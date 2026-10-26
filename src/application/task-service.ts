import { groupTaskRecords } from '../domain/task-run-records.js';
import type { Awaitable } from '../domain/persistence.js';
import { mapAsync, flatMapAsync } from '../shared/async-collections.js';
import {
  projectTaskRecords,
  recordMatches,
  compareRecords,
} from '../domain/task-record-projection.js';
import type { TaskRepository } from '../domain/tasks.js';
import {
  TaskOverview,
  TaskHistory,
  TaskHistoryRequest,
  TaskRecords,
  TaskRecordsRequest,
  type TaskRecord,
  TaskCapabilities,
  AssignTasks,
  TaskStartResult,
  TaskRuntimeOverview,
  TaskRuntimeRequest,
  TaskCommandRequest,
  TaskCommandResult,
  type TaskCommand,
  type Assignment,
  type Plan,
  SchedulerSettings,
} from '../shared/task-contracts.js';
import {
  TaskFeatureOverview,
  TaskFeatureOverviewV2,
  taskFeatureDefinitions,
  type FeatureEvidenceValue,
  type TaskFeatureId,
} from '../shared/task-features.js';
import { ProductError } from '../domain/workspace.js';
import type { z } from 'zod';
export interface TaskExecutionPort {
  hasActiveExecution?(): boolean;
  revokeForControl?(planId: string, profileId: string, reason: string): void;
  available(): Awaitable<boolean>;
  capabilities(): Awaitable<z.infer<typeof TaskCapabilities>>;
  supportsFeature?(id: TaskFeatureId): Awaitable<boolean>;
  start(input: Assignment): Awaitable<Plan[]>;
  stopProfile(profileId: string): Promise<void>;
  commandPlan(planId: string, command: TaskCommand['command']): Promise<Plan>;
}
export class TaskService {
  constructor(
    private readonly repository: TaskRepository,
    private readonly execution: () => TaskExecutionPort | undefined = () => undefined,
    private readonly assertStartAllowed: () => Awaitable<void> = () => {},
    private readonly featureEvidence?: () => FeatureEvidenceValue,
    private readonly onTaskLaunched?: () => void,
  ) {}
  async overview() {
    // Storage is real. Dispatch stays disabled until identity and all requested executors are available.
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
  async runtimeOverview(input: unknown = {}) {
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
            ? snapshot.currentSteps.find((value) => value.jobId === plan.id)
            : ((await this.repository.currentStepForPlan?.(plan.id, plan.round, plan.position)) ??
              (await this.repository.steps(plan.id, plan.round)).find(
                (value) => value.position === plan.position,
              ));
          return step
            ? [
                {
                  id: step.id,
                  jobId: step.jobId,
                  round: step.round,
                  position: step.position,
                  status: step.status,
                  ...(step.outcome ? { outcome: step.outcome } : {}),
                  progress: step.progress,
                  type: step.spec.type,
                  ...(step.spec.type === 'post' && step.spec.destination
                    ? { destination: step.spec.destination }
                    : {}),
                  budget:
                    step.spec.type === 'post'
                      ? { kind: 'posts', count: step.spec.count }
                      : step.spec.type === 'friends'
                        ? {
                            kind: 'friends',
                            mode: step.spec.acceptMode,
                            count: step.spec.acceptMode === 'count' ? step.spec.maxAccepts : null,
                          }
                        : { kind: 'time', milliseconds: step.spec.durationMinutes * 60_000 },
                },
              ]
            : [];
        },
      ),
    });
  }
  async releaseErroredPausedPlans(profileIds: readonly string[]) {
    return (await this.repository.releaseErroredPausedPlans?.(profileIds)) ?? 0;
  }
  async batchExists(batchId: string) {
    return await this.repository.batchExists(batchId);
  }
  async plansForBatch(batchId: string) {
    return await this.repository.plansForBatch(batchId);
  }
  async hasActiveExecution() {
    const runtime = this.execution();
    return (
      runtime?.hasActiveExecution?.() ??
      (await this.repository.livePlans()).some((p) => p.state === 'RUNNING' || p.state === 'QUEUED')
    );
  }
  async livePlans() {
    return await this.repository.livePlans();
  }
  async plansForProfile(profileId: string, states?: readonly Plan['state'][]) {
    return await this.repository.plansForProfile(profileId, states);
  }
  async hasProfilePlanInStates(profileId: string, states: readonly Plan['state'][]) {
    return await this.repository.hasProfilePlanInStates(profileId, states);
  }
  async start(input: unknown) {
    const request = AssignTasks.parse(input),
      execution = this.execution();
    if (!(await this.repository.batchExists(request.requestId))) {
      await this.assertStartAllowed();
      await this.releaseErroredPausedPlans(request.profileIds);
    }
    if (!execution)
      throw new ProductError('COMBINATION_EXECUTOR_UNAVAILABLE', '组合执行尚未开放', 409);
    const result = TaskStartResult.parse({ plans: await execution.start(request) });
    this.onTaskLaunched?.();
    return result;
  }
  async setSettings(input: unknown) {
    await this.repository.setSettings(SchedulerSettings.parse(input));
    return SchedulerSettings.parse(await this.repository.settings());
  }
  async settings() {
    return SchedulerSettings.parse(await this.repository.settings());
  }
  async features(contract: '1' | '2' = '1') {
    const execution = this.execution(),
      capabilities = await this.capabilities();
    const overview = TaskFeatureOverview.parse({
      controllerAvailable: (await execution?.available()) ?? false,
      features: await mapAsync(taskFeatureDefinitions, async ({ id }) => {
        const available = execution?.supportsFeature
          ? await execution.supportsFeature(id)
          : id !== 'story' && capabilities.types.includes(id);
        return {
          id,
          status: available ? 'available' : 'verification-pending',
          reason: available
            ? id === 'story'
              ? '支持明确好友范围的文字、单图或视频快拍；执行前核对当前账号及原素材。'
              : '可加入任务组合运行；实际执行仍需资料连接及当前账号确认。'
            : !execution
              ? '任务执行服务未启用。'
              : id === 'post'
                ? '完整发帖执行尚未开放，部分格式的验证不代表全部发布功能可用。'
                : id === 'story'
                  ? '快拍执行尚未开放。'
                  : '当前执行能力未开放。',
        };
      }),
    });
    if (contract === '1') return overview;
    const evidence = this.featureEvidence?.();
    return TaskFeatureOverviewV2.parse({
      ...overview,
      features: overview.features.map((feature) => ({
        ...feature,
        implementation: evidence?.[feature.id].implementation ?? 'partial',
        verification: evidence?.[feature.id].verification ?? 'pending',
        enabled: feature.status === 'available',
        reason: evidence?.[feature.id].reason ?? feature.reason,
      })),
    });
  }
  async stopActiveProfile(profileId: string) {
    const execution = this.execution();
    if (
      !execution ||
      !(await this.repository.hasProfilePlanInStates(profileId, [
        'QUEUED',
        'RUNNING',
        'PAUSING',
        'PAUSED',
        'STOPPING',
        'REVIEW',
      ]))
    )
      return false;
    await execution.stopProfile(profileId);
    return true;
  }
  async command(input: unknown) {
    const request = TaskCommandRequest.parse(input);
    const execution = this.execution();
    if (!execution) throw new ProductError('TASKS_UNAVAILABLE', '任务执行服务未启用', 409);
    if (request.command === 'stop')
      for (const target of request.plans)
        if (target.expectedState === 'RUNNING')
          execution.revokeForControl?.(target.planId, target.profileId, 'USER_STOP');
    const results = await Promise.all(
      request.plans.map(async (target) => {
        let current: Plan | null = null;
        try {
          const plan = await this.repository.get(target.planId);
          if (plan.profileId !== target.profileId) throw Error('任务与浏览器不匹配');
          current = plan;
          // Progress can change while RUNNING. Only a stable paused revision may be resumed;
          // a stale continue button must never resume a newly paused generation of this plan.
          if (
            plan.state !== target.expectedState ||
            (request.command === 'resume' && plan.updatedAt !== target.expectedUpdatedAt)
          )
            throw Error('任务状态已变化，请重新读取后操作');
          if (request.command === 'resume') await this.assertStartAllowed();
          current = await execution.commandPlan(plan.id, request.command);
          return {
            ...target,
            accepted: true,
            state: current.state,
            controlConfirmed: current.controlConfirmed,
            reason: current.reason,
          };
        } catch (error) {
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
      results: results.map(
        ({ expectedState: _state, expectedUpdatedAt: _time, ...result }) => result,
      ),
    });
    if (request.command === 'resume' && parsed.results.some((r) => r.accepted)) {
      this.onTaskLaunched?.();
    }
    return parsed;
  }
  async records(
    input: unknown,
    profiles: readonly import('../domain/task-record-projection.js').RecordProfile[] = [],
  ) {
    return this.repository.recordsPage
      ? await this.repository.recordsPage(input, profiles)
      : await this.recordsLegacy(input, profiles);
  }
  async recordsLegacy(
    input: unknown,
    profiles: readonly {
      id: string;
      online?: boolean | undefined;
      alias?: string | null | undefined;
      browserName?: string | null | undefined;
      account?: { state: string; id?: string | null | undefined } | null | undefined;
    }[] = [],
  ) {
    const request = TaskRecordsRequest.parse(input ?? {});
    const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));
    const plans = (await this.repository.list()).filter(
      (plan) => !request.profileId || plan.profileId === request.profileId,
    );
    const hidden = new Set((await this.repository.hiddenRecordIds?.()) ?? []);
    const allRows: { row: TaskRecord; isCurrentStep: boolean; hasUnresolved: boolean }[] = [];
    for (const plan of plans) {
      const steps = await this.repository.steps(plan.id);
      const operations = await this.repository.operations(plan.id);
      const events = await this.repository.events(plan.id);
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
    const isRunning = ({ row, isCurrentStep }: { row: TaskRecord; isCurrentStep: boolean }) =>
      isCurrentStep &&
      ['QUEUED', 'RUNNING', 'PAUSING', 'PAUSED', 'STOPPING'].includes(row.planState);
    const isCompleted = ({ row }: { row: TaskRecord }) => row.status === 'COMPLETED';
    const isFailed = ({ row }: { row: TaskRecord }) =>
      row.status === 'FAILED' ||
      (row.status === 'ACTIVE' && row.planState === 'FAILED' && row.outcome?.kind !== 'SKIPPED');
    const isReview = ({
      row,
      isCurrentStep,
      hasUnresolved,
    }: {
      row: TaskRecord;
      isCurrentStep: boolean;
      hasUnresolved: boolean;
    }) => {
      const profile = profileMap.get(row.profileId);
      const offlineQueued =
        row.planState === 'QUEUED' && profile !== undefined && profile.online === false;
      return (
        (isCurrentStep &&
          (row.planState === 'REVIEW' ||
            hasUnresolved ||
            offlineQueued ||
            ['PAUSING', 'STOPPING'].includes(row.planState) ||
            (row.planState === 'PAUSED' &&
              row.planReason !== '' &&
              !/^(USER_|MANUAL_)/.test(row.planReason)))) ||
        (row.outcome?.kind === 'FAILED' && row.outcome.businessResult === 'UNKNOWN')
      );
    };
    const counts = {
      all: queryFiltered.length,
      running: queryFiltered.filter(isRunning).length,
      completed: queryFiltered.filter(isCompleted).length,
      failed: queryFiltered.filter(isFailed).length,
      review: queryFiltered.filter(isReview).length,
    };
    if (request.groupBy === 'run') {
      const matching = new Set(queryFiltered.map(({ row }) => `${row.planId}:${row.round}`));
      const groups = groupTaskRecords(allRows.map((x) => x.row)).filter((g) => matching.has(g.key));
      const meta = new Map(allRows.map((x) => [x.row.stepId, x]));
      const matches = (g: (typeof groups)[number], status: typeof request.status) => {
        if (status === 'completed') return g.rows.every((r) => r.status === 'COMPLETED');
        if (status === 'failed')
          return g.rows.some((r) => {
            const item = meta.get(r.stepId);
            return (
              (item && isFailed(item)) ||
              (r.planState === 'FAILED' && plans.find((p) => p.id === r.planId)?.round === r.round)
            );
          });
        if (status === 'running' || status === 'review')
          return g.rows.some((r) => {
            const item = meta.get(r.stepId);
            return !!item && (status === 'running' ? isRunning(item) : isReview(item));
          });
        return true;
      };
      const runCounts = {
        all: groups.length,
        running: groups.filter((g) => matches(g, 'running')).length,
        completed: groups.filter((g) => matches(g, 'completed')).length,
        failed: groups.filter((g) => matches(g, 'failed')).length,
        review: groups.filter((g) => matches(g, 'review')).length,
      };
      const filtered = groups.filter((g) => matches(g, request.status));
      const offset = request.cursor ? Math.max(0, Number.parseInt(request.cursor, 10) || 0) : 0;
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
        counts: runCounts,
        nextCursor: offset + used < filtered.length ? String(offset + used) : null,
      });
    }
    const statusFiltered = queryFiltered
      .filter((item) => {
        if (request.status === 'running') return isRunning(item);
        if (request.status === 'completed') return isCompleted(item);
        if (request.status === 'failed') return isFailed(item);
        if (request.status === 'review') return isReview(item);
        return true;
      })
      .map((item) => item.row);
    const offset = request.cursor ? Math.max(0, Number.parseInt(request.cursor, 10) || 0) : 0;
    const page = statusFiltered.slice(offset, offset + request.limit);
    const nextOffset = offset + page.length;
    return TaskRecords.parse({
      records: page,
      nextCursor: nextOffset < statusFiltered.length ? String(nextOffset) : null,
      total: statusFiltered.length,
      counts,
    });
  }
  async history(input: unknown) {
    const request = TaskHistoryRequest.parse(input);
    const all = (await this.repository.plansForProfile(request.profileId)).sort(
      (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
    );
    const hidden = new Set((await this.repository.hiddenRecordIds?.()) ?? []);
    const visible: typeof all = [];
    for (const plan of all) {
      if (['STOPPED', 'COMPLETED', 'FAILED'].includes(plan.state) && hidden.size) {
        const steps = await this.repository.steps(plan.id, plan.round);
        if (steps.length && steps.every((step) => hidden.has(step.id))) continue;
      }
      visible.push(plan);
    }
    // Explicit forensic lookup is retained only when no visible history remains.
    if (!visible.length && request.planId) {
      const explicit = all.find((p) => p.id === request.planId);
      if (explicit) visible.push(explicit);
    }
    const plans = visible.slice(0, 50);
    const selected = request.planId ? plans.find((plan) => plan.id === request.planId) : plans[0];
    if (request.planId && !selected)
      throw new ProductError(
        'TASK_HISTORY_PLAN_UNAVAILABLE',
        '这份浏览器的任务记录已变化，请重新读取',
        409,
      );
    const operations = selected ? await this.repository.operations(selected.id) : [];
    const events = selected ? await this.repository.events(selected.id) : [];
    const selectedSteps = selected
      ? await this.repository.steps(selected.id, request.round ?? selected.round)
      : [];
    const times = new Map(
      selected
        ? projectTaskRecords(selected, selectedSteps, operations, events).map(({ row }) => [
            row.stepId,
            row,
          ])
        : [],
    );
    // Read the original ledger. Raw input content, bindings and receipts are not UI evidence.
    return TaskHistory.parse({
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
            id: step.id,
            round: step.round,
            position: step.position,
            status: step.status,
            ...(step.outcome ? { outcome: step.outcome } : {}),
            type: step.spec.type,
            ...(step.spec.type === 'post' && step.spec.destination
              ? { destination: step.spec.destination }
              : {}),
            progress: step.progress,
            startedAt: times.get(step.id)?.startedAt ?? null,
            finishedAt: times.get(step.id)?.finishedAt ?? null,
            budget:
              step.spec.type === 'post'
                ? { kind: 'posts', count: step.spec.count }
                : step.spec.type === 'friends'
                  ? {
                      kind: 'friends',
                      mode: step.spec.acceptMode,
                      count: step.spec.acceptMode === 'count' ? step.spec.maxAccepts : null,
                    }
                  : { kind: 'time', milliseconds: step.spec.durationMinutes * 60_000 },
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
        .map((event) => ({
          sequence: event.sequence,
          type: event.type,
          createdAt: event.createdAt,
        })),
      truncated: {
        plans: visible.length > 50,
        operations: operations.length > 100,
        events: events.length > 100,
      },
    });
  }
}
