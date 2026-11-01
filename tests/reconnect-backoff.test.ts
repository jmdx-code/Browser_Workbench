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
  assert.deepEqual(delays, [500, 1000, 1500, 1500, 1500, 1500, 1500, 1500]);
  backoff.connected(now);
  backoff.healthy(now + 9999);
  assert.equal(
    backoff.failed(now + 9999, () => 1),
    1500,
  );
  now += 40000;
  backoff.connected(now);
  backoff.healthy(now + 10000);
  assert.equal(
    backoff.failed(now + 10000, () => 1),
    500,
  );
  backoff.reset();
  assert.equal(backoff.canAttempt(0), true);
});

test('one hundred simultaneous transport failures spread retries inside bounded windows and never exceed maxMs', () => {
  const delays = Array.from({ length: 100 }, (_, index) => {
    const backoff = new ReconnectBackoff();
    return backoff.failed(1000, () => index / 99);
  });
  assert.equal(new Set(delays).size, 100);
  assert.ok(delays.every((delay) => delay >= 250 && delay <= 500));

  const customBackoff = new ReconnectBackoff(500, 1500);
  for (let i = 0; i < 10; i++) {
    const d = customBackoff.failed(1000, () => 999);
    assert.ok(d <= 1500, `expected delay ${d} <= 1500`);
  }
});

test('WO47-6: focus/activate wake coalesces without resetting backoff, respects manualPauseReconnect and connecting mutex, while alarm resets backoff when disconnected', async () => {
  const backoff = new ReconnectBackoff(500, 1500);
  let now = 1000;
  let manualPauseReconnect = false;
  let connecting = false;
  let socketOpen = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let wsCreations = 0;
  let readyGate = Promise.resolve();

  async function connect() {
    if (manualPauseReconnect || connecting || socketOpen || !backoff.canAttempt(now)) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    connecting = true;
    let openedSocket = false;
    try {
      await readyGate;
      if (manualPauseReconnect || socketOpen || !backoff.canAttempt(now)) return;
      openedSocket = true;
    } finally {
      if (!openedSocket) connecting = false;
    }
    wsCreations++;
  }

  function tryWakeReconnect() {
    if (manualPauseReconnect || connecting || socketOpen || !backoff.canAttempt(now)) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    void connect().catch(() => {});
  }

  function onAlarm() {
    if (manualPauseReconnect || connecting || socketOpen) return;
    backoff.reset();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    void connect().catch(() => {});
  }

  // 1. Backoff active -> focus/activate cannot bypass backoff
  const waitMs = backoff.failed(now, () => 1);
  assert.equal(waitMs, 500);
  tryWakeReconnect();
  tryWakeReconnect();
  await Promise.resolve();
  assert.equal(wsCreations, 0);

  // 2. Backoff expired -> rapid consecutive focus + activate coalesces into 1 connect attempt via synchronous connecting mutex
  now += 500;
  let releaseReady!: () => void;
  readyGate = new Promise<void>((resolve) => {
    releaseReady = resolve;
  });
  tryWakeReconnect();
  tryWakeReconnect();
  tryWakeReconnect();
  assert.equal(connecting, true);
  releaseReady();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(wsCreations, 1);

  // 3. While connecting is true, alarm and focus do not start another connection
  tryWakeReconnect();
  onAlarm();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(wsCreations, 1);

  // 4. manualPauseReconnect prevents both focus wake and alarm reconnect
  connecting = false;
  manualPauseReconnect = true;
  tryWakeReconnect();
  onAlarm();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(wsCreations, 1);

  // 5. Alarm when disconnected and not paused resets backoff and connects immediately
  manualPauseReconnect = false;
  backoff.failed(now, () => 1);
  assert.equal(backoff.canAttempt(now), false);
  onAlarm();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(wsCreations, 2);
});
