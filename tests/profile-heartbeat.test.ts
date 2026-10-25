import test from 'node:test';
import assert from 'node:assert/strict';
import { ProfileHeartbeat } from '../src/application/profile-heartbeat.js';

test('slow window observation cannot hold transport PONG or create overlapping window queries', async () => {
  const messages: unknown[] = [];
  let finish!: (windows: { focused: boolean }[]) => void;
  let reads = 0;
  const heartbeat = new ProfileHeartbeat(
    () => true,
    () => 'epoch',
    (message) => messages.push(message),
    () => {
      reads++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  );
  heartbeat.pulse();
  heartbeat.pulse();
  assert.deepEqual(messages, [
    { type: 'PONG', connectionEpoch: 'epoch' },
    { type: 'PONG', connectionEpoch: 'epoch' },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  finish([{ focused: true }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages[2], {
    type: 'PONG',
    connectionEpoch: 'epoch',
    windowCount: 1,
    profileWindowFocused: true,
  });
});

test('replaced connection discards late window evidence and a query failure withdraws focus without declaring transport dead', async () => {
  const messages: unknown[] = [];
  let epoch = 'old';
  let finish!: (windows: { focused: boolean }[]) => void;
  let fail = false;
  const heartbeat = new ProfileHeartbeat(
    () => true,
    () => epoch,
    (message) => messages.push(message),
    () => {
      if (fail) return Promise.reject(Error('WINDOW_QUERY_FAILED'));
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  );
  heartbeat.pulse();
  await new Promise((resolve) => setImmediate(resolve));
  epoch = 'new';
  finish([{ focused: true }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 1);
  fail = true;
  heartbeat.pulse();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages.slice(1), [
    { type: 'PONG', connectionEpoch: 'new' },
    { type: 'PONG', connectionEpoch: 'new', profileWindowFocused: false },
  ]);
});
