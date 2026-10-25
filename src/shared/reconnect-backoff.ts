// Transport retries only: never retries task commands or changes an input lease.
export class ReconnectBackoff {
  private attempts = 0;
  private nextAttemptAt = 0;
  private connectedAt: number | null = null;
  canAttempt(now: number) {
    return now >= this.nextAttemptAt;
  }
  connected(now: number) {
    this.connectedAt = now;
  }
  healthy(now: number) {
    if (this.connectedAt !== null && now >= this.connectedAt && now - this.connectedAt >= 10000)
      this.attempts = 0;
  }
  failed(now: number, random = Math.random) {
    this.connectedAt = null;
    const ceiling = Math.min(30000, 2000 * 2 ** Math.min(this.attempts, 4));
    this.attempts = Math.min(this.attempts + 1, 5);
    const delay = Math.floor(ceiling / 2 + (Math.max(0, Math.min(1, random())) * ceiling) / 2);
    this.nextAttemptAt = now + delay;
    return delay;
  }
  reset() {
    this.attempts = 0;
    this.nextAttemptAt = 0;
    this.connectedAt = null;
  }
}
