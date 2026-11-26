import { z } from 'zod';
import { Id, PosInt, addIssue, intRange, sMax, sReq, strictObj } from './contracts.js';
import { CheckResourceSources } from './resource-source.js';
import { ResourceTable } from './resource-table.js';
const cnt = intRange(0, 20000);
export const DownloadResourceSources = CheckResourceSources;
export const ResourceDownloadProgress = strictObj({
  completed: cnt,
  total: cnt,
  downloaded: cnt,
  failed: cnt,
  bytes: intRange(0, 64 * 1024 ** 3),
}).refine((v) => v.completed <= v.total && v.completed === v.downloaded + v.failed);
export const ResourceDownloadIssue = strictObj({
  rowId: Id,
  fileIndex: intRange(0, 19),
  error: sReq(300),
});
export const ResourceDownloadReport = strictObj({
  combinationId: Id,
  expectedRevision: PosInt,
  table: ResourceTable,
  progress: ResourceDownloadProgress,
  issues: z.array(ResourceDownloadIssue).max(20000),
}).superRefine((v, ctx) => {
  if (
    v.table.combinationId !== v.combinationId ||
    v.table.revision < v.expectedRevision ||
    v.progress.completed !== v.progress.total ||
    v.issues.length !== v.progress.failed
  )
    addIssue(ctx, 'RESOURCE_DOWNLOAD_REPORT_MISMATCH');
});
export const ResourceDownloadFrame = z.discriminatedUnion('kind', [
  ResourceDownloadProgress.safeExtend({ kind: z.literal('progress') }),
  strictObj({ kind: z.literal('completed'), report: ResourceDownloadReport }),
  strictObj({ kind: z.literal('failed'), error: sMax(1000), code: sMax(100) }),
]);
export type ResourceDownloadProgressValue = z.infer<typeof ResourceDownloadProgress>;
export type ResourceDownloadReportValue = z.infer<typeof ResourceDownloadReport>;
