import type { SynchronousRepository } from '../domain/persistence.js';
import type { DatabaseSync } from 'node:sqlite';
import type { TaskControlRepository as CompatibleTaskControlRepository } from '../domain/task-control.js';
import type { TaskRepository as CompatibleTaskRepository } from '../domain/tasks.js';
import { ProductError } from '../domain/workspace.js';
import {
  TaskControlBinding,
  SessionStopReceipt,
  sameControl,
  sameStop,
  type ControlBinding,
  type StopReceipt,
} from '../shared/task-control.js';
import { transaction } from './sqlite-transaction.js';

export class SqliteTaskControlRepository implements TaskControlRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tasks: TaskRepository,
  ) {}
  list() {
    return this.db
      .prepare(
        'SELECT b.body,r.body AS receipt FROM task_control_bindings b LEFT JOIN task_control_receipts r USING(request_id) ORDER BY b.created_at,b.request_id',
      )
      .all()
      .map((row) => ({
        binding: TaskControlBinding.parse(JSON.parse(String(row.body)) as unknown),
        receipt:
          row.receipt === null
            ? null
            : SessionStopReceipt.parse(JSON.parse(String(row.receipt)) as unknown),
      }));
  }
  private get(requestId: string) {
    const row = this.db
      .prepare(
        'SELECT b.body,r.body AS receipt FROM task_control_bindings b LEFT JOIN task_control_receipts r USING(request_id) WHERE b.request_id=?',
      )
      .get(requestId);
    if (!row) return undefined;
    return {
      binding: TaskControlBinding.parse(JSON.parse(String(row.body)) as unknown),
      receipt:
        row.receipt === null
          ? null
          : SessionStopReceipt.parse(JSON.parse(String(row.receipt)) as unknown),
    };
  }
  private pending(binding: ControlBinding) {
    const plan = this.tasks.get(binding.jobId);
    if (
      plan.profileId !== binding.profileId ||
      plan.accountId !== binding.accountId ||
      plan.controlRequestId !== binding.requestId ||
      plan.controlMode !== binding.mode ||
      plan.controlConfirmed ||
      !['PAUSING', 'STOPPING'].includes(plan.state)
    )
      throw new ProductError('CONTROL_BINDING_NOT_CURRENT', '停止绑定不对应当前待确认请求', 409);
    return plan;
  }
  bind(input: ControlBinding): void {
    const binding = TaskControlBinding.parse(input);
    transaction(this.db, () => {
      this.pending(binding);
      const existing = this.get(binding.requestId);
      if (existing) {
        if (!sameControl(existing.binding, binding))
          throw new ProductError('CONTROL_BINDING_CONFLICT', '停止请求原始绑定不可更改', 409);
        return;
      }
      this.db
        .prepare('INSERT INTO task_control_bindings VALUES(?,?,?,?,?)')
        .run(
          binding.requestId,
          binding.jobId,
          binding.profileId,
          JSON.stringify(binding),
          Date.now(),
        );
    });
  }
  confirm(input: ControlBinding, value: StopReceipt) {
    const binding = TaskControlBinding.parse(input),
      receipt = SessionStopReceipt.parse(value);
    return transaction(this.db, () => {
      const existing = this.get(binding.requestId);
      if (!existing || !sameControl(existing.binding, binding) || !sameStop(binding, receipt))
        throw new ProductError('CONTROL_RECEIPT_MISMATCH', '实际停止回执与原始会话绑定不一致', 409);
      if (existing.receipt) {
        const plan = this.tasks.get(binding.jobId);
        if (
          !sameStop(existing.receipt, receipt) ||
          plan.controlRequestId !== binding.requestId ||
          !plan.controlConfirmed
        )
          throw new ProductError('STALE_CONTROL_RECEIPT', '停止回执已过期', 409);
        return plan;
      }
      this.pending(binding);
      this.db
        .prepare('INSERT INTO task_control_receipts VALUES(?,?,?)')
        .run(binding.requestId, JSON.stringify(receipt), Date.now());
      // Receipt and plan confirmation commit together; UNKNOWN still retains its account lock.
      return this.tasks.confirmControl(binding.jobId, binding.requestId);
    });
  }
}

type TaskControlRepository = SynchronousRepository<CompatibleTaskControlRepository>;
type TaskRepository = SynchronousRepository<CompatibleTaskRepository>;
