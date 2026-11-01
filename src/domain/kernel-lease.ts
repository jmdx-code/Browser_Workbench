import { KernelStamp, type KernelStamp as Stamp } from '../shared/kernel-protocol.js';

// A volatile fence, not a replacement for the durable product outbox or account lock.
export class KernelLease {
  private stamp: Stamp | undefined;
  private revision = 0;
  private revoked = false;
  constructor(
    readonly profileId: string,
    readonly connectionEpoch: string,
    private readonly now: () => number = Date.now,
    private readonly maxLeaseMs = 300_000,
  ) {}
  grant(value: unknown): Stamp {
    const next = KernelStamp.parse(value);
    if (next.profileId !== this.profileId) throw Error('KERNEL_LEASE_REJECTED:profile_mismatch');
    if (next.connectionEpoch !== this.connectionEpoch)
      throw Error('KERNEL_LEASE_REJECTED:epoch_mismatch');
    if (
      this.stamp &&
      next.leaseId === this.stamp.leaseId &&
      next.generation < this.stamp.generation
    )
      throw Error('KERNEL_LEASE_REJECTED:generation_regression');
    if (!this.stamp && this.revoked && next.generation < this.revision)
      throw Error('KERNEL_LEASE_REJECTED:revoked_revision');
    const now = this.now();
    this.revision = Math.max(this.revision, next.generation);
    const expiresAt = Math.min(
      Math.max(next.expiresAt, now + 60_000, this.stamp?.expiresAt ?? 0),
      now + this.maxLeaseMs,
    );
    this.revoked = false;
    this.stamp = {
      ...next,
      generation: this.revision,
      expiresAt,
    };
    return { ...this.stamp };
  }
  check(expected?: Stamp): Stamp {
    const current = this.stamp;
    if (
      !current ||
      (expected &&
        (expected.profileId !== this.profileId ||
          expected.connectionEpoch !== this.connectionEpoch ||
          expected.leaseId !== current.leaseId ||
          expected.generation > current.generation))
    )
      throw Error('KERNEL_FENCED');
    if (current.expiresAt <= this.now()) {
      this.stamp = { ...current, expiresAt: this.now() + 60_000 };
      return { ...this.stamp };
    }
    return { ...current };
  }
  revoke(): void {
    this.stamp = undefined;
    this.revoked = true;
    this.revision++;
  }
  get generation(): number {
    return this.revision;
  }
}
