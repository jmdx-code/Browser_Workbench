import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import {
  GroupBumperService,
  type BumperRepository,
} from '../src/application/group-bumper-service.js';
import {
  GroupPosterService,
  type GroupPosterBrowserPort,
  type PosterMediaPreparerPort,
} from '../src/application/group-poster-service.js';
import { WorkspaceService } from '../src/application/workspace-service.js';
import { handleFeatureModuleRoutes } from '../src/http/routes/feature-module-routes.js';
import { SqliteGroupBumperRepository } from '../src/infrastructure/group-bumper-store.js';
import { confirmedBumperGraphQL } from '../src/infrastructure/group-bumper/bumper-core.js';
import { runBumperPostLike } from '../src/infrastructure/group-bumper/bumper-post-browse-like.js';
import { runBumperPostComment } from '../src/infrastructure/group-bumper/bumper-post-comment-share.js';
import {
  readBumperComposerText,
  typeBumperComment,
} from '../src/infrastructure/group-bumper/bumper-post-flow.js';
import {
  extractPosterPostIdFromUrl,
  inspectPosterGraphQLResponse,
} from '../src/infrastructure/group-poster-runner/poster-network.js';
import { waitMediaAndSubmitPost } from '../src/infrastructure/group-poster-runner/poster-publish.js';
import { readDomCreatedPostFallback } from '../src/infrastructure/group-poster-runner/poster-support.js';
import { SqlitePostBumpRecordsRepository } from '../src/infrastructure/post-bump-records-store.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import {
  createRelativePostAge,
  relativePostAge,
  stripAnsi,
} from '../src/shared/relative-post-age.js';
import { BumperSettings } from '../src/shared/group-bumper.js';
import { PosterSettings, type PosterLog } from '../src/shared/group-poster.js';
import type { PostBumpRecordsPort } from '../src/shared/post-bump-records.js';
import type { ProfileLifecyclePort } from '../src/shared/profile-lifecycle.js';
import type { Binding } from '../src/shared/task-execution.js';

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function openTempStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-w3-test-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'workspace.sqlite');
  const store = await WorkspaceStore.open(file);
  return { dir, file, store };
}

const mkBinding = (profileId: string, accountId = '100088'): Binding => ({
  profileId,
  accountId,
  connectionEpoch: randomUUID(),
  leaseId: randomUUID(),
  generation: 1,
  operationId: randomUUID(),
  jobId: randomUUID(),
  stepId: randomUUID(),
  actionDigest: createHash('sha256')
    .update('digest-' + randomUUID())
    .digest('hex'),
});

describe('W3 Group Poster & Bumper Deep Regression Suite', () => {
  it('relativePostAge covers EN, SC/TC CJK, TH, VI, MY, self-contained createRelativePostAge(), invalid inputs, and stripAnsi', () => {
    const now = new Date(2026, 10, 27, 14, 0, 0).getTime(); // 2026-11-27 14:00:00 local

    // EN
    assert.ok(Math.abs((relativePostAge('3m', now) ?? -1) - 3 / 60) < 1e-6);
    assert.equal(relativePostAge('2 hrs', now), 2);
    assert.equal(relativePostAge('1 day ago', now), 24);
    assert.ok(Math.abs((relativePostAge('30s', now) ?? -1) - 30 / 3600) < 1e-6);
    assert.equal(relativePostAge('just now', now), 0);
    assert.equal(relativePostAge('Yesterday', now), 24);
    assert.ok(Math.abs((relativePostAge('Today at 10:30 AM', now) ?? -1) - 3.5) < 1e-6);

    // Simplified & Traditional Chinese
    assert.ok(Math.abs((relativePostAge('3分钟前', now) ?? -1) - 3 / 60) < 1e-6);
    assert.ok(Math.abs((relativePostAge('3分鐘前', now) ?? -1) - 3 / 60) < 1e-6);
    assert.equal(relativePostAge('2小时前', now), 2);
    assert.equal(relativePostAge('1天前', now), 24);
    assert.ok(Math.abs((relativePostAge('30秒前', now) ?? -1) - 30 / 3600) < 1e-6);
    assert.equal(relativePostAge('刚刚', now), 0);
    assert.ok(Math.abs((relativePostAge('今天 10:30', now) ?? -1) - 3.5) < 1e-6);
    assert.equal(relativePostAge('昨天', now), 24);
    const mdHours = relativePostAge('11月27日', now);
    assert.ok(mdHours !== null && mdHours >= 24);

    // Thai, Vietnamese, Myanmar
    assert.ok(Math.abs((relativePostAge('5 นาทีที่แล้ว', now) ?? -1) - 5 / 60) < 1e-6);
    assert.equal(relativePostAge('เมื่อสักครู่', now), 0);
    assert.equal(relativePostAge('เมื่อวาน', now), 24);
    assert.ok(Math.abs((relativePostAge('5 phút trước', now) ?? -1) - 5 / 60) < 1e-6);
    assert.equal(relativePostAge('vừa xong', now), 0);
    assert.equal(relativePostAge('hôm qua', now), 24);
    assert.ok(Math.abs((relativePostAge('၅ မိနစ်', now) ?? -1) - 5 / 60) < 1e-6);
    assert.equal(relativePostAge('ယခုလေးတင်', now), 0);
    assert.equal(relativePostAge('မနေ့က', now), 24);

    // Invalid inputs
    assert.equal(relativePostAge('', now), null);
    assert.equal(relativePostAge('   ', now), null);
    assert.equal(relativePostAge('Sponsored · Recommended', now), null);
    assert.equal(relativePostAge('abcxyz', now), null);

    // Self-contained browser evaluation check (zero external closures)
    const evalFactory = new Function(
      `return (${createRelativePostAge.toString()})();`,
    ) as () => ReturnType<typeof createRelativePostAge>;
    const evalApi = evalFactory();
    assert.ok(Math.abs((evalApi.relativePostAge('3分鐘前', now) ?? -1) - 3 / 60) < 1e-6);
    assert.equal(evalApi.relativePostAge('昨天', now), 24);
    assert.equal(evalApi.relativePostAge('invalid-token', now), null);

    // stripAnsi CSI & OSC sequences
    assert.equal(
      stripAnsi(
        '\x1B[2mCall log:\x1B[22m \x1B[31mTimeout\x1B[0m \x1B]8;;https://fb.com\x07link\x1B]8;;\x07',
      ),
      'Call log: Timeout link',
    );
  });

  it('SqliteGroupBumperRepository.saveComments keeps monotonic order across multi-line batches & isolates group/page across DB reopen', async () => {
    const { file, store } = await openTempStore();
    const g1 = store.groupBumper.saveComments(
      { texts: ['G-Line-1 🙏', 'G-Line-2\n第二行', 'G-Line-3 🔥'], scope: 'group' },
      'group',
    );
    const p1 = store.groupBumper.saveComments(
      { texts: ['P-Line-1 ✨', 'P-Line-2'], scope: 'page' },
      'page',
    );
    assert.deepEqual(
      g1.map((c) => c.text),
      ['G-Line-1 🙏', 'G-Line-2\n第二行', 'G-Line-3 🔥'],
    );
    const [g10, g11, g12] = g1;
    assert.ok(g10 && g11 && g12);
    assert.ok(g10.createdAt < g11.createdAt && g11.createdAt < g12.createdAt);
    assert.deepEqual(
      p1.map((c) => c.text),
      ['P-Line-1 ✨', 'P-Line-2'],
    );

    // Reorder & update group batch while page stays untouched
    const g2 = store.groupBumper.saveComments(
      { texts: ['G-Line-3 🔥', 'G-Line-4', 'G-Line-1 🙏'], scope: 'group' },
      'group',
    );
    assert.deepEqual(
      g2.map((c) => c.text),
      ['G-Line-3 🔥', 'G-Line-4', 'G-Line-1 🙏'],
    );
    const [g20, g21, g22] = g2;
    assert.ok(g20 && g21 && g22);
    assert.ok(g20.createdAt < g21.createdAt && g21.createdAt < g22.createdAt);
    store.close();

    // Reopen fresh repository directly on SQLite file
    const rawDb = new DatabaseSync(file);
    try {
      const reopened = new SqliteGroupBumperRepository(rawDb);
      assert.deepEqual(
        reopened.comments('group').map((c) => c.text),
        ['G-Line-3 🔥', 'G-Line-4', 'G-Line-1 🙏'],
      );
      assert.deepEqual(
        reopened.comments('page').map((c) => c.text),
        ['P-Line-1 ✨', 'P-Line-2'],
      );
      assert.ok(reopened.comments('group').every((c) => c.scope === 'group'));
      assert.ok(reopened.comments('page').every((c) => c.scope === 'page'));
    } finally {
      rawDb.close();
    }
  });

  it('resolvePendingOperation works for not_applied & confirmed on BOTH Poster & Bumper SQLite stores and RPC routes', async () => {
    const { store } = await openTempStore();
    const profileId = randomUUID();
    const mat = store.groupPoster.saveMaterials({
      items: [{ id: 'mat-pending-1', caption: 'Pending Test Caption', selected: true }],
    })[0];
    assert.ok(mat);
    store.groupPoster.upsertTargets({ items: [{ id: '88001122', name: 'Test Group' }] });
    store.groupBumper.upsertTargets('groups', { items: [{ id: '88001122', name: 'Test Group' }] });
    store.groupBumper.upsertTargets('pages', { items: [{ id: '61500001', name: 'Test Page' }] });

    // 1. Poster: PENDING_REVIEW -> not_applied unlocks group+material; second op -> confirmed writes record
    const posterBinding1 = mkBinding(profileId, '100001');
    store.groupPoster.prepareOperation({
      binding: posterBinding1,
      runId: 'run-p1',
      actionKind: 'submit_post',
      groupId: '88001122',
      groupName: 'Test Group',
      materialId: mat.id,
    });
    store.groupPoster.markOperationReview(
      posterBinding1.operationId,
      '\x1B[31mSubmit interrupted\x1B[0m',
    );
    assert.equal(store.groupPoster.hasGroupPostedMaterial('88001122', mat.id), true);
    assert.equal(store.groupPoster.pendingReviewOperations()[0]?.reason, 'Submit interrupted');

    const posterBinding2 = mkBinding(profileId, '100001');
    store.groupPoster.prepareOperation({
      binding: posterBinding2,
      runId: 'run-p2',
      actionKind: 'submit_post',
      groupId: '88001133',
      groupName: 'Test Group 2',
      materialId: mat.id,
      postId: 'pfbid0abc123456',
      postUrl: 'https://www.facebook.com/groups/88001133/posts/pfbid0abc123456/',
    });
    store.groupPoster.markOperationReview(posterBinding2.operationId, 'Close before confirmation');

    // 2. Bumper: PENDING_REVIEW -> not_applied & confirmed
    const bumperRunId = randomUUID();
    const bumperBinding1 = mkBinding(profileId, '100001');
    store.groupBumper.prepareOperation({
      binding: bumperBinding1,
      runId: bumperRunId,
      actionKind: 'submit_comment',
      groupId: '88001122',
      groupName: 'Test Group',
      pageId: '61500001',
      pageName: 'Test Page',
      postId: '99887766',
      postUrl: 'https://www.facebook.com/groups/88001122/posts/99887766/',
      commentText: 'Nice post!',
      status: 'PREPARED',
      reason: '',
      resolution: null,
    });
    store.groupBumper.markOperationReview(
      bumperBinding1.operationId,
      '\x1B[33mPending comment\x1B[0m',
    );
    assert.equal(
      store.groupBumper.eligibility('100001', profileId, '99887766', Date.now(), 'group').allowed,
      false,
    );

    const bumperBinding2 = mkBinding(profileId, '100001');
    store.groupBumper.prepareOperation({
      binding: bumperBinding2,
      runId: bumperRunId,
      actionKind: 'submit_like',
      groupId: '88001122',
      groupName: 'Test Group',
      pageId: '61500001',
      pageName: 'Test Page',
      postId: '99887767',
      postUrl: 'https://www.facebook.com/groups/88001122/posts/99887767/',
      status: 'PREPARED',
      reason: '',
      resolution: null,
    });
    store.groupBumper.markOperationReview(bumperBinding2.operationId, 'Like receipt unknown');

    // Exercise real RPC route handler handleFeatureModuleRoutes
    const mediaPreparer: PosterMediaPreparerPort = {
      prepare: async () => ({ localFilePath: 'C:\\tmp\\unused.jpg', mediaKind: 'image' }),
    };
    const noopRunner: GroupPosterBrowserPort = {
      ready: () => false,
      busy: async () => false,
      stop: async () => {},
      runProfileWorker: async () => {},
    };
    const posterSvc = new GroupPosterService(store.groupPoster, noopRunner, mediaPreparer);
    const bumperSvc = new GroupBumperService(
      store.groupBumper as unknown as BumperRepository,
      { ready: () => false, busy: async () => false, run: async () => {}, stop: async () => {} },
      async () => ({ comments: [], total: 0 }),
    );
    const wsSvc = new WorkspaceService(store, {} as never);

    const invokeRoute = async (route: string, input: unknown) => {
      let statusCode = 0;
      let body: unknown = null;
      const handled = await handleFeatureModuleRoutes({
        req: { method: 'POST', url: route, headers: {} } as IncomingMessage,
        res: {} as ServerResponse,
        route,
        input,
        json: (_res, status, payload) => {
          statusCode = status;
          body = payload;
        },
        service: wsSvc,
        groupPoster: posterSvc,
        groupBumper: bumperSvc,
      });
      assert.equal(handled, true);
      assert.equal(statusCode, 200);
      return body;
    };

    const pUnlockState = (await invokeRoute(
      '/api/workspace/group-poster/pending-operations/resolve',
      {
        operationId: posterBinding1.operationId,
        resolution: 'not_applied',
        note: 'Checked page, not published',
      },
    )) as {
      pendingReviewOperations: Array<{ id: string }>;
      postedGroupIdsByMaterial: Record<string, string[]>;
    };
    assert.equal(
      pUnlockState.pendingReviewOperations.some((op) => op.id === posterBinding1.operationId),
      false,
    );
    assert.equal(store.groupPoster.hasGroupPostedMaterial('88001122', mat.id), false);

    await invokeRoute('/api/workspace/group-poster/pending-operations/resolve', {
      operationId: posterBinding2.operationId,
      resolution: 'confirmed',
    });
    assert.equal(store.groupPoster.hasGroupPostedMaterial('88001133', mat.id), true);
    assert.equal(store.groupPoster.total(), 1);

    await invokeRoute('/api/workspace/group-bumper/pending-operations/resolve', {
      operationId: bumperBinding1.operationId,
      resolution: 'not_applied',
    });
    assert.equal(
      store.groupBumper.eligibility('100001', profileId, '99887766', Date.now(), 'group').allowed,
      true,
    );

    const bConfState = (await invokeRoute(
      '/api/workspace/group-bumper/pending-operations/resolve',
      {
        operationId: bumperBinding2.operationId,
        resolution: 'confirmed',
      },
    )) as { total: number; pendingReviewOperations: Array<{ id: string }> };
    assert.equal(bConfState.total, 1);
    assert.equal(bConfState.pendingReviewOperations.length, 0);

    // Conflicting re-resolution throws
    assert.throws(
      () =>
        store.groupPoster.resolvePendingOperation({
          operationId: posterBinding1.operationId,
          resolution: 'confirmed',
        }),
      /POSTER_RESOLUTION_CONFLICT/,
    );
    assert.throws(
      () =>
        store.groupBumper.resolvePendingOperation({
          operationId: bumperBinding2.operationId,
          resolution: 'not_applied',
        }),
      /BUMPER_RESOLUTION_CONFLICT/,
    );
  });

  it('post-bump-records isolates Chrome carrier=browser total() from BlueStacks and suppresses duplicate failures', async () => {
    const { file, store } = await openTempStore();
    store.close();
    const rawDb = new DatabaseSync(file);
    try {
      const { SqliteGroupPosterRepository } =
        await import('../src/infrastructure/group-poster-store.js');
      const posterRepo = new SqliteGroupPosterRepository(rawDb);
      const bumperRepo = new SqliteGroupBumperRepository(rawDb);
      const recordsRepo = new SqlitePostBumpRecordsRepository(rawDb);
      const chromeId = randomUUID();
      const bsId = randomUUID();
      rawDb
        .prepare(
          `INSERT INTO bluestacks_instances(id, instance_key, display_name, account_id, account_name, updated_at)
           VALUES(?, ?, ?, ?, ?, ?)`,
        )
        .run(bsId, 'Pie64_1', '蓝蝶1', '100099', 'BS Page', Date.now());

      // Insert 1 Chrome poster + 1 BlueStacks poster + 1 Chrome bumper + 1 BlueStacks bumper
      posterRepo.saveMaterials({ items: [{ id: 'm1', caption: 'hi', selected: true }] });
      posterRepo.recordPost({
        id: randomUUID(),
        profileId: chromeId,
        accountId: '100001',
        accountName: 'Chrome Acc',
        accountAvatar: null,
        identityType: 'personal',
        groupId: '111',
        groupName: 'G1',
        groupAvatar: null,
        materialId: 'm1',
        captionPreview: 'hi',
        postId: '1001',
        postUrl: 'https://www.facebook.com/groups/111/posts/1001/',
        postedAt: Date.now(),
      });
      posterRepo.recordPost({
        id: randomUUID(),
        profileId: bsId,
        accountId: '100099',
        accountName: 'BS Acc',
        accountAvatar: null,
        identityType: 'page',
        groupId: '222',
        groupName: 'G2',
        groupAvatar: null,
        materialId: 'm1',
        captionPreview: 'hi',
        postId: '1002',
        postUrl: 'https://www.facebook.com/groups/222/posts/1002/',
        postedAt: Date.now(),
      });
      bumperRepo.record({
        id: randomUUID(),
        profileId: chromeId,
        accountId: '100001',
        groupId: '111',
        groupName: 'G1',
        pageId: '61501',
        pageName: 'P1',
        postId: '3001',
        postUrl: 'https://www.facebook.com/groups/111/posts/3001/',
        liked: true,
        commentText: null,
        bumpedAt: Date.now(),
        sourceMode: 'group',
      });
      bumperRepo.record({
        id: randomUUID(),
        profileId: bsId,
        accountId: '100099',
        groupId: '222',
        groupName: 'G2',
        pageId: '61502',
        pageName: 'P2',
        postId: '3002',
        postUrl: 'https://www.facebook.com/groups/222/posts/3002/',
        liked: true,
        commentText: null,
        bumpedAt: Date.now(),
        sourceMode: 'group',
      });

      assert.equal(posterRepo.total(), 1, 'Chrome poster total() must exclude BlueStacks');
      assert.equal(bumperRepo.total('group'), 1, 'Chrome bumper total() must exclude BlueStacks');
      assert.equal(recordsRepo.list({ carrier: 'browser' }).total, 2);
      assert.equal(recordsRepo.list({ carrier: 'bluestacks' }).total, 2);

      // Duplicate failure suppression on same operationId / sourceLogId + ANSI strip
      const opId = randomUUID();
      const firstFail = recordsRepo.insert({
        recordType: 'post',
        carrier: 'browser',
        status: 'failed',
        profileId: chromeId,
        groupId: '111',
        sourceLogId: opId,
        errorReason: '\x1B[31mBlocked 368\x1B[0m',
      });
      const secondFail = recordsRepo.insert({
        recordType: 'post',
        carrier: 'browser',
        status: 'failed',
        profileId: chromeId,
        groupId: '111',
        sourceLogId: opId,
        errorReason: '\x1B[31mBlocked 368\x1B[0m',
      });
      assert.equal(firstFail.id, secondFail.id);
      assert.equal(firstFail.errorReason, 'Blocked 368');
      assert.equal(recordsRepo.list({ status: 'failed' }).total, 1);

      // GroupPosterService short-window dedupe on repeated failure callbacks
      const posterSvc = new GroupPosterService(
        posterRepo,
        {
          ready: () => false,
          busy: async () => false,
          stop: async () => {},
          runProfileWorker: async () => {},
        },
        { prepare: async () => ({ localFilePath: 'C:\\tmp\\unused.jpg', mediaKind: 'image' }) },
      );
      let insertedCount = 0;
      const recordsPort: PostBumpRecordsPort = {
        insert: (entry) => {
          insertedCount++;
          return recordsRepo.insert(entry);
        },
        list: (q) => recordsRepo.list(q),
        deleteByIds: (ids) => recordsRepo.deleteByIds(ids),
        clear: (rt) => recordsRepo.clear(rt),
        todayStats: (nowMs) => recordsRepo.todayStats(nowMs),
      };
      posterSvc.setPostBumpRecords(recordsPort);
      const port = Reflect.get(
        Reflect.get(posterSvc, 'runtime'),
        'postBumpRecords',
      ) as PostBumpRecordsPort;
      const r1 = await port.insert({
        recordType: 'post',
        carrier: 'browser',
        status: 'failed',
        profileId: chromeId,
        groupId: '333',
        errorReason: '\x1B[2mError 613\x1B[0m',
      });
      const r2 = await port.insert({
        recordType: 'post',
        carrier: 'browser',
        status: 'failed',
        profileId: chromeId,
        groupId: '333',
        errorReason: '\x1B[2mError 613\x1B[0m',
      });
      assert.equal(insertedCount, 1);
      assert.equal(r1.errorReason, 'Error 613');
      assert.equal(r2.errorReason, 'Error 613');
    } finally {
      rawDb.close();
    }
  });

  it('Group Poster GraphQL 368/613 before story_create, pfbid0... DOM read-back, and Next -> Post flow', async () => {
    // 1. code 368 & 613 captured even when body has NO story_create marker
    const g368 = inspectPosterGraphQLResponse(
      'for (;;);' +
        JSON.stringify({
          errors: [
            { code: 368, summary: 'Temporarily Blocked', description: '\x1B[31mRestricted\x1B[0m' },
          ],
        }),
    );
    assert.equal(g368.hasStoryCreate, false);
    assert.equal(g368.restricted, true);
    assert.equal(g368.primaryError?.code, 368);
    assert.equal(g368.primaryError?.kind, 'restricted');

    const g613 = inspectPosterGraphQLResponse(
      JSON.stringify({
        errors: [{ code: 613, message: 'Calls to this api have exceeded the rate limit.' }],
      }),
    );
    assert.equal(g613.restricted, true);
    assert.equal(g613.primaryError?.code, 613);
    assert.equal(g613.primaryError?.kind, 'rate_limit');

    // 2. pfbid0... URL + GraphQL + DOM read-back
    assert.equal(
      extractPosterPostIdFromUrl(
        'https://www.facebook.com/groups/888/posts/pfbid02XyZ9AbCdEf1234/',
      ),
      'pfbid02XyZ9AbCdEf1234',
    );
    const gPfbid = inspectPosterPostFromGql();
    assert.equal(gPfbid.postId, 'pfbid02XyZ9AbCdEf1234');

    function inspectPosterPostFromGql() {
      return inspectPosterGraphQLResponse(
        JSON.stringify({
          data: {
            story_create: {
              story: { url: 'https://www.facebook.com/groups/888/posts/pfbid02XyZ9AbCdEf1234/' },
            },
          },
        }),
      );
    }

    const domRead = await readDomCreatedPostFallback(
      {
        evaluate: async () => ({
          candidates: [
            {
              postId: 'pfbid0999888777aaa',
              authorMatched: true,
              timeTexts: ['刚刚'],
            },
          ],
          transcoding: false,
        }),
      } as never,
      {
        accountId: '100055',
        effectiveGroupId: '888',
        isPageTimeline: false,
        preSubmitPostIds: new Set(),
      },
    );
    assert.equal(domRead.postId, 'pfbid0999888777aaa');

    // 3. waitMediaAndSubmitPost Next -> Post flow
    const responseListeners = new Set<(r: unknown) => void>();
    let step = 0; // 0 = Next button, 1 = Post button, 2 = closed after submit
    let nextClicks = 0;
    let postClicks = 0;
    const postedLogs: Array<{ postId: string; postUrl: string }> = [];
    const mockPage = {
      url: () => 'https://www.facebook.com/groups/888/',
      on: (ev: string, fn: (r: unknown) => void) => {
        if (ev === 'response') responseListeners.add(fn);
      },
      off: (ev: string, fn: (r: unknown) => void) => {
        if (ev === 'response') responseListeners.delete(fn);
      },
      evaluate: async (fn: unknown) => {
        const src = String(fn);
        if (src.includes('data-wb-poster-next')) {
          return step === 0 ? { kind: 'next', label: 'Next' } : { kind: 'post', label: 'Post' };
        }
        if (src.includes('restrictedDialog')) {
          return { hasComposer: step < 2, restrictedDialog: false };
        }
        return [];
      },
      locator: (sel: string) => ({
        first: () => ({
          evaluate: async () => {},
          click: async () => {
            if (sel.includes('data-wb-poster-next')) {
              nextClicks++;
              step = 1;
            } else if (sel.includes('data-wb-poster-submit')) {
              postClicks++;
              step = 2;
              for (const fn of responseListeners) {
                fn({
                  request: () => ({ method: () => 'POST', postData: () => 'doc_id=1' }),
                  url: () => 'https://www.facebook.com/api/graphql/',
                  status: () => 200,
                  text: async () =>
                    JSON.stringify({
                      data: {
                        story_create: {
                          story: {
                            url: 'https://www.facebook.com/groups/888/posts/pfbid0NextPost1234/',
                          },
                        },
                      },
                    }),
                });
              }
            }
          },
        }),
      }),
    };
    const profileId = randomUUID();
    const binding = mkBinding(profileId, '100055');
    await waitMediaAndSubmitPost({
      profileId,
      getPage: () => mockPage as never,
      getConn: () =>
        ({
          context: async () => binding,
          execute: async (_b: Binding, fn: () => Promise<unknown>) => ({ value: await fn() }),
          reconcile: async () => {},
        }) as never,
      peer: {
        profileId,
        epoch: binding.connectionEpoch,
        online: true,
        synced: true,
        phase: 'PAUSED',
      } as never,
      kernel: {} as never,
      core: undefined,
      accountId: '100055',
      accountName: 'Poster User',
      jobId: binding.jobId,
      stepId: binding.stepId,
      effectiveGroupId: '888',
      effectiveGroupName: 'Group 888',
      isPageTimeline: false,
      groupAvatarUrl: null,
      resolvedGroupAvatar: null,
      surface: {
        visible: true,
        ready: true,
        restricted: false,
        blockingDialog: false,
        groupIds: ['888'],
        posts: [],
        avatarUrl: null,
      } as never,
      material: {
        id: 'mat-next',
        caption: 'Next->Post test',
        mediaSource: '',
        background: 'plain',
        aiLabel: 'default',
        localFilePath: null,
        mediaKind: 'none',
        cacheStatus: 'ready',
        cacheError: null,
        selected: true,
        usedCount: 0,
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      identityMeta: { identityType: 'personal', accountAvatar: null },
      paceScale: 0,
      posterRepo: undefined,
      callbacks: {
        runId: 'run-next-post',
        cancelled: () => false,
        status: () => {},
        onTaskPosted: async (log: PosterLog) => {
          postedLogs.push({ postId: log.postId, postUrl: log.postUrl });
        },
      } as never,
      markedPendingReviewRef: { value: false },
      guard: () => {},
      assertIdentity: async () => {},
      execOp: async (_label, work) => work(),
      stopProfile: async () => {},
      reconnectAfterUncertainOp: async () => {},
    });
    assert.equal(nextClicks, 1);
    assert.equal(postClicks, 1);
    assert.equal(postedLogs[0]?.postId, 'pfbid0NextPost1234');
  });

  it('Bumper Emoji+newline comment typing/readback/GraphQL edge & long-press reaction fallback to Like', async () => {
    // 1. Emoji + newline typing & DOM readback
    const typedEvents: string[] = [];
    let domComposed = '';
    const pageKeys = {
      type: async (ch: string) => {
        typedEvents.push(`type:${ch}`);
        domComposed += ch;
      },
      insertText: async (ch: string) => {
        typedEvents.push(`insert:${ch}`);
        domComposed += ch;
      },
      press: async (k: string) => {
        typedEvents.push(`press:${k}`);
        if (k === 'Shift+Enter') domComposed += '\n';
      },
    };
    const mockBox = {
      innerText: async () => domComposed,
      click: async () => {},
      press: async () => {},
      evaluate: async () => false,
      pressSequentially: async () => {},
    };
    const emojiComment = '支持🔥🙏\n第二行加油!';
    await typeBumperComment({ keyboard: pageKeys } as never, mockBox as never, emojiComment, 0);
    assert.ok(typedEvents.includes('press:Shift+Enter'));
    assert.ok(typedEvents.some((e) => e.startsWith('insert:') && e.includes('🔥')));
    assert.equal(
      await readBumperComposerText(mockBox as never, '支持🔥🙏 第二行加油!'),
      emojiComment,
    );

    // GraphQL feedback_comment_edge confirmation with Emoji + newline
    assert.equal(
      confirmedBumperGraphQL({
        actorId: '100088',
        feedbackId: 'feedback:99001122',
        kind: 'comment',
        comment: emojiComment,
        variables: {
          input: {
            actor_id: '100088',
            feedback_id: 'feedback:99001122',
            message: { text: emojiComment },
          },
        },
        status: 200,
        body: JSON.stringify({
          data: {
            comment_create: {
              feedback_comment_edge: {
                feedback: { id: 'feedback:99001122' },
                node: {
                  id: 'comment-123',
                  author: { id: '100088' },
                  body: { text: emojiComment },
                },
              },
            },
          },
        }),
      }),
      true,
    );

    // 2. Long-press reaction fallback to Like when dock fails to open
    const reqListeners = new Set<(r: unknown) => void>();
    const respListeners = new Set<(r: unknown) => void>();
    const hovered: string[] = [];
    const clicked: string[] = [];
    const submissionCalls = { mousePress: 0 };
    const likePage = {
      on: (ev: string, fn: (v: unknown) => void) => {
        if (ev === 'request') reqListeners.add(fn);
        if (ev === 'response') respListeners.add(fn);
      },
      off: (ev: string, fn: (v: unknown) => void) => {
        if (ev === 'request') reqListeners.delete(fn);
        if (ev === 'response') respListeners.delete(fn);
      },
      evaluate: async (fn: unknown) => {
        const s = String(fn);
        if (s.includes('CometUFIReactionsMenuDock')) return false; // dock did NOT open -> fallback to Like
        if (s.includes('projectBumperReactionTarget')) return null;
        return false;
      },
      locator: (sel: string) => ({
        first: () => ({
          hover: async () => {
            hovered.push(sel);
          },
          click: async () => {
            clicked.push(sel);
            submissionCalls.mousePress += 1;
            const req = {
              method: () => 'POST',
              url: () => 'https://www.facebook.com/api/graphql/',
              postData: () =>
                new URLSearchParams({
                  fb_api_req_friendly_name: 'CometUFIFeedbackReactMutation',
                  variables: JSON.stringify({
                    input: {
                      actor_id: '100088',
                      feedback_id: 'feedback:77788899',
                      feedback_reaction_id: '1635855486666999', // Like ID after fallback
                    },
                  }),
                }).toString(),
            };
            for (const fn of reqListeners) fn(req);
            for (const fn of respListeners) {
              fn({
                request: () => req,
                status: () => 200,
                text: async () =>
                  JSON.stringify({
                    data: {
                      feedback_react: {
                        feedback: {
                          id: 'feedback:77788899',
                          viewer_actor: { id: '100088' },
                          viewer_feedback_reaction_info: {
                            id: '1635855486666999',
                            reaction_type: 1,
                          },
                        },
                      },
                    },
                  }),
              });
            }
          },
          evaluate: async () => false,
        }),
      }),
    };
    const postObj = {
      postId: '77788899',
      postUrl: 'https://www.facebook.com/groups/111/posts/77788899/',
      feedbackId: 'feedback:77788899',
      authorId: '61501',
      authorAliases: [],
      liked: false,
      reactionState: 'none' as const,
      likeCSS: '[data-wb-bumper-like="77788899"]',
      commentButtonCSS: null,
      commentCSS: null,
      shareButtonCSS: null,
      videoCSS: null,
      postCSS: '[data-wb-post="77788899"]',
      hasVideo: false,
      timeText: '1m',
      ageHours: 0.02,
      comments: [],
    };
    const activePostState = {
      postId: '77788899',
      wantLike: true,
      wantShareToStory: false,
      chosen: null,
      record: {
        id: randomUUID(),
        profileId: randomUUID(),
        accountId: '100088',
        groupId: '111',
        groupName: 'G',
        pageId: '61501',
        pageName: 'P',
        postId: '77788899',
        postUrl: postObj.postUrl,
        liked: false,
        commentText: null,
        bumpedAt: Date.now(),
        sourceMode: 'group' as const,
      },
      credited: false,
      browseDone: true,
      likeProgress: 'NOT_SENT' as const,
      commentProgress: 'SKIPPED' as const,
      storyShareProgress: 'SKIPPED' as const,
    };
    let persistedOutcome = '';
    const likeRes = await runBumperPostLike({
      profileId: activePostState.record.profileId,
      paceScale: 0,
      effectiveGroupId: '111',
      group: {
        id: '111',
        name: 'G',
        avatarUrl: null,
        folderId: null,
        sortOrder: 0,
        totalBumpedCount: 0,
        createdAt: 0,
        updatedAt: 0,
      },
      target: {
        id: '61501',
        name: 'P',
        avatarUrl: null,
        folderId: null,
        sortOrder: 0,
        totalBumpedCount: 0,
        createdAt: 0,
        updatedAt: 0,
      },
      post: postObj as never,
      todayCount: 0,
      settings: BumperSettings.parse({ useLongPressReaction: true, reactionTypes: ['care'] }),
      callbacks: { cancelled: () => false, status: () => {}, added: () => {} },
      session: {
        accountId: '100088',
        getPage: () => likePage as never,
        getConn: () => ({ submissionCalls }) as never,
        guard: () => {},
        paceWait: async () => {},
        op: async (
          _label: string,
          work: () => Promise<unknown>,
          verify: (v: unknown) => Promise<boolean>,
          persist?: (
            v: unknown,
            b: Binding,
            r: { id: string; outcome: 'VERIFIED'; evidenceDigest: string },
          ) => Promise<{ outcome: string } | undefined>,
        ) => {
          const v = await work();
          assert.equal(await verify(v), true);
          const r = await persist?.(v, mkBinding(activePostState.record.profileId), {
            id: randomUUID(),
            outcome: 'VERIFIED',
            evidenceDigest: 'd',
          });
          if (r) persistedOutcome = r.outcome;
          return v;
        },
        assertIdentity: async () => {},
        resolveActionProgressOnOpExit: async () => 'VERIFIED',
        resetNoProgressRecoveries: () => {},
      } as never,
      groupHelpers: { dismissWelcomeDialogIfNeeded: async () => {} } as never,
      activePostState,
      stats: { consecutiveUnconfirmed: 0 } as never,
      checkPost: async () => postObj as never,
      persist: async (_v, _b, r) => r,
    });
    assert.equal(likeRes.doLike, true);
    assert.equal(hovered[0], '[data-wb-bumper-like="77788899"]');
    assert.equal(clicked[0], '[data-wb-bumper-like="77788899"]');
    assert.equal(activePostState.record.liked, true);
    assert.equal(persistedOutcome, 'VERIFIED');
  });

  it('Daily-limit stopAfterCurrentPost & Q2 closeBrowserOnFinish queue drain across multi-card Chrome profiles', async () => {
    const { store } = await openTempStore();
    const p1 = randomUUID();
    const p2 = randomUUID();
    store.groupBumper.upsertTargets('groups', { items: [{ id: '111', name: 'G1' }] });
    store.groupBumper.upsertTargets('pages', { items: [{ id: '61501', name: 'P1' }] });
    store.groupBumper.saveSettings(
      BumperSettings.parse({ dailyMaxLikesPerAccount: 1, closeBrowserOnFinish: true }),
    );

    // 1. Bumper daily-limit shouldStopAfterCurrentPost + Q2 closeBrowserOnFinish
    const closedBumperProfiles: string[] = [];
    let stopAfterFlagOnAdded = false;
    const bumperService = new GroupBumperService(
      store.groupBumper as unknown as BumperRepository,
      {
        ready: () => true,
        busy: async () => false,
        stop: async () => {},
        run: async (_pid, _groups, _pages, _settings, cb) => {
          cb.added(1);
          stopAfterFlagOnAdded = Boolean(cb.shouldStopAfterCurrentPost?.());
        },
      },
      async () => ({ comments: [], total: 0 }),
      () => {},
      undefined,
      0,
    );
    const mkLifecycle = (onClose: (id: string) => void): ProfileLifecyclePort => ({
      isLaunching: () => false,
      getStatus: async () => [],
      launchProfile: async (id) => ({
        profileId: id,
        browserName: id,
        action: 'open',
        ok: true,
        online: true,
        phase: 'PAUSED',
        synced: true,
        launchable: true,
        elapsedMs: 1,
      }),
      restartProfile: async (id) => ({
        profileId: id,
        browserName: id,
        action: 'restart',
        ok: true,
        online: true,
        phase: 'PAUSED',
        synced: true,
        launchable: true,
        elapsedMs: 1,
      }),
      ensureProfilesOnline: async (ids) => ({
        requestedIds: [...ids],
        readyIds: [...ids],
        launchedIds: [],
        failed: [],
        items: [],
      }),
      closeProfile: async (id) => {
        onClose(id);
        return {
          profileId: id,
          browserName: id,
          action: 'close',
          ok: true,
          online: false,
          phase: 'OFFLINE',
          synced: false,
          launchable: true,
          elapsedMs: 1,
        };
      },
    });
    bumperService.setProfileLifecycle(mkLifecycle((id) => closedBumperProfiles.push(id)));

    await bumperService.start({
      profileIds: [p1],
      groupIds: ['111'],
      pageIds: ['61501'],
      closeBrowserOnFinish: true,
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(stopAfterFlagOnAdded, true);
    assert.deepEqual(closedBumperProfiles, [p1]);

    // 2. Poster Q2 closeBrowserOnFinish waits for queue drain across 2 materials
    store.groupPoster.upsertTargets({
      items: [
        { id: '111', name: 'G1' },
        { id: '222', name: 'G2' },
      ],
    });
    store.groupPoster.saveMaterials({
      items: [
        { id: 'mat-q1', caption: 'Queue Mat 1', selected: true },
        { id: 'mat-q2', caption: 'Queue Mat 2', selected: true },
      ],
    });
    const closedAtStep: Array<{ profileId: string; postedCount: number }> = [];
    let postedTotal = 0;
    const posterSvc = new GroupPosterService(
      store.groupPoster,
      {
        ready: () => true,
        busy: async () => false,
        stop: async () => {},
        runProfileWorker: async (pid, _files, _settings, cb) => {
          while (true) {
            const task = await cb.claimNextTask();
            if (!task) break;
            postedTotal++;
            await cb.onTaskPosted({
              id: randomUUID(),
              profileId: pid,
              accountId: '10001',
              accountName: 'Poster',
              accountAvatar: null,
              identityType: 'personal',
              groupId: task.group.id,
              groupName: task.group.name,
              groupAvatar: null,
              materialId: task.material.id,
              captionPreview: task.material.caption,
              postId: String(9000 + postedTotal),
              postUrl: `https://www.facebook.com/groups/${task.group.id}/posts/${9000 + postedTotal}/`,
              postedAt: Date.now(),
            });
            if (!(await cb.canContinueAccount(pid))) break;
          }
        },
      },
      { prepare: async () => ({ localFilePath: 'C:\\tmp\\unused.jpg', mediaKind: 'image' }) },
    );
    posterSvc.setProfileLifecycle(
      mkLifecycle((id) => closedAtStep.push({ profileId: id, postedCount: postedTotal })),
    );

    await posterSvc.createBatchTasks({
      materialIds: ['mat-q1', 'mat-q2'],
      groupIds: ['111', '222'],
      accountMode: 'selected',
      profileIds: [p1, p2],
      closeBrowserOnFinish: true,
    });
    const deadline = Date.now() + 3000;
    while (posterSvc.hasActiveExecution() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(postedTotal, 4, 'All 2 materials x 2 groups must complete');
    assert.equal(closedAtStep.length, 2, 'Both profiles must close once drained');
    assert.ok(
      closedAtStep.every((e) => e.postedCount >= 2),
      'Must not close prematurely while items remain queued',
    );
    // Avoid unused warning for runBumperPostComment import check
    assert.equal(typeof runBumperPostComment, 'function');
    assert.equal(PosterSettings.parse({}).closeBrowserOnFinish, false);
  });
});
