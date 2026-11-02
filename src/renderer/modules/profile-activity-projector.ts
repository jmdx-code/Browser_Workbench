import type { z } from 'zod';
import type { Profile } from '../../shared/contracts.js';
import type { BumperProfileStat } from '../../shared/group-bumper.js';
import type { GroupInviterProfileStat } from '../../shared/group-inviter.js';
import { profileTaskResultLabel } from '../../shared/profile-task-result.js';
import type { TaskRuntimeOverview } from '../../shared/task-contracts.js';
import { isErroredPausedPlan, taskReasonDescription } from '../../shared/task-issues.js';
import { taskTimingLabel } from '../../shared/task-timing.js';
import { buildFeatureNavItems } from './feature-nav-items.js';
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
  /** 当前顶贴视图对应的模块（小组顶贴 / 专页顶贴），决定徽标文字。 */
  bumperModuleId?: 'group-bumper' | 'page-bumper' | undefined;
  pageBumperRunningIds?: readonly string[] | undefined;
  groupInviterCounts?: Record<string, GroupInviterProfileStat> | null | undefined;
  groupInviterRunningIds?: readonly string[] | undefined;
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

  const bumperRunning = input.bumperRunningIds?.includes(profileId) === true;
  const inviterRunning = input.groupInviterRunningIds?.includes(profileId) === true;
  const moduleRunning = bumperRunning || inviterRunning;

  // 1. Module-specific view projection when viewing group-bumper
  if (input.bumperCounts && (input.bumperCounts[profileId] || !inviterRunning)) {
    const stat = input.bumperCounts[profileId];
    const running = Boolean(stat?.running || bumperRunning);
    const bumperModule = input.bumperModuleId ?? 'group-bumper';
    const bumperLabel = bumperModule === 'page-bumper' ? '专页顶贴' : '小组顶贴';
    return {
      moduleId: bumperModule,
      moduleLabel: bumperLabel,
      running,
      tone: running ? 'run' : 'ok',
      text: `今日 ${stat?.today ?? 0} · 本轮 ${stat?.session ?? 0} · ${stat?.status ?? '未运行'}`,
      tooltipLines: [
        `${bumperLabel}：今日 ${stat?.today ?? 0} 次 · 本轮 ${stat?.session ?? 0} 次 · ${stat?.status ?? '未运行'}`,
      ],
    };
  }

  // 2. Module-specific view projection when viewing group-inviter
  if (input.groupInviterCounts && (input.groupInviterCounts[profileId] || !bumperRunning)) {
    const stat = input.groupInviterCounts[profileId];
    const statusText = stat?.status ?? '';
    const running = inviterRunning || bumperRunning;
    const tone: ProfileActivityDescriptor['tone'] = running
      ? 'run'
      : /失败|未确认|不可|异常|离线/.test(statusText)
        ? 'err'
        : /停止/.test(statusText)
          ? 'pause'
          : 'ok';
    return {
      moduleId: 'group-inviter',
      moduleLabel: '小组邀请人',
      running,
      tone,
      className: 'group-inviter-profile-stat',
      text: `本次邀请 ${stat?.sessionInvited ?? 0} 人 · 累计 ${stat?.totalInvited ?? 0} 人${statusText ? ' · ' + statusText : ''}`,
      tooltipLines: [
        `小组邀请人：本次 ${stat?.sessionInvited ?? 0} 人 · 累计 ${stat?.totalInvited ?? 0} 人${statusText ? ' · ' + statusText : ''}`,
      ],
    };
  }

  // 3. Active combination plan projection (active-accounts)
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
    const tooltipLines = [
      '任务：' +
        plan.snapshot.name +
        ' · 第' +
        plan.round +
        '轮' +
        (plan.snapshot.loop.mode === 'finite' ? '/' + plan.snapshot.loop.rounds : '（循环）') +
        ' · 第' +
        (plan.position + 1) +
        '/' +
        plan.snapshot.steps.length +
        '项',
      ...(plan.reason ? [taskReasonDescription(plan.reason)?.summary ?? plan.reason] : []),
    ];
    return {
      moduleId: 'active-accounts',
      moduleLabel: '活跃账号',
      running: plan.state === 'RUNNING' || plan.state === 'QUEUED',
      tone: taskTone,
      text: plan.state === 'RUNNING' && step ? stepLabel : plan.snapshot.name + ' · ' + stepLabel,
      tooltipLines,
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

  // 4. Background running module projection
  if (moduleRunning) {
    const isBumper = bumperRunning;
    const isPage = isBumper && input.pageBumperRunningIds?.includes(profileId) === true;
    const label = isPage ? '专页顶贴' : isBumper ? '小组顶贴' : '小组邀请人';
    return {
      moduleId: isPage ? 'page-bumper' : isBumper ? 'group-bumper' : 'group-inviter',
      moduleLabel: label,
      running: true,
      tone: 'run',
      text: `${label} · 运行中`,
      tooltipLines: [`${label}正在后台运行`],
    };
  }

  // 5. Last finished result projection when idle
  if (lastResult && lastStatus) {
    const sourceModule: FeatureModuleId =
      lastResult.source === 'group-bumper'
        ? lastResult.name === '专页顶贴'
          ? 'page-bumper'
          : 'group-bumper'
        : lastResult.source === 'group-inviter'
          ? 'group-inviter'
          : 'active-accounts';
    return {
      moduleId: sourceModule,
      moduleLabel:
        sourceModule === 'group-bumper'
          ? '小组顶贴'
          : sourceModule === 'page-bumper'
            ? '专页顶贴'
            : sourceModule === 'group-inviter'
              ? '小组邀请人'
              : '活跃账号',
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

  return null;
}

export function projectProfileActivitiesMap(
  profiles: readonly Pick<Profile, 'id'>[],
  input: ProfileActivityProjectionInput,
): Map<string, ProfileActivityDescriptor> {
  const map = new Map<string, ProfileActivityDescriptor>();
  for (const profile of profiles) {
    const descriptor = projectProfileActivity(profile.id, input);
    if (descriptor) {
      map.set(profile.id, descriptor);
    }
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
  ]);
  const stoppableModuleProfileIds = [...selected].filter((id) => runningModuleIds.has(id));
  const totalStoppableCount = new Set([
    ...stoppable.map((plan) => plan.profileId),
    ...stoppableModuleProfileIds,
  ]).size;

  const activePlanProfileIds = new Set(
    plans
      .filter((plan) => !['COMPLETED', 'FAILED', 'STOPPED'].includes(plan.state))
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

export function extractInviterRunningIds(
  groupInviter:
    { running: boolean; profileCounts: Record<string, GroupInviterProfileStat> } | null | undefined,
): string[] {
  if (!groupInviter?.running) return [];
  return Object.entries(groupInviter.profileCounts)
    .filter(([, stat]) =>
      Boolean(
        stat.status &&
        !['已完成', '已停止'].includes(stat.status) &&
        !stat.status.startsWith('失败') &&
        !stat.status.startsWith('跳过'),
      ),
    )
    .map(([id]) => id);
}

export { buildFeatureNavItems } from './feature-nav-items.js';

export function buildWorkbenchProjection({
  viewKind,
  profiles,
  selected,
  tasks,
  groupBumper,
  groupInviter,
  attentionCount,
  message,
}: {
  viewKind: 'home' | 'edit' | 'records' | 'group-inviter' | 'group-bumper' | 'page-bumper';
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
  attentionCount: number;
  message: string;
}) {
  const plans = tasks?.plans ?? [];
  const groupBumperRunningIds = Object.entries(groupBumper?.profileCounts ?? {})
    .filter(([, stat]) => stat.running)
    .map(([id]) => id);
  const pageBumperRunningIds = Object.entries(groupBumper?.pageBumperProfileCounts ?? {})
    .filter(([, stat]) => stat.running)
    .map(([id]) => id);
  // 顶贴模块整体运行中的浏览器（小组 + 专页），用于忙碌判定与按 ID 停止。
  const bumperRunningIds = [...new Set([...groupBumperRunningIds, ...pageBumperRunningIds])];
  const inviterRunningIds = extractInviterRunningIds(groupInviter);
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
  const breadcrumbText =
    viewKind === 'home'
      ? '活跃账号'
      : viewKind === 'edit'
        ? '活跃账号 · 编辑组合'
        : viewKind === 'group-inviter'
          ? '小组邀请人'
          : viewKind === 'group-bumper'
            ? '小组顶贴'
            : viewKind === 'page-bumper'
              ? '专页顶贴'
              : '执行记录';
  const navItems = buildFeatureNavItems({
    activeAccountRunningCount,
    groupInviterRunning: Boolean(groupInviter?.running),
    inviterRunningCount: inviterRunningIds.length,
    groupBumperRunning: Boolean(groupBumper?.running),
    bumperRunningCount: groupBumperRunningIds.length,
    pageBumperRunningCount: groupBumper?.pageBumperRunning
      ? Math.max(1, pageBumperRunningIds.length)
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
    activeModule,
    breadcrumbText,
    navItems,
    projectedActivities,
    projectedControls,
    diagUiContext,
  };
}
