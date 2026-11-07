import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { KernelManagedFacebookSession } from '../src/infrastructure/kernel-managed-facebook-session.js';
import { NativeFacebookTaskAuthority } from '../src/infrastructure/facebook-task-authority.js';
import { canonicalAction } from '../src/shared/browser-actions.js';
import type { Action } from '../src/shared/browser-actions.js';
import type { NativeInputGuard } from '../src/application/native-input-gate.js';
import {
  FacebookBrowsePage,
  projectFacebookBrowsePage,
  FACEBOOK_BROWSE_LIKE_CSS,
} from '../src/infrastructure/facebook-browse-reader.js';
import { KernelLease } from '../src/domain/kernel-lease.js';
import { isRecoverableBrowseFault } from '../src/shared/browse-execution.js';
import {
  facebookBrowseSurface,
  matchesMarketplaceSearch,
} from '../src/shared/facebook-browse-route.js';
import { FacebookBrowseStepExecutor } from '../src/infrastructure/facebook-browse-step-executor.js';
import { TaskDispatcher } from '../src/application/task-dispatcher.js';
import { AdmittedTaskRuntime } from '../src/application/admitted-task-runtime.js';
import { TaskRendering } from '../extension/task-rendering.js';
import { ChromeKernelBackend } from '../extension/kernel-backend.js';
import { prepareBound, settlementFixture } from './fixtures/settlement.js';
import { browseHarness } from './fixtures/browse.js';
import { DatabaseSync } from 'node:sqlite';
import { persistenceRoutes } from '../src/infrastructure/persistence-routes.js';
import { Store as BridgeStore } from '../src/bridge/store.js';
import { TaskStepRunner } from '../src/application/task-step-runner.js';
import { ExtensionKernelChannel } from '../extension/kernel-channel.js';
import { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import { Core } from '../src/bridge/core.js';
import { WatchTasks } from '../src/bridge/watch.js';
import { KernelJsonObject } from '../src/shared/kernel-protocol.js';
import { ProfileActor } from '../src/application/profile-actor.js';
import { KernelJournal } from '../src/application/kernel-journal.js';
import type { KernelState } from '../src/shared/kernel-state.js';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import { SqliteTaskRepository } from '../src/infrastructure/task-store.js';
import { KernelRelayModel } from '../src/infrastructure/kernel-relay-model.js';
import type { RuntimeProfile } from '../src/domain/tasks.js';
import type { Plan } from '../src/shared/task-contracts.js';

test('paired native mouse release keeps ownership checks but does not re-read its pressed target', async () => {
  const context = {
    profileId: randomUUID(),
    accountId: '123',
    connectionEpoch: randomUUID(),
    leaseId: randomUUID(),
    generation: 1,
  };
  const proof = {
    profileId: context.profileId,
    ownershipId: randomUUID(),
    browserSessionEpoch: randomUUID(),
    tabId: 1,
    targetId: 'test',
  };
  const action: Action = {
    kind: 'click',
    tabId: 1,
    documentEpoch: 0,
    routeEpoch: 0,
    target: { css: '[data-wb-browse-like="1"]' },
  };
  const binding = {
    ...context,
    operationId: randomUUID(),
    jobId: randomUUID(),
    stepId: randomUUID(),
    actionDigest: createHash('sha256').update(canonicalAction(action)).digest('hex'),
  };
  let resourceGuard: NativeInputGuard,
    targetReads = 0,
    ownerChecks = 0,
    stop = false;
  const counts: number[] = [];
  const dispatch = async (type: string) => {
    await resourceGuard({
      target: { tabId: 1 },
      method: 'Input.dispatchMouseEvent',
      params: { type, button: 'left' },
    });
    counts.push(targetReads);
  };
  const page = {
    url: () => 'https://www.facebook.com/reels/',
    bringToFront: async () => {},
    locator: () => ({}),
    evaluate: async () => ({
      x: 50,
      y: 100,
      left: 20,
      top: 80,
      width: 60,
      height: 40,
      url: 'https://www.facebook.com/reels/',
      timeOrigin: 1,
      needsScroll: false,
    }),
    mouse: {
      click: async () => {
        await dispatch('mousePressed');
        await dispatch('mouseReleased');
      },
    },
  };
  const session = Object.create(
    KernelManagedFacebookSession.prototype,
  ) as KernelManagedFacebookSession;
  const connection = {
    proof,
    browser: { contexts: () => [{ pages: () => [page] }] },
    context: async () => context,
    execute: async (
      _binding: unknown,
      work: () => Promise<void>,
      _guard: unknown,
      _failure: unknown,
      guard: NativeInputGuard,
    ) => {
      resourceGuard = guard;
      await work();
      return { binding, value: undefined, targetUnavailableBeforeInput: false };
    },
  };
  for (const [key, value] of Object.entries({
    context,
    connection,
    plan: { id: binding.jobId },
    failure: async () => {},
    authority: {
      assertIdentity: async () => {
        ownerChecks++;
        if (stop) throw Error('STOPPED');
      },
      assertTarget: async () => {
        targetReads++;
      },
    },
    tabs: { assertForInput: async () => {} },
    tasks: { steps: async () => [{ id: binding.stepId, spec: { type: 'video' } }] },
  }))
    Reflect.set(session, key, value);
  const operation = {
    id: binding.operationId,
    jobId: binding.jobId,
    stepId: binding.stepId,
    action,
    binding,
  } as Parameters<KernelManagedFacebookSession['sendGuarded']>[0];
  await session.sendGuarded(operation, async () => {});
  assert.equal(counts.length, 2);
  assert.equal(counts[0], counts[1]);
  assert.equal(targetReads, 1);
  assert.ok(ownerChecks > targetReads);
  stop = true;
  await assert.rejects(dispatch('mouseReleased'), /STOPPED/);
});

test('transient identity read retries once without revocation; explicit account change revokes immediately', async () => {
  const authority = Object.create(
    NativeFacebookTaskAuthority.prototype,
  ) as NativeFacebookTaskAuthority;
  Reflect.set(authority, 'assertLive', async () => {});
  const read = Reflect.get(authority, 'readWithRetry').bind(authority) as <T>(
    fn: () => Promise<T>,
  ) => Promise<T>;
  let calls = 0;
  assert.equal(
    await read(async () => {
      if (++calls === 1) throw Error('FACEBOOK_IDENTITY_UNCONFIRMED');
      return 'recovered';
    }),
    'recovered',
  );
  assert.equal(calls, 2);
  assert.notEqual(Reflect.get(authority, 'revoked'), true);
  calls = 0;
  await assert.rejects(
    read(async () => {
      calls++;
      throw Error('FACEBOOK_IDENTITY_UNCONFIRMED');
    }),
  );
  assert.equal(calls, 2);
  assert.notEqual(Reflect.get(authority, 'revoked'), true);
  calls = 0;
  await assert.rejects(
    read(async () => {
      calls++;
      throw Error('FACEBOOK_NATIVE_ACCOUNT_CHANGED');
    }),
  );
  assert.equal(calls, 1);
  assert.equal(Reflect.get(authority, 'revoked'), true);
});

test('zero playbackRate is a readable transition, not identity failure or credited playback', () => {
  const sample = {
    url: 'https://www.facebook.com/reels/',
    timeOrigin: 1,
    ready: true,
    visible: true,
    blocked: false,
    scrollY: 0,
    viewportHeight: 720,
    contentKey: 'reel',
    video: {
      css: 'video',
      source: 'test',
      timeSeconds: 1,
      durationSeconds: 60,
      paused: true,
      buffering: true,
      ended: false,
      readyState: 2,
      playbackRate: 0,
    },
  };
  const parsed = FacebookBrowsePage.safeParse(sample);
  assert.ok(parsed.success, JSON.stringify(parsed.error));
  assert.equal(parsed.data.video?.playbackRate, 0);
});

test('WO43-1: KernelLease check never throws KERNEL_FENCED after expiry, lease faults are recoverable, and maxLikes > 0 browse steps settle to NOT_APPLIED', async () => {
  let now = 0;
  const profileId = randomUUID();
  const connectionEpoch = randomUUID();
  const leaseId = randomUUID();
  const lease = new KernelLease(profileId, connectionEpoch, () => now);
  const granted = lease.grant({
    profileId,
    connectionEpoch,
    leaseId,
    generation: 1,
    expiresAt: 1000,
  });
  // Even after expiry (now = 50000), check() auto-extends without throwing KERNEL_FENCED.
  now = 50_000;
  const checked = lease.check({
    profileId,
    connectionEpoch,
    leaseId,
    generation: 1,
    expiresAt: granted.expiresAt,
  });
  assert.equal(checked.leaseId, granted.leaseId);
  assert.ok(checked.expiresAt > 50_000);
  assert.equal(isRecoverableBrowseFault('KERNEL_FENCED'), true);
  assert.equal(isRecoverableBrowseFault('KERNEL_LEASE_REJECTED'), true);

  await settlementFixture(async (store) => {
    const h = await browseHarness(store, 1, {
      name: 'browse',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [
        { id: randomUUID(), type: 'video', durationMinutes: 1, maxLikes: 2, minLikeCount: 0 },
      ],
    });
    const plan = await h.claim();
    const step = (await store.tasks.steps(plan.id))[0]!;
    const session = h.sessions.get(plan.profileId)!;
    const op = await store.tasks.prepareOperation(plan.id, step.id, randomUUID(), {
      kind: 'click',
      tabId: 1,
      documentEpoch: 0,
      routeEpoch: 0,
      target: { css: '[data-wb-browse-like="1"]' },
    });
    const bound = await store.tasks.takeBoundOperation(session);
    assert.ok(bound?.binding);
    await store.tasks.markBoundUnknown(bound.binding, 'KERNEL_RPC_RESULT_UNKNOWN');
    assert.equal((await store.tasks.findOperation(plan.id, op.id))?.status, 'UNKNOWN');
    // WO49: an unregistered click may be a like; it must never be settled as NOT_APPLIED.
    const settled = await store.tasks.settleTransientBrowseOperations(plan.id, 'SELF_HEAL');
    assert.equal(settled, false);
    assert.equal((await store.tasks.findOperation(plan.id, op.id))?.status, 'UNKNOWN');
  });
});

test('WO43-2: FacebookBrowseStepExecutor.verify returns NOT_APPLIED after 3500ms on healthy unchanged page instead of waiting 30s', async () => {
  await settlementFixture(async (store) => {
    const h = await browseHarness(store, 1, {
      name: 'browse',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
    });
    const plan = await h.claim();
    const step = (await store.tasks.steps(plan.id))[0]!;
    const session = h.sessions.get(plan.profileId)!;
    const proof = h.proofs.get(plan.profileId)!;
    const pageState = {
      url: 'https://www.facebook.com/',
      timeOrigin: 100,
      ready: true,
      visible: true,
      blocked: false,
      scrollY: 200,
      scrollMaxY: 5000,
      viewportHeight: 800,
      contentKey: 'feed-post-1',
      video: null,
    };
    const executor = new FacebookBrowseStepExecutor(
      'feed',
      {
        read: async (_e, guard) => {
          await guard();
          return {
            context: session,
            proof,
            page: structuredClone(pageState),
          };
        },
      },
      () => true,
      () => h.clock.at,
    );
    const execution = { plan, step, session };
    const actId = randomUUID();
    const actAction = { kind: 'activateTab' as const, tabId: proof.tabId };
    await executor.verify(
      execution,
      {
        id: actId,
        jobId: plan.id,
        stepId: step.id,
        action: actAction,
        status: 'ACKNOWLEDGED',
        receipt: null,
        checkpointApplied: false,
        createdAt: 0,
        updatedAt: 0,
        binding: {
          ...session,
          operationId: actId,
          jobId: plan.id,
          stepId: step.id,
          actionDigest: createHash('sha256').update(JSON.stringify(actAction)).digest('hex'),
        },
      },
      { kind: 'auxiliary', purpose: 'activate', proof, documentEpoch: 0, routeEpoch: 0 },
      () => {},
    );
    h.clock.at = 0;
    await executor.decide(execution, () => {});
    h.clock.at = 1000;
    await executor.decide(execution, () => {});
    h.clock.at = 9000;
    const decision = await executor.decide(execution, () => {});
    assert.equal(decision.kind, 'action');
    if (decision.kind !== 'action') throw Error('ACTION_REQUIRED');
    const opId = randomUUID();
    const scrollOp = {
      id: opId,
      jobId: plan.id,
      stepId: step.id,
      action: decision.action,
      status: 'ACKNOWLEDGED' as const,
      receipt: null,
      checkpointApplied: false,
      createdAt: 9000,
      updatedAt: 9000,
      binding: {
        ...session,
        operationId: opId,
        jobId: plan.id,
        stepId: step.id,
        actionDigest: createHash('sha256').update(JSON.stringify(decision.action)).digest('hex'),
      },
    };
    h.clock.at = 9500;
    assert.equal(
      (await executor.verify(execution, scrollOp, decision.intent, () => {})).outcome,
      'WAIT',
    );
    h.clock.at = 13_500;
    assert.equal(
      (await executor.verify(execution, scrollOp, decision.intent, () => {})).outcome,
      'NOT_APPLIED',
    );
  });
});

test('WO43-3: projectFacebookBrowsePage caps Fiber traversal at <= 3000 nodes', () => {
  let visited = 0;
  const rootFiber: Record<string, unknown> = {};
  let cursor = rootFiber;
  for (let i = 0; i < 5000; i++) {
    const next: Record<string, unknown> = {};
    const current = cursor;
    Object.defineProperty(current, 'child', {
      get() {
        visited++;
        return next;
      },
      enumerable: true,
    });
    cursor = next;
  }
  const hostEl = {
    __reactContainer$test: rootFiber,
    tagName: 'DIV',
    getBoundingClientRect: () => ({
      top: 100,
      bottom: 300,
      left: 50,
      right: 450,
      width: 400,
      height: 200,
    }),
    getAttribute: () => null,
    hasAttribute: () => false,
    setAttribute: () => {},
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    innerText: 'Post text content ready for reading',
  };
  const dialogEl = {
    tagName: 'DIV',
    getBoundingClientRect: () => ({
      top: 100,
      bottom: 300,
      left: 50,
      right: 450,
      width: 400,
      height: 200,
    }),
    getAttribute: () => null,
    hasAttribute: () => false,
    setAttribute: () => {},
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    innerText: 'Dialog content',
  };
  const prevDoc = Reflect.get(globalThis, 'document');
  const prevWin = Reflect.get(globalThis, 'window');
  const prevPerf = Reflect.get(globalThis, 'performance');
  const prevLoc = Reflect.get(globalThis, 'location');
  const prevIW = Reflect.get(globalThis, 'innerWidth');
  const prevIH = Reflect.get(globalThis, 'innerHeight');
  const prevSY = Reflect.get(globalThis, 'scrollY');
  const prevCS = Reflect.get(globalThis, 'getComputedStyle');
  const prevEl = Reflect.get(globalThis, 'Element');
  try {
    Reflect.set(globalThis, 'Element', class FakeElement {});
    Reflect.set(globalThis, 'innerWidth', 1200);
    Reflect.set(globalThis, 'innerHeight', 800);
    Reflect.set(globalThis, 'scrollY', 0);
    Reflect.set(globalThis, 'getComputedStyle', () => ({
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      pointerEvents: 'auto',
    }));
    Reflect.set(globalThis, 'location', {
      href: 'https://www.facebook.com/',
      hostname: 'www.facebook.com',
      pathname: '/',
      search: '',
    });
    Reflect.set(globalThis, 'performance', { timeOrigin: 100 });
    Reflect.set(globalThis, 'window', {
      scrollY: 0,
      innerHeight: 800,
      innerWidth: 1200,
      getComputedStyle: () => ({
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        pointerEvents: 'auto',
      }),
    });
    Reflect.set(globalThis, 'document', {
      readyState: 'complete',
      visibilityState: 'visible',
      hidden: false,
      body: {
        innerText: 'Normal Facebook feed content',
        scrollHeight: 3000,
        clientHeight: 800,
        querySelectorAll: () => [],
      },
      documentElement: { scrollHeight: 3000, clientHeight: 800 },
      scrollingElement: { scrollTop: 0, scrollHeight: 3000, clientHeight: 800 },
      elementFromPoint: () => hostEl,
      querySelector: () => null,
      querySelectorAll: (sel: string) => {
        if (sel.includes('[role="dialog"]')) return [dialogEl];
        if (sel.includes('[role="main"]') || sel.includes('body')) return [hostEl];
        return [];
      },
    });
    projectFacebookBrowsePage();
    assert.ok(visited > 0 && visited <= 3000, `Expected 0 < visited <= 3000, got ${visited}`);
  } finally {
    Reflect.set(globalThis, 'document', prevDoc);
    Reflect.set(globalThis, 'window', prevWin);
    Reflect.set(globalThis, 'performance', prevPerf);
    Reflect.set(globalThis, 'location', prevLoc);
    Reflect.set(globalThis, 'innerWidth', prevIW);
    Reflect.set(globalThis, 'innerHeight', prevIH);
    Reflect.set(globalThis, 'scrollY', prevSY);
    Reflect.set(globalThis, 'getComputedStyle', prevCS);
    Reflect.set(globalThis, 'Element', prevEl);
  }
});

test('WO43-4: TaskRendering never sends Page.startScreencast and maintainPresentation throttles within 8000ms', async () => {
  const methods: string[] = [];
  const rendering = new TaskRendering(async (_target, method) => {
    methods.push(method);
  });
  await rendering.ensure(1, 'target-1', () => {});
  await rendering.release();
  assert.equal(methods.includes('Page.startScreencast'), false);
  assert.equal(methods.includes('Emulation.setFocusEmulationEnabled'), true);

  let tabGets = 0;
  let now = 10_000;
  const proof = {
    profileId: randomUUID(),
    ownershipId: randomUUID(),
    browserSessionEpoch: randomUUID(),
    tabId: 7,
    targetId: 'target-7',
  };
  const backend = Object.create(ChromeKernelBackend.prototype) as ChromeKernelBackend;
  Reflect.set(backend, 'access', 'facebook-task');
  Reflect.set(backend, 'presentationNow', () => now);
  Reflect.set(backend, 'owned', new Map([[7, proof]]));
  Reflect.set(backend, 'attached', new Map([[7, 'target-7']]));
  Reflect.set(backend, 'allowRead', () => true);
  Reflect.set(backend, 'journal', { writable: true });
  Reflect.set(backend, 'presentation', {
    proof,
    checkedAt: 10_000,
    diagnostic: 'visible:normal',
  });
  Reflect.set(backend, 'reportPresentation', () => {});
  const prevChrome = Reflect.get(globalThis, 'chrome');
  try {
    Reflect.set(globalThis, 'chrome', {
      tabs: {
        get: async () => {
          tabGets++;
          return { id: 7, windowId: 2, active: true, url: 'https://www.facebook.com/' };
        },
      },
      windows: {
        get: async () => ({ id: 2, state: 'normal', focused: true }),
      },
    });
    now = 12_000;
    backend.maintainPresentation();
    now = 15_000;
    backend.maintainPresentation();
    assert.equal(tabGets, 0);
    now = 18_500;
    backend.maintainPresentation();
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(tabGets, 1);
  } finally {
    Reflect.set(globalThis, 'chrome', prevChrome);
  }
});

test('WO43-5: NativeFacebookTaskAuthority.assertLive caches live plan within 400ms window', async () => {
  let taskGets = 0;
  let now = 1000;
  const planId = randomUUID();
  const profileId = randomUUID();
  const epoch = randomUUID();
  const peer = {
    profileId,
    epoch,
    online: true,
    synced: true,
    phase: 'PAUSED',
  };
  const authority = Object.create(
    NativeFacebookTaskAuthority.prototype,
  ) as NativeFacebookTaskAuthority;
  Reflect.set(authority, 'revoked', false);
  Reflect.set(authority, 'cachedLivePlan', undefined);
  Reflect.set(authority, 'now', () => now);
  Reflect.set(authority, 'owned', { page: {}, proof: {} });
  Reflect.set(authority, 'peer', peer);
  Reflect.set(authority, 'core', { peers: new Map([[profileId, peer]]) });
  Reflect.set(authority, 'bootstrap', {
    connection: { profileId, connectionEpoch: epoch },
    actor: { accountId: '10001', checkedAt: 900 },
  });
  Reflect.set(authority, 'plan', {
    id: planId,
    profileId,
    accountId: '10001',
    state: 'RUNNING',
  });
  Reflect.set(authority, 'tasks', {
    get: async () => {
      taskGets++;
      return {
        id: planId,
        profileId,
        accountId: '10001',
        state: 'RUNNING',
      };
    },
  });
  const assertLive = Reflect.get(authority, 'assertLive').bind(authority) as () => Promise<unknown>;
  await assertLive();
  now = 1100;
  await assertLive();
  now = 1300;
  await assertLive();
  assert.equal(taskGets, 1);
  now = 1500;
  await assertLive();
  assert.equal(taskGets, 2);
});

test('WO43-6: src/server.ts has zero historical *Audit imports or instantiations', async () => {
  const serverSource = await readFile(path.resolve('src/server.ts'), 'utf8');
  assert.equal(/Audit\b/.test(serverSource), false);
  assert.ok(serverSource.split(/\r?\n/).length <= 1050);
});

test('WO44-1: NativeFacebookTaskAuthority.assertTarget performs 1 atomic page.evaluate and 1 cached tasks.steps query on browse click', async () => {
  let evaluateCalls = 0;
  let stepQueries = 0;
  const now = 2000;
  const planId = randomUUID();
  const profileId = randomUUID();
  const epoch = randomUUID();
  const stepId = randomUUID();
  const peer = {
    profileId,
    epoch,
    online: true,
    synced: true,
    phase: 'PAUSED',
    capabilities: ['kernel-background-presentation-v1'],
  };
  const actor = {
    version: 1 as const,
    source: 'CometSettingsDropdownTriggerQuery' as const,
    accountId: '10001',
    name: 'Test User',
    type: 'User' as const,
    checkedAt: 1900,
  };
  const page = {
    evaluate: async () => {
      evaluateCalls++;
      return {
        identity: {
          url: 'https://www.facebook.com/',
          timeOrigin: 100,
          ready: 'complete' as const,
          actor,
        },
        page: {
          url: 'https://www.facebook.com/',
          timeOrigin: 100,
          ready: true,
          visible: true,
          blocked: false,
          scrollY: 120,
          viewportHeight: 720,
          contentKey: 'post-1',
          video: null,
          likeTarget: {
            css: FACEBOOK_BROWSE_LIKE_CSS,
            liked: false,
            likeCount: 10,
            sponsored: false,
            text: 'Like',
          },
        },
      };
    },
  };
  const authority = Object.create(
    NativeFacebookTaskAuthority.prototype,
  ) as NativeFacebookTaskAuthority;
  Reflect.set(authority, 'revoked', false);
  Reflect.set(authority, 'cachedLivePlan', undefined);
  Reflect.set(authority, 'cachedSteps', undefined);
  Reflect.set(authority, 'cachedBrowsePage', undefined);
  Reflect.set(authority, 'now', () => now);
  Reflect.set(authority, 'owned', {
    page,
    proof: {
      profileId,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 7,
      targetId: 't-7',
    },
  });
  Reflect.set(authority, 'peer', peer);
  Reflect.set(authority, 'core', { peers: new Map([[profileId, peer]]) });
  Reflect.set(authority, 'bootstrap', {
    connection: { profileId, connectionEpoch: epoch },
    actor: { ...actor },
  });
  Reflect.set(authority, 'plan', {
    id: planId,
    profileId,
    accountId: '10001',
    state: 'RUNNING',
  });
  Reflect.set(authority, 'tasks', {
    get: async () => ({
      id: planId,
      profileId,
      accountId: '10001',
      state: 'RUNNING',
    }),
    steps: async () => {
      stepQueries++;
      return [
        {
          id: stepId,
          status: 'ACTIVE',
          spec: { type: 'feed', durationMinutes: 1, maxLikes: 3, minLikeCount: 0 },
          progress: { effectiveMilliseconds: 0, likes: 0, published: 0, revision: 0 },
        },
      ];
    },
  });
  await authority.assertInputTarget(
    {
      kind: 'click',
      tabId: 7,
      documentEpoch: 0,
      routeEpoch: 0,
      target: { css: FACEBOOK_BROWSE_LIKE_CSS },
    },
    undefined,
    0,
  );
  assert.equal(evaluateCalls, 1);
  assert.equal(stepQueries, 1);
});

test('WO44-2: browse click recoverable fault and verify context change settle in-place as NOT_APPLIED without REVIEW or FAILED', async () =>
  settlementFixture(async (store) => {
    const profileId = randomUUID();
    const profile = {
      id: profileId,
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in' as const, id: '10002', name: 'User', avatar: null },
    };
    const combo = await store.createCombination({
      name: 'WO44-2 Combo',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 2, minLikeCount: 0 }],
    });
    await store.tasks.assign(
      { requestId: randomUUID(), combinationId: combo.id, version: 1, profileIds: [profileId] },
      [profile],
    );
    const plan = await store.tasks.claimNext([profile], new Set(['feed']));
    assert.ok(plan);
    const step = (await store.tasks.steps(plan.id))[0];
    assert.ok(step);
    const proof = {
      profileId,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 9,
      targetId: 't-9',
    };
    let session = {
      profileId,
      accountId: '10002',
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: 1,
    };
    await store.taskTabs.register(plan.id, proof, session);
    const op1 = randomUUID();
    await store.browseIntents.prepare(
      plan.id,
      step.id,
      op1,
      {
        kind: 'click',
        tabId: 9,
        documentEpoch: 0,
        routeEpoch: 0,
        target: { css: FACEBOOK_BROWSE_LIKE_CSS },
      },
      {
        kind: 'like',
        proof,
        documentEpoch: 0,
        routeEpoch: 0,
        contentId: 'post-1',
        observedLikeCount: 10,
        observedLiked: false,
      },
    );
    const dispatcher = new TaskDispatcher(store.tasks, {
      profiles: async () => [profile],
      session: async () => session,
      send: async () => {
        throw Error('KERNEL_RPC_RESULT_UNKNOWN');
      },
    });
    assert.equal(await dispatcher.flushOne(profileId), true);
    // WO49: an unknown like result has side effects and must stay for review, never NOT_APPLIED.
    assert.equal((await store.tasks.get(plan.id)).state, 'REVIEW');
    assert.equal((await store.tasks.operations(plan.id))[0]?.status, 'UNKNOWN');
  }));

test('WO44-3: reconcileRuntime keeps RUNNING plan alive when openingPlanId === plan.id even with dispatchAllowed false or unresolved > 0', async () =>
  settlementFixture(async (store) => {
    const profileId = randomUUID();
    const profile = {
      id: profileId,
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in' as const, id: '10003', name: 'User', avatar: null },
    };
    const combo = await store.createCombination({
      name: 'WO44-3 Combo',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [
        { id: randomUUID(), type: 'video', durationMinutes: 1, maxLikes: 1, minLikeCount: 0 },
      ],
    });
    await store.tasks.assign(
      { requestId: randomUUID(), combinationId: combo.id, version: 1, profileIds: [profileId] },
      [profile],
    );
    const plan = await store.tasks.claimNext([profile], new Set(['video']));
    assert.ok(plan);
    const step = (await store.tasks.steps(plan.id))[0];
    assert.ok(step);
    const proof = {
      profileId,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 11,
      targetId: 't-11',
    };
    const session = {
      profileId,
      accountId: '10003',
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: 1,
    };
    await store.taskTabs.register(plan.id, proof, session);
    await store.browseIntents.prepare(
      plan.id,
      step.id,
      randomUUID(),
      {
        kind: 'browsePlay',
        tabId: 11,
        url: 'https://www.facebook.com/reel/123/',
        timeOrigin: 100,
        documentEpoch: 0,
        routeEpoch: 0,
        css: 'video',
        source: 'blob:1',
      },
      { kind: 'auxiliary', purpose: 'play', proof, documentEpoch: 0, routeEpoch: 0 },
    );
    await store.tasks.takeBoundOperation(session);
    await store.tasks.reconcileRuntime([
      {
        ...profile,
        openingPlanId: plan.id,
        unresolved: 1,
        dispatchAllowed: false,
        unreadyReason: 'BROWSE_SELF_HEAL_REOPENING',
      },
    ]);
    assert.equal((await store.tasks.get(plan.id)).state, 'RUNNING');
    assert.equal(await store.tasks.unresolved(plan.id), false);
  }));

test('WO44-4: ChromeKernelBackend.maintainPresentation never calls chrome.windows.update({ focused: true }) when hidden', async () => {
  const prevChrome = Reflect.get(globalThis, 'chrome');
  let focusedTrueCalls = 0;
  let now = 10_000;
  try {
    Reflect.set(globalThis, 'chrome', {
      tabs: {
        get: async () => ({
          id: 7,
          windowId: 9,
          active: true,
          url: 'https://www.facebook.com/',
        }),
        update: async () => ({}),
      },
      windows: {
        get: async () => ({ id: 9, state: 'normal', focused: false }),
        update: async (_id: number, updateInfo: { focused?: boolean }) => {
          if (updateInfo.focused === true) focusedTrueCalls++;
          return {};
        },
      },
      debugger: {
        sendCommand: async () => ({ result: { value: 'hidden' } }),
      },
    });
    const proof = {
      profileId: randomUUID(),
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 7,
      targetId: 't-7',
    };
    const backend = new ChromeKernelBackend(
      { writable: true } as never,
      () => true,
      'facebook-task',
      () => true,
      () => undefined,
      () => now,
    );
    Reflect.set(backend, 'owned', new Map([[7, proof]]));
    Reflect.set(backend, 'attached', new Map([[7, 't-7']]));
    Reflect.set(backend, 'presentation', {
      proof,
      checkedAt: 0,
      reportedAt: 0,
      visibility: 'hidden',
      visibilityAt: Date.now(),
    });
    backend.maintainPresentation();
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(focusedTrueCalls, 0);
  } finally {
    Reflect.set(globalThis, 'chrome', prevChrome);
  }
});

test('WO45-1: AdmittedTaskRuntime.profiles() exposes openingPlanId even with pending blockingOperations and reconcileRuntime clears them without pausing', async () =>
  settlementFixture(async (store) => {
    const profileId = randomUUID();
    const raw = {
      id: profileId,
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: false,
      account: { state: 'logged-in' as const, id: '10005', name: 'User5', avatar: null },
    };
    const combo = await store.createCombination({
      name: 'WO45-1 Combo',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 1, minLikeCount: 0 }],
    });
    await store.tasks.assign(
      { requestId: randomUUID(), combinationId: combo.id, version: 1, profileIds: [profileId] },
      [raw],
    );
    const plan = await store.tasks.claimNext(
      [{ ...raw, dispatchAllowed: true }],
      new Set(['feed']),
    );
    assert.ok(plan);
    const step = (await store.tasks.steps(plan.id))[0];
    assert.ok(step);
    const proof = {
      profileId,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 15,
      targetId: 't-15',
    };
    const session = {
      profileId,
      accountId: '10005',
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: 1,
    };
    await store.taskTabs.register(plan.id, proof, session);
    await store.browseIntents.prepare(
      plan.id,
      step.id,
      randomUUID(),
      {
        kind: 'click',
        tabId: 15,
        documentEpoch: 0,
        routeEpoch: 0,
        target: { css: FACEBOOK_BROWSE_LIKE_CSS },
      },
      {
        kind: 'like',
        proof,
        documentEpoch: 0,
        routeEpoch: 0,
        contentId: 'post-45',
        observedLikeCount: 5,
        observedLiked: false,
      },
    );
    const runtime = new AdmittedTaskRuntime(
      store.tasks,
      store.taskTabs,
      store.tasks.settlements,
      store.taskControls,
      {
        profile: () => null,
        observeQueued: async () => ({ ...raw, dispatchAllowed: true }),
        openClaimed: async () => {
          throw Error('FACEBOOK_TASK_DOCUMENT_TIMEOUT');
        },
        forget: () => {},
        close: async () => {},
      },
      () => [raw],
      randomUUID,
    );
    try {
      await assert.rejects(runtime.observe(profileId), /FACEBOOK_TASK_DOCUMENT_TIMEOUT/);
      assert.equal((await store.tasks.get(plan.id)).state, 'RUNNING');
      const profiles = await runtime.profiles();
      assert.equal(profiles[0]?.openingPlanId, plan.id);
      await store.tasks.reconcileRuntime(profiles);
      assert.equal((await store.tasks.get(plan.id)).state, 'RUNNING');
      assert.equal((await store.tasks.blockingOperations(plan.id)).length, 0);
    } finally {
      await runtime.close();
    }
  }));

test('WO45-2: settleTransientBrowseOperations restores PAUSING non-user plan to RUNNING on recoverable browse fault', async () =>
  settlementFixture(async (store) => {
    const profileId = randomUUID();
    const profile = {
      id: profileId,
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in' as const, id: '10006', name: 'User6', avatar: null },
    };
    const combo = await store.createCombination({
      name: 'WO45-2 Combo',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [
        { id: randomUUID(), type: 'video', durationMinutes: 1, maxLikes: 1, minLikeCount: 0 },
      ],
    });
    await store.tasks.assign(
      { requestId: randomUUID(), combinationId: combo.id, version: 1, profileIds: [profileId] },
      [profile],
    );
    const plan = await store.tasks.claimNext([profile], new Set(['video']));
    assert.ok(plan);
    await store.tasks.requestControl(plan.id, 'pause', 'TRANSPORT_OR_ACCOUNT_UNREADY');
    assert.equal((await store.tasks.get(plan.id)).state, 'PAUSING');
    const settled = await store.tasks.settleTransientBrowseOperations(
      plan.id,
      'KERNEL_EXECUTE_TIMEOUT',
    );
    assert.equal(settled, true);
    const updated = await store.tasks.get(plan.id);
    assert.equal(updated.state, 'RUNNING');
    assert.equal(updated.controlMode, null);
    assert.equal(updated.controlRequestId, null);
  }));

test('WO45-3: finishControl settles registered unresolved browse operation so confirmControl lands in PAUSED/STOPPED instead of REVIEW', async () =>
  settlementFixture(async (store) => {
    const profileId = randomUUID();
    const profile = {
      id: profileId,
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in' as const, id: '10007', name: 'User7', avatar: null },
    };
    const combo = await store.createCombination({
      name: 'WO45-3 Combo',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 1, minLikeCount: 0 }],
    });
    await store.tasks.assign(
      { requestId: randomUUID(), combinationId: combo.id, version: 1, profileIds: [profileId] },
      [profile],
    );
    const plan = await store.tasks.claimNext([profile], new Set(['feed']));
    assert.ok(plan);
    const step = (await store.tasks.steps(plan.id))[0];
    assert.ok(step);
    const proof = {
      profileId,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 17,
      targetId: 't-17',
    };
    const session = {
      profileId,
      accountId: '10007',
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: 1,
    };
    await store.taskTabs.register(plan.id, proof, session);
    await store.browseIntents.prepare(
      plan.id,
      step.id,
      randomUUID(),
      {
        kind: 'click',
        tabId: 17,
        documentEpoch: 0,
        routeEpoch: 0,
        target: { css: FACEBOOK_BROWSE_LIKE_CSS },
      },
      {
        kind: 'like',
        proof,
        documentEpoch: 0,
        routeEpoch: 0,
        contentId: 'post-47',
        observedLikeCount: 8,
        observedLiked: false,
      },
    );
    await store.tasks.takeBoundOperation(session);
    const pausing = await store.tasks.requestControl(plan.id, 'pause', 'USER_PAUSE');
    assert.ok(pausing.controlRequestId);
    const confirmed = await store.tasks.confirmControl(plan.id, pausing.controlRequestId);
    // WO49: a registered like has side effects; control confirmation must leave it for review.
    assert.equal(confirmed.state, 'REVIEW');
    assert.equal(await store.tasks.unresolved(plan.id), true);
    assert.equal(isRecoverableBrowseFault('ACTOR_TRANSPORT_OR_IDENTITY_CHANGED'), true);
  }));

test('WO46-1 & WO46-2: facebookBrowseSurface supports /marketplace/category/<slug> and Marketplace lazy-load recovery scrolls at 4.5s and reloads at 12s', async () =>
  settlementFixture(async (store) => {
    assert.equal(
      facebookBrowseSurface('https://www.facebook.com/marketplace/category/vehicles/'),
      'marketplace',
    );
    assert.equal(
      facebookBrowseSurface(
        'https://www.facebook.com/marketplace/category/propertyrentals/search?query=car',
      ),
      'marketplace',
    );
    assert.equal(
      matchesMarketplaceSearch('https://www.facebook.com/marketplace/category/vehicles/', {
        keyword: '',
      }),
      true,
    );
    assert.equal(
      matchesMarketplaceSearch(
        'https://www.facebook.com/marketplace/category/vehicles/?referral_surface=category_menu_item',
        { keyword: '' },
      ),
      true,
    );
    assert.equal(
      matchesMarketplaceSearch(
        'https://www.facebook.com/marketplace/category/vehicles/search/?category_id=12345&query=SUV',
        { keyword: 'SUV', categoryId: '12345' },
      ),
      true,
    );
    const profileId = randomUUID();
    const profile = {
      id: profileId,
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in' as const, id: '10008', name: 'User8', avatar: null },
    };
    const combo = await store.createCombination({
      name: 'WO46 Marketplace Combo',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [
        {
          id: randomUUID(),
          type: 'marketplace',
          keyword: '',
          durationMinutes: 1,
          maxLikes: 0,
          minLikeCount: 0,
        },
      ],
    });
    await store.tasks.assign(
      { requestId: randomUUID(), combinationId: combo.id, version: 1, profileIds: [profileId] },
      [profile],
    );
    const plan = await store.tasks.claimNext([profile], new Set(['marketplace']));
    assert.ok(plan);
    const step = (await store.tasks.steps(plan.id))[0];
    assert.ok(step);
    const proof = {
      profileId,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 18,
      targetId: 't-18',
    };
    const session = {
      profileId,
      accountId: '10008',
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: 1,
    };
    let now = 1_000;
    let currentScrollY = 0;
    const executor = new FacebookBrowseStepExecutor(
      'marketplace',
      {
        read: async () => ({
          context: session,
          proof,
          page: {
            url: 'https://www.facebook.com/marketplace/',
            timeOrigin: 100,
            ready: true,
            visible: true,
            blocked: false,
            scrollY: currentScrollY,
            viewportHeight: 800,
            contentKey: null,
            video: null,
          },
        }),
      },
      () => true,
      () => now,
    );
    const execution = { plan, step, session };
    const first = await executor.decide(execution, () => {});
    assert.equal(first.kind, 'wait');

    now = 6_000; // 5s elapsed (>= 4.5s) -> triggers lazy-load scroll once
    const second = await executor.decide(execution, () => {});
    assert.equal(second.kind, 'action');
    if (second.kind === 'action') {
      assert.equal(second.action.kind, 'browseScroll');
    }

    // Even when scrollY stays 0 on a skeleton page, 6s elapsed does not repeat browseScroll
    now = 7_000;
    const afterLazyScroll = await executor.decide(execution, () => {});
    assert.equal(afterLazyScroll.kind, 'wait');

    now = 14_000; // 13s elapsed (>= 12s) -> triggers reload navigate
    const third = await executor.decide(execution, () => {});
    assert.equal(third.kind, 'action');
    if (third.kind === 'action') {
      assert.equal(third.action.kind, 'browseNavigate');
    }
  }));

test('WO47-1/2/3: settlement indexes, bridge operations_updated_at index, persistence route allowlist, hasUndelivered() EXISTS query and 1-query list()', async () =>
  settlementFixture(async (store, file) => {
    assert.equal(persistenceRoutes.has('workspace.tasks.settlements.hasUndelivered'), true);

    const db = new DatabaseSync(file);
    try {
      const noticeIdx = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='task_settlement_notices_profile_order'",
        )
        .get();
      const deliveryIdx = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='task_settlement_delivery_state_due'",
        )
        .get();
      assert.ok(noticeIdx);
      assert.ok(deliveryIdx);

      const bridgeStore = new BridgeStore(':memory:');
      try {
        const bridgeIdx = bridgeStore.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='operations_updated_at'",
          )
          .get();
        assert.ok(bridgeIdx);
        assert.equal(
          (bridgeStore.db.prepare('PRAGMA user_version').get() as { user_version: number })
            .user_version,
          3,
        );
      } finally {
        bridgeStore.db.close();
      }

      const fixtures = [prepareBound(store), prepareBound(store)];
      const profileA = fixtures[0]!.profile.id;
      const profileB = fixtures[1]!.profile.id;
      const insertParents = (opId: string, profileId: string) => {
        const fixture = fixtures.find((value) => value.profile.id === profileId)!;
        const binding = { ...fixture.binding, operationId: opId };
        db.prepare(
          "INSERT INTO task_outbox(id,job_id,step_id,action,status,receipt,checkpoint_applied,created_at,updated_at) SELECT ?,job_id,step_id,action,'VERIFIED',?,1,created_at,updated_at FROM task_outbox WHERE id=?",
        ).run(opId, JSON.stringify({ binding, evidence: {} }), fixture.binding.operationId);
        db.prepare(
          'INSERT INTO task_dispatch_bindings(operation_id,body,created_at) VALUES(?,?,?)',
        ).run(opId, JSON.stringify(binding), 1000);
        return binding;
      };
      db.exec('BEGIN');
      try {
        for (let i = 0; i < 1200; i++) {
          const opId = randomUUID();
          const pid = i % 2 === 0 ? profileA : profileB;
          const body = JSON.stringify({
            binding: insertParents(opId, pid),
            resolution: { id: randomUUID(), outcome: 'VERIFIED', evidenceDigest: 'a'.repeat(64) },
          });
          db.prepare(
            "INSERT INTO task_settlement_notices(operation_id,kind,profile_id,body,created_at) VALUES(?,'BUSINESS',?,?,?)",
          ).run(opId, pid, body, 1000 + i);
          db.prepare(
            "INSERT INTO task_settlement_delivery(operation_id,kind,state,claim_token,attempts,next_attempt_at,reason,updated_at) VALUES(?,'BUSINESS','DELIVERED',NULL,1,0,'REMOTE_RECONCILED',?)",
          ).run(opId, 1000 + i);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }

      assert.equal(await store.tasks.settlements.hasUndelivered(profileA), false);
      assert.equal(await store.tasks.settlements.hasUndelivered(profileB), false);

      // Insert 2 PENDING notices for profileA (one due now, one future retry)
      const pendingDueOp = randomUUID();
      const pendingFutureOp = randomUUID();
      for (const [idx, opId] of [
        [0, pendingDueOp],
        [1, pendingFutureOp],
      ] as const) {
        const body = JSON.stringify({
          binding: insertParents(opId, profileA),
          resolution: { id: randomUUID(), outcome: 'VERIFIED', evidenceDigest: 'b'.repeat(64) },
        });
        db.prepare(
          "INSERT INTO task_settlement_notices(operation_id,kind,profile_id,body,created_at) VALUES(?,'BUSINESS',?,?,?)",
        ).run(opId, profileA, body, 5000 + idx);
        db.prepare(
          "INSERT INTO task_settlement_delivery(operation_id,kind,state,claim_token,attempts,next_attempt_at,reason,updated_at) VALUES(?,'BUSINESS','PENDING',NULL,0,?,'BUSINESS_SETTLED',?)",
        ).run(opId, idx === 0 ? 0 : Date.now() + 60_000, 2000 + idx);
      }

      assert.equal(await store.tasks.settlements.hasUndelivered(profileA), true);
      assert.equal(await store.tasks.settlements.hasUndelivered(profileB), false);

      const captureSql = <T>(read: () => T) => {
        const connection = Reflect.get(store, 'db') as DatabaseSync;
        const prepare = connection.prepare;
        const sql: string[] = [];
        connection.prepare = function (query) {
          sql.push(query);
          return prepare.call(this, query);
        };
        try {
          return { value: read(), sql };
        } finally {
          connection.prepare = prepare;
        }
      };
      const capturedList = captureSql(() => store.tasks.settlements.list(profileA));
      const listA = capturedList.value;
      assert.equal(capturedList.sql.length, 1);
      assert.equal(listA.length, 602);
      assert.equal(listA.at(-2)?.binding.operationId, pendingDueOp);
      assert.equal(listA.at(-1)?.binding.operationId, pendingFutureOp);

      const capturedAll = captureSql(() => store.tasks.settlements.list());
      const allList = capturedAll.value;
      assert.equal(capturedAll.sql.length, 1);
      assert.equal(allList.length, 1202);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

      // Claiming transitions pendingDueOp to SENDING, blocking subsequent claim on profileA
      const capturedClaim = captureSql(() => store.tasks.settlements.claim(profileA));
      const claimed = capturedClaim.value;
      const claimSql = capturedClaim.sql.find((sql) => sql.startsWith('SELECT n.operation_id'));
      assert.ok(claimSql);
      const queryPlan = db.prepare('EXPLAIN QUERY PLAN ' + claimSql).all(profileA, Date.now());
      const details = queryPlan.map((row) => String(row.detail)).join('\n');
      assert.match(details, /task_settlement_notices_profile_order/);
      assert.match(details, /task_settlement_delivery_state_due/);
      assert.doesNotMatch(details, /SCAN [nx]\b/);
      assert.equal(claimed?.binding.operationId, pendingDueOp);
      assert.equal(claimed?.state, 'SENDING');
      assert.equal(await store.tasks.settlements.claim(profileA), null);
      assert.equal(await store.tasks.settlements.hasUndelivered(profileA), true);
      assert.ok(claimed?.claimToken);
      await store.tasks.settlements.delivered(claimed.binding.operationId, claimed.claimToken, {
        binding: claimed.binding,
        resolution: claimed.resolution,
      });
      // A future retry remains undelivered, but cannot be claimed early.
      assert.equal(await store.tasks.settlements.claim(profileA), null);
      assert.equal(await store.tasks.settlements.hasUndelivered(profileA), true);
    } finally {
      db.close();
    }
  }));

test('WO47-4: AdmittedTaskRuntime coalesces onStartupSlotFreed once without infinite loop and applies STARTUP_BACKOFF as WAITING in TaskStepRunner', async () =>
  settlementFixture(async (store) => {
    await store.tasks.setSettings({ maxConcurrentProfiles: 10 });
    const profiles = Array.from({ length: 8 }, (_, i) => ({
      id: randomUUID(),
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: false,
      account: {
        state: 'logged-in' as const,
        id: '1009' + i,
        name: 'User' + i,
        avatar: null,
      },
    }));
    const combo = await store.createCombination({
      name: 'WO47-4 Startup Combo',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
    });
    await store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: combo.id,
        version: 1,
        profileIds: profiles.map((p) => p.id),
      },
      profiles,
    );

    let now = 10_000;
    let releases: (() => void)[] = [];
    let holdStartups = true;
    let shouldFailQueuedForFirst = false;
    const admitted = new Map<string, (typeof profiles)[0]>();

    const runtime = new AdmittedTaskRuntime(
      store.tasks,
      store.taskTabs,
      store.tasks.settlements,
      store.taskControls,
      {
        profile: (id) => admitted.get(id) ?? null,
        observeQueued: async (planId) => {
          const plan = await store.tasks.get(planId);
          if (shouldFailQueuedForFirst && plan.profileId === profiles[0]!.id) {
            throw Error('KERNEL_PEER_NOT_IDLE');
          }
          if (holdStartups) await new Promise<void>((resolve) => releases.push(resolve));
          const found = profiles.find((p) => p.id === plan.profileId)!;
          const next = { ...found, dispatchAllowed: true };
          admitted.set(found.id, next);
          return next;
        },
        openClaimed: async () => {
          throw Error('UNUSED');
        },
        forget: (id) => {
          admitted.delete(id);
        },
        close: async () => {},
      },
      () => profiles,
      randomUUID,
      undefined,
      () => now,
    );

    let wakeCount = 0;
    runtime.setStartupSlotFreedHook(() => {
      wakeCount++;
    });

    try {
      // 1. Trigger 8 concurrent startups (MAX_CONCURRENT_STARTUPS = 6 -> 2 deferred)
      const batch = Promise.allSettled(profiles.map((p) => runtime.observe(p.id)));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(releases.length, 6);
      // Release all 6 simultaneously -> coalesces into a single wakeCount increment!
      const currentReleases = releases;
      releases = [];
      currentReleases.forEach((r) => r());
      await batch;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(wakeCount, 1);
      assert.equal(runtime.startupStatus().deferred, 0);

      // Subsequent startup that does not hit MAX_CONCURRENT_STARTUPS does NOT re-trigger wakeCount!
      const seventh = runtime.observe(profiles[6]!.id);
      await new Promise<void>((resolve) => setImmediate(resolve));
      releases.splice(0).forEach((r) => r());
      await seventh;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(wakeCount, 1);

      // 2. Test startup failure backoff on profile 0 and WAITING integration in TaskStepRunner
      admitted.delete(profiles[0]!.id);
      holdStartups = false;
      shouldFailQueuedForFirst = true;
      await assert.rejects(runtime.observe(profiles[0]!.id), /KERNEL_PEER_NOT_IDLE/);
      // During 1.5s backoff window, observe rejects with STARTUP_BACKOFF
      now += 500;
      await assert.rejects(runtime.observe(profiles[0]!.id), /^Error: STARTUP_BACKOFF$/);

      const runner = new TaskStepRunner(
        store.tasks,
        store.browseIntents,
        store.taskTabs,
        runtime,
        [
          {
            type: 'feed',
            available: () => true,
            decide: async () => ({
              kind: 'wait',
              reason: 'FACEBOOK_BROWSE_WAITING',
            }),
            verify: async (_e, op) => ({
              outcome: 'VERIFIED',
              receipt: { binding: op.binding, evidence: {} },
              effect: { kind: 'auxiliary', purpose: 'advance', observed: true },
            }),
          },
        ],
        { nowMilliseconds: () => now },
        randomUUID,
      );
      try {
        const results = await runner.tick();
        const firstResult = results.find((r) => r.profileId === profiles[0]!.id);
        assert.equal(firstResult?.status, 'WAITING');
        assert.equal(firstResult?.reason, 'STARTUP_BACKOFF');
        const plan0 = (await store.tasks.plansForProfile(profiles[0]!.id))[0]!;
        assert.equal(plan0.state, 'QUEUED');
        assert.equal(plan0.reason, 'STARTUP_BACKOFF');
      } finally {
        await runner.close();
      }
    } finally {
      holdStartups = false;
      releases.splice(0).forEach((release) => release());
      await runtime.close();
    }
  }));

test('WO47-5: KernelLease and ExtensionKernelChannel report specific KERNEL_LEASE_REJECTED sub-reasons, and withSummary releases fixture owner without core.stop only on deterministic open rejections', async () => {
  const profileId = randomUUID();
  const epoch = randomUUID();
  const lease = new KernelLease(profileId, epoch, () => 1000);
  const stamp = {
    profileId,
    connectionEpoch: epoch,
    leaseId: randomUUID(),
    generation: 2,
    expiresAt: 60_000,
  };
  assert.throws(
    () => lease.grant({ ...stamp, profileId: randomUUID() }),
    /KERNEL_LEASE_REJECTED:profile_mismatch/,
  );
  assert.throws(
    () => lease.grant({ ...stamp, connectionEpoch: randomUUID() }),
    /KERNEL_LEASE_REJECTED:epoch_mismatch/,
  );
  lease.grant(stamp);
  assert.throws(
    () => lease.grant({ ...stamp, generation: 1 }),
    /KERNEL_LEASE_REJECTED:generation_regression/,
  );
  lease.revoke();
  assert.throws(
    () => lease.grant({ ...stamp, generation: 2 }),
    /KERNEL_LEASE_REJECTED:revoked_revision/,
  );

  // ExtensionKernelChannel lease_id_mismatch sub-reason
  const replies: Record<string, unknown>[] = [];
  const channel = new ExtensionKernelChannel(
    () => ({ profileId, epoch, valid: true }),
    (msg) => replies.push(msg as Record<string, unknown>),
  );
  channel.receive({
    type: 'KERNEL_REQUEST',
    requestId: randomUUID(),
    sequence: 1,
    connectionEpoch: epoch,
    leaseId: randomUUID(),
    kind: 'open',
    stamp,
    files: [],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(replies[0]?.error, 'KERNEL_LEASE_REJECTED:lease_id_mismatch');

  // Each failure owns a fresh connection. Unknown opens must retain their stop fence,
  // so they must not be reused as if a different SDK session had been confirmed idle.
  for (const scenario of [
    { error: 'KERNEL_LEASE_REJECTED:epoch_mismatch', globalStops: 0 },
    { error: 'KERNEL_ALREADY_OPEN_OR_REVIEW_REQUIRED', globalStops: 1 },
    { error: 'KERNEL_RPC_RESULT_UNKNOWN', globalStops: 1 },
    { error: 'SUMMARY_WORK_FAILED', globalStops: 0, opened: true },
  ]) {
    const bridgeStore = new BridgeStore(':memory:');
    const core = new Core(bridgeStore);
    const bridge = new KernelBridge(core, new WatchTasks(core));
    const callbacks: Promise<unknown>[] = [];
    const defer = (work: () => unknown) => {
      callbacks.push(new Promise((resolve) => setImmediate(() => resolve(work()))));
    };
    let stopCalled = 0;
    const originalStop = core.stop.bind(core);
    core.stop = async (id) => {
      stopCalled++;
      return originalStop(id);
    };
    const peer = core.connect(
      profileId,
      (message) => {
        const msg = KernelJsonObject.parse(message);
        if (msg.type === 'KERNEL_REQUEST' && (msg.kind === 'open' || msg.kind === 'stop')) {
          defer(() =>
            bridge.message(peer, {
              type: 'KERNEL_REPLY',
              requestId: msg.requestId,
              connectionEpoch: peer.epoch,
              leaseId: msg.leaseId,
              ...(msg.kind === 'stop'
                ? { result: { state: 'stopped', requestId: msg.requestId } }
                : scenario.opened
                  ? { result: { opened: true } }
                  : { error: scenario.error }),
            }),
          );
        } else if (msg.type === 'STOP') {
          defer(() => core.stopped(peer, String(msg.requestId ?? '')));
        }
      },
      () => {},
    );
    peer.phase = 'PAUSED';
    peer.synced = true;
    peer.capabilities = ['kernel-journal-v1', 'kernel-unknown-end-v1'];
    try {
      await assert.rejects(
        bridge.withSummary(peer, async () => {
          if (scenario.opened) throw Error(scenario.error);
          assert.fail('A rejected open must not run summary work');
        }),
        (error: unknown) => error instanceof Error && error.message === scenario.error,
      );
      assert.equal(stopCalled, scenario.globalStops);
      await Promise.all(callbacks);
      if (scenario.globalStops === 0) {
        await core.claimFixtureKernel(peer, 'probe-owner');
        core.releaseFixtureKernel(peer, 'probe-owner');
      }
      if (scenario.error.startsWith('KERNEL_LEASE_REJECTED')) {
        assert.ok(
          bridge
            .diagnostics(profileId)
            .some((row) => row.event.startsWith('lease-rejected:epoch_mismatch:')),
        );
      }
    } finally {
      await Promise.all(callbacks);
      await bridge.close();
      await core.shutdown();
      bridgeStore.db.close();
    }
  }
});

const wo48TaskNotFound = (error: unknown) =>
  (error as { code?: unknown }).code === 'TASK_NOT_FOUND' ||
  String((error as Error).message).includes('TASK_NOT_FOUND');

test('WO48-1: schema v46 indexes are idempotent and indexed like deduplication stays exact per account and active status', async () =>
  settlementFixture(async (store, file) => {
    const fixture = prepareBound(store);
    const other = prepareBound(store);
    const reopened = await WorkspaceStore.open(file);
    reopened.close();
    const db = new DatabaseSync(file);
    try {
      assert.equal(
        (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        workspaceSchemaVersion,
      );
      for (const name of [
        'task_plans_account_id',
        'task_browse_intents_like_content',
        'task_events_notification_due',
      ])
        assert.ok(
          db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(name),
          name,
        );
      const insertOutbox = db.prepare(
        'INSERT INTO task_outbox(id,job_id,step_id,action,status,created_at,updated_at) SELECT ?,job_id,step_id,action,?,created_at,updated_at FROM task_outbox WHERE id=?',
      );
      const insertIntent = db.prepare(
        'INSERT INTO task_browse_intents(operation_id,job_id,step_id,body,created_at) VALUES(?,?,?,?,?)',
      );
      const add = (
        owner: ReturnType<typeof prepareBound>,
        status: string,
        intent: Record<string, unknown>,
      ) => {
        const id = randomUUID();
        insertOutbox.run(id, status, owner.binding.operationId);
        insertIntent.run(
          id,
          owner.plan.id,
          owner.step.id,
          JSON.stringify({ operationId: id, jobId: owner.plan.id, stepId: owner.step.id, intent }),
          1000,
        );
        return id;
      };
      const scope = (owner: ReturnType<typeof prepareBound>) => ({
        proof: {
          ownershipId: randomUUID(),
          profileId: owner.profile.id,
          browserSessionEpoch: randomUUID(),
          tabId: 42,
          targetId: 'wo48-target',
        },
        documentEpoch: 0,
        routeEpoch: 0,
      });
      const like = (owner: ReturnType<typeof prepareBound>, contentId: string) => ({
        kind: 'like',
        contentId,
        observedLikeCount: 0,
        observedLiked: false,
        ...scope(owner),
      });
      db.exec('BEGIN');
      try {
        for (let i = 0; i < 400; i++)
          add(fixture, 'VERIFIED', { kind: 'auxiliary', purpose: 'advance', ...scope(fixture) });
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      // Free the one-pending-operation-per-job slot held by each fixture operation.
      db.prepare("UPDATE task_outbox SET status='FAILED' WHERE id IN (?,?)").run(
        fixture.binding.operationId,
        other.binding.operationId,
      );
      const accountId = fixture.profile.account.id;
      assert.ok(accountId);
      for (const status of ['DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN', 'VERIFIED']) {
        const contentId = 'wo48-' + status.toLowerCase();
        const id = add(fixture, status, like(fixture, contentId));
        assert.equal(store.browseIntents.hasAccountLiked(accountId, contentId), true, status);
        assert.equal(store.browseIntents.hasAccountLiked(accountId, contentId + '-x'), false);
        db.prepare("UPDATE task_outbox SET status='FAILED' WHERE id=?").run(id);
        assert.equal(store.browseIntents.hasAccountLiked(accountId, contentId), false, status);
      }
      // A like by another account never blocks this account.
      add(other, 'VERIFIED', like(other, 'wo48-shared'));
      assert.equal(store.browseIntents.hasAccountLiked(accountId, 'wo48-shared'), false);
      assert.equal(
        store.browseIntents.hasAccountLiked(other.profile.account.id, 'wo48-shared'),
        true,
      );
      assert.equal(store.browseIntents.hasAccountLiked(null, 'wo48-shared'), false);
      const plan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT i.body FROM task_browse_intents i JOIN task_outbox o ON o.id=i.operation_id JOIN task_plans p ON p.id=i.job_id WHERE p.account_id=? AND json_extract(i.body, '$.intent.kind')='like' AND json_extract(i.body, '$.intent.contentId')=? AND o.status IN ('DISPATCHING','ACKNOWLEDGED','UNKNOWN','VERIFIED')",
        )
        .all(accountId, 'wo48-shared')
        .map((row) => String(row.detail))
        .join('\n');
      assert.match(plan, /task_plans_account_id/);
      assert.match(plan, /task_browse_intents_like_content/);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      db.close();
    }
  }));

test('WO48-2: terminal notification query keeps identical results with thousands of CHECKPOINT events', async () =>
  settlementFixture(async (store, file) => {
    const fixture = prepareBound(store);
    const db = new DatabaseSync(file);
    try {
      const insert = db.prepare(
        'INSERT INTO task_events(job_id,type,detail,created_at) VALUES(?,?,?,?)',
      );
      db.exec('BEGIN');
      try {
        for (let i = 0; i < 2000; i++) {
          insert.run(fixture.plan.id, 'CHECKPOINT', JSON.stringify({ i }), 2000 + i);
          if (i % 400 === 0)
            insert.run(fixture.plan.id, i % 800 ? 'FAILED' : 'COMPLETED', '{}', 2000 + i);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      const expected = (after: number) =>
        db
          .prepare(
            "SELECT sequence,type FROM task_events NOT INDEXED WHERE sequence>? AND type IN ('FAILED','COMPLETED') ORDER BY sequence LIMIT 100",
          )
          .all(after)
          .map((row) => ({ sequence: Number(row.sequence), type: String(row.type) }));
      const all = expected(0);
      assert.equal(all.length, 5);
      for (const after of [0, all[0]!.sequence, all[2]!.sequence, all.at(-1)!.sequence])
        assert.deepEqual(store.taskNotificationEvents(after), expected(after));
      const plan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT sequence,type FROM task_events WHERE sequence>? AND type IN ('FAILED','COMPLETED') ORDER BY sequence LIMIT 100",
        )
        .all(0)
        .map((row) => String(row.detail))
        .join('\n');
      assert.match(plan, /task_events_notification_due/);
      // CHECKPOINT history is preserved, never pruned by the optimization.
      assert.ok(
        Number(
          db
            .prepare("SELECT count(*) AS n FROM task_events WHERE type='CHECKPOINT' AND job_id=?")
            .get(fixture.plan.id)?.n,
        ) >= 2000,
      );
    } finally {
      db.close();
    }
  }));

test('WO48-3: batchTimingCache is bounded, bypassed in uncommitted transactions, and existence checks bypass stale plan caches', async () =>
  settlementFixture(async (store, file) => {
    assert.equal(persistenceRoutes.has('workspace.tasks.ensurePlanExists'), true);
    const fixture = prepareBound(store);
    const jobId = fixture.plan.id;
    const loaded = store.tasks.get(jobId);
    const cache = Reflect.get(store.tasks, 'batchTimingCache') as Map<string, unknown>;
    assert.ok(cache instanceof Map);
    assert.equal(cache.has(loaded.batchId), true);
    for (let i = 0; i < 1100; i++) cache.set('wo48-synthetic-' + i, cache.get(loaded.batchId));
    cache.delete(loaded.batchId);
    store.tasks.get(jobId);
    assert.equal(cache.size, 1024);
    assert.equal(cache.has(loaded.batchId), true);
    store.tasks.invalidateBatchTimingCache(loaded.batchId);
    assert.equal(cache.has(loaded.batchId), false);
    const db = Reflect.get(store, 'db') as DatabaseSync;
    db.exec('BEGIN');
    try {
      store.tasks.get(jobId);
      assert.equal(cache.has(loaded.batchId), false);
    } finally {
      db.exec('ROLLBACK');
    }
    assert.equal(cache.has(loaded.batchId), false);
    store.tasks.get(jobId);
    assert.equal(cache.has(loaded.batchId), true);
    // Steps/events/forPlan still succeed for an existing plan.
    assert.ok(store.tasks.steps(jobId).length > 0);
    assert.ok(store.tasks.events(jobId).length > 0);
    store.taskTabs.forPlan(jobId);
    // Delete the plan out of band while planRowCache still holds it.
    const external = new DatabaseSync(file);
    try {
      external.exec('PRAGMA foreign_keys=OFF');
      external.prepare('DELETE FROM task_plans WHERE id=?').run(jobId);
    } finally {
      external.close();
    }
    assert.throws(() => store.tasks.ensurePlanExists(jobId), wo48TaskNotFound);
    assert.throws(() => store.tasks.steps(jobId), wo48TaskNotFound);
    assert.throws(() => store.tasks.steps(jobId, 1), wo48TaskNotFound);
    assert.throws(() => store.tasks.events(jobId), wo48TaskNotFound);
    assert.throws(() => store.tasks.endingId(jobId), wo48TaskNotFound);
    assert.throws(() => store.taskTabs.forPlan(jobId), wo48TaskNotFound);
  }));

test('WO48-4: ProfileActor reconciliation subset reads produce identical readiness to the full settlement list', async () =>
  settlementFixture(async (store, file) => {
    assert.equal(persistenceRoutes.has('workspace.tasks.settlements.listForReconciliation'), true);
    const fixture = prepareBound(store);
    const profileId = fixture.profile.id;
    const db = new DatabaseSync(file);
    const copy = (status = 'VERIFIED') => {
      const id = randomUUID();
      const binding = { ...fixture.binding, operationId: id };
      db.prepare(
        'INSERT INTO task_outbox(id,job_id,step_id,action,status,receipt,checkpoint_applied,created_at,updated_at) SELECT ?,job_id,step_id,action,?,?,1,created_at,updated_at FROM task_outbox WHERE id=?',
      ).run(id, status, JSON.stringify({ binding, evidence: {} }), fixture.binding.operationId);
      db.prepare(
        'INSERT INTO task_dispatch_bindings(operation_id,body,created_at) VALUES(?,?,?)',
      ).run(id, JSON.stringify(binding), 1000);
      return binding;
    };
    const notice = (
      binding: ReturnType<typeof copy>,
      outcome: 'VERIFIED' | 'NOT_APPLIED',
      state: 'PENDING' | 'DELIVERED',
      at: number,
    ) => {
      const resolution = { id: randomUUID(), outcome, evidenceDigest: 'a'.repeat(64) };
      db.prepare(
        "INSERT INTO task_settlement_notices(operation_id,kind,profile_id,body,created_at) VALUES(?,'BUSINESS',?,?,?)",
      ).run(binding.operationId, profileId, JSON.stringify({ binding, resolution }), at);
      db.prepare(
        "INSERT INTO task_settlement_delivery(operation_id,kind,state,claim_token,attempts,next_attempt_at,reason,updated_at) VALUES(?,'BUSINESS',?,NULL,1,?,'WO48',?)",
      ).run(binding.operationId, state, Date.now() + 3_600_000, at);
      return resolution;
    };
    let reconciled!: { binding: ReturnType<typeof copy>; resolution: ReturnType<typeof notice> };
    let mismatch!: ReturnType<typeof copy>;
    let pending!: ReturnType<typeof copy>;
    try {
      db.exec('BEGIN');
      try {
        const history: {
          binding: ReturnType<typeof copy>;
          resolution: ReturnType<typeof notice>;
        }[] = [];
        for (let i = 0; i < 300; i++) {
          const binding = copy();
          history.push({ binding, resolution: notice(binding, 'VERIFIED', 'DELIVERED', 1000 + i) });
        }
        reconciled = history[150]!;
        mismatch = copy();
        notice(mismatch, 'VERIFIED', 'DELIVERED', 2000);
        pending = copy();
        notice(pending, 'VERIFIED', 'PENDING', 2001);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      db.close();
    }
    const orphan = { ...fixture.binding, operationId: randomUUID() };
    const journal: KernelState = {
      version: 1,
      profileId,
      browserSessionEpoch: randomUUID(),
      operations: [
        {
          binding: reconciled.binding,
          state: 'RECONCILED',
          reason: '',
          resolution: reconciled.resolution,
        },
        {
          binding: mismatch,
          state: 'RECONCILED',
          reason: '',
          resolution: { id: randomUUID(), outcome: 'NOT_APPLIED', evidenceDigest: 'b'.repeat(64) },
        },
        { binding: orphan, state: 'UNKNOWN', reason: 'WORKER_RESTART', resolution: null },
        { binding: fixture.binding, state: 'DISPATCHING', reason: '', resolution: null },
      ],
      tabs: [],
    };
    const settlements = store.tasks.settlements;
    const subsetCalls: number[] = [];
    const subset = {
      list: (id?: string) => settlements.list(id),
      listForReconciliation: (id: string, ids: readonly string[]) => {
        const rows = settlements.listForReconciliation(id, ids);
        subsetCalls.push(rows.length);
        return rows;
      },
      claim: (id: string) => settlements.claim(id),
      delivered: settlements.delivered.bind(settlements),
      retry: settlements.retry.bind(settlements),
      recoverOnStartup: () => settlements.recoverOnStartup(),
    };
    const full = {
      list: (id?: string) => settlements.list(id),
      claim: (id: string) => settlements.claim(id),
      delivered: settlements.delivered.bind(settlements),
      retry: settlements.retry.bind(settlements),
      recoverOnStartup: () => settlements.recoverOnStartup(),
    };
    const port = {
      profileId,
      notify: async () => {
        throw Error('WO48_NOTIFY_NOT_EXPECTED');
      },
      profile: () => fixture.profile,
      current: () => ({
        profileId,
        accountId: fixture.binding.accountId,
        connectionEpoch: fixture.binding.connectionEpoch,
        leaseId: fixture.binding.leaseId,
        generation: fixture.binding.generation,
      }),
      inventory: async () => structuredClone(journal),
    };
    const observe = async (repository: typeof subset | typeof full) => {
      const actor = new ProfileActor(port, store.tasks, repository);
      await actor.observe();
      const status = await actor.status();
      return { state: status.state, reason: status.reason, issues: status.issues };
    };
    const fast = await observe(subset);
    const slow = await observe(full);
    assert.deepEqual(fast, slow);
    assert.equal(fast.state, 'BLOCKED');
    const reasons = new Set(fast.issues.map((issue) => issue.reason));
    assert.ok(reasons.has('ORPHAN_OPERATION'), JSON.stringify(fast.issues));
    assert.ok(reasons.has('REMOTE_RESULT_MISMATCH') || reasons.has('NOTICE_PENDING'));
    assert.ok(subsetCalls.length >= 1);
    const fullCount = settlements.list(profileId).length;
    assert.ok(subsetCalls.every((count) => count < fullCount));
    // Raw subset semantics: undelivered rows plus explicitly requested operations, in list order.
    const ids: string[] = [mismatch.operationId, reconciled.binding.operationId];
    assert.deepEqual(
      settlements.listForReconciliation(profileId, ids),
      settlements
        .list(profileId)
        .filter((row) => row.state !== 'DELIVERED' || ids.includes(row.binding.operationId)),
    );
    assert.deepEqual(
      settlements.listForReconciliation(profileId, []),
      settlements.list(profileId).filter((row) => row.state !== 'DELIVERED'),
    );
    assert.ok(pending.operationId);
  }));

test('WO48-5: KernelJournal snapshots are isolated copies, revisions guard inventory reads, and write failure stays unhealthy', async () => {
  const profileId = randomUUID();
  const epoch = randomUUID();
  let failWrite = false;
  let persisted: unknown;
  const journal = new KernelJournal({
    read: async () => persisted,
    write: async (state) => {
      if (failWrite) throw Error('WO48_STORAGE_WRITE_FAILED');
      persisted = structuredClone(state);
    },
  });
  await journal.initialize(profileId, epoch);
  const ownershipId = randomUUID();
  await journal.prepareTab(ownershipId, 'https://www.facebook.com/');
  const proof = {
    ownershipId,
    profileId,
    browserSessionEpoch: epoch,
    tabId: 7,
    targetId: 'wo48-target',
  };
  await journal.confirmTab(proof);
  const revision = journal.currentRevision;
  assert.ok(revision >= 3);
  const mutable = await journal.snapshot();
  mutable.tabs[0]!.state = 'CLOSED';
  mutable.tabs.push({ ...mutable.tabs[0]!, ownershipId: randomUUID() });
  const clean = await journal.snapshot();
  assert.equal(clean.tabs.length, 1);
  assert.equal(clean.tabs[0]!.state, 'READY');
  assert.equal(journal.currentRevision, revision);
  await journal.tabState(randomUUID(), 'LOST', 'x').catch(() => {});
  assert.equal(journal.currentRevision, revision, 'rejected mutation must not bump revision');

  const binding = {
    profileId,
    accountId: '10001',
    connectionEpoch: randomUUID(),
    leaseId: randomUUID(),
    generation: 1,
    operationId: randomUUID(),
    jobId: randomUUID(),
    stepId: randomUUID(),
    actionDigest: 'b'.repeat(64),
  };
  const previousChrome = Reflect.get(globalThis, 'chrome');
  let raced = false;
  Reflect.set(globalThis, 'chrome', {
    tabs: {
      query: async () => {
        if (!raced) {
          raced = true;
          await journal.begin(binding);
        }
        return [{ id: 7 }];
      },
    },
    debugger: { getTargets: async () => [] },
  });
  try {
    const backend = new ChromeKernelBackend(
      journal,
      () => false,
      'facebook-task',
      () => true,
    );
    const observed = (await backend.inventory()) as KernelState;
    assert.equal(raced, true);
    assert.deepEqual(
      observed.operations.map((row) => row.binding.operationId),
      [binding.operationId],
    );
    assert.equal(journal.currentRevision, revision + 1);
  } finally {
    Reflect.set(globalThis, 'chrome', previousChrome);
  }

  failWrite = true;
  await assert.rejects(journal.finish(binding, 'ACKNOWLEDGED'), /WO48_STORAGE_WRITE_FAILED/);
  assert.equal(journal.writable, false);
  // WO48-A: a failed write also advances the revision so every earlier snapshot is stale.
  assert.equal(journal.currentRevision, revision + 2);
  await assert.rejects(journal.snapshot(), /KERNEL_JOURNAL_NOT_READY/);
});

const wo48aJournal = async () => {
  const profileId = randomUUID();
  const epoch = randomUUID();
  const control = { failWrite: false };
  let persisted: unknown;
  const journal = new KernelJournal({
    read: async () => persisted,
    write: async (state) => {
      if (control.failWrite) throw Error('WO48A_STORAGE_WRITE_FAILED');
      persisted = structuredClone(state);
    },
  });
  await journal.initialize(profileId, epoch);
  const fail = async () => {
    control.failWrite = true;
    await assert.rejects(
      journal.prepareTab(randomUUID(), 'https://www.facebook.com/'),
      /WO48A_STORAGE_WRITE_FAILED/,
    );
  };
  return { journal, profileId, epoch, fail };
};
const wo48aBackend = (journal: KernelJournal) =>
  new ChromeKernelBackend(
    journal,
    () => false,
    'facebook-task',
    () => true,
  );
const wo48aWithChrome = async (chromeMock: unknown, work: () => Promise<void>) => {
  const previous = Reflect.get(globalThis, 'chrome');
  Reflect.set(globalThis, 'chrome', chromeMock);
  try {
    await work();
  } finally {
    Reflect.set(globalThis, 'chrome', previous);
  }
};

test('WO48-A R48-1: inventory after a failed journal write rejects instead of returning the old READY snapshot', async () => {
  const { journal, fail } = await wo48aJournal();
  await wo48aWithChrome(
    {
      tabs: { query: async () => [] },
      debugger: { getTargets: async () => [] },
      storage: { local: { get: async () => ({}) } },
    },
    async () => {
      const backend = wo48aBackend(journal);
      // Healthy first: inventory succeeds.
      await backend.inventory();
      await fail();
      assert.equal(journal.writable, false);
      await assert.rejects(backend.inventory(), /KERNEL_JOURNAL_NOT_READY/);
    },
  );
});

test('WO48-A R48-1: a write failure while inventory awaits workspace storage rejects that same inventory call', async () => {
  const { journal, fail } = await wo48aJournal();
  let triggered = false;
  await wo48aWithChrome(
    {
      tabs: { query: async () => [] },
      debugger: { getTargets: async () => [] },
      storage: {
        local: {
          get: async () => {
            if (!triggered) {
              triggered = true;
              await fail();
            }
            return {};
          },
        },
      },
    },
    async () => {
      await assert.rejects(wo48aBackend(journal).inventory(), /KERNEL_JOURNAL_NOT_READY/);
      assert.equal(triggered, true);
    },
  );
});

test('WO48-A R48-1: a write failure while inventory awaits retained-tab queries rejects that same inventory call', async () => {
  const { journal, profileId, epoch, fail } = await wo48aJournal();
  const ownershipId = randomUUID();
  await journal.prepareTab(ownershipId, 'https://www.facebook.com/');
  await journal.confirmTab({
    ownershipId,
    profileId,
    browserSessionEpoch: epoch,
    tabId: 7,
    targetId: 'wo48a-target',
  });
  let triggered = false;
  await wo48aWithChrome(
    {
      tabs: {
        query: async () => {
          if (!triggered) {
            triggered = true;
            await fail();
          }
          return [{ id: 7 }];
        },
      },
      debugger: { getTargets: async () => [] },
    },
    async () => {
      // The READY retained tab forces inventory to await native queries after its snapshot.
      await assert.rejects(wo48aBackend(journal).inventory(), /KERNEL_JOURNAL_NOT_READY/);
      assert.equal(triggered, true);
    },
  );
});

const wo48aSchedule = async (
  store: WorkspaceStore,
  file: string,
  work: (input: {
    db: DatabaseSync;
    tasks: SqliteTaskRepository;
    clock: { now: number };
    assign: (count: number, timing?: { mode: 'at'; startAt: number; timeZone: string }) => Plan[];
    begins: () => number;
  }) => Promise<void> | void,
) => {
  const db = new DatabaseSync(file);
  const clock = { now: 10_000 };
  let beginCount = 0;
  const exec = db.exec.bind(db);
  db.exec = (sql: string) => {
    if (/^BEGIN/i.test(sql.trim())) beginCount++;
    return exec(sql);
  };
  const tasks = new SqliteTaskRepository(db, {
    id: randomUUID,
    now: () => clock.now,
    random: () => 0.5,
  });
  const row = await store.createCombination({
    name: 'WO48-A 定时',
    note: '',
    steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
  });
  let serial = 0;
  const assign = (count: number, timing?: { mode: 'at'; startAt: number; timeZone: string }) => {
    const profiles: RuntimeProfile[] = Array.from({ length: count }, () => ({
      id: randomUUID(),
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in', id: 'wo48a-' + serial++, name: null, avatar: null },
    }));
    return tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: row.id,
        version: 1,
        profileIds: profiles.map((p) => p.id),
        ...(timing ? { timing } : {}),
      },
      profiles,
    );
  };
  try {
    await work({ db, tasks, clock, assign, begins: () => beginCount });
  } finally {
    db.close();
  }
};

test('WO48-A R48-2: releaseScheduled with only waiting or untimed plans opens no write transaction and keeps caches warm', async () =>
  settlementFixture(async (store, file) =>
    wo48aSchedule(store, file, ({ tasks, assign, begins }) => {
      const waiting = assign(2, { mode: 'at', startAt: 50_000, timeZone: 'UTC' });
      const plain = assign(1);
      // Warm both caches.
      for (const plan of [...waiting, ...plain]) tasks.get(plan.id);
      tasks.livePlans();
      const planCache = Reflect.get(tasks, 'planRowCache') as Map<string, unknown>;
      const batchCache = Reflect.get(tasks, 'batchTimingCache') as Map<string, unknown>;
      const planKeys = [...planCache.keys()].sort();
      const batchKeys = [...batchCache.keys()].sort();
      assert.ok(planKeys.length >= 3);
      assert.ok(batchKeys.length >= 2);
      const before = begins();
      tasks.releaseScheduled();
      tasks.releaseScheduled();
      assert.equal(begins(), before, 'no write transaction for WAIT-only schedules');
      assert.deepEqual([...planCache.keys()].sort(), planKeys);
      assert.deepEqual([...batchCache.keys()].sort(), batchKeys);
      assert.ok(waiting.every((plan) => !tasks.get(plan.id).timingReleased));
    }),
  ));

test('WO48-A R48-2: one batch release updates every plan of that batch together and leaves unrelated batch caches intact', async () =>
  settlementFixture(async (store, file) =>
    wo48aSchedule(store, file, ({ db, tasks, clock, assign, begins }) => {
      const due = assign(3, { mode: 'at', startAt: 20_000, timeZone: 'UTC' });
      const later = assign(2, { mode: 'at', startAt: 90_000, timeZone: 'UTC' });
      const plain = assign(1);
      for (const plan of [...due, ...later, ...plain]) tasks.get(plan.id);
      const planCache = Reflect.get(tasks, 'planRowCache') as Map<string, unknown>;
      const batchCache = Reflect.get(tasks, 'batchTimingCache') as Map<string, unknown>;
      const dueBatch = due[0]!.batchId;
      const keptPlans = [...later, ...plain].map((plan) => plan.id);
      const keptBatches = [later[0]!.batchId, plain[0]!.batchId];
      assert.ok(keptBatches.every((id) => batchCache.has(id)));
      clock.now = 20_000;
      const before = begins();
      tasks.releaseScheduled();
      assert.equal(begins(), before + 1);
      assert.equal(
        Number(
          db.prepare("SELECT count(*) AS n FROM task_events WHERE type='SCHEDULE_RELEASED'").get()
            ?.n,
        ),
        1,
      );
      // Unrelated batches keep both caches; the released batch was invalidated.
      assert.ok(keptBatches.every((id) => batchCache.has(id)));
      assert.ok(keptPlans.every((id) => planCache.has(id)));
      assert.ok(due.every((plan) => !planCache.has(plan.id)));
      assert.ok(due.every((plan) => tasks.get(plan.id).timingReleased));
      assert.ok(due.every((plan) => tasks.get(plan.id).state === 'QUEUED'));
      assert.ok(later.every((plan) => !tasks.get(plan.id).timingReleased));
      assert.equal(batchCache.has(dueBatch), true, 're-read repopulates the released batch');
      // A second pass does not release again.
      tasks.releaseScheduled();
      assert.equal(
        Number(
          db.prepare("SELECT count(*) AS n FROM task_events WHERE type='SCHEDULE_RELEASED'").get()
            ?.n,
        ),
        1,
      );
    }),
  ));

test('WO48-A R48-2: a queued timed plan past its window fails with SCHEDULE_MISSED', async () =>
  settlementFixture(async (store, file) =>
    wo48aSchedule(store, file, ({ tasks, clock, assign }) => {
      const [missed] = assign(1, { mode: 'at', startAt: 40_000, timeZone: 'UTC' });
      assert.ok(missed);
      tasks.get(missed.id);
      clock.now = 100_001;
      tasks.releaseScheduled();
      const current = tasks.get(missed.id);
      assert.equal(current.state, 'FAILED');
      assert.equal(current.reason, 'SCHEDULE_MISSED');
      assert.equal(tasks.operations(missed.id).length, 0);
    }),
  ));

test('WO48-A R48-3: KernelBridge rejects malformed CDP events and forwards valid ones only through the validated model entry', async () => {
  const bridgeStore = new BridgeStore(':memory:');
  const core = new Core(bridgeStore);
  const bridge = new KernelBridge(core, new WatchTasks(core));
  const profileId = randomUUID();
  const peer = core.connect(
    profileId,
    () => {},
    () => {},
  );
  const leaseId = randomUUID();
  const calls: string[] = [];
  const forwarded: unknown[] = [];
  Reflect.get(bridge, 'sessions').set(profileId, {
    peer,
    stamp: { leaseId },
    model: {
      debuggerEvent: () => calls.push('unvalidated'),
      debuggerEventValidated: (_source: unknown, method: string, params: unknown) => {
        calls.push('validated:' + method);
        forwarded.push(params);
      },
    },
  });
  const base = {
    type: 'KERNEL_EVENT',
    connectionEpoch: peer.epoch,
    leaseId,
    source: { tabId: 1 },
    method: 'Page.frameNavigated',
  };
  try {
    for (const bad of [
      { ...base },
      { ...base, params: [1, 2] },
      { ...base, params: 'x' },
      { ...base, params: {}, extra: true },
    ])
      await assert.rejects(bridge.message(peer, bad));
    assert.deepEqual(calls, []);
    const params = { frame: { id: 'f1', url: 'https://www.facebook.com/' } };
    assert.equal(await bridge.message(peer, { ...base, params }), true);
    assert.deepEqual(calls, ['validated:Page.frameNavigated']);
    assert.deepEqual(forwarded, [params]);
  } finally {
    // The fake session is not a real RPC session; remove it before shutdown.
    Reflect.get(bridge, 'sessions').delete(profileId);
    await bridge.close();
    await core.shutdown();
    bridgeStore.db.close();
  }
});

test('WO48-A R48-3: the unvalidated model entry still rejects malformed params; the validated entry skips re-parsing', () => {
  const emitted: unknown[] = [];
  const model = Object.create(KernelRelayModel.prototype) as KernelRelayModel;
  Object.assign(model, {
    closed: false,
    executor: { acceptsEvent: () => true },
    tabs: new Map([[1, { sessionId: 'sdk-1' }]]),
    children: new Map(),
    initializedFrames: new Set(['sdk-1']),
    initialContextEvents: new Map(),
    trace: () => {},
    access: 'fixture',
    client: (message: unknown) => emitted.push(message),
  });
  for (const bad of [[1], 'text', 42])
    assert.throws(() => model.debuggerEvent({ tabId: 1 }, 'Runtime.consoleAPICalled', bad));
  assert.equal(emitted.length, 0);
  const original = KernelJsonObject.parse.bind(KernelJsonObject);
  let parses = 0;
  KernelJsonObject.parse = ((value: unknown) => {
    parses++;
    return original(value);
  }) as typeof KernelJsonObject.parse;
  try {
    const params = { args: [{ type: 'string', value: 'ok' }] };
    model.debuggerEventValidated({ tabId: 1 }, 'Runtime.consoleAPICalled', params);
    assert.equal(parses, 0);
    model.debuggerEvent({ tabId: 1 }, 'Runtime.consoleAPICalled', params);
    assert.equal(parses, 1);
  } finally {
    KernelJsonObject.parse = original;
  }
  assert.equal(emitted.length, 2);
});
