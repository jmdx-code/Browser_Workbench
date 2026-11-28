import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import { GroupBumperService, type BumperRunner } from '../src/application/group-bumper-service.js';
import { GroupInviterService } from '../src/application/group-inviter-service.js';
import { GroupPosterService } from '../src/application/group-poster-service.js';
import { BumperSettings } from '../src/shared/group-bumper.js';
import { PosterSettings } from '../src/shared/group-poster.js';
import { isUuidLike, normalizeRecordAccountId } from '../src/shared/activity-stats.js';
import {
  isExpiredFbCdnUrl,
  loadKnownAvatarSets,
  readRecordAvatar,
} from '../src/infrastructure/record-avatar-store.js';

const uid = () => randomUUID();

function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-records-v63-'));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {}
    });
}

test('v62 -> v63 migration creates activity stats & browser risk limits tables and idempotently backfills historical steps & BS actions', async () =>
  withTempDir(async (dir) => {
    const dbPath = path.join(dir, 'v62-legacy.sqlite');
    const store1 = await WorkspaceStore.open(dbPath);
    const p1 = uid();
    const bs1 = uid();
    store1.ensureProfileOrders([p1]);
    store1.updateProfileAccountCache(p1, {
      id: '1000991',
      name: 'Chrome User 1',
      state: 'logged-in',
      avatar: null,
    });
    const combo = store1.createCombination({
      name: '养号测试',
      note: '',
      steps: [{ id: uid(), type: 'feed', durationMinutes: 5, maxLikes: 3, minLikeCount: 0 }],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    const [plan] = store1.tasks.assign(
      { requestId: uid(), combinationId: combo.id, version: combo.version, profileIds: [p1] },
      [
        {
          id: p1,
          online: true,
          synced: true,
          unresolved: 0,
          dispatchAllowed: true,
          account: { state: 'logged-in', id: '1000991', name: 'Chrome User 1', avatar: null },
        },
      ],
    );
    assert.ok(plan);
    store1.tasks.claimPlanForProfile(p1, '1000991');
    const step = store1.tasks.currentStepForPlan(plan.id, 1, 0);
    assert.ok(step);
    store1.tasks.completeStepDirect(plan.id, step.id, {
      revision: step.progress.revision,
      effectiveMilliseconds: 185_000,
      likes: 3,
      published: 0,
      cursor: null,
    });
    await store1.close();

    // Simulate pre-v63 database state
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      DELETE FROM account_daily_activity_stats;
      DROP TABLE account_daily_activity_stats;
      DROP TABLE browser_risk_limit_settings;
      INSERT OR REPLACE INTO bluestacks_instances(
        id, instance_key, display_name, alias, adb_port, fb_width, fb_height,
        account_id, numeric_account_id, account_name, account_state, folder_id, sort_order, updated_at
      ) VALUES('${bs1}', 'Nougat32', 'BlueStacks App Player', '蓝蝶01', 5555, 540, 960, '2000992', '2000992', 'BS Account', 'logged-in', NULL, 0, 1000);
      INSERT INTO bluestacks_daily_actions(ymd, instance_id, active_likes, active_actions, updated_at)
      VALUES('2026-11-26', '${bs1}', 7, 9, 1700000000000);
      PRAGMA user_version = 62;
    `);
    raw.close();

    const store2 = await WorkspaceStore.open(dbPath);
    try {
      const checkDb = new DatabaseSync(dbPath, { readOnly: true });
      const ver = (checkDb.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version;
      assert.equal(ver, workspaceSchemaVersion);
      assert.equal(workspaceSchemaVersion, 64);
      assert.equal(checkDb.prepare('PRAGMA foreign_key_check').all().length, 0);
      checkDb.close();

      const stats = store2.activityStats.queryStats({ carrier: 'all', groupBy: 'profile' });
      const chromeRow = stats.rows.find((r) => r.profileId === p1);
      const bsRow = stats.rows.find((r) => r.profileId === bs1);
      assert.ok(chromeRow);
      assert.equal(chromeRow.activeDurationMs, 185_000);
      assert.equal(chromeRow.activeLikes, 3);
      assert.ok(bsRow);
      assert.equal(bsRow.activeLikes, 7);
    } finally {
      await store2.close();
    }
  }));

test('SqliteActivityStatsRepository enforces alias priority, groupBy account, AND filters, and 5-cap browser risk limits', async () => {
  const store = await WorkspaceStore.open(':memory:');
  try {
    const p1 = uid();
    const p2 = uid();
    const sharedAccId = '1000555888';
    store.ensureProfileOrders([p1, p2]);
    store.upsertProfileLaunchBindings([
      {
        profileId: p1,
        browserKind: 'chrome',
        executablePath: 'C:/chrome.exe',
        userDataDir: 'C:/ud',
        profileDirectory: 'Profile 1',
        browserName: 'Default Browser Name',
        windowName: 'Chrome',
        verifiedAt: Date.now(),
      },
    ]);
    store.renameProfile(p1, '自定义别名窗口1');
    store.renameProfile(p2, '窗口2');
    store.updateProfileAccountCache(p1, {
      id: sharedAccId,
      name: 'Shared FB User',
      state: 'logged-in',
      avatar: null,
    });
    store.updateProfileAccountCache(p2, {
      id: sharedAccId,
      name: 'Shared FB User',
      state: 'logged-in',
      avatar: null,
    });

    const now = Date.now();
    store.activityStats.recordDailyActivity({
      carrier: 'browser',
      profileId: p1,
      accountId: sharedAccId,
      durationMsDelta: 120_000,
      likesDelta: 2,
      friendsDelta: 1,
      at: now,
    });
    store.activityStats.recordDailyActivity({
      carrier: 'browser',
      profileId: p2,
      accountId: sharedAccId,
      durationMsDelta: 60_000,
      likesDelta: 1,
      friendsDelta: 0,
      at: now,
    });

    const byProfile = store.activityStats.queryStats({ groupBy: 'profile', carrier: 'browser' });
    const row1 = byProfile.rows.find((r) => r.profileId === p1);
    assert.ok(row1);
    assert.equal(row1.windowName, '自定义别名窗口1');
    assert.equal(row1.activeDurationMs, 120_000);
    assert.equal(row1.activeLikes, 2);
    assert.equal(row1.activeFriends, 1);

    const byAccount = store.activityStats.queryStats({ groupBy: 'account', carrier: 'browser' });
    const mergedAcc = byAccount.rows.find((r) => r.accountId === sharedAccId);
    assert.ok(mergedAcc);
    assert.equal(mergedAcc.activeDurationMs, 180_000);
    assert.equal(mergedAcc.activeLikes, 3);
    assert.equal(mergedAcc.activeFriends, 1);

    // 5-cap browser risk limits + per-target override
    store.activityStats.saveBrowserRiskLimits({
      enabled: true,
      dailyMaxTotalActions: 10,
      dailyMaxBumps: 5,
      dailyMaxPosts: 2,
      dailyMaxInvites: 4,
      dailyMaxActiveLikes: 2,
      perTargetOverrides: {
        [p2]: { dailyMaxActiveLikes: 5 },
      },
    });
    const capP1 = store.activityStats.checkBrowserRiskLimit(p1, 'active-like', now);
    assert.equal(capP1.allowed, false);
    assert.match(capP1.reason ?? '', /活跃点赞日限额/);
    const capP2 = store.activityStats.checkBrowserRiskLimit(p2, 'active-like', now);
    assert.equal(capP2.allowed, true);
  } finally {
    store.close();
  }
});

test('Single-ledger deletion removes dedup usage/effects/logs across posts, bumps, and invites and syncs counts; AND accountQuery ignores target page_name on bumps', async () => {
  const store = await WorkspaceStore.open(':memory:');
  try {
    const p1 = uid();
    store.ensureProfileOrders([p1]);
    store.updateProfileAccountCache(p1, {
      id: '1000111',
      name: 'Poster Account',
      state: 'logged-in',
      avatar: null,
    });
    store.groupBumper.upsertTargets('groups', {
      items: [{ id: '90001', name: 'Group Alpha' }],
    });
    store.groupBumper.upsertTargets('pages', {
      items: [{ id: '80001', name: 'Target Page SpecialName' }],
    });
    const [mat] = store.groupPoster.saveMaterials({
      items: [{ caption: 'Test post body', mediaSource: '' }],
    });
    assert.ok(mat);

    const postLogId = uid();
    store.groupPoster.recordPost({
      id: postLogId,
      profileId: p1,
      accountId: '1000111',
      accountName: 'Poster Account',
      accountAvatar: null,
      identityType: 'personal',
      groupId: '90001',
      groupName: 'Group Alpha',
      groupAvatar: null,
      materialId: mat.id,
      postId: '90001123456',
      postUrl: 'https://www.facebook.com/groups/90001/posts/90001123456/',
      captionPreview: 'Test post body',
      postedAt: Date.now(),
    });
    assert.equal(store.groupPoster.hasGroupPostedMaterial('90001', mat.id), true);

    const bumpLogId = uid();
    store.groupBumper.record({
      id: bumpLogId,
      profileId: p1,
      accountId: '1000111',
      groupId: '90001',
      groupName: 'Group Alpha',
      pageId: '80001',
      pageName: 'Target Page SpecialName',
      postId: '90001123456',
      postUrl: 'https://www.facebook.com/groups/90001/posts/90001123456/',
      liked: true,
      commentText: 'Up!',
      bumpedAt: Date.now(),
      sourceMode: 'group',
    });

    store.groupInviter.recordInvites([
      {
        profileId: p1,
        accountId: '1000111',
        friendId: '50001',
        friendName: 'Friend One',
        groupId: '90001',
        invitedAt: Date.now(),
      },
    ]);

    // Verify accountQuery on bump records does NOT falsely match target pageName!
    const bumpWrongAcc = store.postBumpRecords.list({
      recordType: 'bump_all',
      accountQuery: 'SpecialName',
    });
    assert.equal(bumpWrongAcc.total, 0);
    const bumpRightPage = store.postBumpRecords.list({
      recordType: 'bump_all',
      pageQuery: 'SpecialName',
      groupQuery: '90001',
    });
    assert.equal(bumpRightPage.total, 1);

    // Delete post record -> single ledger cleans group_poster_usage & resets counts
    const postRec = store.postBumpRecords.list({ recordType: 'post' }).records[0];
    assert.ok(postRec);
    store.postBumpRecords.deleteByIds([postRec.id]);
    assert.equal(store.groupPoster.hasGroupPostedMaterial('90001', mat.id), false);
    assert.equal(store.groupPoster.logs().length, 0);
    assert.equal(store.groupPoster.materials()[0]?.usedCount, 0);

    // Clear bump records -> cleans group_bumper_effects + group_bumper_logs & resets counts
    store.postBumpRecords.clear('bump_all');
    assert.equal(store.groupBumper.logs().length, 0);
    assert.equal(store.groupBumper.targets('pages')[0]?.totalBumpedCount, 0);

    // Inviter enriched query + single-ledger delete -> resets invitedCount
    const invList = store.groupInviter.queryEnrichedLogs({
      accountQuery: 'Poster Account',
      groupQuery: 'Group Alpha',
      friendQuery: 'Friend One',
    });
    assert.equal(invList.total, 1);
    const invRowId = invList.records[0]?.id;
    assert.ok(invRowId);
    store.groupInviter.deleteLogs({ ids: [invRowId] });
    assert.equal(store.groupInviter.queryEnrichedLogs().total, 0);
    assert.equal(store.groupInviter.listGroups()[0]?.totalInvitedCount, 0);
  } finally {
    store.close();
  }
});

test('Chrome soft daily risk limits skip profile cleanly across Bumper, Poster, Inviter without marking restricted', async () => {
  const p1 = uid();

  // 1. Bumper skips cleanly without calling runner.run or setting restricted
  let bumperRan = false;
  const bumperSvc = new GroupBumperService(
    {
      settings: () => BumperSettings.parse({}),
      saveSettings: (s) => BumperSettings.parse(s),
      targets: (k) =>
        k === 'groups'
          ? [
              {
                id: '90001',
                name: 'G1',
                avatarUrl: null,
                folderId: null,
                sortOrder: 0,
                totalBumpedCount: 0,
                createdAt: 1,
                updatedAt: 1,
              },
            ]
          : [
              {
                id: '80001',
                name: 'P1',
                avatarUrl: null,
                folderId: null,
                sortOrder: 0,
                totalBumpedCount: 0,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
      upsertTargets: () => [],
      deleteTargets: () => 0,
      saveComments: () => [],
      logs: () => [],
      deleteLogs: () => 0,
      todayCounts: () => ({}),
    },
    {
      ready: () => true,
      busy: async () => false,
      run: async () => {
        bumperRan = true;
      },
      stop: async () => {},
    } as BumperRunner,
    async () => ({ comments: [], total: 0 }),
  );
  bumperSvc.setCheckDailyRiskLimit(async () => ({
    allowed: false,
    reason: '今日已达浏览器顶贴日限额 (30/30)，自动跳过保护',
  }));
  const bumpStep = await bumperSvc.runScheduledProfileStep({
    profileId: p1,
    mode: 'group-bumper',
    groupIds: ['90001'],
    pageIds: ['80001'],
    minConcurrency: 1,
    onProgress: () => {},
  });
  assert.equal(bumperRan, false);
  assert.equal(bumpStep.hardBlocked, false);
  assert.match(bumpStep.status, /日限额/);

  // 2. Poster skips cleanly without restricted = true
  let posterRan = false;
  const posterSvc = new GroupPosterService(
    {
      settings: () => PosterSettings.parse({}),
      saveSettings: (s) => PosterSettings.parse(s),
      targets: () => [
        {
          id: '90001',
          name: 'G1',
          avatarUrl: null,
          folderId: null,
          sortOrder: 0,
          totalBumpedCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      upsertTargets: () => [],
      deleteTargets: () => 0,
      materials: () => [
        {
          id: 'mat-1',
          caption: 'hello',
          mediaSource: '',
          mediaKind: 'none',
          background: 'plain',
          selected: true,
          sortOrder: 0,
          localFilePath: null,
          cacheStatus: 'ready',
          cacheError: null,
          usedCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      saveMaterials: () => [],
      deleteMaterials: () => 0,
      updateMaterialCache: () => {},
      hasGroupPostedMaterial: () => false,
      recordPost: () => true,
      logs: () => [],
      deleteLogs: () => 0,
      total: () => 0,
      todayCounts: () => ({}),
    },
    {
      ready: () => true,
      busy: async () => false,
      runProfileWorker: async () => {
        posterRan = true;
      },
      stop: async () => {},
    },
    { prepare: async () => ({ localFilePath: '', mediaKind: 'none' }) },
  );
  posterSvc.setCheckDailyRiskLimit(async () => ({
    allowed: false,
    reason: '今日已达浏览器发帖日限额 (10/10)，自动跳过保护',
  }));
  const postStep = await posterSvc.runScheduledProfileStep({
    profileId: p1,
    materialIds: ['mat-1'],
    groupIds: ['90001'],
    maxGroupsPerProfile: 2,
    onProgress: () => {},
  });
  assert.equal(posterRan, false);
  assert.equal(postStep.hardBlocked, false);
  assert.equal((await posterSvc.state()).profileCounts[p1]?.restricted ?? false, false);

  // 3. Inviter skips cleanly without failing profile
  let inviterRan = false;
  const inviterSvc = new GroupInviterService(
    {
      listGroups: () => [
        {
          groupId: '90001',
          groupName: 'G1',
          avatarUrl: null,
          folderId: null,
          sortOrder: 0,
          totalInvitedCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      upsertGroups: () => [],
      deleteGroups: () => 0,
      getSettings: () => ({
        invitesPerGroup: 5,
        maxConcurrentProfiles: 4,
        playSoundOnComplete: false,
      }),
      saveSettings: () => ({
        invitesPerGroup: 5,
        maxConcurrentProfiles: 4,
        playSoundOnComplete: false,
      }),
      getInvitedFriendIdsForGroup: () => new Set(),
      recordInvites: () => 0,
      getTotalInvitedByProfile: () => new Map(),
      listLogs: () => [],
    },
    {
      isAvailable: () => true,
      isProfileReady: () => true,
      inviteForGroup: async () => {
        inviterRan = true;
      },
    },
  );
  inviterSvc.setCheckDailyRiskLimit(async () => ({
    allowed: false,
    reason: '今日已达浏览器邀人日限额 (20/20)，自动跳过保护',
  }));
  const invStep = await inviterSvc.runScheduledProfileStep({
    profileId: p1,
    groupIds: ['90001'],
    invitesPerGroup: 5,
    onProgress: () => {},
  });
  assert.equal(inviterRan, false);
  assert.equal(invStep.hardBlocked, false);
  assert.match(invStep.status, /日限额/);
});

test('isExpiredFbCdnUrl, normalizeRecordAccountId, and isUuidLike prevent broken avatars and mixed account IDs', async () => {
  const pastSec = Math.floor((Date.now() - 86_400_000) / 1000).toString(16);
  const futureSec = Math.floor((Date.now() + 86_400_000) / 1000).toString(16);
  const expiredUrl = `https://scontent.fsyd16-2.fna.fbcdn.net/v/t39.30808-1/avatar.jpg?oe=${pastSec}`;
  const validUrl = `https://scontent.fsyd16-2.fna.fbcdn.net/v/t39.30808-1/avatar.jpg?oe=${futureSec}`;

  assert.equal(isExpiredFbCdnUrl(expiredUrl), true);
  assert.equal(isExpiredFbCdnUrl(validUrl), false);
  assert.equal(isExpiredFbCdnUrl('data:image/webp;base64,AAAA'), false);

  assert.equal(isUuidLike('05576a6e-cb92-4d08-a9af-886fe8906970'), true);
  assert.equal(isUuidLike('用户12'), false);
  assert.deepEqual(normalizeRecordAccountId('p023 (Mawi Lee)'), {
    accountId: '',
    extractedName: 'Mawi Lee',
  });
  assert.deepEqual(normalizeRecordAccountId('61593615564708'), {
    accountId: '61593615564708',
    extractedName: '',
  });

  const store = await WorkspaceStore.open(':memory:');
  try {
    const p1 = uid();
    const p2 = uid();
    store.ensureProfileOrders([p1, p2]);
    store.updateProfileAccountCache(p1, {
      id: '100001',
      name: 'Expired',
      state: 'logged-in',
      avatar: expiredUrl,
    });
    store.updateProfileAccountCache(p2, {
      id: '100002',
      name: 'Inline',
      state: 'logged-in',
      avatar: 'data:image/webp;base64,AAAA',
    });
    const db = (store as unknown as { db: DatabaseSync }).db;
    const known = loadKnownAvatarSets(db);
    assert.equal(known.accounts.has('100001'), false);
    assert.equal(known.accounts.has('100002'), true);
    assert.equal(readRecordAvatar(db, 'account', '100001'), null);
    assert.equal(readRecordAvatar(db, 'account', '100002'), 'data:image/webp;base64,AAAA');
  } finally {
    store.close();
  }
});
