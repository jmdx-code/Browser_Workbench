import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ZodError, z } from 'zod';
import { AutoSchedulerService } from '../src/application/auto-scheduler-service.js';
import {
  createBumperRuntime,
  startBumperRunWithMeta,
} from '../src/application/bumper/bumper-workers.js';
import { FeatureExecutionRegistry } from '../src/application/feature-execution-registry.js';
import { GroupBumperService } from '../src/application/group-bumper-service.js';
import { GroupInviterService } from '../src/application/group-inviter-service.js';
import { GroupPosterService } from '../src/application/group-poster-service.js';
import { TaskService } from '../src/application/task-service.js';
import { Workboard } from '../src/application/workboard.js';
import type { Core, Peer } from '../src/bridge/core.js';
import { isZodValidationError, workspaceApi } from '../src/http/workspace-api.js';
import { ActiveAccountRuntime } from '../src/infrastructure/active-account-runtime.js';
import { BrowserLifecycleManager } from '../src/infrastructure/browser-lifecycle-manager.js';
import { FilesystemPosterMediaPreparer } from '../src/infrastructure/group-poster-runner/poster-media-preparer.js';
import type { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import type { WorkspaceStorePort } from '../src/infrastructure/persistence-port.js';
import { AutoSchedulerGlobalSettings } from '../src/shared/auto-scheduler.js';
import { BumperSettings, type BumperTarget } from '../src/shared/group-bumper.js';
import { TaskStepSkip } from '../src/shared/task-step-outcome.js';
import {
  assignSamplePlan,
  makeRuntimeProfiles,
  workspaceFixture,
} from './fixtures/workspace-fixture.js';

const makeTarget = (id: string): BumperTarget => ({
  id,
  name: `Target ${id}`,
  avatarUrl: null,
  folderId: null,
  sortOrder: 0,
  totalBumpedCount: 0,
  createdAt: 0,
  updatedAt: 0,
});

test('BUG-P0-01: active-accounts carrierModule check prevents self-deadlock for poster/bumper/inviter soldiers', async () => {
  const workboard = new Workboard({ browserConcurrency: 10, bluestacksConcurrency: 5 });
  const registry = new FeatureExecutionRegistry();
  const profileId = randomUUID();
  let hasQueuedOrRunningPlan = false;

  registry.register({
    id: 'active-accounts',
    label: '活跃账号',
    isProfileRunning: (id) =>
      workboard.carrierModule(id) === 'active-accounts' || hasQueuedOrRunningPlan,
    hasActiveExecution: () => workboard.isModuleActive('active-accounts'),
  });
  registry.register({
    id: 'group-poster',
    label: '小组发帖',
    isProfileRunning: (id) => workboard.carrierModule(id) === 'group-poster',
    hasActiveExecution: () => workboard.isModuleActive('group-poster'),
  });

  await workboard.runSoldier(
    { carrierId: profileId, carrierKind: 'browser', moduleId: 'group-poster' },
    async () => {
      assert.equal(await registry.isProfileBusy(profileId, 'group-poster'), false);
      assert.equal(await registry.isProfileBusy(profileId, 'group-bumper'), true);
    },
  );

  await workboard.runSoldier(
    { carrierId: profileId, carrierKind: 'browser', moduleId: 'active-accounts' },
    async () => {
      assert.equal(await registry.isProfileBusy(profileId, 'group-poster'), true);
    },
  );

  hasQueuedOrRunningPlan = true;
  assert.equal(await registry.isProfileBusy(profileId, 'group-poster'), true);
});

test('BUG-P1-01: group-bumper -> page-bumper consecutive start succeeds without 409 leak and cleans up early exits', async () => {
  const profileId = randomUUID();
  const group = makeTarget('123456');
  const page = makeTarget('654321');
  const defaultSettings = BumperSettings.parse({});
  let allowed = true;
  const ctx = createBumperRuntime({
    repo: {
      settings: () => defaultSettings,
      saveSettings: (v) => BumperSettings.parse(v),
      pageSettings: () => defaultSettings,
      savePageSettings: (v) => BumperSettings.parse(v),
      targets: (kind) => (kind === 'groups' ? [group] : [page]),
      upsertTargets: () => [],
      deleteTargets: () => 0,
      comments: () => [],
      saveComments: () => [],
      logs: () => [],
      deleteLogs: () => 0,
      todayCounts: () => ({}),
    },
    runner: {
      ready: () => true,
      busy: async () => false,
      run: async () => {},
      stop: async () => {},
    },
    summary: async () => ({ comments: [], total: 0 }),
    assertAllowed: () => {
      if (!allowed) throw new Error('DISALLOWED');
    },
    staggerScale: 0,
  });

  const r1 = await startBumperRunWithMeta(
    ctx,
    { profileIds: [profileId], groupIds: [group.id], pageIds: [page.id] },
    'group-bumper',
  );
  assert.equal(r1.admittedCount, 1);
  await Promise.all(r1.workerPromises);
  assert.equal(ctx.profileModes.has(profileId), false);

  const r2 = await startBumperRunWithMeta(
    ctx,
    { profileIds: [profileId], pageIds: [page.id] },
    'page-bumper',
  );
  assert.equal(r2.admittedCount, 1);
  await Promise.all(r2.workerPromises);
  assert.equal(ctx.profileModes.has(profileId), false);

  allowed = false;
  await assert.rejects(
    () =>
      startBumperRunWithMeta(
        ctx,
        { profileIds: [profileId], groupIds: [group.id], pageIds: [page.id] },
        'group-bumper',
      ),
    /DISALLOWED/,
  );
  assert.equal(ctx.profileModes.has(profileId), false);
});

test('BUG-01: syncMaxConcurrency updates workboard and persists settings across task, poster, bumper (group & page), inviter, and scheduler', async () =>
  workspaceFixture(async (store) => {
    const workboard = new Workboard({ browserConcurrency: 15, bluestacksConcurrency: 5 });

    const taskService = new TaskService(store.tasks);
    taskService.setWorkboard(workboard);

    const posterService = new GroupPosterService(
      store.groupPoster,
      {
        ready: () => false,
        busy: async () => false,
        runProfileWorker: async () => {},
        stop: async () => {},
      },
      { prepare: async () => ({ localFilePath: '', mediaKind: 'none' }) },
    );
    posterService.setWorkboard(workboard);

    const bumperService = new GroupBumperService(
      store.groupBumper,
      {
        ready: () => false,
        busy: async () => false,
        run: async () => {},
        stop: async () => {},
      },
      async () => ({ comments: [], total: 0 }),
    );
    bumperService.setWorkboard(workboard);

    const inviterService = new GroupInviterService(store.groupInviter);
    inviterService.setWorkboard(workboard);

    let syncedCalls = 0;
    const scheduler = new AutoSchedulerService(store.autoScheduler, {
      workspace: {} as never,
      workboard,
      tasks: taskService,
      groupBumper: bumperService,
      groupPoster: posterService,
      groupInviter: inviterService,
      bluestacks: {} as never,
      profileLifecycle: {} as never,
      featureExecution: new FeatureExecutionRegistry(),
      onConcurrencyChanged: async ({ browserConcurrency }) => {
        syncedCalls += 1;
        workboard.setConcurrencyLimits({ browserConcurrency });
        await Promise.all([
          taskService.syncMaxConcurrency(browserConcurrency),
          posterService.syncMaxConcurrency(browserConcurrency),
          bumperService.syncMaxConcurrency(browserConcurrency),
          inviterService.syncMaxConcurrency(browserConcurrency),
        ]);
      },
    });

    await scheduler.saveSettings({ browserConcurrency: 22, bluestacksConcurrency: 7 });
    assert.equal(syncedCalls, 1);
    assert.equal(workboard.browserPermits.max, 22);
    assert.equal(store.tasks.settings().maxConcurrentProfiles, 22);
    assert.equal(store.groupPoster.settings().maxConcurrentProfiles, 22);
    assert.equal(store.groupBumper.settings().maxConcurrentProfiles, 22);
    assert.equal(store.groupBumper.pageSettings().maxConcurrentProfiles, 22);
    assert.equal(store.groupInviter.getSettings().maxConcurrentProfiles, 22);
  }));

test('BUG-02: auto-scheduler validates before IPC worker and workspaceApi maps serialized ZodError to 400 VALIDATION_FAILED', async () => {
  let repoSaveScheduleCalls = 0;
  let repoSaveSettingsCalls = 0;
  const baseSettings = AutoSchedulerGlobalSettings.parse({});
  const svc = new AutoSchedulerService(
    {
      settings: () => baseSettings,
      saveSettings: (input) => {
        repoSaveSettingsCalls += 1;
        return AutoSchedulerGlobalSettings.parse(input);
      },
      listSchedules: () => [],
      getSchedule: () => null,
      saveSchedule: () => {
        repoSaveScheduleCalls += 1;
        throw new Error('SHOULD_NOT_REACH_WORKER');
      },
      toggleSchedule: () => {
        throw new Error('UNUSED');
      },
      duplicateSchedule: () => {
        throw new Error('UNUSED');
      },
      deleteSchedule: () => true,
      saveRun: (r) => r,
      saveRunItem: () => {},
      saveRunWithItems: () => {},
      listRuns: () => [],
      listHandledSlotKeys: () => [],
      listFinishedTargetIdsForSlot: () => [],
      listHardBlockedTargetIdsSince: () => [],
      recoverInterruptedRunsOnStartup: () => 0,
      pruneOldRuns: () => 0,
    },
    {
      workspace: {} as never,
      workboard: new Workboard(),
      tasks: {} as never,
      groupBumper: {} as never,
      groupPoster: {} as never,
      groupInviter: {} as never,
      bluestacks: {} as never,
      profileLifecycle: {} as never,
      featureExecution: new FeatureExecutionRegistry(),
    },
  );

  await assert.rejects(() => svc.saveSchedule({ carrier: 'browser', name: '' }), ZodError);
  assert.equal(repoSaveScheduleCalls, 0);

  await assert.rejects(() => svc.saveSettings({ browserConcurrency: 999 }), ZodError);
  assert.equal(repoSaveSettingsCalls, 0);

  const realZodErr = z.object({ a: z.string() }).safeParse({ a: 1 });
  assert.equal(realZodErr.success, false);
  if (!realZodErr.success) {
    assert.equal(isZodValidationError(realZodErr.error), true);
  }
  const serializedErr = Object.assign(new Error('invalid'), {
    name: 'ZodError',
    issues: [{ path: ['name'], message: '必填' }],
  });
  assert.equal(isZodValidationError(serializedErr), true);
  assert.equal(isZodValidationError(new Error('boom')), false);

  const handler = workspaceApi(
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      saveSchedule: async () => {
        throw serializedErr;
      },
    } as never,
  );
  const server = http.createServer(async (req, res) => {
    await handler(req, res, '/api/workspace/auto-scheduler/schedules/save', {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const resp = await fetch(
      `http://127.0.0.1:${addr.port}/api/workspace/auto-scheduler/schedules/save`,
      {
        method: 'POST',
      },
    );
    assert.equal(resp.status, 400);
    const body = (await resp.json()) as { code: string; issues?: unknown[] };
    assert.equal(body.code, 'VALIDATION_FAILED');
    assert.equal(Array.isArray(body.issues), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('BUG-P2-01a: TaskStepSkip accepts USER_STOP and stopPlanDirect records USER_STOP for pending steps', async () =>
  workspaceFixture(async (store) => {
    const parsed = TaskStepSkip.parse({
      version: 1,
      kind: 'SKIPPED',
      reason: 'USER_STOP',
      endedAt: Date.now(),
    });
    assert.equal(parsed.reason, 'USER_STOP');

    const profile = makeRuntimeProfiles(1)[0];
    assert.ok(profile);
    const step1 = {
      id: randomUUID(),
      type: 'feed' as const,
      durationMinutes: 1,
      maxLikes: 0 as const,
      minLikeCount: 0 as const,
    };
    const step2 = {
      id: randomUUID(),
      type: 'video' as const,
      durationMinutes: 1,
      maxLikes: 0 as const,
      minLikeCount: 0 as const,
    };
    const { plan } = assignSamplePlan(store, { steps: [step1, step2], profile });
    store.tasks.claimPlanForProfile(profile.id, profile.account.id);
    store.tasks.stopPlanDirect(plan.id, 'USER_STOP');

    const steps = store.tasks.steps(plan.id);
    assert.equal(steps[0]?.status, 'FAILED');
    assert.equal(steps[1]?.status, 'SKIPPED');
    assert.equal(steps[1]?.outcome?.kind, 'SKIPPED');
    assert.equal(steps[1]?.outcome?.reason, 'USER_STOP');
  }));

test('BUG-P2-01b: stopProfile/stopActiveProfile/closeProfile tighten stop waits to 3-3.5s', async () => {
  const workboard = new Workboard();
  const profileId = randomUUID();
  let waitTimeoutPassed: number | undefined;
  let releaseSoldier = () => {};
  const soldierRunning = workboard.runSoldier(
    { carrierId: profileId, carrierKind: 'browser', moduleId: 'active-accounts' },
    () =>
      new Promise<void>((resolve) => {
        releaseSoldier = resolve;
      }),
  );

  const runtime = new ActiveAccountRuntime({
    workboard,
    store: {
      tasks: {
        plansForProfile: async () => [{ id: 'plan-1' }],
        stopPlanDirect: async () => {
          await new Promise((r) => setTimeout(r, 40));
          releaseSoldier();
          return {} as never;
        },
      },
    } as unknown as WorkspaceStorePort,
    core: { peers: new Map() } as unknown as Core,
    kernel: {} as KernelBridge,
    profileSource: { profiles: async () => [], records: async () => [], stop: async () => {} },
    dataDirectory: '',
    uploadCacheRoot: '',
  });
  const t0 = Date.now();
  await runtime.stopProfile(profileId);
  await soldierRunning;
  assert.ok(Date.now() - t0 < 2_500);

  const taskSvc = new TaskService({ hasProfilePlanInStates: async () => false } as never, () => ({
    available: () => true,
    capabilities: async () => ({ types: [], combinations: [] }),
    start: async () => [],
    stopProfile: async () => {},
    commandPlan: async () => ({}) as never,
    waitUntilProfileIdle: async (_id, ms) => {
      waitTimeoutPassed = ms;
    },
  }));
  await taskSvc.stopActiveProfile(profileId);
  assert.equal(waitTimeoutPassed, 3_500);

  const sleepDurations: number[] = [];
  const lifecycle = new BrowserLifecycleManager({
    core: {
      peers: new Map([[profileId, { online: true, browserWindowCount: 1 } as Peer]]),
    } as unknown as Core,
    store: { profileSummary: async () => null } as never,
    browserLabels: {
      binding: () => undefined,
      name: () => null,
    } as never,
    sleep: async (ms) => {
      sleepDurations.push(ms);
    },
    stopActiveTasksForProfile: () => new Promise<void>(() => {}),
  });
  // Verify registered online peer triggers 3_500 prestep timeout when stopActiveTasksForProfile hangs
  const lifecycleWithProfile = new BrowserLifecycleManager({
    core: {
      peers: new Map([[profileId, { online: true, browserWindowCount: 1 } as Peer]]),
      reloadExtension: async () => ({ requested: false, reason: 'SKIP' }),
    } as unknown as Core,
    store: { profileSummary: async () => ({ profileId }) } as never,
    browserLabels: {
      binding: () => undefined,
      name: () => null,
    } as never,
    sleep: async (ms) => {
      sleepDurations.push(ms);
    },
    stopActiveTasksForProfile: () => new Promise<void>(() => {}),
  });
  await lifecycleWithProfile.closeProfile(profileId, { stopTasksFirst: true });
  assert.equal(sleepDurations.includes(3_500), true);
  assert.equal(sleepDurations.includes(6_000), false);
  void lifecycle;
});

test('BUG-P2-01c: FilesystemPosterMediaPreparer generates crisp video badge fallback for ready videos without ffmpeg, never for missing files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-thumb-'));
  const prevFfmpegPath = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = path.join(dir, 'nonexistent-ffmpeg');
  try {
    const preparer = new FilesystemPosterMediaPreparer(dir);
    const missingThumb = await preparer.generateThumbnail(path.join(dir, 'missing.mp4'), 'video');
    assert.equal(missingThumb, null);

    const noneThumb = await preparer.generateThumbnail(path.join(dir, 'missing.mp4'), 'none');
    assert.equal(noneThumb, null);

    const videoPath = path.join(dir, 'sample.mp4');
    await writeFile(
      videoPath,
      Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]),
    );
    const videoThumb = await preparer.generateThumbnail(videoPath, 'video');
    assert.ok(videoThumb);
    assert.match(videoThumb, /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/i);
  } finally {
    if (prevFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = prevFfmpegPath;
    await rm(dir, { recursive: true, force: true });
  }
});
