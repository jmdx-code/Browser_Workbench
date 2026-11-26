import type { TabProof } from '../shared/kernel-state.js';
export const sameTabProof = (
  a: TabProof | null | undefined,
  b: TabProof | null | undefined,
): boolean =>
  Boolean(
    a &&
    b &&
    a.ownershipId === b.ownershipId &&
    a.profileId === b.profileId &&
    a.browserSessionEpoch === b.browserSessionEpoch &&
    a.tabId === b.tabId &&
    a.targetId === b.targetId,
  );
