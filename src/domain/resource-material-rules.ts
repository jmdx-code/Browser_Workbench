import {
  ResourceUsageSummary,
  type ResourceRowValue,
  type ResourceTableValue,
  type ResourceMediaValue,
} from '../shared/resource-table.js';
import { hasResource } from './resource-table.js';
import type { MaterialFileSnapshot, MaterialMediaType } from '../shared/materials.js';
import type { Awaitable } from './persistence.js';
import type {
  MaterialUsage,
  MaterialUsageClearRequest,
  MaterialUsageClearResult,
} from '../shared/material-usage.js';
import type {
  ResourceSourceFileValue,
  ResourceSourceIssueValue,
} from '../shared/resource-source.js';
import type { ResourceOrigin } from '../shared/resource-materials.js';
import type { ResourceBinding, FixedResourceSnapshot } from '../shared/task-policies.js';
import type { Combination } from '../shared/contracts.js';
export const normalizeMaterialText = (input: string): string =>
  input
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .trim();
// Dedupe is content-based: retain media multiplicity, ignore file names and presentation order.
// The publishing snapshot separately preserves the ordered files. Do not change v1 after persistence.
export function materialFingerprintPayload(
  text: string,
  files: readonly Pick<MaterialFileSnapshot, 'role' | 'digest'>[],
): string {
  return JSON.stringify({
    version: 1,
    text: normalizeMaterialText(text),
    media: files
      .filter((f) => f.role !== 'text')
      .map((f) => ({ role: f.role, digest: f.digest }))
      .sort((a, b) => (a.role + ':' + a.digest).localeCompare(b.role + ':' + b.digest)),
  });
}
export interface MaterialUsageRepository {
  snapshot(): Awaitable<MaterialUsage>;
  clear(request: MaterialUsageClearRequest): Awaitable<MaterialUsageClearResult>;
}
export type ResourceSourceResult =
  | { verified: true; fingerprint: string; files: ResourceSourceFileValue[] }
  | { verified: false; issue: ResourceSourceIssueValue };
export interface ResourceSourceReader {
  // Explicit saved-row inspection only; no download, upload, file writes or publishing authority.
  verify(
    row: ResourceRowValue,
    assertCurrent: (bytesRead?: number) => Awaitable<void>,
  ): Promise<ResourceSourceResult>;
  previewMedia?(
    row: ResourceRowValue,
    fileIndex: number,
    assertCurrent: () => Awaitable<void>,
  ): Promise<{ bytes: Uint8Array; contentType: MaterialMediaType }>;
}
export const resourceSourceIssueText: Record<ResourceSourceIssueValue, string> = {
  EMPTY: '空行',
  DRIVE_DOWNLOAD_PENDING: '网盘文件待下载核验',
  FILE_UNAVAILABLE: '文件不存在或无法读取',
  PATH_UNSUPPORTED: '文件路径不受支持',
  FILE_CHANGED: '文件或所在目录检查期间发生变化',
  TYPE_MISMATCH: '实际文件类型与扩展名不符',
  FILE_SIZE_LIMIT: '文件超出本次检查容量',
};
export interface ResourceUsageFact {
  attemptId: string;
  resource: ResourceOrigin;
  state: 'RESERVED' | 'REVIEW' | 'PUBLISHED';
}
export function summarizeResourceUsage(table: ResourceTableValue, facts: ResourceUsageFact[]) {
  const rows = new Map(table.rows.filter(hasResource).map((r) => [r.id, JSON.stringify(r)])),
    published = new Set<string>(),
    attempts = new Set<string>();
  let pendingAttempts = 0,
    reviewAttempts = 0,
    previousVersionPending = 0;
  for (const fact of facts) {
    if (fact.resource.combinationId !== table.combinationId || attempts.has(fact.attemptId))
      throw Error('RESOURCE_USAGE_SCOPE_INVALID');
    attempts.add(fact.attemptId);
    const current = rows.get(fact.resource.row.id) === JSON.stringify(fact.resource.row);
    if (fact.state === 'PUBLISHED') {
      if (current) published.add(fact.resource.row.id);
    } else {
      if (fact.state === 'REVIEW') reviewAttempts++;
      else pendingAttempts++;
      if (!current) previousVersionPending++;
    }
  }
  return ResourceUsageSummary.parse({
    version: 2,
    combinationId: table.combinationId,
    revision: table.revision,
    total: rows.size,
    published: published.size,
    remaining: rows.size - published.size,
    pendingAttempts,
    reviewAttempts,
    previousVersionPending,
    verifiedReady: 0,
  });
}
export interface ResourceDriveDownloader {
  download(
    source: string,
    index: number,
    assertCurrent: (bytesRead?: number) => Awaitable<void>,
  ): Promise<ResourceMediaValue>;
}
export const needsResourceTable = (snapshot: Combination) =>
  snapshot.steps.some((step) => step.type === 'post' && step.resourceMode === 'table');
export interface TaskResourceRepository {
  binding(jobId: string): Awaitable<ResourceBinding | null>;
  snapshot(jobId: string): Awaitable<FixedResourceSnapshot>;
}
