import type { Plan, StepInstance, Event, Operation, TaskRecord } from '../shared/task-contracts.js';
type RecordProjectionRow = { row: TaskRecord; isCurrentStep: boolean; hasUnresolved: boolean };
const COMPLETED_EVENTS = new Set([
    'STEP_COMPLETED',
    'STEP_FAILED',
    'STEP_SKIPPED',
    'STEP_CONTINUATION_READY',
  ]),
  TERMINAL_STATES = new Set(['STOPPED', 'COMPLETED', 'FAILED']);
export function projectTaskRecords(
  plan: Plan,
  steps: StepInstance[],
  operations: Pick<Operation, 'stepId' | 'createdAt' | 'updatedAt' | 'status' | 'disposition'>[],
  events: Event[],
): RecordProjectionRow[] {
  const allRows: RecordProjectionRow[] = [],
    hasUnresolved = operations.some(
      (op) => op.status === 'UNKNOWN' && op.disposition === undefined,
    ),
    firstRunningAt = events.find((e) => e.type === 'RUNNING')?.createdAt ?? null,
    roundCreatedAt = new Map<number, number>(),
    stepCompletedAt = new Map<string, number>(),
    stepFirstEventAt = new Map<string, number>(),
    stepLastEventAt = new Map<string, number>(),
    stepFirstOpAt = new Map<string, number>(),
    stepLastOpAt = new Map<string, number>();
  for (const event of events) {
    const detail =
      event.detail && typeof event.detail === 'object' && !Array.isArray(event.detail)
        ? (event.detail as Record<string, unknown>)
        : null;
    if (event.type === 'ROUND_CREATED' && typeof detail?.round === 'number')
      roundCreatedAt.set(detail.round, event.createdAt);
    const stepId = typeof detail?.stepId === 'string' ? detail.stepId : null;
    if (stepId) {
      if (!stepFirstEventAt.has(stepId)) stepFirstEventAt.set(stepId, event.createdAt);
      stepLastEventAt.set(stepId, event.createdAt);
      if (COMPLETED_EVENTS.has(event.type)) stepCompletedAt.set(stepId, event.createdAt);
    }
  }
  for (const op of operations) {
    const f = stepFirstOpAt.get(op.stepId),
      l = stepLastOpAt.get(op.stepId);
    if (f === undefined || op.createdAt < f) stepFirstOpAt.set(op.stepId, op.createdAt);
    if (l === undefined || op.updatedAt > l) stepLastOpAt.set(op.stepId, op.updatedAt);
  }
  let prevFinishedAt: number | null = null,
    prevRound = 0;
  for (const step of steps) {
    if (step.round !== prevRound) {
      prevRound = step.round;
      prevFinishedAt = roundCreatedAt.get(step.round) ?? firstRunningAt ?? plan.createdAt;
    }
    let startedAt: number | null = null;
    if (step.status !== 'PENDING') {
      const c = [stepFirstOpAt.get(step.id), stepFirstEventAt.get(step.id)].filter(
        (v): v is number => v !== undefined,
      );
      c.push(prevFinishedAt ?? firstRunningAt ?? plan.createdAt);
      startedAt = Math.min(...c);
    }
    let finishedAt: number | null = null;
    if (step.outcome?.endedAt !== undefined) finishedAt = step.outcome.endedAt;
    else if (['COMPLETED', 'FAILED', 'SKIPPED'].includes(step.status))
      finishedAt =
        stepCompletedAt.get(step.id) ??
        stepLastOpAt.get(step.id) ??
        stepLastEventAt.get(step.id) ??
        plan.updatedAt;
    else if (step.status === 'ACTIVE' && TERMINAL_STATES.has(plan.state))
      finishedAt = stepLastOpAt.get(step.id) ?? plan.updatedAt;
    if (startedAt !== null && finishedAt !== null && startedAt > finishedAt) startedAt = finishedAt;
    if (finishedAt !== null) prevFinishedAt = finishedAt;
    const { spec } = step,
      budget =
        spec.type === 'post'
          ? { kind: 'posts' as const, count: spec.count }
          : spec.type === 'friends'
            ? {
                kind: 'friends' as const,
                mode: spec.acceptMode,
                count: spec.acceptMode === 'count' ? spec.maxAccepts : null,
              }
            : { kind: 'time' as const, milliseconds: spec.durationMinutes * 60_000 },
      isCurrentStep =
        step.status === 'ACTIVE' ||
        (step.status === 'PENDING' &&
          step.round === plan.round &&
          step.position === plan.position &&
          !TERMINAL_STATES.has(plan.state));
    allRows.push({
      isCurrentStep,
      hasUnresolved,
      row: {
        stepId: step.id,
        planId: plan.id,
        profileId: plan.profileId,
        combinationId: plan.combinationId,
        combinationName: plan.snapshot.name,
        combinationVersion: plan.version,
        round: step.round,
        position: step.position,
        type: spec.type,
        ...(spec.type === 'post' && spec.destination ? { destination: spec.destination } : {}),
        ...(spec.type === 'friends' && spec.friendAction
          ? { friendAction: spec.friendAction }
          : {}),
        ...(spec.type === 'feed' && spec.feedMode && spec.feedMode !== 'home'
          ? { feedMode: spec.feedMode }
          : {}),
        status: step.status,
        planState: plan.state,
        planReason: plan.reason,
        ...(step.outcome ? { outcome: step.outcome } : {}),
        progress: step.progress,
        budget,
        startedAt,
        finishedAt,
        planCreatedAt: plan.createdAt,
        planUpdatedAt: plan.updatedAt,
      },
    });
  }
  return allRows;
}
export type RecordProfile = {
  id: string;
  online?: boolean;
  alias?: string | null;
  browserName?: string | null;
  account?: { state: string; id?: string | null } | null;
};
const stepTypeSearchText: Record<TaskRecord['type'], string> = {
  feed: '浏览首页 feed',
  video: '浏览 reels video 短视频',
  post: '随机发帖 发布帖子 post',
  marketplace: '浏览商城 marketplace',
  friends: '接受好友请求 friends',
};
const feedModeText: Record<string, string> = {
  random_profile: '逛他人时间线 随机时间线 random_profile',
  random_page: '逛公共专页 随机专页 random_page',
  search_pages: '搜专页逛时间线 搜索专页 指定专页 search_pages',
};
export const recordMatches = (
  row: Pick<
    TaskRecord,
    'combinationName' | 'profileId' | 'type' | 'destination' | 'friendAction' | 'feedMode'
  >,
  profile: RecordProfile | undefined,
  query: string,
) =>
  [
    row.combinationName,
    profile?.browserName ?? '',
    profile?.alias ?? '',
    row.profileId,
    stepTypeSearchText[row.type],
    row.destination === 'story' ? '发布快拍 story' : '',
    row.friendAction === 'add_suggested' ? '加推荐好友 添加好友 add_suggested' : '',
    row.feedMode ? (feedModeText[row.feedMode] ?? '') : '',
  ]
    .join(' ')
    .toLocaleLowerCase()
    .includes(query);
export const compareRecords = (a: TaskRecord, b: TaskRecord) =>
  (b.finishedAt ?? b.startedAt ?? b.planCreatedAt) -
    (a.finishedAt ?? a.startedAt ?? a.planCreatedAt) ||
  b.planCreatedAt - a.planCreatedAt ||
  b.round - a.round ||
  b.position - a.position ||
  b.stepId.localeCompare(a.stepId);
