import { z } from 'zod';
import { DispatchBinding, sameBinding } from './task-execution.js';
import { KernelOperationRecord } from './kernel-state.js';
import { OperationDisposition } from './task-ending.js';
export const BusinessResolution = KernelOperationRecord.shape.resolution.unwrap();
export const SettlementResolution = z.union([BusinessResolution, OperationDisposition]);
export const SettlementReceipt = z
  .object({ binding: DispatchBinding, resolution: SettlementResolution })
  .strict();
export const SettlementNotice = SettlementReceipt.extend({
  state: z.enum(['PENDING', 'SENDING', 'DELIVERED']),
  claimToken: z.uuid().nullable(),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.number().int().nonnegative(),
  reason: z.string().max(300),
})
  .strict()
  .superRefine((row, context) => {
    if ((row.state === 'SENDING') !== (row.claimToken !== null))
      context.addIssue({ code: 'custom', message: 'NOTICE_CLAIM_INVALID' });
  });
export type Resolution = z.infer<typeof SettlementResolution>;
export type Notice = z.infer<typeof SettlementNotice>;
export type NoticeReceipt = z.infer<typeof SettlementReceipt>;
export function sameResolution(a: Resolution, b: Resolution): boolean {
  return a.id === b.id && a.outcome === b.outcome && a.evidenceDigest === b.evidenceDigest;
}
export const sameNotice = (a: NoticeReceipt, b: NoticeReceipt) =>
  sameBinding(a.binding, b.binding) && sameResolution(a.resolution, b.resolution);
