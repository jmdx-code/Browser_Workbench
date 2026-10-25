import { z } from 'zod';
import { MaterialArchivePlan } from './material-archive.js';
import { MaterialFile } from './material-snapshot.js';

export const ArchiveExecutionClaim = z
  .object({
    attemptId: z.uuid(),
    revision: z.number().int().positive(),
    token: z.uuid(),
    plan: MaterialArchivePlan,
  })
  .strict();
export const ArchiveIoStep = z
  .object({
    key: z.string().min(1).max(4200),
    kind: z.enum(['DIRECTORY', 'COPY', 'KEEP', 'DELETE']),
    path: z.string().min(1).max(4096),
  })
  .strict();
export const ArchiveIoProof = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('DIRECTORY'),
      dev: z.string().regex(/^\d+$/),
      ino: z.string().regex(/^\d+$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('COPY'),
      stat: MaterialFile.shape.proof,
      digest: MaterialFile.shape.digest,
    })
    .strict(),
  z
    .object({ kind: z.literal('KEEP'), reason: z.enum(['REPEAT_OR_CACHE', 'SHARED_SOURCE']) })
    .strict(),
  z.object({ kind: z.literal('DELETE'), absent: z.literal(true) }).strict(),
]);
export type ArchiveExecution = z.infer<typeof ArchiveExecutionClaim>;
export type ArchiveStep = z.infer<typeof ArchiveIoStep>;
export type ArchiveProof = z.infer<typeof ArchiveIoProof>;
