import type { z } from 'zod';
import {
  formatStepShortLabel,
  type AutoScheduleRun,
  type AutoSchedulerState,
} from '../../shared/auto-scheduler.js';
import { bluestacksDisplayTitle, type BluestacksState } from '../../shared/bluestacks.js';
import {
  profileDisplayName,
  type Profile,
  type SavedCombination,
  type Step,
} from '../../shared/contracts.js';
import type { GoogleSheetsOverview } from '../../shared/google-sheets.js';
import type { BumperState } from '../../shared/group-bumper.js';
import type { GroupInviterState } from '../../shared/group-inviter.js';
import type { PosterState } from '../../shared/group-poster.js';
import type { TaskRuntimeOverview } from '../../shared/task-contracts.js';

type RuntimeOverview = z.infer<typeof TaskRuntimeOverview>;

type ProjectedStep = NonNullable<RuntimeOverview['roundSteps']>[number];

const describeCombinationStep = (s: Step): string =>
  s.type === 'feed'
    ? `浏览首页 (${s.durationMinutes}分)`
    : s.type === 'video'
      ? `浏览 Reels (${s.durationMinutes}分)`
      : s.type === 'marketplace'
        ? `浏览商城 (${s.durationMinutes}分)`
        : s.type === 'friends'
          ? s.friendAction === 'add_suggested'
            ? `加推荐好友 (${s.maxAccepts}人)`
            : `接受好友 (${s.acceptMode === 'all' ? '全部' : `${s.maxAccepts}个`})`
          : s.destination === 'story'
            ? '发布快拍'
            : '发时间线贴';

const describeProjectedStep = (s: ProjectedStep): string => {
  const mins =
    s.budget?.kind === 'time' ? Math.max(1, Math.round(s.budget.milliseconds / 60_000)) : 3;
  if (s.type === 'feed')
    return s.feedMode === 'random_profile'
      ? `逛他人时间线 (${mins}分)`
      : s.feedMode === 'random_page'
        ? `逛公共专页 (${mins}分)`
        : s.feedMode === 'search_pages'
          ? `搜专页逛时间线 (${mins}分)`
          : `浏览首页 (${mins}分)`;
  if (s.type === 'video') return `浏览 Reels (${mins}分)`;
  if (s.type === 'marketplace') return `浏览商城 (${mins}分)`;
  if (s.type === 'friends') {
    const cnt = s.budget?.kind === 'friends' ? s.budget.count : null;
    return s.friendAction === 'add_suggested'
      ? `加推荐好友 (${cnt ?? 3}人)`
      : `接受好友 (${s.budget?.kind === 'friends' && s.budget.mode === 'all' ? '全部' : `${cnt ?? 5}个`})`;
  }
  return s.destination === 'story' ? '发布快拍' : '发时间线贴';
};

const formatRunningStepMeta = (
  planState: RuntimeOverview['plans'][number]['state'],
  cur: ProjectedStep | undefined,
): string => {
  const parts = [planState === 'QUEUED' ? '排队等待' : '进行中'];
  if (planState !== 'QUEUED' && cur) {
    if (cur.progress.likes > 0) parts.push(`已赞 ${cur.progress.likes}`);
    if (cur.progress.published > 0) parts.push(`已发 ${cur.progress.published}`);
    if (cur.progress.accepted && cur.progress.accepted > 0)
      parts.push(`通过 ${cur.progress.accepted}`);
  }
  return parts.join(' · ');
};

export interface LiveRunStepItem {
  label: string;
  state: 'done' | 'running' | 'pending';
  meta?: string | undefined;
}

export interface LiveRunCard {
  key: string;
  carrier: 'browser' | 'bluestacks';
  targetId: string;
  targetName: string;
  title: string;
  subtitle: string;
  statusText: string;
  closeOnFinish?: boolean | undefined;
  steps: LiveRunStepItem[];
  stopKind: 'plan' | 'module' | 'scheduler' | 'bluestacks-module';
  planTarget?: {
    profileId: string;
    planId: string;
    expectedState: RuntimeOverview['plans'][number]['state'];
    expectedUpdatedAt: number;
  };
  schedulerRunId?: string | undefined;
  bsModuleAction?: string | undefined;
}

export function buildLiveRunCards(p: {
  profiles: readonly Profile[];
  runtime: RuntimeOverview | null;
  combinations: readonly SavedCombination[];
  autoScheduler: AutoSchedulerState | null;
  groupBumper: BumperState | null;
  groupPoster: PosterState | null;
  groupInviter: GroupInviterState | null;
  googleSheets: GoogleSheetsOverview | null;
  bluestacks: BluestacksState | null;
}): LiveRunCard[] {
  const cards: LiveRunCard[] = [];
  const profileMap = new Map(p.profiles.map((x) => [x.id, x]));
  const bsMap = new Map((p.bluestacks?.instances ?? []).map((i) => [i.id, i]));
  const comboMap = new Map(p.combinations.map((c) => [c.id, c]));
  const covered = new Set<string>();
  const profLabel = (pid: string) => profileDisplayName(profileMap.get(pid), pid.slice(0, 8));

  for (const run of (p.autoScheduler?.activeRuns ?? []) as readonly AutoScheduleRun[]) {
    const schedule = p.autoScheduler?.schedules.find((s) => s.id === run.scheduleId);
    const items = [...(run.items ?? [])]
      .filter((i) => i.status === 'running' || i.status === 'queued')
      .sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1));
    for (const item of items) {
      covered.add(`${run.carrier}:${item.targetId}`);
      const bsInst = run.carrier === 'bluestacks' ? bsMap.get(item.targetId) : undefined;
      const resolvedTargetName =
        run.carrier === 'browser'
          ? profileDisplayName(
              profileMap.get(item.targetId),
              item.targetName || item.targetId.slice(0, 8),
            )
          : bsInst
            ? bluestacksDisplayTitle(bsInst)
            : item.targetName;
      const totalSteps = schedule?.steps ?? [];
      const stepLabel = (s: (typeof totalSteps)[number]) =>
        s.type === 'active-combination' || s.type === 'bluestacks-active-combination'
          ? (comboMap.get(s.combinationId)?.saved?.name ?? '活跃组合')
          : formatStepShortLabel(s);
      const currentIdx = totalSteps.findIndex((s) => stepLabel(s) === item.currentStep);
      const steps: LiveRunStepItem[] =
        totalSteps.length > 0
          ? totalSteps.map((s, idx) => {
              const st: LiveRunStepItem['state'] =
                item.status === 'queued'
                  ? 'pending'
                  : currentIdx >= 0
                    ? idx < currentIdx
                      ? 'done'
                      : idx === currentIdx
                        ? 'running'
                        : 'pending'
                    : idx === 0
                      ? 'running'
                      : 'pending';
              return {
                label: stepLabel(s),
                state: st,
                meta: st === 'running' ? item.summary || '执行中' : undefined,
              };
            })
          : [
              {
                label: item.currentStep || '排班执行',
                state: item.status === 'queued' ? 'pending' : 'running',
                meta: item.summary,
              },
            ];
      cards.push({
        key: `sched:${run.id}:${item.targetId}`,
        carrier: run.carrier,
        targetId: item.targetId,
        targetName: resolvedTargetName,
        title: `定时排班 · ${run.scheduleName}`,
        subtitle: item.status === 'running' ? '正在执行步骤' : '排队等待并发槽位',
        statusText:
          item.status === 'queued' ? '等待并发槽位' : item.summary || item.currentStep || '运行中',
        closeOnFinish: schedule?.closeWindowOnFinish,
        steps,
        stopKind: 'scheduler',
        schedulerRunId: run.id,
      });
    }
  }

  const stepMap = new Map(
    (p.runtime?.currentSteps ?? []).map((s) => [`${s.jobId}:${s.position}`, s]),
  );
  const roundStepsMap = new Map<string, ProjectedStep[]>();
  for (const rs of p.runtime?.roundSteps ?? []) {
    const arr = roundStepsMap.get(rs.jobId) ?? [];
    arr.push(rs);
    roundStepsMap.set(rs.jobId, arr);
  }
  for (const arr of roundStepsMap.values()) arr.sort((a, b) => a.position - b.position);

  for (const plan of p.runtime?.plans ?? []) {
    if (!['QUEUED', 'RUNNING'].includes(plan.state)) continue;
    covered.add(`browser:${plan.profileId}`);
    const actualSteps = roundStepsMap.get(plan.id);
    const steps: LiveRunStepItem[] =
      actualSteps && actualSteps.length > 0
        ? actualSteps.map((rs) => {
            const isDone = rs.status === 'COMPLETED' || rs.status === 'SKIPPED';
            const isCur = !isDone && rs.position === plan.position;
            const cur = isCur ? (stepMap.get(`${plan.id}:${rs.position}`) ?? rs) : undefined;
            return {
              label: describeProjectedStep(rs),
              state: isDone ? 'done' : isCur ? 'running' : 'pending',
              ...(isCur ? { meta: formatRunningStepMeta(plan.state, cur) } : {}),
            };
          })
        : plan.snapshot.steps.map((spec, idx) => {
            if (idx !== plan.position)
              return {
                label: describeCombinationStep(spec),
                state: idx < plan.position ? 'done' : 'pending',
              };
            const cur = stepMap.get(`${plan.id}:${idx}`);
            return {
              label: describeCombinationStep(spec),
              state: 'running',
              meta: formatRunningStepMeta(plan.state, cur),
            };
          });
    const roundLabel =
      plan.snapshot.loop.mode === 'until-stopped'
        ? `第 ${plan.round} 轮（持续循环）`
        : `第 ${plan.round}/${plan.snapshot.loop.rounds} 轮`;
    cards.push({
      key: `plan:${plan.id}`,
      carrier: 'browser',
      targetId: plan.profileId,
      targetName: profLabel(plan.profileId),
      title: `活跃账号 · ${plan.snapshot.name}`,
      subtitle: `${roundLabel}${plan.snapshot.randomOrder ? ' · 随机顺序' : ''}`,
      statusText: plan.state === 'QUEUED' ? '排队中' : `第 ${plan.position + 1}/${steps.length} 步`,
      closeOnFinish: plan.closeBrowserOnFinish,
      steps,
      stopKind: 'plan',
      planTarget: {
        profileId: plan.profileId,
        planId: plan.id,
        expectedState: plan.state,
        expectedUpdatedAt: plan.updatedAt,
      },
    });
  }

  const addMod = (pid: string, title: string, statusText: string, summary?: string) => {
    if (covered.has(`browser:${pid}`)) return;
    covered.add(`browser:${pid}`);
    cards.push({
      key: `mod:${pid}:${title}`,
      carrier: 'browser',
      targetId: pid,
      targetName: profLabel(pid),
      title,
      subtitle: '单模块运行中',
      statusText,
      steps: [{ label: title, state: 'running', meta: summary || statusText }],
      stopKind: 'module',
    });
  };
  for (const [pid, s] of Object.entries(p.groupPoster?.profileCounts ?? {}))
    if (s.running) addMod(pid, '小组发帖', s.status || '发帖中', `本轮 ${s.session} 贴`);
  for (const [pid, s] of Object.entries(p.groupBumper?.profileCounts ?? {}))
    if (s.running) addMod(pid, '小组顶贴', s.status || '顶贴中', `本轮 ${s.session} 次`);
  for (const [pid, s] of Object.entries(p.groupBumper?.pageBumperProfileCounts ?? {}))
    if (s.running) addMod(pid, '专页顶贴', s.status || '顶贴中', `本轮 ${s.session} 次`);
  for (const [pid, s] of Object.entries(p.groupInviter?.profileCounts ?? {}))
    if (s.running) addMod(pid, '小组邀请人', s.status || '邀请中', `本轮 ${s.sessionInvited} 人`);
  for (const a of p.googleSheets?.activeProfiles ?? [])
    addMod(a.profileId, `云表协同 · ${a.title}`, a.status);

  for (const [title, action, counts] of [
    ['蓝蝶活跃账号', 'active/stop', p.bluestacks?.activeProfileCounts],
    ['蓝蝶小组发帖', 'poster/stop', p.bluestacks?.posterProfileCounts],
    ['蓝蝶小组顶贴', 'bumper/stop', p.bluestacks?.profileCounts],
    ['蓝蝶专页顶贴', 'bumper/stop-page', p.bluestacks?.pageBumperProfileCounts],
    ['蓝蝶小组邀请人', 'inviter/stop', p.bluestacks?.inviterProfileCounts],
  ] as const) {
    for (const [id, stat] of Object.entries(counts ?? {})) {
      if (!stat.running || covered.has(`bluestacks:${id}`)) continue;
      covered.add(`bluestacks:${id}`);
      const inst = bsMap.get(id);
      const rawSteps = 'steps' in stat && Array.isArray(stat.steps) ? stat.steps : [];
      const statSteps =
        rawSteps.length > 0
          ? rawSteps.map((s) => ({
              label: s.label,
              state: s.state,
              ...(s.state === 'running' ? { meta: stat.status || '执行中' } : {}),
            }))
          : [
              {
                label: title,
                state: 'running' as const,
                meta: stat.status || `本轮 ${stat.session}`,
              },
            ];
      cards.push({
        key: `bs:${action}:${id}`,
        carrier: 'bluestacks',
        targetId: id,
        targetName: inst ? bluestacksDisplayTitle(inst) : id,
        title,
        subtitle: '模拟器运行中',
        statusText: stat.status || '执行中',
        steps: statSteps,
        stopKind: 'bluestacks-module',
        bsModuleAction: action,
      });
    }
  }
  return cards;
}
