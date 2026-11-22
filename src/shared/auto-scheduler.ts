import { DateTime } from 'luxon';
import { z } from 'zod';
import { Id, type SavedCombination } from './contracts.js';
import { TEST_COMBINATION_NOTE } from './task-tests.js';
import { TaskTimeZone } from './task-timing.js';

export function isUserSavedCombination(combo: SavedCombination): boolean {
  return combo.saved !== null && !combo.saved.note.startsWith(TEST_COMBINATION_NOTE);
}

const HhMm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '时间格式须为 HH:mm');

export const AutoScheduleCarrier = z.enum(['browser', 'bluestacks']);
export type AutoScheduleCarrier = z.infer<typeof AutoScheduleCarrier>;

export const AutoSchedulePhase = z.enum(['prewarm', 'main']);
export type AutoSchedulePhase = z.infer<typeof AutoSchedulePhase>;

export const AutoSchedulerGlobalSettings = z
  .object({
    browserConcurrency: z.number().int().min(1).max(100).default(15),
    bluestacksConcurrency: z.number().int().min(1).max(50).default(5),
    launchStaggerSeconds: z.number().int().min(0).max(30).default(3),
    idleWatchdogMinutes: z.number().int().min(2).max(60).default(5),
    preventSystemSleep: z.boolean().default(true),
  })
  .strict();
export type AutoSchedulerGlobalSettings = z.infer<typeof AutoSchedulerGlobalSettings>;

export const AutoScheduleTargetSelector = z
  .object({
    mode: z.enum(['groups', 'explicit']).default('groups'),
    groupIds: z.array(z.string().min(1).max(120)).max(200).default([]),
    targetIds: z.array(z.string().min(1).max(120)).max(1000).default([]),
    skipAbnormalAccounts: z.boolean().default(true),
  })
  .strict();
export type AutoScheduleTargetSelector = z.infer<typeof AutoScheduleTargetSelector>;

export const AutoScheduleTrigger = z
  .object({
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1, '请至少选择一天')
      .max(7)
      .refine((days) => new Set(days).size === days.length, '星期不能重复'),
    times: z
      .array(HhMm)
      .min(1, '请至少添加一个触发时间')
      .max(8)
      .refine((items) => new Set(items).size === items.length, '触发时间不能重复'),
    timeZone: TaskTimeZone,
    jitterMinutes: z.number().int().min(0).max(30).default(0),
    misfireGraceMinutes: z.number().int().min(5).max(360).default(120),
  })
  .strict();
export type AutoScheduleTrigger = z.infer<typeof AutoScheduleTrigger>;

export const BrowserQuickBrowseStep = z
  .object({
    id: Id,
    type: z.literal('quick-browse'),
    target: z.enum(['feed', 'video']).default('feed'),
    durationMinutes: z.number().int().min(1).max(120).default(1),
  })
  .strict();

export const BrowserActiveCombinationStep = z
  .object({
    id: Id,
    type: z.literal('active-combination'),
    combinationId: Id,
  })
  .strict();

export const BrowserGroupBumperStep = z
  .object({
    id: Id,
    type: z.literal('group-bumper'),
    groupIds: z.array(z.string().min(1).max(120)).min(1, '请至少选择一个小组').max(500),
    pageIds: z.array(z.string().min(1).max(120)).min(1, '请至少选择一个目标主页').max(500),
  })
  .strict();

export const BrowserPageBumperStep = z
  .object({
    id: Id,
    type: z.literal('page-bumper'),
    pageIds: z.array(z.string().min(1).max(120)).min(1, '请至少选择一个目标专页').max(500),
  })
  .strict();

export const BrowserGroupPosterStep = z
  .object({
    id: Id,
    type: z.literal('group-poster'),
    materialIds: z.array(Id).min(1, '请至少选择一张发帖素材卡').max(100),
    groupIds: z.array(z.string().min(1).max(120)).min(1, '请至少选择一个目标小组').max(500),
    maxGroupsPerProfile: z.number().int().min(1).max(50).default(3),
  })
  .strict();

export const BrowserPipelineStep = z.discriminatedUnion('type', [
  BrowserQuickBrowseStep,
  BrowserActiveCombinationStep,
  BrowserGroupBumperStep,
  BrowserPageBumperStep,
  BrowserGroupPosterStep,
]);
export type BrowserPipelineStep = z.infer<typeof BrowserPipelineStep>;

export const BluestacksQuickBrowseStep = z
  .object({
    id: Id,
    type: z.literal('bluestacks-quick-browse'),
    target: z.enum(['feed', 'video']).default('feed'),
    durationMinutes: z.number().int().min(1).max(120).default(2),
  })
  .strict();

export const BluestacksActiveCombinationStep = z
  .object({
    id: Id,
    type: z.literal('bluestacks-active-combination'),
    combinationId: Id,
  })
  .strict();

export const BluestacksGroupPosterStep = z
  .object({
    id: Id,
    type: z.literal('bluestacks-group-poster'),
    materialIds: z.array(Id).min(1, '请至少选择一张发帖素材卡').max(100),
    groupIds: z.array(z.string().min(1).max(120)).max(500).default([]),
    maxGroupsPerProfile: z.number().int().min(1).max(50).default(3),
    postToTimeline: z.boolean().optional(),
  })
  .strict();

export const BluestacksGroupInviterStep = z
  .object({
    id: Id,
    type: z.literal('bluestacks-group-inviter'),
    groupIds: z.array(z.string().min(1).max(120)).min(1, '请至少选择一个目标小组').max(500),
    invitesPerGroup: z.number().int().min(1).max(50).default(5),
  })
  .strict();

export const BluestacksGroupBumperStep = z
  .object({
    id: Id,
    type: z.literal('bluestacks-group-bumper'),
    groupIds: z.array(z.string().min(1).max(120)).min(1, '请至少选择一个小组').max(500),
    pageIds: z.array(z.string().min(1).max(120)).min(1, '请至少选择一个目标主页').max(500),
    enableSound: z.boolean().optional(),
  })
  .strict();

export const BluestacksPageBumperStep = z
  .object({
    id: Id,
    type: z.literal('bluestacks-page-bumper'),
    pageIds: z.array(z.string().min(1).max(120)).min(1, '请至少选择一个目标专页').max(500),
    enableSound: z.boolean().optional(),
  })
  .strict();

export const BluestacksHealthCheckStep = z
  .object({
    id: Id,
    type: z.literal('bluestacks-health-check'),
    autoInstallApk: z.boolean().default(false),
  })
  .strict();

export const BluestacksPipelineStep = z.discriminatedUnion('type', [
  BluestacksHealthCheckStep,
  BluestacksQuickBrowseStep,
  BluestacksActiveCombinationStep,
  BluestacksGroupPosterStep,
  BluestacksGroupBumperStep,
  BluestacksPageBumperStep,
  BluestacksGroupInviterStep,
]);
export type BluestacksPipelineStep = z.infer<typeof BluestacksPipelineStep>;

export const AutoSchedulePrewarm = z
  .object({
    enabled: z.boolean().default(false),
    leadMinutes: z.number().int().min(15).max(720).default(90),
    steps: z.array(BrowserPipelineStep).max(8).default([]),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.enabled && val.steps.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: '开启提前预热场时，请至少配置一个预热动作',
        path: ['steps'],
      });
    }
  });
export type AutoSchedulePrewarm = z.infer<typeof AutoSchedulePrewarm>;

const AutoScheduleBase = {
  id: Id,
  name: z.string().trim().min(1, '请填写排班名称').max(80),
  enabled: z.boolean().default(true),
  targetSelector: AutoScheduleTargetSelector,
  trigger: AutoScheduleTrigger,
  closeWindowOnFinish: z.boolean().default(true),
  maxSafetyMinutesPerTarget: z.number().int().min(0).max(720).nullable().default(null),
  sortOrder: z.number().int().nonnegative().default(0),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
};

export const BrowserAutoSchedule = z
  .object({
    ...AutoScheduleBase,
    carrier: z.literal('browser'),
    prewarm: AutoSchedulePrewarm,
    steps: z.array(BrowserPipelineStep).min(1, '请至少配置一个正点动作').max(12),
  })
  .strict();

export const BluestacksAutoSchedule = z
  .object({
    ...AutoScheduleBase,
    carrier: z.literal('bluestacks'),
    prewarm: z
      .object({
        enabled: z.literal(false).default(false),
        leadMinutes: z.number().int().min(15).max(720).default(90),
        steps: z.array(BrowserPipelineStep).max(0).default([]),
      })
      .strict()
      .default({ enabled: false, leadMinutes: 90, steps: [] }),
    steps: z.array(BluestacksPipelineStep).min(1, '请至少配置一个模拟器顶贴动作').max(8),
  })
  .strict();

export const AutoSchedule = z
  .discriminatedUnion('carrier', [BrowserAutoSchedule, BluestacksAutoSchedule])
  .superRefine((val, ctx) => {
    if (val.targetSelector.mode === 'groups' && val.targetSelector.groupIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: '请选择至少一个分组，或切换为手动勾选账号',
        path: ['targetSelector', 'groupIds'],
      });
    }
    if (val.targetSelector.mode === 'explicit' && val.targetSelector.targetIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: '请至少勾选一个执行账号/模拟器',
        path: ['targetSelector', 'targetIds'],
      });
    }
  });
export type AutoSchedule = z.infer<typeof AutoSchedule>;

export const SaveAutoScheduleInput = z
  .discriminatedUnion('carrier', [
    BrowserAutoSchedule.omit({ id: true, sortOrder: true, createdAt: true, updatedAt: true })
      .extend({ id: Id.optional() })
      .strict(),
    BluestacksAutoSchedule.omit({ id: true, sortOrder: true, createdAt: true, updatedAt: true })
      .extend({ id: Id.optional() })
      .strict(),
  ])
  .superRefine((val, ctx) => {
    if (val.targetSelector.mode === 'groups' && val.targetSelector.groupIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: '请选择至少一个分组，或切换为手动勾选账号',
        path: ['targetSelector', 'groupIds'],
      });
    }
    if (val.targetSelector.mode === 'explicit' && val.targetSelector.targetIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: '请至少勾选一个执行账号/模拟器',
        path: ['targetSelector', 'targetIds'],
      });
    }
  });
export type SaveAutoScheduleInput = z.infer<typeof SaveAutoScheduleInput>;

export const AutoRunStatus = z.enum([
  'running',
  'completed',
  'partial',
  'stopped',
  'skipped_expired',
]);
export type AutoRunStatus = z.infer<typeof AutoRunStatus>;

export const AutoRunItemStatus = z.enum([
  'queued',
  'running',
  'completed',
  'soft_warning',
  'hard_blocked',
  'watchdog_timeout',
  'stopped',
  'skipped',
]);
export type AutoRunItemStatus = z.infer<typeof AutoRunItemStatus>;

export const AutoScheduleRunItem = z
  .object({
    runId: Id,
    targetId: z.string().min(1).max(120),
    targetName: z.string().max(200),
    status: AutoRunItemStatus,
    currentStep: z.string().max(200),
    summary: z.string().max(400),
    bumpedCount: z.number().int().nonnegative().default(0),
    postedCount: z.number().int().nonnegative().default(0),
    softIssues: z.number().int().nonnegative().default(0),
    hardBlockReason: z.string().max(240).nullable().default(null),
    seamlessHandoff: z.boolean().default(false),
    startedAt: z.number().int().nonnegative().nullable().default(null),
    finishedAt: z.number().int().nonnegative().nullable().default(null),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type AutoScheduleRunItem = z.infer<typeof AutoScheduleRunItem>;

export const AutoScheduleRun = z
  .object({
    id: Id,
    scheduleId: Id,
    scheduleName: z.string().max(120),
    carrier: AutoScheduleCarrier,
    phase: AutoSchedulePhase,
    slotKey: z.string().min(1).max(120),
    triggerMode: z.enum(['cron', 'manual']),
    status: AutoRunStatus,
    statusReason: z.string().max(300),
    totalTargets: z.number().int().nonnegative(),
    completedCount: z.number().int().nonnegative(),
    softIssueCount: z.number().int().nonnegative(),
    hardBlockedCount: z.number().int().nonnegative(),
    watchdogTimeoutCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    scheduledFor: z.number().int().nonnegative(),
    startedAt: z.number().int().nonnegative(),
    finishedAt: z.number().int().nonnegative().nullable(),
    items: z.array(AutoScheduleRunItem).optional(),
  })
  .strict();
export type AutoScheduleRun = z.infer<typeof AutoScheduleRun>;

export interface NextRunPreview {
  nextAt: number | null;
  phase: AutoSchedulePhase | null;
  label: string;
}

export type AutoScheduleView = AutoSchedule & {
  resolvedTargetCount: number;
  estimatedPrewarmMinutesPerTarget: number;
  estimatedMainMinutesPerTarget: number;
  effectivePrewarmSafetyMinutes: number | null;
  effectiveMainSafetyMinutes: number | null;
  nextRun: NextRunPreview;
};

export interface AutoSchedulerState {
  settings: AutoSchedulerGlobalSettings;
  running: boolean;
  powerLockMode: 'none' | 'prevent-app-suspension' | 'prevent-display-sleep';
  activeBrowserWorkers: number;
  queuedBrowserTargets: number;
  activeBluestacksWorkers: number;
  queuedBluestacksTargets: number;
  schedules: AutoScheduleView[];
  activeRuns: AutoScheduleRun[];
  recentRuns: AutoScheduleRun[];
}

export function defaultTimeZone(): string {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (resolved && resolved.trim()) return resolved.trim();
  } catch {
    /* ignore */
  }
  return 'Asia/Shanghai';
}

export function estimateStepMinutes(
  step: BrowserPipelineStep | BluestacksPipelineStep,
  combinationMinutesLookup: (combinationId: string) => number,
): number {
  switch (step.type) {
    case 'quick-browse':
      return Math.max(1, step.durationMinutes);
    case 'active-combination':
      return Math.max(3, combinationMinutesLookup(step.combinationId));
    case 'group-bumper':
      return Math.max(4, Math.min(40, Math.ceil(step.groupIds.length * 1.8) + 2));
    case 'page-bumper':
      return Math.max(4, Math.min(35, Math.ceil(step.pageIds.length * 2.0) + 2));
    case 'group-poster':
      return Math.max(3, Math.min(35, Math.ceil(step.maxGroupsPerProfile * 2.2) + 1));
    case 'bluestacks-health-check':
      return step.autoInstallApk ? 3 : 2;
    case 'bluestacks-quick-browse':
      return Math.max(1, step.durationMinutes);
    case 'bluestacks-active-combination':
      return Math.max(3, combinationMinutesLookup(step.combinationId));
    case 'bluestacks-group-poster':
      return Math.max(3, Math.min(35, Math.ceil(step.maxGroupsPerProfile * 2.4) + 2));
    case 'bluestacks-group-inviter':
      return Math.max(3, Math.min(30, Math.ceil(step.groupIds.length * 1.5) + 2));
    case 'bluestacks-group-bumper':
      return Math.max(5, Math.min(45, Math.ceil(step.groupIds.length * 2.2) + 3));
    case 'bluestacks-page-bumper':
      return Math.max(5, Math.min(40, Math.ceil(step.pageIds.length * 2.2) + 3));
  }
}

export function estimatePipelineMinutes(
  steps: readonly (BrowserPipelineStep | BluestacksPipelineStep)[],
  combinationMinutesLookup: (combinationId: string) => number,
): number {
  let sum = 0;
  for (const s of steps) sum += estimateStepMinutes(s, combinationMinutesLookup);
  return Math.max(2, sum);
}

/**
 * 动态计算单号兜底安全上限（分钟）：
 * - 用户显式填 `0`：关闭总时长封顶，完全交由「真实进度心跳看门狗」判卡死；
 * - 用户显式填正整数：使用用户指定分钟数；
 * - 默认 `null`：按 `(预计单号总分钟 × 2.5) + 30 分钟` 自动推算（保底 60 分钟，上限 360 分钟），确保多步长组合或长视频绝不误触发。
 */
export function computeEffectiveSafetyCeilingMinutes(
  schedule: AutoSchedule,
  phase: AutoSchedulePhase,
  combinationMinutesLookup: (combinationId: string) => number,
): number | null {
  if (schedule.maxSafetyMinutesPerTarget === 0) return null;
  if (
    typeof schedule.maxSafetyMinutesPerTarget === 'number' &&
    schedule.maxSafetyMinutesPerTarget > 0
  ) {
    return Math.max(15, schedule.maxSafetyMinutesPerTarget);
  }
  const steps =
    phase === 'prewarm' && schedule.carrier === 'browser' ? schedule.prewarm.steps : schedule.steps;
  const est = estimatePipelineMinutes(steps, combinationMinutesLookup);
  return Math.min(360, Math.max(60, Math.ceil(est * 2.5) + 30));
}

export function computeWaveDurationEstimateMinutes(
  targetCount: number,
  concurrency: number,
  perTargetMinutes: number,
): number {
  if (targetCount <= 0) return 0;
  const waves = Math.max(1, Math.ceil(targetCount / Math.max(1, concurrency)));
  return Math.ceil(waves * perTargetMinutes);
}

function deterministicJitterMs(scheduleId: string, slotKey: string, jitterMinutes: number): number {
  if (jitterMinutes <= 0) return 0;
  const seed = `${scheduleId}::${slotKey}`;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const maxMs = jitterMinutes * 60_000;
  return (hash >>> 0) % (maxMs + 1);
}

export interface DueScheduleSlot {
  scheduleId: string;
  phase: AutoSchedulePhase;
  slotKey: string;
  mainSlotKey: string;
  scheduledFor: number;
  mainScheduledFor: number;
  expiredSkipReason?: string;
}

/**
 * 纯函数计算当前时刻应触发的排班场次（支持跨午夜提前预热场、确定性随机浮动、Misfire 补跑保护与临近正点自动跳过过期预热）。
 */
export function computeDueScheduleTriggers(
  schedule: AutoSchedule,
  nowMs: number,
  handledSlotKeys: ReadonlySet<string>,
): DueScheduleSlot[] {
  if (!schedule.enabled) return [];
  const zone = schedule.trigger.timeZone;
  const nowDt = DateTime.fromMillis(nowMs, { zone });
  if (!nowDt.isValid) return [];

  const candidateMainDates = [
    nowDt.minus({ days: 1 }).startOf('day'),
    nowDt.startOf('day'),
    nowDt.plus({ days: 1 }).startOf('day'),
  ];
  const graceMs = schedule.trigger.misfireGraceMinutes * 60_000;
  const due: DueScheduleSlot[] = [];

  for (const dayStart of candidateMainDates) {
    if (!schedule.trigger.weekdays.includes(dayStart.weekday)) continue;
    const ymd = dayStart.toFormat('yyyy-MM-dd');
    for (const hhmm of schedule.trigger.times) {
      const [hStr, mStr] = hhmm.split(':');
      const hour = Number(hStr);
      const minute = Number(mStr);
      const mainBaseDt = dayStart.set({ hour, minute, second: 0, millisecond: 0 });
      const mainBaseMs = mainBaseDt.toMillis();
      const mainSlotKey = `${ymd}@${hhmm}:main`;
      const mainJitter = deterministicJitterMs(
        schedule.id,
        mainSlotKey,
        schedule.trigger.jitterMinutes,
      );
      const mainFireMs = mainBaseMs + mainJitter;

      if (
        schedule.carrier === 'browser' &&
        schedule.prewarm.enabled &&
        schedule.prewarm.steps.length > 0
      ) {
        const preSlotKey = `${ymd}@${hhmm}:prewarm`;
        if (!handledSlotKeys.has(preSlotKey)) {
          const preBaseMs = mainBaseMs - schedule.prewarm.leadMinutes * 60_000;
          const preJitter = deterministicJitterMs(
            schedule.id,
            preSlotKey,
            schedule.trigger.jitterMinutes,
          );
          const preFireMs = preBaseMs + preJitter;
          if (nowMs >= preFireMs) {
            // If we already reached or are within 15 minutes of the main stage, skip stale prewarm to protect main peak window!
            const minLeadRemainMs = Math.min(
              15 * 60_000,
              Math.floor(schedule.prewarm.leadMinutes * 60_000 * 0.35),
            );
            if (nowMs >= mainFireMs - minLeadRemainMs && nowMs <= mainFireMs + graceMs) {
              due.push({
                scheduleId: schedule.id,
                phase: 'prewarm',
                slotKey: preSlotKey,
                mainSlotKey,
                scheduledFor: preFireMs,
                mainScheduledFor: mainFireMs,
                expiredSkipReason: '开机/唤醒时已临近正点场，自动跳过过期预热以保障正点顶贴',
              });
            } else if (nowMs <= preFireMs + graceMs && nowMs < mainFireMs - minLeadRemainMs) {
              due.push({
                scheduleId: schedule.id,
                phase: 'prewarm',
                slotKey: preSlotKey,
                mainSlotKey,
                scheduledFor: preFireMs,
                mainScheduledFor: mainFireMs,
              });
            }
          }
        }
      }

      if (
        !handledSlotKeys.has(mainSlotKey) &&
        nowMs >= mainFireMs &&
        nowMs <= mainFireMs + graceMs
      ) {
        due.push({
          scheduleId: schedule.id,
          phase: 'main',
          slotKey: mainSlotKey,
          mainSlotKey,
          scheduledFor: mainFireMs,
          mainScheduledFor: mainFireMs,
        });
      }
    }
  }

  due.sort((a, b) => a.scheduledFor - b.scheduledFor);
  return due;
}

export interface UpcomingRunPreviewItem {
  nextAt: number;
  phase: AutoSchedulePhase;
  label: string;
}

export function computeUpcomingRunsPreview(
  input: {
    id?: string | undefined;
    weekdays: readonly number[];
    times: readonly string[];
    timeZone: string;
    jitterMinutes: number;
    prewarmEnabled: boolean;
    prewarmLeadMinutes: number;
  },
  nowMs: number,
  count = 3,
  handledSlotKeys: ReadonlySet<string> = new Set(),
): UpcomingRunPreviewItem[] {
  const zone = input.timeZone;
  const nowDt = DateTime.fromMillis(nowMs, { zone });
  if (!nowDt.isValid || input.weekdays.length === 0 || input.times.length === 0) return [];

  const seedId = input.id ?? 'preview';
  const candidates: Array<{ at: number; phase: AutoSchedulePhase; mainAt: number }> = [];

  for (let offset = -1; offset <= 8; offset++) {
    const dayStart = nowDt.plus({ days: offset }).startOf('day');
    if (!input.weekdays.includes(dayStart.weekday)) continue;
    const ymd = dayStart.toFormat('yyyy-MM-dd');
    for (const hhmm of input.times) {
      const [hStr, mStr] = hhmm.split(':');
      const mainDt = dayStart.set({
        hour: Number(hStr),
        minute: Number(mStr),
        second: 0,
        millisecond: 0,
      });
      const mainBaseMs = mainDt.toMillis();
      const mainSlotKey = `${ymd}@${hhmm}:main`;
      const mainFireMs =
        mainBaseMs + deterministicJitterMs(seedId, mainSlotKey, input.jitterMinutes);

      if (input.prewarmEnabled) {
        const preSlotKey = `${ymd}@${hhmm}:prewarm`;
        const preBaseMs = mainBaseMs - input.prewarmLeadMinutes * 60_000;
        const preFireMs =
          preBaseMs + deterministicJitterMs(seedId, preSlotKey, input.jitterMinutes);
        if (preFireMs > nowMs && !handledSlotKeys.has(preSlotKey)) {
          candidates.push({ at: preFireMs, phase: 'prewarm', mainAt: mainFireMs });
        }
      }

      if (mainFireMs > nowMs && !handledSlotKeys.has(mainSlotKey)) {
        candidates.push({ at: mainFireMs, phase: 'main', mainAt: mainFireMs });
      }
    }
  }

  candidates.sort((a, b) => a.at - b.at);
  return candidates.slice(0, Math.max(1, count)).map((item) => {
    const targetDt = DateTime.fromMillis(item.at, { zone });
    const isToday = targetDt.hasSame(nowDt, 'day');
    const isTomorrow = targetDt.hasSame(nowDt.plus({ days: 1 }), 'day');
    const dayPrefix = isToday ? '今天' : isTomorrow ? '明天' : targetDt.toFormat('MM-dd');
    const hm = targetDt.toFormat('HH:mm');
    if (item.phase === 'prewarm') {
      const mainHm = DateTime.fromMillis(item.mainAt, { zone }).toFormat('HH:mm');
      return {
        nextAt: item.at,
        phase: 'prewarm',
        label: `${dayPrefix} ${hm} 预热（正点 ${mainHm}）`,
      };
    }
    return {
      nextAt: item.at,
      phase: 'main',
      label: `${dayPrefix} ${hm} 执行`,
    };
  });
}

export function computeNextRunPreview(
  schedule: AutoSchedule,
  nowMs: number,
  handledSlotKeys: ReadonlySet<string> = new Set(),
): NextRunPreview {
  if (!schedule.enabled) {
    return { nextAt: null, phase: null, label: '已停用' };
  }
  const zone = schedule.trigger.timeZone;
  const nowDt = DateTime.fromMillis(nowMs, { zone });
  if (!nowDt.isValid) return { nextAt: null, phase: null, label: '时区无效' };

  const upcoming = computeUpcomingRunsPreview(
    {
      id: schedule.id,
      weekdays: schedule.trigger.weekdays,
      times: schedule.trigger.times,
      timeZone: zone,
      jitterMinutes: schedule.trigger.jitterMinutes,
      prewarmEnabled:
        schedule.carrier === 'browser' &&
        schedule.prewarm.enabled &&
        schedule.prewarm.steps.length > 0,
      prewarmLeadMinutes: schedule.carrier === 'browser' ? schedule.prewarm.leadMinutes : 90,
    },
    nowMs,
    1,
    handledSlotKeys,
  );
  const first = upcoming[0];
  if (!first) {
    return { nextAt: null, phase: null, label: '暂无未来计划' };
  }
  return first;
}

export function formatWeekdaysLabel(weekdays: readonly number[]): string {
  const sorted = [...new Set(weekdays)].sort((a, b) => a - b);
  if (sorted.length === 7) return '每天';
  if (sorted.join(',') === '1,2,3,4,5') return '工作日 (周一至周五)';
  if (sorted.join(',') === '6,7') return '周末 (周六至周日)';
  const names = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  return sorted
    .map((d) => names[d] ?? '')
    .filter(Boolean)
    .join('、');
}

export function formatStepShortLabel(step: BrowserPipelineStep | BluestacksPipelineStep): string {
  switch (step.type) {
    case 'quick-browse':
      return `${step.target === 'video' ? '刷视频' : '刷首页'} ${step.durationMinutes} 分钟`;
    case 'active-combination':
      return '执行活跃组合';
    case 'group-bumper':
      return `小组顶贴 (${step.groupIds.length}组/${step.pageIds.length}专页)`;
    case 'page-bumper':
      return `专页顶贴 (${step.pageIds.length}专页)`;
    case 'group-poster':
      return `小组发帖 (单号≤${step.maxGroupsPerProfile}组)`;
    case 'bluestacks-health-check':
      return step.autoInstallApk ? '蓝蝶健康体检（缺包自装）' : '蓝蝶健康体检';
    case 'bluestacks-quick-browse':
      return `蓝蝶${step.target === 'video' ? '刷视频' : '刷首页'} ${step.durationMinutes} 分钟`;
    case 'bluestacks-active-combination':
      return '蓝蝶执行活跃组合';
    case 'bluestacks-group-poster':
      return `蓝蝶小组发帖 (单号≤${step.maxGroupsPerProfile}组)`;
    case 'bluestacks-group-inviter':
      return `蓝蝶小组邀人 (${step.groupIds.length}组)`;
    case 'bluestacks-group-bumper':
      return `蓝蝶小组顶贴 (${step.groupIds.length}组)`;
    case 'bluestacks-page-bumper':
      return `蓝蝶专页顶贴 (${step.pageIds.length}专页)`;
  }
}
