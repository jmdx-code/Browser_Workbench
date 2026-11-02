// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { projectGroupBumper } from '../src/infrastructure/group-bumper-effects.js';
import {
  bumperSetupLabels,
  bumperSetupKinds,
  bumperDigest,
  recoverBumperOperations,
} from '../src/infrastructure/group-bumper-recovery.js';
import { BumperSettings } from '../src/shared/group-bumper.js';
import { GroupBumperBrowserAdapter } from '../src/infrastructure/group-bumper-runner.js';
import {
  SqliteGroupBumperRepository,
  groupBumperMigration,
  groupBumperOperationsMigration,
} from '../src/infrastructure/group-bumper-store.js';
import { KernelJournal } from '../src/application/kernel-journal.js';
import { MemoryKernelStorage } from './fixtures/kernel-storage.js';
import type { Binding } from '../src/shared/task-execution.js';
import type { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import type { Peer } from '../src/bridge/core.js';

const group = '1116799701798635';
const author = '61572590020071';

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
  vi.stubGlobal('location', new URL('https://www.facebook.com/taiwanxiaowei'));
  Reflect.deleteProperty(window, '__wbReactRootNodesV1');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('WO62-1: bumperSetupLabels includes 打开搜索结果 -> setup_navigate, and positive actionKind mapping never falls back to submit_comment for non-submit labels', () => {
  const idx = bumperSetupLabels.indexOf('打开搜索结果');
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(bumperSetupKinds[idx]).toBe('setup_navigate');
  expect(bumperSetupLabels.length).toBe(bumperSetupKinds.length);

  const resolveActionKind = (label: string) => {
    const index = bumperSetupLabels.indexOf(label as (typeof bumperSetupLabels)[number]);
    return label === '点赞'
      ? 'submit_like'
      : label === '发送评论'
        ? 'submit_comment'
        : index >= 0
          ? (bumperSetupKinds[index] ?? 'setup_navigate')
          : 'setup_navigate';
  };
  expect(resolveActionKind('打开搜索结果')).toBe('setup_navigate');
  expect(resolveActionKind('未知准备步骤')).toBe('setup_navigate');
  expect(resolveActionKind('点赞')).toBe('submit_like');
  expect(resolveActionKind('发送评论')).toBe('submit_comment');
});

it('WO62-2: recoverBumperOperations auto-settles pending operations (including legacy submit_comment/submit_like and setup_*) without throwing 存在待核对操作', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(groupBumperMigration);
    db.exec(groupBumperOperationsMigration);
    const repo = new SqliteGroupBumperRepository(db);
    const profileId = randomUUID();
    const makeBinding = (label: string): Binding => ({
      profileId,
      accountId: '10000000001',
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: 1,
      operationId: randomUUID(),
      jobId: randomUUID(),
      stepId: randomUUID(),
      actionDigest: bumperDigest({
        purpose: 'group-bumper',
        label,
        accountId: '10000000001',
      }),
    });

    // 1. Legacy misclassified submit_comment (from old 打开搜索结果 without postId)
    const legacyCommentBinding = makeBinding('打开搜索结果');
    repo.prepareOperation({
      binding: legacyCommentBinding,
      runId: randomUUID(),
      actionKind: 'submit_comment',
      groupId: '-',
      groupName: '专页主页',
      pageId: author,
      pageName: 'TargetPage',
    });

    // 2. Unrecorded 打开搜索结果 setup operation in journal
    const unrecordedSearchBinding = makeBinding('打开搜索结果');

    const journal = new KernelJournal(new MemoryKernelStorage());
    await journal.initialize(profileId, randomUUID());
    await journal.begin(legacyCommentBinding);
    await journal.finish(legacyCommentBinding, 'ACKNOWLEDGED');
    await journal.begin(unrecordedSearchBinding);
    await journal.finish(unrecordedSearchBinding, 'UNKNOWN');

    const kernel = {
      withSummary: async (_peer: unknown, fn: (port: unknown) => Promise<unknown>) =>
        fn({
          inventory: () => journal.snapshot(),
          notify: async (b: Binding, r: Parameters<KernelJournal['endUnknown']>[1]) => {
            await journal.endUnknown(b, r);
            return { binding: b, disposition: r };
          },
        }),
    } as unknown as KernelBridge;
    const peer = { profileId } as Peer;

    await recoverBumperOperations(kernel, peer, repo, () => {});

    const settledLegacy = repo.getOperation(legacyCommentBinding.operationId);
    const settledSearch = repo.getOperation(unrecordedSearchBinding.operationId);
    expect(settledLegacy?.status).toBe('SETTLED');
    expect(settledLegacy?.resolution?.outcome).toBe('ENDED_UNKNOWN');
    expect(settledSearch?.status).toBe('SETTLED');
    expect(settledSearch?.actionKind).toBe('setup_navigate');
    expect(settledSearch?.resolution?.outcome).toBe('ENDED_UNKNOWN');
  } finally {
    db.close();
  }
});

it('WO62-3: projectGroupBumper on Page timeline extracts postId from /{page}/posts/{id}, /{page}/videos/{id}, /watch/?v={id}, and /photo/?fbid={id}', () => {
  article(`
    <a href="https://www.facebook.com/taiwanxiaowei">台湾小微</a>
    <a href="https://www.facebook.com/taiwanxiaowei/posts/100001/">1h</a>
    <button role="button" data-ad-rendering-role="like_button">Like</button>
  `);
  article(`
    <a href="https://www.facebook.com/taiwanxiaowei">台湾小微</a>
    <a href="https://www.facebook.com/taiwanxiaowei/videos/100002/">2h</a>
    <button role="button" data-ad-rendering-role="like_button">Like</button>
  `);
  article(`
    <a href="https://www.facebook.com/taiwanxiaowei">台湾小微</a>
    <a href="https://www.facebook.com/watch/?v=100003">3h</a>
    <button role="button" data-ad-rendering-role="like_button">Like</button>
  `);
  article(`
    <a href="https://www.facebook.com/taiwanxiaowei">台湾小微</a>
    <a href="https://www.facebook.com/photo/?fbid=100004">4h</a>
    <button role="button" data-ad-rendering-role="like_button">Like</button>
  `);

  const surface = projectGroupBumper({
    groupId: '-',
    pageId: author,
    pageName: '台湾小微',
  });
  expect(surface.posts.map((p) => p.postId)).toEqual(['100001', '100002', '100003', '100004']);
});

it('WO62-4: video post with likeCSS=null after watching scrolls bottomAnchor into view to hydrate likeCSS and completes like; NOT_IDLE retries when not busy', async () => {
  vi.useFakeTimers();
  const postId = '888000111';
  let current = `https://www.facebook.com/profile.php?id=${author}`;
  let bottomScrolled = false;
  let inspectAttempts = 0;
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
    mouse: { wheel: async () => {}, move: async () => {} },
    keyboard: { type: async () => {}, insertText: async () => {} },
    evaluate: async (fn: Function, input?: { groupId?: string; targetPostId?: string }) => {
      if (!input) return 'test-document';
      if (fn.name === 'projectGroupInvitationState')
        return {
          accountId: '10000000001',
          ready: true,
          visible: true,
          verificationRequired: false,
        };
      return {
        url: current,
        groupIds: [],
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
            postId,
            postUrl: `https://www.facebook.com/${author}/videos/${postId}/`,
            // Different authorId on Page timeline (e.g. collaborator/shared post) should still be bumped in page mode
            authorId: '999888777',
            authorName: 'Collaborator',
            authorAliases: [],
            authorAvatarUrl: null,
            pinned: false,
            ageHours: 1,
            timeText: '1h',
            feedbackId: 'fb-' + postId,
            liked: liked.has(postId),
            postCSS: `[data-wb-bumper-post="${postId}"]`,
            // Only hydrate likeCSS after scrolling bottom of card into view
            likeCSS: bottomScrolled ? `[data-wb-bumper-like="${postId}"]` : null,
            commentCSS: null,
            commentButtonCSS: null,
            hasVideo: true,
            videoEnded: true,
            videoPaused: false,
            videoReadyState: 4,
            videoCurrentSrc: 'blob:https://www.facebook.com/vid',
            videoFrames: 60,
            videoCurrentTime: 10,
            videoDuration: 10,
            videoCSS: `[data-wb-bumper-video="${postId}"]`,
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
        if (src.includes('end') && selector === `[data-wb-bumper-post="${postId}"]`) {
          bottomScrolled = true;
        }
        return false;
      },
      click: async () => {
        mutations++;
        if (selector === `[data-wb-bumper-like="${postId}"]`) {
          liked.add(postId);
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
    inspectIdleFacebookPage: async () => {
      inspectAttempts++;
      if (inspectAttempts === 1) throw Error('KERNEL_PROFILE_NOT_IDLE');
      return { actor: { accountId: '10000000001' }, proof };
    },
    inspectFacebookIdentity: async () => {
      throw Error('KERNEL_PROFILE_NOT_IDLE');
    },
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
    0.01,
  );
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

  const run = adapter.run(
    'p',
    [mkTarget('-', '专页主页')],
    [mkTarget(author, author)],
    {
      ...BumperSettings.parse({}),
      likeProbability: 100,
      commentProbability: 0,
      maxPostsPerPage: 1,
    },
    { cancelled: () => false, status: () => {}, added: () => {} },
  );
  await vi.runAllTimersAsync();
  await run;

  expect(inspectAttempts).toBeGreaterThanOrEqual(2);
  expect(bottomScrolled).toBe(true);
  expect(recorded).toEqual([postId]);
});
