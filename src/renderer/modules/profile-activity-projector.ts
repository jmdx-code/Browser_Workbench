import type { z } from 'zod';
import type { Profile } from '../../shared/contracts.js';
import type { BumperProfileStat } from '../../shared/group-bumper.js';
import type { GroupInviterProfileStat } from '../../shared/group-inviter.js';
import type { PosterProfileStat } from '../../shared/group-poster.js';
import { profileTaskResultLabel } from '../../shared/profile-task-result.js';
import type { TaskRuntimeOverview } from '../../shared/task-contracts.js';
import { isErroredPausedPlan, taskReasonDescription } from '../../shared/task-issues.js';
import { taskTimingLabel } from '../../shared/task-timing.js';
import { buildFeatureNavItems } from './feature-nav-items.js';
import {
  extractInviterRunningIds,
  extractPosterRunningIds,
  formatBumperStat,
  formatInviterStat,
  projectGroupPosterProfileActivity,
} from './group-poster-activity.js';
import type {
  FeatureModuleId,
  ProfileActivityDescriptor,
  SelectionControlSummary,
} from './module-contracts.js';

const MODULE_LABELS: Record<string, string> = {
  'group-poster': '小组发帖',
  'group-bumper': '小组顶贴',
  'page-bumper': '专页顶贴',
  'group-inviter': '小组邀请人',
};

const BREADCRUMB_LABELS: Record<string, string> = {
  home: '活跃账号',
  edit: '活跃账号 · 编辑组合',
  'group-inviter': '小组邀请人',
  'group-bumper': '小组顶贴',
  'page-bumper': '专页顶贴',
  'group-poster': '小组发帖',
  'bluestacks-group-bumper': '蓝蝶小组顶贴',
  'bluestacks-page-bumper': '蓝蝶专页顶贴',
};

function runningStatIds(counts?: Record<string, { running: boolean }>): string[] {
  return Object.entries(counts ?? {})
    .filter(([, stat]) => stat.running)
    .map(([id]) => id);
}

function backgroundRunningDescriptor(
  moduleId: FeatureModuleId,
  moduleLabel: string,
): ProfileActivityDescriptor {
  return {
    moduleId,
    moduleLabel,
    running: true,
    tone: 'run',
    text: `${moduleLabel} · 运行中`,
    tooltipLines: [`${moduleLabel}正在后台运行`],
  };
}

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
}

export function projectProfileActivity(
  profileOrId: string | { id: string },
  input: ProfileActivityProjectionInput,
): ProfileActivityDescriptor | null {
  const profileId = typeof profileOrId === 'string' ? profileOrId : profileOrId.id;
  const plan = input.tasks?.plans.find(
    (value) =>
      value.profileId === profileId && !['STOPPED', 'COMPLETED', 'FAILED'].includes(value.state),
  );
  const step = plan
    ? input.tasks?.currentSteps.find((value) => value.jobId === plan.id)
    : undefined;
  const lastResult = input.tasks?.profileResults?.find((value) => value.profileId === profileId);
  const lastStatus = lastResult ? profileTaskResultLabel(lastResult) : undefined;

  const posterRunning =
    input.groupPosterRunningIds?.includes(profileId) === true ||
    input.groupPosterCounts?.[profileId]?.running === true;
  const bumperRunning =
    input.bumperRunningIds?.includes(profileId) === true ||
    input.bumperCounts?.[profileId]?.running === true;
  const inviterRunning = input.groupInviterRunningIds?.includes(profileId) === true;

  // Priority 1: Actively running task in ANY module always takes precedence
  if (posterRunning) {
    return input.groupPosterCounts?.[profileId]
      ? projectGroupPosterProfileActivity(profileId, input.groupPosterCounts, true)
      : backgroundRunningDescriptor('group-poster', '小组发帖');
  }

  if (bumperRunning) {
    const isPage =
      input.pageBumperRunningIds?.includes(profileId) === true ||
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
      plan.state === 'RUNNING'
        ? 'run'
        : plan.state === 'QUEUED'
          ? 'queue'
          : plan.state === 'REVIEW'
            ? 'warn'
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
          ? '待核对'
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
  const map = new Map<string, ProfileActivityDescriptor>();
  for (const profile of profiles) {
    const descriptor = projectProfileActivity(profile.id, input);
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

  const pausable = selectedPlans.filter((plan) => ['RUNNING', 'QUEUED'].includes(plan.state));
  const resumable = selectedPlans.filter((plan) => plan.state === 'PAUSED');
  const stoppable = selectedPlans.filter(
    (plan) => !['COMPLETED', 'FAILED', 'STOPPED'].includes(plan.state),
  );
  const runningModuleIds = new Set<string>([
    ...(input.groupInviterRunningIds ?? []),
    ...(input.bumperRunningIds ?? []),
    ...(input.groupPosterRunningIds ?? []),
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
    | 'records'
    | 'group-inviter'
    | 'group-bumper'
    | 'page-bumper'
    | 'group-poster'
    | 'bluestacks-group-bumper'
    | 'bluestacks-page-bumper';
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
  attentionCount,
  message,
}: WorkbenchProjectionParams) {
  const plans = tasks?.plans ?? [];
  const groupBumperRunningIds = runningStatIds(groupBumper?.profileCounts);
  const pageBumperRunningIds = runningStatIds(groupBumper?.pageBumperProfileCounts);
  const bluestacksRunningCount = runningStatIds(bluestacks?.profileCounts).length;
  const bluestacksPageRunningCount = runningStatIds(bluestacks?.pageBumperProfileCounts).length;
  const bumperRunningIds = [...new Set([...groupBumperRunningIds, ...pageBumperRunningIds])];
  const inviterRunningIds = extractInviterRunningIds(groupInviter);
  const posterRunningIds = extractPosterRunningIds(groupPoster);
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
    activeAccountRunningCount,
    groupInviterRunning: Boolean(groupInviter?.running),
    inviterRunningCount: inviterRunningIds.length,
    groupBumperRunning: Boolean(groupBumper?.running),
    bumperRunningCount: groupBumperRunningIds.length,
    pageBumperRunningCount: groupBumper?.pageBumperRunning
      ? Math.max(1, pageBumperRunningIds.length)
      : 0,
    groupPosterRunningCount: posterRunningIds.length,
    bluestacksBumperRunningCount: bluestacks?.running ? Math.max(1, bluestacksRunningCount) : 0,
    bluestacksPageBumperRunningCount: bluestacks?.pageBumperRunning
      ? Math.max(1, bluestacksPageRunningCount)
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
    activeModule,
    breadcrumbText,
    navItems,
    projectedActivities,
    projectedControls,
    diagUiContext,
  };
}
