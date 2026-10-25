import { z } from 'zod';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
// Immutable evidence on the original upload stage, not another publication/usage ledger.
export const StoryVideoDerivation = z
  .object({
    version: z.literal(1),
    kind: z.literal('story-caption-video'),
    text: z.string().min(1).max(2000),
    sourceSha256: sha256,
    textSha256: sha256,
    captionSha256: sha256,
    rendererVersion: z.literal(1),
    runtimeArchiveSha256: sha256,
    digest: sha256,
    bytes: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 ** 3),
    width: z.number().int().min(240).max(4096),
    height: z.number().int().min(240).max(4096),
    duration: z.number().finite().positive(),
  })
  .strict();
export type VideoDerivation = z.infer<typeof StoryVideoDerivation>;
