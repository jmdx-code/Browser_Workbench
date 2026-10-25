import { z } from 'zod';
import { DispatchBinding } from './task-execution.js';
import { OperationDisposition } from './task-ending.js';

export const OwnedTabProof = z
  .object({
    ownershipId: z.uuid(),
    profileId: z.uuid(),
    browserSessionEpoch: z.uuid(),
    tabId: z.number().int().positive(),
    targetId: z.string().min(1).max(200),
  })
  .strict();
export const OwnedTabRecord = z
  .object({
    ownershipId: z.uuid(),
    url: z.string().max(4096),
    state: z.enum(['CREATING', 'READY', 'UNKNOWN', 'LOST', 'CLOSED']),
    proof: OwnedTabProof.nullable(),
    reason: z.string().max(200),
  })
  .strict();
export const KernelOperationRecord = z
  .object({
    binding: DispatchBinding,
    state: z.enum(['DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN', 'RECONCILED']),
    reason: z.string().max(200),
    disposition: OperationDisposition.optional(),
    resolution: z
      .object({
        id: z.uuid(),
        outcome: z.enum(['VERIFIED', 'NOT_APPLIED', 'CONTROL_RELEASED']),
        evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const KernelPersistentState = z
  .object({
    version: z.literal(1),
    profileId: z.uuid(),
    browserSessionEpoch: z.uuid(),
    operations: z.array(KernelOperationRecord).max(3000),
    tabs: z.array(OwnedTabRecord).max(500),
    workspaceMain: OwnedTabProof.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.workspaceMain &&
      !value.tabs.some(
        (tab) =>
          tab.state === 'READY' &&
          tab.proof &&
          JSON.stringify(tab.proof) === JSON.stringify(value.workspaceMain),
      )
    )
      context.addIssue({ code: 'custom', message: 'KERNEL_WORKSPACE_MAIN_UNCONFIRMED' });
    if (
      value.operations.some(
        (row) =>
          (row.state === 'RECONCILED') !== (row.resolution !== null) ||
          (row.disposition !== undefined &&
            !['UNKNOWN', 'ACKNOWLEDGED', 'RECONCILED'].includes(row.state)),
      ) ||
      value.tabs.some(
        (row) =>
          row.state === 'READY' &&
          (!row.proof || row.proof.browserSessionEpoch !== value.browserSessionEpoch),
      )
    )
      context.addIssue({ code: 'custom', message: 'KERNEL_STATE_INVALID_PHASE' });
    if (
      new Set(value.operations.map((row) => row.binding.operationId)).size !==
        value.operations.length ||
      new Set(value.tabs.map((row) => row.ownershipId)).size !== value.tabs.length
    )
      context.addIssue({ code: 'custom', message: 'KERNEL_STATE_DUPLICATE_ID' });
    if (
      value.operations.some((row) => row.binding.profileId !== value.profileId) ||
      value.tabs.some(
        (row) =>
          row.proof &&
          (row.proof.profileId !== value.profileId || row.proof.ownershipId !== row.ownershipId),
      )
    )
      context.addIssue({ code: 'custom', message: 'KERNEL_STATE_PROFILE_MISMATCH' });
  });
export type TabProof = z.infer<typeof OwnedTabProof>;
export type TabRecord = z.infer<typeof OwnedTabRecord>;
export type KernelRecord = z.infer<typeof KernelOperationRecord>;
export type KernelState = z.infer<typeof KernelPersistentState>;
export const kernelOperationPending = (row: KernelRecord): boolean =>
  row.state !== 'RECONCILED' && row.disposition === undefined;
