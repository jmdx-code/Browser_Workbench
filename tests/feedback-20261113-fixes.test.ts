import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ChromeKernelBackend } from '../extension/kernel-backend.js';
import { FacebookGroupSessionHelper } from '../src/infrastructure/facebook-group-session.js';
import { requireBumperPost } from '../src/infrastructure/group-bumper-runner.js';
import type { BumperPost } from '../src/infrastructure/group-bumper-effects.js';
import type { BumperTarget } from '../src/shared/group-bumper.js';

function makeBumperPost(overrides: Partial<BumperPost> = {}): BumperPost {
  return {
    postId: '1180388421600009',
    postUrl: 'https://www.facebook.com/109514255362292/posts/1180388421600009/',
    authorId: '100064999999999',
    authorName: 'ဘုရားသခင်ကို သိကျွမ်းခြင်း',
    authorAliases: ['100064999999999'],
    authorAvatarUrl: null,
    pinned: false,
    ageHours: 2,
    timeText: '2h',
    feedbackId: 'ZmVlZGJhY2s6MTE4MDM4ODQyMTYwMDAwOQ==',
    liked: false,
    reactionState: 'none',
    postCSS: '[data-wb-bumper-post="1180388421600009"]',
    likeCSS: '[data-wb-bumper-like="1180388421600009"]',
    commentCSS: '[data-wb-bumper-comment="1180388421600009"]',
    commentButtonCSS: null,
    hasVideo: false,
    comments: [],
    ...overrides,
  };
}

test('Issue 2: requireBumperPost accepts cross-mapped Classic Page posts in pageBumper mode while rejecting visitor and self posts', () => {
  const now = Date.now();
  const pageTarget: BumperTarget = {
    id: '109514255362292',
    name: 'ဘုရားသခင်ကို သိကျွမ်းခြင်း',
    avatarUrl: null,
    folderId: null,
    sortOrder: 0,
    totalBumpedCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const crossMappedPost = makeBumperPost();

  // Group bumper mode still strictly requires direct authorId/alias match
  assert.throws(
    () => requireBumperPost(crossMappedPost, pageTarget, crossMappedPost.feedbackId),
    /目标帖子或作者已变化/,
  );

  // Page bumper mode accepts cross-mapped Page posts belonging to the Page owner
  const accepted = requireBumperPost(crossMappedPost, pageTarget, crossMappedPost.feedbackId, {
    pageBumper: true,
    accountId: '61550000000001',
    pageOwnerAuthorId: '100064999999999',
  });
  assert.equal(accepted.postId, crossMappedPost.postId);

  // Rejects foreign visitor posts on the Page timeline
  const visitorPost = makeBumperPost({
    authorId: '100088888888888',
    authorName: 'Other Visitor',
    authorAliases: ['100088888888888'],
  });
  assert.throws(
    () =>
      requireBumperPost(visitorPost, pageTarget, visitorPost.feedbackId, {
        pageBumper: true,
        accountId: '61550000000001',
        pageOwnerAuthorId: '100064999999999',
      }),
    /目标帖子或作者已变化/,
  );

  // Rejects posts authored by the acting account itself
  const selfPost = makeBumperPost({
    authorId: '61550000000001',
    authorName: 'Acting Account',
    authorAliases: ['61550000000001'],
  });
  assert.throws(
    () =>
      requireBumperPost(selfPost, pageTarget, selfPost.feedbackId, {
        pageBumper: true,
        accountId: '61550000000001',
        pageOwnerAuthorId: '100064999999999',
      }),
    /目标帖子或作者已变化/,
  );

  // Rejects mismatched feedbackId
  assert.throws(
    () =>
      requireBumperPost(crossMappedPost, pageTarget, 'ZmVlZGJhY2s6OTk5OTk5OTk5OTk5OTk5OQ==', {
        pageBumper: true,
        accountId: '61550000000001',
        pageOwnerAuthorId: '100064999999999',
      }),
    /目标帖子或作者已变化/,
  );
});

test('Extra Bug A: FacebookGroupSessionHelper.isTransientPrepareError classifies FACEBOOK_TASK_DOCUMENT_TIMEOUT as transient', () => {
  assert.equal(
    FacebookGroupSessionHelper.isTransientPrepareError(new Error('FACEBOOK_TASK_DOCUMENT_TIMEOUT')),
    true,
  );
});

test('Issue 3: passive revealOwnedPage(proof, false) and armTaskPresentation never request OS window focus', async () => {
  const proof = {
    profileId: randomUUID(),
    browserSessionEpoch: randomUUID(),
    ownershipId: randomUUID(),
    tabId: 7,
    targetId: 'target-7',
  };
  const backend = Object.create(ChromeKernelBackend.prototype) as ChromeKernelBackend;
  let renderingEnsured = 0;
  Reflect.set(backend, 'access', 'facebook-task');
  Reflect.set(backend, 'owned', new Map([[7, proof]]));
  Reflect.set(backend, 'attached', new Map([[7, 'target-7']]));
  Reflect.set(backend, 'allowRead', () => true);
  Reflect.set(backend, 'journal', { writable: true, tabState: () => 'READY' });
  Reflect.set(backend, 'presentation', null);
  Reflect.set(backend, 'presentationTimer', null);
  Reflect.set(backend, 'presentationNow', () => 1_000);
  Reflect.set(backend, 'reportPresentation', () => {});
  Reflect.set(backend, 'rendering', {
    ensure: async () => {
      renderingEnsured++;
    },
  });

  let windowState: 'minimized' | 'normal' = 'minimized';
  let windowFocused = false;
  let tabActive = false;
  let tabUrl = 'https://www.facebook.com/';
  const windowUpdatePayloads: Record<string, unknown>[] = [];

  const prevChrome = Reflect.get(globalThis, 'chrome');
  try {
    Reflect.set(globalThis, 'chrome', {
      tabs: {
        get: async (id: number) => ({
          id,
          windowId: 11,
          active: tabActive,
          url: tabUrl,
        }),
        update: async (id: number, props: { active?: boolean }) => {
          if (props.active !== undefined) tabActive = props.active;
          return { id, windowId: 11, active: tabActive, url: tabUrl };
        },
      },
      windows: {
        get: async (id: number) => ({
          id,
          state: windowState,
          focused: windowFocused,
        }),
        update: async (id: number, props: { state?: 'normal'; focused?: boolean }) => {
          windowUpdatePayloads.push({ ...props });
          if (props.state) windowState = props.state;
          if (typeof props.focused === 'boolean') windowFocused = props.focused;
          return { id, state: windowState, focused: windowFocused };
        },
      },
      debugger: {
        getTargets: async () => [
          { id: 'target-7', tabId: 7, type: 'page', url: 'https://www.facebook.com/' },
        ],
      },
    });

    const passiveRes = await backend.revealOwnedPage(proof, false);
    assert.deepEqual(passiveRes, { tabId: 7, focused: false });
    assert.equal(tabActive, true);
    assert.equal(windowState, 'normal');
    assert.equal(renderingEnsured, 1);
    assert.equal(
      windowUpdatePayloads.some((p) => p.focused === true),
      false,
      'passive revealOwnedPage must never set focused: true (which triggers Virtual Desktop switching)',
    );

    // Transient empty tab.url during navigation does not trigger KERNEL_PRESENTATION_URL_CHANGED
    tabUrl = '';
    const reportedErrors: string[] = [];
    Reflect.set(backend, 'reportPresentation', (_event: string, data: { reason?: string }) => {
      if (data.reason) reportedErrors.push(data.reason);
    });
    await backend.armTaskPresentation(proof);
    const maintainPresentation = Reflect.get(
      backend,
      'maintainPresentation',
    ) as () => Promise<void>;
    await maintainPresentation.call(backend);
    assert.deepEqual(reportedErrors, []);
    const presentationTimer = Reflect.get(backend, 'presentationTimer') as ReturnType<
      typeof setInterval
    > | null;
    if (presentationTimer) clearInterval(presentationTimer);

    // Explicit user display (default focus = true) still focuses the browser window normally
    tabUrl = 'https://www.facebook.com/';
    const explicitRes = await backend.revealOwnedPage(proof);
    assert.deepEqual(explicitRes, { tabId: 7, focused: true });
    assert.equal(
      windowUpdatePayloads.some((p) => p.focused === true),
      true,
    );
  } finally {
    const presentationTimer = Reflect.get(backend, 'presentationTimer') as ReturnType<
      typeof setInterval
    > | null;
    if (presentationTimer) clearInterval(presentationTimer);
    Reflect.set(globalThis, 'chrome', prevChrome);
  }
});
