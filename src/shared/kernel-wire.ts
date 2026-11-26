import { z } from 'zod';
import { Id, PosInt, optBool, sMax, sReq, strictObj } from './contracts.js';
import { KernelOperationFileGrant } from './kernel-file-grant.js';
import { KernelJsonObject, KernelStamp, KernelTarget } from './kernel-protocol.js';
import { KernelOperationRecord, OwnedTabProof, OwnedTabRecord } from './kernel-state.js';
import { PageReadRequest } from './page-read.js';
import { DispatchBinding, ExecutionContext } from './task-execution.js';
import { OperationDisposition } from './task-policies.js';
const header = {
  type: z.literal('KERNEL_REQUEST'),
  requestId: Id,
  sequence: PosInt.max(Number.MAX_SAFE_INTEGER),
  connectionEpoch: Id,
  leaseId: Id,
};
const req = <K extends string, T extends z.ZodRawShape>(kind: K, shape: T) =>
  strictObj({ ...header, kind: z.literal(kind), ...shape });
const tabReq = <K extends string>(kind: K) => req(kind, { tabId: PosInt });
const proofReq = <K extends string>(kind: K) => req(kind, { proof: OwnedTabProof });
export const KernelRequest = z.discriminatedUnion('kind', [
  req('open', {
    stamp: KernelStamp,
    files: z.array(sReq(4096)).max(20),
    access: z.enum(['fixture', 'facebook-readonly', 'facebook-task', 'agent-browser']).optional(),
    summaryOnly: optBool,
  }),
  req('renew', { stamp: KernelStamp }),
  req('stop', {}),
  req('quiesce', { context: ExecutionContext, proof: OwnedTabProof }),
  tabReq('scope'),
  tabReq('attach'),
  tabReq('detach'),
  tabReq('remove'),
  tabReq('observeFacebookIdentity'),
  req('create', { url: sMax(4096), ownershipId: Id.optional(), foreground: optBool }),
  req('inventory', {}),
  proofReq('adopt'),
  proofReq('armTaskPresentation'),
  req('revealOwnedPage', { proof: OwnedTabProof, focus: optBool }),
  req('consolidateWorkspace', { preferActiveTab: optBool }),
  proofReq('recoverTabToHome'),
  req('beginOperation', {
    binding: DispatchBinding,
    operationSequence: PosInt.max(Number.MAX_SAFE_INTEGER).optional(),
  }),
  req('collectOperations', {
    records: z.array(KernelOperationRecord).max(200),
    browserSessionEpoch: Id,
  }),
  req('acknowledgeSessionEnd', { browserSessionEpoch: Id }),
  req('retireOperation', {
    binding: DispatchBinding,
    resolution: z.union([KernelOperationRecord.shape.resolution.unwrap(), OperationDisposition]),
  }),
  proofReq('withdrawTaskTab'),
  req('withdrawIdleTaskTab', { record: OwnedTabRecord }),
  req('endUnknownOperation', { binding: DispatchBinding, disposition: OperationDisposition }),
  req('grantOperationFiles', { grant: KernelOperationFileGrant }),
  req('finishOperation', { binding: DispatchBinding }),
  req('reconcileOperation', {
    binding: DispatchBinding,
    resolution: KernelOperationRecord.shape.resolution.unwrap(),
  }),
  req('project', { tabId: PosInt, projection: PageReadRequest }),
  req('send', {
    target: KernelTarget,
    method: z
      .string()
      .regex(/^[A-Za-z]+\.[A-Za-z]+$/)
      .max(160),
    params: KernelJsonObject,
  }),
]);
export type KernelRequest = z.infer<typeof KernelRequest>;
export type KernelRequestBody = KernelRequest extends infer R
  ? R extends KernelRequest
    ? Omit<R, keyof typeof header>
    : never
  : never;
export const KernelReply = strictObj({
  type: z.literal('KERNEL_REPLY'),
  requestId: Id,
  connectionEpoch: Id,
  leaseId: Id,
  result: KernelJsonObject.optional(),
  error: sMax(300).optional(),
});
export const KernelEvent = strictObj({
  type: z.literal('KERNEL_EVENT'),
  connectionEpoch: Id,
  leaseId: Id,
  source: KernelTarget,
  method: sMax(160),
  params: KernelJsonObject,
});
