import { z } from 'zod';
import { ArchiveRequest, ResourceArchiveRequest } from './material-post.js';
import { MaterialFile } from './material-index.js';

const identity = z
  .object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) })
  .strict();
export const ArchivePreparationClaim = z
  .object({ request: ArchiveRequest, revision: z.number().int().positive(), claimToken: z.uuid() })
  .strict();
// Immutable planning witness only. It does not authorize copying, deleting or publishing.
const DirectoryArchivePlan = z
  .object({
    version: z.literal(1),
    request: ArchiveRequest,
    sourceRoot: identity,
    sourceFolder: identity,
    folderPackage: z.boolean(),
    archiveRoot: identity.nullable(),
    destination: z.string().min(1).max(4096),
    files: z
      .array(
        z
          .object({
            original: MaterialFile,
            sourcePath: z.string().min(1).max(4096),
            targetPath: z.string().min(1).max(4096),
          })
          .strict(),
      )
      .min(1)
      .max(21),
    checkedAt: z.string().datetime(),
  })
  .strict();
// Table media retain their real parent directories. Inline text has no invented TXT/file root.
export const ReferenceArchivePlan = z
  .object({
    version: z.literal(2),
    request: ResourceArchiveRequest,
    files: z
      .array(
        z
          .object({
            original: MaterialFile,
            sourcePath: z.string().min(1).max(4096),
            targetPath: z.string().min(1).max(4096),
            sourceParent: identity,
            archiveParent: identity.nullable(),
            preserveSource: z.boolean(),
          })
          .strict(),
      )
      .max(20),
    checkedAt: z.string().datetime(),
  })
  .strict();
export const MaterialArchivePlan = z.union([DirectoryArchivePlan, ReferenceArchivePlan]);
export const MaterialArchivePreparationRecord = z
  .object({
    request: ArchiveRequest,
    state: z.enum(['PREPARING', 'READY', 'REVIEW']),
    revision: z.number().int().positive(),
    claimToken: z.uuid().nullable(),
    reason: z.string().max(500),
    plan: MaterialArchivePlan.nullable(),
  })
  .strict();
export type ArchiveClaim = z.infer<typeof ArchivePreparationClaim>;
export type ArchivePlan = z.infer<typeof MaterialArchivePlan>;
export type ArchivePreparationRecord = z.infer<typeof MaterialArchivePreparationRecord>;
