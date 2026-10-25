import { runVerification } from './verify.js';
import { projectTaskRecords, compareRecords } from '../../src/domain/task-record-projection.js';
import { createHash } from 'node:crypto';
import type { TaskRecord } from '../../src/shared/task-contracts.js';
import { DatabaseSync, backup } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { WorkspaceStore } from '../../src/infrastructure/workspace-store.js';
import { TaskService } from '../../src/application/task-service.js';
import { transaction } from '../../src/infrastructure/sqlite-transaction.js';

export async function runRecords(config: {
  scratch: string;
  reportDir: string;
  scopeSource: string;
  id: string;
  verifyOnly?: boolean;
}) {
  if (config.verifyOnly) return runVerification(config);
  const source = JSON.parse(await readFile(config.scopeSource, 'utf8'));
  assert.ok(path.basename(source.scratch).startsWith('workbench-concurrency-lab-'));
  assert.equal(await readFile(path.join(source.scratch, '.isolated-lab'), 'utf8'), source.id);
  assert.equal(await readFile(path.join(config.scratch, '.isolated-lab'), 'utf8'), config.id);
  const results: unknown[] = [];
  for (const [history, name] of [
    [4, 'forward-100-h4-r0'],
    [20, 'depth-100-h20-r0'],
    [100, 'depth-100-h100-r0'],
  ] as const) {
    const original = new DatabaseSync(path.join(source.scratch, `e1-${name}.sqlite`), {
      readOnly: true,
    });
    const copy = path.join(config.scratch, `records-h${history}.sqlite`);
    try {
      await backup(original, copy);
    } finally {
      original.close();
    }
    const originalExec = DatabaseSync.prototype.exec;
    const slowCommits: number[] = [];
    DatabaseSync.prototype.exec = function (sql: string) {
      const start = performance.now();
      try {
        return originalExec.call(this, sql);
      } finally {
        if (sql === 'COMMIT') slowCommits.push(performance.now() - start);
      }
    };
    const opening = performance.now();
    let store: WorkspaceStore;
    try {
      store = await WorkspaceStore.open(copy);
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }
    const migrationAndBackfillMs = performance.now() - opening;
    await writeFile(
      path.join(config.reportDir, 'traversal-progress.json'),
      JSON.stringify({ history, phase: 'opened', migrationAndBackfillMs }),
    );
    try {
      const db: DatabaseSync = (store as any).db;
      const planCount = Number(db.prepare('SELECT count(*) AS n FROM task_plans').get()!.n);
      const stepCount = Number(db.prepare('SELECT count(*) AS n FROM task_steps').get()!.n);
      assert.equal(planCount, 100 * (history + 1));
      const profiles = db
        .prepare('SELECT DISTINCT profile_id AS id FROM task_plans ORDER BY profile_id')
        .all()
        .map((row) => ({
          id: String(row.id),
          online: true,
          alias: 'lab alias',
          browserName: 'lab browser',
        }));
      const service = new TaskService(store.tasks);
      const legacySamples = [];
      let reference;
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        reference = service.recordsLegacy({ limit: 50 }, profiles);
        legacySamples.push(performance.now() - start);
      }
      const runtimeInitial = service.runtimeOverview();
      const runtimeSamples = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        const value = service.runtimeOverview({ cursor: runtimeInitial.cursor });
        runtimeSamples.push({
          ms: performance.now() - start,
          bytes: Buffer.byteLength(JSON.stringify(value)),
          plans: value.plans.length,
          currentSteps: value.currentSteps.length,
        });
      }
      const beforeWrite = performance.now();
      const active = store.tasks.livePlans()[0];
      if (active) store.tasks.noteQueuedWait(active.id, 'LAB_BC_WAIT');
      const currentRoundWriteMs = performance.now() - beforeWrite;
      const stepStart = performance.now();
      if (active)
        transaction(db, () =>
          db
            .prepare(
              "UPDATE task_steps SET progress=json_set(progress,'$.revision',json_extract(progress,'$.revision')+1) WHERE job_id=? AND round=? AND position=?",
            )
            .run(active.id, active.round, active.position),
        );
      const projectionRoundWriteMs = performance.now() - stepStart;
      const terminalStart = performance.now();
      if (active)
        transaction(db, () =>
          db
            .prepare("UPDATE task_plans SET state='STOPPED',updated_at=updated_at+1 WHERE id=?")
            .run(active.id),
        );
      const syntheticTerminalWriteMs = performance.now() - terminalStart;
      assert.equal(db.prepare('SELECT count(*) AS n FROM task_record_dirty').get()!.n, 0);

      // Refresh the oracle after that deliberate mutation, before all comparison samples.
      reference = service.recordsLegacy({ limit: 50 }, profiles);
      const samples = [];
      for (let i = 0; i < 4; i++) {
        const start = performance.now();
        const value = service.records({ limit: 50 }, profiles);
        const readMs = performance.now() - start;
        const serializeStart = performance.now();
        const bytes = Buffer.byteLength(JSON.stringify(value));
        const serializeMs = performance.now() - serializeStart;
        assert.equal(value.records.length, 50);
        assert.deepEqual(value.records, reference.records);
        assert.deepEqual(value.counts, reference.counts);
        assert.equal(value.total, stepCount);
        samples.push({
          phase: i === 0 ? 'cold' : 'warm',
          readMs,
          serializeMs,
          bytes,
          total: value.total,
          counts: value.counts,
        });
      }
      // Separate instrumented call; do not mix its timings with uninstrumented samples.
      const prepareOriginal = db.prepare.bind(db);
      let prepareCalls = 0,
        executeCalls = 0,
        prepareMs = 0,
        executeMs = 0;
      (db as any).prepare = (sql: string) => {
        const start = performance.now();
        const statement = prepareOriginal(sql);
        prepareMs += performance.now() - start;
        prepareCalls++;
        return new Proxy(statement, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (typeof value !== 'function') return value;
            if (!['all', 'get', 'run'].includes(String(key))) return value.bind(target);
            return (...args: any[]) => {
              executeCalls++;
              const started = performance.now();
              try {
                return value.apply(target, args);
              } finally {
                executeMs += performance.now() - started;
              }
            };
          },
        });
      };
      try {
        service.records({ limit: 50 }, profiles);
      } finally {
        (db as any).prepare = prepareOriginal;
      }
      const canonical = (value: unknown): unknown =>
        Array.isArray(value)
          ? value.map(canonical)
          : value !== null && typeof value === 'object'
            ? Object.fromEntries(
                Object.entries(value)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([key, entry]) => [key, canonical(entry)]),
              )
            : value;
      const digest = (row: TaskRecord) =>
        createHash('sha256')
          .update(JSON.stringify(canonical(row)))
          .digest('hex');
      // Retain compact sort keys + canonical hashes, not two full 80k-row object graphs.
      const expectedAll = store.tasks
        .list()
        .flatMap((plan) =>
          projectTaskRecords(
            plan,
            store.tasks.steps(plan.id),
            store.tasks.operations(plan.id),
            store.tasks.events(plan.id),
          ).map(({ row }) => ({
            key: {
              stepId: row.stepId,
              startedAt: row.startedAt,
              finishedAt: row.finishedAt,
              planCreatedAt: row.planCreatedAt,
              round: row.round,
              position: row.position,
            },
            hash: digest(row),
          })),
        )
        .sort((a, b) => compareRecords(a.key as TaskRecord, b.key as TaskRecord));
      await writeFile(
        path.join(config.reportDir, 'traversal-progress.json'),
        JSON.stringify({ history, phase: 'oracle-built', rows: expectedAll.length }),
      );
      const traversalStart = performance.now();
      const streamHash = createHash('sha256');
      let cursor: string | undefined,
        pages = 0,
        rowCount = 0;
      do {
        const page = service.records({ limit: 200, ...(cursor ? { cursor } : {}) }, profiles);
        for (const row of page.records) {
          const expected = expectedAll[rowCount];
          assert.ok(expected);
          assert.equal(row.stepId, expected.key.stepId);
          const hash = digest(row);
          assert.equal(hash, expected.hash, 'row fields differ at ' + rowCount);
          streamHash.update(hash);
          rowCount++;
        }
        cursor = page.nextCursor ?? undefined;
        pages++;
        if (pages % 100 === 0)
          await writeFile(
            path.join(config.reportDir, 'traversal-progress.json'),
            JSON.stringify({
              history,
              phase: 'paging',
              pages,
              rows: rowCount,
              ms: performance.now() - traversalStart,
            }),
          );
        assert.ok(pages < 1000);
      } while (cursor);
      const completeTraversalMs = performance.now() - traversalStart;
      assert.equal(rowCount, expectedAll.length);
      const traversal = {
        pages,
        rows: rowCount,
        completeTraversalMs,
        allFieldsAndOrderMatched: true,
        sha256CanonicalRowHashes: streamHash.digest('hex'),
      };
      const result = {
        historyPerProfile: history,
        traversal,
        migrationAndBackfillMs,
        startupCommits: {
          count: slowCommits.length,
          totalMs: slowCommits.reduce((a, b) => a + b, 0),
          maxMs: Math.max(0, ...slowCommits),
        },
        legacySamples,
        runtimeSamples,
        currentRoundWriteMs,
        projectionRoundWriteMs,
        syntheticTerminalWriteMs,
        projection: db
          .prepare(
            'SELECT count(*) AS rows,sum(stable_sort IS NULL) AS dynamic FROM task_record_projection',
          )
          .get(),
        explainStable: db
          .prepare(
            'EXPLAIN QUERY PLAN SELECT r.step_id FROM task_record_projection r JOIN task_plans p ON p.id=r.job_id WHERE r.stable_sort IS NOT NULL ORDER BY r.stable_sort DESC,r.created_at DESC,r.round DESC,r.position DESC,r.id_order DESC LIMIT 50',
          )
          .all(),
        profiles: profiles.length,
        planCount,
        stepCount,
        samples,
        instrumented: { prepareCalls, executeCalls, prepareMs, executeMs },
      };
      results.push(result);
      await writeFile(
        path.join(config.reportDir, `records-h${history}.json`),
        JSON.stringify(result, null, 2),
      );
      console.log(JSON.stringify({ recordsHistoryComplete: history }));
    } finally {
      store.close();
    }
  }
  // Demonstrates the proposed async snapshot hazard; this is not a production snapshot implementation.
  const probe = new DatabaseSync(path.join(config.scratch, 'snapshot-hazard.sqlite'));
  let acknowledged = false;
  let rowsBeforeRollback = 0;
  try {
    probe.exec('CREATE TABLE probe(id INTEGER PRIMARY KEY); BEGIN');
    probe.prepare('SELECT * FROM probe').all();
    await Promise.resolve();
    transaction(probe, () => probe.prepare('INSERT INTO probe(id) VALUES (1)').run());
    acknowledged = true;
    rowsBeforeRollback = Number(probe.prepare('SELECT count(*) AS n FROM probe').get()!.n);
    probe.exec('ROLLBACK');
    const rowsAfterRollback = Number(probe.prepare('SELECT count(*) AS n FROM probe').get()!.n);
    assert.equal(rowsBeforeRollback, 1);
    assert.equal(rowsAfterRollback, 0);
    const result = {
      versions: process.versions,
      results,
      snapshotHazard: { acknowledged, rowsBeforeRollback, rowsAfterRollback },
      limitations:
        'Generated histories lack real execution progress/events/operations; 1 cold + 3 warm calls per depth, no RPC, actors, production database or browsers. Instrumentation timed separately. Snapshot hazard intentionally constructs an unguarded future pattern.',
    };
    await writeFile(
      path.join(config.reportDir, 'records-summary.json'),
      JSON.stringify(result, null, 2),
    );
    return result;
  } finally {
    probe.close();
  }
}
