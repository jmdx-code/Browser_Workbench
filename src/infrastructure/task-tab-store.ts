import type { SynchronousRepository } from '../domain/persistence.js';
import type { DatabaseSync } from 'node:sqlite';
import {
  OwnedTabProof,
  KernelPersistentState,
  kernelOperationPending,
  type TabProof,
  type KernelState,
} from '../shared/kernel-state.js';
import {
  ExecutionContext,
  DispatchBinding,
  sameBinding,
  sameExecution,
  type Binding,
  type ExecutionSession,
} from '../shared/task-execution.js';
import { TaskTabRecord, type TaskTab } from '../shared/task-tabs.js';
import {
  sameTabProof,
  assertTaskTabInput,
  TaskTabRepository as CompatibleTaskTabRepository,
} from '../domain/task-tabs.js';
import { ProductError } from '../domain/workspace.js';
import { transaction } from './sqlite-transaction.js';
import type { SqliteTaskRepository } from './task-store.js';
import { assertPostDispatch, postLink } from './material-post-guards.js';
import { CurrentStopReceipt } from '../shared/task-ending.js';
import {
  SessionStopReceipt,
  TaskControlBinding,
  sameStop,
  type StopReceipt,
} from '../shared/task-control.js';

export class SqliteTaskTabRepository implements TaskTabRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tasks: SqliteTaskRepository,
  ) {}
  get(ownershipId: string, jobId?: string): TaskTab {
    const rows = this.db
      .prepare(
        'SELECT o.*,s.state,s.revision,s.context,s.reason,s.updated_at FROM task_tab_ownership o JOIN task_tab_state s USING(ownership_id,job_id) WHERE ownership_id=? AND (? IS NULL OR job_id=?) LIMIT 2',
      )
      .all(ownershipId, jobId ?? null, jobId ?? null);
    if (rows.length > 1)
      throw new ProductError('TASK_TAB_PLAN_REQUIRED', '该页面有多份历史任务，请指定原任务', 409);
    const row = rows[0];
    if (!row) throw new ProductError('TASK_TAB_NOT_FOUND', '专用任务标签页记录不存在', 404);
    return TaskTabRecord.parse({
      jobId: row.job_id,
      accountId: row.account_id,
      proof: JSON.parse(String(row.proof)) as unknown,
      state: row.state,
      revision: row.revision,
      context: row.context === null ? null : (JSON.parse(String(row.context)) as unknown),
      reason: row.reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  forPlan(jobId: string): TaskTab[] {
    this.tasks.get(jobId);
    return this.db
      .prepare(
        'SELECT ownership_id FROM task_tab_ownership WHERE job_id=? ORDER BY created_at,ownership_id',
      )
      .all(jobId)
      .map((row) => this.get(String(row.ownership_id), jobId));
  }
  activeForProfile(profileId: string): TaskTab[] {
    return this.db
      .prepare(
        "SELECT o.ownership_id,o.job_id FROM task_tab_state s JOIN task_tab_ownership o USING(ownership_id,job_id) WHERE s.profile_id=? AND s.state IN ('READY','RECHECK_REQUIRED') ORDER BY o.created_at,o.ownership_id,o.job_id",
      )
      .all(profileId)
      .map((row) => this.get(String(row.ownership_id), String(row.job_id)));
  }
  private checkPlan(jobId: string, proof: TabProof, context: ExecutionSession, creating = false) {
    const plan = this.tasks.get(jobId);
    if (
      plan.profileId !== proof.profileId ||
      context.profileId !== proof.profileId ||
      !plan.accountId ||
      plan.accountId !== context.accountId ||
      (creating
        ? plan.state !== 'RUNNING'
        : !['RUNNING', 'PAUSED', 'REVIEW', 'PAUSING', 'STOPPING'].includes(plan.state))
    )
      throw new ProductError(
        'TASK_TAB_PLAN_MISMATCH',
        '任务资料、账号或状态不允许接入该标签页',
        409,
      );
    return plan;
  }
  register(jobId: string, input: TabProof, session: ExecutionSession): TaskTab {
    const proof = OwnedTabProof.parse(input),
      context = ExecutionContext.parse(session);
    return transaction(this.db, () => {
      this.reconcileSettledTerminalTabs(proof.profileId);
      this.checkPlan(jobId, proof, context, true);
      if (
        this.db
          .prepare('SELECT ownership_id FROM task_tab_ownership WHERE ownership_id=? AND job_id=?')
          .get(proof.ownershipId, jobId)
      ) {
        const row = this.get(proof.ownershipId, jobId);
        if (
          row.jobId !== jobId ||
          row.accountId !== context.accountId ||
          !sameTabProof(row.proof, proof)
        )
          throw new ProductError('TASK_TAB_ID_CONFLICT', '标签页归属ID已关联其他内容', 409);
        if (row.state === 'RELEASED') {
          const previous = this.db
            .prepare(
              'SELECT release_receipt,last_context FROM task_tab_state WHERE ownership_id=? AND job_id=?',
            )
            .get(proof.ownershipId, jobId);
          const raw = previous?.release_receipt;
          const previousContext = previous?.last_context
            ? ExecutionContext.parse(JSON.parse(String(previous.last_context)))
            : null;
          const value = raw ? JSON.parse(String(raw)) : null;
          const release = SessionStopReceipt.safeParse(value);
          const endedRelease = CurrentStopReceipt.safeParse(value);
          const released = release.success ? release.data : null;
          const plan = this.tasks.get(jobId);
          if (
            ((released && !sameExecution(released, context)) ||
              (endedRelease.success &&
                endedRelease.data.profileId === context.profileId &&
                previousContext &&
                !sameExecution(previousContext, context))) &&
            plan.controlRequestId === null &&
            plan.controlMode === null &&
            !plan.controlConfirmed
          ) {
            return this.change(
              proof.ownershipId,
              row.revision,
              () => ({ state: 'READY', context, reason: 'RESUMED_TASK_NEW_INPUT_CONTEXT' }),
              jobId,
            );
          }
        }
        return row; // Duplicate registration never renews an already active context.
      }
      const previous = this.db
        .prepare('SELECT job_id FROM task_tab_ownership WHERE ownership_id=?')
        .all(proof.ownershipId);
      for (const entry of previous) {
        const row = this.get(proof.ownershipId, String(entry.job_id));
        const endedLost =
          row.state === 'LOST' && row.reason === 'ENDED_OWNERSHIP_RELEASED' && this.ended(row);
        if (endedLost) this.assertSettled(row, true);
        if (
          (row.state !== 'RELEASED' && !endedLost) ||
          !sameTabProof(row.proof, proof) ||
          !['PAUSED', 'STOPPED', 'COMPLETED', 'FAILED'].includes(this.tasks.get(row.jobId).state)
        )
          throw new ProductError('TASK_TAB_REUSE_UNCONFIRMED', '原任务尚未释放此页面的控制', 409);
      }
      if (
        this.db
          .prepare(
            "SELECT ownership_id FROM task_tab_state WHERE profile_id=? AND state IN ('READY','RECHECK_REQUIRED')",
          )
          .get(proof.profileId)
      )
        throw new ProductError('TASK_TAB_ALREADY_OWNED', '该资料已有未释放的专用任务标签页', 409);
      if (
        this.tasks
          .blockingOperations(jobId)
          .some((op) => ['DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN'].includes(op.status))
      )
        throw new ProductError(
          'TASK_TAB_UNSETTLED_OPERATION',
          '未决操作核对前不能创建新标签页归属',
          409,
        );
      const now = Date.now();
      this.db
        .prepare('INSERT INTO task_tab_ownership VALUES(?,?,?,?,?)')
        .run(proof.ownershipId, jobId, context.accountId, JSON.stringify(proof), now);
      this.db
        .prepare('INSERT INTO task_tab_state VALUES(?,?,?,?,0,?,?,?,?,NULL)')
        .run(
          proof.ownershipId,
          jobId,
          proof.profileId,
          'READY',
          JSON.stringify(context),
          'OWNED_PROOF_CONFIRMED',
          now,
          JSON.stringify(context),
        );
      return this.get(proof.ownershipId, jobId);
    });
  }
  private change(
    ownershipId: string,
    expectedRevision: number,
    work: (row: TaskTab) => Pick<TaskTab, 'state' | 'context' | 'reason'>,
    jobId?: string,
  ): TaskTab {
    return transaction(this.db, () => {
      const row = this.get(ownershipId, jobId);
      if (row.revision !== expectedRevision)
        throw new ProductError('TASK_TAB_REVISION_CONFLICT', '标签页核对记录已变化', 409);
      const next = work(row);
      TaskTabRecord.parse({ ...row, ...next });
      this.db
        .prepare(
          'UPDATE task_tab_state SET state=?,last_context=COALESCE(?,context,last_context),context=?,reason=?,revision=revision+1,updated_at=? WHERE ownership_id=? AND job_id=? AND revision=?',
        )
        .run(
          next.state,
          next.context === null ? null : JSON.stringify(next.context),
          next.context === null ? null : JSON.stringify(next.context),
          next.reason,
          Date.now(),
          ownershipId,
          row.jobId,
          expectedRevision,
        );
      return this.get(ownershipId, row.jobId);
    });
  }
  requireRecheck(id: string, revision: number, reason: string, jobId?: string): TaskTab {
    return this.change(
      id,
      revision,
      (row) => {
        if (!['READY', 'RECHECK_REQUIRED'].includes(row.state))
          throw new ProductError('TASK_TAB_TERMINAL', '失效或关闭的标签页不能重新接管', 409);
        return { state: 'RECHECK_REQUIRED', context: null, reason };
      },
      jobId,
    );
  }
  confirmObserved(
    id: string,
    revision: number,
    input: TabProof,
    session: ExecutionSession,
    jobId?: string,
  ): TaskTab {
    const proof = OwnedTabProof.parse(input),
      context = ExecutionContext.parse(session);
    return this.change(
      id,
      revision,
      (row) => {
        if (!['READY', 'RECHECK_REQUIRED'].includes(row.state))
          throw new ProductError('TASK_TAB_TERMINAL', '失效或关闭的标签页不能重新接管', 409);
        if (!sameTabProof(row.proof, proof))
          throw new ProductError(
            'TASK_TAB_PROOF_MISMATCH',
            '标签页目标或浏览器会话已变化，不能接管',
            409,
          );
        this.checkPlan(row.jobId, proof, context);
        return { state: 'READY', context, reason: 'CURRENT_OWNED_PROOF_OBSERVED' };
      },
      jobId,
    );
  }
  markLost(id: string, revision: number, reason: string, jobId?: string): TaskTab {
    return this.change(
      id,
      revision,
      (row) => {
        if (row.state === 'CLOSED' || row.state === 'RELEASED')
          throw new ProductError('TASK_TAB_TERMINAL', '已关闭记录不能改变归属', 409);
        return { state: 'LOST', context: null, reason };
      },
      jobId,
    );
  }
  private ended(row: TaskTab): boolean {
    const plan = this.tasks.get(row.jobId);
    const ending = this.db
      .prepare('SELECT ending_id,ending_stop FROM task_plans WHERE id=?')
      .get(row.jobId);
    const stopped = ending?.ending_stop
      ? CurrentStopReceipt.safeParse(JSON.parse(String(ending.ending_stop)))
      : null;
    return (
      (plan.state === 'FAILED' ||
        (plan.state === 'STOPPED' && plan.controlConfirmed) ||
        (plan.state === 'STOPPING' && this.tasks.stepEnding(plan.id)?.finished === true)) &&
      stopped?.success === true &&
      stopped.data.profileId === plan.profileId &&
      stopped.data.requestId === ending?.ending_id
    );
  }
  private assertSettled(row: TaskTab, ended: boolean): void {
    const notices = ended ? this.tasks.settlements.list(row.proof.profileId) : [];
    if (
      this.tasks.operations(row.jobId).some((op) => {
        if (['DISPATCHING', 'ACKNOWLEDGED'].includes(op.status)) return true;
        if (op.status !== 'UNKNOWN') return false;
        const binding = op.binding;
        return (
          !ended ||
          !binding ||
          !op.disposition ||
          !notices.some(
            (notice) =>
              notice.state === 'DELIVERED' &&
              sameBinding(notice.binding, binding) &&
              JSON.stringify(notice.resolution) === JSON.stringify(op.disposition),
          )
        );
      })
    )
      throw new ProductError(
        'TASK_TAB_UNSETTLED_OPERATION',
        '未决操作摘要须先核对，不能释放归属',
        409,
      );
  }
  confirmEndedLost(id: string, revision: number, input: KernelState, jobId?: string): TaskTab {
    const inventory = KernelPersistentState.parse(input);
    return this.change(
      id,
      revision,
      (row) => {
        if (
          !['READY', 'RECHECK_REQUIRED'].includes(row.state) ||
          !this.ended(row) ||
          inventory.profileId !== row.proof.profileId ||
          inventory.operations.some(kernelOperationPending) ||
          inventory.tabs.some(
            (tab) =>
              !['CLOSED', 'LOST'].includes(tab.state) &&
              !(
                tab.state === 'READY' &&
                tab.proof &&
                inventory.workspaceMain &&
                sameTabProof(tab.proof, inventory.workspaceMain) &&
                !sameTabProof(tab.proof, row.proof)
              ),
          )
        )
          throw new ProductError(
            'TASK_TAB_END_UNCONFIRMED',
            '当前控制或原结束处置未确认，不能释放历史占用',
            409,
          );
        this.assertSettled(row, true);
        return { state: 'LOST', context: null, reason: 'ENDED_OWNERSHIP_RELEASED' };
      },
      jobId,
    );
  }
  confirmEndedReleased(id: string, revision: number, input: KernelState, jobId: string): TaskTab {
    const inventory = KernelPersistentState.parse(input);
    return this.change(
      id,
      revision,
      (row) => {
        const native = inventory.tabs.find((tab) => tab.ownershipId === row.proof.ownershipId);
        if (
          (!['READY', 'RECHECK_REQUIRED'].includes(row.state) &&
            !(row.state === 'LOST' && row.reason === 'ENDED_OWNERSHIP_RELEASED')) ||
          !this.ended(row) ||
          inventory.profileId !== row.proof.profileId ||
          inventory.operations.some(kernelOperationPending) ||
          native?.state !== 'READY' ||
          !native.proof ||
          !sameTabProof(native.proof, row.proof) ||
          (inventory.workspaceMain && !sameTabProof(inventory.workspaceMain, row.proof))
        )
          throw new ProductError(
            'TASK_TAB_END_UNCONFIRMED',
            '当前停止与原结束处置未确认，不能保留主页面',
            409,
          );
        this.assertSettled(row, true);
        const raw = this.db
          .prepare('SELECT ending_stop FROM task_plans WHERE id=?')
          .get(row.jobId)?.ending_stop;
        const stop = CurrentStopReceipt.parse(JSON.parse(String(raw)));
        this.db
          .prepare('UPDATE task_tab_state SET release_receipt=? WHERE ownership_id=? AND job_id=?')
          .run(JSON.stringify(stop), row.proof.ownershipId, row.jobId);
        return { state: 'RELEASED', context: null, reason: 'ENDED_CONTROL_RELEASED_PAGE_RETAINED' };
      },
      jobId,
    );
  }
  confirmClosed(id: string, revision: number, input: KernelState, jobId?: string): TaskTab {
    const inventory = KernelPersistentState.parse(input);
    return this.change(
      id,
      revision,
      (row) => {
        if (row.state === 'RELEASED')
          throw new ProductError('TASK_TAB_TERMINAL', '已释放的原任务记录不能重新处置页面', 409);
        const native = inventory.tabs.find((tab) => tab.ownershipId === id);
        const ended = this.ended(row);
        // Inventory must come from the authenticated adapter, never a renderer submission.
        if (
          inventory.profileId !== row.proof.profileId ||
          (inventory.browserSessionEpoch !== row.proof.browserSessionEpoch && !ended) ||
          native?.state !== 'CLOSED' ||
          !native.proof ||
          !sameTabProof(native.proof, row.proof)
        )
          throw new ProductError(
            'TASK_TAB_CLOSE_UNCONFIRMED',
            '没有匹配原生目标的标签页关闭证据',
            409,
          );
        this.assertSettled(row, ended);
        return { state: 'CLOSED', context: null, reason: 'NATIVE_TAB_CLOSED_CONFIRMED' };
      },
      jobId,
    );
  }
  confirmReleased(
    id: string,
    revision: number,
    input: KernelState,
    inputStop: StopReceipt,
    jobId: string,
  ): TaskTab {
    const inventory = KernelPersistentState.parse(input),
      stop = SessionStopReceipt.parse(inputStop);
    return this.change(
      id,
      revision,
      (row) => {
        const plan = this.tasks.get(jobId),
          saved = this.db
            .prepare('SELECT body FROM task_control_bindings WHERE request_id=?')
            .get(stop.requestId),
          control = saved ? TaskControlBinding.parse(JSON.parse(String(saved.body))) : null,
          last = this.db
            .prepare('SELECT last_context FROM task_tab_state WHERE ownership_id=? AND job_id=?')
            .get(id, jobId)?.last_context,
          expected = last ? ExecutionContext.parse(JSON.parse(String(last))) : null,
          native = inventory.tabs.find((tab) => tab.ownershipId === id);
        if (
          !['READY', 'RECHECK_REQUIRED'].includes(row.state) ||
          !expected ||
          !sameExecution(expected, stop) ||
          (plan.state !== 'COMPLETED' &&
            !(plan.state === 'FAILED' && plan.reason === 'PARTIAL_STEP_FAILURE') &&
            (!['PAUSING', 'STOPPING', 'PAUSED', 'STOPPED'].includes(plan.state) ||
              plan.controlRequestId !== stop.requestId ||
              !control ||
              control.jobId !== jobId ||
              !sameStop(control, stop) ||
              control.accountId !== row.accountId)) ||
          inventory.profileId !== row.proof.profileId ||
          inventory.browserSessionEpoch !== row.proof.browserSessionEpoch ||
          native?.state !== 'READY' ||
          !native.proof ||
          !sameTabProof(native.proof, row.proof) ||
          inventory.operations.some(kernelOperationPending)
        )
          throw new ProductError(
            'TASK_TAB_RELEASE_UNCONFIRMED',
            '当前停止与原页面保留证据不匹配',
            409,
          );
        this.assertSettled(row, false);
        this.db
          .prepare('UPDATE task_tab_state SET release_receipt=? WHERE ownership_id=? AND job_id=?')
          .run(JSON.stringify(stop), id, jobId);
        return {
          state: 'RELEASED',
          context: null,
          reason: 'NATIVE_CONTROL_RELEASED_PAGE_RETAINED',
        };
      },
      jobId,
    );
  }
  private reconcileSettledTerminalTabs(profileId?: string): void {
    const rows = profileId
      ? this.db
          .prepare(
            "SELECT ownership_id,job_id,last_context,release_receipt FROM task_tab_state WHERE profile_id=? AND state IN ('READY','RECHECK_REQUIRED')",
          )
          .all(profileId)
      : this.db
          .prepare(
            "SELECT ownership_id,job_id,last_context,release_receipt FROM task_tab_state WHERE state IN ('READY','RECHECK_REQUIRED')",
          )
          .all();
    const now = Date.now();
    for (const item of rows) {
      const ownershipId = String(item.ownership_id);
      const jobId = String(item.job_id);
      try {
        const plan = this.tasks.get(jobId);
        if (
          (plan.state === 'COMPLETED' ||
            (plan.state === 'FAILED' && plan.reason === 'PARTIAL_STEP_FAILURE')) &&
          !this.tasks
            .operations(jobId)
            .some((op) => ['DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN'].includes(op.status))
        ) {
          let receipt = item.release_receipt ? String(item.release_receipt) : null;
          if (!receipt && item.last_context) {
            const parsed = ExecutionContext.safeParse(JSON.parse(String(item.last_context)));
            if (parsed.success) {
              receipt = JSON.stringify({
                ...parsed.data,
                requestId: plan.controlRequestId ?? plan.id,
                state: 'stopped',
              });
            }
          }
          this.db
            .prepare(
              "UPDATE task_tab_state SET state='RELEASED',context=NULL,reason='NATIVE_CONTROL_RELEASED_PAGE_RETAINED',release_receipt=COALESCE(release_receipt,?),revision=revision+1,updated_at=? WHERE ownership_id=? AND job_id=?",
            )
            .run(receipt, now, ownershipId, jobId);
        }
      } catch {
        // Leave non-reconcilable rows untouched for explicit inspection.
      }
    }
  }
  recoverOnStartup(): void {
    // Explicit lifecycle only, never on repository open/read. Preserve every original proof.
    transaction(this.db, () => {
      this.db
        .prepare(
          "UPDATE task_tab_state SET state='RECHECK_REQUIRED',context=NULL,reason='SERVICE_RESTART',revision=revision+1,updated_at=? WHERE state='READY'",
        )
        .run(Date.now());
      this.reconcileSettledTerminalTabs();
    });
  }
  assertForInput(input: Binding, proof: TabProof): void {
    const binding = DispatchBinding.parse(input),
      row = this.get(proof.ownershipId, binding.jobId);
    assertTaskTabInput(row, binding, OwnedTabProof.parse(proof));
    const plan = this.tasks.get(row.jobId);
    const operation = this.tasks.findOperation(row.jobId, binding.operationId);
    if (
      plan.state !== 'RUNNING' ||
      plan.accountId !== binding.accountId ||
      !operation?.binding ||
      !sameBinding(operation.binding, binding) ||
      operation.status !== 'DISPATCHING' ||
      !('tabId' in operation.action) ||
      operation.action.tabId !== row.proof.tabId ||
      operation.stepId !== binding.stepId ||
      this.tasks
        .blockingOperations(row.jobId)
        .some(
          (op) =>
            op.id !== binding.operationId &&
            ['DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN'].includes(op.status),
        )
    )
      throw new ProductError('TASK_TAB_INPUT_REJECTED', '计划或派发操作不允许当前标签页输入', 409);
    if (postLink(this.db, binding.operationId))
      assertPostDispatch(this.db, binding.operationId, binding);
  }
}

type TaskTabRepository = SynchronousRepository<CompatibleTaskTabRepository>;
