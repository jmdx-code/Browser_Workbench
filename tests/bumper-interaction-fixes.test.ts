import { BUMPER_REACTION_IDS } from '../src/infrastructure/bumper-reaction-target.js';
import { bumperNativeEvents } from './fixtures/bumper-native-events.js';
import { Core, type Peer } from '../src/bridge/core.js';
import { randomUUID } from 'node:crypto';
import type { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { projectGroupBumper } from '../src/infrastructure/group-bumper-effects.js';
import {
  GroupBumperBrowserAdapter,
  revealBumperControlIfNeeded,
} from '../src/infrastructure/group-bumper-runner.js';
import { dismissUnexpectedFacebookOverlays } from '../src/infrastructure/facebook-overlay-dismisser.js';
import { BumperSettings } from '../src/shared/group-bumper.js';
import type { Locator, Page } from 'playwright-core';

const group = '1116799701798635';
const author = '61571335405335';
const postId = '122184411446711180';

function setRect(
  el: Element,
  rect: { left?: number; top?: number; width?: number; height?: number },
) {
  const left = rect.left ?? 0;
  const top = rect.top ?? 0;
  const width = rect.width ?? 100;
  const height = rect.height ?? 32;
  el.getBoundingClientRect = () => ({
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  });
}

function attachFiberChain(
  el: Element,
  frames: Array<{ name: string; props: Record<string, unknown> }>,
) {
  let parent: Record<string, unknown> | undefined;
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (!f) continue;
    parent = {
      type: { displayName: f.name },
      memoizedProps: f.props,
      return: parent,
    };
  }
  Reflect.set(el, '__reactFiber$test', parent);
}

beforeEach(() => {
  document.body.innerHTML = '<main></main>';
  document.head.innerHTML = '<base href="https://www.facebook.com/">';
  vi.stubGlobal('location', new URL(`https://www.facebook.com/groups/${group}/`));
  Reflect.deleteProperty(window, '__wbReactRootNodesV1');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('Case 1: revealBumperControlIfNeeded does not scroll when button is in viewport and scrolls minimal delta (68px) when below viewport', async () => {
  Object.defineProperty(window, 'innerHeight', { value: 602, configurable: true });
  const scrollDeltas: number[] = [];
  window.scrollBy = vi.fn((arg: unknown) => {
    if (typeof arg === 'object' && arg !== null && 'top' in arg) {
      scrollDeltas.push(Number((arg as { top: number }).top));
    }
  }) as unknown as typeof window.scrollBy;

  const btn = document.createElement('button');
  document.body.appendChild(btn);

  const mockLocator = {
    evaluate: async (fn: (el: HTMLElement) => boolean) => fn(btn),
  } as unknown as Locator;

  // 1) Button already in viewport (top: 520, bottom: 552, vh: 602) -> returns false, 0 scroll
  setRect(btn, { left: 100, top: 520, width: 80, height: 32 });
  const didScrollInView = await revealBumperControlIfNeeded(mockLocator, 0);
  expect(didScrollInView).toBe(false);
  expect(scrollDeltas).toEqual([]);

  // 2) Button below bottom safe zone (top: 610, bottom: 642, vh: 602) -> minimal delta 642 - (602 - 28) = 68px
  setRect(btn, { left: 100, top: 610, width: 80, height: 32 });
  const didScrollBelow = await revealBumperControlIfNeeded(mockLocator, 0);
  expect(didScrollBelow).toBe(true);
  expect(scrollDeltas).toEqual([68]);
});

it.each([
  ...(['love', 'care', 'haha', 'wow', 'sad', 'angry'] as const).map((reaction) => ({
    reaction,
    missing: false,
  })),
  { reaction: 'care' as const, missing: true },
])(
  'native reaction $reaction, missing=$missing: ignores unknown labels, order, and summary buttons without changing the configured action',
  async ({ reaction, missing }) => {
    const main = document.querySelector('main');
    const article = document.createElement('div');
    article.setAttribute('role', 'article');
    article.innerHTML = `
    <a id="author-link" href="https://www.facebook.com/groups/${group}/user/${author}/">Target Page</a>
    <a id="post-link" href="https://www.facebook.com/groups/${group}/posts/${postId}/">1h</a>
    <div id="top-reactions-bar" role="toolbar" aria-label="查看留下心情的用户">
      <div id="summary-like" role="button" aria-label="赞：19位用户">19</div>
      <div id="summary-love" role="button" aria-label="大爱：3位用户">3</div>
      <div id="summary-care" role="button" aria-label="抱抱：2位用户">2</div>
    </div>
    <div id="like-btn" role="button" data-ad-rendering-role="like_button" aria-pressed="false" aria-label="赞">赞</div>
  `;
    main?.appendChild(article);
    [article, ...Array.from(article.querySelectorAll('*'))].forEach((el) =>
      setRect(el, { left: 40, top: 240, width: 120, height: 36 }),
    );
    // Summary buttons are 18x18 inside the 1st toolbar
    const topToolbar = article.querySelector('#top-reactions-bar');
    if (topToolbar) {
      attachFiberChain(topToolbar, [{ name: 'CometUFITopReactionsRenderer.react', props: {} }]);
    }
    for (const sel of ['#summary-like', '#summary-love', '#summary-care']) {
      const el = article.querySelector(sel);
      if (el) setRect(el, { left: 50, top: 210, width: 18, height: 18 });
    }

    // 2nd toolbar in DOM: CometUFIReactionsMenuDock with 7 reaction buttons (reactionID at depth 8 & 9)
    const dock = document.createElement('div');
    dock.setAttribute('role', 'toolbar');
    const dockSpecs = [
      { id: BUMPER_REACTION_IDS.like, key: 'like', label: '赞' },
      { id: BUMPER_REACTION_IDS.love, key: 'love', label: '大爱' },
      { id: BUMPER_REACTION_IDS.care, key: 'care', label: '抱抱' },
      { id: BUMPER_REACTION_IDS.haha, key: 'haha', label: '笑趴' },
      { id: BUMPER_REACTION_IDS.wow, key: 'wow', label: '哇' },
      { id: BUMPER_REACTION_IDS.sad, key: 'sad', label: '心碎' },
      { id: BUMPER_REACTION_IDS.angry, key: 'angry', label: '怒' },
    ];
    setRect(dock, { left: 40, top: 180, width: 320, height: 48 });
    attachFiberChain(dock, [{ name: 'CometUFIReactionsMenuDock.react', props: {} }]);

    const dockClickCounts: Record<string, number> = {};
    dockSpecs.forEach((spec, idx) => {
      const btn = document.createElement('div');
      btn.setAttribute('role', 'button');
      btn.setAttribute('aria-label', 'أي نص غير معروف');
      btn.id = `dock-${spec.key}`;
      setRect(btn, { left: 44 + idx * 42, top: 184, width: 38, height: 38 });
      // Put reactionID at depth 8 (p) and depth 9 (CometUFIReactionStrategy.react), with 8 wrapper frames above
      attachFiberChain(btn, [
        { name: 'div', props: {} },
        { name: 'CometPressable.react', props: {} },
        { name: 'BaseButton.react', props: {} },
        { name: 'CometTooltip.react', props: {} },
        { name: 'BaseTooltip.react', props: {} },
        { name: 'CometUFIReactionIcon.react', props: {} },
        { name: 'div', props: {} },
        { name: 'span', props: {} },
        { name: 'p', props: { reactionID: spec.id, reactionName: spec.key } },
        {
          name: 'CometUFIReactionStrategy.react',
          props: { reactionID: spec.id, feedback: { __id: 'ZmVlZGJhY2s6' + postId } },
        },
        { name: 'CometUFIReactionsMenuDock.react', props: {} },
      ]);
      btn.addEventListener('click', () => {
        dockClickCounts[spec.key] = (dockClickCounts[spec.key] ?? 0) + 1;
        const likeBtn = article.querySelector('#like-btn');
        likeBtn?.setAttribute('aria-label', spec.label);
        likeBtn?.setAttribute('aria-pressed', 'true');
      });
      if (!(missing && spec.key === reaction)) dock.prepend(btn);
    });
    document.body.appendChild(dock);

    let summaryClicked = 0;
    article.querySelector('#summary-love')?.addEventListener('click', () => {
      summaryClicked += 1;
    });
    article.querySelector('#summary-care')?.addEventListener('click', () => {
      summaryClicked += 1;
    });

    attachFiberChain(article, [
      {
        name: 'CometFeedUnitCard.react',
        props: {
          feedUnit: {
            id: btoa('Uzpf:VK:' + postId),
            creation_time: Math.floor(Date.now() / 1000) - 600,
            feedback: { id: 'ZmVlZGJhY2s6' + postId },
          },
        },
      },
    ]);

    let currentUrl = `https://www.facebook.com/groups/${group}/?sorting_setting=CHRONOLOGICAL`;
    let mutations = 0;
    const nativeEvents = bumperNativeEvents();
    const page = {
      url: () => currentUrl,
      viewportSize: () => ({ width: 933, height: 602 }),
      goto: async (url: string) => {
        currentUrl = url;
        return null;
      },
      waitForURL: async () => {},
      on: nativeEvents.on,
      off: nativeEvents.off,
      mouse: { wheel: async () => {}, move: async () => {} },
      keyboard: { type: async () => {}, insertText: async () => {} },
      evaluate: async (fn: Function, arg?: unknown) => {
        if (fn.name === 'projectGroupInvitationState') {
          return {
            accountId: '10000000009',
            ready: true,
            visible: true,
            verificationRequired: false,
          };
        }
        return fn(arg);
      },
      locator: (selector: string) => ({
        first() {
          return this;
        },
        hover: async () => {},
        evaluate: async (fn: Function, arg?: unknown) => {
          const el = document.querySelector(selector);
          if (!el) throw Error('Element not found: ' + selector);
          return fn(el, arg);
        },
        click: async () => {
          mutations += 1;
          const el = document.querySelector<HTMLElement>(selector);
          if (!el) throw Error('Element not found: ' + selector);
          el.click();
          if (el.id === 'dock-' + reaction)
            nativeEvents.like(
              '10000000009',
              'ZmVlZGJhY2s6' + postId,
              BUMPER_REACTION_IDS[reaction],
            );
        },
      }),
    };

    const proof = {
      ownershipId: '00000000-0000-4000-8000-000000000001',
      profileId: 'p',
      browserSessionEpoch: 'session',
      tabId: 1,
      targetId: 't',
    };
    const connection = {
      stopRequestId: '00000000-0000-4000-8000-000000000055',
      revokeInput: () => {},
      browser: { contexts: () => [{ pages: () => [page] }] },
      context: async () => ({ accountId: '10000000009' }),
      execute: async (binding: unknown, work: () => Promise<unknown>) => ({
        binding,
        value: await work(),
      }),
      reconcile: async () => {},
      get nativeMutationCalls() {
        return { input: mutations };
      },
      close: async () => {},
      retryClose: async () => {},
    };
    const peer = { online: true, synced: true, epoch: 'epoch', profileId: 'p', capabilities: [] };
    const kernel = {
      withSummary: async (_p: unknown, run: (port: unknown) => unknown) =>
        run({
          inventory: async () => ({
            tabs: [{ state: 'READY', proof }],
            workspaceMain: proof,
            operations: [],
          }),
        }),
      inspectFacebookIdentity: async () => ({ actor: { accountId: '10000000009' }, proof }),
      inspectIdleFacebookPage: async () => ({ actor: { accountId: '10000000009' }, proof }),
      connectFacebook: async () => connection,
    };
    const recorded: unknown[] = [];
    const repo = {
      getOperation: async () => null,
      listOperationsByProfile: async () => [],
      prepareOperation: async (input: unknown) => input,
      setOperationResolution: async (_id: string, r: unknown) => r,
      markOperationSettled: async () => {},
      markOperationReview: async () => {},
      confirmSubmission: async (_id: string, r: unknown, _cid: unknown, res: unknown) => {
        recorded.push(r);
        return res;
      },
      eligibility: async () => ({
        today: 0,
        allowed: true,
        duplicate: false,
      }),
      pickComment: async () => null,
      record: async (r: unknown) => {
        recorded.push(r);
        return true;
      },
      updateAvatar: async () => {},
      applyResolvedTargetMetadata: async () => false,
    };

    const runner = new GroupBumperBrowserAdapter(
      repo as never,
      () => kernel as never,
      () => ({ peers: new Map([['p', peer]]) }) as never,
      async () => false,
      0,
    );
    await runner.run(
      'p',
      [
        {
          id: group,
          name: group,
          avatarUrl: null,
          folderId: null,
          sortOrder: 0,
          totalBumpedCount: 0,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      [
        {
          id: author,
          name: 'Target Page',
          avatarUrl: null,
          folderId: null,
          sortOrder: 0,
          totalBumpedCount: 0,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      BumperSettings.parse({
        likeProbability: 100,
        commentProbability: 0,
        useLongPressReaction: true,
        reactionTypes: [reaction],
      }),
      { cancelled: () => false, status: () => {}, added: () => {} },
    );

    expect(summaryClicked).toBe(0);
    expect(dockClickCounts[reaction] ?? 0).toBe(missing ? 0 : 1);
    expect(Object.values(dockClickCounts).reduce((a, b) => a + b, 0)).toBe(missing ? 0 : 1);
    expect(recorded.length).toBe(missing ? 0 : 1);
    expect(mutations).toBe(missing ? 0 : 1);
  },
);

it('Case 3: projectGroupBumper identifies top-level CometUFICommentRow(isComposer: true, depth: 0) editor while excluding depth: 1 replies and existing comments', () => {
  const main = document.querySelector('main');
  const article = document.createElement('div');
  article.setAttribute('role', 'article');
  article.innerHTML = `
    <a id="author-link" href="https://www.facebook.com/groups/${group}/user/${author}/">Page Author</a>
    <a id="post-link" href="https://www.facebook.com/groups/${group}/posts/${postId}/">2h</a>
    <button id="like-btn" role="button" data-ad-rendering-role="like_button">Like</button>
    <div id="existing-comment-row" role="article">
      <a id="commenter-link" href="https://www.facebook.com/groups/${group}/user/999999999/">Other User</a>
      <div id="reply-editor" role="textbox" contenteditable="true" data-lexical-editor="true" aria-label="回复…"></div>
    </div>
    <div id="composer-row">
      <a id="self-avatar-link" href="https://www.facebook.com/groups/${group}/user/888888888/">Current Actor</a>
      <div id="top-comment-editor" role="textbox" contenteditable="true" data-lexical-editor="true" aria-label="写评论…"></div>
    </div>
  `;
  main?.appendChild(article);
  [article, ...Array.from(article.querySelectorAll('*'))].forEach((el) =>
    setRect(el, { left: 40, top: 200, width: 300, height: 36 }),
  );

  const storyId = btoa('Uzpf:VK:' + postId);
  attachFiberChain(article, [
    {
      name: 'CometFeedUnitCard.react',
      props: {
        feedUnit: {
          id: storyId,
          creation_time: Math.floor(Date.now() / 1000) - 600,
          feedback: { id: 'ZmVlZGJhY2s6' + postId },
        },
      },
    },
  ]);

  // Existing comment & nested depth: 1 reply editor must be excluded
  const existingRow = article.querySelector('#existing-comment-row');
  const replyEditor = article.querySelector('#reply-editor');
  const commenterLink = article.querySelector('#commenter-link');
  if (existingRow) {
    attachFiberChain(existingRow, [
      {
        name: 'CometUFICommentRow.react',
        props: {
          comment: { id: 'c1', body: { text: 'old' }, author: { id: '999999999' } },
          depth: 0,
        },
      },
    ]);
  }
  if (commenterLink) {
    attachFiberChain(commenterLink, [
      {
        name: 'CometUFICommentRow.react',
        props: {
          comment: { id: 'c1', body: { text: 'old' }, author: { id: '999999999' } },
          depth: 0,
        },
      },
    ]);
  }
  if (replyEditor) {
    attachFiberChain(replyEditor, [
      {
        name: 'CometUFIComposerInputWithActionsForLexicalInner.react',
        props: { commentAction: 'ADD', depth: 1 },
      },
      { name: 'CometUFICommentRow.react', props: { isComposer: true, depth: 1 } },
    ]);
  }

  // Top-level comment composer row: avatar link is inside CometUFICommentRow (must NOT pollute authorId),
  // while #top-comment-editor has isComposer: true, depth: 0 (must be recognized as commentCSS!)
  const selfAvatarLink = article.querySelector('#self-avatar-link');
  const topEditor = article.querySelector('#top-comment-editor');
  if (selfAvatarLink) {
    attachFiberChain(selfAvatarLink, [
      { name: 'CometUFICommentRow.react', props: { isComposer: true, depth: 0 } },
    ]);
  }
  if (topEditor) {
    attachFiberChain(topEditor, [
      {
        name: 'CometUFIComposerInputWithActionsForLexicalInner.react',
        props: { commentAction: 'ADD', depth: 0 },
      },
      {
        name: 'CometUFICommentRow.react',
        props: { isComposer: true, depth: 0, comment: undefined },
      },
      { name: 'CometFeedUnitCard.react', props: { feedUnit: { id: storyId } } },
    ]);
  }

  const surface = projectGroupBumper({ groupId: group });
  expect(surface.posts.length).toBe(1);
  const p = surface.posts[0];
  expect(p?.authorId).toBe(author);
  expect(p?.commentCSS).toBe(`[data-wb-bumper-comment="${postId}"]`);
  expect(topEditor?.getAttribute('data-wb-bumper-comment')).toBe(postId);
  expect(replyEditor?.getAttribute('data-wb-bumper-comment')).toBeNull();
});

it.each([false, true])(
  'comment rejected=%s: editor clearing or an optimistic comment cannot replace native success, and Enter is sent once',
  async (rejected) => {
    const main = document.querySelector('main');
    const article = document.createElement('div');
    article.setAttribute('role', 'article');
    article.innerHTML = `
    <a href="https://www.facebook.com/groups/${group}/user/${author}/">Page Author</a>
    <a href="https://www.facebook.com/groups/${group}/posts/${postId}/">1h</a>
    <button id="like-btn" role="button" data-ad-rendering-role="like_button" aria-pressed="true" aria-label="已赞">Liked</button>
    <div id="composer-host">
      <div id="top-comment-editor" role="textbox" contenteditable="true" data-lexical-editor="true" aria-label="写评论…"></div>
      <div id="sticker-btn" role="button" aria-label="用贴图评论"><svg></svg></div>
      <div id="gif-btn" role="button" aria-label="用动图评论"><svg></svg></div>
    </div>
  `;
    main?.appendChild(article);
    [article, ...Array.from(article.querySelectorAll('*'))].forEach((el) =>
      setRect(el, { left: 40, top: 220, width: 260, height: 34 }),
    );
    const stickerBtn = article.querySelector('#sticker-btn');
    if (stickerBtn) setRect(stickerBtn, { left: 850, top: 220, width: 28, height: 28 });

    let stickerClicked = 0;
    stickerBtn?.addEventListener('click', () => {
      stickerClicked += 1;
    });

    const storyId = btoa('Uzpf:VK:' + postId);
    const feedbackId = btoa('feedback:' + postId);
    attachFiberChain(article, [
      {
        name: 'CometFeedUnitCard.react',
        props: {
          feedUnit: {
            id: storyId,
            creation_time: Math.floor(Date.now() / 1000) - 600,
            feedback: { id: feedbackId },
          },
        },
      },
    ]);
    const topEditor = article.querySelector<HTMLElement>('#top-comment-editor');
    if (topEditor) {
      attachFiberChain(topEditor, [
        {
          name: 'CometUFIComposerInputWithActionsForLexicalInner.react',
          props: { commentAction: 'ADD', depth: 0 },
        },
        { name: 'CometUFICommentRow.react', props: { isComposer: true, depth: 0 } },
        { name: 'CometFeedUnitCard.react', props: { feedUnit: { id: storyId } } },
      ]);
    }

    let currentUrl = `https://www.facebook.com/groups/${group}/?sorting_setting=CHRONOLOGICAL`;
    let mutations = 0;
    let editorText = '';
    let postedComments: Array<{ id: string; text: string; authorId: string }> = [];

    const commentEvents = bumperNativeEvents();
    let enterCount = 0;
    const page = {
      url: () => currentUrl,
      viewportSize: () => ({ width: 933, height: 602 }),
      goto: async (url: string) => {
        currentUrl = url;
        return null;
      },
      waitForURL: async () => {},
      on: commentEvents.on,
      off: commentEvents.off,
      mouse: { wheel: async () => {}, move: async () => {} },
      keyboard: {
        type: async (ch: string) => {
          editorText += ch;
          if (topEditor) topEditor.textContent = editorText;
        },
        insertText: async (ch: string) => {
          editorText += ch;
          if (topEditor) topEditor.textContent = editorText;
        },
      },
      evaluate: async (fn: Function, arg?: unknown) => {
        if (fn.name === 'projectGroupInvitationState') {
          return {
            accountId: '10000000009',
            ready: true,
            visible: true,
            verificationRequired: false,
          };
        }
        const res = fn(arg);
        if (res && typeof res === 'object' && 'posts' in res) {
          const surface = res as { posts: Array<{ comments: unknown[] }> };
          if (surface.posts[0]) {
            surface.posts[0].comments = [...postedComments];
          }
        }
        return res;
      },
      locator: (selector: string) => ({
        first() {
          return this;
        },
        innerText: async () => editorText,
        evaluate: async (fn: Function, arg?: unknown) => {
          const el = document.querySelector(selector);
          if (!el) throw Error('Element not found: ' + selector);
          return fn(el, arg);
        },
        click: async () => {
          mutations += 1;
        },
        press: async (key: string) => {
          mutations += 1;
          if (key === 'Enter') {
            enterCount++;
            const submitted = editorText;
            // Lexical clears the editor immediately on Enter, and comment appears on screen shortly after
            editorText = '';
            if (topEditor) topEditor.textContent = '';
            postedComments = [{ id: 'c-new-1', text: submitted, authorId: '10000000009' }];
            commentEvents.comment('10000000009', feedbackId, submitted, rejected);
          }
        },
        pressSequentially: async (txt: string) => {
          editorText = txt;
          if (topEditor) topEditor.textContent = editorText;
        },
      }),
    };

    const proof = {
      ownershipId: '00000000-0000-4000-8000-000000000001',
      profileId: 'p',
      browserSessionEpoch: 'session',
      tabId: 1,
      targetId: 't',
    };
    const connection = {
      stopRequestId: '00000000-0000-4000-8000-000000000055',
      revokeInput: () => {},
      browser: { contexts: () => [{ pages: () => [page] }] },
      context: async () => ({ accountId: '10000000009' }),
      execute: async (binding: unknown, work: () => Promise<unknown>) => ({
        binding,
        value: await work(),
      }),
      reconcile: async () => {},
      get nativeMutationCalls() {
        return { input: mutations };
      },
      close: async () => {},
      retryClose: async () => {},
    };
    const peer = { online: true, synced: true, epoch: 'epoch', profileId: 'p', capabilities: [] };
    const kernel = {
      withSummary: async (_p: unknown, run: (port: unknown) => unknown) =>
        run({
          inventory: async () => ({
            tabs: [{ state: 'READY', proof }],
            workspaceMain: proof,
            operations: [],
          }),
        }),
      inspectFacebookIdentity: async () => ({ actor: { accountId: '10000000009' }, proof }),
      inspectIdleFacebookPage: async () => ({ actor: { accountId: '10000000009' }, proof }),
      connectFacebook: async () => connection,
    };
    const recorded: Array<{ commentText?: string | null }> = [];
    const repo = {
      getOperation: async () => null,
      listOperationsByProfile: async () => [],
      prepareOperation: async (input: unknown) => input,
      setOperationResolution: async (_id: string, r: unknown) => r,
      markOperationSettled: async () => {},
      markOperationReview: async () => {},
      confirmSubmission: async (
        _id: string,
        r: { commentText?: string | null },
        _cid: unknown,
        res: unknown,
      ) => {
        recorded.push(r);
        return res;
      },
      eligibility: async () => ({
        today: 0,
        allowed: true,
        duplicate: false,
      }),
      pickComment: async () => ({
        id: '00000000-0000-4000-8000-000000000099',
        text: '很棒的分享！',
        usedCount: 0,
        createdAt: 0,
      }),
      record: async (r: { commentText?: string | null }) => {
        recorded.push(r);
        return true;
      },
      updateAvatar: async () => {},
      applyResolvedTargetMetadata: async () => false,
    };

    const runner = new GroupBumperBrowserAdapter(
      repo as never,
      () => kernel as never,
      () => ({ peers: new Map([['p', peer]]) }) as never,
      async () => false,
      0,
    );
    await runner.run(
      'p',
      [
        {
          id: group,
          name: group,
          avatarUrl: null,
          folderId: null,
          sortOrder: 0,
          totalBumpedCount: 0,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      [
        {
          id: author,
          name: 'Page Author',
          avatarUrl: null,
          folderId: null,
          sortOrder: 0,
          totalBumpedCount: 0,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      BumperSettings.parse({
        likeProbability: 0,
        commentProbability: 100,
      }),
      { cancelled: () => false, status: () => {}, added: () => {} },
    );

    expect(stickerClicked).toBe(0);
    expect(enterCount).toBe(1);
    expect(recorded.length).toBe(rejected ? 0 : 1);
    if (!rejected) expect(recorded[0]?.commentText).toBe('很棒的分享！');
  },
);

it('Case 5: dismissUnexpectedFacebookOverlays closes unexpected dialogs while exempting password/security dialogs, keepSelector dialogs, and post action menu buttons', async () => {
  document.body.innerHTML = `
    <div id="who-reacted-dialog" role="dialog" aria-label="查看留下心情的用户">
      <div id="who-reacted-close" role="button" aria-label="关闭">X</div>
    </div>
    <div id="comment-modal-dialog" role="dialog" aria-label="Target Page的帖子">
      <div id="post-menu-btn" role="button" aria-label="可对这篇帖子执行的操作">...</div>
      <div id="circle-close-btn" role="button">X</div>
    </div>
    <div id="security-dialog" role="dialog" aria-label="安全验证">
      <input type="password" name="pass" />
      <div id="security-close" role="button" aria-label="关闭">X</div>
    </div>
    <div id="poster-work-dialog" role="dialog" data-wb-poster-dialog="1" aria-label="建立贴文">
      <div id="poster-close" role="button" aria-label="关闭">X</div>
    </div>
  `;

  for (const sel of [
    '#who-reacted-dialog',
    '#comment-modal-dialog',
    '#security-dialog',
    '#poster-work-dialog',
  ]) {
    const d = document.querySelector(sel);
    if (d) setRect(d, { left: 100, top: 60, width: 500, height: 420 });
  }
  const whoClose = document.querySelector('#who-reacted-close');
  if (whoClose) setRect(whoClose, { left: 560, top: 72, width: 36, height: 36 });

  // Post 20x20 "..." action menu button vs 36x36 FDSCircleButton top-right close button
  const postMenuBtn = document.querySelector('#post-menu-btn');
  if (postMenuBtn) {
    setRect(postMenuBtn, { left: 555, top: 80, width: 20, height: 20 });
    attachFiberChain(postMenuBtn, [{ name: 'FDSCircleButton.react', props: {} }]);
  }
  const circleCloseBtn = document.querySelector('#circle-close-btn');
  if (circleCloseBtn) {
    setRect(circleCloseBtn, { left: 556, top: 70, width: 36, height: 36 });
    attachFiberChain(circleCloseBtn, [{ name: 'FDSCircleButton.react', props: {} }]);
  }
  const secClose = document.querySelector('#security-close');
  if (secClose) setRect(secClose, { left: 560, top: 72, width: 36, height: 36 });
  const posterClose = document.querySelector('#poster-close');
  if (posterClose) setRect(posterClose, { left: 560, top: 72, width: 36, height: 36 });

  const clickedIds: string[] = [];
  for (const id of [
    'who-reacted-close',
    'post-menu-btn',
    'circle-close-btn',
    'security-close',
    'poster-close',
  ]) {
    document.getElementById(id)?.addEventListener('click', () => clickedIds.push(id));
  }

  const mockPage = {
    evaluate: async (fn: (keep?: string) => unknown, keep?: string) => fn(keep),
  } as unknown as Page;

  const res = await dismissUnexpectedFacebookOverlays(mockPage, {
    keepSelector: '[data-wb-poster-dialog="1"]',
  });

  expect(res.dismissed).toBe(2);
  expect(clickedIds).toContain('who-reacted-close');
  expect(clickedIds).toContain('circle-close-btn');
  expect(clickedIds).not.toContain('post-menu-btn');
  expect(clickedIds).not.toContain('security-close');
  expect(clickedIds).not.toContain('poster-close');
});

it('native single-post query binds the visible footer to its own Story, never a background link or reply editor', () => {
  const targetPost = '123456789012345';
  const targetActor = '61599999999999';
  const parentFeedback = btoa('feedback:' + targetPost);
  const storyKey = 'story:target';
  const records: Record<string, Record<string, unknown>> = {
    [storyKey]: {
      __typename: 'Story',
      post_id: targetPost,
      actors: { __refs: [targetActor] },
      feedback: { __ref: parentFeedback },
      creation_time: Date.now() / 1000,
    },
    [targetActor]: { id: targetActor, name: 'Target actor' },
    [parentFeedback]: { id: parentFeedback },
  };
  const environment = {
    getStore: () => ({ getSource: () => ({ get: (id: string) => records[id] }) }),
  };
  document.body.innerHTML = `<main><article role="article"><a href="/someone/posts/${targetPost}/">shared target</a><button>background Like</button></article></main>
    <div role="dialog"><div id="body">target body</div><div id="footer"><button id="real-like" role="button">Like</button><div id="real-editor" role="textbox" contenteditable="true"></div><div id="reply" role="textbox" contenteditable="true"></div></div></div>`;
  document.querySelectorAll('*').forEach((el) => setRect(el, { width: 400, height: 100 }));
  const background = document.querySelector('article')!;
  attachFiberChain(background, [
    {
      name: 'CometFeedUnitCard.react',
      props: {
        story: {
          __id: 'background',
          post_id: '999999999999999',
          actors: [{ id: '100000000000001' }],
        },
      },
    },
  ]);
  const query = {
    name: 'CometSinglePostDialogRoot.react',
    props: {
      queries: {
        singlePostDialogRootQueryReference: { variables: { storyID: storyKey }, environment },
      },
    },
  };
  attachFiberChain(document.querySelector('[role="dialog"]')!, [query]);
  attachFiberChain(document.getElementById('real-like')!, [
    { name: 'CometUFIReactButtonBase.react', props: { feedback: { __id: parentFeedback } } },
    query,
  ]);
  attachFiberChain(document.getElementById('real-editor')!, [
    { name: 'CometUFIComposerInner.react', props: { feedback: { __id: parentFeedback } } },
    { name: 'CometUFICommentRow.react', props: { isComposer: true, depth: 0 } },
    query,
  ]);
  attachFiberChain(document.getElementById('reply')!, [
    { name: 'CometUFICommentRow.react', props: { depth: 1, comment: { id: 'existing-comment' } } },
    query,
  ]);
  const actual = projectGroupBumper({
    groupId: '-',
    pageId: targetActor,
    targetPostId: targetPost,
  });
  expect(actual.posts).toHaveLength(1);
  expect(actual.posts[0]).toMatchObject({
    postId: targetPost,
    authorId: targetActor,
    authorName: 'Target actor',
    feedbackId: parentFeedback,
  });
  expect(document.getElementById('real-editor')?.getAttribute('data-wb-bumper-comment')).toBe(
    targetPost,
  );
  expect(document.getElementById('reply')?.hasAttribute('data-wb-bumper-comment')).toBe(false);
  expect(background.hasAttribute('data-wb-bumper-post')).toBe(false);
  expect(projectGroupBumper({ groupId: '-', targetPostId: '888888888888888' }).posts).toHaveLength(
    0,
  );
});

it('a link to a target and an unrelated editable dialog cannot rename a different native Story', () => {
  document.body.innerHTML =
    '<main><article role="article"><a href="/actor/posts/888888888888888/">embedded shared post</a></article></main><div role="dialog"><div role="textbox" contenteditable="true"></div></div>';
  document.querySelectorAll('*').forEach((el) => setRect(el, { width: 400, height: 100 }));
  attachFiberChain(document.querySelector('article')!, [
    {
      name: 'CometFeedUnitCard.react',
      props: { story: { post_id: '999999999999999', __id: 'own-story' } },
    },
  ]);
  expect(projectGroupBumper({ groupId: '-', targetPostId: '888888888888888' }).posts).toHaveLength(
    0,
  );
  expect(document.querySelector('[role="textbox"]')?.hasAttribute('data-wb-bumper-comment')).toBe(
    false,
  );
});

it('current native Comet error route is reported with its own reason; stale and foreign routes do not block', () => {
  const title = 'native-title-in-any-language';
  const body = 'native-explanation';
  const route = {
    tracePolicy: 'comet.error',
    url: location.href,
    rootView: { resource: { __dr: 'CometErrorRoot.react' }, props: { title, body } },
  };
  document.body.innerHTML = `<main><h1>${title}</h1><p>${body}</p></main>`;
  const script = document.createElement('script');
  script.type = 'application/json';
  script.textContent = JSON.stringify({ route });
  document.body.append(script);
  const blocked = projectGroupBumper({ groupId: '-' });
  expect(blocked.restricted).toBe(true);
  expect(blocked.restrictionReason).toBe(title + ' · ' + body);
  route.url = 'https://www.facebook.com/another';
  script.textContent = JSON.stringify(route);
  expect(projectGroupBumper({ groupId: '-' }).restricted).toBe(false);
  route.url = location.href;
  script.textContent = JSON.stringify(route);
  document.querySelector('main')!.textContent = 'normal loading content';
  expect(projectGroupBumper({ groupId: '-' }).restricted).toBe(false);
});

it('preparation exceeding fifteen seconds retains one attempt until it converges; cancellation releases its owner', async () => {
  vi.useFakeTimers();
  const profileId = randomUUID();
  const core = new Core({ unresolved: async () => [] } as never);
  const peer = {
    profileId,
    epoch: randomUUID(),
    online: true,
    synced: true,
    phase: 'PAUSED',
    capabilities: [],
  } as unknown as Peer;
  core.peers.set(profileId, peer);
  let calls = 0,
    held = false,
    cancelled = false;
  let release!: () => void;
  let began!: () => void;
  const started = new Promise<void>((r) => (began = r));
  const kernel = {
    withSummary: async (_peer: Peer, fn: (port: unknown) => Promise<unknown>) => {
      const owner = randomUUID();
      calls++;
      await core.claimFixtureKernel(peer, owner);
      try {
        if (calls === 2) {
          held = true;
          began();
          await new Promise<void>((r) => (release = r));
        }
        return await fn({
          inventory: async () => ({ tabs: [], operations: [], workspaceMain: null }),
        });
      } finally {
        core.releaseFixtureKernel(peer, owner);
        held = false;
      }
    },
    inspectIdleFacebookPage: async () => null,
    inspectFacebookIdentity: async () => {
      throw Error('fixture identity stopped');
    },
  } as unknown as KernelBridge;
  const adapter = new GroupBumperBrowserAdapter(
    { listOperationsByProfile: async () => [] } as never,
    () => kernel,
    () => core,
    async () => false,
    0,
  );
  const target = {
    id: '123456789',
    name: 'target',
    avatarUrl: null,
    folderId: null,
    sortOrder: 0,
    totalBumpedCount: 0,
    createdAt: 0,
    updatedAt: 0,
  };
  const result = adapter
    .run(profileId, [target], [target], BumperSettings.parse({}), {
      cancelled: () => cancelled,
      status: () => {},
      added: () => {},
    })
    .then(
      () => null,
      (e) => e,
    );
  await started;
  await vi.advanceTimersByTimeAsync(16000);
  expect(calls).toBe(2);
  expect(held).toBe(true);
  cancelled = true;
  release();
  const error = await result;
  expect(String(error)).toContain('已停止');
  expect(String(error)).not.toContain('KERNEL_PROFILE_NOT_IDLE');
  expect(held).toBe(false);
  const owner = randomUUID();
  await core.claimFixtureKernel(peer, owner);
  core.releaseFixtureKernel(peer, owner);
});
