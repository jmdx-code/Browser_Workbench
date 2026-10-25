import test from 'node:test';
import assert from 'node:assert/strict';
import { ReconnectBackoff } from '../src/shared/reconnect-backoff.js';

test('alarm/manual retry cannot bypass exponential reconnect deadlines, and a stable connection recovers promptly', () => {
  const backoff = new ReconnectBackoff();
  let now = 0;
  const delays = [];
  for (let i = 0; i < 8; i++) {
    assert.equal(backoff.canAttempt(now), true);
    const delay = backoff.failed(now, () => 1);
    delays.push(delay);
    assert.equal(backoff.canAttempt(now + delay - 1), false);
    now += delay;
  }
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
  backoff.connected(now);
  backoff.healthy(now + 9999);
  assert.equal(
    backoff.failed(now + 9999, () => 1),
    30000,
  );
  now += 40000;
  backoff.connected(now);
  backoff.healthy(now + 10000);
  assert.equal(
    backoff.failed(now + 10000, () => 1),
    2000,
  );
  backoff.reset();
  assert.equal(backoff.canAttempt(0), true);
});

test('one hundred simultaneous transport failures spread retries inside bounded windows', () => {
  const delays = Array.from({ length: 100 }, (_, index) => {
    const backoff = new ReconnectBackoff();
    return backoff.failed(1000, () => index / 99);
  });
  assert.equal(new Set(delays).size, 100);
  assert.ok(delays.every((delay) => delay >= 1000 && delay <= 2000));
});
