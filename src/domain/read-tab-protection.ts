import type { TabProof } from '../shared/kernel-state.js';

export interface ReadTabProtection {
  profilePlans: number;
  associated: readonly TabProof[];
}
export function assertReadTabUnassociated(proof: TabProof, protection: ReadTabProtection): void {
  if (
    protection.profilePlans > 0 ||
    protection.associated.some(
      (owned) =>
        owned.ownershipId === proof.ownershipId ||
        (owned.profileId === proof.profileId &&
          owned.browserSessionEpoch === proof.browserSessionEpoch &&
          (owned.tabId === proof.tabId || owned.targetId === proof.targetId)),
    )
  )
    throw Error('READ_TAB_RELEASE_PRODUCT_PROTECTED');
}
