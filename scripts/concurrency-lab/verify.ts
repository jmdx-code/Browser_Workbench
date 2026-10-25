import { DatabaseSync, backup } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WorkspaceStore } from '../../src/infrastructure/workspace-store.js';
import { TaskService } from '../../src/application/task-service.js';
import { projectTaskRecords, compareRecords } from '../../src/domain/task-record-projection.js';
import { TaskStepV2 } from '../../src/shared/task-step-instance.js';
import type { Event, TaskRecord } from '../../src/shared/task-contracts.js';

export async function runVerification(config: {
  scratch: string;
  reportDir: string;
  scopeSource: string;
  id: string;
}) {
  const source = JSON.parse(await readFile(config.scopeSource, 'utf8'));
  assert.ok(path.basename(source.scratch).startsWith('workbench-concurrency-lab-'));
  assert.equal(await readFile(path.join(source.scratch, '.isolated-lab'), 'utf8'), source.id);
  assert.equal(await readFile(path.join(config.scratch, '.isolated-lab'), 'utf8'), config.id);
  const original = new DatabaseSync(path.join(source.scratch, 'records-h100.sqlite'), {
    readOnly: true,
  });
  const file = path.join(config.scratch, 'verification.sqlite');
  try {
    await backup(original, file);
  } finally {
    original.close();
  }
  const store = await WorkspaceStore.open(file);
  try {
    const db: DatabaseSync = (store as unknown as { db: DatabaseSync }).db;
    assert.equal(db.prepare('SELECT count(*) n FROM task_steps').get()?.n, 80800);
    assert.equal(db.prepare('SELECT count(*) n FROM task_outbox').get()?.n, 0);
    const canonical = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(canonical)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, canonical(v)]),
            )
          : value;
    const hash = (row: TaskRecord) =>
      createHash('sha256')
        .update(JSON.stringify(canonical(row)))
        .digest('hex');
    const stepsByPlan = new Map<string, Record<string, unknown>[]>();
    for (const row of db.prepare('SELECT * FROM task_steps ORDER BY job_id,round,position').all()) {
      const id = String(row.job_id),
        rows = stepsByPlan.get(id) ?? [];
      rows.push(row);
      stepsByPlan.set(id, rows);
    }
    const eventsByPlan = new Map<string, Event[]>();
    for (const row of db.prepare('SELECT * FROM task_events ORDER BY sequence').all()) {
      const id = String(row.job_id),
        events = eventsByPlan.get(id) ?? [];
      events.push({
        sequence: Number(row.sequence),
        jobId: id,
        type: String(row.type),
        detail: JSON.parse(String(row.detail)),
        createdAt: Number(row.created_at),
      });
      eventsByPlan.set(id, events);
    }
    // Same original pure JS rules, bulk-loaded inputs avoid tens of thousands of oracle SQL calls.
    const expected = store.tasks
      .list()
      .flatMap((plan) => {
        const rows = stepsByPlan.get(plan.id) ?? [];
        const steps = rows.map((row) =>
          TaskStepV2.parse({
            id: row.id,
            jobId: row.job_id,
            round: row.round,
            position: row.position,
            spec: JSON.parse(String(row.spec)),
            status: row.status,
            progress: JSON.parse(String(row.progress)),
            ...(row.outcome ? { outcome: JSON.parse(String(row.outcome)) } : {}),
          }),
        );
        return projectTaskRecords(plan, steps, [], eventsByPlan.get(plan.id) ?? []).map(
          ({ row }) => ({
            key: {
              stepId: row.stepId,
              finishedAt: row.finishedAt,
              startedAt: row.startedAt,
              planCreatedAt: row.planCreatedAt,
              round: row.round,
              position: row.position,
            },
            hash: hash(row),
          }),
        );
      })
      .sort((a, b) => compareRecords(a.key as TaskRecord, b.key as TaskRecord));
    stepsByPlan.clear();
    eventsByPlan.clear();
    const service = new TaskService(store.tasks),
      streamHash = createHash('sha256'),
      start = performance.now();
    let cursor: string | undefined,
      pages = 0,
      rows = 0;
    do {
      const page = service.records({ limit: 200, ...(cursor ? { cursor } : {}) });
      for (const row of page.records) {
        const oracle = expected[rows];
        assert.ok(oracle);
        assert.equal(row.stepId, oracle.key.stepId);
        const digest = hash(row);
        assert.equal(digest, oracle.hash, `row ${rows}`);
        streamHash.update(digest);
        rows++;
      }
      cursor = page.nextCursor ?? undefined;
      pages++;
      if (pages % 100 === 0)
        await writeFile(
          path.join(config.reportDir, 'progress.json'),
          JSON.stringify({ pages, rows, ms: performance.now() - start }),
        );
      assert.ok(pages < 1000);
    } while (cursor);
    assert.equal(rows, expected.length);
    const result = {
      versions: process.versions,
      source: config.scopeSource,
      pages,
      rows,
      elapsedMs: performance.now() - start,
      allFieldsAndOrderMatched: true,
      sha256CanonicalRowHashes: streamHash.digest('hex'),
      scope:
        'generated h100 database; no operations; real UNKNOWN/late disposition covered separately by control-read-model tests',
    };
    await writeFile(
      path.join(config.reportDir, 'verification-summary.json'),
      JSON.stringify(result, null, 2),
    );
    return result;
  } finally {
    store.close();
  }
}
