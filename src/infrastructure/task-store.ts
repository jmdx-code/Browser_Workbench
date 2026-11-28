import type { SynchronousRepository } from '../domain/persistence.js';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { TaskStepV2 } from '../shared/task-policies.js';
import * as TC from '../shared/task-contracts.js';
import * as DT from '../domain/tasks.js';
import { ProductError } from '../domain/workspace.js';
import { SqliteTaskResourceRepository } from './task-resource-store.js';
import { isUncommittedTransaction, transaction } from './sqlite-transaction.js';
import { prepareCached } from './sqlite-statement-cache.js';
import * as Q from './persistence/sqlite-query-helpers.js';
import * as Ops from './stores/task-store-operations.js';
const mapStepRow = (row: Record<string, unknown>): TC.StepInstance =>
  TaskStepV2.parse(Q.camel(row, '', 'spec,progress,outcome', 'outcome'));
const lruGet = <T>(map: Map<string, T>, key: string): T | undefined => {
  const val = map.get(key);
  if (val !== undefined) {
    map.delete(key);
    map.set(key, val);
  }
  return val;
};
const lruSet = <T>(map: Map<string, T>, key: string, val: T): void => {
  map.set(key, val);
  if (map.size > 1024) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
};
export class SqliteTaskRepository implements TaskRepository {
  readonly resources: SqliteTaskResourceRepository;
  private readonly instanceEpoch = randomUUID().slice(0, 8);
  private hasCloseBrowserColumnCache: boolean | null = null;
  private readonly planRowCache = new Map<string, { key: string; plan: TC.Plan }>();
  constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: Ops.TaskStoreDependencies = {
      id: randomUUID,
      now: Date.now,
      random: Math.random,
    },
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_account_likes( account_id TEXT NOT NULL, target_key TEXT NOT NULL, liked_at INTEGER NOT NULL, PRIMARY KEY(account_id, target_key) );
      CREATE INDEX IF NOT EXISTS task_account_likes_time ON task_account_likes(liked_at);
      CREATE TABLE IF NOT EXISTS direct_material_publications( id TEXT PRIMARY KEY, job_id TEXT NOT NULL, step_id TEXT NOT NULL, account_id TEXT NOT NULL, combination_id TEXT NOT NULL, fingerprint TEXT NOT NULL, post_id TEXT NOT NULL, usage_generation INTEGER NOT NULL DEFAULT 0, usage_source_key TEXT NOT NULL, allow_repeat INTEGER NOT NULL DEFAULT 0, resource_origin TEXT, created_at INTEGER NOT NULL );
      CREATE INDEX IF NOT EXISTS direct_pub_source ON direct_material_publications(usage_source_key, usage_generation); CREATE INDEX IF NOT EXISTS direct_pub_account_fp ON direct_material_publications(account_id, fingerprint);
    `);
    this.resources = new SqliteTaskResourceRepository(db);
  }
  private ctx(): Ops.TaskStoreContext {
    return {
      db: this.db,
      dependencies: this.dependencies,
      instanceEpoch: this.instanceEpoch,
      resources: this.resources,
      stmt: this.stmt,
      getPlan: (id) => this.get(id),
      livePlans: this.livePlans,
      plansForBatch: this.plansForBatch,
      plansForProfile: (p, s) => this.plansForProfile(p, s),
      currentStepForPlan: (id, r, pos) => this.currentStepForPlan(id, r, pos),
      currentStep: (p, sid) => this.currentStep(p, sid),
      steps: (id, r) => this.steps(id, r),
      createRound: (p, r) => this.createRound(p, r),
      state: (id, s, r) => this.state(id, s, r),
      event: (id, t, d) => this.event(id, t, d),
      unlock: this.unlock,
      settings: this.settings,
      hasCloseBrowserColumn: this.hasCloseBrowserColumn,
    };
  }
  private stmt = (sql: string) => prepareCached(this.db, sql);
  recordsPage = (input: unknown, profiles: readonly DT.RecordProfile[]) =>
    Ops.queryTaskRecordsPage(this.ctx(), input, profiles);
  private hasCloseBrowserColumn = (): boolean =>
    (this.hasCloseBrowserColumnCache ??= Q.tableColumns(this.db, 'task_plans').has(
      'close_browser_on_finish',
    ));
  private event(id: string, type: string, detail: TC.Operation['receipt'] = null) {
    this.stmt('INSERT INTO task_events(job_id,type,detail,created_at) VALUES(?,?,?,?)').run(
      id,
      type,
      JSON.stringify(detail),
      this.dependencies.now(),
    );
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
  private state(id: string, state: TC.Plan['state'], reason: string) {
    this.stmt('UPDATE task_plans SET state=?,reason=?,updated_at=? WHERE id=?').run(
      state,
      reason,
      this.dependencies.now(),
      id,
    );
    this.event(id, state, { reason });
  }
  private unlock = (id: string) => {
    this.stmt('DELETE FROM task_account_locks WHERE job_id=?').run(id);
  };
  ensurePlanExists(id: string): void {
    if (!this.stmt('SELECT 1 FROM task_plans WHERE id=?').get(id)) {
      this.planRowCache.delete(id);
      throw new ProductError('TASK_NOT_FOUND', '任务计划不存在', 404);
    }
  }
  private parsePlanRow(row: Record<string, unknown>): TC.Plan {
    const id = String(row.id),
      inWriteTx = isUncommittedTransaction(this.db);
    if (inWriteTx) this.planRowCache.delete(id);
    const closeBrowserOnFinish = row.close_browser_on_finish === 1;
    const cacheKey = [
      row.state,
      row.updated_at,
      row.reason,
      row.control_mode,
      row.control_request_id ?? '',
      row.control_confirmed,
      row.round,
      row.position,
      closeBrowserOnFinish ? '1' : '0',
    ]
      .map(String)
      .join(':');
    if (!inWriteTx) {
      const cached = this.planRowCache.get(id);
      if (cached?.key === cacheKey) return lruGet(this.planRowCache, id)?.plan ?? cached.plan;
    }
    const rs = String(row.state),
      mappedState: TC.Plan['state'] =
        rs === 'QUEUED' ||
        rs === 'RUNNING' ||
        rs === 'STOPPED' ||
        rs === 'COMPLETED' ||
        rs === 'FAILED'
          ? rs
          : 'STOPPED';
    const plan = TC.TaskPlan.parse({
      id,
      batchId: row.batch_id,
      profileId: row.profile_id,
      combinationId: row.combination_id,
      version: row.version,
      accountId: row.account_id,
      snapshot: JSON.parse(String(row.snapshot)) as unknown,
      state: mappedState,
      reason: row.reason,
      controlMode: row.control_mode,
      controlRequestId: row.control_request_id,
      controlConfirmed: Q.b(row.control_confirmed),
      round: row.round,
      position: row.position,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(closeBrowserOnFinish ? { closeBrowserOnFinish: true } : {}),
    });
    if (!inWriteTx) lruSet(this.planRowCache, id, { key: cacheKey, plan });
    return plan;
  }
  get(id: string): TC.Plan {
    const row = this.stmt('SELECT * FROM task_plans WHERE id=?').get(id);
    if (!row) {
      this.planRowCache.delete(id);
      throw new ProductError('TASK_NOT_FOUND', '任务计划不存在', 404);
    }
    return this.parsePlanRow(row);
  }
  batchExists = (batchId: string): boolean =>
    Boolean(
      this.stmt(
        'SELECT 1 FROM task_batches WHERE id=? UNION ALL SELECT 1 FROM task_plans WHERE batch_id=? LIMIT 1',
      ).get(batchId, batchId),
    );
  plansForBatch = (batchId: string): TC.Plan[] =>
    this.stmt('SELECT * FROM task_plans WHERE batch_id=? ORDER BY created_at,rowid')
      .all(batchId)
      .map((r) => this.parsePlanRow(r));
  plansForProfile(profileId: string, states?: readonly TC.Plan['state'][]): TC.Plan[] {
    if (states !== undefined) {
      if (!states.length) return [];
      const sql = `SELECT * FROM task_plans WHERE profile_id=? AND state IN (${states.map(() => '?').join(',')}) ORDER BY created_at,rowid`;
      return this.db
        .prepare(sql)
        .all(profileId, ...states)
        .map((r) => this.parsePlanRow(r));
    }
    return this.stmt('SELECT * FROM task_plans WHERE profile_id=? ORDER BY created_at,rowid')
      .all(profileId)
      .map((r) => this.parsePlanRow(r));
  }
  hasProfilePlanInStates = (profileId: string, states: readonly TC.Plan['state'][]): boolean => {
    const sql = `SELECT 1 FROM task_plans WHERE profile_id=? AND state IN (${states.map(() => '?').join(',')}) LIMIT 1`;
    return states.length > 0 && Boolean(this.db.prepare(sql).get(profileId, ...states));
  };
  list = () =>
    this.stmt('SELECT * FROM task_plans ORDER BY created_at,rowid')
      .all()
      .map((r) => this.parsePlanRow(r));
  livePlans = () => {
    const sql =
      "SELECT * FROM task_plans WHERE state NOT IN ('STOPPED','COMPLETED','FAILED') ORDER BY created_at,rowid";
    return this.stmt(sql)
      .all()
      .map((r) => this.parsePlanRow(r));
  };
  cacheStateToken = (): string | null =>
    this.db.isTransaction
      ? null
      : `${this.instanceEpoch}:${String(this.stmt('PRAGMA data_version').get()?.data_version)}:${String(this.stmt('SELECT total_changes() AS n').get()?.n)}`;
  currentStepForPlan(id: string, round: number, position: number): TC.StepInstance | null {
    const sql = 'SELECT * FROM task_steps WHERE job_id=? AND round=? AND position=?';
    const row = this.stmt(sql).get(id, round, position);
    return row ? mapStepRow(row) : null;
  }
  runtimeSnapshot = (options: TC.RuntimeRequest = {}): DT.RuntimeSnapshotResult =>
    Ops.buildTaskRuntimeSnapshot(this.ctx(), options);
  settings = () => {
    const sql = 'SELECT max_concurrent_profiles FROM scheduler_settings WHERE id=1';
    return TC.SchedulerSettings.parse({
      maxConcurrentProfiles: this.stmt(sql).get()?.max_concurrent_profiles,
    });
  };
  setSettings = (value: TC.Settings) => {
    const n = TC.SchedulerSettings.parse(value).maxConcurrentProfiles;
    this.stmt('UPDATE scheduler_settings SET max_concurrent_profiles=? WHERE id=1').run(n);
  };
  events(id: string) {
    this.ensurePlanExists(id);
    return this.stmt('SELECT * FROM task_events WHERE job_id=? ORDER BY sequence')
      .all(id)
      .map((r) => TC.TaskEvent.parse(Q.camel(r, '', 'detail')));
  }
  steps(id: string, round?: number) {
    this.ensurePlanExists(id);
    const rows =
      round === undefined
        ? this.stmt('SELECT * FROM task_steps WHERE job_id=? ORDER BY round,position').all(id)
        : this.stmt('SELECT * FROM task_steps WHERE job_id=? AND round=? ORDER BY position').all(
            id,
            round,
          );
    return rows.map(mapStepRow);
  }
  private currentStep(plan: TC.Plan, stepId?: string) {
    const step = this.steps(plan.id, plan.round).find((item) => item.position === plan.position);
    if (!step || (stepId && step.id !== stepId))
      throw new ProductError('STALE_STEP', '子任务已变化', 409);
    return step;
  }
  private createRound(plan: TC.Plan, round: number) {
    const order = DT.orderedSteps(
      plan.snapshot.steps,
      plan.snapshot.randomOrder,
      this.dependencies.random,
    );
    const ins = this.stmt(
      'INSERT INTO task_steps(id,job_id,round,position,spec,status,progress) VALUES(?,?,?,?,?,?,?)',
    );
    const empty = JSON.stringify(DT.emptyProgress());
    for (const [pos, spec] of order.entries())
      ins.run(this.dependencies.id(), plan.id, round, pos, JSON.stringify(spec), 'PENDING', empty);
    this.event(plan.id, 'ROUND_CREATED', { round, stepIds: order.map((step) => step.id) });
  }
  assign = (input: TC.Assignment, profiles: DT.RuntimeProfile[]) =>
    Ops.assignTaskBatch(this.ctx(), input, profiles);
  claimPlanForProfile = (profileId: string, accountId: string | null): TC.Plan | null =>
    Ops.claimTaskPlanForProfile(this.ctx(), profileId, accountId);
  bindPlanAccount = (id: string, accountId: string): TC.Plan =>
    Ops.bindTaskPlanAccount(this.ctx(), id, accountId);
  requeueBusyAccountPlan = (id: string): TC.Plan => Ops.requeueBusyAccountPlan(this.ctx(), id);
  updateStepProgress = (id: string, stepId: string, progress: TC.Progress): void => {
    Ops.updateTaskStepProgress(this.ctx(), id, stepId, progress);
  };
  completeStepDirect = (id: string, stepId: string, finalProgress?: TC.Progress): TC.Plan =>
    Ops.completeTaskStepDirect(this.ctx(), id, stepId, finalProgress);
  skipStepDirect = (
    id: string,
    stepId: string,
    reason:
      | 'DEPENDENCY_FAILED'
      | 'RESOURCE_EXHAUSTED'
      | 'FEATURE_UNAVAILABLE'
      | 'MARKETPLACE_UNAVAILABLE'
      | 'USER_STOP',
    dependencyStepId?: string,
  ): TC.Plan => Ops.skipTaskStepDirect(this.ctx(), id, stepId, reason, dependencyStepId);
  failStepDirect = (
    id: string,
    stepId: string,
    reason: string,
    businessResult: 'NOT_APPLICABLE' | 'PUBLISHED' | 'NOT_PUBLISHED' | 'UNKNOWN' = 'NOT_APPLICABLE',
  ): TC.Plan => Ops.failTaskStepDirect(this.ctx(), id, stepId, reason, businessResult);
  stopPlanDirect = (id: string, reason = 'USER_STOP'): TC.Plan =>
    Ops.stopTaskPlanDirect(this.ctx(), id, reason);
  failPlanDirect = (id: string, reason: string): TC.Plan =>
    Ops.failTaskPlanDirect(this.ctx(), id, reason);
  recordAccountLike = (accountId: string, targetKey: string): void => {
    this.stmt('INSERT OR IGNORE INTO task_account_likes VALUES(?,?,?)').run(
      accountId,
      targetKey,
      this.dependencies.now(),
    );
  };
  hasAccountLiked = (accountId: string, targetKey: string): boolean =>
    Boolean(
      this.stmt('SELECT 1 FROM task_account_likes WHERE account_id=? AND target_key=? LIMIT 1').get(
        accountId,
        targetKey,
      ),
    );
  recordDirectPublication(input: DT.DirectPublicationInput): void {
    transaction(this.db, () => {
      const gen = Number(
        this.stmt('SELECT generation FROM material_usage_policy WHERE id=1').get()?.generation ?? 0,
      );
      const cols =
        'id,job_id,step_id,account_id,combination_id,fingerprint,post_id,usage_generation,usage_source_key,allow_repeat,resource_origin,created_at';
      Q.insertFrom(this.db, 'direct_material_publications', cols, input, {
        id: input.id ?? this.dependencies.id(),
        usage_generation: gen,
        resource_origin: input.resourceOrigin ? JSON.stringify(input.resourceOrigin) : null,
        created_at: this.dependencies.now(),
      });
    });
  }
  private hasPublication(where: string, ...args: SQLInputValue[]): boolean {
    const gen = '(SELECT generation FROM material_usage_policy WHERE id=1)';
    const sql = `SELECT 1 FROM direct_material_publications WHERE ${where} AND usage_generation=${gen} UNION ALL SELECT 1 FROM material_publications WHERE ${where} AND usage_generation=${gen} LIMIT 1`;
    return Boolean(this.stmt(sql).get(...args, ...args));
  }
  hasAccountPublishedFingerprint = (accountId: string, fingerprint: string): boolean =>
    this.hasPublication('account_id=? AND fingerprint=?', accountId, fingerprint);
  isMaterialSourceUsed = (usageSourceKey: string): boolean =>
    this.hasPublication('usage_source_key=?', usageSourceKey);
  recoverOnStartup(_preserveFutureSchedules = true) {
    this.planRowCache.clear();
    transaction(this.db, () => {
      const ctx = this.ctx();
      for (const plan of this.livePlans()) {
        Ops.convergeRemainingStepsToTerminal(ctx, plan.id, 'SOFTWARE_RESTART_STOPPED');
        this.stmt(
          'UPDATE task_plans SET control_mode=NULL,control_request_id=NULL,control_confirmed=0 WHERE id=?',
        ).run(plan.id);
        this.state(plan.id, 'STOPPED', 'SOFTWARE_RESTART_STOPPED');
        this.unlock(plan.id);
      }
    });
  }
}
type TaskRepository = SynchronousRepository<DT.TaskRepository>;
