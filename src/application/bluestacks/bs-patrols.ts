import { failError } from '../../domain/workspace.js';
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
import { errMsg, runConcurrentQueue, sortTargetsOnlineFirst } from '../module-worker-pool.js';
import {
  type PatrolKind,
  bsCarrierId,
  ensureFbLiteApk,
  getDiscoverySnapshot,
  invalidateDiscoveryCache,
  runLinkedExtraWorker,
  runPatrolItemLifecycle,
  saveLastStatusSafe,
  stopExtraWorkers,
  withTrackedDeviceOp,
} from './bs-op-helpers.js';
import type { BluestacksServiceContext } from './bs-types.js';
export const resolvePatrolCap = (ctx: BluestacksServiceContext, requested: number): number => {
  const globalCap = Math.max(1, ctx.workboard.bluestacksPermits.max);
  const safeReq = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 1;
  return Math.min(globalCap, safeReq);
};
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
export async function runPatrolBatch<TEntry>(opts: {
  ctx: BluestacksServiceContext;
  kind: PatrolKind;
  entries: readonly TEntry[];
  getInstanceId?: (entry: TEntry) => string;
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
    const { instances } = await getDiscoverySnapshot(ctx, true);
    const byId = new Map(instances.map((i) => [i.id, i]));
    const orderedEntries = opts.getInstanceId
      ? await sortTargetsOnlineFirst(opts.entries, (e) =>
          Boolean(byId.get(opts.getInstanceId?.(e) ?? '')?.online),
        )
      : opts.entries;
    const cap = resolvePatrolCap(ctx, opts.maxConcurrency);
    const abort = new AbortController();
    const { runState, recompute, onFinallyClear, setAbortAndPromise } = opts.initRun(
      cap,
      byId,
      abort,
    );
    ctx.statusText = runState.statusText;
    const runnerPromise = runConcurrentQueue(
      orderedEntries,
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
    failError(
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
    getInstanceId: (id) => id,
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
      await runPatrolItemLifecycle({
        ctx,
        kind: 'health-check',
        item,
        parentSignal: parentSig,
        autoLaunch: parsed.autoLaunch,
        autoInstallApk: parsed.autoInstallApk,
        defaultErr: '体检检测异常',
        closeOnFinish: parsed.closeOnFinish,
        onPreparedInstance: (inst) => {
          item.resolution = `${inst.fbWidth}×${inst.fbHeight}`;
          item.fbLiteVersion = inst.fbLiteVersion ?? item.fbLiteVersion;
          item.androidSdk = inst.androidSdk ?? item.androidSdk;
        },
        onPrepFailed: (prep) => {
          if (prep.reason === 'stopped')
            Object.assign(item, { category: 'stopped', stepText: '已手动停止' });
          else if (prep.reason === 'landscape' && prep.inst) {
            item.category = 'landscape';
            item.error = `横屏分辨率 (${prep.inst.fbWidth}×${prep.inst.fbHeight}) 不支持自动化，请在多开器改为竖屏`;
            item.stepText = `横屏 ${prep.inst.fbWidth}×${prep.inst.fbHeight}（未拉起）`;
          } else if (prep.reason === 'busy')
            Object.assign(item, { category: 'skipped', stepText: '实例正忙于其他任务，已跳过' });
          else if (prep.reason === 'apk-missing') {
            item.category = 'missing-app';
            item.error = '未安装 FB Lite 且未开启自动装包';
            item.stepText = '未安装 FB Lite';
            void saveLastStatusSafe(ctx, item.instanceId, '体检：未安装 FB Lite');
          } else {
            item.category = 'launch-failed';
            item.error =
              prep.reason === 'missing' ? '蓝蝶实例不存在' : '实例未启动且未开启自动拉起';
            item.stepText = prep.reason === 'missing' ? '实例不存在' : item.error;
          }
        },
        execute: async (prep, signal, setStep) => {
          if (prep.autoRepaired) item.autoRepaired = true;
          setStep('正在检测 FB Lite 登录与账号状态…');
          const res = await inspectHealthAndClassify(ctx, item.instanceId, signal, item, false);
          item.category = res.category;
          item.stepText = res.stepText;
          if (res.error) item.error = res.error;
        },
        onError: async (msg, stopped) => {
          const cat = (item.category = stopped ? 'stopped' : classifyHealthErrorMessage(msg));
          item.stepText =
            cat === 'stopped'
              ? '已手动停止'
              : formatHealthErr(cat, msg, Boolean(item.autoRepaired));
          if (cat !== 'stopped') item.error = msg;
          await saveLastStatusSafe(ctx, item.instanceId, `体检：${item.stepText}`);
        },
        onAfterItem: () => {
          item.status = 'done';
          recomputeHealthCheckCounts(runState);
        },
      });
    },
  });
}
export interface ScheduledHealthStepResult {
  category: BluestacksHealthCategory;
  status: string;
  hardBlocked: boolean;
  softIssue: boolean;
  autoRepaired: boolean;
}
const healthResult = (
  category: BluestacksHealthCategory,
  status: string,
  hardBlocked: boolean,
  softIssue: boolean,
  autoRepaired = false,
): ScheduledHealthStepResult => ({ category, status, hardBlocked, softIssue, autoRepaired });
export async function runScheduledHealthCheckStep(
  ctx: BluestacksServiceContext,
  input: {
    instanceId: string;
    autoInstallApk?: boolean;
    signal?: AbortSignal;
    onProgress: (status: string) => void;
  },
): Promise<ScheduledHealthStepResult> {
  return runLinkedExtraWorker<ScheduledHealthStepResult>(
    ctx,
    input.instanceId,
    'health-check',
    input.signal,
    () => healthResult('stopped', '已停止', false, false),
    async (controller) => {
      let releasePermit: (() => void) | undefined;
      try {
        const inst = (await getDiscoverySnapshot(ctx, false)).instances.find(
          (i) => i.id === input.instanceId,
        );
        if (!inst) return healthResult('launch-failed', '蓝蝶实例不存在', false, true);
        if (!isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight))
          return healthResult(
            'landscape',
            `横屏 ${inst.fbWidth}×${inst.fbHeight}（需改竖屏）`,
            true,
            false,
          );
        releasePermit = await ctx.workboard.acquireCarrierPermit(
          'bluestacks',
          bsCarrierId(input.instanceId),
          controller.signal,
        );
        input.onProgress('正在探测 FB Lite 安装状态…');
        const apk = await ensureFbLiteApk(
          ctx,
          inst,
          Boolean(input.autoInstallApk),
          controller.signal,
          () => input.onProgress('缺少 FB Lite，正在自动装包修复…'),
        );
        if (apk.missingNotRepaired) {
          const status = '未安装 FB Lite';
          input.onProgress(status);
          await saveLastStatusSafe(ctx, input.instanceId, `体检：${status}`);
          return healthResult('missing-app', status, true, false);
        }
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
        return healthResult(
          res.category,
          res.stepText,
          isHard,
          res.category !== 'healthy' && !isHard && !isStopped,
          apk.autoRepaired,
        );
      } finally {
        releasePermit?.();
      }
    },
    () => invalidateDiscoveryCache(ctx),
    () => healthResult('skipped', '跳过：窗口正忙于其他任务', false, true),
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
