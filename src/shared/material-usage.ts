import { z } from 'zod';
import { Id, NonNegInt, PosInt, strictObj } from './contracts.js';
export const MaterialUsageSnapshot = strictObj({
  generation: NonNegInt,
  published: NonNegInt,
  contents: NonNegInt,
  lastClearedAt: NonNegInt.nullable(),
  activePublishing: z.boolean(),
});
export const ClearMaterialUsage = strictObj({
  requestId: Id,
  expectedGeneration: NonNegInt,
  expectedPublished: NonNegInt,
});
export const ClearedMaterialUsage = strictObj({
  requestId: Id,
  previousGeneration: NonNegInt,
  generation: PosInt,
  clearedPublications: NonNegInt,
  clearedAt: NonNegInt,
});
export type MaterialUsage = z.infer<typeof MaterialUsageSnapshot>;
export type MaterialUsageClearRequest = z.infer<typeof ClearMaterialUsage>;
export type MaterialUsageClearResult = z.infer<typeof ClearedMaterialUsage>;
