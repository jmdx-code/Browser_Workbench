import type { z } from 'zod';
import type { AutoScheduleRun } from '../../shared/auto-scheduler.js';
import { profileDisplayName, type Profile } from '../../shared/contracts.js';
import type { GoogleSheetsActiveProfile } from '../../shared/google-sheets.js';
import type { BumperProfileStat } from '../../shared/group-bumper.js';
import type { GroupInviterProfileStat } from '../../shared/group-inviter.js';
import type { PosterProfileStat } from '../../shared/group-poster.js';
import { profileTaskResultLabel } from '../../shared/profile-task-result.js';
import type { TaskRuntimeOverview } from '../../shared/task-contracts.js';
import { taskReasonDescription } from '../../shared/task-issues.js';
import {
  BREADCRUMB_LABELS,
  buildFeatureNavItems,
  MODULE_LABELS,
  type FeatureModuleId,
  type ProfileActivityDescriptor,
  type SelectionControlSummary,
} from './module-contracts.js';
export function stepName(step: {
  type: string;
  feedMode?: string | undefined;
  friendAction?: string | undefined;
  destination?: string | undefined;
}): string {
  if (step.type === 'feed') {
    if (step.feedMode === 'search_pages') return '搜专页逛时间线';
    if (step.feedMode === 'random_profile') return '逛他人时间线';
    if (step.feedMode === 'random_page') return '逛公共专页';
    return '浏览首页';
  }
  if (step.type === 'video') return '浏览 Reels';
  if (step.type === 'marketplace') return '浏览商城';
  if (step.type === 'friends')
    return step.friendAction === 'add_suggested' ? '加推荐好友' : '接受好友';
  if (step.type === 'post') return step.destination === 'story' ? '发布快拍' : '发帖';
  return step.type;
}
export { buildFeatureNavItems } from './module-contracts.js';
interface SchedulerActiveProfileInfo {
  scheduleName: string;
  status: 'running' | 'queued';
  currentStep: string;
  summary: string;
}
type TasksOverview = z.infer<typeof TaskRuntimeOverview>;
type RunFlags = Record<string, { running: boolean }>;
const ENDED_STATES = ['STOPPED', 'COMPLETED', 'FAILED'];
const runningStatIds = (counts?: RunFlags) =>
  Object.entries(counts ?? {})
    .filter(([, s]) => s.running)
    .map(([id]) => id);
const countRunning = (counts: RunFlags | undefined) =>
  Object.values(counts ?? {}).filter((s) => s.running).length;
const bgRun = (moduleId: FeatureModuleId, moduleLabel: string): ProfileActivityDescriptor => ({
  moduleId,
  moduleLabel,
  running: true,
  tone: 'run',
  text: `${moduleLabel} · 运行中`,
  tooltipLines: [`${moduleLabel}正在后台运行`],
});
const toneFor = (
  running: boolean,
  status: string,
  errRe: RegExp,
  extraErr?: boolean,
): ProfileActivityDescriptor['tone'] =>
  running ? 'run' : extraErr || errRe.test(status) ? 'err' : /停止/.test(status) ? 'pause' : 'ok';
function extractSchedulerMap(
  activeRuns?: readonly Pick<AutoScheduleRun, 'carrier' | 'scheduleName' | 'items'>[],
) {
  const map: Record<string, SchedulerActiveProfileInfo> = {};
  for (const run of activeRuns ?? []) {
    if (run.carrier !== 'browser') continue;
    for (const item of run.items ?? []) {
      if (
        (item.status === 'running' || item.status === 'queued') &&
        (!map[item.targetId] || item.status === 'running')
      ) {
        map[item.targetId] = {
          scheduleName: run.scheduleName,
          status: item.status,
          currentStep: item.currentStep,
          summary: item.summary,
        };
      }
    }
  }
  return map;
}
function fmtScheduler(info: SchedulerActiveProfileInfo): ProfileActivityDescriptor {
  return {
    moduleId: 'auto-scheduler',
    moduleLabel: '定时排班',
    running: true,
    tone: info.status === 'running' ? 'run' : 'queue',
    text:
      info.status === 'running' ? `排班 · ${info.currentStep}` : `排班排队 · ${info.scheduleName}`,
    tooltipLines: [`定时排班：${info.scheduleName}`, `${info.currentStep} · ${info.summary}`],
  };
}
function fmtSheets(info: GoogleSheetsActiveProfile): ProfileActivityDescriptor {
  const moduleId: FeatureModuleId =
    info.kind === 'post_schedule' ? 'sheets-schedule' : 'sheets-records';
  const moduleLabel =
    info.kind === 'post_schedule' ? '云表排贴' : info.kind === 'metrics' ? '云表采集' : '云表顶贴';
  const status = info.status.trim() || '运行中';
  return {
    moduleId,
    moduleLabel,
    running: true,
    tone: 'run',
    text: `${moduleLabel} · ${status}`,
    tooltipLines: [`${moduleLabel}：${info.title}`, status],
  };
}
const posterAct = (
  s: PosterProfileStat | undefined,
  running: boolean,
): ProfileActivityDescriptor => {
  const status = s?.status ?? '未运行',
    today = s?.today ?? 0,
    session = s?.session ?? 0;
  return {
    moduleId: 'group-poster',
    moduleLabel: '小组发帖',
    running: Boolean(s?.running || running),
    tone: toneFor(Boolean(s?.running || running), status, /受限|验证|中断|失败/, s?.restricted),
    text: `今日 ${today} · 本轮 ${session} · ${status}`,
    tooltipLines: [`小组发帖：今日 ${today} 贴 · 本轮 ${session} 贴 · ${status}`],
  };
};
const bumperAct = (
  mod: 'group-bumper' | 'page-bumper',
  s: BumperProfileStat | undefined,
  running: boolean,
): ProfileActivityDescriptor => {
  const label = mod === 'page-bumper' ? '专页顶贴' : '小组顶贴',
    status = s?.status ?? (running ? '运行中' : '未运行');
  return {
    moduleId: mod,
    moduleLabel: label,
    running,
    tone: toneFor(running, status, /受限|验证|中断|失败|异常|未确认/),
    text: `今日 ${s?.today ?? 0} · 本轮 ${s?.session ?? 0} · ${status}`,
    tooltipLines: [`${label}：今日 ${s?.today ?? 0} 次 · 本轮 ${s?.session ?? 0} 次 · ${status}`],
  };
};
const inviterAct = (
  s: GroupInviterProfileStat | undefined,
  running: boolean,
): ProfileActivityDescriptor => {
  const st = s?.status ?? '',
    summary = `本次邀请 ${s?.sessionInvited ?? 0} 人 · 累计 ${s?.totalInvited ?? 0} 人${st ? ' · ' + st : ''}`;
  return {
    moduleId: 'group-inviter',
    moduleLabel: '小组邀请人',
    running,
    tone: toneFor(running, st, /失败|未确认|不可|异常|离线/),
    text: summary,
    tooltipLines: [`小组邀请人：${summary}`],
  };
};
export interface ProfileActivityProjectionInput {
  activeModule?: FeatureModuleId;
  tasks?: TasksOverview | null;
  bumperCounts?: Record<string, BumperProfileStat>;
  bumperRunningIds?: readonly string[];
  bumperModuleId?: 'group-bumper' | 'page-bumper';
  pageBumperRunningIds?: readonly string[];
  groupInviterCounts?: Record<string, GroupInviterProfileStat> | null;
  groupInviterRunningIds?: readonly string[];
  groupPosterCounts?: Record<string, PosterProfileStat>;
  groupPosterRunningIds?: readonly string[];
  schedulerBrowserMap?: Record<string, SchedulerActiveProfileInfo>;
  googleSheetsActiveMap?: Record<string, GoogleSheetsActiveProfile>;
}
interface IndexedActivityLookup {
  activePlanByProfile: Map<string, TasksOverview['plans'][number]>;
  stepByJobId: Map<string, TasksOverview['currentSteps'][number]>;
  resultByProfile: Map<string, NonNullable<TasksOverview['profileResults']>[number]>;
  posterRunningSet: Set<string>;
  bumperRunningSet: Set<string>;
  pageBumperRunningSet: Set<string>;
  inviterRunningSet: Set<string>;
}
function indexBy<T>(
  items: readonly T[] | undefined,
  key: (v: T) => string,
  skip?: (v: T) => boolean,
) {
  const m = new Map<string, T>();
  for (const v of items ?? []) if (!skip?.(v) && !m.has(key(v))) m.set(key(v), v);
  return m;
}
function buildIndexedLookup(input: ProfileActivityProjectionInput): IndexedActivityLookup {
  return {
    activePlanByProfile: indexBy(
      input.tasks?.plans,
      (p) => p.profileId,
      (p) => ENDED_STATES.includes(p.state),
    ),
    stepByJobId: indexBy(input.tasks?.currentSteps, (s) => s.jobId),
    resultByProfile: indexBy(input.tasks?.profileResults, (r) => r.profileId),
    posterRunningSet: new Set(input.groupPosterRunningIds ?? []),
    bumperRunningSet: new Set(input.bumperRunningIds ?? []),
    pageBumperRunningSet: new Set(input.pageBumperRunningIds ?? []),
    inviterRunningSet: new Set(input.groupInviterRunningIds ?? []),
  };
}
function buildStepProgressView(
  plan: TasksOverview['plans'][number],
  step: TasksOverview['currentSteps'][number] | undefined,
): ProfileActivityDescriptor['progressView'] | undefined {
  if (!step || plan.state !== 'RUNNING') return undefined;
  const spec =
    plan.snapshot.steps.find((item) => item.id === step.id) ?? plan.snapshot.steps[plan.position];
  return {
    type: step.type,
    friendAction: step.friendAction,
    progress: step.progress,
    budget: step.budget,
    maxLikes: step.maxLikes ?? (spec && 'maxLikes' in spec ? spec.maxLikes : undefined),
  };
}
export function projectProfileActivity(
  profileOrId: string | { id: string },
  input: ProfileActivityProjectionInput,
  indexed?: IndexedActivityLookup,
): ProfileActivityDescriptor | null {
  const pid = typeof profileOrId === 'string' ? profileOrId : profileOrId.id;
  const plan = indexed
    ? indexed.activePlanByProfile.get(pid)
    : input.tasks?.plans.find((v) => v.profileId === pid && !ENDED_STATES.includes(v.state));
  const step = plan
    ? indexed
      ? indexed.stepByJobId.get(plan.id)
      : input.tasks?.currentSteps.find((v) => v.jobId === plan.id)
    : undefined;
  const schedInfo = input.schedulerBrowserMap?.[pid];
  if (schedInfo?.status === 'running') {
    const pv = plan ? buildStepProgressView(plan, step) : undefined;
    return pv ? { ...fmtScheduler(schedInfo), progressView: pv } : fmtScheduler(schedInfo);
  }
  const sheetInfo = input.googleSheetsActiveMap?.[pid];
  if (sheetInfo) return fmtSheets(sheetInfo);
  const hasId = (set: Set<string> | undefined, arr: readonly string[] | undefined) =>
    indexed ? Boolean(set?.has(pid)) : arr?.includes(pid) === true;
  if (
    hasId(indexed?.posterRunningSet, input.groupPosterRunningIds) ||
    input.groupPosterCounts?.[pid]?.running
  ) {
    const stat = input.groupPosterCounts?.[pid];
    return stat ? posterAct(stat, true) : bgRun('group-poster', '小组发帖');
  }
  if (
    hasId(indexed?.bumperRunningSet, input.bumperRunningIds) ||
    input.bumperCounts?.[pid]?.running
  ) {
    const isPage =
      hasId(indexed?.pageBumperRunningSet, input.pageBumperRunningIds) ||
      (input.bumperModuleId === 'page-bumper' && input.bumperCounts?.[pid]?.running === true);
    const mod: 'group-bumper' | 'page-bumper' = isPage ? 'page-bumper' : 'group-bumper';
    const stat =
      (input.bumperModuleId ?? 'group-bumper') === mod ? input.bumperCounts?.[pid] : undefined;
    return stat ? bumperAct(mod, stat, true) : bgRun(mod, isPage ? '专页顶贴' : '小组顶贴');
  }
  if (hasId(indexed?.inviterRunningSet, input.groupInviterRunningIds)) {
    const stat = input.groupInviterCounts?.[pid];
    return stat ? inviterAct(stat, true) : bgRun('group-inviter', '小组邀请人');
  }
  if (plan) {
    const reasonSummary = plan.reason ? taskReasonDescription(plan.reason)?.summary : undefined;
    const prefix =
      plan.snapshot.steps.length > 1 ? `[${plan.position + 1}/${plan.snapshot.steps.length}] ` : '';
    const stepLabel =
      plan.state === 'QUEUED'
        ? reasonSummary
          ? '排队中 · ' + reasonSummary
          : '排队中'
        : step
          ? prefix + stepName(step) + ' · 执行中'
          : '运行中';
    const showRound =
      plan.round > 1 || plan.snapshot.loop.mode !== 'finite' || plan.snapshot.loop.rounds > 1;
    const roundSeg = showRound
      ? ` · 第${plan.round}轮${plan.snapshot.loop.mode === 'finite' ? '/' + plan.snapshot.loop.rounds : '（循环）'}`
      : '';
    return {
      moduleId: 'active-accounts',
      moduleLabel: '活跃账号',
      running: plan.state === 'RUNNING' || plan.state === 'QUEUED',
      tone: plan.state === 'RUNNING' ? 'run' : plan.state === 'QUEUED' ? 'queue' : 'pause',
      text: plan.state === 'RUNNING' && step ? stepLabel : plan.snapshot.name + ' · ' + stepLabel,
      tooltipLines: [
        `任务：${plan.snapshot.name}${roundSeg} · 第${plan.position + 1}/${plan.snapshot.steps.length}项`,
        ...(reasonSummary || plan.reason ? [reasonSummary ?? plan.reason ?? ''] : []),
      ],
      progressView: buildStepProgressView(plan, step),
    };
  }
  if (schedInfo) return fmtScheduler(schedInfo);
  for (const [counts, render] of [
    [input.groupPosterCounts, () => posterAct(input.groupPosterCounts?.[pid], false)],
    [
      input.bumperCounts,
      () => bumperAct(input.bumperModuleId ?? 'group-bumper', input.bumperCounts?.[pid], false),
    ],
    [input.groupInviterCounts, () => inviterAct(input.groupInviterCounts?.[pid], false)],
  ] as const) {
    const stat = counts?.[pid],
      activeCount = stat && ('sessionInvited' in stat ? stat.sessionInvited : stat.session);
    if (counts && stat && ((activeCount ?? 0) > 0 || (stat.status && stat.status !== '未运行')))
      return render();
  }
  const lastResult = indexed
    ? indexed.resultByProfile.get(pid)
    : input.tasks?.profileResults?.find((v) => v.profileId === pid);
  const lastStatus = lastResult ? profileTaskResultLabel(lastResult) : undefined;
  if (lastResult && lastStatus) {
    const sourceModule: FeatureModuleId =
      lastResult.source in MODULE_LABELS
        ? (lastResult.source as FeatureModuleId)
        : 'active-accounts';
    return {
      moduleId: sourceModule,
      moduleLabel: MODULE_LABELS[sourceModule] ?? '活跃账号',
      running: false,
      tone: lastStatus.tone,
      text: lastStatus.text,
      tooltipLines: [
        lastStatus.text,
        '结束：' + new Date(lastResult.finishedAt).toLocaleString(),
        ...(lastResult.reason
          ? [taskReasonDescription(lastResult.reason)?.summary ?? lastResult.reason]
          : []),
      ],
    };
  }
  if (input.groupPosterCounts) return posterAct(input.groupPosterCounts[pid], false);
  if (input.bumperCounts)
    return bumperAct(input.bumperModuleId ?? 'group-bumper', input.bumperCounts[pid], false);
  if (input.groupInviterCounts) return inviterAct(input.groupInviterCounts[pid], false);
  return null;
}
export function projectProfileActivitiesMap(
  profiles: readonly Pick<Profile, 'id'>[],
  input: ProfileActivityProjectionInput,
) {
  const indexed = buildIndexedLookup(input),
    map = new Map<string, ProfileActivityDescriptor>();
  for (const profile of profiles) {
    const d = projectProfileActivity(profile.id, input, indexed);
    if (d) map.set(profile.id, d);
  }
  return map;
}
export function projectSelectionControls(
  selected: ReadonlySet<string>,
  input: ProfileActivityProjectionInput,
): SelectionControlSummary {
  const plans = input.tasks?.plans ?? [],
    schedOwnedIds = new Set(Object.keys(input.schedulerBrowserMap ?? {}));
  const stoppable = plans.filter(
    (p) =>
      selected.has(p.profileId) &&
      !schedOwnedIds.has(p.profileId) &&
      !ENDED_STATES.includes(p.state),
  );
  const runningModuleIds = new Set<string>([
    ...(input.groupInviterRunningIds ?? []),
    ...(input.bumperRunningIds ?? []),
    ...(input.groupPosterRunningIds ?? []),
    ...schedOwnedIds,
    ...Object.keys(input.googleSheetsActiveMap ?? {}),
  ]);
  const stoppableModuleProfileIds = [...selected].filter((id) => runningModuleIds.has(id));
  const activePlanProfileIds = new Set(
    plans.filter((p) => !ENDED_STATES.includes(p.state)).map((p) => p.profileId),
  );
  return {
    stoppableTargets: stoppable.map((p) => ({
      profileId: p.profileId,
      planId: p.id,
      expectedState: p.state,
      expectedUpdatedAt: p.updatedAt,
    })),
    stoppableModuleProfileIds,
    totalStoppableCount: new Set([
      ...stoppable.map((p) => p.profileId),
      ...stoppableModuleProfileIds,
    ]).size,
    isProfileBusy: (pid: string) => activePlanProfileIds.has(pid) || runningModuleIds.has(pid),
  };
}
type CountsArg<T> = Record<string, T>;
export interface WorkbenchProjectionParams {
  viewKind: FeatureModuleId | 'home' | 'edit';
  profiles: readonly Profile[] | undefined;
  selected: ReadonlySet<string>;
  tasks: TasksOverview | null | undefined;
  groupBumper:
    | {
        running: boolean;
        profileCounts: CountsArg<BumperProfileStat>;
        pageBumperRunning?: boolean;
        pageBumperProfileCounts?: CountsArg<BumperProfileStat>;
      }
    | null
    | undefined;
  groupInviter:
    { running: boolean; profileCounts: CountsArg<GroupInviterProfileStat> } | null | undefined;
  groupPoster?: { running: boolean; profileCounts: CountsArg<PosterProfileStat> } | null;
  bluestacks?: {
    running: boolean;
    profileCounts: CountsArg<BumperProfileStat>;
    pageBumperRunning?: boolean;
    pageBumperProfileCounts?: CountsArg<BumperProfileStat>;
    activeRunning?: boolean;
    activeProfileCounts?: RunFlags;
    posterRunning?: boolean;
    posterProfileCounts?: RunFlags;
    inviterRunning?: boolean;
    inviterProfileCounts?: RunFlags;
  } | null;
  autoScheduler?: {
    running: boolean;
    activeBrowserWorkers: number;
    activeBluestacksWorkers: number;
    schedules: readonly { enabled: boolean }[];
    activeRuns?: readonly AutoScheduleRun[];
  } | null;
  googleSheets?: {
    runningScheduleCount: number;
    runningRecordsCount: number;
    activeProfiles?: readonly GoogleSheetsActiveProfile[];
    links: readonly {
      kind: string;
      enabled: boolean;
      scheduleConfig?: { enabled: boolean };
      recordsConfig?: { enabled: boolean };
    }[];
  } | null;
  attentionCount?: number;
  message: string;
  carrier?: 'browser' | 'bluestacks';
}
export function buildWorkbenchProjection(p: WorkbenchProjectionParams) {
  const {
    viewKind,
    profiles,
    selected,
    tasks,
    groupBumper,
    groupInviter,
    groupPoster,
    bluestacks,
    autoScheduler,
    googleSheets,
    attentionCount,
    message,
    carrier,
  } = p;
  const plans = tasks?.plans ?? [];
  const groupBumperRunningIds = runningStatIds(groupBumper?.profileCounts);
  const pageBumperRunningIds = runningStatIds(groupBumper?.pageBumperProfileCounts);
  const bumperRunningIds = [...new Set([...groupBumperRunningIds, ...pageBumperRunningIds])];
  const inviterRunningIds = groupInviter?.running
    ? Object.entries(groupInviter.profileCounts)
        .filter(
          ([, s]) =>
            s.running === true ||
            (s.running !== false &&
              Boolean(
                s.status &&
                !['已完成', '已停止'].includes(s.status) &&
                !s.status.startsWith('失败') &&
                !s.status.startsWith('跳过'),
              )),
        )
        .map(([id]) => id)
    : [];
  const posterRunningIds = groupPoster?.running ? runningStatIds(groupPoster.profileCounts) : [];
  const schedulerBrowserMap = extractSchedulerMap(autoScheduler?.activeRuns);
  const googleSheetsActiveMap = Object.fromEntries(
    (googleSheets?.activeProfiles ?? []).filter((i) => i.profileId).map((i) => [i.profileId, i]),
  );
  const countSheets = (kind: string, key: 'scheduleConfig' | 'recordsConfig') =>
    googleSheets?.links.filter((l) => l.kind === kind && l.enabled && l[key]?.enabled).length ?? 0;
  const bsCount = (flag: boolean | undefined, counts: RunFlags | undefined) =>
    flag ? Math.max(1, countRunning(counts)) : 0;
  const activeSheetsModule =
    viewKind === 'sheets-schedule' ||
    viewKind === 'sheets-records' ||
    viewKind === 'sheets-groups' ||
    viewKind === 'sheets-pages'
      ? viewKind
      : undefined;
  const navItems = buildFeatureNavItems({
    carrier: carrier ?? (viewKind.startsWith('bluestacks-') ? 'bluestacks' : 'browser'),
    ...(activeSheetsModule ? { activeSheetsModule } : {}),
    autoSchedulerRunningCount: autoScheduler?.running
      ? Math.max(1, autoScheduler.activeBrowserWorkers + autoScheduler.activeBluestacksWorkers)
      : 0,
    autoSchedulerEnabledCount: autoScheduler?.schedules.filter((s) => s.enabled).length ?? 0,
    activeAccountRunningCount: new Set(
      plans.filter((pl) => !ENDED_STATES.includes(pl.state)).map((pl) => pl.profileId),
    ).size,
    groupInviterRunning: Boolean(groupInviter?.running),
    inviterRunningCount: inviterRunningIds.length,
    groupBumperRunning: Boolean(groupBumper?.running),
    bumperRunningCount: groupBumperRunningIds.length,
    pageBumperRunningCount: groupBumper?.pageBumperRunning
      ? Math.max(1, pageBumperRunningIds.length)
      : 0,
    groupPosterRunningCount: posterRunningIds.length,
    sheetsScheduleRunningCount: googleSheets?.runningScheduleCount ?? 0,
    sheetsScheduleEnabledCount: countSheets('post_schedule', 'scheduleConfig'),
    sheetsRecordsRunningCount: googleSheets?.runningRecordsCount ?? 0,
    sheetsRecordsEnabledCount: countSheets('post_records', 'recordsConfig'),
    bluestacksActiveRunningCount: bsCount(
      bluestacks?.activeRunning,
      bluestacks?.activeProfileCounts,
    ),
    bluestacksPosterRunningCount: bsCount(
      bluestacks?.posterRunning,
      bluestacks?.posterProfileCounts,
    ),
    bluestacksBumperRunningCount: bluestacks?.running
      ? Math.max(1, runningStatIds(bluestacks.profileCounts).length)
      : 0,
    bluestacksPageBumperRunningCount: bluestacks?.pageBumperRunning
      ? Math.max(1, runningStatIds(bluestacks.pageBumperProfileCounts).length)
      : 0,
    bluestacksInviterRunningCount: bsCount(
      bluestacks?.inviterRunning,
      bluestacks?.inviterProfileCounts,
    ),
    attentionCount,
  });
  const projectionInput: ProfileActivityProjectionInput = {
    activeModule: viewKind === 'home' || viewKind === 'edit' ? 'active-accounts' : viewKind,
    tasks,
    bumperCounts:
      viewKind === 'group-bumper'
        ? groupBumper?.profileCounts
        : viewKind === 'page-bumper'
          ? (groupBumper?.pageBumperProfileCounts ?? {})
          : undefined,
    bumperModuleId: viewKind === 'page-bumper' ? 'page-bumper' : 'group-bumper',
    bumperRunningIds,
    pageBumperRunningIds,
    groupInviterCounts: viewKind === 'group-inviter' ? (groupInviter?.profileCounts ?? {}) : null,
    groupInviterRunningIds: inviterRunningIds,
    groupPosterCounts: viewKind === 'group-poster' ? groupPoster?.profileCounts : undefined,
    groupPosterRunningIds: posterRunningIds,
    schedulerBrowserMap,
    googleSheetsActiveMap,
  };
  const selectedNames = (profiles ?? [])
    .filter((pr) => selected.has(pr.id))
    .map((pr) => profileDisplayName(pr))
    .slice(0, 20)
    .join('、');
  return {
    bumperRunningIds,
    inviterRunningIds,
    posterRunningIds,
    schedulerRunningIds: Object.keys(schedulerBrowserMap),
    sheetsRunningIds: Object.keys(googleSheetsActiveMap),
    activeModule: projectionInput.activeModule as FeatureModuleId,
    breadcrumbText: BREADCRUMB_LABELS[viewKind] ?? '数据与记录',
    navItems,
    projectedActivities: profiles
      ? projectProfileActivitiesMap(profiles, projectionInput)
      : undefined,
    projectedControls: projectSelectionControls(selected, projectionInput),
    diagUiContext: `视图:${viewKind}, 已选:${selected.size}个浏览器${selectedNames ? `(${selectedNames})` : ''}, 提示:${message || '无'}`,
  };
}
