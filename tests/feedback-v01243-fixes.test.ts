import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  isRecoverableBrowseFault,
  isSessionBreakingBrowseFault,
} from '../src/shared/browse-execution.js';
import { taskAdmissionIssue } from '../src/shared/task-admission-issues.js';
import { taskReasonDescription } from '../src/shared/task-issues.js';
import { bridgeCapabilities, bridgeHelloCapabilities } from '../src/shared/bridge-capabilities.js';
import { KernelRequest } from '../src/shared/kernel-wire.js';
import type { KernelJsonObject } from '../src/shared/kernel-protocol.js';
import { navigateFacebookBoundPage } from '../src/infrastructure/facebook-bound-navigation.js';
import {
  awaitFacebookTaskDocument,
  FACEBOOK_TASK_DOCUMENT_READ,
} from '../src/infrastructure/facebook-task-document-ready.js';
import { FacebookGroupSessionHelper } from '../src/infrastructure/facebook-group-session.js';
import { KernelJournal } from '../src/application/kernel-journal.js';
import { ChromeKernelBackend } from '../extension/kernel-backend.js';
import { devDiag } from '../src/shared/dev-diagnostics.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { createDiagnosticSnapshotBuilder } from '../src/infrastructure/diagnostic-package.js';
import {
  materializeActiveSteps,
  resolveActivePlan,
} from '../src/application/bluestacks/bs-extra-modules.js';
import type { BluestacksServiceContext } from '../src/application/bluestacks/bs-types.js';
import { handleTaskRoutes, type TaskRouteContext } from '../src/http/routes/task-routes.js';
import type { TabProof } from '../src/shared/kernel-state.js';

function makeProof(profileId = randomUUID(), tabId = 42, targetId = 'target-1'): TabProof {
  return {
    ownershipId: randomUUID(),
    profileId,
    browserSessionEpoch: randomUUID(),
    tabId,
    targetId,
  };
}

test('Fix #1 & #5: transient navigation/kernel faults are recoverable & session-breaking while download and user-cancel are never recoverable', async () => {
  for (const code of [
    'FACEBOOK_NAVIGATION_REJECTED',
    'FACEBOOK_NAVIGATION_DOCUMENT_TIMEOUT',
    'FACEBOOK_NAVIGATION_DOCUMENT_INVALID',
    'FACEBOOK_TASK_DOCUMENT_ERROR_PAGE',
    'FACEBOOK_TASK_DOCUMENT_CONTEXT_CHANGED',
    'KERNEL_READ_FENCED',
    'KERNEL_SCOPE_CHANGED',
    'KERNEL_BOUND_INPUT_INACTIVE',
    'KERNEL_NOT_ATTACHED',
    'KERNEL_SESSION_PARKING',
    'KERNEL_SESSION_NOT_CURRENT',
    'KERNEL_PRESENTATION_REVOKED',
  ]) {
    assert.equal(isRecoverableBrowseFault(code), true, `expected recoverable: ${code}`);
    assert.equal(isSessionBreakingBrowseFault(code), true, `expected sessionBreaking: ${code}`);
  }
  for (const targetCode of [
    'FACEBOOK_BROWSE_LIKE_TARGET_CHANGED',
    'FACEBOOK_BROWSE_DIALOG_DISMISS_TARGET_CHANGED',
    'FACEBOOK_BROWSE_DOCUMENT_OR_TARGET_CHANGED',
  ]) {
    assert.equal(isRecoverableBrowseFault(targetCode), true, `expected recoverable: ${targetCode}`);
  }
  assert.equal(isRecoverableBrowseFault('FACEBOOK_NAVIGATION_DOWNLOAD_REJECTED'), false);
  assert.equal(isRecoverableBrowseFault('KERNEL_DEBUGGER_CANCELED_BY_USER'), false);
  assert.equal(
    FacebookGroupSessionHelper.isTransientPrepareError(
      new Error('FACEBOOK_TASK_DOCUMENT_ERROR_PAGE'),
    ),
    true,
  );
  assert.equal(
    FacebookGroupSessionHelper.isTransientPrepareError(new Error('KERNEL_READ_FENCED')),
    true,
  );

  // User-facing Chinese copy & admission issue mapping
  assert.equal(taskAdmissionIssue('FACEBOOK_TASK_DOCUMENT_ERROR_PAGE')?.disposition, 'pause');
  assert.ok(taskReasonDescription('FACEBOOK_NAVIGATION_REJECTED')?.summary.includes('跳转'));
  assert.ok(
    taskReasonDescription('FACEBOOK_NAVIGATION_DOWNLOAD_REJECTED')?.summary.includes('下载'),
  );
  assert.ok(taskReasonDescription('FACEBOOK_TASK_DOCUMENT_ERROR_PAGE')?.summary.includes('错误页'));
  assert.ok(taskReasonDescription('KERNEL_READ_FENCED')?.summary.includes('读取'));

  // navigateFacebookBoundPage distinguishes errorText vs isDownload and records detail in devDiag
  const recorded: Array<{ event: string; reason?: string; data?: Record<string, unknown> }> = [];
  devDiag.setSink((entry) =>
    recorded.push({ event: entry.event, reason: entry.reason, data: entry.data }),
  );
  try {
    await assert.rejects(
      navigateFacebookBoundPage(
        {
          send: async (): Promise<KernelJsonObject> => ({
            frameId: 'main',
            errorText: 'net::ERR_TIMED_OUT',
          }),
        },
        7,
        'https://www.facebook.com/reels/',
        'https://www.facebook.com/',
        () => {},
        { wait: async () => {} },
      ),
      /^Error: FACEBOOK_NAVIGATION_REJECTED$/,
    );
    await assert.rejects(
      navigateFacebookBoundPage(
        {
          send: async (): Promise<KernelJsonObject> => ({
            frameId: 'main',
            isDownload: true,
          }),
        },
        7,
        'https://www.facebook.com/reels/',
        'https://www.facebook.com/',
        () => {},
        { wait: async () => {} },
      ),
      /^Error: FACEBOOK_NAVIGATION_DOWNLOAD_REJECTED$/,
    );
  } finally {
    devDiag.setSink(null);
  }
  const detail = recorded.find((e) => e.event === 'FACEBOOK_NAVIGATION_REJECTED_DETAIL');
  assert.ok(detail);
  assert.equal(detail.data?.errorText, 'net::ERR_TIMED_OUT');
});

test('Fix #2: awaitFacebookTaskDocument classifies chrome-error:// as ERROR_PAGE and only sends Page.stopLoading on stuck retained browse tabs', async () => {
  // 1. chrome-error:// => FACEBOOK_TASK_DOCUMENT_ERROR_PAGE
  await assert.rejects(
    awaitFacebookTaskDocument(
      {
        send: async () => ({
          result: {
            value: JSON.stringify({ url: 'chrome-error://chromewebdata/', ready: 'complete' }),
          },
        }),
      },
      42,
      () => {},
      { retainedPage: true, wait: async () => {} },
    ),
    /^Error: FACEBOOK_TASK_DOCUMENT_ERROR_PAGE$/,
  );

  // 2. Genuine non-FB URL or /messages still => FACEBOOK_TASK_DOCUMENT_SCOPE_CHANGED
  await assert.rejects(
    awaitFacebookTaskDocument(
      {
        send: async () => ({
          result: {
            value: JSON.stringify({
              url: 'https://www.facebook.com/messages/t/123',
              ready: 'complete',
            }),
          },
        }),
      },
      42,
      () => {},
      { retainedPage: true, wait: async () => {} },
    ),
    /^Error: FACEBOOK_TASK_DOCUMENT_SCOPE_CHANGED$/,
  );

  // 3. allowStuckLoadingStop=true on retainedPage sends Page.stopLoading once at 15s and succeeds if page becomes interactive
  let clock = 0;
  let stopSent = 0;
  await awaitFacebookTaskDocument(
    {
      send: async (_target, method, params): Promise<KernelJsonObject> => {
        if (method === 'Page.stopLoading') {
          stopSent++;
          return {};
        }
        assert.equal(method, 'Runtime.evaluate');
        assert.equal(params.expression, FACEBOOK_TASK_DOCUMENT_READ);
        return {
          result: {
            value: JSON.stringify({
              url: 'https://www.facebook.com/reels/',
              ready: stopSent > 0 ? 'interactive' : 'loading',
            }),
          },
        };
      },
    },
    42,
    () => {},
    {
      retainedPage: true,
      allowStuckLoadingStop: true,
      now: () => clock,
      wait: async () => {
        clock += 1000;
      },
    },
  );
  assert.equal(stopSent, 1);
  assert.equal(clock, 16_000);

  // 4. If still loading 5s after Page.stopLoading, fails fast at 20s with FACEBOOK_TASK_DOCUMENT_TIMEOUT
  clock = 0;
  stopSent = 0;
  await assert.rejects(
    awaitFacebookTaskDocument(
      {
        send: async (_target, method): Promise<KernelJsonObject> => {
          if (method === 'Page.stopLoading') {
            stopSent++;
            return {};
          }
          return {
            result: {
              value: JSON.stringify({ url: 'https://www.facebook.com/reels/', ready: 'loading' }),
            },
          };
        },
      },
      42,
      () => {},
      {
        retainedPage: true,
        allowStuckLoadingStop: true,
        now: () => clock,
        wait: async () => {
          clock += 1000;
        },
      },
    ),
    /^Error: FACEBOOK_TASK_DOCUMENT_TIMEOUT$/,
  );
  assert.equal(stopSent, 1);
  assert.equal(clock, 20_000);
});

test('Fix #3 & #7: extension recoverTabToHome resets in-place without closing tabs/focusing, rebinds swapped targetId, and maintainPresentation deduplicates properly', async () => {
  // Capability & wire schema check
  assert.equal(bridgeCapabilities.includes('kernel-tab-reset-v1'), true);
  assert.equal(
    bridgeHelloCapabilities(['kernel-tab-reset-v1']).includes('kernel-tab-reset-v1'),
    true,
  );
  assert.equal(bridgeHelloCapabilities([]).includes('kernel-tab-reset-v1'), false);
  const sampleProof = makeProof();
  assert.ok(
    KernelRequest.parse({
      type: 'KERNEL_REQUEST',
      requestId: randomUUID(),
      sequence: 1,
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      kind: 'recoverTabToHome',
      proof: sampleProof,
    }),
  );

  // Mock chrome APIs for ChromeKernelBackend
  const g = globalThis as unknown as Record<string, unknown>;
  const savedChrome = g.chrome;
  const profileId = randomUUID();
  const epoch = randomUUID();
  let storageData: Record<string, unknown> = {};
  let currentTargetId = 'target-old';
  let currentUrl = 'https://www.facebook.com/reels/';
  let tabUpdateCalls: Array<{ tabId: number; props: Record<string, unknown> }> = [];
  let tabRemoveCalls: number[] = [];
  let windowUpdateCalls: unknown[] = [];
  let debuggerDetachCalls: number[] = [];

  g.chrome = {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: storageData[k] }),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(storageData, obj);
        },
      },
    },
    tabs: {
      get: async (tabId: number) => ({
        id: tabId,
        windowId: 100,
        groupId: 7,
        active: true,
        url: currentUrl,
      }),
      update: async (tabId: number, props: Record<string, unknown>) => {
        tabUpdateCalls.push({ tabId, props });
        if (typeof props.url === 'string') currentUrl = props.url;
        return { id: tabId, windowId: 100, groupId: 7, active: true, url: currentUrl };
      },
      remove: async (tabId: number) => {
        tabRemoveCalls.push(tabId);
      },
      query: async () => [{ id: 55, windowId: 100, groupId: 7, active: true, url: currentUrl }],
    },
    windows: {
      get: async (id: number) => ({ id, focused: false, state: 'normal' }),
      update: async (...args: unknown[]) => {
        windowUpdateCalls.push(args);
        return { id: 100, focused: false, state: 'normal' };
      },
    },
    tabGroups: {
      query: async () => [{ id: 7, windowId: 100, title: '浏览器工作台', color: 'grey' }],
      update: async () => ({}),
    },
    debugger: {
      getTargets: async () => [{ id: currentTargetId, tabId: 55, type: 'page', url: currentUrl }],
      attach: async () => {},
      detach: async ({ tabId }: { tabId: number }) => {
        debuggerDetachCalls.push(tabId);
      },
      sendCommand: async (_target: unknown, method: string) => {
        if (method === 'Target.getTargetInfo') {
          return {
            targetInfo: {
              targetId: currentTargetId,
              type: 'page',
              title: 'Facebook',
              url: currentUrl,
              attached: true,
            },
          };
        }
        if (method === 'Runtime.evaluate') {
          return { result: { value: 'visible' } };
        }
        return {};
      },
    },
  };

  try {
    let persisted: unknown = undefined;
    const journal = new KernelJournal({
      read: async () => persisted,
      write: async (state) => {
        persisted = structuredClone(state);
      },
    });
    await journal.initialize(profileId, epoch);
    const proof: TabProof = {
      ownershipId: randomUUID(),
      profileId,
      browserSessionEpoch: epoch,
      tabId: 55,
      targetId: currentTargetId,
    };
    await journal.prepareTab(proof.ownershipId, currentUrl);
    await journal.confirmTab(proof);

    let fakeNow = 10_000;
    const backend = new ChromeKernelBackend(
      journal,
      () => true,
      'facebook-task',
      () => true,
      () => undefined,
      () => fakeNow,
    );
    await backend.adopt(proof);
    await backend.attach(55);

    // Part A: recoverTabToHome with same targetId — silent, in-place, never removes tab or focuses window
    const res1 = await backend.recoverTabToHome(proof);
    assert.equal(res1.targetChanged, false);
    assert.deepEqual(res1.proof, proof);
    assert.equal(tabRemoveCalls.length, 0);
    assert.equal(windowUpdateCalls.length, 0);
    assert.deepEqual(tabUpdateCalls, [{ tabId: 55, props: { url: 'https://www.facebook.com/' } }]);
    assert.deepEqual(debuggerDetachCalls, [55]);

    // Part B: recoverTabToHome when Chromium swaps targetId -> journal rebinds cleanly
    tabUpdateCalls = [];
    (
      g.chrome as { tabs: { update: (id: number, p: Record<string, unknown>) => Promise<unknown> } }
    ).tabs.update = async (tabId: number, props: Record<string, unknown>) => {
      tabUpdateCalls.push({ tabId, props });
      currentTargetId = 'target-new-process';
      if (typeof props.url === 'string') currentUrl = props.url;
      return { id: tabId, windowId: 100, groupId: 7, active: true, url: currentUrl };
    };
    const res2 = await backend.recoverTabToHome(proof);
    assert.equal(res2.targetChanged, true);
    assert.equal(res2.proof.targetId, 'target-new-process');
    assert.equal(res2.proof.tabId, 55);
    assert.notEqual(res2.proof.ownershipId, proof.ownershipId);
    const snapAfter = await journal.snapshot();
    assert.equal(snapAfter.tabs.find((t) => t.ownershipId === proof.ownershipId)?.state, 'CLOSED');
    assert.equal(
      snapAfter.tabs.find((t) => t.ownershipId === res2.proof.ownershipId)?.state,
      'READY',
    );

    // Part C: maintainPresentation dedup & probePending accuracy (#7)
    await backend.attach(55);
    const reports: Array<Record<string, unknown>> = [];
    backend.setPresentationObserver((_p, state) => reports.push(state));
    await backend.armTaskPresentation(res2.proof);
    reports.length = 0;

    // Tick 1: first CHECK emits once with probePending: false (previous probe was not stuck)
    fakeNow = 20_000;
    backend.maintainPresentation();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.phase, 'CHECK');
    assert.equal(reports[0]?.probePending, false);

    // Tick 2: visibility became 'visible' after probe 1 finished -> emits state transition once (visibility: 'visible')
    fakeNow = 30_000;
    backend.maintainPresentation();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(reports.length, 2);
    assert.equal(reports[1]?.visibility, 'visible');
    assert.equal(reports[1]?.probePending, false);

    // Tick 3 & 4: nothing semantically changed (only visibilityAt timestamp updated) -> ZERO redundant reports!
    fakeNow = 40_000;
    backend.maintainPresentation();
    await new Promise((r) => setTimeout(r, 30));
    fakeNow = 50_000;
    backend.maintainPresentation();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(reports.length, 2);

    // Part D: recoverTabToHome MUST reject if any pending operation exists in journal
    tabUpdateCalls = [];
    await journal.begin({
      profileId,
      accountId: '61500000000001',
      connectionEpoch: epoch,
      leaseId: randomUUID(),
      generation: 0,
      operationId: randomUUID(),
      jobId: randomUUID(),
      stepId: randomUUID(),
      actionDigest: 'a'.repeat(64),
    });
    await assert.rejects(
      backend.recoverTabToHome(res2.proof),
      /^Error: TAB_RESET_OPERATION_PENDING$/,
    );
    assert.equal(tabUpdateCalls.length, 0);
  } finally {
    g.chrome = savedChrome;
  }
});

test('Fix #6: /api/workspace/tasks/start only launches up to maxConcurrentProfiles offline browsers upfront and defers launchable overflow to QUEUED', async () => {
  const ids = Array.from({ length: 5 }, () => randomUUID());
  const [p1, p2, p3, p4, p5] = ids as [string, string, string, string, string];
  const launchedCalls: string[][] = [];
  const onlineSet = new Set<string>();
  const startedProfileIds: string[] = [];
  let statusCode = 0;
  let responseBody: unknown = null;

  const ctx = {
    req: {
      method: 'POST',
      url: '/api/workspace/tasks/start',
      headers: { 'x-workbench-task-contract': '2' },
    } as unknown as IncomingMessage,
    res: {
      destroyed: false,
    } as unknown as ServerResponse,
    route: '/api/workspace/tasks/start',
    input: {
      requestId: randomUUID(),
      combinationId: randomUUID(),
      version: 1,
      profileIds: ids,
    },
    json: (_res: ServerResponse, status: number, body: unknown) => {
      statusCode = status;
      responseBody = body;
    },
    service: {
      snapshot: async () => ({ combinations: [] }),
      requireProfiles: async () => {},
    },
    tasks: {
      plansForBatch: async () => [],
      releaseErroredPausedPlans: async () => {},
      hasProfilePlanInStates: async () => false,
      settings: async () => ({ maxConcurrentProfiles: 2 }),
      runtimeOverview: async () => ({ plans: [], currentSteps: [] }),
      start: async (val: { profileIds: string[] }) => {
        startedProfileIds.push(...val.profileIds);
        return { plans: [] };
      },
    },
    isProfileOnline: (id: string) => onlineSet.has(id),
    profileLifecycle: {
      isLaunching: () => false,
      ensureProfilesOnline: async (batch: readonly string[]) => {
        launchedCalls.push([...batch]);
        for (const id of batch) onlineSet.add(id);
        return {
          requestedIds: [...batch],
          readyIds: [...batch],
          launchedIds: [...batch],
          failed: [],
          items: [],
        };
      },
      getStatus: async (batch: readonly string[]) =>
        batch.map((profileId) => ({
          profileId,
          browserName: profileId.slice(0, 8),
          action: 'status' as const,
          ok: true,
          online: false,
          phase: 'OFFLINE',
          synced: false,
          // p5 is unlaunchable (missing binding/exe) -> must NOT be admitted!
          launchable: profileId !== p5,
          elapsedMs: 1,
        })),
      launchProfile: async () => {
        throw Error('unexpected');
      },
      closeProfile: async () => {
        throw Error('unexpected');
      },
      restartProfile: async () => {
        throw Error('unexpected');
      },
    },
  } as unknown as TaskRouteContext;

  const handled = await handleTaskRoutes(ctx);
  assert.equal(handled, true);
  assert.equal(statusCode, 200);
  assert.ok(responseBody);
  // Non-blocking start never blocks on ensureProfilesOnline upfront; background Workboard launches lazily.
  assert.deepEqual(launchedCalls, []);
  // All launchable profiles (p1..p4) admitted; unlaunchable p5 rejected cleanly!
  assert.deepEqual(startedProfileIds, [p1, p2, p3, p4]);
});

function readZipJsonEntry(zip: Buffer, targetName: string): unknown {
  let off = 0;
  while (off + 30 <= zip.length && zip.readUInt32LE(off) === 0x04034b50) {
    const method = zip.readUInt16LE(off + 8);
    const compSize = zip.readUInt32LE(off + 18);
    const nameLen = zip.readUInt16LE(off + 26);
    const extraLen = zip.readUInt16LE(off + 28);
    const name = zip.subarray(off + 30, off + 30 + nameLen).toString('utf8');
    const dataStart = off + 30 + nameLen + extraLen;
    const raw = zip.subarray(dataStart, dataStart + compSize);
    if (name === targetName) {
      const text = (method === 8 ? inflateRawSync(raw) : raw).toString('utf8');
      return JSON.parse(text) as unknown;
    }
    off = dataStart + compSize;
  }
  throw Error(`zip entry missing: ${targetName}`);
}

test('v0.1.267: diagnostic snapshot includes sanitized BlueStacks + postBumpRecords, and BS resolveActivePlan materializes per-instance shuffled steps', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-diag-v267-'));
  try {
    const buildDiag = createDiagnosticSnapshotBuilder({
      dataDir: dir,
      softwareVersion: '0.1.267',
      extensionVersion: '0.3.92',
      workspaceService: {
        snapshot: async () => ({ version: 1, groups: [], profiles: [], combinations: [] }),
      } as never,
      taskService: {
        runtimeOverview: async () => ({
          plans: [],
          currentSteps: [],
          settings: { maxConcurrentProfiles: 5 },
        }),
      } as never,
      groupInviterService: {
        state: async () => ({ running: false, runId: null, statusText: '就绪', profileCounts: {} }),
        logs: async () => [],
      } as never,
      getGroupBumperService: () => undefined,
      groupPosterService: {
        state: async () => ({ running: false, statusText: '就绪', profileCounts: {} }),
        logs: async () => [],
      } as never,
      getBluestacksService: () =>
        ({
          state: async () => ({
            running: true,
            pageBumperRunning: false,
            activeRunning: false,
            posterRunning: false,
            inviterRunning: false,
            statusText: '蓝蝶运行中',
            pageBumperStatusText: '',
            activeStatusText: '',
            posterStatusText: '',
            inviterStatusText: '',
            bumperSettings: {},
            pageBumperSettings: {},
            riskLimitSettings: {},
            dailyUsage: { dateYmd: '2026-11-26', totalActions: 0 },
            total: 42,
            pageTotal: 3,
            profileCounts: {},
            pageBumperProfileCounts: {},
            activeProfileCounts: {},
            posterProfileCounts: {},
            inviterProfileCounts: {},
            instances: [
              {
                id: 'bs-1',
                instanceKey: 'Pie64_1',
                displayName: 'p023',
                alias: null,
                online: true,
                fbWidth: 720,
                fbHeight: 1280,
                fbLiteInstalled: true,
                accountState: 'logged-in',
                accountId: '10001',
                accountName: 'Test BS',
                avatar: 'data:image/png;base64,SHOULD_BE_STRIPPED',
                identityType: 'personal',
                lastStatus: '运行正常',
              },
            ],
          }),
        }) as never,
      postBumpRecords: {
        list: () => ({
          records: [{ id: 'rec-1', recordType: 'bump', status: 'success' }],
          total: 1,
          hasMore: false,
          dailyStats: [],
          statusCounts: { total: 1, confirmed: 1, pending: 0, failed: 0 },
        }),
      } as never,
      tasksRepository: {
        list: async () => [],
        steps: async () => [],
        operations: async () => [],
        events: async () => [],
      } as never,
      core: { peers: new Map() } as never,
      getMainKernel: () => undefined,
      controllerLoopDelay: { count: 0, max: 0, percentile: () => 0 },
      devDiagFlush: async () => {},
      devDiagFilePath: path.join(dir, 'nonexistent-diag.jsonl'),
    });

    const pkg = await buildDiag({ note: 'bs diag test', reveal: false });
    const snap = readZipJsonEntry(await readFile(pkg.filePath), '1-snapshot.json') as {
      bluestacks: { total: number; instances: Array<Record<string, unknown>> };
      recentPostBumpRecords: { total: number; records: Array<{ id: string }> };
    };
    assert.equal(snap.bluestacks.total, 42);
    assert.equal(snap.bluestacks.instances.length, 1);
    assert.equal('avatar' in (snap.bluestacks.instances[0] ?? {}), false);
    assert.equal(snap.recentPostBumpRecords.total, 1);
    assert.equal(snap.recentPostBumpRecords.records[0]?.id, 'rec-1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const comboId = randomUUID();
  const plan = await resolveActivePlan(
    {
      extra: {
        listCombinations: async () => [
          {
            id: comboId,
            version: 1,
            revision: 1,
            updatedAt: 1000,
            saved: {
              name: '随机蓝蝶',
              note: '',
              randomOrder: true,
              loop: { mode: 'finite', rounds: 1 },
              steps: [
                {
                  id: randomUUID(),
                  type: 'feed',
                  durationMinutes: 3,
                  maxLikes: 2,
                  minLikeCount: 0,
                },
                {
                  id: randomUUID(),
                  type: 'video',
                  durationMinutes: 4,
                  maxLikes: 1,
                  minLikeCount: 0,
                },
                {
                  id: randomUUID(),
                  type: 'marketplace',
                  durationMinutes: 5,
                  keyword: '',
                  maxLikes: 0,
                  minLikeCount: 0,
                },
                {
                  id: randomUUID(),
                  type: 'friends',
                  acceptMode: 'count',
                  maxAccepts: 2,
                  durationMinutes: 5,
                  maxLikes: 0,
                  minLikeCount: 0,
                },
              ],
            },
            draft: null,
          },
        ],
      },
    } as unknown as BluestacksServiceContext,
    { combinationId: comboId },
  );
  assert.equal(plan.randomOrder, true);
  assert.equal(plan.baseSteps.length, 4);
  const runs = Array.from({ length: 12 }, () =>
    materializeActiveSteps(plan)
      .map((s) => s.type)
      .join(','),
  );
  assert.ok(
    new Set(runs).size > 1,
    `expected distinct random step orders across runs, got ${runs[0]}`,
  );
});
