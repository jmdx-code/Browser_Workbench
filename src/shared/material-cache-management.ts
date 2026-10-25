import { z } from 'zod';

export const MaterialCacheEntry = z
  .object({
    stageId: z.uuid(),
    bytes: z.number().int().nonnegative().safe(),
    eligible: z.boolean(),
    reason: z.string().max(200),
  })
  .strict();
export const MaterialCacheOverview = z
  .object({
    version: z.literal(1),
    entries: z.array(MaterialCacheEntry).max(200),
    truncated: z.boolean(),
  })
  .strict();
export const MaterialCacheCleanRequest = z
  .object({
    stageIds: z.array(z.uuid()).min(1).max(50),
  })
  .strict()
  .refine((value) => new Set(value.stageIds).size === value.stageIds.length, '缓存不能重复');
export const MaterialCacheCleanResult = z
  .object({
    results: z
      .array(
        z.object({ stageId: z.uuid(), cleaned: z.boolean(), reason: z.string().max(200) }).strict(),
      )
      .max(50),
  })
  .strict();
export type CacheOverview = z.infer<typeof MaterialCacheOverview>;
