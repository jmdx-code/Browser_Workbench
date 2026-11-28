import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import type { Peer } from '../src/bridge/core.js';
import { executeBrowseStep } from '../src/infrastructure/active-account-runtime/browse-step-executor.js';
import { checkDirectPostRiskLimit } from '../src/infrastructure/active-account-runtime/direct-post-ledger.js';
import { KernelRpcSession } from '../src/infrastructure/kernel-bridge/kernel-rpc-session.js';
import type { BrowserSessionLease } from '../src/infrastructure/browser-session-lease.js';
import type { WorkspaceStorePort } from '../src/infrastructure/persistence-port.js';
import {
  CombinationSchema,
  CreateCombination,
  SaveCombination,
  SavedCombinationSchema,
} from '../src/shared/contracts.js';
import {
  DailyRiskActionKind,
  evaluateDailyRiskQuota,
  ZERO_DAILY_ACTION_COUNTS,
} from '../src/shared/daily-risk-limits.js';
import { devDiag, type DevDiagEntry } from '../src/shared/dev-diagnostics.js';
import {
  FACEBOOK_BROWSE_LIKE_CSS,
  FACEBOOK_FRIEND_ADD_CSS,
  FACEBOOK_FRIEND_CONFIRM_CSS,
} from '../src/shared/facebook-browse-route.js';
import type { Plan, StepInstance } from '../src/shared/task-contracts.js';
import { workspaceFixture } from './fixtures/workspace-fixture.js';

function createStepPlan(step: StepInstance): { plan: Plan; step: StepInstance } {
  const plan: Plan = {
    id: step.jobId,
    batchId: randomUUID(),
    combinationId: randomUUID(),
    version: 1,
    profileId: randomUUID(),
    accountId: 'acc-w7',
    state: 'RUNNING',
    reason: '',
    controlMode: null,
    controlRequestId: null,
    controlConfirmed: false,
    round: 1,
    position: 0,
    snapshot: {
      name: 'W7 Test',
      note: '',
      steps: [step.spec],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return { plan, step };
}

test('BUG-P1-05: DailyRiskActionKind supports active-friend and evaluateDailyRiskQuota blocks on total cap only', () => {
  assert.equal(DailyRiskActionKind.safeParse('active-friend').success, true);

  const settings = {
    enabled: true,
    dailyMaxTotalActions: 10,
    dailyMaxBumps: 30,
    dailyMaxPosts: 10,
    dailyMaxInvites: 20,
    dailyMaxActiveLikes: 1,
  };

  // Active-like cap reached (1/1), total cap NOT reached (1/10) -> active-friend still allowed
  const likeCapped = evaluateDailyRiskQuota(
    settings,
    {},
    'p1',
    { ...ZERO_DAILY_ACTION_COUNTS, activeLikesToday: 1, activeActionsToday: 1 },
    'active-friend',
  );
  assert.equal(likeCapped.allowed, true);
  assert.equal(likeCapped.reason, null);

  // Total cap reached (10/10) -> active-friend blocked
  const totalCapped = evaluateDailyRiskQuota(
    settings,
    {},
    'p1',
    {
      ...ZERO_DAILY_ACTION_COUNTS,
      groupBumpsToday: 5,
      activeFriendsToday: 5,
      activeActionsToday: 5,
    },
    'active-friend',
  );
  assert.equal(totalCapped.allowed, false);
  assert.match(totalCapped.reason ?? '', /总动作 10\/10/);
});

test('BUG-P1-05: friends step hard-blocks friend-add & friend-confirm when active-friend risk limit is reached without failing', async () => {
  for (const friendAction of ['add_suggested', 'accept'] as const) {
    const step: StepInstance = {
      id: randomUUID(),
      jobId: randomUUID(),
      round: 1,
      position: 0,
      status: 'ACTIVE',
      spec: {
        id: randomUUID(),
        type: 'friends',
        friendAction,
        acceptMode: 'count',
        maxAccepts: 5,
        durationMinutes: 1,
        maxLikes: 0,
        minLikeCount: 0,
      },
      progress: {
        revision: 0,
        effectiveMilliseconds: 0,
        likes: 0,
        published: 0,
        cursor: null,
        accepted: 0,
      },
    };
    const { plan } = createStepPlan(step);
    const ac = new AbortController();
    const diagEntries: DevDiagEntry[] = [];
    let friendClickAttempts = 0;
    let flushedProgressCount = 0;
    let riskKindChecked: string | null = null;

    const mockStore = {
      tasks: {
        updateStepProgress: async () => {
          flushedProgressCount += 1;
        },
        hasAccountLiked: async () => false,
        recordAccountLike: async () => {},
      },
      activityStats: {
        recordDailyActivity: async () => {},
        checkBrowserRiskLimit: (_pid: string, kind: string) => {
          riskKindChecked = kind;
          return { allowed: false, reason: '今日已达浏览器安全日限额（总动作 10/10）' };
        },
      },
    } as unknown as WorkspaceStorePort;

    const isAdd = friendAction === 'add_suggested';
    const mockPage = {
      url: () =>
        isAdd
          ? 'https://www.facebook.com/friends/suggestions/'
          : 'https://www.facebook.com/friends/requests/',
      goto: async () => {},
      bringToFront: async () => {},
      mouse: { wheel: async () => {}, move: async () => {}, click: async () => {} },
      keyboard: { press: async () => {} },
      viewportSize: () => ({ width: 1280, height: 800 }),
      locator: () => ({
        first: () => ({
          evaluate: async () => false,
          click: async () => {
            friendClickAttempts += 1;
          },
        }),
      }),
      evaluate: async () => ({
        url: isAdd
          ? 'https://www.facebook.com/friends/suggestions/'
          : 'https://www.facebook.com/friends/requests/',
        timeOrigin: 1000,
        ready: true,
        visible: true,
        blocked: false,
        scrollY: 0,
        viewportHeight: 800,
        contentKey: 'friend-candidate-1',
        ...(isAdd
          ? { friendAddCSS: FACEBOOK_FRIEND_ADD_CSS, friendSuggestedCount: 3 }
          : { friendConfirmCSS: FACEBOOK_FRIEND_CONFIRM_CSS, friendPendingCount: 3 }),
        video: null,
      }),
    } as unknown as Page;

    const lease = {
      profileId: plan.profileId,
      accountId: 'acc-w7',
      signal: ac.signal,
      page: mockPage,
      guard: () => {},
      execOp: async (_label: string, work: () => Promise<unknown>) => work(),
    } as unknown as BrowserSessionLease;

    const origNow = Date.now;
    const origSetTimeout = globalThis.setTimeout;
    let fakeNow = 10_000;
    Date.now = () => {
      fakeNow += 2_000;
      return fakeNow;
    };
    globalThis.setTimeout = ((cb: (...args: unknown[]) => void) => {
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    devDiag.setSink((entry) => diagEntries.push(entry));
    try {
      const res = await executeBrowseStep(mockStore, plan, step, lease);
      assert.equal(res.kind, 'COMPLETED');
      assert.equal(res.progress.accepted, 0);
      assert.equal(riskKindChecked, 'active-friend');
      assert.equal(friendClickAttempts, 0);
      assert.ok(flushedProgressCount >= 1);
      const skipLog = diagEntries.find((e) => e.event === 'BROWSE_FRIEND_DAILY_LIMIT_SKIP');
      assert.ok(skipLog);
      assert.equal(skipLog.level, 'INFO');
      assert.equal(skipLog.data?.friendAction, friendAction);
    } finally {
      Date.now = origNow;
      globalThis.setTimeout = origSetTimeout;
      devDiag.setSink(null);
    }
  }
});

test('BUG-P1-05: feed/video continue read-only browsing when active-like is blocked and direct post checks post cap', async () => {
  await workspaceFixture(async (store) => {
    const profileId = randomUUID();
    store.activityStats.saveBrowserRiskLimits({
      enabled: true,
      dailyMaxTotalActions: 10,
      dailyMaxPosts: 1,
      dailyMaxActiveLikes: 1,
    });
    store.activityStats.recordDailyActivity({
      carrier: 'browser',
      profileId,
      accountId: 'acc-1',
      likesDelta: 1,
      durationMsDelta: 1000,
    });
    // active-like blocked, active-friend & post still allowed
    assert.equal(
      store.activityStats.checkBrowserRiskLimit(profileId, 'active-like').allowed,
      false,
    );
    assert.equal(
      store.activityStats.checkBrowserRiskLimit(profileId, 'active-friend').allowed,
      true,
    );
    assert.equal((await checkDirectPostRiskLimit(store, profileId)).allowed, true);

    store.postBumpRecords.insert({
      recordType: 'post',
      carrier: 'browser',
      status: 'success',
      profileId,
      accountId: 'acc-1',
      postId: '12345',
      postUrl: 'https://www.facebook.com/12345',
      captionPreview: 'ok',
      errorReason: '',
      sourceLogId: randomUUID(),
      createdAt: Date.now(),
    });
    assert.equal((await checkDirectPostRiskLimit(store, profileId)).allowed, false);
  });

  // Feed continues read-only scrolling when active-like returns allowed:false
  const feedStep: StepInstance = {
    id: randomUUID(),
    jobId: randomUUID(),
    round: 1,
    position: 0,
    status: 'ACTIVE',
    spec: {
      id: randomUUID(),
      type: 'feed',
      durationMinutes: 1,
      maxLikes: 3,
      minLikeCount: 0,
      likeProbability: 100,
    },
    progress: { revision: 0, effectiveMilliseconds: 0, likes: 0, published: 0, cursor: null },
  };
  const { plan } = createStepPlan(feedStep);
  const ac = new AbortController();
  const diagEntries: DevDiagEntry[] = [];
  let likeClicks = 0;
  let scrollWheelCalls = 0;
  let readAttempts = 0;

  const mockStore = {
    tasks: {
      updateStepProgress: async () => {},
      hasAccountLiked: async () => false,
      recordAccountLike: async () => {},
    },
    activityStats: {
      recordDailyActivity: async () => {},
      checkBrowserRiskLimit: () => ({ allowed: false, reason: '今日已达点赞上限' }),
    },
  } as unknown as WorkspaceStorePort;

  const mockPage = {
    url: () => 'https://www.facebook.com/',
    goto: async () => {},
    bringToFront: async () => {},
    mouse: {
      wheel: async () => {
        scrollWheelCalls += 1;
      },
      move: async () => {},
      click: async () => {
        likeClicks += 1;
      },
    },
    keyboard: { press: async () => {} },
    viewportSize: () => ({ width: 1280, height: 800 }),
    locator: () => ({
      first: () => ({
        evaluate: async () => ({ cx: 10, cy: 10 }),
        click: async () => {
          likeClicks += 1;
        },
      }),
    }),
    evaluate: async () => {
      readAttempts += 1;
      if (readAttempts === 1) {
        throw Error('Cannot find context with specified id');
      }
      return {
        url: 'https://www.facebook.com/',
        timeOrigin: 1000,
        ready: true,
        visible: true,
        blocked: false,
        scrollY: scrollWheelCalls * 400,
        viewportHeight: 800,
        contentKey: `post-${scrollWheelCalls}`,
        likeTarget: {
          css: FACEBOOK_BROWSE_LIKE_CSS,
          liked: false,
          likeCount: 50,
          sponsored: false,
          text: 'hello',
        },
        video: null,
      };
    },
  } as unknown as Page;

  const lease = {
    profileId: plan.profileId,
    accountId: 'acc-w7',
    signal: ac.signal,
    page: mockPage,
    guard: () => {},
    execOp: async (_label: string, work: () => Promise<unknown>) => work(),
  } as unknown as BrowserSessionLease;

  const origNow = Date.now;
  const origRandom = Math.random;
  const origSetTimeout = globalThis.setTimeout;
  let fakeNow = 10_000;
  Date.now = () => {
    fakeNow += 3_000;
    return fakeNow;
  };
  Math.random = () => 0;
  globalThis.setTimeout = ((cb: (...args: unknown[]) => void) => {
    cb();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  devDiag.setSink((entry) => diagEntries.push(entry));
  try {
    const res = await executeBrowseStep(mockStore, plan, feedStep, lease);
    assert.equal(res.kind, 'COMPLETED');
    assert.equal(res.progress.likes, 0);
    assert.ok(res.progress.effectiveMilliseconds >= 60_000);
    assert.equal(likeClicks, 0);
    assert.ok(scrollWheelCalls >= 1);
    assert.ok(diagEntries.some((e) => e.event === 'BROWSE_LIKE_DAILY_LIMIT_SKIP'));
    const retryLog = diagEntries.find((e) => e.event === 'BROWSE_CONTEXT_RETRY');
    assert.ok(retryLog);
    assert.equal(retryLog.level, 'INFO');

    // KernelRpcSession downgrades transient context-destroyed rpc-errors to WARN (never ERROR)
    const session = new KernelRpcSession(
      { profileId: plan.profileId, epoch: randomUUID(), online: true } as unknown as Peer,
      'owner-w7',
      () => 1,
    );
    diagEntries.length = 0;
    session.record('rpc-error:{"code":-32000,"message":"Cannot find context with specified id"}');
    session.record('rpc-error:{"code":-32000,"message":"Execution context was destroyed"}');
    session.record('rpc-error:{"code":-32000,"message":"Something truly fatal"}');
    const rpcTraces = diagEntries.filter((e) => e.event === 'KERNEL_SESSION_TRACE');
    assert.equal(rpcTraces.length, 3);
    assert.equal(rpcTraces[0]?.level, 'WARN');
    assert.equal(rpcTraces[1]?.level, 'WARN');
    assert.equal(rpcTraces[2]?.level, 'ERROR');
  } finally {
    Date.now = origNow;
    Math.random = origRandom;
    globalThis.setTimeout = origSetTimeout;
    devDiag.setSink(null);
  }
});

test('BUG-P1-02: CreateCombination & SaveCombination enforce resourceMode table while CombinationSchema preserves read compatibility', () => {
  const basePost = {
    id: randomUUID(),
    type: 'post' as const,
    destination: 'post' as const,
    resourceDirectory: '',
    resourceMode: 'table' as const,
    allowRepeat: false,
    forbidSameAccountRepeat: true as const,
    archivePublished: false,
    count: 1,
  };
  const makeCombo = (postOverrides: Record<string, unknown>) => ({
    name: '组合测试',
    note: '',
    steps: [{ ...basePost, ...postOverrides }],
    randomOrder: false,
    loop: { mode: 'finite' as const, rounds: 1 },
  });

  // Valid table combination passes both CreateCombination & SaveCombination
  assert.equal(CreateCombination.safeParse({ value: makeCombo({}) }).success, true);
  assert.equal(
    SaveCombination.safeParse({ id: randomUUID(), expectedRevision: 0, value: makeCombo({}) })
      .success,
    true,
  );

  // Legacy directory / missing resourceMode / non-empty resourceDirectory rejected on write
  for (const badOverrides of [
    { resourceMode: 'directory', resourceDirectory: 'D:\\legacy' },
    { resourceMode: undefined, resourceDirectory: 'D:\\legacy' },
    { resourceMode: 'table', resourceDirectory: 'D:\\unexpected' },
  ]) {
    const createRes = CreateCombination.safeParse({ value: makeCombo(badOverrides) });
    assert.equal(createRes.success, false);
    if (!createRes.success) {
      assert.ok(
        createRes.error.issues.some((i) =>
          i.message.includes(
            '发帖步骤已统一为「组合资源表」模式，不再支持旧本地目录模式，请改用组合资源表',
          ),
        ),
      );
    }
    const saveRes = SaveCombination.safeParse({
      id: randomUUID(),
      expectedRevision: 1,
      value: makeCombo(badOverrides),
    });
    assert.equal(saveRes.success, false);
    if (!saveRes.success) {
      assert.ok(
        saveRes.error.issues.some((i) =>
          i.message.includes(
            '发帖步骤已统一为「组合资源表」模式，不再支持旧本地目录模式，请改用组合资源表',
          ),
        ),
      );
    }
  }

  // Read compatibility preserved in CombinationSchema & SavedCombinationSchema for old DB rows
  const legacyCombo = makeCombo({ resourceMode: 'directory', resourceDirectory: 'D:\\legacy' });
  assert.equal(CombinationSchema.safeParse(legacyCombo).success, true);
  assert.equal(
    SavedCombinationSchema.safeParse({
      id: randomUUID(),
      version: 1,
      revision: 0,
      saved: legacyCombo,
      draft: null,
      updatedAt: Date.now(),
    }).success,
    true,
  );
});
