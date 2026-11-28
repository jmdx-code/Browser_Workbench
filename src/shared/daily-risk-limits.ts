import { z } from 'zod';
import { intRange, strictObj } from './contracts.js';
export const DailyRiskActionKind = z.enum([
  'bump',
  'post',
  'invite',
  'active-like',
  'active-friend',
]);
export type DailyRiskActionKind = z.infer<typeof DailyRiskActionKind>;
export type CheckDailyRiskLimitFn = (
  profileId: string,
  actionKind: DailyRiskActionKind,
) =>
  | Promise<{ allowed: boolean; reason: string | null }>
  | { allowed: boolean; reason: string | null };
export const DailyRiskLimitRuleSchema = strictObj({
  dailyMaxTotalActions: intRange(0, 2000).default(60),
  dailyMaxBumps: intRange(0, 500).default(30),
  dailyMaxPosts: intRange(0, 200).default(10),
  dailyMaxInvites: intRange(0, 300).default(20),
  dailyMaxActiveLikes: intRange(0, 300).default(25),
});
export type DailyRiskLimitRule = z.infer<typeof DailyRiskLimitRuleSchema>;
export const DailyRiskLimitOverrideSchema = DailyRiskLimitRuleSchema.partial().strict();
export type DailyRiskLimitOverride = z.infer<typeof DailyRiskLimitOverrideSchema>;
export const DailyRiskLimitSettingsSchema = DailyRiskLimitRuleSchema.extend({
  enabled: z.boolean().default(true),
  perTargetOverrides: z.record(z.string(), DailyRiskLimitOverrideSchema).default({}),
}).strict();
export type DailyRiskLimitSettings = z.infer<typeof DailyRiskLimitSettingsSchema>;
export const DEFAULT_DAILY_RISK_LIMIT_SETTINGS: DailyRiskLimitSettings =
  DailyRiskLimitSettingsSchema.parse({});
export interface DailyActionCountInput {
  groupBumpsToday: number;
  pageBumpsToday: number;
  postsToday: number;
  invitesToday: number;
  activeLikesToday: number;
  activeActionsToday?: number;
  activeFriendsToday?: number;
}
export type RawDailyActionCounts = Omit<DailyActionCountInput, 'activeActionsToday'> & {
  activeActionsToday: number;
};
export const ZERO_DAILY_ACTION_COUNTS: RawDailyActionCounts = {
  groupBumpsToday: 0,
  pageBumpsToday: 0,
  postsToday: 0,
  invitesToday: 0,
  activeLikesToday: 0,
  activeActionsToday: 0,
};
/** Single unified formula for total daily actions across risk limits and stats views (no double-counting of activeLikesToday). */
export function computeTotalDailyActions(counts: DailyActionCountInput): number {
  const activeTotal = Math.max(
    counts.activeActionsToday ?? 0,
    counts.activeLikesToday + (counts.activeFriendsToday ?? 0),
  );
  return (
    counts.groupBumpsToday +
    counts.pageBumpsToday +
    counts.postsToday +
    counts.invitesToday +
    activeTotal
  );
}
const nonNegInt = z.number().int().nonnegative();
export const TargetDailyUsageSchema = strictObj({
  targetId: z.string(),
  groupBumpsToday: nonNegInt,
  pageBumpsToday: nonNegInt,
  postsToday: nonNegInt,
  invitesToday: nonNegInt,
  activeLikesToday: nonNegInt,
  activeActionsToday: nonNegInt,
  activeFriendsToday: nonNegInt.optional(),
  totalActionsToday: nonNegInt,
  effectiveLimits: DailyRiskLimitRuleSchema,
  hasOverride: z.boolean(),
  limitReached: z.boolean(),
  limitReason: z.string().nullable(),
});
export type TargetDailyUsage = z.infer<typeof TargetDailyUsageSchema>;
export const DailyUsageOverviewSchema = strictObj({
  dateYmd: z.string(),
  totalGroupBumps: nonNegInt,
  totalPageBumps: nonNegInt,
  totalPosts: nonNegInt,
  totalInvites: nonNegInt,
  totalActiveLikes: nonNegInt,
  totalActions: nonNegInt,
  reachedLimitTargets: nonNegInt,
  perTarget: z.record(z.string(), TargetDailyUsageSchema),
});
export type DailyUsageOverview = z.infer<typeof DailyUsageOverviewSchema>;
export const BrowserRiskLimitsStateSchema = strictObj({
  settings: DailyRiskLimitSettingsSchema,
  dailyUsage: DailyUsageOverviewSchema,
});
export type BrowserRiskLimitsState = z.infer<typeof BrowserRiskLimitsStateSchema>;
export interface DailyRiskQuotaEvaluation {
  allowed: boolean;
  reason: string | null;
  totalActions: number;
  effectiveLimits: DailyRiskLimitRule;
  hasOverride: boolean;
}
export const DAILY_RISK_RULE_KEYS = [
  'dailyMaxTotalActions',
  'dailyMaxBumps',
  'dailyMaxPosts',
  'dailyMaxInvites',
  'dailyMaxActiveLikes',
] as const;
export function evaluateDailyRiskQuota(
  settings: Pick<DailyRiskLimitSettings, 'enabled' | (typeof DAILY_RISK_RULE_KEYS)[number]>,
  overrides: Readonly<Record<string, DailyRiskLimitOverride>>,
  targetId: string,
  counts: RawDailyActionCounts,
  actionKind?: DailyRiskActionKind,
  carrierLabel = '浏览器',
): DailyRiskQuotaEvaluation {
  const ov = overrides[targetId],
    hasOverride = Boolean(ov && DAILY_RISK_RULE_KEYS.some((k) => ov[k] !== undefined)),
    effectiveLimits = Object.fromEntries(
      DAILY_RISK_RULE_KEYS.map((k) => [k, ov?.[k] ?? settings[k]]),
    ) as DailyRiskLimitRule,
    bumpsToday = counts.groupBumpsToday + counts.pageBumpsToday,
    totalActions = computeTotalDailyActions(counts),
    res = (allowed: boolean, reason: string | null): DailyRiskQuotaEvaluation => ({
      allowed,
      reason,
      totalActions,
      effectiveLimits,
      hasOverride,
    });
  if (!settings.enabled) return res(true, null);
  const maxTotal = effectiveLimits.dailyMaxTotalActions;
  if (maxTotal > 0 && totalActions >= maxTotal)
    return res(
      false,
      `今日已达${carrierLabel}安全日限额（总动作 ${totalActions}/${maxTotal}），自动休眠保护`,
    );
  const caps: Array<[DailyRiskActionKind, string, number, number]> = [
    ['bump', '顶贴', bumpsToday, effectiveLimits.dailyMaxBumps],
    ['post', '发帖', counts.postsToday, effectiveLimits.dailyMaxPosts],
    ['invite', '邀人', counts.invitesToday, effectiveLimits.dailyMaxInvites],
    ['active-like', '活跃赞', counts.activeLikesToday, effectiveLimits.dailyMaxActiveLikes],
  ];
  for (const [kind, label, count, limit] of caps)
    if (actionKind === kind && limit > 0 && count >= limit)
      return res(
        false,
        `今日已达${carrierLabel}${kind === 'active-like' ? '活跃点赞' : label}日限额 (${count}/${limit})，自动休眠保护`,
      );
  if (!actionKind) {
    const hits = caps
      .filter(([, , c, l]) => l > 0 && c >= l)
      .map(([, short, c, l]) => `${short} ${c}/${l}`);
    if (hits.length > 0) return res(false, `已达单项上限（${hits.join('、')}）`);
  }
  return res(true, null);
}
export function aggregateDailyUsageOverview(
  dateYmd: string,
  counts: ReadonlyMap<string, RawDailyActionCounts>,
  settings: Pick<DailyRiskLimitSettings, 'enabled' | (typeof DAILY_RISK_RULE_KEYS)[number]>,
  overrides: Readonly<Record<string, DailyRiskLimitOverride>>,
  carrierLabel = '浏览器',
): DailyUsageOverview {
  const perTarget: Record<string, TargetDailyUsage> = {},
    out: DailyUsageOverview = {
      dateYmd,
      totalGroupBumps: 0,
      totalPageBumps: 0,
      totalPosts: 0,
      totalInvites: 0,
      totalActiveLikes: 0,
      totalActions: 0,
      reachedLimitTargets: 0,
      perTarget,
    };
  for (const [id, raw] of counts) {
    const ev = evaluateDailyRiskQuota(settings, overrides, id, raw, undefined, carrierLabel);
    perTarget[id] = {
      targetId: id,
      ...raw,
      totalActionsToday: ev.totalActions,
      effectiveLimits: ev.effectiveLimits,
      hasOverride: ev.hasOverride,
      limitReached: !ev.allowed,
      limitReason: ev.reason,
    };
    out.totalGroupBumps += raw.groupBumpsToday;
    out.totalPageBumps += raw.pageBumpsToday;
    out.totalPosts += raw.postsToday;
    out.totalInvites += raw.invitesToday;
    out.totalActiveLikes += raw.activeLikesToday;
    out.totalActions += ev.totalActions;
    if (!ev.allowed) out.reachedLimitTargets++;
  }
  return out;
}
