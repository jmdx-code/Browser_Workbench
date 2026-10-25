import { z } from 'zod';
import { DispatchBinding } from './task-execution.js';
import { UploadStageManifest } from './material-upload.js';

// Internal ownership records, never a browser input permit or a public path API.
export const UploadStageOwner = z
  .object({
    stageId: z.uuid(),
    attemptId: z.uuid(),
    binding: DispatchBinding,
    intentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    cacheRoot: z.string().min(1).max(4096),
    expectedBytes: z.number().int().positive().safe(),
    createdAt: z.string().datetime(),
  })
  .strict();
export const UploadStageClaim = z
  .object({
    owner: UploadStageOwner,
    claimToken: z.uuid(),
  })
  .strict();
export const UploadStageRecord = z
  .object({
    ...UploadStageClaim.shape,
    state: z.enum(['WRITING', 'READY', 'REVIEW']),
    revision: z.number().int().nonnegative(),
    reason: z.string().max(500),
    manifest: UploadStageManifest.nullable(),
  })
  .strict();
export type StageClaim = z.infer<typeof UploadStageClaim>;
export type StageRecord = z.infer<typeof UploadStageRecord>;
