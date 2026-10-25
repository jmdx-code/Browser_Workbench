import type { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';

const readContexts = new AsyncLocalStorage<Set<DatabaseSync>>();
const commitHooks = new WeakMap<DatabaseSync, () => void>();
export function beforeCommit(db: DatabaseSync, hook: () => void) {
  commitHooks.set(db, hook);
}

interface ConnectionTransactionState {
  writeDepth: number;
  readDepth: number;
}

const connectionStates = new WeakMap<DatabaseSync, ConnectionTransactionState>();

function getState(db: DatabaseSync): ConnectionTransactionState {
  let state = connectionStates.get(db);
  if (!state) {
    state = { writeDepth: 0, readDepth: 0 };
    connectionStates.set(db, state);
  }
  return state;
}

function isThenable(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

let savepointIndex = 0;

export function assertWriteContext(db: DatabaseSync) {
  const state = getState(db);
  if (state.readDepth > 0 || readContexts.getStore()?.has(db)) {
    throw Error('WRITE_IN_READ_SNAPSHOT_FORBIDDEN');
  }
}

// Only lock acquisition is non-blocking. Once BEGIN succeeds, restore the connection's
// original policy before executing any work. There is never an async open transaction.
export function transactionWithNonblockingBegin<T>(db: DatabaseSync, work: () => T): T {
  assertWriteContext(db);
  if (db.isTransaction) throw Error('ASYNC_COMMIT_REQUIRES_OWN_TRANSACTION');
  const timeout = Number(db.prepare('PRAGMA busy_timeout').get()?.timeout ?? 0);
  db.exec('PRAGMA busy_timeout=0');
  try {
    return transaction(db, () => {
      db.exec(`PRAGMA busy_timeout=${timeout}`);
      return work();
    });
  } finally {
    db.exec(`PRAGMA busy_timeout=${timeout}`);
  }
}

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  assertWriteContext(db);
  const state = getState(db);
  if (db.isTransaction) {
    const name = 'workbench_sp_' + ++savepointIndex;
    db.exec('SAVEPOINT ' + name);
    state.writeDepth++;
    try {
      const result = work();
      if (isThenable(result)) {
        throw Error('TRANSACTION_ASYNC_FORBIDDEN');
      }
      db.exec('RELEASE ' + name);
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK TO ' + name);
        db.exec('RELEASE ' + name);
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'SQLITE_SAVEPOINT_ROLLBACK_FAILED');
      }
      throw error;
    } finally {
      state.writeDepth--;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  state.writeDepth++;
  try {
    const result = work();
    if (isThenable(result)) {
      throw Error('TRANSACTION_ASYNC_FORBIDDEN');
    }
    commitHooks.get(db)?.();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      if (db.isTransaction) db.exec('ROLLBACK');
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'SQLITE_TRANSACTION_ROLLBACK_FAILED');
    }
    throw error;
  } finally {
    state.writeDepth--;
  }
}

export function readSnapshot<T>(db: DatabaseSync, work: () => T): T {
  if (work.constructor.name === 'AsyncFunction') throw Error('READ_SNAPSHOT_ASYNC_FORBIDDEN');
  const contexts = new Set(readContexts.getStore());
  contexts.add(db);
  return readContexts.run(contexts, () => guardedReadSnapshot(db, work));
}

function guardedReadSnapshot<T>(db: DatabaseSync, work: () => T): T {
  const state = getState(db);
  // SQLite also fences direct prepare().run()/exec() writes, not only our helper.
  const queryOnly = Number(db.prepare('PRAGMA query_only').get()?.query_only);
  db.exec('PRAGMA query_only=ON');
  try {
    return performReadSnapshot(db, work, state);
  } finally {
    db.exec(`PRAGMA query_only=${queryOnly ? 'ON' : 'OFF'}`);
  }
}

function performReadSnapshot<T>(
  db: DatabaseSync,
  work: () => T,
  state: ConnectionTransactionState,
): T {
  if (db.isTransaction) {
    state.readDepth++;
    try {
      const result = work();
      if (isThenable(result)) {
        throw Error('READ_SNAPSHOT_ASYNC_FORBIDDEN');
      }
      return result;
    } finally {
      state.readDepth--;
    }
  }
  db.exec('BEGIN');
  state.readDepth++;
  try {
    const result = work();
    if (isThenable(result)) {
      throw Error('READ_SNAPSHOT_ASYNC_FORBIDDEN');
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    state.readDepth--;
  }
}
