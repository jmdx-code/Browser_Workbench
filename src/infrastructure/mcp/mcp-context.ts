import { realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { open as openZip, type Entry, type ZipFile } from 'yauzl';
import { ProductError } from '../../domain/workspace.js';
import type { Core } from '../../bridge/core.js';
import type { BridgeStorePort } from '../persistence-port.js';
import type { KernelBridge } from '../kernel-bridge.js';
import type { WorkspaceService } from '../../application/workspace-service.js';
import type { ProfileInspectionService } from '../../application/profile-inspection.js';
import type { FeatureExecutionRegistry } from '../../application/feature-execution-registry.js';
import type { GroupPosterService } from '../../application/group-poster-service.js';
import type { GroupBumperService } from '../../application/group-bumper-service.js';
import type { GroupInviterService } from '../../application/group-inviter-service.js';
import type { BluestacksService } from '../../application/bluestacks-service.js';
import type { TaskService } from '../../application/task-service.js';
import type { Awaitable } from '../../domain/persistence.js';
import { isLocalAvatar } from '../../shared/group-bumper.js';
import type { ProfileLifecyclePort } from '../../shared/profile-lifecycle.js';
import type { AgentBrowserManager, AgentBrowserSessionSummary } from './agent-browser-manager.js';

export interface McpDiagnosticCaptureInput {
  note?: string;
  uiContext?: string;
  targetDir?: string;
  reveal?: boolean;
}

export interface McpDiagnosticCaptureOutput {
  filePath: string;
  fileName: string;
  sizeBytes: number;
  entryId: number;
  at: string;
}

export type McpContentItem =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface McpToolCallResult {
  content: McpContentItem[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpJsonSchemaProperty {
  type?: string | readonly string[];
  description?: string;
  enum?: readonly (string | number | boolean)[];
  items?: McpJsonSchemaProperty;
  properties?: Record<string, McpJsonSchemaProperty>;
  required?: readonly string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, McpJsonSchemaProperty>;
    required?: readonly string[];
    additionalProperties?: boolean;
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
  handler: (rawArgs: Record<string, unknown>) => Promise<McpToolCallResult>;
}

export interface WorkbenchMcpDependencies {
  softwareVersion: string;
  extensionVersion: string;
  dataDir: string;
  core: Core;
  store: BridgeStorePort;
  getMainKernel: () => KernelBridge | undefined;
  workspaceService: WorkspaceService;
  taskService?: TaskService | undefined;
  inspection?: ProfileInspectionService | undefined;
  featureExecution: FeatureExecutionRegistry;
  groupPosterService: GroupPosterService;
  getGroupBumperService: () => GroupBumperService | undefined;
  groupInviterService: GroupInviterService;
  bluestacksService: BluestacksService;
  agentBrowser: AgentBrowserManager;
  profileLifecycle?: ProfileLifecyclePort | undefined;
  captureDiagnostics?:
    ((input?: McpDiagnosticCaptureInput) => Awaitable<McpDiagnosticCaptureOutput>) | undefined;
  devDiagFilePath: string;
  reloadExtensions?:
    | ((profileIds?: string[]) => Promise<{
        reloaded: number;
        skippedBusy: number;
        skippedOffline: number;
        extensionDir: string;
        bundledVersion: string;
      }>)
    | undefined;
  withMutation?: (<T>(work: () => Promise<T>) => Promise<T>) | undefined;
}

export interface DataDirIntegrity {
  configuredPath: string;
  realPath: string;
  isVirtualizedSandbox: boolean;
}

export function resolveDataDirIntegrity(dataDir: string): DataDirIntegrity {
  const configuredPath = path.resolve(dataDir);
  let realPath = configuredPath;
  try {
    realPath = realpathSync.native(configuredPath);
  } catch {
    try {
      realPath = realpathSync(configuredPath);
    } catch {
      realPath = configuredPath;
    }
  }
  const isVirtualizedSandbox = /\\AppData\\Local\\Packages\\[^\\]+\\LocalCache\\Roaming\\/i.test(
    realPath,
  );
  return {
    configuredPath,
    realPath,
    isVirtualizedSandbox,
  };
}

export function okResult(payload: Record<string, unknown>): McpToolCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

export function errorResult(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): McpToolCallResult {
  const payload: Record<string, unknown> = {
    ok: false,
    errorCode: code,
    error: message,
    ...(details ? { details } : {}),
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

export function formatLocalDateTime(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export interface ParsedScheduleTime {
  scheduledAt: number | null;
  scheduledAtLocal: string | null;
  mode: 'immediate' | 'scheduled';
  rolledToNextDay: boolean;
}

export function parseFlexibleScheduleTime(raw: unknown, nowMs = Date.now()): ParsedScheduleTime {
  if (raw === undefined || raw === null) {
    return {
      scheduledAt: null,
      scheduledAtLocal: null,
      mode: 'immediate',
      rolledToNextDay: false,
    };
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) {
      throw new Error('INVALID_SCHEDULE_TIME: 数字时间戳必须为正数');
    }
    const ms = raw < 10_000_000_000 ? Math.round(raw * 1000) : Math.round(raw);
    return {
      scheduledAt: ms,
      scheduledAtLocal: formatLocalDateTime(ms),
      mode: ms > nowMs ? 'scheduled' : 'immediate',
      rolledToNextDay: false,
    };
  }
  if (typeof raw !== 'string') {
    throw new Error('INVALID_SCHEDULE_TIME: 定时参数必须为时间字符串、毫秒时间戳或 null');
  }
  const text = raw.trim();
  if (!text || /^(now|immediate|立即|马上)$/i.test(text)) {
    return {
      scheduledAt: null,
      scheduledAtLocal: null,
      mode: 'immediate',
      rolledToNextDay: false,
    };
  }
  if (/^\d{10,13}$/.test(text)) {
    const num = Number(text);
    const ms = text.length === 10 ? num * 1000 : num;
    return {
      scheduledAt: ms,
      scheduledAtLocal: formatLocalDateTime(ms),
      mode: ms > nowMs ? 'scheduled' : 'immediate',
      rolledToNextDay: false,
    };
  }

  // Day-prefixed Chinese/English relative clock: "今天 18:30", "今晚 20:30", "明天 09:15:00", "明早 08:30", "后天 10:00"
  const relMatch =
    /^(?:(今天|今日|今晚|今夜|今早|today)|(明天|明日|明早|明晚|tomorrow)|(后天))\s*(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?$/i.exec(
      text,
    );
  if (relMatch) {
    const dayOffset = relMatch[2] ? 1 : relMatch[3] ? 2 : 0;
    const hh = Number(relMatch[4]);
    const mm = Number(relMatch[5]);
    const ss = relMatch[6] ? Number(relMatch[6]) : 0;
    if (hh > 23 || mm > 59 || ss > 59) {
      throw new Error(`INVALID_SCHEDULE_TIME: 无效的时钟时间 "${text}"`);
    }
    const base = new Date(nowMs);
    const target = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate() + dayOffset,
      hh,
      mm,
      ss,
      0,
    );
    const ms = target.getTime();
    return {
      scheduledAt: ms,
      scheduledAtLocal: formatLocalDateTime(ms),
      mode: ms > nowMs ? 'scheduled' : 'immediate',
      rolledToNextDay: false,
    };
  }

  // Clock only: "18:30" or "18:30:00"
  const clockMatch = /^(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?$/.exec(text);
  if (clockMatch) {
    const hh = Number(clockMatch[1]);
    const mm = Number(clockMatch[2]);
    const ss = clockMatch[3] ? Number(clockMatch[3]) : 0;
    if (hh > 23 || mm > 59 || ss > 59) {
      throw new Error(`INVALID_SCHEDULE_TIME: 无效的时钟时间 "${text}"`);
    }
    const base = new Date(nowMs);
    let target = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hh, mm, ss, 0);
    let rolled = false;
    if (target.getTime() <= nowMs - 30_000) {
      target = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, hh, mm, ss, 0);
      rolled = true;
    }
    const ms = target.getTime();
    return {
      scheduledAt: ms,
      scheduledAtLocal: formatLocalDateTime(ms),
      mode: ms > nowMs ? 'scheduled' : 'immediate',
      rolledToNextDay: rolled,
    };
  }

  // Local date-time: "YYYY-MM-DD HH:mm[:ss]" or "YYYY/MM/DD HH:mm[:ss]"
  const localDtMatch =
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T\s]+(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?$/.exec(text);
  if (localDtMatch) {
    const year = Number(localDtMatch[1]);
    const month = Number(localDtMatch[2]);
    const day = Number(localDtMatch[3]);
    const hh = Number(localDtMatch[4]);
    const mm = Number(localDtMatch[5]);
    const ss = localDtMatch[6] ? Number(localDtMatch[6]) : 0;
    const target = new Date(year, month - 1, day, hh, mm, ss, 0);
    const ms = target.getTime();
    if (!Number.isFinite(ms)) {
      throw new Error(`INVALID_SCHEDULE_TIME: 无法解析日期时间 "${text}"`);
    }
    return {
      scheduledAt: ms,
      scheduledAtLocal: formatLocalDateTime(ms),
      mode: ms > nowMs ? 'scheduled' : 'immediate',
      rolledToNextDay: false,
    };
  }

  const parsedIso = Date.parse(text);
  if (Number.isFinite(parsedIso) && parsedIso > 0) {
    return {
      scheduledAt: parsedIso,
      scheduledAtLocal: formatLocalDateTime(parsedIso),
      mode: parsedIso > nowMs ? 'scheduled' : 'immediate',
      rolledToNextDay: false,
    };
  }

  throw new Error(
    `INVALID_SCHEDULE_TIME: 无法解析定时时间 "${text}"（支持 "2026-11-11 20:30"、"20:30"、"明天 09:00"、ISO 时间或毫秒时间戳）`,
  );
}

export interface EnrichedProfileSummary {
  id: string;
  alias: string;
  browserName: string | null;
  displayName: string;
  groupId: string | null;
  groupName: string | null;
  online: boolean;
  phase: string;
  synced: boolean;
  unresolvedCount: number;
  readyForTasks: boolean;
  extensionVersion: string | null;
  supportsAgentBrowser: boolean;
  busyModules: string[];
  account: {
    state: string;
    id: string | null;
    name: string | null;
    hasLocalAvatar: boolean;
  };
  liveInspection: {
    state: string;
    reason: string;
    checkedAt: number | null;
    checkedAtLocal: string | null;
  } | null;
  agentBrowserSession: AgentBrowserSessionSummary | null;
}

export async function buildEnrichedProfiles(
  deps: WorkbenchMcpDependencies,
): Promise<EnrichedProfileSummary[]> {
  const snapshot = await deps.workspaceService.snapshot();
  const groupNameById = new Map(snapshot.groups.map((g) => [g.id, g.name]));
  const sessionByProfile = new Map(deps.agentBrowser.listSessions().map((s) => [s.profileId, s]));

  const enriched: EnrichedProfileSummary[] = [];
  for (const profile of snapshot.profiles) {
    const peer = deps.core.peers.get(profile.id);
    const unresolvedRows = await deps.store.unresolved(profile.id);
    const busyModules = await deps.featureExecution.busyModuleLabels([profile.id]);
    const live = deps.inspection?.get(profile.id) ?? null;
    const online = Boolean(peer?.online);
    const phase = peer?.phase ?? profile.phase ?? 'OFFLINE';
    const synced = Boolean(peer?.synced);
    const unresolvedCount = unresolvedRows.length;
    const supportsAgentBrowser = Boolean(peer?.capabilities?.includes('agent-browser-kernel-v1'));
    const readyForTasks =
      online && synced && phase === 'PAUSED' && unresolvedCount === 0 && busyModules.length === 0;
    const browserName =
      typeof profile.browserName === 'string' && profile.browserName.trim()
        ? profile.browserName.trim()
        : null;
    const aliasTrimmed = profile.alias.trim();
    const isGenericChromeAlias = /^Chrome\s+[0-9a-f]{6,}$/i.test(aliasTrimmed);
    const displayName =
      aliasTrimmed && !isGenericChromeAlias
        ? aliasTrimmed
        : (browserName ?? (aliasTrimmed || profile.id));

    enriched.push({
      id: profile.id,
      alias: profile.alias,
      browserName,
      displayName,
      groupId: profile.groupId ?? null,
      groupName: profile.groupId ? (groupNameById.get(profile.groupId) ?? null) : null,
      online,
      phase,
      synced,
      unresolvedCount,
      readyForTasks,
      extensionVersion: peer?.extensionVersion ?? null,
      supportsAgentBrowser,
      busyModules,
      account: {
        state: profile.account.state,
        id: profile.account.id,
        name: profile.account.name,
        hasLocalAvatar: isLocalAvatar(profile.account.avatar),
      },
      liveInspection: live
        ? {
            state: live.state,
            reason: live.reason,
            checkedAt: live.checkedAt,
            checkedAtLocal: formatLocalDateTime(live.checkedAt),
          }
        : null,
      agentBrowserSession: sessionByProfile.get(profile.id) ?? null,
    });
  }
  return enriched;
}

export function resolveProfileIdentifierFromList(
  profiles: readonly EnrichedProfileSummary[],
  rawQuery: string,
): string {
  const query = rawQuery.trim();
  if (!query) {
    throw new ProductError('PROFILE_ID_REQUIRED', '浏览器标识不能为空', 400);
  }
  const lower = query.toLowerCase();

  // 1. Exact UUID / id match
  const exactById = profiles.find((p) => p.id.toLowerCase() === lower);
  if (exactById) return exactById.id;

  const pickUniqueOrSingleOnline = (candidates: readonly EnrichedProfileSummary[]): string => {
    if (candidates.length === 1 && candidates[0]) return candidates[0].id;
    const onlineOnes = candidates.filter((c) => c.online);
    if (onlineOnes.length === 1 && onlineOnes[0]) return onlineOnes[0].id;
    const candidateLabels = candidates
      .slice(0, 6)
      .map(
        (c) =>
          `${c.displayName} (id=${c.id}, account=${c.account.name ?? '未知'}, online=${c.online})`,
      )
      .join('；');
    throw new ProductError(
      'AMBIGUOUS_PROFILE_IDENTIFIER',
      `标识 "${query}" 同时匹配到多个浏览器，请改传明确的 profileId UUID：${candidateLabels}`,
      409,
    );
  };

  // 2. Exact match on browserName / displayName / alias / account.name / account.id
  const exactLabelMatches = profiles.filter((p) =>
    [p.browserName, p.displayName, p.alias, p.account.name, p.account.id]
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .some((v) => v.trim().toLowerCase() === lower),
  );
  if (exactLabelMatches.length > 0) {
    return pickUniqueOrSingleOnline(exactLabelMatches);
  }

  // 3. Fuzzy substring match when query has >= 2 chars
  if (lower.length >= 2) {
    const fuzzyMatches = profiles.filter((p) =>
      [p.browserName, p.displayName, p.alias, p.account.name, p.account.id]
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .some((v) => v.trim().toLowerCase().includes(lower)),
    );
    if (fuzzyMatches.length > 0) {
      return pickUniqueOrSingleOnline(fuzzyMatches);
    }
  }

  const onlineHints = profiles
    .filter((p) => p.online)
    .slice(0, 8)
    .map((p) => `${p.displayName} (id=${p.id}${p.account.name ? `, 账号=${p.account.name}` : ''})`)
    .join('；');
  throw new ProductError(
    'PROFILE_NOT_FOUND',
    `未找到匹配 "${query}" 的浏览器配置。${onlineHints ? `当前在线浏览器：${onlineHints}` : '当前无在线浏览器'}`,
    404,
  );
}

export async function resolveProfileId(
  deps: WorkbenchMcpDependencies,
  rawQuery: string,
): Promise<string> {
  const profiles = await buildEnrichedProfiles(deps);
  return resolveProfileIdentifierFromList(profiles, rawQuery);
}

export async function resolveProfileIds(
  deps: WorkbenchMcpDependencies,
  rawQueries: readonly string[],
): Promise<string[]> {
  if (rawQueries.length === 0) return [];
  const profiles = await buildEnrichedProfiles(deps);
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawQueries) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const id = resolveProfileIdentifierFromList(profiles, trimmed);
    if (!seen.has(id)) {
      seen.add(id);
      resolved.push(id);
    }
  }
  return resolved;
}

function unescapeXmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function columnLettersToIndex(letters: string): number {
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    const ch = letters.charCodeAt(i);
    if (ch >= 65 && ch <= 90) {
      col = col * 26 + (ch - 64);
    } else if (ch >= 97 && ch <= 122) {
      col = col * 26 + (ch - 96);
    }
  }
  return Math.max(0, col - 1);
}

async function readZipEntriesAsUtf8(
  filePath: string,
  predicate: (fileName: string) => boolean,
): Promise<Map<string, string>> {
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    openZip(filePath, { lazyEntries: true, autoClose: true }, (err, zf) => {
      if (err || !zf) reject(err ?? new Error('XLSX_OPEN_FAILED'));
      else resolve(zf);
    });
  });

  const out = new Map<string, string>();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finishErr = (err: unknown) => {
      if (settled) return;
      settled = true;
      try {
        zip.close();
      } catch {}
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    zip.on('error', finishErr);
    zip.on('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.on('entry', (entry: Entry) => {
      const normalized = entry.fileName.replace(/\\/g, '/');
      if (!predicate(normalized) || normalized.endsWith('/')) {
        zip.readEntry();
        return;
      }
      if (entry.uncompressedSize > 32 * 1024 * 1024) {
        finishErr(new Error(`XLSX_ENTRY_TOO_LARGE: ${normalized}`));
        return;
      }
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) {
          finishErr(err ?? new Error(`XLSX_STREAM_FAILED: ${normalized}`));
          return;
        }
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('error', finishErr);
        stream.on('end', () => {
          out.set(normalized, Buffer.concat(chunks).toString('utf8'));
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
  return out;
}

function parseSharedStringsXml(xml: string): string[] {
  const result: string[] = [];
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let siMatch: RegExpExecArray | null;
  while ((siMatch = siRegex.exec(xml)) !== null) {
    const inner = siMatch[1] ?? '';
    // Strip phonetic runs <rPh>...</rPh> so Chinese/Japanese furigana doesn't pollute cell text
    const cleaned = inner.replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, '');
    const parts: string[] = [];
    const tRegex = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let tMatch: RegExpExecArray | null;
    while ((tMatch = tRegex.exec(cleaned)) !== null) {
      parts.push(unescapeXmlEntities(tMatch[1] ?? ''));
    }
    result.push(parts.join(''));
  }
  return result;
}

export type ExcelTemporalKind = 'date' | 'time' | 'datetime';

const BUILTIN_EXCEL_DATE_FMT_IDS = new Set([
  14, 15, 16, 17, 27, 28, 29, 30, 31, 36, 50, 51, 52, 53, 54, 57, 58,
]);
const BUILTIN_EXCEL_TIME_FMT_IDS = new Set([18, 19, 20, 21, 32, 33, 45, 46, 47, 55, 56]);
const BUILTIN_EXCEL_DATETIME_FMT_IDS = new Set([22]);

function classifyExcelFormatCode(formatCode: string): ExcelTemporalKind | null {
  const primarySection = (formatCode.split(';')[0] ?? '').trim();
  if (!primarySection) return null;
  const cleaned = primarySection
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/_.|\*./g, '')
    .replace(/\[(?![hmsHMS]+\])[^\]]*\]/g, '')
    .trim();
  if (!cleaned) return null;
  // Reject general numeric/scientific/percentage formats so numbers are never corrupted
  if (/[#%?]|0\.0|e[+-]/i.test(cleaned)) return null;

  const hasDate = /[yd年日]/i.test(cleaned);
  const hasTime = /[hs时分秒]|am\/pm|a\/p|\[h+\]|\[m+\]|\[s+\]/i.test(cleaned);
  const hasStandaloneMonth = !hasTime && /m|月/i.test(cleaned);

  if ((hasDate || hasStandaloneMonth) && hasTime) return 'datetime';
  if (hasDate || hasStandaloneMonth) return 'date';
  if (hasTime) return 'time';
  return null;
}

export function parseXlsxStylesTemporalMap(stylesXml: string): Array<ExcelTemporalKind | null> {
  if (!stylesXml) return [];
  const customFmtById = new Map<number, ExcelTemporalKind | null>();
  const numFmtRegex = /<numFmt\b([^>]*?)\/?>/g;
  let nfMatch: RegExpExecArray | null;
  while ((nfMatch = numFmtRegex.exec(stylesXml)) !== null) {
    const attrs = nfMatch[1] ?? '';
    const idM = /\bnumFmtId="(\d+)"/.exec(attrs);
    const codeM = /\bformatCode="([^"]*)"/.exec(attrs);
    if (idM?.[1] && codeM?.[1] !== undefined) {
      const id = Number.parseInt(idM[1], 10);
      if (Number.isFinite(id)) {
        customFmtById.set(id, classifyExcelFormatCode(unescapeXmlEntities(codeM[1])));
      }
    }
  }

  const cellXfsBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  if (!cellXfsBlock) return [];
  const styleKinds: Array<ExcelTemporalKind | null> = [];
  const xfRegex = /<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g;
  let xfMatch: RegExpExecArray | null;
  while ((xfMatch = xfRegex.exec(cellXfsBlock)) !== null) {
    const attrs = xfMatch[1] ?? '';
    const nfIdM = /\bnumFmtId="(\d+)"/.exec(attrs);
    const nfId = nfIdM?.[1] ? Number.parseInt(nfIdM[1], 10) : 0;
    if (customFmtById.has(nfId)) {
      styleKinds.push(customFmtById.get(nfId) ?? null);
    } else if (BUILTIN_EXCEL_DATETIME_FMT_IDS.has(nfId)) {
      styleKinds.push('datetime');
    } else if (BUILTIN_EXCEL_DATE_FMT_IDS.has(nfId)) {
      styleKinds.push('date');
    } else if (BUILTIN_EXCEL_TIME_FMT_IDS.has(nfId)) {
      styleKinds.push('time');
    } else {
      styleKinds.push(null);
    }
  }
  return styleKinds;
}

export function formatExcelSerialValue(
  serial: number,
  kind: ExcelTemporalKind,
  date1904 = false,
): string {
  if (!Number.isFinite(serial) || serial < 0) return String(serial);
  const pad = (n: number) => String(n).padStart(2, '0');
  const totalSeconds = Math.round(serial * 86_400);

  if (kind === 'time' || serial < 1) {
    const secInDay = ((totalSeconds % 86_400) + 86_400) % 86_400;
    const hh = Math.floor(secInDay / 3600);
    const mm = Math.floor((secInDay % 3600) / 60);
    const ss = secInDay % 60;
    return ss === 0 ? `${pad(hh)}:${pad(mm)}` : `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  }

  const wholeDays = Math.floor(totalSeconds / 86_400);
  const remSeconds = totalSeconds - wholeDays * 86_400;
  const baseUtcMs = date1904
    ? Date.UTC(1904, 0, 1) + wholeDays * 86_400_000
    : Date.UTC(1899, 11, 31) + (wholeDays > 60 ? wholeDays - 1 : wholeDays) * 86_400_000;
  const dt = new Date(baseUtcMs);
  const datePart = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;

  if (kind === 'date' && remSeconds === 0) {
    return datePart;
  }
  const hh = Math.floor(remSeconds / 3600);
  const mm = Math.floor((remSeconds % 3600) / 60);
  const ss = remSeconds % 60;
  const timePart = ss === 0 ? `${pad(hh)}:${pad(mm)}` : `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  return `${datePart} ${timePart}`;
}

function parseWorksheetXml(
  xml: string,
  sharedStrings: readonly string[],
  styleKinds: readonly (ExcelTemporalKind | null)[] = [],
  date1904 = false,
): string[][] {
  const rows: string[][] = [];
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(xml)) !== null) {
    const rowInner = rowMatch[1] ?? '';
    const rowCells: string[] = [];
    let nextColIdx = 0;
    const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(rowInner)) !== null) {
      const attrs = cellMatch[1] ?? '';
      const cellInner = cellMatch[2] ?? '';
      const refMatch = /\br="([A-Za-z]+)\d+"/.exec(attrs);
      const colIdx = refMatch?.[1] ? columnLettersToIndex(refMatch[1]) : nextColIdx;
      nextColIdx = colIdx + 1;
      const typeMatch = /\bt="([^"]+)"/.exec(attrs);
      const cellType = typeMatch?.[1] ?? '';
      const styleMatch = /\bs="(\d+)"/.exec(attrs);
      const styleIdx = styleMatch?.[1] ? Number.parseInt(styleMatch[1], 10) : -1;
      let val = '';
      if (cellType === 'inlineStr') {
        const parts: string[] = [];
        const tRegex = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
        let tMatch: RegExpExecArray | null;
        while ((tMatch = tRegex.exec(cellInner)) !== null) {
          parts.push(unescapeXmlEntities(tMatch[1] ?? ''));
        }
        val = parts.join('');
      } else {
        const vMatch = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(cellInner);
        const rawV = vMatch?.[1] ? unescapeXmlEntities(vMatch[1]) : '';
        if (cellType === 's') {
          const sIdx = Number.parseInt(rawV, 10);
          val = Number.isFinite(sIdx) ? (sharedStrings[sIdx] ?? '') : '';
        } else if (cellType === 'b') {
          val = rawV === '1' ? 'TRUE' : rawV === '0' ? 'FALSE' : rawV;
        } else if ((cellType === '' || cellType === 'n') && rawV !== '' && styleIdx >= 0) {
          const temporalKind = styleKinds[styleIdx] ?? null;
          const numericVal = Number(rawV);
          if (
            temporalKind &&
            Number.isFinite(numericVal) &&
            numericVal >= 0 &&
            numericVal < 2958466
          ) {
            val = formatExcelSerialValue(numericVal, temporalKind, date1904);
          } else {
            val = rawV;
          }
        } else {
          val = rawV;
        }
      }
      while (rowCells.length < colIdx) rowCells.push('');
      rowCells[colIdx] = val.trim();
    }
    if (rowCells.some((c) => c.length > 0)) {
      rows.push(rowCells);
    }
  }
  return rows;
}

function parseDelimitedText(text: string, delimiter: string): string[][] {
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let curRow: string[] = [];
  let curCell = '';
  let inQuotes = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inQuotes) {
      if (ch === '"') {
        if (cleaned[i + 1] === '"') {
          curCell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        curCell += ch ?? '';
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      curRow.push(curCell.trim());
      curCell = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && cleaned[i + 1] === '\n') i++;
      curRow.push(curCell.trim());
      curCell = '';
      if (curRow.some((c) => c.length > 0)) {
        rows.push(curRow);
      }
      curRow = [];
    } else {
      curCell += ch ?? '';
    }
  }
  curRow.push(curCell.trim());
  if (curRow.some((c) => c.length > 0)) {
    rows.push(curRow);
  }
  return rows;
}

export interface TableReadOptions {
  sheet?: string | number | undefined;
  hasHeader?: boolean | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

export interface TableReadResult {
  filePath: string;
  format: 'xlsx' | 'csv' | 'tsv' | 'json';
  sheetNames: string[];
  selectedSheet: string | null;
  headers: string[];
  totalRows: number;
  offset: number;
  returnedRows: number;
  hasMore: boolean;
  rows: Array<Record<string, string>>;
}

function clipCell(value: unknown, maxLen = 2000): string {
  const str =
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value.trim()
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
  return str.length > maxLen ? `${str.slice(0, maxLen)}…` : str;
}

export async function readSpreadsheetOrTableFile(
  rawFilePath: string,
  options?: TableReadOptions,
): Promise<TableReadResult> {
  const resolved = path.resolve(rawFilePath.trim());
  const fileStat = await stat(resolved);
  if (!fileStat.isFile()) {
    throw new Error(`NOT_A_FILE: "${resolved}" 不是有效文件`);
  }
  if (fileStat.size > 32 * 1024 * 1024) {
    throw new Error(`FILE_TOO_LARGE: 文件超过 32MB 上限 (${fileStat.size} bytes)`);
  }

  const ext = path.extname(resolved).toLowerCase();
  const hasHeader = options?.hasHeader !== false;
  const offset = Math.max(0, Math.floor(options?.offset ?? 0));
  const limit = Math.max(1, Math.min(1000, Math.floor(options?.limit ?? 200)));

  if (ext === '.json' || ext === '.jsonl') {
    const content = await readFile(resolved, 'utf8');
    const parsedItems: unknown[] =
      ext === '.jsonl'
        ? content
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => JSON.parse(l) as unknown)
        : (() => {
            const root = JSON.parse(content) as unknown;
            if (Array.isArray(root)) return root;
            if (typeof root === 'object' && root !== null && 'rows' in root) {
              const rowsField = (root as { rows?: unknown }).rows;
              if (Array.isArray(rowsField)) return rowsField;
            }
            return [root];
          })();

    const headersSet = new Set<string>();
    const normalizedRows: Array<Record<string, string>> = [];
    for (const item of parsedItems) {
      if (Array.isArray(item)) {
        const rec: Record<string, string> = {};
        item.forEach((cell, idx) => {
          const col = `col_${idx + 1}`;
          headersSet.add(col);
          rec[col] = clipCell(cell);
        });
        normalizedRows.push(rec);
      } else if (typeof item === 'object' && item !== null) {
        const rec: Record<string, string> = {};
        for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
          headersSet.add(k);
          rec[k] = clipCell(v);
        }
        normalizedRows.push(rec);
      }
    }
    const sliced = normalizedRows.slice(offset, offset + limit);
    return {
      filePath: resolved,
      format: 'json',
      sheetNames: [],
      selectedSheet: null,
      headers: [...headersSet],
      totalRows: normalizedRows.length,
      offset,
      returnedRows: sliced.length,
      hasMore: offset + sliced.length < normalizedRows.length,
      rows: sliced,
    };
  }

  let rawGrid: string[][] = [];
  let format: 'xlsx' | 'csv' | 'tsv' = 'csv';
  let sheetNames: string[] = [];
  let selectedSheet: string | null = null;

  if (ext === '.xlsx') {
    format = 'xlsx';
    const entries = await readZipEntriesAsUtf8(
      resolved,
      (name) =>
        name === 'xl/workbook.xml' ||
        name === 'xl/_rels/workbook.xml.rels' ||
        name === 'xl/sharedStrings.xml' ||
        name === 'xl/styles.xml' ||
        /^xl\/worksheets\/[^/]+\.xml$/i.test(name),
    );
    const workbookXml = entries.get('xl/workbook.xml') ?? '';
    const relsXml = entries.get('xl/_rels/workbook.xml.rels') ?? '';
    const sharedStrings = parseSharedStringsXml(entries.get('xl/sharedStrings.xml') ?? '');
    const styleKinds = parseXlsxStylesTemporalMap(entries.get('xl/styles.xml') ?? '');
    const date1904 = /<workbookPr\b[^>]*\bdate1904="(?:1|true)"/i.test(workbookXml);

    const relTargetById = new Map<string, string>();
    const relRegex = /<Relationship\b([^>]*?)\/?>/g;
    let relMatch: RegExpExecArray | null;
    while ((relMatch = relRegex.exec(relsXml)) !== null) {
      const attrs = relMatch[1] ?? '';
      const idM = /\bId="([^"]+)"/.exec(attrs);
      const targetM = /\bTarget="([^"]+)"/.exec(attrs);
      if (idM?.[1] && targetM?.[1]) {
        const rawTarget = targetM[1].replace(/^\/+/, '');
        const normalizedTarget = rawTarget.startsWith('xl/') ? rawTarget : `xl/${rawTarget}`;
        relTargetById.set(idM[1], normalizedTarget);
      }
    }

    const sheetsMeta: Array<{ name: string; entryName: string }> = [];
    const sheetRegex = /<sheet\b([^>]*?)\/?>/g;
    let sMatch: RegExpExecArray | null;
    while ((sMatch = sheetRegex.exec(workbookXml)) !== null) {
      const attrs = sMatch[1] ?? '';
      const nameM = /\bname="([^"]+)"/.exec(attrs);
      const rIdM = /\br:id="([^"]+)"/.exec(attrs);
      const sheetName = nameM?.[1]
        ? unescapeXmlEntities(nameM[1])
        : `Sheet${sheetsMeta.length + 1}`;
      const entryName =
        (rIdM?.[1] ? relTargetById.get(rIdM[1]) : undefined) ??
        `xl/worksheets/sheet${sheetsMeta.length + 1}.xml`;
      sheetsMeta.push({ name: sheetName, entryName });
    }
    if (sheetsMeta.length === 0) {
      const fallbackEntries = [...entries.keys()]
        .filter((k) => /^xl\/worksheets\/[^/]+\.xml$/i.test(k))
        .sort();
      fallbackEntries.forEach((entryName, idx) => {
        sheetsMeta.push({ name: `Sheet${idx + 1}`, entryName });
      });
    }
    sheetNames = sheetsMeta.map((s) => s.name);
    let chosen = sheetsMeta[0];
    if (typeof options?.sheet === 'number') {
      chosen = sheetsMeta[options.sheet] ?? sheetsMeta[0];
    } else if (typeof options?.sheet === 'string' && options.sheet.trim()) {
      const wanted = options.sheet.trim().toLowerCase();
      chosen =
        sheetsMeta.find((s) => s.name.toLowerCase() === wanted) ??
        sheetsMeta.find((s) => s.name.toLowerCase().includes(wanted)) ??
        sheetsMeta[0];
    }
    if (!chosen) {
      throw new Error('XLSX_NO_WORKSHEET: Excel 文件中未找到工作表');
    }
    selectedSheet = chosen.name;
    const sheetXml = entries.get(chosen.entryName) ?? '';
    rawGrid = parseWorksheetXml(sheetXml, sharedStrings, styleKinds, date1904);
  } else {
    const content = await readFile(resolved, 'utf8');
    format = ext === '.tsv' ? 'tsv' : 'csv';
    const delimiter =
      ext === '.tsv'
        ? '\t'
        : (() => {
            const firstLine = content.split(/\r?\n/)[0] ?? '';
            const tabs = (firstLine.match(/\t/g) ?? []).length;
            const commas = (firstLine.match(/,/g) ?? []).length;
            return tabs > commas ? '\t' : ',';
          })();
    if (delimiter === '\t') format = 'tsv';
    rawGrid = parseDelimitedText(content, delimiter);
  }

  if (rawGrid.length === 0) {
    return {
      filePath: resolved,
      format,
      sheetNames,
      selectedSheet,
      headers: [],
      totalRows: 0,
      offset,
      returnedRows: 0,
      hasMore: false,
      rows: [],
    };
  }

  const maxCols = rawGrid.reduce((acc, r) => Math.max(acc, r.length), 0);
  const rawHeaders = hasHeader ? (rawGrid[0] ?? []) : [];
  const headers: string[] = [];
  const usedHeaderNames = new Set<string>();
  for (let c = 0; c < maxCols; c++) {
    const candidate = (rawHeaders[c] ?? '').trim() || `col_${c + 1}`;
    let unique = candidate;
    let suffix = 2;
    while (usedHeaderNames.has(unique)) {
      unique = `${candidate}_${suffix++}`;
    }
    usedHeaderNames.add(unique);
    headers.push(unique);
  }

  const dataRows = hasHeader ? rawGrid.slice(1) : rawGrid;
  const mappedRows: Array<Record<string, string>> = dataRows.map((cells, rowIdx) => {
    const obj: Record<string, string> = {
      _rowNumber: String(hasHeader ? rowIdx + 2 : rowIdx + 1),
    };
    for (let c = 0; c < headers.length; c++) {
      const h = headers[c];
      if (h !== undefined) {
        obj[h] = clipCell(cells[c] ?? '');
      }
    }
    return obj;
  });

  const sliced = mappedRows.slice(offset, offset + limit);
  return {
    filePath: resolved,
    format,
    sheetNames,
    selectedSheet,
    headers,
    totalRows: mappedRows.length,
    offset,
    returnedRows: sliced.length,
    hasMore: offset + sliced.length < mappedRows.length,
    rows: sliced,
  };
}
