import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync, readFileSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceStore } from '../../src/infrastructure/workspace-store.js';
import { SqliteTaskRepository } from '../../src/infrastructure/task-store.js';
import { transaction } from '../../src/infrastructure/sqlite-transaction.js';
import type { RuntimeProfile } from '../../src/domain/tasks.js';

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0;
  return {
    count: sorted.length,
    sumMs: values.reduce((a, b) => a + b, 0),
    p50Ms: p(0.5),
    p95Ms: p(0.95),
    p99Ms: p(0.99),
    maxMs: p(1),
  };
}
export async function runE2(config: { id: string; scratch: string; reportDir: string }) {
  assert.equal(readFileSync(path.join(config.scratch, '.isolated-lab'), 'utf8'), config.id);
  const results = [];
  for (const [index, mode] of [
    { batch: 1, queued: false },
    { batch: 8, queued: false },
    { batch: 4, queued: false },
    { batch: 1, queued: false },
    { batch: 4, queued: true },
  ].entries()) {
    const { batch, queued } = mode;
    const file = path.join(config.scratch, 'e2-' + index + '-batch-' + batch + '.sqlite');
    const store = await WorkspaceStore.open(file);
    store.tasks.setSettings({ maxConcurrentProfiles: 100 });
    const profiles: RuntimeProfile[] = Array.from({ length: 100 }, (_, i) => ({
      id: randomUUID(),
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in', id: 'generated-' + i, name: null, avatar: null },
    }));
    const combination = store.createCombination({
      name: 'E2 generated checkpoint load',
      note: 'No browser executor',
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: combination.id,
        version: 1,
        profileIds: profiles.map((p) => p.id),
      },
      profiles,
    );
    for (let i = 0; i < 100; i++) assert.ok(store.tasks.claimNext(profiles, new Set(['feed'])));
    store.close();
    const db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    const repo = new SqliteTaskRepository(db);
    const rows = repo
      .livePlans()
      .map((plan) => ({ plan, step: repo.currentStepForPlan(plan.id, plan.round, plan.position) }));
    assert.ok(rows.every((row) => row.step));
    const configuration = {
      sqlite: process.versions.sqlite,
      pageSize: db.prepare('PRAGMA page_size').get()?.page_size,
      synchronous: db.prepare('PRAGMA synchronous').get()?.synchronous,
      automaticCheckpointPages: db.prepare('PRAGMA wal_autocheckpoint').get()?.wal_autocheckpoint,
    };
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const wal = file + '-wal';
    const fd = openSync(wal, 'r');
    const header = Buffer.alloc(32);
    let salt: string | null = null;
    const restarts: { commitIndex: number; previousCommitMs: number; currentCommitMs: number }[] =
      [];
    const commits: number[] = [],
      waveTimes: number[] = [],
      timerGaps: number[] = [],
      acknowledgements: number[] = [];
    let previousTick = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      timerGaps.push(now - previousTick);
      previousTick = now;
    }, 5);
    const yieldTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    timerGaps.length = 0;
    previousTick = performance.now();
    const started = performance.now();
    try {
      for (let wave = 0; wave < 20; wave++) {
        const waveStart = performance.now();
        if (queued) {
          await Promise.all(
            rows.map(async (row) => {
              assert.ok(row.step);
              const start = performance.now();
              await repo.checkpointAsync(row.plan.id, row.step.id, wave, {
                ...row.step.progress,
                revision: wave + 1,
                effectiveMilliseconds: wave + 1,
              });
              acknowledgements.push(performance.now() - start);
            }),
          );
          if (readSync(fd, header, 0, 32, 0) === 32) {
            const nextSalt = header.subarray(16, 24).toString('hex');
            if (salt !== null && salt !== nextSalt)
              restarts.push({
                commitIndex: repo.checkpointCommitStatus().batches - 1,
                previousCommitMs: 0,
                currentCommitMs: 0,
              });
            salt = nextSalt;
          }
        } else
          for (let offset = 0; offset < rows.length; offset += batch) {
            const start = performance.now();
            const work = () => {
              for (const row of rows.slice(offset, offset + batch)) {
                assert.ok(row.step);
                const progress = {
                  ...row.step.progress,
                  revision: wave + 1,
                  effectiveMilliseconds: wave + 1,
                };
                repo.checkpoint(row.plan.id, row.step.id, wave, progress);
              }
            };
            if (batch === 1) work();
            else transaction(db, work);
            commits.push(performance.now() - start);
            if (readSync(fd, header, 0, 32, 0) === 32) {
              const nextSalt = header.subarray(16, 24).toString('hex');
              if (salt !== null && salt !== nextSalt)
                restarts.push({
                  commitIndex: commits.length - 1,
                  previousCommitMs: commits.at(-2) ?? 0,
                  currentCommitMs: commits.at(-1) ?? 0,
                });
              salt = nextSalt;
            }
          }
        waveTimes.push(performance.now() - waveStart);
        await yieldTurn();
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
      const elapsedMs = performance.now() - started;
      const finalProgress = rows.map(
        (row) =>
          repo.currentStepForPlan(row.plan.id, row.plan.round, row.plan.position)?.progress
            .revision,
      );
      assert.ok(finalProgress.every((revision) => revision === 20));
      const result = {
        batch,
        queued,
        configuration,
        updates: 2000,
        commits: stats(commits),
        asynchronousCommits: repo.checkpointCommitStatus(),
        acknowledgements: stats(acknowledgements),
        waves: stats(waveTimes),
        timerGaps: stats(timerGaps),
        elapsedMs,
        updatesPerSecond: 2000000 / elapsedMs,
        walBytes: statSync(wal).size,
        walSaltRestarts: restarts,
        finalProgressAll20: true,
        scope:
          '100 generated RUNNING plans, real checkpoint repository; 20 bursts of 100 writes; grouped reference excludes collection wait; timer includes measurement overhead; WAL salt restarts show checkpoint/reuse, not exact attribution of slow commits',
      };
      results.push(result);
      await writeFile(
        path.join(config.reportDir, 'commit-summary.json'),
        JSON.stringify({ versions: process.versions, results }, null, 2),
      );
    } finally {
      clearInterval(timer);
      closeSync(fd);
      repo.closeCheckpoints();
      db.close();
    }
  }
  return { versions: process.versions, results };
}
