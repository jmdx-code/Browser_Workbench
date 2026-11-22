import type { z } from 'zod';
import type { Profile } from '../../shared/contracts.js';
import type { GoogleSheetsActiveProfile } from '../../shared/google-sheets.js';
import type { BumperProfileStat } from '../../shared/group-bumper.js';
import type { GroupInviterProfileStat } from '../../shared/group-inviter.js';
import type { PosterProfileStat } from '../../shared/group-poster.js';
import { profileTaskResultLabel } from '../../shared/profile-task-result.js';
import type { TaskRuntimeOverview } from '../../shared/task-contracts.js';
import { isErroredPausedPlan, taskReasonDescription } from '../../shared/task-issues.js';
import { taskTimingLabel } from '../../shared/task-timing.js';
import { BREADCRUMB_LABELS, MODULE_LABELS, buildFeatureNavItems } from './feature-nav-items.js';
import {
  backgroundRunningDescriptor,
  extractInviterRunningIds,
  extractPosterRunningIds,
  extractSchedulerActiveBrowserMap,
  extractSheetsActiveBrowserMap,
  formatBumperStat,
  formatInviterStat,
  formatSchedulerProfileActivity,
  formatSheetsProfileActivity,
  projectGroupPosterProfileActivity,
  runningStatIds,
  type SchedulerActiveProfileInfo,
} from './group-poster-activity.js';
import type {
  FeatureModuleId,
  ProfileActivityDescriptor,
  SelectionControlSummary,
} from './module-contracts.js';

const taskNames = {
  feed: '浏览首页',
  video: '浏览 Reels',
  post: '发布内容',
  marketplace: '浏览商城',
  friends: '接受好友请求',
} as const;

export interface ProfileActivityProjectionInput {
  activeModule?: FeatureModuleId | undefined;
  tasks?: z.infer<typeof TaskRuntimeOverview> | null | undefined;
  bumperCounts?: Record<string, BumperProfileStat> | undefined;
  bumperRunningIds?: readonly string[] | undefined;
  bumperModuleId?: 'group-bumper' | 'page-bumper' | undefined;
  pageBumperRunningIds?: readonly string[] | undefined;
  groupInviterCounts?: Record<string, GroupInviterProfileStat> | null | undefined;
  groupInviterRunningIds?: readonly string[] | undefined;
  groupPosterCounts?: Record<string, PosterProfileStat> | undefined;
  groupPosterRunningIds?: readonly string[] | undefined;
  schedulerBrowserMap?: Record<string, SchedulerActiveProfileInfo> | undefined;
  googleSheetsActiveMap?: Record<string, GoogleSheetsActiveProfile> | undefined;
}

interface IndexedActivityLookup {
  activePlanByProfile: Map<
    string,
    NonNullable<ProfileActivityProjectionInput['tasks']>['plans'][number]
  >;
  stepByJobId: Map<
    string,
    NonNullable<ProfileActivityProjectionInput['tasks']>['currentSteps'][number]
  >;
  resultByProfile: Map<
    string,
    NonNullable<NonNullable<ProfileActivityProjectionInput['tasks']>['profileResults']>[number]
  >;
  posterRunningSet: Set<string>;
  bumperRunningSet: Set<string>;
  pageBumperRunningSet: Set<string>;
  inviterRunningSet: Set<string>;
}

function buildIndexedLookup(input: ProfileActivityProjectionInput): IndexedActivityLookup {
  const activePlanByProfile = new Map<
    string,
    NonNullable<ProfileActivityProjectionInput['tasks']>['plans'][number]
  >();
  for (const plan of input.tasks?.plans ?? []) {
    if (
      !['STOPPED', 'COMPLETED', 'FAILED'].includes(plan.state) &&
      !activePlanByProfile.has(plan.profileId)
    ) {
      activePlanByProfile.set(plan.profileId, plan);
    }
  }
  const stepByJobId = new Map<
    string,
    NonNullable<ProfileActivityProjectionInput['tasks']>['currentSteps'][number]
  >();
  for (const step of input.tasks?.currentSteps ?? []) {
    if (!stepByJobId.has(step.jobId)) stepByJobId.set(step.jobId, step);
  }
  const resultByProfile = new Map<
    string,
    NonNullable<NonNullable<ProfileActivityProjectionInput['tasks']>['profileResults']>[number]
  >();
  for (const res of input.tasks?.profileResults ?? []) {
    if (!resultByProfile.has(res.profileId)) resultByProfile.set(res.profileId, res);
  }
  return {
    activePlanByProfile,
    stepByJobId,
    resultByProfile,
    posterRunningSet: new Set(input.groupPosterRunningIds ?? []),
    bumperRunningSet: new Set(input.bumperRunningIds ?? []),
    pageBumperRunningSet: new Set(input.pageBumperRunningIds ?? []),
    inviterRunningSet: new Set(input.groupInviterRunningIds ?? []),
  };
}

export function projectProfileActivity(
  profileOrId: string | { id: string },
  input: ProfileActivityProjectionInput,
  indexed?: IndexedActivityLookup,
): ProfileActivityDescriptor | null {
  const profileId = typeof profileOrId === 'string' ? profileOrId : profileOrId.id;
  const schedInfo = input.schedulerBrowserMap?.[profileId];
  if (schedInfo && schedInfo.status === 'running') {
    return formatSchedulerProfileActivity(schedInfo);
  }
  const sheetInfo = input.googleSheetsActiveMap?.[profileId];
  if (sheetInfo) {
    return formatSheetsProfileActivity(sheetInfo);
  }
  const plan = indexed
    ? indexed.activePlanByProfile.get(profileId)
    : input.tasks?.plans.find(
        (value) =>
          value.profileId === profileId &&
          !['STOPPED', 'COMPLETED', 'FAILED'].includes(value.state),
      );
  const step = plan
    ? indexed
      ? indexed.stepByJobId.get(plan.id)
      : input.tasks?.currentSteps.find((value) => value.jobId === plan.id)
    : undefined;
  const lastResult = indexed
    ? indexed.resultByProfile.get(profileId)
    : input.tasks?.profileResults?.find((value) => value.profileId === profileId);
  const lastStatus = lastResult ? profileTaskResultLabel(lastResult) : undefined;

  const posterRunning =
    (indexed
      ? indexed.posterRunningSet.has(profileId)
      : input.groupPosterRunningIds?.includes(profileId) === true) ||
    input.groupPosterCounts?.[profileId]?.running === true;
  const bumperRunning =
    (indexed
      ? indexed.bumperRunningSet.has(profileId)
      : input.bumperRunningIds?.includes(profileId) === true) ||
    input.bumperCounts?.[profileId]?.running === true;
  const inviterRunning = indexed
    ? indexed.inviterRunningSet.has(profileId)
    : input.groupInviterRunningIds?.includes(profileId) === true;

  // Priority 1: Actively running task in ANY module always takes precedence
  if (posterRunning) {
    return input.groupPosterCounts?.[profileId]
      ? projectGroupPosterProfileActivity(profileId, input.groupPosterCounts, true)
      : backgroundRunningDescriptor('group-poster', '小组发帖');
  }

  if (bumperRunning) {
    const isPage =
      (indexed
        ? indexed.pageBumperRunningSet.has(profileId)
        : input.pageBumperRunningIds?.includes(profileId) === true) ||
      (input.bumperModuleId === 'page-bumper' && input.bumperCounts?.[profileId]?.running === true);
    const bumperModule: 'group-bumper' | 'page-bumper' = isPage ? 'page-bumper' : 'group-bumper';
    const stat =
      (input.bumperModuleId ?? 'group-bumper') === bumperModule
        ? input.bumperCounts?.[profileId]
        : undefined;
    return stat
      ? formatBumperStat(bumperModule, stat, true)
      : backgroundRunningDescriptor(bumperModule, isPage ? '专页顶贴' : '小组顶贴');
  }

  if (inviterRunning) {
    const stat = input.groupInviterCounts?.[profileId];
    return stat
      ? formatInviterStat(stat, true)
      : backgroundRunningDescriptor('group-inviter', '小组邀请人');
  }

  if (plan) {
    const taskTone: ProfileActivityDescriptor['tone'] =
      plan.state === 'RUNNING' || plan.state === 'REVIEW'
        ? 'run'
        : plan.state === 'QUEUED'
          ? 'queue'
          : 'pause';
    const reasonSummary = plan.reason ? taskReasonDescription(plan.reason)?.summary : undefined;
    const activeStepSpec = step
      ? plan.snapshot.steps.find((item) => item.id === step.id)
      : undefined;
    const stepIndexPrefix =
      plan.snapshot.steps.length > 1 ? `[${plan.position + 1}/${plan.snapshot.steps.length}] ` : '';
    const stepLabel =
      plan.state === 'QUEUED'
        ? plan.timing
          ? taskTimingLabel(plan.timing)
          : reasonSummary
            ? '排队中 · ' + reasonSummary
            : '排队中'
        : plan.state === 'REVIEW'
          ? '自动收尾中…'
          : plan.state === 'PAUSED'
            ? reasonSummary && !/^(USER_|MANUAL_)/.test(plan.reason)
              ? '已暂停 · ' + reasonSummary
              : '已暂停'
            : plan.state === 'PAUSING'
              ? '正在暂停'
              : plan.state === 'STOPPING'
                ? '正在停止'
                : step
                  ? stepIndexPrefix +
                    (step.destination === 'story' ? '发布快拍' : taskNames[step.type]) +
                    ' · 执行中'
                  : '运行中';
    const loopText =
      plan.snapshot.loop.mode === 'finite' ? '/' + plan.snapshot.loop.rounds : '（循环）';
    return {
      moduleId: 'active-accounts',
      moduleLabel: '活跃账号',
      running: plan.state === 'RUNNING' || plan.state === 'QUEUED',
      tone: taskTone,
      text: plan.state === 'RUNNING' && step ? stepLabel : plan.snapshot.name + ' · ' + stepLabel,
      tooltipLines: [
        `任务：${plan.snapshot.name} · 第${plan.round}轮${loopText} · 第${plan.position + 1}/${plan.snapshot.steps.length}项`,
        ...(plan.reason ? [taskReasonDescription(plan.reason)?.summary ?? plan.reason] : []),
      ],
      progressView:
        step && plan.state === 'RUNNING'
          ? {
              type: step.type,
              progress: step.progress,
              budget: step.budget,
              maxLikes:
                activeStepSpec && 'maxLikes' in activeStepSpec
                  ? activeStepSpec.maxLikes
                  : undefined,
            }
          : undefined,
    };
  }

  if (schedInfo) {
    return formatSchedulerProfileActivity(schedInfo);
  }

  // Priority 2: Current module active/recent session projection when viewing a feature module
  const posterStat = input.groupPosterCounts?.[profileId];
  if (
    input.groupPosterCounts &&
    posterStat &&
    (posterStat.session > 0 || (posterStat.status && posterStat.status !== '未运行'))
  ) {
    return projectGroupPosterProfileActivity(profileId, input.groupPosterCounts, false);
  }
  const bumperStat = input.bumperCounts?.[profileId];
  if (
    input.bumperCounts &&
    bumperStat &&
    (bumperStat.session > 0 || (bumperStat.status && bumperStat.status !== '未运行'))
  ) {
    return formatBumperStat(input.bumperModuleId ?? 'group-bumper', bumperStat, false);
  }
  const inviterStat = input.groupInviterCounts?.[profileId];
  if (
    input.groupInviterCounts &&
    inviterStat &&
    (inviterStat.sessionInvited > 0 || (inviterStat.status && inviterStat.status !== '未运行'))
  ) {
    return formatInviterStat(inviterStat, false);
  }

  // Priority 3: Last finished result projection when idle (mapped directly by 5-source enum)
  if (lastResult && lastStatus) {
    const sourceModule: FeatureModuleId =
      lastResult.source in MODULE_LABELS
        ? (lastResult.source as FeatureModuleId)
        : 'active-accounts';
    const moduleLabel = MODULE_LABELS[sourceModule] ?? '活跃账号';
    return {
      moduleId: sourceModule,
      moduleLabel,
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

  if (input.groupPosterCounts)
    return projectGroupPosterProfileActivity(profileId, input.groupPosterCounts, false);
  if (input.bumperCounts)
    return formatBumperStat(input.bumperModuleId ?? 'group-bumper', bumperStat, false);
  if (input.groupInviterCounts) return formatInviterStat(inviterStat, false);

  return null;
}

export function projectProfileActivitiesMap(
  profiles: readonly Pick<Profile, 'id'>[],
  input: ProfileActivityProjectionInput,
): Map<string, ProfileActivityDescriptor> {
  const indexed = buildIndexedLookup(input);
  const map = new Map<string, ProfileActivityDescriptor>();
  for (const profile of profiles) {
    const descriptor = projectProfileActivity(profile.id, input, indexed);
    if (descriptor) map.set(profile.id, descriptor);
  }
  return map;
}

export function projectSelectionControls(
  selected: ReadonlySet<string>,
  input: ProfileActivityProjectionInput,
): SelectionControlSummary {
  const plans = input.tasks?.plans ?? [];
  const selectedPlans = plans.filter((plan) => selected.has(plan.profileId));
  const toTargets = (rows: typeof selectedPlans) =>
    rows.map((plan) => ({
      profileId: plan.profileId,
      planId: plan.id,
      expectedState: plan.state,
      expectedUpdatedAt: plan.updatedAt,
    }));

  const schedOwnedIds = new Set(Object.keys(input.schedulerBrowserMap ?? {}));
  const ownPlans = selectedPlans.filter((plan) => !schedOwnedIds.has(plan.profileId));
  const pausable = ownPlans.filter((plan) => ['RUNNING', 'QUEUED'].includes(plan.state));
  const resumable = ownPlans.filter((plan) => plan.state === 'PAUSED');
  const stoppable = ownPlans.filter(
    (plan) => !['COMPLETED', 'FAILED', 'STOPPED'].includes(plan.state),
  );
  const sheetsRunningIds = Object.keys(input.googleSheetsActiveMap ?? {});
  const runningModuleIds = new Set<string>([
    ...(input.groupInviterRunningIds ?? []),
    ...(input.bumperRunningIds ?? []),
    ...(input.groupPosterRunningIds ?? []),
    ...schedOwnedIds,
    ...sheetsRunningIds,
  ]);
  const stoppableModuleProfileIds = [...selected].filter((id) => runningModuleIds.has(id));
  const totalStoppableCount = new Set([
    ...stoppable.map((plan) => plan.profileId),
    ...stoppableModuleProfileIds,
  ]).size;
  const activePlanProfileIds = new Set(
    plans
      .filter(
        (plan) =>
          !['COMPLETED', 'FAILED', 'STOPPED'].includes(plan.state) && !isErroredPausedPlan(plan),
      )
      .map((plan) => plan.profileId),
  );

  return {
    pausableTargets: toTargets(pausable),
    resumableTargets: toTargets(resumable),
    stoppableTargets: toTargets(stoppable),
    stoppableModuleProfileIds,
    totalStoppableCount,
    isProfileBusy: (profileId: string) =>
      activePlanProfileIds.has(profileId) || runningModuleIds.has(profileId),
  };
}

export { extractInviterRunningIds } from './group-poster-activity.js';
export { buildFeatureNavItems } from './feature-nav-items.js';

export interface WorkbenchProjectionParams {
  viewKind:
    | 'home'
    | 'edit'
    | 'auto-scheduler'
    | 'records'
    | 'group-inviter'
    | 'group-bumper'
    | 'page-bumper'
    | 'group-poster'
    | 'sheets-groups'
    | 'sheets-pages'
    | 'sheets-schedule'
    | 'sheets-records'
    | 'bluestacks-active'
    | 'bluestacks-group-poster'
    | 'bluestacks-group-bumper'
    | 'bluestacks-page-bumper'
    | 'bluestacks-group-inviter';
  profiles: readonly Profile[] | undefined;
  selected: ReadonlySet<string>;
  tasks: z.infer<typeof TaskRuntimeOverview> | null | undefined;
  groupBumper:
    | {
        running: boolean;
        profileCounts: Record<string, BumperProfileStat>;
        pageBumperRunning?: boolean | undefined;
        pageBumperProfileCounts?: Record<string, BumperProfileStat> | undefined;
      }
    | null
    | undefined;
  groupInviter:
    { running: boolean; profileCounts: Record<string, GroupInviterProfileStat> } | null | undefined;
  groupPoster?:
    { running: boolean; profileCounts: Record<string, PosterProfileStat> } | null | undefined;
  bluestacks?:
    | {
        running: boolean;
        profileCounts: Record<string, BumperProfileStat>;
        pageBumperRunning?: boolean | undefined;
        pageBumperProfileCounts?: Record<string, BumperProfileStat> | undefined;
        activeRunning?: boolean | undefined;
        activeProfileCounts?: Record<string, { running: boolean }> | undefined;
        posterRunning?: boolean | undefined;
        posterProfileCounts?: Record<string, { running: boolean }> | undefined;
        inviterRunning?: boolean | undefined;
        inviterProfileCounts?: Record<string, { running: boolean }> | undefined;
      }
    | null
    | undefined;
  autoScheduler?:
    | {
        running: boolean;
        activeBrowserWorkers: number;
        activeBluestacksWorkers: number;
        schedules: readonly { enabled: boolean }[];
        activeRuns?: readonly import('../../shared/auto-scheduler.js').AutoScheduleRun[];
      }
    | null
    | undefined;
  googleSheets?:
    | {
        runningScheduleCount: number;
        runningRecordsCount: number;
        activeProfiles?: readonly GoogleSheetsActiveProfile[] | undefined;
        links: readonly {
          kind: string;
          enabled: boolean;
          scheduleConfig?: { enabled: boolean } | undefined;
          recordsConfig?: { enabled: boolean } | undefined;
        }[];
      }
    | null
    | undefined;
  attentionCount: number;
  message: string;
}

export function buildWorkbenchProjection({
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
}: WorkbenchProjectionParams) {
  const plans = tasks?.plans ?? [];
  const groupBumperRunningIds = runningStatIds(groupBumper?.profileCounts);
  const pageBumperRunningIds = runningStatIds(groupBumper?.pageBumperProfileCounts);
  const bluestacksRunningCount = runningStatIds(bluestacks?.profileCounts).length;
  const bluestacksPageRunningCount = runningStatIds(bluestacks?.pageBumperProfileCounts).length;
  const bluestacksActiveCount = Object.values(bluestacks?.activeProfileCounts ?? {}).filter(
    (s) => s.running,
  ).length;
  const bluestacksPosterCount = Object.values(bluestacks?.posterProfileCounts ?? {}).filter(
    (s) => s.running,
  ).length;
  const bluestacksInviterCount = Object.values(bluestacks?.inviterProfileCounts ?? {}).filter(
    (s) => s.running,
  ).length;
  const bumperRunningIds = [...new Set([...groupBumperRunningIds, ...pageBumperRunningIds])];
  const inviterRunningIds = extractInviterRunningIds(groupInviter);
  const posterRunningIds = extractPosterRunningIds(groupPoster);
  const schedulerBrowserMap = extractSchedulerActiveBrowserMap(autoScheduler?.activeRuns);
  const schedulerRunningIds = Object.keys(schedulerBrowserMap);
  const googleSheetsActiveMap = extractSheetsActiveBrowserMap(googleSheets?.activeProfiles);
  const sheetsRunningIds = Object.keys(googleSheetsActiveMap);
  const activeAccountRunningCount = new Set(
    plans
      .filter(
        (plan) =>
          !['STOPPED', 'COMPLETED', 'FAILED'].includes(plan.state) && !isErroredPausedPlan(plan),
      )
      .map((plan) => plan.profileId),
  ).size;
  const activeModule: FeatureModuleId =
    viewKind === 'home' || viewKind === 'edit' ? 'active-accounts' : viewKind;
  const breadcrumbText = BREADCRUMB_LABELS[viewKind] ?? '执行记录';
  const navItems = buildFeatureNavItems({
    autoSchedulerRunningCount: autoScheduler?.running
      ? Math.max(1, autoScheduler.activeBrowserWorkers + autoScheduler.activeBluestacksWorkers)
      : 0,
    autoSchedulerEnabledCount: autoScheduler?.schedules.filter((s) => s.enabled).length ?? 0,
    activeAccountRunningCount,
    groupInviterRunning: Boolean(groupInviter?.running),
    inviterRunningCount: inviterRunningIds.length,
    groupBumperRunning: Boolean(groupBumper?.running),
    bumperRunningCount: groupBumperRunningIds.length,
    pageBumperRunningCount: groupBumper?.pageBumperRunning
      ? Math.max(1, pageBumperRunningIds.length)
      : 0,
    groupPosterRunningCount: posterRunningIds.length,
    sheetsScheduleRunningCount: googleSheets?.runningScheduleCount ?? 0,
    sheetsScheduleEnabledCount:
      googleSheets?.links.filter(
        (l) => l.kind === 'post_schedule' && l.enabled && l.scheduleConfig?.enabled,
      ).length ?? 0,
    sheetsRecordsRunningCount: googleSheets?.runningRecordsCount ?? 0,
    sheetsRecordsEnabledCount:
      googleSheets?.links.filter(
        (l) => l.kind === 'post_records' && l.enabled && l.recordsConfig?.enabled,
      ).length ?? 0,
    bluestacksActiveRunningCount: bluestacks?.activeRunning
      ? Math.max(1, bluestacksActiveCount)
      : 0,
    bluestacksPosterRunningCount: bluestacks?.posterRunning
      ? Math.max(1, bluestacksPosterCount)
      : 0,
    bluestacksBumperRunningCount: bluestacks?.running ? Math.max(1, bluestacksRunningCount) : 0,
    bluestacksPageBumperRunningCount: bluestacks?.pageBumperRunning
      ? Math.max(1, bluestacksPageRunningCount)
      : 0,
    bluestacksInviterRunningCount: bluestacks?.inviterRunning
      ? Math.max(1, bluestacksInviterCount)
      : 0,
    attentionCount,
  });
  const projectionInput: ProfileActivityProjectionInput = {
    activeModule,
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
  const projectedActivities = profiles
    ? projectProfileActivitiesMap(profiles, projectionInput)
    : undefined;
  const projectedControls = projectSelectionControls(selected, projectionInput);
  const selectedNames = profiles
    ? profiles
        .filter((p) => selected.has(p.id))
        .map((p) => p.alias || p.browserName || p.id.slice(0, 8))
        .slice(0, 20)
        .join('、')
    : '';
  const diagUiContext = `视图:${viewKind}, 已选:${selected.size}个浏览器${selectedNames ? `(${selectedNames})` : ''}, 提示:${message || '无'}`;
  return {
    bumperRunningIds,
    inviterRunningIds,
    posterRunningIds,
    schedulerRunningIds,
    sheetsRunningIds,
    activeModule,
    breadcrumbText,
    navItems,
    projectedActivities,
    projectedControls,
    diagUiContext,
  };
}
