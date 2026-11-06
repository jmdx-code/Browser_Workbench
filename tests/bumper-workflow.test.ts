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
