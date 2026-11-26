import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import { FeatureExecutionRegistry } from '../src/application/feature-execution-registry.js';
import {
  formatPostBumpRecordsAsTsv,
  UNIFIED_POST_BUMP_11_HEADERS,
} from '../src/shared/log-table-copy.js';
import { formatPostBumpRecordSummary } from '../src/shared/post-bump-records.js';
import { seedLegacyLogTablesForV61Upgrade } from './fixtures/workspace-schema.js';

test('v61->v62 upgrade backfills poster & bumper logs across carriers, retires legacy log tables, tracks failures, todayStats, delete and 11-col TSV', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-post-bump-records-'));
  const file = path.join(dir, 'workspace.sqlite');
  let store: WorkspaceStore | undefined;
  try {
    store = await WorkspaceStore.open(file);
    assert.ok(workspaceSchemaVersion >= 62);
    const pId = randomUUID();
    const bsId = randomUUID();
    const now = Date.now();
    store.close();
    store = undefined;

    // Seed legacy log tables on a v61 DB and reopen -> runs v61->v62 migration
    const db = new DatabaseSync(file);
    seedLegacyLogTablesForV61Upgrade(db);
    db.exec('DROP TABLE IF EXISTS post_bump_records; PRAGMA user_version=61;');
    db.prepare(
      `INSERT INTO bluestacks_instances(id, instance_key, display_name, account_id, account_name, updated_at)
       VALUES(?, ?, ?, ?, ?, ?)`,
    ).run(bsId, 'Pie64_1', '蓝蝶01', '10002', 'BlueStacks Page', now);
    db.prepare(
      `INSERT INTO group_poster_logs(
         id, profile_id, account_id, account_name, identity_type, group_id, group_name,
         material_id, caption_preview, post_id, post_url, posted_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'post-legacy-1',
      pId,
      '10001',
      'Chrome User',
      'personal',
      '20001',
      'Tech Group',
      'mat-1',
      'Hello Group!',
      '9001',
      'https://www.facebook.com/groups/20001/posts/9001',
      now - 1000,
    );
    db.prepare(
      `INSERT INTO group_bumper_logs(
         id, profile_id, account_id, group_id, group_name, page_id, page_name,
         post_id, post_url, liked, comment_text, bumped_at, source_mode, story_shared
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'bump-legacy-bs-1',
      bsId,
      '10002',
      '-',
      '-',
      '30001',
      'Brand Page',
      '9002',
      'https://www.facebook.com/30001/posts/9002',
      1,
      'Nice post!',
      now - 500,
      'page',
      0,
    );
    db.close();

    // Reopen -> runs Migration 59 automatically
    store = await WorkspaceStore.open(file);
    const listAll = store.postBumpRecords.list({ limit: 50 });
    assert.equal(listAll.total, 2);
    const migratedPageBump = listAll.records.find((r) => r.sourceLogId === 'bump-legacy-bs-1');
    assert.equal(migratedPageBump?.recordType, 'page_bump');
    assert.equal(migratedPageBump?.carrier, 'bluestacks');
    assert.equal(migratedPageBump?.accountName, 'BlueStacks Page');
    assert.equal(migratedPageBump?.groupName, '');
    const migratedPost = listAll.records.find((r) => r.sourceLogId === 'post-legacy-1');
    assert.equal(migratedPost?.recordType, 'post');
    assert.equal(migratedPost?.carrier, 'browser');

    // Live dual-write via groupPoster.recordPost & groupBumper.record & bluestacks.recordBump
    const matId = randomUUID();
    store.groupPoster.saveMaterials({
      items: [
        {
          id: matId,
          caption: 'New Caption',
          mediaSource: '',
          background: 'plain',
          aiLabel: 'default',
        },
      ],
    });
    const okPost = store.groupPoster.recordPost({
      id: randomUUID(),
      profileId: pId,
      accountId: '10001',
      accountName: 'Chrome User',
      accountAvatar: null,
      identityType: 'personal',
      groupId: '20002',
      groupName: 'Second Group',
      groupAvatar: null,
      materialId: matId,
      captionPreview: 'New Caption',
      postId: '9003',
      postUrl: 'https://www.facebook.com/groups/20002/posts/9003',
      postedAt: now,
    });
    assert.equal(okPost, true);

    const okGroupBump = store.groupBumper.record({
      id: randomUUID(),
      profileId: pId,
      accountId: '10001',
      groupId: '20003',
      groupName: 'Bump Group',
      pageId: '30003',
      pageName: 'Target Page',
      postId: '9004',
      postUrl: 'https://www.facebook.com/groups/20003/posts/9004',
      liked: true,
      commentText: 'Up!',
      bumpedAt: now + 10,
      sourceMode: 'group',
      storyShared: true,
    });
    assert.equal(okGroupBump, true);

    // Record an explicit failed attempt
    store.postBumpRecords.insert({
      recordType: 'post',
      carrier: 'browser',
      status: 'failed',
      profileId: pId,
      accountId: '10001',
      accountName: 'Chrome User',
      groupId: '20004',
      groupName: 'Restricted Group',
      errorReason: '账号需要手机验证',
      createdAt: now + 20,
    });

    const stats = store.postBumpRecords.todayStats(now + 30);
    assert.equal(stats.posts, 2);
    assert.equal(stats.groupBumps, 1);
    assert.equal(stats.pageBumps, 1);
    assert.equal(stats.bumps, 2);
    assert.equal(stats.failures, 1);

    const failedOnly = store.postBumpRecords.list({ status: 'failed' });
    assert.equal(failedOnly.total, 1);
    assert.equal(failedOnly.records[0]?.errorReason, '账号需要手机验证');

    // 11-column TSV output check
    const allNow = store.postBumpRecords.list({ limit: 50 });
    const { tsv, count } = formatPostBumpRecordsAsTsv(allNow.records);
    assert.equal(count, 5);
    const lines = tsv.split('\n');
    assert.equal(lines[0]?.split('\t').length, UNIFIED_POST_BUMP_11_HEADERS.length);
    assert.equal(lines[0]?.split('\t').length, 11);

    // Delete single record
    const firstId = allNow.records[0]?.id;
    assert.ok(firstId);
    const delRes = store.postBumpRecords.deleteByIds([firstId]);
    assert.equal(delRes.deleted, 1);
    assert.equal(store.postBumpRecords.list({ limit: 50 }).total, 4);

    // Stage 3 M3 tests: bump_all, 7-day dailyStats, sentinel sanitization, profile_launch_bindings fallback, bi-directional delete
    const bumpAll = store.postBumpRecords.list({ recordType: 'bump_all' });
    assert.equal(bumpAll.total, 2);
    assert.equal(bumpAll.dailyStats?.length, 7);

    const pid2 = randomUUID();
    store.upsertProfileLaunchBindings([
      {
        profileId: pid2,
        browserKind: 'chrome',
        executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
        userDataDir: 'C:/Users/jj/AppData/Local/Google/Chrome/User Data',
        profileDirectory: 'Profile 9',
        browserName: 'Fallback Browser 9',
        windowName: 'Chrome',
        verifiedAt: now,
      },
    ]);
    const sanitized = store.postBumpRecords.insert({
      recordType: 'post',
      carrier: 'browser',
      status: 'failed',
      profileId: pid2,
      accountId: '',
      accountName: '-',
      groupId: '__page_timeline__',
      groupName: '-',
      pageId: '-',
      pageName: '-',
      postId: 'pending_approval',
      errorReason: '发送未确认',
      createdAt: now + 40,
    });
    assert.equal(sanitized.accountName, 'Fallback Browser 9');
    assert.equal(sanitized.groupId, '');
    assert.equal(sanitized.groupName, '');
    assert.equal(sanitized.pageId, '');
    assert.equal(sanitized.pageName, '');
    assert.equal(
      formatPostBumpRecordSummary({ ...sanitized, status: 'success', captionPreview: '测试审核' }),
      '已发帖（待审核） · 测试审核',
    );

    // Sync via groupPoster & verify bi-directional delete removes poster log while preserving group_poster_usage
    const linkedLogId = randomUUID();
    store.groupPoster.recordPost({
      id: linkedLogId,
      profileId: pid2,
      accountId: '998877',
      accountName: 'Page Identity 9',
      accountAvatar: null,
      identityType: 'page',
      groupId: '30099',
      groupName: 'Test Group 30099',
      groupAvatar: null,
      materialId: 'mat-bi-del',
      postId: 'pending-12345',
      postUrl: 'https://www.facebook.com/groups/30099/posts/12345/',
      captionPreview: '双向联动删除测试',
      postedAt: now + 50,
    });
    const linkedList = store.postBumpRecords.list({ search: '30099' });
    assert.equal(linkedList.total, 1);
    const linkedRecord = linkedList.records[0];
    assert.ok(linkedRecord);
    assert.equal(linkedRecord.sourceLogId, linkedLogId);
    assert.equal(formatPostBumpRecordSummary(linkedRecord), '已发帖（待审核） · 双向联动删除测试');
    store.postBumpRecords.deleteByIds([linkedRecord.id]);
    assert.equal(
      store.groupPoster.logs().some((l) => l.id === linkedLogId),
      false,
    );
    assert.equal(store.groupPoster.hasGroupPostedMaterial('30099', 'mat-bi-del'), true);

    // Verify statusCounts totals (confirmed vs pending vs failed) across full query
    store.postBumpRecords.insert({
      recordType: 'post',
      carrier: 'browser',
      status: 'success',
      profileId: pid2,
      accountId: '998877',
      accountName: 'Page Identity 9',
      groupId: '30098',
      groupName: 'Group 30098',
      postId: 'pending-count-test',
      captionPreview: 'Pending item',
      createdAt: now + 60,
    });
    const fullAfter = store.postBumpRecords.list({});
    assert.ok(fullAfter.statusCounts);
    assert.equal(fullAfter.statusCounts.total, fullAfter.total);
    assert.ok(fullAfter.statusCounts.pending >= 1);
    assert.ok(fullAfter.statusCounts.failed >= 1);
    assert.equal(
      fullAfter.statusCounts.confirmed +
        fullAfter.statusCounts.pending +
        fullAfter.statusCounts.failed,
      fullAfter.statusCounts.total,
    );
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('FeatureExecutionRegistry.activeModuleIds returns active module IDs and respects excludeModuleId', async () => {
  const registry = new FeatureExecutionRegistry();
  registry.register({
    id: 'group-poster',
    label: '小组发帖',
    isProfileRunning: () => false,
    hasActiveExecution: () => true,
  });
  registry.register({
    id: 'group-bumper',
    label: '小组顶贴',
    isProfileRunning: () => false,
    hasActiveExecution: () => false,
  });
  registry.register({
    id: 'bluestacks',
    label: '蓝蝶任务',
    isProfileRunning: () => false,
    hasActiveExecution: () => true,
  });

  assert.deepEqual(await registry.activeModuleIds(), ['group-poster', 'bluestacks']);
  assert.deepEqual(await registry.activeModuleIds('group-poster'), ['bluestacks']);
});
