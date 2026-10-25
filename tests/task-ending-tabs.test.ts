import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { retainEndedMain } from '../src/domain/task-ending-tabs.js';
import type { KernelState, TabProof } from '../src/shared/kernel-state.js';

const capabilities = ['kernel-page-quiesce-v1', 'kernel-workspace-main-proof-v1'];
function fixture() {
  const main: TabProof = {
    profileId: randomUUID(),
    browserSessionEpoch: randomUUID(),
    ownershipId: randomUUID(),
    tabId: 42,
    targetId: randomUUID(),
  };
  const child = { ...main, ownershipId: randomUUID(), tabId: 43, targetId: randomUUID() };
  const inventory: KernelState = {
    version: 1,
    profileId: main.profileId,
    browserSessionEpoch: main.browserSessionEpoch,
    operations: [],
    workspaceMain: main,
    tabs: [main, child].map((proof) => ({
      ownershipId: proof.ownershipId,
      proof,
      url: 'https://www.facebook.com/',
      state: 'READY',
      reason: '',
    })),
  };
  return { main, child, inventory };
}

test('ending retains the registered main among multiple plan pages, never the sole child', () => {
  const { main, child, inventory } = fixture();
  assert.equal(retainEndedMain(main, inventory, capabilities, 2), true);
  assert.equal(retainEndedMain(child, inventory, capabilities, 1), false);
  assert.equal(
    retainEndedMain(main, { ...inventory, workspaceMain: undefined }, capabilities, 1),
    false,
  );
  for (const replacement of [
    { ownershipId: randomUUID() },
    { profileId: randomUUID() },
    { browserSessionEpoch: randomUUID() },
    { tabId: 99 },
    { targetId: randomUUID() },
  ])
    assert.equal(retainEndedMain({ ...main, ...replacement }, inventory, capabilities, 1), false);
});

test('legacy single-page compatibility still requires quiesce and does not preserve multiple pages', () => {
  const { main, inventory } = fixture();
  assert.equal(retainEndedMain(main, inventory, [], 1), false);
  assert.equal(retainEndedMain(main, inventory, ['kernel-page-quiesce-v1'], 1), true);
  assert.equal(retainEndedMain(main, inventory, ['kernel-page-quiesce-v1'], 2), false);
});
