import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { DataCleanupService } from '../src/application/data-cleanup.js';
import { GroupBumperService } from '../src/application/group-bumper-service.js';
import { GroupInviterService } from '../src/application/group-inviter-service.js';
import { GroupPosterService } from '../src/application/group-poster-service.js';
import { SqliteDataCleanup } from '../src/infrastructure/data-cleanup-store.js';
import { SqliteGroupBumperRepository } from '../src/infrastructure/group-bumper-store.js';
import { SqliteGroupInviterRepository } from '../src/infrastructure/group-inviter-store.js';
import { FilesystemPosterMediaPreparer } from '../src/infrastructure/group-poster-runner.js';
import { SqliteGroupPosterRepository } from '../src/infrastructure/group-poster-store.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { projectProfileActivity } from '../src/renderer/modules/profile-activity-projector.js';
import { buildUnifiedActivityFeed } from '../src/renderer/modules/unified-activity-records.js';
import {
  buildTargetCandidates,
  normalizeTargetToken,
  resolveSelectByIds,
} from '../src/shared/target-list.js';

function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-wo-r3-'));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => {
      rmSync(dir, { recursive: true, force: true });
    });
}

test('WO-R3.1: normalizeTargetToken and resolveSelectByIds support full Facebook URLs with query parameters', () => {
  assert.equal(
    normalizeTargetToken(
      'shared_groups',
      'https://www.facebook.com/groups/123456789012345/?ref=share',
    ),
    '123456789012345',
  );
  assert.equal(
    normalizeTargetToken(
      'bumper_pages',
      'https://www.facebook.com/profile.php?id=100089876543210&sk=about',
    ),
    '100089876543210',
  );
  const groupCandidates = buildTargetCandidates([{ id: '123456789012345' }]);
  const matchedGroups = resolveSelectByIds(
    ['https://www.facebook.com/groups/123456789012345/?ref=share', '999999999999'].join('\n'),
    'shared_groups',
    groupCandidates,
  );
  assert.deepEqual(matchedGroups.matchedIds, ['123456789012345']);
  assert.deepEqual(matchedGroups.unmatchedTokens, ['999999999999']);

  const pageCandidates = buildTargetCandidates([{ id: '100089876543210' }]);
  const matchedPages = resolveSelectByIds(
    'https://www.facebook.com/profile.php?id=100089876543210&sk=about',
    'bumper_pages',
    pageCandidates,
  );
  assert.deepEqual(matchedPages.matchedIds, ['100089876543210']);
});

test('WO-R3.2: poster material preparation isolates failures, verifies local/Drive cache existence, and serves full >4MB images without truncation', async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, 'poster.sqlite');
    const store = await WorkspaceStore.open(dbPath);
    await store.close();
    const db = new DatabaseSync(dbPath);
    try {
      const repo = new SqliteGroupPosterRepository(db);
      const validImgPath = path.join(dir, 'large-image.jpg');
      // Write a 5MB image file (> 4MB chunk threshold)
      writeFileSync(validImgPath, Buffer.alloc(5 * 1024 * 1024, 0x42));
      const missingImgPath = path.join(dir, 'missing-image.jpg');

      const saved = repo.saveMaterials({
        items: [
          {
            id: 'mat-invalid',
            caption: 'bad url',
            mediaSource: 'https://example.com/not-supported.txt',
            background: 'plain',
            selected: true,
          },
          {
            id: 'mat-missing-local',
            caption: 'missing local',
            mediaSource: missingImgPath,
            background: 'plain',
            selected: true,
          },
          {
            id: 'mat-valid-local',
            caption: 'valid local',
            mediaSource: validImgPath,
            background: 'plain',
            selected: true,
          },
        ],
        replaceAll: true,
      });

      const invalidMat = saved.find((m) => m.id === 'mat-invalid');
      assert.equal(invalidMat?.cacheStatus, 'error');
      assert.match(invalidMat?.cacheError ?? '', /不支持/);

      const preparer = new FilesystemPosterMediaPreparer(path.join(dir, 'cache'));
      const service = new GroupPosterService(
        repo,
        {
          ready: () => true,
          busy: async () => false,
          runProfileWorker: async () => {},
          stop: async () => {},
        },
        preparer,
      );

      // prepareMaterialById on missing local file marks error instead of short-circuiting on ready
      await assert.rejects(
        () => service.prepareMaterialById('mat-missing-local'),
        /本地文件不存在/,
      );
      const afterMissing = repo.materials().find((m) => m.id === 'mat-missing-local');
      assert.equal(afterMissing?.cacheStatus, 'error');

      // saveMaterials batch preparation isolates mat-missing-local failure so mat-valid-local still prepares
      await service.saveMaterials({
        items: [
          {
            id: 'mat-missing-local',
            caption: 'missing local',
            mediaSource: missingImgPath,
            background: 'plain',
            selected: true,
          },
          {
            id: 'mat-valid-local',
            caption: 'valid local',
            mediaSource: validImgPath,
            background: 'plain',
            selected: true,
          },
        ],
        replaceAll: true,
      });
      for (let i = 0; i < 40; i++) {
        const cur = repo.materials().find((m) => m.id === 'mat-valid-local');
        if (cur?.cacheStatus === 'ready' && cur.lastUsedAt && cur.lastUsedAt > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const validMat = repo.materials().find((m) => m.id === 'mat-valid-local');
      assert.equal(validMat?.cacheStatus, 'ready');
      assert.ok(validMat?.lastUsedAt && validMat.lastUsedAt > 0);

      // readMediaRange without Range header returns full 5MB image (status 200) without 4MB truncation
      const chunk = await preparer.readMediaRange(validImgPath, 'image', undefined);
      assert.equal(chunk?.status, 200);
      assert.equal(chunk?.bytes?.byteLength, 5 * 1024 * 1024);
    } finally {
      db.close();
    }
  });
});

test('WO-R3.3: sidebar projector preserves cross-module lastResult when idle in active module, and inviter concurrency updates dynamically', async () => {
  const pid = randomUUID();
  const projected = projectProfileActivity(pid, {
    activeModule: 'group-poster',
    tasks: {
      plans: [],
      currentSteps: [],
      profileResults: [
        {
          profileId: pid,
          source: 'page-bumper',
          runId: 'run-page-1',
          name: '专页顶贴',
          state: 'COMPLETED',
          reason: '已顶贴 3 次',
          finishedAt: Date.now() - 5000,
          failedSteps: 0,
          skippedSteps: 0,
        },
      ],
    } as never,
    groupPosterCounts: {
      [pid]: {
        today: 2,
        session: 0,
        status: '未运行',
        running: false,
      },
    },
  });
  assert.equal(projected?.moduleId, 'page-bumper');
  assert.equal(projected?.moduleLabel, '专页顶贴');
  assert.match(projected?.text ?? '', /专页顶贴/);
  assert.match((projected?.tooltipLines ?? []).join(' '), /已顶贴 3 次/);

  await withTempDir(async (dir) => {
    const db = new DatabaseSync(path.join(dir, 'inviter.sqlite'));
    try {
      const repo = new SqliteGroupInviterRepository(db);
      const p1 = randomUUID();
      const p2 = randomUUID();
      repo.upsertGroups({ items: [{ groupId: '123456', groupName: 'G1' }] });
      repo.saveSettings({
        invitesPerGroup: 10,
        maxConcurrentProfiles: 1,
        playSoundOnComplete: true,
      });

      const activeInRunner = new Set<string>();
      const gateObj: { release: () => void } = { release: () => {} };
      const gate = new Promise<void>((resolve) => {
        gateObj.release = resolve;
      });
      const service = new GroupInviterService(repo, {
        isAvailable: () => true,
        isProfileReady: () => true,
        isProfileBusy: async () => false,
        fetchGroupAvatar: async () => null,
        inviteForGroup: async (profileId: string) => {
          activeInRunner.add(profileId);
          await gate;
        },
      });

      await service.start({ profileIds: [p1], groupIds: ['123456'], invitesPerGroup: 10 });
      await service.start({ profileIds: [p2], groupIds: ['123456'], invitesPerGroup: 10 });
      await new Promise((r) => setTimeout(r, 80));
      // With maxConcurrentProfiles = 1, only 1 profile enters runner while the appended profile waits for a slot
      assert.equal(activeInRunner.size, 1);

      // Dynamically raise maxConcurrentProfiles to 2 while running
      await service.updateSettings({ maxConcurrentProfiles: 2 });
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(activeInRunner.size, 2);

      gateObj.release();
      await new Promise((r) => setTimeout(r, 80));
    } finally {
      db.close();
    }
  });
});

test('WO-R3.4: GroupBumperService avatar refresh is non-blocking and supports refresh-stop', async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, 'bumper.sqlite');
    const store = await WorkspaceStore.open(dbPath);
    await store.close();
    const db = new DatabaseSync(dbPath);
    try {
      const repo = new SqliteGroupBumperRepository(db);
      repo.upsertTargets('pages', { items: [{ id: '100089876543210', name: '' }] });
      let sawSignalAborted = false;
      const service = new GroupBumperService(
        repo,
        {
          ready: () => true,
          busy: async () => false,
          run: async () => {},
          stop: async () => {},
        },
        async () => ({ comments: [], total: 0 }),
        () => {},
        async (_kind, _items, options) => {
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener(
              'abort',
              () => {
                sawSignalAborted = true;
                resolve();
              },
              { once: true },
            );
          });
          return { updated: 0, needsBrowser: 0, failed: 0 };
        },
      );

      const stateWhileRefreshing = await service.manage('pages/refresh', {});
      assert.equal(stateWhileRefreshing.pageAvatarRefreshing, true);
      assert.match(stateWhileRefreshing.pageBumperStatusText ?? '', /正在读取资料/);

      const stateAfterStop = await service.manage('pages/refresh-stop', {});
      assert.equal(stateAfterStop.pageAvatarRefreshing, false);
      assert.equal(sawSignalAborted, true);
      assert.match(stateAfterStop.pageBumperStatusText ?? '', /已停止读取专页资料/);
    } finally {
      db.close();
    }
  });
});

test('WO-R3.5: deleteLogs recalculates target counts, PENDING_REVIEW operations surface in unified feed, and DataCleanupService purges settled feature ops even when task_steps is empty', async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, 'cleanup.sqlite');
    const store = await WorkspaceStore.open(dbPath);
    await store.close();
    const db = new DatabaseSync(dbPath);
    try {
      const bumperRepo = new SqliteGroupBumperRepository(db);
      const posterRepo = new SqliteGroupPosterRepository(db);
      const pid = randomUUID();
      const epoch = randomUUID();

      bumperRepo.upsertTargets('groups', { items: [{ id: '111222333', name: 'Test Group' }] });
      bumperRepo.upsertTargets('pages', { items: [{ id: '444555666', name: 'Test Page' }] });

      const log1Id = randomUUID();
      bumperRepo.record({
        id: log1Id,
        profileId: pid,
        accountId: '10001',
        groupId: '111222333',
        groupName: 'Test Group',
        pageId: '444555666',
        pageName: 'Test Page',
        postId: '100001',
        postUrl: 'https://www.facebook.com/groups/111222333/posts/100001/',
        liked: true,
        commentText: null,
        bumpedAt: Date.now(),
        sourceMode: 'group',
      });
      assert.equal(bumperRepo.targets('groups')[0]?.totalBumpedCount, 1);
      assert.equal(bumperRepo.targets('pages')[0]?.totalBumpedCount, 1);

      bumperRepo.deleteLogs({ ids: [log1Id], all: false });
      assert.equal(bumperRepo.targets('groups')[0]?.totalBumpedCount, 0);
      assert.equal(bumperRepo.targets('pages')[0]?.totalBumpedCount, 0);

      // Prepare and mark one bumper op as PENDING_REVIEW and one as SETTLED (old)
      const reviewOpId = randomUUID();
      bumperRepo.prepareOperation({
        binding: {
          operationId: reviewOpId,
          profileId: pid,
          accountId: '10001',
          connectionEpoch: epoch,
          leaseId: randomUUID(),
          generation: 1,
          jobId: randomUUID(),
          stepId: randomUUID(),
          actionDigest: 'a'.repeat(64),
        },
        runId: randomUUID(),
        actionKind: 'submit_like',
        groupId: '111222333',
        groupName: 'Test Group',
        pageId: '444555666',
        pageName: 'Test Page',
        postId: '100002',
        postUrl: 'https://www.facebook.com/groups/111222333/posts/100002/',
        commentId: null,
        commentText: null,
        logId: randomUUID(),
        resolution: null,
        status: 'PREPARED',
        reason: '',
      });
      bumperRepo.markOperationReview(reviewOpId, 'SUBMISSION_UNCONFIRMED');

      const settledOpId = randomUUID();
      bumperRepo.prepareOperation({
        binding: {
          operationId: settledOpId,
          profileId: pid,
          accountId: '10001',
          connectionEpoch: epoch,
          leaseId: randomUUID(),
          generation: 1,
          jobId: randomUUID(),
          stepId: randomUUID(),
          actionDigest: 'b'.repeat(64),
        },
        runId: randomUUID(),
        actionKind: 'submit_like',
        groupId: '111222333',
        groupName: 'Test Group',
        pageId: '444555666',
        pageName: 'Test Page',
        postId: '100003',
        postUrl: 'https://www.facebook.com/groups/111222333/posts/100003/',
        commentId: null,
        commentText: null,
        logId: randomUUID(),
        resolution: null,
        status: 'PREPARED',
        reason: '',
      });
      bumperRepo.setOperationResolution(settledOpId, {
        id: randomUUID(),
        outcome: 'NOT_APPLIED',
        evidenceDigest: 'c'.repeat(64),
      });
      bumperRepo.markOperationSettled(settledOpId);
      db.prepare('UPDATE group_bumper_operations SET updated_at = ? WHERE operation_id = ?').run(
        Date.now() - 10 * 86400_000,
        settledOpId,
      );

      // Verify PENDING_REVIEW op is returned and surfaces in buildUnifiedActivityFeed even with empty profileCounts
      const pendingOps = bumperRepo.pendingReviewOperations();
      assert.equal(pendingOps.length, 1);
      assert.equal(pendingOps[0]?.id, reviewOpId);

      const feed = buildUnifiedActivityFeed({
        profiles: [{ id: pid, browserName: 'P1', alias: 'P1' } as never],
        bumperState: {
          groups: [],
          pages: [],
          settings: bumperRepo.settings(),
          comments: [],
          total: 0,
          running: false,
          statusText: '',
          profileCounts: {},
          pendingReviewOperations: pendingOps,
        },
        posterState: {
          groups: [],
          materials: [],
          settings: posterRepo.settings(),
          total: 0,
          running: false,
          statusText: '',
          profileCounts: {},
          dailyStats: [],
          pendingReviewOperations: [],
        },
      });
      assert.equal(feed.statusCounts.attention, 1);
      assert.equal(feed.items[0]?.id, `bumper-op:${reviewOpId}`);

      // Verify DataCleanupService.execute purges settled feature op even when task_steps has 0 rows
      const cleanupRepo = new SqliteDataCleanup(db);
      const cleanupService = new DataCleanupService(
        cleanupRepo,
        { preview: async () => [], remove: async () => ({ deleted: 0, bytes: 0, protected: 0 }) },
        undefined,
        async () => {},
        () => {},
      );
      const preview = await cleanupService.preview({
        kind: 'records',
        scope: { before: Date.now() - 86400_000 },
      });
      assert.equal(preview.eligible, 0);
      const result = await cleanupService.execute({ token: preview.token, confirm: true });
      assert.equal(result.deleted, 1);
      assert.equal(bumperRepo.getOperation(settledOpId), null);
      assert.notEqual(bumperRepo.getOperation(reviewOpId), null);
    } finally {
      db.close();
    }
  });
});
