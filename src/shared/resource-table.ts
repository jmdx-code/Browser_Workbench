import { z } from 'zod';
import { PostAILabelSetting } from './facebook-ai-label.js';

export const RESOURCE_TABLE_BODY_LIMIT = 4 * 1024 * 1024;
export const RESOURCE_TABLE_ROW_LIMIT = 1000;
export const ResourceMedia = z
  .object({
    kind: z.enum(['local', 'drive']),
    source: z.string().min(1).max(2048),
    name: z.string().min(1).max(300),
    mediaType: z.enum(['image', 'video', 'unknown']),
  })
  .strict();
export const ResourceRow = z
  .object({
    id: z.uuid(),
    purpose: z.enum(['post', 'story', 'both']).optional(),
    aiLabel: PostAILabelSetting.optional(),
    text: z
      .string()
      .max(256 * 1024)
      .refine((text) => new TextEncoder().encode(text).byteLength <= 256 * 1024, {
        message: '单条文案超过256KiB，请拆分',
      }),
    media: z.array(ResourceMedia).max(20),
    background: z.enum(['color', 'plain']),
  })
  .strict();
export const ResourceRows = z
  .array(ResourceRow)
  .max(RESOURCE_TABLE_ROW_LIMIT)
  .superRefine((rows, ctx) => {
    if (new Set(rows.map((row) => row.id)).size !== rows.length)
      ctx.addIssue({ code: 'custom', message: '资源行ID不能重复' });
  });
export const ResourceTable = z
  .object({
    combinationId: z.uuid(),
    revision: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    rows: ResourceRows,
    publishingReady: z.literal(false),
  })
  .strict();
export const GetResourceTable = z.object({ combinationId: z.uuid() }).strict();
export const SaveResourceTable = GetResourceTable.extend({
  expectedRevision: z.number().int().nonnegative(),
  rows: ResourceRows,
}).strict();
export const ResourceMediaPreviewRequest = GetResourceTable.extend({
  expectedRevision: z.number().int().nonnegative(),
  rowId: z.uuid(),
  fileIndex: z.number().int().min(0).max(19),
}).strict();
export const ResourceSummary = z
  .object({
    combinationId: z.uuid(),
    revision: z.number().int().nonnegative(),
    remaining: z.number().int().min(0).max(RESOURCE_TABLE_ROW_LIMIT),
    verifiedReady: z.literal(0),
  })
  .strict();
export const ResourceSummaries = z.array(ResourceSummary).max(10000);
export const RESOURCE_SUMMARY_HEADER = 'x-workbench-resource-summary';
// Counts describe saved rows and durable attempts, never permission or eligible content.
export const ResourceUsageSummary = ResourceSummary.extend({
  version: z.literal(2),
  total: z.number().int().min(0).max(RESOURCE_TABLE_ROW_LIMIT),
  published: z.number().int().min(0).max(RESOURCE_TABLE_ROW_LIMIT),
  pendingAttempts: z.number().int().nonnegative(),
  reviewAttempts: z.number().int().nonnegative(),
  previousVersionPending: z.number().int().nonnegative(),
})
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.remaining !== value.total - value.published ||
      value.previousVersionPending > value.pendingAttempts + value.reviewAttempts
    )
      ctx.addIssue({ code: 'custom', message: 'RESOURCE_USAGE_COUNTS_INVALID' });
  });
export const ResourceUsageSummaries = z.array(ResourceUsageSummary).max(10000);
export type ResourceMediaValue = z.infer<typeof ResourceMedia>;
export type ResourceRowValue = z.infer<typeof ResourceRow>;
export type ResourceTableValue = z.infer<typeof ResourceTable>;
export type ResourceSummaryValue = z.infer<typeof ResourceSummary>;
export type ResourceUsageSummaryValue = z.infer<typeof ResourceUsageSummary>;
