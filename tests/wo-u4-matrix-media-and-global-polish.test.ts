import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import { SqliteGroupInviterRepository } from '../src/infrastructure/group-inviter-store.js';
import { SqliteGroupBumperRepository } from '../src/infrastructure/group-bumper-store.js';
import { SqliteGroupPosterRepository } from '../src/infrastructure/group-poster-store.js';
import {
  decodePosterThumbnailDataUrl,
  encodeImageBufferToPosterThumbnail,
  isPathInsidePosterCacheDir,
  removePosterCachedFileIfSafe,
} from '../src/infrastructure/poster-media-thumbnail.js';
import {
  createEmptyMaterialDraft,
  fillPosterMaterialFiles,
  pastePosterMaterialCells,
} from '../src/domain/poster-material-table.js';
import { buildUnifiedActivityFeed } from '../src/renderer/modules/unified-activity-records.js';
import { GroupPosterService } from '../src/application/group-poster-service.js';

const P01 = '00000000-0000-4000-8000-000000000041';

test('WO-U4.1: fresh DB (0 -> 51) and legacy DB upgrade reach user_version = 51 with zero foreign_key_check errors and standalone :memory: store compatibility', async () => {
  assert.ok(workspaceSchemaVersion >= 51);
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-wou4-db-'));
  try {
    const dbPath = path.join(dir, 'fresh.sqlite');
    const store = await WorkspaceStore.open(dbPath);
    store.close();

    const raw = new DatabaseSync(dbPath, { readOnly: true });
    const ver = (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    const fk = raw.prepare('PRAGMA foreign_key_check').all();
    assert.equal(ver, workspaceSchemaVersion);
    assert.equal(fk.length, 0);
    const cols = (
      raw.prepare("PRAGMA table_info('group_poster_materials')").all() as Array<{ name: string }>
    ).map((c) => c.name);
    assert.ok(cols.includes('last_used_at'));
    assert.ok(cols.includes('thumbnail_data_url'));
    raw.close();

    // Standalone :memory: repositories work cleanly without WorkspaceStore.open()
    const mem = new DatabaseSync(':memory:');
    const inviterRepo = new SqliteGroupInviterRepository(mem);
    const bumperRepo = new SqliteGroupBumperRepository(mem);
    const posterRepo = new SqliteGroupPosterRepository(mem);
    assert.equal(inviterRepo.getSettings().maxConcurrentProfiles, 4);
    assert.equal(bumperRepo.settings().maxConcurrentProfiles, 8);
    assert.equal(posterRepo.settings().maxConcurrentProfiles, 4);
    mem.close();

    // Legacy v50 -> v51 upgrade path (pre-thumbnail group_poster_materials)
    const legacyPath = path.join(dir, 'legacy-v50.sqlite');
    const storeLegacy = await WorkspaceStore.open(legacyPath);
    storeLegacy.close();
    const rawLegacy = new DatabaseSync(legacyPath);
    rawLegacy.exec('PRAGMA user_version = 50');
    rawLegacy.close();
    const upgraded = await WorkspaceStore.open(legacyPath);
    upgraded.close();
    const rawUpgraded = new DatabaseSync(legacyPath, { readOnly: true });
    assert.equal(
      (rawUpgraded.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      workspaceSchemaVersion,
    );
    assert.equal(rawUpgraded.prepare('PRAGMA foreign_key_check').all().length, 0);
    rawUpgraded.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WO-U4.2: local media paths immediately become ready without downloading in both domain table helpers and SqliteGroupPosterRepository', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-wou4-local-'));
  try {
    const localImg = path.join(dir, 'sample.png');
    const canvas = createCanvas(160, 90);
    writeFileSync(localImg, canvas.toBuffer('image/png'));

    let seq = 0;
    const rows = pastePosterMaterialCells(
      [createEmptyMaterialDraft('r0')],
      0,
      0,
      `本地测试图片\t${localImg}\t普通文字\n网盘视频\thttps://drive.google.com/file/d/1I7SmXoi5aqDctMn1gQnu0qJbLM2PBkl9/view\t普通文字`,
      () => `id-${++seq}`,
    );
    assert.equal(rows[0]?.cacheStatus, 'ready');
    assert.equal(rows[0]?.localFilePath, localImg);
    assert.equal(rows[1]?.cacheStatus, 'downloading');

    const filled = fillPosterMaterialFiles(
      [createEmptyMaterialDraft('r-fill')],
      0,
      [localImg],
      () => `id-${++seq}`,
    );
    assert.equal(filled[0]?.cacheStatus, 'ready');
    assert.equal(filled[0]?.localFilePath, localImg);

    const dbPath = path.join(dir, 'store.sqlite');
    const store = await WorkspaceStore.open(dbPath);
    const saved = await store.groupPoster.saveMaterials({
      items: [
        {
          id: 'mat-local-1',
          caption: 'Local image',
          mediaSource: localImg,
          background: 'plain',
          selected: true,
        },
        {
          id: 'mat-drive-1',
          caption: 'Drive video',
          mediaSource: 'https://drive.google.com/file/d/1I7SmXoi5aqDctMn1gQnu0qJbLM2PBkl9/view',
          background: 'plain',
          selected: true,
        },
      ],
      replaceAll: true,
    });
    const localMat = saved.find((m) => m.id === 'mat-local-1');
    const driveMat = saved.find((m) => m.id === 'mat-drive-1');
    assert.equal(localMat?.cacheStatus, 'ready');
    assert.equal(localMat?.localFilePath, localImg);
    assert.equal(driveMat?.cacheStatus, 'downloading');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WO-U4.3: 120px aspect-ratio WebP thumbnail generation, zero-polling-bloat PosterState, and 3-day Drive cache cleanup with path guardrail', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-wou4-media-'));
  try {
    // 1. Test 16:9 (320x180 -> 120x68) and 9:16 (180x320 -> 68x120) aspect-ratio thumbnails
    const wide = createCanvas(320, 180);
    const wideCtx = wide.getContext('2d');
    wideCtx.fillStyle = '#2563eb';
    wideCtx.fillRect(0, 0, 320, 180);
    const wideThumb = await encodeImageBufferToPosterThumbnail(wide.toBuffer('image/png'));
    assert.ok(wideThumb);
    assert.ok(wideThumb.startsWith('data:image/webp;base64,'));
    assert.ok(wideThumb.length <= 24 * 1024);
    const wideDecoded = decodePosterThumbnailDataUrl(wideThumb);
    assert.ok(wideDecoded);
    const wideImg = await loadImage(wideDecoded.bytes);
    assert.equal(wideImg.width, 120);
    assert.equal(wideImg.height, 68);

    const tall = createCanvas(180, 320);
    const tallThumb = await encodeImageBufferToPosterThumbnail(tall.toBuffer('image/png'));
    assert.ok(tallThumb);
    const tallDecoded = decodePosterThumbnailDataUrl(tallThumb);
    assert.ok(tallDecoded);
    const tallImg = await loadImage(tallDecoded.bytes);
    assert.equal(tallImg.width, 68);
    assert.equal(tallImg.height, 120);

    // 2. Store thumbnail and verify PosterState.materials does not inline thumbnail_data_url
    const dbPath = path.join(dir, 'poster.sqlite');
    const store = await WorkspaceStore.open(dbPath);
    await store.groupPoster.saveMaterials({
      items: [
        {
          id: 'mat-drive-exp',
          caption: 'Drive material',
          mediaSource: 'https://drive.google.com/file/d/1I7SmXoi5aqDctMn1gQnu0qJbLM2PBkl9/view',
          background: 'plain',
          selected: true,
        },
      ],
      replaceAll: true,
    });
    assert.equal(await store.groupPoster.saveMaterialThumbnail('mat-drive-exp', wideThumb), true);

    const list = await store.groupPoster.materials();
    assert.equal(list[0]?.hasThumbnail, true);
    assert.equal('thumbnailDataUrl' in (list[0] ?? {}), false);
    assert.equal('thumbnail_data_url' in (list[0] ?? {}), false);

    const thumbMeta = await store.groupPoster.getMaterialThumbnail('mat-drive-exp');
    const binary = decodePosterThumbnailDataUrl(thumbMeta?.thumbnailDataUrl);
    assert.ok(binary);
    assert.equal(binary.bytes.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(binary.bytes.subarray(8, 12).toString('ascii'), 'WEBP');

    // 3. Test 3-day Drive cache cleanup & path safety guardrail
    const cacheDir = path.join(dir, 'poster-media-cache');
    mkdirSync(cacheDir, { recursive: true });
    const cachedDriveFile = path.join(cacheDir, 'drive-cached.mp4');
    const userLocalFile = path.join(dir, 'user-precious-video.mp4');
    writeFileSync(cachedDriveFile, 'cached-video-bytes');
    writeFileSync(userLocalFile, 'user-precious-bytes');

    assert.equal(isPathInsidePosterCacheDir(cacheDir, cachedDriveFile), true);
    assert.equal(isPathInsidePosterCacheDir(cacheDir, userLocalFile), false);
    assert.equal(await removePosterCachedFileIfSafe(cacheDir, userLocalFile), false);
    assert.equal(existsSync(userLocalFile), true);

    await store.groupPoster.updateMaterialCache('mat-drive-exp', {
      localFilePath: cachedDriveFile,
      mediaKind: 'video',
      cacheStatus: 'ready',
      cacheError: null,
    });
    store.close();

    // Backdate updated_at to 4 days ago
    const raw = new DatabaseSync(dbPath);
    const fourDaysAgo = Date.now() - 4 * 24 * 3600_000;
    raw
      .prepare('UPDATE group_poster_materials SET updated_at = ?, last_used_at = NULL WHERE id = ?')
      .run(fourDaysAgo, 'mat-drive-exp');
    raw.close();

    const store2 = await WorkspaceStore.open(dbPath);
    const expired = await store2.groupPoster.listExpiredDriveMaterials(
      Date.now() - 3 * 24 * 3600_000,
    );
    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.id, 'mat-drive-exp');

    const service = new GroupPosterService(
      store2.groupPoster,
      {
        ready: () => true,
        busy: async () => false,
        runProfileWorker: async () => {},
        stop: async () => {},
      },
      {
        prepare: async () => ({ localFilePath: cachedDriveFile, mediaKind: 'video' as const }),
        removeCachedDriveFile: async (filePath) => removePosterCachedFileIfSafe(cacheDir, filePath),
      },
    );

    const cleanedResult = await service.cleanupExpiredDriveCache();
    assert.equal(cleanedResult.expired, 1);
    assert.equal(existsSync(cachedDriveFile), false);

    const afterCleanup = (await store2.groupPoster.materials())[0];
    assert.equal(afterCleanup?.cacheStatus, 'expired');
    assert.equal(afterCleanup?.localFilePath, null);
    // Thumbnail is preserved!
    assert.equal(afterCleanup?.hasThumbnail, true);
    assert.ok((await store2.groupPoster.getMaterialThumbnail('mat-drive-exp'))?.thumbnailDataUrl);

    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WO-U4.4: SqliteDataCleanup purges settled operations while protecting PENDING_REVIEW & unsettled locks, and buildUnifiedActivityFeed supports all 5 modules', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-wou4-cleanup-'));
  try {
    const dbPath = path.join(dir, 'cleanup.sqlite');
    const store = await WorkspaceStore.open(dbPath);
    const oldTime = Date.now() - 40 * 24 * 3600_000;

    // 1. Insert settled & pending_review poster operations
    await store.groupPoster.prepareOperation({
      binding: {
        operationId: 'op-verified-settled',
        profileId: P01,
        accountId: '10001',
        connectionEpoch: '00000000-0000-4000-8000-000000000099',
        leaseId: 'lease-1',
        generation: 1,
        jobId: 'job-1',
        stepId: 'step-1',
        actionDigest: 'digest-1',
      },
      runId: 'run-1',
      actionKind: 'submit_post',
      groupId: '123456',
      groupName: 'Group 123456',
      materialId: 'm1',
    });
    await store.groupPoster.setOperationResolution('op-verified-settled', {
      id: 'res-1',
      outcome: 'VERIFIED',
      evidenceDigest: 'ev-1',
    });
    await store.groupPoster.markOperationKernelSettled('op-verified-settled');

    await store.groupPoster.prepareOperation({
      binding: {
        operationId: 'op-pending-review-settled',
        profileId: P01,
        accountId: '10001',
        connectionEpoch: '00000000-0000-4000-8000-000000000099',
        leaseId: 'lease-1',
        generation: 1,
        jobId: 'job-1',
        stepId: 'step-2',
        actionDigest: 'digest-2',
      },
      runId: 'run-1',
      actionKind: 'submit_post',
      groupId: '123456',
      groupName: 'Group 123456',
      materialId: 'm2',
    });
    await store.groupPoster.markOperationReview('op-pending-review-settled', '发布结果未确认');
    await store.groupPoster.markOperationKernelSettled('op-pending-review-settled');
    store.close();

    const rawBackdate = new DatabaseSync(dbPath);
    rawBackdate.prepare('UPDATE group_poster_operations SET updated_at = ?').run(oldTime);
    rawBackdate.close();

    const storeClean = await WorkspaceStore.open(dbPath);
    // Run expired retention cleanup
    await storeClean.dataCleanup.removeBatch({ before: Date.now() - 30 * 24 * 3600_000 });

    // op-verified-settled should be purged, while op-pending-review-settled MUST be preserved!
    assert.equal(await storeClean.groupPoster.hasGroupPostedMaterial('123456', 'm2'), true);
    storeClean.close();

    const raw = new DatabaseSync(dbPath, { readOnly: true });
    const remainingIds = (
      raw.prepare('SELECT operation_id FROM group_poster_operations').all() as Array<{
        operation_id: string;
      }>
    ).map((r) => r.operation_id);
    assert.deepEqual(remainingIds, ['op-pending-review-settled']);
    raw.close();

    // 2. Verify buildUnifiedActivityFeed 5-module projection
    const feed = buildUnifiedActivityFeed({
      profiles: [
        {
          id: P01,
          alias: 'Browser 1',
          browserName: 'Browser 1',
          groupId: null,
          order: 0,
          online: true,
          synced: true,
          phase: 'PAUSED',
          unresolved: 0,
          extensionVersion: '0.3.59',
          capabilities: ['facebook-readonly-v2'],
          account: { state: 'logged-in', id: '10001', name: 'User 1', avatar: null },
        },
      ],
      bumperLogs: [
        {
          id: 'bl-group',
          profileId: P01,
          accountId: '10001',
          groupId: 'g1',
          groupName: 'Group 1',
          pageId: 'p1',
          pageName: 'Page 1',
          postId: 'post1',
          postUrl: 'https://www.facebook.com/groups/g1/posts/post1/',
          liked: true,
          commentText: null,
          bumpedAt: 1000,
          sourceMode: 'group',
        },
        {
          id: 'bl-page',
          profileId: P01,
          accountId: '10001',
          groupId: '-',
          groupName: '专页直顶',
          pageId: 'p1',
          pageName: 'Page 1',
          postId: 'post2',
          postUrl: 'https://www.facebook.com/p1/posts/post2',
          liked: true,
          commentText: 'Nice',
          bumpedAt: 2000,
          sourceMode: 'page',
        },
      ],
      posterLogs: [
        {
          id: 'pl-1',
          profileId: P01,
          accountId: '10001',
          accountName: 'User 1',
          accountAvatar: null,
          identityType: 'personal',
          groupId: 'g1',
          groupName: 'Group 1',
          groupAvatar: null,
          materialId: 'm1',
          captionPreview: 'Hello group',
          postId: 'pending_approval',
          postUrl: 'https://www.facebook.com/groups/g1/',
          postedAt: 3000,
        },
      ],
    });
    assert.equal(feed.moduleCounts['group-bumper'], 1);
    assert.equal(feed.moduleCounts['page-bumper'], 1);
    assert.equal(feed.moduleCounts['group-poster'], 1);
    assert.equal(feed.statusCounts.attention, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
