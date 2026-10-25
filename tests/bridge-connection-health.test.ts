import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  BridgeConnectionHealth,
  bridgeHealthDescription,
} from '../src/shared/bridge-connection-health.js';

test('connection health accepts bounded metadata and rejects accidental credentials', () => {
  const health = {
    failures: [
      { profileId: randomUUID(), code: 'AUTH_PROOF_MISMATCH', fields: [], at: 1, count: 1 },
    ],
    pending: [{ id: randomUUID(), profileId: randomUUID(), expiresAt: 10 }],
  };
  assert.ok(BridgeConnectionHealth.safeParse(health).success);
  assert.equal(
    BridgeConnectionHealth.safeParse({ ...health, secret: 'not-for-ui' }).success,
    false,
  );
  assert.equal(
    BridgeConnectionHealth.safeParse({
      ...health,
      pending: [{ ...health.pending[0], expected: 'private' }],
    }).success,
    false,
  );
  assert.equal(
    BridgeConnectionHealth.safeParse({ ...health, failures: Array(33).fill(health.failures[0]) })
      .success,
    false,
  );
  assert.equal(bridgeHealthDescription('AUTH_PROOF_MISMATCH'), '本机连接凭据不一致');
  assert.equal(bridgeHealthDescription('constructor'), '连接协议未通过');
});
