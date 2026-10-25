import { z } from 'zod';
export const MaterialUsageSnapshot = z
  .object({
    generation: z.number().int().nonnegative(),
    published: z.number().int().nonnegative(),
    contents: z.number().int().nonnegative(),
    lastClearedAt: z.number().int().nonnegative().nullable(),
    activePublishing: z.boolean(),
  })
  .strict();
export const ClearMaterialUsage = z
  .object({
    requestId: z.uuid(),
    expectedGeneration: z.number().int().nonnegative(),
    expectedPublished: z.number().int().nonnegative(),
  })
  .strict();
export const ClearedMaterialUsage = z
  .object({
    requestId: z.uuid(),
    previousGeneration: z.number().int().nonnegative(),
    generation: z.number().int().positive(),
    clearedPublications: z.number().int().nonnegative(),
    clearedAt: z.number().int().nonnegative(),
  })
  .strict();
export type MaterialUsage = z.infer<typeof MaterialUsageSnapshot>;
export type MaterialUsageClearRequest = z.infer<typeof ClearMaterialUsage>;
export type MaterialUsageClearResult = z.infer<typeof ClearedMaterialUsage>;
