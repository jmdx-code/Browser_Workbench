import { z } from 'zod';
import { KernelJsonObject, KernelStamp, KernelTarget } from './kernel-protocol.js';
import { DispatchBinding } from './task-execution.js';
import { OwnedTabProof, OwnedTabRecord, KernelOperationRecord } from './kernel-state.js';
import { PageReadRequest } from './page-read.js';
import { KernelOperationFileGrant } from './kernel-file-grant.js';
import { OperationDisposition } from './task-ending.js';
import { ExecutionContext } from './task-execution.js';
import { TaskWindowSnapshot, WindowRect } from './window-layout.js';

const header = {
  type: z.literal('KERNEL_REQUEST'),
  requestId: z.string().uuid(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  connectionEpoch: z.string().uuid(),
  leaseId: z.string().uuid(),
};
export const KernelRequest = z.discriminatedUnion('kind', [
  z
    .object({
      ...header,
      kind: z.literal('open'),
      stamp: KernelStamp,
      files: z.array(z.string().min(1).max(4096)).max(20),
      access: z.enum(['fixture', 'facebook-readonly', 'facebook-task']).optional(),
      summaryOnly: z.boolean().optional(),
    })
    .strict(),
  z.object({ ...header, kind: z.literal('renew'), stamp: KernelStamp }).strict(),
  z.object({ ...header, kind: z.literal('stop') }).strict(),
  z
    .object({
      ...header,
      kind: z.literal('quiesce'),
      context: ExecutionContext,
      proof: OwnedTabProof,
    })
    .strict(),
  z.object({ ...header, kind: z.literal('scope'), tabId: z.number().int().positive() }).strict(),
  z.object({ ...header, kind: z.literal('attach'), tabId: z.number().int().positive() }).strict(),
  z.object({ ...header, kind: z.literal('detach'), tabId: z.number().int().positive() }).strict(),
  z
    .object({
      ...header,
      kind: z.literal('create'),
      url: z.string().max(4096),
      ownershipId: z.uuid().optional(),
      foreground: z.boolean().optional(),
    })
    .strict(),
  z.object({ ...header, kind: z.literal('inventory') }).strict(),
  z
    .object({
      ...header,
      kind: z.literal('observeFacebookIdentity'),
      tabId: z.number().int().positive(),
    })
    .strict(),
  z.object({ ...header, kind: z.literal('adopt'), proof: OwnedTabProof }).strict(),
  z.object({ ...header, kind: z.literal('armTaskPresentation'), proof: OwnedTabProof }).strict(),
  z.object({ ...header, kind: z.literal('revealOwnedPage'), proof: OwnedTabProof }).strict(),
  z.object({ ...header, kind: z.literal('inspectTaskWindow'), proof: OwnedTabProof }).strict(),
  z
    .object({
      ...header,
      kind: z.literal('positionTaskWindow'),
      expected: TaskWindowSnapshot,
      rect: WindowRect,
      exposed: z.boolean(),
      focus: z.boolean().optional(),
      deadline: z.number().finite().positive().optional(),
    })
    .strict(),
  z
    .object({
      ...header,
      kind: z.literal('consolidateWorkspace'),
      preferActiveTab: z.boolean().optional(),
    })
    .strict(),
  z.object({ ...header, kind: z.literal('beginOperation'), binding: DispatchBinding }).strict(),
  z.object({ ...header, kind: z.literal('withdrawTaskTab'), proof: OwnedTabProof }).strict(),
  z.object({ ...header, kind: z.literal('withdrawIdleTaskTab'), record: OwnedTabRecord }).strict(),
  z
    .object({
      ...header,
      kind: z.literal('endUnknownOperation'),
      binding: DispatchBinding,
      disposition: OperationDisposition,
    })
    .strict(),
  z
    .object({ ...header, kind: z.literal('grantOperationFiles'), grant: KernelOperationFileGrant })
    .strict(),
  z.object({ ...header, kind: z.literal('finishOperation'), binding: DispatchBinding }).strict(),
  z
    .object({
      ...header,
      kind: z.literal('reconcileOperation'),
      binding: DispatchBinding,
      resolution: KernelOperationRecord.shape.resolution.unwrap(),
    })
    .strict(),
  z.object({ ...header, kind: z.literal('remove'), tabId: z.number().int().positive() }).strict(),
  z
    .object({
      ...header,
      kind: z.literal('project'),
      tabId: z.number().int().positive(),
      projection: PageReadRequest,
    })
    .strict(),
  z
    .object({
      ...header,
      kind: z.literal('send'),
      target: KernelTarget,
      method: z
        .string()
        .regex(/^[A-Za-z]+\.[A-Za-z]+$/)
        .max(160),
      params: KernelJsonObject,
    })
    .strict(),
]);
export type KernelRequest = z.infer<typeof KernelRequest>;
export type KernelRequestBody = KernelRequest extends infer R
  ? R extends KernelRequest
    ? Omit<R, keyof typeof header>
    : never
  : never;
export const KernelReply = z
  .object({
    type: z.literal('KERNEL_REPLY'),
    requestId: z.string().uuid(),
    connectionEpoch: z.string().uuid(),
    leaseId: z.string().uuid(),
    result: KernelJsonObject.optional(),
    error: z.string().max(300).optional(),
  })
  .strict();
export const KernelEvent = z
  .object({
    type: z.literal('KERNEL_EVENT'),
    connectionEpoch: z.string().uuid(),
    leaseId: z.string().uuid(),
    source: KernelTarget,
    method: z.string().max(160),
    params: KernelJsonObject,
  })
  .strict();
