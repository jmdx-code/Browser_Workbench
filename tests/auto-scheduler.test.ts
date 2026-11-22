import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  AutoSchedulerService,
  type PowerLockMode,
} from '../src/application/auto-scheduler-service.js';
import type { BluestacksService } from '../src/application/bluestacks-service.js';
import { FeatureExecutionRegistry } from '../src/application/feature-execution-registry.js';
import { syncGlobalConcurrencyToModules } from '../src/application/global-concurrency-sync.js';
import type { GroupBumperService } from '../src/application/group-bumper-service.js';
import type { GroupInviterService } from '../src/application/group-inviter-service.js';
import type { GroupPosterService } from '../src/application/group-poster-service.js';
import type { TaskService } from '../src/application/task-service.js';
import type { WorkspaceService } from '../src/application/workspace-service.js';
import {
  isAccountHardBlockTaskReason,
  stepFailureAllowsAutoContinuation,
} from '../src/domain/step-failure-policy.js';
import { SqliteAutoSchedulerRepository } from '../src/infrastructure/auto-scheduler-store.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { persistenceRoutes } from '../src/infrastructure/persistence-routes.js';
import {
  AutoSchedule,
  computeDueScheduleTriggers,
  computeEffectiveSafetyCeilingMinutes,
  computeNextRunPreview,
  computeUpcomingRunsPreview,
  isUserSavedCombination,
} from '../src/shared/auto-scheduler.js';
import type { Profile, SavedCombination } from '../src/shared/contracts.js';
import type { ProfileLifecyclePort } from '../src/shared/profile-lifecycle.js';
import { TEST_COMBINATION_NOTE } from '../src/shared/task-tests.js';

function waitUntil(pred: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = async () => {
      if (await pred()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('waitUntil timeout'));
        return;
      }
      setTimeout(() => void check(), 25);
    };
    void check();
  });
}

function makeProfile(
  id: string,
  name: string,
  groupId: string | null,
  accountState: Profile['account']['state'] = 'logged-in',
  online = false,
): Profile {
  return {
    id,
    alias: name,
    browserName: name,
    groupId,
    order: 0,
    online,
    phase: online ? 'PAUSED' : 'OFFLINE',
    synced: online,
    unresolved: 0,
    extensionVersion: '0.3.84',
    capabilities: [],
    presentation: null,
    account: {
      state: accountState,
      id: '10001',
      name,
      avatar: null,
    },
  };
}

describe('AutoScheduler (无人值守定时排班)', () => {
  it('registers every public method of SqliteAutoSchedulerRepository in persistenceRoutes and recovers interrupted runs cleanly', () => {
    const proto = SqliteAutoSchedulerRepository.prototype;
    const publicMethods = Object.getOwnPropertyNames(proto).filter(
      (name) =>
        name !== 'constructor' &&
        !name.startsWith('map') &&
        !name.startsWith('listItems') &&
        typeof Reflect.get(proto, name) === 'function',
    );
    for (const method of publicMethods) {
      expect(persistenceRoutes.has(`workspace.autoScheduler.${method}`)).toBe(true);
    }

    const db = new DatabaseSync(':memory:');
    const repo = new SqliteAutoSchedulerRepository(db);
    const saved = repo.saveSchedule({
      name: '早班 30 号',
      enabled: true,
      carrier: 'browser',
      targetSelector: {
        mode: 'groups',
        groupIds: ['grp-morning'],
        targetIds: [],
        skipAbnormalAccounts: true,
      },
      trigger: {
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        times: ['07:30'],
        timeZone: 'Asia/Shanghai',
        jitterMinutes: 0,
        misfireGraceMinutes: 120,
      },
      prewarm: {
        enabled: true,
        leadMinutes: 90,
        steps: [{ id: randomUUID(), type: 'quick-browse', target: 'feed', durationMinutes: 15 }],
      },
      steps: [
        { id: randomUUID(), type: 'quick-browse', target: 'feed', durationMinutes: 1 },
        { id: randomUUID(), type: 'page-bumper', pageIds: ['p1'] },
        { id: randomUUID(), type: 'quick-browse', target: 'feed', durationMinutes: 1 },
      ],
      closeWindowOnFinish: true,
      maxSafetyMinutesPerTarget: null,
    });
    const dup = repo.duplicateSchedule({ id: saved.id });
    expect(dup.name).toBe('早班 30 号 副本');
    expect(dup.enabled).toBe(false);
    expect(repo.listSchedules()).toHaveLength(2);

    const runId = randomUUID();
    const pDone = randomUUID();
    const pInterrupted = randomUUID();
    repo.saveRunWithItems(
      {
        id: runId,
        scheduleId: saved.id,
        scheduleName: saved.name,
        carrier: 'browser',
        phase: 'main',
        slotKey: '2026-11-17@07:30:main',
        triggerMode: 'cron',
        status: 'running',
        statusReason: '运行中',
        totalTargets: 2,
        completedCount: 1,
        softIssueCount: 0,
        hardBlockedCount: 0,
        watchdogTimeoutCount: 0,
        skippedCount: 0,
        scheduledFor: 1000,
        startedAt: 1000,
        finishedAt: null,
      },
      [
        {
          runId,
          targetId: pDone,
          targetName: '已完成号',
          status: 'completed',
          currentStep: '已结束',
          summary: '完成',
          bumpedCount: 3,
          postedCount: 0,
          softIssues: 0,
          hardBlockReason: null,
          seamlessHandoff: false,
          startedAt: 1000,
          finishedAt: 2000,
          updatedAt: 2000,
        },
        {
          runId,
          targetId: pInterrupted,
          targetName: '中断号',
          status: 'running',
          currentStep: '步骤 1',
          summary: '运行中',
          bumpedCount: 0,
          postedCount: 0,
          softIssues: 0,
          hardBlockReason: null,
          seamlessHandoff: false,
          startedAt: 1000,
          finishedAt: null,
          updatedAt: 1500,
        },
      ],
    );

    expect(repo.recoverInterruptedRunsOnStartup(3000)).toBe(1);
    // Interrupted slot is NOT marked handled so it can resume within misfire window,
    // while already-completed account pDone IS preserved in listFinishedTargetIdsForSlot!
    expect(repo.listHandledSlotKeys(saved.id, 0)).toEqual([]);
    expect(repo.listFinishedTargetIdsForSlot(saved.id, '2026-11-17@07:30:main')).toEqual([pDone]);
    db.close();
  });

  it('evaluates Cron prewarm + main triggers, skips expired prewarm near peak time, and computes generous dynamic safety ceilings', () => {
    const sched = AutoSchedule.parse({
      id: randomUUID(),
      name: '早高峰顶贴',
      enabled: true,
      carrier: 'browser',
      targetSelector: {
        mode: 'groups',
        groupIds: ['g1'],
        targetIds: [],
        skipAbnormalAccounts: true,
      },
      trigger: {
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        times: ['07:30'],
        timeZone: 'Asia/Shanghai',
        jitterMinutes: 0,
        misfireGraceMinutes: 120,
      },
      prewarm: {
        enabled: true,
        leadMinutes: 90,
        steps: [{ id: randomUUID(), type: 'active-combination', combinationId: randomUUID() }],
      },
      steps: [
        { id: randomUUID(), type: 'active-combination', combinationId: randomUUID() },
        { id: randomUUID(), type: 'page-bumper', pageIds: ['p1', 'p2', 'p3', 'p4', 'p5'] },
        { id: randomUUID(), type: 'quick-browse', target: 'feed', durationMinutes: 1 },
      ],
      closeWindowOnFinish: true,
      maxSafetyMinutesPerTarget: null,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    });

    // Heavy 40-min combination + 5 pages (~12m) + 1m = 53m -> dynamic safety ceiling should be (53*2.5)+30 = 163m (never 25m!)
    const ceiling = computeEffectiveSafetyCeilingMinutes(sched, 'main', () => 40);
    expect(ceiling).toBe(163);

    // At 05:50 CST -> nextRun is Today 06:00 prewarm (for 07:30 main)
    const t0550 = Date.parse('2026-11-17T05:50:00+08:00');
    const preview = computeNextRunPreview(sched, t0550);
    expect(preview.phase).toBe('prewarm');
    expect(preview.label).toContain('06:00 预热（正点 07:30）');

    // At 06:05 CST -> prewarm fires normally
    const t0605 = Date.parse('2026-11-17T06:05:00+08:00');
    const due0605 = computeDueScheduleTriggers(sched, t0605, new Set());
    expect(due0605).toHaveLength(1);
    expect(due0605[0]?.phase).toBe('prewarm');
    expect(due0605[0]?.expiredSkipReason).toBeUndefined();

    // If PC booted late at 07:22 CST (only 8 mins before 07:30 main stage) -> prewarm auto-skips as expired!
    const t0722 = Date.parse('2026-11-17T07:22:00+08:00');
    const due0722 = computeDueScheduleTriggers(sched, t0722, new Set());
    expect(due0722).toHaveLength(1);
    expect(due0722[0]?.phase).toBe('prewarm');
    expect(due0722[0]?.expiredSkipReason).toContain('自动跳过过期预热');
  });

  it('enforces sliding worker pool concurrency, handles soft vs hard faults, skips prewarm-banned accounts in main stage, and closes every browser', async () => {
    const db = new DatabaseSync(':memory:');
    const repo = new SqliteAutoSchedulerRepository(db);
    repo.saveSettings({
      browserConcurrency: 2,
      launchStaggerSeconds: 0,
      idleWatchdogMinutes: 5,
      preventSystemSleep: true,
    });

    const p1 = randomUUID();
    const p2 = randomUUID(); // Will hit hard ban in prewarm!
    const p3 = randomUUID(); // Will hit soft restriction in main bumper, still runs closing browse & closes!
    const profilesMap = new Map<string, Profile>([
      [p1, makeProfile(p1, '账号1', 'g-morning')],
      [p2, makeProfile(p2, '账号2-待封', 'g-morning')],
      [p3, makeProfile(p3, '账号3-软限', 'g-morning')],
    ]);

    let currentOpenWindows = 0;
    let peakOpenWindows = 0;
    const closedIds: string[] = [];

    const lifecycle: ProfileLifecyclePort = {
      isLaunching: () => false,
      getStatus: async () => [],
      launchProfile: async (id) => ({
        profileId: id,
        browserName: id,
        action: 'open',
        ok: true,
        online: true,
        phase: 'PAUSED',
        synced: true,
        launchable: true,
        elapsedMs: 10,
      }),
      ensureProfilesOnline: async (ids) => {
        for (const id of ids) {
          const p = profilesMap.get(id);
          if (p && !p.online) {
            p.online = true;
            currentOpenWindows++;
            peakOpenWindows = Math.max(peakOpenWindows, currentOpenWindows);
          }
        }
        return {
          requestedIds: [...ids],
          readyIds: [...ids],
          launchedIds: [...ids],
          failed: [],
          items: [],
        };
      },
      closeProfile: async (id) => {
        const p = profilesMap.get(id);
        if (p && p.online) {
          p.online = false;
          currentOpenWindows = Math.max(0, currentOpenWindows - 1);
        }
        closedIds.push(id);
        return {
          profileId: id,
          browserName: id,
          action: 'close',
          ok: true,
          online: false,
          phase: 'OFFLINE',
          synced: false,
          launchable: true,
          elapsedMs: 10,
        };
      },
      restartProfile: async (id) => ({
        profileId: id,
        browserName: id,
        action: 'restart',
        ok: true,
        online: true,
        phase: 'PAUSED',
        synced: true,
        launchable: true,
        elapsedMs: 10,
      }),
    };

    const combos: SavedCombination[] = [];
    const quickBrowseRuns: string[] = [];

    const workspace = {
      snapshot: async () => ({
        profiles: [...profilesMap.values()],
        groups: [{ id: 'g-morning', name: '早班组', color: 'blue', order: 0 }],
        combinations: combos,
      }),
      repository: {
        combinations: async () => combos,
        createCombination: async (spec: SavedCombination['saved']) => {
          const created: SavedCombination = {
            id: randomUUID(),
            version: 1,
            revision: 0,
            saved: spec,
            draft: null,
            updatedAt: Date.now(),
          };
          combos.push(created);
          return created;
        },
      },
    } as unknown as WorkspaceService;

    const batchPlans = new Map<
      string,
      {
        id: string;
        profileId: string;
        state: string;
        reason: string;
        round: number;
        position: number;
        updatedAt: number;
      }
    >();
    const tasks = {
      settings: async () => ({ maxConcurrentProfiles: 15 }),
      setSettings: async () => ({ maxConcurrentProfiles: 15 }),
      releaseErroredPausedPlans: async () => 0,
      livePlans: async () => [],
      stopActiveProfile: async () => true,
      start: async (req: { requestId: string; profileIds: string[] }) => {
        const pid = req.profileIds[0] ?? '';
        quickBrowseRuns.push(pid);
        const planId = randomUUID();
        if (pid === p2) {
          const prof = profilesMap.get(p2);
          if (prof) prof.account.state = 'restricted';
          batchPlans.set(req.requestId, {
            id: planId,
            profileId: pid,
            state: 'FAILED',
            reason: '账号已被封禁',
            round: 1,
            position: 0,
            updatedAt: Date.now(),
          });
        } else {
          batchPlans.set(req.requestId, {
            id: planId,
            profileId: pid,
            state: 'COMPLETED',
            reason: '',
            round: 1,
            position: 0,
            updatedAt: Date.now(),
          });
        }
        return { plans: [{ id: planId, profileId: pid }] };
      },
      plansForBatch: async (reqId: string) => {
        const p = batchPlans.get(reqId);
        return p ? [p] : [];
      },
      runtimeOverview: async () => ({ currentSteps: [] }),
    } as unknown as TaskService;

    const groupBumper = {
      runScheduledProfileStep: async (input: {
        profileId: string;
        onProgress: (s: string, n: number) => void;
      }) => {
        input.onProgress('正在观看视频 (00:15/01:00)', 0);
        await new Promise((r) => setTimeout(r, 30));
        if (input.profileId === p3) {
          return {
            bumpedCount: 1,
            status: '暂时限制评论，已跳过剩余评论',
            hardBlocked: false,
            softIssue: true,
          };
        }
        return {
          bumpedCount: 3,
          status: '已完成 · 本轮 3 次',
          hardBlocked: false,
          softIssue: false,
        };
      },
      stop: async () => ({}),
    } as unknown as GroupBumperService;

    const powerModes: PowerLockMode[] = [];
    const featureExecution = new FeatureExecutionRegistry();
    const service = new AutoSchedulerService(repo, {
      workspace,
      tasks,
      groupBumper,
      profileLifecycle: lifecycle,
      featureExecution,
      onPowerLockChange: (m) => powerModes.push(m),
      pollIntervalMs: 30,
    });
    await service.start();

    const stAfterSave = await service.saveSchedule({
      name: '早高峰测试班',
      enabled: true,
      carrier: 'browser',
      targetSelector: {
        mode: 'groups',
        groupIds: ['g-morning'],
        targetIds: [],
        skipAbnormalAccounts: true,
      },
      trigger: {
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        times: ['23:59'],
        timeZone: 'Asia/Shanghai',
        jitterMinutes: 0,
        misfireGraceMinutes: 120,
      },
      prewarm: {
        enabled: true,
        leadMinutes: 90,
        steps: [{ id: randomUUID(), type: 'quick-browse', target: 'feed', durationMinutes: 5 }],
      },
      steps: [
        { id: randomUUID(), type: 'page-bumper', pageIds: ['page-1'] },
        { id: randomUUID(), type: 'quick-browse', target: 'feed', durationMinutes: 1 },
      ],
      closeWindowOnFinish: true,
      maxSafetyMinutesPerTarget: null,
    });
    const schedId = stAfterSave.schedules[0]?.id ?? '';
    expect(powerModes).toContain('prevent-app-suspension');

    // 1) Run Prewarm: p1 & p3 succeed, p2 hits hard ban -> concurrency never exceeds 2!
    await service.runNow({ id: schedId, phase: 'prewarm' });
    expect(powerModes).toContain('prevent-display-sleep');
    await waitUntil(async () => !(await service.state()).running, 8000);

    expect(peakOpenWindows).toBeLessThanOrEqual(2);
    expect(currentOpenWindows).toBe(0);

    // 2) Run Main Stage: p2 must be auto-skipped, p3 hits soft bumper issue yet STILL executes closing 1-min quick-browse and closes cleanly!
    quickBrowseRuns.length = 0;
    await service.runNow({ id: schedId, phase: 'main' });
    await waitUntil(async () => !(await service.state()).running, 8000);

    const finalState = await service.state();
    const mainReport = finalState.recentRuns[0];
    expect(mainReport?.phase).toBe('main');
    expect(mainReport?.skippedCount).toBe(1); // p2 auto-skipped!
    expect(mainReport?.completedCount).toBe(2); // p1 + p3 (soft warning still counts as completed收尾!)
    expect(mainReport?.softIssueCount).toBe(1); // p3 soft warning recorded!
    expect(quickBrowseRuns).toContain(p3); // p3 STILL ran closing 1-min feed browse after soft bumper warning!
    expect(currentOpenWindows).toBe(0);
    expect(closedIds.filter((id) => id === p3).length).toBeGreaterThanOrEqual(2);

    await service.shutdown();
    db.close();
  });

  it('supports seamless prewarm -> main handoff without closing & reopening, plus BlueStacks auto-launch & auto-close', async () => {
    const db = new DatabaseSync(':memory:');
    const repo = new SqliteAutoSchedulerRepository(db);
    repo.saveSettings({
      browserConcurrency: 4,
      bluestacksConcurrency: 2,
      launchStaggerSeconds: 0,
      idleWatchdogMinutes: 5,
      preventSystemSleep: false,
    });

    const pSlow = randomUUID();
    const profileObj = makeProfile(pSlow, '慢预热号', 'g1', 'logged-in', false);
    let closeCalls = 0;

    const lifecycle: ProfileLifecyclePort = {
      isLaunching: () => false,
      getStatus: async () => [],
      launchProfile: async (id) => ({
        profileId: id,
        browserName: id,
        action: 'open',
        ok: true,
        online: true,
        phase: 'PAUSED',
        synced: true,
        launchable: true,
        elapsedMs: 5,
      }),
      ensureProfilesOnline: async (ids) => {
        profileObj.online = true;
        return {
          requestedIds: [...ids],
          readyIds: [...ids],
          launchedIds: [...ids],
          failed: [],
          items: [],
        };
      },
      closeProfile: async (id) => {
        closeCalls++;
        profileObj.online = false;
        return {
          profileId: id,
          browserName: id,
          action: 'close',
          ok: true,
          online: false,
          phase: 'OFFLINE',
          synced: false,
          launchable: true,
          elapsedMs: 5,
        };
      },
      restartProfile: async (id) => ({
        profileId: id,
        browserName: id,
        action: 'restart',
        ok: true,
        online: true,
        phase: 'PAUSED',
        synced: true,
        launchable: true,
        elapsedMs: 5,
      }),
    };

    const combos: SavedCombination[] = [];
    let prewarmPlanRunning = true;
    const planId = randomUUID();

    const workspace = {
      snapshot: async () => ({
        profiles: [profileObj],
        groups: [{ id: 'g1', name: '组1', color: 'blue', order: 0 }],
        combinations: combos,
      }),
      repository: {
        combinations: async () => combos,
        createCombination: async (spec: SavedCombination['saved']) => {
          const c: SavedCombination = {
            id: randomUUID(),
            version: 1,
            revision: 0,
            saved: spec,
            draft: null,
            updatedAt: Date.now(),
          };
          combos.push(c);
          return c;
        },
      },
    } as unknown as WorkspaceService;

    const tasks = {
      settings: async () => ({ maxConcurrentProfiles: 15 }),
      setSettings: async () => ({ maxConcurrentProfiles: 15 }),
      releaseErroredPausedPlans: async () => 0,
      livePlans: async () => [],
      stopActiveProfile: async () => {
        prewarmPlanRunning = false;
        return true;
      },
      start: async () => ({ plans: [{ id: planId, profileId: pSlow }] }),
      plansForBatch: async () => [
        {
          id: planId,
          profileId: pSlow,
          state: prewarmPlanRunning ? 'RUNNING' : 'STOPPED',
          reason: '',
          round: 1,
          position: 0,
          updatedAt: Date.now(),
        },
      ],
      runtimeOverview: async () => ({ currentSteps: [] }),
    } as unknown as TaskService;

    const groupBumper = {
      runScheduledProfileStep: async () => ({
        bumpedCount: 2,
        status: '已完成 · 本轮 2 次',
        hardBlocked: false,
        softIssue: false,
      }),
      stop: async () => ({}),
    } as unknown as GroupBumperService;

    let bsLaunched = 0;
    let bsClosed = 0;
    const bsId = randomUUID();
    const bluestacks = {
      state: async () => ({
        instances: [
          {
            id: bsId,
            instanceKey: 'Pie64_1',
            displayName: '模拟器1',
            customTitle: null,
            folderId: 'f1',
            sortOrder: 0,
            adbPort: 5555,
            serial: '127.0.0.1:5555',
            fbWidth: 900,
            fbHeight: 1600,
            online: false,
            fbLiteInstalled: true,
            accountState: 'logged-in',
            accountName: 'BS User',
            accountId: '99',
            avatarUrl: null,
            lastStatus: null,
            updatedAt: 1,
          },
        ],
        folders: [{ id: 'f1', name: '蓝蝶早班', sortOrder: 0 }],
      }),
      ensureInstanceOnlineForSchedule: async () => {
        bsLaunched++;
        return { id: bsId };
      },
      runScheduledInstanceStep: async (input: { onProgress: (s: string, n: number) => void }) => {
        input.onProgress('正在扫描帖子 (1/12)', 1);
        return { bumpedCount: 4, status: '已完成', hardBlocked: false, softIssue: false };
      },
      closeInstanceForce: async () => {
        bsClosed++;
      },
      stopBumper: async () => ({}),
    } as unknown as BluestacksService;

    const featureExecution = new FeatureExecutionRegistry();
    const service = new AutoSchedulerService(repo, {
      workspace,
      tasks,
      groupBumper,
      bluestacks,
      profileLifecycle: lifecycle,
      featureExecution,
      pollIntervalMs: 30,
    });
    await service.start();

    const s1 = await service.saveSchedule({
      name: '无缝接力测试',
      enabled: true,
      carrier: 'browser',
      targetSelector: {
        mode: 'groups',
        groupIds: ['g1'],
        targetIds: [],
        skipAbnormalAccounts: true,
      },
      trigger: {
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        times: ['23:59'],
        timeZone: 'Asia/Shanghai',
        jitterMinutes: 0,
        misfireGraceMinutes: 60,
      },
      prewarm: {
        enabled: true,
        leadMinutes: 60,
        steps: [{ id: randomUUID(), type: 'quick-browse', target: 'feed', durationMinutes: 25 }],
      },
      steps: [{ id: randomUUID(), type: 'page-bumper', pageIds: ['p1'] }],
      closeWindowOnFinish: true,
      maxSafetyMinutesPerTarget: null,
    });
    const browserSchedId = s1.schedules[0]?.id ?? '';

    // Start prewarm (stays RUNNING), then trigger main stage while prewarm is still running!
    await service.runNow({ id: browserSchedId, phase: 'prewarm' });
    await waitUntil(() => profileObj.online, 3000);
    expect(closeCalls).toBe(0);

    await service.runNow({ id: browserSchedId, phase: 'main' });
    await waitUntil(async () => !(await service.state()).running, 6000);

    // Only closed ONCE at the end of Main Stage (NOT closed after prewarm and reopened)!
    expect(closeCalls).toBe(1);
    const afterBrowser = await service.state();
    const mainRun = afterBrowser.recentRuns.find((r) => r.phase === 'main');
    expect(mainRun?.items?.[0]?.seamlessHandoff).toBe(true);
    expect(mainRun?.items?.[0]?.bumpedCount).toBe(2);

    // Also verify BlueStacks schedule auto-launch + bump + auto-close!
    const s2 = await service.saveSchedule({
      name: '蓝蝶自动排班',
      enabled: true,
      carrier: 'bluestacks',
      targetSelector: {
        mode: 'groups',
        groupIds: ['f1'],
        targetIds: [],
        skipAbnormalAccounts: true,
      },
      trigger: {
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        times: ['23:59'],
        timeZone: 'Asia/Shanghai',
        jitterMinutes: 0,
        misfireGraceMinutes: 60,
      },
      prewarm: { enabled: false, leadMinutes: 90, steps: [] },
      steps: [
        { id: randomUUID(), type: 'bluestacks-page-bumper', pageIds: ['p1'], enableSound: false },
      ],
      closeWindowOnFinish: true,
      maxSafetyMinutesPerTarget: null,
    });
    const bsSched = s2.schedules.find((x) => x.carrier === 'bluestacks');
    await service.runNow({ id: bsSched?.id ?? '', phase: 'main' });
    await waitUntil(async () => !(await service.state()).running, 6000);

    expect(bsLaunched).toBe(1);
    expect(bsClosed).toBe(1);

    await service.shutdown();
    db.close();
  });

  it('heartbeat watchdog never false-triggers on long video playback with progress, but terminates truly hung steps and closes browser', async () => {
    const db = new DatabaseSync(':memory:');
    const repo = new SqliteAutoSchedulerRepository(db);
    repo.saveSettings({
      browserConcurrency: 2,
      launchStaggerSeconds: 0,
      idleWatchdogMinutes: 5,
      preventSystemSleep: false,
    });

    const pHealthyLongVideo = randomUUID();
    const pFrozen = randomUUID();
    const profilesMap = new Map<string, Profile>([
      [pHealthyLongVideo, makeProfile(pHealthyLongVideo, '长视频健康号', 'g-wd')],
      [pFrozen, makeProfile(pFrozen, '卡死假死号', 'g-wd')],
    ]);
    const closed: string[] = [];

    const lifecycle: ProfileLifecyclePort = {
      isLaunching: () => false,
      getStatus: async () => [],
      launchProfile: async (id) => ({
        profileId: id,
        browserName: id,
        action: 'open',
        ok: true,
        online: true,
        phase: 'PAUSED',
        synced: true,
        launchable: true,
        elapsedMs: 5,
      }),
      ensureProfilesOnline: async (ids) => {
        for (const id of ids) {
          const p = profilesMap.get(id);
          if (p) p.online = true;
        }
        return {
          requestedIds: [...ids],
          readyIds: [...ids],
          launchedIds: [...ids],
          failed: [],
          items: [],
        };
      },
      closeProfile: async (id) => {
        const p = profilesMap.get(id);
        if (p) p.online = false;
        closed.push(id);
        return {
          profileId: id,
          browserName: id,
          action: 'close',
          ok: true,
          online: false,
          phase: 'OFFLINE',
          synced: false,
          launchable: true,
          elapsedMs: 5,
        };
      },
      restartProfile: async (id) => ({
        profileId: id,
        browserName: id,
        action: 'restart',
        ok: true,
        online: true,
        phase: 'PAUSED',
        synced: true,
        launchable: true,
        elapsedMs: 5,
      }),
    };

    const workspace = {
      snapshot: async () => ({
        profiles: [...profilesMap.values()],
        groups: [{ id: 'g-wd', name: '看门狗测试组', color: 'blue', order: 0 }],
        combinations: [],
      }),
      repository: {
        combinations: async () => [],
      },
    } as unknown as WorkspaceService;

    const stoppedByWatchdog = new Set<string>();
    const groupBumper = {
      runScheduledProfileStep: async (input: {
        profileId: string;
        onProgress: (s: string, n: number) => void;
      }) => {
        if (input.profileId === pHealthyLongVideo) {
          // Runs for 280ms (> 120ms watchdog window!), emitting playback progress every 40ms
          for (let tick = 1; tick <= 7; tick++) {
            await new Promise((r) => setTimeout(r, 40));
            if (stoppedByWatchdog.has(input.profileId)) {
              return { bumpedCount: 0, status: '已停止', hardBlocked: false, softIssue: true };
            }
            input.onProgress(`正在观看视频 (00:0${tick}/08:00)`, 0);
          }
          return {
            bumpedCount: 1,
            status: '已完成 · 本轮 1 次',
            hardBlocked: false,
            softIssue: false,
          };
        }
        // pFrozen: emits ZERO progress until stopped by watchdog!
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (stoppedByWatchdog.has(input.profileId)) {
              clearInterval(check);
              resolve();
            }
          }, 20);
        });
        return { bumpedCount: 0, status: '已停止', hardBlocked: false, softIssue: true };
      },
      stop: async (ids?: string[]) => {
        for (const id of ids ?? []) stoppedByWatchdog.add(id);
        return {};
      },
    } as unknown as GroupBumperService;

    const featureExecution = new FeatureExecutionRegistry();
    const service = new AutoSchedulerService(repo, {
      workspace,
      groupBumper,
      profileLifecycle: lifecycle,
      featureExecution,
      pollIntervalMs: 30,
      idleWatchdogOverrideMs: 120,
    });
    await service.start();

    const saved = await service.saveSchedule({
      name: '看门狗活性验证',
      enabled: true,
      carrier: 'browser',
      targetSelector: {
        mode: 'groups',
        groupIds: ['g-wd'],
        targetIds: [],
        skipAbnormalAccounts: true,
      },
      trigger: {
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        times: ['23:59'],
        timeZone: 'Asia/Shanghai',
        jitterMinutes: 0,
        misfireGraceMinutes: 60,
      },
      prewarm: { enabled: false, leadMinutes: 90, steps: [] },
      steps: [{ id: randomUUID(), type: 'page-bumper', pageIds: ['p1'] }],
      closeWindowOnFinish: true,
      maxSafetyMinutesPerTarget: null,
    });
    const schedId = saved.schedules[0]?.id ?? '';
    await service.runNow({ id: schedId, phase: 'main' });
    await waitUntil(async () => !(await service.state()).running, 5000);

    const st = await service.state();
    const run = st.recentRuns[0];
    const healthyItem = run?.items?.find((i) => i.targetId === pHealthyLongVideo);
    const frozenItem = run?.items?.find((i) => i.targetId === pFrozen);

    expect(healthyItem?.status).toBe('completed');
    expect(healthyItem?.bumpedCount).toBe(1);
    expect(frozenItem?.status).toBe('watchdog_timeout');
    expect(closed).toContain(pHealthyLongVideo);
    expect(closed).toContain(pFrozen);

    await service.shutdown();
    db.close();
  });

  it('6. filters internal test combinations, includes jitter in upcoming previews, fast-stops BlueStacks without 8s hang, supports keepWindowsOpen, and clears history', async () => {
    const internalCombo = {
      id: randomUUID(),
      version: 1,
      saved: {
        name: '排班 · 刷首页 1分钟',
        note: `${TEST_COMBINATION_NOTE}定时排班快捷浏览:feed:1`,
        steps: [],
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
      },
      draft: null,
      updatedAt: 1,
    } as unknown as SavedCombination;
    const realCombo = {
      id: randomUUID(),
      version: 1,
      saved: {
        name: '正式早高峰活跃组合',
        note: '用户保存的组合',
        steps: [],
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
      },
      draft: null,
      updatedAt: 1,
    } as unknown as SavedCombination;
    expect(isUserSavedCombination(internalCombo)).toBe(false);
    expect(isUserSavedCombination(realCombo)).toBe(true);

    // Upcoming preview with jitter
    const previews = computeUpcomingRunsPreview(
      {
        id: 'sched-jitter-test',
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        times: ['07:00', '12:00'],
        timeZone: 'Asia/Shanghai',
        jitterMinutes: 15,
        prewarmEnabled: true,
        prewarmLeadMinutes: 90,
      },
      Date.parse('2026-11-17T05:00:00+08:00'),
      3,
    );
    expect(previews.length).toBe(3);

    const db = new DatabaseSync(':memory:');
    const repo = new SqliteAutoSchedulerRepository(db);
    const bsId = randomUUID();
    const closedInstances: string[] = [];

    const bluestacks = {
      state: async () => ({
        instances: [
          {
            id: bsId,
            instanceKey: 'Pie64_1',
            displayName: 'p001',
            folderId: null,
            online: false,
            accountState: 'logged-in',
            accountName: 'Mawi',
          },
        ],
        folders: [],
      }),
      ensureInstanceOnlineForSchedule: async (_id: string, signal?: AbortSignal) => {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 2000);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              reject(new Error('TASK_STOPPED'));
            },
            { once: true },
          );
        });
      },
      runScheduledInstanceStep: async () => ({
        bumpedCount: 0,
        status: '已停止',
        hardBlocked: false,
        softIssue: false,
      }),
      stopBumper: async () => ({}),
      closeInstanceForce: async (id: string) => {
        closedInstances.push(id);
      },
    } as unknown as BluestacksService;

    const workspace = {
      repository: { combinations: async () => [] },
      snapshot: async () => ({ profiles: [], groups: [], combinations: [] }),
    } as unknown as WorkspaceService;

    const featureExecution = new FeatureExecutionRegistry();
    const service = new AutoSchedulerService(repo, {
      workspace,
      bluestacks,
      featureExecution,
      pollIntervalMs: 25,
    });
    await service.start();
    await service.saveSettings({ launchStaggerSeconds: 0 });

    const saved = await service.saveSchedule({
      name: '蓝蝶停止响应测试',
      enabled: true,
      carrier: 'bluestacks',
      targetSelector: {
        mode: 'explicit',
        groupIds: [],
        targetIds: [bsId],
        skipAbnormalAccounts: true,
      },
      trigger: {
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        times: ['22:00'],
        timeZone: 'Asia/Shanghai',
        jitterMinutes: 0,
        misfireGraceMinutes: 60,
      },
      prewarm: { enabled: false, leadMinutes: 90, steps: [] },
      steps: [{ id: randomUUID(), type: 'bluestacks-page-bumper', pageIds: ['p-1'] }],
      closeWindowOnFinish: true,
      maxSafetyMinutesPerTarget: null,
    });
    const schedId = saved.schedules[0]?.id ?? '';
    await service.runNow({ id: schedId, phase: 'main' });
    await new Promise((r) => setTimeout(r, 80));

    // Stop with keepWindowsOpen: true while booting — must resolve in < 1000ms (not 8000ms!) and mark 'stopped' (not 'soft_warning')
    const t0 = Date.now();
    const stoppedState = await service.stop({ targetIds: [bsId], keepWindowsOpen: true });
    const stopElapsed = Date.now() - t0;
    expect(stopElapsed).toBeLessThan(1500);
    expect(stoppedState.running).toBe(false);
    expect(closedInstances).toHaveLength(0);

    const lastRun = stoppedState.recentRuns[0];
    const item = lastRun?.items?.[0];
    expect(item?.status).toBe('stopped');

    const clearedState = await service.clearHistory();
    expect(clearedState.recentRuns).toHaveLength(0);

    await service.shutdown();
    db.close();
  });

  it('synchronizes global browserConcurrency and bluestacksConcurrency to all modules on startup and update', async () => {
    const db = new DatabaseSync(':memory:');
    const repo = new SqliteAutoSchedulerRepository(db);
    repo.saveSettings({ browserConcurrency: 18, bluestacksConcurrency: 6 });

    let taskCap = 100;
    let bumperCap = 8;
    let posterCap = 4;
    let inviterCap = 4;
    let bsCap = 4;

    const tasks = {
      settings: async () => ({ maxConcurrentProfiles: taskCap }),
      setSettings: async (v: { maxConcurrentProfiles: number }) => {
        taskCap = v.maxConcurrentProfiles;
        return { maxConcurrentProfiles: taskCap };
      },
    } as unknown as TaskService;

    const groupBumper = {
      syncMaxConcurrency: async (n: number) => {
        bumperCap = n;
      },
    } as unknown as GroupBumperService;

    const groupPoster = {
      syncMaxConcurrency: async (n: number) => {
        posterCap = n;
      },
    } as unknown as GroupPosterService;

    const groupInviter = {
      state: async () => ({ maxConcurrentProfiles: inviterCap }),
      updateSettings: async (v: { maxConcurrentProfiles?: number }) => {
        if (v.maxConcurrentProfiles !== undefined) inviterCap = v.maxConcurrentProfiles;
        return { maxConcurrentProfiles: inviterCap };
      },
    } as unknown as GroupInviterService;

    const bluestacks = {
      syncMaxConcurrency: async (n: number) => {
        bsCap = n;
      },
    } as unknown as BluestacksService;

    const workspace = {
      snapshot: async () => ({ profiles: [], groups: [], combinations: [] }),
      repository: { combinations: async () => [] },
    } as unknown as WorkspaceService;

    const service = new AutoSchedulerService(repo, {
      workspace,
      featureExecution: new FeatureExecutionRegistry(),
      onConcurrencyChanged: (next) =>
        syncGlobalConcurrencyToModules(next, {
          tasks,
          groupBumper,
          groupPoster,
          groupInviter,
          bluestacks,
        }),
    });

    await service.start();
    expect(taskCap).toBe(18);
    expect(bumperCap).toBe(18);
    expect(posterCap).toBe(18);
    expect(inviterCap).toBe(18);
    expect(bsCap).toBe(6);

    await service.saveSettings({ browserConcurrency: 25, bluestacksConcurrency: 9 });
    expect(taskCap).toBe(25);
    expect(bumperCap).toBe(25);
    expect(posterCap).toBe(25);
    expect(inviterCap).toBe(25);
    expect(bsCap).toBe(9);

    await service.shutdown();
    db.close();
  });

  it('auto-continuation step failure policy skips non-account step errors and INITIAL_SESSION_FAILED without parking in REVIEW', async () => {
    expect(stepFailureAllowsAutoContinuation('FACEBOOK_VIDEO_PLAYER_REQUIRED_TIMEOUT')).toBe(true);
    expect(stepFailureAllowsAutoContinuation('POST_EFFECT_TIMEOUT:SUBMIT:WAIT')).toBe(true);
    expect(stepFailureAllowsAutoContinuation('FACEBOOK_TASK_DOCUMENT_SCOPE_CHANGED')).toBe(true);

    // User-initiated pause and concurrency signals must never be treated as step failures
    expect(stepFailureAllowsAutoContinuation('USER_PAUSE')).toBe(false);
    expect(stepFailureAllowsAutoContinuation('SCHEDULE_WINDOW_CLOSED')).toBe(false);
    expect(stepFailureAllowsAutoContinuation('CONCURRENCY_LIMIT')).toBe(false);

    // Hard account issues must abort the account rather than continuing to subsequent steps
    expect(isAccountHardBlockTaskReason('ACCOUNT_RESTRICTED')).toBe(true);
    expect(isAccountHardBlockTaskReason('ACCOUNT_LOGGED_OUT')).toBe(true);
    expect(stepFailureAllowsAutoContinuation('ACCOUNT_RESTRICTED')).toBe(false);

    // Verify INITIAL_SESSION_FAILED REVIEW plan can execute requestStepEnd -> finishEnd -> finishStepContinuation
    const store = await WorkspaceStore.open(':memory:');
    const profileId = randomUUID();
    const combo = store.createCombination({
      name: '两步组合',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [
        { id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
        { id: randomUUID(), type: 'video', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
      ],
    });
    const assigned = await store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: combo.id,
        version: combo.version,
        profileIds: [profileId],
      },
      [
        {
          id: profileId,
          online: true,
          synced: true,
          unresolved: 0,
          dispatchAllowed: true,
          account: { state: 'logged-in', id: '1000888', name: 'Tester', avatar: null },
        },
      ],
    );
    expect(assigned).toHaveLength(1);
    const claimed = store.tasks.claimNext(
      [
        {
          id: profileId,
          online: true,
          synced: true,
          unresolved: 0,
          dispatchAllowed: true,
          account: { state: 'logged-in', id: '1000888', name: 'Tester', avatar: null },
        },
      ],
      new Set(['feed', 'video']),
    );
    expect(claimed?.state).toBe('RUNNING');
    const step0 = store.tasks.steps(claimed?.id ?? '')[0];
    expect(step0?.status).toBe('ACTIVE');

    const failReason = 'INITIAL_SESSION_FAILED:FACEBOOK_TASK_DOCUMENT_SCOPE_CHANGED';
    store.tasks.noteStepFailure(claimed?.id ?? '', step0?.id ?? '', failReason);
    const reviewed = store.tasks.reviewFailedAdmission(
      claimed?.id ?? '',
      '1000888',
      'FACEBOOK_TASK_DOCUMENT_SCOPE_CHANGED',
    );
    expect(reviewed.state).toBe('REVIEW');
    expect(reviewed.controlMode).toBeNull();

    const endingId = store.tasks.requestStepEnd(reviewed.id, step0?.id ?? '', failReason);
    const stopReceipt = {
      profileId,
      connectionEpoch: randomUUID(),
      requestId: endingId,
      state: 'stopped' as const,
    };
    store.tasks.prepareEnd(reviewed.id, stopReceipt);
    store.tasks.finishEnd(reviewed.id, stopReceipt);
    const advanced = store.tasks.finishStepContinuation(reviewed.id);
    expect(advanced.state).toBe('QUEUED');
    expect(advanced.position).toBe(1);

    store.close();
  });

  it('caches workspace.snapshot once per state() call and skips externally busy profiles in launchScheduleRun', async () => {
    const db = new DatabaseSync(':memory:');
    const repo = new SqliteAutoSchedulerRepository(db);
    const p1 = randomUUID();
    const p2 = randomUUID();
    let snapshotCalls = 0;

    const workspace = {
      repository: {
        combinations: async () => [],
      },
      snapshot: async () => {
        snapshotCalls++;
        return {
          groups: [{ id: 'g1', name: 'G1', color: 'blue', order: 0 }],
          profiles: [
            {
              id: p1,
              alias: 'BusyProf',
              browserName: 'BusyProf',
              groupId: 'g1',
              order: 0,
              online: true,
              phase: 'READY',
              synced: true,
              unresolved: 0,
              extensionVersion: '0.3.84',
              capabilities: [],
              account: { state: 'logged-in', id: '1', name: 'A', avatar: null },
            },
            {
              id: p2,
              alias: 'FreeProf',
              browserName: 'FreeProf',
              groupId: 'g1',
              order: 1,
              online: true,
              phase: 'READY',
              synced: true,
              unresolved: 0,
              extensionVersion: '0.3.84',
              capabilities: [],
              account: { state: 'logged-in', id: '2', name: 'B', avatar: null },
            },
          ],
          combinations: [],
        };
      },
    } as unknown as WorkspaceService;

    const bumpedProfiles: string[] = [];
    const featureExecution = new FeatureExecutionRegistry();
    featureExecution.register({
      id: 'google-sheets',
      label: 'Google 表格联动',
      isProfileRunning: (pid) => pid === p1,
      hasActiveExecution: () => true,
      stopProfiles: async () => {},
    });

    const service = new AutoSchedulerService(repo, {
      workspace,
      tasks: {
        settings: async () => ({ maxConcurrentProfiles: 5 }),
        setSettings: async () => ({ maxConcurrentProfiles: 5 }),
        releaseErroredPausedPlans: async () => 0,
        livePlans: async () => [],
        stopActiveProfile: async () => true,
        start: async () => ({ plans: [] }),
        plansForBatch: async () => [],
        runtimeOverview: async () => ({ currentSteps: [] }),
      } as unknown as TaskService,
      groupBumper: {
        runScheduledProfileStep: async (inp: { profileId: string }) => {
          bumpedProfiles.push(inp.profileId);
          return { bumpedCount: 1, status: 'ok', hardBlocked: false, softIssue: false };
        },
        stop: async () => ({}),
      } as unknown as GroupBumperService,
      profileLifecycle: {
        ensureProfilesOnline: async (ids: string[]) => ({
          requestedIds: [...ids],
          readyIds: [...ids],
          launchedIds: [],
          failed: [],
          items: [],
        }),
        closeProfile: async (id: string) => ({
          profileId: id,
          browserName: id,
          action: 'close',
          ok: true,
          online: false,
          phase: 'OFFLINE',
          synced: false,
          launchable: true,
          elapsedMs: 1,
        }),
      } as unknown as ProfileLifecyclePort,
      featureExecution,
      pollIntervalMs: 60_000,
    });
    await service.start();

    // Save two schedules, then inspect state() -> workspace.snapshot() must be called only ONCE
    await service.saveSchedule({
      name: '班次1',
      enabled: false,
      carrier: 'browser',
      targetSelector: {
        mode: 'groups',
        groupIds: ['g1'],
        targetIds: [],
        skipAbnormalAccounts: true,
      },
      trigger: {
        weekdays: [1],
        times: ['08:00'],
        timeZone: 'Asia/Shanghai',
        jitterMinutes: 0,
        misfireGraceMinutes: 60,
      },
      prewarm: { enabled: false, leadMinutes: 60, steps: [] },
      steps: [{ id: randomUUID(), type: 'page-bumper', pageIds: ['pg1'] }],
      closeWindowOnFinish: false,
      maxSafetyMinutesPerTarget: null,
    });
    const saved2 = await service.saveSchedule({
      name: '班次2',
      enabled: false,
      carrier: 'browser',
      targetSelector: {
        mode: 'groups',
        groupIds: ['g1'],
        targetIds: [],
        skipAbnormalAccounts: true,
      },
      trigger: {
        weekdays: [1],
        times: ['09:00'],
        timeZone: 'Asia/Shanghai',
        jitterMinutes: 0,
        misfireGraceMinutes: 60,
      },
      prewarm: { enabled: false, leadMinutes: 60, steps: [] },
      steps: [{ id: randomUUID(), type: 'page-bumper', pageIds: ['pg1'] }],
      closeWindowOnFinish: false,
      maxSafetyMinutesPerTarget: null,
    });
    snapshotCalls = 0;
    await service.state();
    expect(snapshotCalls).toBe(1);

    // Run schedule 1 now -> p1 is busy in google-sheets and must be skipped; p2 runs cleanly!
    const schedId = saved2.schedules[0]?.id ?? '';
    await service.runNow({ id: schedId, phase: 'main' });
    await waitUntil(async () => !(await service.state()).running, 5000);
    expect(bumpedProfiles).toEqual([p2]);

    await service.shutdown();
    db.close();
  });

  it('supports scheduled bluestacks-health-check patrol (re-checking cached abnormal instances) and hard-blocks subsequent steps when unhealthy', async () => {
    const db = new DatabaseSync(':memory:');
    const repo = new SqliteAutoSchedulerRepository(db);
    repo.saveSettings({
      browserConcurrency: 4,
      bluestacksConcurrency: 2,
      launchStaggerSeconds: 0,
      idleWatchdogMinutes: 5,
      preventSystemSleep: false,
    });

    const bsOk = randomUUID();
    const bsBad = randomUUID();
    const healthChecked: string[] = [];
    const bumped: string[] = [];

    const bluestacksMock = {
      state: async () => ({
        instances: [
          {
            id: bsOk,
            instanceKey: 'Pie64_1',
            displayName: 'BS-OK',
            alias: null,
            folderId: null,
            accountState: 'verification', // Previously cached abnormal -> pure health patrol MUST still check it!
          },
          {
            id: bsBad,
            instanceKey: 'Pie64_2',
            displayName: 'BS-Bad',
            alias: null,
            folderId: null,
            accountState: 'logged-in',
          },
        ],
      }),
      ensureInstanceOnlineForSchedule: async () => ({}),
      runScheduledHealthCheckStep: async (inp: { instanceId: string }) => {
        healthChecked.push(inp.instanceId);
        if (inp.instanceId === bsBad) {
          return {
            category: 'verification',
            status: '账号需安全验证 (Checkpoint)',
            hardBlocked: true,
            softIssue: false,
            autoRepaired: false,
          };
        }
        return {
          category: 'healthy',
          status: '体检健康 · Recovered',
          hardBlocked: false,
          softIssue: false,
          autoRepaired: false,
        };
      },
      runScheduledInstanceStep: async (inp: { instanceId: string }) => {
        bumped.push(inp.instanceId);
        return { bumpedCount: 1, status: '顶贴完成', hardBlocked: false, softIssue: false };
      },
      stopAllForInstances: async () => ({}),
      stopBumper: async () => ({}),
      closeInstanceForce: async () => {},
    } as unknown as BluestacksService;

    const featureExecution = new FeatureExecutionRegistry();
    const service = new AutoSchedulerService(repo, {
      workspace: {
        snapshot: async () => ({ profiles: [], groups: [], combinations: [] }),
        repository: { combinations: async () => [] },
      } as unknown as WorkspaceService,
      bluestacks: bluestacksMock,
      featureExecution,
      pollIntervalMs: 60_000,
    });
    await service.start();

    // 1. Pure health patrol must NOT pre-skip bsOk even though cached accountState was 'verification'
    const patrolState = await service.saveSchedule({
      name: '蓝蝶凌晨体检',
      enabled: false,
      carrier: 'bluestacks',
      targetSelector: {
        mode: 'explicit',
        groupIds: [],
        targetIds: [bsOk],
        skipAbnormalAccounts: true,
      },
      trigger: {
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        times: ['06:00'],
        timeZone: 'Asia/Shanghai',
        jitterMinutes: 0,
        misfireGraceMinutes: 60,
      },
      prewarm: { enabled: false, leadMinutes: 90, steps: [] },
      steps: [{ id: randomUUID(), type: 'bluestacks-health-check', autoInstallApk: true }],
      closeWindowOnFinish: true,
      maxSafetyMinutesPerTarget: null,
    });
    const patrolId = patrolState.schedules[0]?.id ?? '';
    await service.runNow({ id: patrolId, phase: 'main' });
    await waitUntil(async () => !(await service.state()).running, 5000);
    expect(healthChecked).toEqual([bsOk]);

    // 2. Chained health-check -> page-bumper: bsBad fails health-check -> MUST hard-block and NOT run bumper!
    const chainState = await service.saveSchedule({
      name: '先体检再顶贴',
      enabled: false,
      carrier: 'bluestacks',
      targetSelector: {
        mode: 'explicit',
        groupIds: [],
        targetIds: [bsBad],
        skipAbnormalAccounts: true,
      },
      trigger: {
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        times: ['08:00'],
        timeZone: 'Asia/Shanghai',
        jitterMinutes: 0,
        misfireGraceMinutes: 60,
      },
      prewarm: { enabled: false, leadMinutes: 90, steps: [] },
      steps: [
        { id: randomUUID(), type: 'bluestacks-health-check', autoInstallApk: false },
        { id: randomUUID(), type: 'bluestacks-page-bumper', pageIds: ['pg1'] },
      ],
      closeWindowOnFinish: true,
      maxSafetyMinutesPerTarget: null,
    });
    const chainId = chainState.schedules.find((s) => s.name === '先体检再顶贴')?.id ?? '';
    await service.runNow({ id: chainId, phase: 'main' });
    await waitUntil(async () => !(await service.state()).running, 5000);
    expect(healthChecked).toEqual([bsOk, bsBad]);
    expect(bumped).toEqual([]);

    const finalState = await service.state();
    const lastRun = finalState.recentRuns[0];
    expect(lastRun?.hardBlockedCount).toBe(1);

    await service.shutdown();
    db.close();
  });
});
