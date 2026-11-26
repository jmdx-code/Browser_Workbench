import { z } from 'zod';
import {
  Id,
  NonNegInt,
  OperationDisposition,
  PosInt,
  Sha256Hex,
  addIssue,
  sMax,
  sReq,
  strictObj,
} from './contracts.js';
import { DispatchBinding } from './task-execution.js';
export const OwnedTabProof = strictObj({
  ownershipId: Id,
  profileId: Id,
  browserSessionEpoch: Id,
  tabId: PosInt,
  targetId: sReq(200),
});
export const OwnedTabRecord = strictObj({
  ownershipId: Id,
  url: sMax(4096),
  state: z.enum(['CREATING', 'READY', 'UNKNOWN', 'LOST', 'CLOSED']),
  proof: OwnedTabProof.nullable(),
  reason: sMax(200),
});
export const KernelOperationRecord = strictObj({
  binding: DispatchBinding,
  operationSequence: PosInt.max(Number.MAX_SAFE_INTEGER).optional(),
  executionEnded: z.literal(true).optional(),
  state: z.enum(['DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN', 'RECONCILED']),
  reason: sMax(200),
  disposition: OperationDisposition.optional(),
  resolution: strictObj({
    id: Id,
    outcome: z.enum(['VERIFIED', 'NOT_APPLIED', 'CONTROL_RELEASED']),
    evidenceDigest: Sha256Hex,
  }).nullable(),
});
export const KernelPersistentState = strictObj({
  version: z.union([z.literal(1), z.literal(2)]),
  profileId: Id,
  browserSessionEpoch: Id,
  operations: z.array(KernelOperationRecord).max(3000),
  tabs: z.array(OwnedTabRecord).max(500),
  workspaceMain: OwnedTabProof.optional(),
  operationHighWater: NonNegInt.max(Number.MAX_SAFE_INTEGER).optional(),
  previousBrowserSessionEpoch: Id.optional(),
  browserSessionStartedAt: NonNegInt.optional(),
}).superRefine((v, ctx) => {
  if (
    v.workspaceMain &&
    !v.tabs.some(
      (t) =>
        t.state === 'READY' &&
        t.proof &&
        JSON.stringify(t.proof) === JSON.stringify(v.workspaceMain),
    )
  )
    addIssue(ctx, 'KERNEL_WORKSPACE_MAIN_UNCONFIRMED');
  if (
    v.operations.some((r) => (r.state === 'RECONCILED') !== (r.resolution !== null)) ||
    v.tabs.some(
      (r) =>
        r.state === 'READY' && (!r.proof || r.proof.browserSessionEpoch !== v.browserSessionEpoch),
    )
  )
    addIssue(ctx, 'KERNEL_STATE_INVALID_PHASE');
  if (
    new Set(v.operations.map((r) => r.binding.operationId)).size !== v.operations.length ||
    new Set(v.tabs.map((r) => r.ownershipId)).size !== v.tabs.length
  )
    addIssue(ctx, 'KERNEL_STATE_DUPLICATE_ID');
  if (
    v.operations.some((r) => r.binding.profileId !== v.profileId) ||
    v.tabs.some(
      (r) =>
        r.proof && (r.proof.profileId !== v.profileId || r.proof.ownershipId !== r.ownershipId),
    )
  )
    addIssue(ctx, 'KERNEL_STATE_PROFILE_MISMATCH');
});
export type TabProof = z.infer<typeof OwnedTabProof>;
export type TabRecord = z.infer<typeof OwnedTabRecord>;
export type KernelRecord = z.infer<typeof KernelOperationRecord>;
export type KernelState = z.infer<typeof KernelPersistentState>;
export const kernelOperationPending = (row: KernelRecord): boolean =>
  row.state !== 'RECONCILED' && row.disposition === undefined;
