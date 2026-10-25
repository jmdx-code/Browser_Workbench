import type { Awaitable } from '../domain/persistence.js';
import type { MaterialArchivePreparationRepository } from '../domain/material-archive.js';
import type { MaterialArchivePreparation } from './material-archive-preparation.js';

export interface ArchiveExecutionPort {
  execute(attemptId: string, assertAllowed: () => Awaitable<void>): Promise<void>;
}

// Scheduling only: eligibility and all changes remain in the original publication/archive ledger.
// REVIEW is never automatically retried. One disk job at a time; shutdown drains before DB close.
export class MaterialArchiveWorker {
  private stopped = false;
  private active: Promise<void> | null = null;
  constructor(
    private readonly queue: Pick<MaterialArchivePreparationRepository, 'pending'>,
    private readonly preparation: Pick<MaterialArchivePreparation, 'prepare'>,
    private readonly execution: ArchiveExecutionPort,
    private readonly report: (attemptId: string, reason: string) => void = () => {},
  ) {}
  private polling?: Promise<void>;
  tick(): Promise<void> {
    if (this.polling) return this.polling;
    const work = this.tickOnce();
    this.polling = work;
    void work
      .finally(() => {
        if (this.polling === work) this.polling = undefined;
      })
      .catch(() => {});
    return work;
  }
  private async tickOnce() {
    if (this.stopped || this.active) return this.active ?? Promise.resolve();
    const attemptId = (await this.queue.pending(1))[0];
    if (!attemptId) return Promise.resolve();
    return this.start(attemptId);
  }
  resume(attemptId: string, assertRequested: () => Awaitable<void>) {
    if (this.stopped) throw Error('ARCHIVE_WORKER_STOPPED');
    if (this.active || this.polling) throw Error('ARCHIVE_WORKER_BUSY');
    void this.start(attemptId, assertRequested);
  }
  private start(attemptId: string, assertRequested: () => Awaitable<void> = () => {}) {
    const assertAllowed = () => {
      if (this.stopped) throw Error('ARCHIVE_WORKER_STOPPED');
    };
    // Start after active is set, including synchronous failures of an injected adapter.
    this.active = Promise.resolve()
      .then(async () => {
        assertAllowed();
        await assertRequested();
        await this.preparation.prepare(attemptId, assertAllowed);
        assertAllowed();
        await this.execution.execute(attemptId, assertAllowed);
      })
      .catch((error) => {
        this.report(attemptId, error instanceof Error ? error.message : 'ARCHIVE_WORKER_FAILED');
      })
      .finally(() => {
        this.active = null;
      });
    return this.active;
  }
  async close() {
    this.stopped = true;
    await this.polling;
    await this.active;
  }
}
