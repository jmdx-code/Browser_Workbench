// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { projectGroupBumper, type BumperPost } from '../src/infrastructure/group-bumper-effects.js';
import { watchBumperVideo } from '../src/infrastructure/bumper-video.js';
const gid = '111111111111111',
  postId = '222222222222222',
  actor = '61500000000001';
const rect = (el: Element, x = 50, y = 50, w = 500, h = 500) => {
  el.getBoundingClientRect = () => ({
    x,
    y,
    left: x,
    top: y,
    right: x + w,
    bottom: y + h,
    width: w,
    height: h,
    toJSON: () => ({}),
  });
};
function fiber(el: Element, name: string, props: Record<string, unknown>, parent: unknown = null) {
  Reflect.set(el, '__reactFiber$test', {
    type: { displayName: name },
    memoizedProps: props,
    return: parent,
  });
}
function header(state: string) {
  const native = { __typename: 'Group', id: gid, viewer_join_state: state };
  const environment = {
    getStore: () => ({ getSource: () => ({ get: (id: string) => (id === gid ? native : null) }) }),
  };
  document.body.innerHTML = '<main><h1>Group</h1><button id="join">أي نص</button></main>';
  for (const e of Array.from(document.querySelectorAll('*'))) rect(e);
  fiber(document.querySelector('h1')!, 'GroupsCometHeader.react', {
    environment,
    group: { __id: gid },
  });
  fiber(document.querySelector('#join')!, 'GroupsCometJoinForumButton.react', {
    testid: 'group-can-join-' + gid,
    action: { __id: 'client:' + gid + ':join_action(source:"GROUP_MALL")' },
  });
  return native;
}
beforeEach(() => {
  vi.stubGlobal('location', new URL('https://www.facebook.com/groups/' + gid + '/'));
  Reflect.deleteProperty(window, '__wbReactRootNodesV1');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
it('native membership beats stale join buttons in every label language', () => {
  const native = header('CAN_JOIN');
  let s = projectGroupBumper({ groupId: gid });
  expect(s.groupJoinState).toBe('can-join');
  expect(s.joinGroupCSS).not.toBeNull();
  native.viewer_join_state = 'MEMBER';
  s = projectGroupBumper({ groupId: gid });
  expect(s.groupJoinState).toBe('member');
  expect(s.joinGroupCSS).toBeNull();
  native.viewer_join_state = 'REQUESTED';
  s = projectGroupBumper({ groupId: gid });
  expect(s.groupJoinState).toBe('pending');
  expect(s.joinGroupCSS).toBeNull();
});
it('a same-group membership form is a pending human question, not a welcome button', () => {
  header('CAN_JOIN');
  const d = document.createElement('div');
  d.setAttribute('role', 'dialog');
  d.setAttribute('aria-modal', 'true');
  d.innerHTML = '<textarea></textarea><button>Next</button>';
  document.body.append(d);
  rect(d);
  rect(d.querySelector('button')!);
  fiber(d, 'MembershipForm.react', { group: { __id: gid } });
  const s = projectGroupBumper({ groupId: gid });
  expect(s.groupJoinState).toBe('questions');
  expect(s.blockingDialog).toBe(true);
  expect(s.welcomeDismissCSS).toBeNull();
});
it('a modal native close button works in either corner without a label; edge chat is ignored', () => {
  header('MEMBER');
  const d = document.createElement('div');
  d.setAttribute('role', 'dialog');
  d.setAttribute('aria-modal', 'true');
  d.innerHTML = '<button>ข้อความใดก็ได้</button>';
  document.body.append(d);
  rect(d, 100, 50, 700, 600);
  const b = d.querySelector('button')!;
  rect(b, 110, 60, 36, 36);
  fiber(b, 'FDSCircleButton.react', {});
  let s = projectGroupBumper({ groupId: gid });
  expect(s.welcomeDismissCSS).not.toBeNull();
  d.remove();
  const chat = document.createElement('div');
  chat.setAttribute('role', 'dialog');
  chat.innerHTML = '<button>Close</button>';
  document.body.append(chat);
  rect(chat, 800, 500, 200, 200);
  rect(chat.querySelector('button')!, 810, 510, 30, 30);
  fiber(chat.querySelector('button')!, 'FDSCircleButton.react', {});
  s = projectGroupBumper({ groupId: gid });
  expect(s.blockingDialog).toBe(false);
  expect(s.welcomeDismissCSS).toBeNull();
});
it('confirmed group-member onboarding uses its unique native primary, never an arbitrary last button', () => {
  header('MEMBER');
  const d = document.createElement('div');
  d.setAttribute('aria-modal', 'true');
  d.innerHTML = '<button id="primary">Unknown</button><button id="other">Close</button>';
  document.body.append(d);
  rect(d);
  for (const b of Array.from(d.querySelectorAll('button'))) rect(b);
  fiber(d, 'GroupOnboarding.react', { group: { __id: gid } });
  fiber(d.querySelector('#primary')!, 'FDSButton.react', { type: 'primary' });
  let s = projectGroupBumper({ groupId: gid });
  expect(d.querySelector('#primary')?.getAttribute('data-wb-bumper-welcome-dismiss')).toBe('1');
  expect(s.blockingDialog).toBe(true);
  Reflect.deleteProperty(d.querySelector('#primary')!, '__reactFiber$test');
  s = projectGroupBumper({ groupId: gid });
  expect(s.welcomeDismissCSS).toBeNull();
  expect(d.querySelector('#other')?.hasAttribute('data-wb-bumper-welcome-dismiss')).toBe(false);
});
it('restriction classification uses native intervention evidence, not quoted warning text', () => {
  header('MEMBER');
  const d = document.createElement('div');
  d.setAttribute('role', 'dialog');
  d.textContent = 'Try Again Later / 暂时被禁止';
  rect(d);
  document.body.append(d);
  expect(projectGroupBumper({ groupId: gid }).restricted).toBe(false);
  fiber(d, 'GroupsCometFeatureInterventionDialog.react', {});
  expect(projectGroupBumper({ groupId: gid }).restricted).toBe(true);
  expect(projectGroupBumper({ groupId: gid }).welcomeDismissCSS).toBeNull();
});
it('video play control is selected from native playbackIcon, independent of the label', () => {
  header('MEMBER');
  const a = document.createElement('article');
  a.setAttribute('role', 'article');
  a.innerHTML =
    '<a href="/groups/' +
    gid +
    '/user/' +
    actor +
    '/">Page</a><a href="/groups/' +
    gid +
    '/posts/' +
    postId +
    '/">x</a><button>لا علاقة باللغة</button><video></video>';
  document.querySelector('main')!.append(a);
  for (const e of [a, ...Array.from(a.querySelectorAll('*'))]) rect(e);
  const card = {
    type: { displayName: 'CometFeedUnitCard.react' },
    memoizedProps: {
      story: {
        __id: btoa('actor:VK:' + postId),
        post_id: postId,
        creation_time: Date.now() / 1000,
        actors: [{ id: actor }],
      },
    },
    return: null,
  };
  Reflect.set(a, '__reactFiber$test', card);
  fiber(
    a.querySelector('button')!,
    'VideoPlayerPlaybackControlBase.react',
    { playbackIcon: 'play' },
    card,
  );
  let s = projectGroupBumper({ groupId: gid });
  expect(s.posts[0]?.videoPlayCSS).not.toBeNull();
  fiber(
    a.querySelector('button')!,
    'VideoPlayerPlaybackControlBase.react',
    { playbackIcon: 'pause' },
    card,
  );
  s = projectGroupBumper({ groupId: gid });
  expect(s.posts[0]?.videoPlayCSS).toBeNull();
});
function videoHarness(progress = true) {
  const video = document.createElement('video');
  document.body.append(video);
  rect(video);
  video.scrollIntoView = vi.fn();
  video.play = vi.fn(() => new Promise<void>(() => {}));
  const page = {
    locator: () => ({
      first() {
        return this;
      },
      evaluate: async (fn: Function, arg?: unknown) => fn(video, arg),
      click: async () => {},
    }),
  } as unknown as Page;
  const initial = {
    postId,
    feedbackId: 'fb',
    videoCSS: 'video',
    videoCurrentTime: 0,
    videoFrames: 0,
    videoPaused: false,
  } as BumperPost;
  let reads = 0,
    stopped = false;
  const guard = () => {
    if (stopped) throw Error('stopped');
  };
  const work = (extra: Record<string, unknown> = {}) =>
    watchBumperVideo({
      page,
      initial,
      guard,
      readCurrent: async () => ({
        ...initial,
        videoCurrentTime: progress ? ++reads : 0,
        videoFrames: progress ? reads * 30 : 0,
      }),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      sound: false,
      budgetMs: 3000,
      tickMs: 1000,
      stallMs: 1200,
      ...extra,
    });
  return {
    work,
    video,
    stop: () => {
      stopped = true;
    },
  };
}
it('a never-resolving play Promise cannot hang monitoring; actual progress reaches the budget', async () => {
  vi.useFakeTimers();
  const h = videoHarness();
  const p = h.work();
  await vi.runAllTimersAsync();
  expect(await p).toBe('budget');
});
it('no actual playback fails boundedly and never pretends the watch completed', async () => {
  vi.useFakeTimers();
  const h = videoHarness(false);
  const p = expect(h.work()).rejects.toThrow(/未推进|未实际播放/);
  await vi.runAllTimersAsync();
  await p;
});
it('stop interrupts watching before another read or recovery input', async () => {
  vi.useFakeTimers();
  const h = videoHarness();
  const pending = expect(h.work()).rejects.toThrow('stopped');
  h.stop();
  await vi.runAllTimersAsync();
  await pending;
});

it('deep video logger resolves the same complete Story card without taking an adjacent author', () => {
  header('MEMBER');
  const a = document.createElement('article');
  a.setAttribute('role', 'article');
  a.innerHTML = `<div id="inner"><a href="/groups/${gid}/posts/${postId}/">x</a></div><a href="/groups/${gid}/user/${actor}/">Page</a><button data-ad-rendering-role="like_button">anything</button>`;
  document.querySelector('main')!.append(a);
  for (const e of [a, ...a.querySelectorAll('*')]) rect(e);
  const story = {
    __id: btoa('actor:VK:' + postId),
    post_id: postId,
    actors: [{ id: actor }],
    feedback: { id: 'feedback-' + postId },
    creation_time: Date.now() / 1000,
  };
  const card = {
    type: { displayName: 'CometFeedUnitCard.react' },
    memoizedProps: { story },
    return: null,
  };
  Reflect.set(a, '__reactFiber$test', card);
  const link = a.querySelector('#inner a')!;
  let chain: unknown = card;
  for (let i = 0; i < 270; i++) chain = { type: 'div', memoizedProps: {}, return: chain };
  chain = {
    type: { displayName: 'CometFeedStoryClickLoggerContainer.react' },
    memoizedProps: { story: { __id: story.__id, post_id: postId } },
    return: chain,
  };
  Reflect.set(link, '__reactFiber$test', chain);
  fiber(a.querySelector('#inner')!, 'div', {}, card);
  fiber(
    a.querySelector('button')!,
    'CometUFIReactButtonBase.react',
    { feedback: { id: 'feedback-' + postId } },
    card,
  );
  const p = projectGroupBumper({ groupId: gid }).posts.find((p) => p.postId === postId);
  expect(p?.authorId).toBe(actor);
  expect(p?.likeCSS).not.toBeNull();
  // Changing the enclosing native Story must never fill this video's missing author.
  card.memoizedProps.story = {
    ...story,
    __id: btoa('other'),
    post_id: '999999999999999',
    actors: [{ id: '100000000000000' }],
  };
  const after = projectGroupBumper({ groupId: gid }).posts.find((p) => p.postId === postId);
  expect(after?.authorId).not.toBe('100000000000000');
});

it('post-dialog cleanup closes only the owned Story and verifies disappearance', async () => {
  const { closeBumperPostDialog } = await import('../src/infrastructure/group-bumper-runner.js');
  let own = true,
    presses = 0;
  const other = '999999999999999';
  const read = async () =>
    ({
      postDialogs: [
        ...(own ? [{ postId, feedbackId: 'fb', css: '#own' }] : []),
        { postId: other, feedbackId: 'other', css: '#other' },
      ],
    }) as ReturnType<
      (typeof import('../src/infrastructure/group-bumper-effects.js'))['readGroupBumper']
    >;
  await closeBumperPostDialog({
    postId,
    page: {
      keyboard: {
        press: async (key: string) => {
          expect(key).toBe('Escape');
          presses++;
          own = false;
        },
      },
    } as unknown as Page,
    guard: () => {},
    read,
    run: async (work, verify) => {
      const v = await work();
      return verify(v);
    },
  });
  expect(presses).toBe(1);
  expect((await read()).postDialogs?.map((d) => d.postId)).toEqual([other]);
});
it('an unclosed owned dialog stops before any following-post input', async () => {
  vi.useFakeTimers();
  const { closeBumperPostDialog } = await import('../src/infrastructure/group-bumper-runner.js');
  const read = async () =>
    ({ postDialogs: [{ postId, feedbackId: 'fb', css: '#own' }] }) as ReturnType<
      (typeof import('../src/infrastructure/group-bumper-effects.js'))['readGroupBumper']
    >;
  const pending = expect(
    closeBumperPostDialog({
      postId,
      page: { keyboard: { press: async () => {} } } as unknown as Page,
      guard: () => {},
      read,
      run: async (work, verify) => verify(await work()),
    }),
  ).rejects.toThrow('未能关闭');
  await vi.runAllTimersAsync();
  await pending;
});

function nativePostFixture() {
  header('MEMBER');
  const article = document.createElement('article');
  article.setAttribute('role', 'article');
  article.innerHTML = `<a href="/groups/${gid}/posts/${postId}/">1h</a><button data-ad-rendering-role="like_button">arbitrary</button>`;
  document.querySelector('main')!.append(article);
  for (const e of [article, ...article.querySelectorAll('*')]) rect(e);
  const story = {
    __id: 'story-' + postId,
    post_id: postId,
    actors: [{ id: actor }],
    feedback: { id: 'fb-' + postId },
    creation_time: Date.now() / 1000,
  };
  const card = {
    type: { displayName: 'CometFeedUnitCard.react' },
    memoizedProps: { story },
    return: null as unknown,
  };
  Reflect.set(article, '__reactFiber$test', card);
  fiber(
    article.querySelector('button')!,
    'CometUFIReactButtonBase.react',
    { feedback: { id: 'fb-' + postId } },
    card,
  );
  return { article, card, button: article.querySelector('button')! };
}
it('an empty loading projection leaves connected controls intact, but resolved posts drop obsolete controls', () => {
  const h = nativePostFixture();
  expect(projectGroupBumper({ groupId: gid }).posts[0]?.likeCSS).not.toBeNull();
  const loading = document.createElement('span');
  h.article.append(loading);
  rect(loading);
  fiber(loading, 'CometFeedGlimmer.react', {}, h.card);
  const during = projectGroupBumper({ groupId: gid });
  expect(during.loading).toBe(true);
  expect(during.posts).toEqual([]);
  expect(h.button.isConnected).toBe(true);
  expect(h.button.getAttribute('data-wb-bumper-like')).toBe(postId);
  loading.remove();
  h.button.removeAttribute('data-ad-rendering-role');
  Reflect.deleteProperty(h.button, '__reactFiber$test');
  const after = projectGroupBumper({ groupId: gid });
  expect(after.posts[0]?.postId).toBe(postId);
  expect(after.posts[0]?.likeCSS).toBeNull();
  expect(h.button.hasAttribute('data-wb-bumper-like')).toBe(false);
});
it('a DOM shell cannot borrow a nested native Story feedback, video, author or timestamp', () => {
  header('MEMBER');
  document.head.innerHTML = '<base href="https://www.facebook.com/">';
  const outer = document.createElement('article');
  outer.setAttribute('role', 'article');
  const innerId = '333333333333333',
    innerActor = '61500000000002';
  outer.innerHTML = `<a href="https://www.facebook.com/groups/${gid}/user/${actor}/">Outer</a><a href="https://www.facebook.com/groups/${gid}/posts/${postId}/">1h</a><section role="article" id="native"><a href="https://www.facebook.com/groups/${gid}/posts/${innerId}/">2h</a><button data-ad-rendering-role="like_button">whatever</button><video></video></section>`;
  document.querySelector('main')!.append(outer);
  for (const e of [outer, ...outer.querySelectorAll('*')]) rect(e);
  const inner = outer.querySelector('#native')!,
    card = {
      type: { displayName: 'CometFeedUnitCard.react' },
      memoizedProps: {
        story: {
          __id: 'inner-story',
          post_id: innerId,
          actors: [{ id: innerActor }],
          feedback: { id: 'inner-feedback' },
          creation_time: Date.now() / 1000 - 7200,
        },
        isPinned: true,
      },
      return: null,
    };
  Reflect.set(inner, '__reactFiber$test', card);
  fiber(
    inner.querySelector('button')!,
    'CometUFIReactButtonBase.react',
    { feedback: { id: 'inner-feedback' } },
    card,
  );
  fiber(inner.querySelector('video')!, 'CometVideoPlayer.react', {}, card);
  const s = projectGroupBumper({ groupId: gid });
  const a = s.posts.find((p) => p.postId === postId)!,
    b = s.posts.find((p) => p.postId === innerId)!;
  expect(s.posts.map((p) => ({ id: p.postId, author: p.authorId }))).toEqual([
    { id: postId, author: actor },
    { id: innerId, author: innerActor },
  ]);
  expect(a.authorId).toBe(actor);
  expect(a.feedbackId).toBeNull();
  expect(a.likeCSS).toBeNull();
  expect(a.hasVideo).toBe(false);
  expect(a.pinned).toBe(false);
  expect(b.authorId).toBe(innerActor);
  expect(b.likeCSS).not.toBeNull();
  expect(document.querySelector(b.likeCSS!)?.getAttribute('data-wb-bumper-like')).toBe(innerId);
  for (const p of s.posts)
    for (const css of [p.postCSS, p.likeCSS, p.commentCSS, p.videoCSS])
      if (css) expect(document.querySelector(css)).not.toBeNull();
});
it('loading ancestors outside a resolved Card do not discard its controls', () => {
  const h = nativePostFixture();
  h.card.return = {
    type: { displayName: 'CometFeedGlimmer.react' },
    memoizedProps: {},
    return: null,
  };
  const s = projectGroupBumper({ groupId: gid });
  expect(s.posts.find((p) => p.postId === postId)?.likeCSS).not.toBeNull();
});
it('single-post preparation refreshes before centering, retries a replaced node and verifies after centering', async () => {
  vi.useFakeTimers();
  const { prepareBumperPost, BumperPostReadIncomplete } =
    await import('../src/infrastructure/group-bumper-runner.js');
  const current = {
    postId,
    postCSS: '#current',
    likeCSS: '#current-like',
    hasVideo: false,
  } as BumperPost;
  const events: string[] = [];
  let reads = 0,
    centers = 0;
  const page = {
    locator: (css: string) => {
      events.push('loc:' + css);
      return {
        first: () => ({
          evaluate: async () => {
            events.push('center');
            if (centers++ === 0) throw Error('locator.evaluate: Timeout 750ms exceeded.');
          },
        }),
      };
    },
  } as unknown as Page;
  const work = prepareBumperPost({
    page,
    paceScale: 0,
    timeoutMs: 1500,
    guard: () => {},
    readCurrent: async () => {
      events.push('read');
      if (reads++ === 0) throw new BumperPostReadIncomplete();
      return current;
    },
  });
  await vi.runAllTimersAsync();
  expect(await work).toBe(current);
  expect(events[0]).toBe('read');
  expect(events.at(-1)).toBe('read');
  expect(centers).toBe(2);
  expect(events.filter((e) => e.startsWith('loc:'))).toEqual(['loc:#current', 'loc:#current']);
});
it('preparation timeout and stop do not emit business inputs or keep retrying indefinitely', async () => {
  vi.useFakeTimers();
  const { prepareBumperPost, BumperPostReadIncomplete } =
    await import('../src/infrastructure/group-bumper-runner.js');
  const locator = vi.fn();
  let stopped = false;
  const read = vi.fn(async () => {
    throw new BumperPostReadIncomplete();
  });
  const work = expect(
    prepareBumperPost({
      page: { locator } as unknown as Page,
      readCurrent: read,
      guard: () => {
        if (stopped) throw Error('stopped');
      },
      timeoutMs: 500,
      paceScale: 0,
    }),
  ).rejects.toThrow('准备超时');
  await vi.runAllTimersAsync();
  await work;
  expect(read.mock.calls.length).toBeLessThanOrEqual(4);
  expect(locator).not.toHaveBeenCalled();
  const stop = expect(
    prepareBumperPost({
      page: { locator } as unknown as Page,
      readCurrent: read,
      guard: () => {
        if (stopped) throw Error('stopped');
      },
      timeoutMs: 12000,
    }),
  ).rejects.toThrow('stopped');
  stopped = true;
  await vi.runAllTimersAsync();
  await stop;
});
it('an unloaded candidate is scrolled once as a card and must be re-read before preparation succeeds', async () => {
  vi.useFakeTimers();
  const { prepareBumperPost, BumperPostReadIncomplete } =
    await import('../src/infrastructure/group-bumper-runner.js');
  const current = { postId, postCSS: '#fresh-card', likeCSS: '#fresh-like' } as BumperPost;
  const centered: string[] = [];
  let hydrated = false;
  const work = prepareBumperPost({
    page: {
      locator: (css: string) => ({
        first: () => ({
          evaluate: async () => {
            centered.push(css);
            hydrated = true;
          },
        }),
      }),
    } as unknown as Page,
    candidateCardCSS: '#candidate-card',
    readCurrent: async () => {
      if (!hydrated) throw new BumperPostReadIncomplete();
      return current;
    },
    guard: () => {},
    paceScale: 0,
  });
  await vi.runAllTimersAsync();
  expect(await work).toBe(current);
  expect(centered).toEqual(['#candidate-card', '#fresh-card']);
  expect(centered).not.toContain('#fresh-like');
});
it('an inner Story logger is not assigned to a different enclosing native Card', () => {
  const h = nativePostFixture(),
    innerId = '444444444444444',
    innerActor = '61500000000003';
  const nested = document.createElement('section');
  nested.innerHTML = `<a href="https://www.facebook.com/groups/${gid}/posts/${innerId}/">inner</a><button data-ad-rendering-role="like_button">any label</button>`;
  h.article.append(nested);
  for (const el of [nested, ...nested.querySelectorAll('*')]) rect(el);
  const logger = {
    type: { displayName: 'CometFeedStoryClickLoggerContainer.react' },
    memoizedProps: {
      story: {
        __id: 'inner-story',
        post_id: innerId,
        actors: [{ id: innerActor }],
        feedback: { id: 'inner-feedback' },
      },
    },
    return: h.card,
  };
  Reflect.set(nested, '__reactFiber$test', logger);
  fiber(nested.querySelector('a')!, 'CometLink.react', {}, logger);
  fiber(
    nested.querySelector('button')!,
    'CometUFIReactButtonBase.react',
    { feedback: { id: 'inner-feedback' } },
    logger,
  );
  const s = projectGroupBumper({ groupId: gid });
  const a = s.posts.find((p) => p.postId === postId)!,
    b = s.posts.find((p) => p.postId === innerId)!;
  expect(a.authorId).toBe(actor);
  expect(b.authorId).toBe(innerActor);
  expect(document.querySelector(a.likeCSS!)).toBe(h.button);
  expect(document.querySelector(b.likeCSS!)).toBe(nested.querySelector('button'));
});

it('projects video speaker button and speaker muted state across labels and Fiber props', () => {
  header('MEMBER');
  const a = document.createElement('article');
  a.setAttribute('role', 'article');
  a.innerHTML = `<a href="/groups/${gid}/posts/${postId}/">p</a><a href="/groups/${gid}/user/${actor}/">Page</a><video src="https://video.xx.fbcdn.net/v.mp4"></video><div role="button" id="speaker" aria-label="Unmute"></div><button data-ad-rendering-role="like_button">Like</button>`;
  document.querySelector('main')!.append(a);
  for (const e of [a, ...a.querySelectorAll('*')]) rect(e);
  const videoEl = a.querySelector('video')!;
  videoEl.muted = true;
  const story = {
    __id: btoa('actor:VK:' + postId),
    post_id: postId,
    actors: [{ id: actor }],
    feedback: { id: 'feedback-' + postId },
  };
  const card = {
    type: { displayName: 'CometFeedUnitCard.react' },
    memoizedProps: { story },
    return: null,
  };
  Reflect.set(a, '__reactFiber$test', card);
  const speaker = a.querySelector('#speaker')!;
  fiber(speaker, 'VideoPlayerAudioButton.react', { isMuted: true }, card);

  let s = projectGroupBumper({ groupId: gid });
  expect(s.posts[0]?.videoAudioCSS).toBe(`[data-wb-bumper-video-audio="${postId}"]`);
  expect(s.posts[0]?.videoSpeakerMuted).toBe(true);
  expect(s.posts[0]?.videoMuted).toBe(true);

  speaker.setAttribute('aria-label', 'Mute');
  videoEl.muted = false;
  fiber(speaker, 'VideoPlayerAudioButton.react', { isMuted: false }, card);
  s = projectGroupBumper({ groupId: gid });
  expect(s.posts[0]?.videoSpeakerMuted).toBe(false);
  expect(s.posts[0]?.videoMuted).toBe(false);
});

it('watchBumperVideo clicks speaker button when sound=true so speaker icon turns on and video continues playing', async () => {
  vi.useFakeTimers();
  const video = document.createElement('video');
  document.body.append(video);
  rect(video);
  video.muted = true;
  video.volume = 0.2;
  video.scrollIntoView = vi.fn();
  video.play = vi.fn(async () => {});
  let speakerMuted = true;
  let speakerClicks = 0;
  const audioSelector = `[data-wb-bumper-video-audio="${postId}"]`;
  const page = {
    locator: (sel: string) => ({
      first() {
        return this;
      },
      evaluate: async (fn: Function, arg?: unknown) => fn(video, arg),
      hover: async () => {},
      click: async () => {
        if (sel === audioSelector) {
          speakerClicks++;
          speakerMuted = !speakerMuted;
          video.muted = speakerMuted;
        }
      },
    }),
  } as unknown as Page;
  let reads = 0;
  let unmutedObservedDuringWatch = false;
  const initial = {
    postId,
    feedbackId: 'fb',
    videoCSS: 'video',
    videoAudioCSS: audioSelector,
    videoMuted: true,
    videoSpeakerMuted: true,
    videoCurrentTime: 0,
    videoFrames: 0,
    videoPaused: false,
  } as BumperPost;
  const p = watchBumperVideo({
    page,
    initial,
    guard: () => {},
    readCurrent: async () => {
      reads++;
      if (!video.muted && !speakerMuted) unmutedObservedDuringWatch = true;
      return {
        ...initial,
        videoMuted: video.muted,
        videoSpeakerMuted: speakerMuted,
        videoCurrentTime: reads,
        videoFrames: reads * 30,
      };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    sound: true,
    budgetMs: 2500,
    tickMs: 800,
    stallMs: 3000,
  });
  await vi.runAllTimersAsync();
  expect(await p).toBe('budget');
  expect(speakerClicks).toBe(1);
  expect(unmutedObservedDuringWatch).toBe(true);
  expect(video.volume).toBeGreaterThanOrEqual(0.8);
  // Keep speaker icon and <video>.muted unmuted on normal completion so volumechange does not flip speaker back off
  expect(video.muted).toBe(false);
  expect(speakerMuted).toBe(false);
});

it('watchBumperVideo starts paused CometVideoPlayer first, hovers with force:true over sibling overlay, and clicks speaker button without poisoning el.muted beforehand', async () => {
  vi.useFakeTimers();
  const video = document.createElement('video');
  document.body.append(video);
  rect(video);
  video.muted = true;
  video.volume = 0.2;
  let paused = true;
  Object.defineProperty(video, 'paused', {
    configurable: true,
    get: () => paused,
  });
  video.scrollIntoView = vi.fn();
  let mutedWhenPlayStarted: boolean | null = null;
  video.play = vi.fn(async () => {
    mutedWhenPlayStarted = video.muted;
    paused = false;
  });

  let controlBarMounted = false;
  let speakerMuted = true;
  let speakerClicks = 0;
  const hoverForceFlags: boolean[] = [];
  const audioSelector = `[data-wb-bumper-video-audio="${postId}"]`;

  const page = {
    locator: (sel: string) => ({
      first() {
        return this;
      },
      evaluate: async (fn: Function, arg?: unknown) => {
        const el = sel === audioSelector ? document.createElement('div') : video;
        return fn(el, arg);
      },
      hover: async (opts?: { force?: boolean }) => {
        hoverForceFlags.push(Boolean(opts?.force));
        if (!opts?.force) {
          throw new Error('TimeoutError: subtree intercepts pointer events');
        }
        // CometVideoPlayer only mounts bottom speaker control once playback has started
        if (!paused) {
          controlBarMounted = true;
        }
      },
      click: async () => {
        if (sel === audioSelector) {
          speakerClicks++;
          speakerMuted = false;
          video.muted = false;
        }
      },
    }),
  } as unknown as Page;

  let reads = 0;
  const initial = {
    postId,
    feedbackId: 'fb',
    videoCSS: 'video',
    videoAudioCSS: null,
    videoMuted: true,
    videoCurrentTime: 0,
    videoFrames: 0,
    videoPaused: true,
  } as BumperPost;

  const p = watchBumperVideo({
    page,
    initial,
    guard: () => {},
    readCurrent: async () => {
      if (!paused) reads++;
      return {
        ...initial,
        videoPaused: paused,
        videoAudioCSS: controlBarMounted ? audioSelector : null,
        videoMuted: video.muted,
        ...(controlBarMounted ? { videoSpeakerMuted: speakerMuted } : {}),
        videoCurrentTime: reads,
        videoFrames: reads * 30,
      };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    sound: true,
    budgetMs: 2500,
    tickMs: 800,
    stallMs: 3000,
  });
  await vi.runAllTimersAsync();
  expect(await p).toBe('budget');
  expect(mutedWhenPlayStarted).toBe(true);
  expect(hoverForceFlags.length).toBeGreaterThanOrEqual(1);
  expect(hoverForceFlags.every(Boolean)).toBe(true);
  expect(speakerClicks).toBe(1);
  expect(speakerMuted).toBe(false);
  expect(video.muted).toBe(false);
});

it('projectGroupBumper resolves videoCSS and videoAudioCSS for shared/attached Reel inside a Group post without absorbing comment videos', () => {
  header('MEMBER');
  const outerPostId = '1533589038599880';
  const attachedReelId = '1471153598436852';
  const a = document.createElement('div');
  a.setAttribute('role', 'article');
  a.innerHTML = `
    <a href="/groups/${gid}/user/${actor}/">Goal of Faith Victory</a>
    <a href="/groups/${gid}/posts/${outerPostId}/">8m</a>
    <a href="/reel/${attachedReelId}/?group_id=${gid}&s=group">34s Reels</a>
    <div id="reelAttachment">
      <video id="sharedReelVideo" src="https://video.xx.fbcdn.net/reel.mp4"></video>
      <div role="button" id="sharedReelSpeaker" aria-label="取消静音"></div>
    </div>
    <button id="outerLike" data-ad-rendering-role="like_button">Like</button>
    <div role="article" id="commentItem">
      <video id="commentVideo"></video>
      <div role="button" id="commentSpeaker" aria-label="取消静音"></div>
    </div>
  `;
  const main = document.querySelector('main');
  if (!main) throw new Error('missing main');
  main.append(a);
  for (const e of [a, ...a.querySelectorAll('*')]) rect(e);

  const outerStory = {
    __id: btoa('group_share:' + outerPostId),
    post_id: outerPostId,
    actors: [{ id: actor }],
    feedback: { id: 'feedback-' + outerPostId },
    creation_time: Date.now() / 1000 - 480,
  };
  const outerCard = {
    type: { displayName: 'CometFeedUnitCard.react' },
    memoizedProps: { story: outerStory },
    return: null,
  };
  Reflect.set(a, '__reactFiber$test', outerCard);

  const innerLogger = {
    type: { displayName: 'CometFeedStoryClickLoggerContainer.react' },
    memoizedProps: {
      story: {
        __id: btoa('attached_reel:' + attachedReelId),
        post_id: attachedReelId,
      },
    },
    return: outerCard,
  };
  const reelAttachment = a.querySelector('#reelAttachment');
  const sharedVideo = a.querySelector<HTMLVideoElement>('#sharedReelVideo');
  const sharedSpeaker = a.querySelector('#sharedReelSpeaker');
  const outerLike = a.querySelector('#outerLike');
  const commentItem = a.querySelector('#commentItem');
  const commentVideo = a.querySelector('#commentVideo');
  const commentSpeaker = a.querySelector('#commentSpeaker');
  if (
    !reelAttachment ||
    !sharedVideo ||
    !sharedSpeaker ||
    !outerLike ||
    !commentItem ||
    !commentVideo ||
    !commentSpeaker
  ) {
    throw new Error('missing fixture nodes');
  }
  sharedVideo.muted = true;
  Reflect.set(reelAttachment, '__reactFiber$test', innerLogger);
  Reflect.set(sharedVideo, '__reactFiber$test', {
    type: 'video',
    memoizedProps: {},
    return: innerLogger,
  });
  Reflect.set(sharedSpeaker, '__reactFiber$test', {
    type: { displayName: 'ReelsAudioButton.react' },
    memoizedProps: { isMuted: true },
    return: innerLogger,
  });
  fiber(
    outerLike,
    'CometUFIReactButtonBase.react',
    { feedback: { id: 'feedback-' + outerPostId } },
    outerCard,
  );
  const commentRowFiber = {
    type: { displayName: 'CometUFICommentRow.react' },
    memoizedProps: { comment: { id: 'c1', body: { text: 'amen' } }, depth: 0 },
    return: outerCard,
  };
  Reflect.set(commentItem, '__reactFiber$test', commentRowFiber);
  Reflect.set(commentVideo, '__reactFiber$test', {
    type: 'video',
    memoizedProps: {},
    return: commentRowFiber,
  });
  Reflect.set(commentSpeaker, '__reactFiber$test', {
    type: 'div',
    memoizedProps: {},
    return: commentRowFiber,
  });

  const surface = projectGroupBumper({ groupId: gid });
  const post = surface.posts.find((p) => p.postId === outerPostId);
  expect(post).toBeDefined();
  expect(post?.authorId).toBe(actor);
  expect(post?.likeCSS).toBe(`[data-wb-bumper-like="${outerPostId}"]`);
  expect(post?.hasVideo).toBe(true);
  expect(post?.videoCSS).toBe(`[data-wb-bumper-video="${outerPostId}"]`);
  expect(post?.videoAudioCSS).toBe(`[data-wb-bumper-video-audio="${outerPostId}"]`);
  expect(post?.videoSpeakerMuted).toBe(true);
  expect(sharedVideo.getAttribute('data-wb-bumper-video')).toBe(outerPostId);
  expect(sharedSpeaker.getAttribute('data-wb-bumper-video-audio')).toBe(outerPostId);
  expect(commentVideo.getAttribute('data-wb-bumper-video')).toBeNull();
  expect(commentSpeaker.getAttribute('data-wb-bumper-video-audio')).toBeNull();
});

it('projectGroupBumper matches top-right speaker button nested inside <a href="/reel/..."> wrapper and survives alternate Fiber re-render while rejecting external link buttons', () => {
  header('MEMBER');
  const outerPostId = '1871483144196559';
  const attachedReelId = '1639415287921451';
  const a = document.createElement('div');
  a.setAttribute('role', 'article');
  a.innerHTML = `
    <a href="/groups/${gid}/user/${actor}/">Jesus Loves You</a>
    <a href="/groups/${gid}/posts/${outerPostId}/">7h</a>
    <a id="externalLink" href="https://example.com/promo">
      <div role="button" id="fakeLinkSpeaker" aria-label="取消静音">Fake</div>
    </a>
    <a id="reelCardAnchor" href="/reel/${attachedReelId}/?group_id=${gid}&s=group">
      <video id="anchorReelVideo" playsinline></video>
      <div tabindex="0" role="button" id="anchorReelSpeaker" aria-label="取消静音"></div>
    </a>
    <button id="outerLike2" data-ad-rendering-role="like_button">Like</button>
  `;
  const main = document.querySelector('main');
  if (!main) throw new Error('missing main');
  main.append(a);
  for (const e of [a, ...a.querySelectorAll('*')]) rect(e);

  const outerStory = {
    __id: btoa('group_reel_anchor:' + outerPostId),
    post_id: outerPostId,
    actors: [{ id: actor }],
    feedback: { id: 'feedback-' + outerPostId },
    creation_time: Date.now() / 1000 - 600,
  };
  const outerCard = {
    type: { displayName: 'CometFeedUnitCard.react' },
    memoizedProps: { story: outerStory },
    return: null,
    alternate: null as unknown,
  };
  Reflect.set(a, '__reactFiber$test', outerCard);

  const innerLogger = {
    type: { displayName: 'CometFeedStoryClickLoggerContainer.react' },
    memoizedProps: {
      story: {
        __id: btoa('reel_inner:' + attachedReelId),
        post_id: attachedReelId,
      },
    },
    return: outerCard,
  };
  const reelAnchor = a.querySelector('#reelCardAnchor');
  const reelVideo = a.querySelector<HTMLVideoElement>('#anchorReelVideo');
  const reelSpeaker = a.querySelector('#anchorReelSpeaker');
  const fakeLinkSpeaker = a.querySelector('#fakeLinkSpeaker');
  const outerLike2 = a.querySelector('#outerLike2');
  if (!reelAnchor || !reelVideo || !reelSpeaker || !fakeLinkSpeaker || !outerLike2) {
    throw new Error('missing anchor reel fixture nodes');
  }
  Reflect.set(reelAnchor, '__reactFiber$test', innerLogger);
  Reflect.set(reelVideo, '__reactFiber$test', {
    type: 'video',
    memoizedProps: {},
    return: innerLogger,
  });
  Reflect.set(reelSpeaker, '__reactFiber$test', {
    type: 'div',
    memoizedProps: { 'aria-label': '取消静音' },
    return: innerLogger,
  });
  fiber(
    outerLike2,
    'CometUFIReactButtonBase.react',
    { feedback: { id: 'feedback-' + outerPostId } },
    outerCard,
  );

  const beforeClick = projectGroupBumper({ groupId: gid });
  const postBefore = beforeClick.posts.find((p) => p.postId === outerPostId);
  expect(postBefore?.videoAudioCSS).toBe(`[data-wb-bumper-video-audio="${outerPostId}"]`);
  expect(postBefore?.videoSpeakerMuted).toBe(true);
  expect(reelSpeaker.getAttribute('data-wb-bumper-video-audio')).toBe(outerPostId);
  expect(fakeLinkSpeaker.getAttribute('data-wb-bumper-video-audio')).toBeNull();

  // Simulate React double-buffered alternate Fiber commit when speaker flips to 静音
  reelSpeaker.setAttribute('aria-label', '静音');
  const alternateOuterCard = {
    type: { displayName: 'CometFeedUnitCard.react' },
    memoizedProps: { story: outerStory },
    return: null,
    alternate: outerCard,
  };
  outerCard.alternate = alternateOuterCard;
  const alternateLogger = {
    ...innerLogger,
    return: alternateOuterCard,
  };
  Reflect.set(reelSpeaker, '__reactFiber$test', {
    type: 'div',
    memoizedProps: { 'aria-label': '静音' },
    return: alternateLogger,
  });

  const afterClick = projectGroupBumper({ groupId: gid, targetPostId: outerPostId });
  const postAfter = afterClick.posts.find((p) => p.postId === outerPostId);
  expect(postAfter?.videoAudioCSS).toBe(`[data-wb-bumper-video-audio="${outerPostId}"]`);
  expect(postAfter?.videoSpeakerMuted).toBe(false);
});

it('watchBumperVideo scrolls top-right Reel speaker icon out from behind sticky header in tiled 602px windows before clicking', async () => {
  vi.useFakeTimers();
  Object.defineProperty(window, 'innerHeight', { value: 602, configurable: true });
  const video = document.createElement('video');
  const speaker = document.createElement('div');
  speaker.setAttribute('role', 'button');
  document.body.append(video, speaker);
  rect(video);
  let speakerTop = -40;
  const syncSpeakerRect = () => {
    speaker.getBoundingClientRect = () => ({
      x: 700,
      y: speakerTop,
      left: 700,
      top: speakerTop,
      right: 732,
      bottom: speakerTop + 32,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
  };
  syncSpeakerRect();
  const scrollSpy = vi.spyOn(window, 'scrollBy').mockImplementation(((
    xOrOpts?: number | ScrollToOptions,
    y?: number,
  ) => {
    const dy = typeof xOrOpts === 'number' ? (y ?? 0) : (xOrOpts?.top ?? 0);
    speakerTop -= dy;
    syncSpeakerRect();
  }) as typeof window.scrollBy);

  video.muted = true;
  video.scrollIntoView = vi.fn();
  video.play = vi.fn(async () => {});
  let speakerMuted = true;
  let speakerTopAtClick: number | null = null;
  const audioSelector = `[data-wb-bumper-video-audio="${postId}"]`;
  const page = {
    locator: (sel: string) => ({
      first() {
        return this;
      },
      evaluate: async (fn: Function, arg?: unknown) =>
        fn(sel === audioSelector ? speaker : video, arg),
      hover: async () => {},
      click: async () => {
        if (sel === audioSelector) {
          speakerTopAtClick = speakerTop;
          speakerMuted = false;
          video.muted = false;
        }
      },
    }),
  } as unknown as Page;

  let reads = 0;
  let summaryObserved: { speakerConfirmedUnmuted: boolean; unmuteClicks: number } | null = null;
  const initial = {
    postId,
    feedbackId: 'fb',
    videoCSS: 'video',
    videoAudioCSS: audioSelector,
    videoMuted: true,
    videoSpeakerMuted: true,
    videoCurrentTime: 0,
    videoFrames: 0,
    videoPaused: false,
  } as BumperPost;

  const p = watchBumperVideo({
    page,
    initial,
    guard: () => {},
    readCurrent: async () => {
      reads++;
      return {
        ...initial,
        videoMuted: video.muted,
        videoSpeakerMuted: speakerMuted,
        videoCurrentTime: reads,
        videoFrames: reads * 30,
      };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    sound: true,
    budgetMs: 1800,
    tickMs: 800,
    stallMs: 3000,
    onSummary: (s) => {
      summaryObserved = {
        speakerConfirmedUnmuted: s.speakerConfirmedUnmuted,
        unmuteClicks: s.unmuteClicks,
      };
    },
  });
  await vi.runAllTimersAsync();
  expect(await p).toBe('budget');
  expect(scrollSpy).toHaveBeenCalled();
  expect(speakerTopAtClick).not.toBeNull();
  expect(speakerTopAtClick!).toBeGreaterThanOrEqual(148);
  expect(summaryObserved).toEqual({ speakerConfirmedUnmuted: true, unmuteClicks: 1 });
});
