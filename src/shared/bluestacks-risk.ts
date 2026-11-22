import { z } from 'zod';

export const BluestacksRiskActionKind = z.enum(['bump', 'post', 'invite', 'active-like']);
export type BluestacksRiskActionKind = z.infer<typeof BluestacksRiskActionKind>;

export const BluestacksRiskLimitRule = z
  .object({
    dailyMaxTotalActions: z.number().int().min(0).max(2000).default(60),
    dailyMaxBumps: z.number().int().min(0).max(500).default(30),
    dailyMaxPosts: z.number().int().min(0).max(200).default(10),
    dailyMaxInvites: z.number().int().min(0).max(300).default(20),
    dailyMaxActiveLikes: z.number().int().min(0).max(300).default(25),
  })
  .strict();
export type BluestacksRiskLimitRule = z.infer<typeof BluestacksRiskLimitRule>;

export const BluestacksRiskLimitOverride = BluestacksRiskLimitRule.partial().strict();
export type BluestacksRiskLimitOverride = z.infer<typeof BluestacksRiskLimitOverride>;

export const BluestacksRiskLimitSettings = z
  .object({
    enabled: z.boolean().default(true),
    dailyMaxTotalActions: z.number().int().min(0).max(2000).default(60),
    dailyMaxBumps: z.number().int().min(0).max(500).default(30),
    dailyMaxPosts: z.number().int().min(0).max(200).default(10),
    dailyMaxInvites: z.number().int().min(0).max(300).default(20),
    dailyMaxActiveLikes: z.number().int().min(0).max(300).default(25),
    perInstanceOverrides: z.record(z.string(), BluestacksRiskLimitOverride).default({}),
  })
  .strict();
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

export interface BluestacksRiskQuotaEvaluation {
  allowed: boolean;
  reason: string | null;
  totalActions: number;
  effectiveLimits: BluestacksRiskLimitRule;
  hasOverride: boolean;
}

export function resolveEffectiveBluestacksLimits(
  settings: BluestacksRiskLimitSettings,
  instanceId: string,
): { effectiveLimits: BluestacksRiskLimitRule; hasOverride: boolean } {
  const override = settings.perInstanceOverrides[instanceId];
  const hasOverride = Boolean(
    override &&
    (override.dailyMaxTotalActions !== undefined ||
      override.dailyMaxBumps !== undefined ||
      override.dailyMaxPosts !== undefined ||
      override.dailyMaxInvites !== undefined ||
      override.dailyMaxActiveLikes !== undefined),
  );
  return {
    hasOverride,
    effectiveLimits: {
      dailyMaxTotalActions: override?.dailyMaxTotalActions ?? settings.dailyMaxTotalActions,
      dailyMaxBumps: override?.dailyMaxBumps ?? settings.dailyMaxBumps,
      dailyMaxPosts: override?.dailyMaxPosts ?? settings.dailyMaxPosts,
      dailyMaxInvites: override?.dailyMaxInvites ?? settings.dailyMaxInvites,
      dailyMaxActiveLikes: override?.dailyMaxActiveLikes ?? settings.dailyMaxActiveLikes,
    },
  };
}

/**
 * Single shared pure risk quota evaluator used by persistence, service pre-flight,
 * mid-run callbacks, bumper eligibility, and renderer dashboard badges.
 */
export function evaluateBluestacksRiskQuota(
  settings: BluestacksRiskLimitSettings,
  instanceId: string,
  counts: BluestacksRawDailyCounts,
  actionKind?: BluestacksRiskActionKind,
): BluestacksRiskQuotaEvaluation {
  const { effectiveLimits, hasOverride } = resolveEffectiveBluestacksLimits(settings, instanceId);
  const bumpsToday = counts.groupBumpsToday + counts.pageBumpsToday;
  const totalActions =
    bumpsToday + counts.postsToday + counts.invitesToday + counts.activeLikesToday;

  if (!settings.enabled) {
    return {
      allowed: true,
      reason: null,
      totalActions,
      effectiveLimits,
      hasOverride,
    };
  }

  if (
    effectiveLimits.dailyMaxTotalActions > 0 &&
    totalActions >= effectiveLimits.dailyMaxTotalActions
  ) {
    return {
      allowed: false,
      reason: `今日已达蓝蝶风控安全上限（总动作 ${totalActions}/${effectiveLimits.dailyMaxTotalActions}），自动休眠保护`,
      totalActions,
      effectiveLimits,
      hasOverride,
    };
  }

  if (
    actionKind === 'bump' &&
    effectiveLimits.dailyMaxBumps > 0 &&
    bumpsToday >= effectiveLimits.dailyMaxBumps
  ) {
    return {
      allowed: false,
      reason: `今日已达蓝蝶顶贴风控上限 (${bumpsToday}/${effectiveLimits.dailyMaxBumps})，自动休眠保护`,
      totalActions,
      effectiveLimits,
      hasOverride,
    };
  }

  if (
    actionKind === 'post' &&
    effectiveLimits.dailyMaxPosts > 0 &&
    counts.postsToday >= effectiveLimits.dailyMaxPosts
  ) {
    return {
      allowed: false,
      reason: `今日已达蓝蝶发帖风控上限 (${counts.postsToday}/${effectiveLimits.dailyMaxPosts})，自动休眠保护`,
      totalActions,
      effectiveLimits,
      hasOverride,
    };
  }

  if (
    actionKind === 'invite' &&
    effectiveLimits.dailyMaxInvites > 0 &&
    counts.invitesToday >= effectiveLimits.dailyMaxInvites
  ) {
    return {
      allowed: false,
      reason: `今日已达蓝蝶邀人风控上限 (${counts.invitesToday}/${effectiveLimits.dailyMaxInvites})，自动休眠保护`,
      totalActions,
      effectiveLimits,
      hasOverride,
    };
  }

  if (
    actionKind === 'active-like' &&
    effectiveLimits.dailyMaxActiveLikes > 0 &&
    counts.activeLikesToday >= effectiveLimits.dailyMaxActiveLikes
  ) {
    return {
      allowed: false,
      reason: `今日已达蓝蝶活跃点赞风控上限 (${counts.activeLikesToday}/${effectiveLimits.dailyMaxActiveLikes})，自动休眠保护`,
      totalActions,
      effectiveLimits,
      hasOverride,
    };
  }

  // Overview summary (when no specific actionKind is requested): report if any category cap is hit
  if (!actionKind) {
    const hits: string[] = [];
    if (effectiveLimits.dailyMaxBumps > 0 && bumpsToday >= effectiveLimits.dailyMaxBumps) {
      hits.push(`顶贴 ${bumpsToday}/${effectiveLimits.dailyMaxBumps}`);
    }
    if (effectiveLimits.dailyMaxPosts > 0 && counts.postsToday >= effectiveLimits.dailyMaxPosts) {
      hits.push(`发帖 ${counts.postsToday}/${effectiveLimits.dailyMaxPosts}`);
    }
    if (
      effectiveLimits.dailyMaxInvites > 0 &&
      counts.invitesToday >= effectiveLimits.dailyMaxInvites
    ) {
      hits.push(`邀人 ${counts.invitesToday}/${effectiveLimits.dailyMaxInvites}`);
    }
    if (
      effectiveLimits.dailyMaxActiveLikes > 0 &&
      counts.activeLikesToday >= effectiveLimits.dailyMaxActiveLikes
    ) {
      hits.push(`活跃赞 ${counts.activeLikesToday}/${effectiveLimits.dailyMaxActiveLikes}`);
    }
    if (hits.length > 0) {
      return {
        allowed: false,
        reason: `已达单项上限（${hits.join('、')}）`,
        totalActions,
        effectiveLimits,
        hasOverride,
      };
    }
  }

  return {
    allowed: true,
    reason: null,
    totalActions,
    effectiveLimits,
    hasOverride,
  };
}
