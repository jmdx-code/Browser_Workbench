import { bumperNativeEvents } from './fixtures/bumper-native-events.js';
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { projectGroupBumper } from '../src/infrastructure/group-bumper-effects.js';
import { BumperSettings } from '../src/shared/group-bumper.js';
import {
  GroupBumperBrowserAdapter,
  isForeignPagePost,
} from '../src/infrastructure/group-bumper-runner.js';

const group = '1116799701798635',
  author = '61572590020071',
  post = '4550823395062898';

function box(el: Element) {
  el.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 500,
    bottom: 500,
    width: 500,
    height: 500,
    toJSON: () => ({}),
  });
}
function fiber(el: Element, name: string, props: Record<string, unknown>) {
  Reflect.set(el, '__reactFiber$test', { type: { displayName: name }, memoizedProps: props });
}
beforeEach(() => {
  document.body.innerHTML = '<main></main>';
  document.head.innerHTML = '<base href="https://www.facebook.com/">';
  Reflect.deleteProperty(window, '__wbReactRootNodesV1');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const mkTarget = (id: string, name = id) => ({
  id,
  name,
  avatarUrl: null,
  folderId: null,
  sortOrder: 0,
  totalBumpedCount: 0,
  createdAt: 0,
  updatedAt: 0,
});

type SurfaceInput = { groupId?: string; pageId?: string; targetPostId?: string };
function harness(options: {
  surface: (url: string, input: SurfaceInput) => Record<string, unknown>;
  kernel?: Record<string, unknown>;
  onClick?: (selector: string) => void;
  nativeResult?: 'error' | 'missing';
}) {
  let current = '';
  const gotos: string[] = [];
  const clicks: string[] = [];
  let mutations = 0;
  const nativeEvents = bumperNativeEvents();
  const page = {
    url: () => current,
    viewportSize: () => ({ width: 1280, height: 800 }),
    goto: async (url: string) => {
      current = url;
      gotos.push(url);
      return null;
    },
    // 与 Playwright 一致：谓词不满足时超时抛错
    waitForURL: async (predicate: (u: URL) => boolean) => {
      if (!predicate(new URL(current))) throw Error('page.waitForURL: Timeout 15000ms exceeded.');
    },
    on: nativeEvents.on,
    off: nativeEvents.off,
    mouse: { wheel: async () => {}, move: async () => {} },
    keyboard: { type: async () => {}, insertText: async () => {} },
    evaluate: async (fn: unknown, input?: unknown) => {
      if (typeof fn === 'function' && fn.name === 'projectGroupInvitationState')
        return {
          accountId: '10000000001',
          ready: true,
          visible: true,
          verificationRequired: false,
        };
      if (typeof fn === 'function' && fn.name === 'projectBumperReactionRead')
        return { state: 'unknown' };
      if (!input || typeof input !== 'object') return typeof input === 'string' ? false : 'doc';
      return {
        url: current,
        groupIds: [group],
        avatarUrl: null,
        pageAvatarUrl: null,
        ready: true,
        visible: true,
        restricted: false,
        loading: false,
        groupEntryCSS: null,
        joinGroupCSS: null,
        welcomeDismissCSS: null,
        posts: [],
        ...options.surface(current, input as SurfaceInput),
      };
    },
    locator: (selector: string) => ({
      first() {
        return this;
      },
      evaluate: async () => {},
      press: async () => {},
      click: async () => {
        mutations++;
        clicks.push(selector);
        options.onClick?.(selector);
        const data = options.surface(current, {});
        const posts = data.posts as { likeCSS?: string; feedbackId?: string }[] | undefined;
        const post = posts?.find((p) => p.likeCSS === selector);
        if (post?.feedbackId && options.nativeResult !== 'missing')
          nativeEvents.like(
            '10000000001',
            post.feedbackId,
            '1635855486666999',
            options.nativeResult === 'error',
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
    context: async () => ({ accountId: '10000000001' }),
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
    inspectIdleFacebookPage: async () => ({ actor: { accountId: '10000000001' }, proof }),
    connectFacebook: async () => connection,
    ...options.kernel,
  };
  const recorded: string[] = [];
  const repo = {
    getOperation: async () => null,
    listOperationsByProfile: async () => [],
    prepareOperation: async (input: unknown) => input,
    setOperationResolution: async (_id: string, r: unknown) => r,
    markOperationSettled: async () => {},
    markOperationReview: async () => {},
    confirmSubmission: async (_id: string, row: { postId: string }, _c: unknown, r: unknown) => {
      recorded.push(row.postId);
      return r;
    },
    eligibility: async () => ({ today: 0, allowed: true }),
    pickComment: async () => null,
    record: async () => true,
    updateAvatar: async () => {},
    applyResolvedTargetMetadata: async () => {},
  };
  const adapter = new GroupBumperBrowserAdapter(
    repo as unknown as ConstructorParameters<typeof GroupBumperBrowserAdapter>[0],
    () =>
      kernel as unknown as ReturnType<ConstructorParameters<typeof GroupBumperBrowserAdapter>[1]>,
    () =>
      ({ peers: new Map([['p', peer]]) }) as unknown as ReturnType<
        ConstructorParameters<typeof GroupBumperBrowserAdapter>[2]
      >,
    async () => false,
    0,
  );
  return { adapter, gotos, clicks, recorded, proof, current: () => current };
}
const settings = (extra: Partial<BumperSettings> = {}) => ({
  ...BumperSettings.parse({}),
  likeProbability: 100,
  commentProbability: 0,
  ...extra,
});
const targetPost = (overrides: Record<string, unknown> = {}) => ({
  postId: post,
  postUrl: `https://www.facebook.com/groups/${group}/posts/${post}/`,
  authorId: author,
  authorName: 'TargetPage',
  authorAliases: [],
  authorAvatarUrl: null,
  pinned: false,
  ageHours: 1,
  timeText: '1h',
  feedbackId: 'fb-' + post,
  liked: false,
  postCSS: `[data-wb-bumper-post="${post}"]`,
  likeCSS: `[data-wb-bumper-like="${post}"]`,
  commentCSS: null,
  commentButtonCSS: null,
  hasVideo: false,
  comments: [],
  ...overrides,
});

it('WO60-B: prepareAndConnect reads identity with browseAdmission=true, story=false, home=false first', async () => {
  vi.useFakeTimers();
  const identityCalls: unknown[][] = [];
  const idleCalls: unknown[][] = [];
  const h = harness({
    surface: () => ({}),
    kernel: {
      inspectIdleFacebookPage: async (...args: unknown[]) => {
        idleCalls.push(args);
        return null;
      },
      inspectFacebookIdentity: async (...args: unknown[]) => {
        identityCalls.push(args);
        return { actor: { accountId: '10000000001' }, proof: h.proof };
      },
    },
  });
  const work = h.adapter
    .run('p', [mkTarget(group)], [mkTarget(author, 'TargetPage')], settings(), {
      cancelled: () => false,
      status: () => {},
      added: () => {},
    })
    .catch(() => {});
  await vi.runAllTimersAsync();
  await work;
  expect(idleCalls[0]?.slice(2)).toEqual([false, false]);
  expect(identityCalls).toHaveLength(1);
  expect(identityCalls[0]?.slice(2)).toEqual([true, h.proof, true, false, false]);
});

it('WO60-B: time_sort falls back to the default group URL when CHRONOLOGICAL renders 0 posts', async () => {
  vi.useFakeTimers();
  const liked = new Set<string>();
  const h = harness({
    onClick: (s) => s.includes('bumper-like') && liked.add(post),
    surface: (url) => ({
      posts:
        url.includes('sorting_setting=CHRONOLOGICAL') || url.includes('/search')
          ? []
          : [targetPost({ liked: liked.has(post) })],
    }),
  });
  const work = h.adapter.run(
    'p',
    [mkTarget(group)],
    [mkTarget(author, 'TargetPage')],
    settings({ searchMode: 'time_sort', maxPostsPerGroupPage: 1 }),
    { cancelled: () => false, status: () => {}, added: () => {} },
  );
  await vi.runAllTimersAsync();
  await work;
  const chrono = h.gotos.findIndex((u) => u.includes('sorting_setting=CHRONOLOGICAL'));
  expect(chrono).toBeGreaterThanOrEqual(0);
  expect(h.gotos.slice(chrono + 1)).toContain(`https://www.facebook.com/groups/${group}/`);
  expect(h.recorded).toEqual([post]);
});

it('WO60-B: page search click that stays on /search falls back to the page URL and never likes on the search page', async () => {
  vi.useFakeTimers();
  const pageId = '61578473189457';
  const liked = new Set<string>();
  const h = harness({
    onClick: (s) => s === `[data-wb-bumper-like="${post}"]` && liked.add(post),
    surface: (url) =>
      url.includes('/search')
        ? {
            groupIds: [],
            groupEntryCSS: '[data-wb-bumper-group="1"]',
            posts: [targetPost({ postId: '999', likeCSS: '[data-wb-bumper-like="999"]' })],
          }
        : {
            groupIds: [],
            posts: [
              targetPost({ authorId: pageId, authorName: '台湾小微', liked: liked.has(post) }),
            ],
          },
  });
  const work = h.adapter.run(
    'p',
    [{ ...mkTarget('-', '专页主页') }],
    [mkTarget(pageId, '台湾小微')],
    settings({ maxPostsPerPage: 1 }),
    { cancelled: () => false, status: () => {}, added: () => {} },
  );
  await vi.runAllTimersAsync();
  await work;
  expect(h.clicks).toContain('[data-wb-bumper-group="1"]');
  expect(h.gotos).toContain('https://www.facebook.com/profile.php?id=' + pageId);
  expect(h.clicks).not.toContain('[data-wb-bumper-like="999"]');
  expect(h.recorded).toEqual([post]);
});

it('WO60-B: page search entry ignores post/photo/hashtag/external sub-links and supports exact name match', () => {
  vi.stubGlobal('location', new URL('https://www.facebook.com/search/pages/?q=x'));
  const card = document.createElement('div');
  document.querySelector('main')!.append(card);
  const add = (href: string, text: string) => {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = text;
    box(a);
    card.append(a);
    // 子链接继承了同一张结果卡片的专页 Fiber
    fiber(a, 'SearchResultCard.react', { page: { id: '61578473189457' } });
    return a;
  };
  add('https://www.facebook.com/taiwanxiaowei/posts/123', 'post');
  add('https://www.facebook.com/photo/?fbid=1', 'photo');
  add('https://www.facebook.com/hashtag/abc', '#abc');
  add('https://l.facebook.com/l.php?u=x', 'external');
  let state = projectGroupBumper({ groupId: '-', pageId: '61578473189457', pageName: '台湾小微' });
  expect(state.groupEntryCSS).toBeNull();
  expect(card.querySelector('[data-wb-bumper-group]')).toBeNull();
  const home = document.createElement('a');
  home.href = 'https://www.facebook.com/taiwanxiaowei';
  home.textContent = '台湾小微';
  box(home);
  card.append(home);
  state = projectGroupBumper({ groupId: '-', pageId: '61578473189457', pageName: '台湾小微' });
  expect(state.groupEntryCSS).toBe('[data-wb-bumper-group="1"]');
  expect(home.getAttribute('data-wb-bumper-group')).toBe('1');
});

it('WO60-B: foreign visitor posts are filtered only after the page owner author ID is confirmed', () => {
  const page = { id: '61578473189457', name: '台湾小微' };
  const visitor = { authorId: '100000000000001', authorName: 'Visitor', authorAliases: [] };
  expect(isForeignPagePost(visitor, page, null)).toBe(false);
  expect(isForeignPagePost(visitor, page, '100099999999999')).toBe(true);
  expect(
    isForeignPagePost(
      { authorId: '100099999999999', authorName: 'x', authorAliases: [] },
      page,
      '100099999999999',
    ),
  ).toBe(false);
  expect(
    isForeignPagePost(
      { authorId: '100000000000002', authorName: '台湾小微', authorAliases: [] },
      page,
      '100099999999999',
    ),
  ).toBe(false);
  expect(isForeignPagePost({ authorId: null, authorName: '', authorAliases: [] }, page, '1')).toBe(
    false,
  );
});

it.each(['error', 'missing'] as const)(
  'optimistic liked DOM with %s native evidence never creates a successful record or retries the input',
  async (nativeResult) => {
    vi.useFakeTimers();
    let pressed = false;
    const h = harness({
      nativeResult,
      onClick: () => {
        pressed = true;
      },
      surface: () => ({ posts: [targetPost({ liked: pressed })] }),
    });
    const until = Date.now() + 20000;
    const work = h.adapter
      .run('p', [mkTarget(group)], [mkTarget(author)], settings({ useLongPressReaction: false }), {
        cancelled: () => Date.now() >= until,
        status: () => {},
        added: () => {},
      })
      .catch((e) => {
        if (!/已停止/.test(String(e))) throw e;
      });
    await vi.runAllTimersAsync();
    await work;
    expect(h.clicks.filter((s) => s.includes('bumper-like'))).toHaveLength(1);
    expect(h.recorded).toEqual([]);
  },
);

it('pending approval and membership questions skip only that group, then the next joined group still runs', async () => {
  for (const firstState of ['pending', 'questions'] as const) {
    vi.useFakeTimers();
    const second = '222222222222222',
      secondPost = '888888888888888';
    const h = harness({
      surface: (url) => {
        const gid = url.includes('/groups/' + second) ? second : group;
        return {
          groupIds: [gid],
          groupJoinState: gid === group ? firstState : 'member',
          posts:
            gid === second
              ? [
                  targetPost({
                    postId: secondPost,
                    postUrl: `https://www.facebook.com/groups/${second}/posts/${secondPost}/`,
                    feedbackId: 'fb-' + secondPost,
                    likeCSS: '[data-wb-bumper-like="' + secondPost + '"]',
                  }),
                ]
              : [],
        };
      },
    });
    const statuses: string[] = [];
    const work = h.adapter.run(
      'p',
      [mkTarget(group), mkTarget(second)],
      [mkTarget(author)],
      settings(),
      { cancelled: () => false, status: (s) => statuses.push(s), added: () => {} },
    );
    await vi.runAllTimersAsync();
    await work;
    expect(h.recorded).toEqual([secondPost]);
    expect(statuses.some((s) => s.includes(firstState === 'pending' ? '待审核' : '入组问题'))).toBe(
      true,
    );
    expect(h.clicks.every((s) => !s.includes('bumper-join'))).toBe(true);
    vi.useRealTimers();
  }
});
