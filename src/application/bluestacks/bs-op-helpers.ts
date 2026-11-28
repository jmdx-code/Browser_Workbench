import { ProductError, failError } from '../../domain/workspace.js';
import {
  DEFAULT_BLUESTACKS_RISK_LIMIT_SETTINGS,
  bluestacksDisplayTitle,
  evaluateBluestacksRiskQuota,
  isBluestacksPortraitResolution,
  type BluestacksBumperMode,
  type BluestacksInstance,
  type BluestacksRiskActionKind,
} from '../../shared/bluestacks.js';
import type { BumperProfileStat } from '../../shared/group-bumper.js';
import type { PostBumpRecordsPort } from '../../shared/post-bump-records.js';
import {
  errMsg,
  extractRiskAbortReason,
  ignoreError,
  linkAbortSignal,
  sleepMs,
} from '../module-worker-pool.js';
import type { BluestacksServiceContext, ExtraExecutionKind } from './bs-types.js';
export type PatrolKind = 'health-check' | 'batch-login';
export type PrepFailReason =
  'stopped' | 'missing' | 'landscape' | 'busy' | 'launch-missing' | 'apk-missing';
export interface PatrolPrepResult {
  ok: boolean;
  reason?: PrepFailReason;
  inst?: BluestacksInstance;
  launched: boolean;
  autoRepaired: boolean;
  claimed: boolean;
  releasePermit?: () => void;
}
export const bsCarrierId = (instanceId: string) => `bs:${instanceId}`;
export const invalidateDiscoveryCache = (ctx: BluestacksServiceContext) =>
  void (ctx.discoveryCache = null);
export async function withBsCarrierPermit<T>(
  ctx: BluestacksServiceContext,
  instanceId: string,
  signal: AbortSignal,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await ctx.workboard.acquireCarrierPermit(
    'bluestacks',
    bsCarrierId(instanceId),
    signal,
  );
  try {
    return await fn();
  } finally {
    release();
  }
}
export async function withTrackedDeviceOp<T>(
  ctx: BluestacksServiceContext,
  trackSet: Set<string>,
  instanceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  trackSet.add(instanceId);
  try {
    return await fn();
  } finally {
    trackSet.delete(instanceId);
    invalidateDiscoveryCache(ctx);
  }
}
export function setBsStat<T extends BumperProfileStat>(
  statsMap: Map<string, T>,
  id: string,
  patch: Partial<T> & { running: boolean; status: string },
): void {
  const cur = statsMap.get(id);
  const prevSteps =
    patch.running &&
    !('steps' in patch) &&
    cur &&
    'steps' in cur &&
    Array.isArray((cur as { steps?: unknown }).steps)
      ? { steps: (cur as { steps?: unknown }).steps }
      : {};
  statsMap.set(id, {
    session: cur?.session ?? 0,
    today: cur?.today ?? 0,
    ...prevSteps,
    ...patch,
  } as T);
}
export const saveLastStatusSafe = (ctx: BluestacksServiceContext, id: string, status: string) =>
  ignoreError(ctx.repo.saveLastStatus(id, status.slice(0, 120)));
export const makeStatusReporter =
  (ctx: BluestacksServiceContext, id: string, persist = true) =>
  (text: string) => {
    ctx.statusText = text;
    if (persist) void saveLastStatusSafe(ctx, id, text);
  };
export const recordBsFailure = (
  ctx: BluestacksServiceContext,
  input: Parameters<PostBumpRecordsPort['insert']>[0],
) => {
  if (ctx.postBumpRecords) void ignoreError(ctx.postBumpRecords.insert(input));
};
export function classifyBsWorkerError(ctrl: AbortController, err: unknown, fallback = '运行异常') {
  const riskReason = extractRiskAbortReason(ctrl.signal, err);
  const rawMsg = errMsg(err, fallback);
  return { riskReason, rawMsg, stopped: ctrl.signal.aborted || rawMsg === 'TASK_STOPPED' };
}
export function deleteAllBsStats(ctx: BluestacksServiceContext, instanceId: string): void {
  for (const map of [
    ctx.profileStats,
    ctx.pageProfileStats,
    ctx.activeProfileStats,
    ctx.posterProfileStats,
    ctx.inviterProfileStats,
  ])
    map.delete(instanceId);
}
export function runWithBsSoldier<T>(
  ctx: BluestacksServiceContext,
  instanceId: string,
  moduleId: string,
  controller: AbortController,
  work: () => Promise<T>,
): Promise<T> {
  const cid = bsCarrierId(instanceId);
  const enter = () =>
    ctx.workboard.runSoldier(
      { carrierId: cid, carrierKind: 'bluestacks', moduleId },
      async (soldier) => {
        const onAbort = () =>
          !controller.signal.aborted && controller.abort(new Error('TASK_STOPPED'));
        if (soldier.signal.aborted) onAbort();
        else soldier.signal.addEventListener('abort', onAbort, { once: true });
        try {
          return await work();
        } finally {
          soldier.signal.removeEventListener('abort', onAbort);
        }
      },
    );
  return ctx.workboard.isCarrierBusy(cid)
    ? ctx.workboard.waitUntilCarrierIdle(cid, 1500).then(enter)
    : enter();
}
export function runLinkedExtraWorker<T>(
  ctx: BluestacksServiceContext,
  instanceId: string,
  kind: ExtraExecutionKind,
  externalSignal: AbortSignal | undefined,
  onAbortedInitially: () => T,
  execute: (controller: AbortController) => Promise<T>,
  cleanup?: () => Promise<void> | void,
  onBusy?: () => T,
): Promise<T> {
  const { controller, abortedInitially, detach } = linkAbortSignal(externalSignal);
  if (abortedInitially) return Promise.resolve(onAbortedInitially());
  if (isInstanceBusyInOtherWorker(ctx, instanceId)) {
    detach();
    return Promise.resolve((onBusy ?? onAbortedInitially)());
  }
  let entry!: { kind: ExtraExecutionKind; controller: AbortController; promise: Promise<void> };
  const run = (async () => {
    try {
      return await execute(controller);
    } finally {
      detach();
      if (ctx.extraWorkers.get(instanceId) === entry) ctx.extraWorkers.delete(instanceId);
      await cleanup?.();
    }
  })();
  entry = {
    kind,
    controller,
    promise: run.then(
      () => undefined,
      () => undefined,
    ),
  };
  ctx.extraWorkers.set(instanceId, entry);
  return run;
}
export function hasExtraExecution(
  ctx: BluestacksServiceContext,
  kind?: ExtraExecutionKind,
): boolean {
  for (const w of ctx.extraWorkers.values()) if (!kind || w.kind === kind) return true;
  for (const q of ctx.queuedExtraTasks.values()) if (!kind || q.kind === kind) return true;
  return false;
}
const transientSets = (ctx: BluestacksServiceContext) => [
  ctx.launchingIds,
  ctx.closingIds,
  ctx.inspectingIds,
  ctx.installingIds,
  ctx.loggingInIds,
  ctx.switchingIds,
];
export function isProfileRunning(
  ctx: BluestacksServiceContext,
  instanceId: string,
  mode?: BluestacksBumperMode,
): boolean {
  if (mode)
    return (
      (ctx.activeWorkers.has(instanceId) && ctx.activeWorkerModes.get(instanceId) === mode) ||
      ctx.queuedTasks.some((t) => t.instanceId === instanceId && t.mode === mode)
    );
  return (
    ctx.activeWorkers.has(instanceId) ||
    ctx.queuedTasks.some((t) => t.instanceId === instanceId) ||
    ctx.extraWorkers.has(instanceId) ||
    ctx.queuedExtraTasks.has(instanceId) ||
    ctx.closingIds.has(instanceId)
  );
}
export function hasActiveExecution(
  ctx: BluestacksServiceContext,
  mode?: BluestacksBumperMode,
): boolean {
  if (mode) {
    for (const m of ctx.activeWorkerModes.values()) if (m === mode) return true;
    return ctx.queuedTasks.some((t) => t.mode === mode);
  }
  return (
    ctx.activeWorkers.size > 0 ||
    ctx.queuedTasks.length > 0 ||
    ctx.extraWorkers.size > 0 ||
    ctx.queuedExtraTasks.size > 0 ||
    transientSets(ctx).some((s) => s.size > 0) ||
    Boolean(ctx.batchLoginState?.running) ||
    Boolean(ctx.healthCheckState?.running)
  );
}
const hasInstanceBusyState = (
  ctx: BluestacksServiceContext,
  instanceId: string,
  includeLaunch: boolean,
): boolean => {
  const op = ctx.instanceOpWorkers.get(instanceId);
  return (
    isProfileRunning(ctx, instanceId) ||
    Boolean(op && (includeLaunch || op.kind !== 'launch')) ||
    (includeLaunch
      ? transientSets(ctx)
      : [ctx.closingIds, ctx.inspectingIds, ctx.installingIds, ctx.loggingInIds, ctx.switchingIds]
    ).some((s) => s.has(instanceId))
  );
};
export const isInstanceBusyInOtherWorker = (ctx: BluestacksServiceContext, instanceId: string) =>
  hasInstanceBusyState(ctx, instanceId, true);
export const isInstanceConflictingWorker = (ctx: BluestacksServiceContext, instanceId: string) =>
  hasInstanceBusyState(ctx, instanceId, false);
export async function getDiscoverySnapshot(ctx: BluestacksServiceContext, force = false) {
  const cached = ctx.discoveryCache;
  if (!force && cached && Date.now() - cached.at < 2500)
    return {
      instances: await ctx.repo.listInstances([...ctx.devices.getOnlineKeys()]),
      config: cached.config,
    };
  if (ctx.discoveryInFlight) return ctx.discoveryInFlight;
  const p = ctx.devices
    .discoverInstances()
    .then(
      (res) => (
        (ctx.discoveryCache = { at: Date.now(), instances: res.instances, config: res.config }),
        res
      ),
    )
    .finally(() => {
      if (ctx.discoveryInFlight === p) ctx.discoveryInFlight = null;
    });
  ctx.discoveryInFlight = p;
  return p;
}
export const launchTrackedInstance = (
  ctx: BluestacksServiceContext,
  instanceId: string,
  signal?: AbortSignal,
) =>
  withTrackedDeviceOp(ctx, ctx.launchingIds, instanceId, () =>
    ctx.workboard.runStaggeredLaunch(signal, () => ctx.devices.launchInstance(instanceId, signal)),
  );
export async function ensurePortraitInstanceOnline(
  ctx: BluestacksServiceContext,
  instanceId: string,
  opts: {
    forceDiscover: boolean;
    launchStatus: string;
    signal?: AbortSignal;
    waitWhileLaunching?: boolean;
    onStatus?: (text: string) => void;
  },
): Promise<BluestacksInstance> {
  if (opts.waitWhileLaunching) {
    while (ctx.launchingIds.has(instanceId) && !opts.signal?.aborted) {
      opts.onStatus?.('等待蓝蝶窗口启动完成…');
      await sleepMs(300, opts.signal);
    }
    if (opts.signal?.aborted) throw new Error('TASK_STOPPED');
  }
  const existing = (await getDiscoverySnapshot(ctx, opts.forceDiscover)).instances.find(
    (i) => i.id === instanceId,
  );
  if (!existing)
    throw new ProductError('BLUESTACKS_INSTANCE_NOT_FOUND', '未找到指定的蓝蝶模拟器实例', 404);
  if (!isBluestacksPortraitResolution(existing.fbWidth, existing.fbHeight))
    failError(
      'BLUESTACKS_LANDSCAPE_UNSUPPORTED',
      `模拟器为横屏 (${existing.fbWidth}×${existing.fbHeight})，需改为竖屏`,
      400,
    );
  if (existing.online) return existing;
  opts.onStatus?.('正在自动启动蓝蝶窗口…');
  const launched = await launchTrackedInstance(ctx, instanceId, opts.signal);
  await saveLastStatusSafe(ctx, instanceId, opts.launchStatus);
  return launched;
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
export function runFireAndForgetInstanceBatch(
  ctx: BluestacksServiceContext,
  ids: readonly string[],
  trackSet: Set<string>,
  startText: string,
  errPrefix: string,
  perItem: (id: string, saveText: (text: string) => void, signal: AbortSignal) => Promise<void>,
  onDone: (okCount: number, errors: string[]) => string,
  interDelayMs = 0,
  opKind: 'launch' | 'inspect' | 'install-apk' = 'launch',
): void {
  const controllers = new Map<string, AbortController>();
  const resolvers = new Map<string, () => void>();
  for (const id of ids) {
    trackSet.add(id);
    const controller = new AbortController();
    controllers.set(id, controller);
    const promise = new Promise<void>((resolve) => resolvers.set(id, resolve));
    ctx.instanceOpWorkers.set(id, { kind: opKind, controller, promise });
  }
  ctx.statusText = startText;
  void (async () => {
    let okCount = 0;
    const errors: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!id) continue;
      const ctrl = controllers.get(id);
      try {
        if (ctrl?.signal.aborted) {
          errors.push('已手动停止');
          await saveLastStatusSafe(ctx, id, `${errPrefix}已手动停止`);
        } else {
          await withTrackedDeviceOp(ctx, trackSet, id, () =>
            perItem(id, makeStatusReporter(ctx, id), ctrl?.signal ?? new AbortController().signal),
          );
          okCount++;
        }
      } catch (err) {
        const msg = ctrl?.signal.aborted ? '已手动停止' : errMsg(err, '操作失败');
        errors.push(msg);
        await saveLastStatusSafe(ctx, id, `${errPrefix}${msg}`);
      } finally {
        trackSet.delete(id);
        if (ctx.instanceOpWorkers.get(id)?.controller === ctrl) ctx.instanceOpWorkers.delete(id);
        resolvers.get(id)?.();
      }
      if (interDelayMs > 0 && i + 1 < ids.length) await sleepMs(interDelayMs).catch(() => {});
    }
    ctx.statusText = onDone(okCount, errors);
  })();
}
const TRANSIENT_LABELS =
  'launchingIds:正在启动窗口…|closingIds:正在关闭窗口…|inspectingIds:正在识别账号…|installingIds:正在安装 FB Lite…|loggingInIds:正在自动登录账号…|switchingIds:正在切换身份…'
    .split('|')
    .map(
      (s) =>
        s.split(':') as [
          (
            | 'launchingIds'
            | 'closingIds'
            | 'inspectingIds'
            | 'installingIds'
            | 'loggingInIds'
            | 'switchingIds'
          ),
          string,
        ],
    );
export function buildDefaultInstanceStatus(
  ctx: BluestacksServiceContext,
  inst: BluestacksInstance,
): string {
  for (const [key, label] of TRANSIENT_LABELS) if (ctx[key].has(inst.id)) return label;
  if (!inst.online)
    return inst.lastStatus === '窗口已启动' || inst.lastStatus?.startsWith('账号已识别')
      ? '未启动'
      : inst.lastStatus || '未启动';
  if (!isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight))
    return `横屏 ${inst.fbWidth}×${inst.fbHeight}（需改竖屏）`;
  if (inst.fbLiteInstalled === false || inst.accountState === 'missing-app')
    return '未安装 FB Lite';
  if (inst.accountState === 'logged-out') return '未登录 FB Lite';
  if (inst.accountState === 'verification') return '需安全验证 (Checkpoint)';
  if (inst.accountState === 'restricted') return '账号受限/停用';
  return inst.lastStatus === '已关闭' || inst.lastStatus?.startsWith('启动失败')
    ? '在线就绪'
    : inst.lastStatus || '在线就绪';
}
export async function guardInstanceRiskQuota(
  ctx: BluestacksServiceContext,
  instanceId: string,
  actionKind?: BluestacksRiskActionKind,
  saveStatus = true,
): Promise<string | null> {
  if (!ctx.repo.dailyInstanceUsage) return null;
  const [saved, usage] = await Promise.all([
    ctx.repo.savedSettings(),
    Promise.resolve(ctx.repo.dailyInstanceUsage()).catch(() => null),
  ]);
  const risk = saved.riskLimitSettings ?? DEFAULT_BLUESTACKS_RISK_LIMIT_SETTINGS;
  if (!risk.enabled || !usage) return null;
  const counts = usage.perInstance[instanceId] ?? {
    groupBumpsToday: 0,
    pageBumpsToday: 0,
    postsToday: 0,
    invitesToday: 0,
    activeLikesToday: 0,
    activeActionsToday: 0,
  };
  const res = evaluateBluestacksRiskQuota(risk, instanceId, counts, actionKind ?? 'active-like');
  const blocked = actionKind
    ? !res.allowed
    : res.effectiveLimits.dailyMaxTotalActions > 0 &&
      res.totalActions >= res.effectiveLimits.dailyMaxTotalActions;
  if (!blocked) return null;
  const msg = actionKind
    ? (res.reason ?? '今日已达蓝蝶风控安全上限，自动休眠保护')
    : `今日已达蓝蝶总操作上限 (${res.totalActions}/${res.effectiveLimits.dailyMaxTotalActions})，自动休眠保护`;
  if (saveStatus) await saveLastStatusSafe(ctx, instanceId, msg);
  return msg;
}
export const triggerRiskQuotaAbort = (
  ctx: BluestacksServiceContext,
  instanceId: string,
  actionKind: BluestacksRiskActionKind | undefined,
  controller: AbortController,
) =>
  void guardInstanceRiskQuota(ctx, instanceId, actionKind, false)
    .then(
      (msg) =>
        msg &&
        !controller.signal.aborted &&
        controller.abort(new Error(`RISK_LIMIT_REACHED:${msg}`)),
    )
    .catch(() => {});
export async function isExternallyBusy(
  ctx: BluestacksServiceContext,
  instanceId: string,
): Promise<boolean> {
  if (!ctx.registry) return false;
  for (const p of ctx.registry.participants())
    if (!p.id.startsWith('bluestacks-') && (await p.isProfileRunning(instanceId))) return true;
  return false;
}
export async function prepareIdlePortraitInstances(
  ctx: BluestacksServiceContext,
  profileIds: readonly string[],
  instances: readonly BluestacksInstance[],
  riskKind: BluestacksRiskActionKind | undefined,
  statsMap: Map<string, BumperProfileStat>,
  busyMessage = '所选蓝蝶窗口正忙于其他任务',
): Promise<string[]> {
  const instMap = new Map(instances.map((i) => [i.id, i]));
  const idleIds = [...new Set(profileIds)].filter((id) => !isProfileRunning(ctx, id));
  if (!idleIds.length)
    throw new ProductError('INSTANCES_ALREADY_RUNNING', '所选模拟器已在运行队列中', 409);
  const eligibleReady: string[] = [];
  const skippedReasons: string[] = [];
  const markSkipped = (id: string, reason: string, status: string) => {
    skippedReasons.push(reason);
    setBsStat(statsMap, id, { running: false, status });
  };
  for (const id of idleIds) {
    const inst = instMap.get(id);
    if (!inst) continue;
    const label = bluestacksDisplayTitle(inst);
    if (ctx.closingIds.has(id)) markSkipped(id, `${label} 正在关闭`, '跳过：窗口正在关闭');
    else if (!isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight))
      markSkipped(
        id,
        `${label} 为横屏 (${inst.fbWidth}×${inst.fbHeight})`,
        `跳过：横屏 ${inst.fbWidth}×${inst.fbHeight}（需改竖屏）`,
      );
    else eligibleReady.push(id);
  }
  if (!eligibleReady.length)
    failError(
      'NO_ONLINE_PORTRAIT_INSTANCES',
      skippedReasons.length
        ? `无法启动运行：${skippedReasons.slice(0, 3).join('；')}`
        : '未找到可用的竖屏蓝蝶窗口，请先检查蓝蝶分辨率设置',
      400,
    );
  const idleReady: string[] = [];
  for (const id of eligibleReady) if (!(await isExternallyBusy(ctx, id))) idleReady.push(id);
  if (!idleReady.length) throw new ProductError('NO_IDLE_INSTANCES', busyMessage, 409);
  const allowedIds: string[] = [];
  let firstBlocked: string | null = null;
  for (const id of idleReady) {
    const blockedMsg = await guardInstanceRiskQuota(ctx, id, riskKind);
    if (!blockedMsg) allowedIds.push(id);
    else {
      firstBlocked ??= blockedMsg;
      setBsStat(statsMap, id, { running: false, status: blockedMsg });
    }
  }
  if (!allowedIds.length && firstBlocked)
    throw new ProductError('BLUESTACKS_DAILY_RISK_LIMIT', firstBlocked, 409);
  return allowedIds;
}
export async function stopExtraWorkers(
  ctx: BluestacksServiceContext,
  kind?: ExtraExecutionKind,
  ids?: readonly string[],
): Promise<void> {
  const idSet = ids?.length ? new Set(ids) : null;
  const abortTask = (
    id: string,
    item: { kind: ExtraExecutionKind; controller: AbortController },
  ) => {
    if ((kind && item.kind !== kind) || (idSet && !idSet.has(id))) return false;
    item.controller.abort(new Error('TASK_STOPPED'));
    ctx.workboard.abortCarrier(bsCarrierId(id), 'TASK_STOPPED');
    return true;
  };
  for (const [id, q] of [...ctx.queuedExtraTasks.entries()]) {
    if (!abortTask(id, q)) continue;
    ctx.queuedExtraTasks.delete(id);
    setBsStat(q.statsMap, id, { running: false, status: '已停止' });
  }
  const waits = [...ctx.extraWorkers.entries()].flatMap(([id, w]) =>
    abortTask(id, w) ? [w.promise] : [],
  );
  if (waits.length) await Promise.allSettled(waits);
  for (const [k, field, msg] of [
    ['active', 'activeStatusText', '已停止蓝蝶活跃任务'],
    ['poster', 'posterStatusText', '已停止蓝蝶发帖任务'],
    ['inviter', 'inviterStatusText', '已停止蓝蝶小组邀请任务'],
  ] as const)
    if ((!kind || kind === k) && !hasExtraExecution(ctx, k)) ctx[field] = msg;
}
export async function ensureFbLiteApk(
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
export async function closeInstanceIfIdleAfterFinish(
  ctx: BluestacksServiceContext,
  instanceId: string,
  enabled: boolean | undefined,
  onError?: (err: unknown) => void,
): Promise<boolean> {
  if (!enabled || isInstanceBusyInOtherWorker(ctx, instanceId)) return false;
  if (await isExternallyBusy(ctx, instanceId).catch(() => true)) return false;
  if (isInstanceBusyInOtherWorker(ctx, instanceId)) return false;
  let closed = false;
  await withTrackedDeviceOp(ctx, ctx.closingIds, instanceId, async () => {
    try {
      await ctx.devices.closeInstance(instanceId);
      closed = true;
    } catch (err) {
      onError?.(err);
    }
  });
  return closed;
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
): Promise<PatrolPrepResult> {
  const sig = workerEntry.controller.signal;
  let releasePermit: (() => void) | undefined;
  const fail = (
    reason: PrepFailReason,
    inst?: BluestacksInstance,
    launched = false,
    claimed = false,
  ): PatrolPrepResult => {
    releasePermit?.();
    return { ok: false, reason, ...(inst ? { inst } : {}), launched, autoRepaired: false, claimed };
  };
  if (sig.aborted) return fail('stopped');
  let inst = (await getDiscoverySnapshot(ctx, false)).instances.find((i) => i.id === instanceId);
  if (!inst) return fail('missing');
  if (!isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight)) return fail('landscape', inst);
  const feature = kind === 'health-check' ? 'bluestacks-health-check' : 'bluestacks-batch-login';
  if (
    isInstanceBusyInOtherWorker(ctx, instanceId) ||
    (ctx.registry ? await ctx.registry.isProfileBusy(instanceId, feature) : false) ||
    isInstanceBusyInOtherWorker(ctx, instanceId)
  )
    return fail('busy', inst);
  ctx.extraWorkers.set(instanceId, workerEntry);
  if (onCheckSkip?.(inst)) return fail('busy', inst, false, true);
  let launched = false;
  if (
    !inst.online &&
    !autoLaunch &&
    !autoInstallApk &&
    (inst.fbLiteInstalled === false || inst.accountState === 'missing-app')
  )
    return fail('apk-missing', inst, false, true);
  if (!inst.online && !autoLaunch) return fail('launch-missing', inst, false, true);
  releasePermit = await ctx.workboard.acquireCarrierPermit(
    'bluestacks',
    bsCarrierId(instanceId),
    sig,
  );
  try {
    if (sig.aborted) return fail('stopped', inst, false, true);
    if (!inst.online) {
      setStep(kind === 'health-check' ? '正在自动拉起蓝蝶窗口…' : '正在自动启动蓝蝶窗口…');
      inst = await launchTrackedInstance(ctx, inst.id, sig);
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
      releasePermit,
    };
  } catch (err) {
    releasePermit?.();
    throw err;
  }
}
export async function runPatrolItemLifecycle<
  TItem extends {
    instanceId: string;
    instanceName: string;
    stepText: string;
    status: string;
    startedAt?: number;
    finishedAt?: number;
  },
>(opts: {
  ctx: BluestacksServiceContext;
  kind: PatrolKind;
  item: TItem;
  parentSignal: AbortSignal;
  autoLaunch: boolean;
  autoInstallApk: boolean;
  persistStepStatus?: boolean;
  defaultErr: string;
  closeOnFinish: boolean;
  onCheckSkip?: (inst: BluestacksInstance) => boolean;
  onPreparedInstance?: (inst: BluestacksInstance) => void;
  onPrepFailed: (prep: PatrolPrepResult) => void;
  execute: (
    prep: PatrolPrepResult,
    signal: AbortSignal,
    setStep: (t: string) => void,
  ) => Promise<boolean | void>;
  onError: (msg: string, stopped: boolean, err: unknown) => Promise<void>;
  onFinally?: (claimed: boolean) => void;
  onAfterItem: () => void;
}): Promise<void> {
  const { ctx, kind, item } = opts;
  const { controller: itemCtrl, detach } = linkAbortSignal(opts.parentSignal);
  const setStep = (text: string) => {
    item.stepText = text;
    ctx.statusText = `${item.instanceName}：${text}`;
    if (opts.persistStepStatus) void saveLastStatusSafe(ctx, item.instanceId, text);
  };
  let launched = false;
  let claimed = false;
  let shouldCloseOnExit = false;
  let releasePermit: (() => void) | undefined;
  const workerEntry = { kind, controller: itemCtrl, promise: Promise.resolve() };
  const workerPromise = (async () => {
    try {
      item.status = 'running';
      item.startedAt = Date.now();
      const prep = await preparePatrolInstance(
        ctx,
        item.instanceId,
        kind,
        workerEntry,
        opts.autoLaunch,
        opts.autoInstallApk,
        setStep,
        opts.onCheckSkip,
      );
      launched = prep.launched;
      claimed = prep.claimed;
      releasePermit = prep.releasePermit;
      if (prep.inst) {
        item.instanceName = bluestacksDisplayTitle(prep.inst);
        opts.onPreparedInstance?.(prep.inst);
      }
      if (!prep.ok) return opts.onPrepFailed(prep);
      shouldCloseOnExit = opts.closeOnFinish && launched;
      if ((await opts.execute(prep, itemCtrl.signal, setStep)) === false) shouldCloseOnExit = false;
    } catch (err) {
      const msg = errMsg(err, opts.defaultErr);
      await opts.onError(msg, itemCtrl.signal.aborted || msg === 'TASK_STOPPED', err);
    } finally {
      releasePermit?.();
      detach();
      if (claimed && ctx.extraWorkers.get(item.instanceId) === workerEntry)
        ctx.extraWorkers.delete(item.instanceId);
      opts.onFinally?.(claimed);
      if (shouldCloseOnExit && launched) await closePatrolInstance(ctx, item.instanceId, item);
      opts.onAfterItem();
      item.finishedAt = Date.now();
      invalidateDiscoveryCache(ctx);
    }
  })();
  workerEntry.promise = workerPromise;
  await workerPromise;
}
