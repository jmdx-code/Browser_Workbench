import { ProductError } from '../../domain/workspace.js';
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
import { errMsg, sleepMs } from '../module-worker-pool.js';
import {
  type BluestacksServiceContext,
  buildDefaultInstanceStatus,
  deleteAllBsStats,
  ensurePortraitInstanceOnline,
  getDiscoverySnapshot,
  hasActiveExecution,
  hasExtraExecution,
  isExternallyBusy,
  isProfileRunning,
  saveLastStatusSafe,
  withTrackedDeviceOp,
} from './bs-types.js';

function runFireAndForgetInstanceBatch(
  ctx: BluestacksServiceContext,
  ids: readonly string[],
  trackSet: Set<string>,
  startText: string,
  errPrefix: string,
  perItem: (id: string) => Promise<void>,
  onDone: (okCount: number, errors: string[]) => string,
  interDelayMs = 0,
): void {
  for (const id of ids) trackSet.add(id);
  ctx.statusText = startText;
  void (async () => {
    let okCount = 0;
    const errors: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!id) continue;
      try {
        await withTrackedDeviceOp(ctx, trackSet, id, () => perItem(id));
        okCount++;
      } catch (err) {
        const msg = errMsg(err, '操作失败');
        errors.push(msg);
        await saveLastStatusSafe(ctx, id, `${errPrefix}${msg}`);
      }
      if (interDelayMs > 0 && i + 1 < ids.length) await sleepMs(interDelayMs);
    }
    ctx.statusText = onDone(okCount, errors);
  })();
}

export const ensureInstanceOnlineForManualAction = (
  ctx: BluestacksServiceContext,
  instanceId: string,
  signal?: AbortSignal,
  onStatus?: (text: string) => void,
) =>
  ensurePortraitInstanceOnline(ctx, instanceId, {
    forceDiscover: false,
    launchStatus: '窗口已自动启动',
    signal,
    waitWhileLaunching: true,
    onStatus,
  });

export async function launchInstancesOp(
  ctx: BluestacksServiceContext,
  input: unknown,
): Promise<void> {
  const { instanceIds } = BluestacksInstanceIdsInput.parse(input);
  const toLaunch = [...new Set(instanceIds)].filter(
    (id) => !ctx.launchingIds.has(id) && !ctx.closingIds.has(id),
  );
  if (!toLaunch.length) return;
  runFireAndForgetInstanceBatch(
    ctx,
    toLaunch,
    ctx.launchingIds,
    `正在启动 ${toLaunch.length} 个蓝蝶窗口…`,
    '启动失败: ',
    async (id) => {
      await ctx.devices.launchInstance(id);
      await saveLastStatusSafe(ctx, id, '窗口已启动');
    },
    (ok, errs) =>
      errs.length
        ? `窗口启动完成：成功 ${ok} 个，异常 ${errs.length} 个（${errs[0]}）`
        : `已启动 ${ok} 个蓝蝶窗口`,
    1200,
  );
}

export async function closeInstancesOp(
  ctx: BluestacksServiceContext,
  input: unknown,
): Promise<boolean> {
  const { instanceIds } = BluestacksInstanceIdsInput.parse(input);
  for (const id of instanceIds) {
    if (isProfileRunning(ctx, id) || (await isExternallyBusy(ctx, id)))
      throw new ProductError(
        'INSTANCE_BUSY',
        '所选蓝蝶窗口正在执行顶贴或排班任务，请先停止任务后再关闭窗口',
        409,
      );
  }
  const toClose = [...new Set(instanceIds)].filter((id) => !ctx.closingIds.has(id));
  if (!toClose.length) return false;
  ctx.statusText = `正在关闭 ${toClose.length} 个蓝蝶窗口…`;
  for (const id of toClose) {
    await withTrackedDeviceOp(ctx, ctx.closingIds, id, async () => {
      await ctx.devices.closeInstance(id);
      await saveLastStatusSafe(ctx, id, '已关闭');
      deleteAllBsStats(ctx, id);
    });
  }
  ctx.statusText = `已关闭 ${toClose.length} 个蓝蝶窗口`;
  return true;
}

export async function inspectInstancesOp(
  ctx: BluestacksServiceContext,
  input: unknown,
): Promise<void> {
  const { instanceIds } = BluestacksInstanceIdsInput.parse(input);
  const targets: string[] = [];
  for (const id of new Set(instanceIds)) {
    if (
      ctx.inspectingIds.has(id) ||
      ctx.launchingIds.has(id) ||
      ctx.closingIds.has(id) ||
      isProfileRunning(ctx, id) ||
      (await isExternallyBusy(ctx, id))
    )
      continue;
    targets.push(id);
  }
  if (!targets.length)
    throw new ProductError('NO_IDLE_INSTANCES', '所选模拟器正在执行操作，请稍候', 409);
  runFireAndForgetInstanceBatch(
    ctx,
    targets,
    ctx.inspectingIds,
    `正在识别 ${targets.length} 个蓝蝶窗口的 FB Lite 账号…`,
    '识别失败 · ',
    async (id) => {
      const setMsg = (msg: string) => {
        ctx.statusText = msg;
        void saveLastStatusSafe(ctx, id, msg);
      };
      await ensureInstanceOnlineForManualAction(ctx, id, undefined, setMsg);
      const updated = await ctx.devices.inspectAccount(id);
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
  );
}

export async function showInstanceOp(ctx: BluestacksServiceContext, input: unknown): Promise<void> {
  const { instanceId } = BluestacksShowInstanceInput.parse(input);
  if (!ctx.devices.showInstance)
    throw new ProductError('BLUESTACKS_UNSUPPORTED', '当前环境不支持窗口置前', 400);
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
  });
  ctx.statusText =
    arranged > 0 ? `已自动平铺 ${arranged} 个蓝蝶窗口` : '当前没有可平铺的在线蓝蝶窗口';
}

export async function installApkOp(ctx: BluestacksServiceContext, input: unknown): Promise<void> {
  const { instanceIds, apkPath } = BluestacksInstallApkInput.parse(input);
  if (!ctx.devices.installFbLiteApk)
    throw new ProductError('BLUESTACKS_UNSUPPORTED', '当前环境不支持自动安装 FB Lite APK', 400);
  const targets = [...new Set(instanceIds)].filter(
    (id) => !ctx.installingIds.has(id) && !isProfileRunning(ctx, id),
  );
  if (!targets.length)
    throw new ProductError('NO_IDLE_INSTANCES', '所选蓝蝶窗口正忙，请稍候再试', 409);
  runFireAndForgetInstanceBatch(
    ctx,
    targets,
    ctx.installingIds,
    `正在为 ${targets.length} 个蓝蝶窗口安装 FB Lite…`,
    '安装失败 · ',
    async (id) => {
      await ensureInstanceOnlineForManualAction(ctx, id, undefined, (msg) => {
        ctx.statusText = msg;
        void saveLastStatusSafe(ctx, id, msg);
      });
      const updated = await ctx.devices.installFbLiteApk?.(id, apkPath);
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
  );
}

export async function switchIdentityOp(
  ctx: BluestacksServiceContext,
  input: unknown,
): Promise<void> {
  const parsed = BluestacksSwitchIdentityInput.parse(input);
  const switchFn = ctx.devices.switchIdentity;
  if (!switchFn) throw new ProductError('BLUESTACKS_UNSUPPORTED', '当前环境不支持切换身份', 400);
  if (isProfileRunning(ctx, parsed.instanceId) || ctx.switchingIds.has(parsed.instanceId))
    throw new ProductError('INSTANCE_BUSY', '该蓝蝶窗口正在执行其他操作，请先停止', 409);
  await withTrackedDeviceOp(ctx, ctx.switchingIds, parsed.instanceId, async () => {
    await ensureInstanceOnlineForManualAction(
      ctx,
      parsed.instanceId,
      undefined,
      (msg) => void (ctx.statusText = msg),
    );
    const updated = await switchFn(parsed.instanceId, {
      targetName: parsed.targetName,
      targetType: parsed.targetType,
    });
    const roleLabel = updated.identityType === 'page' ? '专页' : '个人';
    await saveLastStatusSafe(
      ctx,
      parsed.instanceId,
      `已切换为${roleLabel}身份 · ${updated.accountName || bluestacksDisplayTitle(updated)}`,
    );
    ctx.statusText = `已切换为${roleLabel}身份：${updated.accountName}`;
  });
}

export async function loginInstanceOp(
  ctx: BluestacksServiceContext,
  input: unknown,
): Promise<void> {
  const parsed = BluestacksLoginInput.parse(input);
  const loginFn = ctx.devices.loginAccountDetailed;
  if (!loginFn) throw new ProductError('BLUESTACKS_UNSUPPORTED', '当前环境不支持自动登录', 400);
  if (isProfileRunning(ctx, parsed.instanceId) || ctx.loggingInIds.has(parsed.instanceId))
    throw new ProductError('INSTANCE_BUSY', '该蓝蝶窗口正在执行其他操作，请稍候再试', 409);
  ctx.statusText = '正在自动登录 FB Lite 账号…';
  void withTrackedDeviceOp(ctx, ctx.loggingInIds, parsed.instanceId, async () => {
    const saveText = (text: string) => {
      ctx.statusText = text;
      void saveLastStatusSafe(ctx, parsed.instanceId, text);
    };
    try {
      await ensureInstanceOnlineForManualAction(ctx, parsed.instanceId, undefined, saveText);
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
        undefined,
        saveText,
      );
      if (res.instance) {
        const label = res.instance.accountName || bluestacksDisplayTitle(res.instance);
        saveText(
          res.skippedAlreadyLoggedIn ? `原已登录 · ${label}，已跳过` : `登录成功 · ${label}`,
        );
      }
    } catch (err) {
      const msg = errMsg(err, '自动登录失败');
      ctx.statusText = `登录失败：${msg}`;
      await saveLastStatusSafe(ctx, parsed.instanceId, `登录失败 · ${msg.slice(0, 80)}`);
    }
  });
}

export async function buildServiceState(ctx: BluestacksServiceContext, forceDiscover = false) {
  const [
    { instances, config },
    folders,
    saved,
    counts,
    pageCounts,
    total,
    pageTotal,
    dailyStats,
    pageDailyStats,
    dailyUsage,
  ] = await Promise.all([
    getDiscoverySnapshot(ctx, forceDiscover),
    ctx.repo.folders(),
    ctx.repo.savedSettings(),
    ctx.repo.todayCounts(undefined, 'group'),
    ctx.repo.todayCounts(undefined, 'page'),
    ctx.repo.total('group'),
    ctx.repo.total('page'),
    ctx.repo.weeklyDailyCounts(undefined, 'group'),
    ctx.repo.weeklyDailyCounts(undefined, 'page'),
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
      const running = isRunningFn(inst.id);
      const cur = statsMap.get(inst.id);
      const stale = !running && cur?.status === '跳过：模拟器未启动';
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
    dailyStats,
    pageDailyStats,
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
