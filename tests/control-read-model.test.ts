import { deliverPostNotices } from './fixtures/material-post.js';
import { prepareBound } from './fixtures/settlement.js';
import { SqliteTaskRepository } from '../src/infrastructure/task-store.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { TaskService } from '../src/application/task-service.js';
import { readSnapshot, transaction } from '../src/infrastructure/sqlite-transaction.js';
import type { RuntimeProfile } from '../src/domain/tasks.js';
import type { TaskRecord } from '../src/shared/task-contracts.js';
import { groupTaskRecords } from '../src/domain/task-run-records.js';
import { DataCleanupService } from '../src/application/data-cleanup.js';
import { cleanupDateEnd } from '../src/shared/cleanup-date.js';

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
    for (const plan of plans) store.tasks.requestControl(plan.id, 'stop');
    transaction(db, () => {
      for (const plan of plans)
        db.prepare("UPDATE task_steps SET status='COMPLETED' WHERE job_id=? AND position<2").run(
          plan.id,
        );
    });
    const service = new TaskService(store.tasks);
    const seen: TaskRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.records({
        groupBy: 'run',
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      assert.equal(page.records.length, 3);
      assert.deepEqual(
        page.records.map((r) => r.position),
        [0, 1, 2],
      );
      assert.equal(page.total, 4);
      seen.push(...page.records);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(new Set(seen.map((r) => r.stepId)).size, 12);
    assert.equal(groupTaskRecords(seen).length, 4);
    assert.ok(groupTaskRecords(seen).every((g) => g.completed === 2 && g.state === 'STOPPED'));
    for (const status of ['all', 'completed', 'failed', 'running', 'review'] as const) {
      const page = await service.records({ groupBy: 'run', status });
      const legacy = await service.recordsLegacy({ groupBy: 'run', status });
      assert.deepEqual(page.counts, legacy.counts);
      assert.deepEqual(page.records, legacy.records);
    }
    // A type-specific search must bring back unmatched sibling types as well.
    const plan = plans[0]!;
    const searched = await service.records({
      groupBy: 'run',
      query: '商城',
      profileId: plan.profileId,
    });
    assert.equal(searched.total, 1);
    assert.equal(searched.records.length, 3);
    assert.deepEqual(
      searched.records,
      (await service.recordsLegacy({ groupBy: 'run', query: '商城', profileId: plan.profileId }))
        .records,
    );
  });
});

test('selected-day cleanup includes afternoon records and expands pending siblings in preview and execution', async () => {
  await fixture(async (store, db) => {
    const { plans } = seed(store, 1);
    const plan = plans[0]!;
    store.tasks.requestControl(plan.id, 'stop');
    const steps = store.tasks.steps(plan.id);
    transaction(db, () => {
      db.prepare("UPDATE task_steps SET status='COMPLETED' WHERE id=?").run(steps[0]!.id);
      db.prepare('UPDATE task_plans SET updated_at=? WHERE id=?').run(
        new Date('2026-10-26T15:30:00').getTime(),
        plan.id,
      );
    });
    const cutoff = cleanupDateEnd('2026-10-26');
    assert.equal(new Date(cutoff).getHours(), 23);
    assert.equal(new Date(cutoff).getMilliseconds(), 999);
    assert.equal(store.dataCleanup.preview({ before: cutoff }).eligible, 3);
    const scope = { stepIds: [steps[0]!.id] };
    assert.equal(store.dataCleanup.preview(scope).eligible, 3);
    assert.equal(store.dataCleanup.removeBatch(scope, 1), 1);
    assert.equal(store.dataCleanup.removeBatch(scope), 2);
    assert.equal((await new TaskService(store.tasks).records({ groupBy: 'run' })).total, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('hidden terminal history is absent even when READY tab proof prevents physical cleanup', async () => {
  await fixture(async (store, db) => {
    const { plans, profiles } = seed(store, 1);
    const plan = plans[0]!;
    const ownership = randomUUID();
    const proof = {
      ownershipId: ownership,
      profileId: plan.profileId,
      browserSessionEpoch: randomUUID(),
      tabId: 42,
      targetId: 'fixture-target',
    };
    transaction(db, () => {
      db.prepare('INSERT INTO task_tab_ownership VALUES(?,?,?,?,?)').run(
        ownership,
        plan.id,
        plan.accountId,
        JSON.stringify(proof),
        Date.now(),
      );
      db.prepare("INSERT INTO task_tab_state VALUES(?,?,?,'READY',0,NULL,'',?,NULL,NULL)").run(
        ownership,
        plan.id,
        plan.profileId,
        Date.now(),
      );
    });
    store.tasks.requestControl(plan.id, 'stop');
    store.dataCleanup.removeBatch({ stepIds: store.tasks.steps(plan.id).map((s) => s.id) });
    assert.equal(store.tasks.get(plan.id).state, 'STOPPED');
    const service = new TaskService(store.tasks);
    assert.deepEqual((await service.history({ profileId: profiles[0]!.id })).plans, []);
    assert.equal(
      (await service.history({ profileId: profiles[0]!.id, planId: plan.id })).selectedPlanId,
      plan.id,
    );
    assert.equal(
      db.prepare('SELECT state FROM task_tab_state WHERE job_id=?').get(plan.id)?.state,
      'READY',
    );
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
    for (const plan of plans) store.tasks.requestControl(plan.id, 'stop');
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
test('indexed records equal legacy rows/order/search/counts across long live rounds, dynamic fallback and page invalidation', async () => {
  await fixture(async (store, db, file) => {
    const { profiles, plans } = seed(store, 3);
    const plan = plans[0]!;
    // Deliberately incomplete legacy history: all ended steps borrow plan.updatedAt.
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
    const check = async () => {
      for (const status of ['all', 'running', 'completed', 'failed', 'review'] as const)
        for (const query of ['', 'Alpha Browser', 'browser 0', '浏览首页', 'ALPHA', '不存在']) {
          const scope = { status, query, limit: 200 };
          const legacy = await service.recordsLegacy(scope, labels);
          const rows: TaskRecord[] = [];
          let cursor: string | undefined;
          do {
            const page = await service.records(
              { ...scope, limit: 7, ...(cursor ? { cursor } : {}) },
              labels,
            );
            assert.deepEqual(page.counts, legacy.counts);
            assert.equal(page.total, legacy.total);
            rows.push(...page.records);
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
          assert.deepEqual(rows, legacy.records);
        }
    };
    await check();
    const first = await service.records({ limit: 2 }, labels);
    assert.ok(first.nextCursor);
    store.tasks.noteQueuedWait(plan.id, 'WAIT_CHANGED');
    await assert.rejects(
      async () => await service.records({ limit: 2, cursor: first.nextCursor! }, labels),
      /记录已变化/,
    );
    await check();
    store.tasks.requestControl(plan.id, 'stop');
    await check();
    labels[1]!.online = true;
    labels[0]!.alias = '已改名';
    await check();
    const all = (await service.recordsLegacy({ limit: 200 }, labels)).records;
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(
        (await new TaskService(reopened.tasks).records({ limit: 200 }, labels)).records,
        all,
      );
    } finally {
      reopened.close();
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM task_record_dirty').get()!.n, 0);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  });
});

test('records track original UNKNOWN, operation timestamps and late disposition without rewriting evidence', async () => {
  await fixture(async (store) => {
    const f = prepareBound(store);
    const service = new TaskService(store.tasks);
    const check = async () => {
      for (const status of ['all', 'running', 'completed', 'failed', 'review'] as const)
        assert.deepEqual(
          (await service.records({ status, limit: 100 })).records,
          (await service.recordsLegacy({ status, limit: 100 })).records,
        );
    };
    await check();
    store.tasks.markBoundUnknown(f.binding, 'TEST_UNKNOWN');
    await check();
    assert.equal((await service.records({ status: 'review' })).total, 1);
    const endingId = store.tasks.requestEnd(f.plan.id);
    const stop = {
      profileId: f.profile.id,
      connectionEpoch: f.binding.connectionEpoch,
      requestId: endingId,
      state: 'stopped' as const,
    };
    store.tasks.prepareEnd(f.plan.id, stop);
    deliverPostNotices(store, f.profile.id);
    store.tasks.finishEnd(f.plan.id, stop);
    await check();
    assert.equal(store.tasks.operations(f.plan.id)[0]?.status, 'UNKNOWN');
    const first = await service.records({ limit: 1 });
    if (first.nextCursor) {
      const tampered = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString());
      tampered.keys[0] = 0;
      await assert.rejects(
        async () =>
          await service.records({
            limit: 1,
            cursor: Buffer.from(JSON.stringify(tampered)).toString('base64url'),
          }),
        /记录已变化/,
      );
    }
  });
});
test('equal-time UUID ties preserve JS collation with mixed-case identifiers and cursor tampering is rejected', async () => {
  await fixture(async (store, db) => {
    const { profiles } = seed(store, 8);
    for (const plan of store.tasks.livePlans()) store.tasks.requestControl(plan.id, 'stop');
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
    const service = new TaskService(repo),
      expected = (await service.recordsLegacy({ limit: 200 })).records;
    const actual: TaskRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.records({ limit: 5, ...(cursor ? { cursor } : {}) });
      actual.push(...page.records);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(actual, expected);
    const first = await service.records({ limit: 1 });
    assert.ok(first.nextCursor);
    const tampered = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString());
    tampered.keys[0] = 0;
    await assert.rejects(
      async () =>
        await service.records({
          limit: 1,
          cursor: Buffer.from(JSON.stringify(tampered)).toString('base64url'),
        }),
      /记录已变化/,
    );
  });
});

test('hot input/receipt writes only invalidate a live round; records refresh it and terminal commit drains it', async () => {
  await fixture(async (store, db) => {
    const f = prepareBound(store);
    const service = new TaskService(store.tasks);
    assert.ok(Number(db.prepare('SELECT count(*) AS n FROM task_record_dirty').get()?.n) > 0);
    await service.records({});
    assert.equal(db.prepare('SELECT count(*) AS n FROM task_record_dirty').get()?.n, 0);
    store.tasks.markBoundUnknown(f.binding, 'HOT_PATH_UNKNOWN');
    assert.ok(Number(db.prepare('SELECT count(*) AS n FROM task_record_dirty').get()?.n) > 0);
    assert.deepEqual(
      (await service.records({})).records,
      (await service.recordsLegacy({})).records,
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM task_record_dirty').get()?.n, 0);
  });
});

test('startup backfill reports progress, restores pager settings and resumes after an atomic projection failure', async () => {
  await fixture(async (store, db) => {
    const { plans } = seed(store, 1),
      plan = plans[0]!;
    const originalCache = db.prepare('PRAGMA cache_size').get()?.cache_size;
    const progress: { completed: number; total: number }[] = [];
    await store.tasks.recordReader.initialize((completed, total) =>
      progress.push({ completed, total }),
    );
    assert.equal(progress[0]?.completed, 0);
    assert.equal(progress.at(-1)?.completed, progress.at(-1)?.total);
    assert.equal(db.prepare('PRAGMA cache_size').get()?.cache_size, originalCache);
    transaction(db, () =>
      db
        .prepare("UPDATE task_steps SET progress=json_set(progress,'$.revision',1) WHERE job_id=?")
        .run(plan.id),
    );
    db.exec(
      "CREATE TRIGGER inject_record_backfill_failure BEFORE INSERT ON task_record_projection BEGIN SELECT RAISE(ABORT,'INJECT_RECORD_BACKFILL_FAILURE'); END",
    );
    await assert.rejects(store.tasks.recordReader.initialize(), /INJECT_RECORD_BACKFILL_FAILURE/);
    assert.equal(db.isTransaction, false);
    assert.equal(db.prepare('PRAGMA cache_size').get()?.cache_size, originalCache);
    assert.equal(db.prepare('SELECT count(*) n FROM task_record_dirty').get()?.n, 1);
    db.exec('DROP TRIGGER inject_record_backfill_failure');
    await store.tasks.recordReader.initialize();
    assert.equal(db.prepare('SELECT count(*) n FROM task_record_dirty').get()?.n, 0);
    const service = new TaskService(store.tasks);
    assert.deepEqual(
      (await service.records({})).records,
      (await service.recordsLegacy({})).records,
    );
  });
});

test('run reads use one grouped query and one bounded batch; eight-entry LRU survives tab switches and invalidates on writes', async () => {
  await fixture(async (store, db) => {
    seed(store, 20);
    const service = new TaskService(store.tasks);
    await service.records({ groupBy: 'run', limit: 1 }); // Flush live round projections before counting SQL.
    const prepare = db.prepare.bind(db);
    const queries: string[] = [];
    db.prepare = (sql) => {
      queries.push(sql);
      return prepare(sql);
    };
    try {
      const result = await service.records({ groupBy: 'run', limit: 100 });
      assert.equal(result.total, 20);
      assert.equal(result.records.length, 60);
      assert.equal(queries.filter((q) => q.startsWith('WITH matching')).length, 1);
      assert.equal(queries.filter((q) => q.includes('JOIN json_each(?) selected')).length, 1);
      for (const status of ['running', 'completed', 'failed', 'review'] as const)
        await service.records({ groupBy: 'run', limit: 100, status });
      queries.length = 0;
      result.records[0]!.combinationName = 'must not poison cache';
      const cached = await service.records({ groupBy: 'run', limit: 100 });
      assert.notEqual(cached.records[0]!.combinationName, 'must not poison cache');
      assert.equal(queries.filter((q) => q.startsWith('WITH matching')).length, 0);
      for (let limit = 2; limit <= 10; limit++) await service.records({ groupBy: 'run', limit });
      queries.length = 0;
      await service.records({ groupBy: 'run', limit: 100 });
      assert.equal(
        queries.filter((q) => q.startsWith('WITH matching')).length,
        1,
        'LRU evicts the oldest of more than eight entries',
      );
      const plan = store.tasks.livePlans()[0]!;
      store.tasks.requestControl(plan.id, 'stop');
      queries.length = 0;
      const changed = await service.records({ groupBy: 'run', limit: 100 });
      assert.equal(changed.counts.running, 19);
      assert.equal(
        queries.filter((q) => q.startsWith('WITH matching')).length,
        1,
        'state change invalidates cache',
      );
    } finally {
      db.prepare = prepare;
    }
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
      for (const plan of plans.slice(0, 5)) repo.requestControl(plan.id, 'stop');
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
      const records = await new TaskService(store.tasks).records({ groupBy: 'run' });
      assert.equal(records.total, mode === 'both' ? 2 : 3);
      assert.ok(records.records.some((r) => r.planId === plans[5]!.id));
      assert.ok(records.records.some((r) => r.planId === plans[4]!.id));
      if (mode !== 'both') assert.ok(records.records.some((r) => r.planId === plans[3]!.id));
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    });
  });

test('quotas count rounds, respect a profile scope, and purge only the affected jobs', async () => {
  await fixture(async (store, db) => {
    const { plans } = seed(store, 2);
    for (const plan of plans) store.tasks.requestControl(plan.id, 'stop');
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
    const result = await new TaskService(store.tasks).records({ groupBy: 'run' });
    assert.equal(result.total, 3);
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

test('quota migration upgrades version40 and reopening is idempotent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-quota-upgrade-'));
  const file = path.join(dir, 'workspace.sqlite');
  try {
    const store = await WorkspaceStore.open(file);
    store.dataCleanup.saveSettings({ expectedRevision: 0, historyRetentionDays: 7 });
    store.close();
    const db = new DatabaseSync(file);
    db.exec(
      'ALTER TABLE data_cleanup_settings DROP COLUMN history_max_count;PRAGMA user_version=40',
    );
    db.close();
    const upgraded = await WorkspaceStore.open(file);
    assert.equal(upgraded.dataCleanup.settings().historyRetentionDays, 7);
    assert.equal(upgraded.dataCleanup.settings().historyMaxCount, null);
    upgraded.dataCleanup.saveSettings({
      expectedRevision: 1,
      historyRetentionDays: 7,
      historyMaxCount: 20,
    });
    upgraded.close();
    const reopened = await WorkspaceStore.open(file);
    assert.equal(reopened.dataCleanup.settings().historyMaxCount, 20);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('automatic retention drains excess history across multiple 100-step batches', async () => {
  await fixture(async (store) => {
    const { plans } = seed(store, 90);
    for (const plan of plans) store.tasks.requestControl(plan.id, 'stop');
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
    const records = await new TaskService(store.tasks).records({ groupBy: 'run' });
    assert.equal(records.total, 1);
    assert.equal(records.records.length, 3);
    assert.equal(store.dataCleanup.preview({ keepLatestRuns: 1 }).eligible, 0);
  });
});

test('migration41 to42 installs all job indexes and the resource cleanup guard, including fresh initialization', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-cleanup42-'));
  const file = path.join(dir, 'workspace.sqlite');
  const names = [
    'task_outbox_job_status',
    'task_steps_job_round',
    'task_tab_state_job',
    'material_post_intents_job',
    'task_control_bindings_job',
    'task_resource_bindings_job',
    'task_account_locks_job',
  ];
  try {
    const fresh = await WorkspaceStore.open(file);
    fresh.close();
    const db = new DatabaseSync(file);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 42);
    for (const name of names) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name));
      db.exec('DROP INDEX ' + name);
    }
    db.exec(
      "DROP TRIGGER retain_task_resource_binding;CREATE TRIGGER retain_task_resource_binding BEFORE DELETE ON task_resource_bindings BEGIN SELECT RAISE(ABORT,'RETAIN_TASK_RESOURCE_BINDING');END;PRAGMA user_version=41",
    );
    db.close();
    const upgraded = await WorkspaceStore.open(file);
    upgraded.close();
    const verified = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(verified.prepare('PRAGMA user_version').get()?.user_version, 42);
      for (const name of names)
        assert.ok(
          verified.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name),
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
