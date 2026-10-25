import { z } from 'zod';
import { UploadStageOwner } from './material-upload-stages.js';
import { UploadStageManifest } from './material-upload.js';
import { AttemptVerdict } from './material-post.js';
import { TaskTabRecord } from './task-tabs.js';
import { TaskControlBinding, SessionStopReceipt } from './task-control.js';
import { MaterialFile } from './material-index.js';

export const CacheCleanupPlan = z
  .object({
    owner: UploadStageOwner,
    manifest: UploadStageManifest,
    terminal: AttemptVerdict,
    closedTab: TaskTabRecord,
    stopBinding: TaskControlBinding,
    stopReceipt: SessionStopReceipt,
    createdAt: z.string().datetime(),
  })
  .strict();
export const CacheCleanupClaim = z
  .object({
    plan: CacheCleanupPlan,
    revision: z.number().int().positive(),
    claimToken: z.uuid(),
  })
  .strict();
const identity = z.object({ dev: z.string().min(1), ino: z.string().min(1) }).strict();
export const CacheCleanupScope = z.object({ root: identity, folder: identity }).strict();
export const CacheCleanupFile = z
  .object({
    name: z.string().regex(/^(?:ready\.json|\d{2}-[a-f0-9]{64}\.(?:jpg|jpeg|png|webp|mp4|mov))$/),
    bytes: z.number().int().positive().safe(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    proof: MaterialFile.shape.proof,
  })
  .strict();
export const CacheCleanupRecord = z
  .object({
    plan: CacheCleanupPlan,
    state: z.enum(['PENDING', 'DELETING', 'REVIEW', 'CLEANED']),
    revision: z.number().int().nonnegative(),
    claimToken: z.uuid().nullable(),
    reason: z.string().max(500),
    scope: CacheCleanupScope.nullable(),
    directoryRemovalStarted: z.boolean(),
    files: z
      .array(z.object({ file: CacheCleanupFile, state: z.enum(['DELETING', 'DELETED']) }).strict())
      .max(21),
  })
  .strict();
export const CacheCleanupCompletion = z
  .object({
    stageId: z.uuid(),
    scope: CacheCleanupScope,
    folderAbsent: z.literal(true),
    checkedAt: z.string().datetime(),
  })
  .strict();
export type CleanupPlan = z.infer<typeof CacheCleanupPlan>;
export type CleanupClaim = z.infer<typeof CacheCleanupClaim>;
export type CleanupScope = z.infer<typeof CacheCleanupScope>;
export type CleanupFile = z.infer<typeof CacheCleanupFile>;
export type CleanupRecord = z.infer<typeof CacheCleanupRecord>;
export type CleanupCompletion = z.infer<typeof CacheCleanupCompletion>;
