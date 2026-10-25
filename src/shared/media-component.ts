import { z } from 'zod';

export const MediaComponentStatus = z
  .object({
    supported: z.boolean(),
    installed: z.boolean(),
    busy: z.boolean(),
    platform: z.string(),
    phase: z.enum(['idle', 'downloading', 'verifying', 'installing']),
    receivedBytes: z.number().nonnegative(),
    totalBytes: z.number().nonnegative(),
    error: z.string(),
  })
  .strict();
