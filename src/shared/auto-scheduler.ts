import { DateTime } from 'luxon';
import { z } from 'zod';
import {
  Id,
  NonNegInt,
  NumNull,
  PosInt,
  addIssue,
  boolF,
  boolT,
  intRange,
  optBool,
  sMax,
  sReq,
  strictObj,
  trimReq,
  type SavedCombination,
} from './contracts.js';
import { PartialBumperSettings } from './group-bumper.js';
import { TEST_COMBINATION_NOTE } from './task-tests.js';
import { TaskTimeZone } from './task-timing.js';
export const isUserSavedCombination = (combo: SavedCombination): boolean =>
  combo.saved !== null && !combo.saved.note.startsWith(TEST_COMBINATION_NOTE);
const HhMm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '时间格式须为 HH:mm'),
  TargetIdArr = z.array(sReq(120)),
  uniq = <T>(arr: readonly T[]) => new Set(arr).size === arr.length,
  GroupIdsReq = TargetIdArr.min(1, '请至少选择一个小组').max(500),
  PageIdsReq = TargetIdArr.min(1, '请至少选择一个目标专页').max(500),
  BumperPageIdsReq = TargetIdArr.min(1, '请至少选择一个目标主页').max(500),
  n0 = NonNegInt.default(0),
  nullNn = NonNegInt.nullable().default(null);
export const AutoScheduleCarrier = z.enum(['browser', 'bluestacks']);
export type AutoScheduleCarrier = z.infer<typeof AutoScheduleCarrier>;
export const AutoSchedulePhase = z.enum(['prewarm', 'main']);
export type AutoSchedulePhase = z.infer<typeof AutoSchedulePhase>;
export const AutoSchedulerGlobalSettings = strictObj({
  browserConcurrency: intRange(1, 100).default(15),
  bluestacksConcurrency: intRange(1, 50).default(5),
  launchStaggerSeconds: intRange(0, 30).default(3),
  idleWatchdogMinutes: intRange(2, 60).default(5),
  preventSystemSleep: boolT,
});
export type AutoSchedulerGlobalSettings = z.infer<typeof AutoSchedulerGlobalSettings>;
const AutoScheduleTargetSelector = strictObj({
  mode: z.enum(['groups', 'explicit']).default('groups'),
  groupIds: TargetIdArr.max(200).default([]),
  targetIds: TargetIdArr.max(1000).default([]),
  skipAbnormalAccounts: boolT,
});
type AutoScheduleTargetSelector = z.infer<typeof AutoScheduleTargetSelector>;
const AutoScheduleTrigger = strictObj({
  mode: z.enum(['weekly', 'once']).default('weekly'),
  onceAt: PosInt.nullable().default(null),
  weekdays: z
    .array(intRange(1, 7))
    .min(1, '请至少选择一天')
    .max(7)
    .refine(uniq, '星期不能重复')
    .default([1, 2, 3, 4, 5, 6, 7]),
  times: z
    .array(HhMm)
    .min(1, '请至少添加一个触发时间')
    .max(8)
    .refine(uniq, '触发时间不能重复')
    .default(['09:00']),
  timeZone: TaskTimeZone,
  jitterMinutes: intRange(0, 30).default(0),
  misfireGraceMinutes: intRange(5, 360).default(120),
});
type AutoScheduleTrigger = z.infer<typeof AutoScheduleTrigger>;
const quickBrowse = <T extends 'quick-browse' | 'bluestacks-quick-browse'>(
  type: T,
  defMin: number,
) =>
  strictObj({
    id: Id,
    type: z.literal(type),
    target: z.enum(['feed', 'video']).default('feed'),
    durationMinutes: intRange(1, 120).default(defMin),
  });
const activeCombo = <T extends 'active-combination' | 'bluestacks-active-combination'>(type: T) =>
  strictObj({ id: Id, type: z.literal(type), combinationId: Id });
const inviterStep = <T extends 'group-inviter' | 'bluestacks-group-inviter'>(
  type: T,
  withSound: boolean,
) =>
  strictObj({
    id: Id,
    type: z.literal(type),
    groupIds: GroupIdsReq,
    invitesPerGroup: intRange(1, 50).default(5),
    ...(withSound ? { playSoundOnComplete: optBool } : {}),
  });
const posterFields = {
  id: Id,
  materialIds: z.array(Id).min(1, '请至少选择一张发帖素材卡').max(100),
  maxGroupsPerProfile: intRange(1, 50).default(3),
  materialsPerGroup: intRange(1, 50).optional(),
};
const bumperCommon = { id: Id, settingsOverride: PartialBumperSettings.optional() };
export const BrowserPipelineStep = z.discriminatedUnion('type', [
  quickBrowse('quick-browse', 1),
  activeCombo('active-combination'),
  strictObj({
    ...bumperCommon,
    type: z.literal('group-bumper'),
    groupIds: GroupIdsReq,
    pageIds: BumperPageIdsReq,
  }),
  strictObj({ ...bumperCommon, type: z.literal('page-bumper'), pageIds: PageIdsReq }),
  strictObj({ ...posterFields, type: z.literal('group-poster'), groupIds: GroupIdsReq }),
  inviterStep('group-inviter', true),
]);
export type BrowserPipelineStep = z.infer<typeof BrowserPipelineStep>;
export const BluestacksGroupPosterStep = strictObj({
  ...posterFields,
  type: z.literal('bluestacks-group-poster'),
  groupIds: TargetIdArr.max(500).default([]),
  postToTimeline: optBool,
}).superRefine((val, ctx) => {
  if (val.groupIds.length === 0 && !val.postToTimeline)
    addIssue(ctx, '请至少选择一个目标小组或开启发专页时间线', ['groupIds']);
});
export const BluestacksPipelineStep = z.discriminatedUnion('type', [
  strictObj({ id: Id, type: z.literal('bluestacks-health-check'), autoInstallApk: boolF }),
  quickBrowse('bluestacks-quick-browse', 2),
  activeCombo('bluestacks-active-combination'),
  BluestacksGroupPosterStep,
  strictObj({
    ...bumperCommon,
    type: z.literal('bluestacks-group-bumper'),
    groupIds: GroupIdsReq,
    pageIds: BumperPageIdsReq,
    enableSound: optBool,
  }),
  strictObj({
    ...bumperCommon,
    type: z.literal('bluestacks-page-bumper'),
    pageIds: PageIdsReq,
    enableSound: optBool,
  }),
  inviterStep('bluestacks-group-inviter', false),
]);
export type BluestacksPipelineStep = z.infer<typeof BluestacksPipelineStep>;
const AutoSchedulePrewarm = strictObj({
  enabled: boolF,
  leadMinutes: intRange(15, 720).default(90),
  steps: z.array(BrowserPipelineStep).max(8).default([]),
}).superRefine((val, ctx) => {
  if (val.enabled && val.steps.length === 0)
    addIssue(ctx, '开启提前预热场时，请至少配置一个预热动作', ['steps']);
});
const AutoScheduleBase = {
  id: Id,
  name: trimReq(80).min(1, '请填写排班名称'),
  enabled: boolT,
  targetSelector: AutoScheduleTargetSelector,
  trigger: AutoScheduleTrigger,
  closeWindowOnFinish: boolT,
  maxSafetyMinutesPerTarget: intRange(0, 720).nullable().default(null),
  sortOrder: n0,
  createdAt: NonNegInt,
  updatedAt: NonNegInt,
};
const BrowserAutoSchedule = strictObj({
  ...AutoScheduleBase,
  carrier: z.literal('browser'),
  prewarm: AutoSchedulePrewarm,
  steps: z.array(BrowserPipelineStep).min(1, '请至少配置一个正点动作').max(12),
});
const BluestacksAutoSchedule = strictObj({
  ...AutoScheduleBase,
  carrier: z.literal('bluestacks'),
  prewarm: strictObj({
    enabled: z.literal(false).default(false),
    leadMinutes: intRange(15, 720).default(90),
    steps: z.array(BrowserPipelineStep).max(0).default([]),
  }).default({ enabled: false, leadMinutes: 90, steps: [] }),
  steps: z.array(BluestacksPipelineStep).min(1, '请至少配置一个模拟器顶贴动作').max(8),
});
function validateScheduleRefinements(
  val: { targetSelector: AutoScheduleTargetSelector; trigger: AutoScheduleTrigger },
  ctx: z.RefinementCtx,
): void {
  if (val.targetSelector.mode === 'groups' && val.targetSelector.groupIds.length === 0)
    addIssue(ctx, '请选择至少一个分组，或切换为手动勾选账号', ['targetSelector', 'groupIds']);
  if (val.targetSelector.mode === 'explicit' && val.targetSelector.targetIds.length === 0)
    addIssue(ctx, '请至少勾选一个执行账号/模拟器', ['targetSelector', 'targetIds']);
  if (val.trigger.mode === 'once' && (!val.trigger.onceAt || val.trigger.onceAt <= 0))
    addIssue(ctx, '单次定时必须选择执行日期与时间', ['trigger', 'onceAt']);
}
export const AutoSchedule = z
  .discriminatedUnion('carrier', [BrowserAutoSchedule, BluestacksAutoSchedule])
  .superRefine(validateScheduleRefinements);
export type AutoSchedule = z.infer<typeof AutoSchedule>;
const omitBase = { id: true, sortOrder: true, createdAt: true, updatedAt: true } as const;
export const SaveAutoScheduleInput = z
  .discriminatedUnion('carrier', [
    BrowserAutoSchedule.omit(omitBase).extend({ id: Id.optional() }).strict(),
    BluestacksAutoSchedule.omit(omitBase).extend({ id: Id.optional() }).strict(),
  ])
  .superRefine(validateScheduleRefinements);
export type SaveAutoScheduleInput = z.infer<typeof SaveAutoScheduleInput>;
export interface QuickScheduleSeed {
  carrier: AutoScheduleCarrier;
  name: string;
  targetIds: string[];
  groupIds?: string[];
  steps: Array<BrowserPipelineStep | BluestacksPipelineStep>;
}
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
export const AutoScheduleRunItem = strictObj({
  runId: Id,
  targetId: sReq(120),
  targetName: sMax(200),
  status: AutoRunItemStatus,
  currentStep: sMax(200),
  summary: sMax(400),
  bumpedCount: n0,
  postedCount: n0,
  softIssues: n0,
  hardBlockReason: sMax(240).nullable().default(null),
  seamlessHandoff: boolF,
  startedAt: nullNn,
  finishedAt: nullNn,
  updatedAt: NonNegInt,
});
export type AutoScheduleRunItem = z.infer<typeof AutoScheduleRunItem>;
export const AutoScheduleRun = strictObj({
  id: Id,
  scheduleId: Id,
  scheduleName: sMax(120),
  carrier: AutoScheduleCarrier,
  phase: AutoSchedulePhase,
  slotKey: sReq(120),
  triggerMode: z.enum(['cron', 'manual']),
  status: AutoRunStatus,
  statusReason: sMax(300),
  totalTargets: NonNegInt,
  completedCount: NonNegInt,
  softIssueCount: NonNegInt,
  hardBlockedCount: NonNegInt,
  watchdogTimeoutCount: NonNegInt,
  skippedCount: NonNegInt,
  scheduledFor: NonNegInt,
  startedAt: NonNegInt,
  finishedAt: NumNull,
  items: z.array(AutoScheduleRunItem).optional(),
});
export type AutoScheduleRun = z.infer<typeof AutoScheduleRun>;
type NextRunPreview = { nextAt: number | null; phase: AutoSchedulePhase | null; label: string };
type AutoScheduleView = AutoSchedule & {
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
    const r = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (r?.trim()) return r.trim();
  } catch {}
  return 'Asia/Shanghai';
}
const stepBounds = (min: number, max: number, val: number) =>
  Math.max(min, Math.min(max, Math.ceil(val)));
function estimateStepMinutes(
  step: BrowserPipelineStep | BluestacksPipelineStep,
  lookup: (id: string) => number,
): number {
  const t = step.type;
  if (t === 'quick-browse' || t === 'bluestacks-quick-browse')
    return Math.max(1, step.durationMinutes);
  if (t === 'active-combination' || t === 'bluestacks-active-combination')
    return Math.max(3, lookup(step.combinationId));
  if (t === 'bluestacks-health-check') return step.autoInstallApk ? 3 : 2;
  const bs = t.startsWith('bluestacks-');
  if (t === 'group-poster' || t === 'bluestacks-group-poster')
    return stepBounds(3, 35, step.maxGroupsPerProfile * (bs ? 2.4 : 2.2) + (bs ? 2 : 1));
  if (t === 'page-bumper' || t === 'bluestacks-page-bumper')
    return stepBounds(
      bs ? 5 : 4,
      bs ? 40 : 35,
      step.pageIds.length * (bs ? 2.2 : 2) + (bs ? 3 : 2),
    );
  return t.endsWith('inviter')
    ? stepBounds(3, 30, step.groupIds.length * (bs ? 1.5 : 1.4) + 2)
    : stepBounds(bs ? 5 : 4, bs ? 45 : 40, step.groupIds.length * (bs ? 2.2 : 1.8) + (bs ? 3 : 2));
}
export const estimatePipelineMinutes = (
  steps: readonly (BrowserPipelineStep | BluestacksPipelineStep)[],
  combinationMinutesLookup: (combinationId: string) => number,
): number =>
  Math.max(
    2,
    steps.reduce((sum, s) => sum + estimateStepMinutes(s, combinationMinutesLookup), 0),
  );
export function computeEffectiveSafetyCeilingMinutes(
  schedule: AutoSchedule,
  phase: AutoSchedulePhase,
  combinationMinutesLookup: (combinationId: string) => number,
): number | null {
  if (schedule.maxSafetyMinutesPerTarget === 0) return null;
  if (
    typeof schedule.maxSafetyMinutesPerTarget === 'number' &&
    schedule.maxSafetyMinutesPerTarget > 0
  )
    return Math.max(15, schedule.maxSafetyMinutesPerTarget);
  const steps =
    phase === 'prewarm' && schedule.carrier === 'browser' ? schedule.prewarm.steps : schedule.steps;
  return stepBounds(60, 360, estimatePipelineMinutes(steps, combinationMinutesLookup) * 2.5 + 30);
}
function deterministicJitterMs(scheduleId: string, slotKey: string, jitterMinutes: number): number {
  if (jitterMinutes <= 0) return 0;
  const seed = `${scheduleId}::${slotKey}`;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  return (hash >>> 0) % (jitterMinutes * 60_000 + 1);
}
function* iterWeeklySlots(
  nowDt: DateTime,
  minOffset: number,
  maxOffset: number,
  weekdays: readonly number[],
  times: readonly string[],
  seedId: string,
  jitterMinutes: number,
) {
  for (let offset = minOffset; offset <= maxOffset; offset++) {
    const dayStart = nowDt.plus({ days: offset }).startOf('day');
    if (!weekdays.includes(dayStart.weekday)) continue;
    const ymd = dayStart.toFormat('yyyy-MM-dd');
    for (const hhmm of times) {
      const [hStr, mStr] = hhmm.split(':'),
        mainBaseMs = dayStart
          .set({ hour: Number(hStr), minute: Number(mStr), second: 0, millisecond: 0 })
          .toMillis(),
        mainSlotKey = `${ymd}@${hhmm}:main`;
      yield {
        ymd,
        hhmm,
        mainBaseMs,
        mainSlotKey,
        mainFireMs: mainBaseMs + deterministicJitterMs(seedId, mainSlotKey, jitterMinutes),
      };
    }
  }
}
export function computeDueScheduleTriggers(
  schedule: AutoSchedule,
  nowMs: number,
  handledSlotKeys: ReadonlySet<string>,
): Array<{
  scheduleId: string;
  phase: AutoSchedulePhase;
  slotKey: string;
  mainSlotKey: string;
  scheduledFor: number;
  mainScheduledFor: number;
  expiredSkipReason?: string;
}> {
  if (!schedule.enabled) return [];
  const graceMs = schedule.trigger.misfireGraceMinutes * 60_000,
    slot = (
      phase: AutoSchedulePhase,
      slotKey: string,
      mainSlotKey: string,
      scheduledFor: number,
      mainScheduledFor: number,
      expiredSkipReason?: string,
    ) => ({
      scheduleId: schedule.id,
      phase,
      slotKey,
      mainSlotKey,
      scheduledFor,
      mainScheduledFor,
      ...(expiredSkipReason ? { expiredSkipReason } : {}),
    });
  if (schedule.trigger.mode === 'once') {
    const onceAt = schedule.trigger.onceAt;
    if (!onceAt || !Number.isFinite(onceAt)) return [];
    const slotKey = `once@${onceAt}:main`;
    return !handledSlotKeys.has(slotKey) && nowMs >= onceAt && nowMs <= onceAt + graceMs
      ? [slot('main', slotKey, slotKey, onceAt, onceAt)]
      : [];
  }
  const nowDt = DateTime.fromMillis(nowMs, { zone: schedule.trigger.timeZone });
  if (!nowDt.isValid) return [];
  const rawArmedAt = Math.max(schedule.createdAt ?? 0, schedule.updatedAt ?? 0),
    armedCutoffMs = rawArmedAt >= 1_000_000_000_000 ? rawArmedAt - 60_000 : 0,
    due: Array<ReturnType<typeof slot>> = [],
    { weekdays, times, jitterMinutes } = schedule.trigger;
  for (const { ymd, hhmm, mainBaseMs, mainSlotKey, mainFireMs } of iterWeeklySlots(
    nowDt,
    -1,
    1,
    weekdays,
    times,
    schedule.id,
    jitterMinutes,
  )) {
    if (
      schedule.carrier === 'browser' &&
      schedule.prewarm.enabled &&
      schedule.prewarm.steps.length > 0
    ) {
      const preSlotKey = `${ymd}@${hhmm}:prewarm`;
      if (!handledSlotKeys.has(preSlotKey)) {
        const leadMs = schedule.prewarm.leadMinutes * 60_000,
          preBaseMs = mainBaseMs - leadMs,
          minLeadRemainMs = Math.min(15 * 60_000, Math.floor(leadMs * 0.35)),
          preJitter = deterministicJitterMs(schedule.id, preSlotKey, jitterMinutes),
          maxValidPreFireMs = mainFireMs - minLeadRemainMs - 60_000,
          preFireMs =
            preBaseMs < maxValidPreFireMs
              ? Math.min(preBaseMs + preJitter, maxValidPreFireMs)
              : preBaseMs + preJitter;
        if (nowMs >= preFireMs && preFireMs >= armedCutoffMs) {
          if (nowMs >= mainFireMs - minLeadRemainMs && nowMs <= mainFireMs + graceMs)
            due.push(
              slot(
                'prewarm',
                preSlotKey,
                mainSlotKey,
                preFireMs,
                mainFireMs,
                '开机/唤醒时已临近正点场，自动跳过过期预热以保障正点顶贴',
              ),
            );
          else if (nowMs <= preFireMs + graceMs && nowMs < mainFireMs - minLeadRemainMs)
            due.push(slot('prewarm', preSlotKey, mainSlotKey, preFireMs, mainFireMs));
        }
      }
    }
    if (
      !handledSlotKeys.has(mainSlotKey) &&
      nowMs >= mainFireMs &&
      nowMs <= mainFireMs + graceMs &&
      mainFireMs >= armedCutoffMs
    )
      due.push(slot('main', mainSlotKey, mainSlotKey, mainFireMs, mainFireMs));
  }
  return due.sort((a, b) => a.scheduledFor - b.scheduledFor);
}
const formatDayPrefix = (targetDt: DateTime, nowDt: DateTime) =>
    targetDt.hasSame(nowDt, 'day')
      ? '今天'
      : targetDt.hasSame(nowDt.plus({ days: 1 }), 'day')
        ? '明天'
        : targetDt.toFormat('MM-dd'),
  stepCountTag = (n: number, unit: string) => `${n}${unit}`,
  weekdayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export function computeUpcomingRunsPreview(
  input: {
    id?: string;
    mode?: 'weekly' | 'once';
    onceAt?: number | null;
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
): Array<{ nextAt: number; phase: AutoSchedulePhase; label: string }> {
  const zone = input.timeZone,
    nowDt = DateTime.fromMillis(nowMs, { zone });
  if (!nowDt.isValid) return [];
  if (input.mode === 'once') {
    const onceAt = input.onceAt;
    if (
      !onceAt ||
      !Number.isFinite(onceAt) ||
      onceAt <= nowMs ||
      handledSlotKeys.has(`once@${onceAt}:main`)
    )
      return [];
    const targetDt = DateTime.fromMillis(onceAt, { zone });
    return targetDt.isValid
      ? [
          {
            nextAt: onceAt,
            phase: 'main',
            label: `单次 · ${formatDayPrefix(targetDt, nowDt)} ${targetDt.toFormat('HH:mm')} 执行`,
          },
        ]
      : [];
  }
  if (!input.weekdays.length || !input.times.length) return [];
  const seedId = input.id ?? 'preview',
    candidates: Array<{ at: number; phase: AutoSchedulePhase; mainAt: number }> = [];
  for (const { ymd, hhmm, mainBaseMs, mainSlotKey, mainFireMs } of iterWeeklySlots(
    nowDt,
    -1,
    8,
    input.weekdays,
    input.times,
    seedId,
    input.jitterMinutes,
  )) {
    if (input.prewarmEnabled) {
      const preSlotKey = `${ymd}@${hhmm}:prewarm`,
        preFireMs =
          mainBaseMs -
          input.prewarmLeadMinutes * 60_000 +
          deterministicJitterMs(seedId, preSlotKey, input.jitterMinutes);
      if (preFireMs > nowMs && !handledSlotKeys.has(preSlotKey))
        candidates.push({ at: preFireMs, phase: 'prewarm', mainAt: mainFireMs });
    }
    if (mainFireMs > nowMs && !handledSlotKeys.has(mainSlotKey))
      candidates.push({ at: mainFireMs, phase: 'main', mainAt: mainFireMs });
  }
  return candidates
    .sort((a, b) => a.at - b.at)
    .slice(0, Math.max(1, count))
    .map((item) => {
      const targetDt = DateTime.fromMillis(item.at, { zone }),
        prefix = `${formatDayPrefix(targetDt, nowDt)} ${targetDt.toFormat('HH:mm')}`;
      return {
        nextAt: item.at,
        phase: item.phase,
        label:
          item.phase === 'prewarm'
            ? `${prefix} 预热（正点 ${DateTime.fromMillis(item.mainAt, { zone }).toFormat('HH:mm')}）`
            : `${prefix} 执行`,
      };
    });
}
export function computeNextRunPreview(
  schedule: AutoSchedule,
  nowMs: number,
  handledSlotKeys: ReadonlySet<string> = new Set(),
): NextRunPreview {
  if (!schedule.enabled) return { nextAt: null, phase: null, label: '已停用' };
  const zone = schedule.trigger.timeZone;
  if (!DateTime.fromMillis(nowMs, { zone }).isValid)
    return { nextAt: null, phase: null, label: '时区无效' };
  return (
    computeUpcomingRunsPreview(
      {
        id: schedule.id,
        mode: schedule.trigger.mode,
        onceAt: schedule.trigger.onceAt,
        weekdays: schedule.trigger.weekdays,
        times: schedule.trigger.times,
        timeZone: zone,
        jitterMinutes: schedule.trigger.jitterMinutes,
        prewarmEnabled:
          schedule.trigger.mode !== 'once' &&
          schedule.carrier === 'browser' &&
          schedule.prewarm.enabled &&
          schedule.prewarm.steps.length > 0,
        prewarmLeadMinutes: schedule.carrier === 'browser' ? schedule.prewarm.leadMinutes : 90,
      },
      nowMs,
      1,
      handledSlotKeys,
    )[0] ?? {
      nextAt: null,
      phase: null,
      label: schedule.trigger.mode === 'once' ? '单次已到期' : '暂无未来计划',
    }
  );
}
export function formatWeekdaysLabel(weekdays: readonly number[]): string {
  const sorted = [...new Set(weekdays)].sort((a, b) => a - b);
  if (sorted.length === 7) return '每天';
  const joined = sorted.join(',');
  if (joined === '1,2,3,4,5') return '工作日 (周一至周五)';
  if (joined === '6,7') return '周末 (周六至周日)';
  return sorted
    .map((d) => weekdayNames[d] ?? '')
    .filter(Boolean)
    .join('、');
}
export function formatStepShortLabel(step: BrowserPipelineStep | BluestacksPipelineStep): string {
  const p = step.type.startsWith('bluestacks-') ? '蓝蝶' : '';
  if (step.type === 'quick-browse' || step.type === 'bluestacks-quick-browse')
    return `${p}${step.target === 'video' ? '刷视频' : '刷首页'} ${step.durationMinutes} 分钟`;
  if (step.type === 'active-combination' || step.type === 'bluestacks-active-combination')
    return `${p}执行活跃组合`;
  if (step.type === 'group-bumper')
    return `小组顶贴 (${stepCountTag(step.groupIds.length, '组')}/${stepCountTag(step.pageIds.length, '专页')})`;
  if (step.type === 'page-bumper' || step.type === 'bluestacks-page-bumper')
    return `${p}专页顶贴 (${stepCountTag(step.pageIds.length, '专页')})`;
  if (step.type === 'group-poster' || step.type === 'bluestacks-group-poster')
    return `${p}小组发帖 (单号≤${step.maxGroupsPerProfile}组)`;
  if (step.type === 'group-inviter')
    return `小组邀人 (${step.groupIds.length}组 · 每组${step.invitesPerGroup}人)`;
  if (step.type === 'bluestacks-group-inviter') return `蓝蝶小组邀人 (${step.groupIds.length}组)`;
  if (step.type === 'bluestacks-group-bumper') return `蓝蝶小组顶贴 (${step.groupIds.length}组)`;
  return step.autoInstallApk ? '蓝蝶健康体检（缺包自装）' : '蓝蝶健康体检';
}
