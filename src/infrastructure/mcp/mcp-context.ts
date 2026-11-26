import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { AutoSchedulerService } from '../../application/auto-scheduler-service.js';
import type { BluestacksService } from '../../application/bluestacks-service.js';
import type { FeatureExecutionRegistry } from '../../application/feature-execution-registry.js';
import type { GoogleSheetsService } from '../../application/google-sheets-service.js';
import type { GroupBumperService } from '../../application/group-bumper-service.js';
import type { GroupInviterService } from '../../application/group-inviter-service.js';
import type { GroupPosterService } from '../../application/group-poster-service.js';
import type { ProfileInspectionService } from '../../application/profile-inspection.js';
import type { TaskService } from '../../application/task-service.js';
import type { WorkspaceService } from '../../application/workspace-service.js';
import type { Core } from '../../bridge/core.js';
import type { Awaitable } from '../../domain/persistence.js';
import { ProductError } from '../../domain/workspace.js';
import { bluestacksDisplayTitle, type BluestacksInstance } from '../../shared/bluestacks.js';
import type { BrowserWindowPort } from '../../shared/browser-window.js';
import { profileDisplayName } from '../../shared/contracts.js';
import { devDiag, type DevDiagLevel } from '../../shared/dev-diagnostics.js';
import { extractFacebookGroupId, extractFacebookPageId } from '../../shared/facebook-target-id.js';
import { isLocalAvatar, isTargetIncomplete } from '../../shared/group-bumper.js';
import type { ProfileLifecyclePort } from '../../shared/profile-lifecycle.js';
import type { ReloadResult } from '../../shared/software-update.js';
import type { Plan } from '../../shared/task-contracts.js';
import type { WindowLayoutPort } from '../../shared/window-layout.js';
import type { KernelBridge } from '../kernel-bridge.js';
import type { BridgeStorePort } from '../persistence-port.js';
import type { AgentBrowserManager, AgentBrowserSessionSummary } from './agent-browser-manager.js';

export {
  formatExcelSerialValue,
  readSpreadsheetOrTableFile,
  type ExcelTemporalKind,
  type TableReadOptions,
  type TableReadResult,
} from './mcp-table-reader.js';

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
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
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
  getAutoSchedulerService?: (() => AutoSchedulerService | undefined) | undefined;
  getGoogleSheetsService?: (() => GoogleSheetsService | undefined) | undefined;
  agentBrowser: AgentBrowserManager;
  profileLifecycle?: ProfileLifecyclePort | undefined;
  browserWindow?: BrowserWindowPort | undefined;
  windowLayout?: WindowLayoutPort | undefined;
  captureDiagnostics?: (i?: {
    note?: string;
    uiContext?: string;
    targetDir?: string;
    reveal?: boolean;
  }) => Awaitable<{
    filePath: string;
    fileName: string;
    sizeBytes: number;
    entryId: number;
    at: string;
  }>;
  devDiagFilePath: string;
  reloadExtensions?: ((ids?: string[]) => Promise<ReloadResult>) | undefined;
  withMutation?: (<T>(work: () => Promise<T>) => Promise<T>) | undefined;
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
  account: { state: string; id: string | null; name: string | null; hasLocalAvatar: boolean };
  liveInspection: {
    state: string;
    reason: string;
    checkedAt: number | null;
    checkedAtLocal: string | null;
  } | null;
  agentBrowserSession: AgentBrowserSessionSummary | null;
}
export interface ParsedScheduleTime {
  scheduledAt: number | null;
  scheduledAtLocal: string | null;
  mode: 'immediate' | 'scheduled';
  rolledToNextDay: boolean;
}

type P = McpJsonSchemaProperty;
type PExtra = Pick<P, 'properties' | 'required' | 'additionalProperties'>;
export const E = (v: string | readonly (string | number | boolean)[], d?: string): P => ({
  type: 'string',
  enum: typeof v === 'string' ? v.split(' ') : v,
  ...(d && { description: d }),
});
export const A = (items: P, d?: string): P => ({
  type: 'array',
  items,
  ...(d && { description: d }),
});
export const O = (d?: string, x?: PExtra): P => ({
  type: 'object',
  ...(d && { description: d }),
  ...x,
});
export const U = (t: string | readonly string[], d?: string, x?: PExtra): P => ({
  type: typeof t === 'string' ? t.split(' ') : t,
  ...(d && { description: d }),
  ...x,
});
export const arrObj = (spec: string, desc: string, reqFields?: string): P =>
  A(
    O(undefined, { properties: sp(spec), ...(reqFields && { required: reqFields.split(' ') }) }),
    desc,
  );

const parseProp = (ts: string, d?: string): P => {
  if (ts === 's' || ts === 'b')
    return { type: ts === 's' ? 'string' : 'boolean', ...(d && { description: d }) };
  if (ts === 'sa') return A({ type: 'string' }, d);
  if (ts === 'o') return O(d);
  if (ts.startsWith('e(') || ts.startsWith('u('))
    return (ts[0] === 'e' ? E : U)(ts.slice(2, -1), d);
  const [a, b] = ts === 'n' ? [] : ts.slice(2, -1).split(',');
  return {
    type: 'number',
    ...(a && { minimum: Number(a) }),
    ...(b && { maximum: Number(b) }),
    ...(d && { description: d }),
  };
};
const CP = sp(
  'profileId:s:浏览器标识/名称|profileIds:sa:浏览器标识列表|groupIds:sa:目标小组 ID 或链接|pageIds:sa:目标专页 ID 或链接|search:s:搜索关键词|limit:n(1,200):返回条数上限|taskId:s:任务或计划 ID|taskIds:sa:任务或计划 ID 列表|scheduledAt:u(string number):定时时间（20:30/+30m/ISO/时间戳）|settings:o:设置参数补丁|comments:sa:留言话术列表|consumeCommentOnUse:b:用后消耗移除|includeComments:b:返回留言话术|autoAddMissingTargets:b:未入库目标自动补入',
);
export function sp(spec: string, extra?: Record<string, P>): Record<string, P> {
  const out: Record<string, P> = {};
  for (const raw of spec.split('|')) {
    const t = raw.trim();
    if (!t) continue;
    if (t[0] === '@') {
      const k = t.slice(1);
      if (CP?.[k]) out[k] = CP[k];
      continue;
    }
    const i1 = t.indexOf(':');
    const i2 = t.indexOf(':', i1 + 1);
    if (i1 > 0)
      out[t.slice(0, i1)] = parseProp(
        i2 > i1 ? t.slice(i1 + 1, i2) : t.slice(i1 + 1),
        i2 > i1 ? t.slice(i2 + 1) || undefined : undefined,
      );
  }
  return extra ? { ...out, ...extra } : out;
}

export function reg(
  name: string,
  description: string,
  specOrProps: string | Record<string, P>,
  handler: (a: Record<string, unknown>) => Promise<McpToolCallResult | object>,
  opts?: { req?: string; readOnly?: boolean; openWorld?: boolean; errCode?: string },
): McpToolDefinition {
  const properties = typeof specOrProps === 'string' ? sp(specOrProps) : specOrProps;
  const required = opts?.req?.split(' ');
  const annotations =
    opts?.readOnly || opts?.openWorld
      ? {
          ...(opts.readOnly && { readOnlyHint: true }),
          ...(opts.openWorld && { openWorldHint: true }),
        }
      : undefined;
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      ...(required?.length && { required }),
      additionalProperties: false,
    },
    ...(annotations && { annotations }),
    handler: async (rawArgs) => {
      try {
        const res = (await handler(rawArgs)) as Record<string, unknown>;
        return Array.isArray(res.content)
          ? (res as unknown as McpToolCallResult)
          : okResult('ok' in res ? res : { ok: true, ...res });
      } catch (err) {
        if (err instanceof ProductError) return errorResult(err.code, err.message);
        if (opts?.errCode) return errorResult(opts.errCode, errMsg(err));
        throw err;
      }
    },
  };
}

export const act = (action: string, map: Record<string, () => Promise<object> | object>) => {
  const fn = map[action];
  if (!fn) throw new ProductError('MCP_INVALID_ACTION', `未知 action: ${action}`, 400);
  return fn();
};
export function req<T>(
  val: T,
  code: string,
  msg: string,
  status = 400,
): asserts val is NonNullable<T> {
  if (val === undefined || val === null || val === '') throw new ProductError(code, msg, status);
}
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
export const strArg = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
export const strArrArg = (v: unknown) =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
export const collectRawIds = (a: Record<string, unknown>, listK: string, singleK: string) => [
  ...strArrArg(a[listK]),
  ...(strArg(a[singleK]) ? [strArg(a[singleK])] : []),
];
export const clampInt = (v: unknown, def: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.floor(Number(v ?? def))));
export const objArg = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const extractGroupIds = (v: unknown) =>
  strArrArg(v).map(extractFacebookGroupId).filter(Boolean);
export const extractPageIds = (v: unknown) =>
  strArrArg(v).map(extractFacebookPageId).filter(Boolean);

const PICK_MOD: Record<string, (v: unknown) => unknown> = {
  '?': (v) => v ?? null,
  '!': (v) => Boolean(v),
  '=': (v) => v ?? '',
  '#': (v) => v ?? [],
};
export function pick(src: object, keys: string): Record<string, unknown> {
  const rec = src as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const tok of keys.split(' ')) {
    if (!tok) continue;
    const mod = tok.slice(-1);
    const fn = PICK_MOD[mod];
    const k = mod === '@' || fn ? tok.slice(0, -1) : tok;
    out[k] = fn ? fn(rec[k]) : rec[k];
    if (mod === '@') out[`${k}Local`] = formatLocalDateTime(rec[k] as number | null | undefined);
  }
  return out;
}
export const mapAt = <T extends object>(rows: readonly T[], k: string) =>
  rows.map((r) => ({
    ...r,
    [`${k}Local`]: formatLocalDateTime(
      (r as Record<string, unknown>)[k] as number | null | undefined,
    ),
  }));

const TYPE_PRED: Record<string, (v: unknown) => boolean> = {
  n: (v) => typeof v === 'number',
  b: (v) => typeof v === 'boolean',
  rs: (v) => typeof v === 'string',
  o: (v) => typeof v === 'object' && v !== null,
};
export function pickTypes(src: Record<string, unknown>, spec: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of spec.split(' ')) {
    const [k, t] = entry.split(':');
    const v = k ? src[k] : undefined;
    if (k && t === 's' && typeof v === 'string' && v.trim()) out[k] = v.trim();
    else if (k && t && TYPE_PRED[t]?.(v)) out[k] = v;
  }
  return out;
}

export const mapActivePlan = (
  p: Plan,
  keys = 'id profileId combinationId state reason round position updatedAt@',
) => ({
  ...pick(p, keys),
  combinationName: p.snapshot.name,
});

export const pickBumperScope = (st: object, isPage: boolean) => {
  const r = st as Record<string, unknown>;
  const g = (p: string, q: string) => r[isPage ? p : q];
  return {
    running: Boolean(g('pageBumperRunning', 'running')),
    statusText: String(g('pageBumperStatusText', 'statusText') ?? ''),
    settings: g('pageSettings', 'settings') as Record<string, unknown> | undefined,
    comments: (g('pageComments', 'comments') ?? []) as Array<{ text: string }>,
    profileCounts: g('pageBumperProfileCounts', 'profileCounts'),
    total: Number(g('pageTotal', 'total') ?? 0),
  };
};

export const summarizeTarget = (i: {
  id?: string;
  groupId?: string;
  name?: string;
  groupName?: string;
  avatarUrl?: string | null;
  folderId?: string | null;
  totalBumpedCount?: number;
  updatedAt?: number;
}) => {
  const [id, name] = [i.id ?? i.groupId ?? '', i.name ?? i.groupName ?? ''];
  return {
    id,
    name,
    folderId: i.folderId ?? null,
    hasLocalAvatar: isLocalAvatar(i.avatarUrl),
    incomplete: isTargetIncomplete({ id, name, avatarUrl: i.avatarUrl }),
    totalBumpedCount: i.totalBumpedCount ?? 0,
    updatedAt: i.updatedAt ?? 0,
  };
};

export function parseTargetAddItems(args: Record<string, unknown>, defFolder?: string) {
  const out: Array<{ id: string; name?: string; folderId?: string | null }> = [];
  for (const raw of Array.isArray(args.items) ? args.items : []) {
    const r = objArg(raw);
    const id = strArg(r.idOrUrl) || strArg(r.groupId) || strArg(r.id);
    const name = strArg(r.name) || strArg(r.groupName);
    const f = r.folderId === null ? null : strArg(r.folderId) || defFolder;
    if (id) out.push({ id, ...(name && { name }), ...(f !== undefined && { folderId: f }) });
  }
  if (typeof args.rawText === 'string')
    for (const l of args.rawText.split(/\r?\n/))
      if (l.trim())
        out.push({ id: l.trim(), ...(defFolder !== undefined && { folderId: defFolder }) });
  return out;
}

export async function ensureBumperTargets(
  deps: WorkbenchMcpDependencies,
  gIds: readonly string[],
  pIds: readonly string[],
) {
  const bumper = deps.getGroupBumperService();
  if (!bumper || (gIds.length === 0 && pIds.length === 0)) return;
  const cur = await bumper.state();
  const mg = gIds.filter((id) => !cur.groups.some((g) => g.id === id)).map((id) => ({ id }));
  const mp = pIds.filter((id) => !cur.pages.some((p) => p.id === id)).map((id) => ({ id }));
  if (mg.length > 0) await bumper.manage('groups/add', { items: mg });
  if (mp.length > 0) await bumper.manage('pages/add', { items: mp });
}

export function recentDiagSlice(
  maxScan: number,
  limit: number,
  opts?: {
    minSeq?: number;
    levels?: readonly DevDiagLevel[];
    profileFilter?: string;
    query?: string;
  },
) {
  const lvl = opts?.levels ? new Set<string>(opts.levels) : null;
  const q = opts?.query?.trim().toLowerCase() ?? '';
  return devDiag
    .recent(maxScan)
    .filter(
      (e) =>
        !(opts?.minSeq !== undefined && e.seq <= opts.minSeq) &&
        (!lvl || lvl.has(e.level)) &&
        (!opts?.profileFilter || (e.profileId ?? '') === opts.profileFilter) &&
        (!q ||
          `${e.event} ${e.reason ?? ''} ${e.url ?? ''} ${e.profileName ?? ''} ${e.data ? JSON.stringify(e.data) : ''}`
            .toLowerCase()
            .includes(q)),
    )
    .slice(-limit);
}

export async function pollUntil(
  deadlineMs: number,
  intervalMs: number,
  checkDone: () => Promise<boolean>,
) {
  while (Date.now() < deadlineMs && !(await checkDone())) await sleep(intervalMs);
}

export async function scheduleOnceViaAutoScheduler(
  schedSvc: AutoSchedulerService,
  name: string,
  profileIds: string[],
  onceAt: number,
  step: Record<string, unknown>,
) {
  const scheduleId = randomUUID();
  const now = Date.now();
  const schedState = await schedSvc.saveSchedule({
    id: scheduleId,
    name: `${name} · ${formatLocalDateTime(onceAt)}`,
    enabled: true,
    carrier: 'browser',
    targetSelector: {
      mode: 'explicit',
      groupIds: [],
      targetIds: profileIds,
      skipAbnormalAccounts: false,
    },
    trigger: {
      mode: 'once',
      onceAt,
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      times: ['09:00'],
      timeZone: localTz(),
      jitterMinutes: 0,
      misfireGraceMinutes: 120,
    },
    prewarm: { enabled: false, leadMinutes: 90, steps: [] },
    steps: [step],
    closeWindowOnFinish: true,
    maxSafetyMinutesPerTarget: null,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  });
  return {
    scheduleId,
    schedState,
    created: schedState.schedules.find((s) => s.id === scheduleId) ?? null,
  };
}

export function formatLocalDateTime(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function parseFlexibleScheduleTime(raw: unknown, nowMs = Date.now()): ParsedScheduleTime {
  const res = (ms: number | null, rolledToNextDay = false): ParsedScheduleTime => ({
    scheduledAt: ms,
    scheduledAtLocal: formatLocalDateTime(ms),
    mode: ms !== null && ms > nowMs ? 'scheduled' : 'immediate',
    rolledToNextDay,
  });
  if (raw == null) return res(null);
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0)
      throw new Error('INVALID_SCHEDULE_TIME: 时间戳必须为正数');
    return res(raw < 10_000_000_000 ? Math.round(raw * 1000) : Math.round(raw));
  }
  if (typeof raw !== 'string') throw new Error('INVALID_SCHEDULE_TIME: 参数类型无效');
  const text = raw.trim();
  if (!text || /^(now|immediate|立即|马上)$/i.test(text)) return res(null);
  if (/^\d{10,13}$/.test(text)) return res(text.length === 10 ? Number(text) * 1000 : Number(text));
  const rel = /^\+(\d+)\s*(s|m|h|d)$/i.exec(text);
  const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  if (rel) return res(nowMs + Number(rel[1]) * (unitMs[(rel[2] ?? 'm').toLowerCase()] ?? 60_000));
  const b = new Date(nowMs);
  const clk =
    /^(?:(今天|今日|今晚|今夜|今早|today)|(明天|明日|明早|明晚|tomorrow)|(后天))?\s*(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?$/i.exec(
      text,
    );
  if (clk) {
    const [hh, mm, ss] = [Number(clk[4]), Number(clk[5]), clk[6] ? Number(clk[6]) : 0];
    if (hh > 23 || mm > 59 || ss > 59) throw new Error(`INVALID_SCHEDULE_TIME: 无效时钟 "${text}"`);
    const msAt = (d: number) =>
      new Date(b.getFullYear(), b.getMonth(), b.getDate() + d, hh, mm, ss, 0).getTime();
    const ms = msAt(clk[2] ? 1 : clk[3] ? 2 : 0);
    const rolled = !clk[1] && !clk[2] && !clk[3] && ms <= nowMs - 30_000;
    return res(rolled ? msAt(1) : ms, rolled);
  }
  const dt = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T\s]+(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?$/.exec(
    text,
  );
  if (dt) {
    const ms = new Date(
      Number(dt[1]),
      Number(dt[2]) - 1,
      Number(dt[3]),
      Number(dt[4]),
      Number(dt[5]),
      dt[6] ? Number(dt[6]) : 0,
    ).getTime();
    if (!Number.isFinite(ms)) throw new Error(`INVALID_SCHEDULE_TIME: 无效日期 "${text}"`);
    return res(ms);
  }
  const iso = Date.parse(text);
  if (Number.isFinite(iso) && iso > 0) return res(iso);
  throw new Error(`INVALID_SCHEDULE_TIME: 无法解析 "${text}"`);
}

export function resolveDataDirIntegrity(dataDir: string) {
  const configuredPath = path.resolve(dataDir);
  let realPath = configuredPath;
  try {
    realPath = (realpathSync.native ?? realpathSync)(configuredPath);
  } catch {}
  return {
    configuredPath,
    realPath,
    isVirtualizedSandbox: /\\AppData\\Local\\Packages\\[^\\]+\\LocalCache\\Roaming\\/i.test(
      realPath,
    ),
  };
}

export const okResult = (payload: Record<string, unknown>): McpToolCallResult => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  structuredContent: payload,
});
export const errorResult = (
  code: string,
  message: string,
  details?: Record<string, unknown>,
): McpToolCallResult => {
  const payload = { ok: false, errorCode: code, error: message, ...(details && { details }) };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
};

export async function buildEnrichedProfiles(
  deps: WorkbenchMcpDependencies,
): Promise<EnrichedProfileSummary[]> {
  const snapshot = await deps.workspaceService.snapshot();
  const groupMap = new Map(snapshot.groups.map((g) => [g.id, g.name]));
  const sessionMap = new Map(deps.agentBrowser.listSessions().map((s) => [s.profileId, s]));
  return Promise.all(
    snapshot.profiles.map(async (p) => {
      const peer = deps.core.peers.get(p.id);
      const unresolvedCount = (await deps.store.unresolved(p.id)).length;
      const busyModules = await deps.featureExecution.busyModuleLabels([p.id]);
      const live = deps.inspection?.get(p.id) ?? null;
      const [online, phase, synced] = [
        Boolean(peer?.online),
        peer?.phase ?? p.phase ?? 'OFFLINE',
        Boolean(peer?.synced),
      ];
      const [groupId, browserName] = [
        p.groupId ?? null,
        typeof p.browserName === 'string' ? p.browserName.trim() || null : null,
      ];
      return {
        id: p.id,
        alias: p.alias,
        browserName,
        displayName: profileDisplayName(p, p.id),
        groupId,
        groupName: groupId ? (groupMap.get(groupId) ?? null) : null,
        online,
        phase,
        synced,
        unresolvedCount,
        readyForTasks:
          online &&
          synced &&
          phase === 'PAUSED' &&
          unresolvedCount === 0 &&
          busyModules.length === 0,
        extensionVersion: peer?.extensionVersion ?? null,
        supportsAgentBrowser: Boolean(peer?.capabilities?.includes('agent-browser-kernel-v1')),
        busyModules,
        account: {
          ...pick(p.account, 'state id name'),
          hasLocalAvatar: isLocalAvatar(p.account.avatar),
        } as EnrichedProfileSummary['account'],
        liveInspection: live
          ? ({
              state: live.state,
              reason: live.reason,
              ...pick(live, 'checkedAt@'),
            } as EnrichedProfileSummary['liveInspection'])
          : null,
        agentBrowserSession: sessionMap.get(p.id) ?? null,
      };
    }),
  );
}

export const buildProfileDisplayNameMap = async (deps: WorkbenchMcpDependencies) =>
  new Map((await buildEnrichedProfiles(deps)).map((p) => [p.id, p.displayName]));

export function resolveEntityIdentifier<T extends { id: string }>(
  items: readonly T[],
  rawQuery: string,
  opts: {
    prefix: string;
    label: string;
    emptyMsg: string;
    emptyHints: string;
    isOnline?: (item: T) => boolean;
    exactFields: (item: T) => Array<string | null | undefined>;
    fuzzyFields?: (item: T) => Array<string | null | undefined>;
    formatLabel: (item: T) => string;
    formatHint?: (item: T) => string;
  },
): T {
  const query = rawQuery.trim();
  if (!query) throw new ProductError(`${opts.prefix}_ID_REQUIRED`, opts.emptyMsg, 400);
  const lower = query.toLowerCase();
  const byId = items.find((i) => i.id.toLowerCase() === lower);
  if (byId) return byId;
  const pickUnique = (matches: readonly T[]): T => {
    if (matches.length === 1 && matches[0]) return matches[0];
    const on = opts.isOnline ? matches.filter(opts.isOnline) : [];
    if (on.length === 1 && on[0]) return on[0];
    throw new ProductError(
      `AMBIGUOUS_${opts.prefix}_IDENTIFIER`,
      `标识 "${query}" 同时匹配到多个${opts.label}：${matches.slice(0, 6).map(opts.formatLabel).join('；')}`,
      409,
    );
  };
  const find = (fn: (item: T) => Array<string | null | undefined>, pred: (v: string) => boolean) =>
    items.filter((i) =>
      fn(i).some((v) => typeof v === 'string' && v.trim() && pred(v.trim().toLowerCase())),
    );
  const exact = find(opts.exactFields, (v) => v === lower);
  if (exact.length > 0) return pickUnique(exact);
  if (lower.length >= 2) {
    const fuzzy = find(opts.fuzzyFields ?? opts.exactFields, (v) => v.includes(lower));
    if (fuzzy.length > 0) return pickUnique(fuzzy);
  }
  const hints = (opts.isOnline ? items.filter(opts.isOnline) : items)
    .slice(0, 8)
    .map(opts.formatHint ?? opts.formatLabel)
    .join('；');
  throw new ProductError(
    `${opts.prefix}_NOT_FOUND`,
    `未找到匹配 "${query}" 的${opts.label}。${hints ? `可用：${hints}` : opts.emptyHints}`,
    404,
  );
}

export function resolveUniqueIds(
  rawQueries: readonly string[],
  resolveOne: (query: string) => string,
): string[] {
  const seen = new Set<string>();
  for (const raw of rawQueries) if (raw.trim()) seen.add(resolveOne(raw.trim()));
  return [...seen];
}

const fmtMatch = (
  title: string,
  id: string,
  acct: string | null | undefined,
  extra: string,
  full: boolean,
) =>
  `${title} (id=${id}${extra}${full ? `, account=${acct || '未知'}` : acct ? `, 账号=${acct}` : ''})`;

export const resolveProfileIdentifierFromList = (
  profiles: readonly EnrichedProfileSummary[],
  rawQuery: string,
) =>
  resolveEntityIdentifier(profiles, rawQuery, {
    prefix: 'PROFILE',
    label: '浏览器',
    emptyMsg: '浏览器标识不能为空',
    emptyHints: '当前无在线浏览器',
    isOnline: (p) => p.online,
    exactFields: (p) => [p.browserName, p.displayName, p.alias, p.account.name, p.account.id],
    formatLabel: (c) => fmtMatch(c.displayName, c.id, c.account.name, `, online=${c.online}`, true),
    formatHint: (p) => fmtMatch(p.displayName, p.id, p.account.name, '', false),
  }).id;

export const resolveProfileId = async (deps: WorkbenchMcpDependencies, rawQuery: string) =>
  resolveProfileIdentifierFromList(await buildEnrichedProfiles(deps), rawQuery);
export async function resolveProfileIds(
  deps: WorkbenchMcpDependencies,
  rawQueries: readonly string[],
) {
  if (rawQueries.length === 0) return [];
  const profiles = await buildEnrichedProfiles(deps);
  return resolveUniqueIds(rawQueries, (q) => resolveProfileIdentifierFromList(profiles, q));
}
export const optPids = (deps: WorkbenchMcpDependencies, args: Record<string, unknown>) => {
  const r = strArrArg(args.profileIds);
  return r.length > 0
    ? resolveProfileIds(deps, r)
    : Promise.resolve<string[] | undefined>(undefined);
};
export const reqSinglePid = async (
  deps: WorkbenchMcpDependencies,
  args: Record<string, unknown>,
) => {
  const raw = strArg(args.profileId);
  req(raw, 'PROFILE_ID_REQUIRED', '必须提供 profileId');
  return resolveProfileId(deps, raw);
};

const bsBase = (i: BluestacksInstance) => [
  bluestacksDisplayTitle(i),
  i.displayName,
  i.alias,
  i.instanceKey,
  i.accountName,
  i.accountId,
  i.serial,
];

export const resolveBluestacksInstanceIdentifierFromList = (
  instances: readonly BluestacksInstance[],
  rawQuery: string,
) =>
  resolveEntityIdentifier(instances, rawQuery, {
    prefix: 'BLUESTACKS_INSTANCE',
    label: '蓝蝶窗口',
    emptyMsg: '蓝蝶窗口标识不能为空',
    emptyHints: '当前无在线蓝蝶窗口',
    isOnline: (i) => i.online,
    exactFields: (i) => [...bsBase(i), String(i.adbPort), `:${i.adbPort}`],
    fuzzyFields: bsBase,
    formatLabel: (c) =>
      fmtMatch(
        bluestacksDisplayTitle(c),
        c.id,
        c.accountName,
        `, port=${c.adbPort}, online=${c.online}`,
        true,
      ),
    formatHint: (i) =>
      fmtMatch(bluestacksDisplayTitle(i), i.id, i.accountName, `, port=${i.adbPort}`, false),
  }).id;

export const resolveBluestacksInstanceIds = (
  instances: readonly BluestacksInstance[],
  rawQueries: readonly string[],
) =>
  rawQueries.length === 0
    ? []
    : resolveUniqueIds(rawQueries, (q) =>
        resolveBluestacksInstanceIdentifierFromList(instances, q),
      );
