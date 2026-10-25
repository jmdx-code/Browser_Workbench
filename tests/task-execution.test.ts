import { latestMigrationBackupMarker } from './fixtures/workspace-schema.js';
import test from 'node:test';
import { dropControlSchema } from './fixtures/control.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { TaskDispatcher } from '../src/application/task-dispatcher.js';
import type { RuntimeProfile, TaskBrowserPort } from '../src/domain/tasks.js';
import type { Binding, ExecutionReceipt, ExecutionSession } from '../src/shared/task-execution.js';
import type { Operation } from '../src/shared/task-contracts.js';
import type { Action } from '../src/shared/browser-actions.js';

const click: Action = {
  kind: 'click',
  tabId: 42,
  documentEpoch: 0,
  routeEpoch: 0,
  target: { css: '#fixture-button' },
};
const supported = new Set<'video'>(['video']);
async function fixture(run: (store: WorkspaceStore, file: string) => Promise<void> | void) {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-bound-'));
  const file = path.join(dir, 'workspace.sqlite');
  const store = await WorkspaceStore.open(file);
  try {
    await run(store, file);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
async function setup(store: WorkspaceStore, count = 1, sharedAccount = false) {
  const runtime: RuntimeProfile[] = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: true,
    account: {
      state: 'logged-in',
      id: sharedAccount ? 'fixture-same-account' : 'fixture-account-' + index,
      name: null,
      avatar: null,
    },
  }));
  // Assignment persists profiles in canonical ID order; test setup must use that same order.
  runtime.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const saved = await store.createCombination({
    name: '隔离执行层测试',
    note: '模拟端口，不代表FB业务',
    steps: [{ id: randomUUID(), type: 'video', durationMinutes: 1, maxLikes: 1, minLikeCount: 0 }],
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
  });
  await store.tasks.assign(
    {
      requestId: randomUUID(),
      combinationId: saved.id,
      version: saved.version,
      profileIds: runtime.map((row) => row.id),
    },
    runtime,
  );
  const contexts = new Map<string, ExecutionSession>(
    runtime.map((profile) => [
      profile.id,
      {
        profileId: profile.id,
        accountId: profile.account.id ?? '',
        connectionEpoch: randomUUID(),
        leaseId: randomUUID(),
        generation: 0,
      },
    ]),
  );
  const operations: Operation[] = [];
  for (let index = 0; index < count; index++) {
    const plan = await store.tasks.claimNext(runtime, supported);
    if (!plan) break;
    const step = (await store.tasks.steps(plan.id))[0];
    assert.ok(step);
    operations.push(await store.tasks.prepareOperation(plan.id, step.id, randomUUID(), click));
  }
  return { runtime, contexts, operations };
}
async function bound(store: WorkspaceStore, context: ExecutionSession) {
  const operation = await store.tasks.takeBoundOperation(context);
  assert.ok(operation?.binding);
  return { ...operation, binding: operation.binding };
}
function receipt(binding: Binding): ExecutionReceipt {
  return { binding, evidence: { fixtureCounter: 1 } };
}
function execution(binding: Binding): ExecutionSession {
  const { profileId, accountId, connectionEpoch, leaseId, generation } = binding;
  return { profileId, accountId, connectionEpoch, leaseId, generation };
}
function session(contexts: Map<string, ExecutionSession>, id: string) {
  const value = contexts.get(id);
  assert.ok(value);
  return value;
}
async function checkpoint(store: WorkspaceStore, operation: Operation) {
  const step = (await store.tasks.steps(operation.jobId)).find(
    (row) => row.id === operation.stepId,
  );
  assert.ok(step);
  return { ...step.progress, revision: step.progress.revision + 1, likes: 1 };
}
test('dispatch binding is durable before input, wrong account cannot claim, and legacy receipts cannot bypass it', async () => {
  await fixture(async (store, file) => {
    const { contexts, runtime } = await setup(store);
    const profile = runtime[0];
    assert.ok(profile);
    const context = session(contexts, profile.id);
    assert.equal(
      await store.tasks.takeBoundOperation({ ...context, accountId: 'wrong-account' }),
      null,
    );
    const operation = await bound(store, context);
    assert.match(operation.binding.actionDigest, /^[a-f0-9]{64}$/);
    const other = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(other.tasks.operations(operation.jobId)[0]?.binding, operation.binding);
      assert.equal(other.tasks.takeBoundOperation({ ...context, leaseId: randomUUID() }), null);
    } finally {
      other.close();
    }
    await assert.rejects(
      async () => await store.tasks.markAcknowledged(operation.id, {}),
      /完整执行回执/,
    );
    await assert.rejects(
      async () =>
        await store.tasks.settleOperation(
          operation.id,
          'VERIFIED',
          {},
          await checkpoint(store, operation),
        ),
      /完整执行回执/,
    );
    const db = new DatabaseSync(file);
    try {
      assert.throws(
        () =>
          db
            .prepare('UPDATE task_dispatch_bindings SET body=? WHERE operation_id=?')
            .run('{}', operation.id),
        /IMMUTABLE/,
      );
      assert.throws(
        () =>
          db.prepare('DELETE FROM task_dispatch_bindings WHERE operation_id=?').run(operation.id),
        /RETAIN/,
      );
    } finally {
      db.close();
    }
  });
});
test('each identity field and action digest are required on ACK and verification', async () => {
  await fixture(async (store) => {
    const { contexts, runtime } = await setup(store);
    const profile = runtime[0];
    assert.ok(profile);
    const operation = await bound(store, session(contexts, profile.id));
    const corruptions: Partial<Binding>[] = [
      { profileId: randomUUID() },
      { accountId: 'other' },
      { connectionEpoch: randomUUID() },
      { leaseId: randomUUID() },
      { generation: 1 },
      { jobId: randomUUID() },
      { stepId: randomUUID() },
      { actionDigest: '0'.repeat(64) },
    ];
    for (const change of corruptions) {
      const reply = receipt({ ...operation.binding, ...change });
      await assert.rejects(async () => await store.tasks.acknowledgeBound(reply), /上下文不一致/);
      await assert.rejects(
        async () =>
          await store.tasks.settleBound(reply, 'VERIFIED', await checkpoint(store, operation)),
        /上下文不一致/,
      );
    }
    assert.equal((await store.tasks.operations(operation.jobId))[0]?.status, 'DISPATCHING');
    await store.tasks.acknowledgeBound(receipt(operation.binding));
    assert.equal((await store.tasks.steps(operation.jobId))[0]?.progress.likes, 0);
    await store.tasks.settleBound(
      receipt(operation.binding),
      'VERIFIED',
      await checkpoint(store, operation),
    );
    await store.tasks.settleBound(
      receipt(operation.binding),
      'VERIFIED',
      await checkpoint(store, operation),
    );
    assert.equal((await store.tasks.steps(operation.jobId))[0]?.progress.revision, 1);
  });
});
test('independent profiles dispatch concurrently, while overlapping flushes cannot send a profile twice', async () => {
  await fixture(async (store) => {
    const { runtime, contexts, operations } = await setup(store, 2);
    const releases: (() => void)[] = [],
      sends: string[] = [];
    const dispatcher = new TaskDispatcher(store.tasks, {
      profiles: () => runtime,
      session: (id) => contexts.get(id) ?? null,
      send: async (operation) => {
        sends.push(operation.binding.profileId);
        assert.equal((await store.tasks.operations(operation.jobId))[0]?.status, 'DISPATCHING');
        await new Promise<void>((resolve) => releases.push(resolve));
        return receipt(operation.binding);
      },
    });
    const first = dispatcher.flushOne(),
      second = dispatcher.flushOne();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sends.length, 2);
    assert.equal(new Set(sends).size, 2);
    assert.equal(await dispatcher.flushOne(), false);
    releases.forEach((release) => release());
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    for (const operation of operations)
      assert.equal((await store.tasks.operations(operation.jobId))[0]?.status, 'ACKNOWLEDGED');
  });
});
test('a changed connection before ACK holds uncertainty and prevents replay on a new lease', async () => {
  await fixture(async (store) => {
    const { runtime, contexts, operations } = await setup(store, 2, true);
    const first = operations[0];
    assert.ok(first);
    let sends = 0;
    const dispatcher = new TaskDispatcher(store.tasks, {
      profiles: () => runtime,
      session: (id) => contexts.get(id) ?? null,
      send: async (operation) => {
        sends++;
        contexts.set(operation.binding.profileId, {
          ...execution(operation.binding),
          connectionEpoch: randomUUID(),
          leaseId: randomUUID(),
        });
        return receipt(operation.binding);
      },
    });
    assert.equal(await dispatcher.flushOne(), true);
    assert.equal((await store.tasks.operations(first.jobId))[0]?.status, 'UNKNOWN');
    assert.equal((await store.tasks.get(first.jobId)).state, 'REVIEW');
    assert.equal(await dispatcher.flushOne(), false);
    assert.equal(sends, 1);
    assert.equal(await store.tasks.claimNext(runtime, supported), null);
  });
});
test('executor echo of another operation cannot ACK that operation or the requested one', async () => {
  await fixture(async (store) => {
    const { runtime, contexts, operations } = await setup(store, 2);
    const otherProfile = runtime[1];
    assert.ok(otherProfile);
    const other = await bound(store, session(contexts, otherProfile.id));
    const dispatcher = new TaskDispatcher(store.tasks, {
      profiles: () => runtime,
      session: (id) => contexts.get(id) ?? null,
      send: async () => receipt(other.binding),
    });
    assert.equal(await dispatcher.flushOne(), true);
    const first = operations[0];
    assert.ok(first);
    assert.equal((await store.tasks.operations(first.jobId))[0]?.status, 'UNKNOWN');
    assert.equal((await store.tasks.operations(other.jobId))[0]?.status, 'DISPATCHING');
  });
});
test('unknown result rejects late success; independent reconciliation advances once and only after actual control confirmation frees the lock', async () => {
  await fixture(async (store) => {
    const { runtime, contexts } = await setup(store, 2, true);
    const profile = runtime[0];
    assert.ok(profile);
    const operation = await bound(store, session(contexts, profile.id));
    const reply = receipt(operation.binding);
    await store.tasks.markBoundUnknown(operation.binding, 'DISCONNECTED');
    await store.tasks.acknowledgeBound(reply);
    await assert.rejects(
      async () =>
        await store.tasks.settleBound(reply, 'VERIFIED', await checkpoint(store, operation)),
      /独立核对/,
    );
    const stopped = await store.tasks.requestControl(operation.jobId, 'stop');
    assert.ok(stopped.controlRequestId);
    await store.tasks.confirmControl(stopped.id, stopped.controlRequestId);
    assert.equal(await store.tasks.claimNext(runtime, supported), null);
    await store.tasks.reconcileBound(reply, 'VERIFIED', await checkpoint(store, operation));
    assert.equal((await store.tasks.get(operation.jobId)).state, 'STOPPED');
    assert.equal((await store.tasks.steps(operation.jobId))[0]?.progress.likes, 1);
    await assert.rejects(
      async () =>
        await store.tasks.reconcileBound(reply, 'VERIFIED', await checkpoint(store, operation)),
      /仅未知/,
    );
    assert.ok(await store.tasks.claimNext(runtime, supported));
  });
});

test('unknown observations remain bound, durable and immutable without confirming an effect or changing progress', async () => {
  await fixture(async (store, file) => {
    const { runtime, contexts } = await setup(store);
    const profile = runtime[0];
    assert.ok(profile);
    const operation = await bound(store, session(contexts, profile.id));
    const observed = {
      binding: operation.binding,
      evidence: { pending: { version: 1, visible: false, scrollY: 8085 } },
    };
    await assert.rejects(
      async () =>
        await store.tasks.markBoundUnknown(operation.binding, 'BROWSE_EFFECT_TIMEOUT', {
          ...observed,
          binding: { ...operation.binding, operationId: randomUUID() },
        }),
      /BINDING_MISMATCH/,
    );
    assert.equal((await store.tasks.operations(operation.jobId))[0]?.status, 'DISPATCHING');
    await store.tasks.markBoundUnknown(operation.binding, 'BROWSE_EFFECT_TIMEOUT', observed);
    const saved = (await store.tasks.operations(operation.jobId))[0]?.receipt;
    await store.tasks.markBoundUnknown(operation.binding, 'LATER_REASON', {
      ...observed,
      evidence: { pending: { version: 1, visible: true, scrollY: 9000 } },
    });
    assert.deepEqual((await store.tasks.operations(operation.jobId))[0]?.receipt, saved);
    assert.equal((await store.tasks.operations(operation.jobId))[0]?.status, 'UNKNOWN');
    assert.equal((await store.tasks.steps(operation.jobId))[0]?.progress.effectiveMilliseconds, 0);
    const reader = new DatabaseSync(file, { readOnly: true });
    try {
      assert.deepEqual(
        JSON.parse(
          String(
            reader.prepare('SELECT receipt FROM task_outbox WHERE id=?').get(operation.id)?.receipt,
          ),
        ),
        saved,
      );
    } finally {
      reader.close();
    }
  });
});
test('verification from a replaced lease cannot advance even with the original receipt', async () => {
  await fixture(async (store) => {
    const { runtime, contexts, operations } = await setup(store);
    let reply: ExecutionReceipt | undefined;
    const port: TaskBrowserPort = {
      profiles: () => runtime,
      session: (id) => contexts.get(id) ?? null,
      send: async (operation) => {
        reply = receipt(operation.binding);
        return reply;
      },
    };
    const dispatcher = new TaskDispatcher(store.tasks, port);
    await dispatcher.flushOne();
    assert.ok(reply);
    const original = reply;
    contexts.set(original.binding.profileId, {
      ...execution(original.binding),
      leaseId: randomUUID(),
    });
    const operation = operations[0];
    assert.ok(operation);
    await assert.rejects(
      async () => await dispatcher.verify(original, 'VERIFIED', await checkpoint(store, operation)),
      /CONTEXT_CHANGED/,
    );
    assert.equal((await store.tasks.operations(operation.jobId))[0]?.status, 'UNKNOWN');
    assert.equal((await store.tasks.steps(operation.jobId))[0]?.progress.likes, 0);
  });
});
test('restart retains binding and uncertainty; migration from schema 2 backs up and preserves existing plans', async () => {
  await fixture(async (store, file) => {
    const { runtime, contexts } = await setup(store);
    const profile = runtime[0];
    assert.ok(profile);
    const operation = await bound(store, session(contexts, profile.id));
    const restarted = await WorkspaceStore.open(file);
    try {
      restarted.tasks.recoverOnStartup();
      assert.deepEqual(restarted.tasks.operations(operation.jobId)[0]?.binding, operation.binding);
      assert.equal(restarted.tasks.operations(operation.jobId)[0]?.status, 'UNKNOWN');
      assert.equal(restarted.tasks.get(operation.jobId).state, 'REVIEW');
      assert.equal(
        restarted.tasks.takeBoundOperation({
          ...execution(operation.binding),
          leaseId: randomUUID(),
        }),
        null,
      );
    } finally {
      restarted.close();
    }
  });
  await fixture(async (store, file) => {
    const { operations } = await setup(store);
    const operation = operations[0];
    assert.ok(operation);
    const seed = new DatabaseSync(file);
    seed.exec(
      dropControlSchema +
        'DROP TRIGGER immutable_settlement_notice; DROP TRIGGER retain_settlement_notice; DROP TABLE task_settlement_delivery; DROP TABLE task_settlement_notices; DROP TRIGGER immutable_task_tab_proof; DROP TRIGGER retain_task_tab_proof; DROP TABLE task_tab_state; DROP TABLE task_tab_ownership; DROP TRIGGER immutable_dispatch_binding; DROP TRIGGER retain_dispatch_binding; DROP TABLE task_dispatch_bindings; PRAGMA user_version=2',
    );
    seed.close();
    const upgraded = await WorkspaceStore.open(file);
    try {
      assert.equal(upgraded.tasks.get(operation.jobId).state, 'RUNNING');
      assert.equal(upgraded.tasks.operations(operation.jobId)[0]?.binding, null);
      const backupName = (await readdir(path.dirname(file))).find((name) =>
        name.includes(latestMigrationBackupMarker),
      );
      assert.ok(backupName);
      const backup = new DatabaseSync(path.join(path.dirname(file), backupName), {
        readOnly: true,
      });
      try {
        assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 2);
        assert.equal(backup.prepare('SELECT count(*) AS count FROM task_plans').get()?.count, 1);
      } finally {
        backup.close();
      }
    } finally {
      upgraded.close();
    }
  });
});

test('uncertain send during a pending stop retains the current control request until actual confirmation', async () => {
  await fixture(async (store) => {
    const { runtime, contexts } = await setup(store);
    const profile = runtime[0];
    assert.ok(profile);
    const operation = await bound(store, session(contexts, profile.id));
    const stopping = await store.tasks.requestControl(operation.jobId, 'pause');
    assert.ok(stopping.controlRequestId);
    await store.tasks.markBoundUnknown(operation.binding, 'STOP_INTERRUPTED_SDK_WAIT');
    assert.equal((await store.tasks.get(operation.jobId)).state, 'PAUSING');
    assert.equal(
      (await store.tasks.get(operation.jobId)).controlRequestId,
      stopping.controlRequestId,
    );
    await store.tasks.confirmControl(operation.jobId, stopping.controlRequestId);
    assert.equal((await store.tasks.get(operation.jobId)).state, 'REVIEW');
    assert.equal((await store.tasks.get(operation.jobId)).controlConfirmed, true);
    await store.tasks.reconcileBound(receipt(operation.binding), 'NOT_APPLIED');
    assert.equal((await store.tasks.get(operation.jobId)).state, 'PAUSED');
  });
});
