// Generated profiles/plans, actual current repositories; no browser/runtime/server imports.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { WorkspaceStore } from '../../src/infrastructure/workspace-store.js';
import { WorkspaceService } from '../../src/application/workspace-service.js';
import { TaskService } from '../../src/application/task-service.js';
import { TaskPlan, TaskOverview, TaskRuntimeOverview } from '../../src/shared/task-contracts.js';
import { TaskStepV2 } from '../../src/shared/task-step-instance.js';

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
  return {
    count: sorted.length,
    sumMs: values.reduce((a, b) => a + b, 0),
    p50Ms: p(0.5),
    p95Ms: p(0.95),
    p99Ms: p(0.99),
    maxMs: p(1),
  };
}
export async function runE1(config: { scratch: string; reportDir?: string; e1Matrix?: boolean }) {
  const results = [];
  const scenarios = config.e1Matrix
    ? [
        ...[12, 50, 100].map((count) => ({ count, historyDepth: 4, running: 0, order: 'forward' })),
        ...[100, 50, 12].map((count) => ({ count, historyDepth: 4, running: 0, order: 'reverse' })),
        ...[20, 100].map((historyDepth) => ({
          count: 100,
          historyDepth,
          running: 0,
          order: 'depth',
        })),
        ...[4, 20, 100].map((historyDepth) => ({
          count: 100,
          historyDepth,
          running: 50,
          order: 'mixed',
        })),
      ]
    : [12, 50, 100].map((count) => ({ count, historyDepth: 4, running: 0, order: 'original' }));
  for (const scenario of scenarios) {
    const { count, historyDepth, running, order } = scenario;
    const scenarioId = `${order}-${count}-h${historyDepth}-r${running}`;
    const file = path.join(config.scratch, `e1-${scenarioId}.sqlite`);
    const store = await WorkspaceStore.open(file);
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
    const profiles = Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      alias: 'synthetic-' + index,
      groupId: null,
      online: true,
      phase: 'PAUSED',
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      extensionVersion: null,
      capabilities: [],
      account: {
        state: 'logged-in' as const,
        id: 'lab-only-' + index,
        name: 'synthetic-' + index,
        avatar: null,
      },
    }));
    const saved = store.createCombination({
      name: 'ISOLATED-LAB',
      note: 'generated; no execution',
      steps: Array.from({ length: 8 }, () => ({
        id: randomUUID(),
        type: 'feed' as const,
        durationMinutes: 1,
        maxLikes: 0,
        minLikeCount: 0,
      })),
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    // Original path retained for old entry; matrix uses fixture-only bulk clones to avoid
    // O(history^2) assignment admission work dominating setup. Neither path executes tasks.
    for (let batch = 0; batch < (config.e1Matrix ? 0 : historyDepth); batch++) {
      store.tasks.assign(
        {
          requestId: randomUUID(),
          combinationId: saved.id,
          version: saved.version,
          profileIds: profiles.map((p) => p.id),
        },
        profiles,
      );
      db.exec("UPDATE task_plans SET state='COMPLETED'");
    }
    const plans = store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: saved.id,
        version: saved.version,
        profileIds: profiles.map((p) => p.id),
      },
      profiles,
    );
    const seedStart = performance.now();
    if (config.e1Matrix) {
      const currentRows = db.prepare('SELECT * FROM task_plans ORDER BY rowid').all();
      const currentSteps = db.prepare('SELECT * FROM task_steps ORDER BY job_id,position').all();
      const fields = Object.keys(currentRows[0]!);
      const stepFields = Object.keys(currentSteps[0]!);
      for (const field of [...fields, ...stepFields]) assert.match(field, /^[a-z_]+$/);
      const insertPlan = db.prepare(
        `INSERT INTO task_plans(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`,
      );
      const insertStep = db.prepare(
        `INSERT INTO task_steps(${stepFields.join(',')}) VALUES(${stepFields.map(() => '?').join(',')})`,
      );
      const insertBatch = db.prepare('INSERT INTO task_batches VALUES(?,?,?)');
      db.exec('BEGIN IMMEDIATE');
      try {
        for (let history = 0; history < historyDepth; history++) {
          const batchId = randomUUID();
          const createdAt = Date.now() - (historyDepth - history) * 60_000;
          insertBatch.run(
            batchId,
            JSON.stringify({
              requestId: batchId,
              combinationId: saved.id,
              version: saved.version,
              profileIds: profiles.map((p) => p.id),
            }),
            createdAt,
          );
          const idMap = new Map<unknown, string>();
          for (const row of currentRows) {
            const id = randomUUID();
            idMap.set(row.id, id);
            const clone = {
              ...row,
              id,
              batch_id: batchId,
              state: 'COMPLETED',
              created_at: createdAt,
              updated_at: createdAt,
            };
            insertPlan.run(...fields.map((field) => (clone as any)[field]));
          }
          for (const row of currentSteps) {
            const clone = {
              ...row,
              id: randomUUID(),
              job_id: idMap.get(row.job_id),
              status: 'COMPLETED',
            };
            insertStep.run(...stepFields.map((field) => (clone as any)[field]));
          }
        }
        db.exec('UPDATE scheduler_settings SET max_concurrent_profiles=50 WHERE id=1');
        for (const plan of plans.slice(0, running)) {
          db.prepare("UPDATE task_plans SET state='RUNNING',updated_at=? WHERE id=?").run(
            Date.now(),
            plan.id,
          );
          db.prepare("UPDATE task_steps SET status='ACTIVE' WHERE job_id=? AND position=0").run(
            plan.id,
          );
          db.prepare('INSERT INTO task_account_locks(account_id,job_id) VALUES(?,?)').run(
            plan.accountId,
            plan.id,
          );
        }
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    }
    const fixtureStates = db
      .prepare('SELECT state,count(*) AS n FROM task_plans GROUP BY state')
      .all();
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM task_plans').get()!.n,
      count * (historyDepth + 1),
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM task_plans WHERE state='RUNNING'").get()!.n,
      running,
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM task_account_locks').get()!.n, running);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    const seedMs = performance.now() - seedStart;
    const service = new WorkspaceService(store, {
      profiles: () => profiles,
      records: () => [],
    } as any);
    const tasks = new TaskService(store.tasks);
    const measurements: any[] = [];
    let active: any = null;
    const storageDb = (store as any).db;
    const originalPrepare = storageDb.prepare.bind(storageDb);
    storageDb.prepare = (sql: string) => {
      if (active) active.prepares++;
      const prepareStart = performance.now();
      const stmt = originalPrepare(sql);
      if (active) active.prepareMs += performance.now() - prepareStart;
      return new Proxy(stmt, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (!['get', 'all', 'run'].includes(String(key)))
            return typeof value === 'function' ? value.bind(target) : value;
          return (...args: any[]) => {
            const start = performance.now();
            try {
              return value.apply(target, args);
            } finally {
              if (active) {
                active.sqlCalls++;
                active.sqlMs += performance.now() - start;
                const category = sql.includes('task_batch_timing')
                  ? 'batch-timing'
                  : sql.includes('task_steps')
                    ? 'task-steps'
                    : 'other';
                active.sqlCategories[category] = (active.sqlCategories[category] ?? 0) + 1;
                if (/^(INSERT|UPDATE|DELETE)/i.test(sql)) active.writes++;
              }
            }
          };
        },
      });
    };
    const originalExec = storageDb.exec.bind(storageDb);
    storageDb.exec = (sql: string) => {
      const start = performance.now();
      try {
        return originalExec(sql);
      } finally {
        if (active) {
          const elapsed = performance.now() - start;
          active.execMs += elapsed;
          if (sql === 'COMMIT') {
            active.commits++;
            active.commitMs += elapsed;
          }
        }
      }
    };
    const originalParse = JSON.parse;
    const schemas = [
      ['TaskPlan', TaskPlan],
      ['TaskOverview', TaskOverview],
      ['TaskRuntimeOverview', TaskRuntimeOverview],
      ['TaskStepV2', TaskStepV2],
    ] as const;
    const restoreSchema: (() => void)[] = [];
    const restoreRepository: (() => void)[] = [];
    for (const name of ['settings', 'list', 'steps'] as const) {
      const repository = store.tasks as any;
      const original = repository[name].bind(repository);
      repository[name] = (...args: any[]) => {
        const start = performance.now();
        try {
          return original(...args);
        } finally {
          if (active)
            active.repositoryMs[name] =
              (active.repositoryMs[name] ?? 0) + performance.now() - start;
        }
      };
      restoreRepository.push(() => {
        repository[name] = original;
      });
    }
    JSON.parse = function (...args: any[]) {
      const start = performance.now();
      try {
        return (originalParse as any)(...args);
      } finally {
        if (active) {
          active.jsonParses++;
          active.jsonParseMs += performance.now() - start;
        }
      }
    } as typeof JSON.parse;
    for (const [name, schema] of schemas) {
      const original = schema.parse;
      (schema as any).parse = function (...args: any[]) {
        const start = performance.now();
        try {
          return (original as any)(...args);
        } finally {
          if (active) {
            active.schemaCalls[name] = (active.schemaCalls[name] ?? 0) + 1;
            active.schemaMs[name] = (active.schemaMs[name] ?? 0) + performance.now() - start;
          }
        }
      };
      restoreSchema.push(() => {
        (schema as any).parse = original;
      });
    }
    function measure(name: string, fn: () => unknown) {
      const row = {
        name,
        prepares: 0,
        prepareMs: 0,
        sqlCalls: 0,
        sqlMs: 0,
        writes: 0,
        execMs: 0,
        commits: 0,
        commitMs: 0,
        jsonParses: 0,
        jsonParseMs: 0,
        sqlCategories: {} as Record<string, number>,
        schemaMs: {} as Record<string, number>,
        schemaCalls: {} as Record<string, number>,
        repositoryMs: {} as Record<string, number>,
        instrumented: !name.includes('uninstrumented'),
      };
      active = row;
      const start = performance.now();
      const value = fn();
      const durationMs = performance.now() - start;
      active = null;
      const serialize = performance.now();
      const json = JSON.stringify(value);
      const serializedMs = performance.now() - serialize;
      const parse = performance.now();
      originalParse(json);
      const clientJsonParseMs = performance.now() - parse;
      measurements.push({
        ...row,
        durationMs,
        serializedMs,
        clientJsonParseMs,
        responseBytes: Buffer.byteLength(json),
      });
      return value;
    }
    try {
      measure('workspace-first-account-cache', () => service.snapshot());
      measure('runtime-cold', () => tasks.runtimeOverview());
      for (let round = 0; round < 20; round++) {
        measure('workspace-idle', () => service.snapshot());
        measure('runtime-idle', () => tasks.runtimeOverview());
        const plan = plans[round % plans.length]!;
        // Generated progress mutation, no input or native operation; no claim of real task execution.
        const update = performance.now();
        db.prepare('UPDATE task_steps SET progress=? WHERE job_id=? AND position=0').run(
          JSON.stringify({
            revision: round + 1,
            effectiveMilliseconds: (round + 1) * 1000,
            likes: 0,
            published: 0,
            cursor: null,
          }),
          plan.id,
        );
        const mutationMs = performance.now() - update;
        measure('runtime-one-progress-changed', () => tasks.runtimeOverview());
        (measurements[measurements.length - 1] as any).fixtureMutationMs = mutationMs;
      }
    } finally {
      JSON.parse = originalParse;
      for (const restore of restoreSchema) restore();
      for (const restore of restoreRepository) restore();
      storageDb.prepare = originalPrepare;
      storageDb.exec = originalExec;
    }
    for (let round = 0; round < 20; round++)
      measure('runtime-uninstrumented', () => tasks.runtimeOverview());
    const groups: Record<string, unknown> = {};
    for (const name of new Set(measurements.map((m) => m.name))) {
      const rows = measurements.filter((m) => m.name === name);
      groups[name] = {
        duration: stats(rows.map((m) => m.durationMs)),
        serialize: stats(rows.map((m) => m.serializedMs)),
        representative: rows[rows.length - 1],
      };
    }
    const result = {
      scenarioId,
      order,
      historyDepth,
      running,
      queued: count - running,
      fixtureStates,
      seedMs,
      profiles: count,
      plans: count * (historyDepth + 1),
      activePlans: count,
      stepsPerPlan: 8,
      state: 'generated states only; no executor, actor admission, browser or native operations',
      groups,
      measurements,
    };
    results.push(result);
    db.close();
    store.close();
    if (config.reportDir) {
      await writeFile(
        path.join(config.reportDir, `e1-${scenarioId}.json`),
        JSON.stringify(result, null, 2),
      );
      console.log(JSON.stringify({ completed: scenarioId, plans: result.plans }));
    }
  }
  return {
    versions: process.versions,
    limitation:
      'Synthetic real-repository read/parse/serialization baseline, not live RPC/business load; instrumentation adds overhead; sql and nested parse timings not all additive.',
    results,
  };
}
