import type { KernelState, TabProof } from '../shared/kernel-state.js';
import { sameTabProof } from './task-tabs.js';

export function retainEndedMain(
  proof: TabProof,
  inventory: KernelState,
  capabilities: readonly string[],
  planTabCount: number,
): boolean {
  if (!capabilities.includes('kernel-page-quiesce-v1')) return false;
  if (capabilities.includes('kernel-workspace-main-proof-v1'))
    return !!inventory.workspaceMain && sameTabProof(inventory.workspaceMain, proof);
  // Compatibility for the earlier single-page bridge, not a child-page inference.
  return planTabCount === 1;
}
