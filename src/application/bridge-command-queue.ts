// Serializes the existing command lane; control stop drains writes, not stalled reads.
export class BridgeCommandQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly writes = new Set<Promise<void>>();
  enqueue(write: boolean, run: () => Promise<void>): Promise<void> {
    const work = this.tail.catch(() => {}).then(run);
    this.tail = work;
    if (write) this.writes.add(work);
    void work.finally(() => this.writes.delete(work)).catch(() => {});
    return work;
  }
  async drainWrites(): Promise<void> {
    await Promise.allSettled([...this.writes]);
  }
}
