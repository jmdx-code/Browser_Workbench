import { profileDisplayName } from './contracts.js';
import { isPendingApprovalPostId, type PosterLog } from './group-poster.js';
import { formatPostBumpRecordSummary, type PostBumpRecord } from './post-bump-records.js';
interface LogProfileDisplay {
  id: string;
  browserName?: string | null | undefined;
  alias?: string | null | undefined;
  name?: string | null | undefined;
  account?: { id?: string | null | undefined; name?: string | null | undefined } | null | undefined;
}
export function formatTimestampLocal(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms),
    p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
export function sanitizeTsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const normalized = String(value)
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  return !normalized ? '' : /^[=+@-]/.test(normalized) ? ` ${normalized}` : normalized;
}
const buildTsvDocument = (
  headers: readonly string[],
  rows: ReadonlyArray<readonly unknown[]>,
): string =>
  [
    headers.map(sanitizeTsvCell).join('\t'),
    ...rows.map((cols) => cols.map(sanitizeTsvCell).join('\t')),
  ].join('\n');
export const POSTER_LOG_TSV_HEADERS =
  '发帖时间 浏览器 发帖身份 发帖账号/专页 账号/专页ID 目标小组 小组ID 状态 贴文摘要 帖子ID 发帖链接'.split(
    ' ',
  );
export function formatPosterLogsAsTsv(
  logs: readonly PosterLog[],
  profiles: readonly LogProfileDisplay[] = [],
): string {
  const byProfile = new Map(profiles.map((p) => [p.id, p]));
  return buildTsvDocument(
    POSTER_LOG_TSV_HEADERS,
    logs.map((row) => {
      const p = byProfile.get(row.profileId);
      const browserTitle = profileDisplayName(p, p?.account?.name?.trim() || row.profileId);
      return [
        formatTimestampLocal(row.postedAt),
        browserTitle,
        row.identityType === 'page' ? '专页' : '个人号',
        row.accountName.trim() || p?.account?.name?.trim() || browserTitle,
        row.accountId,
        row.groupName,
        row.groupId,
        isPendingApprovalPostId(row.postId) ? '已提交待群管审核' : '已发布',
        row.captionPreview,
        row.postId,
        row.postUrl,
      ];
    }),
  );
}
export const UNIFIED_POST_BUMP_11_HEADERS =
  '日期时间 类型 载体 账号名 账号ID 小组名 小组ID 专页名 专页ID 贴文链接 动作与摘要'.split(' ');
export function formatPostBumpRecordsAsTsv(records: readonly PostBumpRecord[]): {
  tsv: string;
  count: number;
} {
  const rows = records.map((row) => [
    formatTimestampLocal(row.createdAt),
    row.recordType === 'post'
      ? '小组发帖'
      : row.recordType === 'page_bump'
        ? '专页顶贴'
        : '小组顶贴',
    row.carrier === 'bluestacks' ? '蓝蝶' : '浏览器',
    row.accountName || row.accountId,
    row.accountId,
    row.groupName,
    row.groupId,
    row.pageName,
    row.pageId,
    row.postUrl,
    formatPostBumpRecordSummary(row),
  ]);
  return { tsv: buildTsvDocument(UNIFIED_POST_BUMP_11_HEADERS, rows), count: records.length };
}
export async function collectAllPaginatedLogs<T extends { id: string }>(options: {
  initialRows: readonly T[];
  pageSize?: number | undefined;
  maxPages?: number | undefined;
  getTimestamp: (row: T) => number;
  fetchPage: (before: number, beforeId: string) => Promise<readonly T[]>;
}): Promise<T[]> {
  const pageSize = options.pageSize ?? 200,
    maxPages = options.maxPages ?? 50,
    result: T[] = [],
    seen = new Set<string>();
  const addBatch = (batch: readonly T[]) => {
    let added = 0;
    for (const item of batch)
      if (!seen.has(item.id)) {
        seen.add(item.id);
        result.push(item);
        added++;
      }
    return added;
  };
  addBatch(options.initialRows);
  if (options.initialRows.length < pageSize) return result;
  for (let page = 1, last = options.initialRows.at(-1); page < maxPages && last;) {
    const batch = await options.fetchPage(options.getTimestamp(last), last.id);
    if (!batch.length || addBatch(batch) === 0 || batch.length < pageSize) break;
    last = batch.at(-1);
  }
  return result;
}
