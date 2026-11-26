import { z } from 'zod';
import {
  Id,
  NonNegInt,
  PosInt,
  Sha256Hex,
  addIssue,
  intRange,
  sMax,
  sReq,
  strictObj,
} from './contracts.js';
import { GetResourceTable, RESOURCE_TABLE_ROW_LIMIT } from './resource-table.js';
const rowCount = intRange(0, RESOURCE_TABLE_ROW_LIMIT);
export const CheckResourceSources = GetResourceTable.extend({
  expectedRevision: PosInt,
  rowIds: z
    .array(Id)
    .min(1)
    .max(RESOURCE_TABLE_ROW_LIMIT)
    .refine((ids) => new Set(ids).size === ids.length)
    .optional(),
}).strict();
export const ResourceSourceFile = strictObj({
  name: sReq(300),
  role: z.enum(['image', 'video']),
  bytes: PosInt.max(10 * 1024 ** 3),
  digest: Sha256Hex,
});
export const ResourceSourceIssue = z.enum([
  'EMPTY',
  'DRIVE_DOWNLOAD_PENDING',
  'FILE_UNAVAILABLE',
  'PATH_UNSUPPORTED',
  'FILE_CHANGED',
  'TYPE_MISMATCH',
  'FILE_SIZE_LIMIT',
]);
export const ResourceSourceRow = strictObj({
  rowId: Id,
  sourceVerified: z.boolean(),
  issue: ResourceSourceIssue.nullable(),
  fingerprint: Sha256Hex.nullable(),
  files: z.array(ResourceSourceFile).max(20),
  duplicateOf: Id.nullable(),
  blockers: z.array(z.enum(['TEXT_INPUT_LIMIT', 'BACKGROUND_UNVERIFIED'])).max(2),
}).superRefine((row, ctx) => {
  if (
    row.sourceVerified
      ? row.issue !== null || row.fingerprint === null
      : row.issue === null ||
        row.files.length > 0 ||
        row.duplicateOf !== null ||
        row.fingerprint !== null
  )
    addIssue(ctx, '来源检查状态不一致');
});
export const ResourceSourceReport = CheckResourceSources.extend({
  checkedAt: NonNegInt,
  readonly: z.literal(true),
  publishingReady: z.literal(false),
  fingerprintVersion: z.literal(1),
  rows: z.array(ResourceSourceRow).max(RESOURCE_TABLE_ROW_LIMIT),
  verifiedSources: rowCount,
  uniqueContents: rowCount,
})
  .strict()
  .superRefine((report, ctx) => {
    const first = new Map<string, string>();
    for (const row of report.rows) {
      if (!row.fingerprint) continue;
      if (row.duplicateOf !== (first.get(row.fingerprint) ?? null))
        addIssue(ctx, '重复内容关联不一致');
      if (!first.has(row.fingerprint)) first.set(row.fingerprint, row.rowId);
    }
    if (
      new Set(report.rows.map((r) => r.rowId)).size !== report.rows.length ||
      (report.rowIds &&
        JSON.stringify([...report.rowIds].sort()) !==
          JSON.stringify(report.rows.map((r) => r.rowId).sort())) ||
      report.verifiedSources !== report.rows.filter((r) => r.sourceVerified).length ||
      report.uniqueContents !== first.size
    )
      addIssue(ctx, '来源检查汇总不一致');
  });
export type ResourceSourceFileValue = z.infer<typeof ResourceSourceFile>;
export type ResourceSourceIssueValue = z.infer<typeof ResourceSourceIssue>;
export type ResourceSourceReportValue = z.infer<typeof ResourceSourceReport>;
export const ResourceCheckProgress = strictObj({ completed: rowCount, total: rowCount }).refine(
  (v) => v.completed <= v.total,
);
export const ResourceCheckFrame = z.discriminatedUnion('kind', [
  ResourceCheckProgress.safeExtend({ kind: z.literal('progress') }),
  strictObj({ kind: z.literal('completed'), report: ResourceSourceReport }),
  strictObj({ kind: z.literal('failed'), code: sMax(100), error: sMax(1000) }),
]);
export type ResourceCheckProgressValue = z.infer<typeof ResourceCheckProgress>;
