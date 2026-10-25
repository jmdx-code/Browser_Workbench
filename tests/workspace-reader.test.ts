import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceReader } from '../src/renderer/workspace-reader.js';
import type { Workspace } from '../src/shared/contracts.js';

test('a hung workspace request times out and allows the next read', async () => {
  let calls = 0;
  const updates: string[] = [];
  const reader = new WorkspaceReader(
    () => {
      calls++;
      return new Promise(() => {});
    },
    (_value, error) => updates.push(error),
    10,
  );
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await reader.refresh();
    await reader.refresh();
    assert.equal(calls, 2);
    assert.equal(updates.length, 2);
    assert.ok(updates.every((value) => value.includes('旧状态')));
  } finally {
    reader.dispose();
    clearTimeout(keepAlive);
  }
});

test('manual reconnect cancels the hung read and ignores its late response', async () => {
  const pending: { signal: AbortSignal; resolve: (value: Workspace) => void }[] = [];
  const updates: (Workspace | null)[] = [];
  const reader = new WorkspaceReader(
    (signal) => new Promise((resolve) => pending.push({ signal, resolve })),
    (value) => updates.push(value),
  );
  const old = reader.refresh();
  await Promise.resolve();
  const fresh = reader.refresh(true);
  await Promise.resolve();
  assert.equal(pending[0]?.signal.aborted, true);
  const latest = { profiles: [] } as unknown as Workspace;
  pending[1]?.resolve(latest);
  await fresh;
  pending[0]?.resolve({ profiles: ['stale'] } as unknown as Workspace);
  await old;
  assert.deepEqual(updates, [latest]);
  reader.dispose();
});

test('dispose cancels pending IO and prevents updates after unmount', async () => {
  let signal: AbortSignal | undefined;
  let updates = 0;
  const reader = new WorkspaceReader(
    (input) => {
      signal = input;
      return new Promise(() => {});
    },
    () => updates++,
  );
  const pending = reader.refresh();
  await Promise.resolve();
  reader.dispose();
  await pending;
  assert.equal(signal?.aborted, true);
  assert.equal(updates, 0);
});
