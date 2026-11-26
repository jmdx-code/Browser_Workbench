import test from 'node:test';
import assert from 'node:assert/strict';
import { heartbeatLeaseDeadline } from '../src/shared/bridge-connection-health.js';

test('heartbeat renewal is epoch-specific, bounded and rejects malformed packets', () => {
  const packet = { type: 'HEARTBEAT', connectionEpoch: 'current', leaseMs: 4500 };
  assert.equal(heartbeatLeaseDeadline(packet, 'current', 1000, 4500), 5500);
  assert.equal(heartbeatLeaseDeadline({ ...packet, leaseMs: 10000 }, 'current', 1000, 4500), 5500);
  for (const p of [
    null,
    [],
    { ...packet, connectionEpoch: 'old' },
    { ...packet, leaseMs: NaN },
    { ...packet, leaseMs: 0 },
    { ...packet, leaseMs: 1.5 },
    { ...packet, type: 'STOP' },
  ])
    assert.equal(heartbeatLeaseDeadline(p, 'current', 1000, 4500), null);
  assert.equal(heartbeatLeaseDeadline(packet, '', 1000, 4500), null);
});
