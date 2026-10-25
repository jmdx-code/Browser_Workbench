import {
  latestMigrationBackupMarker,
  dropStoryPrivacySchema,
} from './fixtures/workspace-schema.js';
import test from 'node:test';
import { dropControlSchema } from './fixtures/control.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import type { RuntimeProfile } from '../src/domain/tasks.js';
import type { ExecutionSession, Binding } from '../src/shared/task-execution.js';
import type { TabProof, KernelState } from '../src/shared/kernel-state.js';
import { taskTabMigration } from '../src/infrastructure/task-tab-migration.js';

async function fixture(run: (store: WorkspaceStore, file: string) => Promise<void> | void) {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-task-tabs-'));
  const file = path.join(dir, 'workspace.sqlite');
  const store = await WorkspaceStore.open(file);
  try {
    await run(store, file);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
async function setup(store: WorkspaceStore) {
  const profile: RuntimeProfile = {
    id: randomUUID(),
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: true,
    account: { state: 'logged-in', id: 'fixture-only-account', name: null, avatar: null },
  };
  const saved = await store.createCombination({
    name: '隔离标签页计划',
    note: '不是FB任务',
    steps: [{ id: randomUUID(), type: 'video', durationMinutes: 1, maxLikes: 1, minLikeCount: 0 }],
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
  });
  await store.tasks.assign(
    {
      requestId: randomUUID(),
      combinationId: saved.id,
      version: saved.version,
      profileIds: [profile.id],
    },
    [profile],
  );
  const plan = await store.tasks.claimNext([profile], new Set(['video']));
  assert.ok(plan);
  const context: ExecutionSession = {
    profileId: profile.id,
    accountId: 'fixture-only-account',
    connectionEpoch: randomUUID(),
    leaseId: randomUUID(),
    generation: 0,
  };
  const proof: TabProof = {
    ownershipId: randomUUID(),
    profileId: profile.id,
    browserSessionEpoch: randomUUID(),
    tabId: 42,
    targetId: 'fixture-native-target',
  };
  return { plan, context, proof, profile };
}
async function operation(
  store: WorkspaceStore,
  jobId: string,
  context: ExecutionSession,
  tabId = 42,
): Promise<Binding> {
  const step = (await store.tasks.steps(jobId))[0];
  assert.ok(step);
  await store.tasks.prepareOperation(jobId, step.id, randomUUID(), {
    kind: 'click',
    tabId,
    documentEpoch: 0,
    routeEpoch: 0,
    target: { css: '#counter' },
  });
  const op = await store.tasks.takeBoundOperation(context);
  assert.ok(op?.binding);
  return op.binding;
}
function inventory(proof: TabProof, state: 'READY' | 'CLOSED' = 'CLOSED'): KernelState {
  return {
    version: 1,
    profileId: proof.profileId,
    browserSessionEpoch: proof.browserSessionEpoch,
    operations: [],
    tabs: [
      {
        ownershipId: proof.ownershipId,
        url: 'http://127.0.0.1:18767/kernel-fixture',
        state,
        proof,
        reason: 'native-observed',
      },
    ],
  };
}

test('child lifecycle is persisted only against an acknowledged operation and exact ready parent', async () => {
  await fixture(async (store) => {
    const { plan, proof, context } = await setup(store);
    await store.taskTabs.register(plan.id, proof, context);
    const binding = await operation(store, plan.id, context);
    const ownershipId = randomUUID();
    const requested = {
      version: 1 as const,
      role: 'publication-result' as const,
      ownershipId,
      parent: proof,
      child: null,
      state: 'REQUESTED' as const,
    };
    await assert.rejects(
      async () => await store.tasks.noteChildPageLifecycle(binding, requested),
      /ORIGINAL_CONTEXT_REQUIRED/,
    );
    await store.tasks.acknowledgeBound({ binding, evidence: {} });
    await store.tasks.noteChildPageLifecycle(binding, requested);
    const child = { ...proof, ownershipId, tabId: 43, targetId: 'child-target' };
    await store.tasks.noteChildPageLifecycle(binding, { ...requested, state: 'READY', child });
    await store.tasks.noteChildPageLifecycle(binding, { ...requested, state: 'CLOSED', child });
    assert.deepEqual(
      (await store.tasks.events(plan.id))
        .filter((row) => row.type.startsWith('CHILD_PAGE_'))
        .map((row) => row.type),
      ['CHILD_PAGE_REQUESTED', 'CHILD_PAGE_READY', 'CHILD_PAGE_CLOSED'],
    );
    await assert.rejects(
      async () =>
        await store.tasks.noteChildPageLifecycle(binding, {
          ...requested,
          parent: { ...proof, targetId: 'recycled-target' },
        }),
      /ORIGINAL_CONTEXT_REQUIRED/,
    );
    await store.tasks.requestControl(plan.id, 'stop');
    await assert.rejects(
      async () => await store.tasks.noteChildPageLifecycle(binding, requested),
      /ORIGINAL_CONTEXT_REQUIRED/,
    );
    assert.equal(
      (await store.tasks.events(plan.id)).filter((row) => row.type.startsWith('CHILD_PAGE_'))
        .length,
      3,
    );
  });
});

test('confirmed control release retains the native page and permits a later plan without rewriting old evidence', async () => {
  await fixture(async (store) => {
    const { plan, proof, context, profile } = await setup(store);
    const first = await store.taskTabs.register(plan.id, proof, context);
    const stopping = await store.tasks.requestControl(plan.id, 'stop');
    assert.ok(stopping.controlRequestId);
    const binding = {
      ...context,
      jobId: plan.id,
      mode: 'stop' as const,
      requestId: stopping.controlRequestId,
    };
    const receipt = { ...context, requestId: binding.requestId, state: 'stopped' as const };
    await store.taskControls.bind(binding);
    await assert.rejects(
      async () =>
        await store.taskTabs.confirmReleased(
          proof.ownershipId,
          0,
          inventory(proof, 'READY'),
          { ...receipt, leaseId: randomUUID() },
          plan.id,
        ),
      /停止与原页面/,
    );
    assert.deepEqual(await store.taskTabs.get(proof.ownershipId), first);
    const released = await store.taskTabs.confirmReleased(
      proof.ownershipId,
      0,
      inventory(proof, 'READY'),
      receipt,
      plan.id,
    );
    await store.taskControls.confirm(binding, receipt);
    assert.equal(released.state, 'RELEASED');
    assert.equal(released.context, null);
    const saved = (await store.combinations()).find((row) => row.id === plan.combinationId);
    assert.ok(saved?.saved);
    await store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: saved.id,
        version: saved.version,
        profileIds: [profile.id],
      },
      [profile],
    );
    const next = await store.tasks.claimNext([profile], new Set(['video']));
    assert.ok(next);
    const nextContext = { ...context, leaseId: randomUUID(), generation: 1 };
    const current = await store.taskTabs.register(next.id, proof, nextContext);
    assert.equal(current.state, 'READY');
    assert.deepEqual(await store.taskTabs.get(proof.ownershipId, plan.id), released);
    assert.deepEqual(await store.taskTabs.forPlan(next.id), [current]);
    await assert.rejects(async () => await store.taskTabs.get(proof.ownershipId), /指定原任务/);
    await assert.rejects(
      async () =>
        await store.taskTabs.requireRecheck(
          proof.ownershipId,
          released.revision,
          'OLD_CALLBACK',
          plan.id,
        ),
      /不能重新接管/,
    );
    const nextOperation = await operation(store, next.id, nextContext);
    await store.taskTabs.assertForInput(nextOperation, proof);
    await assert.rejects(
      async () => await store.taskTabs.assertForInput({ ...nextOperation, jobId: plan.id }, proof),
      /尚未完成/,
    );
    assert.deepEqual(await store.taskTabs.get(proof.ownershipId, plan.id), released);
  });
});

test('schema23 page evidence and pending operation survive composite association migration with a backup', async () => {
  await fixture(async (store, file) => {
    const { plan, proof, context } = await setup(store);
    const tab = await store.taskTabs.register(plan.id, proof, context);
    const pending = await operation(store, plan.id, context);
    await store.tasks.acknowledgeBound({ binding: pending, evidence: { originalAck: true } });
    const operations = await store.tasks.operations(plan.id);
    const old = new DatabaseSync(file);
    try {
      old.exec('PRAGMA foreign_keys=OFF');
      old.exec(
        'CREATE TEMP TABLE old_page_ownership AS SELECT * FROM task_tab_ownership;CREATE TEMP TABLE old_page_state AS SELECT ownership_id,profile_id,state,revision,context,reason,updated_at FROM task_tab_state',
      );
      old.exec(
        'DROP TRIGGER immutable_task_tab_proof;DROP TRIGGER retain_task_tab_proof;DROP TABLE task_tab_state;DROP TABLE task_tab_ownership',
      );
      old.exec(taskTabMigration);
      old.exec(
        dropStoryPrivacySchema +
          "DROP INDEX one_original_post_background;DROP TABLE workspace_preferences;INSERT INTO task_tab_ownership SELECT * FROM old_page_ownership;INSERT INTO task_tab_state SELECT * FROM old_page_state;DELETE FROM workspace_execution_contracts WHERE name IN ('post-native-background','task-page-lifecycle','post-home-preparation','browse-wheel-visual-anchor');PRAGMA user_version=23",
      );
    } finally {
      old.close();
    }
    const upgraded = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(upgraded.taskTabs.get(proof.ownershipId, plan.id), tab);
      assert.deepEqual(upgraded.tasks.operations(plan.id), operations);
      assert.equal(upgraded.tasks.get(plan.id).state, 'RUNNING');
      assert.ok(
        (await readdir(path.dirname(file))).some((name) =>
          name.includes(latestMigrationBackupMarker),
        ),
      );
    } finally {
      upgraded.close();
    }
  });
});

test('plan-tab original proof persists, duplicate registration does not renew context, SQL forbids rewriting history', async () => {
  await fixture(async (store, file) => {
    const { plan, proof, context } = await setup(store);
    const first = await store.taskTabs.register(plan.id, proof, context);
    assert.deepEqual(
      await store.taskTabs.register(plan.id, proof, { ...context, leaseId: randomUUID() }),
      first,
    );
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(reopened.taskTabs.get(proof.ownershipId), first);
      assert.equal(reopened.tasks.get(plan.id).state, 'RUNNING');
    } finally {
      reopened.close();
    }
    const db = new DatabaseSync(file);
    try {
      assert.throws(
        () => db.prepare('UPDATE task_tab_ownership SET account_id=?').run('other'),
        /IMMUTABLE_TASK_TAB_PROOF/,
      );
      assert.throws(() => db.exec('DELETE FROM task_tab_ownership'), /RETAIN_TASK_TAB_PROOF/);
    } finally {
      db.close();
    }
    await assert.rejects(
      async () =>
        await store.taskTabs.register(plan.id, { ...proof, targetId: 'other-target' }, context),
      /归属ID/,
    );
  });
});
test('plan-tab registration rejects foreign profile/account and non-running plan', async () => {
  await fixture(async (store) => {
    const { plan, proof, context } = await setup(store);
    await assert.rejects(
      async () =>
        await store.taskTabs.register(plan.id, { ...proof, profileId: randomUUID() }, context),
      /资料、账号/,
    );
    await assert.rejects(
      async () =>
        await store.taskTabs.register(plan.id, proof, { ...context, accountId: 'changed-account' }),
      /资料、账号/,
    );
    await store.tasks.requestControl(plan.id, 'pause');
    await assert.rejects(
      async () => await store.taskTabs.register(plan.id, proof, context),
      /资料、账号/,
    );
    assert.equal((await store.taskTabs.forPlan(plan.id)).length, 0);
  });
});
test('two repositories cannot give one profile another active task tab; lost proof remains retained', async () => {
  await fixture(async (store, file) => {
    const { plan, proof, context } = await setup(store);
    await store.taskTabs.register(plan.id, proof, context);
    const other = await WorkspaceStore.open(file);
    try {
      const newProof = {
        ...proof,
        ownershipId: randomUUID(),
        tabId: 43,
        targetId: 'second-native-target',
      };
      assert.throws(() => other.taskTabs.register(plan.id, newProof, context), /已有未释放/);
      await store.taskTabs.markLost(proof.ownershipId, 0, 'NATIVE_TARGET_GONE');
      other.taskTabs.register(plan.id, newProof, context);
      assert.equal(other.taskTabs.forPlan(plan.id).length, 2);
      assert.equal(other.taskTabs.get(proof.ownershipId).state, 'LOST');
    } finally {
      other.close();
    }
  });
});
test('explicit recovery invalidates input context, exact proof confirmation does not resume paused plan', async () => {
  await fixture(async (store) => {
    const { plan, proof, context } = await setup(store);
    await store.taskTabs.register(plan.id, proof, context);
    await store.tasks.recoverOnStartup();
    await store.taskTabs.recoverOnStartup();
    const pending = await store.taskTabs.get(proof.ownershipId);
    assert.equal(pending.state, 'RECHECK_REQUIRED');
    assert.equal(pending.context, null);
    assert.deepEqual(pending.proof, proof);
    const fresh = { ...context, connectionEpoch: randomUUID(), leaseId: randomUUID() };
    await store.taskTabs.confirmObserved(proof.ownershipId, pending.revision, proof, fresh);
    assert.equal((await store.tasks.get(plan.id)).state, 'PAUSED');
    await store.tasks.resume(plan.id);
    await store.tasks.claimNext([setupRuntime(proof.profileId)], new Set(['video']));
    const binding = await operation(store, plan.id, fresh);
    await assert.doesNotReject(async () => await store.taskTabs.assertForInput(binding, proof));
    await assert.rejects(
      async () =>
        await store.taskTabs.assertForInput({ ...binding, leaseId: context.leaseId }, proof),
      /尚未完成/,
    );
  });
});
function setupRuntime(id: string): RuntimeProfile {
  return {
    id,
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: true,
    account: { state: 'logged-in', id: 'fixture-only-account', name: null, avatar: null },
  };
}
test('same tab ID with another native target/browser session cannot be adopted; stale revisions cannot overwrite observation', async () => {
  await fixture(async (store) => {
    const { plan, proof, context } = await setup(store);
    await store.taskTabs.register(plan.id, proof, context);
    await store.taskTabs.requireRecheck(proof.ownershipId, 0, 'DISCONNECTED');
    for (const changed of [
      { ...proof, targetId: 'reused-tab-other-target' },
      { ...proof, browserSessionEpoch: randomUUID() },
      { ...proof, tabId: 43 },
    ])
      await assert.rejects(
        async () => await store.taskTabs.confirmObserved(proof.ownershipId, 1, changed, context),
        /不能接管/,
      );
    await assert.rejects(
      async () => await store.taskTabs.confirmObserved(proof.ownershipId, 0, proof, context),
      /记录已变化/,
    );
    assert.equal((await store.taskTabs.get(proof.ownershipId)).state, 'RECHECK_REQUIRED');
    assert.deepEqual((await store.taskTabs.get(proof.ownershipId)).proof, proof);
  });
});
test('closure requires exact native CLOSED inventory; closed/lost records cannot revive', async () => {
  await fixture(async (store) => {
    const { plan, proof, context } = await setup(store);
    await store.taskTabs.register(plan.id, proof, context);
    await assert.rejects(
      async () =>
        await store.taskTabs.confirmClosed(proof.ownershipId, 0, inventory(proof, 'READY')),
      /关闭证据/,
    );
    await assert.rejects(
      async () =>
        await store.taskTabs.confirmClosed(
          proof.ownershipId,
          0,
          inventory({ ...proof, targetId: 'different' }),
        ),
      /关闭证据/,
    );
    await store.taskTabs.confirmClosed(proof.ownershipId, 0, inventory(proof));
    await assert.rejects(
      async () => await store.taskTabs.confirmObserved(proof.ownershipId, 1, proof, context),
      /不能重新接管/,
    );
    assert.equal((await store.taskTabs.register(plan.id, proof, context)).state, 'CLOSED');
    const lost = { ...proof, ownershipId: randomUUID(), tabId: 43, targetId: 'lost-target' };
    await store.taskTabs.register(plan.id, lost, context);
    await store.taskTabs.markLost(lost.ownershipId, 0, 'TARGET_CHANGED');
    await assert.rejects(
      async () => await store.taskTabs.confirmObserved(lost.ownershipId, 1, lost, context),
      /不能重新接管/,
    );
  });
});
test('unresolved ACK/UNKNOWN prevents ownership release and replacement; result is not cleared to recover a tab', async () => {
  await fixture(async (store) => {
    const { plan, proof, context } = await setup(store);
    await store.taskTabs.register(plan.id, proof, context);
    const binding = await operation(store, plan.id, context);
    await store.tasks.acknowledgeBound({ binding, evidence: { sdkReturned: true } });
    await assert.rejects(
      async () => await store.taskTabs.confirmClosed(proof.ownershipId, 0, inventory(proof)),
      /未决操作/,
    );
    await store.tasks.markBoundUnknown(binding, 'NATIVE_RESULT_UNKNOWN');
    await store.taskTabs.markLost(proof.ownershipId, 0, 'TARGET_GONE');
    await assert.rejects(
      async () =>
        await store.taskTabs.register(plan.id, { ...proof, ownershipId: randomUUID() }, context),
      /状态不允许/,
    );
    assert.equal((await store.tasks.operations(plan.id))[0]?.status, 'UNKNOWN');
    assert.deepEqual((await store.taskTabs.get(proof.ownershipId)).proof, proof);
  });
});

test('confirmed end plus retained native CLOSED across a browser epoch releases only ownership, preserving UNKNOWN', async () => {
  await fixture(async (store) => {
    const { plan, proof, context, profile } = await setup(store);
    await store.taskTabs.register(plan.id, proof, context);
    const binding = await operation(store, plan.id, context);
    await store.tasks.markBoundUnknown(binding, 'LOST_BUSINESS_RESULT');
    const requestId = await store.tasks.requestEnd(plan.id);
    const stop = {
      profileId: profile.id,
      connectionEpoch: context.connectionEpoch,
      requestId,
      state: 'stopped' as const,
    };
    await store.tasks.prepareEnd(plan.id, stop);
    await assert.rejects(
      async () => await store.taskTabs.confirmClosed(proof.ownershipId, 0, inventory(proof)),
      /未决操作/,
    );
    const notice = await store.tasks.settlements.claim(profile.id);
    assert.ok(notice?.claimToken);
    await store.tasks.settlements.delivered(notice.binding.operationId, notice.claimToken, {
      binding: notice.binding,
      resolution: notice.resolution,
    });
    await store.tasks.finishEnd(plan.id, stop);
    const operations = await store.tasks.operations(plan.id);
    const historicalPlan = await store.tasks.get(plan.id);
    assert.equal(historicalPlan.controlConfirmed, false);
    assert.equal(operations[0]?.status, 'UNKNOWN');
    await assert.rejects(
      async () =>
        await store.taskTabs.confirmClosed(proof.ownershipId, 0, inventory(proof, 'READY')),
      /关闭证据/,
    );
    const closed = await store.taskTabs.confirmClosed(proof.ownershipId, 0, {
      ...inventory(proof),
      browserSessionEpoch: randomUUID(),
    });
    assert.equal(closed.state, 'CLOSED');
    assert.deepEqual(await store.tasks.operations(plan.id), operations);
    assert.deepEqual(await store.tasks.get(plan.id), historicalPlan);
    await store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: plan.combinationId,
        version: plan.version,
        profileIds: [profile.id],
      },
      [profile],
    );
    const next = await store.tasks.claimNext([profile], new Set(['video']));
    assert.ok(next);
    assert.equal(
      (
        await store.taskTabs.register(
          next.id,
          { ...proof, ownershipId: randomUUID(), targetId: 'next-owned-target', tabId: 43 },
          { ...context, leaseId: randomUUID() },
        )
      ).state,
      'READY',
    );
  });
});

test('finished ending can release lost or absent historical ownership without inventing CLOSED or settling UNKNOWN', async () => {
  for (const absent of [false, true])
    await fixture(async (store) => {
      const { plan, proof, context, profile } = await setup(store);
      await store.taskTabs.register(plan.id, proof, context);
      const binding = await operation(store, plan.id, context);
      await store.tasks.markBoundUnknown(binding, 'UNKNOWN_RETAINED');
      const lost = {
        ...inventory(proof),
        tabs: absent
          ? []
          : inventory(proof).tabs.map((tab) => ({ ...tab, state: 'LOST' as const })),
      };
      await assert.rejects(
        async () => await store.taskTabs.confirmEndedLost(proof.ownershipId, 0, lost),
        /结束处置/,
      );
      const requestId = await store.tasks.requestEnd(plan.id);
      const stop = {
        profileId: profile.id,
        connectionEpoch: context.connectionEpoch,
        requestId,
        state: 'stopped' as const,
      };
      await store.tasks.prepareEnd(plan.id, stop);
      await assert.rejects(
        async () => await store.taskTabs.confirmEndedLost(proof.ownershipId, 0, lost),
        /结束处置/,
      );
      const notice = await store.tasks.settlements.claim(profile.id);
      assert.ok(notice?.claimToken);
      await store.tasks.settlements.delivered(notice.binding.operationId, notice.claimToken, {
        binding: notice.binding,
        resolution: notice.resolution,
      });
      await store.tasks.finishEnd(plan.id, stop);
      await assert.rejects(
        async () =>
          await store.taskTabs.confirmEndedLost(proof.ownershipId, 0, inventory(proof, 'READY')),
        /控制/,
      );
      await assert.rejects(
        async () =>
          await store.taskTabs.confirmEndedLost(proof.ownershipId, 0, {
            ...lost,
            profileId: randomUUID(),
          }),
        /控制|PROFILE_MISMATCH/,
      );
      const before = await store.tasks.operations(plan.id);
      const released = await store.taskTabs.confirmEndedLost(proof.ownershipId, 0, lost);
      assert.equal(released.state, 'LOST');
      assert.equal(released.context, null);
      assert.deepEqual(released.proof, proof);
      assert.deepEqual(await store.tasks.operations(plan.id), before);
      assert.equal((await store.tasks.get(plan.id)).controlConfirmed, false);
      await assert.rejects(
        async () =>
          await store.taskTabs.confirmObserved(
            proof.ownershipId,
            released.revision,
            proof,
            context,
          ),
        /不能重新接管/,
      );
    });
});
test('input guard binds current outbox/action/step/proof and stops during control or connection recheck', async () => {
  await fixture(async (store) => {
    const { plan, proof, context } = await setup(store);
    await store.taskTabs.register(plan.id, proof, context);
    const binding = await operation(store, plan.id, context);
    await assert.doesNotReject(async () => await store.taskTabs.assertForInput(binding, proof));
    await assert.rejects(
      async () =>
        await store.taskTabs.assertForInput({ ...binding, actionDigest: 'a'.repeat(64) }, proof),
      /不允许当前/,
    );
    await assert.rejects(
      async () => await store.taskTabs.assertForInput({ ...binding, stepId: randomUUID() }, proof),
      /不允许当前/,
    );
    await assert.rejects(
      async () => await store.taskTabs.assertForInput(binding, { ...proof, targetId: 'other' }),
      /尚未完成/,
    );
    await store.taskTabs.requireRecheck(proof.ownershipId, 0, 'DISCONNECTED');
    await assert.rejects(
      async () => await store.taskTabs.assertForInput(binding, proof),
      /尚未完成/,
    );
    await store.taskTabs.confirmObserved(proof.ownershipId, 1, proof, context);
    await store.tasks.requestControl(plan.id, 'pause');
    await assert.rejects(
      async () => await store.taskTabs.assertForInput(binding, proof),
      /不允许当前/,
    );
  });
});
test('schema 3 to latest backs up before migration and preserves existing plan, binding and combination without recovery', async () => {
  await fixture(async (store, file) => {
    const { plan, context } = await setup(store);
    const binding = await operation(store, plan.id, context);
    const db = new DatabaseSync(file);
    db.exec(
      dropControlSchema +
        'DROP TRIGGER immutable_settlement_notice; DROP TRIGGER retain_settlement_notice; DROP TABLE task_settlement_delivery; DROP TABLE task_settlement_notices; DROP TRIGGER immutable_task_tab_proof; DROP TRIGGER retain_task_tab_proof; DROP TABLE task_tab_state; DROP TABLE task_tab_ownership; PRAGMA user_version=3',
    );
    db.close();
    const migrated = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(migrated.tasks.get(plan.id), await store.tasks.get(plan.id));
      assert.deepEqual(migrated.tasks.operations(plan.id)[0]?.binding, binding);
      assert.equal(migrated.tasks.operations(plan.id)[0]?.status, 'DISPATCHING');
      assert.deepEqual(migrated.combinations(), await store.combinations());
      assert.deepEqual(migrated.taskTabs.forPlan(plan.id), []);
      const name = (await readdir(path.dirname(file))).find((row) =>
        row.includes(latestMigrationBackupMarker),
      );
      assert.ok(name);
      const backup = new DatabaseSync(path.join(path.dirname(file), name), { readOnly: true });
      try {
        assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 3);
        assert.equal(
          backup.prepare('SELECT count(*) AS count FROM task_dispatch_bindings').get()?.count,
          1,
        );
      } finally {
        backup.close();
      }
    } finally {
      migrated.close();
    }
  });
});
