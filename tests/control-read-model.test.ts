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
function seed(store: WorkspaceStore, count = 3) {
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
    steps: Array.from({ length: 3 }, () => ({
      id: randomUUID(),
      type: 'feed' as const,
      durationMinutes: 1,
      maxLikes: 0,
      minLikeCount: 0,
    })),
    randomOrder: false,
    loop: { mode: 'until-stopped' },
  });
  const plans = store.tasks.assign(
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
