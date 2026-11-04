import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  ensureFeatureExecutionRegistry,
  FeatureExecutionRegistry,
} from '../src/application/feature-execution-registry.js';
import { admitProfilesForStart } from '../src/application/profile-start-admission.js';
import { WorkspaceService } from '../src/application/workspace-service.js';
import type { BrowserProfileSource } from '../src/domain/workspace.js';
import { SqliteGroupPosterRepository } from '../src/infrastructure/group-poster-store.js';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import { inspectionAvatarURL } from '../src/renderer/inspection-presentation.js';
import { projectProfileActivity } from '../src/renderer/modules/profile-activity-projector.js';
import {
  classifyAccountRestrictionScope,
  isGlobalAbnormalRouteUrl,
  isRenderableAccountAvatar,
  mergeAccountCacheUpdate,
} from '../src/shared/account-state-policy.js';
import type { Profile } from '../src/shared/contracts.js';

const SAMPLE_LOCAL_WEBP =
  'data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADQAQCdASoQABAAgA0JaQAA3AA/vuUAAA==';
const SAMPLE_FBCDN_AVATAR =
  'https://scontent.xx.fbcdn.net/v/t39.30808-1/123456_7890_n.jpg?stp=dst-jpg';

function makeProfile(id: string, name: string, overrides?: Partial<Profile>): Profile {
  return {
    id,
    alias: name,
    browserName: name,
    groupId: null,
    order: 0,
    online: true,
    synced: true,
    phase: 'PAUSED',
    unresolved: 0,
    extensionVersion: '0.3.59',
    capabilities: ['facebook-readonly-v2'],
    account: {
      state: 'logged-in',
      id: '10000000012345',
      name,
      avatar: null,
    },
    ...overrides,
  };
}

test('WO-U1: fresh DB (version=0) and v47->v48 upgrade rebuild profile_task_results with 5 sources and preserve trigger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-wo-u1-db-'));
  try {
    // 1. Fresh DB path (version = 0 -> 48)
    const freshPath = join(dir, 'fresh.sqlite');
    const freshStore = await WorkspaceStore.open(freshPath);
    freshStore.close();

    const rawFresh = new DatabaseSync(freshPath);
    try {
      const uv = rawFresh.prepare('PRAGMA user_version').get() as { user_version: number };
      assert.equal(uv.user_version, workspaceSchemaVersion);
      assert.ok(uv.user_version >= 48);
      const fkErrors = rawFresh.prepare('PRAGMA foreign_key_check').all();
      assert.equal(fkErrors.length, 0);

      // Verify all 5 sources are accepted by profile_task_results CHECK constraint
      const insertStmt = rawFresh.prepare(
        'INSERT INTO profile_task_results VALUES(?,?,?,?,?,?,?,?,?)',
      );
      for (const source of [
        'task',
        'group-inviter',
        'group-bumper',
        'page-bumper',
        'group-poster',
      ] as const) {
        insertStmt.run(
          randomUUID(),
          source,
          `run-${source}`,
          `name-${source}`,
          'COMPLETED',
          '已完成',
          Date.now(),
          0,
          0,
        );
      }
      const triggerRow = rawFresh
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name='profile_task_result_terminal'",
        )
        .get();
      assert.ok(triggerRow, 'profile_task_result_terminal trigger must exist after v48');
    } finally {
      rawFresh.close();
    }

    // 2. Simulate upgrading from v47 where profile_task_results had old 3-source CHECK and legacy rows
    const upgradePath = join(dir, 'upgrade.sqlite');
    const initStore = await WorkspaceStore.open(upgradePath);
    initStore.close();

    const preUpgrade = new DatabaseSync(upgradePath);
    const pPoster = randomUUID();
    const pPage = randomUUID();
    const pGroup = randomUUID();
    try {
      preUpgrade.exec(`
        DROP TRIGGER IF EXISTS profile_task_result_terminal;
        DROP TABLE profile_task_results;
        CREATE TABLE profile_task_results(
          profile_id TEXT PRIMARY KEY,
          source TEXT NOT NULL CHECK(source IN ('task','group-inviter','group-bumper')),
          run_id TEXT NOT NULL,
          name TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('COMPLETED','FAILED','STOPPED')),
          reason TEXT NOT NULL,
          finished_at INTEGER NOT NULL,
          failed_steps INTEGER NOT NULL DEFAULT 0,
          skipped_steps INTEGER NOT NULL DEFAULT 0
        );
      `);
      const ins = preUpgrade.prepare('INSERT INTO profile_task_results VALUES(?,?,?,?,?,?,?,?,?)');
      ins.run(pPoster, 'group-bumper', 'r1', '小组发帖', 'COMPLETED', '已完成', 1000, 0, 0);
      ins.run(pPage, 'group-bumper', 'r2', '专页顶贴', 'FAILED', '受限 · 频控', 2000, 1, 0);
      ins.run(pGroup, 'group-bumper', 'r3', '小组顶贴', 'STOPPED', '已停止', 3000, 0, 0);
      preUpgrade.exec('PRAGMA user_version=47');
    } finally {
      preUpgrade.close();
    }

    const upgradedStore = await WorkspaceStore.open(upgradePath);
    try {
      const results = upgradedStore.tasks.runtimeSnapshot().profileResults ?? [];
      assert.equal(results.find((r) => r.profileId === pPoster)?.source, 'group-poster');
      assert.equal(results.find((r) => r.profileId === pPage)?.source, 'page-bumper');
      assert.equal(results.find((r) => r.profileId === pGroup)?.source, 'group-bumper');

      // Verify deleteProfiles cascades to profile_task_results and profile_account_cache
      upgradedStore.updateProfileAccountCache(pPoster, {
        state: 'logged-in',
        id: '100001',
        name: 'Poster User',
        avatar: SAMPLE_LOCAL_WEBP,
      });
      assert.equal(upgradedStore.profileAccountCache().has(pPoster), true);
      upgradedStore.deleteProfiles([pPoster]);
      assert.equal(upgradedStore.profileAccountCache().has(pPoster), false);
      assert.equal(
        (upgradedStore.tasks.runtimeSnapshot().profileResults ?? []).some(
          (r) => r.profileId === pPoster,
        ),
        false,
      );
    } finally {
      upgradedStore.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WO-U1: account-state-policy separates global_route vs feature_action, self-heals logged-in, and prevents 1.8s local avatar overwrite', async () => {
  assert.equal(
    isGlobalAbnormalRouteUrl('https://www.facebook.com/checkpoint/12345'),
    'verification',
  );
  assert.equal(isGlobalAbnormalRouteUrl('https://www.facebook.com/disabled/'), 'restricted');
  assert.equal(isGlobalAbnormalRouteUrl('https://www.facebook.com/login/'), 'logged-out');
  assert.equal(isGlobalAbnormalRouteUrl('https://www.facebook.com/groups/12345/'), null);

  assert.deepEqual(
    classifyAccountRestrictionScope({
      url: 'https://www.facebook.com/groups/12345/',
      hasCUserCookie: true,
    }),
    { scope: 'feature_action', state: null },
  );
  assert.deepEqual(
    classifyAccountRestrictionScope({
      url: 'https://www.facebook.com/checkpoint/',
      hasCUserCookie: true,
    }),
    { scope: 'global_route', state: 'verification' },
  );

  // Renderable avatar check accepts both local WebP data URL and fbcdn URL
  assert.equal(isRenderableAccountAvatar(SAMPLE_LOCAL_WEBP), true);
  assert.equal(isRenderableAccountAvatar(SAMPLE_FBCDN_AVATAR), true);
  assert.equal(isRenderableAccountAvatar('https://evil.example.com/a.jpg'), false);

  const profileId = randomUUID();
  const profileWithLocalAvatar = makeProfile(profileId, 'User A', {
    account: {
      state: 'logged-in',
      id: '10000000999',
      name: 'User A',
      avatar: SAMPLE_LOCAL_WEBP,
    },
  });
  assert.equal(
    inspectionAvatarURL(profileWithLocalAvatar, undefined, true, 1000),
    SAMPLE_LOCAL_WEBP,
  );

  // feature_action restriction must NOT overwrite existing logged-in state
  const existing = {
    state: 'logged-in' as const,
    id: '10000000999',
    name: 'User A',
    avatar: SAMPLE_LOCAL_WEBP,
    avatarUpdatedAt: 5000,
  };
  const ignoredFeatureRestriction = mergeAccountCacheUpdate({
    existing,
    incoming: {
      state: 'restricted',
      scope: 'feature_action',
    },
  });
  assert.equal(ignoredFeatureRestriction.changed, false);
  assert.equal(ignoredFeatureRestriction.next.state, 'logged-in');
  assert.equal(ignoredFeatureRestriction.next.avatar, SAMPLE_LOCAL_WEBP);

  // 1.8s snapshot polling with remote fbcdn URL or null must NOT overwrite local WebP avatar
  const noDowngradeFromRemote = mergeAccountCacheUpdate({
    existing,
    incoming: {
      state: 'logged-in',
      id: '10000000999',
      name: 'User A',
      avatar: SAMPLE_FBCDN_AVATAR,
    },
  });
  assert.equal(noDowngradeFromRemote.changed, false);
  assert.equal(noDowngradeFromRemote.next.avatar, SAMPLE_LOCAL_WEBP);

  // Global route verification followed by liveConfirmedLoggedIn self-heals back to logged-in and retains local avatar
  const dir = mkdtempSync(join(tmpdir(), 'wb-wo-u1-cache-'));
  try {
    const store = await WorkspaceStore.open(join(dir, 'workspace.sqlite'));
    store.updateProfileAccountCache(profileId, {
      state: 'logged-in',
      id: '10000000999',
      name: 'User A',
      avatar: SAMPLE_LOCAL_WEBP,
      avatarUpdatedAt: 1000,
    });
    store.updateProfileAccountCache(profileId, {
      state: 'verification',
      scope: 'global_route',
    });
    assert.equal(store.profileAccountCache().get(profileId)?.state, 'verification');
    assert.equal(store.profileAccountCache().get(profileId)?.avatar, SAMPLE_LOCAL_WEBP);

    // Self-heal when live browser reports logged-in with remote avatar
    const liveRow: Profile = makeProfile(profileId, 'User A', {
      account: {
        state: 'logged-in',
        id: '10000000999',
        name: 'User A',
        avatar: SAMPLE_FBCDN_AVATAR,
      },
    });
    let writeCount = 0;
    const origUpdate = store.updateProfileAccountCache.bind(store);
    store.updateProfileAccountCache = (pid, upd) => {
      writeCount++;
      origUpdate(pid, upd);
    };
    const source: BrowserProfileSource = {
      profiles: () => [liveRow],
      records: () => [],
      stop: () => {},
    };
    const ws = new WorkspaceService(store, source);
    const snap1 = await ws.snapshot();
    const p1 = snap1.profiles[0];
    assert.ok(p1);
    assert.equal(p1.account.state, 'logged-in');
    assert.equal(p1.account.avatar, SAMPLE_LOCAL_WEBP);
    assert.equal(writeCount, 1);

    // Second 1.8s poll must NOT trigger any DB write!
    const snap2 = await ws.snapshot();
    assert.equal(snap2.profiles[0]?.account.avatar, SAMPLE_LOCAL_WEBP);
    assert.equal(writeCount, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WO-U1: SqliteGroupPosterRepository snapshots personal avatar on write without overwriting page avatar on read', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      "CREATE TABLE profile_account_cache(profile_id TEXT PRIMARY KEY,account_state TEXT NOT NULL DEFAULT 'unknown',account_id TEXT,account_name TEXT,avatar_url TEXT,avatar_updated_at INTEGER NOT NULL DEFAULT 0)",
    );
    const profileId = randomUUID();
    db.prepare(
      'INSERT INTO profile_account_cache(profile_id,account_state,account_id,account_name,avatar_url,avatar_updated_at) VALUES(?,?,?,?,?,?)',
    ).run(profileId, 'logged-in', '100000111', 'Personal Name', SAMPLE_LOCAL_WEBP, 1000);

    const repo = new SqliteGroupPosterRepository(db);
    const pageAvatar =
      'data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADQAQCdASoQABAAgA0JaQAA3AA/vuUAAA==';

    // Personal post without avatar snapshots from profile_account_cache
    repo.recordPost({
      id: randomUUID(),
      profileId,
      accountId: '100000111',
      accountName: 'Personal Name',
      accountAvatar: null,
      identityType: 'personal',
      groupId: '123456',
      groupName: 'Group 1',
      groupAvatar: null,
      materialId: 'm1',
      captionPreview: 'Hello personal',
      postId: 'p1',
      postUrl: 'https://www.facebook.com/groups/123456/posts/p1/',
      postedAt: 1000,
    });

    // Page post keeps its own page avatar (or null) and is NEVER overwritten by personal cache
    repo.recordPost({
      id: randomUUID(),
      profileId,
      accountId: '6155000999',
      accountName: 'My Brand Page',
      accountAvatar: pageAvatar,
      identityType: 'page',
      groupId: '123456',
      groupName: 'Group 1',
      groupAvatar: null,
      materialId: 'm2',
      captionPreview: 'Hello page',
      postId: 'p2',
      postUrl: 'https://www.facebook.com/groups/123456/posts/p2/',
      postedAt: 2000,
    });

    const logs = repo.logs();
    assert.equal(logs.length, 2);
    const pageLog = logs.find((l) => l.identityType === 'page');
    const personalLog = logs.find((l) => l.identityType === 'personal');
    assert.equal(pageLog?.accountAvatar, pageAvatar);
    assert.equal(personalLog?.accountAvatar, SAMPLE_LOCAL_WEBP);
  } finally {
    db.close();
  }
});

test('WO-U1: admitProfilesForStart admits idle profiles regardless of historical restriction and skips busy/offline profiles', async () => {
  const pIdleRestrictedHistory = randomUUID();
  const pBusyInPoster = randomUUID();
  const pOffline = randomUUID();

  const registry = new FeatureExecutionRegistry();
  registry.register({
    id: 'group-poster',
    label: '小组发帖',
    isProfileRunning: (id) => id === pBusyInPoster,
    hasActiveExecution: () => true,
  });

  const admitted = await admitProfilesForStart({
    requestedProfileIds: [pIdleRestrictedHistory, pBusyInPoster, pOffline],
    currentModuleId: 'group-bumper',
    busyModuleLabelsForProfile: (id) => registry.busyModuleLabels([id], 'group-bumper'),
    isProfileReady: (id) => id !== pOffline,
  });

  assert.deepEqual(admitted.admittedProfileIds, [pIdleRestrictedHistory]);
  assert.equal(admitted.skippedBusy.length, 1);
  assert.equal(admitted.skippedBusy[0]?.profileId, pBusyInPoster);
  assert.match(admitted.skippedBusy[0]?.reason ?? '', /小组发帖/);
  assert.equal(admitted.skippedOffline.length, 1);
  assert.equal(admitted.skippedOffline[0]?.profileId, pOffline);
});

test('WO-U1: projectProfileActivity keeps running module status across tab switches and maps all 5 result sources', () => {
  const pRunningPoster = randomUUID();
  const pIdleFinishedPageBumper = randomUUID();
  const pIdleFinishedPoster = randomUUID();

  // User is currently viewing 'group-bumper' tab where bumperCounts has an idle entry for pRunningPoster
  const actRunning = projectProfileActivity(pRunningPoster, {
    activeModule: 'group-bumper',
    bumperCounts: {
      [pRunningPoster]: { today: 0, session: 0, status: '未运行', running: false },
    },
    groupPosterRunningIds: [pRunningPoster],
  });
  assert.ok(actRunning);
  assert.equal(actRunning.moduleId, 'group-poster');
  assert.equal(actRunning.running, true);
  assert.equal(actRunning.text, '小组发帖 · 运行中');

  // Idle profile with page-bumper lastResult on home tab
  const actPageResult = projectProfileActivity(pIdleFinishedPageBumper, {
    activeModule: 'active-accounts',
    tasks: {
      dispatchEnabled: true,
      settings: { maxConcurrentProfiles: 5 },
      plans: [],
      currentSteps: [],
      profileResults: [
        {
          profileId: pIdleFinishedPageBumper,
          source: 'page-bumper',
          runId: 'r-page',
          name: '专页顶贴',
          state: 'COMPLETED',
          reason: '已完成 · 本轮 3 次',
          finishedAt: 10000,
          failedSteps: 0,
          skippedSteps: 0,
        },
        {
          profileId: pIdleFinishedPoster,
          source: 'group-poster',
          runId: 'r-poster',
          name: '小组发帖',
          state: 'FAILED',
          reason: '受限 · 需要手机验证或操作受限',
          finishedAt: 20000,
          failedSteps: 1,
          skippedSteps: 0,
        },
      ],
    },
  });
  assert.ok(actPageResult);
  assert.equal(actPageResult.moduleId, 'page-bumper');
  assert.equal(actPageResult.moduleLabel, '专页顶贴');
  assert.match(actPageResult.text, /上次成功 · 专页顶贴/);

  const actPosterResult = projectProfileActivity(pIdleFinishedPoster, {
    activeModule: 'active-accounts',
    tasks: {
      dispatchEnabled: true,
      settings: { maxConcurrentProfiles: 5 },
      plans: [],
      currentSteps: [],
      profileResults: [
        {
          profileId: pIdleFinishedPoster,
          source: 'group-poster',
          runId: 'r-poster',
          name: '小组发帖',
          state: 'FAILED',
          reason: '受限 · 需要手机验证或操作受限',
          finishedAt: 20000,
          failedSteps: 1,
          skippedSteps: 0,
        },
      ],
    },
  });
  assert.ok(actPosterResult);
  assert.equal(actPosterResult.moduleId, 'group-poster');
  assert.equal(actPosterResult.moduleLabel, '小组发帖');
  assert.equal(actPosterResult.tone, 'warn');
  assert.match(actPosterResult.text, /上次受限 · 需要手机验证或操作受限 · 小组发帖/);
});

test('WO-U1: ensureFeatureExecutionRegistry wires all 5 modules including active-accounts and group-poster stopProfiles', async () => {
  const stopped: string[] = [];
  const pActive = randomUUID();
  const pPoster = randomUUID();
  const pPage = randomUUID();

  const registry = ensureFeatureExecutionRegistry(undefined, {
    tasks: {
      hasProfilePlanInStates: (id) => id === pActive,
      hasActiveExecution: () => true,
      stopActiveProfile: async (id) => {
        stopped.push(`active-accounts:${id}`);
        return true;
      },
    },
    groupInviter: {
      isProfileRunning: () => false,
      hasActiveExecution: () => false,
      stopProfiles: async ({ profileIds }) => {
        stopped.push(`group-inviter:${profileIds.join(',')}`);
      },
    },
    groupBumper: {
      isProfileRunning: (id) => id === pPage,
      hasActiveExecution: () => true,
      isProfileRunningInMode: (id, mode) => id === pPage && mode === 'page-bumper',
      hasActiveExecutionInMode: (mode) => mode === 'page-bumper',
      stop: async (ids, mode) => {
        stopped.push(`${mode}:${(ids ?? []).join(',')}`);
      },
    },
    groupPoster: {
      isProfileRunning: (id) => id === pPoster,
      hasActiveExecution: () => true,
      stopProfiles: async (ids) => {
        stopped.push(`group-poster:${ids.join(',')}`);
      },
    },
  });

  assert.equal(registry.participants().length, 5);
  assert.deepEqual(await registry.busyModuleLabels([pActive, pPoster, pPage]), [
    '活跃账号',
    '专页顶贴',
    '小组发帖',
  ]);
  const didStop = await registry.stopProfilesAcrossModules([pActive, pPoster, pPage]);
  assert.equal(didStop, true);
  assert.deepEqual(stopped, [
    `active-accounts:${pActive}`,
    `page-bumper:${pPage}`,
    `group-poster:${pPoster}`,
  ]);
});
