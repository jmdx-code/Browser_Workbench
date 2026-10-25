import { z } from 'zod';
import { MaterialFormat } from './materials.js';
export const MaterialFile = z
  .object({
    relativePath: z.string().min(1).max(2048),
    role: z.enum(['text', 'image', 'video']),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    proof: z
      .object({
        dev: z.string().regex(/^\d+$/),
        ino: z.string().regex(/^\d+$/),
        size: z.string().regex(/^\d+$/),
        mtimeNs: z.string().regex(/^-?\d+$/),
        ctimeNs: z.string().regex(/^-?\d+$/),
      })
      .strict(),
  })
  .strict();
export const MaterialSnapshot = z
  .object({
    source: z.string().min(1).max(2048),
    format: MaterialFormat,
    text: z.string().max(262144),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    files: z.array(MaterialFile).min(1).max(21),
  })
  .strict();
