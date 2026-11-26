import { ProductError } from '../../domain/workspace.js';
import {
  StartBluestacksHealthCheckInput,
  bluestacksDisplayTitle,
  classifyHealthErrorMessage,
  healthCategoryLabel,
  isBluestacksPortraitResolution,
  type BluestacksHealthCategory,
  type BluestacksHealthCheckItem,
  type BluestacksHealthCheckState,
  type BluestacksInstance,
} from '../../shared/bluestacks.js';
import { errMsg, linkAbortSignal, runConcurrentQueue } from '../module-worker-pool.js';
import {
  type BluestacksServiceContext,
  getDiscoverySnapshot,
  invalidateDiscoveryCache,
  isInstanceBusyInOtherWorker,
  runLinkedExtraWorker,
  saveLastStatusSafe,
  stopExtraWorkers,
  withTrackedDeviceOp,
} from './bs-types.js';

export type PatrolKind = 'health-check' | 'batch-login';
export type PrepFailReason =
  'stopped' | 'missing' | 'landscape' | 'busy' | 'launch-missing' | 'apk-missing';

export const resolvePatrolCap = (ctx: BluestacksServiceContext, requested: number, saved: number) =>
  Math.max(
    1,
    Math.min(
      10,
      Math.max(1, requested),
      Math.max(saved, ctx.activeConcurrencyCap ?? 0, requested, 1),
    ),
  );

export const joinLabels = (entries: Array<[string, number]>) =>
  entries
    .filter(([, count], i) => i === 0 || count > 0)
    .map(([label, count]) => `${label} ${count}`)
    .join(' / ');

function formatHealthErr(
  cat: BluestacksHealthCategory,
  msg: string,
  autoRepaired: boolean,
  scheduledStyle = false,
): string {
  if (cat === 'missing-app') return '未安装 FB Lite';
  if (cat === 'logged-out')
    return autoRepaired
      ? scheduledStyle
        ? '已自动装包，账号未登录'
        : '已自动装包 · 待登录账号'
      : 'FB Lite 未登录账号';
  if (cat === 'verification') return '账号需安全验证 (Checkpoint)';
  if (cat === 'restricted') return scheduledStyle ? '账号已受限/停用' : '账号受限/停用';
  return scheduledStyle ? msg.slice(0, 100) : `检测异常 · ${msg.slice(0, 72)}`;
}

async function ensureFbLiteApk(
  ctx: BluestacksServiceContext,
  inst: BluestacksInstance,
  autoInstallApk: boolean,
  signal: AbortSignal,
  onRepairing: () => void,
) {
  const probe = ctx.devices.probeFbLiteInstalled
    ? await ctx.devices.probeFbLiteInstalled(inst.serial, true, signal)
    : inst.fbLiteInstalled;
  if (probe !== false) return { inst, autoRepaired: false, missingNotRepaired: false };
  const installFn = ctx.devices.installFbLiteApk;
  if (!autoInstallApk || !installFn) return { inst, autoRepaired: false, missingNotRepaired: true };
  onRepairing();
  return {
    inst: await withTrackedDeviceOp(ctx, ctx.installingIds, inst.id, () =>
      installFn(inst.id, undefined, signal),
    ),
    autoRepaired: true,
    missingNotRepaired: false,
  };
}

export async function closePatrolInstance(
  ctx: BluestacksServiceContext,
  instanceId: string,
  item: { stepText: string },
): Promise<void> {
  const prev = item.stepText;
  item.stepText = `${prev}（正在关窗释放内存…）`;
  await withTrackedDeviceOp(ctx, ctx.closingIds, instanceId, () =>
    ctx.devices.closeInstance(instanceId).catch(() => {}),
  );
  item.stepText = prev;
}

export async function preparePatrolInstance(
  ctx: BluestacksServiceContext,
  instanceId: string,
  kind: PatrolKind,
  workerEntry: { kind: PatrolKind; controller: AbortController; promise: Promise<void> },
  autoLaunch: boolean,
  autoInstallApk: boolean,
  setStep: (t: string) => void,
  onCheckSkip?: (inst: BluestacksInstance) => boolean,
): Promise<{
  ok: boolean;
  reason?: PrepFailReason;
  inst?: BluestacksInstance;
  launched: boolean;
  autoRepaired: boolean;
  claimed: boolean;
}> {
  const sig = workerEntry.controller.signal;
  const fail = (
    reason: PrepFailReason,
    inst?: BluestacksInstance,
    launched = false,
    claimed = false,
  ) => ({
    ok: false,
    reason,
    ...(inst ? { inst } : {}),
    launched,
    autoRepaired: false,
    claimed,
  });
  if (sig.aborted) return fail('stopped');
  let inst = (await getDiscoverySnapshot(ctx, false)).instances.find((i) => i.id === instanceId);
  if (!inst) return fail('missing');
  if (!isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight)) return fail('landscape', inst);
  const feature = kind === 'health-check' ? 'bluestacks-health-check' : 'bluestacks-batch-login';
  if (
    (ctx.registry ? await ctx.registry.isProfileBusy(instanceId, feature) : false) ||
    isInstanceBusyInOtherWorker(ctx, instanceId)
  )
    return fail('busy', inst);
  ctx.extraWorkers.set(instanceId, workerEntry);
  if (onCheckSkip?.(inst)) return fail('busy', inst, false, true);
  let launched = false;
  if (!inst.online) {
    if (!autoLaunch) return fail('launch-missing', inst, false, true);
    setStep(kind === 'health-check' ? '正在自动拉起蓝蝶窗口…' : '正在自动启动蓝蝶窗口…');
    const offlineInst = inst;
    inst = await withTrackedDeviceOp(ctx, ctx.launchingIds, offlineInst.id, () =>
      ctx.devices.launchInstance(offlineInst.id, sig),
    );
    launched = true;
  }
  if (sig.aborted) return fail('stopped', inst, launched, true);
  const apkRes = await ensureFbLiteApk(ctx, inst, autoInstallApk, sig, () =>
    setStep('未检测到 FB Lite，正在自动装包修复…'),
  );
  if (apkRes.missingNotRepaired) return fail('apk-missing', apkRes.inst, launched, true);
  if (sig.aborted) return fail('stopped', apkRes.inst, launched, true);
  return {
    ok: true,
    inst: apkRes.inst,
    launched,
    autoRepaired: apkRes.autoRepaired,
    claimed: true,
  };
}

export async function runPatrolBatch<TEntry>(opts: {
  ctx: BluestacksServiceContext;
  kind: PatrolKind;
  entries: readonly TEntry[];
  maxConcurrency: number;
  initRun: (
    cap: number,
    byId: Map<string, BluestacksInstance>,
    abort: AbortController,
  ) => {
    runState: { running: boolean; finishedAt: number | null; statusText: string };
    recompute: () => void;
    onFinallyClear: () => void;
    setAbortAndPromise: (abort: AbortController, promise: Promise<void>) => void;
  };
  onAbortedItem: (entry: TEntry) => void;
  runItem: (entry: TEntry, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  const { ctx, kind } = opts;
  const startKey = kind === 'health-check' ? 'healthCheckStarting' : 'batchLoginStarting';
  ctx[startKey] = true;
  try {
    const [{ instances }, saved] = await Promise.all([
      getDiscoverySnapshot(ctx, true),
      ctx.repo.savedSettings(),
    ]);
    const cap = resolvePatrolCap(
      ctx,
      opts.maxConcurrency,
      saved.bumperSettings.maxConcurrentProfiles,
    );
    const abort = new AbortController();
    const { runState, recompute, onFinallyClear, setAbortAndPromise } = opts.initRun(
      cap,
      new Map(instances.map((i) => [i.id, i])),
      abort,
    );
    ctx.statusText = runState.statusText;
    const runnerPromise = runConcurrentQueue(
      opts.entries,
      cap,
      (entry) => opts.runItem(entry, abort.signal),
      abort.signal,
      opts.onAbortedItem,
    ).finally(() => {
      runState.running = false;
      runState.finishedAt = Date.now();
      recompute();
      ctx.statusText = runState.statusText;
      onFinallyClear();
      invalidateDiscoveryCache(ctx);
    });
    setAbortAndPromise(abort, runnerPromise);
  } finally {
    ctx[startKey] = false;
  }
}

export async function stopPatrolBatch(
  ctx: BluestacksServiceContext,
  kind: PatrolKind,
  abort: AbortController | null,
  state: {
    running: boolean;
    items: Array<{
      status: string;
      category?: string | null;
      stepText: string;
      finishedAt?: number;
    }>;
  } | null,
  recompute: () => void,
  runnerPromise: Promise<void> | null,
): Promise<void> {
  abort?.abort(new Error('TASK_STOPPED'));
  if (state?.running) {
    for (const item of state.items) {
      if (item.status !== 'queued') continue;
      item.status = kind === 'health-check' ? 'done' : 'stopped';
      if (kind === 'health-check') item.category = 'stopped';
      item.stepText = '已取消排队';
      item.finishedAt = Date.now();
    }
    recompute();
  }
  await stopExtraWorkers(ctx, kind);
  if (runnerPromise) await Promise.allSettled([runnerPromise]);
}

export function recomputeHealthCheckCounts(state: BluestacksHealthCheckState): void {
  const c: Record<BluestacksHealthCategory, number> = {
    healthy: 0,
    'logged-out': 0,
    verification: 0,
    restricted: 0,
    'missing-app': 0,
    landscape: 0,
    'launch-failed': 0,
    skipped: 0,
    stopped: 0,
  };
  let completed = 0;
  let autoRepaired = 0;
  for (const item of state.items) {
    if (item.autoRepaired) autoRepaired++;
    if (item.status !== 'done') continue;
    completed++;
    if (item.category) c[item.category]++;
  }
  Object.assign(state, {
    completed,
    healthy: c.healthy,
    loggedOut: c['logged-out'],
    verification: c.verification,
    restricted: c.restricted,
    missingApp: c['missing-app'],
    landscape: c.landscape,
    launchFailed: c['launch-failed'],
    skipped: c.skipped,
    stopped: c.stopped,
    autoRepaired,
  });
  const abnormal =
    c['logged-out'] +
    c.verification +
    c.restricted +
    c['missing-app'] +
    c.landscape +
    c['launch-failed'];
  state.statusText = state.running
    ? `正在批量体检 (${completed}/${state.total} · 健康 ${c.healthy}${abnormal > 0 ? ` · 异常 ${abnormal}` : ''})`
    : `批量体检已完成 (${completed}/${state.total} · ${joinLabels([
        ['健康', c.healthy],
        ['未登录', c['logged-out']],
        ['待验证', c.verification],
        ['受限', c.restricted],
        ['缺App', c['missing-app']],
        ['横屏', c.landscape],
        ['失败', c['launch-failed']],
        ['跳过', c.skipped],
        ['已停', c.stopped],
      ])})`;
}

const mapAccountStateToHealthCategory = (
  accountState: BluestacksInstance['accountState'],
): BluestacksHealthCategory =>
  accountState === 'logged-in'
    ? 'healthy'
    : ['logged-out', 'verification', 'restricted', 'missing-app'].includes(accountState)
      ? (accountState as BluestacksHealthCategory)
      : 'launch-failed';

async function inspectHealthAndClassify(
  ctx: BluestacksServiceContext,
  instanceId: string,
  signal: AbortSignal,
  item?: BluestacksHealthCheckItem,
  scheduledStyle = false,
): Promise<{ category: BluestacksHealthCategory; stepText: string; error?: string }> {
  const autoRepaired = Boolean(item?.autoRepaired);
  try {
    const inspected = await withTrackedDeviceOp(ctx, ctx.inspectingIds, instanceId, () =>
      ctx.devices.inspectAccount(instanceId, signal),
    );
    if (item) {
      item.resolution = `${inspected.fbWidth}×${inspected.fbHeight}`;
      item.fbLiteVersion = inspected.fbLiteVersion ?? item.fbLiteVersion;
      item.androidSdk = inspected.androidSdk ?? item.androidSdk;
      item.identityType = inspected.identityType ?? 'unknown';
      item.accountName = inspected.accountName || undefined;
      item.numericAccountId = inspected.numericAccountId || undefined;
      item.managedPageCount =
        inspected.managedIdentities?.filter((m) => m.identityType === 'page').length ?? 0;
    }
    const category = mapAccountStateToHealthCategory(inspected.accountState);
    let stepText: string;
    let error: string | undefined;
    if (category === 'healthy') {
      const role = !scheduledStyle
        ? inspected.identityType === 'page'
          ? ' (专页)'
          : inspected.identityType === 'personal'
            ? ' (个人)'
            : ''
        : '';
      const prefix = scheduledStyle ? '体检健康' : `健康正常${role}`;
      stepText = `${prefix} · ${inspected.accountName || bluestacksDisplayTitle(inspected)}${inspected.numericAccountId ? ` · ID ${inspected.numericAccountId}` : ''}`;
    } else {
      stepText = healthCategoryLabel(category);
      if (category === 'verification') error = '触发安全验证 (Checkpoint)';
      else if (category === 'restricted') error = '账号受限或已停用';
    }
    await saveLastStatusSafe(ctx, instanceId, scheduledStyle ? stepText : `体检：${stepText}`);
    return { category, stepText, error };
  } catch (err) {
    const msg = errMsg(err, scheduledStyle ? '体检异常' : '体检检测异常');
    if (signal.aborted || msg === 'TASK_STOPPED') {
      const stopText = scheduledStyle ? '已停止' : '已手动停止';
      if (!scheduledStyle) await saveLastStatusSafe(ctx, instanceId, `体检：${stopText}`);
      return { category: 'stopped', stepText: stopText };
    }
    const latest = await Promise.resolve(ctx.repo.getInstance(instanceId)).catch(() => null);
    if (item && latest) {
      item.fbLiteVersion = latest.fbLiteVersion ?? item.fbLiteVersion;
      item.androidSdk = latest.androidSdk ?? item.androidSdk;
      item.resolution = `${latest.fbWidth}×${latest.fbHeight}`;
    }
    const category = classifyHealthErrorMessage(msg, latest?.accountState);
    const stepText = formatHealthErr(category, msg, autoRepaired, scheduledStyle);
    await saveLastStatusSafe(ctx, instanceId, `体检：${stepText}`);
    return { category, stepText, error: msg };
  }
}

export async function startHealthCheck(
  ctx: BluestacksServiceContext,
  input: unknown,
): Promise<void> {
  if (ctx.healthCheckStarting || ctx.healthCheckState?.running)
    throw new ProductError(
      'HEALTH_CHECK_ALREADY_RUNNING',
      '当前已有蓝蝶批量体检任务正在运行，请等待完成或先停止',
      409,
    );
  const parsed = StartBluestacksHealthCheckInput.parse(input);
  const uniqueIds = [...new Set(parsed.instanceIds)];
  let runState!: BluestacksHealthCheckState;
  await runPatrolBatch({
    ctx,
    kind: 'health-check',
    entries: uniqueIds,
    maxConcurrency: parsed.maxConcurrency,
    initRun: (cap, byId) => {
      const items: BluestacksHealthCheckItem[] = uniqueIds.map((id) => {
        const inst = byId.get(id);
        return {
          instanceId: id,
          instanceName: inst ? bluestacksDisplayTitle(inst) : id.slice(0, 8),
          resolution: inst ? `${inst.fbWidth}×${inst.fbHeight}` : '-',
          status: 'queued',
          category: null,
          stepText: '排队等待并发槽位…',
          fbLiteVersion: inst?.fbLiteVersion ?? null,
          androidSdk: inst?.androidSdk ?? null,
        };
      });
      runState = {
        runId: crypto.randomUUID(),
        running: true,
        startedAt: Date.now(),
        finishedAt: null,
        total: items.length,
        completed: 0,
        healthy: 0,
        loggedOut: 0,
        verification: 0,
        restricted: 0,
        missingApp: 0,
        landscape: 0,
        launchFailed: 0,
        skipped: 0,
        stopped: 0,
        autoRepaired: 0,
        statusText: `准备批量体检 ${items.length} 台蓝蝶（并发 ${cap}）…`,
        items,
      };
      ctx.healthCheckState = runState;
      return {
        runState,
        recompute: () => recomputeHealthCheckCounts(runState),
        setAbortAndPromise: (abort, promise) => {
          ctx.healthCheckAbort = abort;
          ctx.healthCheckRunnerPromise = promise;
        },
        onFinallyClear: () => {
          if (ctx.healthCheckAbort?.signal.aborted !== undefined && ctx.healthCheckRunnerPromise) {
            ctx.healthCheckAbort = null;
            ctx.healthCheckRunnerPromise = null;
          }
        },
      };
    },
    onAbortedItem: (id) => {
      const it = runState.items.find((x) => x.instanceId === id);
      if (!it || it.status !== 'queued') return;
      Object.assign(it, {
        status: 'done',
        category: 'stopped',
        stepText: '已取消排队',
        finishedAt: Date.now(),
      });
      recomputeHealthCheckCounts(runState);
    },
    runItem: async (id, parentSig) => {
      const item = runState.items.find((x) => x.instanceId === id);
      if (!item) return;
      const { controller: itemCtrl, detach } = linkAbortSignal(parentSig);
      const setStep = (text: string) => {
        item.stepText = text;
        ctx.statusText = `${item.instanceName}：${text}`;
      };
      let launched = false;
      let claimed = false;
      const workerEntry = {
        kind: 'health-check' as const,
        controller: itemCtrl,
        promise: Promise.resolve(),
      };
      const workerPromise = (async () => {
        try {
          Object.assign(item, { status: 'running', startedAt: Date.now() });
          const prep = await preparePatrolInstance(
            ctx,
            item.instanceId,
            'health-check',
            workerEntry,
            parsed.autoLaunch,
            parsed.autoInstallApk,
            setStep,
          );
          launched = prep.launched;
          claimed = prep.claimed;
          if (prep.inst) {
            item.instanceName = bluestacksDisplayTitle(prep.inst);
            item.resolution = `${prep.inst.fbWidth}×${prep.inst.fbHeight}`;
            item.fbLiteVersion = prep.inst.fbLiteVersion ?? item.fbLiteVersion;
            item.androidSdk = prep.inst.androidSdk ?? item.androidSdk;
          }
          if (!prep.ok) {
            if (prep.reason === 'stopped')
              Object.assign(item, { category: 'stopped', stepText: '已手动停止' });
            else if (prep.reason === 'landscape' && prep.inst) {
              item.category = 'landscape';
              item.error = `横屏分辨率 (${prep.inst.fbWidth}×${prep.inst.fbHeight}) 不支持自动化，请在多开器改为竖屏`;
              item.stepText = `横屏 ${prep.inst.fbWidth}×${prep.inst.fbHeight}（未拉起）`;
            } else if (prep.reason === 'busy')
              Object.assign(item, { category: 'skipped', stepText: '实例正忙于其他任务，已跳过' });
            else {
              item.category = 'launch-failed';
              item.error =
                prep.reason === 'missing' ? '蓝蝶实例不存在' : '实例未启动且未开启自动拉起';
              item.stepText = prep.reason === 'missing' ? '实例不存在' : item.error;
            }
            return;
          }
          if (prep.autoRepaired) item.autoRepaired = true;
          setStep('正在检测 FB Lite 登录与账号状态…');
          const res = await inspectHealthAndClassify(
            ctx,
            item.instanceId,
            itemCtrl.signal,
            item,
            false,
          );
          item.category = res.category;
          item.stepText = res.stepText;
          if (res.error) item.error = res.error;
        } catch (err) {
          const msg = errMsg(err, '体检检测异常');
          const cat = (item.category =
            itemCtrl.signal.aborted || msg === 'TASK_STOPPED'
              ? 'stopped'
              : classifyHealthErrorMessage(msg));
          item.stepText =
            cat === 'stopped'
              ? '已手动停止'
              : formatHealthErr(cat, msg, Boolean(item.autoRepaired));
          if (cat !== 'stopped') item.error = msg;
          await saveLastStatusSafe(ctx, item.instanceId, `体检：${item.stepText}`);
        } finally {
          detach();
          if (claimed && ctx.extraWorkers.get(item.instanceId) === workerEntry)
            ctx.extraWorkers.delete(item.instanceId);
          if (parsed.closeOnFinish && launched)
            await closePatrolInstance(ctx, item.instanceId, item);
          item.status = 'done';
          item.finishedAt = Date.now();
          invalidateDiscoveryCache(ctx);
          recomputeHealthCheckCounts(runState);
        }
      })();
      workerEntry.promise = workerPromise;
      await workerPromise;
    },
  });
}

export async function runScheduledHealthCheckStep(
  ctx: BluestacksServiceContext,
  input: {
    instanceId: string;
    autoInstallApk?: boolean;
    signal?: AbortSignal;
    onProgress: (status: string) => void;
  },
): Promise<{
  category: BluestacksHealthCategory;
  status: string;
  hardBlocked: boolean;
  softIssue: boolean;
  autoRepaired: boolean;
}> {
  return runLinkedExtraWorker(
    ctx,
    input.instanceId,
    'health-check',
    input.signal,
    () => ({
      category: 'stopped' as const,
      status: '已停止',
      hardBlocked: false,
      softIssue: false,
      autoRepaired: false,
    }),
    async (controller) => {
      const inst = (await getDiscoverySnapshot(ctx, false)).instances.find(
        (i) => i.id === input.instanceId,
      );
      if (!inst)
        return {
          category: 'launch-failed' as const,
          status: '蓝蝶实例不存在',
          hardBlocked: false,
          softIssue: true,
          autoRepaired: false,
        };
      if (!isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight))
        return {
          category: 'landscape' as const,
          status: `横屏 ${inst.fbWidth}×${inst.fbHeight}（需改竖屏）`,
          hardBlocked: true,
          softIssue: false,
          autoRepaired: false,
        };
      input.onProgress('正在探测 FB Lite 安装状态…');
      const apk = await ensureFbLiteApk(
        ctx,
        inst,
        Boolean(input.autoInstallApk),
        controller.signal,
        () => input.onProgress('缺少 FB Lite，正在自动装包修复…'),
      );
      input.onProgress('正在检测 FB Lite 账号健康状态…');
      const res = await inspectHealthAndClassify(
        ctx,
        input.instanceId,
        controller.signal,
        undefined,
        true,
      );
      const isHard = [
        'verification',
        'restricted',
        'logged-out',
        'missing-app',
        'landscape',
      ].includes(res.category);
      const isStopped = res.category === 'stopped';
      if (!isStopped) input.onProgress(res.stepText);
      return {
        category: res.category,
        status: res.stepText,
        hardBlocked: isHard,
        softIssue: res.category !== 'healthy' && !isHard && !isStopped,
        autoRepaired: apk.autoRepaired,
      };
    },
    () => invalidateDiscoveryCache(ctx),
  );
}

export const stopHealthCheck = (ctx: BluestacksServiceContext): Promise<void> =>
  stopPatrolBatch(
    ctx,
    'health-check',
    ctx.healthCheckAbort,
    ctx.healthCheckState,
    () => ctx.healthCheckState && recomputeHealthCheckCounts(ctx.healthCheckState),
    ctx.healthCheckRunnerPromise,
  );
