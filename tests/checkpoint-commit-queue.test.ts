import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { SqliteTaskRepository } from '../src/infrastructure/task-store.js';
import { CheckpointCommitQueue } from '../src/infrastructure/checkpoint-commit-queue.js';
import { beforeCommit, readSnapshot } from '../src/infrastructure/sqlite-transaction.js';
import type { RuntimeProfile } from '../src/domain/tasks.js';

async function fixture(
  run: (
    repo: SqliteTaskRepository,
    db: DatabaseSync,
    reader: DatabaseSync,
    jobs: { id: string; step: string }[],
    file: string,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-checkpoint-commit-'));
  const file = path.join(directory, 'workspace.sqlite');
  const store = await WorkspaceStore.open(file);
  store.tasks.setSettings({ maxConcurrentProfiles: 8 });
  const saved = store.createCombination({
    name: 'Generated durable checkpoints',
    note: '',
    steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
  });
  const profiles: RuntimeProfile[] = Array.from({ length: 8 }, (_, i) => ({
    id: randomUUID(),
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: true,
    account: { state: 'logged-in', id: 'generated-' + i, name: null, avatar: null },
  }));
  store.tasks.assign(
    {
      requestId: randomUUID(),
      combinationId: saved.id,
      version: 1,
      profileIds: profiles.map((p) => p.id),
    },
    profiles,
  );
  const jobs = Array.from({ length: 8 }, () => {
    const plan = store.tasks.claimNext(profiles, new Set(['feed']));
    assert.ok(plan);
    const step = store.tasks.currentStepForPlan(plan.id, plan.round, plan.position);
    assert.ok(step);
    return { id: plan.id, step: step.id };
  });
  store.close();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
  const reader = new DatabaseSync(file, { readOnly: true });
  const repo = new SqliteTaskRepository(db);
  try {
    await run(repo, db, reader, jobs, file);
  } finally {
    repo.closeCheckpoints();
    reader.close();
    db.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('workbench-checkpoint-commit-'));
    await rm(directory, { recursive: true, force: true });
  }
}
const progress = { revision: 1, effectiveMilliseconds: 1, likes: 0, published: 0, cursor: null };
const revision = (db: DatabaseSync, id: string) =>
  Number(
    db
      .prepare("SELECT json_extract(progress,'$.revision') AS revision FROM task_steps WHERE id=?")
      .get(id)?.revision,
  );

test('checkpoint promises resolve after the shared durable commit; expected conflicts only reject their own item', async () => {
  await fixture(async (repo, _db, reader, jobs) => {
    const a = jobs[0]!,
      b = jobs[1]!;
    let returned = false;
    const first = repo.checkpointAsync(a.id, a.step, 0, progress).then(() => {
      returned = true;
    });
    const conflict = assert.rejects(repo.checkpointAsync(a.id, a.step, 0, progress), /已变化/);
    const last = repo.checkpointAsync(b.id, b.step, 0, progress);
    assert.equal(returned, false);
    assert.equal(revision(reader, a.step), 0);
    await Promise.all([first, conflict, last]);
    assert.equal(returned, true);
    assert.equal(revision(reader, a.step), 1);
    assert.equal(revision(reader, b.step), 1);
    assert.equal(repo.checkpointCommitStatus().batches, 1);
  });
});

test('external write lock waits asynchronously before BEGIN, retains the original timeout and acknowledges only after commit', async () => {
  await fixture(async (repo, db, reader, jobs, file) => {
    db.exec('PRAGMA busy_timeout=5000');
    const holder = new DatabaseSync(file);
    holder.exec('BEGIN IMMEDIATE');
    let released = false;
    const timer = setTimeout(() => {
      holder.exec('ROLLBACK');
      released = true;
    }, 60);
    const started = performance.now();
    try {
      const job = jobs[0]!;
      await repo.checkpointAsync(job.id, job.step, 0, progress);
      assert.equal(released, true);
      assert.ok(
        performance.now() - started < 1500,
        'the same-loop release timer must not wait for synchronous busy_timeout',
      );
      assert.ok(repo.checkpointCommitStatus().lockRetries > 0);
      assert.equal(repo.checkpointCommitStatus().failed, false);
      assert.equal(revision(reader, job.step), 1);
      assert.equal(db.prepare('PRAGMA busy_timeout').get()?.timeout, 5000);
    } finally {
      clearTimeout(timer);
      if (holder.isTransaction) holder.exec('ROLLBACK');
      holder.close();
    }
  });
});

test('lock deadline rejects without executing work, preserves queued limits and closing cancels retries', async () => {
  await fixture(async (_repo, db, reader, jobs, file) => {
    const holder = new DatabaseSync(file);
    holder.exec('BEGIN IMMEDIATE');
    const queue = new CheckpointCommitQueue(db, 1, 1, 60);
    let writes = 0;
    try {
      const waiting = assert.rejects(
        queue.enqueue(() => {
          writes++;
        }),
        /locked/,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(queue.status().waitingForLock, true);
      await assert.rejects(
        queue.enqueue(() => {
          writes++;
        }),
        /QUEUE_FULL/,
      );
      await waiting;
      assert.equal(writes, 0);
      assert.equal(queue.status().failed, true);
      assert.equal(revision(reader, jobs[0]!.step), 0);
      const other = new CheckpointCommitQueue(db);
      const pending = assert.rejects(
        other.enqueue(() => {
          writes++;
        }),
        /CLOSED/,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      other.close();
      await pending;
      holder.exec('ROLLBACK');
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      assert.equal(writes, 0);
      assert.equal(other.status().waitingForLock, false);
    } finally {
      queue.close();
      if (holder.isTransaction) holder.exec('ROLLBACK');
      holder.close();
    }
  });
});

test('checkpoint flush refuses an unrelated open transaction instead of acknowledging its SAVEPOINT before outer commit', async () => {
  await fixture(async (repo, db, reader, jobs) => {
    const job = jobs[0]!;
    db.exec('BEGIN IMMEDIATE');
    try {
      await assert.rejects(repo.checkpointAsync(job.id, job.step, 0, progress), /OWN_TRANSACTION/);
      assert.equal(revision(reader, job.step), 0);
      assert.equal(db.isTransaction, true);
    } finally {
      db.exec('ROLLBACK');
    }
  });
});

test('BUSY at COMMIT rolls the whole batch back and never reruns callbacks as lock acquisition retries', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-commit-busy-'));
  const file = path.join(directory, 'fixture.sqlite');
  const db = new DatabaseSync(file);
  db.exec(
    'PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=15; CREATE TABLE counter(value INTEGER); INSERT INTO counter VALUES(0)',
  );
  const reader = new DatabaseSync(file, { readOnly: true });
  reader.exec('BEGIN');
  reader.prepare('SELECT * FROM counter').get();
  const queue = new CheckpointCommitQueue(db);
  let calls = 0;
  try {
    const outcomes = await Promise.allSettled(
      [1, 2].map(() =>
        queue.enqueue(() => {
          calls++;
          db.prepare('UPDATE counter SET value=value+1').run();
        }),
      ),
    );
    assert.ok(
      outcomes.every(
        (outcome) => outcome.status === 'rejected' && /locked/.test(String(outcome.reason)),
      ),
    );
    assert.equal(calls, 2);
    assert.equal(queue.status().failed, true);
    assert.equal(queue.status().lockRetries, 0);
    assert.equal(db.isTransaction, false);
    reader.exec('ROLLBACK');
    assert.equal(reader.prepare('SELECT value FROM counter').get()?.value, 0);
    await assert.rejects(
      queue.enqueue(() => {
        calls++;
      }),
      /locked/,
    );
    assert.equal(calls, 2);
    assert.equal(db.prepare('PRAGMA busy_timeout').get()?.timeout, 15);
  } finally {
    queue.close();
    if (reader.isTransaction) reader.exec('ROLLBACK');
    reader.close();
    db.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('workbench-commit-busy-'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('stop revokes immediately while a queued checkpoint rechecks the current state at execution', async () => {
  await fixture(async (repo, _db, reader, jobs) => {
    const a = jobs[0]!,
      b = jobs[1]!;
    const cancelled = assert.rejects(repo.checkpointAsync(a.id, a.step, 0, progress), /未运行/);
    const other = repo.checkpointAsync(b.id, b.step, 0, progress);
    const stopped = repo.requestControl(a.id, 'stop', 'USER_STOP');
    assert.equal(stopped.state, 'STOPPING');
    await Promise.all([cancelled, other]);
    assert.equal(revision(reader, a.step), 0);
    assert.equal(revision(reader, b.step), 1);
  });
});

for (const failure of ['sql', 'commit-hook', 'transaction-lost'] as const) {
  test(
    'global checkpoint failure rolls back all writes and rejects every pending acknowledgement: ' +
      failure,
    async () => {
      await fixture(async (repo, db, reader, jobs) => {
        const bad = jobs[1]!;
        if (failure === 'commit-hook')
          beforeCommit(db, () => {
            throw Error('INJECTED_COMMIT_FAILURE');
          });
        else
          db.exec(
            `CREATE TRIGGER injected_checkpoint_failure BEFORE INSERT ON task_events WHEN NEW.job_id='${bad.id}' AND NEW.type='CHECKPOINT' BEGIN SELECT RAISE(${failure === 'transaction-lost' ? 'ROLLBACK' : 'ABORT'},'INJECTED_SQL_FAILURE'); END`,
          );
        const outcomes = await Promise.allSettled(
          jobs.map((job) => repo.checkpointAsync(job.id, job.step, 0, progress)),
        );
        assert.ok(outcomes.every((outcome) => outcome.status === 'rejected'));
        assert.ok(jobs.every((job) => revision(reader, job.step) === 0));
        assert.equal(db.isTransaction, false);
        assert.equal(repo.checkpointCommitStatus().failed, true);
        await assert.rejects(repo.checkpointAsync(bad.id, bad.step, 0, progress));
        if (failure === 'transaction-lost') {
          const outcome = outcomes[0];
          assert.ok(outcome?.status === 'rejected');
          assert.ok(outcome.reason instanceof AggregateError);
          assert.equal(outcome.reason.errors.length, 2);
        }
      });
    },
  );
}

test('read scope rejects asynchronous writes at enqueue, and closing the bounded queue never acknowledges unwritten work', async () => {
  await fixture(async (repo, db, reader, jobs) => {
    const job = jobs[0]!;
    assert.throws(
      () => readSnapshot(db, () => repo.checkpointAsync(job.id, job.step, 0, progress)),
      /WRITE_IN_READ/,
    );
    const queue = new CheckpointCommitQueue(db, 1, 1);
    const pending = assert.rejects(
      queue.enqueue(() => repo.checkpoint(job.id, job.step, 0, progress)),
      /CLOSED/,
    );
    await assert.rejects(
      queue.enqueue(() => {}),
      /QUEUE_FULL/,
    );
    queue.close();
    await pending;
    assert.equal(revision(reader, job.step), 0);
    assert.equal(repo.checkpointCommitStatus().failed, false);
  });
});
