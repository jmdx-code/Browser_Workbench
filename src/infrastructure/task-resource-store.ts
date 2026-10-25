import type { SynchronousRepository } from '../domain/persistence.js';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { TaskResourceBinding, TaskResourceSnapshot } from '../shared/task-resources.js';
import type { Assignment, Plan } from '../shared/task-contracts.js';
import type { Combination } from '../shared/contracts.js';
import type { TaskResourceRepository as CompatibleTaskResourceRepository } from '../domain/task-resources.js';
import { needsResourceTable } from '../domain/task-resources.js';
import { hasResource } from '../domain/resource-table.js';
import { ProductError } from '../domain/workspace.js';
import { SqliteResourceTableRepository } from './resource-table-store.js';

export class SqliteTaskResourceRepository implements TaskResourceRepository {
  private readonly tables: SqliteResourceTableRepository;
  constructor(private readonly db: DatabaseSync) {
    this.tables = new SqliteResourceTableRepository(db);
  }
  assertAssignment(request: Assignment, snapshot: Combination): number | null {
    if (!needsResourceTable(snapshot)) {
      if (request.expectedResourceRevision !== undefined)
        throw new ProductError('RESOURCE_BINDING_UNEXPECTED', '该组合没有资源表发布步骤', 409);
      return null;
    }
    if (request.expectedResourceRevision === undefined)
      throw new ProductError('RESOURCE_VERSION_REQUIRED', '分配前需要明确资源表版本', 409);
    const table = this.tables.read(request.combinationId);
    if (table.revision !== request.expectedResourceRevision)
      throw new ProductError('RESOURCE_REVISION_CONFLICT', '资源表已修改，请核对后再分配', 409);
    if (!table.rows.some(hasResource))
      throw new ProductError('RESOURCE_TABLE_EMPTY', '资源表没有可分配的内容', 409);
    return table.revision;
  }
  // Called only from the original assignment transaction after plan creation.
  insert(plan: Plan, resourceRevision: number) {
    if (!this.db.isTransaction) throw Error('TASK_RESOURCE_ASSIGNMENT_TRANSACTION_REQUIRED');
    const binding = TaskResourceBinding.parse({
      jobId: plan.id,
      combinationId: plan.combinationId,
      resourceRevision,
      createdAt: plan.createdAt,
    });
    this.db
      .prepare('INSERT INTO task_resource_bindings VALUES(?,?,?,?)')
      .run(binding.jobId, binding.combinationId, binding.resourceRevision, binding.createdAt);
  }
  binding(jobId: string) {
    z.uuid().parse(jobId);
    const plan = this.db.prepare('SELECT combination_id FROM task_plans WHERE id=?').get(jobId);
    if (!plan) throw new ProductError('TASK_NOT_FOUND', '任务计划不存在', 404);
    const row = this.db.prepare('SELECT * FROM task_resource_bindings WHERE job_id=?').get(jobId);
    if (!row) return null;
    if (plan.combination_id !== row.combination_id) throw Error('TASK_RESOURCE_BINDING_MISMATCH');
    return TaskResourceBinding.parse({
      jobId,
      combinationId: row.combination_id,
      resourceRevision: row.resource_revision,
      createdAt: row.created_at,
    });
  }
  snapshot(jobId: string) {
    const binding = this.binding(jobId);
    if (!binding)
      throw new ProductError(
        'RESOURCE_BINDING_REQUIRED',
        '原计划没有固定资源版本，不能按最新资源补配',
        409,
      );
    return TaskResourceSnapshot.parse({
      binding,
      table: this.tables.readVersion(binding.combinationId, binding.resourceRevision),
    });
  }
}

type TaskResourceRepository = SynchronousRepository<CompatibleTaskResourceRepository>;
