import { z } from 'zod';
import { strictObj } from './contracts.js';
import { DispatchBinding, sameBinding } from './task-execution.js';
import { KernelOperationRecord } from './kernel-state.js';
import { OperationDisposition } from './task-policies.js';
const SettlementResolution = z.union([
  KernelOperationRecord.shape.resolution.unwrap(),
  OperationDisposition,
]);
export const SettlementReceipt = strictObj({
  binding: DispatchBinding,
  resolution: SettlementResolution,
});
export type Resolution = z.infer<typeof SettlementResolution>;
export type NoticeReceipt = z.infer<typeof SettlementReceipt>;
const sameResolution = (a: Resolution, b: Resolution): boolean =>
  a.id === b.id && a.outcome === b.outcome && a.evidenceDigest === b.evidenceDigest;
export const sameNotice = (a: NoticeReceipt, b: NoticeReceipt) =>
  sameBinding(a.binding, b.binding) && sameResolution(a.resolution, b.resolution);
