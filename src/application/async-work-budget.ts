import type { Awaitable } from '../domain/persistence.js';
// Bounded FIFO for expensive phases. A permit never grants account or input authority.
export class AsyncWorkBudget {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(
    private readonly limit: number,
    private readonly capacity: number,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(capacity) || capacity < 1)
      throw Error('WORK_BUDGET_INVALID');
  }
  run<T>(guard: () => Awaitable<void>, work: () => Promise<T>): Promise<T> {
    if (this.waiting.length >= this.capacity)
      return Promise.reject(Error('HEAVY_PHASE_QUEUE_FULL'));
    const admission = Promise.resolve().then(guard);
    void admission.catch(() => {});
    return new Promise<T>((resolve, reject) => {
      this.waiting.push(() => {
        void admission
          .then(guard)
          .then(work)
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.drain();
          });
      });
      this.drain();
    });
  }
  private drain() {
    while (this.active < this.limit && this.waiting.length) {
      const next = this.waiting.shift();
      if (!next) break;
      this.active++;
      next();
    }
  }
  status() {
    return { active: this.active, waiting: this.waiting.length, limit: this.limit };
  }
}
