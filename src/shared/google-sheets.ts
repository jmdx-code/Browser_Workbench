import { z } from 'zod';
import { Id } from './contracts.js';
import { extractFacebookGroupId, extractFacebookPageId } from './facebook-target-id.js';
import { BumperSettings } from './group-bumper.js';

export const GoogleSheetKind = z.enum([
  'group_library',
  'page_library',
  'post_schedule',
  'post_records',
]);
export type GoogleSheetKind = z.infer<typeof GoogleSheetKind>;

export const PAGE_TIMELINE_SYNTHETIC_GROUP_ID = '__page_timeline__';

export const SheetImageHostPreference = z.enum(['auto', 'gyazo', 'drive']);
export type SheetImageHostPreference = z.infer<typeof SheetImageHostPreference>;

export const SheetImageHostConfig = z
  .object({
    preferredHost: SheetImageHostPreference.default('auto'),
    gyazoAccessToken: z.string().trim().max(512).default(''),
    gyazoAccessTokens: z.array(z.string().trim().min(1).max(512)).max(50).default([]),
    driveFolderId: z.string().trim().max(256).nullable().default(null),
    defaultMachineName: z.string().trim().min(1).max(60).default('电脑1号'),
  })
  .strict();
export type SheetImageHostConfig = z.infer<typeof SheetImageHostConfig>;

export const SaveSheetImageHostInput = z
  .object({
    preferredHost: SheetImageHostPreference.optional(),
    gyazoAccessToken: z.string().trim().max(512).optional(),
    gyazoAccessTokens: z.array(z.string().trim().max(512)).max(50).optional(),
    clearGyazoToken: z.boolean().optional(),
    defaultMachineName: z.string().trim().min(1).max(60).optional(),
  })
  .strict();
export type SaveSheetImageHostInput = z.infer<typeof SaveSheetImageHostInput>;

export const GoogleAuthStatus = z.object({
  hasCredentials: z.boolean(),
  clientIdHint: z.string().nullable(),
  authorized: z.boolean(),
  authorizedEmail: z.string().nullable(),
  scopes: z.array(z.string()),
  pendingAuthUrl: z.string().nullable(),
  pendingAuthStartedAt: z.number().nullable(),
  lastError: z.string().nullable(),
});
export type GoogleAuthStatus = z.infer<typeof GoogleAuthStatus>;

export const SheetImageHostStatus = z.object({
  preferredHost: SheetImageHostPreference,
  hasGyazoToken: z.boolean(),
  gyazoTokenPreview: z.string().nullable(),
  gyazoTokenCount: z.number().int().nonnegative().default(0),
  gyazoTokenPreviews: z.array(z.string()).default([]),
  driveFolderId: z.string().nullable(),
  defaultMachineName: z.string(),
  cachedImageCount: z.number().int().nonnegative(),
});
export type SheetImageHostStatus = z.infer<typeof SheetImageHostStatus>;

export function parseGyazoTokenList(raw: string | readonly string[]): string[] {
  const parts = Array.isArray(raw)
    ? raw.flatMap((entry) => String(entry).split(/[\r\n,;，；\s]+/))
    : String(raw).split(/[\r\n,;，；\s]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed.length > 512) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= 50) break;
  }
  return out;
}

export function resolveEffectiveGyazoTokens(config: {
  gyazoAccessToken?: string | undefined;
  gyazoAccessTokens?: readonly string[] | undefined;
}): string[] {
  const combined: string[] = [];
  if (Array.isArray(config.gyazoAccessTokens)) {
    combined.push(...config.gyazoAccessTokens);
  }
  if (typeof config.gyazoAccessToken === 'string' && config.gyazoAccessToken.trim()) {
    combined.push(config.gyazoAccessToken);
  }
  return parseGyazoTokenList(combined);
}

export function maskGyazoToken(token: string): string | null {
  const t = token.trim();
  if (!t) return null;
  if (t.length <= 10) return '••••••';
  return `${t.slice(0, 4)}••••${t.slice(-4)}`;
}

export const ScheduleExecutionCarrier = z.enum(['browser', 'bluestacks', 'auto']);
export type ScheduleExecutionCarrier = z.infer<typeof ScheduleExecutionCarrier>;

export const PostScheduleSheetConfig = z
  .object({
    enabled: z.boolean().default(false),
    pollIntervalMinutes: z.number().int().min(1).max(60).default(2),
    targetRecordLinkId: z.string().trim().max(120).nullable().default(null),
    autoWakeBumper: z.boolean().default(true),
    executionCarrier: ScheduleExecutionCarrier.default('browser'),
    bluestacksFolderIds: z.array(z.string().trim().min(1)).max(100).default([]),
    bluestacksInstanceIds: z.array(z.string().trim().min(1)).max(500).default([]),
    closeBluestacksOnFinish: z.boolean().default(true),
  })
  .strict();
export type PostScheduleSheetConfig = z.infer<typeof PostScheduleSheetConfig>;

export const PostRecordsSheetConfig = z
  .object({
    enabled: z.boolean().default(false),
    machineName: z.string().trim().min(1).max(60).default('电脑1号'),
    bumperProfileGroupIds: z.array(z.string().trim().min(1)).max(100).default([]),
    bumperProfileIds: z.array(z.string().trim().min(1)).max(500).default([]),
    bumperBluestacksFolderIds: z.array(z.string().trim().min(1)).max(100).default([]),
    bumperBluestacksIds: z.array(z.string().trim().min(1)).max(500).default([]),
    bumperSettings: BumperSettings.default(() => BumperSettings.parse({})),
    commentPool: z.array(z.string().trim().min(1).max(1000)).max(2000).default([]),
    collectMetricsOnThisPc: z.boolean().default(false),
    activePollMinutes: z.number().int().min(1).max(30).default(2),
    semiActivePollMinutes: z.number().int().min(2).max(120).default(10),
    semiActiveAfterIdlePolls: z.number().int().min(1).max(30).default(5),
  })
  .strict();
export type PostRecordsSheetConfig = z.infer<typeof PostRecordsSheetConfig>;

export const SheetPollingMode = z.enum(['idle', 'active', 'semi_active']);
export type SheetPollingMode = z.infer<typeof SheetPollingMode>;

export const GoogleSheetLinkRuntime = z.object({
  lastSyncedAt: z.number().nullable().default(null),
  lastSyncSummary: z.string().default(''),
  lastError: z.string().nullable().default(null),
  pollingMode: SheetPollingMode.default('idle'),
  consecutiveIdlePolls: z.number().int().nonnegative().default(0),
  nextPollAt: z.number().nullable().default(null),
  activeJobText: z.string().default(''),
  activeRunningCount: z.number().int().nonnegative().default(0),
  totalRowCount: z.number().int().nonnegative().default(0),
  lastMetricsRunAt: z.number().nullable().default(null),
});
export type GoogleSheetLinkRuntime = z.infer<typeof GoogleSheetLinkRuntime>;

export const GoogleSheetLink = z.object({
  id: Id,
  kind: GoogleSheetKind,
  title: z.string().trim().min(1).max(120),
  spreadsheetId: z.string().trim().min(10).max(200),
  spreadsheetTitle: z.string().trim().max(240).default(''),
  sheetId: z.number().int().nonnegative(),
  sheetName: z.string().trim().min(1).max(200),
  spreadsheetUrl: z.string().trim().max(1000).default(''),
  sortOrder: z.number().int().default(0),
  enabled: z.boolean().default(true),
  scheduleConfig: PostScheduleSheetConfig.optional(),
  recordsConfig: PostRecordsSheetConfig.optional(),
  runtime: GoogleSheetLinkRuntime.default(() => GoogleSheetLinkRuntime.parse({})),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type GoogleSheetLink = z.infer<typeof GoogleSheetLink>;

export const CreateSheetLinkInput = z
  .object({
    kind: GoogleSheetKind,
    title: z.string().trim().min(1).max(120).optional(),
    spreadsheetUrlOrId: z.string().trim().min(10).max(1000),
    sheetName: z.string().trim().min(1).max(200).optional(),
    sheetId: z.number().int().nonnegative().optional(),
    scheduleConfig: PostScheduleSheetConfig.partial().optional(),
    recordsConfig: PostRecordsSheetConfig.partial().optional(),
  })
  .strict();
export type CreateSheetLinkInput = z.infer<typeof CreateSheetLinkInput>;

export const UpdateSheetLinkInput = z
  .object({
    id: Id,
    title: z.string().trim().min(1).max(120).optional(),
    sheetName: z.string().trim().min(1).max(200).optional(),
    sheetId: z.number().int().nonnegative().optional(),
    enabled: z.boolean().optional(),
    scheduleConfig: PostScheduleSheetConfig.partial().optional(),
    recordsConfig: PostRecordsSheetConfig.partial().optional(),
  })
  .strict();
export type UpdateSheetLinkInput = z.infer<typeof UpdateSheetLinkInput>;

export const SheetTabMeta = z.object({
  sheetId: z.number().int().nonnegative(),
  title: z.string(),
  rowCount: z.number().int().nonnegative(),
  columnCount: z.number().int().nonnegative(),
});
export type SheetTabMeta = z.infer<typeof SheetTabMeta>;

export const SpreadsheetMeta = z.object({
  spreadsheetId: z.string(),
  title: z.string(),
  url: z.string(),
  tabs: z.array(SheetTabMeta),
});
export type SpreadsheetMeta = z.infer<typeof SpreadsheetMeta>;

export const SheetGridRow = z.object({
  rowNumber: z.number().int().min(2),
  isHintRow: z.boolean(),
  values: z.array(z.string()),
  displayValues: z.array(z.string()),
});
export type SheetGridRow = z.infer<typeof SheetGridRow>;

export const SheetGridSnapshot = z.object({
  linkId: Id,
  spreadsheetId: z.string(),
  spreadsheetTitle: z.string(),
  sheetName: z.string(),
  headers: z.array(z.string()),
  rows: z.array(SheetGridRow),
  fetchedAt: z.number(),
  totalRows: z.number().int().nonnegative(),
});
export type SheetGridSnapshot = z.infer<typeof SheetGridSnapshot>;

export const SheetSyncLogEntry = z.object({
  id: Id,
  linkId: z.string().nullable(),
  level: z.enum(['info', 'warn', 'error']),
  action: z.string(),
  summary: z.string(),
  createdAt: z.number(),
});
export type SheetSyncLogEntry = z.infer<typeof SheetSyncLogEntry>;

export const GoogleSheetsActiveProfile = z.object({
  profileId: z.string(),
  linkId: z.string(),
  kind: z.enum(['post_schedule', 'post_records', 'metrics']),
  title: z.string(),
  status: z.string(),
});
export type GoogleSheetsActiveProfile = z.infer<typeof GoogleSheetsActiveProfile>;

export const GoogleSheetsOverview = z.object({
  auth: GoogleAuthStatus,
  imageHost: SheetImageHostStatus,
  links: z.array(GoogleSheetLink),
  logs: z.array(SheetSyncLogEntry),
  runningScheduleCount: z.number().int().nonnegative(),
  runningRecordsCount: z.number().int().nonnegative(),
  activeProfiles: z.array(GoogleSheetsActiveProfile).default([]),
});
export type GoogleSheetsOverview = z.infer<typeof GoogleSheetsOverview>;

export const LibraryImportMode = z.enum(['incremental', 'overwrite']);
export type LibraryImportMode = z.infer<typeof LibraryImportMode>;

export interface LibrarySyncSummary {
  direction: 'sheet_to_local' | 'local_to_sheet';
  mode: LibraryImportMode | 'diff';
  added: number;
  updated: number;
  deleted: number;
  skipped: number;
  foldersCreated: number;
  avatarsUploaded: number;
  metadataRefreshTriggered: boolean;
  summary: string;
}

export function parseGoogleSpreadsheetUrl(
  raw: string,
): { spreadsheetId: string; gid: number | null } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const idOnly = /^[A-Za-z0-9_-]{20,120}$/.exec(trimmed);
  if (idOnly) {
    return { spreadsheetId: trimmed, gid: null };
  }
  try {
    const u = new URL(trimmed);
    const match = /\/spreadsheets\/d\/([A-Za-z0-9_-]{10,120})/i.exec(u.pathname);
    if (!match?.[1]) return null;
    const gidParam = u.searchParams.get('gid') ?? /(?:^|[#&])gid=(\d+)/.exec(u.hash)?.[1] ?? null;
    const gid = gidParam && /^\d+$/.test(gidParam) ? Number(gidParam) : null;
    return { spreadsheetId: match[1], gid };
  } catch {
    return null;
  }
}

export function columnIndexToA1(index: number): string {
  let n = Math.max(0, Math.floor(index));
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

export function normalizeHeaderKey(header: string): string {
  return header
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（(].*?[)）]/g, '')
    .trim()
    .toLowerCase();
}

export function buildHeaderMap(headers: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  headers.forEach((raw, idx) => {
    const exact = raw.trim();
    if (exact && !map.has(exact)) map.set(exact, idx);
    const normalized = normalizeHeaderKey(raw);
    if (normalized && !map.has(normalized)) map.set(normalized, idx);
  });
  return map;
}

export function findHeaderColumn(headers: readonly string[], aliases: readonly string[]): number {
  const map = buildHeaderMap(headers);
  for (const alias of aliases) {
    const direct = map.get(alias.trim());
    if (direct !== undefined) return direct;
    const norm = map.get(normalizeHeaderKey(alias));
    if (norm !== undefined) return norm;
  }
  return -1;
}

export function resolveGroupLibraryColumns(headers: readonly string[]) {
  return {
    category: findHeaderColumn(headers, ['类别', '類別', '分组', '分組', '小组类别', '社团类别']),
    id: findHeaderColumn(headers, ['小组id', '小組id', '小组ID', '社团id', 'group_id', 'id']),
    name: findHeaderColumn(headers, [
      '小组名字',
      '小組名字',
      '小组名称',
      '小組名稱',
      '名称',
      'name',
    ]),
    avatar: findHeaderColumn(headers, ['小组头像', '小組頭像', '头像', '頭像', 'avatar']),
  };
}

export function resolvePageLibraryColumns(headers: readonly string[]) {
  return {
    category: findHeaderColumn(headers, ['类别', '類別', '分组', '分組', '专页类别', '專頁類別']),
    id: findHeaderColumn(headers, ['专页id', '專頁id', '专页ID', 'page_id', 'id']),
    name: findHeaderColumn(headers, [
      '专页名字',
      '專頁名字',
      '专页名称',
      '專頁名稱',
      '名称',
      'name',
    ]),
    avatar: findHeaderColumn(headers, ['专页头像', '專頁頭像', '头像', '頭像', 'avatar']),
  };
}

export function resolveScheduleColumns(headers: readonly string[]) {
  return {
    pageId: findHeaderColumn(headers, ['发帖专页', '發帖專頁', '专页id', '专页', 'page_id']),
    date: findHeaderColumn(headers, ['发帖日期', '發帖日期', '日期', 'date']),
    time: findHeaderColumn(headers, ['发帖时间', '發帖時間', '时间', 'time']),
    caption: findHeaderColumn(headers, ['发帖文案', '發帖文案', '文案', '引导语', 'caption']),
    media: findHeaderColumn(headers, ['发帖素材', '發帖素材', '素材', '媒体', '网盘链接', 'media']),
    aiLabel: findHeaderColumn(headers, ['开启ai声明', '開啟ai聲明', 'ai声明', 'AI声明', 'ai']),
    postTimeline: findHeaderColumn(headers, ['是否发时间线', '是否發時間線', '发时间线', '时间线']),
    groupsSpec: findHeaderColumn(headers, ['发多少小组', '發多少小組', '目标小组', '小组数']),
    groupCategory: findHeaderColumn(headers, ['小组类别', '小組類別', '抽群类别', '类别']),
    thumbnail: findHeaderColumn(headers, ['缩略图', '縮略圖', '贴文缩略图', 'thumbnail']),
    resourceCode: findHeaderColumn(headers, ['资源编号', '資源編號', '素材编号']),
    status: findHeaderColumn(headers, ['发布状态', '發布狀態', '状态', '狀態', 'status']),
    postedGroupsCount: findHeaderColumn(headers, [
      '已发小组数量',
      '已發小組數量',
      '已发数量',
      '已发小组数',
    ]),
  };
}

export function resolveRecordColumns(headers: readonly string[], machineName?: string) {
  return {
    postedAt: findHeaderColumn(headers, ['发帖日期', '發帖日期', '发帖时间', '日期']),
    groupId: findHeaderColumn(headers, ['小组id', '小組id', '小组ID', 'group_id']),
    groupName: findHeaderColumn(headers, ['小组名字', '小組名字', '小组名称']),
    pageId: findHeaderColumn(headers, ['专页id', '專頁id', '专页ID', 'page_id']),
    pageName: findHeaderColumn(headers, ['专页名字', '專頁名字', '专页名称']),
    postUrl: findHeaderColumn(headers, ['贴文链接', '貼文連結', '链接', 'post_url', 'url']),
    groupAvatar: findHeaderColumn(headers, ['小组头像', '小組頭像']),
    pageAvatar: findHeaderColumn(headers, ['专页头像', '專頁頭像']),
    postCode: findHeaderColumn(headers, ['贴文编号', '貼文編號', '编号', 'post_code']),
    thumbnail: findHeaderColumn(headers, ['缩略图', '縮略圖', '贴文缩略图']),
    likes: findHeaderColumn(headers, ['点赞', '點讚', '赞', 'likes']),
    comments: findHeaderColumn(headers, ['留言', '评论', '評論', 'comments']),
    machineColumn: machineName ? findHeaderColumn(headers, [machineName]) : -1,
  };
}

const TEMPLATE_HINT_TOKEN_RE =
  /^[（(].{1,80}[)）]$|填id|填网盘链接|填網盤連結|填数字随机发|填數字隨機發|软件生成|軟體生成|软件负责填|軟體負責填|日期-素材随机码|日期-素材隨機碼|是\/否/i;

export function isTemplateHintRow(values: readonly string[]): boolean {
  const nonEmpty = values.map((v) => v.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return false;
  let hintHits = 0;
  for (const cell of nonEmpty) {
    if (TEMPLATE_HINT_TOKEN_RE.test(cell)) hintHits++;
  }
  return hintHits >= 2 || (nonEmpty.length === 1 && TEMPLATE_HINT_TOKEN_RE.test(nonEmpty[0] ?? ''));
}

export function extractImageUrlFromCell(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const formulaMatch = /^=\s*IMAGE\s*\(\s*"(https?:\/\/[^"]+)"/i.exec(trimmed);
  if (formulaMatch?.[1]) return formulaMatch[1].trim();
  if (/^https?:\/\/\S+$/i.test(trimmed)) return trimmed;
  if (
    /^data:image\/(?:webp|jpeg|png|gif|svg\+xml)(?:;charset=[^;,]+)?(?:;base64|;utf8)?,/i.test(
      trimmed,
    )
  ) {
    return trimmed;
  }
  return null;
}

export function toSheetsImageFormula(url: string): string {
  const safe = url.trim().replace(/"/g, '%22');
  return `=IMAGE("${safe}")`;
}

export function extractFacebookTargetId(raw: string, kind: 'group' | 'page'): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (kind === 'group') return extractFacebookGroupId(trimmed);
  return extractFacebookPageId(trimmed);
}

export type ParsedGroupsSpec =
  | { mode: 'none' }
  | { mode: 'random'; count: number; category: string | null }
  | { mode: 'explicit'; groupIds: string[] };

export function parseGroupsSpec(
  raw: string | null | undefined,
  extraCategory?: string | null,
): ParsedGroupsSpec {
  const trimmed = (raw ?? '').trim();
  const fallbackCat = extraCategory?.trim() ? extraCategory.trim() : null;
  if (!trimmed || /^(?:0|否|无|無|不发|不發|none|no|false|-)$/i.test(trimmed)) {
    return { mode: 'none' };
  }
  // Pure small integer -> random N groups (1..500); long digit sequence (>= 5 digits) is a Facebook Group ID!
  if (/^\d{1,3}$/.test(trimmed)) {
    const count = Number(trimmed);
    return count > 0 ? { mode: 'random', count, category: fallbackCat } : { mode: 'none' };
  }
  // Shorthand "经文群:5" or "经文群：5"
  const catCountMatch = /^([^:：\r\n,，]+?)\s*[:：]\s*(\d{1,3})$/.exec(trimmed);
  if (catCountMatch?.[1] && catCountMatch[2]) {
    const count = Number(catCountMatch[2]);
    const category = catCountMatch[1].trim();
    if (count > 0 && category) {
      return { mode: 'random', count, category };
    }
    return { mode: 'none' };
  }
  // Explicit Group IDs / URLs separated by commas, Chinese commas, semicolons, newlines, or whitespace
  const tokens = trimmed
    .split(/[\r\n,，;；\s]+/)
    .map((part) => extractFacebookGroupId(part))
    .filter((id) => id.length > 0);
  const unique = [...new Set(tokens)];
  if (unique.length === 0) return { mode: 'none' };
  return { mode: 'explicit', groupIds: unique };
}

export function parseBooleanCell(raw: string | null | undefined): boolean {
  const trimmed = (raw ?? '').trim().toLowerCase();
  return /^(?:是|yes|true|1|y|开启|開啟|开|開|✓|✔)$/.test(trimmed);
}

export function parseAiLabelCell(raw: string | null | undefined): 'default' | 'on' | 'off' {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (!trimmed) return 'default';
  if (/^(?:是|yes|true|1|y|开启|開啟|开|開|✓|✔)$/.test(trimmed)) return 'on';
  if (/^(?:否|no|false|0|n|关闭|關閉|关|關|×|✗)$/.test(trimmed)) return 'off';
  return 'default';
}

function buildWallClockMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone?: string,
): number | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }
  // Verify exact calendar date (reject JS rollover like Feb 30 -> Mar 2)
  const checkUtc = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  if (
    checkUtc.getUTCFullYear() !== year ||
    checkUtc.getUTCMonth() !== month - 1 ||
    checkUtc.getUTCDate() !== day
  ) {
    return null;
  }
  if (!timeZone) {
    const ms = new Date(year, month - 1, day, hour, minute, second, 0).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  try {
    const targetUtcGuess = Date.UTC(year, month - 1, day, hour, minute, second, 0);
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const toZonedAsUtcMs = (ms: number): number => {
      const parts = fmt.formatToParts(new Date(ms));
      const num = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
      const h = num('hour') % 24;
      return Date.UTC(num('year'), num('month') - 1, num('day'), h, num('minute'), num('second'));
    };
    const offset1 = toZonedAsUtcMs(targetUtcGuess) - targetUtcGuess;
    const candidate = targetUtcGuess - offset1;
    const offset2 = toZonedAsUtcMs(candidate) - candidate;
    const resolved = targetUtcGuess - offset2;
    return Number.isFinite(resolved) ? resolved : null;
  } catch {
    const ms = new Date(year, month - 1, day, hour, minute, second, 0).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
}

export function parseScheduleDateTimeMs(
  dateCell: string,
  timeCell: string,
  timeZone?: string,
): number | null {
  const d = dateCell.trim();
  const t = timeCell.trim();
  if (!d) return null;

  const applyTimeString = (
    rawTime: string,
    baseHour: number,
    baseMinute: number,
    baseSecond: number,
  ): { hour: number; minute: number; second: number; dayCarry: number } | null => {
    const trimmed = rawTime.trim();
    if (!trimmed) return { hour: baseHour, minute: baseMinute, second: baseSecond, dayCarry: 0 };
    // Normalize full-width Chinese colons/spaces & "14点30分" / "下午2点" style strings
    const normalized = trimmed
      .replace(/[：]/g, ':')
      .replace(
        /(\d{1,2})\s*[点點时時]\s*(\d{1,2})\s*(?:分(?:\s*(\d{1,2})\s*秒?)?)?/g,
        (_, h, m, s) => (s ? `${h}:${m}:${s}` : `${h}:${m}`),
      )
      .replace(/(\d{1,2})\s*[点點时時]\s*(?:整)?$/g, '$1:00')
      .trim();
    const zhMatch =
      /^(上午|早上|凌晨|中午|下午|晚上)?\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(am|pm|上午|下午)?$/i.exec(
        normalized,
      );
    if (zhMatch && zhMatch[2] !== undefined && zhMatch[3] !== undefined) {
      let hour = Number(zhMatch[2]);
      const minute = Number(zhMatch[3]);
      const second = zhMatch[4] !== undefined ? Number(zhMatch[4]) : 0;
      const period = (zhMatch[1] || zhMatch[5] || '').toLowerCase();
      if ((period === 'pm' || period === '下午' || period === '晚上') && hour < 12) {
        hour += 12;
      } else if ((period === 'am' || period === '上午' || period === '凌晨') && hour === 12) {
        hour = 0;
      }
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
        return null;
      }
      return { hour, minute, second, dayCarry: 0 };
    }
    if (/^0?\.\d+$/.test(normalized)) {
      const totalSec = Math.round(Number(normalized) * 86400);
      const dayCarry = Math.floor(totalSec / 86400);
      const remSec = totalSec % 86400;
      return {
        hour: Math.floor(remSec / 3600),
        minute: Math.floor((remSec % 3600) / 60),
        second: remSec % 60,
        dayCarry,
      };
    }
    // Never silently coerce unparseable non-empty time strings to 00:00:00!
    return null;
  };

  // Support Google Sheets numeric serial dates (days since 1899-12-30)
  if (/^\d{5}(?:\.\d+)?$/.test(d)) {
    const serial = Number(d);
    const wholeDays = Math.floor(serial);
    const fracDay = serial - wholeDays;
    const serialSec = Math.round(fracDay * 86400);
    const serialDayCarry = Math.floor(serialSec / 86400);
    const remSec = serialSec % 86400;
    const timeRes = applyTimeString(
      t,
      Math.floor(remSec / 3600),
      Math.floor((remSec % 3600) / 60),
      remSec % 60,
    );
    if (!timeRes) return null;
    const baseUtc = new Date(
      Date.UTC(1899, 11, 30 + wholeDays + serialDayCarry + timeRes.dayCarry),
    );
    return buildWallClockMs(
      baseUtc.getUTCFullYear(),
      baseUtc.getUTCMonth() + 1,
      baseUtc.getUTCDate(),
      timeRes.hour,
      timeRes.minute,
      timeRes.second,
      timeZone,
    );
  }

  // Handle "2026-11-20", "2026/11/20", "2026年11月20日", with optional inline time
  const combinedMatch =
    /^(\d{4})(?:[-/.]|年)(\d{1,2})(?:[-/.]|月)(\d{1,2})日?(?:[T\s]+(.+))?$/.exec(d);
  if (combinedMatch) {
    const year = Number(combinedMatch[1]);
    const month = Number(combinedMatch[2]);
    const day = Number(combinedMatch[3]);
    const inlineTime = combinedMatch[4]?.trim() ?? '';
    const timeRes = applyTimeString(t || inlineTime, 0, 0, 0);
    if (!timeRes) return null;
    const baseUtc = new Date(Date.UTC(year, month - 1, day + timeRes.dayCarry));
    if (
      timeRes.dayCarry === 0 &&
      (baseUtc.getUTCFullYear() !== year ||
        baseUtc.getUTCMonth() !== month - 1 ||
        baseUtc.getUTCDate() !== day)
    ) {
      return null;
    }
    return buildWallClockMs(
      baseUtc.getUTCFullYear(),
      baseUtc.getUTCMonth() + 1,
      baseUtc.getUTCDate(),
      timeRes.hour,
      timeRes.minute,
      timeRes.second,
      timeZone,
    );
  }

  // Handle US locale "M/D/YYYY" (default Google Sheets locale) with optional inline/separate time
  const usMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(.+))?$/.exec(d);
  if (usMatch) {
    const month = Number(usMatch[1]);
    const day = Number(usMatch[2]);
    const year = Number(usMatch[3]);
    const inlineTime = usMatch[4]?.trim() ?? '';
    const timeRes = applyTimeString(t || inlineTime, 0, 0, 0);
    if (!timeRes) return null;
    const baseUtc = new Date(Date.UTC(year, month - 1, day + timeRes.dayCarry));
    if (
      timeRes.dayCarry === 0 &&
      (baseUtc.getUTCFullYear() !== year ||
        baseUtc.getUTCMonth() !== month - 1 ||
        baseUtc.getUTCDate() !== day)
    ) {
      return null;
    }
    return buildWallClockMs(
      baseUtc.getUTCFullYear(),
      baseUtc.getUTCMonth() + 1,
      baseUtc.getUTCDate(),
      timeRes.hour,
      timeRes.minute,
      timeRes.second,
      timeZone,
    );
  }

  // Fallback for standard parseable strings like "Nov 20, 2026"
  if (t) {
    const parsedTime = applyTimeString(t, 0, 0, 0);
    if (!parsedTime) return null;
    const baseMs = Date.parse(d);
    if (!Number.isFinite(baseMs)) return null;
    const dt = new Date(baseMs);
    return buildWallClockMs(
      dt.getFullYear(),
      dt.getMonth() + 1,
      dt.getDate() + parsedTime.dayCarry,
      parsedTime.hour,
      parsedTime.minute,
      parsedTime.second,
      timeZone,
    );
  }
  const fallback = Date.parse(d);
  return Number.isFinite(fallback) ? fallback : null;
}

export function formatDateTimeForSheet(ms: number): string {
  const dt = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

export function formatDateCompact(ms: number): string {
  const dt = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}`;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomCodeSegment(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)] ?? 'X';
  }
  return out;
}

export function generateResourceCode(dateMs = Date.now(), randomSuffix?: string): string {
  return `${formatDateCompact(dateMs)}-${(randomSuffix ?? randomCodeSegment(6)).toUpperCase()}`;
}

export function generatePostCode(resourceCode: string, randomSuffix?: string): string {
  const base = resourceCode.trim() || generateResourceCode();
  return `${base}-${(randomSuffix ?? randomCodeSegment(4)).toUpperCase()}`;
}

/**
 * Protect 11+ digit pure numeric IDs (Facebook Group/Page/User/Post IDs are 12–19 digits)
 * from Google Sheets `USER_ENTERED` IEEE-754 float parsing & scientific notation (`1.99955E+15`).
 * Leading `'` instructs Sheets to store exact lossless plain text without showing the apostrophe;
 * formulas (`=IMAGE(...)`) and short counters (`1`, `42`, `2/2`) stay untouched.
 */
export function sanitizeSheetCellValue(value: string): string {
  const trimmed = value.trim();
  if (/^\d{11,}$/.test(trimmed)) {
    return `'${trimmed}`;
  }
  return value;
}

export function isScientificNotationCell(raw: string): boolean {
  return /^\s*\d+(?:\.\d+)?e[+-]\d+\s*$/i.test(raw);
}

export interface LibrarySyncRowInput {
  rowNumber: number; // 1-based sheet row (>= 2)
  values: string[];
  displayValues?: string[] | undefined;
  isHintRow: boolean;
}

export interface LocalLibraryItem {
  id: string;
  category: string;
  name: string;
  avatarCellValue: string; // '=IMAGE("...")' or ''
}

export interface LibrarySyncDiffPlan {
  /** Cell-level updates for existing rows (preserving custom user columns!). */
  cellUpdates: Array<{ rowNumber: number; colIndex: number; value: string }>;
  /** Full new rows (sized up to max managed column index + 1) to append. */
  appends: string[][];
  /** 1-based row numbers to delete, sorted strictly descending so bottom-to-top deleteDimension never shifts earlier indices. */
  deleteRowNumbersDesc: number[];
  stats: { updated: number; added: number; deleted: number; unchanged: number };
}

export function computeLibrarySyncDiff(input: {
  sheetRows: readonly LibrarySyncRowInput[];
  localItems: readonly LocalLibraryItem[];
  columns: { category: number; id: number; name: number; avatar: number };
  kind: 'group' | 'page';
}): LibrarySyncDiffPlan {
  const { sheetRows, localItems, columns, kind } = input;
  const localById = new Map<string, LocalLibraryItem>();
  for (const item of localItems) {
    const key = extractFacebookTargetId(item.id, kind).toLowerCase();
    if (key) localById.set(key, item);
  }

  const matchedLocalKeys = new Set<string>();
  const cellUpdates: Array<{ rowNumber: number; colIndex: number; value: string }> = [];
  const deleteRowNumbers: number[] = [];
  let updated = 0;
  let unchanged = 0;

  for (const row of sheetRows) {
    if (row.isHintRow) continue;
    const rawId = columns.id >= 0 ? (row.values[columns.id] ?? '') : '';
    const normalizedId = extractFacebookTargetId(rawId, kind);
    const key = normalizedId.toLowerCase();
    if (!key) {
      // Completely blank row? Skip without deleting user padding unless it has stale data
      continue;
    }
    const local = localById.get(key);
    if (!local || matchedLocalKeys.has(key)) {
      // Extra row (not in software, or duplicate ID in sheet) -> delete!
      deleteRowNumbers.push(row.rowNumber);
      continue;
    }
    matchedLocalKeys.add(key);
    let rowChanged = false;
    const checkCol = (colIndex: number, desired: string) => {
      if (colIndex < 0) return;
      const existing = (row.values[colIndex] ?? '').trim();
      if (existing !== desired.trim()) {
        cellUpdates.push({ rowNumber: row.rowNumber, colIndex, value: desired });
        rowChanged = true;
      }
    };
    checkCol(columns.category, local.category);
    const displayedId = columns.id >= 0 ? (row.displayValues?.[columns.id] ?? '').trim() : '';
    if (columns.id >= 0 && isScientificNotationCell(displayedId)) {
      cellUpdates.push({ rowNumber: row.rowNumber, colIndex: columns.id, value: local.id });
      rowChanged = true;
    } else {
      checkCol(columns.id, local.id);
    }
    checkCol(columns.name, local.name);
    if (local.avatarCellValue) {
      checkCol(columns.avatar, local.avatarCellValue);
    }
    if (rowChanged) updated++;
    else unchanged++;
  }

  const maxCol = Math.max(columns.category, columns.id, columns.name, columns.avatar, 0);
  const appends: string[][] = [];
  for (const item of localItems) {
    const key = extractFacebookTargetId(item.id, kind).toLowerCase();
    if (!key || matchedLocalKeys.has(key)) continue;
    const cells = new Array<string>(maxCol + 1).fill('');
    if (columns.category >= 0) cells[columns.category] = item.category;
    if (columns.id >= 0) cells[columns.id] = item.id;
    if (columns.name >= 0) cells[columns.name] = item.name;
    if (columns.avatar >= 0) cells[columns.avatar] = item.avatarCellValue;
    appends.push(cells);
  }

  deleteRowNumbers.sort((a, b) => b - a);
  return {
    cellUpdates,
    appends,
    deleteRowNumbersDesc: deleteRowNumbers,
    stats: {
      updated,
      added: appends.length,
      deleted: deleteRowNumbers.length,
      unchanged,
    },
  };
}

export function evaluateMetricsEligibility(
  postedAtMs: number | null,
  metricsStage: number,
  nowMs = Date.now(),
): '24h' | '72h' | null {
  if (!postedAtMs || !Number.isFinite(postedAtMs) || postedAtMs <= 0) return null;
  const ageHours = (nowMs - postedAtMs) / 3_600_000;
  if (metricsStage <= 0 && ageHours >= 24) return '24h';
  if (metricsStage === 1 && ageHours >= 72) return '72h';
  return null;
}

export function nextTieredPollingState(input: {
  currentMode: SheetPollingMode;
  consecutiveIdlePolls: number;
  hasNewActivity: boolean;
  activePollMinutes: number;
  semiActivePollMinutes: number;
  semiActiveAfterIdlePolls: number;
  nowMs?: number;
}): {
  pollingMode: SheetPollingMode;
  consecutiveIdlePolls: number;
  nextPollAt: number;
} {
  const now = input.nowMs ?? Date.now();
  const activeMs = Math.max(1, input.activePollMinutes) * 60_000;
  const semiActiveMs = Math.max(2, input.semiActivePollMinutes) * 60_000;
  if (input.hasNewActivity) {
    return {
      pollingMode: 'active',
      consecutiveIdlePolls: 0,
      nextPollAt: now + activeMs,
    };
  }
  const nextIdle = input.consecutiveIdlePolls + 1;
  if (
    input.currentMode === 'semi_active' ||
    nextIdle >= Math.max(1, input.semiActiveAfterIdlePolls)
  ) {
    return {
      pollingMode: 'semi_active',
      consecutiveIdlePolls: nextIdle,
      nextPollAt: now + semiActiveMs,
    };
  }
  return {
    pollingMode: 'active',
    consecutiveIdlePolls: nextIdle,
    nextPollAt: now + activeMs,
  };
}

export function extractFacebookPostIdFromUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl.trim());
    const m1 = /\/(?:posts|permalink)\/(\d{1,30})/i.exec(u.pathname);
    if (m1?.[1]) return m1[1];
    const m2 = /\/(?:videos|reel|reels|watch)\/(\d{1,30})/i.exec(u.pathname);
    if (m2?.[1]) return m2[1];
    const queryId =
      u.searchParams.get('story_fbid') ??
      u.searchParams.get('fbid') ??
      (/^\/watch\/?$/i.test(u.pathname) ? u.searchParams.get('v') : null);
    if (queryId && /^(?:\d{1,30}|pfbid[A-Za-z0-9]+)$/i.test(queryId)) return queryId;
    const pfbid = /\/(?:posts|permalink)\/(pfbid[A-Za-z0-9]+)/i.exec(u.pathname);
    if (pfbid?.[1]) return pfbid[1];
    return null;
  } catch {
    return null;
  }
}

export function isDirectFacebookPostUrl(rawUrl: string | null | undefined): boolean {
  if (!rawUrl) return false;
  const trimmed = rawUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    const u = new URL(trimmed);
    const host = u.hostname.toLowerCase();
    const isFbHost =
      host === 'facebook.com' ||
      host.endsWith('.facebook.com') ||
      host === 'fb.com' ||
      host.endsWith('.fb.com') ||
      host === 'fb.watch';
    if (!isFbHost) return false;
    if (/^\/(?:login|checkpoint|recover|home\.php|me)(?:\/|$)/i.test(u.pathname)) {
      return false;
    }
    if (host === 'fb.watch' && /^\/[A-Za-z0-9_-]{4,}\/?$/.test(u.pathname)) {
      return true;
    }
    if (/^\/share\/[pvr]\/[A-Za-z0-9_-]{4,}\/?$/i.test(u.pathname)) {
      return true;
    }
    return extractFacebookPostIdFromUrl(trimmed) !== null;
  } catch {
    return false;
  }
}

export function inferBumperSourceMode(input: {
  groupId?: string | null | undefined;
  postUrl?: string | null | undefined;
}): 'group' | 'page' {
  const url = (input.postUrl ?? '').trim();
  if (url && /\/groups\/[^/]+\//i.test(url)) return 'group';
  const gid = (input.groupId ?? '').trim();
  if (!gid || gid === '-' || gid === '__page_timeline__') return 'page';
  return 'group';
}

export function extractGroupIdFromPostUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl.trim());
    const m = /^\/groups\/([^/]+)\//i.exec(u.pathname);
    return m?.[1] ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}
