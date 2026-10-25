// One controller-wide foreground recovery slot. Denied callers retry; no delayed
// grants survive STOP or an owner change. This is presentation, never input authority.
export class PresentationFocusGate {
  constructor(
    private readonly globalGap = 1500,
    private readonly profileGap = 15000,
  ) {}
  cancel(key: string) {
    this.waiting.delete(key);
  }
  private nextAt = 0;
  private readonly waiting = new Map<string, number>();
  private readonly recovered = new Map<string, number>();
  request(key: string, now: number): boolean {
    for (const [id, at] of this.waiting) if (now - at > 10000) this.waiting.delete(id);
    for (const [id, at] of this.recovered) if (now - at >= 60000) this.recovered.delete(id);
    if (now - (this.recovered.get(key) ?? -Infinity) < this.profileGap) return false;
    if (!this.waiting.has(key) && this.waiting.size >= 100) return false;
    this.waiting.set(key, now);
    if (now < this.nextAt || this.waiting.keys().next().value !== key) return false;
    this.waiting.delete(key);
    this.recovered.set(key, now);
    this.nextAt = now + this.globalGap;
    return true;
  }
}

// Position updates already run through WindowLayoutService's serial queue.
// Admit each live profile independently; an absent retry must not hold the queue.
export class PositionRecoveryGate {
  private readonly recovered = new Map<string, number>();
  request(key: string, now: number): boolean {
    for (const [id, at] of this.recovered) if (now - at >= 60000) this.recovered.delete(id);
    if (now - (this.recovered.get(key) ?? -Infinity) < 2000) return false;
    if (!this.recovered.has(key) && this.recovered.size >= 100) return false;
    this.recovered.set(key, now);
    return true;
  }
  cancel(key: string) {
    this.recovered.delete(key);
  }
}
