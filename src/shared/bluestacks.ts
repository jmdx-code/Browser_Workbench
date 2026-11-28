import { z } from 'zod';
import {
  Id,
  boolF,
  boolT,
  intRange,
  optBool,
  sMax,
  sReq,
  strictObj,
  trimMax,
  trimReq,
} from './contracts.js';
import { parseRelativePostAge } from './relative-post-age.js';
import { BumperSettings, type BumperProfileStat } from './group-bumper.js';
import {
  DailyRiskActionKind,
  DailyRiskLimitOverrideSchema,
  DailyRiskLimitRuleSchema,
  DailyRiskLimitSettingsSchema,
  evaluateDailyRiskQuota,
  type DailyRiskLimitOverride,
} from './daily-risk-limits.js';
import { GroupIdString } from './group-inviter.js';
export const normalizeTotpSecret = (raw: string): string =>
  raw
    .replace(/[\s-]+/g, '')
    .trim()
    .toUpperCase();
export function isValidTotpSecret(raw: string): boolean {
  const clean = normalizeTotpSecret(raw);
  return Boolean(clean && /^[A-Z2-7]+={0,6}$/.test(clean) && clean.replace(/=+$/, '').length >= 8);
}
const TOTP_ERR_MSG = '2FA 密钥格式无效（需为至少 8 位 Base32 字符 A-Z / 2-7）';
const OptTotpSecret = trimMax(200)
  .refine((v) => !v || isValidTotpSecret(v), TOTP_ERR_MSG)
  .optional();
export const BluestacksLoginExistingPolicy = z.enum(['skip', 'clear-and-relogin']);
export type BluestacksLoginExistingPolicy = z.infer<typeof BluestacksLoginExistingPolicy>;
export const BluestacksBatchLoginItemStatus = z.enum([
  'queued',
  'running',
  'succeeded',
  'skipped',
  'verification',
  'restricted',
  'failed',
  'stopped',
]);
export type BluestacksBatchLoginItemStatus = z.infer<typeof BluestacksBatchLoginItemStatus>;
export const StartBluestacksBatchLoginInput = strictObj({
  items: z
    .array(
      strictObj({
        instanceId: Id,
        account: trimReq(200),
        password: sReq(200),
        totpSecret: OptTotpSecret,
      }),
    )
    .min(1)
    .max(200),
  maxConcurrency: intRange(1, 10).default(3),
  autoLaunch: boolT,
  autoInstallApk: boolT,
  ifAlreadyLoggedIn: BluestacksLoginExistingPolicy.default('skip'),
  saveLoginInfo: boolT,
  closeOnFinish: boolT,
});
export type StartBluestacksBatchLoginInput = z.infer<typeof StartBluestacksBatchLoginInput>;
interface BluestacksRunBase<T> {
  runId: string;
  running: boolean;
  startedAt: number;
  finishedAt: number | null;
  total: number;
  completed: number;
  statusText: string;
  items: T[];
}
export interface BluestacksBatchLoginItemProgress {
  instanceId: string;
  instanceName: string;
  maskedAccount: string;
  hasTotp: boolean;
  status: BluestacksBatchLoginItemStatus;
  stepText: string;
  accountName?: string;
  numericAccountId?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}
export interface BluestacksBatchLoginState extends BluestacksRunBase<BluestacksBatchLoginItemProgress> {
  succeeded: number;
  skipped: number;
  verification: number;
  restricted: number;
  failed: number;
  stopped: number;
}
export function maskLoginAccountLabel(account: string): string {
  const t = account.trim();
  if (!t) return '***';
  const atIdx = t.indexOf('@');
  if (atIdx > 0) {
    const local = t.slice(0, atIdx),
      domain = t.slice(atIdx);
    return local.length <= 2
      ? `${local[0] ?? '*'}***${domain}`
      : `${local.slice(0, 2)}***${local.slice(-1)}${domain}`;
  }
  return t.length <= 4
    ? `${t[0] ?? '*'}***`
    : t.length <= 8
      ? `${t.slice(0, 2)}***${t.slice(-2)}`
      : `${t.slice(0, 4)}***${t.slice(-2)}`;
}
const ACCOUNT_LABEL_RE =
    /^(?:账号|帐号|用户名|邮箱|手机|手机号|登录名|account|email|mail|phone|user|username|uid|id)\s*[:：]\s*(.+)$/i,
  PASSWORD_LABEL_RE = /^(?:密码|口令|登录密码|password|pass|pwd)\s*[:：]\s*(.+)$/i,
  TOTP_LABEL_RE =
    /^(?:totp|2fa|二步验证|双重验证|双重验证码|验证密钥|密钥|验证码密钥|secret|otp|fa|2fa密钥|totp密钥)\s*[:：]\s*(.+)$/i;
function splitDelimitedLine(line: string): string[] | null {
  for (const sep of ['\t', '----', '|', ';']) if (line.includes(sep)) return line.split(sep);
  if (!line.includes(',')) return null;
  const out: string[] = [];
  let current = '',
    inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(current);
      current = '';
    } else current += ch;
  }
  return (out.push(current), out);
}
export function parseBatchLoginText(raw: string): {
  entries: Array<{ lineNumber: number; account: string; password: string; totpSecret: string }>;
  errors: Array<{ lineNumber: number; reason: string }>;
} {
  const lines = raw.split(/\r?\n/),
    entries: Array<{ lineNumber: number; account: string; password: string; totpSecret: string }> =
      [],
    errors: Array<{ lineNumber: number; reason: string }> = [];
  let block: { startLine: number; account: string; password: string; totpSecret: string } | null =
    null;
  const pushEntry = (
      lineNumber: number,
      account: string,
      password: string,
      totpRaw: string,
      totpErrMsg: string,
    ) => {
      if (!account) return errors.push({ lineNumber, reason: '缺少账号字段' });
      if (!password) return errors.push({ lineNumber, reason: '缺少密码字段' });
      if (totpRaw && !isValidTotpSecret(totpRaw))
        return errors.push({ lineNumber, reason: totpErrMsg });
      entries.push({
        lineNumber,
        account,
        password,
        totpSecret: totpRaw ? normalizeTotpSecret(totpRaw) : '',
      });
    },
    flushBlock = () => {
      if (!block) return;
      const cur = block;
      block = null;
      if (cur.account || cur.password || cur.totpSecret)
        pushEntry(cur.startLine, cur.account, cur.password, cur.totpSecret, TOTP_ERR_MSG);
    },
    labelSpecs: Array<[RegExp, 'account' | 'password' | 'totpSecret', boolean]> = [
      [ACCOUNT_LABEL_RE, 'account', true],
      [PASSWORD_LABEL_RE, 'password', true],
      [TOTP_LABEL_RE, 'totpSecret', false],
    ];
  for (let idx = 0; idx < lines.length; idx++) {
    const lineNum = idx + 1,
      trimmed = (lines[idx] ?? '').trim();
    if (!trimmed) {
      flushBlock();
      continue;
    }
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    let matchedLabel = false;
    for (const [re, field, flushIfSet] of labelSpecs) {
      const m = re.exec(trimmed);
      if (m?.[1] !== undefined) {
        if (flushIfSet && block?.[field]) flushBlock();
        block ??= { startLine: lineNum, account: '', password: '', totpSecret: '' };
        block[field] = m[1].trim();
        matchedLabel = true;
        break;
      }
    }
    if (matchedLabel) continue;
    flushBlock();
    const cols = splitDelimitedLine(trimmed);
    if (!cols || cols.length < 2) {
      errors.push({
        lineNumber: lineNum,
        reason: '无法识别分隔符（支持 账号:/密码:/totp: 多行格式，或 | / Tab / ---- / ; / , 分隔）',
      });
      continue;
    }
    if (
      /^(?:账号|帐号|用户名|邮箱|手机|account|email|user|username|uid|id)$/.test(
        (cols[0] ?? '').trim().toLowerCase(),
      ) &&
      /^(?:密码|口令|password|pass|pwd)$/.test((cols[1] ?? '').trim().toLowerCase())
    )
      continue;
    const account = (cols[0] ?? '').trim(),
      password = (cols[1] ?? '').trim();
    if (!account || !password) {
      errors.push({ lineNumber: lineNum, reason: '账号或密码为空' });
      continue;
    }
    const extraCols = cols
        .slice(2)
        .map((c) => c.trim())
        .filter(Boolean),
      score = (s: string) => {
        const n = normalizeTotpSecret(s);
        return (n.length >= 16 ? 10 : 0) + (/[2-7]/.test(n) ? 5 : 0) + n.length / 100;
      },
      rawTotp =
        extraCols.length <= 1
          ? (extraCols[0] ?? '')
          : (extraCols.filter(isValidTotpSecret).sort((a, b) => score(b) - score(a))[0] ??
            extraCols[0] ??
            '');
    pushEntry(lineNum, account, password, rawTotp, `第 3 列 ${TOTP_ERR_MSG}`);
  }
  return (flushBlock(), { entries, errors });
}
export const BluestacksHealthCategory = z.enum([
  'healthy',
  'logged-out',
  'verification',
  'restricted',
  'missing-app',
  'landscape',
  'launch-failed',
  'skipped',
  'stopped',
]);
export type BluestacksHealthCategory = z.infer<typeof BluestacksHealthCategory>;
type BluestacksHealthCheckItemStatus = 'queued' | 'running' | 'done';
export const StartBluestacksHealthCheckInput = strictObj({
  instanceIds: z.array(Id).min(1, '请至少选择一个蓝蝶窗口').max(200),
  maxConcurrency: intRange(1, 10).default(3),
  autoLaunch: boolT,
  autoInstallApk: boolF,
  closeOnFinish: boolT,
});
export type StartBluestacksHealthCheckInput = z.infer<typeof StartBluestacksHealthCheckInput>;
export interface BluestacksHealthCheckItem {
  instanceId: string;
  instanceName: string;
  resolution: string;
  status: BluestacksHealthCheckItemStatus;
  category: BluestacksHealthCategory | null;
  stepText: string;
  error?: string;
  fbLiteVersion?: string | null;
  androidSdk?: number | null;
  identityType?: 'unknown' | 'personal' | 'page';
  accountName?: string;
  numericAccountId?: string;
  managedPageCount?: number;
  autoRepaired?: boolean;
  startedAt?: number;
  finishedAt?: number;
}
export interface BluestacksHealthCheckState extends BluestacksRunBase<BluestacksHealthCheckItem> {
  healthy: number;
  loggedOut: number;
  verification: number;
  restricted: number;
  missingApp: number;
  landscape: number;
  launchFailed: number;
  skipped: number;
  stopped: number;
  autoRepaired: number;
}
const HEALTH_LABELS: Record<BluestacksHealthCategory, string> = {
  healthy: '健康正常',
  'logged-out': '未登录',
  verification: '需安全验证',
  restricted: '已受限/封禁',
  'missing-app': '未装 FB Lite',
  landscape: '横屏需调整',
  'launch-failed': '启动/检测失败',
  skipped: '忙线跳过',
  stopped: '已手动停止',
};
export const healthCategoryLabel = (category: BluestacksHealthCategory | null): string =>
  category ? HEALTH_LABELS[category] : '检测中';
export function classifyHealthErrorMessage(
  message: string,
  fallbackAccountState?: string | null,
): BluestacksHealthCategory {
  if (/横屏/i.test(message)) return 'landscape';
  if (/未安装\s*FB\s*Lite/i.test(message)) return 'missing-app';
  if (/未登录|退出登录|logged-out/i.test(message)) return 'logged-out';
  if (/Checkpoint|安全验证|身份验证|手机验证/i.test(message)) return 'verification';
  if (/受限|停用|封禁|封号/i.test(message)) return 'restricted';
  return fallbackAccountState === 'verification' ||
    fallbackAccountState === 'restricted' ||
    fallbackAccountState === 'logged-out' ||
    fallbackAccountState === 'missing-app'
    ? fallbackAccountState
    : 'launch-failed';
}
export function formatBluestacksHealthReportText(state: BluestacksHealthCheckState): string {
  const header = [
    '【蓝蝶批量健康体检报表】',
    `总计: ${state.total} | 已完成: ${state.completed} | 健康: ${state.healthy} | 未登录: ${state.loggedOut} | 待验证: ${state.verification} | 受限: ${state.restricted} | 缺App: ${state.missingApp} | 横屏: ${state.landscape} | 失败: ${state.launchFailed}${state.autoRepaired > 0 ? ` | 自动装包修复: ${state.autoRepaired}` : ''}`,
    '---',
  ];
  return [
    ...header,
    ...state.items.map((item) => {
      const acct = item.accountName
        ? `${item.accountName}${item.numericAccountId ? ` (ID:${item.numericAccountId})` : ''}`
        : '-';
      return `${item.instanceName} | ${healthCategoryLabel(item.category)}${item.autoRepaired ? ' [已自动装包]' : ''} | ${acct} | ${item.resolution} | FB Lite ${item.fbLiteVersion ? `v${item.fbLiteVersion}` : '-'} | ${item.stepText}`;
    }),
  ].join('\n');
}
export const BluestacksRiskActionKind = DailyRiskActionKind;
export type BluestacksRiskActionKind = z.infer<typeof BluestacksRiskActionKind>;
const BluestacksRiskLimitRule = DailyRiskLimitRuleSchema;
type BluestacksRiskLimitRule = z.infer<typeof BluestacksRiskLimitRule>;
export const BluestacksRiskLimitOverride = DailyRiskLimitOverrideSchema;
export type BluestacksRiskLimitOverride = DailyRiskLimitOverride;
export const BluestacksRiskLimitSettings = DailyRiskLimitRuleSchema.extend({
  enabled: DailyRiskLimitSettingsSchema.shape.enabled,
  perInstanceOverrides: z.record(z.string(), BluestacksRiskLimitOverride).default({}),
}).strict();
export type BluestacksRiskLimitSettings = z.infer<typeof BluestacksRiskLimitSettings>;
export const DEFAULT_BLUESTACKS_RISK_LIMIT_SETTINGS: BluestacksRiskLimitSettings =
  BluestacksRiskLimitSettings.parse({});
export interface BluestacksRawDailyCounts {
  groupBumpsToday: number;
  pageBumpsToday: number;
  postsToday: number;
  invitesToday: number;
  activeLikesToday: number;
  activeActionsToday: number;
}
export interface BluestacksDailyInstanceStats extends BluestacksRawDailyCounts {
  instanceId: string;
  totalActionsToday: number;
  effectiveLimits: BluestacksRiskLimitRule;
  hasOverride: boolean;
  limitReached: boolean;
  limitReason: string | null;
}
export interface BluestacksDailyUsageOverview {
  dateYmd: string;
  totalGroupBumps: number;
  totalPageBumps: number;
  totalPosts: number;
  totalInvites: number;
  totalActiveLikes: number;
  totalActions: number;
  reachedLimitInstances: number;
  perInstance: Record<string, BluestacksDailyInstanceStats>;
}
export const evaluateBluestacksRiskQuota = (
  settings: BluestacksRiskLimitSettings,
  instanceId: string,
  counts: BluestacksRawDailyCounts,
  actionKind?: BluestacksRiskActionKind,
) =>
  evaluateDailyRiskQuota(
    settings,
    settings.perInstanceOverrides,
    instanceId,
    counts,
    actionKind,
    '蓝蝶风控',
  );
export const BluestacksAccountState = z.enum([
  'unknown',
  'logged-in',
  'logged-out',
  'missing-app',
  'restricted',
  'verification',
]);
export type BluestacksAccountState = z.infer<typeof BluestacksAccountState>;
export const BluestacksIdentityType = z.enum(['unknown', 'personal', 'page']);
export type BluestacksIdentityType = z.infer<typeof BluestacksIdentityType>;
export const BluestacksManagedIdentitySchema = strictObj({
  name: trimReq(200),
  identityType: z.enum(['personal', 'page']),
  active: z.boolean(),
});
export type BluestacksManagedIdentity = z.infer<typeof BluestacksManagedIdentitySchema>;
export const BluestacksInstanceSchema = strictObj({
  id: Id,
  instanceKey: trimReq(120),
  displayName: trimReq(200),
  alias: trimMax(80).nullable(),
  folderId: Id.nullable(),
  sortOrder: z.number().int(),
  adbPort: intRange(1, 65535),
  serial: trimReq(120),
  fbWidth: intRange(100, 8000),
  fbHeight: intRange(100, 8000),
  online: z.boolean(),
  fbLiteInstalled: optBool.nullable(),
  accountState: BluestacksAccountState,
  accountId: sMax(300),
  accountName: sMax(200),
  avatarUrl: z.string().nullable(),
  lastStatus: sMax(300).nullable(),
  updatedAt: z.number().int(),
  identityType: BluestacksIdentityType.optional(),
  numericAccountId: sMax(64).optional(),
  managedIdentities: z.array(BluestacksManagedIdentitySchema).max(50).optional(),
  androidSdk: intRange(1, 99).nullable().optional(),
  fbLiteVersion: sMax(64).nullable().optional(),
});
export type BluestacksInstance = z.infer<typeof BluestacksInstanceSchema>;
export const BluestacksFolderSchema = strictObj({
  id: Id,
  name: trimReq(80),
  sortOrder: z.number().int(),
});
export type BluestacksFolder = z.infer<typeof BluestacksFolderSchema>;
const OptPath = trimMax(500).nullable(),
  OptApkPath = trimMax(600).nullable();
export interface BluestacksRuntimeConfig {
  installDir: string | null;
  confPath: string | null;
  detectedInstallDir: string | null;
  detectedConfPath: string | null;
  adbReady: boolean;
  playerReady: boolean;
  apkPath?: string | null;
  detectedApkPath?: string | null;
}
export const UpdateBluestacksPathsInput = strictObj({
  installDir: OptPath.optional(),
  confPath: OptPath.optional(),
  apkPath: OptApkPath.optional(),
});
export type UpdateBluestacksPathsInput = z.infer<typeof UpdateBluestacksPathsInput>;
const bsIds = z.array(Id).min(1).max(200),
  bsTargetIds = z.array(GroupIdString).min(1).max(500);
export const BluestacksInstanceIdsInput = strictObj({ instanceIds: bsIds });
export const BluestacksShowInstanceInput = strictObj({ instanceId: Id });
export const BluestacksArrangeWindowsInput = strictObj({
  instanceIds: z.array(Id).max(200).optional(),
  columns: intRange(1, 10).optional(),
  gap: intRange(0, 48).optional(),
  monitorBounds: strictObj({
    left: intRange(-100000, 100000),
    top: intRange(-100000, 100000),
    width: intRange(100, 20000),
    height: intRange(100, 20000),
  }).optional(),
});
export const BluestacksInstallApkInput = strictObj({
  instanceIds: bsIds,
  apkPath: trimMax(600).optional(),
});
export const BluestacksSwitchIdentityInput = strictObj({
  instanceId: Id,
  targetName: trimReq(200).optional(),
  targetType: z.enum(['personal', 'page']).optional(),
});
export const BluestacksLoginInput = strictObj({
  instanceId: Id,
  account: trimReq(200),
  password: z.string().min(1).max(200),
  totpSecret: OptTotpSecret,
  saveLoginInfo: z.boolean().optional(),
  ifAlreadyLoggedIn: BluestacksLoginExistingPolicy.optional(),
});
export type BluestacksLoginInput = z.infer<typeof BluestacksLoginInput>;
export const BluestacksQuickActiveStepType = z.enum([
  'feed',
  'video',
  'marketplace',
  'friends',
  'post',
  'story',
]);
export type BluestacksQuickActiveStepType = z.infer<typeof BluestacksQuickActiveStepType>;
export const StartBluestacksActiveInput = strictObj({
  instanceIds: bsIds,
  combinationId: Id.optional(),
  closeWindowOnFinish: z.boolean().optional(),
  quickStep: strictObj({
    type: BluestacksQuickActiveStepType,
    durationMinutes: z.number().min(0.2).max(120).optional(),
    maxLikes: intRange(0, 50).optional(),
    maxAccepts: intRange(0, 50).optional(),
    caption: z.string().max(4000).optional(),
    mediaPath: z.string().max(600).optional(),
    background: z.string().max(40).optional(),
  }).optional(),
}).refine((v) => Boolean(v.combinationId || v.quickStep), '请指定活跃任务组合或单步活跃动作');
export type StartBluestacksActiveInput = z.infer<typeof StartBluestacksActiveInput>;
export const StartBluestacksPosterInput = strictObj({
  instanceIds: bsIds,
  materialIds: z.array(Id).min(1).max(100),
  groupIds: z.array(GroupIdString).max(500).default([]),
  maxGroupsPerInstance: intRange(1, 50).default(3),
  postToTimeline: z.boolean().default(false),
  closeWindowOnFinish: boolF,
}).refine((v) => v.groupIds.length > 0 || v.postToTimeline, '请至少选择一个目标小组或开启发时间线');
export type StartBluestacksPosterInput = z.infer<typeof StartBluestacksPosterInput>;
export const StartBluestacksInviterInput = strictObj({
  instanceIds: bsIds,
  groupIds: bsTargetIds,
  invitesPerGroup: intRange(1, 50).default(5),
  closeWindowOnFinish: boolF,
});
export type StartBluestacksInviterInput = z.infer<typeof StartBluestacksInviterInput>;
export type BluestacksWorkerKind =
  | 'group-bumper'
  | 'page-bumper'
  | 'active'
  | 'poster'
  | 'inviter'
  | 'sheets-bumper'
  | 'sheets-poster'
  | 'batch-login'
  | 'health-check';
export interface BluestacksModuleProfileStat {
  running: boolean;
  status: string;
  session: number;
  today: number;
  combinationId?: string | null | undefined;
  closeOnFinish?: boolean | undefined;
  steps?: Array<{ label: string; state: 'done' | 'running' | 'pending' }> | undefined;
}
export const CreateBluestacksFolderInput = strictObj({ name: trimReq(80) });
export const RenameBluestacksFolderInput = strictObj({ id: Id, name: trimReq(80) });
export const DeleteBluestacksFolderInput = strictObj({ id: Id });
export const ReorderBluestacksFoldersInput = strictObj({ ids: z.array(Id).max(200) });
export const RenameBluestacksInstanceInput = strictObj({ id: Id, alias: trimMax(80).nullable() });
export const ReorderBluestacksInstancesInput = strictObj({
  folderId: Id.nullable(),
  ids: z.array(Id).max(500),
});
export const BluestacksBumperMode = z.enum(['group', 'page']);
export type BluestacksBumperMode = z.infer<typeof BluestacksBumperMode>;
export const StartBluestacksBumperInput = strictObj({
  profileIds: bsIds,
  groupIds: bsTargetIds,
  pageIds: bsTargetIds,
  closeWindowOnFinish: boolF,
});
export const StartBluestacksPageBumperInput = strictObj({
  profileIds: bsIds,
  pageIds: bsTargetIds,
  closeWindowOnFinish: boolF,
});
export const StopBluestacksBumperInput = strictObj({ profileIds: bsIds.optional() });
export interface BluestacksState {
  instances: BluestacksInstance[];
  folders: BluestacksFolder[];
  config: BluestacksRuntimeConfig;
  bumperSettings: BumperSettings;
  pageBumperSettings: BumperSettings;
  running: boolean;
  pageBumperRunning: boolean;
  activeRunning?: boolean;
  posterRunning?: boolean;
  inviterRunning?: boolean;
  launchingIds: string[];
  closingIds: string[];
  inspectingIds: string[];
  installingIds?: string[];
  loggingInIds?: string[];
  switchingIds?: string[];
  statusText: string;
  pageBumperStatusText: string;
  activeStatusText?: string;
  posterStatusText?: string;
  inviterStatusText?: string;
  profileCounts: Record<string, BumperProfileStat>;
  pageBumperProfileCounts: Record<string, BumperProfileStat>;
  activeProfileCounts?: Record<string, BluestacksModuleProfileStat>;
  posterProfileCounts?: Record<string, BluestacksModuleProfileStat>;
  inviterProfileCounts?: Record<string, BluestacksModuleProfileStat>;
  total: number;
  pageTotal: number;
  batchLogin?: BluestacksBatchLoginState | null;
  healthCheck?: BluestacksHealthCheckState | null;
  riskLimitSettings?: BluestacksRiskLimitSettings;
  dailyUsage?: BluestacksDailyUsageOverview;
}
const COMPOSITE_BS_RE =
  /^(?:p\d{1,4}|pie\d*\S*|nougat\d*\S*|rvc\d*\S*|bluestacks[^()]*|蓝蝶\s*#?\S*)\s*\([^()]+\)$/i;
const PLACEHOLDER_BS_RE = /^(?:fb\s*lite|facebook|meta|menu|菜单|菜單|未知|unknown)$/i;
export function isCompositePlaceholderBsAccountId(
  value: string | null | undefined,
  displayName?: string | null,
  instanceKey?: string | null,
): boolean {
  const t = value?.trim() ?? '';
  if (!t) return false;
  const lo = t.toLowerCase();
  return (
    [displayName, instanceKey].some((s) => {
      const l = s?.trim().toLowerCase();
      return Boolean(l && (lo === l || (lo.startsWith(`${l} (`) && t.endsWith(')'))));
    }) ||
    /\((?:fb\s*lite)\)$/i.test(t) ||
    COMPOSITE_BS_RE.test(t) ||
    PLACEHOLDER_BS_RE.test(t) ||
    /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(t)
  );
}
export const resolveEffectiveBsAccountId = (
  inst: Pick<BluestacksInstance, 'id' | 'accountId' | 'numericAccountId'> &
    Partial<Pick<BluestacksInstance, 'displayName' | 'instanceKey'>>,
): string =>
  [inst.numericAccountId, inst.accountId]
    .map((v) => v?.trim() ?? '')
    .find((v) => v && !isCompositePlaceholderBsAccountId(v, inst.displayName, inst.instanceKey)) ||
  inst.id;
export function isBluestacksPortraitResolution(fbWidth: number, fbHeight: number): boolean {
  return fbWidth > 0 && fbHeight > fbWidth;
}
export function bluestacksDisplayTitle(
  instance: Pick<BluestacksInstance, 'alias' | 'displayName' | 'instanceKey'>,
): string {
  const alias = instance.alias?.trim();
  if (alias) return alias;
  const raw = instance.displayName.trim();
  const bsMatch = /^BlueStacks\s+App\s+Player(?:\s+(\d+))?$/i.exec(raw);
  return bsMatch ? (bsMatch[1] ? `蓝蝶 #${bsMatch[1]}` : '蓝蝶 #主') : raw || instance.instanceKey;
}
// Stage 1 compatibility wrapper: preserves BlueStacks 0.02h just-now expectation in bluestacks.test.ts:83 until Stage 2 aligns it to 0.
export function relativePostAge(text: string, now = Date.now()): number | null {
  return parseRelativePostAge(text, now, 0.02);
}
const cleanMatch = (s: string, re: RegExp) => s.toLowerCase().replace(re, '').trim();
const normalizeNameForMatch = (s: string): string =>
  cleanMatch(s, /[\s·•.,，。!！?？'"“”‘’()（）[\]【】\-_/\\|]+/g);
export const extractOcrReadableText = (s: string): string =>
  cleanMatch(s, /[^a-z0-9\u4e00-\u9fa5]+/g);
export const hasUnsupportedOcrScript = (s: string): boolean =>
  /[\u0900-\u109f\u1780-\u17ff]/u.test(s);
function bigramDice(na: string, nb: string): number {
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) {
    const minLen = Math.min(na.length, nb.length);
    const ratio = minLen / Math.max(na.length, nb.length);
    if (minLen >= 2) return Math.max(minLen >= 4 ? 0.88 : 0.8, ratio);
  }
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0;
  const bigrams = (str: string) => {
    const map = new Map<string, number>();
    for (let i = 0; i < str.length - 1; i++) {
      const bg = str.slice(i, i + 2);
      map.set(bg, (map.get(bg) ?? 0) + 1);
    }
    return map;
  };
  const ba = bigrams(na),
    bb = bigrams(nb);
  let overlap = 0;
  for (const [k, c] of ba) overlap += Math.min(c, bb.get(k) ?? 0);
  return (2 * overlap) / (na.length + nb.length - 2);
}
export function nameSimilarity(a: string, b: string): number {
  const fullSim = bigramDice(normalizeNameForMatch(a), normalizeNameForMatch(b));
  const ra = extractOcrReadableText(a),
    rb = extractOcrReadableText(b);
  return ra.length >= 3 && rb.length >= 3 ? Math.max(fullSim, bigramDice(ra, rb)) : fullSim;
}
