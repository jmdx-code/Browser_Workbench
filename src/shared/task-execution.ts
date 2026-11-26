import { z } from 'zod';
import { Id, NonNegInt, Sha256Hex, sReq, strictObj } from './contracts.js';
// Transport identity, supplied by the authenticated executor, never by the UI.
export const ExecutionContext = strictObj({
  profileId: Id,
  accountId: sReq(200),
  connectionEpoch: Id,
  leaseId: Id,
  generation: NonNegInt,
});
export const DispatchBinding = ExecutionContext.extend({
  operationId: Id,
  jobId: Id,
  stepId: Id,
  actionDigest: Sha256Hex,
}).strict();
export const BoundReceipt = strictObj({ binding: DispatchBinding, evidence: z.json() });
const SessionStopBinding = ExecutionContext.extend({ requestId: Id }).strict();
const SessionStopReceipt = SessionStopBinding.extend({ state: z.literal('stopped') }).strict();
export type StopReceipt = z.infer<typeof SessionStopReceipt>;
export type ExecutionSession = z.infer<typeof ExecutionContext>;
export type Binding = z.infer<typeof DispatchBinding>;
export const sameExecution = (
  a: ExecutionSession | null | undefined,
  b: ExecutionSession | null | undefined,
): boolean =>
  Boolean(
    a &&
    b &&
    a.profileId === b.profileId &&
    a.accountId === b.accountId &&
    a.connectionEpoch === b.connectionEpoch &&
    a.leaseId === b.leaseId &&
    a.generation === b.generation,
  );
export const sameBinding = (
  a: Binding | null | undefined,
  b: Binding | null | undefined,
): boolean =>
  Boolean(
    a &&
    b &&
    sameExecution(a, b) &&
    a.operationId === b.operationId &&
    a.jobId === b.jobId &&
    a.stepId === b.stepId &&
    a.actionDigest === b.actionDigest,
  );
