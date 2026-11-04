import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Core, type Peer } from '../src/bridge/core.js';
import { Store } from '../src/bridge/store.js';
import { GroupBumperService } from '../src/application/group-bumper-service.js';
import {
  GroupPosterService,
  type GroupPosterBrowserPort,
  type PosterMediaPreparerPort,
} from '../src/application/group-poster-service.js';
import { BridgeBrowserWindow } from '../src/infrastructure/bridge-browser-window.js';
import {
  extractCreatedGroupPostIdFromGraphQL,
  GroupPosterBrowserAdapter,
  posterDigest,
  recoverPosterOperations,
  resolvePosterPendingApprovalState,
} from '../src/infrastructure/group-poster-runner.js';
import { SqliteGroupBumperRepository } from '../src/infrastructure/group-bumper-store.js';
import { SqliteGroupInviterRepository } from '../src/infrastructure/group-inviter-store.js';
import { SqliteGroupPosterRepository } from '../src/infrastructure/group-poster-store.js';
import { SqliteTargetLibraryRepository } from '../src/infrastructure/target-library-store.js';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import type { Binding } from '../src/shared/task-execution.js';

const P01 = '00000000-0000-4000-8000-000000000051';

test('WO-R1.1: group_poster_operations accepts real UUID connectionEpoch without SQLITE_MISMATCH and round-trips exact UUID', async () => {
  const store = await WorkspaceStore.open(':memory:');
  try {
    const epochUuid = randomUUID();
    const binding: Binding = {
      operationId: randomUUID(),
      profileId: P01,
      accountId: '100088899900011',
      connectionEpoch: epochUuid,
      leaseId: randomUUID(),
      generation: 1,
      jobId: randomUUID(),
      stepId: randomUUID(),
      actionDigest: posterDigest({
        purpose: 'group-poster',
        actionKind: 'submit_post',
        label: '点击发布按钮',
        accountId: '100088899900011',
      }),
    };

    const prepared = store.groupPoster.prepareOperation({
      binding,
      runId: binding.jobId,
      actionKind: 'submit_post',
      groupId: '123456789012',
      groupName: 'UUID Epoch Group',
      materialId: 'mat-uuid-1',
    });
    assert.equal(prepared.binding.connectionEpoch, epochUuid);

    const listed = store.groupPoster.listOperationsByProfile(P01);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.binding.connectionEpoch, epochUuid);
    assert.equal(listed[0]?.binding.operationId, binding.operationId);
  } finally {
    store.close();
  }
});

test('WO-R1.2: v0 -> v52, v47 -> v52, and v51 -> v52 migrations upgrade group_poster_operations.connection_epoch to TEXT, preserve rows, pass foreign_key_check, and run zero ALTER TABLE in constructors', async () => {
  assert.equal(workspaceSchemaVersion, 52);
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-wor1-mig-'));
  try {
    // 1. v0 -> v52 fresh database
    const freshPath = path.join(dir, 'fresh-v52.sqlite');
    const freshStore = await WorkspaceStore.open(freshPath);
    freshStore.close();

    const rawFresh = new DatabaseSync(freshPath, { readOnly: true });
    assert.equal(
      (rawFresh.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      52,
    );
    assert.deepEqual(rawFresh.prepare('PRAGMA foreign_key_check').all(), []);
    const freshCols = rawFresh
      .prepare("PRAGMA table_info('group_poster_operations')")
      .all() as Array<{
      name: string;
      type: string;
    }>;
    assert.equal(freshCols.find((c) => c.name === 'connection_epoch')?.type, 'TEXT');
    rawFresh.close();

    // 2. v47 -> v52 legacy upgrade path
    const v47Path = path.join(dir, 'legacy-v47.sqlite');
    const seedStore = await WorkspaceStore.open(v47Path);
    seedStore.close();
    const rawV47 = new DatabaseSync(v47Path);
    rawV47.exec(`
      DROP TABLE IF EXISTS shared_facebook_groups;
      DROP TABLE IF EXISTS shared_facebook_pages;
      DROP TABLE IF EXISTS group_poster_operations;
      PRAGMA user_version = 47;
    `);
    rawV47.close();

    const upgradedFrom47 = await WorkspaceStore.open(v47Path);
    const epoch47 = randomUUID();
    upgradedFrom47.groupPoster.prepareOperation({
      binding: {
        operationId: randomUUID(),
        profileId: P01,
        accountId: '10001',
        connectionEpoch: epoch47,
        leaseId: randomUUID(),
        generation: 1,
        jobId: randomUUID(),
        stepId: randomUUID(),
        actionDigest: 'dig-47',
      },
      runId: 'run-47',
      actionKind: 'setup_open_group',
      groupId: '99887766',
      groupName: 'From v47',
    });
    upgradedFrom47.close();

    const rawAfter47 = new DatabaseSync(v47Path, { readOnly: true });
    assert.equal(
      (rawAfter47.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      52,
    );
    assert.deepEqual(rawAfter47.prepare('PRAGMA foreign_key_check').all(), []);
    rawAfter47.close();

    // 3. v51 -> v52 upgrade path (where connection_epoch was INTEGER NOT NULL)
    const v51Path = path.join(dir, 'legacy-v51.sqlite');
    const prep51 = await WorkspaceStore.open(v51Path);
    prep51.close();

    const rawV51 = new DatabaseSync(v51Path);
    rawV51.exec(`
      DROP TABLE IF EXISTS group_poster_operations;
      CREATE TABLE group_poster_operations (
        operation_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        connection_epoch INTEGER NOT NULL,
        lease_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        job_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        action_digest TEXT NOT NULL,
        run_id TEXT NOT NULL,
        action_kind TEXT NOT NULL,
        group_id TEXT NOT NULL DEFAULT '',
        group_name TEXT NOT NULL DEFAULT '',
        material_id TEXT,
        post_id TEXT,
        post_url TEXT,
        log_id TEXT,
        resolution_id TEXT,
        resolution_outcome TEXT,
        evidence_digest TEXT,
        status TEXT NOT NULL DEFAULT 'PREPARED',
        kernel_settled INTEGER NOT NULL DEFAULT 0,
        review_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO group_poster_operations (
        operation_id, profile_id, account_id, connection_epoch, lease_id, generation,
        job_id, step_id, action_digest, run_id, action_kind, group_id, group_name,
        material_id, status, kernel_settled, created_at, updated_at
      ) VALUES (
        'op-legacy-int', '${P01}', '100051', 7, 'lease-51', 1,
        'job-51', 'step-51', 'dig-51', 'run-51', 'submit_post', '515151', 'Legacy Group 51',
        'mat-51', 'PENDING_REVIEW', 1, 1700000000000, 1700000000000
      );
      PRAGMA user_version = 51;
    `);
    rawV51.close();

    const upgradedFrom51 = await WorkspaceStore.open(v51Path);
    const preservedOps = upgradedFrom51.groupPoster.listOperationsByProfile(P01, true);
    assert.equal(preservedOps.length, 1);
    assert.equal(preservedOps[0]?.binding.operationId, 'op-legacy-int');
    assert.equal(preservedOps[0]?.binding.connectionEpoch, '7');
    assert.equal(preservedOps[0]?.status, 'PENDING_REVIEW');

    const newEpochUuid = randomUUID();
    upgradedFrom51.groupPoster.prepareOperation({
      binding: {
        operationId: 'op-new-uuid',
        profileId: P01,
        accountId: '100051',
        connectionEpoch: newEpochUuid,
        leaseId: randomUUID(),
        generation: 2,
        jobId: randomUUID(),
        stepId: randomUUID(),
        actionDigest: 'dig-52',
      },
      runId: 'run-52',
      actionKind: 'submit_post',
      groupId: '515151',
      groupName: 'Legacy Group 51',
      materialId: 'mat-52',
    });
    const allOps = upgradedFrom51.groupPoster.listOperationsByProfile(P01, true);
    assert.equal(
      allOps.find((o) => o.binding.operationId === 'op-new-uuid')?.binding.connectionEpoch,
      newEpochUuid,
    );
    upgradedFrom51.close();

    // 4. Verify Repository constructors execute ZERO ALTER TABLE on a v52 database
    const checkDb = new DatabaseSync(v51Path);
    const origExec = checkDb.exec.bind(checkDb);
    const alterCalls: string[] = [];
    checkDb.exec = (sql: string) => {
      if (/\bALTER\s+TABLE\b/i.test(sql)) {
        alterCalls.push(sql);
      }
      return origExec(sql);
    };
    new SqliteTargetLibraryRepository(checkDb);
    new SqliteGroupInviterRepository(checkDb);
    new SqliteGroupBumperRepository(checkDb);
    new SqliteGroupPosterRepository(checkDb);
    assert.deepEqual(alterCalls, []);
    checkDb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WO-R1.3: submit_post never false-positives pending_approval when composer dialog remains open with static admin approval text', () => {
  // 1. Static banner "管理员开启了帖子审核" present before and during submit while dialog is still open (hasComposer = true)
  assert.equal(
    resolvePosterPendingApprovalState({
      hasComposer: true,
      graphqlPendingApproval: false,
      preSubmitNotices: ['管理员开启了帖子审核 · Admin approval is required for posts'],
      currentNotices: ['管理员开启了帖子审核 · Admin approval is required for posts'],
    }),
    false,
  );

  // 2. Even if new text appears inside composer while hasComposer === true, never treat as pendingApproval
  assert.equal(
    resolvePosterPendingApprovalState({
      hasComposer: true,
      graphqlPendingApproval: true,
      preSubmitNotices: [],
      currentNotices: ['待管理员审核'],
    }),
    false,
  );

  // 3. Dialog closed (hasComposer === false), but only pre-existing static notice remains -> false
  assert.equal(
    resolvePosterPendingApprovalState({
      hasComposer: false,
      graphqlPendingApproval: false,
      preSubmitNotices: ['管理员批准后才会显示'],
      currentNotices: ['管理员批准后才会显示'],
    }),
    false,
  );

  // 4. Dialog closed (hasComposer === false) AND new post-submit approval toast appeared -> true
  assert.equal(
    resolvePosterPendingApprovalState({
      hasComposer: false,
      graphqlPendingApproval: false,
      preSubmitNotices: ['管理员批准后才会显示'],
      currentNotices: ['管理员批准后才会显示', '感谢发帖，你的帖子已提交，正在等待管理员审核。'],
    }),
    true,
  );

  // 5. GraphQL ComposerStoryCreateMutation with error must not set pendingApproval
  const gqlWithError = extractCreatedGroupPostIdFromGraphQL(
    JSON.stringify({
      errors: [{ message: 'Some error occurred while pending approval' }],
      data: { story_create: null },
    }),
  );
  assert.equal(gqlWithError.postId, null);
  assert.equal(gqlWithError.pendingApproval, false);

  // 6. GraphQL ComposerStoryCreateMutation without error and with approval notice sets pendingApproval = true
  const gqlApproval = extractCreatedGroupPostIdFromGraphQL(
    JSON.stringify({
      data: {
        group_composer_story_create: {
          notice: 'Your post is pending admin approval',
        },
      },
    }),
  );
  assert.equal(gqlApproval.postId, null);
  assert.equal(gqlApproval.pendingApproval, true);
});

test('WO-R1.4: execOp with nativeMutationCalls > 0 settles via ENDED_UNKNOWN (never in-session reconcile NOT_APPLIED), and submit_post exception marks operation PENDING_REVIEW', async () => {
  const store = await WorkspaceStore.open(':memory:');
  try {
    const profileId = P01;
    const epochUuid = randomUUID();
    const accountId = '1000777888999';
    const bridgeStore = new Store(':memory:');
    const bridgeCore = new Core(bridgeStore);
    const peer = bridgeCore.connect(
      profileId,
      () => {},
      () => {},
    );
    peer.epoch = epochUuid;
    peer.online = true;
    peer.synced = true;
    peer.paused = true;
    peer.phase = 'PAUSED';
    peer.capabilities = ['kernel-journal-v1', 'kernel-unknown-end-v1'];
    peer.extensionVersion = '0.3.60';

    const reconcileCalls: Array<{ binding: Binding; outcome: string }> = [];
    const notifyCalls: Array<{ binding: Binding; outcome: string }> = [];
    const kernelOps = new Map<
      string,
      {
        binding: Binding;
        state: 'ACKNOWLEDGED' | 'UNKNOWN' | 'RECONCILED';
        reason: string;
        resolution: null | { id: string; outcome: string; evidenceDigest: string };
        disposition?: { id: string; outcome: string; evidenceDigest: string };
      }
    >();

    // Simulate an uncertain setup operation (with mutations > 0) and a throwing submit_post operation
    const setupOpId = randomUUID();
    const setupBinding: Binding = {
      operationId: setupOpId,
      profileId,
      accountId,
      connectionEpoch: epochUuid,
      leaseId: randomUUID(),
      generation: 1,
      jobId: randomUUID(),
      stepId: randomUUID(),
      actionDigest: posterDigest({
        purpose: 'group-poster',
        actionKind: 'setup_wait_media_ready',
        label: '等待媒体上传就绪',
        accountId,
      }),
    };
    store.groupPoster.prepareOperation({
      binding: setupBinding,
      runId: setupBinding.jobId,
      actionKind: 'setup_wait_media_ready',
      groupId: '11223344',
      groupName: 'Video Group',
      materialId: 'mat-video-1',
    });
    store.groupPoster.setOperationResolution(setupOpId, {
      id: randomUUID(),
      outcome: 'NOT_APPLIED',
      evidenceDigest: 'ev-not-applied',
    });
    kernelOps.set(setupOpId, {
      binding: setupBinding,
      state: 'UNKNOWN',
      reason: '',
      resolution: null,
    });

    const submitOpId = randomUUID();
    const submitBinding: Binding = {
      operationId: submitOpId,
      profileId,
      accountId,
      connectionEpoch: epochUuid,
      leaseId: randomUUID(),
      generation: 1,
      jobId: setupBinding.jobId,
      stepId: randomUUID(),
      actionDigest: posterDigest({
        purpose: 'group-poster',
        actionKind: 'submit_post',
        label: '点击发布按钮',
        groupId: '11223344',
        materialId: 'mat-video-1',
        accountId,
      }),
    };
    store.groupPoster.prepareOperation({
      binding: submitBinding,
      runId: submitBinding.jobId,
      actionKind: 'submit_post',
      groupId: '11223344',
      groupName: 'Video Group',
      materialId: 'mat-video-1',
    });
    // Simulate submit_post throwing during conn.execute -> markOperationReview called before recovery
    store.groupPoster.markOperationReview(
      submitOpId,
      '发布中断待核对: Execution context destroyed',
    );
    kernelOps.set(submitOpId, {
      binding: submitBinding,
      state: 'ACKNOWLEDGED',
      reason: '',
      resolution: null,
    });

    const fakeKernel = {
      withSummary: async <T>(
        _peer: Peer,
        work: (port: {
          profileId: string;
          inventory: () => Promise<{ profileId: string; operations: unknown[]; tabs: unknown[] }>;
          notify: (
            b: Binding,
            r: { id: string; outcome: string; evidenceDigest: string },
          ) => Promise<unknown>;
          stopCurrent: () => Promise<unknown>;
        }) => Promise<T>,
      ) =>
        work({
          profileId,
          inventory: async () => ({
            profileId,
            operations: [...kernelOps.values()],
            tabs: [],
          }),
          notify: async (b, r) => {
            notifyCalls.push({ binding: b, outcome: r.outcome });
            const op = kernelOps.get(b.operationId);
            if (op) {
              op.disposition = r;
            }
            return { binding: b, resolution: r };
          },
          stopCurrent: async () => ({
            profileId,
            connectionEpoch: epochUuid,
            requestId: randomUUID(),
            state: 'stopped',
          }),
        }),
    };

    await recoverPosterOperations(
      fakeKernel as unknown as Parameters<typeof recoverPosterOperations>[0],
      peer,
      store.groupPoster,
      () => {},
    );

    assert.equal(reconcileCalls.length, 0);
    assert.equal(notifyCalls.length, 2);
    assert.ok(notifyCalls.every((c) => c.outcome === 'ENDED_UNKNOWN'));

    const allRows = store.groupPoster.listOperationsByProfile(profileId, true);
    const setupRow = allRows.find((r) => r.binding.operationId === setupOpId);
    const submitRow = allRows.find((r) => r.binding.operationId === submitOpId);
    assert.equal(setupRow?.status, 'NOT_APPLIED');
    assert.equal(setupRow?.kernelSettled, true);
    assert.equal(submitRow?.status, 'PENDING_REVIEW');
    assert.equal(submitRow?.kernelSettled, true);
    assert.equal(store.groupPoster.hasGroupPostedMaterial('11223344', 'mat-video-1'), true);
    assert.ok(typeof GroupPosterBrowserAdapter === 'function');
    await bridgeCore.shutdown();
    bridgeStore.close();
  } finally {
    store.close();
  }
});

test('WO-R1.5: GroupPosterService preserves user-selected group order, does not mutate group.id in-place on canonical redirect, releases activeGroupIds cleanly, and updates remaining queued tasks for that group', async () => {
  const store = await WorkspaceStore.open(':memory:');
  try {
    store.groupPoster.upsertTargets({
      items: [
        { id: 'slug-alpha', name: 'Alpha Group' },
        { id: 'slug-beta', name: 'Beta Group' },
      ],
    });
    const savedMaterials = store.groupPoster.saveMaterials({
      items: [
        { id: 'mat-1', caption: 'Post 1', mediaSource: '', background: 'plain', selected: true },
        { id: 'mat-2', caption: 'Post 2', mediaSource: '', background: 'plain', selected: true },
      ],
    });
    assert.equal(savedMaterials.length, 2);
    store.groupPoster.saveSettings({
      materialsPerGroup: 2,
      maxPostsPerAccount: 10,
      maxConcurrentProfiles: 1,
    });

    const claimedOrder: Array<{ rawGroupRefId: string; materialId: string }> = [];
    const runner: GroupPosterBrowserPort = {
      ready: () => true,
      busy: async () => false,
      stop: async () => {},
      runProfileWorker: async (profileId, _files, _settings, callbacks) => {
        while (!callbacks.cancelled() && (await callbacks.canContinueAccount(profileId))) {
          const task = await callbacks.claimNextTask();
          if (!task) break;
          const originalGroupRef = task.group;
          claimedOrder.push({ rawGroupRefId: originalGroupRef.id, materialId: task.material.id });
          let effectiveId = originalGroupRef.id;
          if (originalGroupRef.id === 'slug-beta') {
            effectiveId = '999888777666';
            store.groupPoster.applyResolvedTargetMetadata('slug-beta', {
              canonicalId: effectiveId,
              name: 'Beta Canonical Group',
            });
            await callbacks.onGroupIdResolved?.('slug-beta', effectiveId);
          }
          // Verify original group reference was NOT mutated in place
          assert.equal(originalGroupRef.id, claimedOrder[claimedOrder.length - 1]?.rawGroupRefId);
          await callbacks.onTaskPosted({
            id: randomUUID(),
            profileId,
            accountId: '10001',
            accountName: 'Poster Account',
            accountAvatar: null,
            identityType: 'personal',
            groupId: effectiveId,
            groupName: originalGroupRef.name,
            groupAvatar: null,
            materialId: task.material.id,
            captionPreview: task.material.caption,
            postId: randomUUID(),
            postUrl: `https://www.facebook.com/groups/${effectiveId}/`,
            postedAt: Date.now(),
          });
        }
      },
    };
    const preparer: PosterMediaPreparerPort = {
      prepare: async (src) => ({ localFilePath: src, mediaKind: 'none' }),
    };

    const service = new GroupPosterService(store.groupPoster, runner, preparer);
    // Pass groupIds in reverse order: ['slug-beta', 'slug-alpha']
    await service.start({
      profileIds: [P01],
      groupIds: ['slug-beta', 'slug-alpha'],
      materialIds: ['mat-1', 'mat-2'],
    });

    while ((await service.state()).running) {
      await new Promise<void>((r) => setTimeout(r, 20));
    }

    const finalState = await service.state();
    assert.equal(finalState.running, false);
    assert.equal(finalState.profileCounts[P01]?.session, 4);
    // Check that activeGroupIds is completely empty after run
    const internalActive = Reflect.get(service, 'activeGroupIds') as Set<string>;
    assert.equal(internalActive.size, 0);
    // Check that the second material for slug-beta was updated to canonicalId '999888777666' in the queue!
    const betaClaims = claimedOrder.filter(
      (c) => c.rawGroupRefId === 'slug-beta' || c.rawGroupRefId === '999888777666',
    );
    assert.equal(betaClaims.length, 2);
    assert.equal(betaClaims[0]?.rawGroupRefId, 'slug-beta');
    assert.equal(betaClaims[1]?.rawGroupRefId, '999888777666');
  } finally {
    store.close();
  }
});

test('WO-R1.6: GroupBumperService.state() preserves comment-only session today count instead of overwriting with 0 from likes-only todayCounts', async () => {
  const store = await WorkspaceStore.open(':memory:');
  try {
    store.groupBumper.upsertTargets('groups', {
      items: [{ id: '1234567890', name: 'Comment Only Group' }],
    });
    store.groupBumper.upsertTargets('pages', {
      items: [{ id: '100099887766', name: 'Comment Target Page' }],
    });
    // Record a comment-only log row in group_bumper_logs (liked = 0, comment_text non-empty)
    store.groupBumper.record({
      id: randomUUID(),
      profileId: P01,
      accountId: '1000112233',
      groupId: '1234567890',
      groupName: 'Comment Only Group',
      pageId: '100099887766',
      pageName: 'Comment Target Page',
      postId: '555666777888',
      postUrl: 'https://www.facebook.com/groups/1234567890/posts/555666777888/',
      liked: false,
      commentText: 'Great post!',
      bumpedAt: Date.now(),
      sourceMode: 'group',
    });
    const service = new GroupBumperService(
      store.groupBumper,
      {
        ready: () => true,
        busy: async () => false,
        stop: async () => {},
        run: async (_profileId, _groups, _pages, _settings, callbacks) => {
          callbacks.added(1);
        },
      },
      async () => ({ comments: [], total: 1 }),
      () => {},
      undefined,
      0,
    );

    await service.start({
      profileIds: [P01],
      groupIds: ['1234567890'],
      pageIds: ['100099887766'],
    });
    while ((await service.state()).running) {
      await new Promise<void>((r) => setTimeout(r, 20));
    }

    const state = await service.state();
    assert.ok((state.profileCounts[P01]?.today ?? 0) >= 1);
    assert.equal(state.profileCounts[P01]?.session, 1);
  } finally {
    store.close();
  }
});

test('WO-R1.7: BridgeBrowserWindow.consolidate rejects cleanupExtraTabs when peer is RUNNING or inviterBusy is true on extension >= 0.3.59', async () => {
  const store = new Store(':memory:');
  const core = new Core(store);
  let extraCleanupCalled = 0;
  const peer = core.connect(
    randomUUID(),
    (input) => {
      const m = input as { type: string };
      if (m.type === 'CLEANUP_EXTRA_TABS') {
        extraCleanupCalled++;
      }
    },
    () => {},
  );
  peer.extensionVersion = '0.3.59';
  peer.synced = true;
  peer.phase = 'RUNNING';
  peer.capabilities = ['browser-window-reveal-v1', 'kernel-workspace-cleanup-v1'];

  let busyFlag = false;
  const service = new BridgeBrowserWindow(
    core,
    {
      list: async () => [],
      hasProfilePlanInStates: async () => false,
    },
    undefined,
    async () => ({
      profileId: peer.profileId,
      proof: {
        profileId: peer.profileId,
        ownershipId: randomUUID(),
        tabId: 1,
        targetId: 't-1',
        browserSessionEpoch: peer.epoch,
      },
      url: 'https://www.facebook.com/',
      closedTabIds: [2],
      remainingTabCount: 1,
    }),
    () => busyFlag,
  );

  try {
    // 1. Rejects when peer.phase === 'RUNNING'
    await assert.rejects(service.consolidate(peer.profileId), /BROWSER_BUSY|正在执行或对账/);
    assert.equal(extraCleanupCalled, 0);

    // 2. Rejects when inviterBusy(profileId) === true even if peer.phase === 'PAUSED'
    peer.phase = 'PAUSED';
    busyFlag = true;
    await assert.rejects(service.consolidate(peer.profileId), /BROWSER_TASK_ACTIVE|任务正在执行/);
    assert.equal(extraCleanupCalled, 0);

    // 3. cleanupTabs counts busy profile in skippedBusy without calling CLEANUP_EXTRA_TABS
    const batchRes = await service.cleanupTabs([peer.profileId]);
    assert.equal(batchRes.cleanedProfiles, 0);
    assert.equal(batchRes.skippedBusy, 1);
    assert.equal(extraCleanupCalled, 0);
  } finally {
    await core.shutdown();
    store.close();
  }
});
