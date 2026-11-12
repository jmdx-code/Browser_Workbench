import type { BumperLog } from './group-bumper.js';
import type { PosterLog } from './group-poster.js';

export interface LogProfileDisplay {
  id: string;
  browserName?: string | null | undefined;
  alias?: string | null | undefined;
  name?: string | null | undefined;
  account?:
    | {
        id?: string | null | undefined;
        name?: string | null | undefined;
      }
    | null
    | undefined;
}

export function formatTimestampLocal(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * Normalizes a value into a single-line TSV cell safe for pasting directly into
 * Excel, Google Sheets, WPS, Feishu/Lark Sheets, or Notion tables without row-splitting
 * or formula-evaluation errors.
 */
export function sanitizeTsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const normalized = String(value)
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  if (!normalized) return '';
  if (/^[=+@-]/.test(normalized)) {
    return ` ${normalized}`;
  }
  return normalized;
}

function buildTsvDocument(
  headers: readonly string[],
  rows: ReadonlyArray<readonly unknown[]>,
): string {
  const headerLine = headers.map(sanitizeTsvCell).join('\t');
  const bodyLines = rows.map((cols) => cols.map(sanitizeTsvCell).join('\t'));
  return [headerLine, ...bodyLines].join('\n');
}

function resolveBrowserTitle(
  byProfile: ReadonlyMap<string, LogProfileDisplay>,
  profileId: string,
): string {
  const p = byProfile.get(profileId);
  if (!p) return profileId;
  return (
    p.browserName?.trim() ||
    p.alias?.trim() ||
    p.name?.trim() ||
    p.account?.name?.trim() ||
    profileId
  );
}

function formatPosterPublishStatus(postId: string): string {
  if (postId === 'pending_approval' || postId.startsWith('pending-')) {
    return '已提交待群管审核';
  }
  return '已发布';
}

export const POSTER_LOG_TSV_HEADERS = [
  '发帖时间',
  '浏览器',
  '发帖身份',
  '发帖账号/专页',
  '账号/专页ID',
  '目标小组',
  '小组ID',
  '状态',
  '贴文摘要',
  '帖子ID',
  '发帖链接',
] as const;

export function formatPosterLogsAsTsv(
  logs: readonly PosterLog[],
  profiles: readonly LogProfileDisplay[] = [],
): string {
  const byProfile = new Map(profiles.map((p) => [p.id, p]));
  const rows = logs.map((row) => {
    const p = byProfile.get(row.profileId);
    const browserTitle = resolveBrowserTitle(byProfile, row.profileId);
    const accountTitle = row.accountName.trim() || p?.account?.name?.trim() || browserTitle;
    return [
      formatTimestampLocal(row.postedAt),
      browserTitle,
      row.identityType === 'page' ? '专页' : '个人号',
      accountTitle,
      row.accountId,
      row.groupName,
      row.groupId,
      formatPosterPublishStatus(row.postId),
      row.captionPreview,
      row.postId,
      row.postUrl,
    ];
  });
  return buildTsvDocument(POSTER_LOG_TSV_HEADERS, rows);
}

export const BUMPER_LOG_TSV_HEADERS = [
  '顶贴时间',
  '模块类型',
  '浏览器/窗口',
  '顶贴账号名称',
  '顶贴账号ID',
  '所属小组',
  '小组ID',
  '目标主页/专页',
  '主页/专页ID',
  '是否点赞',
  '留言内容',
  '帖子ID',
  '帖子链接',
] as const;

export function formatBumperLogsAsTsv(
  logs: readonly BumperLog[],
  profiles: readonly LogProfileDisplay[] = [],
): string {
  const byProfile = new Map(profiles.map((p) => [p.id, p]));
  const rows = logs.map((row) => {
    const p = byProfile.get(row.profileId);
    const browserTitle = resolveBrowserTitle(byProfile, row.profileId);
    const accountName = p?.account?.name?.trim() || p?.name?.trim() || '';
    const isPageMode = row.sourceMode === 'page' || row.groupId === '-';
    return [
      formatTimestampLocal(row.bumpedAt),
      isPageMode ? '专页顶贴' : '小组顶贴',
      browserTitle,
      accountName,
      row.accountId,
      isPageMode ? '专页主页' : row.groupName,
      isPageMode ? '' : row.groupId,
      row.pageName,
      row.pageId,
      row.liked ? '已点赞' : '否',
      row.commentText ?? '',
      row.postId,
      row.postUrl,
    ];
  });
  return buildTsvDocument(BUMPER_LOG_TSV_HEADERS, rows);
}

export const UNIFIED_POST_BUMP_TSV_HEADERS = [
  '执行时间',
  '模块类型',
  '浏览器/窗口',
  '执行账号/专页',
  '执行账号ID',
  '所属小组',
  '小组ID',
  '目标主页/专页',
  '主页/专页ID',
  '动作/贴文内容',
  '帖子ID',
  '帖子链接',
] as const;

export function formatUnifiedPostAndBumpLogsAsTsv(input: {
  posterLogs: readonly PosterLog[];
  bumperLogs: readonly BumperLog[];
  profiles?: readonly LogProfileDisplay[] | undefined;
}): { tsv: string; count: number } {
  const byProfile = new Map((input.profiles ?? []).map((p) => [p.id, p]));
  type CombinedEntry = { timestamp: number; id: string; cols: readonly unknown[] };
  const combined: CombinedEntry[] = [];

  for (const row of input.posterLogs) {
    const p = byProfile.get(row.profileId);
    const browserTitle = resolveBrowserTitle(byProfile, row.profileId);
    const accountTitle = row.accountName.trim() || p?.account?.name?.trim() || browserTitle;
    const statusLabel = formatPosterPublishStatus(row.postId);
    combined.push({
      timestamp: row.postedAt,
      id: `poster:${row.id}`,
      cols: [
        formatTimestampLocal(row.postedAt),
        '小组发帖',
        browserTitle,
        accountTitle,
        row.accountId,
        row.groupName,
        row.groupId,
        '',
        '',
        `[${statusLabel}] ${row.captionPreview}`.trim(),
        row.postId,
        row.postUrl,
      ],
    });
  }

  for (const row of input.bumperLogs) {
    const p = byProfile.get(row.profileId);
    const browserTitle = resolveBrowserTitle(byProfile, row.profileId);
    const accountTitle = p?.account?.name?.trim() || p?.name?.trim() || browserTitle;
    const isPageMode = row.sourceMode === 'page' || row.groupId === '-';
    const actionParts: string[] = [];
    if (row.liked) actionParts.push('已点赞');
    if (row.commentText) actionParts.push(`留言: ${row.commentText}`);
    combined.push({
      timestamp: row.bumpedAt,
      id: `bumper:${row.id}`,
      cols: [
        formatTimestampLocal(row.bumpedAt),
        isPageMode ? '专页顶贴' : '小组顶贴',
        browserTitle,
        accountTitle,
        row.accountId,
        isPageMode ? '专页主页' : row.groupName,
        isPageMode ? '' : row.groupId,
        row.pageName,
        row.pageId,
        actionParts.join(' · ') || '已顶贴',
        row.postId,
        row.postUrl,
      ],
    });
  }

  combined.sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));
  return {
    tsv: buildTsvDocument(
      UNIFIED_POST_BUMP_TSV_HEADERS,
      combined.map((item) => item.cols),
    ),
    count: combined.length,
  };
}

export async function collectAllPaginatedLogs<T extends { id: string }>(options: {
  initialRows: readonly T[];
  pageSize?: number | undefined;
  maxPages?: number | undefined;
  getTimestamp: (row: T) => number;
  fetchPage: (before: number, beforeId: string) => Promise<readonly T[]>;
}): Promise<T[]> {
  const pageSize = options.pageSize ?? 200;
  const maxPages = options.maxPages ?? 50;
  const result: T[] = [];
  const seen = new Set<string>();
  for (const row of options.initialRows) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      result.push(row);
    }
  }
  if (options.initialRows.length < pageSize) {
    return result;
  }
  let last = options.initialRows.at(-1);
  for (let page = 1; page < maxPages && last; page++) {
    const batch = await options.fetchPage(options.getTimestamp(last), last.id);
    if (!batch.length) break;
    let added = 0;
    for (const item of batch) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        result.push(item);
        added++;
      }
    }
    if (batch.length < pageSize || added === 0) break;
    last = batch.at(-1);
  }
  return result;
}
