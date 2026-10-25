import { z } from 'zod';
import { DispatchBinding } from './task-execution.js';
import { OwnedTabProof } from './kernel-state.js';
import { StoryVideoDerivation } from './story-video-derivation.js';

// Ephemeral passive correlation; no public input permission, persisted verdict or post result.
export const FacebookVideoTransfer = z
  .object({
    source: z.literal('owned-video-upload-transfer'),
    binding: DispatchBinding,
    proof: OwnedTabProof,
    attemptId: z.uuid(),
    stageId: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive(),
    videoId: z.string().regex(/^\d{1,30}$/),
    timeOrigin: z.number().finite().nonnegative(),
    url: z.string().max(4096),
    receivedBytes: z.number().int().positive(),
    derivation: StoryVideoDerivation.optional(),
  })
  .strict()
  .superRefine((transfer, ctx) => {
    if (
      transfer.derivation &&
      (transfer.digest !== transfer.derivation.digest ||
        transfer.bytes !== transfer.derivation.bytes ||
        transfer.receivedBytes !== transfer.bytes)
    )
      ctx.addIssue({ code: 'custom', message: 'VIDEO_DERIVATION_TRANSFER_MISMATCH' });
  });
export type VideoTransfer = z.infer<typeof FacebookVideoTransfer>;
