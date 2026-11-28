import { z } from 'zod';
import { NonNegInt, sMax, strictObj } from './contracts.js';
import type {
  BrowserRiskLimitsState,
  DailyRiskActionKind,
  DailyRiskLimitSettings,
  DailyUsageOverview,
} from './daily-risk-limits.js';
export const ActivityStatsQuerySchema = strictObj({
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  carrier: z.enum(['all', 'browser', 'bluestacks']).default('all'),
  groupBy: z.enum(['profile', 'account']).default('profile'),
  search: sMax(200).default(''),
  onlyActive: z.boolean().default(false),
});
export type ActivityStatsQuery = z.input<typeof ActivityStatsQuerySchema>;
export const ActivitySummaryTotalsSchema = strictObj({
  posts: NonNegInt,
  pendingPosts: NonNegInt,
  groupBumps: NonNegInt,
  pageBumps: NonNegInt,
  bumps: NonNegInt,
  invites: NonNegInt,
  activeDurationMs: NonNegInt,
  activeLikes: NonNegInt,
  activeFriends: NonNegInt,
  failures: NonNegInt,
  totalActions: NonNegInt,
});
export type ActivitySummaryTotals = z.infer<typeof ActivitySummaryTotalsSchema>;
export const emptyActivityTotals = (): ActivitySummaryTotals => ({
  posts: 0,
  pendingPosts: 0,
  groupBumps: 0,
  pageBumps: 0,
  bumps: 0,
  invites: 0,
  activeDurationMs: 0,
  activeLikes: 0,
  activeFriends: 0,
  failures: 0,
  totalActions: 0,
});
export const AccountActivityRowSchema = strictObj({
  rowKey: z.string().min(1),
  carrier: z.enum(['browser', 'bluestacks', 'mixed']),
  profileId: z.string(),
  windowName: z.string(),
  accountId: z.string(),
  accountName: z.string(),
  accountAvatarUrl: z.string(),
  posts: NonNegInt,
  pendingPosts: NonNegInt,
  groupBumps: NonNegInt,
  pageBumps: NonNegInt,
  bumps: NonNegInt,
  invites: NonNegInt,
  activeDurationMs: NonNegInt,
  activeLikes: NonNegInt,
  activeFriends: NonNegInt,
  failures: NonNegInt,
  totalActions: NonNegInt,
  lastActiveAt: NonNegInt.nullable(),
  dailyLimitReached: z.boolean(),
  dailyLimitReason: z.string().nullable(),
  windowCount: z.number().int().min(1).optional(),
  mergedWindowNames: z.array(z.string()).optional(),
});
export type AccountActivityRow = z.infer<typeof AccountActivityRowSchema>;
export const ActivityStatsResponseSchema = strictObj({
  totals: ActivitySummaryTotalsSchema,
  rows: z.array(AccountActivityRowSchema),
});
export type ActivityStatsResponse = z.infer<typeof ActivityStatsResponseSchema>;
export function isUuidLike(raw: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.trim());
}
export function isExpiredFbCdnUrl(url: string, now = Date.now()): boolean {
  if (!url.startsWith('https://')) return false;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('.fbcdn.net')) return false;
    const oe = parsed.searchParams.get('oe');
    if (!oe || !/^[0-9a-f]+$/i.test(oe)) return false;
    const expMs = Number.parseInt(oe, 16) * 1000;
    return Number.isFinite(expMs) && expMs > 0 && expMs < now;
  } catch {
    return false;
  }
}
export function normalizeRecordAccountId(rawId: string): {
  accountId: string;
  extractedName: string;
} {
  const trimmed = rawId.trim();
  const match = /^[^\s(]+\s*\(([^()]+)\)$/.exec(trimmed);
  if (match) return { accountId: '', extractedName: (match[1] ?? '').trim() };
  return { accountId: trimmed, extractedName: '' };
}
export interface RecordDailyActivityInput {
  ymd?: string;
  carrier: 'browser' | 'bluestacks';
  profileId: string;
  accountId?: string;
  durationMsDelta?: number;
  likesDelta?: number;
  friendsDelta?: number;
  actionsDelta?: number;
  at?: number;
}
export interface ActivityStatsPort {
  queryStats(query?: ActivityStatsQuery): Promise<ActivityStatsResponse> | ActivityStatsResponse;
  recordDailyActivity(input: RecordDailyActivityInput): Promise<void> | void;
  getBrowserRiskLimits(): Promise<DailyRiskLimitSettings> | DailyRiskLimitSettings;
  saveBrowserRiskLimits(input: unknown): Promise<DailyRiskLimitSettings> | DailyRiskLimitSettings;
  browserDailyUsage(now?: number): Promise<DailyUsageOverview> | DailyUsageOverview;
  browserRiskLimitsState(now?: number): Promise<BrowserRiskLimitsState> | BrowserRiskLimitsState;
  checkBrowserRiskLimit(
    profileId: string,
    actionKind: DailyRiskActionKind,
    now?: number,
  ):
    | Promise<{ allowed: boolean; reason: string | null }>
    | { allowed: boolean; reason: string | null };
}
