import { z } from 'zod';
import { Id } from './contracts.js';

// Transport identity, supplied by the authenticated executor, never by the UI.
export const ExecutionContext = z
  .object({
    profileId: Id,
    accountId: z.string().min(1).max(200),
    connectionEpoch: z.uuid(),
    leaseId: z.uuid(),
    generation: z.number().int().nonnegative(),
  })
  .strict();
export const DispatchBinding = ExecutionContext.extend({
  operationId: Id,
  jobId: Id,
  stepId: Id,
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const BoundReceipt = z.object({ binding: DispatchBinding, evidence: z.json() }).strict();
export type ExecutionSession = z.infer<typeof ExecutionContext>;
export type Binding = z.infer<typeof DispatchBinding>;
export type ExecutionReceipt = z.infer<typeof BoundReceipt>;

export function sameExecution(a: ExecutionSession, b: ExecutionSession): boolean {
  return (
    a.profileId === b.profileId &&
    a.accountId === b.accountId &&
    a.connectionEpoch === b.connectionEpoch &&
    a.leaseId === b.leaseId &&
    a.generation === b.generation
  );
}
export function sameBinding(a: Binding, b: Binding): boolean {
  return (
    sameExecution(a, b) &&
    a.operationId === b.operationId &&
    a.jobId === b.jobId &&
    a.stepId === b.stepId &&
    a.actionDigest === b.actionDigest
  );
}
