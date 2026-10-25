export function heartbeatLeaseDeadline(
  value: unknown,
  epoch: string,
  now: number,
  maximumLease: number,
): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (
    !('type' in value) ||
    value.type !== 'HEARTBEAT' ||
    !epoch ||
    !('connectionEpoch' in value) ||
    value.connectionEpoch !== epoch ||
    !('leaseMs' in value) ||
    typeof value.leaseMs !== 'number' ||
    !Number.isSafeInteger(value.leaseMs) ||
    value.leaseMs <= 0 ||
    !Number.isFinite(now) ||
    now < 0 ||
    !Number.isSafeInteger(maximumLease) ||
    maximumLease <= 0
  )
    return null;
  return now + Math.min(value.leaseMs, maximumLease);
}
