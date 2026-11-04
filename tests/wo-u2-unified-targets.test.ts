import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import { extractFacebookGroupId, extractFacebookPageId } from '../src/shared/facebook-target-id.js';

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

test('WO-U2: fresh DB (0 -> 49+) and legacy v48 -> 49 migration losslessly merge 18 groups, folders, and 3 independent counters', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-wo-u2-mig-'));
  const freshFile = path.join(dir, 'fresh.sqlite');
  const legacyFile = path.join(dir, 'legacy.sqlite');
  try {
    // 1. Fresh DB path (version 0 -> latest)
    const freshStore = await WorkspaceStore.open(freshFile);
    assert.ok(workspaceSchemaVersion >= 49);
    freshStore.close();
    const freshDb = new DatabaseSync(freshFile, { readOnly: true });
    assert.equal(
      freshDb.prepare('PRAGMA user_version').get()?.user_version,
      workspaceSchemaVersion,
    );
    assert.deepEqual(freshDb.prepare('PRAGMA foreign_key_check').all(), []);
    const droppedTables = freshDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('group_inviter_groups', 'group_bumper_groups')",
      )
      .all();
    assert.deepEqual(droppedTables, []);
    freshDb.close();

    // 2. Legacy v48 -> v49 upgrade path with 18 groups across inviter & bumper + folders "新小组" and "测试"
    let store = await WorkspaceStore.open(legacyFile);
    store.close();

    const raw = new DatabaseSync(legacyFile);
    raw.exec(`
      DROP TABLE IF EXISTS shared_facebook_groups;
      DROP TABLE IF EXISTS target_list_folders;
      CREATE TABLE target_list_folders (
        id TEXT PRIMARY KEY,
        list_kind TEXT NOT NULL CHECK(list_kind IN ('inviter_groups','bumper_groups','bumper_pages')),
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE group_inviter_groups (
        group_id TEXT PRIMARY KEY,
        group_name TEXT NOT NULL,
        avatar_url TEXT,
        total_invited_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        folder_id TEXT DEFAULT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE group_bumper_groups (
        group_id TEXT PRIMARY KEY,
        group_name TEXT NOT NULL,
        avatar_url TEXT,
        total_bumped_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        folder_id TEXT DEFAULT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
    `);

    const inviterNewFolderId = '11111111-1111-4111-8111-111111111111';
    const bumperNewFolderId = '22222222-2222-4222-8222-222222222222';
    const bumperTestFolderId = '33333333-3333-4333-8333-333333333333';
    const now = Date.now();
    raw
      .prepare(
        'INSERT INTO target_list_folders (id, list_kind, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(inviterNewFolderId, 'inviter_groups', '新小组', 0, now - 5000);
    raw
      .prepare(
        'INSERT INTO target_list_folders (id, list_kind, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(bumperNewFolderId, 'bumper_groups', '新小组', 0, now - 3000);
    raw
      .prepare(
        'INSERT INTO target_list_folders (id, list_kind, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(bumperTestFolderId, 'bumper_groups', '测试', 1, now - 2000);

    const localAvatar = 'data:image/webp;base64,' + 'A'.repeat(256);
    // Insert 18 distinct groups (1..12 in inviter, 7..18 in bumper, so 7..12 overlap)
    for (let i = 1; i <= 12; i++) {
      const gid = `10000000000000${String(i).padStart(2, '0')}`;
      raw
        .prepare(
          'INSERT INTO group_inviter_groups (group_id, group_name, avatar_url, total_invited_count, created_at, updated_at, folder_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          gid,
          i === 7 ? gid : `Inviter Group ${i}`,
          i === 8 ? localAvatar : 'https://example.com/ext.jpg',
          i,
          now - 1000,
          now - 1000,
          i <= 6 ? inviterNewFolderId : null,
          i - 1,
        );
    }
    for (let i = 7; i <= 18; i++) {
      const gid = `10000000000000${String(i).padStart(2, '0')}`;
      raw
        .prepare(
          'INSERT INTO group_bumper_groups (group_id, group_name, avatar_url, total_bumped_count, created_at, updated_at, folder_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          gid,
          `Bumper Real Name ${i}`,
          i === 7 ? localAvatar : 'https://example.com/bumper.jpg',
          i * 2,
          now - 500,
          now - 500,
          i <= 12 ? bumperNewFolderId : bumperTestFolderId,
          i - 7,
        );
    }

    // Seed real logs in the 3 log tables for group #7 (`1000000000000007`)
    const g7 = '1000000000000007';
    const pid = randomUUID();
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
         VALUES (?, ?, 'acc1', ?, 'G7', 'p1', 'Page 1', 'post1', 'https://facebook.com/1', 1, NULL, ?),
                (?, ?, 'acc1', ?, 'G7', 'p1', 'Page 1', 'post2', 'https://facebook.com/2', 1, 'hi', ?),
                (?, ?, 'acc1', ?, 'G7', 'p1', 'Page 1', 'post3', 'https://facebook.com/3', 1, NULL, ?)`,
      )
      .run(randomUUID(), pid, g7, now, randomUUID(), pid, g7, now, randomUUID(), pid, g7, now);
    raw
      .prepare(
        `INSERT INTO group_poster_logs (id, profile_id, account_id, account_name, account_avatar, identity_type, group_id, group_name, group_avatar, material_id, caption_preview, post_id, post_url, posted_at)
         VALUES (?, ?, 'acc1', 'Acc', NULL, 'personal', ?, 'G7', NULL, 'm1', 'cap1', 'p1', 'https://facebook.com/p1', ?),
                (?, ?, 'acc1', 'Acc', NULL, 'personal', ?, 'G7', NULL, 'm2', 'cap2', 'p2', 'https://facebook.com/p2', ?),
                (?, ?, 'acc1', 'Acc', NULL, 'personal', ?, 'G7', NULL, 'm3', 'cap3', 'p3', 'https://facebook.com/p3', ?),
                (?, ?, 'acc1', 'Acc', NULL, 'personal', ?, 'G7', NULL, 'm4', 'cap4', 'p4', 'https://facebook.com/p4', ?)`,
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

    raw.exec('PRAGMA user_version = 48;');
    raw.close();

    store = await WorkspaceStore.open(legacyFile);
    try {
      const folders = store.targetFolders('inviter_groups');
      assert.deepEqual(
        folders.map((f) => f.name),
        ['新小组', '测试'],
      );
      const inviterGroups = store.groupInviter.listGroups();
      const bumperGroups = store.groupBumper.targets('groups');
      const posterGroups = store.groupPoster.targets();
      assert.equal(inviterGroups.length, 18);
      assert.equal(bumperGroups.length, 18);
      assert.equal(posterGroups.length, 18);

      // Verify priority merge on group 7 and group 8
      const g7Inv = inviterGroups.find((g) => g.groupId === g7);
      const g7Bmp = bumperGroups.find((g) => g.id === g7);
      const g7Pst = posterGroups.find((g) => g.id === g7);
      assert.equal(g7Inv?.groupName, 'Bumper Real Name 7');
      assert.equal(g7Inv?.avatarUrl, localAvatar);
      assert.equal(g7Inv?.totalInvitedCount, 2);
      assert.equal(g7Bmp?.totalBumpedCount, 3);
      assert.equal(g7Pst?.totalBumpedCount, 4);

      const g8 = '1000000000000008';
      assert.equal(bumperGroups.find((g) => g.id === g8)?.avatarUrl, localAvatar);
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

    // 3. Seed logs under both old.group.slug and canonical 999888777 to test UNIQUE(group_id, friend_id) conflict resolution
    const db = new DatabaseSync(file);
    const now = Date.now();
    const pid = randomUUID();
    db.prepare(
      `INSERT INTO group_inviter_logs (id, profile_id, account_id, friend_id, friend_name, group_id, invited_at, confirmation, operation_id)
       VALUES (?, ?, 'acc1', 'friend_same', 'Same Friend', 'old.group.slug', ?, 'CONFIRMED', 'op_old'),
              (?, ?, 'acc1', 'friend_same', 'Same Friend', '999888777', ?, 'PENDING', 'op_new'),
              (?, ?, 'acc1', 'friend_only_old', 'Only Old', 'old.group.slug', ?, 'CONFIRMED', 'op_old2')`,
    ).run(randomUUID(), pid, now, randomUUID(), pid, now - 1000, randomUUID(), pid, now);
    db.prepare(
      `INSERT INTO group_bumper_logs (id, profile_id, account_id, group_id, group_name, page_id, page_name, post_id, post_url, liked, comment_text, bumped_at)
       VALUES (?, ?, 'acc1', 'old.group.slug', 'Old', 'p1', 'Page', 'post_1', 'https://facebook.com/p1', 1, NULL, ?)`,
    ).run(randomUUID(), pid, now);
    db.prepare(
      `INSERT INTO group_poster_logs (id, profile_id, account_id, account_name, account_avatar, identity_type, group_id, group_name, group_avatar, material_id, caption_preview, post_id, post_url, posted_at)
       VALUES (?, ?, 'acc1', 'Acc', NULL, 'personal', 'old.group.slug', 'Old', NULL, 'm1', 'cap', 'post1', 'https://facebook.com/post1', ?)`,
    ).run(randomUUID(), pid, now);
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
