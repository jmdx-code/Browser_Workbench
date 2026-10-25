import type { Awaitable } from '../domain/persistence.js';
import {
  KernelPersistentState,
  OwnedTabProof,
  kernelOperationPending,
  type TabProof,
} from '../shared/kernel-state.js';
import { kernelFacebookReadURL } from '../shared/kernel-policy.js';
import { sameTabProof } from '../domain/task-tabs.js';

export interface ReadTabReleasePort {
  assertCurrent(): Awaitable<void>;
  assertUnassociated(proof: TabProof): Awaitable<void>;
  inventory(): Promise<unknown>;
  adopt(proof: TabProof): Promise<void>;
  remove(tabId: number): Promise<void>;
}

// Internal, explicit release of a journal-owned inspection target. No URL-based discovery/adoption.
export async function releaseFacebookReadTab(input: TabProof, port: ReadTabReleasePort) {
  const proof = OwnedTabProof.parse(input);
  const assertAllowed = async () => {
    await port.assertCurrent();
    await port.assertUnassociated(proof);
  };
  await assertAllowed();
  const before = KernelPersistentState.parse(await port.inventory());
  await assertAllowed();
  const row = before.tabs.find((item) => item.ownershipId === proof.ownershipId);
  if (
    before.profileId !== proof.profileId ||
    before.browserSessionEpoch !== proof.browserSessionEpoch ||
    row?.state !== 'READY' ||
    !row.proof ||
    !sameTabProof(row.proof, proof) ||
    !kernelFacebookReadURL(row.url) ||
    before.operations.some(kernelOperationPending)
  )
    throw Error('READ_TAB_RELEASE_PROOF_REJECTED');
  // Native adopt verifies the actual Target identity, current browser session and scope again.
  await port.adopt(proof);
  await assertAllowed();
  await port.remove(proof.tabId);
  await port.assertCurrent();
  const after = KernelPersistentState.parse(await port.inventory());
  await port.assertCurrent();
  const closed = after.tabs.find((item) => item.ownershipId === proof.ownershipId);
  if (
    after.profileId !== proof.profileId ||
    after.browserSessionEpoch !== proof.browserSessionEpoch ||
    closed?.state !== 'CLOSED' ||
    !closed.proof ||
    !sameTabProof(closed.proof, proof)
  )
    throw Error('READ_TAB_RELEASE_CLOSE_UNCONFIRMED');
  return { proof, before: row, closed };
}
