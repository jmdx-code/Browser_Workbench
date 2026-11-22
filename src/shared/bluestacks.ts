import { z } from 'zod';
import { Id } from './contracts.js';
import {
  BluestacksLoginExistingPolicy,
  type BluestacksBatchLoginState,
} from './bluestacks-batch-login.js';
import type { BluestacksHealthCheckState } from './bluestacks-health-check.js';
import type {
  BluestacksDailyUsageOverview,
  BluestacksRiskLimitSettings,
} from './bluestacks-risk.js';
import { BumperSettings, type BumperDailyStat, type BumperProfileStat } from './group-bumper.js';
import { GroupIdString } from './group-inviter.js';
export * from './bluestacks-batch-login.js';
export * from './bluestacks-health-check.js';
export * from './bluestacks-risk.js';

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

export const BluestacksManagedIdentitySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    identityType: z.enum(['personal', 'page']),
    active: z.boolean(),
  })
  .strict();
export type BluestacksManagedIdentity = z.infer<typeof BluestacksManagedIdentitySchema>;

export const BluestacksInstanceSchema = z
  .object({
    id: Id,
    instanceKey: z.string().trim().min(1).max(120),
    displayName: z.string().trim().min(1).max(200),
    alias: z.string().trim().max(80).nullable(),
    folderId: z.uuid().nullable(),
    sortOrder: z.number().int(),
    adbPort: z.number().int().min(1).max(65535),
    serial: z.string().trim().min(1).max(120),
    fbWidth: z.number().int().min(100).max(8000),
    fbHeight: z.number().int().min(100).max(8000),
    online: z.boolean(),
    fbLiteInstalled: z.boolean().nullable(),
    accountState: BluestacksAccountState,
    accountId: z.string().max(300),
    accountName: z.string().max(200),
    avatarUrl: z.string().nullable(),
    lastStatus: z.string().max(300).nullable(),
    updatedAt: z.number().int(),
    identityType: BluestacksIdentityType.optional(),
    numericAccountId: z.string().max(64).optional(),
    managedIdentities: z.array(BluestacksManagedIdentitySchema).max(50).optional(),
    androidSdk: z.number().int().min(1).max(99).nullable().optional(),
    fbLiteVersion: z.string().max(64).nullable().optional(),
  })
  .strict();
export type BluestacksInstance = z.infer<typeof BluestacksInstanceSchema>;

export const BluestacksFolderSchema = z
  .object({
    id: Id,
    name: z.string().trim().min(1).max(80),
    sortOrder: z.number().int(),
  })
  .strict();
export type BluestacksFolder = z.infer<typeof BluestacksFolderSchema>;

export const BluestacksRuntimeConfigSchema = z
  .object({
    installDir: z.string().trim().max(500).nullable(),
    confPath: z.string().trim().max(500).nullable(),
    detectedInstallDir: z.string().trim().max(500).nullable(),
    detectedConfPath: z.string().trim().max(500).nullable(),
    adbReady: z.boolean(),
    playerReady: z.boolean(),
    apkPath: z.string().trim().max(600).nullable().optional(),
    detectedApkPath: z.string().trim().max(600).nullable().optional(),
  })
  .strict();
export type BluestacksRuntimeConfig = z.infer<typeof BluestacksRuntimeConfigSchema>;

export const UpdateBluestacksPathsInput = z
  .object({
    installDir: z.string().trim().max(500).nullable().optional(),
    confPath: z.string().trim().max(500).nullable().optional(),
    apkPath: z.string().trim().max(600).nullable().optional(),
  })
  .strict();
export type UpdateBluestacksPathsInput = z.infer<typeof UpdateBluestacksPathsInput>;

export const BluestacksInstanceIdsInput = z
  .object({
    instanceIds: z.array(Id).min(1).max(200),
  })
  .strict();

export const BluestacksShowInstanceInput = z
  .object({
    instanceId: Id,
  })
  .strict();

export const BluestacksArrangeWindowsInput = z
  .object({
    instanceIds: z.array(Id).max(200).optional(),
    columns: z.number().int().min(1).max(10).optional(),
    gap: z.number().int().min(0).max(40).optional(),
  })
  .strict();

export const BluestacksInstallApkInput = z
  .object({
    instanceIds: z.array(Id).min(1).max(200),
    apkPath: z.string().trim().max(600).optional(),
  })
  .strict();

export const BluestacksSwitchIdentityInput = z
  .object({
    instanceId: Id,
    targetName: z.string().trim().min(1).max(200).optional(),
    targetType: z.enum(['personal', 'page']).optional(),
  })
  .strict();

export const BluestacksLoginInput = z
  .object({
    instanceId: Id,
    account: z.string().trim().min(1).max(200),
    password: z.string().min(1).max(200),
    totpSecret: z.string().trim().max(200).optional(),
    saveLoginInfo: z.boolean().optional(),
    ifAlreadyLoggedIn: BluestacksLoginExistingPolicy.optional(),
  })
  .strict();
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

export const StartBluestacksActiveInput = z
  .object({
    instanceIds: z.array(Id).min(1).max(200),
    combinationId: Id.optional(),
    quickStep: z
      .object({
        type: BluestacksQuickActiveStepType,
        durationMinutes: z.number().min(0.2).max(120).optional(),
        maxLikes: z.number().int().min(0).max(50).optional(),
        maxAccepts: z.number().int().min(0).max(50).optional(),
        caption: z.string().max(4000).optional(),
        mediaPath: z.string().max(600).optional(),
        background: z.string().max(40).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => Boolean(v.combinationId || v.quickStep), {
    message: '请指定活跃任务组合或单步活跃动作',
  });
export type StartBluestacksActiveInput = z.infer<typeof StartBluestacksActiveInput>;

export const StartBluestacksPosterInput = z
  .object({
    instanceIds: z.array(Id).min(1).max(200),
    materialIds: z.array(Id).min(1).max(100),
    groupIds: z.array(GroupIdString).max(500).default([]),
    maxGroupsPerInstance: z.number().int().min(1).max(50).default(3),
    postToTimeline: z.boolean().default(false),
  })
  .strict()
  .refine((v) => v.groupIds.length > 0 || v.postToTimeline, {
    message: '请至少选择一个目标小组或开启发时间线',
  });
export type StartBluestacksPosterInput = z.infer<typeof StartBluestacksPosterInput>;

export const StartBluestacksInviterInput = z
  .object({
    instanceIds: z.array(Id).min(1).max(200),
    groupIds: z.array(GroupIdString).min(1).max(500),
    invitesPerGroup: z.number().int().min(1).max(50).default(5),
  })
  .strict();
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
}

export const CreateBluestacksFolderInput = z
  .object({
    name: z.string().trim().min(1).max(80),
  })
  .strict();

export const RenameBluestacksFolderInput = z
  .object({
    id: Id,
    name: z.string().trim().min(1).max(80),
  })
  .strict();

export const DeleteBluestacksFolderInput = z
  .object({
    id: Id,
  })
  .strict();

export const ReorderBluestacksFoldersInput = z
  .object({
    ids: z.array(Id).max(200),
  })
  .strict();

export const RenameBluestacksInstanceInput = z
  .object({
    id: Id,
    alias: z.string().trim().max(80).nullable(),
  })
  .strict();

export const ReorderBluestacksInstancesInput = z
  .object({
    folderId: Id.nullable(),
    ids: z.array(Id).max(500),
  })
  .strict();

export const BluestacksBumperMode = z.enum(['group', 'page']);
export type BluestacksBumperMode = z.infer<typeof BluestacksBumperMode>;

export const StartBluestacksBumperInput = z
  .object({
    profileIds: z.array(Id).min(1).max(200),
    groupIds: z.array(GroupIdString).min(1).max(500),
    pageIds: z.array(GroupIdString).min(1).max(500),
  })
  .strict();

export const StartBluestacksPageBumperInput = z
  .object({
    profileIds: z.array(Id).min(1).max(200),
    pageIds: z.array(GroupIdString).min(1).max(500),
  })
  .strict();

export const StopBluestacksBumperInput = z
  .object({
    profileIds: z.array(Id).min(1).max(200).optional(),
  })
  .strict();

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
  dailyStats: BumperDailyStat[];
  pageDailyStats: BumperDailyStat[];
  batchLogin?: BluestacksBatchLoginState | null;
  healthCheck?: BluestacksHealthCheckState | null;
  riskLimitSettings?: BluestacksRiskLimitSettings;
  dailyUsage?: BluestacksDailyUsageOverview;
}

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
  if (bsMatch) {
    return bsMatch[1] ? `蓝蝶 #${bsMatch[1]}` : '蓝蝶 #主';
  }
  return raw || instance.instanceKey;
}

export function relativePostAge(text: string, now = Date.now()): number | null {
  const raw = text
    .replace(/[·•*。‧・+]/g, ' | ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!raw) return null;

  const cleaned = raw
    .replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/gu, '$1')
    .replace(/(\d)\s+(?=[\u4e00-\u9fa5a-z])/gu, '$1')
    .replace(/([\u4e00-\u9fa5])\s+(?=\d)/gu, '$1');

  if (/(?:just\s*now|刚刚|剛剛|則則|则则)/u.test(cleaned)) return 0.02;
  if (/(?:yesterday|昨天)/u.test(cleaned)) return 24;

  const mdMatch =
    /(?:^|\D)(1[0-2]|0?[1-9])(?:月|[8b])([12]\d|3[01]|0?[1-9])(?:日|号|號|[80b])(?:\D|$)/iu.exec(
      cleaned,
    );
  if (mdMatch) {
    const d = new Date(now);
    const target = new Date(d.getFullYear(), Number(mdMatch[1]) - 1, Number(mdMatch[2]));
    if (target.getTime() > now) target.setFullYear(d.getFullYear() - 1);
    return Math.max(24, (now - target.getTime()) / 3600000);
  }

  const match =
    /(?:^|\D)(\d{1,3}(?:\.\d+)?)\s*(m|min(?:ute)?s?|分钟|分鐘|分|h|hr|hours?|(?:[刂小]\s*[、丶]?\s*)?(?:小时|小時|时|時)|d|days?|天|日|w|wk|weeks?|周|週)(?![a-z])/iu.exec(
      cleaned,
    );
  if (match) {
    const num = Number(match[1]);
    const unit = match[2] ?? '';
    if (/^(?:m|min|分钟|分鐘|分)/i.test(unit)) return num / 60;
    if (/^(?:h|hr|hour|[刂小]|小时|小時|时|時)/i.test(unit)) return num;
    if (/^(?:w|wk|week|周|週)/i.test(unit)) return num * 24 * 7;
    return num * 24;
  }

  const enMdMatch = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/i.exec(
    raw,
  );
  if (enMdMatch && enMdMatch[1]) {
    const months = [
      'jan',
      'feb',
      'mar',
      'apr',
      'may',
      'jun',
      'jul',
      'aug',
      'sep',
      'oct',
      'nov',
      'dec',
    ];
    const mIdx = months.indexOf(enMdMatch[1].slice(0, 3).toLowerCase());
    if (mIdx >= 0) {
      const d = new Date(now);
      const target = new Date(d.getFullYear(), mIdx, Number(enMdMatch[2]));
      if (target.getTime() > now) target.setFullYear(d.getFullYear() - 1);
      return Math.max(24, (now - target.getTime()) / 3600000);
    }
  }

  return null;
}

export function normalizeNameForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s·•.,，。!！?？'"“”‘’()（）[\]【】\-_/\\|]+/g, '')
    .trim();
}

export function extractOcrReadableText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
    .trim();
}

export function hasUnsupportedOcrScript(s: string): boolean {
  return /[\u0900-\u109f\u1780-\u17ff]/u.test(s);
}

function bigramDice(na: string, nb: string): number {
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) {
    const minLen = Math.min(na.length, nb.length);
    const maxLen = Math.max(na.length, nb.length);
    if (minLen >= 4) return Math.max(0.88, minLen / maxLen);
    if (minLen >= 2) return Math.max(0.8, minLen / maxLen);
  }
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0;
  const bigrams = (str: string) => {
    const set = new Map<string, number>();
    for (let i = 0; i < str.length - 1; i++) {
      const bg = str.slice(i, i + 2);
      set.set(bg, (set.get(bg) ?? 0) + 1);
    }
    return set;
  };
  const ba = bigrams(na);
  const bb = bigrams(nb);
  let overlap = 0;
  for (const [k, countA] of ba) {
    const countB = bb.get(k) ?? 0;
    overlap += Math.min(countA, countB);
  }
  return (2 * overlap) / (na.length - 1 + (nb.length - 1));
}

export function nameSimilarity(a: string, b: string): number {
  const fullSim = bigramDice(normalizeNameForMatch(a), normalizeNameForMatch(b));
  const ra = extractOcrReadableText(a);
  const rb = extractOcrReadableText(b);
  if (ra.length >= 3 && rb.length >= 3) {
    const readableSim = bigramDice(ra, rb);
    return Math.max(fullSim, readableSim);
  }
  return fullSim;
}
