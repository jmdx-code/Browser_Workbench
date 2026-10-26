import type { SynchronousRepository } from '../domain/persistence.js';
import { TaskRecordReader } from './task-record-reader.js';
import { CheckpointCommitQueue } from './checkpoint-commit-queue.js';
import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Action, canonicalAction, isWrite } from '../shared/browser-actions.js';
import {
  BrowsePendingDiagnostic,
  BrowseOperationIntent,
  type PendingDiagnostic,
} from '../shared/browse-execution.js';
import { validateBrowseIntent } from '../domain/browse-policy.js';
import { FACEBOOK_REEL_NEXT_CSS } from '../shared/facebook-browse-route.js';
import { OwnedTabProof } from '../shared/kernel-state.js';
import { TaskChildPageLifecycle } from '../shared/task-child-page.js';
import { sameTabProof } from '../domain/task-tabs.js';
import {
  BoundReceipt,
  DispatchBinding,
  ExecutionContext,
  sameBinding,
  sameExecution,
  type Binding,
  type ExecutionReceipt,
  type ExecutionSession,
} from '../shared/task-execution.js';
import { CombinationSchema, type Step } from '../shared/contracts.js';
import { TaskStepV2 } from '../shared/task-step-instance.js';
import {
  AssignTasks,
  ProfileTaskResult,
  SchedulerSettings,
  TaskEvent,
  TaskOperation,
  TaskPlan,
  TaskProgress,
  TaskRuntimeEvent,
  type Assignment,
  type Operation,
  type Plan,
  type Progress,
  type RuntimeEvent,
  type RuntimeRequest,
  type Settings,
  type StepInstance,
} from '../shared/task-contracts.js';
import { TaskStepFailure, TaskStepSkip } from '../shared/task-step-outcome.js';
import {
  emptyProgress,
  orderedSteps,
  stepComplete,
  terminal,
  validateProgress,
  type RuntimeProfile,
  type RuntimeSnapshotResult,
  TaskRepository as CompatibleTaskRepository,
} from '../domain/tasks.js';
import { ProductError } from '../domain/workspace.js';
import { needsResourceTable } from '../domain/task-resources.js';
import { SqliteTaskResourceRepository } from './task-resource-store.js';
import { readSnapshot, transaction } from './sqlite-transaction.js';
import { TaskTiming } from '../shared/task-timing.js';
import { taskTimingEligibility } from '../domain/task-timing.js';
import { cancelNeverDispatchedPost } from './material-post-cancellation.js';
import { endPostWithoutSubmit } from './material-post-cancellation.js';
import {
  CurrentStopReceipt,
  OperationDisposition,
  type CurrentStop,
} from '../shared/task-ending.js';
import { SqliteSettlementRepository } from './settlement-store.js';
import {
  assertPostPreparation,
  assertPostDispatch,
  assertPostSettlement,
  postLink,
} from './material-post-guards.js';
import { isErroredPausedPlan } from '../shared/task-issues.js';

type Dependencies = { id(): string; now(): number; random(): number };
type RuntimeAnchor = { seq: number; jobId: string; createdAt: number };
type RuntimeCursorPayload = {
  v: 4;
  epoch: string;
  seq: number;
  anchor: RuntimeAnchor | null;
  first: RuntimeAnchor | null;
};
function classifyRuntimeEvent(type: string): RuntimeEvent['category'] {
  if (type === 'STOPPED' || type === 'COMPLETED' || type === 'FAILED') return 'PLAN_TERMINAL';
  if (type.startsWith('STEP_') || type === 'ROUND_CREATED' || type === 'CHECKPOINT')
    return 'STEP_EVENT';
  if (type.startsWith('OPERATION_') || type.startsWith('CHILD_PAGE_') || type.startsWith('BROWSE_'))
    return 'OPERATION_EVENT';
  return 'PLAN_STATE';
}
function encodeRuntimeCursor(payload: RuntimeCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
function decodeRuntimeCursor(raw: string): RuntimeCursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (
      obj.v !== 4 ||
      typeof obj.epoch !== 'string' ||
      typeof obj.seq !== 'number' ||
      !Number.isInteger(obj.seq) ||
      obj.seq < 0
    )
      return null;
    const checkAnchor = (val: unknown): RuntimeAnchor | null | undefined => {
      if (val === null) return null;
      if (typeof val !== 'object' || val === null) return undefined;
      const a = val as Record<string, unknown>;
      if (
        typeof a.seq === 'number' &&
        Number.isInteger(a.seq) &&
        a.seq > 0 &&
        typeof a.jobId === 'string' &&
        typeof a.createdAt === 'number'
      )
        return { seq: a.seq, jobId: a.jobId, createdAt: a.createdAt };
      return undefined;
    };
    const anchor = checkAnchor(obj.anchor);
    const first = checkAnchor(obj.first);
    if (anchor === undefined || first === undefined) return null;
    return { v: 4, epoch: obj.epoch, seq: obj.seq, anchor, first };
  } catch {
    return null;
  }
}
const CancelledBrowseReceipt = z
  .object({ binding: DispatchBinding, reason: z.literal('USER_STOP') })
  .strict();
export class SqliteTaskRepository implements TaskRepository {
  readonly recordReader: TaskRecordReader;
  hiddenRecordIds() {
    return this.db
      .prepare("SELECT name FROM sqlite_master WHERE name='task_record_deletions'")
      .get()
      ? this.db
          .prepare('SELECT step_id FROM task_record_deletions')
          .all()
          .map((r) => String(r.step_id))
      : [];
  }
  recordsPage(
    input: unknown,
    profiles: readonly import('../domain/task-record-projection.js').RecordProfile[],
  ) {
    return this.recordReader.page(input, profiles);
  }
  readonly settlements: SqliteSettlementRepository;
  readonly resources: SqliteTaskResourceRepository;
  private readonly instanceEpoch = randomUUID().slice(0, 8);
  private readonly checkpointQueue: CheckpointCommitQueue;
  constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: Dependencies = {
      id: randomUUID,
      now: Date.now,
      random: Math.random,
    },
  ) {
    this.checkpointQueue = new CheckpointCommitQueue(db);
    this.settlements = new SqliteSettlementRepository(db, dependencies);
    this.resources = new SqliteTaskResourceRepository(db);
    this.recordReader = new TaskRecordReader(
      db,
      (id) => this.get(id),
      (id, round) => this.steps(id, round),
      () => this.cacheStateToken(),
    );
  }
  private event(id: string, type: string, detail: Operation['receipt'] = null) {
    this.db
      .prepare('INSERT INTO task_events(job_id,type,detail,created_at) VALUES(?,?,?,?)')
      .run(id, type, JSON.stringify(detail), this.dependencies.now());
  }
  noteQueuedWait(id: string, reason: string) {
    const plan = this.get(id);
    if (plan.state === 'QUEUED' && plan.reason !== reason)
      transaction(this.db, () => this.state(id, 'QUEUED', reason.slice(0, 200)));
  }
  noteRunningWait(id: string, reason: string) {
    const bounded = reason.slice(0, 200);
    transaction(this.db, () => {
      const plan = this.get(id);
      if (plan.state === 'RUNNING' && plan.reason !== bounded) this.state(id, 'RUNNING', bounded);
    });
  }
  retainedTaskPage(profileId: string) {
    const row = this.db
      .prepare(
        "SELECT o.proof FROM task_tab_ownership o JOIN task_tab_state s USING(ownership_id,job_id) WHERE s.profile_id=? AND s.state='RELEASED' AND s.release_receipt IS NOT NULL ORDER BY o.created_at DESC,o.job_id DESC LIMIT 1",
      )
      .get(profileId);
    return row ? OwnedTabProof.parse(JSON.parse(String(row.proof))) : null;
  }
  private state(id: string, state: Plan['state'], reason: string) {
    this.db
      .prepare('UPDATE task_plans SET state=?,reason=?,updated_at=? WHERE id=?')
      .run(state, reason, this.dependencies.now(), id);
    this.event(id, state, { reason });
  }
  private unlock(id: string) {
    this.db.prepare('DELETE FROM task_account_locks WHERE job_id=?').run(id);
  }
  private readonly planRowCache = new Map<string, { key: string; plan: Plan }>();
  private parsePlanRow(row: Record<string, unknown>): Plan {
    const id = String(row.id);
    const batchId = String(row.batch_id);
    const timing = this.db
      .prepare('SELECT body FROM task_batch_timing WHERE batch_id=?')
      .get(batchId);
    const timingReleased = timing
      ? !!this.db
          .prepare(
            "SELECT e.sequence FROM task_events e JOIN task_plans p ON p.id=e.job_id WHERE p.batch_id=? AND e.type='SCHEDULE_RELEASED' LIMIT 1",
          )
          .get(batchId)
      : false;
    const cacheKey = `${String(row.state)}:${String(row.updated_at)}:${String(row.reason)}:${String(row.control_mode)}:${String(row.control_request_id ?? '')}:${String(row.control_confirmed)}:${String(row.round)}:${String(row.position)}:${timing ? String(timing.body) : ''}:${String(timingReleased)}`;
    const cached = this.planRowCache.get(id);
    if (cached?.key === cacheKey) {
      this.planRowCache.delete(id);
      this.planRowCache.set(id, cached);
      return cached.plan;
    }
    const plan = TaskPlan.parse({
      id: row.id,
      batchId: row.batch_id,
      profileId: row.profile_id,
      combinationId: row.combination_id,
      version: row.version,
      accountId: row.account_id,
      snapshot: JSON.parse(String(row.snapshot)) as unknown,
      state: row.state,
      reason: row.reason,
      controlMode: row.control_mode,
      controlRequestId: row.control_request_id,
      controlConfirmed: row.control_confirmed === 1,
      round: row.round,
      position: row.position,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(timing
        ? {
            timing: TaskTiming.parse(JSON.parse(String(timing.body))),
            timingReleased,
          }
        : {}),
    });
    this.planRowCache.set(id, { key: cacheKey, plan });
    if (this.planRowCache.size > 1024) {
      const oldest = this.planRowCache.keys().next().value;
      if (oldest !== undefined) this.planRowCache.delete(oldest);
    }
    return plan;
  }
  get(id: string): Plan {
    const row = this.db.prepare('SELECT * FROM task_plans WHERE id=?').get(id);
    if (!row) throw new ProductError('TASK_NOT_FOUND', '任务计划不存在', 404);
    return this.parsePlanRow(row);
  }
  batchExists(batchId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 FROM task_batches WHERE id=? UNION ALL SELECT 1 FROM task_plans WHERE batch_id=? LIMIT 1',
        )
        .get(batchId, batchId),
    );
  }
  plansForBatch(batchId: string): Plan[] {
    return this.db
      .prepare('SELECT * FROM task_plans WHERE batch_id=? ORDER BY created_at,rowid')
      .all(batchId)
      .map((row) => this.parsePlanRow(row));
  }
  plansForProfile(profileId: string, states?: readonly Plan['state'][]): Plan[] {
    if (states !== undefined) {
      if (states.length === 0) return [];
      const placeholders = states.map(() => '?').join(',');
      return this.db
        .prepare(
          `SELECT * FROM task_plans WHERE profile_id=? AND state IN (${placeholders}) ORDER BY created_at,rowid`,
        )
        .all(profileId, ...states)
        .map((row) => this.parsePlanRow(row));
    }
    return this.db
      .prepare('SELECT * FROM task_plans WHERE profile_id=? ORDER BY created_at,rowid')
      .all(profileId)
      .map((row) => this.parsePlanRow(row));
  }
  hasProfilePlanInStates(profileId: string, states: readonly Plan['state'][]): boolean {
    if (states.length === 0) return false;
    const placeholders = states.map(() => '?').join(',');
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM task_plans WHERE profile_id=? AND state IN (${placeholders}) LIMIT 1`,
        )
        .get(profileId, ...states),
    );
  }
  hasPlanOrOperation(jobId: string, operationId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 FROM task_plans WHERE id=? UNION ALL SELECT 1 FROM task_outbox o JOIN task_plans p ON p.id=o.job_id WHERE o.id=? LIMIT 1',
        )
        .get(jobId, operationId),
    );
  }
  list() {
    return this.db
      .prepare('SELECT * FROM task_plans ORDER BY created_at,rowid')
      .all()
      .map((row) => this.parsePlanRow(row));
  }
  releaseScheduled() {
    transaction(this.db, () => {
      for (const plan of this.livePlans().filter(
        (row) => row.state === 'QUEUED' && row.timing && !row.timingReleased,
      )) {
        // The activation marker is an append-only original task event. After release,
        // concurrency/offline queueing does not turn the other 49 plans into missed jobs.
        const current = this.get(plan.id);
        if (current.timingReleased) continue;
        const eligibility = taskTimingEligibility(current.timing, this.dependencies.now());
        if (eligibility === 'OPEN') this.event(current.id, 'SCHEDULE_RELEASED');
        else if (eligibility === 'MISSED') this.state(current.id, 'FAILED', 'SCHEDULE_MISSED');
      }
    });
  }
  livePlans() {
    return this.db
      .prepare(
        "SELECT * FROM task_plans WHERE state NOT IN ('STOPPED','COMPLETED','FAILED') ORDER BY created_at,rowid",
      )
      .all()
      .map((row) => this.parsePlanRow(row));
  }
  cacheStateToken(): string | null {
    if (this.db.isTransaction) return null;
    return `${this.instanceEpoch}:${String(this.db.prepare('PRAGMA data_version').get()?.data_version)}:${String(this.db.prepare('SELECT total_changes() AS n').get()?.n)}`;
  }
  currentStepForPlan(id: string, round: number, position: number): StepInstance | null {
    const row = this.db
      .prepare('SELECT * FROM task_steps WHERE job_id=? AND round=? AND position=?')
      .get(id, round, position);
    return row
      ? TaskStepV2.parse({
          id: row.id,
          jobId: row.job_id,
          round: row.round,
          position: row.position,
          spec: JSON.parse(String(row.spec)),
          status: row.status,
          progress: JSON.parse(String(row.progress)),
          ...(row.outcome ? { outcome: JSON.parse(String(row.outcome)) } : {}),
        })
      : null;
  }
  runtimeSnapshot(options: RuntimeRequest = {}): RuntimeSnapshotResult {
    return readSnapshot(this.db, () => {
      const high = Number(
        this.db.prepare('SELECT coalesce(max(sequence),0) AS n FROM task_events').get()?.n ?? 0,
      );
      const anchor = (seq: number): RuntimeAnchor | null => {
        const row = this.db
          .prepare('SELECT sequence,job_id,created_at FROM task_events WHERE sequence=?')
          .get(seq);
        return row
          ? {
              seq: Number(row.sequence),
              jobId: String(row.job_id),
              createdAt: Number(row.created_at),
            }
          : null;
      };
      const firstRow = this.db
        .prepare('SELECT sequence FROM task_events ORDER BY sequence LIMIT 1')
        .get();
      const first = firstRow ? anchor(Number(firstRow.sequence)) : null;
      const previous = options.cursor ? decodeRuntimeCursor(options.cursor) : null;
      const resetRequired = Boolean(
        options.cursor &&
        (!previous ||
          previous.epoch !== this.instanceEpoch ||
          previous.seq > high ||
          JSON.stringify(previous.first) !== JSON.stringify(first) ||
          JSON.stringify(previous.anchor) !== JSON.stringify(anchor(previous.seq))),
      );
      // A new reader replays from zero, including terminal events; the UI drains bounded pages.
      const after = resetRequired ? 0 : (previous?.seq ?? options.afterSequence ?? 0);
      if (after > high)
        throw new ProductError('RUNTIME_CURSOR_INVALID', '任务游标已失效，请重新读取', 409);
      const rows = this.db
        .prepare(
          'SELECT sequence,job_id,type,created_at FROM task_events WHERE sequence>? ORDER BY sequence LIMIT ?',
        )
        .all(after, options.limit ?? 100);
      const events: RuntimeEvent[] = [];
      let bytes = 2,
        scanned = after;
      for (const row of rows) {
        // UI replay carries identities/categories, never large receipts or arbitrary event detail.
        const event = TaskRuntimeEvent.parse({
          sequence: row.sequence,
          jobId: row.job_id,
          type: row.type,
          detail: null,
          createdAt: row.created_at,
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
      const plans = this.livePlans();
      const terminalIds = [
        ...new Set(events.filter((e) => e.category === 'PLAN_TERMINAL').map((e) => e.jobId)),
      ];
      const recentTerminalPlans = terminalIds
        .map((id) => this.get(id))
        .filter((plan) => terminal(plan.state));
      return {
        settings: this.settings(),
        plans,
        currentSteps: plans.flatMap((plan) => {
          const step = this.currentStepForPlan(plan.id, plan.round, plan.position);
          return step ? [step] : [];
        }),
        recentTerminalPlans,
        profileResults: this.db
          .prepare(
            `SELECT profile_id AS profileId,source,run_id AS runId,
          name,state,reason,finished_at AS finishedAt,failed_steps AS failedSteps,skipped_steps AS skippedSteps FROM profile_task_results`,
          )
          .all()
          .map((row) => ProfileTaskResult.parse(row)),
        events,
        lastEventSequence: high,
        lastScannedSequence: scanned,
        hasMore: scanned < high,
        resetRequired,
        visibleTerminalFloorSequence: 0,
        epoch: this.instanceEpoch,
        cursor: encodeRuntimeCursor({
          v: 4,
          epoch: this.instanceEpoch,
          seq: scanned,
          anchor: anchor(scanned),
          first,
        }),
      };
    });
  }
  releaseErroredPausedPlans(profileIds: readonly string[]): number {
    const targetIds = new Set(profileIds);
    if (!targetIds.size) return 0;
    return transaction(this.db, () => {
      let released = 0;
      for (const plan of this.livePlans()) {
        if (!targetIds.has(plan.profileId)) continue;
        if (isErroredPausedPlan(plan) && !this.unresolved(plan.id)) {
          this.state(plan.id, 'STOPPED', plan.reason);
          this.unlock(plan.id);
          released += 1;
        }
      }
      return released;
    });
  }
  settings() {
    const row = this.db
      .prepare('SELECT max_concurrent_profiles FROM scheduler_settings WHERE id=1')
      .get();
    return SchedulerSettings.parse({ maxConcurrentProfiles: row?.max_concurrent_profiles });
  }
  setSettings(value: Settings) {
    const parsed = SchedulerSettings.parse(value);
    this.db
      .prepare('UPDATE scheduler_settings SET max_concurrent_profiles=? WHERE id=1')
      .run(parsed.maxConcurrentProfiles);
  }
  events(id: string) {
    this.get(id);
    return this.db
      .prepare('SELECT * FROM task_events WHERE job_id=? ORDER BY sequence')
      .all(id)
      .map((row) =>
        TaskEvent.parse({
          sequence: row.sequence,
          jobId: row.job_id,
          type: row.type,
          detail: JSON.parse(String(row.detail)) as unknown,
          createdAt: row.created_at,
        }),
      );
  }
  steps(id: string, round?: number) {
    this.get(id);
    const rows =
      round === undefined
        ? this.db.prepare('SELECT * FROM task_steps WHERE job_id=? ORDER BY round,position').all(id)
        : this.db
            .prepare('SELECT * FROM task_steps WHERE job_id=? AND round=? ORDER BY position')
            .all(id, round);
    return rows.map((row) =>
      TaskStepV2.parse({
        id: row.id,
        jobId: row.job_id,
        round: row.round,
        position: row.position,
        spec: JSON.parse(String(row.spec)) as unknown,
        status: row.status,
        progress: JSON.parse(String(row.progress)) as unknown,
        ...(row.outcome ? { outcome: JSON.parse(String(row.outcome)) as unknown } : {}),
      }),
    );
  }
  private currentStep(plan: Plan, stepId?: string) {
    const step = this.steps(plan.id, plan.round).find((item) => item.position === plan.position);
    if (!step || (stepId && step.id !== stepId))
      throw new ProductError('STALE_STEP', '子任务已变化', 409);
    return step;
  }
  private createRound(plan: Plan, round: number) {
    const order = orderedSteps(
      plan.snapshot.steps,
      plan.snapshot.randomOrder,
      this.dependencies.random,
    );
    for (const [position, spec] of order.entries())
      this.db
        .prepare(
          'INSERT INTO task_steps(id,job_id,round,position,spec,status,progress) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          this.dependencies.id(),
          plan.id,
          round,
          position,
          JSON.stringify(spec),
          'PENDING',
          JSON.stringify(emptyProgress()),
        );
    this.event(plan.id, 'ROUND_CREATED', { round, stepIds: order.map((step) => step.id) });
  }
  assign(input: Assignment, profiles: RuntimeProfile[]) {
    const request = AssignTasks.parse(input);
    request.profileIds = [...new Set(request.profileIds)].sort();
    const serialized = JSON.stringify(request);
    const runtime = new Map(profiles.map((profile) => [profile.id, profile]));
    return transaction(this.db, () => {
      const previous = this.db
        .prepare('SELECT request FROM task_batches WHERE id=?')
        .get(request.requestId);
      if (previous) {
        if (previous.request !== serialized)
          throw new ProductError('BATCH_ID_CONFLICT', '提交标识对应的参数不同', 409);
        return this.plansForBatch(request.requestId);
      }
      if (request.profileIds.some((id) => !runtime.has(id)))
        throw new ProductError('PROFILE_NOT_FOUND', '分配中包含不存在的资料', 404);
      const saved = this.db
        .prepare('SELECT body FROM combination_versions WHERE combination_id=? AND version=?')
        .get(request.combinationId, request.version);
      if (!saved) throw new ProductError('COMBINATION_VERSION_NOT_FOUND', '保存版本不存在', 404);
      const snapshot = CombinationSchema.parse(JSON.parse(String(saved.body)) as unknown);
      const resourceRevision = this.resources.assertAssignment(request, snapshot);
      if (
        this.livePlans().some(
          (plan) => request.profileIds.includes(plan.profileId) && !terminal(plan.state),
        )
      )
        throw new ProductError('PROFILE_PLAN_BUSY', '部分资料已有未结束计划，请先停止原计划', 409);
      this.db
        .prepare('INSERT INTO task_batches VALUES(?,?,?)')
        .run(request.requestId, serialized, this.dependencies.now());
      if (request.timing) {
        if (request.timing.mode === 'at' && request.timing.startAt < this.dependencies.now())
          throw new ProductError('SCHEDULE_PAST_TIME', '请选择未来的启动时间', 409);
        this.db
          .prepare('INSERT INTO task_batch_timing VALUES(?,?)')
          .run(request.requestId, JSON.stringify(request.timing));
      }
      return request.profileIds.map((profileId) => {
        const profile = runtime.get(profileId);
        if (!profile) throw new ProductError('PROFILE_NOT_FOUND', '资料不存在', 404);
        const accountId = profile.account.state === 'logged-in' ? profile.account.id : null;
        const id = this.dependencies.id(),
          now = this.dependencies.now();
        this.db
          .prepare(
            "INSERT INTO task_plans(id,batch_id,profile_id,combination_id,version,account_id,snapshot,state,reason,round,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'QUEUED','',1,0,?,?)",
          )
          .run(
            id,
            request.requestId,
            profileId,
            request.combinationId,
            request.version,
            accountId,
            JSON.stringify(snapshot),
            now,
            now,
          );
        const plan = this.get(id);
        if (resourceRevision !== null) this.resources.insert(plan, resourceRevision);
        this.createRound(plan, 1);
        this.event(id, 'ASSIGNED', {
          version: plan.version,
          ...(resourceRevision !== null ? { resourceRevision } : {}),
        });
        return plan;
      });
    });
  }
  private waitingReason(
    plan: Plan,
    profile: RuntimeProfile | undefined,
    supported: ReadonlySet<Step['type']>,
    sourceCapabilities?: { resourceTables: boolean },
  ) {
    if (!profile?.online) return 'OFFLINE';
    if (!profile.synced || profile.unresolved) return 'RECONCILIATION_REQUIRED';
    if (profile.account.state !== 'logged-in' || !profile.account.id) return 'IDENTITY_REQUIRED';
    if (needsResourceTable(plan.snapshot)) {
      if (!this.resources.binding(plan.id)) return 'RESOURCE_BINDING_REQUIRED';
      if (!sourceCapabilities?.resourceTables) return 'RESOURCE_TABLE_EXECUTOR_REQUIRED';
    }
    if (!plan.snapshot.steps.every((step) => supported.has(step.type))) return 'EXECUTOR_REQUIRED';
    if (!profile.dispatchAllowed) return 'CHANNEL_NOT_READY';
    return '';
  }
  claimNext(
    profiles: RuntimeProfile[],
    supported: ReadonlySet<Step['type']>,
    sourceCapabilities?: { resourceTables: boolean; profileId?: string },
  ) {
    this.releaseScheduled();
    return transaction(this.db, () => {
      const runtime = new Map(profiles.map((profile) => [profile.id, profile]));
      const active = Number(
        this.db
          .prepare(
            "SELECT count(*) AS count FROM task_plans WHERE state IN ('RUNNING','PAUSING','STOPPING') OR (state='REVIEW' AND control_confirmed=0)",
          )
          .get()?.count,
      );
      for (const plan of this.livePlans().filter((row) => row.state === 'QUEUED')) {
        // A per-profile runner may claim only its own plan. Keep the full runtime inventory
        // for account/transport checks without changing other queued profiles' reasons.
        if (sourceCapabilities?.profileId && plan.profileId !== sourceCapabilities.profileId)
          continue;
        const timing = taskTimingEligibility(
          plan.timing,
          this.dependencies.now(),
          plan.timingReleased === true,
          // Queued members of an already released batch keep their original queue position.
        );
        if (timing !== 'OPEN') {
          const reason = timing === 'MISSED' ? 'SCHEDULE_MISSED' : 'SCHEDULE_WAITING';
          if (plan.reason !== reason)
            this.state(plan.id, timing === 'MISSED' ? 'FAILED' : 'QUEUED', reason);
          continue;
        }
        const profile = runtime.get(plan.profileId);
        if (
          plan.accountId &&
          profile?.account.state === 'logged-in' &&
          profile.account.id &&
          profile.account.id !== plan.accountId
        ) {
          this.state(plan.id, 'STOPPED', 'ACCOUNT_CHANGED');
          this.unlock(plan.id);
          continue;
        }
        let reason = this.waitingReason(plan, profile, supported, sourceCapabilities);
        if (!reason && active >= this.settings().maxConcurrentProfiles)
          reason = 'CONCURRENCY_LIMIT';
        const accountId = profile?.account.id;
        if (
          !reason &&
          accountId &&
          this.db.prepare('SELECT job_id FROM task_account_locks WHERE account_id=?').get(accountId)
        )
          reason = 'ACCOUNT_BUSY';
        if (reason) {
          if (plan.reason !== reason) this.state(plan.id, 'QUEUED', reason);
          continue;
        }
        if (!accountId) throw new ProductError('IDENTITY_REQUIRED', '需要确认账号身份', 409);
        this.db.prepare('INSERT INTO task_account_locks VALUES(?,?)').run(accountId, plan.id);
        this.db
          .prepare(
            'UPDATE task_plans SET account_id=?,control_mode=NULL,control_request_id=NULL,control_confirmed=0 WHERE id=?',
          )
          .run(accountId, plan.id);
        const step = this.currentStep(plan);
        this.db.prepare("UPDATE task_steps SET status='ACTIVE' WHERE id=?").run(step.id);
        this.state(plan.id, 'RUNNING', '');
        return this.get(plan.id);
      }
      return null;
    });
  }
  reviewFailedAdmission(id: string, expectedAccountId: string, reason: string) {
    return transaction(this.db, () => {
      const plan = this.get(id);
      // A competing stop/identity change owns its existing state. Admission failure is
      // not proof that a native owner stopped or that an unknown creation never happened.
      if (plan.state !== 'RUNNING' || plan.accountId !== expectedAccountId) return plan;
      if (this.blockingOperations(id).length)
        throw Error('ADMISSION_FAILURE_OPERATION_ALREADY_EXISTS');
      this.state(id, 'REVIEW', ('INITIAL_SESSION_FAILED:' + reason).slice(0, 200));
      return this.get(id); // Keep the original account lock and all native tab evidence.
    });
  }
  unresolved(id: string) {
    return (
      Boolean(
        this.db
          .prepare(
            "SELECT attempt_id FROM material_reservations WHERE job_id=? AND state IN ('RESERVED','REVIEW') AND control_ended=0",
          )
          .get(id),
      ) ||
      this.blockingOperations(id).some((op) =>
        ['PREPARED', 'DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN'].includes(op.status),
      )
    );
  }
  // Material verdicts can resolve a stopped attempt without a dispatched final submit operation.
  finishResolvedPostControl(id: string) {
    transaction(this.db, () => {
      const plan = this.get(id);
      if (plan.state === 'REVIEW' && plan.controlConfirmed && !this.unresolved(id))
        this.finishControl(plan);
    });
  }
  private cancelPrepared(id: string) {
    this.db
      .prepare(
        "UPDATE task_outbox SET status='CANCELLED',updated_at=? WHERE job_id=? AND status='PREPARED'",
      )
      .run(this.dependencies.now(), id);
  }
  private control(id: string, mode: 'pause' | 'stop', reason: string) {
    const plan = this.get(id);
    if (terminal(plan.state)) return plan;
    if (plan.state === 'STOPPING' || (plan.state === 'PAUSING' && mode === 'pause')) return plan;
    this.cancelPrepared(id);
    // Cancel only fresh local reservations with no dispatch history. Historical REVIEW
    // and every bound operation remain untouched; physical stop still needs its receipt.
    const operations = this.operations(id);
    for (const row of this.db
      .prepare("SELECT attempt_id FROM material_reservations WHERE job_id=? AND state='RESERVED'")
      .all(id))
      cancelNeverDispatchedPost(this.db, String(row.attempt_id), operations);
    this.db
      .prepare(
        "UPDATE material_reservations SET state='REVIEW',reason='CONTROL_REQUESTED',updated_at=? WHERE job_id=? AND state='RESERVED'",
      )
      .run(this.dependencies.now(), id);
    this.db.prepare('UPDATE task_plans SET control_mode=? WHERE id=?').run(mode, id);
    if (plan.state === 'REVIEW' && plan.controlConfirmed) {
      // The native owner already stopped. Changing desired disposition needs no new input/stop;
      // unresolved side effects still hold REVIEW and the account lock until independent verdict.
      this.finishControl(this.get(id));
      return this.get(id);
    }
    if (['QUEUED', 'PAUSED'].includes(plan.state) && !this.unresolved(id)) {
      this.state(id, mode === 'stop' ? 'STOPPED' : 'PAUSED', reason);
      this.unlock(id);
    } else {
      this.db
        .prepare('UPDATE task_plans SET control_request_id=?,control_confirmed=0 WHERE id=?')
        .run(this.dependencies.id(), id);
      this.state(id, mode === 'stop' ? 'STOPPING' : 'PAUSING', reason);
    }
    return this.get(id);
  }
  requestControl(id: string, mode: 'pause' | 'stop', reason = 'USER_REQUEST') {
    return transaction(this.db, () => this.control(id, mode, reason));
  }
  private finishControl(plan: Plan) {
    if (this.unresolved(plan.id)) {
      this.state(plan.id, 'REVIEW', 'UNRESOLVED_OPERATION');
      return;
    }
    this.state(plan.id, plan.controlMode === 'stop' ? 'STOPPED' : 'PAUSED', plan.reason);
    if (!this.stepEnding(plan.id)) this.unlock(plan.id);
  }
  confirmControl(id: string, requestId: string) {
    return transaction(this.db, () => {
      const plan = this.get(id);
      if (!['PAUSING', 'STOPPING'].includes(plan.state))
        throw new ProductError('CONTROL_NOT_PENDING', '没有待确认的停止控制', 409);
      if (requestId !== plan.controlRequestId)
        throw new ProductError('STALE_CONTROL_CONFIRMATION', '停止回执已过期', 409);
      this.db.prepare('UPDATE task_plans SET control_confirmed=1 WHERE id=?').run(id);
      this.event(id, 'CONTROL_CONFIRMED');
      this.finishControl(this.get(id));
      return this.get(id);
    });
  }
  resume(id: string) {
    return transaction(this.db, () => {
      const plan = this.get(id);
      if (plan.state !== 'PAUSED' || this.unresolved(id))
        throw new ProductError('TASK_RESUME_REJECTED', '任务需先核对或不能继续', 409);
      this.db
        .prepare(
          'UPDATE task_plans SET control_mode=NULL,control_request_id=NULL,control_confirmed=0 WHERE id=?',
        )
        .run(id);
      this.state(id, 'QUEUED', 'USER_RESUMED');
      return this.get(id);
    });
  }
  reconcileProfileRuntime(profile: RuntimeProfile) {
    this.reconcileRuntime([profile], profile.id);
  }
  reconcileRuntime(profiles: RuntimeProfile[], onlyProfileId?: string) {
    transaction(this.db, () => {
      const runtime = new Map(profiles.map((profile) => [profile.id, profile]));
      const plans =
        onlyProfileId === undefined
          ? this.livePlans().filter((row) => row.state === 'RUNNING')
          : this.plansForProfile(onlyProfileId, ['RUNNING']);
      for (const plan of plans) {
        const profile = runtime.get(plan.profileId);
        if (
          profile?.account.state === 'logged-in' &&
          profile.account.id &&
          profile.account.id !== plan.accountId
        )
          this.control(plan.id, 'stop', 'ACCOUNT_CHANGED');
        else if (
          profile?.openingPlanId === plan.id &&
          profile.online &&
          profile.synced &&
          !profile.unresolved &&
          this.blockingOperations(plan.id).length === 0
        )
          continue; // The bounded startup read has no registered actor or input permission yet.
        else if (
          !profile?.online ||
          !profile.synced ||
          profile.unresolved ||
          profile.account.state !== 'logged-in' ||
          !profile.account.id ||
          !profile.dispatchAllowed
        )
          this.control(
            plan.id,
            'pause',
            profile?.unreadyReason?.slice(0, 200) || 'RUNTIME_NOT_READY',
          );
      }
    });
  }
  recoverOnStartup(preserveFutureSchedules = true) {
    transaction(this.db, () => {
      for (const plan of this.livePlans()) {
        this.cancelStepContinuation(plan.id); // Boot may finish stopping, never automatically resume business.
        if (
          preserveFutureSchedules &&
          plan.state === 'QUEUED' &&
          plan.timing &&
          !plan.timingReleased &&
          this.operations(plan.id).length === 0
        ) {
          const timing = taskTimingEligibility(plan.timing, this.dependencies.now());
          if (timing === 'WAIT') continue; // Future scheduled work has never been admitted.
          this.state(plan.id, 'PAUSED', 'SCHEDULE_MISSED_ON_RESTART');
          continue; // Never catch up missed publishing on boot.
        }
        if (
          (this.blockingOperations(plan.id).some((op) => op.status !== 'PREPARED') ||
            ['STOPPING', 'PAUSING'].includes(plan.state) ||
            ['SOFTWARE_RESTART_UNCERTAIN', 'STOP_CONFIRMATION_REQUIRED'].includes(plan.reason)) &&
          this.stopOfflineBrowse(plan.id, 'SOFTWARE_RESTART_BROWSE_CANCELLED')
        )
          continue;
        this.db
          .prepare(
            "UPDATE material_reservations SET state='REVIEW',reason='SOFTWARE_RESTART',updated_at=? WHERE job_id=? AND state='RESERVED'",
          )
          .run(this.dependencies.now(), plan.id);
        this.cancelPrepared(plan.id);
        this.db
          .prepare(
            "UPDATE task_outbox SET status='UNKNOWN',updated_at=? WHERE job_id=? AND status IN ('DISPATCHING','ACKNOWLEDGED')",
          )
          .run(this.dependencies.now(), plan.id);
        if (this.unresolved(plan.id)) {
          this.db
            .prepare(
              "UPDATE task_plans SET control_mode=coalesce(control_mode,'pause'),control_request_id=NULL,control_confirmed=0 WHERE id=?",
            )
            .run(plan.id);
          this.state(plan.id, 'REVIEW', 'SOFTWARE_RESTART_UNCERTAIN');
        } else if (
          ['STOPPING', 'PAUSING'].includes(plan.state) ||
          (plan.state === 'REVIEW' && !plan.controlConfirmed)
        ) {
          this.db.prepare('UPDATE task_plans SET control_request_id=NULL WHERE id=?').run(plan.id);
          this.state(plan.id, 'REVIEW', 'STOP_CONFIRMATION_REQUIRED');
        } else {
          this.db
            .prepare(
              "UPDATE task_plans SET control_mode='pause',control_request_id=NULL,control_confirmed=0 WHERE id=?",
            )
            .run(plan.id);
          this.state(plan.id, 'PAUSED', 'SOFTWARE_RESTART');
          this.unlock(plan.id);
        }
      }
    });
  }
  stopOfflineBrowse(id: string, reason = 'OFFLINE_BROWSE_CANCELLED'): Plan | null {
    return transaction(this.db, () => {
      const plan = this.get(id);
      if (terminal(plan.state)) return plan;
      if (
        this.db
          .prepare(
            "SELECT 1 FROM material_reservations WHERE job_id=? AND state IN ('RESERVED','REVIEW') AND control_ended=0",
          )
          .get(id)
      )
        return null;
      const pending = this.blockingOperations(id).filter((op) => op.status !== 'PREPARED');
      if (
        pending.some(
          (op) =>
            (op.action.kind !== 'browseScroll' && !this.isRegisteredReelAdvance(op)) ||
            postLink(this.db, op.id),
        )
      )
        return null;
      this.cancelStepContinuation(id);
      this.cancelPrepared(id);
      for (const op of pending) {
        // Cancellation concerns inert browsing only, not proof that scrolling never happened.
        // Reuse NOT_APPLIED delivery so a later reconnect can retire the original journal entry.
        if (op.binding) {
          const receipt = {
            binding: op.binding,
            evidence: { reason, offlineBrowseCancelled: true },
          };
          this.settle(op.id, 'NOT_APPLIED', receipt);
          this.settlements.ensureSettled(op.binding, 'NOT_APPLIED', receipt);
        } else this.settle(op.id, 'NOT_APPLIED', { reason, offlineBrowseCancelled: true });
      }
      this.db
        .prepare(
          "UPDATE task_plans SET control_mode='stop',control_request_id=NULL,control_confirmed=1 WHERE id=?",
        )
        .run(id);
      this.db
        .prepare(
          "UPDATE task_tab_state SET state='LOST',context=NULL,reason='ENDED_OWNERSHIP_RELEASED',revision=revision+1,updated_at=? WHERE job_id=? AND state NOT IN ('CLOSED','RELEASED','LOST')",
        )
        .run(this.dependencies.now(), id);
      this.state(id, 'STOPPED', reason);
      this.unlock(id);
      this.event(id, 'OFFLINE_BROWSE_CANCELLED', { operations: pending.map((op) => op.id) });
      return this.get(id);
    });
  }
  private operation(id: string): Operation {
    const row = this.db
      .prepare(
        'SELECT o.*,b.body AS binding FROM task_outbox o LEFT JOIN task_dispatch_bindings b ON b.operation_id=o.id WHERE o.id=?',
      )
      .get(id);
    if (!row) throw new ProductError('OPERATION_NOT_FOUND', '任务指令不存在', 404);
    return TaskOperation.parse({
      id: row.id,
      jobId: row.job_id,
      stepId: row.step_id,
      action: JSON.parse(String(row.action)) as unknown,
      binding: row.binding === null ? null : (JSON.parse(String(row.binding)) as unknown),
      status: row.status,
      receipt: row.receipt === null ? null : (JSON.parse(String(row.receipt)) as unknown),
      checkpointApplied: row.checkpoint_applied === 1,
      ...(row.disposition ? { disposition: JSON.parse(String(row.disposition)) as unknown } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  operations(id: string) {
    return this.db
      .prepare('SELECT id FROM task_outbox WHERE job_id=? ORDER BY created_at,rowid')
      .all(id)
      .map((row) => this.operation(String(row.id)));
  }
  recentOperations(id: string, limit: number) {
    return this.db
      .prepare(
        'SELECT id FROM task_outbox WHERE job_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?',
      )
      .all(id, Math.max(1, Math.min(100, limit)))
      .reverse()
      .map((row) => this.operation(String(row.id)));
  }
  findOperation(jobId: string, operationId: string): Operation | null {
    const row = this.db
      .prepare('SELECT id FROM task_outbox WHERE id=? AND job_id=?')
      .get(operationId, jobId);
    return row ? this.operation(String(row.id)) : null;
  }
  blockingOperations(id: string) {
    return this.db
      .prepare(
        "SELECT id FROM task_outbox WHERE job_id=? AND (status IN ('PREPARED','DISPATCHING','ACKNOWLEDGED') OR (status='UNKNOWN' AND control_ended=0)) ORDER BY created_at,rowid",
      )
      .all(id)
      .map((row) => this.operation(String(row.id)));
  }
  noteStepFailure(id: string, stepId: string, reason: string): void {
    transaction(this.db, () => {
      const plan = this.get(id),
        step = this.currentStep(plan, stepId);
      if (
        step.status !== 'ACTIVE' ||
        terminal(plan.state) ||
        plan.controlMode === 'stop' ||
        plan.reason.startsWith('USER_')
      )
        return;
      if (this.endingId(id)) return;
      this.db
        .prepare('UPDATE task_plans SET ending_step_id=?,ending_step_reason=? WHERE id=?')
        .run(stepId, reason.slice(0, 200), id);
      this.event(id, 'STEP_FAILURE_INTENT', { stepId, reason });
    });
  }
  requestStepEnd(id: string, stepId: string, reason: string): string {
    return transaction(this.db, () => {
      const plan = this.get(id),
        step = this.currentStep(plan, stepId);
      if (
        step.status !== 'ACTIVE' ||
        plan.controlMode !== 'pause' ||
        (plan.reason !== reason && this.stepEnding(id)?.reason !== reason) ||
        !['PAUSING', 'PAUSED', 'REVIEW'].includes(plan.state)
      )
        throw Error('STEP_END_SCOPE_CHANGED');
      const previous = this.stepEnding(id);
      if (previous && previous.stepId !== stepId) throw Error('STEP_END_ALREADY_PENDING');
      const endingId = this.requestEnd(id);
      this.db
        .prepare('UPDATE task_plans SET ending_step_id=?,ending_step_reason=? WHERE id=?')
        .run(stepId, reason.slice(0, 200), id);
      this.event(id, 'STEP_END_REQUESTED', { stepId, endingId, reason });
      return endingId;
    });
  }
  stepEnding(id: string): { stepId: string; reason: string; finished: boolean } | null {
    const row = this.db
      .prepare(
        'SELECT ending_step_id,ending_step_reason,ending_finished FROM task_plans WHERE id=?',
      )
      .get(id);
    return row?.ending_step_id
      ? {
          stepId: String(row.ending_step_id),
          reason: String(row.ending_step_reason),
          finished: row.ending_finished === 1,
        }
      : null;
  }
  cancelStepContinuation(id: string): void {
    transaction(this.db, () => {
      if (!this.stepEnding(id)) return;
      this.db
        .prepare('UPDATE task_plans SET ending_step_id=NULL,ending_step_reason=NULL WHERE id=?')
        .run(id);
      this.event(id, 'STEP_CONTINUATION_CANCELLED', {});
    });
  }
  endingId(id: string): string | null {
    this.get(id);
    const row = this.db.prepare('SELECT ending_id FROM task_plans WHERE id=?').get(id);
    return row?.ending_id ? String(row.ending_id) : null;
  }
  pendingEndings(): Plan[] {
    return this.livePlans().filter((plan) => this.endingId(plan.id) !== null);
  }
  requestEnd(id: string): string {
    return transaction(this.db, () => {
      const plan = this.get(id),
        previous = this.endingId(id);
      if (previous) return previous;
      if (
        terminal(plan.state) ||
        (!['REVIEW', 'PAUSING', 'STOPPING'].includes(plan.state) &&
          !(plan.state === 'PAUSED' && this.stepEnding(id)))
      )
        throw Error('TASK_END_REQUIRES_STOPPING_OR_REVIEW');
      const endingId = this.dependencies.id();
      this.cancelPrepared(id);
      this.db.prepare('UPDATE task_plans SET ending_id=? WHERE id=?').run(endingId, id);
      this.state(id, 'STOPPING', 'ENDING_UNCONFIRMED_TASK');
      this.event(id, 'END_REQUESTED', { endingId });
      return endingId;
    });
  }
  prepareEnd(id: string, input: CurrentStop): void {
    const stop = CurrentStopReceipt.parse(input);
    transaction(this.db, () => {
      const plan = this.get(id),
        endingId = this.endingId(id);
      if (
        !endingId ||
        stop.requestId !== endingId ||
        stop.profileId !== plan.profileId ||
        terminal(plan.state)
      )
        throw Error('TASK_END_STOP_BINDING_REJECTED');
      this.db
        .prepare('UPDATE task_plans SET ending_stop=? WHERE id=?')
        .run(JSON.stringify(stop), id);
      this.db
        .prepare(
          "UPDATE task_outbox SET status='UNKNOWN',updated_at=? WHERE job_id=? AND status IN ('DISPATCHING','ACKNOWLEDGED')",
        )
        .run(this.dependencies.now(), id);
      for (const op of this.blockingOperations(id).filter((op) => op.status === 'UNKNOWN')) {
        if (!op.binding) throw Error('TASK_END_ORIGINAL_BINDING_REQUIRED');
        const evidenceDigest = createHash('sha256')
          .update(JSON.stringify({ endingId, binding: op.binding }))
          .digest('hex');
        this.settlements.ensureEnded(op.binding, {
          id: this.dependencies.id(),
          outcome: 'ENDED_UNKNOWN',
          evidenceDigest,
        });
      }
    });
  }
  private isRegisteredReelAdvance(op: Operation): boolean {
    if (
      op.action.kind !== 'click' ||
      op.action.target.css !== FACEBOOK_REEL_NEXT_CSS ||
      op.action.target.scope !== undefined ||
      op.action.target.text !== undefined ||
      !op.binding
    )
      return false;
    try {
      const row = this.db
        .prepare(
          'SELECT body FROM task_browse_intents WHERE operation_id=? AND job_id=? AND step_id=?',
        )
        .get(op.id, op.binding.jobId, op.binding.stepId);
      if (!row) return false;
      const registered = BrowseOperationIntent.parse(JSON.parse(String(row.body)) as unknown);
      const step = this.steps(op.binding.jobId).find((item) => item.id === op.binding?.stepId);
      if (
        !step ||
        registered.operationId !== op.id ||
        registered.jobId !== op.binding.jobId ||
        registered.stepId !== op.binding.stepId ||
        registered.intent.kind !== 'auxiliary' ||
        registered.intent.purpose !== 'advance' ||
        registered.intent.proof.profileId !== op.binding.profileId
      )
        return false;
      validateBrowseIntent(step, op.action, registered.intent);
      return true;
    } catch {
      return false;
    }
  }
  finishEnd(id: string, input: CurrentStop): Plan {
    const stop = CurrentStopReceipt.parse(input);
    return transaction(this.db, () => {
      const plan = this.get(id),
        endingId = this.endingId(id);
      if (!endingId || stop.requestId !== endingId || stop.profileId !== plan.profileId)
        throw Error('TASK_END_STOP_BINDING_REJECTED');
      if (terminal(plan.state)) return plan;
      if (this.stepEnding(id)?.finished) return plan;
      const savedStop = this.db
        .prepare('SELECT ending_stop FROM task_plans WHERE id=?')
        .get(id)?.ending_stop;
      if (!savedStop) throw Error('TASK_END_PREPARED_STOP_REQUIRED');
      const preparedStop = CurrentStopReceipt.parse(JSON.parse(String(savedStop)) as unknown);
      if (preparedStop.requestId !== endingId || preparedStop.profileId !== plan.profileId)
        throw Error('TASK_END_STOP_BINDING_REJECTED');
      const notices = this.settlements.list(plan.profileId);
      for (const op of this.blockingOperations(id)) {
        if (['PREPARED', 'DISPATCHING', 'ACKNOWLEDGED'].includes(op.status))
          throw Error('TASK_END_INPUT_NOT_DRAINED');
        if (op.status !== 'UNKNOWN') continue;
        const notice = notices.find(
          (n) => n.binding.operationId === op.id && n.resolution.outcome === 'ENDED_UNKNOWN',
        );
        if (
          !notice ||
          notice.state !== 'DELIVERED' ||
          !op.binding ||
          !sameBinding(op.binding, notice.binding)
        )
          throw Error('TASK_END_NOTICE_PENDING');
        const disposition = OperationDisposition.parse(notice.resolution);
        if (op.disposition && JSON.stringify(op.disposition) !== JSON.stringify(disposition))
          throw Error('TASK_END_DISPOSITION_CONFLICT');
        this.db
          .prepare('UPDATE task_outbox SET disposition=? WHERE id=?')
          .run(JSON.stringify(disposition), op.id);
      }
      const operations = this.operations(id);
      let possiblePublication = false;
      for (const row of this.db
        .prepare(
          "SELECT attempt_id FROM material_reservations WHERE job_id=? AND state IN ('RESERVED','REVIEW') AND control_ended=0",
        )
        .all(id)) {
        const attemptId = String(row.attempt_id);
        if (!endPostWithoutSubmit(this.db, attemptId, operations, endingId)) {
          possiblePublication = true;
          this.db
            .prepare(
              "UPDATE material_reservations SET state='REVIEW',reason='ENDED_SUBMISSION_UNCONFIRMED',updated_at=? WHERE attempt_id=?",
            )
            .run(this.dependencies.now(), attemptId);
        }
      }
      this.db
        .prepare('UPDATE task_plans SET ending_stop=? WHERE id=?')
        .run(JSON.stringify(stop), id);
      this.event(id, 'END_CONFIRMED', { endingId, stop, possiblePublication });
      const scope = this.stepEnding(id);
      if (scope) {
        const step = this.currentStep(plan, scope.stepId);
        const post = step.spec.type === 'post';
        const skipped =
          scope.reason === 'MATERIAL_NO_ELIGIBLE_RESOURCE' &&
          step.progress.published === 0 &&
          !this.operations(id).some((op) => op.stepId === step.id);
        const outcome = skipped
          ? TaskStepSkip.parse({
              version: 1,
              kind: 'SKIPPED',
              reason: 'RESOURCE_EXHAUSTED',
              endedAt: this.dependencies.now(),
            })
          : TaskStepFailure.parse({
              version: 1,
              kind: 'FAILED',
              reason:
                scope.reason === 'MATERIAL_NO_ELIGIBLE_RESOURCE'
                  ? 'RESOURCE_EXHAUSTED'
                  : scope.reason,
              endedAt: this.dependencies.now(),
              endingId,
              currentStop: stop,
              submissionPhase: post
                ? possiblePublication
                  ? 'UNKNOWN'
                  : 'BEFORE_SUBMIT'
                : 'NOT_APPLICABLE',
              businessResult: post
                ? possiblePublication
                  ? 'UNKNOWN'
                  : 'NOT_PUBLISHED'
                : 'NOT_APPLICABLE',
            });
        this.db
          .prepare("UPDATE task_steps SET status=?,outcome=? WHERE id=? AND status='ACTIVE'")
          .run(outcome.kind, JSON.stringify(outcome), step.id);
        this.db.prepare('UPDATE task_plans SET ending_finished=1 WHERE id=?').run(id);
        this.db
          .prepare(
            "UPDATE task_outbox SET control_ended=1 WHERE job_id=? AND step_id=? AND status='UNKNOWN' AND control_ended=0",
          )
          .run(id, step.id);
        this.db
          .prepare(
            "UPDATE material_reservations SET control_ended=1 WHERE job_id=? AND state='REVIEW' AND control_ended=0 AND attempt_id IN (SELECT attempt_id FROM material_post_intents WHERE step_id=?)",
          )
          .run(id, step.id);
        this.event(id, skipped ? 'STEP_SKIPPED' : 'STEP_FAILED', { stepId: step.id, outcome });
        return this.get(id); // STOPPING retains the account lock until page ownership is settled.
      }
      const unknown = operations.filter((op) => op.status === 'UNKNOWN');
      const cancelledDraft =
        plan.controlMode === 'stop' &&
        plan.controlConfirmed &&
        !possiblePublication &&
        plan.snapshot.steps.some((step) => step.type === 'post') &&
        this.steps(id).every((step) => step.status !== 'FAILED') &&
        operations.every((op) => ['VERIFIED', 'CANCELLED'].includes(op.status)) &&
        !this.db
          .prepare(
            "SELECT 1 FROM material_post_operations m JOIN task_outbox o ON o.id=m.operation_id WHERE o.job_id=? AND m.purpose='SUBMIT' LIMIT 1",
          )
          .get(id);
      const cancelledBrowse =
        plan.controlMode === 'stop' &&
        plan.controlConfirmed &&
        !possiblePublication &&
        plan.snapshot.steps.every(
          (step) =>
            ['feed', 'video', 'marketplace'].includes(step.type) &&
            'maxLikes' in step &&
            step.maxLikes === 0,
        ) &&
        operations.every((op) => ['VERIFIED', 'CANCELLED', 'UNKNOWN'].includes(op.status)) &&
        unknown.length > 0 &&
        unknown.every((op) => {
          const cancelled = CancelledBrowseReceipt.safeParse(op.receipt);
          return (
            (op.action.kind === 'browseScroll' || this.isRegisteredReelAdvance(op)) &&
            op.disposition?.outcome === 'ENDED_UNKNOWN' &&
            op.binding &&
            cancelled.success &&
            sameBinding(op.binding, cancelled.data.binding)
          );
        });
      // A verified, never-submitted draft can stop normally. Unknown inputs keep their
      // original UNKNOWN/disposition; only registered, non-interactive browse cancellation applies.
      const cancelled = cancelledBrowse || cancelledDraft;
      const preservedReason =
        !cancelled && !possiblePublication && unknown.length === 0 && plan.controlMode !== 'stop'
          ? (() => {
              const eventReasons = this.events(id)
                .map((item) => {
                  const detail = item.detail;
                  if (
                    detail &&
                    typeof detail === 'object' &&
                    !Array.isArray(detail) &&
                    typeof (detail as Record<string, unknown>).reason === 'string'
                  ) {
                    return String((detail as Record<string, unknown>).reason).trim();
                  }
                  return '';
                })
                .filter(
                  (r) =>
                    r !== '' &&
                    r !== 'ENDING_UNCONFIRMED_TASK' &&
                    r !== 'OPERATION_RESULT_UNCONFIRMED' &&
                    !r.startsWith('USER_'),
                );
              return (
                eventReasons.find((r) => r.startsWith('INITIAL_SESSION_FAILED:')) ??
                eventReasons.at(-1) ??
                null
              );
            })()
          : null;
      this.state(
        id,
        cancelled ? 'STOPPED' : 'FAILED',
        cancelled
          ? 'USER_STOP'
          : possiblePublication ||
              this.steps(id).some(
                (step) =>
                  step.outcome?.kind === 'FAILED' && step.outcome.businessResult === 'UNKNOWN',
              )
            ? 'PUBLISH_RESULT_UNCONFIRMED'
            : (preservedReason ?? 'OPERATION_RESULT_UNCONFIRMED'),
      );
      this.unlock(id);
      return this.get(id);
    });
  }
  finishStepContinuation(id: string): Plan {
    return transaction(this.db, () => {
      const plan = this.get(id),
        scope = this.stepEnding(id);
      if (!scope?.finished || plan.state !== 'STOPPING') throw Error('STEP_END_NOT_CONFIRMED');
      if (
        this.db
          .prepare(
            "SELECT s.ownership_id FROM task_tab_state s JOIN task_tab_ownership o USING(ownership_id,job_id) WHERE o.job_id=? AND s.state IN ('READY','RECHECK_REQUIRED')",
          )
          .get(id)
      )
        throw Error('STEP_END_TAB_OWNERSHIP_PENDING');
      if (this.blockingOperations(id).length) throw Error('STEP_END_OPERATION_PENDING');
      this.db
        .prepare(
          'UPDATE task_plans SET ending_id=NULL,ending_stop=NULL,ending_step_id=NULL,ending_step_reason=NULL,ending_finished=0,control_mode=NULL,control_request_id=NULL,control_confirmed=0 WHERE id=?',
        )
        .run(id);
      this.unlock(id); // Physical end and page disposition are complete; normal admission reacquires.
      this.advanceStepPosition(plan, true);
      this.event(id, 'STEP_CONTINUATION_READY', { stepId: scope.stepId });
      return this.get(id);
    });
  }
  prepareOperation(id: string, stepId: string, operationId: string, action: Action) {
    const parsed = Action.parse(action),
      body = JSON.stringify(parsed);
    return transaction(this.db, () => {
      const existing = this.db
        .prepare('SELECT id,job_id,step_id,action FROM task_outbox WHERE id=?')
        .get(operationId);
      if (existing) {
        if (existing.job_id !== id || existing.step_id !== stepId || existing.action !== body)
          throw new ProductError('OPERATION_ID_CONFLICT', '指令标识对应的内容不同', 409);
        return this.operation(operationId);
      }
      const plan = this.get(id);
      if (plan.state !== 'RUNNING')
        throw new ProductError('TASK_NOT_RUNNING', '任务没有执行权限', 409);
      const step = this.currentStep(plan, stepId);
      if (step.spec.type === 'post')
        assertPostPreparation(this.db, id, stepId, operationId, parsed);
      if (
        (step.spec.type !== 'post' && this.unresolved(id)) ||
        this.blockingOperations(id).some((op) =>
          ['PREPARED', 'DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN'].includes(op.status),
        )
      )
        throw new ProductError('OPERATION_PENDING', '上一指令尚未结算', 409);
      const now = this.dependencies.now();
      this.db
        .prepare(
          "INSERT INTO task_outbox(id,job_id,step_id,action,status,created_at,updated_at) VALUES(?,?,?,?,'PREPARED',?,?)",
        )
        .run(operationId, id, stepId, body, now, now);
      this.event(id, 'OPERATION_PREPARED', { operationId });
      return this.operation(operationId);
    });
  }
  takeOperation() {
    return transaction(this.db, () => {
      const row = this.db
        .prepare(
          "SELECT o.id FROM task_outbox o JOIN task_plans p ON p.id=o.job_id WHERE o.status='PREPARED' AND p.state='RUNNING' ORDER BY o.created_at,o.rowid LIMIT 1",
        )
        .get();
      if (!row) return null;
      const id = String(row.id);
      if (postLink(this.db, id)) throw Error('POST_BOUND_DISPATCH_REQUIRED');
      this.db
        .prepare("UPDATE task_outbox SET status='DISPATCHING',updated_at=? WHERE id=?")
        .run(this.dependencies.now(), id);
      const operation = this.operation(id);
      this.event(operation.jobId, 'OPERATION_DISPATCHING', { operationId: id });
      return operation;
    });
  }
  takeBoundOperation(input: ExecutionSession) {
    const context = ExecutionContext.parse(input);
    return transaction(this.db, () => {
      const row = this.db
        .prepare(
          "SELECT o.id FROM task_outbox o JOIN task_plans p ON p.id=o.job_id WHERE o.status='PREPARED' AND p.state='RUNNING' AND p.profile_id=? AND p.account_id=? ORDER BY o.created_at,o.rowid LIMIT 1",
        )
        .get(context.profileId, context.accountId);
      if (!row) return null;
      const operation = this.operation(String(row.id));
      const plan = this.get(operation.jobId);
      const step = this.currentStep(plan, operation.stepId);
      if (step.spec.type === 'post') assertPostDispatch(this.db, operation.id, context);
      const binding = DispatchBinding.parse({
        ...context,
        operationId: operation.id,
        jobId: operation.jobId,
        stepId: operation.stepId,
        actionDigest: createHash('sha256').update(canonicalAction(operation.action)).digest('hex'),
      });
      // Binding and dispatch state commit together, before any browser call.
      this.db
        .prepare('INSERT INTO task_dispatch_bindings VALUES(?,?,?)')
        .run(operation.id, JSON.stringify(binding), this.dependencies.now());
      this.db
        .prepare("UPDATE task_outbox SET status='DISPATCHING',updated_at=? WHERE id=?")
        .run(this.dependencies.now(), operation.id);
      this.event(plan.id, 'OPERATION_BOUND', binding);
      return this.operation(operation.id);
    });
  }
  private requireBinding(input: Binding) {
    const binding = DispatchBinding.parse(input);
    const operation = this.operation(binding.operationId);
    if (!operation.binding || !sameBinding(operation.binding, binding))
      throw new ProductError('DISPATCH_BINDING_MISMATCH', '执行回执与派发上下文不一致', 409);
    return operation;
  }
  acknowledgeBound(input: ExecutionReceipt) {
    const receipt = BoundReceipt.parse(input);
    transaction(this.db, () => {
      this.requireBinding(receipt.binding);
      this.acknowledge(receipt.binding.operationId, receipt);
    });
  }
  markBoundUnknown(binding: Binding, reason: string, observation?: ExecutionReceipt) {
    const observed = observation === undefined ? undefined : BoundReceipt.parse(observation);
    if (observed && !sameBinding(binding, observed.binding))
      throw Error('BUSINESS_VERDICT_BINDING_MISMATCH');
    transaction(this.db, () => {
      this.requireBinding(binding);
      this.settle(binding.operationId, 'UNKNOWN', {
        binding,
        reason,
        ...(observed ? { observation: observed.evidence } : {}),
      });
    });
  }
  noteChildPageLifecycle(input: Binding, value: unknown) {
    const binding = DispatchBinding.parse(input),
      lifecycle = TaskChildPageLifecycle.parse(value);
    transaction(this.db, () => {
      const operation = this.requireBinding(binding),
        plan = this.get(binding.jobId);
      const parent = this.db
        .prepare(
          'SELECT o.proof,s.state,s.context FROM task_tab_ownership o JOIN task_tab_state s USING(ownership_id,job_id) WHERE o.job_id=? AND o.ownership_id=?',
        )
        .get(binding.jobId, lifecycle.parent.ownershipId);
      if (
        plan.state !== 'RUNNING' ||
        operation.status !== 'ACKNOWLEDGED' ||
        lifecycle.parent.profileId !== binding.profileId ||
        parent?.state !== 'READY' ||
        parent.context === null ||
        !sameExecution(ExecutionContext.parse(JSON.parse(String(parent.context))), binding) ||
        !sameTabProof(OwnedTabProof.parse(JSON.parse(String(parent.proof))), lifecycle.parent)
      )
        throw Error('TASK_CHILD_PAGE_ORIGINAL_CONTEXT_REQUIRED');
      this.event(binding.jobId, 'CHILD_PAGE_' + lifecycle.state, {
        binding,
        lifecycle,
      });
    });
  }
  noteBrowseReadFailure(
    jobId: string,
    stepId: string,
    input: ExecutionSession,
    reason: string,
    value: PendingDiagnostic,
    kind: 'timeout' | 'input-fence' = 'timeout',
  ) {
    const context = ExecutionContext.parse(input),
      pending = BrowsePendingDiagnostic.parse(value);
    transaction(this.db, () => {
      const plan = this.get(jobId),
        step = this.currentStep(plan, stepId);
      if (
        plan.state !== 'RUNNING' ||
        step.status !== 'ACTIVE' ||
        plan.profileId !== context.profileId ||
        plan.accountId !== context.accountId
      )
        throw Error('BROWSE_DIAGNOSTIC_OWNER_CHANGED');
      this.event(jobId, kind === 'input-fence' ? 'BROWSE_INPUT_FENCE' : 'BROWSE_READ_TIMEOUT', {
        version: 1,
        stepId,
        reason,
        pending,
      });
    });
  }
  releaseBrowseControl(input: ExecutionReceipt) {
    const receipt = BoundReceipt.parse(input);
    transaction(this.db, () => {
      const op = this.requireBinding(receipt.binding);
      if (
        op.status !== 'ACKNOWLEDGED' ||
        op.action.kind !== 'browseScroll' ||
        postLink(this.db, op.id)
      )
        throw Error('BROWSE_CONTROL_RELEASE_REJECTED');
      this.db
        .prepare("UPDATE task_outbox SET status='CANCELLED',receipt=?,updated_at=? WHERE id=?")
        .run(JSON.stringify(receipt), this.dependencies.now(), op.id);
      this.settlements.ensureSettled(receipt.binding, 'CONTROL_RELEASED', receipt);
      this.event(op.jobId, 'BROWSE_CONTROL_RELEASED', { operationId: op.id });
    });
  }
  settleBound(input: ExecutionReceipt, outcome: 'VERIFIED' | 'NOT_APPLIED', progress?: Progress) {
    const receipt = BoundReceipt.parse(input);
    transaction(this.db, () => {
      const operation = this.requireBinding(receipt.binding);
      if (operation.status === 'UNKNOWN')
        throw new ProductError(
          'EXPLICIT_RECONCILIATION_REQUIRED',
          '未知结果需独立核对，不能接受迟到的成功回执',
          409,
        );
      this.settle(operation.id, outcome, receipt, progress);
      this.settlements.ensureSettled(receipt.binding, outcome, receipt);
    });
  }
  reconcileBound(
    input: ExecutionReceipt,
    outcome: 'VERIFIED' | 'NOT_APPLIED',
    progress?: Progress,
  ) {
    const receipt = BoundReceipt.parse(input);
    transaction(this.db, () => {
      const operation = this.requireBinding(receipt.binding);
      if (operation.status !== 'UNKNOWN')
        throw new ProductError('RECONCILIATION_NOT_REQUIRED', '仅未知指令可进入独立核对', 409);
      if (
        this.db.prepare('SELECT control_ended FROM task_outbox WHERE id=?').get(operation.id)
          ?.control_ended === 1
      )
        throw new ProductError(
          'ENDED_OPERATION_REVIEW_REQUIRED',
          '已结束步骤的业务未知保留，不能推进后继步骤进度',
          409,
        );
      this.settle(operation.id, outcome, receipt, progress);
      this.settlements.ensureSettled(receipt.binding, outcome, receipt);
      this.event(operation.jobId, 'OPERATION_RECONCILED', { operationId: operation.id });
    });
  }
  markAcknowledged(operationId: string, receipt: Operation['receipt']) {
    transaction(this.db, () => {
      const operation = this.operation(operationId);
      if (operation.binding)
        throw new ProductError('BOUND_RECEIPT_REQUIRED', '已绑定指令需要完整执行回执', 409);
      this.acknowledge(operationId, receipt);
    });
  }
  private acknowledge(operationId: string, receipt: Operation['receipt']) {
    const operation = this.operation(operationId);
    if (operation.status !== 'DISPATCHING') return; // Late ACK cannot undo UNKNOWN or VERIFIED.
    this.db
      .prepare("UPDATE task_outbox SET status='ACKNOWLEDGED',receipt=?,updated_at=? WHERE id=?")
      .run(JSON.stringify(receipt), this.dependencies.now(), operationId);
    this.event(operation.jobId, 'OPERATION_ACKNOWLEDGED', { operationId });
  }
  private writeProgress(plan: Plan, stepId: string, expectedRevision: number, next: Progress) {
    const step = this.currentStep(plan, stepId),
      progress = TaskProgress.parse(next);
    if (step.progress.revision !== expectedRevision)
      throw new ProductError('CHECKPOINT_CONFLICT', '执行进度已变化', 409);
    validateProgress(step.spec, step.progress, progress);
    this.db
      .prepare('UPDATE task_steps SET progress=? WHERE id=?')
      .run(JSON.stringify(progress), stepId);
    this.event(plan.id, 'CHECKPOINT', { stepId, revision: progress.revision });
  }
  checkpoint(id: string, stepId: string, expectedRevision: number, progress: Progress) {
    transaction(this.db, () => {
      const plan = this.get(id);
      if (plan.state !== 'RUNNING' || this.unresolved(id))
        throw new ProductError('CHECKPOINT_NOT_READY', '存在未决指令或任务未运行', 409);
      const step = this.currentStep(plan, stepId);
      if (progress.likes !== step.progress.likes || progress.published !== step.progress.published)
        throw new ProductError(
          'SIDE_EFFECT_EVIDENCE_REQUIRED',
          '副作用计数必须关联已核验指令',
          409,
        );
      this.writeProgress(plan, stepId, expectedRevision, progress);
    });
  }
  checkpointAsync(
    id: string,
    stepId: string,
    expectedRevision: number,
    progress: Progress,
  ): Promise<void> {
    const frozen = structuredClone(progress);
    return this.checkpointQueue.enqueue(() =>
      this.checkpoint(id, stepId, expectedRevision, frozen),
    );
  }
  checkpointCommitStatus() {
    return this.checkpointQueue.status();
  }
  closeCheckpoints() {
    this.checkpointQueue.close();
  }
  settleOperation(
    operationId: string,
    outcome: 'VERIFIED' | 'NOT_APPLIED' | 'UNKNOWN',
    evidence: Operation['receipt'],
    progress?: Progress,
  ) {
    transaction(this.db, () => {
      if (this.operation(operationId).binding)
        throw new ProductError('BOUND_RECEIPT_REQUIRED', '已绑定指令需要完整执行回执', 409);
      this.settle(operationId, outcome, evidence, progress);
    });
  }
  private settle(
    operationId: string,
    outcome: 'VERIFIED' | 'NOT_APPLIED' | 'UNKNOWN',
    evidence: Operation['receipt'],
    progress?: Progress,
  ) {
    const operation = this.operation(operationId),
      plan = this.get(operation.jobId);
    if (outcome !== 'UNKNOWN' && postLink(this.db, operationId)) {
      if (!operation.binding) throw Error('POST_BOUND_RECEIPT_REQUIRED');
      assertPostSettlement(this.db, BoundReceipt.parse(evidence), outcome);
    }
    if (['VERIFIED', 'FAILED', 'CANCELLED'].includes(operation.status)) return;
    if (operation.status === 'UNKNOWN' && outcome === 'UNKNOWN') return;
    if (!['DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN'].includes(operation.status))
      throw new ProductError('OPERATION_NOT_DISPATCHED', '指令尚未派发', 409);
    if (outcome === 'VERIFIED') {
      if (isWrite(operation.action) && !progress)
        throw new ProductError('CHECKPOINT_REQUIRED', '写操作核验必须同时提交执行进度', 409);
      if (progress) this.writeProgress(plan, operation.stepId, progress.revision - 1, progress);
    } else if (progress)
      throw new ProductError('UNVERIFIED_CHECKPOINT', '未核验不能推进业务进度', 409);
    const status = outcome === 'NOT_APPLIED' ? 'FAILED' : outcome;
    this.db
      .prepare(
        'UPDATE task_outbox SET status=?,receipt=?,checkpoint_applied=?,updated_at=? WHERE id=?',
      )
      .run(
        status,
        JSON.stringify(evidence),
        outcome === 'VERIFIED' && progress ? 1 : 0,
        this.dependencies.now(),
        operationId,
      );
    this.event(plan.id, 'OPERATION_' + status, { operationId });
    if (status === 'UNKNOWN') {
      this.db
        .prepare(
          "UPDATE material_reservations SET state='REVIEW',reason='OPERATION_UNKNOWN',updated_at=? WHERE job_id=? AND state='RESERVED'",
        )
        .run(this.dependencies.now(), plan.id);
      this.cancelPrepared(plan.id);
      this.db
        .prepare(
          "UPDATE task_plans SET control_mode=coalesce(control_mode,'pause'),control_confirmed=0 WHERE id=?",
        )
        .run(plan.id);
      if (['PAUSING', 'STOPPING'].includes(plan.state) && plan.controlRequestId) {
        this.event(plan.id, 'OPERATION_REVIEW_PENDING_CONTROL', { operationId });
      } else this.state(plan.id, 'REVIEW', 'UNRESOLVED_OPERATION');
    } else if (plan.state === 'REVIEW' && plan.controlConfirmed) this.finishControl(plan);
  }
  completeStep(id: string, stepId: string) {
    return transaction(this.db, () => {
      const plan = this.get(id);
      if (plan.state !== 'RUNNING' || this.unresolved(id))
        throw new ProductError('TASK_NOT_READY', '任务未运行或指令未结算', 409);
      const step = this.currentStep(plan, stepId);
      if (!stepComplete(step.spec, step.progress))
        throw new ProductError('STEP_INCOMPLETE', '子任务没有达到完成条件', 409);
      this.db.prepare("UPDATE task_steps SET status='COMPLETED' WHERE id=?").run(step.id);
      this.event(id, 'STEP_COMPLETED', { stepId });
      this.advanceStepPosition(plan, false);
      return this.get(id);
    });
  }
  private advanceStepPosition(plan: Plan, readmit: boolean) {
    const id = plan.id;
    if (plan.position + 1 < plan.snapshot.steps.length) {
      this.db
        .prepare('UPDATE task_plans SET position=position+1,updated_at=? WHERE id=?')
        .run(this.dependencies.now(), id);
      const next = this.currentStep(this.get(id));
      this.db.prepare("UPDATE task_steps SET status='ACTIVE' WHERE id=?").run(next.id);
      if (readmit) this.state(id, 'QUEUED', 'NEXT_STEP_REQUIRES_ADMISSION');
    } else if (plan.snapshot.loop.mode === 'finite' && plan.round >= plan.snapshot.loop.rounds) {
      const failed = this.steps(id).some(
        (step) => step.status === 'FAILED' || step.status === 'SKIPPED',
      );
      this.state(id, failed ? 'FAILED' : 'COMPLETED', failed ? 'PARTIAL_STEP_FAILURE' : '');
      this.unlock(id);
    } else {
      this.createRound(plan, plan.round + 1);
      this.db
        .prepare('UPDATE task_plans SET round=round+1,position=0,updated_at=? WHERE id=?')
        .run(this.dependencies.now(), id);
      const next = this.currentStep(this.get(id));
      this.db.prepare("UPDATE task_steps SET status='ACTIVE' WHERE id=?").run(next.id);
      if (readmit) this.state(id, 'QUEUED', 'NEXT_STEP_REQUIRES_ADMISSION');
    }
  }
}

type TaskRepository = SynchronousRepository<CompatibleTaskRepository>;
