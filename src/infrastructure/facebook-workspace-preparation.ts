import { createHash, randomUUID } from 'node:crypto';
import type { Awaitable } from '../domain/persistence.js';
import type { Peer } from '../bridge/core.js';
import type { KernelBridge } from './kernel-bridge.js';
import { kernelOperationPending, type TabProof } from '../shared/kernel-state.js';
import { sameTabProof } from '../domain/task-tabs.js';

export const invitationDigest = (label: string, accountId: string, operationId: string) =>
  createHash('sha256')
    .update(JSON.stringify({ purpose: 'group-inviter', label, accountId, operationId }))
    .digest('hex');
const setupLabels = [
  'enter-group',
  'open-invite-modal',
  'click-invite-menuitem',
  'close-invite-modal',
  'close-join-popup',
  'join-group',
  ...Array.from({ length: 200 }, (_, i) => `check-friend-${i + 1}`),
];

export async function endInvitationSetupOperations(
  kernel: KernelBridge,
  peer: Peer,
  guard: () => Awaitable<void> = () => {},
) {
  await guard();
  let inventory = await kernel.withSummary(peer, (port) => port.inventory());
  await guard();
  for (const operation of inventory.operations.filter(kernelOperationPending)) {
    if (
      !['UNKNOWN', 'ACKNOWLEDGED'].includes(operation.state) ||
      !setupLabels.some(
        (label) =>
          operation.binding.actionDigest ===
          invitationDigest(label, operation.binding.accountId, operation.binding.operationId),
      )
    )
      continue;
    await guard();
    await kernel.withSummary(peer, (port) =>
      port.notify(operation.binding, {
        id: randomUUID(),
        outcome: 'ENDED_UNKNOWN',
        evidenceDigest: createHash('sha256')
          .update(
            JSON.stringify({
              binding: operation.binding,
              reason: 'Non-submit invitation setup ended before workspace reuse',
            }),
          )
          .digest('hex'),
      }),
    );
    await guard();
    inventory = await kernel.withSummary(peer, (port) => port.inventory());
    await guard();
  }
  return inventory;
}

// Reuse the native main whenever possible. Only the existing cleanup RPC may
// rebind its group and close unowned user tabs; no extension protocol is added.
export async function prepareFacebookWorkspace(
  kernel: KernelBridge,
  peer: Peer,
  preferred: TabProof | undefined,
  guard: () => Awaitable<void>,
) {
  let inventory = await endInvitationSetupOperations(kernel, peer, guard);
  const ready = inventory.tabs.filter((t) => t.state === 'READY' && t.proof);
  let proof =
    ready.find((t) => preferred && t.proof && sameTabProof(t.proof, preferred))?.proof ??
    ready.find(
      (t) => inventory.workspaceMain && t.proof && sameTabProof(t.proof, inventory.workspaceMain),
    )?.proof ??
    ready[0]?.proof ??
    undefined;
  if (inventory.operations.some(kernelOperationPending)) return { inventory, proof };
  const conflict =
    ready.length > 1 ||
    inventory.tabs.some((t) => !['READY', 'CLOSED', 'LOST'].includes(t.state)) ||
    (proof && (!inventory.workspaceMain || !sameTabProof(inventory.workspaceMain, proof)));
  if (conflict && peer.capabilities?.includes('kernel-workspace-cleanup-v1')) {
    await guard();
    const result = await kernel.consolidateFacebookWorkspace(peer, false);
    await guard();
    proof = result.proof;
    inventory = await kernel.withSummary(peer, (port) => port.inventory());
    await guard();
  } else if (ready.length > 1) {
    for (const extra of ready) {
      if (extra.proof && proof && !sameTabProof(extra.proof, proof)) {
        await guard();
        await kernel.discardAdmissionTab(peer, extra.proof);
        await guard();
      }
    }
    inventory = await kernel.withSummary(peer, (port) => port.inventory());
    await guard();
  }
  return { inventory, proof };
}
