import { z } from 'zod';
import {
  Id,
  NonNegInt,
  NumNull,
  StrNull,
  boolF,
  boolT,
  intRange,
  optBool,
  strictObj,
  trimMax,
  trimReq,
} from './contracts.js';
import { BumperSettings } from './group-bumper.js';
import { extractFacebookGroupId } from './facebook-target-id.js';
export * from './google-sheets-metrics.js';
export const GoogleSheetKind = z.enum([
  'group_library',
  'page_library',
  'post_schedule',
  'post_records',
]);
export type GoogleSheetKind = z.infer<typeof GoogleSheetKind>;
export const PAGE_TIMELINE_SYNTHETIC_GROUP_ID = '__page_timeline__';
export const UNGROUPED_BUCKET_ID = 'ungrouped';
export const includesUngroupedBucket = (
  groupIds: readonly string[],
  includeUngrouped?: boolean,
): boolean => Boolean(includeUngrouped) || groupIds.includes(UNGROUPED_BUCKET_ID);
export const resolveEffectiveInstanceIds = (
  primary?: readonly string[],
  alias?: readonly string[],
): string[] => [...new Set([...(primary ?? []), ...(alias ?? [])])];
export const SheetImageHostPreference = z.enum(['auto', 'gyazo', 'drive']);
export type SheetImageHostPreference = z.infer<typeof SheetImageHostPreference>;
const StrArr = z.array(trimReq(120));
export const SheetImageHostConfig = strictObj({
  preferredHost: SheetImageHostPreference.default('auto'),
  gyazoAccessToken: trimMax(512).default(''),
  gyazoAccessTokens: z.array(trimReq(512)).max(50).default([]),
  driveFolderId: trimMax(256).nullable().default(null),
  defaultMachineName: trimReq(60).default('电脑1号'),
});
export type SheetImageHostConfig = z.infer<typeof SheetImageHostConfig>;
export const SaveSheetImageHostInput = strictObj({
  preferredHost: SheetImageHostPreference.optional(),
  gyazoAccessToken: trimMax(512).optional(),
  gyazoAccessTokens: z.array(trimMax(512)).max(50).optional(),
  clearGyazoToken: optBool,
  defaultMachineName: trimReq(60).optional(),
});
export type SaveSheetImageHostInput = z.infer<typeof SaveSheetImageHostInput>;
export const GoogleAuthStatus = z.object({
  hasCredentials: z.boolean(),
  clientIdHint: StrNull,
  authorized: z.boolean(),
  authorizedEmail: StrNull,
  scopes: z.array(z.string()),
  pendingAuthUrl: StrNull,
  pendingAuthStartedAt: NumNull,
  lastError: StrNull,
});
export type GoogleAuthStatus = z.infer<typeof GoogleAuthStatus>;
export const SheetImageHostStatus = z.object({
  preferredHost: SheetImageHostPreference,
  hasGyazoToken: z.boolean(),
  gyazoTokenPreview: StrNull,
  gyazoTokenCount: NonNegInt.default(0),
  gyazoTokenPreviews: z.array(z.string()).default([]),
  driveFolderId: StrNull,
  defaultMachineName: z.string(),
  cachedImageCount: NonNegInt,
});
export type SheetImageHostStatus = z.infer<typeof SheetImageHostStatus>;
export function parseGyazoTokenList(raw: string | readonly string[]): string[] {
  const out = new Set<string>();
  for (const part of (Array.isArray(raw) ? raw : [raw]).flatMap((e) =>
    String(e).split(/[\r\n,;，；\s]+/),
  )) {
    const t = part.trim();
    if (t && t.length <= 512 && out.size < 50) out.add(t);
  }
  return [...out];
}
export const resolveEffectiveGyazoTokens = (config: {
  gyazoAccessToken?: string;
  gyazoAccessTokens?: readonly string[];
}): string[] =>
  parseGyazoTokenList([
    ...(Array.isArray(config.gyazoAccessTokens) ? config.gyazoAccessTokens : []),
    ...(typeof config.gyazoAccessToken === 'string' && config.gyazoAccessToken.trim()
      ? [config.gyazoAccessToken]
      : []),
  ]);
export function maskGyazoToken(token: string): string | null {
  const t = token.trim();
  return !t ? null : t.length <= 10 ? '••••••' : `${t.slice(0, 4)}••••${t.slice(-4)}`;
}
export const ScheduleExecutionCarrier = z.enum(['browser', 'bluestacks', 'auto']);
export type ScheduleExecutionCarrier = z.infer<typeof ScheduleExecutionCarrier>;
export const PostScheduleSheetConfig = strictObj({
  enabled: boolF,
  pollIntervalMinutes: intRange(1, 60).default(2),
  targetRecordLinkId: trimMax(120).nullable().default(null),
  autoWakeBumper: boolT,
  executionCarrier: ScheduleExecutionCarrier.default('browser'),
  bluestacksFolderIds: StrArr.max(100).default([]),
  bluestacksInstanceIds: StrArr.max(500).default([]),
  selectedInstanceIds: StrArr.max(500).optional(),
  includeUngrouped: optBool,
  closeBluestacksOnFinish: boolT,
});
export type PostScheduleSheetConfig = z.infer<typeof PostScheduleSheetConfig>;
export const PostRecordsSheetConfig = strictObj({
  enabled: boolF,
  machineName: trimReq(60).default('电脑1号'),
  bumperProfileGroupIds: StrArr.max(100).default([]),
  bumperProfileIds: StrArr.max(500).default([]),
  bumperBluestacksFolderIds: StrArr.max(100).default([]),
  bumperBluestacksIds: StrArr.max(500).default([]),
  selectedInstanceIds: StrArr.max(500).optional(),
  includeUngrouped: optBool,
  bumperSettings: BumperSettings.default(() => BumperSettings.parse({})),
  commentPool: z.array(trimReq(1000)).max(2000).default([]),
  collectMetricsOnThisPc: boolF,
  activePollMinutes: intRange(1, 30).default(2),
  semiActivePollMinutes: intRange(2, 120).default(10),
  semiActiveAfterIdlePolls: intRange(1, 30).default(5),
});
export type PostRecordsSheetConfig = z.infer<typeof PostRecordsSheetConfig>;
export const sheetScheduleRetryFields = {
  attemptCount: NonNegInt.optional(),
  nextRetryAt: NumNull.optional(),
  lastError: StrNull.optional(),
};
export const SheetScheduleRetryMeta = z.object(sheetScheduleRetryFields);
export type SheetScheduleRetryMeta = z.infer<typeof SheetScheduleRetryMeta>;
export const SheetPollingModeSchema = z.enum(['idle', 'active', 'semi_active']);
export const GoogleSheetLinkRuntime = z.object({
  lastSyncedAt: NumNull.default(null),
  lastSyncSummary: z.string().default(''),
  lastError: StrNull.default(null),
  attemptCount: NonNegInt.optional(),
  nextRetryAt: NumNull.optional(),
  pollingMode: SheetPollingModeSchema.default('idle'),
  consecutiveIdlePolls: NonNegInt.default(0),
  nextPollAt: NumNull.default(null),
  activeJobText: z.string().default(''),
  activeRunningCount: NonNegInt.default(0),
  totalRowCount: NonNegInt.default(0),
  lastMetricsRunAt: NumNull.default(null),
});
export type GoogleSheetLinkRuntime = z.infer<typeof GoogleSheetLinkRuntime>;
export const GoogleSheetLink = z.object({
  id: Id,
  kind: GoogleSheetKind,
  title: trimReq(120),
  spreadsheetId: trimReq(200, 10),
  spreadsheetTitle: trimMax(240).default(''),
  sheetId: NonNegInt,
  sheetName: trimReq(200),
  spreadsheetUrl: trimMax(1000).default(''),
  sortOrder: z.number().int().default(0),
  enabled: boolT,
  scheduleConfig: PostScheduleSheetConfig.optional(),
  recordsConfig: PostRecordsSheetConfig.optional(),
  runtime: GoogleSheetLinkRuntime.default(() => GoogleSheetLinkRuntime.parse({})),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type GoogleSheetLink = z.infer<typeof GoogleSheetLink>;
const sheetConfigFields = {
  sheetName: trimReq(200).optional(),
  sheetId: NonNegInt.optional(),
  scheduleConfig: PostScheduleSheetConfig.partial().optional(),
  recordsConfig: PostRecordsSheetConfig.partial().optional(),
};
export const CreateSheetLinkInput = strictObj({
  kind: GoogleSheetKind,
  title: trimReq(120).optional(),
  spreadsheetUrlOrId: trimReq(1000, 10),
  ...sheetConfigFields,
});
export type CreateSheetLinkInput = z.infer<typeof CreateSheetLinkInput>;
export const UpdateSheetLinkInput = strictObj({
  id: Id,
  title: trimReq(120).optional(),
  enabled: optBool,
  ...sheetConfigFields,
});
export type UpdateSheetLinkInput = z.infer<typeof UpdateSheetLinkInput>;
const tabSchema = z.object({
  sheetId: NonNegInt,
  title: z.string(),
  rowCount: NonNegInt,
  columnCount: NonNegInt,
});
export const SpreadsheetMeta = z.object({
  spreadsheetId: z.string(),
  title: z.string(),
  url: z.string(),
  tabs: z.array(tabSchema),
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
  totalRows: NonNegInt,
});
export type SheetGridSnapshot = z.infer<typeof SheetGridSnapshot>;
export const SheetSyncLogEntry = z.object({
  id: Id,
  linkId: StrNull,
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
  runningScheduleCount: NonNegInt,
  runningRecordsCount: NonNegInt,
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
export function parseGoogleSpreadsheetUrl(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[A-Za-z0-9_-]{20,120}$/.test(trimmed)) return { spreadsheetId: trimmed, gid: null };
  try {
    const u = new URL(trimmed),
      match = /\/spreadsheets\/d\/([A-Za-z0-9_-]{10,120})/i.exec(u.pathname),
      gidParam = u.searchParams.get('gid') ?? /(?:^|[#&])gid=(\d+)/.exec(u.hash)?.[1] ?? null;
    return match?.[1]
      ? {
          spreadsheetId: match[1],
          gid: gidParam && /^\d+$/.test(gidParam) ? Number(gidParam) : null,
        }
      : null;
  } catch {
    return null;
  }
}
export function columnIndexToA1(index: number): string {
  let n = Math.max(0, Math.floor(index)),
    out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}
export const normalizeHeaderKey = (header: string): string =>
  header
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（(].*?[)）]/g, '')
    .trim()
    .toLowerCase();
function lookupCol(map: Map<string, number>, aliases: readonly string[]): number {
  for (const alias of aliases) {
    const hit = map.get(alias.trim()) ?? map.get(normalizeHeaderKey(alias));
    if (hit !== undefined) return hit;
  }
  return -1;
}
function findCols<K extends string>(
  headers: readonly string[],
  spec: Record<K, string>,
): Record<K, number> {
  const map = new Map<string, number>();
  headers.forEach((raw, idx) => {
    const exact = raw.trim(),
      norm = normalizeHeaderKey(raw);
    if (exact && !map.has(exact)) map.set(exact, idx);
    if (norm && !map.has(norm)) map.set(norm, idx);
  });
  const out = {} as Record<K, number>;
  for (const key of Object.keys(spec) as K[]) out[key] = lookupCol(map, spec[key].split('|'));
  return out;
}
const resolveLibraryColumns = (headers: readonly string[], kind: 'group' | 'page') =>
  findCols(
    headers,
    kind === 'group'
      ? {
          category: '类别|類別|分组|分組|小组类别|社团类别',
          id: '小组id|小組id|小组ID|社团id|group_id|id',
          name: '小组名字|小組名字|小组名称|小組名稱|名称|name',
          avatar: '小组头像|小組頭像|头像|頭像|avatar',
        }
      : {
          category: '类别|類別|分组|分組|专页类别|專頁類別',
          id: '专页id|專頁id|专页ID|page_id|id',
          name: '专页名字|專頁名字|专页名称|專頁名稱|名称|name',
          avatar: '专页头像|專頁頭像|头像|頭像|avatar',
        },
  );
export const resolveGroupLibraryColumns = (headers: readonly string[]) =>
  resolveLibraryColumns(headers, 'group');
export const resolvePageLibraryColumns = (headers: readonly string[]) =>
  resolveLibraryColumns(headers, 'page');
export const resolveScheduleColumns = (headers: readonly string[]) =>
  findCols(headers, {
    pageId: '发帖专页|發帖專頁|专页id|专页|page_id',
    date: '发帖日期|發帖日期|日期|date',
    time: '发帖时间|發帖時間|时间|time',
    caption: '发帖文案|發帖文案|文案|引导语|caption',
    media: '发帖素材|發帖素材|素材|媒体|网盘链接|media',
    aiLabel: '开启ai声明|開啟ai聲明|ai声明|AI声明|ai',
    postTimeline: '是否发时间线|是否發時間線|发时间线|时间线',
    groupsSpec: '发多少小组|發多少小組|目标小组|小组数',
    groupCategory: '小组类别|小組類別|抽群类别|类别',
    thumbnail: '缩略图|縮略圖|贴文缩略图|thumbnail',
    resourceCode: '资源编号|資源編號|素材编号',
    status: '发布状态|發布狀態|状态|狀態|status',
    postedGroupsCount: '已发小组数量|已發小組數量|已发数量|已发小组数',
  });
export const resolveRecordColumns = (headers: readonly string[], machineName?: string) =>
  findCols(headers, {
    postedAt: '发帖日期|發帖日期|发帖时间|日期',
    groupId: '小组id|小組id|小组ID|group_id',
    groupName: '小组名字|小組名字|小组名称',
    pageId: '专页id|專頁id|专页ID|page_id',
    pageName: '专页名字|專頁名字|专页名称',
    postUrl: '贴文链接|貼文連結|链接|post_url|url',
    groupAvatar: '小组头像|小組頭像',
    pageAvatar: '专页头像|專頁頭像',
    postCode: '贴文编号|貼文編號|编号|post_code',
    thumbnail: '缩略图|縮略圖|贴文缩略图',
    likes: '点赞|點讚|赞|likes',
    comments: '留言|评论|評論|comments',
    machineColumn: machineName ?? '',
  });
const TEMPLATE_HINT_TOKEN_RE =
  /^[（(].{1,80}[)）]$|填id|填网盘链接|填網盤連結|填数字随机发|填數字隨機發|软件生成|軟體生成|软件负责填|軟體負責填|日期-素材随机码|日期-素材隨機碼|是\/否/i;
export function isTemplateHintRow(values: readonly string[]): boolean {
  const nonEmpty = values.map((v) => v.trim()).filter(Boolean);
  if (!nonEmpty.length) return false;
  const hintHits = nonEmpty.filter((cell) => TEMPLATE_HINT_TOKEN_RE.test(cell)).length;
  return hintHits >= 2 || (nonEmpty.length === 1 && TEMPLATE_HINT_TOKEN_RE.test(nonEmpty[0] ?? ''));
}
export function extractImageUrlFromCell(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const formulaMatch = /^=\s*IMAGE\s*\(\s*"(https?:\/\/[^"]+)"/i.exec(trimmed);
  if (formulaMatch?.[1]) return formulaMatch[1].trim();
  if (/^https?:\/\/\S+$/i.test(trimmed)) return trimmed;
  return /^data:image\/(?:webp|jpeg|png|gif|svg\+xml)(?:;charset=[^;,]+)?(?:;base64|;utf8)?,/i.test(
    trimmed,
  )
    ? trimmed
    : null;
}
export const toSheetsImageFormula = (url: string) => `=IMAGE("${url.trim().replace(/"/g, '%22')}")`;
type ParsedGroupsSpec =
  | { mode: 'none' }
  | { mode: 'random'; count: number; category: string | null }
  | { mode: 'explicit'; groupIds: string[] };
export function parseGroupsSpec(
  raw: string | null | undefined,
  extraCategory?: string | null,
): ParsedGroupsSpec {
  const trimmed = (raw ?? '').trim();
  const fallbackCat = extraCategory?.trim() || null;
  if (!trimmed || /^(?:0|否|无|無|不发|不發|none|no|false|-)$/i.test(trimmed))
    return { mode: 'none' };
  if (/^\d{1,3}$/.test(trimmed)) {
    const count = Number(trimmed);
    return count > 0 ? { mode: 'random', count, category: fallbackCat } : { mode: 'none' };
  }
  const catCountMatch = /^([^:：\r\n,，]+?)\s*[:：]\s*(\d{1,3})$/.exec(trimmed);
  if (catCountMatch?.[1] && catCountMatch[2]) {
    const count = Number(catCountMatch[2]);
    const category = catCountMatch[1].trim();
    return count > 0 && category ? { mode: 'random', count, category } : { mode: 'none' };
  }
  const unique = [
    ...new Set(
      trimmed
        .split(/[\r\n,，;；\s]+/)
        .map(extractFacebookGroupId)
        .filter(Boolean),
    ),
  ];
  return unique.length > 0 ? { mode: 'explicit', groupIds: unique } : { mode: 'none' };
}
export const parseBooleanCell = (raw: string | null | undefined): boolean =>
  /^(?:是|yes|true|1|y|开启|開啟|开|開|✓|✔)$/.test((raw ?? '').trim().toLowerCase());
export function parseAiLabelCell(raw: string | null | undefined): 'default' | 'on' | 'off' {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (!trimmed) return 'default';
  if (/^(?:是|yes|true|1|y|开启|開啟|开|開|✓|✔)$/.test(trimmed)) return 'on';
  if (/^(?:否|no|false|0|n|关闭|關閉|关|關|×|✗)$/.test(trimmed)) return 'off';
  return 'default';
}
function buildWallClockMs(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timeZone?: string,
): number | null {
  const chk = new Date(Date.UTC(y, mo - 1, d));
  if (
    [y, mo, d, h, mi, s].some((v) => !Number.isInteger(v)) ||
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    d > 31 ||
    h < 0 ||
    h > 23 ||
    mi < 0 ||
    mi > 59 ||
    s < 0 ||
    s > 59 ||
    chk.getUTCFullYear() !== y ||
    chk.getUTCMonth() !== mo - 1 ||
    chk.getUTCDate() !== d
  )
    return null;
  const local = () => {
    const ms = new Date(y, mo - 1, d, h, mi, s).getTime();
    return Number.isFinite(ms) ? ms : null;
  };
  if (!timeZone) return local();
  try {
    const guess = Date.UTC(y, mo - 1, d, h, mi, s),
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
      toUtc = (ms: number) => {
        const m = Object.fromEntries(
          fmt.formatToParts(new Date(ms)).map((p) => [p.type, Number(p.value)]),
        );
        return Date.UTC(
          m.year ?? NaN,
          (m.month ?? NaN) - 1,
          m.day ?? NaN,
          (m.hour ?? NaN) % 24,
          m.minute ?? NaN,
          m.second ?? NaN,
        );
      },
      cand = guess - (toUtc(guess) - guess),
      resolved = guess - (toUtc(cand) - cand);
    return Number.isFinite(resolved) ? resolved : null;
  } catch {
    return local();
  }
}
export function parseScheduleDateTimeMs(
  dateCell: string,
  timeCell: string,
  timeZone?: string,
): number | null {
  const d = dateCell.trim(),
    t = timeCell.trim();
  if (!d) return null;
  const parseTime = (raw: string, bh: number, bm: number, bs: number) => {
    const tr = raw.trim();
    if (!tr) return { hour: bh, minute: bm, second: bs, dayCarry: 0 };
    const norm = tr
      .replace(/[：]/g, ':')
      .replace(
        /(\d{1,2})\s*[点點时時]\s*(\d{1,2})\s*(?:分(?:\s*(\d{1,2})\s*秒?)?)?/g,
        (_, h, m, s) => (s ? `${h}:${m}:${s}` : `${h}:${m}`),
      )
      .replace(/(\d{1,2})\s*[点點时時]\s*(?:整)?$/g, '$1:00')
      .trim();
    const zm =
      /^(上午|早上|凌晨|中午|下午|晚上)?\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(am|pm|上午|下午)?$/i.exec(
        norm,
      );
    if (zm?.[2] !== undefined && zm[3] !== undefined) {
      let hour = Number(zm[2]);
      const minute = Number(zm[3]),
        second = zm[4] !== undefined ? Number(zm[4]) : 0,
        period = (zm[1] || zm[5] || '').toLowerCase();
      if ((period === 'pm' || period === '下午' || period === '晚上') && hour < 12) hour += 12;
      else if ((period === 'am' || period === '上午' || period === '凌晨') && hour === 12) hour = 0;
      return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59
        ? { hour, minute, second, dayCarry: 0 }
        : null;
    }
    if (/^0?\.\d+$/.test(norm)) {
      const total = Math.round(Number(norm) * 86400),
        rem = total % 86400;
      return {
        hour: Math.floor(rem / 3600),
        minute: Math.floor((rem % 3600) / 60),
        second: rem % 60,
        dayCarry: Math.floor(total / 86400),
      };
    }
    return null;
  };
  const fromUtc = (u: Date, r: { hour: number; minute: number; second: number }) =>
      buildWallClockMs(
        u.getUTCFullYear(),
        u.getUTCMonth() + 1,
        u.getUTCDate(),
        r.hour,
        r.minute,
        r.second,
        timeZone,
      ),
    byYmd = (y: number, m: number, day: number, inline: string) => {
      const tr = parseTime(t || inline, 0, 0, 0);
      if (!tr) return null;
      const u = new Date(Date.UTC(y, m - 1, day + tr.dayCarry));
      return tr.dayCarry === 0 &&
        (u.getUTCFullYear() !== y || u.getUTCMonth() !== m - 1 || u.getUTCDate() !== day)
        ? null
        : fromUtc(u, tr);
    };
  if (/^\d{5}(?:\.\d+)?$/.test(d)) {
    const serial = Number(d),
      days = Math.floor(serial),
      sec = Math.round((serial - days) * 86400),
      rem = sec % 86400,
      tr = parseTime(t, Math.floor(rem / 3600), Math.floor((rem % 3600) / 60), rem % 60);
    return tr
      ? fromUtc(new Date(Date.UTC(1899, 11, 30 + days + Math.floor(sec / 86400) + tr.dayCarry)), tr)
      : null;
  }
  const cm = /^(\d{4})(?:[-/.]|年)(\d{1,2})(?:[-/.]|月)(\d{1,2})日?(?:[T\s]+(.+))?$/.exec(d);
  if (cm) return byYmd(Number(cm[1]), Number(cm[2]), Number(cm[3]), cm[4]?.trim() ?? '');
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(.+))?$/.exec(d);
  if (us) return byYmd(Number(us[3]), Number(us[1]), Number(us[2]), us[4]?.trim() ?? '');
  if (t) {
    const pt = parseTime(t, 0, 0, 0),
      base = Date.parse(d);
    if (!pt || !Number.isFinite(base)) return null;
    const dt = new Date(base);
    return buildWallClockMs(
      dt.getFullYear(),
      dt.getMonth() + 1,
      dt.getDate() + pt.dayCarry,
      pt.hour,
      pt.minute,
      pt.second,
      timeZone,
    );
  }
  const fb = Date.parse(d);
  return Number.isFinite(fb) ? fb : null;
}
const pad2 = (n: number) => String(n).padStart(2, '0');
export function formatDateTimeForSheet(ms: number): string {
  const dt = new Date(ms);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
}
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const randomCodeSegment = (length: number): string =>
  Array.from(
    { length },
    () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)] ?? 'X',
  ).join('');
export const generateResourceCode = (dateMs = Date.now(), randomSuffix?: string): string => {
  const dt = new Date(dateMs);
  return `${dt.getFullYear()}${pad2(dt.getMonth() + 1)}${pad2(dt.getDate())}-${(randomSuffix ?? randomCodeSegment(6)).toUpperCase()}`;
};
export const generatePostCode = (resourceCode: string, randomSuffix?: string): string =>
  `${resourceCode.trim() || generateResourceCode()}-${(randomSuffix ?? randomCodeSegment(4)).toUpperCase()}`;
