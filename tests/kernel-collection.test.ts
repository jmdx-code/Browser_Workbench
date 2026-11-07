import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { KernelJournal } from '../src/application/kernel-journal.js';
import { MemoryKernelStorage } from './fixtures/kernel-storage.js';
import { Store } from '../src/bridge/store.js';
import { KernelPersistentState } from '../src/shared/kernel-state.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { recoverBumperOperations } from '../src/infrastructure/group-bumper-recovery.js';
import { retireClosedKernelSession } from '../src/infrastructure/kernel-session-retirement.js';
import { prepareBound } from './fixtures/settlement.js';
import type { Binding } from '../src/shared/task-execution.js';
import type { KernelSummaryPort, KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import type { Peer } from '../src/bridge/core.js';
const binding = (profileId = randomUUID()): Binding => ({
  profileId,
  accountId: '10001',
  connectionEpoch: randomUUID(),
  leaseId: randomUUID(),
  generation: 0,
  operationId: randomUUID(),
  jobId: randomUUID(),
  stepId: randomUUID(),
  actionDigest: 'a'.repeat(64),
});
const resolution = () => ({
  id: randomUUID(),
  outcome: 'VERIFIED' as const,
  evidenceDigest: 'b'.repeat(64),
});

test('native receipts are archived durably before collection; old begin stays retired after worker restart', async () => {
  const db = new Store(':memory:'),
    storage = new MemoryKernelStorage(),
    b = binding(),
    epoch = randomUUID();
  try {
    let journal = new KernelJournal(storage);
    await journal.initialize(b.profileId, epoch);
    const seq = db.kernelOperationSequence(b);
    assert.equal(db.kernelOperationSequence(b), seq);
    await journal.begin(b, seq);
    await journal.finish(b, 'ACKNOWLEDGED');
    await journal.reconcile(b, resolution());
    const records = (await journal.snapshot()).operations;
    db.archiveKernelReceipts(b.profileId, records);
    await journal.collect(records, epoch);
    assert.equal(await journal.collect(records, epoch), 0);
    journal = new KernelJournal(storage);
    await journal.initialize(b.profileId, epoch);
    await assert.rejects(journal.begin(b, seq), /RETIRED/);
    await assert.rejects(journal.begin(b), /SEQUENCE_REQUIRED/);
    assert.equal(db.kernelReceipts(b.profileId, [b.operationId]).length, 1);
    const next = { ...b, operationId: randomUUID() };
    assert.equal((await journal.begin(next, db.kernelOperationSequence(next))).fresh, true);
  } finally {
    db.close();
  }
});

test('collection never drops pending, mismatched or foreign-session entries, nor loses a receipt on failed storage', async () => {
  const storage = new MemoryKernelStorage(),
    b = binding(),
    epoch = randomUUID(),
    j = new KernelJournal(storage);
  await j.initialize(b.profileId, epoch);
  await j.begin(b, 1);
  let rows = (await j.snapshot()).operations;
  await assert.rejects(j.collect(rows, epoch), /MISMATCH/);
  await j.finish(b, 'ACKNOWLEDGED');
  await j.reconcile(b, resolution());
  rows = (await j.snapshot()).operations;
  await assert.rejects(j.collect(rows, randomUUID()), /CONTEXT_CHANGED/);
  await assert.rejects(j.collect([{ ...rows[0]!, reason: 'wrong' }], epoch), /MISMATCH/);
  storage.fail = true;
  await assert.rejects(j.collect(rows, epoch), /STORAGE_FAILURE/);
  assert.equal(KernelPersistentState.parse(storage.value).operations.length, 1);
});

test('one uninterrupted journal runs more than 3000 operations with bounded receipt storage', async () => {
  const storage = new MemoryKernelStorage(),
    b = binding(),
    epoch = randomUUID(),
    j = new KernelJournal(storage);
  await j.initialize(b.profileId, epoch);
  for (let i = 1; i <= 3200; i++) {
    const current = { ...b, operationId: randomUUID() };
    await j.begin(current, i);
    await j.finish(current, 'ACKNOWLEDGED');
    await j.reconcile(current, resolution());
    if (i % 200 === 0) {
      const snapshot = await j.snapshot();
      await j.collect(snapshot.operations.slice(0, -20), epoch);
    }
  }
  const state = await j.snapshot();
  assert.equal(state.operationHighWater, 3200);
  assert.ok(state.operations.length <= 20);
});

test('a browser session change marks old execution ended; a worker wake in the same browser does not', async () => {
  const storage = new MemoryKernelStorage(),
    b = binding(),
    epoch = randomUUID();
  let j = new KernelJournal(storage);
  await j.initialize(b.profileId, epoch);
  await j.begin(b, 1);
  j = new KernelJournal(storage);
  await j.initialize(b.profileId, epoch);
  assert.equal((await j.snapshot()).operations[0]?.executionEnded, undefined);
  const nextEpoch = randomUUID();
  j = new KernelJournal(storage);
  await j.initialize(b.profileId, nextEpoch);
  assert.equal((await j.snapshot()).operations[0]?.executionEnded, true);
  await assert.rejects(j.acknowledgeSessionEnd(nextEpoch), /UNCONFIRMED/);
  await j.retireOperation(b, { ...resolution(), outcome: 'ENDED_UNKNOWN' });
  await j.acknowledgeSessionEnd(nextEpoch);
  assert.equal((await j.snapshot()).previousBrowserSessionEpoch, undefined);
});

test('archived receipt recovers SETTLEMENT_PENDING even after the native copy was collected', async () => {
  const db = new Store(':memory:'),
    workspace = await WorkspaceStore.open(':memory:'),
    b = binding();
  try {
    const r = workspace.groupBumper;
    const record = {
      id: randomUUID(),
      profileId: b.profileId,
      accountId: b.accountId,
      groupId: '12345',
      groupName: 'g',
      pageId: '20001',
      pageName: 'p',
      postId: '300000001',
      postUrl: 'https://www.facebook.com/groups/12345/posts/300000001/',
      liked: true,
      commentText: null,
      bumpedAt: Date.now(),
    };
    r.prepareOperation({
      binding: b,
      runId: randomUUID(),
      actionKind: 'submit_like',
      groupId: record.groupId,
      groupName: 'g',
      pageId: record.pageId,
      pageName: 'p',
      postId: record.postId,
      postUrl: record.postUrl,
      logId: record.id,
    });
    const saved = r.confirmSubmission(b.operationId, record, undefined, resolution());
    if (saved.outcome === 'ENDED_UNKNOWN') throw Error('expected verified result');
    db.archiveKernelReceipts(b.profileId, [
      {
        binding: b,
        state: 'RECONCILED',
        reason: '',
        resolution: { ...saved, outcome: saved.outcome },
      },
    ]);
    const kernel = {
      withSummary: async (_p: unknown, fn: Function) =>
        fn({ inventory: async () => ({ operations: [] }) }),
      archivedOperations: async (profileId: string, ids: string[]) =>
        db.kernelReceipts(profileId, ids),
    } as unknown as KernelBridge;
    await recoverBumperOperations(kernel, { profileId: b.profileId } as Peer, r, () => {});
    assert.equal(r.getOperation(b.operationId)?.status, 'SETTLED');
    assert.equal(r.total(), 1);
  } finally {
    workspace.close();
    db.close();
  }
});

test('an interrupted task with unknown input ends on browser restart without replay or an account lock', async () => {
  const workspace = await WorkspaceStore.open(':memory:');
  try {
    const f = prepareBound(workspace);
    const storage = new MemoryKernelStorage(),
      j = new KernelJournal(storage),
      epoch = randomUUID();
    await j.initialize(f.profile.id, epoch);
    await j.begin(f.binding, 1);
    await j.finish(f.binding, 'UNKNOWN');
    const reloaded = new KernelJournal(storage);
    await reloaded.initialize(f.profile.id, randomUUID());
    let inputs = 0;
    const port: KernelSummaryPort = {
      profileId: f.profile.id,
      inventory: () => reloaded.snapshot(),
      stopCurrent: async (id) => ({
        profileId: f.profile.id,
        connectionEpoch: randomUUID(),
        requestId: id,
        state: 'stopped',
      }),
      notify: async (b, r) => {
        await reloaded.retireOperation(b, r);
        return { binding: b, resolution: r };
      },
    };
    const state = await reloaded.snapshot();
    await retireClosedKernelSession(
      workspace,
      { profileId: f.profile.id } as Peer,
      port,
      { ...state, browserSessionStartedAt: Date.now() + 1 },
      Date.now() + 1,
    );
    const plan = workspace.tasks.get(f.plan.id);
    assert.ok(['STOPPED', 'FAILED'].includes(plan.state));
    assert.equal(inputs, 0);
    const old = workspace.tasks.operations(f.plan.id)[0]!;
    assert.equal(old.status, 'UNKNOWN');
    assert.equal(old.disposition?.outcome, 'ENDED_UNKNOWN');
    assert.equal(workspace.tasks.settlements.hasUndelivered(f.profile.id), false);
    assert.equal(workspace.tasks.blockingOperations(f.plan.id).length, 0);
  } finally {
    workspace.close();
  }
});

test('a short connection restart does not end a current task created after controller startup', async () => {
  const workspace = await WorkspaceStore.open(':memory:');
  try {
    const startup = Date.now() - 1000,
      f = prepareBound(workspace),
      storage = new MemoryKernelStorage(),
      j = new KernelJournal(storage);
    await j.initialize(f.profile.id, randomUUID());
    await j.begin(f.binding, 1);
    await j.finish(f.binding, 'UNKNOWN');
    const port: KernelSummaryPort = {
      profileId: f.profile.id,
      inventory: () => j.snapshot(),
      stopCurrent: async () => {
        throw Error('MUST_NOT_STOP_CURRENT_TASK');
      },
      notify: async () => {
        throw Error('MUST_NOT_RETIRE_CURRENT_INPUT');
      },
    };
    await retireClosedKernelSession(
      workspace,
      { profileId: f.profile.id } as Peer,
      port,
      await j.snapshot(),
      startup,
    );
    assert.equal(workspace.tasks.get(f.plan.id).state, 'RUNNING');
    assert.equal((await j.snapshot()).operations[0]?.disposition, undefined);
  } finally {
    workspace.close();
  }
});

test('future scheduled work survives the end of the previous browser session', async () => {
  const workspace = await WorkspaceStore.open(':memory:');
  try {
    const profile = {
      id: randomUUID(),
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in' as const, id: '10001', name: null, avatar: null },
    };
    const combo = workspace.createCombination({
      name: 'future',
      note: '',
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    const plans = workspace.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: combo.id,
        version: 1,
        profileIds: [profile.id],
        timing: { mode: 'at', startAt: Date.now() + 3600000, timeZone: 'UTC' },
      },
      [profile],
    );
    const storage = new MemoryKernelStorage(),
      j = new KernelJournal(storage);
    await j.initialize(profile.id, randomUUID());
    const port: KernelSummaryPort = {
      profileId: profile.id,
      inventory: () => j.snapshot(),
      stopCurrent: async () => {
        throw Error('MUST_NOT_STOP_FUTURE_TASK');
      },
      notify: async () => {
        throw Error('UNEXPECTED_NOTIFY');
      },
    };
    await retireClosedKernelSession(
      workspace,
      { profileId: profile.id } as Peer,
      port,
      {
        ...(await j.snapshot()),
        previousBrowserSessionEpoch: randomUUID(),
        browserSessionStartedAt: Date.now() + 1,
      },
      Date.now() + 1,
    );
    assert.equal(workspace.tasks.get(plans[0]!.id).state, 'QUEUED');
    assert.equal(workspace.tasks.get(plans[0]!.id).timingReleased, false);
  } finally {
    workspace.close();
  }
});

test('a saved conclusion without a native begin receipt is ended and settled instead of waiting forever', async () => {
  const workspace = await WorkspaceStore.open(':memory:'),
    b = binding();
  try {
    const repo = workspace.groupBumper;
    repo.prepareOperation({
      binding: b,
      runId: randomUUID(),
      actionKind: 'setup_navigate',
      groupId: '-',
      groupName: 'page',
    });
    const saved = repo.setOperationResolution(b.operationId, {
      ...resolution(),
      outcome: 'NOT_APPLIED',
    });
    let notified = 0;
    const kernel = {
      archivedOperations: async () => [],
      withSummary: async (_p: unknown, fn: Function) =>
        fn({
          inventory: async () => ({ operations: [] }),
          notify: async (value: Binding, r: unknown) => {
            assert.deepEqual(value, b);
            assert.deepEqual(r, saved);
            notified++;
            return { binding: value, resolution: r };
          },
        }),
    } as unknown as KernelBridge;
    await recoverBumperOperations(
      kernel,
      { profileId: b.profileId, capabilities: ['kernel-journal-collection-v1'] } as Peer,
      repo,
      () => {},
    );
    assert.equal(notified, 1);
    assert.equal(repo.getOperation(b.operationId)?.status, 'SETTLED');
    assert.equal(repo.total(), 0);
  } finally {
    workspace.close();
  }
});
