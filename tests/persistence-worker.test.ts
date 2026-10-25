import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Worker } from 'node:worker_threads';
import { PersistenceClient } from '../src/infrastructure/persistence-client.js';
import { ProductError } from '../src/domain/workspace.js';
import { randomUUID } from 'node:crypto';
import { emptyResourceRow } from '../src/domain/resource-table.js';

test('worker bundle persists optional row AI and retains immutable pre-AI resource versions', async () => {
  await fixture(async (client) => {
    const combo = await client.workspace.createDraft({
      name: 'row AI worker',
      note: '',
      steps: [
        {
          id: randomUUID(),
          type: 'post',
          resourceMode: 'table',
          resourceDirectory: '',
          count: 1,
          allowRepeat: false,
          forbidSameAccountRepeat: true,
          archivePublished: false,
        },
      ],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    const row = { ...emptyResourceRow(randomUUID()), text: 'fixture' };
    await client.workspace.resourceTables.save(combo.id, 0, [row]);
    await client.workspace.resourceTables.save(combo.id, 1, [{ ...row, aiLabel: 'on' }]);
    assert.equal((await client.workspace.resourceTables.read(combo.id)).rows[0]?.aiLabel, 'on');
    assert.deepEqual((await client.workspace.resourceTables.readVersion(combo.id, 1)).rows, [row]);
  });
});

async function fixture(work: (client: PersistenceClient, file: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-worker-'));
  const client = await PersistenceClient.open(directory);
  try {
    await work(client, path.join(directory, 'workspace.sqlite'));
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('worker preserves committed units and structured business errors; private routes are unavailable', async () => {
  await fixture(async (client) => {
    const group = await client.workspace.createGroup('isolated', 'gray');
    assert.ok((await client.workspace.groups()).some((row) => row.id === group.id));
    await assert.rejects(
      client.workspace.createGroup('isolated', 'gray'),
      (error: unknown) =>
        error instanceof ProductError && error.code === 'GROUP_NAME_EXISTS' && error.status === 409,
    );
    assert.throws(() => Reflect.get(client.workspace, 'db'), /MEMBER_REJECTED/);
    await assert.rejects(
      Reflect.apply(Reflect.get(client.workspace, 'nonexistent'), undefined, []),
      /ROUTE_REJECTED/,
    );
  });
});

test('SQLite lock waiting does not block communication timers and never acknowledges an uncommitted write', async () => {
  await fixture(async (client, file) => {
    const lock = new DatabaseSync(file);
    let ticks = 0,
      acknowledged = false,
      locked = true;
    const pulse = setInterval(() => ticks++, 5);
    lock.exec('BEGIN IMMEDIATE');
    const write = client.workspace.createGroup('locked-write', 'gray').then((row) => {
      acknowledged = true;
      assert.equal(locked, false);
      return row;
    });
    try {
      const deadline = performance.now() + 2000;
      while (ticks < 8 && performance.now() < deadline)
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      assert.equal(acknowledged, false);
      assert.ok(ticks >= 8, `communication ticks: ${ticks}`);
      locked = false;
      lock.exec('ROLLBACK');
      const group = await write;
      assert.ok(lock.prepare('SELECT id FROM groups WHERE id=?').get(group.id));
      assert.equal(lock.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
    } finally {
      if (locked) {
        locked = false;
        lock.exec('ROLLBACK');
      }
      await write.catch(() => {});
      clearInterval(pulse);
      lock.close();
    }
  });
});

test('bounded admission rejects excess calls and close drains every accepted command', async () => {
  await fixture(async (client, file) => {
    const lock = new DatabaseSync(file);
    lock.exec('BEGIN IMMEDIATE');
    const write = client.workspace.createGroup('queue-write', 'gray');
    const reads = Array.from({ length: 255 }, () => client.workspace.groups());
    try {
      await assert.rejects(client.workspace.groups(), /QUEUE_FULL/);
      const closing = client.close();
      await assert.rejects(client.workspace.groups(), /CLOSING/);
      lock.exec('ROLLBACK');
      await write;
      await Promise.all(reads);
      await closing;
      assert.equal(
        lock.prepare("SELECT count(*) AS n FROM groups WHERE name='queue-write'").get()!.n,
        1,
      );
    } finally {
      lock.close();
    }
  });
});

test('worker death rejects all callers once and never restarts or replays accepted writes', async () => {
  await fixture(async (client, file) => {
    let failures = 0;
    client.setFailureHandler(() => failures++);
    const lock = new DatabaseSync(file);
    lock.exec('BEGIN IMMEDIATE');
    const write = client.workspace.createGroup('uncertain-once', 'gray');
    const rejected = assert.rejects(write, /PERSISTENCE_WORKER_EXITED/);
    const worker = Reflect.get(client, 'worker') as Worker;
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      const terminating = worker.terminate();
      lock.exec('ROLLBACK');
      await terminating;
      await rejected;
      assert.equal(failures, 1);
      await assert.rejects(client.workspace.groups(), /PERSISTENCE_WORKER_EXITED/);
      const rows = lock
        .prepare("SELECT count(*) AS n FROM groups WHERE name='uncertain-once'")
        .get()!;
      assert.ok(Number(rows.n) <= 1); // Interrupted COMMIT is unknown, never guessed not applied.
    } finally {
      lock.close();
    }
  });
});

test('a future schema is rejected without mutating its version', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-future-worker-'));
  const file = path.join(directory, 'workspace.sqlite');
  let db = new DatabaseSync(file);
  db.exec('PRAGMA user_version=999');
  db.close();
  try {
    await assert.rejects(PersistenceClient.open(directory));
    db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 999);
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
