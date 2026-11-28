import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import type { Locator, Page } from 'playwright-core';
import type { Core, Peer } from '../src/bridge/core.js';
import { executeBrowseStep } from '../src/infrastructure/active-account-runtime/browse-step-executor.js';
import { withBrowserSession } from '../src/infrastructure/browser-session-lease.js';
import { projectFacebookBrowsePage } from '../src/infrastructure/facebook-browse-reader.js';
import { projectGroupInvitationState } from '../src/infrastructure/group-inviter-effects.js';
import { createBumperSessionRuntime } from '../src/infrastructure/group-bumper/bumper-session.js';
import { revealInvitationControl } from '../src/infrastructure/group-inviter-runner/inviter-ops.js';
import { waitMediaAndSubmitPost } from '../src/infrastructure/group-poster-runner/poster-publish.js';
import { extractCreatedGroupPostIdFromGraphQL } from '../src/infrastructure/group-poster-runner/poster-support.js';
import type { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import { connectAgentBrowserImpl } from '../src/infrastructure/kernel-bridge/kernel-connections.js';
import type { WorkspaceStorePort } from '../src/infrastructure/persistence-port.js';
import {
  FACEBOOK_BROWSE_LIKE_CSS,
  FACEBOOK_FRIEND_CONFIRM_CSS,
} from '../src/shared/facebook-browse-route.js';
import { kernelAgentBrowserURL } from '../src/shared/kernel-policy.js';
import type { Plan, StepInstance } from '../src/shared/task-contracts.js';

function withDomGlobals<T>(win: Window, fn: () => T): T {
  const keys = [
    'window',
    'document',
    'navigator',
    'location',
    'Element',
    'HTMLElement',
    'HTMLAnchorElement',
    'HTMLImageElement',
    'HTMLVideoElement',
    'getComputedStyle',
    'innerWidth',
    'innerHeight',
    'scrollY',
  ] as const;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const k of keys) saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
  const winAsRecord = win as unknown as Record<string, unknown>;
  Object.defineProperty(win, 'innerWidth', { configurable: true, value: 1280 });
  Object.defineProperty(win, 'innerHeight', { configurable: true, value: 720 });
  Object.defineProperty(win, 'scrollY', { configurable: true, value: 0 });
  for (const k of keys) {
    Object.defineProperty(globalThis, k, {
      configurable: true,
      writable: true,
      value: k === 'window' ? win : winAsRecord[k],
    });
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      const desc = saved.get(k);
      if (desc) Object.defineProperty(globalThis, k, desc);
      else Reflect.deleteProperty(globalThis, k);
    }
    void win.close();
  }
}

test('connectAgentBrowserImpl permits initialUrl="about:blank" used by AgentBrowserManager', async () => {
  assert.equal(kernelAgentBrowserURL('about:blank'), true);
  const offlinePeer = {
    profileId: 'p-agent',
    online: false,
    synced: false,
    phase: 'PAUSED',
  } as unknown as Peer;
  await assert.rejects(
    () =>
      connectAgentBrowserImpl(
        { core: { peers: new Map() } } as never,
        async () => {},
        offlinePeer,
        { initialUrl: 'about:blank' },
      ),
    (err: Error & { code?: string }) => {
      assert.doesNotMatch(err.message, /AGENT_BROWSER_URL_REJECTED/);
      assert.equal(err.code, 'AGENT_BROWSER_PROFILE_NOT_READY');
      return true;
    },
  );
});

test('Reels reader still detects Liked target with img icon and Burmese labels, and friends confirms Burmese button', () => {
  const win = new Window({ url: 'https://www.facebook.com/reel/1234567890' });
  win.document.body.innerHTML = `
    <main style="opacity:1;display:block;visibility:visible">
      <div id="reel-wrap" style="opacity:1">
        <video src="https://video.example/reel.mp4" style="opacity:1"></video>
        <div role="button" aria-label="ကြိုက်ပြီး" style="opacity:1">
          <img src="https://static.example/thumb.png" style="opacity:1" />
        </div>
      </div>
    </main>
  `;
  const mockRect = (top: number, left: number, width: number, height: number): DOMRect =>
    ({
      top,
      left,
      bottom: top + height,
      right: left + width,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  const mainEl = win.document.querySelector('main') as unknown as HTMLElement;
  const videoEl = win.document.querySelector('video') as unknown as HTMLVideoElement;
  const likeEl = win.document.querySelector('[role="button"]') as unknown as HTMLElement;
  const imgEl = win.document.querySelector('img') as unknown as HTMLElement;
  mainEl.getBoundingClientRect = () => mockRect(60, 0, 1280, 660);
  videoEl.getBoundingClientRect = () => mockRect(70, 340, 400, 620);
  likeEl.getBoundingClientRect = () => mockRect(420, 760, 48, 48);
  imgEl.getBoundingClientRect = () => mockRect(428, 768, 24, 24);
  win.document.elementFromPoint = () => likeEl as never;

  const projected = withDomGlobals(win, () => projectFacebookBrowsePage());
  assert.ok(projected.likeTarget, 'Reels likeTarget should remain non-null after icon swap');
  assert.equal(projected.likeTarget.liked, true);
  assert.equal(projected.likeTarget.css, FACEBOOK_BROWSE_LIKE_CSS);

  const friendsWin = new Window({ url: 'https://www.facebook.com/friends/requests/' });
  friendsWin.document.body.innerHTML = `
    <main style="opacity:1;display:block;visibility:visible">
      <div id="row" style="opacity:1">
        <a href="/friend.test" style="opacity:1">Aung Aung</a>
        <div role="button" style="opacity:1">အတည်ပြုရန်</div>
      </div>
    </main>
  `;
  const fMain = friendsWin.document.querySelector('main') as unknown as HTMLElement;
  const fBtn = friendsWin.document.querySelector('[role="button"]') as unknown as HTMLElement;
  fMain.getBoundingClientRect = () => mockRect(60, 0, 1280, 660);
  fBtn.getBoundingClientRect = () => mockRect(180, 200, 140, 36);
  friendsWin.document.elementFromPoint = () => fBtn as never;

  const friendsProj = withDomGlobals(friendsWin, () => projectFacebookBrowsePage());
  assert.equal(friendsProj.friendConfirmCSS, FACEBOOK_FRIEND_CONFIRM_CSS);

  const zhReelWin = new Window({ url: 'https://www.facebook.com/reel/1179046878121581' });
  zhReelWin.document.body.innerHTML = `
    <main style="opacity:1;display:block;visibility:visible">
      <div id="reel-wrap" style="opacity:1">
        <video src="https://video.example/reel2.mp4" style="opacity:1"></video>
        <div id="like-btn" role="button" aria-label="移除赞，15.6 万个心情" style="opacity:1">
          <div id="badge" style="opacity:1;background-color:rgb(8, 102, 255)">
            <svg style="opacity:1"></svg>
          </div>
        </div>
        <div id="react-btn" role="button" aria-label="更改赞心情" style="opacity:1">
          <svg style="opacity:1"></svg>
        </div>
      </div>
    </main>
  `;
  const zhMain = zhReelWin.document.querySelector('main') as unknown as HTMLElement;
  const zhVideo = zhReelWin.document.querySelector('video') as unknown as HTMLVideoElement;
  const zhLike = zhReelWin.document.querySelector('#like-btn') as unknown as HTMLElement;
  const zhBadge = zhReelWin.document.querySelector('#badge') as unknown as HTMLElement;
  const zhReact = zhReelWin.document.querySelector('#react-btn') as unknown as HTMLElement;
  zhMain.getBoundingClientRect = () => mockRect(60, 0, 1280, 660);
  zhVideo.getBoundingClientRect = () => mockRect(70, 340, 400, 620);
  zhLike.getBoundingClientRect = () => mockRect(380, 760, 48, 48);
  zhBadge.getBoundingClientRect = () => mockRect(384, 764, 40, 40);
  zhReact.getBoundingClientRect = () => mockRect(430, 760, 48, 48);
  zhReelWin.document.elementFromPoint = () => zhLike as never;

  const zhProj = withDomGlobals(zhReelWin, () => projectFacebookBrowsePage());
  assert.ok(zhProj.likeTarget, 'Reels likeTarget should recognize 移除赞 label and blue badge');
  assert.equal(zhProj.likeTarget.liked, true);
  assert.equal(zhProj.likeTarget.likeCount, 156_000);
});

test('executeBrowseStep polls post-click Reels like and requires verified change before crediting Friends confirm', async () => {
  const likedIds: string[] = [];
  const evalResponses: Array<Record<string, unknown>> = [
    {
      url: 'https://www.facebook.com/reel/99887766',
      timeOrigin: 1000,
      ready: true,
      visible: true,
      blocked: false,
      scrollY: 0,
      viewportHeight: 720,
      contentKey: 'https://video.example/1.mp4',
      recommendedDwellMs: 1400,
      likeTarget: {
        css: FACEBOOK_BROWSE_LIKE_CSS,
        liked: false,
        likeCount: 100,
        sponsored: false,
        text: 'hello',
      },
      video: {
        css: 'video',
        source: 'https://video.example/1.mp4',
        paused: false,
        buffering: false,
        ended: false,
        timeSeconds: 2,
        playbackRate: 1,
      },
    },
    {
      url: 'https://www.facebook.com/reel/99887766',
      timeOrigin: 1000,
      ready: true,
      visible: true,
      blocked: false,
      scrollY: 0,
      viewportHeight: 720,
      contentKey: 'https://video.example/1.mp4',
      recommendedDwellMs: 1400,
      likeTarget: {
        css: FACEBOOK_BROWSE_LIKE_CSS,
        liked: false,
        likeCount: 100,
        sponsored: false,
        text: 'hello',
      },
      video: {
        css: 'video',
        source: 'https://video.example/1.mp4',
        paused: false,
        buffering: false,
        ended: false,
        timeSeconds: 3,
        playbackRate: 1,
      },
    },
    {
      url: 'https://www.facebook.com/reel/99887766',
      timeOrigin: 1000,
      ready: true,
      visible: true,
      blocked: false,
      scrollY: 0,
      viewportHeight: 720,
      contentKey: 'https://video.example/1.mp4',
      recommendedDwellMs: 1400,
      likeTarget: {
        css: FACEBOOK_BROWSE_LIKE_CSS,
        liked: false,
        likeCount: 100,
        sponsored: false,
        text: 'hello',
      },
      video: {
        css: 'video',
        source: 'https://video.example/1.mp4',
        paused: false,
        buffering: false,
        ended: false,
        timeSeconds: 4,
        playbackRate: 1,
      },
    },
    {
      url: 'https://www.facebook.com/reel/99887766',
      timeOrigin: 1000,
      ready: true,
      visible: true,
      blocked: false,
      scrollY: 0,
      viewportHeight: 720,
      contentKey: 'https://video.example/1.mp4',
      recommendedDwellMs: 1400,
      likeTarget: {
        css: FACEBOOK_BROWSE_LIKE_CSS,
        liked: true,
        likeCount: 101,
        sponsored: false,
        text: 'hello',
      },
      video: {
        css: 'video',
        source: 'https://video.example/1.mp4',
        paused: false,
        buffering: false,
        ended: false,
        timeSeconds: 5,
        playbackRate: 1,
      },
    },
  ];
  let idx = 0;
  let scrollCalls = 0;
  let mouseClicks = 0;
  const mockStore = {
    tasks: {
      updateStepProgress: async () => {},
      hasAccountLiked: async () => false,
      recordAccountLike: async (_acc: string, cid: string) => {
        likedIds.push(cid);
      },
    },
  } as unknown as WorkspaceStorePort;
  const mockPage = {
    goto: async () => {},
    evaluate: async () => {
      const val = evalResponses[Math.min(idx, evalResponses.length - 1)];
      idx += 1;
      return val;
    },
    locator: () => ({
      first: () => ({
        evaluate: async () => ({ cx: 100, cy: 200 }),
        click: async () => {},
      }),
    }),
    viewportSize: () => ({ width: 1280, height: 720 }),
    mouse: {
      wheel: async () => {},
      move: async () => {},
      click: async () => {
        mouseClicks += 1;
      },
    },
    keyboard: { press: async () => {} },
  } as unknown as Page;
  const mockPlan = {
    id: 'plan-1',
    accountId: 'acc-1',
    profileId: 'prof-1',
  } as unknown as Plan;
  const videoStep: StepInstance = {
    id: 'step-video',
    round: 1,
    position: 0,
    status: 'RUNNING',
    spec: {
      type: 'video',
      durationMinutes: 0.5,
      maxLikes: 1,
      likeProbability: 100,
      minLikeCount: 0,
      skipSponsored: true,
    },
    progress: { revision: 0, effectiveMilliseconds: 0, likes: 0, published: 0 },
  } as unknown as StepInstance;
  const ac = new AbortController();
  const realDateNow = Date.now;
  let fakeNow = 10_000;
  Date.now = () => {
    fakeNow += 2_000;
    return fakeNow;
  };
  try {
    const res = await executeBrowseStep(mockStore, mockPlan, videoStep, {
      profileId: 'prof-1',
      accountId: 'acc-1',
      signal: ac.signal,
      page: mockPage,
      guard: () => {},
      execOp: async (_label: string, work: () => Promise<unknown>) => work(),
    } as never);
    assert.equal(res.kind, 'COMPLETED');
    assert.equal(res.progress.likes, 1);
    assert.equal(likedIds.length, 1);
    assert.equal(mouseClicks, 1);
    assert.equal(scrollCalls, 0);
  } finally {
    Date.now = realDateNow;
  }

  let fIdx = 0;
  const unverifiedState = {
    url: 'https://www.facebook.com/friends/requests/',
    timeOrigin: 1000,
    ready: true,
    visible: true,
    blocked: false,
    scrollY: 0,
    viewportHeight: 720,
    contentKey: 'friend-req:u1|pending:1',
    friendConfirmCSS: FACEBOOK_FRIEND_CONFIRM_CSS,
    friendPendingCount: 1,
    video: null,
  };
  const friendPage = {
    ...mockPage,
    locator: () => ({
      first: () => ({
        evaluate: async () => {
          scrollCalls += 1;
          return false;
        },
        click: async () => {},
      }),
    }),
    evaluate: async () => {
      fIdx += 1;
      return fIdx <= 20
        ? unverifiedState
        : {
            ...unverifiedState,
            contentKey: 'FRIENDS_REQUESTS_EXHAUSTED',
            friendConfirmCSS: null,
            friendPendingCount: 0,
          };
    },
  } as unknown as Page;
  const friendStep: StepInstance = {
    id: 'step-friends',
    round: 1,
    position: 0,
    status: 'RUNNING',
    spec: {
      type: 'friends',
      friendAction: 'accept',
      acceptMode: 'count',
      maxAccepts: 1,
      durationMinutes: 0.5,
    },
    progress: { revision: 0, effectiveMilliseconds: 0, likes: 0, published: 0, accepted: 0 },
  } as unknown as StepInstance;
  let friendNow = 10_000;
  Date.now = () => {
    friendNow += 3_000;
    return friendNow;
  };
  try {
    const fRes = await executeBrowseStep(mockStore, mockPlan, friendStep, {
      profileId: 'prof-1',
      accountId: 'acc-1',
      signal: ac.signal,
      page: friendPage,
      guard: () => {},
      execOp: async (_label: string, work: () => Promise<unknown>) => work(),
    } as never);
    assert.equal(fRes.kind, 'COMPLETED');
    assert.equal(fRes.progress.accepted, 0);
  } finally {
    Date.now = realDateNow;
  }
});

test('revealInvitationControl accounts for inner scrollParent top offset below dialog header', async () => {
  const win = new Window({ url: 'https://www.facebook.com/groups/123/' });
  win.document.body.innerHTML = `
    <div id="scroller" style="overflow-y:auto">
      <div id="cb" role="checkbox">Friend A</div>
    </div>
  `;
  const scroller = win.document.getElementById('scroller') as unknown as HTMLElement;
  const cb = win.document.getElementById('cb') as unknown as HTMLElement;
  Object.defineProperty(scroller, 'scrollHeight', { value: 900 });
  Object.defineProperty(scroller, 'clientHeight', { value: 300 });
  scroller.scrollTop = 200;
  scroller.getBoundingClientRect = () =>
    ({ top: 180, bottom: 480, left: 100, right: 500, width: 400, height: 300 }) as DOMRect;
  cb.getBoundingClientRect = () =>
    ({ top: 182, bottom: 210, left: 120, right: 480, width: 360, height: 28 }) as DOMRect;
  cb.scrollIntoView = () => {};
  win.document.elementFromPoint = () => cb as never;

  await withDomGlobals(win, () =>
    revealInvitationControl(
      {
        evaluate: async (fn: (el: Element, arg: number) => unknown, arg: number) => fn(cb, arg),
      } as unknown as Locator,
      0,
    ),
  );
  assert.ok(scroller.scrollTop < 200, `expected upward reveal scroll, got ${scroller.scrollTop}`);
});

test('waitMediaAndSubmitPost detects Burmese pending-approval toast and settles without error', async () => {
  let evalCallCount = 0;
  const pageWithPrePostNotices = {
    on: () => {},
    off: () => {},
    url: () => 'https://www.facebook.com/groups/123/',
    evaluate: async (fn: Function) => {
      const s = fn.toString();
      if (s.includes('Pending approval')) {
        evalCallCount += 1;
        return evalCallCount === 1
          ? []
          : ['သင့်ပို့စ်ကို ခွင့်ပြုချက်အတွက် စိစစ်ရန် ဆိုင်းငံ့ထားသည်'];
      }
      if (s.includes('hasComposer')) return { hasComposer: false, restrictedDialog: false };
      return true;
    },
    locator: () => ({
      first: () => ({
        evaluate: async () => {},
        click: async () => {},
      }),
    }),
  } as unknown as Page;

  let postedPostId = '';
  const conn = {
    context: async () => ({
      profileId: 'p1',
      accountId: 'acc1',
      leaseId: 'l1',
      epoch: 'e1',
      tabId: 1,
    }),
    submissionCalls: { mousePress: 1, enter: 0 },
    execute: async (_binding: unknown, fn: () => Promise<unknown>) => ({ value: await fn() }),
    reconcile: async () => {},
  } as never;

  await waitMediaAndSubmitPost({
    profileId: 'p1',
    getPage: () => pageWithPrePostNotices,
    getConn: () => conn,
    peer: { online: true, synced: true } as unknown as Peer,
    kernel: {} as KernelBridge,
    core: undefined,
    accountId: 'acc1',
    accountName: 'Acc',
    jobId: 'j1',
    stepId: 's1',
    effectiveGroupId: '123',
    effectiveGroupName: 'Group',
    isPageTimeline: false,
    groupAvatarUrl: null,
    resolvedGroupAvatar: null,
    surface: { avatarUrl: null } as never,
    material: { id: 'm1', caption: '', mediaSource: 'x.jpg', mediaKind: 'image' } as never,
    identityMeta: { identityType: 'personal', accountAvatar: null },
    paceScale: 0,
    posterRepo: undefined,
    callbacks: {
      runId: 'r1',
      cancelled: () => false,
      status: () => {},
      onTaskPosted: async (entry: { postId: string }) => {
        postedPostId = entry.postId;
      },
    } as never,
    markedPendingReviewRef: { value: false },
    guard: () => {},
    assertIdentity: async () => {},
    execOp: async (_l, work) => work(),
    stopProfile: async () => {},
    reconnectAfterUncertainOp: async () => {},
  });
  assert.equal(postedPostId, 'pending_approval');
});

test('bumper searchViaInputOrUrl scopes search inputs strictly to [role="banner"] and handles Burmese aria-label', async () => {
  const checkedSelectors: string[] = [];
  const navigated: string[] = [];
  let currentUrl = 'https://www.facebook.com/';
  const mockPage = {
    url: () => currentUrl,
    evaluate: async (fn: Function, arg?: unknown) => {
      if (typeof arg === 'string' && arg.includes('[role="banner"]')) {
        checkedSelectors.push(arg);
        return false;
      }
      if (arg === undefined && fn.toString().includes('performance.timeOrigin'))
        return `${currentUrl}|1000`;
      return {
        url: currentUrl,
        accountId: '100',
        visible: true,
        ready: true,
        dialog: false,
        menu: false,
        dialogCount: 0,
        joined: true,
        items: [],
      };
    },
    goto: async (u: string) => {
      currentUrl = u;
      navigated.push(u);
      return null;
    },
  } as unknown as Page;

  const peer = { profileId: 'p1', online: true, synced: true, epoch: 'e1' } as unknown as Peer;
  const conn = {
    proof: { tabId: 1, profileId: 'p1', ownershipId: 'o1', browserSessionEpoch: 'se1' },
    stopRequestId: 'stop-1',
    context: async () => ({
      profileId: 'p1',
      accountId: '100',
      leaseId: 'l1',
      epoch: 'e1',
      tabId: 1,
    }),
    nativeMutationCalls: {},
    execute: async (_b: unknown, work: () => Promise<unknown>) => ({ value: await work() }),
    reconcile: async () => {},
    browser: { contexts: () => [{ pages: () => [mockPage] }] },
  };
  const kernel = {
    withSummary: async (_p: Peer, fn: (port: unknown) => Promise<unknown>) =>
      fn({ inventory: async () => ({ profileId: 'p1', tabs: [], operations: [] }) }),
    inspectIdleFacebookPage: async () => ({
      actor: { accountId: '100', name: 'A' },
      proof: conn.proof,
    }),
    connectFacebook: async () => conn,
    revealOwnedFacebookPage: async () => {},
  } as unknown as KernelBridge;

  const session = await createBumperSessionRuntime({
    profileId: 'p1',
    initialPeer: peer,
    kernel,
    core: {
      peers: new Map([['p1', peer]]),
      inspectKernelProfileIdle: async () => ({
        idle: true,
        reason: 'IDLE',
        unresolvedCount: 0,
        legacyFixtureCount: 0,
      }),
    } as unknown as Core,
    repo: {
      prepareOperation: async () => {},
      setOperationResolution: async (_id: string, r: unknown) => r,
      markOperationSettled: async () => {},
      listOperationsByProfile: async () => [],
    } as never,
    isBusy: async () => false,
    paceScale: 0,
    callbacks: { cancelled: () => false, status: () => {} } as never,
    connections: new Map(),
    closing: new Map(),
    stopProfile: async () => {},
    clock: { now: () => Date.now(), sleep: async () => {} },
  });

  await session.searchViaInputOrUrl(
    'group name',
    'https://www.facebook.com/groups/search/groups/?q=group',
  );
  assert.ok(checkedSelectors[0]?.includes('[role="banner"] input[aria-label*="ရှာ"]'));
  assert.ok(
    checkedSelectors[0]?.split(',').every((part) => part.trim().startsWith('[role="banner"]')),
  );
  assert.equal(navigated.length, 1);
});

test('withBrowserSession reconnects once on transient null context unless canceled by user', async () => {
  const peer = {
    profileId: 'p-lease',
    online: true,
    synced: true,
    phase: 'PAUSED',
    epoch: 'e1',
    browserWindowCount: 1,
  } as unknown as Peer;
  const ac = new AbortController();
  let connectCount = 0;
  let failureReason: string | null = null;
  const makeConn = (nullCtx: boolean) => ({
    stopRequestId: `stop-${connectCount}`,
    get failureReason() {
      return failureReason;
    },
    proof: { tabId: 1, profileId: 'p-lease', ownershipId: 'o1' },
    browser: { contexts: () => [{ pages: () => [{ url: () => 'https://www.facebook.com/' }] }] },
    context: async () =>
      nullCtx ? null : { profileId: 'p-lease', accountId: 'acc1', leaseId: 'l1', epoch: 'e1' },
    execute: async (_b: unknown, fn: () => Promise<unknown>) => ({ value: await fn() }),
    reconcile: async () => {},
    revokeInput: () => {},
    close: async () => {},
  });
  const kernel = {
    inventory: async () => ({ profileId: 'p-lease', tabs: [], operations: [] }),
    withSummary: async (_p: Peer, fn: (port: unknown) => Promise<unknown>) =>
      fn({ inventory: async () => ({ profileId: 'p-lease', tabs: [], operations: [] }) }),
    inspectIdleFacebookPage: async () => ({
      actor: { accountId: 'acc1', name: 'A' },
      proof: { tabId: 1, profileId: 'p-lease', ownershipId: 'o1' },
    }),
    connectFacebook: async () => {
      connectCount += 1;
      return makeConn(connectCount === 1);
    },
  } as unknown as KernelBridge;

  const val = await withBrowserSession(
    {
      core: {
        peers: new Map([['p-lease', peer]]),
        inspectKernelProfileIdle: async () => ({ idle: true, reason: 'IDLE' }),
      } as unknown as Core,
      kernel,
      workboard: {
        launchPermits: { run: async (_s: AbortSignal, fn: () => unknown) => fn() },
      } as never,
    },
    { profileId: 'p-lease', jobId: 'j1', signal: ac.signal, allowAutoLaunch: false },
    async (lease) => lease.execOp('op1', async () => 'recovered-ok'),
  );
  assert.equal(val, 'recovered-ok');
  assert.equal(connectCount, 2);

  connectCount = 0;
  failureReason = 'KERNEL_DEBUGGER_CANCELED_BY_USER';
  await assert.rejects(
    () =>
      withBrowserSession(
        {
          core: {
            peers: new Map([['p-lease', peer]]),
            inspectKernelProfileIdle: async () => ({ idle: true, reason: 'IDLE' }),
          } as unknown as Core,
          kernel,
          workboard: {
            launchPermits: { run: async (_s: AbortSignal, fn: () => unknown) => fn() },
          } as never,
        },
        { profileId: 'p-lease', jobId: 'j2', signal: ac.signal, allowAutoLaunch: false },
        async (lease) => lease.execOp('op2', async () => 'should-fail'),
      ),
    /FACEBOOK_EXECUTION_CONTEXT_LOST/,
  );
  assert.equal(connectCount, 1);

  let rejectOnceCount = 0;
  const ctxRetryKernel = {
    inventory: async () => ({ profileId: 'p-lease', tabs: [], operations: [] }),
    withSummary: async (_p: Peer, fn: (port: unknown) => Promise<unknown>) =>
      fn({ inventory: async () => ({ profileId: 'p-lease', tabs: [], operations: [] }) }),
    inspectIdleFacebookPage: async () => ({
      actor: { accountId: 'acc1', name: 'A' },
      proof: { tabId: 1, profileId: 'p-lease', ownershipId: 'o1' },
    }),
    connectFacebook: async () => {
      rejectOnceCount += 1;
      if (rejectOnceCount === 1) throw Error('KERNEL_CONTEXT_REJECTED');
      return makeConn(false);
    },
  } as unknown as KernelBridge;

  const retriedVal = await withBrowserSession(
    {
      core: {
        peers: new Map([['p-lease', peer]]),
        inspectKernelProfileIdle: async () => ({ idle: true, reason: 'IDLE' }),
      } as unknown as Core,
      kernel: ctxRetryKernel,
      workboard: {
        launchPermits: { run: async (_s: AbortSignal, fn: () => unknown) => fn() },
      } as never,
    },
    { profileId: 'p-lease', jobId: 'j3', signal: ac.signal, allowAutoLaunch: false },
    async () => 'context-retry-ok',
  );
  assert.equal(retriedVal, 'context-retry-ok');
  assert.equal(rejectOnceCount, 2);
});

test('extractCreatedGroupPostIdFromGraphQL ignores coincidental 368/1357031 substrings and inspects structured errors', () => {
  const okWithCoincidentalDigits = JSON.stringify({
    data: {
      story_create: {
        post_id: '1223689913570314',
        story: { id: 'UzpfSTExMTozNjg=' },
        media_width: 368,
      },
    },
  });
  const okParsed = extractCreatedGroupPostIdFromGraphQL(okWithCoincidentalDigits);
  assert.equal(okParsed.restricted, false);
  assert.equal(okParsed.postId, '1223689913570314');

  const pendingWithCoincidentalDigits = JSON.stringify({
    data: {
      group_composer_story_create: {
        is_pending: true,
        pending_post: { id: '368001' },
      },
    },
  });
  const pendingParsed = extractCreatedGroupPostIdFromGraphQL(pendingWithCoincidentalDigits);
  assert.equal(pendingParsed.restricted, false);
  assert.equal(pendingParsed.pendingApproval, true);

  const structuredBlocked = JSON.stringify({
    errors: [{ code: 368, summary: "You're Temporarily Blocked" }],
    data: { story_create: null },
  });
  const blockedParsed = extractCreatedGroupPostIdFromGraphQL(structuredBlocked);
  assert.equal(blockedParsed.restricted, true);
  assert.equal(blockedParsed.postId, null);
});

test('projectGroupInvitationState detects localized sendButton even without FDSButton primary fiber', () => {
  const win = new Window({ url: 'https://www.facebook.com/groups/1072811415396195' });
  win.document.body.innerHTML = `
    <div id="dlg" role="dialog" style="opacity:1;display:block">
      <div id="cb" role="checkbox" aria-checked="true" aria-label="Test Friend" style="opacity:1"></div>
      <div id="cancel" role="button" aria-label="取消邀请好友" style="opacity:1">取消邀请好友</div>
      <div id="send" role="button" aria-label="发送邀请" style="opacity:1">发送邀请</div>
    </div>
  `;
  const mockRect = (top: number, left: number, width: number, height: number): DOMRect =>
    ({
      top,
      left,
      bottom: top + height,
      right: left + width,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  const dlg = win.document.querySelector('#dlg') as unknown as HTMLElement;
  const cb = win.document.querySelector('#cb') as unknown as HTMLElement;
  const cancel = win.document.querySelector('#cancel') as unknown as HTMLElement;
  const send = win.document.querySelector('#send') as unknown as HTMLElement;
  dlg.getBoundingClientRect = () => mockRect(40, 200, 420, 400);
  cb.getBoundingClientRect = () => mockRect(120, 220, 360, 44);
  cancel.getBoundingClientRect = () => mockRect(390, 400, 80, 36);
  send.getBoundingClientRect = () => mockRect(390, 490, 100, 36);
  Reflect.set(cb, '__reactFiber$test', {
    type: { displayName: 'GroupsCometInviteFriendsSearchFriendItem' },
    memoizedProps: { user$key: { __id: '1000123456789' } },
    return: null,
  });

  const state = withDomGlobals(win, () => projectGroupInvitationState('[role="dialog"]'));
  assert.equal(state.dialog, true);
  assert.ok(state.sendButton, 'sendButton should be matched by localized label fallback');
  assert.equal(state.sendButton.disabled, false);
  assert.equal(send.getAttribute('data-wb-group-send-btn'), '1');
});

test('projectGroupInvitationState resolves React double-buffered alternate fiber beyond depth 256', () => {
  const win = new Window({ url: 'https://www.facebook.com/groups/1072811415396195' });
  win.document.body.innerHTML = `
    <div id="dlg" role="dialog" style="opacity:1;display:block">
      <div id="cb" role="checkbox" aria-checked="true" aria-label="Test Friend" style="opacity:1"></div>
      <div id="send" role="button" aria-label="发送邀请" style="opacity:1">发送邀请</div>
    </div>
  `;
  const mockRect = (top: number, left: number, width: number, height: number): DOMRect =>
    ({
      top,
      left,
      bottom: top + height,
      right: left + width,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  const dlg = win.document.querySelector('#dlg') as unknown as HTMLElement;
  const cb = win.document.querySelector('#cb') as unknown as HTMLElement;
  const send = win.document.querySelector('#send') as unknown as HTMLElement;
  dlg.getBoundingClientRect = () => mockRect(40, 200, 420, 400);
  cb.getBoundingClientRect = () => mockRect(120, 220, 360, 44);
  send.getBoundingClientRect = () => mockRect(390, 490, 100, 36);

  Reflect.set(cb, '__reactFiber$test', {
    type: { displayName: 'GroupsCometInviteFriendsSearchFriendItem' },
    memoizedProps: { user$key: { __id: '1000123456789' } },
    return: null,
  });

  const hostStateNode: { current: unknown } = { current: null };
  const rootA: Record<string, unknown> = { stateNode: hostStateNode, return: null };
  const rootB: Record<string, unknown> = { stateNode: hostStateNode, return: null };
  rootA.alternate = rootB;
  rootB.alternate = rootA;
  let tailA: Record<string, unknown> = rootA;
  let tailB: Record<string, unknown> = rootB;
  for (let i = 0; i < 270; i++) {
    tailA = { type: 'div', memoizedProps: {}, return: tailA };
    tailB = { type: 'div', memoizedProps: {}, return: tailB };
  }
  const fdsA = {
    type: { displayName: 'FDSButton.react' },
    memoizedProps: { type: 'primary', disabled: true },
    return: tailA,
  };
  const fdsB = {
    type: { displayName: 'FDSButton.react' },
    memoizedProps: { type: 'primary', disabled: false },
    return: tailB,
  };
  const leafB: Record<string, unknown> = { type: 'div', memoizedProps: {}, return: fdsB };
  const leafA: Record<string, unknown> = {
    type: 'div',
    memoizedProps: {},
    return: fdsA,
    alternate: leafB,
  };
  leafB.alternate = leafA;
  hostStateNode.current = rootB;
  Reflect.set(send, '__reactFiber$test', leafA);

  const state = withDomGlobals(win, () => projectGroupInvitationState('[role="dialog"]'));
  assert.equal(state.dialog, true);
  assert.ok(state.sendButton, 'sendButton should resolve across alternate Fiber tree');
  assert.equal(state.sendButton.disabled, false);
});
