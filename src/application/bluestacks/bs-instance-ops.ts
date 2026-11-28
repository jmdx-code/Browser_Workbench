import { ProductError, failError } from '../../domain/workspace.js';
import {
  BluestacksArrangeWindowsInput,
  BluestacksInstallApkInput,
  BluestacksInstanceIdsInput,
  BluestacksLoginInput,
  BluestacksShowInstanceInput,
  BluestacksSwitchIdentityInput,
  DEFAULT_BLUESTACKS_RISK_LIMIT_SETTINGS,
  bluestacksDisplayTitle,
  type BluestacksModuleProfileStat,
} from '../../shared/bluestacks.js';
import type { BumperProfileStat } from '../../shared/group-bumper.js';
import { errMsg } from '../module-worker-pool.js';
import {
  buildDefaultInstanceStatus,
  deleteAllBsStats,
  ensureInstanceOnlineForManualAction,
  getDiscoverySnapshot,
  hasActiveExecution,
  hasExtraExecution,
  isExternallyBusy,
  isInstanceBusyInOtherWorker,
  isProfileRunning,
  makeStatusReporter,
  runFireAndForgetInstanceBatch,
  saveLastStatusSafe,
  withTrackedDeviceOp,
} from './bs-op-helpers.js';
import type { BluestacksServiceContext } from './bs-types.js';
export { ensureInstanceOnlineForManualAction };
async function collectIdleInstanceTargets(
  ctx: BluestacksServiceContext,
  instanceIds: readonly string[],
): Promise<string[]> {
  const targets: string[] = [];
  for (const id of new Set(instanceIds)) {
    if (isInstanceBusyInOtherWorker(ctx, id) || (await isExternallyBusy(ctx, id))) continue;
    if (!isInstanceBusyInOtherWorker(ctx, id)) targets.push(id);
  }
  return targets;
}
async function prepareSingleInstanceOp(
  ctx: BluestacksServiceContext,
  instanceId: string,
  kind: 'switch-identity' | 'login',
  busyMsg: string,
) {
  if (
    isInstanceBusyInOtherWorker(ctx, instanceId) ||
    (await isExternallyBusy(ctx, instanceId)) ||
    isInstanceBusyInOtherWorker(ctx, instanceId)
  )
    throw new ProductError('INSTANCE_BUSY', busyMsg, 409);
  const controller = new AbortController();
  let resolveOp!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveOp = resolve;
  });
  ctx.instanceOpWorkers.set(instanceId, { kind, controller, promise });
  return {
    controller,
    release: () => {
      if (ctx.instanceOpWorkers.get(instanceId)?.controller === controller)
        ctx.instanceOpWorkers.delete(instanceId);
      resolveOp();
    },
  };
}
export async function stopInstanceOps(
  ctx: BluestacksServiceContext,
  ids?: readonly string[],
): Promise<void> {
  const idSet = ids?.length ? new Set(ids) : null;
  const waits: Promise<void>[] = [];
  for (const [id, op] of ctx.instanceOpWorkers.entries()) {
    if (idSet && !idSet.has(id)) continue;
    op.controller.abort(new Error('TASK_STOPPED'));
    waits.push(op.promise);
  }
  if (waits.length) await Promise.allSettled(waits);
}
export async function launchInstancesOp(
  ctx: BluestacksServiceContext,
  input: unknown,
): Promise<void> {
  const { instanceIds } = BluestacksInstanceIdsInput.parse(input);
  const candidates = await collectIdleInstanceTargets(ctx, instanceIds);
  if (!candidates.length) return;
  runFireAndForgetInstanceBatch(
    ctx,
    candidates,
    ctx.launchingIds,
    `正在启动 ${candidates.length} 个蓝蝶窗口…`,
    '启动失败: ',
    async (id, _saveText, signal) => {
      await ctx.devices.launchInstance(id, signal);
      await saveLastStatusSafe(ctx, id, '窗口已启动');
    },
    (ok, errs) =>
      errs.length
        ? `窗口启动完成：成功 ${ok} 个，异常 ${errs.length} 个（${errs[0]}）`
        : `已启动 ${ok} 个蓝蝶窗口`,
    1200,
    'launch',
  );
}
export async function closeInstancesOp(
  ctx: BluestacksServiceContext,
  input: unknown,
): Promise<boolean> {
  const { instanceIds } = BluestacksInstanceIdsInput.parse(input);
  for (const id of instanceIds) {
    if (isProfileRunning(ctx, id) || (await isExternallyBusy(ctx, id)))
      failError(
        'INSTANCE_BUSY',
        '所选蓝蝶窗口正在执行顶贴或排班任务，请先停止任务后再关闭窗口',
        409,
      );
  }
  const toClose = [...new Set(instanceIds)].filter((id) => !ctx.closingIds.has(id));
  if (!toClose.length) return false;
  ctx.statusText = `正在关闭 ${toClose.length} 个蓝蝶窗口…`;
  await Promise.allSettled(
    toClose.map((id) =>
      withTrackedDeviceOp(ctx, ctx.closingIds, id, async () => {
        await ctx.devices.closeInstance(id);
        await saveLastStatusSafe(ctx, id, '已关闭');
        deleteAllBsStats(ctx, id);
      }),
    ),
  );
  ctx.statusText = `已关闭 ${toClose.length} 个蓝蝶窗口`;
  return true;
}
export async function inspectInstancesOp(
  ctx: BluestacksServiceContext,
  input: unknown,
): Promise<void> {
  const { instanceIds } = BluestacksInstanceIdsInput.parse(input);
  const targets = await collectIdleInstanceTargets(ctx, instanceIds);
  if (!targets.length)
    throw new ProductError('NO_IDLE_INSTANCES', '所选模拟器正在执行操作，请稍候', 409);
  runFireAndForgetInstanceBatch(
    ctx,
    targets,
    ctx.inspectingIds,
    `正在识别 ${targets.length} 个蓝蝶窗口的 FB Lite 账号…`,
    '识别失败 · ',
    async (id, saveText, signal) => {
      await ensureInstanceOnlineForManualAction(ctx, id, signal, saveText);
      const updated = await ctx.devices.inspectAccount(id, signal);
      const label =
        updated.accountState === 'verification'
          ? '账号需验证 (Checkpoint)'
          : updated.accountState === 'restricted'
            ? '账号已受限/停用'
            : `账号已识别 · ${updated.accountName || bluestacksDisplayTitle(updated)}`;
      await saveLastStatusSafe(ctx, id, label);
    },
    (ok, errs) =>
      errs.length
        ? `账号识别完成：成功 ${ok} 个，异常 ${errs.length} 个（${errs[0]}）`
        : `账号识别完成：成功识别 ${ok} 个窗口`,
    0,
    'inspect',
  );
}
export async function showInstanceOp(ctx: BluestacksServiceContext, input: unknown): Promise<void> {
  const { instanceId } = BluestacksShowInstanceInput.parse(input);
  if (!ctx.devices.showInstance)
    throw new ProductError('BLUESTACKS_UNSUPPORTED', '当前环境不支持窗口置前', 400);
  if (ctx.launchingIds.has(instanceId))
    throw new ProductError('BLUESTACKS_LAUNCHING', '蓝蝶窗口正在启动中，请稍候再试', 409);
  await ctx.devices.showInstance(instanceId);
}
export async function arrangeWindowsOp(
  ctx: BluestacksServiceContext,
  input: unknown,
): Promise<void> {
  const parsed = BluestacksArrangeWindowsInput.parse(input ?? {});
  if (!ctx.devices.arrangeWindows)
    throw new ProductError('BLUESTACKS_UNSUPPORTED', '当前环境不支持自动平铺窗口', 400);
  const arranged = await ctx.devices.arrangeWindows(parsed.instanceIds, {
    columns: parsed.columns,
    gap: parsed.gap,
    ...(parsed.monitorBounds ? { monitorBounds: parsed.monitorBounds } : {}),
  });
  ctx.statusText =
    arranged > 0 ? `已自动平铺 ${arranged} 个蓝蝶窗口` : '当前没有可平铺的在线蓝蝶窗口';
}
export async function installApkOp(ctx: BluestacksServiceContext, input: unknown): Promise<void> {
  const { instanceIds, apkPath } = BluestacksInstallApkInput.parse(input);
  if (!ctx.devices.installFbLiteApk)
    throw new ProductError('BLUESTACKS_UNSUPPORTED', '当前环境不支持自动安装 FB Lite APK', 400);
  const targets = await collectIdleInstanceTargets(ctx, instanceIds);
  if (!targets.length)
    throw new ProductError('NO_IDLE_INSTANCES', '所选蓝蝶窗口正忙，请稍候再试', 409);
  runFireAndForgetInstanceBatch(
    ctx,
    targets,
    ctx.installingIds,
    `正在为 ${targets.length} 个蓝蝶窗口安装 FB Lite…`,
    '安装失败 · ',
    async (id, saveText, signal) => {
      await ensureInstanceOnlineForManualAction(ctx, id, signal, saveText);
      const updated = await ctx.devices.installFbLiteApk?.(id, apkPath, signal);
      await saveLastStatusSafe(
        ctx,
        id,
        `已安装 FB Lite${updated?.fbLiteVersion ? ' ' + updated.fbLiteVersion : ''}`,
      );
    },
    (ok, errs) =>
      errs.length
        ? `FB Lite 安装完成：成功 ${ok} 个，失败 ${errs.length} 个（${errs[0]}）`
        : `FB Lite 安装完成：成功 ${ok} 个窗口`,
    0,
    'install-apk',
  );
}
export async function switchIdentityOp(
  ctx: BluestacksServiceContext,
  input: unknown,
): Promise<void> {
  const parsed = BluestacksSwitchIdentityInput.parse(input);
  const switchFn = ctx.devices.switchIdentity;
  if (!switchFn) throw new ProductError('BLUESTACKS_UNSUPPORTED', '当前环境不支持切换身份', 400);
  const { controller, release } = await prepareSingleInstanceOp(
    ctx,
    parsed.instanceId,
    'switch-identity',
    '该蓝蝶窗口正在执行其他操作，请先停止',
  );
  try {
    await withTrackedDeviceOp(ctx, ctx.switchingIds, parsed.instanceId, async () => {
      await ensureInstanceOnlineForManualAction(
        ctx,
        parsed.instanceId,
        controller.signal,
        makeStatusReporter(ctx, parsed.instanceId, false),
      );
      const updated = await switchFn(
        parsed.instanceId,
        { targetName: parsed.targetName, targetType: parsed.targetType },
        controller.signal,
      );
      const roleLabel = updated.identityType === 'page' ? '专页' : '个人';
      await saveLastStatusSafe(
        ctx,
        parsed.instanceId,
        `已切换为${roleLabel}身份 · ${updated.accountName || bluestacksDisplayTitle(updated)}`,
      );
      ctx.statusText = `已切换为${roleLabel}身份：${updated.accountName}`;
    });
  } finally {
    release();
  }
}
export async function loginInstanceOp(
  ctx: BluestacksServiceContext,
  input: unknown,
): Promise<void> {
  const parsed = BluestacksLoginInput.parse(input);
  const loginFn = ctx.devices.loginAccountDetailed;
  if (!loginFn) throw new ProductError('BLUESTACKS_UNSUPPORTED', '当前环境不支持自动登录', 400);
  const { controller, release } = await prepareSingleInstanceOp(
    ctx,
    parsed.instanceId,
    'login',
    '该蓝蝶窗口正在执行其他操作，请稍候再试',
  );
  ctx.statusText = '正在自动登录 FB Lite 账号…';
  void withTrackedDeviceOp(ctx, ctx.loggingInIds, parsed.instanceId, async () => {
    const saveText = makeStatusReporter(ctx, parsed.instanceId);
    try {
      await ensureInstanceOnlineForManualAction(
        ctx,
        parsed.instanceId,
        controller.signal,
        saveText,
      );
      const res = await loginFn.call(
        ctx.devices,
        parsed.instanceId,
        {
          account: parsed.account,
          password: parsed.password,
          totpSecret: parsed.totpSecret,
          saveLoginInfo: parsed.saveLoginInfo,
          ifAlreadyLoggedIn: parsed.ifAlreadyLoggedIn,
        },
        controller.signal,
        saveText,
      );
      if (res.instance) {
        const label = res.instance.accountName || bluestacksDisplayTitle(res.instance);
        saveText(
          res.skippedAlreadyLoggedIn ? `原已登录 · ${label}，已跳过` : `登录成功 · ${label}`,
        );
      }
    } catch (err) {
      const msg = controller.signal.aborted ? '已手动停止' : errMsg(err, '自动登录失败');
      ctx.statusText = `登录失败：${msg}`;
      await saveLastStatusSafe(ctx, parsed.instanceId, `登录失败 · ${msg.slice(0, 80)}`);
    } finally {
      release();
    }
  });
}
export async function buildServiceState(ctx: BluestacksServiceContext, forceDiscover = false) {
  const [{ instances, config }, folders, saved, counts, pageCounts, total, pageTotal, dailyUsage] =
    await Promise.all([
      getDiscoverySnapshot(ctx, forceDiscover),
      ctx.repo.folders(),
      ctx.repo.savedSettings(),
      ctx.repo.todayCounts(undefined, 'group'),
      ctx.repo.todayCounts(undefined, 'page'),
      ctx.repo.total('group'),
      ctx.repo.total('page'),
      ctx.repo.dailyInstanceUsage
        ? Promise.resolve(ctx.repo.dailyInstanceUsage()).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
  const mapStats = <T extends BumperProfileStat>(
    statsMap: Map<string, T>,
    isRunningFn: (instId: string) => boolean,
    resolveToday: (instId: string, cur: T | undefined) => number,
  ) => {
    const out: Record<string, T> = {};
    for (const inst of instances) {
      const running = isRunningFn(inst.id),
        cur = statsMap.get(inst.id),
        stale = !running && cur?.status === '跳过：模拟器未启动';
      if (stale) statsMap.delete(inst.id);
      const today = resolveToday(inst.id, cur);
      out[inst.id] =
        cur && !stale
          ? { ...cur, running, today }
          : ({ running, status: buildDefaultInstanceStatus(ctx, inst), session: 0, today } as T);
    }
    return out;
  };
  const buildExtraMap = (
    kind: 'active' | 'poster' | 'inviter',
    statsMap: Map<string, BluestacksModuleProfileStat>,
  ) =>
    mapStats(
      statsMap,
      (id) =>
        ctx.extraWorkers.get(id)?.kind === kind || ctx.queuedExtraTasks.get(id)?.kind === kind,
      (id, cur) => {
        const d = dailyUsage?.perInstance[id];
        return Math.max(
          cur?.today ?? 0,
          kind === 'active'
            ? (d?.activeLikesToday ?? 0)
            : kind === 'poster'
              ? (d?.postsToday ?? 0)
              : (d?.invitesToday ?? 0),
        );
      },
    );
  return {
    instances,
    folders,
    config,
    bumperSettings: saved.bumperSettings,
    pageBumperSettings: saved.pageBumperSettings ?? saved.bumperSettings,
    running: hasActiveExecution(ctx, 'group'),
    pageBumperRunning: hasActiveExecution(ctx, 'page'),
    activeRunning: hasExtraExecution(ctx, 'active'),
    posterRunning: hasExtraExecution(ctx, 'poster'),
    inviterRunning: hasExtraExecution(ctx, 'inviter'),
    launchingIds: [...ctx.launchingIds],
    closingIds: [...ctx.closingIds],
    inspectingIds: [...ctx.inspectingIds],
    installingIds: [...ctx.installingIds],
    loggingInIds: [...ctx.loggingInIds],
    switchingIds: [...ctx.switchingIds],
    statusText: ctx.statusText,
    pageBumperStatusText: ctx.pageStatusText,
    activeStatusText: ctx.activeStatusText,
    posterStatusText: ctx.posterStatusText,
    inviterStatusText: ctx.inviterStatusText,
    profileCounts: mapStats(
      ctx.profileStats,
      (id) => isProfileRunning(ctx, id, 'group'),
      (id) => counts[id] ?? 0,
    ),
    pageBumperProfileCounts: mapStats(
      ctx.pageProfileStats,
      (id) => isProfileRunning(ctx, id, 'page'),
      (id) => pageCounts[id] ?? 0,
    ),
    activeProfileCounts: buildExtraMap('active', ctx.activeProfileStats),
    posterProfileCounts: buildExtraMap('poster', ctx.posterProfileStats),
    inviterProfileCounts: buildExtraMap('inviter', ctx.inviterProfileStats),
    total,
    pageTotal,
    batchLogin: ctx.batchLoginState
      ? { ...ctx.batchLoginState, items: ctx.batchLoginState.items.map((i) => ({ ...i })) }
      : null,
    healthCheck: ctx.healthCheckState
      ? { ...ctx.healthCheckState, items: ctx.healthCheckState.items.map((i) => ({ ...i })) }
      : null,
    riskLimitSettings: saved.riskLimitSettings ?? DEFAULT_BLUESTACKS_RISK_LIMIT_SETTINGS,
    ...(dailyUsage ? { dailyUsage } : {}),
  };
}
