import { bluestacksDisplayTitle } from '../../shared/bluestacks.js';
import { profileDisplayName } from '../../shared/contracts.js';
import {
  computeDueScheduleTriggers,
  computeEffectiveSafetyCeilingMinutes,
  computeNextRunPreview,
  estimatePipelineMinutes,
  type AutoSchedule,
  type AutoSchedulePhase,
  type AutoScheduleRun,
  type AutoScheduleRunItem,
  type AutoSchedulerState,
} from '../../shared/auto-scheduler.js';
import type {
  LiveRunTracker,
  QueuedTargetWork,
  SchedulerRuntimeContext,
} from '../auto-scheduler-service.js';
import type { WorkspaceService } from '../workspace-service.js';
import { checkAndFinalizeRun, pumpCarrierPool } from './scheduler-pool.js';

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
  seamlessHandoff: false,
  startedAt: nowMs,
  finishedAt: nowMs,
  updatedAt: nowMs ?? 0,
});

async function buildCombinationMinutesMap(
  workspace: WorkspaceService,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (const row of await workspace.repository.combinations()) {
    const spec = row.saved;
    if (!spec) continue;
    let stepSum = 0;
    for (const s of spec.steps)
      stepSum += s.type === 'post' ? Math.max(2, s.count * 2) : Math.max(1, s.durationMinutes);
    map.set(
      row.id,
      Math.max(2, stepSum * (spec.loop.mode === 'finite' ? Math.max(1, spec.loop.rounds) : 1)),
    );
  }
  return map;
}

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
  const [settings, schedules, persistedRuns, comboMap] = await Promise.all([
    ctx.repo.settings(),
    ctx.repo.listSchedules(),
    ctx.repo.listRuns(20, 20),
    buildCombinationMinutesMap(ctx.deps.workspace),
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
  const lookupCombo = (cid: string) => comboMap.get(cid) ?? 10;
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
      estimatedPrewarmMinutesPerTarget:
        s.carrier === 'browser' && s.prewarm.enabled && s.prewarm.steps.length
          ? estimatePipelineMinutes(s.prewarm.steps, lookupCombo)
          : 0,
      estimatedMainMinutesPerTarget: estimatePipelineMinutes(s.steps, lookupCombo),
      effectivePrewarmSafetyMinutes:
        s.carrier === 'browser' && s.prewarm.enabled
          ? computeEffectiveSafetyCeilingMinutes(s, 'prewarm', lookupCombo)
          : null,
      effectiveMainSafetyMinutes: computeEffectiveSafetyCeilingMinutes(s, 'main', lookupCombo),
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
    ctx.cachedEnabledScheduleCount = schedules.filter((s) => s.enabled).length;

    for (const schedule of schedules) {
      if (!schedule.enabled) continue;
      try {
        const handled = await collectHandledSlotKeys(ctx, schedule.id, nowMs);
        for (const due of computeDueScheduleTriggers(schedule, nowMs, handled)) {
          const lockKey = `${schedule.id}::${due.slotKey}`;
          if (ctx.inMemorySlotLocks.has(lockKey)) continue;
          const launchKey = `${schedule.id}:${due.phase}`;
          if (!due.expiredSkipReason) {
            const alreadyLive = [...ctx.liveRuns.values()].some(
              (t) => !t.cancelled && t.schedule.id === schedule.id && t.run.phase === due.phase,
            );
            if (ctx.launchingScheduleKeys.has(launchKey) || alreadyLive) continue;
          }
          ctx.inMemorySlotLocks.add(lockKey);
          try {
            if (due.expiredSkipReason) {
              await ctx.repo.saveRun({
                id: globalThis.crypto.randomUUID(),
                scheduleId: schedule.id,
                scheduleName: schedule.name,
                carrier: schedule.carrier,
                phase: due.phase,
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
              continue;
            }
            ctx.launchingScheduleKeys.add(launchKey);
            ctx.cancelledLaunchSchedules.delete(schedule.id);
            try {
              await launchScheduleRun(
                ctx,
                schedule,
                due.phase,
                due.slotKey,
                'cron',
                due.scheduledFor,
              );
            } finally {
              ctx.launchingScheduleKeys.delete(launchKey);
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
  phase: AutoSchedulePhase,
  slotKey: string,
  triggerMode: 'cron' | 'manual',
  scheduledFor: number,
): Promise<void> {
  const nowMs = ctx.now();
  const comboMap = await buildCombinationMinutesMap(ctx.deps.workspace);
  const safetyCeilingMinutes = computeEffectiveSafetyCeilingMinutes(
    schedule,
    phase,
    (cid) => comboMap.get(cid) ?? 10,
  );
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

  for (const c of candidates) {
    const existingCtx = ctx.activeContexts.get(c.id);
    const seamlessPrewarm =
      phase === 'main' &&
      schedule.carrier === 'browser' &&
      existingCtx?.scheduleId === schedule.id &&
      existingCtx?.phase === 'prewarm' &&
      !existingCtx?.finished;
    if (
      schedule.targetSelector.skipAbnormalAccounts &&
      !isPureBsPatrol &&
      !(canAutoInstall && c.abnormalReason === '未安装 FB Lite') &&
      c.abnormalReason
    ) {
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
    } else if (
      !seamlessPrewarm &&
      (await ctx.deps.featureExecution.isProfileBusy(c.id, 'auto-scheduler'))
    ) {
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
        ...makeRunItem(runId, c.id, c.name, null, 'queued', '等待并发空位…', '已进入滑动补位队列'),
        updatedAt: nowMs,
      });
    }
  }

  const phaseLabel = phase === 'prewarm' ? '提前预热场' : '正点场';
  const run: AutoScheduleRun = {
    id: runId,
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    carrier: schedule.carrier,
    phase,
    slotKey,
    triggerMode,
    status: runnableWorks.length ? 'running' : 'completed',
    statusReason: runnableWorks.length
      ? `${phaseLabel}运行中 · 共 ${candidates.length} 个目标`
      : candidates.length
        ? `${phaseLabel}已自动跳过全部 ${initialSkipped} 个异常账号`
        : `${phaseLabel}无待跑账号（今日已完成或分组为空）`,
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

  if (triggerMode === 'cron' && phase === 'main' && schedule.trigger.mode === 'once') {
    await Promise.resolve(ctx.repo.toggleSchedule({ id: schedule.id, enabled: false })).catch(
      () => {},
    );
    const latest = await Promise.resolve(ctx.repo.listSchedules()).catch(() => null);
    if (latest) ctx.cachedEnabledScheduleCount = latest.filter((s) => s.enabled).length;
  }
  if (!runnableWorks.length) return;

  const tracker: LiveRunTracker = { run, schedule, items: itemsMap, cancelled: false };
  ctx.liveRuns.set(runId, tracker);

  const handoffIds = new Set<string>();
  if (phase === 'main' && schedule.carrier === 'browser') {
    for (const w of runnableWorks) {
      const existingCtx = ctx.activeContexts.get(w.id);
      if (
        existingCtx &&
        existingCtx.scheduleId === schedule.id &&
        existingCtx.phase === 'prewarm' &&
        !existingCtx.finished
      ) {
        existingCtx.handoffToMain = true;
        existingCtx.abortStep();
        handoffIds.add(w.id);
      }
    }
    const affectedPrewarmRuns = new Set<string>();
    for (let i = ctx.browserQueue.length - 1; i >= 0; i--) {
      const qw = ctx.browserQueue[i];
      if (!qw || qw.tracker.schedule.id !== schedule.id || qw.tracker.run.phase !== 'prewarm')
        continue;
      ctx.browserQueue.splice(i, 1);
      const preItem = qw.tracker.items.get(qw.targetId);
      if (preItem) {
        const updatedPre: AutoScheduleRunItem = {
          ...preItem,
          status: 'skipped',
          currentStep: '已并入正点场',
          summary: '正点时间已到，直接转入正点顶贴队列',
          finishedAt: nowMs,
          updatedAt: nowMs,
        };
        qw.tracker.items.set(qw.targetId, updatedPre);
        void ctx.repo.saveRunItem(updatedPre);
        affectedPrewarmRuns.add(qw.tracker.run.id);
      }
    }
    for (const preRunId of affectedPrewarmRuns) void checkAndFinalizeRun(ctx, preRunId);
  }

  const targetQueue = schedule.carrier === 'browser' ? ctx.browserQueue : ctx.bluestacksQueue;
  const priorityWorks: QueuedTargetWork[] = [];
  for (const w of runnableWorks) {
    const entry: QueuedTargetWork = {
      tracker,
      targetId: w.id,
      targetName: w.name,
      safetyCeilingMinutes,
      priorityHandoff: handoffIds.has(w.id),
    };
    (entry.priorityHandoff ? priorityWorks : targetQueue).push(entry);
  }
  if (priorityWorks.length) targetQueue.unshift(...priorityWorks);

  ctx.syncPowerLock();
  pumpCarrierPool(ctx, schedule.carrier);
}
