import type { z } from 'zod';
import type { Awaitable } from '../domain/persistence.js';
import type { RecordProfile, TaskRepository } from '../domain/tasks.js';
import { ProductError } from '../domain/workspace.js';
import { flatMapAsync } from '../shared/async-collections.js';
import {
  AssignTasks,
  SchedulerSettings,
  TaskCapabilities,
  TaskCommandRequest,
  TaskCommandResult,
  TaskOverview,
  TaskRecords,
  TaskRecordsRequest,
  TaskRuntimeOverview,
  TaskRuntimeRequest,
  TaskStartResult,
  buildTaskRecord,
  type Assignment,
  type Plan,
  type RuntimeRequest,
  type StepInstance,
  type TaskCommand,
  type TaskRecord,
} from '../shared/task-contracts.js';
import type { TaskFeatureId } from '../shared/task-policies.js';
import { isSuccessfulTaskStep } from '../shared/task-step-outcome.js';
import type { Workboard } from './workboard.js';
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
  private workboard?: Workboard;
  constructor(
    private readonly repository: TaskRepository,
    private readonly execution: () => TaskExecutionPort | undefined = () => undefined,
    private readonly assertStartAllowed: () => Awaitable<void> = () => {},
    private readonly onTaskLaunched?: () => void,
  ) {}
  setWorkboard = (workboard: Workboard) => void (this.workboard = workboard);
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
  async syncMaxConcurrency(maxConcurrentProfiles: number): Promise<void> {
    const capped = Math.max(1, Math.min(50, Math.round(maxConcurrentProfiles)));
    this.workboard?.browserPermits.setLimit(capped);
    const cur = await this.settings();
    if (cur.maxConcurrentProfiles !== capped)
      await this.repository.setSettings(
        SchedulerSettings.parse({ ...cur, maxConcurrentProfiles: capped }),
      );
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
      await execution.waitUntilProfileIdle?.(profileId, 3_500);
      return false;
    }
    await execution.stopProfile(profileId);
    await execution.waitUntilProfileIdle?.(profileId, 3_500);
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
          if (plan.state !== target.expectedState) throw Error('任务状态已变化，请重新读取后操作');
          current = await execution.commandPlan(plan.id, request.command);
          execution.revokeForControl?.(target.planId, target.profileId, 'USER_STOP');
          return {
            ...target,
            accepted: true,
            state: current.state,
            controlConfirmed: current.controlConfirmed,
            reason: current.reason,
          };
        } catch (error) {
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
    return TaskCommandResult.parse({
      results: results.map(({ expectedState: _s, expectedUpdatedAt: _t, ...r }) => r),
    });
  }
  async records(input: unknown, profiles: readonly RecordProfile[] = []) {
    if (this.repository.recordsPage) return await this.repository.recordsPage(input, profiles);
    const request = TaskRecordsRequest.parse(input ?? {});
    const profileMap = new Map(profiles.map((p) => [p.id, p]));
    const plans = (await this.repository.list()).filter(
      (p) => !request.profileId || p.profileId === request.profileId,
    );
    const q = request.query?.trim().toLowerCase() ?? '';
    const allRows: TaskRecord[] = [];
    for (const plan of plans) {
      const prof = profileMap.get(plan.profileId);
      const profText = [prof?.browserName, prof?.alias, prof?.account?.name, prof?.account?.id]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      for (const step of await this.repository.steps(plan.id)) {
        const row = buildTaskRecord(
          step,
          plan.id,
          plan.profileId,
          plan.combinationId,
          plan.snapshot.name,
          plan.version,
          plan.state,
          plan.reason,
          plan.createdAt,
          plan.updatedAt,
        );
        if (
          !q ||
          `${row.combinationName} ${row.type} ${row.planReason} ${row.profileId} ${profText}`
            .toLowerCase()
            .includes(q)
        ) {
          allRows.push(row);
        }
      }
    }
    allRows.sort((a, b) => b.planUpdatedAt - a.planUpdatedAt || a.position - b.position);
    const classify = (row: TaskRecord) => {
      const running =
        (row.status === 'ACTIVE' || row.status === 'PENDING') &&
        ['QUEUED', 'RUNNING'].includes(row.planState);
      const completed = isSuccessfulTaskStep(row.type, row.status, row.outcome);
      const failed = row.status === 'FAILED';
      const review = row.outcome?.kind === 'FAILED' && row.outcome.businessResult === 'UNKNOWN';
      return { running, completed, failed, review };
    };
    const counts = {
      all: allRows.length,
      running: allRows.filter((r) => classify(r).running).length,
      completed: allRows.filter((r) => classify(r).completed).length,
      failed: allRows.filter((r) => classify(r).failed).length,
      review: allRows.filter((r) => classify(r).review).length,
    };
    const filtered =
      request.status === 'all'
        ? allRows
        : allRows.filter(
            (r) => classify(r)[request.status as Exclude<typeof request.status, 'all'>],
          );
    const offset = request.cursor ? Math.max(0, Number.parseInt(request.cursor, 10) || 0) : 0;
    const page = filtered.slice(offset, offset + request.limit);
    const nextOffset = offset + page.length;
    return TaskRecords.parse({
      records: page,
      nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
      total: filtered.length,
      counts,
    });
  }
}
