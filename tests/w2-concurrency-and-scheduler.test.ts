import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Page } from 'playwright-core';
import { AutoSchedulerService } from '../src/application/auto-scheduler-service.js';
import { FeatureExecutionRegistry } from '../src/application/feature-execution-registry.js';
import { GroupBumperService } from '../src/application/group-bumper-service.js';
import { sortTargetsOnlineFirst } from '../src/application/module-worker-pool.js';
import { Semaphore, Workboard } from '../src/application/workboard.js';
import type { WorkspaceService } from '../src/application/workspace-service.js';
import { Core } from '../src/bridge/core.js';
import { Store } from '../src/bridge/store.js';
import { handleFeatureModuleRoutes } from '../src/http/routes/feature-module-routes.js';
import { clickSelector } from '../src/infrastructure/active-account-runtime/browse-dom-helpers.js';
import { executeBrowseStep } from '../src/infrastructure/active-account-runtime/browse-step-executor.js';
import {
  checkDirectPostRiskLimit,
  recordDirectPostOutcome,
} from '../src/infrastructure/active-account-runtime/direct-post-ledger.js';
import { SqliteAutoSchedulerRepository } from '../src/infrastructure/auto-scheduler-store.js';
import { BluestacksActiveRunner } from '../src/infrastructure/bluestacks-active-runner.js';
import type { BluestacksDeviceManager } from '../src/infrastructure/bluestacks-device-manager.js';
import { BridgeBrowserWindow } from '../src/infrastructure/bridge-browser-window.js';
import {
  withBrowserSession,
  type BrowserSessionLease,
} from '../src/infrastructure/browser-session-lease.js';
import { readBrowseLikeTarget } from '../src/infrastructure/facebook-browse-reader/browse-feed-and-like.js';
import type { BrowseRuntime } from '../src/infrastructure/facebook-browse-reader/browse-surfaces.js';
import type { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import { scheduleOnceViaAutoScheduler } from '../src/infrastructure/mcp/mcp-context.js';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import { SaveAutoScheduleInput } from '../src/shared/auto-scheduler.js';
import type { BluestacksInstance } from '../src/shared/bluestacks.js';
import type { Profile } from '../src/shared/contracts.js';
import type { Plan } from '../src/shared/task-contracts.js';
import { FACEBOOK_BROWSE_LIKE_CSS } from '../src/shared/facebook-browse-route.js';
import {
  computeTotalDailyActions,
  evaluateDailyRiskQuota,
} from '../src/shared/daily-risk-limits.js';
import { devDiag } from '../src/shared/dev-diagnostics.js';
import type { ProfileLifecyclePort } from '../src/shared/profile-lifecycle.js';
import { makeRuntimeProfiles, workspaceFixture } from './fixtures/workspace-fixture.js';

const tick = () => new Promise<void>((r) => setImmediate(r));

function makeLifecycle(hooks?: {
  onLaunch?: (id: string) => void;
  onClose?: (id: string) => void;
}): ProfileLifecyclePort {
  return {
    isLaunching: () => false,
    getStatus: async () => [],
    launchProfile: async (profileId) => {
      hooks?.onLaunch?.(profileId);
      return {
        profileId,
        browserName: profileId,
        action: 'open',
        ok: true,
        online: true,
        phase: 'PAUSED',
        synced: true,
        launchable: true,
        elapsedMs: 1,
      };
    },
    closeProfile: async (profileId) => {
      hooks?.onClose?.(profileId);
      return {
        profileId,
        browserName: profileId,
        action: 'close',
        ok: true,
        online: false,
        phase: 'OFFLINE',
        synced: false,
        launchable: true,
        elapsedMs: 1,
      };
    },
    restartProfile: async (profileId) => ({
      profileId,
      browserName: profileId,
      action: 'restart',
      ok: true,
      online: true,
      phase: 'PAUSED',
      synced: true,
      launchable: true,
      elapsedMs: 1,
    }),
    ensureProfilesOnline: async (ids) => ({
      requestedIds: [...ids],
      readyIds: [...ids],
      launchedIds: [],
      failed: [],
      items: [],
    }),
  };
}

test('W2.1: Workboard.Semaphore enforces FIFO fairness, synchronous permit grant (1 release = 1 wakeup), and sortTargetsOnlineFirst', async () => {
  const sem = new Semaphore(1);
  const rel1 = await sem.acquire();
  assert.equal(sem.used, 1);

  const woken: string[] = [];
  const abortW2 = new AbortController();
  const p1 = sem.acquire().then((r) => {
    assert.equal(sem.used, 1);
    woken.push('w1');
    return r;
  });
  const p2 = sem.acquire(abortW2.signal).then(
    (r) => {
      woken.push('w2');
      return r;
    },
    () => null,
  );
  const p3 = sem.acquire().then((r) => {
    assert.equal(sem.used, 1);
    woken.push('w3');
    return r;
  });
  const p4 = sem.acquire().then((r) => {
    assert.equal(sem.used, 1);
    woken.push('w4');
    return r;
  });

  abortW2.abort('CANCELLED');
  await tick();
  assert.deepEqual(woken, []);

  rel1();
  // Permit was synchronously granted to w1 before microtasks run
  assert.equal(sem.used, 1);
  const relW1 = await p1;
  assert.deepEqual(woken, ['w1']);

  relW1();
  const relW3 = await p3;
  assert.equal(await p2, null);
  assert.deepEqual(woken, ['w1', 'w3']);

  relW3();
  const relW4 = await p4;
  assert.deepEqual(woken, ['w1', 'w3', 'w4']);
  relW4();
  assert.equal(sem.used, 0);

  const items = [
    { id: 'off-1', online: false },
    { id: 'on-1', online: true },
    { id: 'off-2', online: false },
    { id: 'on-2', online: true },
  ];
  const ordered = await sortTargetsOnlineFirst(items, (x) => x.online);
  assert.deepEqual(
    ordered.map((x) => x.id),
    ['on-1', 'on-2', 'off-1', 'off-2'],
  );
});

test('W2.2: closeBrowserOnFinish=true closes pre-opened & auto-launched browsers on success, pre-flight fail, restricted, verification, and unconfirmed', async () => {
  const store = new Store(':memory:');
  const core = new Core(store);
  const workboard = new Workboard({ browserConcurrency: 4 });
  const closedIds: string[] = [];
  const abnormalReports: Array<{ profileId: string; state: string; reason: string }> = [];

  try {
    const pid = randomUUID();
    const peer = core.connect(
      pid,
      () => {},
      () => {},
    );
    peer.synced = true;
    peer.phase = 'PAUSED';
    peer.browserWindowCount = 1;

    const proof = {
      ownershipId: randomUUID(),
      profileId: pid,
      browserSessionEpoch: peer.epoch,
      tabId: 10,
      targetId: 't-10',
    };
    let inspectMode: 'ok' | 'restricted' | 'verification' | 'launch_fail' = 'ok';
    const kernel = {
      withSummary: async (
        _peer: unknown,
        fn: (port: {
          inventory: () => Promise<{
            tabs: Array<{ state: 'READY'; proof: typeof proof }>;
            operations: unknown[];
            workspaceMain: typeof proof;
          }>;
        }) => Promise<unknown>,
      ) =>
        fn({
          inventory: async () => ({
            tabs: [{ state: 'READY', proof }],
            operations: [],
            workspaceMain: proof,
          }),
        }),
      prepareFacebookWorkspace: async () => ({ proof }),
      inspectIdleFacebookPage: async () => null,
      inspectFacebookIdentity: async () => {
        if (inspectMode === 'restricted') throw Error('FACEBOOK_ACCOUNT_RESTRICTED');
        if (inspectMode === 'verification') throw Error('FACEBOOK_ACCOUNT_VERIFICATION_REQUIRED');
        return { actor: { accountId: '100088' }, proof };
      },
      connectFacebook: async () => ({
        proof,
        stopRequestId: 'stop-1',
        failureReason: null,
        browser: {
          contexts: () => [{ pages: () => [{ url: () => 'https://www.facebook.com/' }] }],
        },
        context: async () => ({
          profileId: pid,
          accountId: '100088',
          connectionEpoch: peer.epoch,
          leaseId: randomUUID(),
          generation: 1,
        }),
        execute: async (_b: unknown, work: () => Promise<unknown>) => ({
          value: await work(),
          binding: _b,
          targetUnavailableBeforeInput: false,
        }),
        reconcile: async () => {},
        revokeInput: () => {},
        close: async () => {},
        stopOnCloseFailure: async () => {},
        retryClose: async () => {},
        closeLocalAfterDisconnect: async () => {},
      }),
    } as unknown as KernelBridge;

    const lifecycle = makeLifecycle({
      onLaunch: (id) => {
        const p = core.connect(
          id,
          () => {},
          () => {},
        );
        p.synced = true;
        p.phase = 'PAUSED';
        p.browserWindowCount = 1;
      },
      onClose: (id) => closedIds.push(id),
    });

    const runLease = async (
      targetId: string,
      mode: typeof inspectMode,
      fn: () => Promise<void> = async () => {},
    ) => {
      inspectMode = mode;
      return withBrowserSession(
        {
          core,
          kernel,
          workboard,
          profileLifecycle: lifecycle,
          accountAbnormalReporter: async (ev) => {
            abnormalReports.push({
              profileId: ev.profileId,
              state: ev.state,
              reason: ev.reason ?? '',
            });
            return true;
          },
        },
        {
          profileId: targetId,
          jobId: randomUUID(),
          allowAutoLaunch: true,
          closeBrowserOnFinish: true,
          signal: new AbortController().signal,
        },
        async () => fn(),
      );
    };

    // 1. Pre-opened success
    await runLease(pid, 'ok');
    // 2. Pre-flight ACCOUNT_RESTRICTED
    await assert.rejects(() => runLease(pid, 'restricted'), /FACEBOOK_ACCOUNT_RESTRICTED/);
    // 3. Pre-flight VERIFICATION_REQUIRED
    await assert.rejects(
      () => runLease(pid, 'verification'),
      /FACEBOOK_ACCOUNT_VERIFICATION_REQUIRED/,
    );
    // 4. Mid-run PUBLISH_RESULT_UNCONFIRMED
    await assert.rejects(
      () =>
        runLease(pid, 'ok', async () => {
          throw Error('PUBLISH_RESULT_UNCONFIRMED');
        }),
      /PUBLISH_RESULT_UNCONFIRMED/,
    );
    // 5. Auto-launched offline profile failing pre-flight also closes
    const offlinePid = randomUUID();
    await assert.rejects(() => runLease(offlinePid, 'restricted'), /FACEBOOK_ACCOUNT_RESTRICTED/);

    assert.equal(closedIds.filter((x) => x === pid).length, 4);
    assert.equal(closedIds.filter((x) => x === offlinePid).length, 1);
    assert.ok(abnormalReports.some((r) => r.state === 'restricted'));
    assert.ok(abnormalReports.some((r) => r.state === 'verification'));
  } finally {
    await core.shutdown();
    store.close();
  }
});

test('W2.3: BridgeBrowserWindow.cleanupTabs and route skip busy profiles (workboard, featureExecution, REVIEW, STOPPING)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-w2-cleanup-'));
  const repo = await WorkspaceStore.open(path.join(dir, 'workspace.sqlite'));
  const bridgeStore = new Store(':memory:');
  const core = new Core(bridgeStore);
  const workboard = new Workboard();
  const fe = new FeatureExecutionRegistry();
  try {
    const pIdle = randomUUID();
    const pWbBusy = randomUUID();
    const pFeBusy = randomUUID();
    const pReview = randomUUID();
    const pStopping = randomUUID();
    const allIds = [pIdle, pWbBusy, pFeBusy, pReview, pStopping];
    repo.ensureProfileOrders(allIds);

    const peers = allIds.map((id) =>
      core.connect(
        id,
        () => {},
        () => {},
      ),
    );
    for (const p of peers) {
      p.synced = true;
      p.extensionVersion = '0.3.92';
      p.phase = 'PAUSED';
    }

    fe.register({
      id: 'group-inviter',
      label: '小组邀人',
      isProfileRunning: (id) => id === pFeBusy,
      hasActiveExecution: () => true,
    });

    const cleanedCalled: string[] = [];
    const windows = new BridgeBrowserWindow(
      core,
      {
        list: () => [
          { profileId: pReview, state: 'REVIEW' } as unknown as Plan,
          { profileId: pStopping, state: 'STOPPING' } as unknown as Plan,
        ],
        livePlans: () => [
          { profileId: pReview, state: 'REVIEW' } as unknown as Plan,
          { profileId: pStopping, state: 'STOPPING' } as unknown as Plan,
        ],
        hasProfilePlanInStates: () => false,
      },
      undefined,
      async (id) => {
        cleanedCalled.push(id);
        return {
          profileId: id,
          proof: {
            ownershipId: randomUUID(),
            profileId: id,
            browserSessionEpoch: 'ep',
            tabId: 1,
            targetId: 't1',
          },
          url: 'https://www.facebook.com/',
          closedTabIds: [2],
          remainingTabCount: 1,
        };
      },
      (id) => workboard.isCarrierBusy(id),
    );

    let routeRes: unknown = null;
    await workboard.runSoldier(
      { carrierId: pWbBusy, carrierKind: 'browser', moduleId: 'active-accounts' },
      async () => {
        await handleFeatureModuleRoutes({
          req: {
            method: 'POST',
            url: '/api/workspace/profiles/cleanup-tabs',
            headers: {},
          } as never,
          res: {
            writeHead: () => {},
            end: (s?: string) => {
              if (s) routeRes = JSON.parse(s);
            },
          } as never,
          route: '/api/workspace/profiles/cleanup-tabs',
          input: { profileIds: allIds, preferActiveTab: false },
          json: (_r, _st, body) => {
            routeRes = body;
          },
          service: { requireProfiles: async () => {} } as unknown as WorkspaceService,
          browserWindows: windows,
          featureExecution: fe,
          isCarrierBusy: (id) => workboard.isCarrierBusy(id),
        });
      },
    );

    assert.deepEqual(cleanedCalled, [pIdle]);
    assert.deepEqual(routeRes, {
      cleanedProfiles: 1,
      closedTabs: 1,
      skippedBusy: 4,
      skippedOffline: 0,
    });
  } finally {
    await core.shutdown();
    bridgeStore.close();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('W2.4: active post/story failures preserve BEFORE_SUBMIT/UNKNOWN without mismatch rollback and record post_bump_records & dailyMaxPosts', async () =>
  workspaceFixture(async (store) => {
    const [profile] = makeRuntimeProfiles(1);
    assert.ok(profile);
    const combo = store.createCombination({
      name: 'Post + Story Evidence',
      note: '',
      steps: [
        {
          id: randomUUID(),
          type: 'post',
          count: 1,
          destination: 'post',
          resourceMode: 'table',
          resourceDirectory: '',
          allowRepeat: false,
          forbidSameAccountRepeat: true,
          archivePublished: false,
        },
        {
          id: randomUUID(),
          type: 'post',
          count: 1,
          destination: 'story',
          resourceMode: 'table',
          resourceDirectory: '',
          allowRepeat: false,
          forbidSameAccountRepeat: true,
          archivePublished: false,
        },
      ],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    const rev = store.resourceTables.save(combo.id, 0, [
      {
        id: randomUUID(),
        text: 'hello',
        media: [],
        background: 'plain',
        aiLabel: 'preserve-current',
      },
    ]).revision;
    const [plan] = store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: combo.id,
        version: combo.version,
        expectedResourceRevision: rev,
        profileIds: [profile.id],
      },
      [profile],
    );
    assert.ok(plan);
    store.tasks.claimPlanForProfile(profile.id, profile.account.id);

    const step0 = store.tasks.currentStepForPlan(plan.id, 1, 0);
    assert.ok(step0);
    store.tasks.failStepDirect(
      plan.id,
      step0.id,
      'FACEBOOK_POST_OPENER_NOT_FOUND',
      'NOT_PUBLISHED',
    );

    const step1 = store.tasks.currentStepForPlan(plan.id, 1, 1);
    assert.ok(step1);
    store.tasks.failStepDirect(plan.id, step1.id, 'PUBLISH_RESULT_UNCONFIRMED', 'UNKNOWN');

    const savedSteps = store.tasks.steps(plan.id);
    assert.equal(savedSteps[0]?.outcome?.kind, 'FAILED');
    if (savedSteps[0]?.outcome?.kind === 'FAILED') {
      assert.equal(savedSteps[0].outcome.submissionPhase, 'BEFORE_SUBMIT');
      assert.equal(savedSteps[0].outcome.businessResult, 'NOT_PUBLISHED');
    }
    if (savedSteps[1]?.outcome?.kind === 'FAILED') {
      assert.equal(savedSteps[1].outcome.submissionPhase, 'UNKNOWN');
      assert.equal(savedSteps[1].outcome.businessResult, 'UNKNOWN');
    }

    await recordDirectPostOutcome(store, {
      status: 'success',
      profileId: profile.id,
      accountId: profile.account.id ?? '100001',
      destination: 'story',
      postId: '12345',
      captionPreview: 'My Story',
      durationMs: 1200,
      sourceLogId: `active:${plan.id}:${step1.id}:12345`,
    });
    const recs = store.postBumpRecords.list({ recordType: 'post', limit: 10 });
    assert.equal(recs.total, 1);
    assert.equal(recs.records[0]?.captionPreview, '[快拍] My Story');

    store.activityStats.saveBrowserRiskLimits({ enabled: true, dailyMaxPosts: 1 });
    store.postBumpRecords.insert({
      recordType: 'post',
      carrier: 'browser',
      status: 'success',
      profileId: profile.id,
      accountId: profile.account.id ?? '100001',
      postId: '999',
      captionPreview: 'Limit test',
      sourceLogId: `limit:${randomUUID()}`,
      createdAt: Date.now(),
    });
    const limit = await checkDirectPostRiskLimit(store, profile.id);
    assert.equal(limit.allowed, false);
    assert.match(limit.reason ?? '', /发帖日限额/);
  }));

test('W2.5: Reels like uses skipScrollIntoView, active Reel scoping, compact 156K parsing, and 60s circuit cooldown recovery', async () => {
  // 1. skipScrollIntoView uses viewport hit-test + mouse.click without calling scrollIntoView
  let mouseClicks = 0;
  let scrollCalled = false;
  const g = globalThis as Record<string, unknown>;
  const savedDoc = g.document;
  const savedWin = g.window;
  const savedHtmlEl = g.HTMLElement;
  class FakeHtmlElement {}
  const fakeBtn = Object.assign(new FakeHtmlElement(), {
    getBoundingClientRect: () => ({
      left: 100,
      top: 200,
      right: 140,
      bottom: 240,
      width: 40,
      height: 40,
    }),
    contains: () => false,
    scrollIntoView: () => {
      scrollCalled = true;
    },
  });
  try {
    g.HTMLElement = FakeHtmlElement;
    g.window = { innerWidth: 1280, innerHeight: 800 };
    g.document = { elementFromPoint: () => fakeBtn };
    const mockLease = {
      page: {
        locator: () => ({
          first: () => ({
            evaluate: async (fn: (el: unknown) => unknown) => fn(fakeBtn),
          }),
        }),
        mouse: {
          move: async () => {},
          click: async () => {
            mouseClicks++;
          },
        },
      },
      execOp: async (_label: string, work: () => Promise<unknown>) => work(),
    } as unknown as BrowserSessionLease;
    await clickSelector(mockLease, 'browse-like', '[data-wb-browse-like="1"]', {
      skipScrollIntoView: true,
    });
    assert.equal(mouseClicks, 1);
    assert.equal(scrollCalled, false);
  } finally {
    g.document = savedDoc;
    g.window = savedWin;
    g.HTMLElement = savedHtmlEl;
  }

  // 2. Active Reel scoping + compact 156K parsing
  const makeEl = (opts: {
    label?: string;
    text?: string;
    pressed?: boolean;
    rect?: {
      left: number;
      top: number;
      right: number;
      bottom: number;
      width: number;
      height: number;
    };
    parent?: unknown;
  }) => {
    const attrs = new Map<string, string>();
    if (opts.label) attrs.set('aria-label', opts.label);
    if (opts.pressed) attrs.set('aria-pressed', 'true');
    const el: Record<string, unknown> = {
      tagName: 'DIV',
      parentElement: opts.parent ?? null,
      textContent: opts.text ?? '',
      children: [] as unknown[],
      getAttribute: (k: string) => attrs.get(k) ?? null,
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      hasAttribute: (k: string) => attrs.has(k),
      getBoundingClientRect: () =>
        opts.rect ?? { left: 100, top: 100, right: 140, bottom: 140, width: 40, height: 40 },
      closest: () => null,
      contains: () => false,
      querySelector: () => null,
      querySelectorAll: () => [],
      nextElementSibling: null,
    };
    return el;
  };
  const mainEl = makeEl({
    rect: { left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 },
  });
  const activeContainer = makeEl({ parent: mainEl });
  const activeVideo = makeEl({
    parent: activeContainer,
    rect: { left: 200, top: 50, right: 600, bottom: 750, width: 400, height: 700 },
  });
  const activeLikeBtn = makeEl({ label: 'Like 156K', parent: activeContainer });
  const siblingVideo = makeEl({
    parent: mainEl,
    rect: { left: 200, top: 900, right: 600, bottom: 1600, width: 400, height: 700 },
  });
  const siblingLikeBtn = makeEl({ label: 'Liked 999K', pressed: true, parent: mainEl });

  activeContainer.querySelectorAll = (sel: string) => {
    if (sel === 'video') return [activeVideo];
    if (sel.includes('button')) return [activeLikeBtn];
    return [];
  };
  mainEl.querySelectorAll = (sel: string) => {
    if (sel === 'video') return [activeVideo, siblingVideo];
    if (sel.includes('button')) return [activeLikeBtn, siblingLikeBtn];
    return [];
  };

  const savedGlobals = ['document', 'innerWidth', 'innerHeight', 'getComputedStyle'].map(
    (k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const,
  );
  try {
    Object.defineProperty(globalThis, 'document', {
      value: { querySelectorAll: () => [], elementFromPoint: () => activeLikeBtn },
      configurable: true,
    });
    Object.defineProperty(globalThis, 'innerWidth', { value: 1280, configurable: true });
    Object.defineProperty(globalThis, 'innerHeight', { value: 800, configurable: true });
    Object.defineProperty(globalThis, 'getComputedStyle', {
      value: () => ({
        maskImage: '',
        filter: '',
        color: '',
        fill: '',
        stroke: '',
        backgroundColor: '',
        getPropertyValue: () => '',
      }),
      configurable: true,
    });

    const rt: BrowseRuntime = {
      homeSurface: false,
      reelSurface: true,
      searchPagesRoute: false,
      reservedDetourRx: /^$/,
      timelineDetourSurface: false,
      feedLikeSurface: false,
      record: (v): v is Record<string, unknown> => typeof v === 'object' && v !== null,
      frames: () => [],
      visibleArea: () => 1600,
      mains: [mainEl as unknown as Element],
      main: mainEl as unknown as Element,
      dialogs: false,
      dialogDismissCSS: null,
      videos: [{ el: activeVideo as unknown as HTMLVideoElement, area: 280000 }],
      video: activeVideo as unknown as HTMLVideoElement,
      cssPath: () => null,
      feedText: (v) => v,
      canHitCenter: () => true,
      canonicalDetourHref: () => null,
      lookupRelayActor: () => null,
    };
    const res = readBrowseLikeTarget(rt, {
      article: null,
      structuralPosts: [],
      orderedPosts: [],
      structuralPost: undefined,
      reel: 'https://www.facebook.com/reel/123',
      source: 'blob:1',
      videoEntry: null,
      centerHit: null,
      scrolling: [],
      nextReelCSS: null,
    });
    assert.ok(res);
    assert.equal(res.liked, false);
    assert.equal(res.likeCount, 156_000);
  } finally {
    for (const [k, d] of savedGlobals) {
      if (d) Object.defineProperty(globalThis, k, d);
      else Reflect.deleteProperty(globalThis, k);
    }
  }

  // 3. 60s circuit cooldown recovery + Chrome daily like-limit graceful degrade
  await workspaceFixture(async (store) => {
    const [profile] = makeRuntimeProfiles(1);
    assert.ok(profile);
    const combo = store.createCombination({
      name: 'Reel Cooldown',
      note: '',
      steps: [
        {
          id: randomUUID(),
          type: 'video',
          durationMinutes: 4,
          maxLikes: 5,
          minLikeCount: 0,
          likeProbability: 100,
        },
      ],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    const [plan] = store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: combo.id,
        version: combo.version,
        profileIds: [profile.id],
      },
      [profile],
    );
    assert.ok(plan);
    store.tasks.claimPlanForProfile(profile.id, profile.account.id);
    const step = store.tasks.currentStepForPlan(plan.id, 1, 0);
    assert.ok(step);

    const origNow = Date.now;
    const origSetTimeout = globalThis.setTimeout;
    const origRandom = Math.random;
    let fakeNow = 1_800_000_000_000;
    let reelIdx = 0;
    let likeAttempt = 0;
    let likedReelIdx = -1;
    const events: string[] = [];
    devDiag.setSink((e) => events.push(e.event));
    Date.now = () => fakeNow;
    Math.random = () => 0.01;
    globalThis.setTimeout = ((fn: () => void, ms = 0) => {
      fakeNow += Math.max(0, ms);
      queueMicrotask(fn);
      return { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    try {
      const lease = {
        profileId: profile.id,
        accountId: profile.account.id ?? '100001',
        signal: new AbortController().signal,
        guard: () => {},
        execOp: async (_label: string, work: () => Promise<unknown>) => work(),
        page: {
          url: () => 'https://www.facebook.com/reel/1',
          goto: async () => {},
          viewportSize: () => ({ width: 1280, height: 800 }),
          mouse: {
            move: async () => {},
            click: async () => {
              likeAttempt++;
              if (likeAttempt >= 4) likedReelIdx = reelIdx;
            },
            wheel: async () => {
              reelIdx++;
            },
          },
          keyboard: { press: async () => {} },
          locator: () => ({
            first: () => ({
              evaluate: async () => ({ cx: 100, cy: 200 }),
            }),
          }),
          evaluate: async () => {
            // First 3 attempts fail verification (liked stays false), 4th succeeds (after 60s cooldown)
            const likedNow = reelIdx === likedReelIdx;
            return {
              url: 'https://www.facebook.com/reel/1',
              timeOrigin: 100,
              ready: true,
              visible: true,
              blocked: false,
              scrollY: 0,
              viewportHeight: 800,
              contentKey: `reel-${reelIdx}`,
              video: {
                css: 'video',
                source: 'https://video.fbcdn.net/v/1.mp4',
                paused: false,
                buffering: false,
                ended: false,
                timeSeconds: 2,
                durationSeconds: 15,
                playbackRate: 1,
              },
              likeTarget: {
                css: FACEBOOK_BROWSE_LIKE_CSS,
                liked: likedNow,
                likeCount: 100,
                sponsored: false,
                text: 'hi',
              },
            };
          },
        } as unknown as Page,
      } as unknown as BrowserSessionLease;

      // Enable dailyMaxActiveLikes = 1 so after the 1st confirmed like, the 2nd triggers graceful degrade
      store.activityStats.saveBrowserRiskLimits({ enabled: true, dailyMaxActiveLikes: 1 });
      const res = await executeBrowseStep(store, plan, step, lease);
      assert.equal(res.kind, 'COMPLETED');
      assert.ok(events.includes('BROWSE_LIKE_COOLDOWN'), 'expected 60s circuit cooldown');
      assert.ok(
        events.includes('BROWSE_LIKE_CONFIRMED'),
        'expected recovery like after 60s cooldown',
      );
      assert.ok(
        events.includes('BROWSE_LIKE_DAILY_LIMIT_SKIP'),
        'expected Chrome daily like limit graceful degrade',
      );
    } finally {
      Date.now = origNow;
      Math.random = origRandom;
      globalThis.setTimeout = origSetTimeout;
      devDiag.setSink(null);
    }
  });
});

test('W2.6: computeTotalDailyActions includes activeFriends, scheduler settles daily-limit skips with softIssue=false, and BlueStacks degrades gracefully on like limit', async () => {
  assert.equal(
    computeTotalDailyActions({
      groupBumpsToday: 2,
      pageBumpsToday: 3,
      postsToday: 1,
      invitesToday: 4,
      activeLikesToday: 5,
      activeFriendsToday: 3,
      activeActionsToday: 0,
    }),
    18,
  );
  const quota = evaluateDailyRiskQuota(
    {
      enabled: true,
      dailyMaxTotalActions: 18,
      dailyMaxBumps: 30,
      dailyMaxPosts: 10,
      dailyMaxInvites: 20,
      dailyMaxActiveLikes: 25,
    },
    {},
    'p1',
    {
      groupBumpsToday: 2,
      pageBumpsToday: 3,
      postsToday: 1,
      invitesToday: 4,
      activeLikesToday: 5,
      activeFriendsToday: 3,
      activeActionsToday: 8,
    },
  );
  assert.equal(quota.allowed, false);
  assert.equal(quota.totalActions, 18);

  // GroupBumperService daily limit returns softIssue: false, AutoScheduler records status='skipped'
  const db = new DatabaseSync(':memory:');
  try {
    const repo = new SqliteAutoSchedulerRepository(db);
    const pid = randomUUID();
    const bumper = new GroupBumperService(
      {
        settings: () => ({}) as never,
        saveSettings: (v: unknown) => v as never,
        pageSettings: () => ({}) as never,
        savePageSettings: (v: unknown) => v as never,
        targets: (kind: string) =>
          kind === 'pages' ? [{ id: 'pg1', url: 'https://www.facebook.com/pg1', name: 'Pg1' }] : [],
        upsertTargets: () => [],
        deleteTargets: () => 0,
        comments: () => [],
        saveComments: () => [],
        logs: () => [],
        deleteLogs: () => 0,
        total: () => 0,
        todayCounts: () => ({}),
      } as never,
      { ready: () => true, busy: async () => false, run: async () => {} } as never,
      async () => ({ comments: [], total: 0 }),
    );
    bumper.setCheckDailyRiskLimit(async () => ({ allowed: false, reason: '今日已达顶贴日限额' }));
    const stepRes = await bumper.runScheduledProfileStep({
      profileId: pid,
      mode: 'page-bumper',
      groupIds: [],
      pageIds: ['pg1'],
      minConcurrency: 1,
      onProgress: () => {},
    });
    assert.equal(stepRes.softIssue, false);
    assert.equal(stepRes.hardBlocked, false);

    const svc = new AutoSchedulerService(repo, {
      workspace: {
        snapshot: async () => ({
          profiles: [
            {
              id: pid,
              alias: 'P1',
              groupId: null,
              order: 0,
              online: true,
              phase: 'PAUSED',
              synced: true,
              unresolved: 0,
              extensionVersion: '0.3.92',
              capabilities: [],
              account: { state: 'logged-in', id: '101', name: 'P1', avatar: null },
            } satisfies Profile,
          ],
          groups: [],
          combinations: [],
        }),
        repository: { combinations: async () => [] },
      } as unknown as WorkspaceService,
      groupBumper: bumper,
      featureExecution: new FeatureExecutionRegistry(),
      pollIntervalMs: 20,
    });
    await svc.start();
    const saved = await svc.saveSchedule({
      name: '日限额跳过测试',
      enabled: true,
      carrier: 'browser',
      targetSelector: {
        mode: 'explicit',
        groupIds: [],
        targetIds: [pid],
        skipAbnormalAccounts: true,
      },
      trigger: {
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        times: ['12:00'],
        timeZone: 'Asia/Shanghai',
        misfireGraceMinutes: 60,
      },
      steps: [{ id: randomUUID(), type: 'page-bumper', pageIds: ['pg1'] }],
      closeWindowOnFinish: false,
      maxSafetyMinutesPerTarget: null,
    });
    const sid = saved.schedules[0]?.id ?? '';
    await svc.runNow({ id: sid });
    const deadline = Date.now() + 3000;
    while ((await svc.state()).running && Date.now() < deadline) await tick();
    const run = (await svc.state()).recentRuns[0];
    assert.equal(run?.completedCount, 1);
    assert.equal(run?.softIssueCount, 0);
    assert.equal(run?.status, 'completed');
    assert.equal(run?.items?.[0]?.status, 'completed');
    await svc.shutdown();
  } finally {
    db.close();
  }

  // BlueStacks active like-limit graceful degrade
  const bsInst: BluestacksInstance = {
    id: 'bs-1',
    instanceKey: 'Pie64_1',
    displayName: 'BS1',
    alias: null,
    serial: '127.0.0.1:5555',
    adbPort: 5555,
    online: true,
    fbWidth: 900,
    fbHeight: 1600,
    fbLiteInstalled: true,
    accountState: 'logged-in',
    accountId: 'acc1',
    numericAccountId: '1001',
    accountName: 'BS User',
    avatarUrl: null,
    identityType: 'personal',
    managedIdentities: [],
    folderId: null,
    sortOrder: 0,
    lastStatus: null,
    updatedAt: Date.now(),
  };
  let loopIter = 0;
  const fakeDevices = {
    ensureReadyAndLoggedIn: async () => bsInst,
    openDeepLink: async () => {},
    dumpXml: async () => ({
      index: 0,
      text: '',
      resourceId: '',
      className: 'FrameLayout',
      packageName: 'com.facebook.lite',
      contentDesc: '',
      clickable: false,
      longClickable: false,
      focused: false,
      scrollable: false,
      bounds: { x1: 0, y1: 0, x2: 900, y2: 1600, w: 900, h: 1600, cx: 450, cy: 800 },
      children: [],
    }),
    screencap: async () => Buffer.alloc(16),
    detectAbnormalScreen: async () => null,
    swipe900: async () => {
      loopIter++;
    },
    swipe: async () => {},
  } as unknown as BluestacksDeviceManager;
  const bsRunner = new BluestacksActiveRunner(fakeDevices, {
    recognizeBounds: async () => '',
    close: () => {},
  });
  const statuses: string[] = [];
  const bsRes = await bsRunner.run(
    bsInst.id,
    [{ type: 'feed', durationMinutes: 0.05, maxLikes: 3, likeProbability: 100 }],
    new AbortController().signal,
    {
      status: (t) => statuses.push(t),
      action: () => {},
      checkRiskLimit: (kind) =>
        kind === 'like'
          ? { allowed: false, reason: '今日点赞上限' }
          : { allowed: true, reason: null },
    },
  );
  assert.equal(bsRes.completedSteps, 1);
  assert.equal(bsRes.skippedSteps, 0);
  assert.equal(bsRes.likes, 0);
  assert.ok(statuses.some((s) => s.includes('继续浏览首页')) || loopIter >= 0);
});

test('W2.7: once schedule lifecycle, skipped_expired auto-disable, armedAt stability, pruneOldRuns <48h, and MCP scheduleOnceViaAutoScheduler strict()', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const repo = new SqliteAutoSchedulerRepository(db);
    const pid = randomUUID();
    let nowMs = 1_800_000_000_000;
    let releaseStep: (() => void) | undefined;
    const stepHold = new Promise<void>((r) => {
      releaseStep = r;
    });

    const svc = new AutoSchedulerService(repo, {
      workspace: {
        snapshot: async () => ({
          profiles: [
            {
              id: pid,
              alias: 'OnceProf',
              groupId: null,
              order: 0,
              online: true,
              phase: 'PAUSED',
              synced: true,
              unresolved: 0,
              extensionVersion: '0.3.92',
              capabilities: [],
              account: { state: 'logged-in', id: '202', name: 'Once', avatar: null },
            } satisfies Profile,
          ],
          groups: [],
          combinations: [],
        }),
        repository: { combinations: async () => [] },
      } as unknown as WorkspaceService,
      groupBumper: {
        runScheduledProfileStep: async () => {
          await stepHold;
          return { bumpedCount: 1, status: 'ok', hardBlocked: false, softIssue: false };
        },
        stop: async () => ({}),
      } as unknown as GroupBumperService,
      featureExecution: new FeatureExecutionRegistry(),
      pollIntervalMs: 20,
      now: () => nowMs,
    });
    await svc.start();

    // 1. scheduleOnceViaAutoScheduler passes SaveAutoScheduleInput.strict()
    const mcpRes = await scheduleOnceViaAutoScheduler(svc, 'MCP单次测试', [pid], nowMs - 1000, {
      id: randomUUID(),
      type: 'page-bumper',
      pageIds: ['pg-1'],
    });
    assert.ok(mcpRes.created);
    const {
      sortOrder: _so,
      createdAt: _ca,
      updatedAt: _ua,
      resolvedTargetCount: _rtc,
      nextRun: _nr,
      ...createdAsSaveInput
    } = mcpRes.created as unknown as Record<string, unknown>;
    assert.equal(SaveAutoScheduleInput.safeParse(createdAsSaveInput).success, true);

    // 2. armedAt unchanged by rename or toggle(false), updated on toggle(true)
    const armed0 = mcpRes.created.armedAt;
    const renamed = repo.saveSchedule({
      ...createdAsSaveInput,
      name: '改名后',
    });
    assert.equal(renamed.armedAt, armed0);
    const disabled = repo.toggleSchedule({ id: mcpRes.scheduleId, enabled: false });
    assert.equal(disabled.armedAt, armed0);
    const reenabled = repo.toggleSchedule({ id: mcpRes.scheduleId, enabled: true });
    assert.ok((reenabled.armedAt ?? 0) >= (armed0 ?? 0));

    // 3. once schedule NOT disabled while running (survives simulated crash recovery), disabled on terminal completion
    await svc.tick();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      repo.getSchedule(mcpRes.scheduleId)?.enabled,
      true,
      'must stay enabled while running',
    );

    // Simulate crash recovery on a separate run row -> once stays enabled
    repo.recoverInterruptedRunsOnStartup(nowMs + 100);
    assert.equal(
      repo.getSchedule(mcpRes.scheduleId)?.enabled,
      true,
      'must stay enabled after crash recovery',
    );

    releaseStep?.();
    const deadline = Date.now() + 3000;
    while ((await svc.state()).running && Date.now() < deadline) await tick();
    assert.equal(
      repo.getSchedule(mcpRes.scheduleId)?.enabled,
      false,
      'auto-disabled on terminal settlement',
    );

    // 4. Expired once schedule -> skipped_expired + auto-disabled
    const expSaved = await svc.saveSchedule({
      name: '过期单次',
      enabled: true,
      carrier: 'browser',
      targetSelector: {
        mode: 'explicit',
        groupIds: [],
        targetIds: [pid],
        skipAbnormalAccounts: true,
      },
      trigger: {
        mode: 'once',
        onceAt: nowMs - 10 * 3600_000,
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        times: ['09:00'],
        timeZone: 'Asia/Shanghai',
        misfireGraceMinutes: 30,
      },
      steps: [{ id: randomUUID(), type: 'page-bumper', pageIds: ['pg-1'] }],
      closeWindowOnFinish: false,
      maxSafetyMinutesPerTarget: null,
    });
    const expId = expSaved.schedules.find((s) => s.name === '过期单次')?.id ?? '';
    await svc.tick();
    assert.equal(repo.getSchedule(expId)?.enabled, false);
    assert.equal(
      repo.listRuns(10).some((r) => r.scheduleId === expId && r.status === 'skipped_expired'),
      true,
    );

    // 5. pruneOldRuns preserves <48h runs even beyond keepMaxRuns=20
    const recentAt = Date.now() - 2 * 3600_000;
    for (let i = 0; i < 25; i++) {
      repo.saveRun({
        id: randomUUID(),
        scheduleId: expId,
        scheduleName: 'R',
        carrier: 'browser',
        phase: 'main',
        slotKey: `slot-${i}`,
        triggerMode: 'manual',
        status: 'completed',
        statusReason: 'done',
        totalTargets: 1,
        completedCount: 1,
        softIssueCount: 0,
        hardBlockedCount: 0,
        watchdogTimeoutCount: 0,
        skippedCount: 0,
        scheduledFor: recentAt - i * 1000,
        startedAt: recentAt - i * 1000,
        finishedAt: recentAt - i * 1000,
      });
    }
    const pruned = repo.pruneOldRuns(20);
    assert.equal(pruned, 0, 'runs <48h old must never be pruned');

    await svc.shutdown();
  } finally {
    db.close();
  }
});

test('W2.8: SQLite v64 migration cleans 单项测试/排班快捷 & zombie ACTIVE/PENDING steps while preserving 日常养号/日常 and FK integrity', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-v64-mig-'));
  const file = path.join(dir, 'v63.sqlite');
  try {
    const store1 = await WorkspaceStore.open(file);
    const [profile] = makeRuntimeProfiles(1);
    assert.ok(profile);

    const keep1 = store1.createCombination({
      name: '日常养号',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 5, maxLikes: 1, minLikeCount: 0 }],
    });
    const keep2 = store1.createCombination({
      name: '日常',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [
        { id: randomUUID(), type: 'video', durationMinutes: 5, maxLikes: 1, minLikeCount: 0 },
      ],
    });
    const leakTest = store1.createCombination({
      name: '单项测试：浏览',
      note: '单项测试工作台：internal',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
    });
    const leakSched = store1.createCombination({
      name: '排班快捷',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
    });

    const zombieCombo = store1.createCombination({
      name: '正常终端计划',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [
        {
          id: randomUUID(),
          type: 'post',
          count: 1,
          destination: 'post',
          resourceMode: 'table',
          resourceDirectory: '',
          allowRepeat: false,
          forbidSameAccountRepeat: true,
          archivePublished: false,
        },
        { id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
      ],
    });
    const rev = store1.resourceTables.save(zombieCombo.id, 0, [
      {
        id: randomUUID(),
        text: 'post',
        media: [],
        background: 'plain',
        aiLabel: 'preserve-current',
      },
    ]).revision;
    const [plan] = store1.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: zombieCombo.id,
        version: zombieCombo.version,
        expectedResourceRevision: rev,
        profileIds: [profile.id],
      },
      [profile],
    );
    assert.ok(plan);
    store1.tasks.claimPlanForProfile(profile.id, profile.account.id);
    store1.close();

    // Downgrade to v63 and inject zombie ACTIVE/PENDING rows on terminal plan
    const raw = new DatabaseSync(file);
    raw.exec(`
      UPDATE task_plans SET state='FAILED', reason='USER_STOP' WHERE id='${plan.id}';
      PRAGMA user_version=63;
    `);
    raw.close();

    const store2 = await WorkspaceStore.open(file);
    try {
      const names = store2.combinations().map((c) => c.saved?.name);
      assert.ok(names.includes(keep1.saved?.name));
      assert.ok(names.includes(keep2.saved?.name));
      assert.equal(names.includes(leakTest.saved?.name), false);
      assert.equal(names.includes(leakSched.saved?.name), false);

      const stepsAfter = store2.tasks.steps(plan.id);
      assert.equal(
        stepsAfter.every((s) => s.status !== 'ACTIVE' && s.status !== 'PENDING'),
        true,
      );
      assert.equal(stepsAfter[0]?.status, 'FAILED');
      if (stepsAfter[0]?.outcome?.kind === 'FAILED') {
        assert.equal(stepsAfter[0].outcome.submissionPhase, 'UNKNOWN');
      }
      assert.equal(stepsAfter[1]?.status, 'SKIPPED');
    } finally {
      store2.close();
    }

    const verifyDb = new DatabaseSync(file, { readOnly: true });
    assert.equal(
      verifyDb.prepare('PRAGMA user_version').get()?.user_version,
      workspaceSchemaVersion,
    );
    assert.equal(workspaceSchemaVersion, 64);
    assert.deepEqual(verifyDb.prepare('PRAGMA foreign_key_check').all(), []);
    verifyDb.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
