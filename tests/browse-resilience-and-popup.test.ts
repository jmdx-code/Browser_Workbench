import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { open as openYauzl, type Entry as YauzlEntry, type ZipFile as YauzlZipFile } from 'yauzl';
import { Window } from 'happy-dom';
import {
  buildDiagnosticFeedbackPackage,
  revealDiagnosticPackage,
} from '../src/infrastructure/diagnostic-package.js';
import {
  projectFacebookBrowsePage,
  FACEBOOK_BROWSE_DIALOG_DISMISS_CSS,
  FACEBOOK_BROWSE_LIKE_CSS,
  FACEBOOK_REEL_NEXT_CSS,
  type BrowsePage,
} from '../src/infrastructure/facebook-browse-reader.js';
import { FacebookBrowseStepExecutor } from '../src/infrastructure/facebook-browse-step-executor.js';
import { BrowseObservation } from '../src/shared/browse-execution.js';
import { BusinessResolution } from '../src/shared/settlement.js';
import { validateBrowseIntent } from '../src/domain/browse-policy.js';
import { taskAdmissionIssue } from '../src/shared/task-admission-issues.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { AdmittedTaskRuntime } from '../src/application/admitted-task-runtime.js';
import { TaskStepRunner } from '../src/application/task-step-runner.js';
import { TaskDispatcher } from '../src/application/task-dispatcher.js';
import { KernelJournal } from '../src/application/kernel-journal.js';
import { TaskService } from '../src/application/task-service.js';
import { navigateFacebookBoundPage } from '../src/infrastructure/facebook-bound-navigation.js';
import {
  isRecoverableBrowseFault,
  isSessionBreakingBrowseFault,
} from '../src/shared/browse-execution.js';
import { sameExecution, sameBinding } from '../src/shared/task-execution.js';
import { sameTabProof } from '../src/domain/task-tabs.js';
import type { BrowseStepExecutor, StepExecution } from '../src/domain/browse-execution.js';
import type { ManagedProfileSession, QueuedProfileFactory } from '../src/domain/profile-actor.js';
import type { RuntimeProfile } from '../src/domain/tasks.js';
import type { ExecutionSession } from '../src/shared/task-execution.js';
import type { KernelJsonObject } from '../src/shared/kernel-protocol.js';
import type { KernelState, TabProof } from '../src/shared/kernel-state.js';

function makeProof(
  profileId: `${string}-${string}-${string}-${string}-${string}` = randomUUID(),
): TabProof {
  return {
    profileId,
    ownershipId: randomUUID(),
    browserSessionEpoch: randomUUID(),
    tabId: 42,
    targetId: 'target-42',
  };
}

function makeExecution(
  type: 'video' | 'feed' = 'video',
  profileId: `${string}-${string}-${string}-${string}-${string}` = randomUUID(),
): StepExecution {
  const stepId = randomUUID();
  const stepSpec = {
    id: stepId,
    type,
    durationMinutes: 5,
    maxLikes: 2,
    minLikeCount: 10,
  };
  const plan: StepExecution['plan'] = {
    id: randomUUID(),
    batchId: randomUUID(),
    profileId,
    accountId: '1000001',
    combinationId: randomUUID(),
    version: 1,
    snapshot: {
      name: '日常活跃测试',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [stepSpec],
    },
    state: 'RUNNING',
    round: 1,
    position: 0,
    reason: '',
    controlMode: null,
    controlRequestId: null,
    controlConfirmed: false,
    createdAt: 1000,
    updatedAt: 1000,
  };
  const step: StepExecution['step'] = {
    id: stepId,
    jobId: plan.id,
    round: 1,
    position: 0,
    spec: stepSpec,
    status: 'ACTIVE',
    progress: {
      revision: 0,
      effectiveMilliseconds: 0,
      likes: 0,
      published: 0,
      cursor: null,
    },
  };
  const session: ExecutionSession = {
    profileId,
    accountId: '1000001',
    connectionEpoch: randomUUID(),
    leaseId: randomUUID(),
    generation: 0,
  };
  return { plan, step, session };
}

test('1. cross-route browse step navigates immediately to target route even when current page has a blocking dialog', async () => {
  const proof = makeProof();
  const execution = makeExecution(
    'video',
    proof.profileId as `${string}-${string}-${string}-${string}-${string}`,
  );
  const blockedHomePage: BrowsePage = {
    url: 'https://www.facebook.com/',
    timeOrigin: 100,
    ready: true,
    visible: true,
    blocked: true,
    scrollY: 0,
    viewportHeight: 800,
    contentKey: null,
    video: null,
  };
  const executor = new FacebookBrowseStepExecutor(
    'video',
    {
      read: async (_e, guard) => {
        await guard();
        return {
          context: execution.session,
          proof,
          page: structuredClone(blockedHomePage),
        };
      },
    },
    () => true,
    () => 1_000,
  );
  const decision = await executor.decide(execution, () => {});
  assert.equal(decision.kind, 'action');
  if (decision.kind !== 'action') throw Error('ACTION_REQUIRED');
  assert.deepEqual(decision.action, {
    kind: 'browseNavigate',
    tabId: proof.tabId,
    url: 'https://www.facebook.com/reels/',
  });
  assert.equal(decision.intent.kind, 'auxiliary');
  if (decision.intent.kind === 'auxiliary') {
    assert.equal(decision.intent.purpose, 'advance');
  }
  validateBrowseIntent(execution.step, decision.action, decision.intent);
});

test('2. blocking dialog on target route auto-detects safe dismiss button, validates policy, verifies dismissal, or refreshes after 12s', async () => {
  const win = new Window({
    url: 'https://www.facebook.com/reel/123456/',
    width: 1280,
    height: 800,
  });
  const doc = win.document;
  doc.body.innerHTML = `
    <div role="main" style="width:1200px;height:760px;opacity:1;">
      <video src="https://video.xx.fbcdn.net/v/t42/reel.mp4" style="width:400px;height:700px;opacity:1;"></video>
    </div>
    <div role="dialog" aria-modal="true" style="position:fixed;left:200px;top:120px;width:520px;height:360px;display:block;opacity:1;">
      <h2>账号通知提示</h2>
      <div role="button" id="danger-btn" style="width:120px;height:40px;opacity:1;">删除账号</div>
      <div role="button" id="dismiss-btn" aria-label="关闭" style="width:120px;height:40px;opacity:1;">以后再说</div>
    </div>
  `;
  for (const el of doc.querySelectorAll(
    '[role="dialog"], #danger-btn, #dismiss-btn, [role="main"]',
  )) {
    (el as unknown as HTMLElement).getBoundingClientRect = () =>
      ({
        left: 220,
        top: 150,
        right: 640,
        bottom: 420,
        width: 420,
        height: 270,
        x: 220,
        y: 150,
        toJSON: () => ({}),
      }) as DOMRect;
  }
  doc.elementFromPoint = () => doc.querySelector('#dismiss-btn')!;
  const globals = globalThis as Record<string, unknown>;
  const saved = {
    window: globals.window,
    document: globals.document,
    location: globals.location,
    innerWidth: globals.innerWidth,
    innerHeight: globals.innerHeight,
    scrollY: globals.scrollY,
    Element: globals.Element,
    HTMLElement: globals.HTMLElement,
    HTMLMediaElement: globals.HTMLMediaElement,
    HTMLVideoElement: globals.HTMLVideoElement,
    HTMLImageElement: globals.HTMLImageElement,
    HTMLAnchorElement: globals.HTMLAnchorElement,
    HTMLInputElement: globals.HTMLInputElement,
    getComputedStyle: globals.getComputedStyle,
  };
  try {
    globals.window = win;
    globals.document = doc;
    globals.location = win.location;
    globals.innerWidth = 1280;
    globals.innerHeight = 800;
    globals.scrollY = 0;
    globals.Element = win.Element;
    globals.HTMLElement = win.HTMLElement;
    globals.HTMLMediaElement = win.HTMLMediaElement;
    globals.HTMLVideoElement = win.HTMLVideoElement;
    globals.HTMLImageElement = win.HTMLImageElement;
    globals.HTMLAnchorElement = win.HTMLAnchorElement;
    globals.HTMLInputElement = win.HTMLInputElement;
    globals.getComputedStyle = win.getComputedStyle.bind(win);

    const projected = projectFacebookBrowsePage();
    assert.equal(projected.blocked, true);
    assert.equal(projected.dialogDismissCSS, FACEBOOK_BROWSE_DIALOG_DISMISS_CSS);
    assert.equal(
      doc.querySelector('#dismiss-btn')?.getAttribute('data-wb-browse-dialog-dismiss'),
      '1',
    );
    assert.equal(
      doc.querySelector('#danger-btn')?.getAttribute('data-wb-browse-dialog-dismiss'),
      null,
    );
  } finally {
    Object.assign(globals, saved);
  }

  const proof = makeProof();
  const execution = makeExecution(
    'video',
    proof.profileId as `${string}-${string}-${string}-${string}-${string}`,
  );
  let nowMs = 5_000;
  let currentSample: BrowsePage = {
    url: 'https://www.facebook.com/reel/123456/',
    timeOrigin: 100,
    ready: true,
    visible: true,
    blocked: true,
    scrollY: 0,
    viewportHeight: 800,
    contentKey: 'reel:123456',
    dialogDismissCSS: FACEBOOK_BROWSE_DIALOG_DISMISS_CSS,
    video: null,
  };
  const executor = new FacebookBrowseStepExecutor(
    'video',
    {
      read: async (_e, guard) => {
        await guard();
        return {
          context: execution.session,
          proof,
          page: structuredClone(currentSample),
        };
      },
    },
    () => true,
    () => nowMs,
  );

  const dismissDecision = await executor.decide(execution, () => {});
  assert.equal(dismissDecision.kind, 'action');
  if (dismissDecision.kind !== 'action') throw Error('DISMISS_ACTION_REQUIRED');
  assert.deepEqual(dismissDecision.action, {
    kind: 'click',
    tabId: proof.tabId,
    documentEpoch: 0,
    routeEpoch: 0,
    target: { css: FACEBOOK_BROWSE_DIALOG_DISMISS_CSS },
  });
  validateBrowseIntent(execution.step, dismissDecision.action, dismissDecision.intent);

  // Verify dismissal once blocked becomes false
  currentSample = { ...currentSample, blocked: false, dialogDismissCSS: null };
  const operationId = randomUUID();
  const binding = {
    ...execution.session,
    operationId,
    jobId: execution.plan.id,
    stepId: execution.step.id,
    actionDigest: createHash('sha256').update(JSON.stringify(dismissDecision.action)).digest('hex'),
  };
  const verdict = await executor.verify(
    execution,
    {
      id: operationId,
      jobId: execution.plan.id,
      stepId: execution.step.id,
      action: dismissDecision.action,
      binding,
      status: 'ACKNOWLEDGED',
      receipt: { binding, evidence: {} },
      checkpointApplied: false,
      createdAt: nowMs,
      updatedAt: nowMs,
    },
    dismissDecision.intent,
    () => {},
  );
  assert.equal(verdict.outcome, 'VERIFIED');

  // When blocked without dismiss button for >= 12s, it refreshes via browseNavigate instead of throwing 30s timeout
  currentSample = {
    ...currentSample,
    blocked: true,
    dialogDismissCSS: null,
  };
  const wait1 = await executor.decide(execution, () => {});
  assert.equal(wait1.kind, 'wait');
  nowMs += 12_500;
  const refreshDecision = await executor.decide(execution, () => {});
  assert.equal(refreshDecision.kind, 'action');
  if (refreshDecision.kind !== 'action') throw Error('REFRESH_ACTION_REQUIRED');
  assert.deepEqual(refreshDecision.action, {
    kind: 'browseNavigate',
    tabId: proof.tabId,
    url: 'https://www.facebook.com/reels/',
  });
});

test('3 & 4. browse task self-heals on KERNEL_DEBUGGER_DETACHED / target closed without UNKNOWN or PAUSING hang', async () => {
  const store = await WorkspaceStore.open(':memory:');
  const profileId = randomUUID();
  const raw: RuntimeProfile = {
    id: profileId,
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: false,
    account: { state: 'unknown', id: null, name: null, avatar: null },
  };
  const known: RuntimeProfile = {
    ...raw,
    dispatchAllowed: true,
    account: { state: 'logged-in', id: '10000099', name: '测试号', avatar: null },
  };
  const combo = store.createCombination({
    name: '日常刷视频自愈测试',
    note: '',
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
    steps: [{ id: randomUUID(), type: 'video', durationMinutes: 1, maxLikes: 1, minLikeCount: 10 }],
  });
  const [plan] = store.tasks.assign(
    {
      requestId: randomUUID(),
      combinationId: combo.id,
      version: combo.version,
      profileIds: [profileId],
    },
    [raw],
  );
  assert.ok(plan);

  let generation = 0;
  let admitted = false;
  let currentSession: ExecutionSession | null = null;
  let shouldFailSendWithDetach = false;
  let shouldFailStopWithDetach = false;
  const proof = makeProof(profileId);

  const makePort = (): ManagedProfileSession => {
    const ctx: ExecutionSession = {
      profileId,
      accountId: '10000099',
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: ++generation,
    };
    currentSession = ctx;
    const remote: KernelState = {
      version: 1,
      profileId,
      browserSessionEpoch: proof.browserSessionEpoch,
      operations: [],
      tabs: [
        {
          proof,
          ownershipId: proof.ownershipId,
          url: 'https://www.facebook.com/reels/',
          state: 'READY',
          reason: '',
        },
      ],
    };
    return {
      profileId,
      profile: () => known,
      current: () => currentSession,
      inventory: async () => structuredClone(remote),
      confirmTaskTab: async () => {},
      notify: async (b, r) => ({ binding: b, resolution: r }),
      setFailureHandler: () => {},
      sendGuarded: async (op) => {
        if (shouldFailSendWithDetach) {
          currentSession = null;
          throw Error('KERNEL_DEBUGGER_DETACHED');
        }
        return {
          binding: op.binding,
          evidence: { appliedAt: 1000 },
        };
      },
      stop: async (binding) => {
        currentSession = null;
        if (shouldFailStopWithDetach) {
          throw Error('KERNEL_DEBUGGER_DETACHED');
        }
        return { ...binding, state: 'stopped' };
      },
    };
  };

  const factory: QueuedProfileFactory = {
    profile: (id) => (admitted && id === profileId ? structuredClone(known) : null),
    observeQueued: async (id) => {
      assert.equal(id, plan.id);
      admitted = true;
      return structuredClone(known);
    },
    openClaimed: async () => {
      const port = makePort();
      const existing = store.taskTabs.forPlan(plan.id)[0];
      if (!existing) {
        store.taskTabs.register(plan.id, proof, currentSession!);
      } else {
        store.taskTabs.confirmObserved(
          proof.ownershipId,
          existing.revision,
          proof,
          currentSession!,
          plan.id,
        );
      }
      return port;
    },
    forget: () => {
      admitted = false;
    },
    close: async () => {
      admitted = false;
    },
  };

  const runtime = new AdmittedTaskRuntime(
    store.tasks,
    store.taskTabs,
    store.tasks.settlements,
    store.taskControls,
    factory,
    () => [raw],
    randomUUID,
  );

  let clockMs = 1_000;
  let videoTimeSeconds = 1;
  let decideAction = false;
  let decideThrow: string | null = null;
  const videoExecutor: BrowseStepExecutor = {
    type: 'video',
    available: () => true,
    decide: async () => {
      if (decideThrow) {
        const msg = decideThrow;
        decideThrow = null;
        throw Error(msg);
      }
      if (decideAction) {
        return {
          kind: 'action',
          action: {
            kind: 'browseNavigate',
            tabId: proof.tabId,
            url: 'https://www.facebook.com/reels/',
          },
          intent: {
            kind: 'auxiliary',
            purpose: 'advance',
            proof,
            documentEpoch: 0,
            routeEpoch: 0,
          },
        };
      }
      return {
        kind: 'observe',
        observation: {
          proof,
          documentEpoch: 0,
          routeEpoch: 0,
          type: 'video',
          contentId: 'a'.repeat(64),
          visible: true,
          ready: true,
          paused: false,
          buffering: false,
          timeSeconds: videoTimeSeconds,
          playbackRate: 1,
        },
      };
    },
    verify: async (_e, op) => ({
      outcome: 'VERIFIED',
      receipt: { binding: op.binding, evidence: {} },
      effect: { kind: 'auxiliary', purpose: 'advance', observed: true },
    }),
  };

  const runner = new TaskStepRunner(
    store.tasks,
    store.browseIntents,
    store.taskTabs,
    runtime,
    [videoExecutor],
    { nowMilliseconds: () => clockMs },
    randomUUID,
  );

  try {
    // 1. Admit and claim the plan (first observe)
    await runner.tick();
    assert.equal(store.tasks.get(plan.id).state, 'RUNNING');

    // 2. Trigger KERNEL_DEBUGGER_DETACHED during action dispatch
    decideAction = true;
    shouldFailSendWithDetach = true;
    const res1 = await runner.advance(plan.id);
    assert.equal(res1.status, 'WAITING');
    assert.equal(res1.reason, 'KERNEL_DEBUGGER_DETACHED');
    assert.equal(store.tasks.get(plan.id).state, 'RUNNING');
    assert.equal(
      store.tasks.operations(plan.id).some((op) => op.status === 'UNKNOWN'),
      false,
      'browse operation must never remain UNKNOWN on transient detach',
    );

    // 3. Next tick re-admits and re-opens a fresh session automatically and continues browsing!
    shouldFailSendWithDetach = false;
    decideAction = false;
    clockMs += 1_000;
    const [res2] = await runner.tick();
    assert.equal(res2?.status, 'OBSERVED');
    assert.equal(store.tasks.get(plan.id).state, 'RUNNING');
    assert.equal(generation, 2);

    // 4. Advance clock to credit effective time (resets consecutive self-heal counter)
    clockMs += 2_000;
    videoTimeSeconds = 3;
    await runner.advance(plan.id);
    assert.equal(store.tasks.steps(plan.id)[0]?.progress.effectiveMilliseconds, 2000);

    // 5. Trigger Target closed error during decide — stays RUNNING
    decideThrow = 'Target page, context or browser has been closed';
    const res3 = await runner.advance(plan.id);
    assert.equal(res3.status, 'WAITING');
    assert.equal(store.tasks.get(plan.id).state, 'RUNNING');

    // 6. When user or system pauses while port throws KERNEL_DEBUGGER_DETACHED on stop,
    // it completes immediately into PAUSED without hanging in PAUSING / STOP_UNCONFIRMED
    await runner.tick();
    shouldFailStopWithDetach = true;
    const paused = await runtime.control(plan.id, 'pause', 'USER_PAUSE');
    assert.equal(paused.state, 'PAUSED');
    assert.equal(paused.controlConfirmed, true);
    assert.equal((await runtime.registry.status()).length, 0);
  } finally {
    await runner.close();
    await runtime.close();
    store.close();
  }
});

test('5. WINDOW_LAYOUT_MAIN_CHANGED and FACEBOOK_TASK_DOCUMENT_READ_FAILED wait while FACEBOOK_TASK_DOCUMENT_SCOPE_CHANGED and FACEBOOK_ACCOUNT_* pause immediately', () => {
  for (const reason of ['WINDOW_LAYOUT_MAIN_CHANGED', 'FACEBOOK_TASK_DOCUMENT_READ_FAILED']) {
    const issue = taskAdmissionIssue(reason);
    assert.ok(issue, `expected admission issue for ${reason}`);
    assert.equal(issue.disposition, 'wait', `${reason} must wait and retry instead of pausing`);
  }
  for (const reason of [
    'FACEBOOK_TASK_DOCUMENT_SCOPE_CHANGED',
    'FACEBOOK_ACCOUNT_VERIFICATION_REQUIRED',
    'FACEBOOK_ACCOUNT_RESTRICTED',
    'FACEBOOK_ACCOUNT_LOGGED_OUT',
    'FACEBOOK_NATIVE_ACCOUNT_CHANGED',
    'FACEBOOK_NATIVE_ACCOUNT_MISMATCH',
  ]) {
    const issue = taskAdmissionIssue(reason);
    assert.ok(issue, `expected admission issue for ${reason}`);
    assert.equal(issue.disposition, 'pause', `${reason} must pause immediately`);
  }
});

test('Test A. continuous 1:1 wall-clock timing credits full elapsed time across observe, like click, verify wait, and next-reel switch without gaps', async () => {
  const store = await WorkspaceStore.open(':memory:');
  const profileId = randomUUID();
  const raw: RuntimeProfile = {
    id: profileId,
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: false,
    account: { state: 'unknown', id: null, name: null, avatar: null },
  };
  const known: RuntimeProfile = {
    ...raw,
    dispatchAllowed: true,
    account: { state: 'logged-in', id: '100000101', name: 'WallClock User', avatar: null },
  };

  const stepId = randomUUID();
  const combo = store.createCombination({
    name: '日常连续计时测试',
    note: '',
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
    steps: [
      {
        id: stepId,
        type: 'video',
        durationMinutes: 1,
        maxLikes: 2,
        minLikeCount: 10,
        likeProbability: 100,
      },
    ],
  });
  const [plan] = store.tasks.assign(
    {
      requestId: randomUUID(),
      combinationId: combo.id,
      version: combo.version,
      profileIds: [profileId],
    },
    [raw],
  );
  assert.ok(plan);

  const proof = makeProof(profileId);
  let currentSession: ExecutionSession | null = null;
  let generation = 0;
  let admitted = false;

  const makePort = (): ManagedProfileSession => {
    const ctx: ExecutionSession = {
      profileId,
      accountId: '100000101',
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: ++generation,
    };
    currentSession = ctx;
    const remote: KernelState = {
      version: 1,
      profileId,
      browserSessionEpoch: proof.browserSessionEpoch,
      operations: [],
      tabs: [
        {
          proof,
          ownershipId: proof.ownershipId,
          url: 'https://www.facebook.com/reel/101/',
          state: 'READY',
          reason: '',
        },
      ],
    };
    return {
      profileId,
      profile: () => known,
      current: () => currentSession,
      inventory: async () => structuredClone(remote),
      confirmTaskTab: async () => {},
      notify: async (b, r) => {
        const record = remote.operations.find((op) => op.binding.operationId === b.operationId);
        if (record) {
          record.state = 'RECONCILED';
          record.resolution = BusinessResolution.parse(r);
        }
        return { binding: b, resolution: r };
      },
      setFailureHandler: () => {},
      sendGuarded: async (op) => {
        remote.operations.push({
          binding: op.binding,
          state: 'ACKNOWLEDGED',
          reason: 'mock-input',
          resolution: null,
        });
        return {
          binding: op.binding,
          evidence: { appliedAt: 1000 },
        };
      },
      stop: async (binding) => {
        currentSession = null;
        return { ...binding, state: 'stopped' };
      },
    };
  };

  const factory: QueuedProfileFactory = {
    profile: (id) => (admitted && id === profileId ? structuredClone(known) : null),
    observeQueued: async () => {
      admitted = true;
      return structuredClone(known);
    },
    openClaimed: async () => {
      const port = makePort();
      const existing = store.taskTabs.forPlan(plan.id)[0];
      if (!existing) {
        store.taskTabs.register(plan.id, proof, currentSession!);
      } else {
        store.taskTabs.confirmObserved(
          proof.ownershipId,
          existing.revision,
          proof,
          currentSession!,
          plan.id,
        );
      }
      return port;
    },
    forget: () => {
      admitted = false;
    },
    close: async () => {
      admitted = false;
    },
  };

  const runtime = new AdmittedTaskRuntime(
    store.tasks,
    store.taskTabs,
    store.tasks.settlements,
    store.taskControls,
    factory,
    () => [raw],
    randomUUID,
  );

  let clockMs = 1_000;
  let samplePage: BrowsePage = {
    url: 'https://www.facebook.com/reel/101/',
    timeOrigin: 100,
    ready: true,
    visible: true,
    blocked: false,
    scrollY: 0,
    viewportHeight: 800,
    contentKey: 'reel:101',
    recommendedDwellMs: 5000,
    nextReelCSS: FACEBOOK_REEL_NEXT_CSS,
    likeTarget: {
      css: FACEBOOK_BROWSE_LIKE_CSS,
      liked: false,
      likeCount: 50,
      sponsored: false,
      text: 'awesome reel',
    },
    video: {
      css: 'video',
      source: 'blob:reel-101',
      paused: false,
      buffering: false,
      ended: false,
      timeSeconds: 1,
      playbackRate: 1,
    },
  };

  const realVideoExecutor = new FacebookBrowseStepExecutor(
    'video',
    {
      read: async (exec, guard) => {
        await guard();
        return {
          context: exec.session,
          proof,
          page: structuredClone(samplePage),
        };
      },
    },
    () => true,
    () => clockMs,
    undefined,
    undefined,
    () => 0.1,
  );

  const runner = new TaskStepRunner(
    store.tasks,
    store.browseIntents,
    store.taskTabs,
    runtime,
    [realVideoExecutor],
    { nowMilliseconds: () => clockMs },
    randomUUID,
  );

  try {
    // Tick 1 at t=1000ms: claims plan and records baseline at 1000ms
    await runner.tick();
    assert.equal(store.tasks.steps(plan.id)[0]?.progress.effectiveMilliseconds, 0);

    // Tick 2 at t=3000ms (+2000ms): dwell >= 1600ms triggers like click action!
    // Even though it dispatches a click action, wall-clock 2000ms is credited!
    clockMs = 3_000;
    samplePage.video!.timeSeconds = 3;
    const r2 = await runner.advance(plan.id);
    assert.equal(r2.status, 'DISPATCHED');
    assert.equal(store.tasks.steps(plan.id)[0]?.progress.effectiveMilliseconds, 2_000);

    // Tick 3 at t=4000ms (+1000ms): like verify still pending (WAIT)
    clockMs = 4_000;
    samplePage.video!.timeSeconds = 4;
    const r3 = await runner.advance(plan.id);
    assert.equal(r3.status, 'WAITING');
    assert.equal(r3.reason, 'FACEBOOK_BROWSE_LIKE_EFFECT_PENDING');

    // Tick 4 at t=5000ms (+1000ms, total +2000ms since dispatch): like becomes VERIFIED!
    // Both the WAIT time and VERIFIED time are credited continuously (total = 4000ms, likes = 1)
    clockMs = 5_000;
    samplePage.likeTarget!.liked = true;
    samplePage.video!.timeSeconds = 5;
    const r4 = await runner.advance(plan.id);
    assert.equal(r4.status, 'VERIFIED');
    assert.equal(store.tasks.steps(plan.id)[0]?.progress.likes, 1);
    assert.equal(store.tasks.steps(plan.id)[0]?.progress.effectiveMilliseconds, 4_000);

    // Tick 5 at t=7000ms (+2000ms): dwell >= 5000ms triggers next-reel click action!
    clockMs = 7_000;
    samplePage.video!.timeSeconds = 1; // Even if short video looped back to 1s!
    const r5 = await runner.advance(plan.id);
    assert.equal(r5.status, 'DISPATCHED');
    assert.equal(store.tasks.steps(plan.id)[0]?.progress.effectiveMilliseconds, 6_000);

    // Tick 6 at t=8000ms (+1000ms): next reel loaded and verified!
    clockMs = 8_000;
    samplePage = {
      ...samplePage,
      url: 'https://www.facebook.com/reel/102/',
      contentKey: 'reel:102',
      likeTarget: {
        css: FACEBOOK_BROWSE_LIKE_CSS,
        liked: false,
        likeCount: 80,
        sponsored: false,
        text: 'second reel',
      },
      video: {
        ...samplePage.video!,
        source: 'blob:reel-102',
        timeSeconds: 0.5,
      },
    };
    const r6 = await runner.advance(plan.id);
    assert.equal(r6.status, 'VERIFIED');
    assert.equal(store.tasks.steps(plan.id)[0]?.progress.effectiveMilliseconds, 7_000);

    // Tick 7 at t=10000ms (+2000ms): pure observe on new reel credits +2000ms -> 9000ms total
    // (1000ms -> 10000ms = 9000ms 1:1 wall-clock with 0ms lost!)
    clockMs = 10_000;
    samplePage.video!.timeSeconds = 2.5;
    const r7 = await runner.advance(plan.id);
    assert.equal(r7.status, 'OBSERVED');
    assert.equal(store.tasks.steps(plan.id)[0]?.progress.effectiveMilliseconds, 9_000);
  } finally {
    await runner.close();
    await runtime.close();
    store.close();
  }
});

test('Test B. Reels like detection reads fiber.alternate and inner SVG computed/attribute blue color and scopes likeCount to the Reel action column', () => {
  const win = new Window({
    url: 'https://www.facebook.com/reel/888888/',
    width: 1280,
    height: 800,
  });
  const doc = win.document;
  doc.body.innerHTML = `
    <div role="main" id="main-root" style="width:1200px;height:760px;opacity:1;">
      <div id="unrelated-header" aria-label="99,999 likes" style="width:200px;height:30px;opacity:1;">99,999</div>
      <div id="reel-card" style="width:400px;height:700px;opacity:1;">
        <video id="active-vid" src="https://video.xx.fbcdn.net/v/t42/active.mp4" style="width:400px;height:700px;opacity:1;"></video>
        <div id="action-col" style="width:60px;height:200px;opacity:1;">
          <div role="button" id="reel-like-btn" aria-label="Like" style="width:48px;height:48px;opacity:1;">
            <svg id="like-svg" style="width:24px;height:24px;opacity:1;">
              <path id="like-path" fill="rgb(8, 102, 255)"></path>
            </svg>
          </div>
          <span id="reel-like-count" style="width:48px;height:20px;opacity:1;">245</span>
        </div>
      </div>
    </div>
  `;

  const setRect = (sel: string, rect: Partial<DOMRect>) => {
    const el = doc.querySelector(sel) as unknown as HTMLElement | null;
    if (!el) return;
    el.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 100,
        right: 500,
        bottom: 700,
        width: 400,
        height: 600,
        x: 100,
        y: 100,
        toJSON: () => ({}),
        ...rect,
      }) as DOMRect;
  };
  setRect('#main-root', { left: 0, top: 0, right: 1200, bottom: 760, width: 1200, height: 760 });
  setRect('#unrelated-header', {
    left: 20,
    top: 20,
    right: 220,
    bottom: 50,
    width: 200,
    height: 30,
  });
  setRect('#reel-card', { left: 300, top: 60, right: 700, bottom: 740, width: 400, height: 680 });
  setRect('#active-vid', { left: 300, top: 60, right: 700, bottom: 740, width: 400, height: 680 });
  setRect('#action-col', { left: 710, top: 400, right: 770, bottom: 600, width: 60, height: 200 });
  setRect('#reel-like-btn', {
    left: 716,
    top: 420,
    right: 764,
    bottom: 468,
    width: 48,
    height: 48,
  });
  setRect('#like-svg', { left: 728, top: 432, right: 752, bottom: 456, width: 24, height: 24 });
  setRect('#reel-like-count', {
    left: 716,
    top: 470,
    right: 764,
    bottom: 490,
    width: 48,
    height: 20,
  });

  const likeBtn = doc.querySelector('#reel-like-btn')!;
  const likeSvg = doc.querySelector('#like-svg')!;
  doc.elementFromPoint = () => likeBtn;

  // Attach React Fiber where initial mount fiber has selected: false,
  // while fiber.alternate (current root committed tree) has selected: true and FBNucleusLikeFilled24Icon.react
  const rootFiber: Record<string, unknown> = { stateNode: { current: null as unknown } };
  const oldBtnFiber: Record<string, unknown> = {
    type: { displayName: 'CometUFIReactButtonBase.react' },
    memoizedProps: { selected: false },
    return: rootFiber,
  };
  const altBtnFiber: Record<string, unknown> = {
    type: { displayName: 'CometUFIReactButtonBase.react' },
    memoizedProps: { selected: true },
    return: rootFiber,
    alternate: oldBtnFiber,
  };
  oldBtnFiber.alternate = altBtnFiber;
  (rootFiber.stateNode as Record<string, unknown>).current = altBtnFiber;
  Reflect.set(likeBtn, '__reactFiber$test1', oldBtnFiber);

  const oldIconFiber: Record<string, unknown> = {
    type: { displayName: 'FBNucleusLikeOutline24Icon.react' },
    memoizedProps: {},
    return: oldBtnFiber,
  };
  const altIconFiber: Record<string, unknown> = {
    type: { displayName: 'FBNucleusLikeFilled24Icon.react' },
    memoizedProps: {},
    return: altBtnFiber,
    alternate: oldIconFiber,
  };
  oldIconFiber.alternate = altIconFiber;
  Reflect.set(likeSvg, '__reactFiber$test1', oldIconFiber);

  const globals = globalThis as Record<string, unknown>;
  const saved = {
    window: globals.window,
    document: globals.document,
    location: globals.location,
    innerWidth: globals.innerWidth,
    innerHeight: globals.innerHeight,
    scrollY: globals.scrollY,
    Element: globals.Element,
    HTMLElement: globals.HTMLElement,
    HTMLMediaElement: globals.HTMLMediaElement,
    HTMLVideoElement: globals.HTMLVideoElement,
    HTMLImageElement: globals.HTMLImageElement,
    HTMLAnchorElement: globals.HTMLAnchorElement,
    HTMLInputElement: globals.HTMLInputElement,
    getComputedStyle: globals.getComputedStyle,
  };
  try {
    globals.window = win;
    globals.document = doc;
    globals.location = win.location;
    globals.innerWidth = 1280;
    globals.innerHeight = 800;
    globals.scrollY = 0;
    globals.Element = win.Element;
    globals.HTMLElement = win.HTMLElement;
    globals.HTMLMediaElement = win.HTMLMediaElement;
    globals.HTMLVideoElement = win.HTMLVideoElement;
    globals.HTMLImageElement = win.HTMLImageElement;
    globals.HTMLAnchorElement = win.HTMLAnchorElement;
    globals.HTMLInputElement = win.HTMLInputElement;
    globals.getComputedStyle = win.getComputedStyle.bind(win);

    const projected = projectFacebookBrowsePage();
    assert.ok(projected.likeTarget);
    assert.equal(projected.likeTarget.liked, true);
    assert.equal(projected.likeTarget.likeCount, 245);
  } finally {
    Object.assign(globals, saved);
  }
});

test('Test C. playbackRate: 0 is valid in BrowseObservation and ZodError in TaskStepRunner self-heals as FACEBOOK_BROWSE_SCHEMA_MISMATCH without pausing', async () => {
  const proof = makeProof();
  const parsed = BrowseObservation.safeParse({
    type: 'video',
    proof,
    documentEpoch: 0,
    routeEpoch: 0,
    contentId: 'v-zero-rate',
    visible: true,
    ready: true,
    paused: true,
    buffering: true,
    timeSeconds: 0,
    playbackRate: 0,
  });
  assert.equal(parsed.success, true);

  const store = await WorkspaceStore.open(':memory:');
  const profileId = randomUUID();
  const raw: RuntimeProfile = {
    id: profileId,
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: false,
    account: { state: 'unknown', id: null, name: null, avatar: null },
  };
  const known: RuntimeProfile = {
    ...raw,
    dispatchAllowed: true,
    account: { state: 'logged-in', id: '10000061', name: 'User 61', avatar: null },
  };

  const combo = store.createCombination({
    name: 'Schema容错测试',
    note: '',
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
    steps: [{ id: randomUUID(), type: 'video', durationMinutes: 5, maxLikes: 0, minLikeCount: 0 }],
  });
  const [plan] = store.tasks.assign(
    {
      requestId: randomUUID(),
      combinationId: combo.id,
      version: combo.version,
      profileIds: [profileId],
    },
    [raw],
  );
  assert.ok(plan);

  const tabProof = makeProof(profileId);
  let currentSession: ExecutionSession | null = null;
  let admitted = false;
  const factory: QueuedProfileFactory = {
    profile: (id) => (admitted && id === profileId ? structuredClone(known) : null),
    observeQueued: async () => {
      admitted = true;
      return structuredClone(known);
    },
    openClaimed: async () => {
      const ctx: ExecutionSession = {
        profileId,
        accountId: '10000061',
        connectionEpoch: randomUUID(),
        leaseId: randomUUID(),
        generation: 1,
      };
      currentSession = ctx;
      const existing = store.taskTabs.forPlan(plan.id)[0];
      if (!existing) store.taskTabs.register(plan.id, tabProof, ctx);
      else
        store.taskTabs.confirmObserved(
          tabProof.ownershipId,
          existing.revision,
          tabProof,
          ctx,
          plan.id,
        );
      return {
        profileId,
        profile: () => known,
        current: () => currentSession,
        inventory: async () => ({
          version: 1,
          profileId,
          browserSessionEpoch: tabProof.browserSessionEpoch,
          operations: [],
          tabs: [
            {
              proof: tabProof,
              ownershipId: tabProof.ownershipId,
              url: 'https://www.facebook.com/reels/',
              state: 'READY',
              reason: '',
            },
          ],
        }),
        confirmTaskTab: async () => {},
        notify: async (b, r) => ({ binding: b, resolution: r }),
        setFailureHandler: () => {},
        sendGuarded: async (op) => ({ binding: op.binding, evidence: { appliedAt: 1000 } }),
        stop: async (binding) => {
          currentSession = null;
          return { ...binding, state: 'stopped' };
        },
      };
    },
    forget: () => {
      admitted = false;
    },
    close: async () => {
      admitted = false;
    },
  };

  const runtime = new AdmittedTaskRuntime(
    store.tasks,
    store.taskTabs,
    store.tasks.settlements,
    store.taskControls,
    factory,
    () => [raw],
    randomUUID,
  );

  let throwZod = false;
  const executor: BrowseStepExecutor = {
    type: 'video',
    available: () => true,
    decide: async () => {
      if (throwZod) {
        throwZod = false;
        const err = new Error('[\n  {\n    "code": "too_small"\n  }\n]');
        err.name = 'ZodError';
        throw err;
      }
      return {
        kind: 'observe',
        observation: {
          proof: tabProof,
          documentEpoch: 0,
          routeEpoch: 0,
          type: 'video',
          contentId: 'b'.repeat(64),
          visible: true,
          ready: true,
          paused: false,
          buffering: false,
          timeSeconds: 1,
          playbackRate: 1,
        },
      };
    },
    verify: async (_e, op) => ({
      outcome: 'VERIFIED',
      receipt: { binding: op.binding, evidence: {} },
      effect: { kind: 'auxiliary', purpose: 'advance', observed: true },
    }),
  };

  const runner = new TaskStepRunner(
    store.tasks,
    store.browseIntents,
    store.taskTabs,
    runtime,
    [executor],
    { nowMilliseconds: () => 1000 },
    randomUUID,
  );

  try {
    await runner.tick();
    assert.equal(store.tasks.get(plan.id).state, 'RUNNING');

    throwZod = true;
    const res = await runner.advance(plan.id);
    assert.equal(res.status, 'WAITING');
    assert.equal(res.reason, 'FACEBOOK_BROWSE_SCHEMA_MISMATCH');
    assert.equal(store.tasks.get(plan.id).state, 'RUNNING');
  } finally {
    await runner.close();
    await runtime.close();
    store.close();
  }
});

test('Test D. video memory cleanup frees partially-visible passed videos and triggers soft refresh when scrollY >= 15000', async () => {
  const win = new Window({
    url: 'https://www.facebook.com/reel/55555/',
    width: 1280,
    height: 800,
  });
  const doc = win.document;
  doc.body.innerHTML = `
    <div role="main" id="main-root" style="width:1200px;height:760px;opacity:1;">
      <video id="prev-vid" src="https://video.xx.fbcdn.net/v/t42/prev.mp4" style="width:400px;height:700px;opacity:1;"></video>
      <video id="active-vid" src="https://video.xx.fbcdn.net/v/t42/curr.mp4" style="width:400px;height:700px;opacity:1;"></video>
    </div>
  `;
  const mainEl = doc.querySelector('#main-root') as unknown as HTMLElement;
  const prevVid = doc.querySelector('#prev-vid') as unknown as HTMLVideoElement & {
    loadCalled?: boolean;
  };
  const activeVid = doc.querySelector('#active-vid') as unknown as HTMLVideoElement;

  mainEl.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 1200,
      bottom: 760,
      width: 1200,
      height: 760,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  // Previous video still has 20px bottom edge peeking at top (top: -680, bottom: 20)
  prevVid.getBoundingClientRect = () =>
    ({
      left: 300,
      top: -680,
      right: 700,
      bottom: 20,
      width: 400,
      height: 700,
      x: 300,
      y: -680,
      toJSON: () => ({}),
    }) as DOMRect;
  activeVid.getBoundingClientRect = () =>
    ({
      left: 300,
      top: 60,
      right: 700,
      bottom: 760,
      width: 400,
      height: 700,
      x: 300,
      y: 60,
      toJSON: () => ({}),
    }) as DOMRect;

  let prevLoaded = false;
  prevVid.load = () => {
    prevLoaded = true;
  };
  (win as unknown as Record<string, unknown>).__wbReactRootNodesV1 = new WeakMap();

  const globals = globalThis as Record<string, unknown>;
  const saved = {
    window: globals.window,
    document: globals.document,
    location: globals.location,
    innerWidth: globals.innerWidth,
    innerHeight: globals.innerHeight,
    scrollY: globals.scrollY,
    Element: globals.Element,
    HTMLElement: globals.HTMLElement,
    HTMLMediaElement: globals.HTMLMediaElement,
    HTMLVideoElement: globals.HTMLVideoElement,
    HTMLImageElement: globals.HTMLImageElement,
    HTMLAnchorElement: globals.HTMLAnchorElement,
    HTMLInputElement: globals.HTMLInputElement,
    getComputedStyle: globals.getComputedStyle,
  };
  try {
    globals.window = win;
    globals.document = doc;
    globals.location = win.location;
    globals.innerWidth = 1280;
    globals.innerHeight = 800;
    globals.scrollY = 0;
    globals.Element = win.Element;
    globals.HTMLElement = win.HTMLElement;
    globals.HTMLMediaElement = win.HTMLMediaElement;
    globals.HTMLVideoElement = win.HTMLVideoElement;
    globals.HTMLImageElement = win.HTMLImageElement;
    globals.HTMLAnchorElement = win.HTMLAnchorElement;
    globals.HTMLInputElement = win.HTMLInputElement;
    globals.getComputedStyle = win.getComputedStyle.bind(win);

    projectFacebookBrowsePage();
    assert.equal(prevVid.getAttribute('data-wb-buffer-freed'), '1');
    assert.equal(prevVid.hasAttribute('src'), false);
    assert.equal(prevLoaded, true);
    assert.equal(activeVid.getAttribute('data-wb-buffer-freed'), null);
    assert.equal(
      (win as unknown as Record<string, unknown>).__wbReactRootNodesV1 instanceof WeakMap,
      true,
    );
  } finally {
    Object.assign(globals, saved);
  }

  // Also verify soft refresh when scrollY >= 15000 on Reel advance
  const proof = makeProof();
  const execution = makeExecution(
    'video',
    proof.profileId as `${string}-${string}-${string}-${string}-${string}`,
  );
  let nowMs = 1_000;
  const pageSample: BrowsePage = {
    url: 'https://www.facebook.com/reel/55555/',
    timeOrigin: 100,
    ready: true,
    visible: true,
    blocked: false,
    scrollY: 16_200,
    viewportHeight: 800,
    contentKey: 'reel:55555',
    recommendedDwellMs: 4000,
    nextReelCSS: FACEBOOK_REEL_NEXT_CSS,
    video: {
      css: 'video',
      source: 'blob:55555',
      paused: false,
      buffering: false,
      ended: true,
      timeSeconds: 12,
      playbackRate: 1,
    },
  };
  const executor = new FacebookBrowseStepExecutor(
    'video',
    {
      read: async (_e, guard) => {
        await guard();
        return { context: execution.session, proof, page: structuredClone(pageSample) };
      },
    },
    () => true,
    () => nowMs,
  );
  const dec = await executor.decide(execution, () => {});
  assert.equal(dec.kind, 'action');
  if (dec.kind !== 'action') throw Error('EXPECTED_ACTION');
  assert.deepEqual(dec.action, {
    kind: 'browseNavigate',
    tabId: proof.tabId,
    url: 'https://www.facebook.com/reels/',
  });
});

test('Test E. navigateFacebookBoundPage tolerates Facebook same-origin redirects and friends/marketplace/video surface transitions without throwing FACEBOOK_NAVIGATION_SCOPE_CHANGED', async () => {
  assert.equal(isRecoverableBrowseFault('FACEBOOK_NAVIGATION_SCOPE_CHANGED'), true);
  assert.equal(isRecoverableBrowseFault('FACEBOOK_NAVIGATION_DOCUMENT_TIMEOUT'), true);
  assert.equal(isRecoverableBrowseFault('FACEBOOK_MANAGED_CONTEXT_CHANGED'), true);
  assert.equal(isRecoverableBrowseFault('STEP_EXECUTION_CONTEXT_CHANGED'), true);
  assert.equal(isRecoverableBrowseFault('ACTOR_INPUT_FENCED'), true);

  let evaluations = 0;
  await navigateFacebookBoundPage(
    {
      send: async (_target, method): Promise<KernelJsonObject> => {
        if (method === 'Page.navigate') return { frameId: 'main' };
        if (method === 'Target.getTargetInfo') {
          return {
            targetInfo: {
              url: 'https://www.facebook.com/friends/requests/?fcref=none',
            },
          };
        }
        evaluations++;
        return {
          result: {
            value: JSON.stringify(
              evaluations < 15
                ? {
                    url: 'https://www.facebook.com/?sk=h_chr',
                    ready: 'complete',
                  }
                : {
                    url: 'https://www.facebook.com/friends/requests/?fcref=none',
                    ready: 'interactive',
                  },
            ),
          },
        };
      },
    },
    7,
    'https://www.facebook.com/friends/requests/',
    'https://www.facebook.com/',
    () => {},
  );
  assert.equal(evaluations, 15);
});

test('Test F. Stopping an active browse task with maxLikes > 0 or pending browseNavigate settles as STOPPED (USER_STOP) and never throws null profileId or false PAUSING/FAILED', async () => {
  assert.equal(sameExecution(null, null), false);
  assert.equal(sameBinding(undefined, null), false);
  assert.equal(sameTabProof(null, undefined), false);

  const store = await WorkspaceStore.open(':memory:');
  const profileId = randomUUID();
  const known: RuntimeProfile = {
    id: profileId,
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: true,
    account: { state: 'logged-in', id: '10000088', name: 'Stop User', avatar: null },
  };
  const combo = store.createCombination({
    name: '停止防误败测试',
    note: '',
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
    steps: [
      { id: randomUUID(), type: 'video', durationMinutes: 10, maxLikes: 3, minLikeCount: 10 },
      {
        id: randomUUID(),
        type: 'friends',
        durationMinutes: 5,
        acceptMode: 'all',
        maxAccepts: 5,
        maxLikes: 0,
        minLikeCount: 0,
      },
    ],
  });
  const [plan] = store.tasks.assign(
    {
      requestId: randomUUID(),
      combinationId: combo.id,
      version: combo.version,
      profileIds: [profileId],
    },
    [known],
  );
  assert.ok(plan);
  const claimed = store.tasks.claimNext([known], new Set(['video', 'friends']));
  assert.ok(claimed);
  const step = store.tasks.steps(plan.id)[0]!;
  const proof = makeProof(profileId);
  const context: ExecutionSession = {
    profileId,
    accountId: '10000088',
    connectionEpoch: randomUUID(),
    leaseId: randomUUID(),
    generation: 1,
  };
  store.taskTabs.register(plan.id, proof, context);
  const opId = randomUUID();
  store.browseIntents.prepare(
    plan.id,
    step.id,
    opId,
    {
      kind: 'browseNavigate',
      tabId: proof.tabId,
      url: 'https://www.facebook.com/reels/',
    },
    {
      kind: 'auxiliary',
      purpose: 'advance',
      proof,
      documentEpoch: 0,
      routeEpoch: 0,
    },
  );
  const bound = store.tasks.takeBoundOperation(context);
  assert.ok(bound?.binding);
  // Even if navigation failed transiently with FACEBOOK_NAVIGATION_SCOPE_CHANGED before user stop:
  store.tasks.markBoundUnknown(bound.binding, 'FACEBOOK_NAVIGATION_SCOPE_CHANGED');
  const control = store.tasks.requestControl(plan.id, 'stop', 'USER_STOP');
  assert.ok(control.controlRequestId);
  store.tasks.confirmControl(plan.id, control.controlRequestId);
  const endingId = store.tasks.requestEnd(plan.id);
  const stopReceipt = {
    profileId,
    connectionEpoch: context.connectionEpoch,
    requestId: endingId,
    state: 'stopped' as const,
  };
  store.tasks.prepareEnd(plan.id, stopReceipt);
  const notice = store.tasks.settlements.claim(profileId);
  if (notice?.claimToken) {
    store.tasks.settlements.delivered(bound.binding.operationId, notice.claimToken, {
      binding: notice.binding,
      resolution: notice.resolution,
    });
  }
  const ended = store.tasks.finishEnd(plan.id, stopReceipt);
  assert.equal(ended.state, 'STOPPED');
  assert.equal(ended.reason, 'USER_STOP');

  // Also verify TaskService.command('stop') executes commandPlan before revokeForControl
  const callOrder: string[] = [];
  const plan2List = store.tasks.assign(
    {
      requestId: randomUUID(),
      combinationId: combo.id,
      version: combo.version,
      profileIds: [profileId],
    },
    [known],
  );
  const plan2 = store.tasks.claimNext([known], new Set(['video', 'friends']));
  assert.ok(plan2 && plan2List[0]);
  const service = new TaskService(store.tasks, () => ({
    available: () => true,
    capabilities: async () => ({ types: ['video', 'friends'], combinations: [] }),
    start: async () => [],
    stopProfile: async () => {},
    commandPlan: async (id) => {
      callOrder.push('commandPlan');
      const req = store.tasks.requestControl(id, 'stop', 'USER_STOP');
      return store.tasks.confirmControl(id, req.controlRequestId!);
    },
    revokeForControl: () => {
      callOrder.push('revokeForControl');
    },
  }));
  const cmdResult = await service.command({
    command: 'stop',
    plans: [
      {
        profileId,
        planId: plan2.id,
        expectedState: 'RUNNING',
        expectedUpdatedAt: plan2.updatedAt,
      },
    ],
  });
  assert.equal(cmdResult.results[0]?.accepted, true);
  assert.equal(cmdResult.results[0]?.state, 'STOPPED');
  assert.deepEqual(callOrder, ['commandPlan', 'revokeForControl']);
  store.close();
});

test('Test G. Reels like button selection prefers innermost button and detects liked state across primary/alternate fibers and aria-pressed/liked labels', () => {
  const win = new Window({
    url: 'https://www.facebook.com/reel/999111/',
    width: 1280,
    height: 800,
  });
  const doc = win.document;
  doc.body.innerHTML = `
    <div role="main" id="main-root" style="width:1200px;height:760px;opacity:1;">
      <div id="reel-card" style="width:400px;height:700px;opacity:1;">
        <video id="active-vid" src="https://video.xx.fbcdn.net/v/t42/active.mp4" style="width:400px;height:700px;opacity:1;"></video>
        <div role="button" id="outer-action-wrapper" style="width:60px;height:120px;opacity:1;">
          <div role="button" id="inner-like-btn" aria-label="Liked" aria-pressed="true" style="width:48px;height:48px;opacity:1;">
            <svg id="like-svg" style="width:24px;height:24px;opacity:1;"></svg>
          </div>
          <span id="reel-like-count" style="width:48px;height:20px;opacity:1;">1.2K</span>
        </div>
      </div>
    </div>
  `;
  const setRect = (sel: string, rect: Partial<DOMRect>) => {
    const el = doc.querySelector(sel) as unknown as HTMLElement | null;
    if (!el) return;
    el.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 100,
        right: 500,
        bottom: 700,
        width: 400,
        height: 600,
        x: 100,
        y: 100,
        toJSON: () => ({}),
        ...rect,
      }) as DOMRect;
  };
  setRect('#main-root', { left: 0, top: 0, right: 1200, bottom: 760, width: 1200, height: 760 });
  setRect('#reel-card', { left: 300, top: 60, right: 700, bottom: 740, width: 400, height: 680 });
  setRect('#active-vid', { left: 300, top: 60, right: 700, bottom: 740, width: 400, height: 680 });
  setRect('#outer-action-wrapper', {
    left: 710,
    top: 400,
    right: 770,
    bottom: 520,
    width: 60,
    height: 120,
  });
  setRect('#inner-like-btn', {
    left: 716,
    top: 420,
    right: 764,
    bottom: 468,
    width: 48,
    height: 48,
  });
  setRect('#like-svg', { left: 728, top: 432, right: 752, bottom: 456, width: 24, height: 24 });
  setRect('#reel-like-count', {
    left: 716,
    top: 470,
    right: 764,
    bottom: 490,
    width: 48,
    height: 20,
  });

  const outerWrapper = doc.querySelector('#outer-action-wrapper')!;
  const innerBtn = doc.querySelector('#inner-like-btn')!;
  doc.elementFromPoint = () => innerBtn;

  const wrapperFiber: Record<string, unknown> = {
    type: { displayName: 'CometUFIReactButtonBase.react' },
    memoizedProps: { selected: false },
  };
  const innerPrimaryFiber: Record<string, unknown> = {
    type: { displayName: 'CometUFIReactButtonBase.react' },
    memoizedProps: { isReacted: true },
    alternate: {
      type: { displayName: 'CometUFIReactButtonBase.react' },
      memoizedProps: { selected: false },
    },
  };
  Reflect.set(outerWrapper, '__reactFiber$w', wrapperFiber);
  Reflect.set(innerBtn, '__reactFiber$i', innerPrimaryFiber);

  const globals = globalThis as Record<string, unknown>;
  const saved = {
    window: globals.window,
    document: globals.document,
    location: globals.location,
    innerWidth: globals.innerWidth,
    innerHeight: globals.innerHeight,
    scrollY: globals.scrollY,
    Element: globals.Element,
    HTMLElement: globals.HTMLElement,
    HTMLMediaElement: globals.HTMLMediaElement,
    HTMLVideoElement: globals.HTMLVideoElement,
    HTMLImageElement: globals.HTMLImageElement,
    HTMLAnchorElement: globals.HTMLAnchorElement,
    HTMLInputElement: globals.HTMLInputElement,
    getComputedStyle: globals.getComputedStyle,
  };
  try {
    globals.window = win;
    globals.document = doc;
    globals.location = win.location;
    globals.innerWidth = 1280;
    globals.innerHeight = 800;
    globals.scrollY = 0;
    globals.Element = win.Element;
    globals.HTMLElement = win.HTMLElement;
    globals.HTMLMediaElement = win.HTMLMediaElement;
    globals.HTMLVideoElement = win.HTMLVideoElement;
    globals.HTMLImageElement = win.HTMLImageElement;
    globals.HTMLAnchorElement = win.HTMLAnchorElement;
    globals.HTMLInputElement = win.HTMLInputElement;
    globals.getComputedStyle = win.getComputedStyle.bind(win);

    const projected = projectFacebookBrowsePage();
    assert.ok(projected.likeTarget);
    assert.equal(innerBtn.getAttribute('data-wb-browse-like'), '1');
    assert.equal(outerWrapper.getAttribute('data-wb-browse-like'), null);
    assert.equal(projected.likeTarget.liked, true);
    assert.equal(projected.likeTarget.likeCount, 1200);
  } finally {
    Object.assign(globals, saved);
  }
});

async function readZipEntriesWithYauzl(zipPath: string): Promise<Map<string, string>> {
  const zip = await new Promise<YauzlZipFile>((resolve, reject) =>
    openYauzl(zipPath, { lazyEntries: true, strictFileNames: true }, (err, file) =>
      err || !file ? reject(err ?? Error('ZIP_OPEN_FAILED')) : resolve(file),
    ),
  );
  const files = new Map<string, string>();
  await new Promise<void>((resolve, reject) => {
    zip.once('error', (err) => {
      zip.close();
      reject(err);
    });
    zip.once('end', () => {
      zip.close();
      resolve();
    });
    zip.on('entry', (entry: YauzlEntry) => {
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) {
          zip.close();
          reject(err ?? Error('ZIP_STREAM_FAILED'));
          return;
        }
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.once('error', (streamErr) => {
          zip.close();
          reject(streamErr);
        });
        stream.once('end', () => {
          files.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
  return files;
}

test('Test H. Diagnostic feedback package builds standard PKZIP readable by yauzl with snapshot, task ledger, dev-diagnostics, runtime logs, and retains at most 10 packages', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'wb-diag-pkg-'));
  const store = await WorkspaceStore.open(':memory:');
  try {
    const profileId = '77777777-7777-4777-8777-777777777777';
    const combo = store.createCombination({
      name: '诊断测试组合',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [
        {
          id: randomUUID(),
          type: 'video',
          durationMinutes: 5,
          maxLikes: 2,
          minLikeCount: 10,
        },
      ],
    });
    const known: RuntimeProfile = {
      id: profileId,
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in', id: '10000777777', name: 'Diag User', avatar: null },
    };
    const [plan] = store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: combo.id,
        version: combo.version,
        profileIds: [profileId],
      },
      [known],
    );
    assert.ok(plan);
    const claimed = store.tasks.claimNext([known], new Set(['video']));
    assert.ok(claimed);
    const step = store.tasks.steps(plan.id)[0]!;
    store.tasks.prepareOperation(plan.id, step.id, randomUUID(), {
      kind: 'browseNavigate',
      tabId: 1,
      url: 'https://www.facebook.com/reels/',
    });

    const logsDir = path.join(tempRoot, 'logs');
    await mkdir(logsDir, { recursive: true });
    const diagFilePath = path.join(logsDir, 'dev-diagnostics.jsonl');
    const prevDiagPath = path.join(logsDir, 'dev-diagnostics.prev.jsonl');
    await writeFile(
      diagFilePath,
      JSON.stringify({ id: 1, event: 'USER_MANUAL_SNAPSHOT', reason: 'test-diag' }) + '\n',
      'utf8',
    );
    await writeFile(
      prevDiagPath,
      JSON.stringify({ id: 0, event: 'PREV_LOG_EVENT', reason: 'prev-log' }) + '\n',
      'utf8',
    );
    await writeFile(
      path.join(logsDir, 'runtime-2026-10-27.ndjson'),
      JSON.stringify({
        version: 1,
        observedAt: '2026-10-27T10:00:00.000Z',
        event: 'SOFTWARE_STARTED',
      }) + '\n',
      'utf8',
    );

    let lastResult = await buildDiagnosticFeedbackPackage({
      dataDir: tempRoot,
      softwareVersion: '0.1.157',
      extensionVersion: '0.3.58',
      note: '测试浏览器61在刷Reels时卡住',
      uiContext: '视图:records, 已选:1个浏览器',
      reveal: false,
      entryId: 42,
      at: '2026-10-27T10:30:00.000Z',
      controllerLoopDelay: {
        resolutionMs: 20,
        samples: 100,
        maxSampleIntervalMs: 32.5,
        p99SampleIntervalMs: 24.1,
      },
      profiles: [
        {
          id: profileId,
          name: '用户61',
          alias: '用户61',
          browserName: '用户61',
          online: true,
          phase: 'READY',
          synced: true,
          unresolved: false,
          extensionVersion: '0.3.58',
          accountState: 'logged-in',
          accountId: '10000777777',
          accountName: 'Diag User',
          profileWindowFocused: true,
          focusedWindowAt: 1_760_000_000_000,
          presentationRecoverySupported: true,
          kernelTraceTail: [{ event: 'KERNEL_STEP', at: 1_760_000_000_000 }],
        },
      ],
      combinations: [{ id: combo.id, version: combo.version }],
      groupInviter: {
        state: { running: false, statusText: '就绪' },
        logs: [{ id: 'inv-log-1', groupId: '12345' }],
      },
      groupBumper: {
        state: { running: false, statusText: '未运行' },
        logs: [{ id: 'bmp-log-1', groupId: '67890' }],
      },
      tasksRepository: store.tasks,
      taskTabsRepository: store.taskTabs,
      devDiagFlush: async () => {},
      devDiagFilePath: diagFilePath,
    });

    assert.ok(lastResult.fileName.startsWith('问题反馈-v0.1.157-'));
    assert.ok(lastResult.fileName.endsWith('.zip'));
    assert.ok(lastResult.sizeBytes > 100);

    const extracted = await readZipEntriesWithYauzl(lastResult.filePath);
    assert.ok(extracted.has('1-snapshot.json'));
    assert.ok(extracted.has('2-task-ledger.json'));
    assert.ok(extracted.has('3-dev-diagnostics.jsonl'));
    assert.ok(extracted.has('3b-dev-diagnostics.prev.jsonl'));
    assert.ok(extracted.has('4-runtime-logs.ndjson'));

    const snap = JSON.parse(extracted.get('1-snapshot.json')!) as Record<string, unknown>;
    assert.equal(snap.userNote, '测试浏览器61在刷Reels时卡住');
    assert.equal(snap.uiContext, '视图:records, 已选:1个浏览器');
    assert.equal(snap.softwareVersion, '0.1.157');
    assert.ok(Array.isArray(snap.profiles) && snap.profiles.length === 1);
    assert.ok(snap.groupBumper);
    assert.ok(snap.groupInviter);

    const ledger = JSON.parse(extracted.get('2-task-ledger.json')!) as {
      plans: Array<{
        plan: { id: string };
        steps: unknown[];
        operations: unknown[];
        events: unknown[];
      }>;
    };
    assert.equal(ledger.plans.length, 1);
    assert.equal(ledger.plans[0]?.plan.id, plan.id);
    assert.equal(ledger.plans[0]?.steps.length, 1);
    assert.equal(ledger.plans[0]?.operations.length, 1);
    assert.ok((ledger.plans[0]?.events.length ?? 0) >= 1);

    assert.match(extracted.get('3-dev-diagnostics.jsonl')!, /USER_MANUAL_SNAPSHOT/);
    assert.match(extracted.get('3b-dev-diagnostics.prev.jsonl')!, /PREV_LOG_EVENT/);
    assert.match(extracted.get('4-runtime-logs.ndjson')!, /SOFTWARE_STARTED/);

    // Generate 11 more packages (total 12) and verify retention keeps at most 10 .zip files
    for (let i = 0; i < 11; i++) {
      lastResult = await buildDiagnosticFeedbackPackage({
        dataDir: tempRoot,
        softwareVersion: '0.1.157',
        extensionVersion: '0.3.58',
        note: `batch-${i}`,
        reveal: false,
        entryId: 100 + i,
        at: '2026-10-27T10:31:00.000Z',
        controllerLoopDelay: {
          resolutionMs: 20,
          samples: 1,
          maxSampleIntervalMs: 20,
          p99SampleIntervalMs: 20,
        },
        profiles: [],
        combinations: [],
        groupInviter: { state: {}, logs: [] },
        groupBumper: null,
        tasksRepository: store.tasks,
        taskTabsRepository: store.taskTabs,
        devDiagFlush: async () => {},
        devDiagFilePath: diagFilePath,
      });
    }

    const feedbackDir = path.join(tempRoot, 'logs', 'feedback');
    const remainingZips = (await readdir(feedbackDir)).filter((n) => n.endsWith('.zip'));
    assert.equal(remainingZips.length, 10);

    const revealed = await revealDiagnosticPackage(tempRoot, lastResult.fileName);
    assert.equal(revealed.fileName, lastResult.fileName);
  } finally {
    store.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Test I. Playwright/CDP-prefixed faults match recoverable/session-breaking guards, retireForBrowseSelfHeal stops session after settling in-flight operation, and KernelJournal reconciles DISPATCHING + NOT_APPLIED', async () => {
  const prefixedFaults = [
    'mouse.wheel: Protocol error (Input.dispatchMouseEvent): KERNEL_RPC_RESULT_UNKNOWN',
    'page.evaluate: Protocol error (Runtime.callFunctionOn): Target.detachedFromTarget',
    'page.evaluate: Execution context was destroyed, most likely because of a navigation',
    'KERNEL_OPERATION_FINISH_TIMEOUT',
    'FACEBOOK_NAVIGATION_READ_TIMEOUT',
    'KERNEL_EXECUTE_TIMEOUT',
  ];
  for (const fault of prefixedFaults) {
    assert.equal(isRecoverableBrowseFault(fault), true, `Expected recoverable: ${fault}`);
    assert.equal(isSessionBreakingBrowseFault(fault), true, `Expected session-breaking: ${fault}`);
  }

  // Verify KernelJournal reconciles DISPATCHING with NOT_APPLIED
  const profileId = randomUUID();
  const journal = new KernelJournal({
    read: async () => undefined,
    write: async () => {},
  });
  await journal.initialize(profileId, randomUUID());
  const session: ExecutionSession = {
    profileId,
    accountId: '10000099',
    leaseId: randomUUID(),
    connectionEpoch: randomUUID(),
    generation: 1,
  };
  const binding = {
    ...session,
    operationId: randomUUID(),
    jobId: randomUUID(),
    stepId: randomUUID(),
    actionDigest: 'a'.repeat(64),
  };
  const begun = await journal.begin(binding);
  assert.equal(begun.record.state, 'DISPATCHING');
  await journal.reconcile(binding, {
    id: randomUUID(),
    outcome: 'NOT_APPLIED',
    evidenceDigest: 'b'.repeat(64),
  });
  const stateAfterReconcile = await journal.snapshot();
  assert.equal(stateAfterReconcile.operations[0]?.state, 'RECONCILED');

  // Verify retireForBrowseSelfHeal stops port even if current() still returns the old context
  const store = await WorkspaceStore.open(':memory:');
  try {
    const known: RuntimeProfile = {
      id: profileId,
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in', id: '10000099', name: 'SelfHeal User', avatar: null },
    };
    const combo = store.createCombination({
      name: '自愈断连测试',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [
        { id: randomUUID(), type: 'feed', durationMinutes: 5, maxLikes: 0, minLikeCount: 10 },
      ],
    });
    const [plan] = store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: combo.id,
        version: combo.version,
        profileIds: [profileId],
      },
      [known],
    );
    assert.ok(plan);
    store.tasks.claimNext([known], new Set(['feed']));
    const step = store.tasks.steps(plan.id)[0]!;
    const proof = makeProof(profileId);
    store.taskTabs.register(plan.id, proof, session);
    const opId = randomUUID();
    store.browseIntents.prepare(
      plan.id,
      step.id,
      opId,
      {
        kind: 'browseScroll',
        tabId: proof.tabId,
        url: 'https://www.facebook.com/',
        timeOrigin: 100,
        documentEpoch: 0,
        routeEpoch: 0,
        deltaY: 420,
        fromY: 0,
      },
      {
        kind: 'auxiliary',
        purpose: 'advance',
        proof,
        documentEpoch: 0,
        routeEpoch: 0,
      },
    );
    const bound = store.tasks.takeBoundOperation(session);
    assert.ok(bound?.binding);

    let stopCalls = 0;
    const managedPort: ManagedProfileSession = {
      profileId,
      ownedPlanId: () => plan.id,
      profile: async () => known,
      current: async () => session,
      inventory: async () => ({
        version: 1,
        profileId,
        browserSessionEpoch: proof.browserSessionEpoch,
        operations: [],
        tabs: [
          {
            ownershipId: proof.ownershipId,
            url: 'https://www.facebook.com/',
            state: 'READY',
            proof,
            reason: '',
          },
        ],
      }),
      notify: async () => ({
        binding: bound.binding!,
        resolution: { id: randomUUID(), outcome: 'NOT_APPLIED', evidenceDigest: 'c'.repeat(64) },
      }),
      sendGuarded: async () => {
        throw Error('UNEXPECTED');
      },
      setFailureHandler: () => {},
      revokeInput: () => {},
      stop: async (stopBinding) => {
        stopCalls++;
        return { ...stopBinding, state: 'stopped' };
      },
    };
    const factory: QueuedProfileFactory = {
      profile: async () => known,
      observeQueued: async () => known,
      openClaimed: async () => managedPort,
      forget: async () => {},
      close: async () => {},
    };
    const runtime = new AdmittedTaskRuntime(
      store.tasks,
      store.taskTabs,
      store.tasks.settlements,
      store.taskControls,
      factory,
      () => [known],
      () => randomUUID(),
    );
    await runtime.observe(profileId);
    assert.equal(runtime.hasOwner(profileId), true);
    await runtime.retireForBrowseSelfHeal(
      profileId,
      'mouse.wheel: Protocol error (Input.dispatchMouseEvent): KERNEL_RPC_RESULT_UNKNOWN',
    );
    assert.equal(stopCalls, 1);
    assert.equal(runtime.hasOwner(profileId), false);
    const settledOp = store.tasks.operations(plan.id)[0];
    assert.equal(settledOp?.status, 'FAILED');
  } finally {
    store.close();
  }
});

test('Test J. TaskDispatcher.flushOne settles browseScroll recoverable faults without marking UNKNOWN, and TaskTabStore.register supersedes terminal plans with historical ended UNKNOWN operations', async () => {
  const store = await WorkspaceStore.open(':memory:');
  try {
    const profileId = randomUUID();
    const known: RuntimeProfile = {
      id: profileId,
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in', id: '10000100', name: 'Scroll Heal User', avatar: null },
    };
    const combo = store.createCombination({
      name: '滚动自愈与标签页释放测试',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [
        { id: randomUUID(), type: 'feed', durationMinutes: 5, maxLikes: 0, minLikeCount: 10 },
      ],
    });
    const [plan] = store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: combo.id,
        version: combo.version,
        profileIds: [profileId],
      },
      [known],
    );
    assert.ok(plan);
    store.tasks.claimNext([known], new Set(['feed']));
    const step = store.tasks.steps(plan.id)[0]!;
    const proof = makeProof(profileId);
    const session: ExecutionSession = {
      profileId,
      accountId: '10000100',
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: 1,
    };
    store.taskTabs.register(plan.id, proof, session);
    const opId = randomUUID();
    store.browseIntents.prepare(
      plan.id,
      step.id,
      opId,
      {
        kind: 'browseScroll',
        tabId: proof.tabId,
        url: 'https://www.facebook.com/',
        timeOrigin: 100,
        documentEpoch: 0,
        routeEpoch: 0,
        deltaY: 500,
        fromY: 0,
      },
      {
        kind: 'auxiliary',
        purpose: 'advance',
        proof,
        documentEpoch: 0,
        routeEpoch: 0,
      },
    );

    const dispatcher = new TaskDispatcher(store.tasks, {
      profiles: async () => [known],
      session: async () => session,
      send: async () => {
        throw Error(
          'mouse.wheel: Protocol error (Input.dispatchMouseEvent): KERNEL_RPC_RESULT_UNKNOWN',
        );
      },
    });
    const flushed = await dispatcher.flushOne(profileId);
    assert.equal(flushed, true);
    const opAfterFlush = store.tasks.operations(plan.id)[0];
    assert.equal(opAfterFlush?.status, 'FAILED');
    assert.equal(store.tasks.get(plan.id).state, 'RUNNING');

    // Now simulate an older FAILED plan that had an ended UNKNOWN operation and left a READY/RECHECK_REQUIRED tab row
    const opId2 = randomUUID();
    store.browseIntents.prepare(
      plan.id,
      step.id,
      opId2,
      {
        kind: 'click',
        tabId: proof.tabId,
        documentEpoch: 0,
        routeEpoch: 0,
        target: { css: '[data-wb-browse-dialog-dismiss="1"]' },
      },
      {
        kind: 'auxiliary',
        purpose: 'advance',
        proof,
        documentEpoch: 0,
        routeEpoch: 0,
      },
    );
    const bound2 = store.tasks.takeBoundOperation(session);
    assert.ok(bound2?.binding);
    store.tasks.markBoundUnknown(bound2.binding, 'NON_RECOVERABLE_TEST_FAULT');
    const endingId = store.tasks.requestEnd(plan.id);
    const stopReceipt = {
      profileId,
      connectionEpoch: session.connectionEpoch,
      requestId: endingId,
      state: 'stopped' as const,
    };
    store.tasks.prepareEnd(plan.id, stopReceipt);
    for (let i = 0; i < 4; i++) {
      const notice = store.tasks.settlements.claim(profileId);
      if (!notice?.claimToken) break;
      store.tasks.settlements.delivered(notice.binding.operationId, notice.claimToken, {
        binding: notice.binding,
        resolution: notice.resolution,
      });
    }
    const failedPlan = store.tasks.finishEnd(plan.id, stopReceipt);
    assert.equal(failedPlan.state, 'FAILED');

    // Assign and claim a new plan on the same profile; registering a new tab must succeed without TASK_TAB_ALREADY_OWNED
    const [newPlan] = store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: combo.id,
        version: combo.version,
        profileIds: [profileId],
      },
      [known],
    );
    assert.ok(newPlan);
    store.tasks.claimNext([known], new Set(['feed']));
    const newProof = makeProof(profileId);
    const newSession: ExecutionSession = {
      profileId,
      accountId: '10000100',
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: 2,
    };
    const registered = store.taskTabs.register(newPlan.id, newProof, newSession);
    assert.equal(registered.state, 'READY');
    assert.equal(registered.jobId, newPlan.id);
  } finally {
    store.close();
  }
});

test('Test K. projectFacebookBrowsePage on Reels excludes comment/dialog like buttons and prioritizes the active video card like button even beyond 80 buttons', () => {
  const win = new Window({
    url: 'https://www.facebook.com/reel/888222/',
    width: 1280,
    height: 800,
  });
  const doc = win.document;
  const fillerButtons = Array.from(
    { length: 95 },
    (_, i) =>
      `<div role="button" class="filler-btn" id="filler-${i}" style="width:20px;height:20px;opacity:1;">Filler ${i}</div>`,
  ).join('');
  doc.body.innerHTML = `
    <div role="main" id="main-root" style="width:1200px;height:760px;opacity:1;">
      ${fillerButtons}
      <div role="article" aria-label="评论" id="comment-panel" style="width:320px;height:600px;opacity:1;">
        <div role="button" id="comment-like-btn" aria-label="赞" style="width:36px;height:36px;opacity:1;">
          <svg id="comment-svg" style="width:16px;height:16px;opacity:1;"></svg>
        </div>
      </div>
      <div id="reel-card" style="width:400px;height:700px;opacity:1;">
        <video id="active-vid" src="https://video.xx.fbcdn.net/v/t42/active2.mp4" style="width:400px;height:700px;opacity:1;"></video>
        <div role="button" id="reel-like-btn" aria-label="赞" style="width:48px;height:48px;opacity:1;">
          <svg id="reel-svg" style="width:24px;height:24px;opacity:1;"></svg>
        </div>
        <span id="reel-like-count" style="width:48px;height:20px;opacity:1;">856</span>
      </div>
    </div>
  `;
  const setRect = (sel: string, rect: Partial<DOMRect>) => {
    for (const el of doc.querySelectorAll(sel)) {
      (el as unknown as HTMLElement).getBoundingClientRect = () =>
        ({
          left: 10,
          top: 10,
          right: 30,
          bottom: 30,
          width: 20,
          height: 20,
          x: 10,
          y: 10,
          toJSON: () => ({}),
          ...rect,
        }) as DOMRect;
    }
  };
  setRect('.filler-btn', { left: 10, top: 10, right: 30, bottom: 30, width: 20, height: 20 });
  setRect('#main-root', { left: 0, top: 0, right: 1200, bottom: 760, width: 1200, height: 760 });
  setRect('#comment-panel', {
    left: 800,
    top: 60,
    right: 1120,
    bottom: 660,
    width: 320,
    height: 600,
  });
  setRect('#comment-like-btn', {
    left: 820,
    top: 200,
    right: 856,
    bottom: 236,
    width: 36,
    height: 36,
  });
  setRect('#comment-svg', { left: 828, top: 208, right: 844, bottom: 224, width: 16, height: 16 });
  setRect('#reel-card', { left: 300, top: 60, right: 700, bottom: 740, width: 400, height: 680 });
  setRect('#active-vid', { left: 300, top: 60, right: 700, bottom: 740, width: 400, height: 680 });
  setRect('#reel-like-btn', {
    left: 716,
    top: 420,
    right: 764,
    bottom: 468,
    width: 48,
    height: 48,
  });
  setRect('#reel-svg', { left: 728, top: 432, right: 752, bottom: 456, width: 24, height: 24 });
  setRect('#reel-like-count', {
    left: 716,
    top: 470,
    right: 764,
    bottom: 490,
    width: 48,
    height: 20,
  });

  const commentBtn = doc.querySelector('#comment-like-btn')!;
  const reelBtn = doc.querySelector('#reel-like-btn')!;
  Reflect.set(commentBtn, '__reactFiber$c', {
    type: { displayName: 'CometUFIReactButtonBase.react' },
    memoizedProps: { selected: false },
  });
  doc.elementFromPoint = () => reelBtn;

  const globals = globalThis as Record<string, unknown>;
  const saved = {
    window: globals.window,
    document: globals.document,
    location: globals.location,
    innerWidth: globals.innerWidth,
    innerHeight: globals.innerHeight,
    scrollY: globals.scrollY,
    Element: globals.Element,
    HTMLElement: globals.HTMLElement,
    HTMLMediaElement: globals.HTMLMediaElement,
    HTMLVideoElement: globals.HTMLVideoElement,
    HTMLImageElement: globals.HTMLImageElement,
    HTMLAnchorElement: globals.HTMLAnchorElement,
    HTMLInputElement: globals.HTMLInputElement,
    getComputedStyle: globals.getComputedStyle,
  };
  try {
    globals.window = win;
    globals.document = doc;
    globals.location = win.location;
    globals.innerWidth = 1280;
    globals.innerHeight = 800;
    globals.scrollY = 0;
    globals.Element = win.Element;
    globals.HTMLElement = win.HTMLElement;
    globals.HTMLMediaElement = win.HTMLMediaElement;
    globals.HTMLVideoElement = win.HTMLVideoElement;
    globals.HTMLImageElement = win.HTMLImageElement;
    globals.HTMLAnchorElement = win.HTMLAnchorElement;
    globals.HTMLInputElement = win.HTMLInputElement;
    globals.getComputedStyle = win.getComputedStyle.bind(win);

    const projected = projectFacebookBrowsePage();
    assert.ok(projected.likeTarget);
    assert.equal(reelBtn.getAttribute('data-wb-browse-like'), '1');
    assert.equal(commentBtn.getAttribute('data-wb-browse-like'), null);
    assert.equal(projected.likeTarget.liked, false);
    assert.equal(projected.likeTarget.likeCount, 856);
    assert.equal(projected.likeTarget.css, FACEBOOK_BROWSE_LIKE_CSS);
  } finally {
    Object.assign(globals, saved);
  }
});
