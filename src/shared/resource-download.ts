import { z } from 'zod';
import { CheckResourceSources } from './resource-source.js';
import { ResourceTable } from './resource-table.js';

export const DownloadResourceSources = CheckResourceSources;
export const ResourceDownloadProgress = z
  .object({
    completed: z.number().int().min(0).max(20000),
    total: z.number().int().min(0).max(20000),
    downloaded: z.number().int().min(0).max(20000),
    failed: z.number().int().min(0).max(20000),
    bytes: z
      .number()
      .int()
      .min(0)
      .max(64 * 1024 ** 3),
  })
  .strict()
  .refine(
    (value) =>
      value.completed <= value.total && value.completed === value.downloaded + value.failed,
  );
export const ResourceDownloadIssue = z
  .object({
    rowId: z.uuid(),
    fileIndex: z.number().int().min(0).max(19),
    error: z.string().min(1).max(300),
  })
  .strict();
export const ResourceDownloadReport = z
  .object({
    combinationId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    table: ResourceTable,
    progress: ResourceDownloadProgress,
    issues: z.array(ResourceDownloadIssue).max(20000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.table.combinationId !== value.combinationId ||
      value.table.revision < value.expectedRevision ||
      value.progress.completed !== value.progress.total ||
      value.issues.length !== value.progress.failed
    )
      ctx.addIssue({ code: 'custom', message: 'RESOURCE_DOWNLOAD_REPORT_MISMATCH' });
  });
export const ResourceDownloadFrame = z.discriminatedUnion('kind', [
  ResourceDownloadProgress.safeExtend({ kind: z.literal('progress') }),
  z.object({ kind: z.literal('completed'), report: ResourceDownloadReport }).strict(),
  z
    .object({ kind: z.literal('failed'), error: z.string().max(1000), code: z.string().max(100) })
    .strict(),
]);
export type ResourceDownloadProgressValue = z.infer<typeof ResourceDownloadProgress>;
export type ResourceDownloadReportValue = z.infer<typeof ResourceDownloadReport>;
