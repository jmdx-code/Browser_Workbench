import type { AutoRunStatus, AutoScheduleRunItem } from '../../shared/auto-scheduler.js';
import {
  finishTargetContext,
  type ActiveTargetExecutionContext,
  type TargetProgressPatch,
} from '../auto-scheduler-executor.js';
import type {
  LiveRunTracker,
  QueuedTargetWork,
  SchedulerRuntimeContext,
} from '../auto-scheduler-service.js';
import {
  errMsg,
  ignoreError,
  pumpQueuedWorkers,
  sleepMs,
  sortTargetsOnlineFirst,
} from '../module-worker-pool.js';
import { isWorkAbortError } from '../workboard.js';
const STOP_SETTLE_TIMEOUT_MS = 26_000;
export function recomputeRunCounters(tracker: LiveRunTracker): void {
  const counts = { completed: 0, soft: 0, hard: 0, timeout: 0, skipped: 0, running: 0, queued: 0 };
  for (const item of tracker.items.values()) {
    if (item.status === 'completed') counts.completed++;
    else if (item.status === 'soft_warning') {
      counts.completed++;
      counts.soft++;
    } else if (item.status === 'hard_blocked') counts.hard++;
    else if (item.status === 'watchdog_timeout') counts.timeout++;
    else if (item.status === 'skipped') counts.skipped++;
    else if (item.status === 'running') counts.running++;
    else if (item.status === 'queued') counts.queued++;
  }
  Object.assign(tracker.run, {
    completedCount: counts.completed,
    softIssueCount: counts.soft,
    hardBlockedCount: counts.hard,
    watchdogTimeoutCount: counts.timeout,
    skippedCount: counts.skipped,
  });
  if (counts.running + counts.queued > 0 && !tracker.cancelled)
    tracker.run.statusReason = `运行 ${counts.running} / 排队 ${counts.queued} · 已完成 ${counts.completed}/${tracker.run.totalTargets}`;
}
export async function checkAndFinalizeRun(
  ctx: SchedulerRuntimeContext,
  runId: string,
): Promise<void> {
  const tracker = ctx.liveRuns.get(runId);
  if (!tracker) return;
  const hasPending = [...tracker.items.values()].some(
    (i) => i.status === 'queued' || i.status === 'running',
  );
  recomputeRunCounters(tracker);
  if (hasPending) return void (await ctx.repo.saveRun(tracker.run));
  tracker.run.finishedAt = ctx.now();
  const allItems = [...tracker.items.values()];
  const stoppedCount = allItems.filter((i) => i.status === 'stopped').length;
  const allStopped = allItems.length > 0 && stoppedCount === allItems.length;
  const status: AutoRunStatus =
    tracker.cancelled || allStopped
      ? 'stopped'
      : tracker.run.hardBlockedCount > 0 || tracker.run.watchdogTimeoutCount > 0 || stoppedCount > 0
        ? 'partial'
        : 'completed';
  tracker.run.status = status;
  const parts = [
    `完成 ${tracker.run.completedCount}`,
    tracker.run.softIssueCount > 0 ? `含软受限收尾 ${tracker.run.softIssueCount}` : '',
    tracker.run.hardBlockedCount > 0 ? `封号/掉登摘除 ${tracker.run.hardBlockedCount}` : '',
    tracker.run.watchdogTimeoutCount > 0 ? `看门狗回收 ${tracker.run.watchdogTimeoutCount}` : '',
    tracker.run.skippedCount > 0 ? `跳过 ${tracker.run.skippedCount}` : '',
    stoppedCount > 0 ? `手动停止 ${stoppedCount}` : '',
  ]
    .filter(Boolean)
    .join(' / ');
  tracker.run.statusReason = ctx.shuttingDown
    ? '工作台重启收尾'
    : tracker.cancelled || allStopped
      ? `已手动停止（${parts}）`
      : `已结束 · ${parts}`;
  ctx.liveRuns.delete(runId);
  await ctx.repo.saveRun(tracker.run);
  if (
    tracker.run.triggerMode === 'cron' &&
    tracker.schedule.trigger.mode === 'once' &&
    !ctx.shuttingDown
  ) {
    await Promise.resolve(
      ctx.repo.toggleSchedule({ id: tracker.schedule.id, enabled: false }),
    ).catch(() => {});
    const latest = await Promise.resolve(ctx.repo.listSchedules()).catch(() => null);
    if (latest) ctx.cachedEnabledScheduleCount = latest.filter((s) => s.enabled).length;
  }
  ctx.markMutated();
  ctx.syncPowerLock();
}
async function getOnlineTargetIds(
  ctx: SchedulerRuntimeContext,
  isBrowser: boolean,
): Promise<Set<string>> {
  if (isBrowser) {
    const snap = await ctx.deps.workspace.snapshot().catch(() => null);
    return new Set((snap?.profiles ?? []).filter((p) => p.online).map((p) => p.id));
  }
  const bsState = ctx.deps.bluestacks
    ? await ctx.deps.bluestacks.state(false).catch(() => null)
    : null;
  return new Set((bsState?.instances ?? []).filter((i) => i.online).map((i) => i.id));
}
function runPumpQueuedWorkers(
  ctx: SchedulerRuntimeContext,
  carrier: 'browser' | 'bluestacks',
): void {
  const isBrowser = carrier === 'browser';
  pumpQueuedWorkers({
    queue: isBrowser ? ctx.browserQueue : ctx.bluestacksQueue,
    getCapacity: () =>
      isBrowser ? ctx.cachedSettings.browserConcurrency : ctx.cachedSettings.bluestacksConcurrency,
    getActiveCount: () => (isBrowser ? ctx.activeBrowserWorkers : ctx.activeBluestacksWorkers),
    incrementActive: () =>
      void (isBrowser ? ctx.activeBrowserWorkers++ : ctx.activeBluestacksWorkers++),
    decrementActive: () => {
      if (isBrowser) ctx.activeBrowserWorkers = Math.max(0, ctx.activeBrowserWorkers - 1);
      else ctx.activeBluestacksWorkers = Math.max(0, ctx.activeBluestacksWorkers - 1);
    },
    isTargetActive: (targetId) => ctx.activeContexts.has(targetId),
    startWork: async (work) => {
      ctx.ownedTargets.add(work.targetId);
      const targetCtx: ActiveTargetExecutionContext = {
        runId: work.tracker.run.id,
        scheduleId: work.tracker.schedule.id,
        targetId: work.targetId,
        cancelled: work.tracker.cancelled,
        keepWindowOpenOnCancel: false,
        finished: false,
        onHandoffReady: [],
        abortStep: () => {},
      };
      ctx.activeContexts.set(work.targetId, targetCtx);
      try {
        await runCarrierWorkItem(ctx, work, targetCtx, isBrowser);
      } finally {
        ctx.activeContexts.delete(work.targetId);
        ctx.ownedTargets.delete(work.targetId);
        finishTargetContext(targetCtx);
      }
    },
    onError: async (work, err) => {
      const cur = work.tracker.items.get(work.targetId);
      await commitTerminalItem(ctx, work, {
        status: 'soft_warning',
        currentStep: '执行异常',
        summary: `执行异常：${errMsg(err).slice(0, 120)}`,
        softIssues: (cur?.softIssues ?? 0) + 1,
      });
    },
    onFinally: (work) => {
      void checkAndFinalizeRun(ctx, work.tracker.run.id);
      pumpCarrierPool(ctx, carrier);
    },
  });
}
export function pumpCarrierPool(
  ctx: SchedulerRuntimeContext,
  carrier: 'browser' | 'bluestacks',
): void {
  if (ctx.shuttingDown) return;
  const isBrowser = carrier === 'browser',
    pumpingKey = isBrowser ? 'pumpingBrowser' : 'pumpingBluestacks',
    repumpKey = isBrowser ? 'repumpBrowser' : 'repumpBluestacks';
  if (ctx[pumpingKey]) {
    ctx[repumpKey] = true;
    return;
  }
  const queue = isBrowser ? ctx.browserQueue : ctx.bluestacksQueue;
  if (queue.length <= 1) {
    ctx[pumpingKey] = true;
    try {
      runPumpQueuedWorkers(ctx, carrier);
    } finally {
      ctx[pumpingKey] = false;
    }
    if (ctx[repumpKey] && !ctx.shuttingDown) {
      ctx[repumpKey] = false;
      pumpCarrierPool(ctx, carrier);
    }
    return;
  }
  ctx[pumpingKey] = true;
  void (async () => {
    try {
      do {
        ctx[repumpKey] = false;
        if (ctx.shuttingDown) break;
        if (queue.length > 1) {
          const onlineIds = await getOnlineTargetIds(ctx, isBrowser);
          if (ctx.shuttingDown) break;
          const before = [...queue];
          const sorted = await sortTargetsOnlineFirst(before, (w) => onlineIds.has(w.targetId));
          const currentSet = new Set(queue),
            beforeSet = new Set(before);
          queue.splice(
            0,
            queue.length,
            ...sorted.filter((w) => currentSet.has(w)),
            ...queue.filter((w) => !beforeSet.has(w)),
          );
        }
        runPumpQueuedWorkers(ctx, carrier);
      } while (ctx[repumpKey] && !ctx.shuttingDown);
    } finally {
      ctx[pumpingKey] = false;
    }
  })();
}
async function commitTerminalItem(
  ctx: SchedulerRuntimeContext,
  work: QueuedTargetWork,
  patch: Partial<AutoScheduleRunItem> &
    Pick<AutoScheduleRunItem, 'status' | 'currentStep' | 'summary'>,
): Promise<void> {
  const doneAt = ctx.now();
  const cur = work.tracker.items.get(work.targetId);
  const doneItem: AutoScheduleRunItem = {
    runId: work.tracker.run.id,
    targetId: work.targetId,
    targetName: work.targetName,
    bumpedCount: cur?.bumpedCount ?? 0,
    postedCount: cur?.postedCount ?? 0,
    softIssues: cur?.softIssues ?? 0,
    hardBlockReason: cur?.hardBlockReason ?? null,
    startedAt: cur?.startedAt ?? doneAt,
    ...patch,
    currentStep: patch.currentStep.slice(0, 200),
    summary: patch.summary.slice(0, 400),
    finishedAt: doneAt,
    updatedAt: doneAt,
  };
  work.tracker.items.set(work.targetId, doneItem);
  ctx.markMutated();
  await ignoreError(ctx.repo.saveRunItem(doneItem));
}
async function waitStaggerDelay(
  waitMs: number,
  targetCtx: ActiveTargetExecutionContext,
  shouldStop: () => boolean,
): Promise<void> {
  if (waitMs <= 0 || shouldStop()) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      targetCtx.abortStep = () => {};
      resolve();
    }, waitMs);
    timer.unref?.();
    targetCtx.abortStep = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}
async function runCarrierWorkItem(
  ctx: SchedulerRuntimeContext,
  work: QueuedTargetWork,
  targetCtx: ActiveTargetExecutionContext,
  isBrowser: boolean,
): Promise<void> {
  if (work.tracker.schedule.carrier !== (isBrowser ? 'browser' : 'bluestacks')) return;
  const shouldStop = () => targetCtx.cancelled;
  const finishEarlyStop = (stoppedMsg = isBrowser ? '已停止' : '已取消启动模拟器') =>
    commitTerminalItem(ctx, work, {
      status: 'stopped',
      currentStep: '已结束',
      summary: stoppedMsg,
    });
  if (shouldStop() || ctx.shuttingDown) return finishEarlyStop('已停止');
  if (await ctx.deps.featureExecution.isProfileBusy(work.targetId, 'auto-scheduler')) {
    return commitTerminalItem(ctx, work, {
      status: 'skipped',
      currentStep: '已自动跳过',
      summary: isBrowser
        ? '跳过：等待并发期间该账号已启动其他任务'
        : '跳过：等待并发期间该模拟器已启动其他任务',
    });
  }
  let releasePermit: (() => void) | undefined;
  if (ctx.deps.workboard) {
    const permitAbort = new AbortController();
    targetCtx.abortStep = () => permitAbort.abort('USER_STOP');
    try {
      releasePermit = await ctx.deps.workboard.acquireCarrierPermit(
        isBrowser ? 'browser' : 'bluestacks',
        isBrowser ? work.targetId : `bs:${work.targetId}`,
        permitAbort.signal,
      );
    } catch (err) {
      if (isWorkAbortError(err) || shouldStop() || ctx.shuttingDown)
        return finishEarlyStop('已停止');
      throw err;
    } finally {
      targetCtx.abortStep = () => {};
    }
  }
  try {
    if (shouldStop() || ctx.shuttingDown) return finishEarlyStop('已停止');
    let bsAlreadyOnline = false;
    let bsWaitMs = 0;
    if (!isBrowser) {
      const bsState = ctx.deps.bluestacks
        ? await ctx.deps.bluestacks.state(false).catch(() => null)
        : null;
      if (shouldStop() || ctx.shuttingDown) return finishEarlyStop('已停止');
      bsAlreadyOnline = Boolean(bsState?.instances.find((i) => i.id === work.targetId)?.online);
      if (!bsAlreadyOnline) {
        const nowMs = ctx.now();
        const rawStagger = ctx.cachedSettings.launchStaggerSeconds * 1000;
        const earliest = ctx.lastBluestacksLaunchAt + Math.max(2000, rawStagger);
        bsWaitMs = Math.max(0, earliest - nowMs);
        ctx.lastBluestacksLaunchAt = Math.max(nowMs, earliest);
      }
    }
    const existingItem = work.tracker.items.get(work.targetId);
    const startItem: AutoScheduleRunItem = {
      ...(existingItem ?? {
        runId: work.tracker.run.id,
        targetId: work.targetId,
        targetName: work.targetName,
        bumpedCount: 0,
        postedCount: 0,
        softIssues: 0,
        hardBlockReason: null,
        finishedAt: null,
      }),
      status: 'running',
      currentStep: isBrowser ? '正在启动…' : bsWaitMs > 0 ? '错峰启动模拟器…' : '正在启动模拟器…',
      summary: isBrowser ? '开始执行流水线' : '准备拉起蓝蝶实例',
      startedAt: ctx.now(),
      updatedAt: ctx.now(),
    };
    work.tracker.items.set(work.targetId, startItem);
    recomputeRunCounters(work.tracker);
    ctx.markMutated();
    await ctx.repo.saveRunItem(startItem);
    await ctx.repo.saveRun(work.tracker.run);
    if (!isBrowser && !bsAlreadyOnline) await waitStaggerDelay(bsWaitMs, targetCtx, shouldStop);
    if (shouldStop() || ctx.shuttingDown)
      return finishEarlyStop(isBrowser ? '已取消启动' : '已取消启动模拟器');
    let lastSavedAt = 0;
    const onUpdate = (patch: TargetProgressPatch) => {
      const cur = work.tracker.items.get(work.targetId);
      if (!cur) return;
      const updated: AutoScheduleRunItem = {
        ...cur,
        currentStep: patch.currentStep.slice(0, 200),
        summary: patch.summary.slice(0, 400),
        bumpedCount: patch.bumpedCount,
        postedCount: patch.postedCount,
        softIssues: patch.softIssues,
        updatedAt: ctx.now(),
      };
      work.tracker.items.set(work.targetId, updated);
      if (ctx.now() - lastSavedAt >= 3000) {
        lastSavedAt = ctx.now();
        void ignoreError(ctx.repo.saveRunItem(updated));
      }
    };
    const outcome =
      work.tracker.schedule.carrier === 'browser'
        ? await ctx.executor.executeBrowserTarget({
            schedule: work.tracker.schedule,
            profileId: work.targetId,
            safetyCeilingMinutes: work.safetyCeilingMinutes,
            ctx: targetCtx,
            onUpdate,
          })
        : await ctx.executor.executeBluestacksTarget({
            schedule: work.tracker.schedule,
            instanceId: work.targetId,
            safetyCeilingMinutes: work.safetyCeilingMinutes,
            ctx: targetCtx,
            onUpdate,
          });
    await commitTerminalItem(ctx, work, {
      status: outcome.status,
      currentStep: '已结束',
      summary: outcome.summary,
      bumpedCount: outcome.bumpedCount,
      postedCount: outcome.postedCount,
      softIssues: outcome.softIssues,
      hardBlockReason: outcome.hardBlockReason ? outcome.hardBlockReason.slice(0, 240) : null,
    });
  } finally {
    releasePermit?.();
  }
}
async function drainStoppedWork(
  ctx: SchedulerRuntimeContext,
  matchWork: (work: QueuedTargetWork) => boolean,
  activeContexts: ActiveTargetExecutionContext[],
  keepOpen: boolean,
  queuedStep: string,
  queuedSummary: string,
  affectedRunIds: Set<string>,
): Promise<void> {
  for (const queue of [ctx.browserQueue, ctx.bluestacksQueue]) {
    for (let i = queue.length - 1; i >= 0; i--) {
      const w = queue[i];
      if (!w || !matchWork(w)) continue;
      queue.splice(i, 1);
      affectedRunIds.add(w.tracker.run.id);
      const item = w.tracker.items.get(w.targetId);
      if (item && item.status === 'queued') {
        const nextItem: AutoScheduleRunItem = {
          ...item,
          status: 'stopped',
          currentStep: queuedStep,
          summary: queuedSummary,
          finishedAt: ctx.now(),
          updatedAt: ctx.now(),
        };
        w.tracker.items.set(w.targetId, nextItem);
        void ctx.repo.saveRunItem(nextItem);
      }
    }
  }
  const activePromises = activeContexts.map((c) => {
    affectedRunIds.add(c.runId);
    c.cancelled = true;
    c.keepWindowOpenOnCancel = keepOpen;
    c.abortStep();
    return new Promise<void>((resolve) =>
      c.finished ? resolve() : void c.onHandoffReady.push(resolve),
    );
  });
  if (activePromises.length)
    await Promise.race([Promise.allSettled(activePromises), sleepMs(STOP_SETTLE_TIMEOUT_MS)]);
  for (const runId of affectedRunIds) await checkAndFinalizeRun(ctx, runId);
}
export async function stopSchedulerRuns(
  ctx: SchedulerRuntimeContext,
  options: { runId?: string; scheduleId?: string; keepOpen: boolean },
): Promise<void> {
  if (options.scheduleId) ctx.cancelledLaunchSchedules.add(options.scheduleId);
  else if (!options.runId) {
    for (const sid of ctx.launchingScheduleKeys) {
      if (sid) ctx.cancelledLaunchSchedules.add(sid);
    }
  }
  const targetRunIds = new Set<string>();
  for (const [runId, tracker] of ctx.liveRuns.entries()) {
    if (
      (options.runId && runId !== options.runId) ||
      (options.scheduleId && tracker.schedule.id !== options.scheduleId)
    )
      continue;
    targetRunIds.add(runId);
    tracker.cancelled = true;
  }
  await drainStoppedWork(
    ctx,
    (w) => targetRunIds.has(w.tracker.run.id),
    [...ctx.activeContexts.values()].filter((c) => targetRunIds.has(c.runId)),
    options.keepOpen,
    '已取消排队',
    '已手动停止',
    targetRunIds,
  );
}
export const stopSchedulerTargets = (
  ctx: SchedulerRuntimeContext,
  targetIds: readonly string[],
  keepWindowsOpen = false,
  runId?: string,
) => {
  const targetSet = new Set(targetIds);
  return drainStoppedWork(
    ctx,
    (w) => targetSet.has(w.targetId) && (!runId || w.tracker.run.id === runId),
    targetIds
      .map((tid) => ctx.activeContexts.get(tid))
      .filter(
        (c): c is ActiveTargetExecutionContext => c !== undefined && (!runId || c.runId === runId),
      ),
    keepWindowsOpen,
    '已停止',
    '已被单号手动停止',
    new Set(),
  );
};
