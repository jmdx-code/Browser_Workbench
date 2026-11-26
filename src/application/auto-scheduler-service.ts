import { z } from 'zod';
import type { CompatibleRepository } from '../domain/persistence.js';
import { ProductError } from '../domain/workspace.js';
import {
  AutoSchedulePhase,
  type AutoSchedule,
  type AutoScheduleRun,
  type AutoScheduleRunItem,
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
import {
  buildSchedulerState,
  launchScheduleRun,
  tickScheduler,
} from './scheduler/scheduler-launch.js';
import {
  pumpCarrierPool,
  stopSchedulerRuns,
  stopSchedulerTargets,
} from './scheduler/scheduler-pool.js';
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
  listRuns(limit?: number, includeItemsLimit?: number): AutoScheduleRun[];
  listHandledSlotKeys(scheduleId: string, sinceMs: number): string[];
  listFinishedTargetIdsForSlot(scheduleId: string, slotKey: string): string[];
  listHardBlockedTargetIdsSince(scheduleId: string, sinceMs: number): string[];
  recoverInterruptedRunsOnStartup(nowMs?: number): number;
  pruneOldRuns(keepMaxRuns?: number): number;
  clearHistoryRuns?(): number;
}

export const RunNowInput = z.object({ id: Id, phase: AutoSchedulePhase.default('main') }).strict();
export const StopRunInput = z
  .object({
    runId: Id.optional(),
    scheduleId: Id.optional(),
    targetIds: z.array(z.string().min(1).max(120)).max(1000).optional(),
    keepWindowsOpen: z.boolean().optional(),
  })
  .strict();

export interface LiveRunTracker {
  run: AutoScheduleRun;
  schedule: AutoSchedule;
  items: Map<string, AutoScheduleRunItem>;
  cancelled: boolean;
}

export interface QueuedTargetWork {
  tracker: LiveRunTracker;
  targetId: string;
  targetName: string;
  safetyCeilingMinutes: number | null;
  priorityHandoff?: boolean;
}

export type PowerLockMode = 'none' | 'prevent-app-suspension' | 'prevent-display-sleep';

export interface AutoSchedulerServiceDeps {
  workspace: WorkspaceService;
  tasks?: TaskService;
  groupBumper?: GroupBumperService;
  groupPoster?: GroupPosterService;
  groupInviter?: GroupInviterService;
  bluestacks?: BluestacksService;
  profileLifecycle?: ProfileLifecyclePort;
  featureExecution: FeatureExecutionRegistry;
  assertAllowed?: () => void;
  onPowerLockChange?: (mode: PowerLockMode) => void;
  onConcurrencyChanged?: (next: {
    browserConcurrency: number;
    bluestacksConcurrency: number;
  }) => Promise<void> | void;
  now?: () => number;
  pollIntervalMs?: number;
  idleWatchdogOverrideMs?: number;
}

function createSchedulerRuntime(
  repo: CompatibleRepository<AutoSchedulerRepository>,
  deps: AutoSchedulerServiceDeps,
  hooks: { hasActiveExecution(): boolean; syncPowerLock(): void },
) {
  const ownedTargets = new Set<string>();
  const inMemorySlotLocks = new Set<string>();
  let cachedSettings: AutoSchedulerGlobalSettings = {
    browserConcurrency: 15,
    bluestacksConcurrency: 5,
    launchStaggerSeconds: 3,
    idleWatchdogMinutes: 5,
    preventSystemSleep: true,
  };
  return {
    repo,
    deps,
    executor: new AutoSchedulerTargetExecutor({
      workspace: deps.workspace,
      tasks: deps.tasks,
      groupBumper: deps.groupBumper,
      groupPoster: deps.groupPoster,
      groupInviter: deps.groupInviter,
      bluestacks: deps.bluestacks,
      profileLifecycle: deps.profileLifecycle,
      featureExecution: deps.featureExecution,
      getIdleWatchdogMs: () =>
        deps.idleWatchdogOverrideMs ?? cachedSettings.idleWatchdogMinutes * 60_000,
      getBrowserConcurrency: () => cachedSettings.browserConcurrency,
      getBluestacksConcurrency: () => cachedSettings.bluestacksConcurrency,
      releaseOwnershipBeforeClose: (targetId) => void ownedTargets.delete(targetId),
      pollIntervalMs: deps.pollIntervalMs,
    }),
    get cachedSettings() {
      return cachedSettings;
    },
    set cachedSettings(next: AutoSchedulerGlobalSettings) {
      cachedSettings = next;
    },
    cachedEnabledScheduleCount: 0,
    currentPowerLock: 'none' as PowerLockMode,
    ticking: false,
    shuttingDown: false,
    liveRuns: new Map<string, LiveRunTracker>(),
    inMemorySlotLocks,
    ownedTargets,
    activeContexts: new Map<string, ActiveTargetExecutionContext>(),
    launchingScheduleKeys: new Set<string>(),
    cancelledLaunchSchedules: new Set<string>(),
    browserQueue: [] as QueuedTargetWork[],
    bluestacksQueue: [] as QueuedTargetWork[],
    activeBrowserWorkers: 0,
    activeBluestacksWorkers: 0,
    lastBrowserLaunchAt: 0,
    lastBluestacksLaunchAt: 0,
    pumpingBrowser: false,
    pumpingBluestacks: false,
    now: () => (deps.now ? deps.now() : Date.now()),
    hasActiveExecution: hooks.hasActiveExecution,
    syncPowerLock: hooks.syncPowerLock,
    pruneInMemorySlotLocks: () => {
      if (inMemorySlotLocks.size <= 400) return;
      const keep = [...inMemorySlotLocks].slice(-200);
      inMemorySlotLocks.clear();
      for (const k of keep) inMemorySlotLocks.add(k);
    },
  };
}

export type SchedulerRuntimeContext = ReturnType<typeof createSchedulerRuntime>;

export class AutoSchedulerService {
  private cronTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private readonly runtime: SchedulerRuntimeContext;

  constructor(
    private readonly repo: CompatibleRepository<AutoSchedulerRepository>,
    private readonly deps: AutoSchedulerServiceDeps,
  ) {
    this.runtime = createSchedulerRuntime(repo, deps, {
      hasActiveExecution: () => this.hasActiveExecution(),
      syncPowerLock: () => this.syncPowerLock(),
    });
    if (!deps.featureExecution.hasParticipant('auto-scheduler')) {
      deps.featureExecution.register({
        id: 'auto-scheduler',
        label: '定时排班',
        isProfileRunning: (profileId) => this.runtime.ownedTargets.has(profileId),
        hasActiveExecution: () => this.hasActiveExecution(),
        stopProfiles: async (profileIds) =>
          void (await stopSchedulerTargets(this.runtime, profileIds, true)),
      });
    }
  }

  hasActiveExecution = () =>
    this.runtime.liveRuns.size > 0 ||
    this.runtime.activeBrowserWorkers > 0 ||
    this.runtime.activeBluestacksWorkers > 0 ||
    this.runtime.browserQueue.length > 0 ||
    this.runtime.bluestacksQueue.length > 0;

  private syncPowerLock(): void {
    const next: PowerLockMode = !this.runtime.cachedSettings.preventSystemSleep
      ? 'none'
      : this.hasActiveExecution()
        ? 'prevent-display-sleep'
        : this.runtime.cachedEnabledScheduleCount > 0
          ? 'prevent-app-suspension'
          : 'none';
    if (next !== this.runtime.currentPowerLock) {
      this.runtime.currentPowerLock = next;
      this.deps.onPowerLockChange?.(next);
    }
  }

  private async refreshEnabledCountAndPowerLock(): Promise<void> {
    this.runtime.cachedEnabledScheduleCount = (await this.repo.listSchedules()).filter(
      (s) => s.enabled,
    ).length;
    this.syncPowerLock();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.runtime.shuttingDown = false;
    await this.repo.recoverInterruptedRunsOnStartup(this.runtime.now());
    this.runtime.cachedSettings = await this.repo.settings();
    await this.deps.onConcurrencyChanged?.({
      browserConcurrency: this.runtime.cachedSettings.browserConcurrency,
      bluestacksConcurrency: this.runtime.cachedSettings.bluestacksConcurrency,
    });
    await this.refreshEnabledCountAndPowerLock();
    this.cronTimer = setInterval(() => void this.tick().catch(() => {}), 10_000);
    this.cronTimer.unref?.();
    setTimeout(
      () => !this.runtime.shuttingDown && void this.tick().catch(() => {}),
      1500,
    ).unref?.();
  }

  async shutdown(): Promise<void> {
    this.runtime.shuttingDown = true;
    if (this.cronTimer) {
      clearInterval(this.cronTimer);
      this.cronTimer = null;
    }
    this.started = false;
    if (this.hasActiveExecution()) await this.stop({}).catch(() => {});
    this.runtime.currentPowerLock = 'none';
    this.deps.onPowerLockChange?.('none');
  }

  state = (): Promise<AutoSchedulerState> => buildSchedulerState(this.runtime);

  private async mutateAndState(fn: () => Promise<unknown>): Promise<AutoSchedulerState> {
    this.deps.assertAllowed?.();
    await fn();
    return this.state();
  }

  saveSettings = (input: unknown) =>
    this.mutateAndState(async () => {
      this.runtime.cachedSettings = await this.repo.saveSettings(input);
      await this.deps.onConcurrencyChanged?.({
        browserConcurrency: this.runtime.cachedSettings.browserConcurrency,
        bluestacksConcurrency: this.runtime.cachedSettings.bluestacksConcurrency,
      });
      this.syncPowerLock();
      pumpCarrierPool(this.runtime, 'browser');
      pumpCarrierPool(this.runtime, 'bluestacks');
    });

  saveSchedule = (input: unknown) =>
    this.mutateAndState(async () => {
      await this.repo.saveSchedule(input);
      await this.refreshEnabledCountAndPowerLock();
    });

  toggleSchedule = (input: unknown) =>
    this.mutateAndState(async () => {
      await this.repo.toggleSchedule(input);
      await this.refreshEnabledCountAndPowerLock();
      if (!this.runtime.shuttingDown) void this.tick().catch(() => {});
    });

  duplicateSchedule = (input: unknown) =>
    this.mutateAndState(() => Promise.resolve(this.repo.duplicateSchedule(input)));

  deleteSchedule = (input: unknown) =>
    this.mutateAndState(async () => {
      const { id } = z.object({ id: Id }).strict().parse(input);
      for (const tracker of this.runtime.liveRuns.values())
        if (tracker.schedule.id === id)
          throw new ProductError('SCHEDULE_RUNNING', '该排班当前正在运行中，请先停止后再删除', 409);
      for (const key of this.runtime.launchingScheduleKeys)
        if (key.startsWith(`${id}:`))
          throw new ProductError('SCHEDULE_RUNNING', '该排班正在启动中，请先停止后再删除', 409);
      await this.repo.deleteSchedule({ id });
      await this.refreshEnabledCountAndPowerLock();
    });

  runNow = (input: unknown) =>
    this.mutateAndState(async () => {
      const { id, phase } = RunNowInput.parse(input);
      const schedule = await this.repo.getSchedule(id);
      if (!schedule) throw new ProductError('SCHEDULE_NOT_FOUND', '未找到该排班', 404);
      if (phase === 'prewarm' && (schedule.carrier !== 'browser' || !schedule.prewarm.enabled))
        throw new ProductError('PREWARM_NOT_ENABLED', '该排班未开启提前预热场', 400);
      const launchKey = `${id}:${phase}`;
      if (this.runtime.launchingScheduleKeys.has(launchKey))
        throw new ProductError(
          'SCHEDULE_ALREADY_RUNNING',
          '该排班当前场次已在启动中，请勿重复启动',
          409,
        );
      for (const tracker of this.runtime.liveRuns.values()) {
        if (!tracker.cancelled && tracker.schedule.id === id && tracker.run.phase === phase)
          throw new ProductError(
            'SCHEDULE_ALREADY_RUNNING',
            '该排班当前场次已在运行中，请勿重复启动',
            409,
          );
      }
      const nowMs = this.runtime.now();
      this.runtime.launchingScheduleKeys.add(launchKey);
      this.runtime.cancelledLaunchSchedules.delete(id);
      try {
        await launchScheduleRun(
          this.runtime,
          schedule,
          phase,
          `manual-${nowMs}:${phase}`,
          'manual',
          nowMs,
        );
      } finally {
        this.runtime.launchingScheduleKeys.delete(launchKey);
      }
    });

  clearHistory = () => this.mutateAndState(() => Promise.resolve(this.repo.clearHistoryRuns?.()));

  async stop(input: unknown = {}): Promise<AutoSchedulerState> {
    const parsed = StopRunInput.parse(input ?? {});
    const keepOpen = Boolean(parsed.keepWindowsOpen);
    if (parsed.targetIds?.length)
      await stopSchedulerTargets(this.runtime, parsed.targetIds, keepOpen);
    else
      await stopSchedulerRuns(this.runtime, {
        runId: parsed.runId,
        scheduleId: parsed.scheduleId,
        keepOpen,
      });
    this.syncPowerLock();
    return this.state();
  }

  tick = (): Promise<void> => tickScheduler(this.runtime);
}
