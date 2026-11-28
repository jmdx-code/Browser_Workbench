import { SqliteTaskRepository } from '../src/infrastructure/task-store.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import { TaskService } from '../src/application/task-service.js';
import { readSnapshot, transaction } from '../src/infrastructure/sqlite-transaction.js';
import type { RuntimeProfile } from '../src/domain/tasks.js';
import type { TaskRecord } from '../src/shared/task-contracts.js';
import { DataCleanupService } from '../src/application/data-cleanup.js';

function groupTaskRecords(records: readonly TaskRecord[]) {
  const byPlan = new Map<string, TaskRecord[]>();
  for (const r of records) {
    const arr = byPlan.get(r.planId) ?? [];
    arr.push(r);
    byPlan.set(r.planId, arr);
  }
  return [...byPlan.entries()].map(([planId, items]) => ({
    planId,
    state: items[0]!.planState,
    completed: items.filter((x) => x.status === 'COMPLETED').length,
  }));
}
import { cleanupDateEnd } from '../src/shared/data-cleanup.js';

async function fixture(
  run: (store: WorkspaceStore, db: DatabaseSync, file: string) => Promise<void> | void,
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-read-model-'));
  const file = path.join(dir, 'workspace.sqlite');
  const store = await WorkspaceStore.open(file);
  try {
    await run(store, (store as unknown as { db: DatabaseSync }).db, file);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
function seed(store: WorkspaceStore, count = 3, mixed = false, repository = store.tasks) {
  const profiles: RuntimeProfile[] = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: true,
    account: { state: 'logged-in', id: `account-${i}`, name: `账号${i}`, avatar: null },
  }));
  const saved = store.createCombination({
    name: '组合 · 搜索 Alpha',
    note: 'test',
    steps: Array.from({ length: 3 }, (_, index) => ({
      id: randomUUID(),
      ...(mixed && index === 2
        ? { type: 'marketplace' as const, keyword: '' }
        : { type: 'feed' as const }),
      durationMinutes: 1,
      maxLikes: 0,
      minLikeCount: 0,
    })),
    randomOrder: false,
    loop: { mode: 'until-stopped' },
  });
  const plans = repository.assign(
    {
      requestId: randomUUID(),
      combinationId: saved.id,
      version: saved.version,
      profileIds: profiles.map((x) => x.id),
    },
    profiles,
  );
  return { profiles, plans };
}

test('run pagination keeps all steps together across filters, boundaries and stopped pending siblings', async () => {
  await fixture(async (store, db) => {
    const { plans } = seed(store, 4, true);
    transaction(db, () => {
      for (const plan of plans)
        db.prepare("UPDATE task_steps SET status='COMPLETED' WHERE job_id=? AND position<2").run(
          plan.id,
        );
    });
    for (const plan of plans) store.tasks.stopPlanDirect(plan.id, 'USER_STOP');
    const service = new TaskService(store.tasks);
    const seen: TaskRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.records({
        groupBy: 'run',
        limit: 3,
        ...(cursor ? { cursor } : {}),
      });
      assert.equal(page.records.length, 3);
      assert.deepEqual(
        page.records.map((r) => r.position),
        [0, 1, 2],
      );
      assert.equal(page.total, 12);
      seen.push(...page.records);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(new Set(seen.map((r) => r.stepId)).size, 12);
    assert.equal(groupTaskRecords(seen).length, 4);
    assert.ok(groupTaskRecords(seen).every((g) => g.completed === 2 && g.state === 'STOPPED'));
    const allStatus = await service.records({ groupBy: 'run', status: 'all' });
    assert.equal(allStatus.counts.all, 12);
    assert.equal(allStatus.counts.completed, 8);
    assert.equal(allStatus.counts.running, 0);
    // Search by query + profileId returns matching plan records.
    const plan = plans[0]!;
    const searched = await service.records({
      groupBy: 'run',
      query: 'Alpha',
      profileId: plan.profileId,
    });
    assert.equal(searched.total, 3);
    assert.equal(searched.records.length, 3);
  });
});

test('selected-day cleanup includes afternoon records and expands pending siblings in preview and execution', async () => {
  await fixture(async (store, db) => {
    const { plans } = seed(store, 1);
    const plan = plans[0]!;
    const steps = store.tasks.steps(plan.id);
    transaction(db, () => {
      db.prepare("UPDATE task_steps SET status='COMPLETED' WHERE id=?").run(steps[0]!.id);
    });
    store.tasks.stopPlanDirect(plan.id, 'USER_STOP');
    transaction(db, () => {
      db.prepare('UPDATE task_plans SET updated_at=? WHERE id=?').run(
        new Date('2026-10-26T15:30:00').getTime(),
        plan.id,
      );
    });
    const cutoff = cleanupDateEnd('2026-10-26');
    assert.equal(new Date(cutoff).getHours(), 23);
    assert.equal(new Date(cutoff).getMilliseconds(), 999);
    assert.equal(store.dataCleanup.preview({ before: cutoff }).eligible, 3);
    const singleScope = { stepIds: [steps[0]!.id] };
    assert.equal(store.dataCleanup.preview(singleScope).eligible, 1);
    const scope = { stepIds: steps.map((s) => s.id) };
    assert.equal(store.dataCleanup.preview(scope).eligible, 3);
    assert.equal(store.dataCleanup.removeBatch(scope, 1), 1);
    assert.equal(store.dataCleanup.removeBatch(scope), 2);
    assert.equal((await new TaskService(store.tasks).records({ groupBy: 'run' })).total, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('hidden terminal history is absent after physical cleanup and keeps foreign keys valid', async () => {
  await fixture(async (store, db) => {
    const { plans, profiles } = seed(store, 1);
    const plan = plans[0]!;
    store.tasks.stopPlanDirect(plan.id, 'USER_STOP');
    store.dataCleanup.removeBatch({ stepIds: store.tasks.steps(plan.id).map((s) => s.id) });
    assert.deepEqual(store.tasks.plansForProfile(profiles[0]!.id), []);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});
test('read snapshot fences direct SQL and nested writes, rejects async before invocation, and restores after failure', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE probe(id INTEGER)');
  try {
    let called = false;
    assert.throws(
      () =>
        readSnapshot(db, async () => {
          called = true;
        }),
      /ASYNC_FORBIDDEN/,
    );
    assert.equal(called, false);
    assert.throws(
      () =>
        readSnapshot(db, () =>
          transaction(db, () => db.prepare('INSERT INTO probe VALUES(1)').run()),
        ),
      /WRITE_IN_READ/,
    );
    assert.throws(() => readSnapshot(db, () => db.exec('INSERT INTO probe VALUES(2)')), /readonly/);
    assert.throws(
      () =>
        readSnapshot(db, () => {
          throw Error('failure');
        }),
      /failure/,
    );
    transaction(db, () => {
      transaction(db, () => db.exec('INSERT INTO probe VALUES(3)'));
      readSnapshot(db, () =>
        assert.equal(db.prepare('SELECT count(*) AS n FROM probe').get()!.n, 1),
      );
    });
    assert.equal(db.isTransaction, false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM probe').get()!.n, 1);
    assert.equal(db.prepare('PRAGMA query_only').get()!.query_only, 0);
    assert.throws(
      () =>
        transaction(db, () => {
          db.exec('INSERT INTO probe VALUES(4)');
          throw Error('rollback');
        }),
      /rollback/,
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM probe').get()!.n, 1);
  } finally {
    db.close();
  }
});
test('runtime reads only active plans/current steps, drains all terminal events, handles gaps and restart epoch', async () => {
  await fixture(async (store, db, file) => {
    const { plans } = seed(store, 3);
    const service = new TaskService(store.tasks);
    const first = await service.runtimeOverview();
    assert.equal(first.plans.length, 3);
    for (const plan of plans) store.tasks.stopPlanDirect(plan.id, 'USER_STOP');
    const originalList = store.tasks.list;
    store.tasks.list = () => {
      throw Error('FULL_HISTORY_FORBIDDEN');
    };
    try {
      let cursor = first.cursor;
      const seen = new Set<string>();
      let pages = 0;
      for (;;) {
        const value = await service.runtimeOverview({ cursor, limit: 1, maxBytes: 1024 });
        cursor = value.cursor;
        pages++;
        assert.equal(value.plans.length, 0);
        for (const event of value.events ?? [])
          if (event.category === 'PLAN_TERMINAL') seen.add(event.jobId);
        if (!value.hasMore) break;
        assert.ok(pages < 100);
      }
      assert.deepEqual([...seen].sort(), plans.map((x) => x.id).sort());
      const reset = await service.runtimeOverview({ cursor: 'not-a-cursor' });
      assert.equal(reset.resetRequired, true);
      assert.equal(reset.lastScannedSequence, reset.lastEventSequence);
      const reopened = await WorkspaceStore.open(file);
      try {
        assert.equal(
          (await new TaskService(reopened.tasks).runtimeOverview({ cursor })).resetRequired,
          true,
        );
      } finally {
        reopened.close();
      }
      db.exec('BEGIN');
      db.prepare(
        "INSERT INTO task_events(job_id,type,detail,created_at) VALUES(?,'FAILED','null',0)",
      ).run(plans[0]!.id);
      db.exec('ROLLBACK');
      const after = await service.runtimeOverview({ cursor });
      assert.equal(after.events?.length, 0);
    } finally {
      store.tasks.list = originalList;
    }
  });
});
test('recordsPage returns consistent rows, counts, search, pagination across 40 rounds and reopen', async () => {
  await fixture(async (store, db, file) => {
    const { profiles, plans } = seed(store, 3);
    const plan = plans.find((p) => p.profileId === profiles[0]!.id) ?? plans[0]!;
    transaction(db, () => {
      const source = store.tasks.steps(plan.id)[0]!;
      for (let round = 2; round <= 40; round++) {
        for (let position = 0; position < 3; position++)
          db.prepare(
            "INSERT INTO task_steps(id,job_id,round,position,spec,status,progress) VALUES(?,?,?,?,?,'COMPLETED',?)",
          ).run(
            randomUUID(),
            plan.id,
            round,
            position,
            JSON.stringify(source.spec),
            JSON.stringify(source.progress),
          );
      }
      db.prepare('UPDATE task_plans SET round=40,updated_at=? WHERE id=?').run(777, plan.id);
    });
    const labels = profiles.map((p, i) => ({
      id: p.id,
      online: i !== 1,
      browserName: `Browser ${i}`,
      alias: `别名 ${i}`,
    }));
    const service = new TaskService(store.tasks);
    const all = await service.records({ status: 'all', limit: 200 }, labels);
    assert.equal(all.total, 126);
    assert.equal(all.counts.all, 126);
    assert.equal(all.counts.completed, 117);
    assert.equal(all.counts.running, 9);

    const paged: TaskRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.records(
        { status: 'all', limit: 17, ...(cursor ? { cursor } : {}) },
        labels,
      );
      paged.push(...page.records);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(paged, all.records);

    const filtered = await service.records({ query: 'Browser 0', limit: 200 }, labels);
    assert.equal(filtered.total, 120);
    store.tasks.stopPlanDirect(plan.id, 'USER_STOP');
    labels[0]!.alias = '已改名';
    const afterStop = await service.records({ query: '已改名', limit: 200 }, labels);
    assert.equal(afterStop.total, 120);
    assert.equal(afterStop.counts.running, 0);

    const reopened = await WorkspaceStore.open(file);
    try {
      assert.equal(
        (await new TaskService(reopened.tasks).records({ limit: 200 }, labels)).total,
        126,
      );
    } finally {
      reopened.close();
    }
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  });
});

test('equal-time UUID ties paginate deterministically without duplicates', async () => {
  await fixture(async (store, db) => {
    const { profiles } = seed(store, 8);
    for (const plan of store.tasks.livePlans()) store.tasks.stopPlanDirect(plan.id, 'USER_STOP');
    let serial = 0;
    const repo = new SqliteTaskRepository(db, {
      id: () => {
        const value = randomUUID();
        return serial++ % 2 ? value.toUpperCase() : value;
      },
      now: () => 100,
      random: () => 0.5,
    });
    const saved = store.combinations()[0]?.saved;
    assert.ok(saved);
    const id = store.combinations()[0]?.id;
    assert.ok(id);
    repo.assign(
      {
        requestId: randomUUID(),
        combinationId: id,
        version: 1,
        profileIds: profiles.map((p) => p.id),
      },
      profiles,
    );
    const service = new TaskService(repo);
    const expected = (await service.records({ limit: 200 })).records;
    const actual: TaskRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.records({ limit: 5, ...(cursor ? { cursor } : {}) });
      actual.push(...page.records);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(actual, expected);
    assert.equal(new Set(actual.map((r) => r.stepId)).size, expected.length);
  });
});

test('live plan step progress updates are reflected immediately in records() and counts update on terminal', async () => {
  await fixture(async (store) => {
    const { plans } = seed(store, 20);
    const service = new TaskService(store.tasks);
    const result = await service.records({ limit: 100 });
    assert.equal(result.total, 60);
    assert.equal(result.counts.running, 60);
    const plan = plans[0]!;
    store.tasks.claimPlanForProfile(plan.profileId, plan.accountId);
    const step = store.tasks.steps(plan.id)[0]!;
    store.tasks.updateStepProgress(plan.id, step.id, {
      ...step.progress,
      revision: 1,
      effectiveMilliseconds: 1000,
    });
    const updated = await service.records({ profileId: plan.profileId, limit: 10 });
    assert.equal(updated.records[0]?.progress.effectiveMilliseconds, 1000);
    store.tasks.stopPlanDirect(plan.id, 'USER_STOP');
    const changed = await service.records({ limit: 100 });
    assert.equal(changed.counts.running, 57);
  });
});

for (const mode of ['count', 'both', 'automatic'] as const)
  test('run quotas keep the newest ended runs and every live step: ' + mode, async () => {
    await fixture(async (store, db) => {
      let now = 100;
      const repo = new SqliteTaskRepository(db, {
        id: randomUUID,
        now: () => now++,
        random: () => 0.5,
      });
      const { plans } = seed(store, 6, false, repo);
      for (const plan of plans.slice(0, 5)) repo.stopPlanDirect(plan.id, 'USER_STOP');
      const scope =
        mode === 'both'
          ? { before: repo.get(plans[3]!.id).updatedAt + 1, keepLatestRuns: 4 }
          : { keepLatestRuns: 2 };
      if (mode === 'automatic') {
        const saved = store.dataCleanup.saveSettings({
          expectedRevision: 0,
          historyRetentionDays: null,
          historyMaxCount: 2,
        });
        assert.equal(saved.historyMaxCount, 2);
        // Legacy callers that save only days/logs must not silently erase the count policy.
        assert.equal(
          store.dataCleanup.saveSettings({ expectedRevision: 1, historyRetentionDays: null })
            .historyMaxCount,
          2,
        );
        const service = new DataCleanupService(
          store.dataCleanup,
          { preview: async () => [], remove: async () => ({ deleted: 0, bytes: 0, protected: 0 }) },
          undefined,
          async () => {},
          () => {},
        );
        await service.automatic();
      } else {
        assert.equal(store.dataCleanup.preview(scope).eligible, mode === 'both' ? 12 : 9);
        let removed = 0;
        for (;;) {
          const n = store.dataCleanup.removeBatch(scope, 2);
          removed += n;
          if (!n) break;
          assert.ok(removed < 30);
        }
        assert.equal(removed, mode === 'both' ? 12 : 9);
      }
      const records = await new TaskService(store.tasks).records({ limit: 100 });
      assert.equal(groupTaskRecords(records.records).length, mode === 'both' ? 2 : 3);
      assert.equal(records.total, mode === 'both' ? 6 : 9);
      assert.ok(records.records.some((r) => r.planId === plans[5]!.id));
      assert.ok(records.records.some((r) => r.planId === plans[4]!.id));
      if (mode !== 'both') assert.ok(records.records.some((r) => r.planId === plans[3]!.id));
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    });
  });

test('quotas count rounds, respect a profile scope, and purge only the affected jobs', async () => {
  await fixture(async (store, db) => {
    const { plans } = seed(store, 2);
    for (const plan of plans) store.tasks.stopPlanDirect(plan.id, 'USER_STOP');
    const plan = plans[0]!;
    const source = store.tasks.steps(plan.id)[0]!;
    transaction(db, () => {
      for (let round = 2; round <= 5; round++)
        db.prepare(
          "INSERT INTO task_steps(id,job_id,round,position,spec,status,progress) VALUES(?,?,?,?,?,'COMPLETED',?)",
        ).run(
          randomUUID(),
          plan.id,
          round,
          0,
          JSON.stringify(source.spec),
          JSON.stringify(source.progress),
        );
    });
    const scope = { keepLatestRuns: 2, profileId: plan.profileId };
    assert.equal(store.dataCleanup.preview(scope).eligible, 5); // round1 has three pending steps, round2/3 one each.
    const prepare = db.prepare.bind(db);
    const purgeQueries: string[] = [];
    db.prepare = (sql) => {
      if (sql.startsWith('SELECT p.id FROM task_plans p WHERE')) purgeQueries.push(sql);
      return prepare(sql);
    };
    try {
      store.dataCleanup.removeBatch(scope);
    } finally {
      db.prepare = prepare;
    }
    assert.ok(purgeQueries.every((q) => q.includes('p.id IN(SELECT value FROM json_each(?))')));
    const result = await new TaskService(store.tasks).records({ limit: 100 });
    assert.equal(new Set(result.records.map((r) => `${r.planId}:${r.round}`)).size, 3);
    assert.equal(result.total, 5);
    assert.ok(result.records.some((r) => r.planId === plans[1]!.id));
    assert.deepEqual(
      result.records
        .filter((r) => r.planId === plan.id)
        .map((r) => r.round)
        .sort(),
      [4, 5],
    );
  });
});

test('v61->v62 preserves data_cleanup_settings while rebuilding pre-v59 v40 DBs to v62', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-quota-upgrade-'));
  const file = path.join(dir, 'workspace.sqlite');
  const oldFile = path.join(dir, 'v40.sqlite');
  try {
    const oldDb = new DatabaseSync(oldFile);
    oldDb.exec('PRAGMA user_version=40');
    oldDb.close();
    const rebuilt = await WorkspaceStore.open(oldFile);
    rebuilt.close();
    const rebuiltCheck = new DatabaseSync(oldFile, { readOnly: true });
    assert.equal(
      rebuiltCheck.prepare('PRAGMA user_version').get()?.user_version,
      workspaceSchemaVersion,
    );
    assert.deepEqual(rebuiltCheck.prepare('PRAGMA foreign_key_check').all(), []);
    rebuiltCheck.close();

    const store = await WorkspaceStore.open(file);
    store.dataCleanup.saveSettings({
      expectedRevision: 0,
      historyRetentionDays: 7,
      historyMaxCount: null,
    });
    store.close();
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version=61');
    db.close();
    const upgraded = await WorkspaceStore.open(file);
    try {
      assert.equal(upgraded.dataCleanup.settings().historyRetentionDays, 7);
      assert.equal(upgraded.dataCleanup.settings().historyMaxCount, null);
      upgraded.dataCleanup.saveSettings({
        expectedRevision: 1,
        historyRetentionDays: 7,
        historyMaxCount: 20,
      });
    } finally {
      upgraded.close();
    }
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.equal(reopened.dataCleanup.settings().historyMaxCount, 20);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('automatic retention drains excess history across multiple 100-step batches', async () => {
  await fixture(async (store) => {
    const { plans } = seed(store, 90);
    for (const plan of plans) store.tasks.stopPlanDirect(plan.id, 'USER_STOP');
    store.dataCleanup.saveSettings({
      expectedRevision: 0,
      historyRetentionDays: null,
      historyMaxCount: 1,
    });
    const service = new DataCleanupService(
      store.dataCleanup,
      { preview: async () => [], remove: async () => ({ deleted: 0, bytes: 0, protected: 0 }) },
      undefined,
      async () => {},
      () => {},
    );
    await service.automatic();
    const records = await new TaskService(store.tasks).records({ limit: 100 });
    assert.equal(groupTaskRecords(records.records).length, 1);
    assert.equal(records.total, 3);
    assert.equal(records.records.length, 3);
    assert.equal(store.dataCleanup.preview({ keepLatestRuns: 1 }).eligible, 0);
  });
});

test('v62 schema installs all job indexes and rebuilds v41 DBs cleanly', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-cleanup62-'));
  const file = path.join(dir, 'workspace.sqlite');
  const oldFile = path.join(dir, 'v41.sqlite');
  const retainedNames = [
    'task_outbox_job_status',
    'task_steps_job_round',
    'material_post_intents_job',
    'task_resource_bindings_job',
    'task_account_locks_job',
  ];
  const droppedNames = ['task_tab_state_job', 'task_control_bindings_job'];
  try {
    const oldDb = new DatabaseSync(oldFile);
    oldDb.exec('PRAGMA user_version=41');
    oldDb.close();
    const rebuilt = await WorkspaceStore.open(oldFile);
    rebuilt.close();
    const rebuiltCheck = new DatabaseSync(oldFile, { readOnly: true });
    assert.equal(
      rebuiltCheck.prepare('PRAGMA user_version').get()?.user_version,
      workspaceSchemaVersion,
    );
    assert.deepEqual(rebuiltCheck.prepare('PRAGMA foreign_key_check').all(), []);
    rebuiltCheck.close();

    const fresh = await WorkspaceStore.open(file);
    fresh.close();
    const db = new DatabaseSync(file);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, workspaceSchemaVersion);
    for (const name of retainedNames) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name));
    }
    for (const name of droppedNames) {
      assert.equal(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name),
        undefined,
      );
    }
    db.exec('PRAGMA user_version=61');
    db.close();
    const upgraded = await WorkspaceStore.open(file);
    upgraded.close();
    const verified = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(
        verified.prepare('PRAGMA user_version').get()?.user_version,
        workspaceSchemaVersion,
      );
      for (const name of retainedNames)
        assert.ok(
          verified.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name),
        );
      for (const name of droppedNames)
        assert.equal(
          verified.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name),
          undefined,
        );
      assert.match(
        String(
          verified
            .prepare("SELECT sql FROM sqlite_master WHERE name='retain_task_resource_binding'")
            .get()?.sql,
        ),
        /WHEN NOT EXISTS/,
      );
      const query = verified
        .prepare(
          "EXPLAIN QUERY PLAN SELECT 1 FROM task_outbox o WHERE o.job_id=? AND o.status='UNKNOWN' AND o.disposition IS NULL",
        )
        .all(randomUUID());
      assert.ok(query.some((row) => String(row.detail).includes('task_outbox_job_status')));
      assert.ok(!query.some((row) => String(row.detail).includes('SCAN o')));
      assert.deepEqual(verified.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      verified.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
