import { z } from 'zod';
import { GetResourceTable, RESOURCE_TABLE_ROW_LIMIT } from './resource-table.js';

export const CheckResourceSources = GetResourceTable.extend({
  expectedRevision: z.number().int().positive(),
  rowIds: z
    .array(z.uuid())
    .min(1)
    .max(RESOURCE_TABLE_ROW_LIMIT)
    .refine((ids) => new Set(ids).size === ids.length)
    .optional(),
}).strict();
export const ResourceSourceFile = z
  .object({
    name: z.string().min(1).max(300),
    role: z.enum(['image', 'video']),
    bytes: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 ** 3),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const ResourceSourceIssue = z.enum([
  'EMPTY',
  'DRIVE_DOWNLOAD_PENDING',
  'FILE_UNAVAILABLE',
  'PATH_UNSUPPORTED',
  'FILE_CHANGED',
  'TYPE_MISMATCH',
  'FILE_SIZE_LIMIT',
]);
export const ResourceSourceRow = z
  .object({
    rowId: z.uuid(),
    sourceVerified: z.boolean(),
    issue: ResourceSourceIssue.nullable(),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    files: z.array(ResourceSourceFile).max(20),
    duplicateOf: z.uuid().nullable(),
    blockers: z.array(z.enum(['TEXT_INPUT_LIMIT', 'BACKGROUND_UNVERIFIED'])).max(2),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (
      row.sourceVerified
        ? row.issue !== null || row.fingerprint === null
        : row.issue === null ||
          row.files.length > 0 ||
          row.duplicateOf !== null ||
          row.fingerprint !== null
    )
      ctx.addIssue({ code: 'custom', message: '来源检查状态不一致' });
  });
export const ResourceSourceReport = CheckResourceSources.extend({
  checkedAt: z.number().int().nonnegative(),
  readonly: z.literal(true),
  publishingReady: z.literal(false),
  fingerprintVersion: z.literal(1),
  rows: z.array(ResourceSourceRow).max(RESOURCE_TABLE_ROW_LIMIT),
  verifiedSources: z.number().int().min(0).max(RESOURCE_TABLE_ROW_LIMIT),
  uniqueContents: z.number().int().min(0).max(RESOURCE_TABLE_ROW_LIMIT),
})
  .strict()
  .superRefine((report, ctx) => {
    const first = new Map<string, string>();
    for (const row of report.rows) {
      if (!row.fingerprint) continue;
      if (row.duplicateOf !== (first.get(row.fingerprint) ?? null))
        ctx.addIssue({ code: 'custom', message: '重复内容关联不一致' });
      if (!first.has(row.fingerprint)) first.set(row.fingerprint, row.rowId);
    }
    if (
      new Set(report.rows.map((row) => row.rowId)).size !== report.rows.length ||
      (report.rowIds &&
        JSON.stringify([...report.rowIds].sort()) !==
          JSON.stringify(report.rows.map((row) => row.rowId).sort())) ||
      report.verifiedSources !== report.rows.filter((row) => row.sourceVerified).length ||
      report.uniqueContents !== first.size
    )
      ctx.addIssue({ code: 'custom', message: '来源检查汇总不一致' });
  });
export type ResourceSourceFileValue = z.infer<typeof ResourceSourceFile>;
export type ResourceSourceIssueValue = z.infer<typeof ResourceSourceIssue>;
export type ResourceSourceReportValue = z.infer<typeof ResourceSourceReport>;
export const ResourceCheckProgress = z
  .object({
    completed: z.number().int().min(0).max(RESOURCE_TABLE_ROW_LIMIT),
    total: z.number().int().min(0).max(RESOURCE_TABLE_ROW_LIMIT),
  })
  .strict()
  .refine((value) => value.completed <= value.total);
export const ResourceCheckFrame = z.discriminatedUnion('kind', [
  ResourceCheckProgress.safeExtend({ kind: z.literal('progress') }),
  z.object({ kind: z.literal('completed'), report: ResourceSourceReport }).strict(),
  z
    .object({ kind: z.literal('failed'), code: z.string().max(100), error: z.string().max(1000) })
    .strict(),
]);
export type ResourceCheckProgressValue = z.infer<typeof ResourceCheckProgress>;
