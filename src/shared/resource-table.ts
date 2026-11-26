import { z } from 'zod';
import {
  Id,
  NonNegInt,
  PostAILabelSetting,
  addIssue,
  intRange,
  sMax,
  sReq,
  strictObj,
} from './contracts.js';
export const RESOURCE_TABLE_BODY_LIMIT = 4 * 1024 * 1024;
export const RESOURCE_TABLE_ROW_LIMIT = 1000;
const rowCount = intRange(0, RESOURCE_TABLE_ROW_LIMIT);
export const ResourceMedia = strictObj({
  kind: z.enum(['local', 'drive']),
  source: sReq(2048),
  name: sReq(300),
  mediaType: z.enum(['image', 'video', 'unknown']),
});
export const ResourceRow = strictObj({
  id: Id,
  purpose: z.enum(['post', 'story', 'both']).optional(),
  aiLabel: PostAILabelSetting.optional(),
  text: sMax(256 * 1024).refine(
    (t) => new TextEncoder().encode(t).byteLength <= 256 * 1024,
    '单条文案超过256KiB，请拆分',
  ),
  media: z.array(ResourceMedia).max(20),
  background: z.enum(['color', 'plain']),
});
export const ResourceRows = z
  .array(ResourceRow)
  .max(RESOURCE_TABLE_ROW_LIMIT)
  .superRefine((rows, ctx) => {
    if (new Set(rows.map((r) => r.id)).size !== rows.length) addIssue(ctx, '资源行ID不能重复');
  });
export const ResourceTable = strictObj({
  combinationId: Id,
  revision: NonNegInt,
  updatedAt: NonNegInt,
  rows: ResourceRows,
  publishingReady: z.literal(false),
});
export const GetResourceTable = strictObj({ combinationId: Id });
export const SaveResourceTable = GetResourceTable.extend({
  expectedRevision: NonNegInt,
  rows: ResourceRows,
}).strict();
export const ResourceMediaPreviewRequest = GetResourceTable.extend({
  expectedRevision: NonNegInt,
  rowId: Id,
  fileIndex: intRange(0, 19),
}).strict();
export const ResourceSummary = strictObj({
  combinationId: Id,
  revision: NonNegInt,
  remaining: rowCount,
  verifiedReady: z.literal(0),
});
export const ResourceSummaries = z.array(ResourceSummary).max(10000);
export const RESOURCE_SUMMARY_HEADER = 'x-workbench-resource-summary';
// Counts describe saved rows and durable attempts, never permission or eligible content.
export const ResourceUsageSummary = ResourceSummary.extend({
  version: z.literal(2),
  total: rowCount,
  published: rowCount,
  pendingAttempts: NonNegInt,
  reviewAttempts: NonNegInt,
  previousVersionPending: NonNegInt,
})
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.remaining !== v.total - v.published ||
      v.previousVersionPending > v.pendingAttempts + v.reviewAttempts
    )
      addIssue(ctx, 'RESOURCE_USAGE_COUNTS_INVALID');
  });
export const ResourceUsageSummaries = z.array(ResourceUsageSummary).max(10000);
export type ResourceMediaValue = z.infer<typeof ResourceMedia>;
export type ResourceRowValue = z.infer<typeof ResourceRow>;
export type ResourceTableValue = z.infer<typeof ResourceTable>;
export type ResourceSummaryValue = z.infer<typeof ResourceSummary>;
export type ResourceUsageSummaryValue = z.infer<typeof ResourceUsageSummary>;
