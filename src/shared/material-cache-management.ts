import { z } from 'zod';
import { Id, NonNegInt, sMax, strictObj } from './contracts.js';
const MaterialCacheEntry = strictObj({
  stageId: Id,
  bytes: NonNegInt,
  eligible: z.boolean(),
  reason: sMax(200),
});
export const MaterialCacheOverview = strictObj({
  version: z.literal(1),
  entries: z.array(MaterialCacheEntry).max(200),
  truncated: z.boolean(),
});
export const MaterialCacheCleanRequest = strictObj({ stageIds: z.array(Id).min(1).max(50) }).refine(
  (value) => new Set(value.stageIds).size === value.stageIds.length,
  '缓存不能重复',
);
export const MaterialCacheCleanResult = strictObj({
  results: z.array(strictObj({ stageId: Id, cleaned: z.boolean(), reason: sMax(200) })).max(50),
});
export type CacheOverview = z.infer<typeof MaterialCacheOverview>;
