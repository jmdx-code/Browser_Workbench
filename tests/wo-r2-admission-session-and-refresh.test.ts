import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { admitProfilesForStart } from '../src/application/profile-start-admission.js';
import {
  FeatureExecutionRegistry,
  ensureFeatureExecutionRegistry,
} from '../src/application/feature-execution-registry.js';
import { extractFacebookGroupId, extractFacebookPageId } from '../src/shared/facebook-target-id.js';
import { AddInviterGroupsRequest } from '../src/shared/group-inviter.js';
import {
  BumperGroupTargetsInput,
  BumperPageTargetsInput,
  BumperTargetsInput,
} from '../src/shared/group-bumper.js';
import { GroupBumperService } from '../src/application/group-bumper-service.js';
import { GroupInviterService } from '../src/application/group-inviter-service.js';
import { PosterAccountRestrictedError } from '../src/infrastructure/group-poster-runner.js';
import { TargetMetadataRefreshService } from '../src/infrastructure/target-metadata-refresh.js';
import {
  BumperMetadataAccountError,
  FacebookGroupSessionHelper,
  GroupBumperBrowserAdapter,
} from '../src/infrastructure/group-bumper-runner.js';
import {
  createGlobalAccountAbnormalReporter,
  inferAbnormalScopeFromUrl,
  inferAbnormalStateFromCodeOrMessage,
} from '../src/application/account-abnormal-reporter.js';
import { mergeAccountCacheUpdate } from '../src/shared/account-state-policy.js';
import { ProfileInspectionService } from '../src/application/profile-inspection.js';
import { ProductError } from '../src/domain/workspace.js';
import { unifiedTargetLibraryMigration } from '../src/infrastructure/target-library-store.js';
import { bumperDigest } from '../src/infrastructure/group-bumper-recovery.js';

async function withStore(run: (store: WorkspaceStore, dir: string) => Promise<void> | void) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-wo-r2-'));
  const file = path.join(dir, 'workspace.sqlite');
  const store = await WorkspaceStore.open(file);
  try {
    await run(store, dir);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('WO-R2.1: extractFacebookGroupId / extractFacebookPageId and Zod preprocess handle /p/ slug-id, reject root/non-FB/login.php URLs', () => {
  assert.equal(
    extractFacebookPageId('https://www.facebook.com/p/My-Awesome-Page-61550011223344/'),
    '61550011223344',
  );
  assert.equal(extractFacebookPageId('https://www.facebook.com/login.php'), '');
  assert.equal(extractFacebookPageId('https://www.facebook.com/'), '');
  assert.equal(extractFacebookPageId('https://example.com/some-page'), '');
  assert.equal(extractFacebookGroupId('https://www.facebook.com/'), '');
  assert.equal(extractFacebookGroupId('https://example.com/groups/123456'), '');
  assert.equal(
    extractFacebookGroupId('https://www.facebook.com/groups/3017439278594998/?ref=share'),
    '3017439278594998',
  );

  const inviterParsed = AddInviterGroupsRequest.parse({
    items: [
      {
        groupId: 'https://www.facebook.com/groups/3017439278594998/',
        groupName: 'Test Group',
      },
    ],
  });
  assert.equal(inviterParsed.items[0]?.groupId, '3017439278594998');

  const bumperGroupsParsed = BumperGroupTargetsInput.parse({
    items: [{ id: 'https://www.facebook.com/groups/888999000/', name: 'G' }],
  });
  assert.equal(bumperGroupsParsed.items[0]?.id, '888999000');

  const bumperPagesParsed = BumperPageTargetsInput.parse({
    items: [{ id: 'https://www.facebook.com/p/Brand-Page-61558899001122/', name: 'P' }],
  });
  assert.equal(bumperPagesParsed.items[0]?.id, '61558899001122');

  const bumperGenericParsed = BumperTargetsInput.parse({
    items: [{ id: 'https://www.facebook.com/profile.php?id=1000888777666', name: '' }],
  });
  assert.equal(bumperGenericParsed.items[0]?.id, '1000888777666');
});

test('WO-R2.2: admitProfilesForStart partitions ready / busy / offline across all 5 modules without false-busy self-blocking', async () => {
  await withStore(async (store) => {
    const pReady = randomUUID();
    const pBusy = randomUUID();
    const pOffline = randomUUID();

    store.groupBumper.upsertTargets('groups', { items: [{ id: '123456', name: 'Group 1' }] });
    store.groupBumper.upsertTargets('pages', { items: [{ id: '654321', name: 'Page 1' }] });

    const registry = new FeatureExecutionRegistry();
    registry.register({
      id: 'active-accounts',
      label: '活跃账号',
      isProfileRunning: (id) => id === pBusy,
      hasActiveExecution: () => true,
      stopProfiles: async () => {},
    });

    const admission = await admitProfilesForStart({
      requestedProfileIds: [pReady, pBusy, pOffline],
      currentModuleId: 'group-bumper',
      isAlreadyRunningInCurrentModule: () => false,
      busyModuleLabelsForProfile: (id) => registry.busyModuleLabels([id], 'group-bumper'),
      isProfileBusyInOtherModule: (id) => registry.isProfileBusy(id, 'group-bumper'),
      isProfileReady: (id) => id !== pOffline,
    });
    assert.deepEqual(admission.admittedProfileIds, [pReady]);
    assert.equal(admission.skippedBusy.length, 1);
    assert.equal(admission.skippedBusy[0]?.profileId, pBusy);
    assert.equal(admission.skippedBusy[0]?.reason, '跳过：正在运行「活跃账号」');
    assert.equal(admission.skippedOffline.length, 1);
    assert.equal(admission.skippedOffline[0]?.profileId, pOffline);
    assert.equal(admission.skippedOffline[0]?.reason, '跳过：浏览器未连接');

    let startedProfiles: string[] = [];
    const bumperService = new GroupBumperService(
      store.groupBumper,
      {
        ready: (id) => id !== pOffline,
        busy: (id) => registry.isProfileBusy(id, 'group-bumper'),
        stop: async () => {},
        run: async (id, _g, _p, _s, cb) => {
          startedProfiles.push(id);
          while (!cb.cancelled()) await new Promise((r) => setTimeout(r, 10));
        },
      },
      async () => ({ comments: [], total: 0 }),
      () => {},
      undefined,
      0,
    );
    bumperService.setFeatureExecutionRegistry(registry);
    ensureFeatureExecutionRegistry(registry, {
      groupInviter: {
        isProfileRunning: () => false,
        hasActiveExecution: () => false,
        stopProfiles: async () => {},
      },
      groupBumper: bumperService,
      groupPoster: {
        isProfileRunning: () => false,
        hasActiveExecution: () => false,
        stopProfiles: async () => {},
      },
    });

    const state = await bumperService.start({
      profileIds: [pReady, pBusy, pOffline],
      groupIds: ['123456'],
      pageIds: ['654321'],
    });
    assert.equal(state.running, true);
    assert.equal(state.profileCounts[pBusy]?.status, '跳过：正在运行「活跃账号」');
    assert.equal(state.profileCounts[pOffline]?.status, '跳过：浏览器未连接');
    await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(startedProfiles, [pReady]);
    await bumperService.stop([pReady]);
  });
});

test('WO-R2.3: applyResolvedTargetMetadata updates group_poster_logs without deleting historical logs on canonicalId merge, and unifiedTargetLibraryMigration sanitizes invalid folder_id', async () => {
  await withStore(async (store) => {
    const profileId = randomUUID();
    store.groupBumper.upsertTargets('groups', {
      items: [
        { id: 'alias_group_slug', name: 'Alias Group' },
        { id: '999888777666', name: 'Numeric Group' },
      ],
    });
    const mat = store.groupPoster.saveMaterials({
      items: [{ caption: 'Hello world', background: 'plain' }],
    })[0];
    assert.ok(mat);

    const log1Id = randomUUID();
    const log2Id = randomUUID();
    store.groupPoster.recordPost({
      id: log1Id,
      profileId,
      accountId: '10001',
      accountName: 'Alice',
      accountAvatar: null,
      identityType: 'personal',
      groupId: 'alias_group_slug',
      groupName: 'Alias Group',
      groupAvatar: null,
      materialId: mat.id,
      captionPreview: 'Hello 1',
      postId: '111',
      postUrl: 'https://www.facebook.com/groups/alias_group_slug/posts/111/',
      postedAt: 1000,
    });
    store.groupPoster.recordPost({
      id: log2Id,
      profileId,
      accountId: '10001',
      accountName: 'Alice',
      accountAvatar: null,
      identityType: 'personal',
      groupId: '999888777666',
      groupName: 'Numeric Group',
      groupAvatar: null,
      materialId: mat.id,
      captionPreview: 'Hello 2',
      postId: '222',
      postUrl: 'https://www.facebook.com/groups/999888777666/posts/222/',
      postedAt: 2000,
    });

    store.groupBumper.applyResolvedTargetMetadata('groups', 'alias_group_slug', {
      canonicalId: '999888777666',
      name: 'Unified Numeric Group',
      avatarUrl: 'data:image/webp;base64,' + 'A'.repeat(64),
    });

    const posterLogs = store.groupPoster.logs('');
    assert.equal(posterLogs.length, 2);
    assert.ok(
      posterLogs.some(
        (l) =>
          l.id === log1Id &&
          l.groupId === '999888777666' &&
          l.groupName === 'Unified Numeric Group',
      ),
    );
    assert.ok(posterLogs.some((l) => l.id === log2Id && l.groupId === '999888777666'));
  });

  // Verify unifiedTargetLibraryMigration with dangling folder_id in legacy tables
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE group_bumper_folders (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE group_bumper_groups (
        group_id TEXT PRIMARY KEY,
        group_name TEXT NOT NULL,
        avatar_url TEXT,
        folder_id TEXT,
        sort_order INTEGER NOT NULL,
        total_bumped_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE group_inviter_groups (
        group_id TEXT PRIMARY KEY,
        group_name TEXT NOT NULL,
        avatar_url TEXT,
        folder_id TEXT,
        sort_order INTEGER NOT NULL,
        total_invited_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO group_bumper_groups VALUES ('123456', 'G1', NULL, 'dangling-folder-1', 0, 2, 100, 100);
      INSERT INTO group_inviter_groups VALUES ('789012', 'G2', NULL, 'dangling-folder-2', 1, 3, 100, 100);
    `);
    unifiedTargetLibraryMigration(db);
    const fkCheck = db.prepare('PRAGMA foreign_key_check').all();
    assert.deepEqual(fkCheck, []);
    const rows = (
      db
        .prepare('SELECT group_id, folder_id FROM shared_facebook_groups ORDER BY sort_order ASC')
        .all() as Array<{ group_id: string; folder_id: string | null }>
    ).map((r) => ({ group_id: r.group_id, folder_id: r.folder_id }));
    assert.deepEqual(rows, [
      { group_id: '123456', folder_id: null },
      { group_id: '789012', folder_id: null },
    ]);
  } finally {
    db.close();
  }
});

test('WO-R2.4: TargetMetadataRefreshService supports stopRefresh, keeps running=false during refresh, and GroupBumperBrowserAdapter fails over to next PAUSED candidate on account error', async () => {
  await withStore(async (store) => {
    store.groupBumper.upsertTargets('groups', {
      items: [
        { id: '111222333', name: '111222333' },
        { id: '444555666', name: '444555666' },
      ],
    });

    let activeSignal: AbortSignal | undefined;
    const refreshService = new TargetMetadataRefreshService({
      refreshTargetBatch: async (_kind, _items, options) => {
        activeSignal = options?.signal;
        await new Promise<void>((resolve) => {
          const onAbort = () => resolve();
          options?.signal?.addEventListener('abort', onAbort, { once: true });
        });
        return { updated: 0, failed: 0, needsBrowser: 0 };
      },
      resolveTargetMetadata: async () => ({
        canonicalId: null,
        name: null,
        avatarUrl: null,
      }),
    });

    const registry = new FeatureExecutionRegistry();
    const bumperService = new GroupBumperService(
      store.groupBumper,
      {
        ready: () => true,
        busy: async () => false,
        stop: async () => {},
        run: async () => {},
      },
      async () => ({ comments: [], total: 0 }),
      () => {},
      (kind, items, options) => refreshService.refreshTargetBatch(kind, items, options),
      0,
      (kind) => refreshService.stopRefresh(kind),
    );
    bumperService.setFeatureExecutionRegistry(registry);
    ensureFeatureExecutionRegistry(registry, {
      groupInviter: {
        isProfileRunning: () => false,
        hasActiveExecution: () => false,
        stopProfiles: async () => {},
      },
      groupBumper: bumperService,
      groupPoster: {
        isProfileRunning: () => false,
        hasActiveExecution: () => false,
        stopProfiles: async () => {},
      },
    });

    const refreshTask = bumperService.manage('groups/refresh', {});
    await new Promise((r) => setTimeout(r, 15));
    const refreshingState = await bumperService.state();
    assert.equal(refreshingState.running, false);
    assert.equal(refreshingState.pageBumperRunning, false);
    assert.equal(refreshingState.groupAvatarRefreshing, true);
    assert.equal(refreshingState.metadataRefreshing, true);
    assert.equal(await registry.hasAnyActiveExecution(), true);

    const stoppedState = await bumperService.manage('groups/refresh-stop', {});
    await refreshTask;
    assert.equal(activeSignal?.aborted, true);
    assert.equal(stoppedState.groupAvatarRefreshing, false);

    // Multi-candidate failover in GroupBumperBrowserAdapter.refreshTargets
    const peerBadId = randomUUID();
    const peerGoodId = randomUUID();
    const peerBad = {
      profileId: peerBadId,
      online: true,
      synced: true,
      phase: 'PAUSED' as const,
      epoch: randomUUID(),
      capabilities: [],
    };
    const peerGood = {
      profileId: peerGoodId,
      online: true,
      synced: true,
      phase: 'PAUSED' as const,
      epoch: randomUUID(),
      capabilities: [],
    };
    const abnormalReports: Array<{ profileId: string; state: string; scope: string }> = [];
    const adapter = new GroupBumperBrowserAdapter(
      store.groupBumper,
      () =>
        ({
          withSummary: async (_p: unknown, fn: (port: unknown) => unknown) =>
            fn({
              inventory: async () => ({
                tabs: [{ state: 'READY', proof: { tabId: 1 } }],
                operations: [],
              }),
            }),
          readFacebookMetadataPage: async (
            peer: { profileId: string },
            _guard: () => Promise<void>,
            fn: (page: unknown) => Promise<void>,
          ) => {
            if (peer.profileId === peerBadId) {
              throw new BumperMetadataAccountError('FACEBOOK_ACCOUNT_LOGGED_OUT');
            }
            const fakePage = {
              evaluate: async () =>
                '<html><head><meta property="og:title" content="Resolved Group Name" /></head></html>',
            };
            await fn(fakePage);
          },
        }) as never,
      () =>
        ({
          peers: new Map([
            [peerBadId, peerBad],
            [peerGoodId, peerGood],
          ]),
        }) as never,
      async () => false,
      0,
      async (input) => {
        abnormalReports.push({
          profileId: input.profileId,
          state: input.state,
          scope: input.scope,
        });
        return true;
      },
    );

    const resolvedItems: Array<{ rawId: string; name: string | null }> = [];
    const batchRes = await adapter.refreshTargets(
      'groups',
      [
        {
          id: '111222333',
          name: '111222333',
          avatarUrl: 'data:image/webp;base64,' + 'B'.repeat(64),
        },
      ],
      {
        onItemResolved: async (rawId, meta) => {
          resolvedItems.push({ rawId, name: meta.name });
        },
      },
    );
    assert.equal(batchRes.updated, 1);
    assert.equal(batchRes.failed, 0);
    assert.equal(abnormalReports.length, 1);
    assert.equal(abnormalReports[0]?.profileId, peerBadId);
    assert.equal(abnormalReports[0]?.state, 'logged-out');
    assert.equal(abnormalReports[0]?.scope, 'global_route');
    assert.equal(resolvedItems[0]?.name, 'Resolved Group Name');
  });
});

test('WO-R2.5: GlobalAccountAbnormalReporter, mergeAccountCacheUpdate avatar protection, and DataCleanup unsettled bumper operations guard', async () => {
  await withStore(async (store) => {
    const profileId = randomUUID();
    const localAvatar = 'data:image/webp;base64,' + 'C'.repeat(64);

    // 1. Seed logged-in account with local data:image/ avatar
    store.updateProfileAccountCache(profileId, {
      state: 'logged-in',
      id: '1000999888777',
      name: 'Test User',
      avatar: localAvatar,
      liveConfirmedLoggedIn: true,
    });

    // 2. Live observation with avatar: null on logged-in must NOT clear cached avatar
    const mergedLoggedIn = mergeAccountCacheUpdate({
      existing: store.profileAccountCache().get(profileId),
      incoming: {
        state: 'logged-in',
        id: '1000999888777',
        name: 'Test User',
        avatar: null,
      },
      nowMs: Date.now(),
    });
    assert.equal(mergedLoggedIn.next.avatar, localAvatar);

    // 3. Feature-action restriction does NOT overwrite global account state
    let syncedState: string | null = null;
    const fakeInspection = {
      syncExternalObservation: (_id: string, account: { state: string }) => {
        syncedState = account.state;
      },
    } as unknown as ProfileInspectionService;
    const reporter = createGlobalAccountAbnormalReporter({
      updateProfileAccountCache: (id, patch) =>
        store.updateProfileAccountCache(id, {
          state: patch.state,
          scope: patch.scope,
          ...(patch.accountId !== undefined ? { id: patch.accountId } : {}),
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
        }),
      syncExternalObservation: (id, patch) =>
        fakeInspection.syncExternalObservation(id, {
          state: patch.state,
          ...(patch.accountId !== undefined ? { id: patch.accountId } : {}),
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
        }),
    });

    await reporter({
      profileId,
      scope: 'feature_action',
      state: 'restricted',
      reason: '小组禁止发帖',
    });
    assert.equal(store.profileAccountCache().get(profileId)?.state, 'logged-in');
    assert.equal(syncedState, null);

    // 4. Global-route checkpoint updates state to verification and preserves local data:image/ avatar
    assert.equal(inferAbnormalScopeFromUrl('https://www.facebook.com/checkpoint/'), 'global_route');
    assert.equal(
      inferAbnormalScopeFromUrl('https://www.facebook.com/groups/123456/'),
      'feature_action',
    );
    assert.equal(
      inferAbnormalStateFromCodeOrMessage('FACEBOOK_ACCOUNT_VERIFICATION_REQUIRED'),
      'verification',
    );
    const err = new PosterAccountRestrictedError('受限', {
      scope: 'global_route',
      abnormalState: 'verification',
    });
    await reporter({
      profileId,
      scope: err.scope,
      state: err.abnormalState ?? 'restricted',
      reason: err.message,
    });
    const cachedAfterCheckpoint = store.profileAccountCache().get(profileId);
    assert.equal(cachedAfterCheckpoint?.state, 'verification');
    assert.equal(cachedAfterCheckpoint?.avatar, localAvatar);
    assert.equal(syncedState, 'verification');

    // 5. DataCleanup assertResettable blocks when group_bumper_operations has unsettled rows
    const opId = randomUUID();
    store.groupBumper.prepareOperation({
      binding: {
        profileId,
        accountId: '1000999888777',
        connectionEpoch: randomUUID(),
        leaseId: randomUUID(),
        generation: 1,
        operationId: opId,
        jobId: randomUUID(),
        stepId: randomUUID(),
        actionDigest: bumperDigest({
          purpose: 'group-bumper',
          label: '点赞',
          accountId: '1000999888777',
        }),
      },
      runId: randomUUID(),
      actionKind: 'submit_like',
      groupId: '123456',
      groupName: 'G1',
    });
    assert.throws(() => store.dataCleanup.assertResettable(), /顶贴模块存在未结清的内核操作锁/);
    store.groupBumper.setOperationResolution(opId, {
      id: randomUUID(),
      outcome: 'NOT_APPLIED',
      evidenceDigest: bumperDigest({ test: true }),
    });
    store.groupBumper.markOperationSettled(opId);
    assert.doesNotThrow(() => store.dataCleanup.assertResettable());
  });
});

test('WO-R2.6: FacebookGroupSessionHelper.ensureJoinedGroup anchors pendingRegex to short button text and GroupInviter last uninvitable group skips instead of failing', async () => {
  await withStore(async (store) => {
    assert.equal(
      FacebookGroupSessionHelper.extractCanonicalGroupIdFromUrl(
        'https://www.facebook.com/groups/3017439278594998/?sorting_setting=CHRONOLOGICAL',
      ),
      '3017439278594998',
    );
    assert.equal(
      FacebookGroupSessionHelper.extractCanonicalGroupIdFromUrl(
        'https://www.facebook.com/groups/my_group_slug/',
      ),
      null,
    );

    const profileId = randomUUID();
    await store.groupInviter.upsertGroups({
      items: [{ groupId: '3017439278594998', groupName: 'Pending Group' }],
    });
    const inviterService = new GroupInviterService(store.groupInviter, {
      isAvailable: () => true,
      isProfileReady: () => true,
      isProfileBusy: () => false,
      fetchGroupAvatar: async () => null,
      inviteForGroup: async () => {
        throw new ProductError(
          'GROUP_INVITER_GROUP_UNINVITABLE',
          '跳过：该群需管理员审核或回答入群问题',
          409,
        );
      },
    });

    await inviterService.start({
      profileIds: [profileId],
      groupIds: ['3017439278594998'],
    });
    for (let i = 0; i < 40 && inviterService.hasActiveExecution(); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const finalState = await inviterService.state();
    assert.equal(finalState.running, false);
    assert.match(finalState.profileCounts[profileId]?.status ?? '', /已完成/);
    const taskResult = store.tasks
      .runtimeSnapshot()
      .profileResults?.find((r) => r.profileId === profileId);
    assert.equal(taskResult?.state, 'COMPLETED');
  });
});
