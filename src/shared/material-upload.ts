import { z } from 'zod';
import { DispatchBinding } from './task-execution.js';
import { MaterialFile } from './material-index.js';
import { StoryVideoDerivation } from './story-video-derivation.js';

export const UploadStageManifest = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    stageId: z.uuid(),
    sourcePaths: z.array(z.string().min(1).max(4096)).min(1).max(20).optional(),
    attemptId: z.uuid(),
    binding: DispatchBinding,
    intentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime(),
    files: z
      .array(
        z
          .object({
            original: MaterialFile,
            name: z
              .string()
              .min(1)
              .max(255)
              .refine((name) => !/[\\/\0]/.test(name)),
            proof: MaterialFile.shape.proof,
            derivation: StoryVideoDerivation.optional(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (
      manifest.sourcePaths &&
      (manifest.version !== 1 || manifest.sourcePaths.length !== manifest.files.length)
    )
      ctx.addIssue({ code: 'custom', message: 'UPLOAD_SOURCE_PATHS_MISMATCH' });
    const derived = manifest.files.filter((file) => file.derivation !== undefined);
    if (
      manifest.version === 1
        ? derived.length !== 0
        : manifest.files.length !== 1 || derived.length !== 1
    )
      ctx.addIssue({ code: 'custom', message: 'UPLOAD_DERIVATION_VERSION_MISMATCH' });
    for (const file of derived)
      if (file.original.role !== 'video' || file.derivation?.sourceSha256 !== file.original.digest)
        ctx.addIssue({ code: 'custom', message: 'UPLOAD_DERIVATION_SOURCE_MISMATCH' });
  });
export type UploadManifest = z.infer<typeof UploadStageManifest>;

export const uploadedFileContent = (file: UploadManifest['files'][number]) =>
  file.derivation ?? file.original;
