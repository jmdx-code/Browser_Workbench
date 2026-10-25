import type { DatabaseSync } from 'node:sqlite';
import { ProductError } from '../domain/workspace.js';
import {
  assertWriteContext,
  transaction,
  transactionWithNonblockingBegin,
} from './sqlite-transaction.js';

type Pending = { work: () => void; resolve: () => void; reject: (error: unknown) => void };
const expectedRejections = new Set(['CHECKPOINT_NOT_READY', 'CHECKPOINT_CONFLICT', 'STALE_STEP']);

// Progress checkpoints only; no browser/network work and no success before the outer COMMIT.
export class CheckpointCommitQueue {
  private readonly pending: Pending[] = [];
  private scheduled: ReturnType<typeof setImmediate> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lockWaitStarted: number | null = null;
  private lockAttempt = 0;
  private lockRetries = 0;
  private closed = false;
  private failure: unknown = null;
  private batches = 0;
  private totalBatchMs = 0;
  private maxBatchMs = 0;
  constructor(
    private readonly db: DatabaseSync,
    private readonly batchSize = 4,
    private readonly capacity = 256,
    private readonly lockWaitMs = 5000,
  ) {
    if (
      !Number.isInteger(batchSize) ||
      batchSize < 1 ||
      !Number.isInteger(capacity) ||
      capacity < batchSize ||
      !Number.isFinite(lockWaitMs) ||
      lockWaitMs < 0 ||
      lockWaitMs > 60000
    )
      throw Error('CHECKPOINT_QUEUE_BUDGET_INVALID');
  }
  enqueue(work: () => void): Promise<void> {
    assertWriteContext(this.db);
    if (this.closed) return Promise.reject(Error('CHECKPOINT_QUEUE_CLOSED'));
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.length >= this.capacity) return Promise.reject(Error('CHECKPOINT_QUEUE_FULL'));
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ work, resolve, reject });
      this.schedule();
    });
  }
  private schedule() {
    if (this.scheduled || this.retryTimer || this.closed || this.failure || !this.pending.length)
      return;
    this.scheduled = setImmediate(() => {
      this.scheduled = null;
      this.flushOne();
    });
  }
  private flushOne() {
    const started = performance.now();
    const batch = this.pending.splice(0, this.batchSize);
    const rejections = new Map<Pending, unknown>();
    let workStarted = false;
    try {
      transactionWithNonblockingBegin(this.db, () => {
        workStarted = true;
        for (const item of batch) {
          try {
            transaction(this.db, item.work);
          } catch (error) {
            if (
              !(error instanceof ProductError) ||
              !expectedRejections.has(error.code) ||
              !this.db.isTransaction
            )
              throw error;
            rejections.set(item, error);
          }
        }
      });
      this.batches++;
      this.lockWaitStarted = null;
      this.lockAttempt = 0;
      const elapsed = performance.now() - started;
      this.totalBatchMs += elapsed;
      this.maxBatchMs = Math.max(this.maxBatchMs, elapsed);
      for (const item of batch) {
        if (rejections.has(item)) item.reject(rejections.get(item));
        else item.resolve();
      }
    } catch (error) {
      const remaining = this.lockWaitMs - (performance.now() - (this.lockWaitStarted ?? started));
      if (
        !workStarted &&
        !this.db.isTransaction &&
        error instanceof Error &&
        'errcode' in error &&
        typeof error.errcode === 'number' &&
        (error.errcode & 255) === 5 &&
        remaining > 0
      ) {
        // BEGIN acquired nothing: no callback, write, commit or browser input has happened.
        // Recheck the original job when the lock is actually acquired, including stop/revision.
        this.lockWaitStarted ??= started;
        this.pending.unshift(...batch);
        this.lockRetries++;
        const delay = Math.min(remaining, 250, 20 * 2 ** Math.min(this.lockAttempt++, 4));
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.schedule();
        }, delay);
        return;
      }
      // Never report success for a SAVEPOINT whose outer COMMIT failed or retry it.
      this.failure = error;
      for (const item of [...batch, ...this.pending.splice(0)]) item.reject(error);
    }
    this.schedule(); // Yield between bounded batches so stop/renew traffic gets a turn.
  }
  status() {
    return {
      pending: this.pending.length,
      batches: this.batches,
      totalBatchMs: this.totalBatchMs,
      maxBatchMs: this.maxBatchMs,
      lockRetries: this.lockRetries,
      waitingForLock: this.retryTimer !== null,
      failed: this.failure !== null,
    };
  }
  close() {
    this.closed = true;
    if (this.scheduled) clearImmediate(this.scheduled);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.scheduled = null;
    this.retryTimer = null;
    for (const item of this.pending.splice(0)) item.reject(Error('CHECKPOINT_QUEUE_CLOSED'));
  }
}
