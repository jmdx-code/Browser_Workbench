// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { projectGroupBumper } from '../src/infrastructure/group-bumper-effects.js';
import { BumperSettings } from '../src/shared/group-bumper.js';
import { GroupBumperBrowserAdapter } from '../src/infrastructure/group-bumper-runner.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { SqliteGroupBumperRepository } from '../src/infrastructure/group-bumper-store.js';

const group = '1116799701798635';
const author = '61572590020071';
const post1 = '4550823395062898';
const post2 = '4550823395062899';

function box(el: Element) {
  el.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 200,
    right: 500,
    bottom: 500,
    width: 500,
    height: 300,
    toJSON: () => ({}),
  });
}

function fiber(
  el: Element,
  name: string,
  props: Record<string, unknown>,
  parent?: Record<string, unknown>,
) {
  Reflect.set(el, '__reactFiber$test', {
    type: { displayName: name },
    memoizedProps: props,
    return: parent,
  });
}

function article(html: string) {
  const a = document.createElement('div');
  a.setAttribute('role', 'article');
  a.innerHTML = html;
  document.querySelector('main')?.append(a);
  [a, ...a.querySelectorAll('*')].forEach(box);
  return a;
}

beforeEach(() => {
  document.body.innerHTML = '<main></main>';
  document.head.innerHTML = '<base href="https://www.facebook.com/">';
  vi.stubGlobal('location', new URL('https://www.facebook.com/groups/' + group + '/'));
  Reflect.deleteProperty(window, '__wbReactRootNodesV1');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('WO61-1: projectGroupBumper with targetPostId for post 1 preserves data-wb-bumper-* attributes on post 2', () => {
  const a1 = article(`
    <a href="https://www.facebook.com/groups/${group}/user/${author}/">Target Author</a>
    <a href="https://www.facebook.com/groups/${group}/posts/${post1}/">1h</a>
    <button id="like1" role="button" data-ad-rendering-role="like_button">Like</button>
    <button id="open1" role="button" data-ad-rendering-role="comment_button">Comment</button>
    <video id="vid1"></video>
  `);
  const a2 = article(`
    <a href="https://www.facebook.com/groups/${group}/user/${author}/">Target Author</a>
    <a href="https://www.facebook.com/groups/${group}/posts/${post2}/">2h</a>
    <button id="like2" role="button" data-ad-rendering-role="like_button">Like</button>
    <button id="open2" role="button" data-ad-rendering-role="comment_button">Comment</button>
    <video id="vid2"></video>
  `);
  fiber(a1, 'CometFeedUnitCard.react', {
    feedUnit: { id: btoa('Uzpf:VK:' + post1), creation_time: Date.now() / 1000 - 3600 },
  });
  fiber(a2, 'CometFeedUnitCard.react', {
    feedUnit: { id: btoa('Uzpf:VK:' + post2), creation_time: Date.now() / 1000 - 7200 },
  });

  // 1. Full scan tags both posts
  const full = projectGroupBumper({ groupId: group });
  expect(full.posts.map((p) => p.postId)).toEqual([post1, post2]);
  expect(a1.getAttribute('data-wb-bumper-post')).toBe(post1);
  expect(a2.getAttribute('data-wb-bumper-post')).toBe(post2);
  expect(a2.querySelector('#like2')?.getAttribute('data-wb-bumper-like')).toBe(post2);
  expect(a2.querySelector('#open2')?.getAttribute('data-wb-bumper-open-comment')).toBe(post2);
  expect(a2.querySelector('#vid2')?.getAttribute('data-wb-bumper-video')).toBe(post2);

  // 2. Single-post re-check for post1 does NOT wipe post2's DOM attributes
  const single = projectGroupBumper({ groupId: group, targetPostId: post1 });
  expect(single.posts.map((p) => p.postId)).toEqual([post1]);
  expect(a2.getAttribute('data-wb-bumper-post')).toBe(post2);
  expect(a2.querySelector('#like2')?.getAttribute('data-wb-bumper-like')).toBe(post2);
  expect(a2.querySelector('#open2')?.getAttribute('data-wb-bumper-open-comment')).toBe(post2);
  expect(a2.querySelector('#vid2')?.getAttribute('data-wb-bumper-video')).toBe(post2);
});

it('WO61-2: video post finishes on videoEnded/duration, completes at 3min deadline without skip error, and re-centers after 5 offscreen ticks', async () => {
  vi.useFakeTimers();
  let current = `https://www.facebook.com/groups/${group}/?sorting_setting=CHRONOLOGICAL`;
  let videoEnded = false;
  let videoCurrentTime = 0;
  let videoDuration = 600; // 10-minute video to test 3-minute deadline
  let isOffscreen = false;
  let hydratedVideoCSS: string | null = null;
  let checkPostCount = 0;
  const centeredSelectors: string[] = [];
  const liked = new Set<string>();
  let mutations = 0;

  const page = {
    url: () => current,
    viewportSize: () => ({ width: 1280, height: 800 }),
    goto: async (url: string) => {
      current = url;
      return null;
    },
    waitForURL: async () => {},
    on: () => {},
    off: () => {},
    mouse: {
      wheel: async () => {},
      move: async () => {},
    },
    evaluate: async (fn: Function, input?: { groupId?: string; targetPostId?: string }) => {
      if (!input) return 'test-document';
      if (fn.name === 'projectGroupInvitationState')
        return {
          accountId: '10000000001',
          ready: true,
          visible: true,
          verificationRequired: false,
        };
      if (input.targetPostId) {
        checkPostCount++;
        // Hydrate videoCSS on first checkPost after centering postCSS
        hydratedVideoCSS = `[data-wb-bumper-video="${post1}"]`;
        // Simulate manual scroll offscreen during ticks 2..6 (5 consecutive ticks)
        isOffscreen = checkPostCount >= 2 && checkPostCount <= 6;
      }
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
        posts: [
          {
            postId: post1,
            postUrl: `https://www.facebook.com/groups/${group}/posts/${post1}/`,
            authorId: author,
            authorName: 'TargetPage',
            authorAliases: [],
            authorAvatarUrl: null,
            pinned: false,
            ageHours: 1,
            timeText: '1h',
            feedbackId: 'fb-' + post1,
            liked: liked.has(post1),
            postCSS: `[data-wb-bumper-post="${post1}"]`,
            likeCSS: `[data-wb-bumper-like="${post1}"]`,
            commentCSS: null,
            commentButtonCSS: null,
            hasVideo: true,
            videoEnded,
            videoPaused: false,
            videoReadyState: 4,
            videoCurrentSrc: 'blob:https://www.facebook.com/vid1',
            videoFrames: 100,
            videoCurrentTime,
            videoDuration,
            videoCSS: input.targetPostId ? hydratedVideoCSS : null,
            comments: [],
          },
        ],
      };
    },
    locator: (selector: string) => ({
      first() {
        return this;
      },
      evaluate: async (fn: Function) => {
        const src = fn.toString();
        if (src.includes('scrollIntoView')) {
          centeredSelectors.push(selector);
          return { x: 400, y: 400, width: 200, height: 100, vh: 800 };
        }
        if (src.includes('getBoundingClientRect') && src.includes('innerHeight')) {
          return isOffscreen;
        }
        return undefined;
      },
      click: async () => {
        mutations++;
        if (selector === `[data-wb-bumper-like="${post1}"]`) {
          liked.add(post1);
        }
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
    inspectFacebookIdentity: async () => ({ actor: { accountId: '10000000001' }, proof }),
    inspectIdleFacebookPage: async () => ({ actor: { accountId: '10000000001' }, proof }),
    connectFacebook: async () => connection,
  };
  const recorded: string[] = [];
  const repo = {
    getOperation: async () => null,
    listOperationsByProfile: async () => [],
    prepareOperation: async (input: unknown) => input,
    setOperationResolution: async (_id: string, r: unknown) => r,
    markOperationSettled: async () => {},
    markOperationReview: async () => {},
    confirmSubmission: async (_id: string, row: never, _comment: unknown, resolution: unknown) => {
      await repo.record(row);
      return resolution;
    },
    eligibility: async () => ({ today: 0, allowed: true }),
    pickComment: async () => null,
    record: async (row: { postId: string }) => {
      recorded.push(row.postId);
      return true;
    },
    updateAvatar: async () => {},
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
    0.01, // 180_000 * 0.01 = 1800ms maxWatchMs, stepMs = 10ms
  );
  const mkTarget = (id: string) => ({
    id,
    name: id,
    avatarUrl: null,
    folderId: null,
    sortOrder: 0,
    totalBumpedCount: 0,
    createdAt: 0,
    updatedAt: 0,
  });

  // Case A: 10-minute video does not end within 3min deadline, experiences 5 offscreen ticks, re-centers, and still likes after 3min deadline without throwing skip error
  const runA = adapter.run(
    'p',
    [mkTarget(group)],
    [mkTarget(author)],
    {
      ...BumperSettings.parse({}),
      searchMode: 'time_sort',
      likeProbability: 100,
      commentProbability: 0,
      maxPostsPerGroupPage: 1,
    },
    { cancelled: () => false, status: () => {}, added: () => {} },
  );
  await vi.runAllTimersAsync();
  await runA;

  // Hydrated videoCSS was centered AND re-centered after 5 offscreen ticks
  const videoCenters = centeredSelectors.filter((s) => s === `[data-wb-bumper-video="${post1}"]`);
  expect(videoCenters.length).toBeGreaterThanOrEqual(2);
  expect(recorded).toEqual([post1]);

  // Case B: Short video finishes immediately when videoCurrentTime reaches duration - 0.5
  liked.clear();
  recorded.length = 0;
  checkPostCount = 0;
  videoDuration = 12;
  videoCurrentTime = 11.5;
  videoEnded = true;
  const runB = adapter.run(
    'p',
    [mkTarget(group)],
    [mkTarget(author)],
    {
      ...BumperSettings.parse({}),
      searchMode: 'time_sort',
      likeProbability: 100,
      commentProbability: 0,
      maxPostsPerGroupPage: 1,
    },
    { cancelled: () => false, status: () => {}, added: () => {} },
  );
  await vi.runAllTimersAsync();
  await runB;
  expect(recorded).toEqual([post1]);
  expect(checkPostCount).toBeLessThanOrEqual(6);
});

it('WO61-3: BumperSettings defaults maxConcurrentProfiles to 8 (max 50) and auto-migrates legacy 4 once', async () => {
  const defaults = BumperSettings.parse({});
  expect(defaults.maxConcurrentProfiles).toBe(8);
  expect(BumperSettings.parse({ maxConcurrentProfiles: 50 }).maxConcurrentProfiles).toBe(50);
  expect(() => BumperSettings.parse({ maxConcurrentProfiles: 51 })).toThrow();

  const dir = await mkdtemp(path.join(tmpdir(), 'wb-wo61-'));
  const file = path.join(dir, 'workspace.sqlite');
  const store = await WorkspaceStore.open(file);
  store.close();
  const rawDb = new DatabaseSync(file);
  try {
    // 1. Simulate legacy DB with maxConcurrentProfiles: 4 and default_max_concurrent_8_applied = 0
    const legacy = { ...BumperSettings.parse({}), maxConcurrentProfiles: 4 };
    rawDb
      .prepare(
        'UPDATE group_bumper_settings SET body=?, default_max_concurrent_8_applied=0 WHERE id=1',
      )
      .run(JSON.stringify(legacy));

    // 2. First open upgrades 4 -> 8 and sets default_max_concurrent_8_applied = 1
    const repo1 = new SqliteGroupBumperRepository(rawDb);
    expect(repo1.settings().maxConcurrentProfiles).toBe(8);

    // 3. User explicitly saves maxConcurrentProfiles = 4; reopening does NOT overwrite it
    repo1.saveSettings({ ...repo1.settings(), maxConcurrentProfiles: 4 });
    const repo2 = new SqliteGroupBumperRepository(rawDb);
    expect(repo2.settings().maxConcurrentProfiles).toBe(4);
  } finally {
    rawDb.close();
    await rm(dir, { recursive: true, force: true });
  }
});
