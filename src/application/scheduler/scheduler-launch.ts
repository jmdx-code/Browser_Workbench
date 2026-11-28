import { bluestacksDisplayTitle } from '../../shared/bluestacks.js';
import { profileDisplayName } from '../../shared/contracts.js';
import {
  computeDueScheduleTriggers,
  computeNextRunPreview,
  type AutoSchedule,
  type AutoScheduleRun,
  type AutoScheduleRunItem,
  type AutoSchedulerState,
} from '../../shared/auto-scheduler.js';
import type { LiveRunTracker, SchedulerRuntimeContext } from '../auto-scheduler-service.js';
import { pumpCarrierPool } from './scheduler-pool.js';
const BROWSER_ABNORMAL_LABELS: Record<string, string> = {
  'logged-out': '账号未登录',
  verification: '账号需验证 (Checkpoint)',
  restricted: '账号已封禁/全局受限',
};
const BLUESTACKS_ABNORMAL_LABELS: Record<string, string> = {
  'logged-out': 'FB Lite 未登录',
  'missing-app': '未安装 FB Lite',
  verification: '账号需验证 (Checkpoint)',
  restricted: '账号已封禁/全局受限',
};
const matchesSelector = (
  selector: AutoSchedule['targetSelector'],
  groupId: string | null,
  targetId: string,
  idSet: Set<string>,
) => (selector.mode === 'groups' ? Boolean(groupId && idSet.has(groupId)) : idSet.has(targetId));
async function collectHandledSlotKeys(
  ctx: SchedulerRuntimeContext,
  scheduleId: string,
  nowMs: number,
): Promise<Set<string>> {
  const handled = new Set(await ctx.repo.listHandledSlotKeys(scheduleId, nowMs - 48 * 3600_000));
  const prefix = `${scheduleId}::`;
  for (const mem of ctx.inMemorySlotLocks)
    if (mem.startsWith(prefix)) handled.add(mem.slice(prefix.length));
  return handled;
}
const makeRunItem = (
  runId: string,
  targetId: string,
  targetName: string,
  nowMs: number | null,
  status: AutoScheduleRunItem['status'],
  currentStep: string,
  summary: string,
  hardBlockReason: string | null = null,
): AutoScheduleRunItem => ({
  runId,
  targetId,
  targetName,
  status,
  currentStep,
  summary,
  bumpedCount: 0,
  postedCount: 0,
  softIssues: 0,
  hardBlockReason,
  startedAt: nowMs,
  finishedAt: nowMs,
  updatedAt: nowMs ?? 0,
});
function countMatchingTargets(
  schedule: AutoSchedule,
  profiles: ReadonlyArray<{ id: string; groupId: string | null }> | null,
  instances: ReadonlyArray<{ id: string; folderId: string | null }> | null,
): number {
  const idSet = new Set(
    schedule.targetSelector.mode === 'groups'
      ? schedule.targetSelector.groupIds
      : schedule.targetSelector.targetIds,
  );
  const items = schedule.carrier === 'browser' ? profiles : instances;
  return (
    items?.filter((x) =>
      matchesSelector(
        schedule.targetSelector,
        'groupId' in x ? x.groupId : x.folderId,
        x.id,
        idSet,
      ),
    ).length ?? 0
  );
}
export async function buildSchedulerState(
  ctx: SchedulerRuntimeContext,
): Promise<AutoSchedulerState> {
  const nowMs = ctx.now();
  ctx.pruneInMemorySlotLocks();
  const [settings, schedules, persistedRuns] = await Promise.all([
    ctx.repo.settings(),
    ctx.repo.listSchedules(),
    ctx.repo.listRuns(20, 20),
  ]);
  ctx.cachedSettings = settings;
  ctx.cachedEnabledScheduleCount = schedules.filter((s) => s.enabled).length;
  ctx.syncPowerLock();
  const [browserSnap, bsState] = await Promise.all([
    schedules.some((s) => s.carrier === 'browser')
      ? ctx.deps.workspace.snapshot()
      : Promise.resolve(null),
    ctx.deps.bluestacks && schedules.some((s) => s.carrier === 'bluestacks')
      ? ctx.deps.bluestacks.state(false)
      : Promise.resolve(null),
  ]);
  const views = [];
  for (const s of schedules) {
    const handled = await collectHandledSlotKeys(ctx, s.id, nowMs);
    views.push({
      ...s,
      resolvedTargetCount: countMatchingTargets(
        s,
        browserSnap?.profiles ?? null,
        bsState?.instances ?? null,
      ),
      nextRun: computeNextRunPreview(s, nowMs, handled),
    });
  }
  const activeRuns: AutoScheduleRun[] = [...ctx.liveRuns.values()].map((t) => ({
    ...t.run,
    items: [...t.items.values()],
  }));
  const activeIds = new Set(activeRuns.map((r) => r.id));
  return {
    settings,
    running: ctx.hasActiveExecution(),
    powerLockMode: ctx.currentPowerLock,
    activeBrowserWorkers: ctx.activeBrowserWorkers,
    queuedBrowserTargets: ctx.browserQueue.length,
    activeBluestacksWorkers: ctx.activeBluestacksWorkers,
    queuedBluestacksTargets: ctx.bluestacksQueue.length,
    schedules: views,
    activeRuns,
    recentRuns: persistedRuns.filter((r) => !activeIds.has(r.id)),
  };
}
export async function tickScheduler(ctx: SchedulerRuntimeContext): Promise<void> {
  if (ctx.ticking || ctx.shuttingDown) return;
  try {
    await ctx.deps.assertAllowed?.();
  } catch {
    return;
  }
  ctx.ticking = true;
  try {
    ctx.pruneInMemorySlotLocks();
    const nowMs = ctx.now();
    const [settings, schedules] = await Promise.all([
      ctx.repo.settings(),
      ctx.repo.listSchedules(),
    ]);
    ctx.cachedSettings = settings;
    ctx.deps.workboard?.setConcurrencyLimits({
      browserConcurrency: settings.browserConcurrency,
      bluestacksConcurrency: settings.bluestacksConcurrency,
      launchStaggerMs: settings.launchStaggerSeconds * 1000,
    });
    ctx.cachedEnabledScheduleCount = schedules.filter((s) => s.enabled).length;
    for (const schedule of schedules) {
      if (!schedule.enabled) continue;
      try {
        const handled = await collectHandledSlotKeys(ctx, schedule.id, nowMs);
        for (const due of computeDueScheduleTriggers(schedule, nowMs, handled)) {
          const lockKey = `${schedule.id}::${due.slotKey}`;
          if (ctx.inMemorySlotLocks.has(lockKey)) continue;
          if (!due.expiredSkipReason) {
            const alreadyLive = [...ctx.liveRuns.values()].some(
              (t) => !t.cancelled && t.schedule.id === schedule.id,
            );
            if (ctx.launchingScheduleKeys.has(schedule.id) || alreadyLive) continue;
          }
          ctx.inMemorySlotLocks.add(lockKey);
          try {
            if (due.expiredSkipReason) {
              await ctx.repo.saveRun({
                id: globalThis.crypto.randomUUID(),
                scheduleId: schedule.id,
                scheduleName: schedule.name,
                carrier: schedule.carrier,
                phase: 'main',
                slotKey: due.slotKey,
                triggerMode: 'cron',
                status: 'skipped_expired',
                statusReason: due.expiredSkipReason,
                totalTargets: 0,
                completedCount: 0,
                softIssueCount: 0,
                hardBlockedCount: 0,
                watchdogTimeoutCount: 0,
                skippedCount: 0,
                scheduledFor: due.scheduledFor,
                startedAt: nowMs,
                finishedAt: nowMs,
              });
              if (schedule.trigger.mode === 'once') {
                await Promise.resolve(
                  ctx.repo.toggleSchedule({ id: schedule.id, enabled: false }),
                ).catch(() => {});
                const latest = await Promise.resolve(ctx.repo.listSchedules()).catch(() => null);
                if (latest) ctx.cachedEnabledScheduleCount = latest.filter((s) => s.enabled).length;
              }
              ctx.markMutated();
              continue;
            }
            ctx.launchingScheduleKeys.add(schedule.id);
            ctx.cancelledLaunchSchedules.delete(schedule.id);
            try {
              await launchScheduleRun(ctx, schedule, due.slotKey, 'cron', due.scheduledFor);
            } finally {
              ctx.launchingScheduleKeys.delete(schedule.id);
            }
          } catch {
            ctx.inMemorySlotLocks.delete(lockKey);
          }
        }
      } catch {
        /* Isolate per-schedule errors */
      }
    }
    ctx.syncPowerLock();
  } finally {
    ctx.ticking = false;
  }
}
export async function launchScheduleRun(
  ctx: SchedulerRuntimeContext,
  schedule: AutoSchedule,
  slotKey: string,
  triggerMode: 'cron' | 'manual',
  scheduledFor: number,
): Promise<void> {
  const nowMs = ctx.now();
  const safetyCeilingMinutes =
    schedule.maxSafetyMinutesPerTarget === 0 ? null : (schedule.maxSafetyMinutesPerTarget ?? 180);
  const alreadyDoneSet =
    triggerMode === 'cron'
      ? new Set(await ctx.repo.listFinishedTargetIdsForSlot(schedule.id, slotKey))
      : new Set<string>();
  const recentHardBlockedSet =
    schedule.targetSelector.skipAbnormalAccounts && triggerMode === 'cron'
      ? new Set(await ctx.repo.listHardBlockedTargetIdsSince(schedule.id, nowMs - 18 * 3600_000))
      : new Set<string>();
  const selectorSet = new Set(
    schedule.targetSelector.mode === 'groups'
      ? schedule.targetSelector.groupIds
      : schedule.targetSelector.targetIds,
  );
  const rawTargets =
    schedule.carrier === 'browser'
      ? (await ctx.deps.workspace.snapshot()).profiles.map((p) => ({
          id: p.id,
          groupId: p.groupId,
          name: profileDisplayName(p),
          state: p.account.state,
          labels: BROWSER_ABNORMAL_LABELS,
        }))
      : ctx.deps.bluestacks
        ? (await ctx.deps.bluestacks.state(true)).instances.map((i) => ({
            id: i.id,
            groupId: i.folderId,
            name: bluestacksDisplayTitle(i),
            state: i.accountState,
            labels: BLUESTACKS_ABNORMAL_LABELS,
          }))
        : [];
  const candidates = rawTargets
    .filter(
      (t) =>
        matchesSelector(schedule.targetSelector, t.groupId, t.id, selectorSet) &&
        !alreadyDoneSet.has(t.id),
    )
    .map((t) => ({
      id: t.id,
      name: t.name,
      abnormalReason:
        t.labels[t.state] ??
        (t.state === 'unknown' && recentHardBlockedSet.has(t.id)
          ? '今日前序场次已判定账号异常'
          : null),
    }));
  const runId = globalThis.crypto.randomUUID();
  const itemsMap = new Map<string, AutoScheduleRunItem>();
  const runnableWorks: Array<{ id: string; name: string }> = [];
  let initialSkipped = 0;
  const isPureBsPatrol =
    schedule.carrier === 'bluestacks' &&
    schedule.steps.length > 0 &&
    schedule.steps.every((s) => s.type === 'bluestacks-health-check');
  const canAutoInstall =
    schedule.carrier === 'bluestacks' &&
    schedule.steps.some((s) => s.type === 'bluestacks-health-check' && Boolean(s.autoInstallApk));
  const nonAbnormalIds: string[] = [];
  const abnormalIds = new Set<string>();
  for (const c of candidates) {
    if (
      schedule.targetSelector.skipAbnormalAccounts &&
      !isPureBsPatrol &&
      !(canAutoInstall && c.abnormalReason === '未安装 FB Lite') &&
      c.abnormalReason
    ) {
      abnormalIds.add(c.id);
    } else nonAbnormalIds.push(c.id);
  }
  // Atomically reserve non-abnormal targets in FeatureExecutionRegistry before queueing.
  const reservation = nonAbnormalIds.length
    ? await ctx.deps.featureExecution.tryReserve('auto-scheduler', nonAbnormalIds)
    : { reservedIds: [] as string[], busyIds: [] as string[] };
  const reservedSet = new Set(reservation.reservedIds);
  let releasePendingReservation = true;
  try {
    for (const c of candidates) {
      if (abnormalIds.has(c.id)) {
        initialSkipped++;
        itemsMap.set(
          c.id,
          makeRunItem(
            runId,
            c.id,
            c.name,
            nowMs,
            'skipped',
            '已自动跳过',
            `自动跳过：${c.abnormalReason}`,
            c.abnormalReason,
          ),
        );
      } else if (!reservedSet.has(c.id)) {
        initialSkipped++;
        itemsMap.set(
          c.id,
          makeRunItem(
            runId,
            c.id,
            c.name,
            nowMs,
            'skipped',
            '已自动跳过',
            '跳过：该账号当前正在执行其他任务',
          ),
        );
      } else {
        runnableWorks.push({ id: c.id, name: c.name });
        itemsMap.set(c.id, {
          ...makeRunItem(
            runId,
            c.id,
            c.name,
            null,
            'queued',
            '等待并发空位…',
            '已进入滑动补位队列',
          ),
          updatedAt: nowMs,
        });
      }
    }
    const run: AutoScheduleRun = {
      id: runId,
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      carrier: schedule.carrier,
      phase: 'main',
      slotKey,
      triggerMode,
      status: runnableWorks.length ? 'running' : 'completed',
      statusReason: runnableWorks.length
        ? `正点场运行中 · 共 ${candidates.length} 个目标`
        : candidates.length
          ? `正点场已自动跳过全部 ${initialSkipped} 个异常账号`
          : '正点场无待跑账号（今日已完成或分组为空）',
      totalTargets: candidates.length,
      completedCount: 0,
      softIssueCount: 0,
      hardBlockedCount: 0,
      watchdogTimeoutCount: 0,
      skippedCount: initialSkipped,
      scheduledFor,
      startedAt: nowMs,
      finishedAt: runnableWorks.length ? null : nowMs,
    };
    if (ctx.shuttingDown || ctx.cancelledLaunchSchedules.has(schedule.id))
      return void ctx.cancelledLaunchSchedules.delete(schedule.id);
    await ctx.repo.saveRunWithItems(run, [...itemsMap.values()]);
    await ctx.repo.pruneOldRuns(120);
    if (!runnableWorks.length) {
      if (triggerMode === 'cron' && schedule.trigger.mode === 'once') {
        await Promise.resolve(ctx.repo.toggleSchedule({ id: schedule.id, enabled: false })).catch(
          () => {},
        );
        const latest = await Promise.resolve(ctx.repo.listSchedules()).catch(() => null);
        if (latest) ctx.cachedEnabledScheduleCount = latest.filter((s) => s.enabled).length;
      }
      ctx.markMutated();
      return;
    }
    // Atomically register into liveRuns + carrier queue in the same tick before releasing reservation.
    const tracker: LiveRunTracker = { run, schedule, items: itemsMap, cancelled: false };
    ctx.liveRuns.set(runId, tracker);
    const targetQueue = schedule.carrier === 'browser' ? ctx.browserQueue : ctx.bluestacksQueue;
    for (const w of runnableWorks) {
      targetQueue.push({ tracker, targetId: w.id, targetName: w.name, safetyCeilingMinutes });
    }
    ctx.deps.featureExecution.releaseReservation('auto-scheduler', reservation.reservedIds);
    releasePendingReservation = false;
    ctx.markMutated();
    ctx.syncPowerLock();
    pumpCarrierPool(ctx, schedule.carrier);
  } finally {
    if (releasePendingReservation && reservation.reservedIds.length) {
      ctx.deps.featureExecution.releaseReservation('auto-scheduler', reservation.reservedIds);
    }
  }
}
