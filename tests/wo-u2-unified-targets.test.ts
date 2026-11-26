import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import { extractFacebookGroupId, extractFacebookPageId } from '../src/shared/facebook-target-id.js';
import { seedLegacyLogTablesForV61Upgrade } from './fixtures/workspace-schema.js';

test('WO-U2: extractFacebookGroupId and extractFacebookPageId handle people/pages/profile URLs and reject reserved segments', () => {
  assert.equal(extractFacebookGroupId('1834045181273689'), '1834045181273689');
  assert.equal(
    extractFacebookGroupId('https://www.facebook.com/groups/3017439278594998/?ref=share'),
    '3017439278594998',
  );
  assert.equal(
    extractFacebookGroupId('https://www.facebook.com/groups/my.group.slug/posts/12345/'),
    'my.group.slug',
  );
  assert.equal(extractFacebookGroupId('https://www.facebook.com/groups/feed/'), '');
  assert.equal(extractFacebookGroupId('https://www.facebook.com/watch/'), '');

  // people/<Name>/<NumericId> and pages/<Name>/<NumericId> must extract the numeric ID, never "people" or "pages"
  assert.equal(
    extractFacebookPageId('https://www.facebook.com/people/Alice-Shop/61550011223344/'),
    '61550011223344',
  );
  assert.equal(
    extractFacebookPageId('https://www.facebook.com/pages/category/Brand/My-Brand/1000888999000/'),
    '1000888999000',
  );
  assert.equal(
    extractFacebookPageId('https://www.facebook.com/profile.php?id=61559988776655&sk=about'),
    '61559988776655',
  );
  assert.equal(
    extractFacebookPageId('https://www.facebook.com/MyBrandOfficial/posts/pfbid0123'),
    'MyBrandOfficial',
  );
  for (const reserved of [
    'people',
    'pages',
    'groups',
    'watch',
    'reels',
    'events',
    'marketplace',
    'gaming',
    'messages',
    'notifications',
    'bookmarks',
    'friends',
    'settings',
    'login',
    'checkpoint',
    'share',
    'sharer.php',
    'photo.php',
    'permalink.php',
    'story.php',
    'search',
    'saved',
    'professional_dashboard',
    'adsmanager',
    'business',
    'latest',
  ]) {
    assert.equal(extractFacebookPageId(`https://www.facebook.com/${reserved}/`), '');
    assert.equal(extractFacebookPageId(reserved), '');
  }
});

test('WO-U2: fresh DB (0 -> 62) and v61 -> 62 upgrade backfill legacy logs, drop legacy log tables, and preserve unified targets & counters', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-wo-u2-mig-'));
  const freshFile = path.join(dir, 'fresh.sqlite');
  const legacyFile = path.join(dir, 'legacy.sqlite');
  try {
    // 1. Fresh DB path (version 0 -> latest v62)
    const freshStore = await WorkspaceStore.open(freshFile);
    assert.ok(workspaceSchemaVersion >= 62);
    freshStore.close();
    const freshDb = new DatabaseSync(freshFile, { readOnly: true });
    assert.equal(
      freshDb.prepare('PRAGMA user_version').get()?.user_version,
      workspaceSchemaVersion,
    );
    assert.deepEqual(freshDb.prepare('PRAGMA foreign_key_check').all(), []);
    const droppedTables = freshDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('group_inviter_groups', 'group_bumper_groups', 'group_poster_logs', 'group_bumper_logs')",
      )
      .all();
    assert.deepEqual(droppedTables, []);
    freshDb.close();

    // 2. v61 -> v62 upgrade path with legacy group_bumper_logs & group_poster_logs backfilled into post_bump_records
    let store = await WorkspaceStore.open(legacyFile);
    const g7 = '1000000000000007';
    const localAvatar = 'data:image/webp;base64,' + 'A'.repeat(256);
    try {
      store.targetListCommand({ action: 'create', listKind: 'shared_groups', name: '新小组' });
      const folderId = store.targetFolders('shared_groups')[0]?.id ?? null;
      assert.ok(folderId);
      store.groupBumper.upsertTargets('groups', {
        items: [{ id: g7, name: 'Bumper Real Name 7', folderId }],
      });
      store.groupBumper.updateAvatar('groups', g7, localAvatar);
    } finally {
      store.close();
    }

    const raw = new DatabaseSync(legacyFile);
    seedLegacyLogTablesForV61Upgrade(raw);
    raw.exec('DROP TABLE IF EXISTS post_bump_records;');
    const pid = randomUUID();
    const now = Date.now();
    raw
      .prepare(
        `INSERT INTO group_inviter_logs (id, profile_id, account_id, friend_id, friend_name, group_id, invited_at, confirmation, operation_id)
         VALUES (?, ?, 'acc1', 'f1', 'Friend 1', ?, ?, 'CONFIRMED', 'op1'),
                (?, ?, 'acc1', 'f2', 'Friend 2', ?, ?, 'CONFIRMED', 'op2'),
                (?, ?, 'acc1', 'f3', 'Friend 3', ?, ?, 'PENDING', 'op3')`,
      )
      .run(randomUUID(), pid, g7, now, randomUUID(), pid, g7, now, randomUUID(), pid, g7, now);
    raw
      .prepare(
        `INSERT INTO group_bumper_logs (id, profile_id, account_id, group_id, group_name, page_id, page_name, post_id, post_url, liked, comment_text, bumped_at)
         VALUES (?, ?, 'acc1', ?, 'Bumper Real Name 7', 'p1', 'Page 1', 'post1', 'https://facebook.com/1', 1, NULL, ?),
                (?, ?, 'acc1', ?, 'Bumper Real Name 7', 'p1', 'Page 1', 'post2', 'https://facebook.com/2', 1, 'hi', ?),
                (?, ?, 'acc1', ?, 'Bumper Real Name 7', 'p1', 'Page 1', 'post3', 'https://facebook.com/3', 1, NULL, ?)`,
      )
      .run(randomUUID(), pid, g7, now, randomUUID(), pid, g7, now, randomUUID(), pid, g7, now);
    raw
      .prepare(
        `INSERT INTO group_poster_logs (id, profile_id, account_id, account_name, account_avatar, identity_type, group_id, group_name, group_avatar, material_id, caption_preview, post_id, post_url, posted_at)
         VALUES (?, ?, 'acc1', 'Acc', NULL, 'personal', ?, 'Bumper Real Name 7', NULL, 'm1', 'cap1', 'p1', 'https://facebook.com/p1', ?),
                (?, ?, 'acc1', 'Acc', NULL, 'personal', ?, 'Bumper Real Name 7', NULL, 'm2', 'cap2', 'p2', 'https://facebook.com/p2', ?),
                (?, ?, 'acc1', 'Acc', NULL, 'personal', ?, 'Bumper Real Name 7', NULL, 'm3', 'cap3', 'p3', 'https://facebook.com/p3', ?),
                (?, ?, 'acc1', 'Acc', NULL, 'personal', ?, 'Bumper Real Name 7', NULL, 'm4', 'cap4', 'p4', 'https://facebook.com/p4', ?)`,
      )
      .run(
        randomUUID(),
        pid,
        g7,
        now,
        randomUUID(),
        pid,
        g7,
        now,
        randomUUID(),
        pid,
        g7,
        now,
        randomUUID(),
        pid,
        g7,
        now,
      );
    raw.exec('PRAGMA user_version = 61;');
    raw.close();

    store = await WorkspaceStore.open(legacyFile);
    try {
      assert.equal(store.groupBumper.logs('', 20, undefined, undefined, 'group').length, 3);
      assert.equal(store.groupPoster.logs('', 20).length, 4);
      assert.equal(store.postBumpRecords.list({ limit: 20 }).total, 7);
    } finally {
      store.close();
    }
    const checkRaw = new DatabaseSync(legacyFile, { readOnly: true });
    try {
      assert.equal(
        checkRaw
          .prepare(
            "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('group_poster_logs', 'group_bumper_logs')",
          )
          .get()?.n,
        0,
      );
    } finally {
      checkRaw.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

test('WO-U2: upsert preserves existing folder_id when incoming folderId is null, and applyResolvedTargetMetadata cascades atomically across 4 tables', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-wo-u2-cascade-'));
  const file = path.join(dir, 'workspace.sqlite');
  let store = await WorkspaceStore.open(file);
  try {
    store.targetListCommand({ action: 'create', listKind: 'bumper_groups', name: '核心小组' });
    const folderId = store.targetFolders('bumper_groups')[0]?.id ?? null;
    assert.ok(folderId);

    // 1. Add group with folderId
    store.groupBumper.upsertTargets('groups', {
      items: [{ id: 'old.group.slug', name: 'Old Group Name', folderId }],
    });
    assert.equal(store.groupBumper.targets('groups')[0]?.folderId, folderId);

    // 2. Re-upsert with folderId: null -> must NOT clear existing folder_id!
    store.groupInviter.upsertGroups({
      items: [{ groupId: 'old.group.slug', groupName: 'Updated Group Name', folderId: null }],
    });
    assert.equal(store.groupBumper.targets('groups')[0]?.folderId, folderId);
    assert.equal(store.groupBumper.targets('groups')[0]?.name, 'Updated Group Name');
    store.close();

    // 3. Seed records under both old.group.slug and canonical 999888777
    const db = new DatabaseSync(file);
    const now = Date.now();
    const pid = randomUUID();
    db.prepare(
      `INSERT INTO group_inviter_logs (id, profile_id, account_id, friend_id, friend_name, group_id, invited_at, confirmation, operation_id)
       VALUES (?, ?, 'acc1', 'friend_same', 'Same Friend', 'old.group.slug', ?, 'CONFIRMED', 'op_old'),
              (?, ?, 'acc1', 'friend_same', 'Same Friend', '999888777', ?, 'PENDING', 'op_new'),
              (?, ?, 'acc1', 'friend_only_old', 'Only Old', 'old.group.slug', ?, 'CONFIRMED', 'op_old2')`,
    ).run(randomUUID(), pid, now, randomUUID(), pid, now - 1000, randomUUID(), pid, now);
    const bId = randomUUID();
    db.prepare(
      `INSERT INTO group_bumper_effects (log_id, profile_id, account_id, group_id, page_id, post_id, source_mode, liked, commented, comment_digest, applied_at, story_shared)
       VALUES (?, ?, 'acc1', 'old.group.slug', 'p1', 'post_1', 'group', 1, 0, NULL, ?, 0)`,
    ).run(bId, pid, now);
    const pId = randomUUID();
    db.prepare(
      `INSERT INTO group_poster_usage (log_id, profile_id, group_id, material_id, posted_at)
       VALUES (?, ?, 'old.group.slug', 'm1', ?)`,
    ).run(pId, pid, now);
    db.close();

    store = await WorkspaceStore.open(file);

    // 4. Resolve metadata from old.group.slug -> 999888777
    const localAvatar = 'data:image/webp;base64,' + 'C'.repeat(300);
    store.groupBumper.applyResolvedTargetMetadata('groups', 'old.group.slug', {
      canonicalId: '999888777',
      name: 'Canonical Group Name',
      avatarUrl: localAvatar,
    });

    const groups = store.groupBumper.targets('groups');
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.id, '999888777');
    assert.equal(groups[0]?.name, 'Canonical Group Name');
    assert.equal(groups[0]?.avatarUrl, localAvatar);
    assert.equal(groups[0]?.folderId, folderId);
    assert.equal(groups[0]?.totalBumpedCount, 1);
    assert.equal(store.groupInviter.listGroups()[0]?.totalInvitedCount, 2);
    assert.equal(store.groupPoster.targets()[0]?.totalBumpedCount, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
