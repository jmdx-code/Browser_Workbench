import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openKernelRelayEndpoint } from '../src/infrastructure/kernel-relay-endpoint.js';
import type { KernelRelayModel } from '../src/infrastructure/kernel-relay-model.js';
import { Store } from '../src/bridge/store.js';
import { ExtensionKernelChannel } from '../extension/kernel-channel.js';
import { KernelJournal } from '../src/application/kernel-journal.js';
import { MemoryKernelStorage } from './fixtures/kernel-storage.js';
import { SqliteGroupInviterRepository } from '../src/infrastructure/group-inviter-store.js';
import { GroupInviterService } from '../src/application/group-inviter-service.js';
import { SqliteRecordRetention } from '../src/infrastructure/record-retention-store.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { facebookNavigationContextPending } from '../src/infrastructure/facebook-navigation-read.js';
import { isBumperRecoverableDisconnectError } from '../src/infrastructure/group-bumper-runner.js';
import { BluestacksService } from '../src/application/bluestacks-service.js';
import { BumperSettings } from '../src/shared/group-bumper.js';
import { FeatureExecutionRegistry } from '../src/application/feature-execution-registry.js';

test('Cycle4-1: openKernelRelayEndpoint preserves strict retryClose contract and supports close-then-retry recovery', async () => {
  let stopCalls = 0;
  const fakeModel = {
    connect() {},
    async receive() {},
    async stop(requestId: string) {
      stopCalls++;
      return { requestId, state: 'stopped' as const, unresolvedMethods: [] };
    },
  } as unknown as KernelRelayModel;

  const ep = await openKernelRelayEndpoint(fakeModel);
  await assert.rejects(() => ep.retryClose(), /KERNEL_LOCAL_STOP_RETRY_IN_FLIGHT/);
  const res = await ep.close();
  assert.equal(res.state, 'stopped');
  assert.equal(stopCalls, 1);
  // Subsequent retryClose after close finished re-checks stop cleanly without throwing IN_FLIGHT
  const res2 = await ep.retryClose();
  assert.equal(res2.state, 'stopped');
  assert.equal(stopCalls, 2);
});

test('Cycle4-3: ExtensionKernelChannel.removed emits Inspector.detached on unexpected owned tab closure', async () => {
  const profileId = randomUUID();
  const epoch = randomUUID();
  const leaseId = randomUUID();
  const journal = new KernelJournal(new MemoryKernelStorage());
  await journal.initialize(profileId, epoch);
  const emitted: Array<Record<string, unknown>> = [];
  const channel = new ExtensionKernelChannel(
    () => ({ profileId, epoch, valid: true }),
    (m) => emitted.push(m as Record<string, unknown>),
    undefined,
    journal,
  );
  const ownedTabs = new Set<number>([42]);
  Reflect.set(channel, 'activeLeaseId', leaseId);
  Reflect.set(channel, 'backend', {
    owns: (tabId: number) => ownedTabs.has(tabId),
    expectedRemoval: () => false,
    tabRemoved: (tabId: number) => ownedTabs.delete(tabId),
  });

  channel.removed(42);
  assert.equal(ownedTabs.has(42), false);
  const detachedEvt = emitted.find(
    (e) => e.type === 'KERNEL_EVENT' && e.method === 'Inspector.detached',
  );
  assert.ok(
    detachedEvt,
    'must emit synthetic Inspector.detached when owned tab closes unexpectedly',
  );
  assert.deepEqual(detachedEvt.params, { reason: 'target_closed' });
  assert.equal(detachedEvt.leaseId, leaseId);
});

test('Cycle4-5: archiveKernelReceipts refreshes updated_at on conflict and SqliteRecordRetention protects PENDING inviter ops', async () => {
  const store = new Store(':memory:');
  try {
    const profileId = randomUUID();
    const operationId = randomUUID();
    const binding = {
      profileId,
      accountId: '1000123456',
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: 1,
      jobId: randomUUID(),
      stepId: randomUUID(),
      operationId,
      actionDigest: createHash('sha256').update('test-op').digest('hex'),
    };
    const seq = store.kernelOperationSequence(binding);
    assert.equal(seq, 1);

    // Simulate legacy pre-fix row with updated_at = 0 before archival
    const rawDb = Reflect.get(store, 'db') as DatabaseSync;
    rawDb
      .prepare(
        'UPDATE kernel_operation_receipts SET updated_at=0 WHERE profile_id=? AND operation_id=?',
      )
      .run(profileId, operationId);

    store.archiveKernelReceipts(profileId, [
      {
        binding,
        state: 'RECONCILED',
        reason: 'verified',
        operationSequence: seq,
        resolution: {
          id: randomUUID(),
          outcome: 'VERIFIED',
          evidenceDigest: createHash('sha256').update('ok').digest('hex'),
        },
      },
    ]);

    const row = rawDb
      .prepare(
        'SELECT updated_at FROM kernel_operation_receipts WHERE profile_id=? AND operation_id=?',
      )
      .get(profileId, operationId) as { updated_at: number } | undefined;
    assert.ok(
      row && row.updated_at > 1_700_000_000_000,
      'archiveKernelReceipts must update updated_at on conflict',
    );
  } finally {
    store.close();
  }

  // Verify SqliteRecordRetention protects PENDING group_inviter_logs operation_ids
  const ws = await WorkspaceStore.open(':memory:');
  try {
    const pendingOpId = randomUUID();
    ws.groupInviter.reserveInvites(pendingOpId, [
      {
        profileId: randomUUID(),
        accountId: '1000111222',
        friendId: '2000333444',
        friendName: 'Alice',
        groupId: '987654321',
      },
    ]);
    const retention = new SqliteRecordRetention(Reflect.get(ws, 'db') as DatabaseSync);
    assert.ok(
      retention.protectedOperationIds().includes(pendingOpId),
      'PENDING group_inviter_logs operation_id must be protected from kernel receipt retirement',
    );
  } finally {
    ws.close();
  }
});

test('Cycle4-6: group_inviter_logs creates composite indexes and pushes search/before/limit into SQL', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const repo = new SqliteGroupInviterRepository(db);
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='group_inviter_logs'",
      )
      .all()
      .map((r) => String(r.name));
    assert.ok(indexes.includes('idx_group_inviter_logs_operation'));
    assert.ok(indexes.includes('idx_group_inviter_logs_conf_invited_at'));
    assert.ok(indexes.includes('idx_group_inviter_logs_conf_profile'));

    const p1 = randomUUID();
    repo.recordInvites([
      {
        profileId: p1,
        accountId: '10001',
        friendId: '20001',
        friendName: 'Alice One',
        groupId: '30001',
        invitedAt: 1000,
      },
      {
        profileId: p1,
        accountId: '10001',
        friendId: '20002',
        friendName: 'Bob Two',
        groupId: '30001',
        invitedAt: 2000,
      },
      {
        profileId: p1,
        accountId: '10001',
        friendId: '20003',
        friendName: 'Alice Three',
        groupId: '30002',
        invitedAt: 3000,
      },
    ]);

    const limited = repo.listLogs({ limit: 2 });
    assert.equal(limited.length, 2);
    assert.equal(limited[0]?.friendId, '20003');

    const beforeRows = repo.listLogs({ before: 2500, limit: 10 });
    assert.deepEqual(
      beforeRows.map((r) => r.friendId),
      ['20002', '20001'],
    );

    const searchRows = repo.listLogs({ search: 'alice', limit: 10 });
    assert.deepEqual(
      searchRows.map((r) => r.friendId),
      ['20003', '20001'],
    );

    const svc = new GroupInviterService(repo, undefined);
    const svcRows = await svc.logs('alice', 2500, 5);
    assert.deepEqual(
      svcRows.map((r) => r.friendId),
      ['20001'],
    );
  } finally {
    db.close();
  }
});

test('Cycle4-7: -32000 Cannot find context and locator.evaluate context-destroyed are treated as recoverable navigation/disconnect', () => {
  assert.equal(
    facebookNavigationContextPending(
      new Error(
        'locator.evaluate: Execution context was destroyed, most likely because of a navigation',
      ),
    ),
    true,
  );
  assert.equal(
    facebookNavigationContextPending(
      new Error('{"code":-32000,"message":"Cannot find context with specified id"}'),
    ),
    true,
  );
  assert.equal(
    isBumperRecoverableDisconnectError(
      new Error('rpc-error:{"code":-32000,"message":"Cannot find context with specified id"}'),
    ),
    true,
  );
});

test('Cycle4-8: BluestacksService scheduled/sheets entry points exit immediately on already-aborted AbortSignal', async () => {
  let runnerInvoked = false;
  const fakeRepo = {
    targets: () => [{ id: 'g1', name: 'G1', url: 'https://www.facebook.com/groups/1' }],
    savedSettings: () => ({
      bumperSettings: { maxConcurrentProfiles: 2 },
      pageBumperSettings: { maxConcurrentProfiles: 2 },
      riskPolicy: { enabled: false },
    }),
    todayCounts: () => ({}),
    saveLastStatus: () => {},
    getRiskPolicy: () => ({ enabled: false }),
    countDailyActions: () => 0,
  } as unknown as ConstructorParameters<typeof BluestacksService>[0];
  const fakeDevices = {
    discover: async () => ({
      instances: [],
      configPath: '',
      adbPath: '',
      playerPath: '',
      error: null,
    }),
    inspectAccount: async () => {
      runnerInvoked = true;
      throw new Error('SHOULD_NOT_RUN');
    },
  } as unknown as ConstructorParameters<typeof BluestacksService>[1];
  const fakeRunner = {
    run: async () => {
      runnerInvoked = true;
    },
    runDirectPosts: async () => {
      runnerInvoked = true;
      return { bumped: 1, attempted: 1 };
    },
  } as unknown as ConstructorParameters<typeof BluestacksService>[2];

  const service = new BluestacksService(
    fakeRepo,
    fakeDevices,
    fakeRunner,
    new FeatureExecutionRegistry(),
    {
      activeRunner: {
        run: async () => {
          runnerInvoked = true;
          return {
            completedSteps: 1,
            skippedSteps: 0,
            likes: 0,
            acceptedFriends: 0,
            published: 0,
            notes: [],
          };
        },
      },
      posterRunner: {
        run: async () => {
          runnerInvoked = true;
          return { posted: 1, skipped: 0, notes: [] };
        },
      },
      inviterRunner: {
        run: async () => {
          runnerInvoked = true;
          return { invited: 1, skippedGroups: 0, notes: [] };
        },
      },
      listPosterMaterials: () => [
        {
          id: 'm1',
          name: 'Mat1',
          caption: 'Hi',
          background: 'plain' as const,
          mediaSource: '',
          mediaKind: 'none' as const,
          localFilePath: null,
          thumbnailDataUrl: null,
          cacheStatus: 'ready' as const,
          cacheError: null,
          selected: true,
          usedCount: 0,
          aiLabelMode: 'default' as const,
          sortOrder: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    },
  );

  const ac = new AbortController();
  ac.abort(new Error('TASK_STOPPED'));

  const r1 = await service.runScheduledInstanceStep({
    instanceId: 'bs-1',
    mode: 'group',
    groupIds: ['g1'],
    pageIds: ['g1'],
    minConcurrency: 1,
    signal: ac.signal,
    onProgress: () => {},
  });
  assert.equal(r1.status, '已停止');

  const r2 = await service.runScheduledHealthCheckStep({
    instanceId: 'bs-1',
    signal: ac.signal,
    onProgress: () => {},
  });
  assert.equal(r2.category, 'stopped');

  const r3 = await service.runScheduledActiveStep({
    instanceId: 'bs-1',
    quickStep: { type: 'feed', durationMinutes: 1, maxLikes: 0 },
    signal: ac.signal,
    onProgress: () => {},
  });
  assert.equal(r3.status, '已停止');

  const r4 = await service.runScheduledPosterStep({
    instanceId: 'bs-1',
    materialIds: ['m1'],
    groupIds: ['g1'],
    maxGroupsPerProfile: 1,
    signal: ac.signal,
    onProgress: () => {},
  });
  assert.equal(r4.status, '已停止');

  const r5 = await service.runScheduledInviterStep({
    instanceId: 'bs-1',
    groupIds: ['g1'],
    invitesPerGroup: 5,
    signal: ac.signal,
    onProgress: () => {},
  });
  assert.equal(r5.status, '已停止');

  const r6 = await service.runDirectPostsForSheet({
    instanceId: 'bs-1',
    posts: [],
    settings: BumperSettings.parse({}),
    commentPool: [],
    signal: ac.signal,
  });
  assert.equal(r6.attempted, 0);
  assert.equal(
    runnerInvoked,
    false,
    'none of the 6 runners may execute when signal is already aborted',
  );
});
