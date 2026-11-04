import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GroupBumperService } from '../src/application/group-bumper-service.js';
import { GroupInviterService } from '../src/application/group-inviter-service.js';
import { GroupPosterService } from '../src/application/group-poster-service.js';
import { InFlightBumperCoordinator } from '../src/infrastructure/facebook-group-session.js';
import { recoverPosterOperations } from '../src/infrastructure/group-poster-runner.js';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import type { Binding } from '../src/shared/task-execution.js';
import type { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import type { Peer } from '../src/bridge/core.js';

test('WO-U3: migrates fresh database (version = 0 -> v50) and upgrades v49 database to v50 cleanly', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-wo-u3-'));
  try {
    // 1. Fresh DB (0 -> v50)
    const freshDbPath = path.join(tmpDir, 'fresh.sqlite');
    const freshStore = await WorkspaceStore.open(freshDbPath);
    assert.ok(workspaceSchemaVersion >= 50);
    assert.equal(freshStore.groupInviter.getSettings().maxConcurrentProfiles, 4);
    assert.equal(freshStore.groupInviter.getSettings().playSoundOnComplete, true);
    assert.equal(freshStore.groupBumper.settings().maxPostsPerGroupPage, 5);
    assert.equal(freshStore.groupBumper.pageSettings().maxPostsPerPage, 3);
    freshStore.close();

    const rawFresh = new DatabaseSync(freshDbPath, { readOnly: true });
    const userVersion = rawFresh.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(userVersion.user_version, workspaceSchemaVersion);
    assert.deepEqual(rawFresh.prepare('PRAGMA foreign_key_check').all(), []);
    const posterOpsIdx = rawFresh
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'group_poster_operations'",
      )
      .all() as Array<{ name: string }>;
    const idxNames = posterOpsIdx.map((i) => i.name);
    assert.ok(idxNames.includes('idx_group_poster_operations_profile_settled'));
    assert.ok(idxNames.includes('idx_group_poster_operations_group_material_status'));
    rawFresh.close();

    // 2. Upgrade from v49 with historical data (including group_id = '-' page bumper logs)
    const upgDbPath = path.join(tmpDir, 'upgrade-v49.sqlite');
    const seedStore = await WorkspaceStore.open(upgDbPath);
    seedStore.close();

    const rawSeed = new DatabaseSync(upgDbPath);
    rawSeed.exec('PRAGMA foreign_keys = OFF;');
    rawSeed.exec(`
      DROP TABLE IF EXISTS group_poster_operations;
      DROP TABLE IF EXISTS page_bumper_settings;
    `);
    rawSeed.prepare('UPDATE group_bumper_settings SET body = ? WHERE id = 1').run(
      JSON.stringify({
        maxPostsPerPage: 9,
        dailyMaxLikesPerAccount: 33,
        enableSound: true,
      }),
    );
    rawSeed
      .prepare(
        `INSERT INTO group_bumper_logs (
          id, profile_id, account_id, group_id, group_name, page_id, page_name,
          post_id, post_url, liked, comment_text, bumped_at, source_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'group')`,
      )
      .run(
        'legacy-page-log-1',
        'p-1',
        '100088888888888',
        '-',
        '专页主页',
        '100099999999999',
        'Target Page',
        '1234567890',
        'https://www.facebook.com/100099999999999/posts/1234567890',
        1,
        'legacy page comment',
        Date.now(),
      );
    rawSeed.exec('PRAGMA user_version = 49;');
    rawSeed.exec('PRAGMA foreign_keys = ON;');
    rawSeed.close();

    const upgradedStore = await WorkspaceStore.open(upgDbPath);
    assert.equal(upgradedStore.groupBumper.pageSettings().maxPostsPerPage, 9);
    assert.equal(upgradedStore.groupBumper.pageSettings().dailyMaxLikesPerAccount, 33);
    assert.equal(upgradedStore.groupBumper.pageSettings().enableSound, true);
    const pageLogs = upgradedStore.groupBumper.logs(undefined, 10, undefined, undefined, 'page');
    assert.ok(pageLogs.some((l) => l.id === 'legacy-page-log-1'));
    assert.equal(upgradedStore.groupBumper.total('page'), 1);
    assert.equal(upgradedStore.groupBumper.total('group'), 0);
    upgradedStore.close();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('WO-U3: enforces InFlightBumperCoordinator per-(accountId, postId) lock and atomic daily quota across concurrent browsers on the same Page identity', () => {
  const coord = new InFlightBumperCoordinator();
  const pageIdentity = '61550011122233';
  const postId = 'pfbid02xyz';

  // Browser A acquires post lock; Browser B on the same Page identity cannot acquire the same post concurrently
  assert.equal(coord.tryAcquirePost(pageIdentity, postId), true);
  assert.equal(coord.tryAcquirePost(pageIdentity, postId), false);
  // Browser B CAN acquire a different post concurrently under the same Page identity!
  assert.equal(coord.tryAcquirePost(pageIdentity, 'pfbid02other'), true);

  coord.releasePost(pageIdentity, postId);
  assert.equal(coord.tryAcquirePost(pageIdentity, postId), true);
  coord.releasePost(pageIdentity, postId);
  coord.releasePost(pageIdentity, 'pfbid02other');

  // Atomic daily quota reservation: persistedCount = 19, dailyMax = 20
  assert.equal(coord.tryReserveDailyQuota(pageIdentity, 'group', 19, 20), true);
  // Second concurrent browser sees 19 + 1 in-flight = 20 >= 20 -> rejected immediately
  assert.equal(coord.tryReserveDailyQuota(pageIdentity, 'group', 19, 20), false);
  coord.releaseDailyQuota(pageIdentity, 'group');
  assert.equal(coord.tryReserveDailyQuota(pageIdentity, 'group', 19, 20), true);
  coord.releaseDailyQuota(pageIdentity, 'group');
});

test('WO-U3: decouples group_poster_operations kernel_settled from business status so PENDING_REVIEW releases browser without reposting', async () => {
  const store = await WorkspaceStore.open(':memory:');
  try {
    const binding: Binding = {
      operationId: 'op-review-1',
      profileId: 'prof-1',
      accountId: '100011122233344',
      connectionEpoch: '00000000-0000-4000-8000-000000000099',
      leaseId: 'lease-1',
      generation: 1,
      jobId: 'run-poster-1',
      stepId: 'step-submit-1',
      actionDigest: 'digest-submit-1',
    };

    store.groupPoster.prepareOperation({
      binding,
      runId: 'run-poster-1',
      actionKind: 'submit_post',
      groupId: '123456789012',
      groupName: 'Test Group',
      materialId: 'mat-1',
    });

    // Unsettled submit_post blocks workspace reset
    assert.throws(() => store.dataCleanup.assertResettable(), /存在未结清的内核操作锁/);
    assert.equal(store.groupPoster.hasGroupPostedMaterial('123456789012', 'mat-1'), false);

    // Mark operation as PENDING_REVIEW when post submission confirmation times out
    store.groupPoster.markOperationReview(
      'op-review-1',
      '发布回执超时未确认，已停止该浏览器后续发帖并转人工核对',
    );
    assert.equal(store.groupPoster.listOperationsByProfile('prof-1').length, 1);
    assert.equal(store.groupPoster.hasGroupPostedMaterial('123456789012', 'mat-1'), true);

    // Recover poster operations via KernelBridge: settles kernel lock (kernel_settled = 1)
    // while preserving business status = 'PENDING_REVIEW'
    const notified: Array<{ operationId: string; outcome: string }> = [];
    const fakeKernel = {
      withSummary: async (_peer: Peer, fn: (port: unknown) => Promise<unknown>) =>
        fn({
          inventory: async () => ({
            tabs: [],
            operations: [
              {
                binding,
                state: 'ACKNOWLEDGED',
              },
            ],
          }),
          notify: async (b: Binding, res: { outcome: string }) => {
            notified.push({ operationId: b.operationId, outcome: res.outcome });
          },
        }),
    } as unknown as KernelBridge;

    await recoverPosterOperations(
      fakeKernel,
      { profileId: 'prof-1' } as Peer,
      store.groupPoster,
      () => {},
    );

    assert.deepEqual(notified, [{ operationId: 'op-review-1', outcome: 'ENDED_UNKNOWN' }]);

    // Kernel settlement is now complete: browser is unlocked and assertResettable passes
    assert.equal(store.groupPoster.listOperationsByProfile('prof-1').length, 0);
    assert.doesNotThrow(() => store.dataCleanup.assertResettable());

    // CRITICAL: Business status remains 'PENDING_REVIEW' permanently and blocks duplicate reposting!
    const persistedOp = store.groupPoster.getOperation('op-review-1');
    assert.equal(persistedOp?.status, 'PENDING_REVIEW');
    assert.equal(persistedOp?.kernelSettled, true);
    assert.equal(store.groupPoster.hasGroupPostedMaterial('123456789012', 'mat-1'), true);
  } finally {
    store.close();
  }
});

test('WO-U3: supports append-run in GroupInviterService and GroupPosterService without 409 conflicts or duplicate tasks', async () => {
  const store = await WorkspaceStore.open(':memory:');
  try {
    store.groupInviter.upsertGroups({
      items: [
        { groupId: '111000111', groupName: 'Group 1' },
        { groupId: '222000222', groupName: 'Group 2' },
      ],
    });

    const pA = '00000000-0000-4000-8000-00000000000a';
    const pB = '00000000-0000-4000-8000-00000000000b';
    const visitedByProfile: Array<{ profileId: string; groupId: string }> = [];
    let releaseFirstProfile: (() => void) | null = null;
    const firstProfileStarted = new Promise<void>((resolve) => {
      releaseFirstProfile = resolve;
    });
    let unblockFirstGroup: (() => void) | null = null;
    const firstGroupGate = new Promise<void>((resolve) => {
      unblockFirstGroup = resolve;
    });

    const inviterService = new GroupInviterService(store.groupInviter, {
      isAvailable: () => true,
      isProfileReady: () => true,
      isProfileBusy: () => false,
      fetchGroupAvatar: async () => null,
      inviteForGroup: async (profileId, group, _invitesPerGroup, callbacks) => {
        visitedByProfile.push({ profileId, groupId: group.groupId });
        if (profileId === pA && visitedByProfile.length === 1) {
          releaseFirstProfile?.();
          await firstGroupGate;
        }
        await callbacks.addSessionInvited(profileId, 1);
      },
    });

    await inviterService.start({
      profileIds: [pA],
      groupIds: ['111000111'],
    });
    await firstProfileStarted;
    assert.equal((await inviterService.state()).running, true);

    // Append pB while pA is actively running
    const afterAppend = await inviterService.start({
      profileIds: [pB],
      groupIds: ['111000111'],
    });
    assert.equal(afterAppend.running, true);
    if (unblockFirstGroup) (unblockFirstGroup as () => void)();

    for (let i = 0; i < 60 && (await inviterService.state()).running; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal((await inviterService.state()).running, false);
    assert.deepEqual(visitedByProfile.map((v) => v.profileId).sort(), [pA, pB]);

    // GroupPosterService append-run verification (shared taskQueue without duplicate posting)
    store.groupPoster.upsertTargets({
      items: [
        { id: '333000333', name: 'Poster Group 1' },
        { id: '444000444', name: 'Poster Group 2' },
      ],
    });
    const savedMaterials = store.groupPoster.saveMaterials({
      items: [
        { caption: 'Material 1', mediaSource: '', background: 'plain', selected: true },
        { caption: 'Material 2', mediaSource: '', background: 'plain', selected: true },
      ],
      replaceAll: true,
    });

    const postedPairs: Array<{ profileId: string; groupId: string; materialId: string }> = [];
    let releasePosterFirst: (() => void) | null = null;
    const posterFirstStarted = new Promise<void>((resolve) => {
      releasePosterFirst = resolve;
    });
    let unblockPosterFirst: (() => void) | null = null;
    const posterFirstGate = new Promise<void>((resolve) => {
      unblockPosterFirst = resolve;
    });

    const posterService = new GroupPosterService(
      store.groupPoster,
      {
        ready: () => true,
        busy: async () => false,
        stop: async () => {},
        runProfileWorker: async (profileId, _files, _settings, callbacks) => {
          while (!callbacks.cancelled()) {
            const task = await callbacks.claimNextTask();
            if (!task) break;
            postedPairs.push({
              profileId,
              groupId: task.group.id,
              materialId: task.material.id,
            });
            if (profileId === pA && postedPairs.length === 1) {
              releasePosterFirst?.();
              await posterFirstGate;
            }
            await callbacks.onTaskPosted({
              id: `log-${profileId}-${task.group.id}`,
              profileId,
              accountId: '10001',
              accountName: 'Poster User',
              accountAvatar: null,
              identityType: 'personal',
              groupId: task.group.id,
              groupName: task.group.name,
              groupAvatar: null,
              materialId: task.material.id,
              captionPreview: task.material.caption,
              postId: `post-${task.group.id}`,
              postUrl: `https://www.facebook.com/groups/${task.group.id}/posts/1`,
              postedAt: Date.now(),
            });
          }
        },
      },
      {
        prepare: async () => ({ localFilePath: '', mediaKind: 'none' }),
      },
    );

    await posterService.start({
      profileIds: [pA],
      groupIds: ['333000333', '444000444'],
      materialIds: savedMaterials.map((m) => m.id),
    });
    await posterFirstStarted;

    const posterAfterAppend = await posterService.start({
      profileIds: [pB],
      groupIds: ['333000333', '444000444'],
      materialIds: savedMaterials.map((m) => m.id),
    });
    assert.equal(posterAfterAppend.running, true);
    if (unblockPosterFirst) (unblockPosterFirst as () => void)();

    for (let i = 0; i < 60 && (await posterService.state()).running; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal((await posterService.state()).running, false);
    assert.deepEqual(postedPairs.map((p) => p.groupId).sort(), ['333000333', '444000444']);
  } finally {
    store.close();
  }
});

test('WO-U3: completely decouples group-bumper and page-bumper settings, comments, and logs', async () => {
  const store = await WorkspaceStore.open(':memory:');
  try {
    const service = new GroupBumperService(
      store.groupBumper,
      {
        ready: () => true,
        busy: async () => false,
        run: async () => {},
        stop: async () => {},
      },
      async () => ({
        comments: store.groupBumper.comments('group'),
        total: store.groupBumper.total('group'),
      }),
    );

    const initial = await service.state();
    await service.manage('settings', {
      ...initial.settings,
      dailyMaxLikesPerAccount: 15,
      consumeCommentOnUse: false,
    });
    await service.manage('page-settings', {
      ...(initial.pageSettings ?? initial.settings),
      dailyMaxLikesPerAccount: 45,
      maxPostsPerPage: 12,
      consumeCommentOnUse: true,
    });

    await service.manage('comments', {
      texts: ['Group Comment A', 'Group Comment B'],
      consumeCommentOnUse: false,
    });
    await service.manage('page-comments', {
      texts: ['Page Comment X'],
      consumeCommentOnUse: true,
    });

    const state = await service.state();
    assert.equal(state.settings.dailyMaxLikesPerAccount, 15);
    assert.equal(state.settings.consumeCommentOnUse, false);
    assert.equal(state.pageSettings?.dailyMaxLikesPerAccount, 45);
    assert.equal(state.pageSettings?.maxPostsPerPage, 12);
    assert.equal(state.pageSettings?.consumeCommentOnUse, true);
    assert.deepEqual(state.comments.map((c) => c.text).sort(), [
      'Group Comment A',
      'Group Comment B',
    ]);
    assert.deepEqual(
      state.pageComments?.map((c) => c.text),
      ['Page Comment X'],
    );

    // Record a page-bumper log with consumeCommentOnUse=true: only page comment should be consumed!
    const pageComment = store.groupBumper.pickComment('9988776655', 0, [], 'page');
    assert.equal(pageComment?.text, 'Page Comment X');
    store.groupBumper.record(
      {
        id: '00000000-0000-4000-8000-000000000001',
        profileId: '00000000-0000-4000-8000-000000000002',
        accountId: '10001',
        groupId: '-',
        groupName: '专页主页',
        pageId: '10009',
        pageName: 'Page 9',
        postId: '9988776655',
        postUrl: 'https://www.facebook.com/10009/posts/9988776655',
        liked: true,
        commentText: pageComment?.text ?? '',
        bumpedAt: Date.now(),
        sourceMode: 'page',
      },
      pageComment?.id,
    );

    const afterRecord = await service.state();
    assert.equal(afterRecord.pageComments?.length, 0);
    assert.equal(afterRecord.comments.length, 2);
    assert.equal(afterRecord.pageTotal, 1);
    assert.equal(afterRecord.total, 0);
  } finally {
    store.close();
  }
});

test('WO-U3: GroupPosterService maxPostsPerAccount enforces per-round session quota (not historical today) and authorizes queued files on append-run', async () => {
  const store = await WorkspaceStore.open(':memory:');
  try {
    const p21 = '00000000-0000-4000-8000-000000000021';
    const p22 = '00000000-0000-4000-8000-000000000022';
    store.groupPoster.saveSettings({
      maxConcurrentProfiles: 2,
      maxPostsPerAccount: 2,
      materialsPerGroup: 1,
    });
    store.groupPoster.upsertTargets({
      items: [
        { id: '900001', name: 'Group A' },
        { id: '900002', name: 'Group B' },
        { id: '900003', name: 'Group C' },
      ],
    });
    // Pre-seed 2 posts earlier today for p21 so todayCounts[p21] === 2 === maxPostsPerAccount
    const now = Date.now();
    for (const n of [1, 2]) {
      store.groupPoster.recordPost({
        id: `hist-${n}`,
        profileId: p21,
        accountId: '61594502274210',
        accountName: 'Page A',
        accountAvatar: null,
        identityType: 'page',
        groupId: `80000${n}`,
        groupName: `Old Group ${n}`,
        groupAvatar: null,
        materialId: `old-mat-${n}`,
        captionPreview: 'Earlier today',
        postId: `old-post-${n}`,
        postUrl: `https://www.facebook.com/groups/80000${n}/posts/${n}`,
        postedAt: now - 10_000,
      });
    }
    assert.equal(store.groupPoster.todayCounts()[p21], 2);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-poster-round-'));
    try {
      const localVideo = path.join(tmpDir, 'video1.mp4');
      await fs.writeFile(localVideo, 'fake-mp4');
      const mats = store.groupPoster.saveMaterials({
        items: [
          { id: 'm-vid', caption: 'Video mat', mediaSource: localVideo, selected: true },
          { id: 'm-txt', caption: 'Text mat', mediaSource: '', selected: true },
        ],
        replaceAll: true,
      });
      assert.equal(mats.length, 2);

      const seenFilesByProfile = new Map<string, readonly string[]>();
      let releaseFirst: (() => void) | null = null;
      const firstClaimed = new Promise<void>((r) => {
        releaseFirst = r;
      });
      let unblockFirst: (() => void) | null = null;
      const gate = new Promise<void>((r) => {
        unblockFirst = r;
      });

      const service = new GroupPosterService(
        store.groupPoster,
        {
          ready: () => true,
          busy: async () => false,
          stop: async () => {},
          runProfileWorker: async (profileId, files, _settings, callbacks) => {
            seenFilesByProfile.set(profileId, files);
            while (!callbacks.cancelled() && (await callbacks.canContinueAccount(profileId))) {
              const task = await callbacks.claimNextTask();
              if (!task) break;
              if (profileId === p21 && (await service.state()).profileCounts[p21]?.session === 0) {
                releaseFirst?.();
                await gate;
              }
              await callbacks.onTaskPosted({
                id: `new-${profileId}-${task.group.id}-${task.material.id}`,
                profileId,
                accountId: '61594502274210',
                accountName: 'Page A',
                accountAvatar: null,
                identityType: 'page',
                groupId: task.group.id,
                groupName: task.group.name,
                groupAvatar: null,
                materialId: task.material.id,
                captionPreview: task.material.caption,
                postId: `p-${task.group.id}-${task.material.id}`,
                postUrl: `https://www.facebook.com/groups/${task.group.id}/posts/1`,
                postedAt: Date.now(),
              });
            }
          },
        },
        {
          prepare: async (mediaSource) => ({
            localFilePath: mediaSource,
            mediaKind: mediaSource ? 'video' : 'none',
          }),
        },
      );

      // Start round on p21 (which already has today=2) with video material across 3 groups
      await service.start({
        profileIds: [p21],
        groupIds: ['900001', '900002', '900003'],
        materialIds: ['m-vid'],
      });
      await firstClaimed;

      // Append p22 with ONLY m-txt while m-vid tasks are still in taskQueue!
      await service.start({
        profileIds: [p22],
        groupIds: ['900001'],
        materialIds: ['m-txt'],
      });
      if (unblockFirst) (unblockFirst as () => void)();

      for (let i = 0; i < 60 && service.hasActiveExecution(); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }

      const finalState = await service.state();
      // p21 posted 2 times in this round despite starting with today = 2 -> today = 4, session = 2
      assert.equal(finalState.profileCounts[p21]?.session, 2);
      assert.equal(finalState.profileCounts[p21]?.today, 4);
      assert.match(finalState.profileCounts[p21]?.status ?? '', /已达本轮上限 \(2\/2\)/);
      // p22 received localVideo in kernel file authorization even though its own append call only selected m-txt!
      assert.equal(seenFilesByProfile.get(p22)?.includes(localVideo), true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  } finally {
    store.close();
  }
});
