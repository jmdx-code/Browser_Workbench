import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeCommandQueue } from '../src/application/bridge-command-queue.js';
import { heartbeatLeaseDeadline } from '../src/shared/bridge-heartbeat.js';

test('stalled read does not block stop, but queued writes remain drained in serial order', async () => {
  const queue = new BridgeCommandQueue(),
    events: string[] = [];
  let finish!: () => void;
  const read = queue.enqueue(false, async () => {
    events.push('read');
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  await queue.drainWrites();
  assert.deepEqual(events, ['read']);
  const write = queue.enqueue(true, async () => {
    events.push('write');
  });
  let drained = false;
  const stop = queue.drainWrites().then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  finish();
  await Promise.all([read, write, stop]);
  assert.deepEqual(events, ['read', 'write']);
});

test('failed command does not poison subsequent commands or leave phantom pending writes', async () => {
  const queue = new BridgeCommandQueue();
  await assert.rejects(
    queue.enqueue(true, async () => {
      throw Error('FAILED');
    }),
    /FAILED/,
  );
  await queue.drainWrites();
  let ran = false;
  await queue.enqueue(true, async () => {
    ran = true;
  });
  await queue.drainWrites();
  assert.equal(ran, true);
});

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
