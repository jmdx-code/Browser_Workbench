import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { taskTimingEligibility } from '../../domain/system-ports.js';
import {
  terminal,
  validateProgress,
  type RuntimeProfile,
  type RuntimeSnapshotResult,
} from '../../domain/tasks.js';
import { ProductError } from '../../domain/workspace.js';
import { CombinationSchema } from '../../shared/contracts.js';
import * as TC from '../../shared/task-contracts.js';
import {
  isMarketplaceUnavailableSkip,
  TaskStepFailure,
  TaskStepSkip,
} from '../../shared/task-step-outcome.js';
import { camel, clampLimit } from '../persistence/sqlite-query-helpers.js';
import { readSnapshot, transaction } from '../sqlite-transaction.js';
import type { SqliteTaskResourceRepository } from '../task-resource-store.js';

export type TaskStoreDependencies = { id(): string; now(): number; random(): number };
type RuntimeAnchor = { seq: number; jobId: string; createdAt: number };
type RuntimeCursorPayload = {
  v: 4;
  epoch: string;
  seq: number;
  anchor: RuntimeAnchor | null;
  first: RuntimeAnchor | null;
};

export interface TaskStoreContext {
  readonly db: DatabaseSync;
  readonly dependencies: TaskStoreDependencies;
  readonly instanceEpoch: string;
  readonly resources: SqliteTaskResourceRepository;
  stmt(sql: string): StatementSync;
  getPlan(id: string): TC.Plan;
  livePlans(): TC.Plan[];
  plansForBatch(batchId: string): TC.Plan[];
  plansForProfile(profileId: string, states?: readonly TC.Plan['state'][]): TC.Plan[];
  currentStepForPlan(id: string, round: number, position: number): TC.StepInstance | null;
  currentStep(plan: TC.Plan, stepId?: string): TC.StepInstance;
  steps(id: string, round?: number): TC.StepInstance[];
  createRound(plan: TC.Plan, round: number): void;
  state(id: string, state: TC.Plan['state'], reason: string): void;
  event(id: string, type: string, detail?: TC.Operation['receipt']): void;
  unlock(id: string): void;
  settings(): TC.Settings;
  invalidateBatchTimingCache(batchId?: string): void;
  hasCloseBrowserColumn(): boolean;
}

const classifyRuntimeEvent = (t: string): TC.RuntimeEvent['category'] =>
  t === 'STOPPED' || t === 'COMPLETED' || t === 'FAILED'
    ? 'PLAN_TERMINAL'
    : t.startsWith('STEP_') || t === 'ROUND_CREATED' || t === 'CHECKPOINT'
      ? 'STEP_EVENT'
      : t.startsWith('OPERATION_') || t.startsWith('CHILD_PAGE_') || t.startsWith('BROWSE_')
        ? 'OPERATION_EVENT'
        : 'PLAN_STATE';

function decodeRuntimeCursor(raw: string): RuntimeCursorPayload | null {
  try {
    const obj = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    > | null;
    if (
      !obj ||
      typeof obj !== 'object' ||
      obj.v !== 4 ||
      typeof obj.epoch !== 'string' ||
      typeof obj.seq !== 'number' ||
      !Number.isInteger(obj.seq) ||
      obj.seq < 0
    )
      return null;
    const chk = (val: unknown): RuntimeAnchor | null | undefined => {
      if (val === null) return null;
      if (!val || typeof val !== 'object') return undefined;
      const a = val as Record<string, unknown>;
      return typeof a.seq === 'number' &&
        Number.isInteger(a.seq) &&
        a.seq > 0 &&
        typeof a.jobId === 'string' &&
        typeof a.createdAt === 'number'
        ? { seq: a.seq, jobId: a.jobId, createdAt: a.createdAt }
        : undefined;
    };
    const anchor = chk(obj.anchor),
      first = chk(obj.first);
    return anchor === undefined || first === undefined
      ? null
      : { v: 4, epoch: obj.epoch, seq: obj.seq, anchor, first };
  } catch {
    return null;
  }
}

const applyStepCheckpoint = (
  ctx: TaskStoreContext,
  id: string,
  step: TC.StepInstance,
  progress: TC.Progress,
) => {
  const next = TC.TaskProgress.parse({ ...progress, revision: step.progress.revision + 1 });
  validateProgress(step.spec, step.progress, next);
  ctx.stmt('UPDATE task_steps SET progress=? WHERE id=?').run(JSON.stringify(next), step.id);
  ctx.event(id, 'CHECKPOINT', { stepId: step.id, revision: next.revision });
};

const activateCurrentStep = (ctx: TaskStoreContext, id: string) => {
  ctx
    .stmt("UPDATE task_steps SET status='ACTIVE' WHERE id=?")
    .run(ctx.currentStep(ctx.getPlan(id)).id);
};

export function buildTaskRuntimeSnapshot(
  ctx: TaskStoreContext,
  options: TC.RuntimeRequest = {},
): RuntimeSnapshotResult {
  return readSnapshot(ctx.db, () => {
    const st = ctx.stmt;
    const high = Number(st('SELECT coalesce(max(sequence),0) AS n FROM task_events').get()?.n ?? 0);
    const anchor = (seq: number): RuntimeAnchor | null => {
      const r = st('SELECT sequence,job_id,created_at FROM task_events WHERE sequence=?').get(seq);
      return r
        ? { seq: Number(r.sequence), jobId: String(r.job_id), createdAt: Number(r.created_at) }
        : null;
    };
    const firstRow = st('SELECT sequence FROM task_events ORDER BY sequence LIMIT 1').get();
    const first = firstRow ? anchor(Number(firstRow.sequence)) : null,
      prev = options.cursor ? decodeRuntimeCursor(options.cursor) : null;
    const resetRequired = Boolean(
      options.cursor &&
      (!prev ||
        prev.epoch !== ctx.instanceEpoch ||
        prev.seq > high ||
        JSON.stringify(prev.first) !== JSON.stringify(first) ||
        JSON.stringify(prev.anchor) !== JSON.stringify(anchor(prev.seq))),
    );
    const after = resetRequired ? 0 : (prev?.seq ?? options.afterSequence ?? 0);
    if (after > high)
      throw new ProductError('RUNTIME_CURSOR_INVALID', '任务游标已失效，请重新读取', 409);
    const evSql =
      'SELECT sequence,job_id,type,created_at FROM task_events WHERE sequence>? ORDER BY sequence LIMIT ?';
    const events: TC.RuntimeEvent[] = [],
      rows = st(evSql).all(after, options.limit ?? 100);
    let bytes = 2,
      scanned = after;
    for (const row of rows) {
      const event = TC.TaskRuntimeEvent.parse({
        ...camel(row),
        detail: null,
        category: classifyRuntimeEvent(String(row.type)),
      });
      const size = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (bytes + size > (options.maxBytes ?? 65536)) {
        if (!events.length)
          throw new ProductError('RUNTIME_EVENT_TOO_LARGE', '事件摘要超过本页预算', 413);
        break;
      }
      events.push(event);
      bytes += size;
      scanned = event.sequence;
    }
    const plans = ctx.livePlans();
    const roundSteps = plans.flatMap((p) => ctx.steps(p.id, p.round));
    const terminalIds = [
      ...new Set(events.filter((e) => e.category === 'PLAN_TERMINAL').map((e) => e.jobId)),
    ];
    const cursorObj = {
      v: 4,
      epoch: ctx.instanceEpoch,
      seq: scanned,
      anchor: anchor(scanned),
      first,
    };
    return {
      settings: ctx.settings(),
      plans,
      currentSteps: plans.flatMap((p) => {
        const s = ctx.currentStepForPlan(p.id, p.round, p.position);
        return s ? [s] : [];
      }),
      roundSteps,
      recentTerminalPlans: terminalIds
        .map((id) => ctx.getPlan(id))
        .filter((p) => terminal(p.state)),
      profileResults: st('SELECT * FROM profile_task_results')
        .all()
        .map((r) => TC.ProfileTaskResult.parse(camel(r))),
      events,
      lastEventSequence: high,
      lastScannedSequence: scanned,
      hasMore: scanned < high,
      resetRequired,
      visibleTerminalFloorSequence: 0,
      epoch: ctx.instanceEpoch,
      cursor: Buffer.from(JSON.stringify(cursorObj), 'utf8').toString('base64url'),
    };
  });
}

export function assignTaskBatch(
  ctx: TaskStoreContext,
  input: TC.Assignment,
  profiles: RuntimeProfile[],
): TC.Plan[] {
  const req = TC.AssignTasks.parse(input);
  req.profileIds = [...new Set(req.profileIds)].sort();
  const serialized = JSON.stringify(req),
    runtime = new Map(profiles.map((p) => [p.id, p]));
  return transaction(ctx.db, () => {
    const prev = ctx.stmt('SELECT request FROM task_batches WHERE id=?').get(req.requestId);
    if (prev) {
      if (prev.request !== serialized)
        throw new ProductError('BATCH_ID_CONFLICT', '提交标识对应的参数不同', 409);
      return ctx.plansForBatch(req.requestId);
    }
    if (req.profileIds.some((id) => !runtime.has(id)))
      throw new ProductError('PROFILE_NOT_FOUND', '分配中包含不存在的资料', 404);
    const verSql = 'SELECT body FROM combination_versions WHERE combination_id=? AND version=?';
    const saved = ctx.stmt(verSql).get(req.combinationId, req.version);
    if (!saved) throw new ProductError('COMBINATION_VERSION_NOT_FOUND', '保存版本不存在', 404);
    const snapshot = CombinationSchema.parse(JSON.parse(String(saved.body)) as unknown),
      resourceRevision = ctx.resources.assertAssignment(req, snapshot);
    if (ctx.livePlans().some((p) => req.profileIds.includes(p.profileId) && !terminal(p.state)))
      throw new ProductError('PROFILE_PLAN_BUSY', '部分资料已有未结束计划，请先停止原计划', 409);
    ctx
      .stmt('INSERT INTO task_batches VALUES(?,?,?)')
      .run(req.requestId, serialized, ctx.dependencies.now());
    ctx.invalidateBatchTimingCache(req.requestId);
    if (req.timing) {
      if (req.timing.mode === 'at' && req.timing.startAt < ctx.dependencies.now())
        throw new ProductError('SCHEDULE_PAST_TIME', '请选择未来的启动时间', 409);
      ctx
        .stmt('INSERT INTO task_batch_timing VALUES(?,?)')
        .run(req.requestId, JSON.stringify(req.timing));
    }
    const hasClose = ctx.hasCloseBrowserColumn();
    const insSql = hasClose
      ? "INSERT INTO task_plans(id,batch_id,profile_id,combination_id,version,account_id,snapshot,state,reason,round,position,created_at,updated_at,close_browser_on_finish) VALUES(?,?,?,?,?,?,?,'QUEUED','',1,0,?,?,?)"
      : "INSERT INTO task_plans(id,batch_id,profile_id,combination_id,version,account_id,snapshot,state,reason,round,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'QUEUED','',1,0,?,?)";
    const ins = ctx.stmt(insSql),
      snapJson = JSON.stringify(snapshot);
    return req.profileIds.map((profileId) => {
      const profile = runtime.get(profileId);
      if (!profile) throw new ProductError('PROFILE_NOT_FOUND', '资料不存在', 404);
      const id = ctx.dependencies.id(),
        now = ctx.dependencies.now(),
        acct = profile.account.state === 'logged-in' ? profile.account.id : null;
      const args = [
        id,
        req.requestId,
        profileId,
        req.combinationId,
        req.version,
        acct,
        snapJson,
        now,
        now,
      ];
      if (hasClose) args.push(req.closeBrowserOnFinish ? 1 : 0);
      ins.run(...args);
      const plan = ctx.getPlan(id);
      if (resourceRevision !== null) ctx.resources.insert(plan, resourceRevision);
      ctx.createRound(plan, 1);
      ctx.event(id, 'ASSIGNED', {
        version: plan.version,
        ...(resourceRevision !== null ? { resourceRevision } : {}),
      });
      return plan;
    });
  });
}

export function claimTaskPlanForProfile(
  ctx: TaskStoreContext,
  profileId: string,
  accountId: string | null,
  releaseScheduledFn: () => void,
): TC.Plan | null {
  releaseScheduledFn();
  return transaction(ctx.db, () => {
    const plan = ctx.plansForProfile(profileId, ['QUEUED'])[0];
    if (!plan) return null;
    const runCnt = Number(
      ctx.stmt("SELECT count(*) AS c FROM task_plans WHERE state='RUNNING'").get()?.c ?? 0,
    );
    if (runCnt >= ctx.settings().maxConcurrentProfiles) return null;
    const timing = taskTimingEligibility(
      plan.timing,
      ctx.dependencies.now(),
      plan.timingReleased === true,
    );
    if (timing !== 'OPEN') {
      const reason = timing === 'MISSED' ? 'SCHEDULE_MISSED' : 'SCHEDULE_WAITING';
      if (timing === 'MISSED') {
        ctx.state(plan.id, 'FAILED', reason);
        ctx.unlock(plan.id);
      } else if (plan.reason !== reason) ctx.state(plan.id, 'QUEUED', reason);
      return null;
    }
    if (plan.accountId && accountId && accountId !== plan.accountId) {
      ctx.state(plan.id, 'STOPPED', 'ACCOUNT_CHANGED');
      ctx.unlock(plan.id);
      return null;
    }
    const resolvedAccountId = accountId ?? plan.accountId ?? null;
    if (resolvedAccountId) {
      const lockSql = 'SELECT job_id FROM task_account_locks WHERE account_id=?';
      const existingLock = ctx.stmt(lockSql).get(resolvedAccountId);
      if (existingLock && String(existingLock.job_id) !== plan.id) {
        if (plan.reason !== 'ACCOUNT_BUSY') ctx.state(plan.id, 'QUEUED', 'ACCOUNT_BUSY');
        return null;
      }
      ctx
        .stmt('INSERT OR IGNORE INTO task_account_locks VALUES(?,?)')
        .run(resolvedAccountId, plan.id);
    }
    const updSql =
      'UPDATE task_plans SET account_id=?,control_mode=NULL,control_request_id=NULL,control_confirmed=0 WHERE id=?';
    ctx.stmt(updSql).run(resolvedAccountId, plan.id);
    const step = ctx.currentStep(plan);
    if (step.status === 'PENDING')
      ctx.stmt("UPDATE task_steps SET status='ACTIVE' WHERE id=?").run(step.id);
    ctx.state(plan.id, 'RUNNING', '');
    return ctx.getPlan(plan.id);
  });
}

export function bindTaskPlanAccount(ctx: TaskStoreContext, id: string, accountId: string): TC.Plan {
  return transaction(ctx.db, () => {
    const plan = ctx.getPlan(id);
    if (terminal(plan.state)) return plan;
    if (plan.accountId && plan.accountId !== accountId) {
      ctx.state(id, 'STOPPED', 'ACCOUNT_CHANGED');
      ctx.unlock(id);
      return ctx.getPlan(id);
    }
    const existingLock = ctx
      .stmt('SELECT job_id FROM task_account_locks WHERE account_id=?')
      .get(accountId);
    if (existingLock && String(existingLock.job_id) !== id)
      throw new ProductError('ACCOUNT_BUSY', '账号已在其他浏览器执行任务', 409);
    ctx.stmt('INSERT OR IGNORE INTO task_account_locks VALUES(?,?)').run(accountId, id);
    ctx
      .stmt('UPDATE task_plans SET account_id=?,updated_at=? WHERE id=?')
      .run(accountId, ctx.dependencies.now(), id);
    return ctx.getPlan(id);
  });
}

function advanceStepPosition(ctx: TaskStoreContext, plan: TC.Plan): void {
  const id = plan.id;
  if (plan.position + 1 < plan.snapshot.steps.length) {
    ctx
      .stmt('UPDATE task_plans SET position=position+1,updated_at=? WHERE id=?')
      .run(ctx.dependencies.now(), id);
    activateCurrentStep(ctx, id);
  } else if (plan.snapshot.loop.mode === 'finite' && plan.round >= plan.snapshot.loop.rounds) {
    const failed = ctx
      .steps(id)
      .some(
        (s) =>
          s.status === 'FAILED' ||
          (s.status === 'SKIPPED' &&
            !isMarketplaceUnavailableSkip(s.spec.type, s.status, s.outcome)),
      );
    ctx.state(id, failed ? 'FAILED' : 'COMPLETED', failed ? 'PARTIAL_STEP_FAILURE' : '');
    ctx.unlock(id);
  } else {
    ctx.createRound(plan, plan.round + 1);
    ctx
      .stmt('UPDATE task_plans SET round=round+1,position=0,updated_at=? WHERE id=?')
      .run(ctx.dependencies.now(), id);
    activateCurrentStep(ctx, id);
  }
}

export function updateTaskStepProgress(
  ctx: TaskStoreContext,
  id: string,
  stepId: string,
  progress: TC.Progress,
): void {
  transaction(ctx.db, () => {
    const plan = ctx.getPlan(id);
    if (plan.state !== 'RUNNING') return;
    const step = ctx.currentStep(plan, stepId);
    if (!['COMPLETED', 'FAILED', 'SKIPPED'].includes(step.status))
      applyStepCheckpoint(ctx, id, step, progress);
  });
}

function transitionTaskStepDirect(
  ctx: TaskStoreContext,
  id: string,
  stepId: string,
  apply: (step: TC.StepInstance) => void,
): TC.Plan {
  return transaction(ctx.db, () => {
    const plan = ctx.getPlan(id);
    if (terminal(plan.state)) return plan;
    const step = ctx.currentStep(plan, stepId);
    if (['COMPLETED', 'FAILED', 'SKIPPED'].includes(step.status)) return plan;
    apply(step);
    advanceStepPosition(ctx, ctx.getPlan(id));
    return ctx.getPlan(id);
  });
}

export const completeTaskStepDirect = (
  ctx: TaskStoreContext,
  id: string,
  stepId: string,
  finalProgress?: TC.Progress,
): TC.Plan =>
  transitionTaskStepDirect(ctx, id, stepId, (step) => {
    if (finalProgress) applyStepCheckpoint(ctx, id, step, finalProgress);
    ctx.stmt("UPDATE task_steps SET status='COMPLETED' WHERE id=?").run(stepId);
    ctx.event(id, 'STEP_COMPLETED', { stepId });
  });

function recordStepFailure(
  ctx: TaskStoreContext,
  id: string,
  stepId: string,
  reason: string,
  businessResult: 'NOT_APPLICABLE' | 'PUBLISHED' | 'NOT_PUBLISHED' | 'UNKNOWN',
) {
  const submissionPhase =
    businessResult === 'NOT_APPLICABLE'
      ? 'NOT_APPLICABLE'
      : businessResult === 'NOT_PUBLISHED'
        ? 'BEFORE_SUBMIT'
        : businessResult === 'PUBLISHED'
          ? 'RESULT_CONFIRMED'
          : 'UNKNOWN';
  const outcome = TaskStepFailure.parse({
    version: 1,
    kind: 'FAILED',
    reason: (reason || 'STEP_FAILED').slice(0, 200),
    endedAt: ctx.dependencies.now(),
    submissionPhase,
    businessResult,
  });
  ctx
    .stmt("UPDATE task_steps SET status='FAILED',outcome=? WHERE id=?")
    .run(JSON.stringify(outcome), stepId);
  ctx.event(id, 'STEP_FAILED', { stepId, outcome });
}

export const skipTaskStepDirect = (
  ctx: TaskStoreContext,
  id: string,
  stepId: string,
  reason:
    'DEPENDENCY_FAILED' | 'RESOURCE_EXHAUSTED' | 'FEATURE_UNAVAILABLE' | 'MARKETPLACE_UNAVAILABLE',
  dependencyStepId?: string,
): TC.Plan =>
  transitionTaskStepDirect(ctx, id, stepId, () => {
    const outcome = TaskStepSkip.parse({
      version: 1,
      kind: 'SKIPPED',
      reason,
      endedAt: ctx.dependencies.now(),
      ...(dependencyStepId ? { dependencyStepId } : {}),
    });
    ctx
      .stmt("UPDATE task_steps SET status='SKIPPED',outcome=? WHERE id=?")
      .run(JSON.stringify(outcome), stepId);
    ctx.event(id, 'STEP_SKIPPED', { stepId, outcome });
  });

export const failTaskStepDirect = (
  ctx: TaskStoreContext,
  id: string,
  stepId: string,
  reason: string,
  businessResult: 'NOT_APPLICABLE' | 'PUBLISHED' | 'NOT_PUBLISHED' | 'UNKNOWN' = 'NOT_APPLICABLE',
): TC.Plan =>
  transitionTaskStepDirect(ctx, id, stepId, () =>
    recordStepFailure(ctx, id, stepId, reason, businessResult),
  );

export function stopTaskPlanDirect(
  ctx: TaskStoreContext,
  id: string,
  reason = 'USER_STOP',
): TC.Plan {
  const sql =
    "UPDATE task_plans SET control_mode='stop',control_request_id=NULL,control_confirmed=1 WHERE id=?";
  return transaction(ctx.db, () => {
    const plan = ctx.getPlan(id);
    if (terminal(plan.state)) return plan;
    ctx.stmt(sql).run(id);
    ctx.state(id, 'STOPPED', (reason || 'USER_STOP').slice(0, 200));
    ctx.unlock(id);
    return ctx.getPlan(id);
  });
}

export function failTaskPlanDirect(ctx: TaskStoreContext, id: string, reason: string): TC.Plan {
  const sql =
    'UPDATE task_plans SET control_mode=NULL,control_request_id=NULL,control_confirmed=0 WHERE id=?';
  return transaction(ctx.db, () => {
    const plan = ctx.getPlan(id);
    if (terminal(plan.state)) return plan;
    const bounded = (reason || 'TASK_FAILED').slice(0, 200),
      step = ctx.currentStepForPlan(id, plan.round, plan.position);
    if (step && (step.status === 'ACTIVE' || step.status === 'PENDING'))
      recordStepFailure(ctx, id, step.id, bounded, 'NOT_APPLICABLE');
    ctx.stmt(sql).run(id);
    ctx.state(id, 'FAILED', bounded);
    ctx.unlock(id);
    return ctx.getPlan(id);
  });
}

export function readTaskOperation(ctx: TaskStoreContext, id: string): TC.Operation {
  const sql =
    'SELECT o.id,o.job_id,o.step_id,o.action,b.body AS binding,o.status,o.receipt,o.checkpoint_applied,o.disposition,o.created_at,o.updated_at FROM task_outbox o LEFT JOIN task_dispatch_bindings b ON b.operation_id=o.id WHERE o.id=?';
  const row = ctx.stmt(sql).get(id);
  if (!row) throw new ProductError('OPERATION_NOT_FOUND', '任务指令不存在', 404);
  return TC.TaskOperation.parse(
    camel(row, 'checkpoint_applied', 'action,binding,receipt,disposition', 'disposition'),
  );
}

export const listTaskOperationsBySql = (
  ctx: TaskStoreContext,
  sql: string,
  ...params: Array<string | number>
): TC.Operation[] =>
  ctx
    .stmt(sql)
    .all(...params)
    .map((row) => readTaskOperation(ctx, String(row.id)));

export function findTaskOperation(
  ctx: TaskStoreContext,
  jobId: string,
  operationId: string,
): TC.Operation | null {
  const row = ctx
    .stmt('SELECT id FROM task_outbox WHERE id=? AND job_id=?')
    .get(operationId, jobId);
  return row ? readTaskOperation(ctx, String(row.id)) : null;
}

export const listRecentTaskOperations = (
  ctx: TaskStoreContext,
  id: string,
  limit: number,
): TC.Operation[] =>
  listTaskOperationsBySql(
    ctx,
    'SELECT id FROM task_outbox WHERE job_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?',
    id,
    clampLimit(limit, 1, 100),
  ).reverse();
