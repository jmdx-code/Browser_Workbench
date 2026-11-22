import { z } from 'zod';
import type { CompatibleRepository } from '../domain/persistence.js';
import { ProductError } from '../domain/workspace.js';
import { bluestacksDisplayTitle } from '../shared/bluestacks.js';
import {
  AutoSchedulePhase,
  computeDueScheduleTriggers,
  computeEffectiveSafetyCeilingMinutes,
  computeNextRunPreview,
  estimatePipelineMinutes,
  type AutoRunStatus,
  type AutoSchedule,
  type AutoScheduleRun,
  type AutoScheduleRunItem,
  type AutoScheduleView,
  type AutoSchedulerGlobalSettings,
  type AutoSchedulerState,
} from '../shared/auto-scheduler.js';
import { Id } from '../shared/contracts.js';
import type { ProfileLifecyclePort } from '../shared/profile-lifecycle.js';
import {
  AutoSchedulerTargetExecutor,
  type ActiveTargetExecutionContext,
} from './auto-scheduler-executor.js';
import type { BluestacksService } from './bluestacks-service.js';
import type { FeatureExecutionRegistry } from './feature-execution-registry.js';
import type { GroupBumperService } from './group-bumper-service.js';
import type { GroupInviterService } from './group-inviter-service.js';
import type { GroupPosterService } from './group-poster-service.js';
import type { TaskService } from './task-service.js';
import type { WorkspaceService } from './workspace-service.js';

export interface AutoSchedulerRepository {
  settings(): AutoSchedulerGlobalSettings;
  saveSettings(input: unknown): AutoSchedulerGlobalSettings;
  listSchedules(): AutoSchedule[];
  getSchedule(id: string): AutoSchedule | null;
  saveSchedule(input: unknown): AutoSchedule;
  toggleSchedule(input: unknown): AutoSchedule;
  duplicateSchedule(input: unknown): AutoSchedule;
  deleteSchedule(input: unknown): boolean;
  saveRun(run: AutoScheduleRun): AutoScheduleRun;
  saveRunItem(item: AutoScheduleRunItem): void;
  saveRunWithItems(run: AutoScheduleRun, items: readonly AutoScheduleRunItem[]): void;
  getRun(runId: string): AutoScheduleRun | null;
  listRuns(limit?: number, includeItemsLimit?: number): AutoScheduleRun[];
  listHandledSlotKeys(scheduleId: string, sinceMs: number): string[];
  listFinishedTargetIdsForSlot(scheduleId: string, slotKey: string): string[];
  listHardBlockedTargetIdsSince(scheduleId: string, sinceMs: number): string[];
  recoverInterruptedRunsOnStartup(nowMs?: number): number;
  pruneOldRuns(keepMaxRuns?: number): number;
  clearHistoryRuns?(): number;
}

const RunNowInput = z
  .object({
    id: Id,
    phase: AutoSchedulePhase.default('main'),
  })
  .strict();

const StopRunInput = z
  .object({
    runId: Id.optional(),
    scheduleId: Id.optional(),
    targetIds: z.array(z.string().min(1).max(120)).max(1000).optional(),
    keepWindowsOpen: z.boolean().optional(),
  })
  .strict();

interface LiveRunTracker {
  run: AutoScheduleRun;
  schedule: AutoSchedule;
  items: Map<string, AutoScheduleRunItem>;
  cancelled: boolean;
}

interface QueuedTargetWork {
  tracker: LiveRunTracker;
  targetId: string;
  targetName: string;
  safetyCeilingMinutes: number | null;
  priorityHandoff?: boolean;
}

export type PowerLockMode = 'none' | 'prevent-app-suspension' | 'prevent-display-sleep';

export class AutoSchedulerService {
  private cachedSettings: AutoSchedulerGlobalSettings = {
    browserConcurrency: 15,
    bluestacksConcurrency: 5,
    launchStaggerSeconds: 3,
    idleWatchdogMinutes: 5,
    preventSystemSleep: true,
  };
  private cachedEnabledScheduleCount = 0;
  private currentPowerLock: PowerLockMode = 'none';
  private cronTimer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private started = false;
  private shuttingDown = false;

  private readonly liveRuns = new Map<string, LiveRunTracker>();
  private readonly inMemorySlotLocks = new Set<string>();
  private readonly ownedTargets = new Set<string>();
  private readonly activeContexts = new Map<string, ActiveTargetExecutionContext>();
  private readonly launchingScheduleKeys = new Set<string>();
  private readonly cancelledLaunchSchedules = new Set<string>();

  private readonly browserQueue: QueuedTargetWork[] = [];
  private readonly bluestacksQueue: QueuedTargetWork[] = [];
  private activeBrowserWorkers = 0;
  private activeBluestacksWorkers = 0;
  private lastBrowserLaunchAt = 0;
  private lastBluestacksLaunchAt = 0;
  private pumpingBrowser = false;
  private pumpingBluestacks = false;

  private readonly executor: AutoSchedulerTargetExecutor;

  constructor(
    private readonly repo: CompatibleRepository<AutoSchedulerRepository>,
    private readonly deps: {
      workspace: WorkspaceService;
      tasks?: TaskService | undefined;
      groupBumper?: GroupBumperService | undefined;
      groupPoster?: GroupPosterService | undefined;
      groupInviter?: GroupInviterService | undefined;
      bluestacks?: BluestacksService | undefined;
      profileLifecycle?: ProfileLifecyclePort | undefined;
      featureExecution: FeatureExecutionRegistry;
      assertAllowed?: (() => void) | undefined;
      onPowerLockChange?: ((mode: PowerLockMode) => void) | undefined;
      onConcurrencyChanged?:
        | ((next: {
            browserConcurrency: number;
            bluestacksConcurrency: number;
          }) => Promise<void> | void)
        | undefined;
      now?: (() => number) | undefined;
      pollIntervalMs?: number | undefined;
      idleWatchdogOverrideMs?: number | undefined;
    },
  ) {
    this.executor = new AutoSchedulerTargetExecutor({
      workspace: deps.workspace,
      tasks: deps.tasks,
      groupBumper: deps.groupBumper,
      groupPoster: deps.groupPoster,
      groupInviter: deps.groupInviter,
      bluestacks: deps.bluestacks,
      profileLifecycle: deps.profileLifecycle,
      featureExecution: deps.featureExecution,
      getIdleWatchdogMs: () =>
        deps.idleWatchdogOverrideMs ?? this.cachedSettings.idleWatchdogMinutes * 60_000,
      getBrowserConcurrency: () => this.cachedSettings.browserConcurrency,
      getBluestacksConcurrency: () => this.cachedSettings.bluestacksConcurrency,
      releaseOwnershipBeforeClose: (targetId) => {
        this.ownedTargets.delete(targetId);
      },
      pollIntervalMs: deps.pollIntervalMs,
    });

    if (!deps.featureExecution.hasParticipant('auto-scheduler')) {
      deps.featureExecution.register({
        id: 'auto-scheduler',
        label: '定时排班',
        isProfileRunning: (profileId) => this.ownedTargets.has(profileId),
        hasActiveExecution: () => this.hasActiveExecution(),
        stopProfiles: async (profileIds) => {
          // Lifecycle/task-stop callers own closing the browser window if desired;
          // keeping windows open here prevents re-entrant BrowserLifecycleManager deadlocks.
          await this.stopTargets(profileIds, true);
        },
      });
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  hasActiveExecution(): boolean {
    return (
      this.liveRuns.size > 0 ||
      this.activeBrowserWorkers > 0 ||
      this.activeBluestacksWorkers > 0 ||
      this.browserQueue.length > 0 ||
      this.bluestacksQueue.length > 0
    );
  }

  isTargetRunning(targetId: string): boolean {
    return this.ownedTargets.has(targetId);
  }

  private syncPowerLock(): void {
    const next: PowerLockMode = !this.cachedSettings.preventSystemSleep
      ? 'none'
      : this.hasActiveExecution()
        ? 'prevent-display-sleep'
        : this.cachedEnabledScheduleCount > 0
          ? 'prevent-app-suspension'
          : 'none';
    if (next !== this.currentPowerLock) {
      this.currentPowerLock = next;
      this.deps.onPowerLockChange?.(next);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.shuttingDown = false;
    await this.repo.recoverInterruptedRunsOnStartup(this.now());
    this.cachedSettings = await this.repo.settings();
    await this.deps.onConcurrencyChanged?.({
      browserConcurrency: this.cachedSettings.browserConcurrency,
      bluestacksConcurrency: this.cachedSettings.bluestacksConcurrency,
    });
    const schedules = await this.repo.listSchedules();
    this.cachedEnabledScheduleCount = schedules.filter((s) => s.enabled).length;
    this.syncPowerLock();

    this.cronTimer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 10_000);
    this.cronTimer.unref?.();

    setTimeout(() => {
      if (!this.shuttingDown) void this.tick().catch(() => {});
    }, 1500).unref?.();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.cronTimer) {
      clearInterval(this.cronTimer);
      this.cronTimer = null;
    }
    this.started = false;
    if (this.hasActiveExecution()) {
      await this.stop({}).catch(() => {});
    }
    this.currentPowerLock = 'none';
    this.deps.onPowerLockChange?.('none');
  }

  private async buildCombinationMinutesMap(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    const combos = await this.deps.workspace.repository.combinations();
    for (const row of combos) {
      const spec = row.saved ?? row.draft;
      if (!spec) continue;
      let stepSum = 0;
      for (const s of spec.steps) {
        if (s.type === 'post') stepSum += Math.max(2, s.count * 2);
        else stepSum += Math.max(1, s.durationMinutes);
      }
      const rounds = spec.loop.mode === 'finite' ? Math.max(1, spec.loop.rounds) : 1;
      map.set(row.id, Math.max(2, stepSum * rounds));
    }
    return map;
  }

  private countMatchingTargetsFromCache(
    schedule: AutoSchedule,
    browserProfiles: ReadonlyArray<{ id: string; groupId: string | null }> | null,
    bluestacksInstances: ReadonlyArray<{ id: string; folderId: string | null }> | null,
  ): number {
    if (schedule.carrier === 'browser') {
      if (!browserProfiles) return 0;
      if (schedule.targetSelector.mode === 'groups') {
        const gset = new Set(schedule.targetSelector.groupIds);
        return browserProfiles.filter((p) => p.groupId && gset.has(p.groupId)).length;
      }
      const tset = new Set(schedule.targetSelector.targetIds);
      return browserProfiles.filter((p) => tset.has(p.id)).length;
    }
    if (!bluestacksInstances) return 0;
    if (schedule.targetSelector.mode === 'groups') {
      const fset = new Set(schedule.targetSelector.groupIds);
      return bluestacksInstances.filter((i) => i.folderId && fset.has(i.folderId)).length;
    }
    const tset = new Set(schedule.targetSelector.targetIds);
    return bluestacksInstances.filter((i) => tset.has(i.id)).length;
  }

  private pruneInMemorySlotLocks(): void {
    if (this.inMemorySlotLocks.size <= 400) return;
    const keep = [...this.inMemorySlotLocks].slice(-200);
    this.inMemorySlotLocks.clear();
    for (const k of keep) this.inMemorySlotLocks.add(k);
  }

  async state(): Promise<AutoSchedulerState> {
    const nowMs = this.now();
    this.pruneInMemorySlotLocks();
    const [settings, schedules, persistedRuns, comboMap] = await Promise.all([
      this.repo.settings(),
      this.repo.listSchedules(),
      this.repo.listRuns(20, 8),
      this.buildCombinationMinutesMap(),
    ]);
    this.cachedSettings = settings;
    this.cachedEnabledScheduleCount = schedules.filter((s) => s.enabled).length;
    this.syncPowerLock();

    const needsBrowserSnap = schedules.some((s) => s.carrier === 'browser');
    const needsBsSnap =
      Boolean(this.deps.bluestacks) && schedules.some((s) => s.carrier === 'bluestacks');
    const [browserSnap, bsState] = await Promise.all([
      needsBrowserSnap ? this.deps.workspace.snapshot() : Promise.resolve(null),
      needsBsSnap && this.deps.bluestacks
        ? this.deps.bluestacks.state(false)
        : Promise.resolve(null),
    ]);

    const lookupCombo = (cid: string) => comboMap.get(cid) ?? 10;
    const views: AutoScheduleView[] = [];

    for (const s of schedules) {
      const handled = new Set(await this.repo.listHandledSlotKeys(s.id, nowMs - 48 * 3600_000));
      for (const lockKey of this.inMemorySlotLocks) {
        if (lockKey.startsWith(`${s.id}::`)) {
          handled.add(lockKey.slice(s.id.length + 2));
        }
      }
      const resolvedTargetCount = this.countMatchingTargetsFromCache(
        s,
        browserSnap?.profiles ?? null,
        bsState?.instances ?? null,
      );
      const estimatedPrewarmMinutesPerTarget =
        s.carrier === 'browser' && s.prewarm.enabled && s.prewarm.steps.length > 0
          ? estimatePipelineMinutes(s.prewarm.steps, lookupCombo)
          : 0;
      const estimatedMainMinutesPerTarget = estimatePipelineMinutes(s.steps, lookupCombo);

      views.push({
        ...s,
        resolvedTargetCount,
        estimatedPrewarmMinutesPerTarget,
        estimatedMainMinutesPerTarget,
        effectivePrewarmSafetyMinutes:
          s.carrier === 'browser' && s.prewarm.enabled
            ? computeEffectiveSafetyCeilingMinutes(s, 'prewarm', lookupCombo)
            : null,
        effectiveMainSafetyMinutes: computeEffectiveSafetyCeilingMinutes(s, 'main', lookupCombo),
        nextRun: computeNextRunPreview(s, nowMs, handled),
      });
    }

    const activeRuns: AutoScheduleRun[] = [...this.liveRuns.values()].map((t) => ({
      ...t.run,
      items: [...t.items.values()],
    }));
    const activeIds = new Set(activeRuns.map((r) => r.id));
    const recentRuns = persistedRuns.filter((r) => !activeIds.has(r.id));

    return {
      settings,
      running: this.hasActiveExecution(),
      powerLockMode: this.currentPowerLock,
      activeBrowserWorkers: this.activeBrowserWorkers,
      queuedBrowserTargets: this.browserQueue.length,
      activeBluestacksWorkers: this.activeBluestacksWorkers,
      queuedBluestacksTargets: this.bluestacksQueue.length,
      schedules: views,
      activeRuns,
      recentRuns,
    };
  }

  async saveSettings(input: unknown): Promise<AutoSchedulerState> {
    this.deps.assertAllowed?.();
    this.cachedSettings = await this.repo.saveSettings(input);
    await this.deps.onConcurrencyChanged?.({
      browserConcurrency: this.cachedSettings.browserConcurrency,
      bluestacksConcurrency: this.cachedSettings.bluestacksConcurrency,
    });
    this.syncPowerLock();
    this.pumpBrowserPool();
    this.pumpBluestacksPool();
    return this.state();
  }

  async saveSchedule(input: unknown): Promise<AutoSchedulerState> {
    this.deps.assertAllowed?.();
    await this.repo.saveSchedule(input);
    const schedules = await this.repo.listSchedules();
    this.cachedEnabledScheduleCount = schedules.filter((s) => s.enabled).length;
    this.syncPowerLock();
    return this.state();
  }

  async toggleSchedule(input: unknown): Promise<AutoSchedulerState> {
    this.deps.assertAllowed?.();
    await this.repo.toggleSchedule(input);
    const schedules = await this.repo.listSchedules();
    this.cachedEnabledScheduleCount = schedules.filter((s) => s.enabled).length;
    this.syncPowerLock();
    if (!this.shuttingDown) void this.tick().catch(() => {});
    return this.state();
  }

  async duplicateSchedule(input: unknown): Promise<AutoSchedulerState> {
    this.deps.assertAllowed?.();
    await this.repo.duplicateSchedule(input);
    return this.state();
  }

  async deleteSchedule(input: unknown): Promise<AutoSchedulerState> {
    this.deps.assertAllowed?.();
    const { id } = z.object({ id: Id }).strict().parse(input);
    for (const tracker of this.liveRuns.values()) {
      if (tracker.schedule.id === id) {
        throw new ProductError('SCHEDULE_RUNNING', '该排班当前正在运行中，请先停止后再删除', 409);
      }
    }
    for (const key of this.launchingScheduleKeys) {
      if (key.startsWith(`${id}:`)) {
        throw new ProductError('SCHEDULE_RUNNING', '该排班正在启动中，请先停止后再删除', 409);
      }
    }
    await this.repo.deleteSchedule({ id });
    const schedules = await this.repo.listSchedules();
    this.cachedEnabledScheduleCount = schedules.filter((s) => s.enabled).length;
    this.syncPowerLock();
    return this.state();
  }

  async runNow(input: unknown): Promise<AutoSchedulerState> {
    this.deps.assertAllowed?.();
    const { id, phase } = RunNowInput.parse(input);
    const schedule = await this.repo.getSchedule(id);
    if (!schedule) throw new ProductError('SCHEDULE_NOT_FOUND', '未找到该排班', 404);
    if (phase === 'prewarm' && (schedule.carrier !== 'browser' || !schedule.prewarm.enabled)) {
      throw new ProductError('PREWARM_NOT_ENABLED', '该排班未开启提前预热场', 400);
    }
    const launchKey = `${id}:${phase}`;
    if (this.launchingScheduleKeys.has(launchKey)) {
      throw new ProductError(
        'SCHEDULE_ALREADY_RUNNING',
        '该排班当前场次已在启动中，请勿重复启动',
        409,
      );
    }
    for (const tracker of this.liveRuns.values()) {
      if (!tracker.cancelled && tracker.schedule.id === id && tracker.run.phase === phase) {
        throw new ProductError(
          'SCHEDULE_ALREADY_RUNNING',
          '该排班当前场次已在运行中，请勿重复启动',
          409,
        );
      }
    }
    const nowMs = this.now();
    const slotKey = `manual-${nowMs}:${phase}`;
    this.launchingScheduleKeys.add(launchKey);
    this.cancelledLaunchSchedules.delete(id);
    try {
      await this.launchScheduleRun({
        schedule,
        phase,
        slotKey,
        triggerMode: 'manual',
        scheduledFor: nowMs,
      });
    } finally {
      this.launchingScheduleKeys.delete(launchKey);
    }
    return this.state();
  }

  async clearHistory(): Promise<AutoSchedulerState> {
    this.deps.assertAllowed?.();
    await this.repo.clearHistoryRuns?.();
    return this.state();
  }

  async stop(input: unknown = {}): Promise<AutoSchedulerState> {
    const parsed = StopRunInput.parse(input ?? {});
    const keepOpen = Boolean(parsed.keepWindowsOpen);

    if (parsed.targetIds && parsed.targetIds.length > 0) {
      await this.stopTargets(parsed.targetIds, keepOpen);
      this.syncPowerLock();
      return this.state();
    }

    const targetRunIds = new Set<string>();
    if (parsed.scheduleId) {
      this.cancelledLaunchSchedules.add(parsed.scheduleId);
    } else if (!parsed.runId) {
      for (const key of this.launchingScheduleKeys) {
        const sid = key.split(':')[0];
        if (sid) this.cancelledLaunchSchedules.add(sid);
      }
    }
    for (const [runId, tracker] of this.liveRuns.entries()) {
      if (parsed.runId && runId !== parsed.runId) continue;
      if (parsed.scheduleId && tracker.schedule.id !== parsed.scheduleId) continue;
      targetRunIds.add(runId);
    }

    for (const runId of targetRunIds) {
      const tracker = this.liveRuns.get(runId);
      if (!tracker) continue;
      tracker.cancelled = true;
    }

    const removeQueued = (queue: QueuedTargetWork[]) => {
      for (let i = queue.length - 1; i >= 0; i--) {
        const w = queue[i];
        if (w && targetRunIds.has(w.tracker.run.id)) {
          queue.splice(i, 1);
          const item = w.tracker.items.get(w.targetId);
          if (item && item.status === 'queued') {
            const nextItem: AutoScheduleRunItem = {
              ...item,
              status: 'stopped',
              currentStep: '已取消排队',
              summary: '已手动停止',
              finishedAt: this.now(),
              updatedAt: this.now(),
            };
            w.tracker.items.set(w.targetId, nextItem);
            void this.repo.saveRunItem(nextItem);
          }
        }
      }
    };
    removeQueued(this.browserQueue);
    removeQueued(this.bluestacksQueue);

    const activePromises: Promise<void>[] = [];
    for (const ctx of this.activeContexts.values()) {
      if (targetRunIds.has(ctx.runId)) {
        ctx.cancelled = true;
        ctx.keepWindowOpenOnCancel = keepOpen;
        ctx.abortStep();
        activePromises.push(
          new Promise<void>((resolve) => {
            if (ctx.finished) resolve();
            else ctx.onHandoffReady.push(resolve);
          }),
        );
      }
    }

    if (activePromises.length > 0) {
      await Promise.race([
        Promise.allSettled(activePromises),
        new Promise<void>((r) => setTimeout(r, 8000)),
      ]);
    }

    for (const runId of targetRunIds) {
      await this.checkAndFinalizeRun(runId);
    }
    this.syncPowerLock();
    return this.state();
  }

  private async stopTargets(targetIds: readonly string[], keepWindowsOpen = false): Promise<void> {
    const idSet = new Set(targetIds);
    const affectedRunIds = new Set<string>();
    const removeFromQueue = (queue: QueuedTargetWork[]) => {
      for (let i = queue.length - 1; i >= 0; i--) {
        const w = queue[i];
        if (w && idSet.has(w.targetId)) {
          queue.splice(i, 1);
          affectedRunIds.add(w.tracker.run.id);
          const item = w.tracker.items.get(w.targetId);
          if (item && item.status === 'queued') {
            const nextItem: AutoScheduleRunItem = {
              ...item,
              status: 'stopped',
              currentStep: '已停止',
              summary: '已被单号手动停止',
              finishedAt: this.now(),
              updatedAt: this.now(),
            };
            w.tracker.items.set(w.targetId, nextItem);
            void this.repo.saveRunItem(nextItem);
          }
        }
      }
    };
    removeFromQueue(this.browserQueue);
    removeFromQueue(this.bluestacksQueue);

    const activePromises: Promise<void>[] = [];
    for (const tid of idSet) {
      const ctx = this.activeContexts.get(tid);
      if (ctx) {
        affectedRunIds.add(ctx.runId);
        ctx.cancelled = true;
        ctx.keepWindowOpenOnCancel = keepWindowsOpen;
        ctx.abortStep();
        activePromises.push(
          new Promise<void>((resolve) => {
            if (ctx.finished) resolve();
            else ctx.onHandoffReady.push(resolve);
          }),
        );
      }
    }

    if (activePromises.length > 0) {
      await Promise.race([
        Promise.allSettled(activePromises),
        new Promise<void>((r) => setTimeout(r, 8000)),
      ]);
    }

    for (const runId of affectedRunIds) {
      await this.checkAndFinalizeRun(runId);
    }
  }

  async tick(): Promise<void> {
    if (this.ticking || this.shuttingDown) return;
    this.ticking = true;
    try {
      const nowMs = this.now();
      const [settings, schedules] = await Promise.all([
        this.repo.settings(),
        this.repo.listSchedules(),
      ]);
      this.cachedSettings = settings;
      this.cachedEnabledScheduleCount = schedules.filter((s) => s.enabled).length;

      for (const schedule of schedules) {
        if (!schedule.enabled) continue;
        try {
          const persistedKeys = await this.repo.listHandledSlotKeys(
            schedule.id,
            nowMs - 48 * 3600_000,
          );
          const handled = new Set(persistedKeys);
          for (const mem of this.inMemorySlotLocks) {
            if (mem.startsWith(`${schedule.id}::`)) {
              handled.add(mem.slice(schedule.id.length + 2));
            }
          }

          const dueSlots = computeDueScheduleTriggers(schedule, nowMs, handled);
          for (const due of dueSlots) {
            const lockKey = `${schedule.id}::${due.slotKey}`;
            if (this.inMemorySlotLocks.has(lockKey)) continue;
            this.inMemorySlotLocks.add(lockKey);

            try {
              if (due.expiredSkipReason) {
                const skippedRun: AutoScheduleRun = {
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
                };
                await this.repo.saveRun(skippedRun);
                continue;
              }

              const launchKey = `${schedule.id}:${due.phase}`;
              this.launchingScheduleKeys.add(launchKey);
              this.cancelledLaunchSchedules.delete(schedule.id);
              try {
                await this.launchScheduleRun({
                  schedule,
                  phase: due.phase,
                  slotKey: due.slotKey,
                  triggerMode: 'cron',
                  scheduledFor: due.scheduledFor,
                });
              } finally {
                this.launchingScheduleKeys.delete(launchKey);
              }
            } catch {
              this.inMemorySlotLocks.delete(lockKey);
            }
          }
        } catch {
          /* Isolate transient per-schedule errors so remaining schedules still tick. */
        }
      }

      this.syncPowerLock();
    } finally {
      this.ticking = false;
    }
  }

  private async launchScheduleRun(input: {
    schedule: AutoSchedule;
    phase: AutoSchedulePhase;
    slotKey: string;
    triggerMode: 'cron' | 'manual';
    scheduledFor: number;
  }): Promise<void> {
    const { schedule, phase, slotKey, triggerMode, scheduledFor } = input;
    const nowMs = this.now();
    const comboMap = await this.buildCombinationMinutesMap();
    const safetyCeilingMinutes = computeEffectiveSafetyCeilingMinutes(
      schedule,
      phase,
      (cid) => comboMap.get(cid) ?? 10,
    );

    const alreadyDoneSet =
      triggerMode === 'cron'
        ? new Set(await this.repo.listFinishedTargetIdsForSlot(schedule.id, slotKey))
        : new Set<string>();
    const recentHardBlockedSet = schedule.targetSelector.skipAbnormalAccounts
      ? new Set(await this.repo.listHardBlockedTargetIdsSince(schedule.id, nowMs - 18 * 3600_000))
      : new Set<string>();

    const candidates: Array<{
      id: string;
      name: string;
      abnormalReason: string | null;
    }> = [];

    if (schedule.carrier === 'browser') {
      const snap = await this.deps.workspace.snapshot();
      const groupSet = new Set(schedule.targetSelector.groupIds);
      const explicitSet = new Set(schedule.targetSelector.targetIds);
      for (const p of snap.profiles) {
        const matched =
          schedule.targetSelector.mode === 'groups'
            ? Boolean(p.groupId && groupSet.has(p.groupId))
            : explicitSet.has(p.id);
        if (!matched || alreadyDoneSet.has(p.id)) continue;
        const abnormal =
          p.account.state === 'logged-out'
            ? '账号未登录'
            : p.account.state === 'verification'
              ? '账号需验证 (Checkpoint)'
              : p.account.state === 'restricted'
                ? '账号已封禁/全局受限'
                : recentHardBlockedSet.has(p.id)
                  ? '今日前序场次已判定账号异常'
                  : null;
        candidates.push({
          id: p.id,
          name: p.browserName || p.alias,
          abnormalReason: abnormal,
        });
      }
    } else if (this.deps.bluestacks) {
      const bs = await this.deps.bluestacks.state(true);
      const folderSet = new Set(schedule.targetSelector.groupIds);
      const explicitSet = new Set(schedule.targetSelector.targetIds);
      for (const inst of bs.instances) {
        const matched =
          schedule.targetSelector.mode === 'groups'
            ? Boolean(inst.folderId && folderSet.has(inst.folderId))
            : explicitSet.has(inst.id);
        if (!matched || alreadyDoneSet.has(inst.id)) continue;
        const abnormal =
          inst.accountState === 'logged-out'
            ? 'FB Lite 未登录'
            : inst.accountState === 'missing-app'
              ? '未安装 FB Lite'
              : inst.accountState === 'verification'
                ? '账号需验证 (Checkpoint)'
                : inst.accountState === 'restricted'
                  ? '账号已封禁/全局受限'
                  : recentHardBlockedSet.has(inst.id)
                    ? '今日前序场次已判定账号异常'
                    : null;
        candidates.push({
          id: inst.id,
          name: bluestacksDisplayTitle(inst),
          abnormalReason: abnormal,
        });
      }
    }

    const runId = globalThis.crypto.randomUUID();
    const itemsMap = new Map<string, AutoScheduleRunItem>();
    const runnableWorks: Array<{ id: string; name: string }> = [];
    let initialSkipped = 0;

    const isPureBluestacksHealthPatrol =
      schedule.carrier === 'bluestacks' &&
      schedule.steps.length > 0 &&
      schedule.steps.every((s) => s.type === 'bluestacks-health-check');

    for (const c of candidates) {
      if (
        schedule.targetSelector.skipAbnormalAccounts &&
        !isPureBluestacksHealthPatrol &&
        c.abnormalReason
      ) {
        initialSkipped++;
        itemsMap.set(c.id, {
          runId,
          targetId: c.id,
          targetName: c.name,
          status: 'skipped',
          currentStep: '已自动跳过',
          summary: `自动跳过：${c.abnormalReason}`,
          bumpedCount: 0,
          postedCount: 0,
          softIssues: 0,
          hardBlockReason: c.abnormalReason,
          seamlessHandoff: false,
          startedAt: nowMs,
          finishedAt: nowMs,
          updatedAt: nowMs,
        });
      } else if (
        !(
          phase === 'main' &&
          schedule.carrier === 'browser' &&
          this.activeContexts.get(c.id)?.scheduleId === schedule.id &&
          this.activeContexts.get(c.id)?.phase === 'prewarm' &&
          !this.activeContexts.get(c.id)?.finished
        ) &&
        (await this.deps.featureExecution.isProfileBusy(c.id, 'auto-scheduler'))
      ) {
        initialSkipped++;
        itemsMap.set(c.id, {
          runId,
          targetId: c.id,
          targetName: c.name,
          status: 'skipped',
          currentStep: '已自动跳过',
          summary: '跳过：该账号当前正在执行其他任务',
          bumpedCount: 0,
          postedCount: 0,
          softIssues: 0,
          hardBlockReason: null,
          seamlessHandoff: false,
          startedAt: nowMs,
          finishedAt: nowMs,
          updatedAt: nowMs,
        });
      } else {
        runnableWorks.push({ id: c.id, name: c.name });
        itemsMap.set(c.id, {
          runId,
          targetId: c.id,
          targetName: c.name,
          status: 'queued',
          currentStep: '等待并发空位…',
          summary: '已进入滑动补位队列',
          bumpedCount: 0,
          postedCount: 0,
          softIssues: 0,
          hardBlockReason: null,
          seamlessHandoff: false,
          startedAt: null,
          finishedAt: null,
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
      status: runnableWorks.length === 0 ? 'completed' : 'running',
      statusReason:
        runnableWorks.length === 0
          ? candidates.length === 0
            ? `${phaseLabel}无待跑账号（今日已完成或分组为空）`
            : `${phaseLabel}已自动跳过全部 ${initialSkipped} 个异常账号`
          : `${phaseLabel}运行中 · 共 ${candidates.length} 个目标`,
      totalTargets: candidates.length,
      completedCount: 0,
      softIssueCount: 0,
      hardBlockedCount: 0,
      watchdogTimeoutCount: 0,
      skippedCount: initialSkipped,
      scheduledFor,
      startedAt: nowMs,
      finishedAt: runnableWorks.length === 0 ? nowMs : null,
    };

    if (this.shuttingDown || this.cancelledLaunchSchedules.has(schedule.id)) {
      this.cancelledLaunchSchedules.delete(schedule.id);
      return;
    }

    await this.repo.saveRunWithItems(run, [...itemsMap.values()]);
    await this.repo.pruneOldRuns(120);

    if (runnableWorks.length === 0) return;

    const tracker: LiveRunTracker = {
      run,
      schedule,
      items: itemsMap,
      cancelled: false,
    };
    this.liveRuns.set(runId, tracker);

    // Trigger seamless prewarm -> main handoff for any account of this same schedule still in prewarm!
    const handoffTargetIds = new Set<string>();
    if (phase === 'main' && schedule.carrier === 'browser') {
      for (const w of runnableWorks) {
        const existingCtx = this.activeContexts.get(w.id);
        if (
          existingCtx &&
          existingCtx.scheduleId === schedule.id &&
          existingCtx.phase === 'prewarm' &&
          !existingCtx.finished
        ) {
          existingCtx.handoffToMain = true;
          existingCtx.abortStep();
          handoffTargetIds.add(w.id);
        }
      }
      // Also cancel any still-queued prewarm items of this schedule so they don't run AFTER main stage!
      for (let i = this.browserQueue.length - 1; i >= 0; i--) {
        const qw = this.browserQueue[i];
        if (qw && qw.tracker.schedule.id === schedule.id && qw.tracker.run.phase === 'prewarm') {
          this.browserQueue.splice(i, 1);
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
            void this.repo.saveRunItem(updatedPre);
            void this.checkAndFinalizeRun(qw.tracker.run.id);
          }
        }
      }
    }

    const targetQueue = schedule.carrier === 'browser' ? this.browserQueue : this.bluestacksQueue;
    const priorityHandoffWorks: QueuedTargetWork[] = [];
    for (const w of runnableWorks) {
      const entry: QueuedTargetWork = {
        tracker,
        targetId: w.id,
        targetName: w.name,
        safetyCeilingMinutes,
        priorityHandoff: handoffTargetIds.has(w.id),
      };
      if (entry.priorityHandoff) priorityHandoffWorks.push(entry);
      else targetQueue.push(entry);
    }
    if (priorityHandoffWorks.length > 0) {
      targetQueue.unshift(...priorityHandoffWorks);
    }

    this.syncPowerLock();
    if (schedule.carrier === 'browser') this.pumpBrowserPool();
    else this.pumpBluestacksPool();
  }

  private recomputeRunCounters(tracker: LiveRunTracker): void {
    let completed = 0;
    let soft = 0;
    let hard = 0;
    let timeout = 0;
    let skipped = 0;
    let runningOrQueued = 0;

    for (const item of tracker.items.values()) {
      if (item.status === 'completed') completed++;
      else if (item.status === 'soft_warning') {
        completed++;
        soft++;
      } else if (item.status === 'hard_blocked') hard++;
      else if (item.status === 'watchdog_timeout') timeout++;
      else if (item.status === 'skipped') skipped++;
      else if (item.status === 'queued' || item.status === 'running') runningOrQueued++;
    }

    tracker.run.completedCount = completed;
    tracker.run.softIssueCount = soft;
    tracker.run.hardBlockedCount = hard;
    tracker.run.watchdogTimeoutCount = timeout;
    tracker.run.skippedCount = skipped;

    if (runningOrQueued > 0 && !tracker.cancelled) {
      const activeCount = [...tracker.items.values()].filter((i) => i.status === 'running').length;
      const queuedCount = [...tracker.items.values()].filter((i) => i.status === 'queued').length;
      tracker.run.statusReason = `运行 ${activeCount} / 排队 ${queuedCount} · 已完成 ${completed}/${tracker.run.totalTargets}`;
    }
  }

  private async checkAndFinalizeRun(runId: string): Promise<void> {
    const tracker = this.liveRuns.get(runId);
    if (!tracker) return;

    const hasPending = [...tracker.items.values()].some(
      (i) => i.status === 'queued' || i.status === 'running',
    );
    this.recomputeRunCounters(tracker);
    if (hasPending) {
      await this.repo.saveRun(tracker.run);
      return;
    }

    const nowMs = this.now();
    tracker.run.finishedAt = nowMs;
    const status: AutoRunStatus = tracker.cancelled
      ? 'stopped'
      : tracker.run.hardBlockedCount > 0 || tracker.run.watchdogTimeoutCount > 0
        ? 'partial'
        : 'completed';
    tracker.run.status = status;

    const parts = [`完成 ${tracker.run.completedCount}`];
    if (tracker.run.softIssueCount > 0) parts.push(`含软受限收尾 ${tracker.run.softIssueCount}`);
    if (tracker.run.hardBlockedCount > 0)
      parts.push(`封号/掉登摘除 ${tracker.run.hardBlockedCount}`);
    if (tracker.run.watchdogTimeoutCount > 0)
      parts.push(`看门狗回收 ${tracker.run.watchdogTimeoutCount}`);
    if (tracker.run.skippedCount > 0) parts.push(`跳过 ${tracker.run.skippedCount}`);

    tracker.run.statusReason = tracker.cancelled
      ? `已手动停止（${parts.join(' / ')}）`
      : `已结束 · ${parts.join(' / ')}`;

    this.liveRuns.delete(runId);
    await this.repo.saveRun(tracker.run);
    this.syncPowerLock();
  }

  private pumpBrowserPool(): void {
    if (this.pumpingBrowser || this.shuttingDown) return;
    this.pumpingBrowser = true;
    try {
      const cap = Math.max(1, this.cachedSettings.browserConcurrency);
      while (this.activeBrowserWorkers < cap && this.browserQueue.length > 0) {
        const nextIdx = this.browserQueue.findIndex((w) => !this.activeContexts.has(w.targetId));
        if (nextIdx === -1) break;
        const [work] = this.browserQueue.splice(nextIdx, 1);
        if (!work) break;

        this.activeBrowserWorkers++;
        this.ownedTargets.add(work.targetId);
        const ctx: ActiveTargetExecutionContext = {
          runId: work.tracker.run.id,
          scheduleId: work.tracker.schedule.id,
          phase: work.tracker.run.phase,
          targetId: work.targetId,
          cancelled: work.tracker.cancelled,
          keepWindowOpenOnCancel: false,
          handoffToMain: false,
          finished: false,
          onHandoffReady: [],
          abortStep: () => {},
        };
        this.activeContexts.set(work.targetId, ctx);
        void this.runBrowserWorkItem(work, ctx)
          .catch(async (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            const cur = work.tracker.items.get(work.targetId);
            const doneAt = this.now();
            const failedItem: AutoScheduleRunItem = {
              runId: work.tracker.run.id,
              targetId: work.targetId,
              targetName: work.targetName,
              status: 'soft_warning',
              currentStep: '执行异常',
              summary: `执行异常：${msg.slice(0, 120)}`,
              bumpedCount: cur?.bumpedCount ?? 0,
              postedCount: cur?.postedCount ?? 0,
              softIssues: (cur?.softIssues ?? 0) + 1,
              hardBlockReason: cur?.hardBlockReason ?? null,
              seamlessHandoff: cur?.seamlessHandoff ?? false,
              startedAt: cur?.startedAt ?? doneAt,
              finishedAt: doneAt,
              updatedAt: doneAt,
            };
            work.tracker.items.set(work.targetId, failedItem);
            await Promise.resolve(this.repo.saveRunItem(failedItem)).catch(() => {});
          })
          .finally(() => {
            this.activeContexts.delete(work.targetId);
            this.ownedTargets.delete(work.targetId);
            this.activeBrowserWorkers = Math.max(0, this.activeBrowserWorkers - 1);
            void this.checkAndFinalizeRun(work.tracker.run.id);
            this.pumpBrowserPool();
          });
      }
    } finally {
      this.pumpingBrowser = false;
    }
  }

  private async runBrowserWorkItem(
    work: QueuedTargetWork,
    ctx: ActiveTargetExecutionContext,
  ): Promise<void> {
    if (work.tracker.schedule.carrier !== 'browser') return;
    const schedule = work.tracker.schedule;
    const nowMs = this.now();

    // Stagger consecutive browser launches to avoid disk/CPU spikes
    const staggerMs = this.cachedSettings.launchStaggerSeconds * 1000;
    const earliest = this.lastBrowserLaunchAt + staggerMs;
    const waitMs = Math.max(0, earliest - nowMs);
    this.lastBrowserLaunchAt = Math.max(nowMs, earliest);

    const finishEarly = async (
      status: AutoScheduleRunItem['status'],
      currentStep: string,
      summary: string,
    ) => {
      const doneAt = this.now();
      const base = work.tracker.items.get(work.targetId) ?? {
        runId: work.tracker.run.id,
        targetId: work.targetId,
        targetName: work.targetName,
        bumpedCount: 0,
        postedCount: 0,
        softIssues: 0,
        hardBlockReason: null,
        seamlessHandoff: false,
        startedAt: doneAt,
      };
      const doneItem: AutoScheduleRunItem = {
        ...base,
        status,
        currentStep: currentStep.slice(0, 200),
        summary: summary.slice(0, 400),
        finishedAt: doneAt,
        updatedAt: doneAt,
      };
      work.tracker.items.set(work.targetId, doneItem);
      await Promise.resolve(this.repo.saveRunItem(doneItem)).catch(() => {});
      ctx.finished = true;
      for (const listener of ctx.onHandoffReady.splice(0)) listener();
    };

    if (ctx.cancelled || ctx.handoffToMain || this.shuttingDown) {
      await finishEarly(
        ctx.handoffToMain ? 'completed' : 'stopped',
        '已结束',
        ctx.handoffToMain ? '无缝切换至正点场' : '已停止',
      );
      return;
    }

    // Re-verify target is not busy in another module after waiting in concurrency queue
    if (await this.deps.featureExecution.isProfileBusy(work.targetId, 'auto-scheduler')) {
      await finishEarly('skipped', '已自动跳过', '跳过：等待并发期间该账号已启动其他任务');
      return;
    }

    const existingItem = work.tracker.items.get(work.targetId);
    const snap = await this.deps.workspace.snapshot();
    if (ctx.cancelled || ctx.handoffToMain || this.shuttingDown) {
      await finishEarly(
        ctx.handoffToMain ? 'completed' : 'stopped',
        '已结束',
        ctx.handoffToMain ? '无缝切换至正点场' : '已停止',
      );
      return;
    }
    const alreadyOnline = Boolean(snap.profiles.find((p) => p.id === work.targetId)?.online);

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
      currentStep: waitMs > 0 && !alreadyOnline ? '错峰启动准备…' : '正在启动…',
      summary: waitMs > 0 && !alreadyOnline ? '错峰等待拉起窗口…' : '开始执行流水线',
      seamlessHandoff: alreadyOnline && work.tracker.run.phase === 'main',
      startedAt: this.now(),
      updatedAt: this.now(),
    };
    work.tracker.items.set(work.targetId, startItem);
    this.recomputeRunCounters(work.tracker);
    await this.repo.saveRunItem(startItem);
    await this.repo.saveRun(work.tracker.run);

    if (waitMs > 0 && !alreadyOnline && !ctx.cancelled && !ctx.handoffToMain) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          ctx.abortStep = () => {};
          resolve();
        }, waitMs);
        ctx.abortStep = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }

    if (ctx.cancelled || ctx.handoffToMain || this.shuttingDown) {
      await finishEarly(
        ctx.handoffToMain ? 'completed' : 'stopped',
        '已结束',
        ctx.handoffToMain ? '无缝切换至正点场' : '已取消启动',
      );
      return;
    }

    let lastSavedAt = 0;
    const outcome = await this.executor.executeBrowserTarget({
      schedule,
      phase: work.tracker.run.phase,
      profileId: work.targetId,
      seamlessEntered: startItem.seamlessHandoff,
      safetyCeilingMinutes: work.safetyCeilingMinutes,
      ctx,
      onUpdate: (patch) => {
        const cur = work.tracker.items.get(work.targetId);
        if (!cur) return;
        const updated: AutoScheduleRunItem = {
          ...cur,
          currentStep: patch.currentStep.slice(0, 200),
          summary: patch.summary.slice(0, 400),
          bumpedCount: patch.bumpedCount,
          postedCount: patch.postedCount,
          softIssues: patch.softIssues,
          updatedAt: this.now(),
        };
        work.tracker.items.set(work.targetId, updated);
        if (this.now() - lastSavedAt >= 3000) {
          lastSavedAt = this.now();
          void Promise.resolve(this.repo.saveRunItem(updated)).catch(() => {});
        }
      },
    });

    const doneAt = this.now();
    const cur = work.tracker.items.get(work.targetId) ?? startItem;
    const finalItem: AutoScheduleRunItem = {
      ...cur,
      status: outcome.status,
      currentStep: '已结束',
      summary: outcome.summary.slice(0, 400),
      bumpedCount: outcome.bumpedCount,
      postedCount: outcome.postedCount,
      softIssues: outcome.softIssues,
      hardBlockReason: outcome.hardBlockReason ? outcome.hardBlockReason.slice(0, 240) : null,
      finishedAt: doneAt,
      updatedAt: doneAt,
    };
    work.tracker.items.set(work.targetId, finalItem);
    await this.repo.saveRunItem(finalItem);
  }

  private pumpBluestacksPool(): void {
    if (this.pumpingBluestacks || this.shuttingDown) return;
    this.pumpingBluestacks = true;
    try {
      const cap = Math.max(1, this.cachedSettings.bluestacksConcurrency);
      while (this.activeBluestacksWorkers < cap && this.bluestacksQueue.length > 0) {
        const nextIdx = this.bluestacksQueue.findIndex((w) => !this.activeContexts.has(w.targetId));
        if (nextIdx === -1) break;
        const [work] = this.bluestacksQueue.splice(nextIdx, 1);
        if (!work) break;

        this.activeBluestacksWorkers++;
        this.ownedTargets.add(work.targetId);
        const ctx: ActiveTargetExecutionContext = {
          runId: work.tracker.run.id,
          scheduleId: work.tracker.schedule.id,
          phase: work.tracker.run.phase,
          targetId: work.targetId,
          cancelled: work.tracker.cancelled,
          keepWindowOpenOnCancel: false,
          handoffToMain: false,
          finished: false,
          onHandoffReady: [],
          abortStep: () => {},
        };
        this.activeContexts.set(work.targetId, ctx);
        void this.runBluestacksWorkItem(work, ctx)
          .catch(async (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            const cur = work.tracker.items.get(work.targetId);
            const doneAt = this.now();
            const failedItem: AutoScheduleRunItem = {
              runId: work.tracker.run.id,
              targetId: work.targetId,
              targetName: work.targetName,
              status: 'soft_warning',
              currentStep: '执行异常',
              summary: `执行异常：${msg.slice(0, 120)}`,
              bumpedCount: cur?.bumpedCount ?? 0,
              postedCount: cur?.postedCount ?? 0,
              softIssues: (cur?.softIssues ?? 0) + 1,
              hardBlockReason: cur?.hardBlockReason ?? null,
              seamlessHandoff: false,
              startedAt: cur?.startedAt ?? doneAt,
              finishedAt: doneAt,
              updatedAt: doneAt,
            };
            work.tracker.items.set(work.targetId, failedItem);
            await Promise.resolve(this.repo.saveRunItem(failedItem)).catch(() => {});
          })
          .finally(() => {
            this.activeContexts.delete(work.targetId);
            this.ownedTargets.delete(work.targetId);
            this.activeBluestacksWorkers = Math.max(0, this.activeBluestacksWorkers - 1);
            void this.checkAndFinalizeRun(work.tracker.run.id);
            this.pumpBluestacksPool();
          });
      }
    } finally {
      this.pumpingBluestacks = false;
    }
  }

  private async runBluestacksWorkItem(
    work: QueuedTargetWork,
    ctx: ActiveTargetExecutionContext,
  ): Promise<void> {
    if (work.tracker.schedule.carrier !== 'bluestacks') return;
    const schedule = work.tracker.schedule;
    const nowMs = this.now();

    const staggerMs = Math.max(2000, this.cachedSettings.launchStaggerSeconds * 1000);
    const earliest = this.lastBluestacksLaunchAt + staggerMs;
    const waitMs = Math.max(0, earliest - nowMs);
    this.lastBluestacksLaunchAt = Math.max(nowMs, earliest);

    const finishEarly = async (
      status: AutoScheduleRunItem['status'],
      currentStep: string,
      summary: string,
    ) => {
      const doneAt = this.now();
      const base = work.tracker.items.get(work.targetId) ?? {
        runId: work.tracker.run.id,
        targetId: work.targetId,
        targetName: work.targetName,
        bumpedCount: 0,
        postedCount: 0,
        softIssues: 0,
        hardBlockReason: null,
        seamlessHandoff: false,
        startedAt: doneAt,
      };
      const doneItem: AutoScheduleRunItem = {
        ...base,
        status,
        currentStep: currentStep.slice(0, 200),
        summary: summary.slice(0, 400),
        finishedAt: doneAt,
        updatedAt: doneAt,
      };
      work.tracker.items.set(work.targetId, doneItem);
      await Promise.resolve(this.repo.saveRunItem(doneItem)).catch(() => {});
      ctx.finished = true;
      for (const listener of ctx.onHandoffReady.splice(0)) listener();
    };

    if (ctx.cancelled || this.shuttingDown) {
      await finishEarly('stopped', '已结束', '已停止');
      return;
    }

    if (await this.deps.featureExecution.isProfileBusy(work.targetId, 'auto-scheduler')) {
      await finishEarly('skipped', '已自动跳过', '跳过：等待并发期间该模拟器已启动其他任务');
      return;
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
        seamlessHandoff: false,
        finishedAt: null,
      }),
      status: 'running',
      currentStep: waitMs > 0 ? '错峰启动模拟器…' : '正在启动模拟器…',
      summary: '准备拉起蓝蝶实例',
      startedAt: this.now(),
      updatedAt: this.now(),
    };
    work.tracker.items.set(work.targetId, startItem);
    this.recomputeRunCounters(work.tracker);
    await this.repo.saveRunItem(startItem);
    await this.repo.saveRun(work.tracker.run);

    if (waitMs > 0 && !ctx.cancelled) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          ctx.abortStep = () => {};
          resolve();
        }, waitMs);
        ctx.abortStep = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }

    if (ctx.cancelled || this.shuttingDown) {
      await finishEarly('stopped', '已结束', '已取消启动模拟器');
      return;
    }

    let lastSavedAt = 0;
    const outcome = await this.executor.executeBluestacksTarget({
      schedule,
      instanceId: work.targetId,
      safetyCeilingMinutes: work.safetyCeilingMinutes,
      ctx,
      onUpdate: (patch) => {
        const cur = work.tracker.items.get(work.targetId);
        if (!cur) return;
        const updated: AutoScheduleRunItem = {
          ...cur,
          currentStep: patch.currentStep.slice(0, 200),
          summary: patch.summary.slice(0, 400),
          bumpedCount: patch.bumpedCount,
          postedCount: patch.postedCount,
          softIssues: patch.softIssues,
          updatedAt: this.now(),
        };
        work.tracker.items.set(work.targetId, updated);
        if (this.now() - lastSavedAt >= 3000) {
          lastSavedAt = this.now();
          void Promise.resolve(this.repo.saveRunItem(updated)).catch(() => {});
        }
      },
    });

    const doneAt = this.now();
    const cur = work.tracker.items.get(work.targetId) ?? startItem;
    const finalItem: AutoScheduleRunItem = {
      ...cur,
      status: outcome.status,
      currentStep: '已结束',
      summary: outcome.summary.slice(0, 400),
      bumpedCount: outcome.bumpedCount,
      postedCount: outcome.postedCount,
      softIssues: outcome.softIssues,
      hardBlockReason: outcome.hardBlockReason ? outcome.hardBlockReason.slice(0, 240) : null,
      finishedAt: doneAt,
      updatedAt: doneAt,
    };
    work.tracker.items.set(work.targetId, finalItem);
    await this.repo.saveRunItem(finalItem);
  }
}
