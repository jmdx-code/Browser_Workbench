import type { z } from 'zod';
import type { Awaitable } from '../domain/persistence.js';
import {
  compareRecords,
  projectTaskRecords,
  recordMatches,
  type RecordProfile,
} from '../domain/task-record-projection.js';
import { groupTaskRecords } from '../domain/task-run-records.js';
import type { TaskRepository } from '../domain/tasks.js';
import { ProductError } from '../domain/workspace.js';
import { flatMapAsync } from '../shared/async-collections.js';
import {
  AssignTasks,
  SchedulerSettings,
  TaskCapabilities,
  TaskCommandRequest,
  TaskCommandResult,
  TaskHistory,
  TaskHistoryRequest,
  TaskOverview,
  TaskRecords,
  TaskRecordsRequest,
  TaskRuntimeOverview,
  TaskRuntimeRequest,
  TaskStartResult,
  type Assignment,
  type Plan,
  type RuntimeRequest,
  type StepInstance,
  type TaskCommand,
  type TaskRecord,
} from '../shared/task-contracts.js';
import type { TaskFeatureId } from '../shared/task-policies.js';
import { isSuccessfulTaskStep } from '../shared/task-step-outcome.js';

export interface TaskExecutionPort {
  hasActiveExecution?(): boolean;
  waitUntilProfileIdle?(profileId: string, timeoutMs?: number): Promise<void>;
  currentResourceRevision?(combinationId: string): Promise<number | null>;
  revokeForControl?(planId: string, profileId: string, reason: string): void;
  available(): Awaitable<boolean>;
  capabilities(): Awaitable<z.infer<typeof TaskCapabilities>>;
  supportsFeature?(id: TaskFeatureId): Awaitable<boolean>;
  start(input: Assignment): Awaitable<Plan[]>;
  stopProfile(profileId: string): Promise<void>;
  commandPlan(planId: string, command: TaskCommand['command']): Promise<Plan>;
}

function projectStepBase(step: StepInstance) {
  const s = step.spec;
  return {
    id: step.id,
    round: step.round,
    position: step.position,
    status: step.status,
    ...(step.outcome ? { outcome: step.outcome } : {}),
    progress: step.progress,
    type: s.type,
    ...(s.type === 'post' && s.destination ? { destination: s.destination } : {}),
    ...(s.type === 'friends' && s.friendAction ? { friendAction: s.friendAction } : {}),
    ...(s.type === 'feed' && s.feedMode && s.feedMode !== 'home' ? { feedMode: s.feedMode } : {}),
    ...(s.type === 'feed' || s.type === 'video' ? { maxLikes: s.maxLikes } : {}),
    budget:
      s.type === 'post'
        ? { kind: 'posts', count: s.count }
        : s.type === 'friends'
          ? {
              kind: 'friends',
              mode: s.acceptMode,
              count: s.acceptMode === 'count' ? s.maxAccepts : null,
            }
          : { kind: 'time', milliseconds: s.durationMinutes * 60_000 },
  };
}

export class TaskService {
  constructor(
    private readonly repository: TaskRepository,
    private readonly execution: () => TaskExecutionPort | undefined = () => undefined,
    private readonly assertStartAllowed: () => Awaitable<void> = () => {},
    private readonly onTaskLaunched?: () => void,
  ) {}

  async overview() {
    return TaskOverview.parse({
      dispatchEnabled: (await this.execution()?.available()) ?? false,
      settings: await this.repository.settings(),
      plans: await this.repository.list(),
    });
  }

  async capabilities() {
    return TaskCapabilities.parse(
      (await this.execution()?.capabilities()) ?? { types: [], combinations: [] },
    );
  }

  async runtimeOverview(input: RuntimeRequest = {}) {
    const request = TaskRuntimeRequest.parse(input);
    const snapshot = await this.repository.runtimeSnapshot?.(request);
    const overview = snapshot
      ? {
          dispatchEnabled: (await this.execution()?.available()) ?? false,
          settings: snapshot.settings,
          plans: snapshot.plans,
        }
      : { ...(await this.overview()), plans: await this.repository.livePlans() };
    return TaskRuntimeOverview.parse({
      ...overview,
      ...(snapshot
        ? {
            recentTerminalPlans: snapshot.recentTerminalPlans,
            profileResults: snapshot.profileResults,
            events: snapshot.events,
            lastEventSequence: snapshot.lastEventSequence,
            lastScannedSequence: snapshot.lastScannedSequence,
            hasMore: snapshot.hasMore,
            resetRequired: snapshot.resetRequired,
            visibleTerminalFloorSequence: snapshot.visibleTerminalFloorSequence,
            epoch: snapshot.epoch,
            cursor: snapshot.cursor,
          }
        : {}),
      currentSteps: await flatMapAsync(
        overview.plans.filter((plan) => !['STOPPED', 'COMPLETED', 'FAILED'].includes(plan.state)),
        async (plan) => {
          const step = snapshot
            ? snapshot.currentSteps.find((v) => v.jobId === plan.id)
            : await this.currentStepForPlan(plan.id, plan.round, plan.position);
          return step ? [{ ...projectStepBase(step), jobId: step.jobId }] : [];
        },
      ),
      roundSteps: (snapshot?.roundSteps
        ? snapshot.roundSteps
        : await flatMapAsync(
            overview.plans.filter(
              (plan) => !['STOPPED', 'COMPLETED', 'FAILED'].includes(plan.state),
            ),
            (plan) => this.repository.steps(plan.id, plan.round),
          )
      ).map((step) => ({ ...projectStepBase(step), jobId: step.jobId })),
    });
  }

  async currentStepForPlan(planId: string, round: number, position: number) {
    return (
      (await this.repository.currentStepForPlan?.(planId, round, position)) ??
      (await this.repository.steps(planId, round)).find((v) => v.position === position) ??
      null
    );
  }

  async plansForBatch(batchId: string) {
    return await this.repository.plansForBatch(batchId);
  }

  async hasActiveExecution() {
    return (
      this.execution()?.hasActiveExecution?.() ??
      (await this.repository.livePlans()).some((p) => p.state === 'RUNNING' || p.state === 'QUEUED')
    );
  }

  async livePlans() {
    return await this.repository.livePlans();
  }

  async hasProfilePlanInStates(profileId: string, states: readonly Plan['state'][]) {
    return await this.repository.hasProfilePlanInStates(profileId, states);
  }

  async start(input: unknown) {
    const request = AssignTasks.parse(input);
    const execution = this.execution();
    if (!(await this.repository.batchExists(request.requestId))) await this.assertStartAllowed();
    if (!execution)
      throw new ProductError('COMBINATION_EXECUTOR_UNAVAILABLE', '组合执行尚未开放', 409);
    const result = TaskStartResult.parse({ plans: await execution.start(request) });
    this.onTaskLaunched?.();
    return result;
  }

  async setSettings(input: unknown) {
    await this.repository.setSettings(SchedulerSettings.parse(input));
    return this.settings();
  }

  async settings() {
    return SchedulerSettings.parse(await this.repository.settings());
  }

  async waitUntilProfileIdle(profileId: string, timeoutMs = 8_000): Promise<void> {
    await this.execution()?.waitUntilProfileIdle?.(profileId, timeoutMs);
  }

  async currentResourceRevision(combinationId: string): Promise<number | null> {
    return (await this.execution()?.currentResourceRevision?.(combinationId)) ?? null;
  }

  async stopActiveProfile(profileId: string) {
    const execution = this.execution();
    if (!execution) return false;
    if (!(await this.repository.hasProfilePlanInStates(profileId, ['QUEUED', 'RUNNING']))) {
      await execution.waitUntilProfileIdle?.(profileId, 8_000);
      return false;
    }
    await execution.stopProfile(profileId);
    await execution.waitUntilProfileIdle?.(profileId, 8_000);
    return true;
  }

  async command(input: unknown) {
    const request = TaskCommandRequest.parse(input);
    const execution = this.execution();
    if (!execution) throw new ProductError('TASKS_UNAVAILABLE', '任务执行服务未启用', 409);
    const results = await Promise.all(
      request.plans.map(async (target) => {
        let current: Plan | null = null;
        try {
          const plan = await this.repository.get(target.planId);
          if (plan.profileId !== target.profileId) throw Error('任务与浏览器不匹配');
          current = plan;
          if (
            plan.state !== target.expectedState ||
            (request.command === 'resume' && plan.updatedAt !== target.expectedUpdatedAt)
          ) {
            throw Error('任务状态已变化，请重新读取后操作');
          }
          if (request.command === 'resume') await this.assertStartAllowed();
          current = await execution.commandPlan(plan.id, request.command);
          if (request.command === 'stop')
            execution.revokeForControl?.(target.planId, target.profileId, 'USER_STOP');
          return {
            ...target,
            accepted: true,
            state: current.state,
            controlConfirmed: current.controlConfirmed,
            reason: current.reason,
          };
        } catch (error) {
          if (request.command === 'stop')
            execution.revokeForControl?.(target.planId, target.profileId, 'USER_STOP');
          if (current) current = await this.repository.get(current.id);
          return {
            ...target,
            accepted: false,
            state: current?.state ?? null,
            controlConfirmed: current?.controlConfirmed ?? false,
            reason: error instanceof Error ? error.message.slice(0, 200) : '任务操作失败',
          };
        }
      }),
    );
    const parsed = TaskCommandResult.parse({
      results: results.map(({ expectedState: _s, expectedUpdatedAt: _t, ...r }) => r),
    });
    if (request.command === 'resume' && parsed.results.some((r) => r.accepted))
      this.onTaskLaunched?.();
    return parsed;
  }

  async records(input: unknown, profiles: readonly RecordProfile[] = []) {
    return this.repository.recordsPage
      ? await this.repository.recordsPage(input, profiles)
      : await this.recordsLegacy(input, profiles);
  }

  async recordsLegacy(input: unknown, profiles: readonly RecordProfile[] = []) {
    const request = TaskRecordsRequest.parse(input ?? {});
    const profileMap = new Map(profiles.map((p) => [p.id, p]));
    const plans = (await this.repository.list()).filter(
      (p) => !request.profileId || p.profileId === request.profileId,
    );
    const hidden = new Set((await this.repository.hiddenRecordIds?.()) ?? []);
    const allRows: { row: TaskRecord; isCurrentStep: boolean; hasUnresolved: boolean }[] = [];
    for (const plan of plans) {
      const [steps, operations, events] = await Promise.all([
        this.repository.steps(plan.id),
        this.repository.operations(plan.id),
        this.repository.events(plan.id),
      ]);
      allRows.push(
        ...projectTaskRecords(plan, steps, operations, events).filter(
          (item) => !hidden.has(item.row.stepId),
        ),
      );
    }
    const q = request.query?.trim().toLocaleLowerCase() ?? '';
    const queryFiltered = !q
      ? allRows
      : allRows.filter(({ row }) => recordMatches(row, profileMap.get(row.profileId), q));
    queryFiltered.sort((a, b) => compareRecords(a.row, b.row));
    type Item = (typeof allRows)[number];
    const isRunning = ({ row, isCurrentStep }: Item) =>
      isCurrentStep && ['QUEUED', 'RUNNING'].includes(row.planState);
    const isCompleted = ({ row }: Item) => isSuccessfulTaskStep(row.type, row.status, row.outcome);
    const isFailed = ({ row }: Item) =>
      row.status === 'FAILED' ||
      (row.status === 'ACTIVE' && row.planState === 'FAILED' && row.outcome?.kind !== 'SKIPPED');
    const isReview = ({ row, isCurrentStep, hasUnresolved }: Item) =>
      (isCurrentStep &&
        (hasUnresolved ||
          (row.planState === 'QUEUED' && profileMap.get(row.profileId)?.online === false))) ||
      (row.outcome?.kind === 'FAILED' && row.outcome.businessResult === 'UNKNOWN');
    const predByStatus = {
      running: isRunning,
      completed: isCompleted,
      failed: isFailed,
      review: isReview,
      all: () => true,
    } as const;
    const countBy = <T>(
      list: readonly T[],
      match: (item: T, st: 'running' | 'completed' | 'failed' | 'review') => boolean,
    ) => ({
      all: list.length,
      running: list.filter((x) => match(x, 'running')).length,
      completed: list.filter((x) => match(x, 'completed')).length,
      failed: list.filter((x) => match(x, 'failed')).length,
      review: list.filter((x) => match(x, 'review')).length,
    });
    const offset = request.cursor ? Math.max(0, Number.parseInt(request.cursor, 10) || 0) : 0;

    if (request.groupBy === 'run') {
      const matching = new Set(queryFiltered.map(({ row }) => `${row.planId}:${row.round}`));
      const groups = groupTaskRecords(allRows.map((x) => x.row)).filter((g) => matching.has(g.key));
      const meta = new Map(allRows.map((x) => [x.row.stepId, x]));
      const matches = (g: (typeof groups)[number], status: typeof request.status) => {
        if (status === 'completed')
          return g.rows.every((r) => isSuccessfulTaskStep(r.type, r.status, r.outcome));
        if (status === 'failed') {
          return g.rows.some((r) => {
            const item = meta.get(r.stepId);
            return (
              (item && isFailed(item)) ||
              (r.planState === 'FAILED' && plans.find((p) => p.id === r.planId)?.round === r.round)
            );
          });
        }
        if (status === 'running' || status === 'review') {
          return g.rows.some((r) => {
            const item = meta.get(r.stepId);
            return !!item && (status === 'running' ? isRunning(item) : isReview(item));
          });
        }
        return true;
      };
      const filtered = groups.filter((g) => matches(g, request.status));
      const rows: TaskRecord[] = [];
      let used = 0;
      for (const g of filtered.slice(offset, offset + request.limit)) {
        if (
          rows.length + g.rows.length > 200 ||
          JSON.stringify([...rows, ...g.rows]).length > 80000
        ) {
          if (!rows.length)
            throw new ProductError(
              'RECORD_DETAIL_REQUIRED',
              '单次任务超过页面预算，请查看任务详情',
              413,
            );
          break;
        }
        rows.push(...g.rows);
        used++;
      }
      return TaskRecords.parse({
        records: rows,
        total: filtered.length,
        counts: countBy(groups, matches),
        nextCursor: offset + used < filtered.length ? String(offset + used) : null,
      });
    }

    const statusFiltered = queryFiltered
      .filter(predByStatus[request.status])
      .map((item) => item.row);
    const page = statusFiltered.slice(offset, offset + request.limit);
    const nextOffset = offset + page.length;
    return TaskRecords.parse({
      records: page,
      nextCursor: nextOffset < statusFiltered.length ? String(nextOffset) : null,
      total: statusFiltered.length,
      counts: countBy(queryFiltered, (x, st) => predByStatus[st](x)),
    });
  }

  async history(input: unknown) {
    const request = TaskHistoryRequest.parse(input);
    const all = (
      this.repository.historyPlans
        ? await this.repository.historyPlans(request.profileId, request.planId)
        : await this.repository.plansForProfile(request.profileId)
    ).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    const hidden = this.repository.historyPlans
      ? new Set<string>()
      : new Set((await this.repository.hiddenRecordIds?.()) ?? []);
    const visible: typeof all = [];
    for (const plan of all) {
      if (['STOPPED', 'COMPLETED', 'FAILED'].includes(plan.state) && hidden.size) {
        const steps = await this.repository.steps(plan.id, plan.round);
        if (steps.length && steps.every((step) => hidden.has(step.id))) continue;
      }
      visible.push(plan);
    }
    if (!visible.length && request.planId) {
      const explicit = all.find((p) => p.id === request.planId);
      if (explicit) visible.push(explicit);
    }
    const plans = visible.slice(0, 50);
    const selected = request.planId ? visible.find((p) => p.id === request.planId) : plans[0];
    if (selected && !plans.some((p) => p.id === selected.id)) {
      plans.pop();
      plans.push(selected);
    }
    if (request.planId && !selected) {
      throw new ProductError(
        'TASK_HISTORY_PLAN_UNAVAILABLE',
        '这份浏览器的任务记录已变化，请重新读取',
        409,
      );
    }
    const operations = selected ? await this.repository.operations(selected.id) : [];
    const events = selected ? await this.repository.events(selected.id) : [];
    const selectedSteps = selected
      ? await this.repository.steps(selected.id, request.round ?? selected.round)
      : [];
    const finalRecords = selected
      ? await this.repository.finalRecords?.(selected.id, request.round ?? selected.round)
      : null;
    const times = new Map(
      finalRecords
        ? finalRecords.map((row) => [row.stepId, row] as const)
        : selected
          ? projectTaskRecords(selected, selectedSteps, operations, events).map(({ row }) => [
              row.stepId,
              row,
            ])
          : [],
    );
    return TaskHistory.parse({
      ...(finalRecords ? { detailsReclaimed: true } : {}),
      profileId: request.profileId,
      plans: plans.map((plan) => ({
        id: plan.id,
        combinationId: plan.combinationId,
        version: plan.version,
        name: plan.snapshot.name,
        ...(plan.timing ? { timing: plan.timing } : {}),
        accountId: plan.accountId,
        state: plan.state,
        reason: plan.reason,
        controlConfirmed: plan.controlConfirmed,
        round: plan.round,
        position: plan.position,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      })),
      selectedPlanId: selected?.id ?? null,
      steps: selected
        ? selectedSteps.map((step) => ({
            ...projectStepBase(step),
            startedAt: times.get(step.id)?.startedAt ?? null,
            finishedAt: times.get(step.id)?.finishedAt ?? null,
          }))
        : [],
      operations: operations
        .slice(-100)
        .reverse()
        .map((op) => ({
          id: op.id,
          stepId: op.stepId,
          kind: op.action.kind,
          status: op.status,
          createdAt: op.createdAt,
          updatedAt: op.updatedAt,
        })),
      events: events
        .slice(-100)
        .reverse()
        .map((e) => ({ sequence: e.sequence, type: e.type, createdAt: e.createdAt })),
      truncated: {
        plans: visible.length > 50,
        operations: operations.length > 100,
        events: events.length > 100,
      },
    });
  }
}
