import type { Plan, StepInstance, Event, Operation, TaskRecord } from '../shared/task-contracts.js';
export type RecordProjectionRow = {
  row: TaskRecord;
  isCurrentStep: boolean;
  hasUnresolved: boolean;
};
export function projectTaskRecords(
  plan: Plan,
  steps: StepInstance[],
  operations: Pick<Operation, 'stepId' | 'createdAt' | 'updatedAt' | 'status' | 'disposition'>[],
  events: Event[],
): RecordProjectionRow[] {
  const allRows: RecordProjectionRow[] = [];
  const hasUnresolved = operations.some(
    (op) => op.status === 'UNKNOWN' && op.disposition === undefined,
  );
  const firstRunningAt = events.find((event) => event.type === 'RUNNING')?.createdAt ?? null;
  const roundCreatedAt = new Map<number, number>();
  const stepCompletedAt = new Map<string, number>();
  const stepFirstEventAt = new Map<string, number>();
  const stepLastEventAt = new Map<string, number>();
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
      if (
        event.type === 'STEP_COMPLETED' ||
        event.type === 'STEP_FAILED' ||
        event.type === 'STEP_SKIPPED' ||
        event.type === 'STEP_CONTINUATION_READY'
      )
        stepCompletedAt.set(stepId, event.createdAt);
    }
  }
  const stepFirstOpAt = new Map<string, number>();
  const stepLastOpAt = new Map<string, number>();
  for (const op of operations) {
    const prevFirst = stepFirstOpAt.get(op.stepId);
    if (prevFirst === undefined || op.createdAt < prevFirst)
      stepFirstOpAt.set(op.stepId, op.createdAt);
    const prevLast = stepLastOpAt.get(op.stepId);
    if (prevLast === undefined || op.updatedAt > prevLast)
      stepLastOpAt.set(op.stepId, op.updatedAt);
  }
  let prevFinishedAt: number | null = null;
  let prevRound = 0;
  for (const step of steps) {
    if (step.round !== prevRound) {
      prevRound = step.round;
      prevFinishedAt = roundCreatedAt.get(step.round) ?? firstRunningAt ?? plan.createdAt;
    }
    let startedAt: number | null = null;
    if (step.status !== 'PENDING') {
      const opFirst = stepFirstOpAt.get(step.id);
      const evFirst = stepFirstEventAt.get(step.id);
      const candidates = [opFirst, evFirst].filter((v): v is number => v !== undefined);
      if (prevFinishedAt !== null) candidates.push(prevFinishedAt);
      else if (firstRunningAt !== null) candidates.push(firstRunningAt);
      else candidates.push(plan.createdAt);
      startedAt = Math.min(...candidates);
    }
    let finishedAt: number | null = null;
    if (step.outcome?.endedAt !== undefined) {
      finishedAt = step.outcome.endedAt;
    } else if (['COMPLETED', 'FAILED', 'SKIPPED'].includes(step.status)) {
      finishedAt =
        stepCompletedAt.get(step.id) ??
        stepLastOpAt.get(step.id) ??
        stepLastEventAt.get(step.id) ??
        plan.updatedAt;
    } else if (
      step.status === 'ACTIVE' &&
      ['STOPPED', 'COMPLETED', 'FAILED'].includes(plan.state)
    ) {
      finishedAt = stepLastOpAt.get(step.id) ?? plan.updatedAt;
    }
    if (startedAt !== null && finishedAt !== null && startedAt > finishedAt) startedAt = finishedAt;
    if (finishedAt !== null) prevFinishedAt = finishedAt;
    const budget =
      step.spec.type === 'post'
        ? { kind: 'posts' as const, count: step.spec.count }
        : step.spec.type === 'friends'
          ? {
              kind: 'friends' as const,
              mode: step.spec.acceptMode,
              count: step.spec.acceptMode === 'count' ? step.spec.maxAccepts : null,
            }
          : { kind: 'time' as const, milliseconds: step.spec.durationMinutes * 60_000 };
    const isCurrentStep =
      step.status === 'ACTIVE' ||
      (step.status === 'PENDING' &&
        step.round === plan.round &&
        step.position === plan.position &&
        !['STOPPED', 'COMPLETED', 'FAILED'].includes(plan.state));
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
        type: step.spec.type,
        ...(step.spec.type === 'post' && step.spec.destination
          ? { destination: step.spec.destination }
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
  online?: boolean | undefined;
  alias?: string | null | undefined;
  browserName?: string | null | undefined;
  account?: { state: string; id?: string | null | undefined } | null | undefined;
};
export const stepTypeSearchText: Record<TaskRecord['type'], string> = {
  feed: '浏览首页 feed',
  video: '浏览 reels video 短视频',
  post: '随机发帖 发布帖子 post',
  marketplace: '浏览商城 marketplace',
  friends: '接受好友请求 friends',
};
export function recordMatches(
  row: Pick<TaskRecord, 'combinationName' | 'profileId' | 'type' | 'destination'>,
  profile: RecordProfile | undefined,
  query: string,
) {
  return [
    row.combinationName,
    profile?.browserName ?? '',
    profile?.alias ?? '',
    row.profileId,
    stepTypeSearchText[row.type],
    row.destination === 'story' ? '发布快拍 story' : '',
  ]
    .join(' ')
    .toLocaleLowerCase()
    .includes(query);
}
export function compareRecords(a: TaskRecord, b: TaskRecord) {
  return (
    (b.finishedAt ?? b.startedAt ?? b.planCreatedAt) -
      (a.finishedAt ?? a.startedAt ?? a.planCreatedAt) ||
    b.planCreatedAt - a.planCreatedAt ||
    b.round - a.round ||
    b.position - a.position ||
    b.stepId.localeCompare(a.stepId)
  );
}
