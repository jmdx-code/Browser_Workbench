import { KernelStamp, type KernelStamp as Stamp } from '../shared/kernel-protocol.js';

// A volatile fence, not a replacement for the durable product outbox or account lock.
export class KernelLease {
  private stamp: Stamp | undefined;
  private revision = 0;
  constructor(
    readonly profileId: string,
    readonly connectionEpoch: string,
    private readonly now: () => number = Date.now,
    private readonly maxLeaseMs = 12_000,
  ) {}
  grant(value: unknown): Stamp {
    const next = KernelStamp.parse(value);
    if (
      next.profileId !== this.profileId ||
      next.connectionEpoch !== this.connectionEpoch ||
      next.generation !== this.revision ||
      next.expiresAt <= this.now() ||
      next.expiresAt > this.now() + this.maxLeaseMs ||
      (this.stamp && (this.stamp.leaseId !== next.leaseId || next.expiresAt < this.stamp.expiresAt))
    )
      throw Error('KERNEL_LEASE_REJECTED');
    this.stamp = next;
    return { ...next };
  }
  check(expected?: Stamp): Stamp {
    const current = this.stamp;
    if (
      !current ||
      current.expiresAt <= this.now() ||
      current.generation !== this.revision ||
      (expected &&
        (expected.profileId !== current.profileId ||
          expected.connectionEpoch !== current.connectionEpoch ||
          expected.leaseId !== current.leaseId ||
          expected.generation !== current.generation))
    )
      throw Error('KERNEL_FENCED');
    return { ...current };
  }
  revoke(): void {
    this.stamp = undefined;
    this.revision++;
  }
  get generation(): number {
    return this.revision;
  }
}
