import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import type { RuntimeProfile } from '../src/domain/tasks.js';
import type { Combination } from '../src/shared/contracts.js';
import { AssignTasks, TaskPlan } from '../src/shared/task-contracts.js';
import { TaskResourceSnapshot } from '../src/shared/task-resources.js';
import { emptyResourceRow } from '../src/domain/resource-table.js';
import {
  dropTaskResourceSchema,
  latestMigrationBackupMarker,
} from './fixtures/workspace-schema.js';
const profiles = (count: number): RuntimeProfile[] =>
  Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: true,
    account: {
      state: 'logged-in',
      id: 'generated-fixture-account-' + index,
      name: null,
      avatar: null,
    },
  }));
const combination = (table = true): Combination => ({
  name: '固定资源测试',
  note: '生成fixture，不执行FB',
  steps: [
    {
      id: randomUUID(),
      type: 'post',
      ...(table ? { resourceMode: 'table' as const } : {}),
      resourceDirectory: table ? '' : 'D:\\生成',
      count: 1,
      allowRepeat: false,
      forbidSameAccountRepeat: true,
      archivePublished: true,
    },
  ],
  randomOrder: false,
  loop: { mode: 'finite', rounds: 2 },
});
const textRow = (text: string) => ({ ...emptyResourceRow(randomUUID()), text });

test('ended resource-table plans can be physically cleaned without losing the original resource version', async () =>
  fixture(async (store, file) => {
    const saved = store.createCombination(combination());
    store.resourceTables.save(saved.id, 0, [textRow('原始素材保留')]);
    const runtime = profiles(1);
    const plan = store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: saved.id,
        version: saved.version,
        expectedResourceRevision: 1,
        profileIds: runtime.map((p) => p.id),
      },
      runtime,
    )[0];
    assert.ok(plan);
    store.tasks.requestControl(plan.id, 'stop');
    const steps = store.tasks.steps(plan.id);
    assert.equal(store.dataCleanup.removeBatch({ stepIds: steps.map((s) => s.id) }), steps.length);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(
        db.prepare('SELECT count(*) n FROM task_resource_bindings WHERE job_id=?').get(plan.id)?.n,
        0,
      );
      assert.equal(db.prepare('SELECT count(*) n FROM task_plans WHERE id=?').get(plan.id)?.n, 0);
      assert.equal(store.resourceTables.readVersion(saved.id, 1).rows[0]?.text, '原始素材保留');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      db.close();
    }
  }));
async function fixture(run: (store: WorkspaceStore, file: string) => Promise<void> | void) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-task-resources-')),
    file = path.join(dir, 'workspace.sqlite');
  const store = await WorkspaceStore.open(file);
  try {
    await run(store, file);
  } finally {
    store.close();
    assert.equal(path.dirname(dir), tmpdir());
    assert.ok(path.basename(dir).startsWith('wb-task-resources-'));
    await rm(dir, { recursive: true, force: true });
  }
}

test('50 original queued plans pin one immutable resource version atomically; edits and idempotent replay retain original rows', async () =>
  fixture(async (store, file) => {
    const saved = await store.createCombination(combination()),
      runtime = profiles(50);
    const original = await store.resourceTables.save(saved.id, 0, [
      textRow('第一版'),
      textRow('第二条'),
    ]);
    const input = {
      requestId: randomUUID(),
      combinationId: saved.id,
      version: saved.version,
      profileIds: runtime.map((profile) => profile.id),
      expectedResourceRevision: 1,
    };
    const plans = await store.tasks.assign(input, runtime);
    assert.equal(plans.length, 50);
    for (const plan of plans) {
      assert.equal(plan.state, 'QUEUED');
      assert.equal(TaskPlan.safeParse(plan).success, true);
      const fixed = await store.tasks.resources.snapshot(plan.id);
      assert.deepEqual(fixed.table, original);
      assert.equal(fixed.binding.resourceRevision, 1);
      assert.deepEqual(
        (await store.tasks.events(plan.id)).find((event) => event.type === 'ASSIGNED')?.detail,
        { version: 1, resourceRevision: 1 },
      );
    }
    await store.resourceTables.save(saved.id, 1, [textRow('编辑后的资源')]);
    assert.deepEqual(
      await store.tasks.assign({ ...input, profileIds: [...input.profileIds].reverse() }, runtime),
      plans,
    );
    assert.deepEqual((await store.tasks.resources.snapshot(plans[0]?.id ?? '')).table, original);
    await assert.rejects(
      async () => await store.tasks.assign({ ...input, expectedResourceRevision: 2 }, runtime),
      /提交标识/,
    );
    const copy = await store.tasks.resources.snapshot(plans[0]?.id ?? '');
    copy.table.rows.length = 0;
    assert.equal((await store.tasks.resources.snapshot(plans[0]?.id ?? '')).table.rows.length, 2);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM task_resource_bindings').get()?.n, 50);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM material_reservations').get()?.n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM task_outbox').get()?.n, 0);
    } finally {
      db.close();
    }
  }));

test('missing/stale/empty versions reject before batch mutation; resource version parameters cannot attach to directory-only plans', async () =>
  fixture(async (store, file) => {
    const saved = await store.createCombination(combination()),
      runtime = profiles(1),
      input = {
        requestId: randomUUID(),
        combinationId: saved.id,
        version: saved.version,
        profileIds: runtime.map((profile) => profile.id),
      };
    await assert.rejects(async () => await store.tasks.assign(input, runtime), /明确资源表版本/);
    await assert.rejects(
      async () => await store.tasks.assign({ ...input, expectedResourceRevision: 1 }, runtime),
      /资源表已修改/,
    );
    await store.resourceTables.save(saved.id, 0, [textRow('')]);
    await assert.rejects(
      async () => await store.tasks.assign({ ...input, expectedResourceRevision: 1 }, runtime),
      /没有可分配/,
    );
    await store.resourceTables.save(saved.id, 1, [textRow('资源')]);
    await assert.rejects(
      async () => await store.tasks.assign({ ...input, expectedResourceRevision: 1 }, runtime),
      /资源表已修改/,
    );
    const legacy = await store.createCombination(combination(false));
    await assert.rejects(
      async () =>
        await store.tasks.assign(
          { ...input, combinationId: legacy.id, expectedResourceRevision: 2 },
          runtime,
        ),
      /没有资源表发布步骤/,
    );
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      for (const name of [
        'task_batches',
        'task_plans',
        'task_steps',
        'task_events',
        'task_resource_bindings',
      ])
        assert.equal(db.prepare('SELECT COUNT(*) n FROM ' + name).get()?.n, 0, name);
    } finally {
      db.close();
    }
  }));

test('failure during second resource binding rolls back the entire original assignment, events and steps', async () =>
  fixture(async (store, file) => {
    const saved = await store.createCombination(combination()),
      runtime = profiles(2);
    await store.resourceTables.save(saved.id, 0, [textRow('资源')]);
    const db = new DatabaseSync(file);
    db.exec(
      "CREATE TRIGGER injected_pin_failure BEFORE INSERT ON task_resource_bindings WHEN (SELECT COUNT(*) FROM task_resource_bindings)=1 BEGIN SELECT RAISE(ABORT,'INJECTED_PIN_FAILURE'); END",
    );
    try {
      await assert.rejects(
        async () =>
          await store.tasks.assign(
            {
              requestId: randomUUID(),
              combinationId: saved.id,
              version: 1,
              profileIds: runtime.map((profile) => profile.id),
              expectedResourceRevision: 1,
            },
            runtime,
          ),
        /INJECTED_PIN_FAILURE/,
      );
      for (const name of [
        'task_batches',
        'task_plans',
        'task_steps',
        'task_events',
        'task_resource_bindings',
      ])
        assert.equal(db.prepare('SELECT COUNT(*) n FROM ' + name).get()?.n, 0, name);
    } finally {
      db.close();
    }
  }));

test('binding SQL immutability and lineage guards retain originals and reject cross-combination, stale head and forged timestamp', async () =>
  fixture(async (store, file) => {
    const saved = await store.createCombination(combination()),
      other = await store.createCombination(combination()),
      runtime = profiles(1);
    await store.resourceTables.save(saved.id, 0, [textRow('资源')]);
    await store.resourceTables.save(other.id, 0, [textRow('其他')]);
    const plan = (
      await store.tasks.assign(
        {
          requestId: randomUUID(),
          combinationId: saved.id,
          version: 1,
          profileIds: runtime.map((profile) => profile.id),
          expectedResourceRevision: 1,
        },
        runtime,
      )
    )[0];
    assert.ok(plan);
    await assert.rejects(
      async () => await store.tasks.resources.insert(plan, 1),
      /TRANSACTION_REQUIRED/,
    );
    const db = new DatabaseSync(file);
    try {
      assert.throws(
        () =>
          db
            .prepare('UPDATE task_resource_bindings SET resource_revision=2 WHERE job_id=?')
            .run(plan.id),
        /IMMUTABLE/,
      );
      assert.throws(
        () => db.prepare('DELETE FROM task_resource_bindings WHERE job_id=?').run(plan.id),
        /RETAIN/,
      );
      assert.throws(
        () =>
          db
            .prepare('INSERT INTO task_resource_bindings VALUES(?,?,?,?)')
            .run(plan.id, other.id, 1, plan.createdAt),
        /ASSIGNMENT_MISMATCH/,
      );
      assert.throws(
        () =>
          db
            .prepare('INSERT INTO task_resource_bindings VALUES(?,?,?,?)')
            .run(plan.id, saved.id, 1, plan.createdAt + 1),
        /ASSIGNMENT_MISMATCH/,
      );
      await store.resourceTables.save(saved.id, 1, [textRow('新资源')]);
      assert.throws(
        () =>
          db
            .prepare('INSERT INTO task_resource_bindings VALUES(?,?,?,?)')
            .run(plan.id, saved.id, 1, plan.createdAt),
        /ASSIGNMENT_MISMATCH/,
      );
      assert.equal((await store.tasks.resources.snapshot(plan.id)).table.rows[0]?.text, '资源');
    } finally {
      db.close();
    }
  }));

test('resource pin is not source verification or executable capability; queued table plans never acquire account locks', async () =>
  fixture(async (store, file) => {
    const saved = await store.createCombination(combination()),
      runtime = profiles(1);
    await store.resourceTables.save(saved.id, 0, [textRow('未核验文字')]);
    const plan = (
      await store.tasks.assign(
        {
          requestId: randomUUID(),
          combinationId: saved.id,
          version: 1,
          profileIds: runtime.map((profile) => profile.id),
          expectedResourceRevision: 1,
        },
        runtime,
      )
    )[0];
    assert.ok(plan);
    assert.equal(await store.tasks.claimNext(runtime, new Set(['post'])), null);
    assert.equal((await store.tasks.get(plan.id)).reason, 'RESOURCE_TABLE_EXECUTOR_REQUIRED');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM task_account_locks').get()?.n, 0);
    } finally {
      db.close();
    }
  }));

test('legacy directory assignment remains compatible and has no fabricated resource binding', async () =>
  fixture(async (store) => {
    const saved = await store.createCombination(combination(false)),
      runtime = profiles(1);
    const plan = (
      await store.tasks.assign(
        {
          requestId: randomUUID(),
          combinationId: saved.id,
          version: 1,
          profileIds: runtime.map((profile) => profile.id),
        },
        runtime,
      )
    )[0];
    assert.ok(plan);
    assert.equal(await store.tasks.resources.binding(plan.id), null);
    await assert.rejects(
      async () => await store.tasks.resources.snapshot(plan.id),
      /不能按最新资源补配/,
    );
    assert.equal((await store.tasks.claimNext(runtime, new Set(['post'])))?.id, plan.id);
  }));

test('migration13 to14 backs up originals without backfilling historical plans from the current head', async () =>
  fixture(async (store, file) => {
    const saved = await store.createCombination(combination()),
      runtime = profiles(1);
    await store.resourceTables.save(saved.id, 0, [textRow('原资源')]);
    const plan = (
      await store.tasks.assign(
        {
          requestId: randomUUID(),
          combinationId: saved.id,
          version: 1,
          profileIds: runtime.map((profile) => profile.id),
          expectedResourceRevision: 1,
        },
        runtime,
      )
    )[0];
    assert.ok(plan);
    await store.resourceTables.save(saved.id, 1, [textRow('此后最新资源')]);
    const db = new DatabaseSync(file);
    db.exec(dropTaskResourceSchema + 'PRAGMA user_version=13');
    const batch = db.prepare('SELECT request FROM task_batches WHERE id=?').get(plan.batchId);
    assert.ok(batch);
    const original = AssignTasks.parse(JSON.parse(String(batch.request)) as unknown);
    delete original.expectedResourceRevision;
    db.prepare('UPDATE task_batches SET request=? WHERE id=?').run(
      JSON.stringify(original),
      plan.batchId,
    );
    const definitions = db
      .prepare('SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name')
      .all();
    db.close();
    const upgraded = await WorkspaceStore.open(file);
    try {
      assert.equal(upgraded.tasks.resources.binding(plan.id), null);
      assert.equal(upgraded.tasks.claimNext(runtime, new Set(['post'])), null);
      assert.equal(upgraded.tasks.get(plan.id).reason, 'RESOURCE_BINDING_REQUIRED');
      assert.equal(upgraded.resourceTables.revision(saved.id), 2);
      const actual = new DatabaseSync(file, { readOnly: true });
      try {
        for (const definition of definitions) assertSchemaDefinitionPreserved(actual, definition);
        assert.equal(
          actual.prepare('PRAGMA user_version').get()?.user_version,
          workspaceSchemaVersion,
        );
      } finally {
        actual.close();
      }
      const backups = (await readdir(path.dirname(file))).filter((name) =>
        name.includes(latestMigrationBackupMarker),
      );
      assert.equal(backups.length, 1);
      const backup = new DatabaseSync(path.join(path.dirname(file), backups[0] ?? ''), {
        readOnly: true,
      });
      try {
        assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 13);
      } finally {
        backup.close();
      }
    } finally {
      upgraded.close();
    }
  }));

test('fixed-resource contracts require exact combination/revision matching and reject fake readiness fields', () => {
  const id = randomUUID(),
    binding = { jobId: randomUUID(), combinationId: id, resourceRevision: 1, createdAt: 0 },
    table = { combinationId: id, revision: 1, updatedAt: 0, rows: [], publishingReady: false };
  assert.equal(TaskResourceSnapshot.safeParse({ binding, table }).success, true);
  assert.equal(
    TaskResourceSnapshot.safeParse({ binding, table: { ...table, revision: 2 } }).success,
    false,
  );
  assert.equal(
    TaskResourceSnapshot.safeParse({ binding, table: { ...table, combinationId: randomUUID() } })
      .success,
    false,
  );
  assert.equal(
    TaskResourceSnapshot.safeParse({ binding, table, sourceVerified: true }).success,
    false,
  );
});
import { assertSchemaDefinitionPreserved } from './fixtures/workspace-schema.js';
