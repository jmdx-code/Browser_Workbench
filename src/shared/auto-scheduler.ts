import { DateTime } from 'luxon';
import { z } from 'zod';
import {
  Id,
  NonNegInt,
  NumNull,
  PosInt,
  TaskTimeZone,
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
import { TEST_COMBINATION_NOTE } from './task-tests.js';
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
const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
function stripKeys(val: unknown, keys: readonly string[]): unknown {
  if (!isRec(val)) return val;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val)) if (!keys.includes(k)) out[k] = v;
  return out;
}
function normalizeLegacyScheduleInput(raw: unknown, dropLegacyQuickBrowse: boolean): unknown {
  if (!isRec(raw)) return raw;
  const cleaned = stripKeys(raw, ['prewarm']) as Record<string, unknown>;
  if (isRec(cleaned.trigger)) cleaned.trigger = stripKeys(cleaned.trigger, ['jitterMinutes']);
  if (Array.isArray(cleaned.steps)) {
    cleaned.steps = cleaned.steps
      .filter(
        (s) =>
          !dropLegacyQuickBrowse ||
          !isRec(s) ||
          (s.type !== 'quick-browse' && s.type !== 'bluestacks-quick-browse'),
      )
      .map((s) => stripKeys(s, ['playSoundOnComplete', 'settingsOverride']));
  }
  return cleaned;
}
export const AutoScheduleCarrier = z.enum(['browser', 'bluestacks']);
export type AutoScheduleCarrier = z.infer<typeof AutoScheduleCarrier>;
export const AutoSchedulerGlobalSettings = strictObj({
  browserConcurrency: intRange(1, 50).default(15),
  bluestacksConcurrency: intRange(1, 30).default(5),
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
const AutoScheduleTrigger = z.preprocess(
  (v) => stripKeys(v, ['jitterMinutes']),
  strictObj({
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
    misfireGraceMinutes: intRange(5, 360).default(120),
  }),
);
type AutoScheduleTrigger = z.infer<typeof AutoScheduleTrigger>;
const activeCombo = <T extends 'active-combination' | 'bluestacks-active-combination'>(type: T) =>
  strictObj({ id: Id, type: z.literal(type), combinationId: Id });
const inviterStep = <T extends 'group-inviter' | 'bluestacks-group-inviter'>(type: T) =>
  strictObj({
    id: Id,
    type: z.literal(type),
    groupIds: GroupIdsReq,
    invitesPerGroup: intRange(1, 50).default(5),
  });
const posterFields = {
  id: Id,
  materialIds: z.array(Id).min(1, '请至少选择一张发帖素材卡').max(100),
  maxGroupsPerProfile: intRange(1, 50).default(3),
  materialsPerGroup: intRange(1, 50).optional(),
};
export const BrowserPipelineStep = z.preprocess(
  (v) => stripKeys(v, ['playSoundOnComplete', 'settingsOverride']),
  z.discriminatedUnion('type', [
    activeCombo('active-combination'),
    strictObj({
      id: Id,
      type: z.literal('group-bumper'),
      groupIds: GroupIdsReq,
      pageIds: BumperPageIdsReq,
    }),
    strictObj({ id: Id, type: z.literal('page-bumper'), pageIds: PageIdsReq }),
    strictObj({ ...posterFields, type: z.literal('group-poster'), groupIds: GroupIdsReq }),
    inviterStep('group-inviter'),
  ]),
);
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
export const BluestacksPipelineStep = z.preprocess(
  (v) => stripKeys(v, ['playSoundOnComplete', 'settingsOverride']),
  z.discriminatedUnion('type', [
    strictObj({ id: Id, type: z.literal('bluestacks-health-check'), autoInstallApk: boolF }),
    activeCombo('bluestacks-active-combination'),
    BluestacksGroupPosterStep,
    strictObj({
      id: Id,
      type: z.literal('bluestacks-group-bumper'),
      groupIds: GroupIdsReq,
      pageIds: BumperPageIdsReq,
      enableSound: optBool,
    }),
    strictObj({
      id: Id,
      type: z.literal('bluestacks-page-bumper'),
      pageIds: PageIdsReq,
      enableSound: optBool,
    }),
    inviterStep('bluestacks-group-inviter'),
  ]),
);
export type BluestacksPipelineStep = z.infer<typeof BluestacksPipelineStep>;
const AutoScheduleBase = {
  id: Id,
  name: trimReq(80).min(1, '请填写排班名称'),
  enabled: boolT,
  targetSelector: AutoScheduleTargetSelector,
  trigger: AutoScheduleTrigger,
  closeWindowOnFinish: boolT,
  maxSafetyMinutesPerTarget: intRange(0, 720).nullable().default(null),
  sortOrder: n0,
  armedAt: NonNegInt.optional(),
  createdAt: NonNegInt,
  updatedAt: NonNegInt,
};
const BrowserAutoSchedule = strictObj({
  ...AutoScheduleBase,
  carrier: z.literal('browser'),
  steps: z.array(BrowserPipelineStep).min(1, '请至少配置一个正点动作').max(12),
});
const BluestacksAutoSchedule = strictObj({
  ...AutoScheduleBase,
  carrier: z.literal('bluestacks'),
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
const AutoScheduleUnion = z
  .discriminatedUnion('carrier', [BrowserAutoSchedule, BluestacksAutoSchedule])
  .superRefine(validateScheduleRefinements);
export const AutoSchedule = z.preprocess(
  (v) => normalizeLegacyScheduleInput(v, true),
  AutoScheduleUnion,
);
export type AutoSchedule = z.infer<typeof AutoScheduleUnion>;
const omitBase = { id: true, sortOrder: true, createdAt: true, updatedAt: true } as const;
const SaveAutoScheduleUnion = z
  .discriminatedUnion('carrier', [
    BrowserAutoSchedule.omit(omitBase).extend({ id: Id.optional() }).strict(),
    BluestacksAutoSchedule.omit(omitBase).extend({ id: Id.optional() }).strict(),
  ])
  .superRefine(validateScheduleRefinements);
export const SaveAutoScheduleInput = z.preprocess(
  (v) => normalizeLegacyScheduleInput(v, false),
  SaveAutoScheduleUnion,
);
export type SaveAutoScheduleInput = z.infer<typeof SaveAutoScheduleUnion>;
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
  'skipped',
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
const AutoScheduleRunItemObj = strictObj({
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
  startedAt: nullNn,
  finishedAt: nullNn,
  updatedAt: NonNegInt,
});
export const AutoScheduleRunItem = z.preprocess(
  (v) => stripKeys(v, ['seamlessHandoff']),
  AutoScheduleRunItemObj,
);
export type AutoScheduleRunItem = z.infer<typeof AutoScheduleRunItemObj>;
export const AutoScheduleRun = strictObj({
  id: Id,
  scheduleId: Id,
  scheduleName: sMax(120),
  carrier: AutoScheduleCarrier,
  phase: z.literal('main').catch('main').default('main'),
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
type NextRunPreview = { nextAt: number | null; label: string };
type AutoScheduleView = AutoSchedule & { resolvedTargetCount: number; nextRun: NextRunPreview };
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
function* iterWeeklySlots(
  nowDt: DateTime,
  minOffset: number,
  maxOffset: number,
  weekdays: readonly number[],
  times: readonly string[],
) {
  for (let offset = minOffset; offset <= maxOffset; offset++) {
    const dayStart = nowDt.plus({ days: offset }).startOf('day');
    if (!weekdays.includes(dayStart.weekday)) continue;
    const ymd = dayStart.toFormat('yyyy-MM-dd');
    for (const hhmm of times) {
      const [hStr, mStr] = hhmm.split(':'),
        mainFireMs = dayStart
          .set({ hour: Number(hStr), minute: Number(mStr), second: 0, millisecond: 0 })
          .toMillis(),
        mainSlotKey = `${ymd}@${hhmm}:main`;
      yield { ymd, hhmm, mainSlotKey, mainFireMs };
    }
  }
}
type DueTrigger = {
  scheduleId: string;
  slotKey: string;
  scheduledFor: number;
  expiredSkipReason?: string;
};
export function computeDueScheduleTriggers(
  schedule: AutoSchedule,
  nowMs: number,
  handledSlotKeys: ReadonlySet<string>,
): DueTrigger[] {
  if (!schedule.enabled) return [];
  const graceMs = schedule.trigger.misfireGraceMinutes * 60_000;
  if (schedule.trigger.mode === 'once') {
    const onceAt = schedule.trigger.onceAt;
    if (!onceAt || !Number.isFinite(onceAt)) return [];
    const slotKey = `once@${onceAt}:main`;
    if (handledSlotKeys.has(slotKey) || nowMs < onceAt) return [];
    return [
      {
        scheduleId: schedule.id,
        slotKey,
        scheduledFor: onceAt,
        ...(nowMs <= onceAt + graceMs
          ? {}
          : { expiredSkipReason: '单次定时已超过宽限窗，自动跳过并停用' }),
      },
    ];
  }
  const nowDt = DateTime.fromMillis(nowMs, { zone: schedule.trigger.timeZone });
  if (!nowDt.isValid) return [];
  const rawArmedAt = schedule.armedAt ?? schedule.createdAt ?? 0;
  const armedCutoffMs = rawArmedAt >= 1_000_000_000_000 ? rawArmedAt - 60_000 : 0;
  const due: DueTrigger[] = [];
  const { weekdays, times } = schedule.trigger;
  for (const { mainSlotKey, mainFireMs } of iterWeeklySlots(nowDt, -1, 1, weekdays, times))
    if (
      !handledSlotKeys.has(mainSlotKey) &&
      nowMs >= mainFireMs &&
      nowMs <= mainFireMs + graceMs &&
      mainFireMs >= armedCutoffMs
    )
      due.push({ scheduleId: schedule.id, slotKey: mainSlotKey, scheduledFor: mainFireMs });
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
  },
  nowMs: number,
  count = 3,
  handledSlotKeys: ReadonlySet<string> = new Set(),
): Array<{ nextAt: number; label: string }> {
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
            label: `单次 · ${formatDayPrefix(targetDt, nowDt)} ${targetDt.toFormat('HH:mm')} 执行`,
          },
        ]
      : [];
  }
  if (!input.weekdays.length || !input.times.length) return [];
  const candidates: number[] = [];
  for (const { mainSlotKey, mainFireMs } of iterWeeklySlots(
    nowDt,
    -1,
    8,
    input.weekdays,
    input.times,
  )) {
    if (mainFireMs > nowMs && !handledSlotKeys.has(mainSlotKey)) candidates.push(mainFireMs);
  }
  return candidates
    .sort((a, b) => a - b)
    .slice(0, Math.max(1, count))
    .map((at) => {
      const targetDt = DateTime.fromMillis(at, { zone });
      return {
        nextAt: at,
        label: `${formatDayPrefix(targetDt, nowDt)} ${targetDt.toFormat('HH:mm')} 执行`,
      };
    });
}
export function computeNextRunPreview(
  schedule: AutoSchedule,
  nowMs: number,
  handledSlotKeys: ReadonlySet<string> = new Set(),
): NextRunPreview {
  if (!schedule.enabled) return { nextAt: null, label: '已停用' };
  const zone = schedule.trigger.timeZone;
  if (!DateTime.fromMillis(nowMs, { zone }).isValid) return { nextAt: null, label: '时区无效' };
  return (
    computeUpcomingRunsPreview(
      {
        id: schedule.id,
        mode: schedule.trigger.mode,
        onceAt: schedule.trigger.onceAt,
        weekdays: schedule.trigger.weekdays,
        times: schedule.trigger.times,
        timeZone: zone,
      },
      nowMs,
      1,
      handledSlotKeys,
    )[0] ?? {
      nextAt: null,
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
