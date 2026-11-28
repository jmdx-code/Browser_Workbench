import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import { latestMigrationBackupMarker } from './fixtures/workspace-schema.js';

function seedSimulatedV55Database(file: string) {
  const groupId = randomUUID();
  const profileId = randomUUID();
  const orphanProfileId = randomUUID();
  const comboId = randomUUID();
  const bsFolderId = randomUUID();
  const bsInstanceId = randomUUID();
  const matId = randomUUID();
  const scheduleId = randomUUID();
  const sheetLinkId = randomUUID();

  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE groups(id TEXT PRIMARY KEY,name TEXT NOT NULL COLLATE NOCASE UNIQUE,color TEXT NOT NULL,sort_order INTEGER NOT NULL);
      CREATE TABLE profile_metadata(profile_id TEXT PRIMARY KEY,group_id TEXT REFERENCES groups(id),alias TEXT, sort_order INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE profile_account_cache(profile_id TEXT PRIMARY KEY, account_state TEXT NOT NULL DEFAULT 'unknown', account_id TEXT, account_name TEXT, avatar_url TEXT, avatar_updated_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE profile_launch_bindings(profile_id TEXT PRIMARY KEY, browser_kind TEXT NOT NULL, executable_path TEXT NOT NULL, user_data_dir TEXT NOT NULL, profile_directory TEXT NOT NULL, browser_name TEXT NOT NULL, window_name TEXT NOT NULL, verified_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE combinations(id TEXT PRIMARY KEY,current_version INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,draft TEXT,updated_at INTEGER NOT NULL);
      CREATE TABLE combination_versions(combination_id TEXT NOT NULL REFERENCES combinations(id),version INTEGER NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(combination_id,version));
      CREATE TABLE resource_table_heads(combination_id TEXT PRIMARY KEY REFERENCES combinations(id),revision INTEGER NOT NULL CHECK(revision>0));
      CREATE TABLE resource_table_versions(combination_id TEXT NOT NULL REFERENCES combinations(id),revision INTEGER NOT NULL CHECK(revision>0),body TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(combination_id,revision));
      CREATE TABLE workspace_preferences(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL CHECK(revision>=0),default_time_zone TEXT,desktop_notifications TEXT NOT NULL CHECK(desktop_notifications IN ('off','failures','all')), log_retention_days INTEGER NOT NULL DEFAULT 14, window_layout TEXT);
      CREATE TABLE bluestacks_folders(id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, sort_order INTEGER NOT NULL);
      CREATE TABLE bluestacks_instances(id TEXT PRIMARY KEY, instance_key TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, alias TEXT, folder_id TEXT REFERENCES bluestacks_folders(id) ON DELETE SET NULL, sort_order INTEGER NOT NULL DEFAULT 0, adb_port INTEGER NOT NULL DEFAULT 5555, fb_width INTEGER NOT NULL DEFAULT 900, fb_height INTEGER NOT NULL DEFAULT 1600, fb_lite_installed INTEGER, account_state TEXT NOT NULL DEFAULT 'unknown', account_id TEXT NOT NULL DEFAULT '', account_name TEXT NOT NULL DEFAULT '', avatar_url TEXT, last_status TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE target_list_folders(id TEXT PRIMARY KEY, list_kind TEXT NOT NULL CHECK(list_kind IN ('shared_groups', 'bumper_pages')), name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE shared_facebook_groups(group_id TEXT PRIMARY KEY, group_name TEXT NOT NULL, avatar_url TEXT, folder_id TEXT DEFAULT NULL, sort_order INTEGER NOT NULL DEFAULT 0, invited_count INTEGER NOT NULL DEFAULT 0, bumped_count INTEGER NOT NULL DEFAULT 0, posted_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE group_bumper_pages(page_id TEXT PRIMARY KEY, page_name TEXT NOT NULL, avatar_url TEXT, total_bumped_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, folder_id TEXT DEFAULT NULL, sort_order INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE group_bumper_comments(id TEXT PRIMARY KEY, comment_text TEXT NOT NULL, used_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, scope TEXT NOT NULL DEFAULT 'group');
      CREATE TABLE group_bumper_operations(operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, profile_id TEXT NOT NULL, account_id TEXT NOT NULL, connection_epoch TEXT NOT NULL, lease_id TEXT NOT NULL, generation INTEGER NOT NULL, job_id TEXT NOT NULL, step_id TEXT NOT NULL, action_digest TEXT NOT NULL, action_kind TEXT NOT NULL CHECK(action_kind IN ('setup_navigate','submit_like','submit_comment')), group_id TEXT NOT NULL, group_name TEXT NOT NULL, page_id TEXT, page_name TEXT, post_id TEXT, post_url TEXT, comment_id TEXT, comment_text TEXT, log_id TEXT, resolution_id TEXT, resolution_outcome TEXT, evidence_digest TEXT, status TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE group_bumper_effects(log_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, account_id TEXT NOT NULL, group_id TEXT NOT NULL, page_id TEXT NOT NULL, post_id TEXT NOT NULL, source_mode TEXT NOT NULL, liked INTEGER NOT NULL, commented INTEGER NOT NULL, comment_digest TEXT, applied_at INTEGER NOT NULL);
      CREATE TABLE group_poster_materials(id TEXT PRIMARY KEY, caption TEXT NOT NULL, media_source TEXT NOT NULL DEFAULT '', background TEXT NOT NULL DEFAULT 'plain', local_file_path TEXT, media_kind TEXT NOT NULL DEFAULT 'none', cache_status TEXT NOT NULL DEFAULT 'ready', cache_error TEXT, selected INTEGER NOT NULL DEFAULT 1, used_count INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER DEFAULT NULL, thumbnail_data_url TEXT DEFAULT NULL, ai_label TEXT NOT NULL DEFAULT 'default');
      CREATE TABLE group_poster_logs(id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, account_id TEXT NOT NULL, account_name TEXT NOT NULL DEFAULT '', identity_type TEXT NOT NULL DEFAULT 'personal', group_id TEXT NOT NULL, group_name TEXT NOT NULL, material_id TEXT NOT NULL, caption_preview TEXT NOT NULL, post_id TEXT NOT NULL DEFAULT '', post_url TEXT NOT NULL DEFAULT '', posted_at INTEGER NOT NULL);
      CREATE TABLE group_bumper_logs(id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, account_id TEXT NOT NULL, group_id TEXT NOT NULL, group_name TEXT NOT NULL, page_id TEXT NOT NULL, page_name TEXT NOT NULL, post_id TEXT NOT NULL, post_url TEXT NOT NULL, liked INTEGER NOT NULL DEFAULT 0, comment_text TEXT, source_mode TEXT NOT NULL DEFAULT 'group', bumped_at INTEGER NOT NULL);
      CREATE TABLE group_inviter_logs(id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, account_id TEXT NOT NULL, friend_id TEXT NOT NULL, friend_name TEXT NOT NULL, group_id TEXT NOT NULL, invited_at INTEGER NOT NULL, confirmation TEXT NOT NULL DEFAULT 'CONFIRMED', operation_id TEXT, UNIQUE(group_id, friend_id));
      CREATE TABLE auto_scheduler_schedules(id TEXT PRIMARY KEY, sort_order INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, carrier TEXT NOT NULL, body_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE google_sheet_links(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, spreadsheet_id TEXT NOT NULL, spreadsheet_title TEXT NOT NULL DEFAULT '', sheet_id INTEGER NOT NULL DEFAULT 0, sheet_name TEXT NOT NULL, spreadsheet_url TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, config_json TEXT NOT NULL DEFAULT '{}', runtime_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE task_plans(id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, profile_id TEXT NOT NULL, combination_id TEXT NOT NULL, version INTEGER NOT NULL, account_id TEXT, snapshot TEXT NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL, control_mode TEXT, control_request_id TEXT, control_confirmed INTEGER NOT NULL DEFAULT 0, round INTEGER NOT NULL, position INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE task_outbox(id TEXT PRIMARY KEY, job_id TEXT NOT NULL, step_id TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE task_control_bindings(operation_id TEXT PRIMARY KEY, job_id TEXT NOT NULL);
      CREATE TABLE material_archive_requests(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TRIGGER new_operation_requires_active_control BEFORE INSERT ON task_outbox WHEN NOT EXISTS(SELECT 1 FROM task_control_bindings b WHERE b.operation_id=NEW.id) BEGIN SELECT RAISE(ABORT, 'ZOMBIE_TRIGGER_BLOCK'); END;
    `);

    const now = 1_795_000_000_000;
    db.exec('PRAGMA foreign_keys=OFF');
    db.prepare('INSERT INTO groups VALUES(?,?,?,?)').run(groupId, '测试组', 'blue', 0);
    db.prepare('INSERT INTO profile_metadata VALUES(?,?,?,?)').run(
      profileId,
      groupId,
      '主力号01',
      0,
    );
    db.prepare('INSERT INTO profile_metadata VALUES(?,?,?,?)').run(
      orphanProfileId,
      'missing-group-fk',
      '孤儿组号',
      1,
    );
    db.prepare('INSERT INTO profile_account_cache VALUES(?,?,?,?,?,?)').run(
      profileId,
      'logged-in',
      '1000999',
      'Alice',
      null,
      now,
    );
    db.prepare('INSERT INTO workspace_preferences VALUES(?,?,?,?,?,?)').run(
      1,
      2,
      'Asia/Shanghai',
      'failures',
      30,
      null,
    );
    db.prepare('INSERT INTO bluestacks_folders VALUES(?,?,?)').run(bsFolderId, 'BS组1', 0);
    db.prepare(
      'INSERT INTO bluestacks_instances(id, instance_key, display_name, alias, folder_id, sort_order, adb_port, fb_width, fb_height, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ).run(bsInstanceId, 'Pie64_1', 'BlueStacks 1', '安卓01', bsFolderId, 0, 5555, 900, 1600, now);

    const comboBody = JSON.stringify({
      name: 'v243保留组合',
      note: '测试过渡',
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 5, maxLikes: 1, minLikeCount: 0 }],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    db.prepare('INSERT INTO combinations VALUES(?,?,?,?,?)').run(comboId, 1, 1, null, now);
    db.prepare('INSERT INTO combination_versions VALUES(?,?,?,?)').run(comboId, 1, comboBody, now);
    db.prepare('INSERT INTO resource_table_heads VALUES(?,?)').run(comboId, 1);
    db.prepare('INSERT INTO resource_table_versions VALUES(?,?,?,?)').run(
      comboId,
      1,
      JSON.stringify([]),
      now,
    );

    db.prepare(
      'INSERT INTO shared_facebook_groups(group_id, group_name, sort_order, created_at, updated_at) VALUES(?,?,?,?,?)',
    ).run('9001', '保留小组', 0, now, now);
    db.prepare(
      'INSERT INTO group_bumper_pages(page_id, page_name, sort_order, created_at, updated_at) VALUES(?,?,?,?,?)',
    ).run('8001', '保留专页', 0, now, now);
    db.prepare('INSERT INTO group_bumper_comments VALUES(?,?,?,?,?)').run(
      randomUUID(),
      'Nice post!',
      1,
      now,
      'group',
    );
    db.prepare('INSERT INTO group_bumper_comments VALUES(?,?,?,?,?)').run(
      randomUUID(),
      'Invalid scope row',
      0,
      now,
      'bad',
    );
    db.prepare(
      'INSERT INTO group_poster_materials(id, caption, sort_order, created_at, updated_at) VALUES(?,?,?,?,?)',
    ).run(matId, '保留发帖素材', 0, now, now);
    db.prepare('INSERT INTO group_poster_logs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'post-log-1',
      profileId,
      '1000999',
      'Alice',
      'personal',
      '9001',
      '保留小组',
      matId,
      '保留发帖素材',
      'p123',
      'https://fb.com/p123',
      now,
    );
    db.prepare('INSERT INTO group_bumper_logs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'bump-log-1',
      profileId,
      '1000999',
      '-',
      '-',
      '8001',
      '保留专页',
      'bp456',
      'https://fb.com/bp456',
      1,
      '顶一下',
      'page',
      now + 1000,
    );
    db.prepare('INSERT INTO group_inviter_logs VALUES(?,?,?,?,?,?,?,?,?)').run(
      randomUUID(),
      profileId,
      '1000999',
      'friend-1',
      'Bob',
      '9001',
      now,
      'CONFIRMED',
      null,
    );

    const scheduleBody = JSON.stringify({
      id: scheduleId,
      name: 'v243定时排班',
      enabled: true,
      carrier: 'browser',
      targetSelector: {
        mode: 'explicit',
        groupIds: [],
        targetIds: [profileId],
        skipAbnormalAccounts: true,
      },
      trigger: {
        mode: 'weekly',
        onceAt: null,
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        times: ['09:00'],
        timeZone: 'Asia/Shanghai',
        jitterMinutes: 0,
        misfireGraceMinutes: 120,
      },
      steps: [{ id: randomUUID(), type: 'active-combination', combinationId: comboId }],
      prewarm: { enabled: false, leadMinutes: 90, steps: [] },
      closeWindowOnFinish: true,
      maxSafetyMinutesPerTarget: null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    db.prepare('INSERT INTO auto_scheduler_schedules VALUES(?,?,?,?,?,?,?)').run(
      scheduleId,
      0,
      1,
      'browser',
      scheduleBody,
      now,
      now,
    );
    db.prepare(
      'INSERT INTO google_sheet_links(id, kind, title, spreadsheet_id, sheet_name, created_at, updated_at) VALUES(?,?,?,?,?,?,?)',
    ).run(sheetLinkId, 'group_library', '云表小组库', 'sheet-1234567890', 'Sheet1', now, now);

    db.exec('PRAGMA user_version=55');
  } finally {
    db.close();
  }

  return {
    groupId,
    profileId,
    orphanProfileId,
    comboId,
    bsFolderId,
    bsInstanceId,
    matId,
    scheduleId,
    sheetLinkId,
  };
}

test('v55 (v0.1.243) legacy database rebuilds cleanly to v62 while migrating core assets and dropping legacy execution tables', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-v55-rebuild-'));
  const file = path.join(dir, 'workspace.sqlite');
  try {
    const seeded = seedSimulatedV55Database(file);

    const store = await WorkspaceStore.open(file);
    try {
      assert.equal(store.groups()[0]?.name, '测试组');
      assert.equal(store.profileMetadata().get(seeded.profileId)?.alias, '主力号01');
      assert.equal(store.profileMetadata().get(seeded.profileId)?.groupId, seeded.groupId);
      assert.equal(store.profileMetadata().get(seeded.orphanProfileId)?.groupId, null);
      assert.equal(store.combinations()[0]?.saved?.name, 'v243保留组合');
      assert.equal(store.bluestacks.folders()[0]?.name, 'BS组1');
      assert.equal(store.bluestacks.listInstances()[0]?.alias, '安卓01');
      assert.equal(store.groupBumper.targets('groups')[0]?.id, '9001');
      assert.equal(store.groupBumper.targets('pages')[0]?.id, '8001');
      assert.equal(store.groupBumper.comments('group').length, 1);
      assert.equal(store.groupBumper.comments('group')[0]?.text, 'Nice post!');
      assert.equal(store.groupPoster.materials()[0]?.caption, '保留发帖素材');
      assert.equal(store.groupPoster.hasGroupPostedMaterial('9001', seeded.matId), true);
      assert.equal(store.groupInviter.listLogs({ limit: 10 }).length, 1);
      assert.equal(store.autoScheduler.listSchedules()[0]?.name, 'v243定时排班');
      assert.equal(store.googleSheets.listLinks()[0]?.title, '云表小组库');
      assert.equal(store.postBumpRecords.list({ limit: 10 }).total, 2);

      // Verify upgraded v62 CHECK constraints allow submit_story_share without error
      const op = store.groupBumper.prepareOperation({
        binding: {
          operationId: randomUUID(),
          profileId: seeded.profileId,
          accountId: '1000999',
          connectionEpoch: randomUUID(),
          leaseId: randomUUID(),
          generation: 1,
          jobId: randomUUID(),
          stepId: randomUUID(),
          actionDigest: 'a'.repeat(64),
        },
        runId: randomUUID(),
        actionKind: 'submit_story_share',
        groupId: '-',
        groupName: '-',
        pageId: '8001',
        pageName: '保留专页',
        postId: 'bp456',
        postUrl: 'https://fb.com/bp456',
        commentId: null,
        commentText: null,
        logId: null,
        resolution: null,
        status: 'PREPARED',
        reason: '',
      });
      assert.equal(op.actionKind, 'submit_story_share');

      // Verify close_browser_on_finish works cleanly on new batches
      const plans = await store.tasks.assign(
        {
          requestId: randomUUID(),
          combinationId: seeded.comboId,
          version: 1,
          profileIds: [seeded.profileId],
          closeBrowserOnFinish: true,
        },
        [
          {
            id: seeded.profileId,
            online: true,
            synced: true,
            unresolved: 0,
            dispatchAllowed: true,
            account: { state: 'logged-in', id: '1000999', name: 'Alice', avatar: null },
          },
        ],
      );
      assert.equal(plans[0]?.closeBrowserOnFinish, true);
    } finally {
      store.close();
    }

    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, workspaceSchemaVersion);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      for (const zombieTable of [
        'task_control_bindings',
        'material_archive_requests',
        'group_poster_logs',
        'group_bumper_logs',
      ]) {
        assert.equal(
          db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(zombieTable),
          undefined,
          `${zombieTable} must be removed`,
        );
      }
      assert.equal(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='new_operation_requires_active_control'",
          )
          .get(),
        undefined,
      );
      assert.equal(db.prepare('SELECT count(*) n FROM task_plans').get()?.n, 1);
    } finally {
      db.close();
    }

    assert.ok((await readdir(dir)).some((name) => name.includes(latestMigrationBackupMarker)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
