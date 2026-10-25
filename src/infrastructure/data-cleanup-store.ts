import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { ProductError } from '../domain/workspace.js';
import {
  CleanupSettings,
  RecordCleanupScope,
  SaveCleanupSettings,
} from '../shared/data-cleanup.js';
import { transaction } from './sqlite-transaction.js';

export const dataCleanupMigration = `
CREATE TABLE task_record_deletions(step_id TEXT PRIMARY KEY,deleted_at INTEGER NOT NULL);
CREATE TABLE data_cleanup_settings(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,history_retention_days INTEGER CHECK(history_retention_days BETWEEN 1 AND 3650),automatic_logs INTEGER NOT NULL DEFAULT 0 CHECK(automatic_logs IN(0,1)));
INSERT INTO data_cleanup_settings VALUES(1,0,NULL,0);
CREATE INDEX task_plans_cleanup ON task_plans(state,updated_at,id);
`;

// Unresolved business evidence and material usage are retained. Fully deleted, ended
// ordinary histories can be physically removed once all their records are selected.
const purgeablePlan = `p.state IN ('COMPLETED','STOPPED','FAILED')
 AND NOT EXISTS(SELECT 1 FROM task_steps s WHERE s.job_id=p.id AND NOT EXISTS(SELECT 1 FROM task_record_deletions d WHERE d.step_id=s.id))
 AND NOT EXISTS(SELECT 1 FROM material_post_intents m WHERE m.job_id=p.id)
 AND NOT EXISTS(SELECT 1 FROM task_outbox o WHERE o.job_id=p.id AND o.status IN ('PREPARED','DISPATCHING','ACKNOWLEDGED','UNKNOWN'))
 AND NOT EXISTS(SELECT 1 FROM task_settlement_notices n JOIN task_settlement_delivery d USING(operation_id,kind) JOIN task_outbox o ON o.id=n.operation_id WHERE o.job_id=p.id AND d.state<>'DELIVERED')
 AND NOT EXISTS(SELECT 1 FROM task_tab_state t WHERE t.job_id=p.id AND t.state IN ('READY','RECHECK_REQUIRED'))`;
export const physicalHistoryCleanupMigration = [
  ...[
    ['retain_browse_intent', 'task_browse_intents', 'OLD.job_id'],
    [
      'retain_dispatch_binding',
      'task_dispatch_bindings',
      '(SELECT job_id FROM task_outbox WHERE id=OLD.operation_id)',
    ],
    [
      'retain_settlement_notice',
      'task_settlement_notices',
      '(SELECT job_id FROM task_outbox WHERE id=OLD.operation_id)',
    ],
    ['retain_task_control_binding', 'task_control_bindings', 'OLD.job_id'],
    [
      'retain_task_control_receipt',
      'task_control_receipts',
      '(SELECT job_id FROM task_control_bindings WHERE request_id=OLD.request_id)',
    ],
    ['retain_task_tab_proof', 'task_tab_ownership', 'OLD.job_id'],
  ].flatMap(([name, table, job]) => [
    `DROP TRIGGER ${name}`,
    `CREATE TRIGGER ${name} BEFORE DELETE ON ${table} WHEN NOT EXISTS(SELECT 1 FROM task_plans p WHERE p.id=${job} AND ${purgeablePlan}) BEGIN SELECT RAISE(ABORT,'${String(name).toUpperCase()}'); END`,
  ]),
].join(';');
export class SqliteDataCleanup {
  constructor(private readonly db: DatabaseSync) {}
  settings() {
    const row = this.db
      .prepare(
        'SELECT revision,history_retention_days AS historyRetentionDays,automatic_logs, (SELECT log_retention_days FROM workspace_preferences WHERE id=1) AS logRetentionDays FROM data_cleanup_settings WHERE id=1',
      )
      .get();
    return CleanupSettings.parse({
      revision: row?.revision,
      historyRetentionDays: row?.historyRetentionDays,
      logRetentionDays: row?.logRetentionDays,
      automaticLogs: row?.automatic_logs === 1,
    });
  }
  saveSettings(input: unknown) {
    const request = SaveCleanupSettings.parse(input);
    return transaction(this.db, () => {
      const result = this.db
        .prepare(
          'UPDATE data_cleanup_settings SET revision=revision+1,history_retention_days=?,automatic_logs=? WHERE id=1 AND revision=?',
        )
        .run(request.historyRetentionDays, request.automaticLogs ? 1 : 0, request.expectedRevision);
      if (!result.changes)
        throw new ProductError('CLEANUP_SETTINGS_CHANGED', '清理设置已变化，请重新读取', 409);
      return this.settings();
    });
  }
  private selection(input: unknown) {
    const scope = RecordCleanupScope.parse(input);
    let where = 'NOT EXISTS(SELECT 1 FROM task_record_deletions d WHERE d.step_id=s.id)';
    const params: SQLInputValue[] = [];
    if (scope.stepIds) {
      where += ' AND s.id IN(SELECT value FROM json_each(?))';
      params.push(JSON.stringify(scope.stepIds));
    }
    if (scope.before !== undefined) {
      where += ' AND p.updated_at<?';
      params.push(scope.before);
    }
    if (scope.profileId) {
      where += ' AND p.profile_id=?';
      params.push(scope.profileId);
    }
    return { where, params };
  }
  preview(input: unknown) {
    const { where, params } = this.selection(input);
    const row = this.db
      .prepare(
        `SELECT count(*) AS total,coalesce(sum(p.state IN ('COMPLETED','STOPPED','FAILED')),0) AS eligible FROM task_steps s JOIN task_plans p ON p.id=s.job_id WHERE ${where}`,
      )
      .get(...params);
    const eligible = Number(row?.eligible ?? 0);
    return { eligible, protected: Number(row?.total ?? 0) - eligible, bytes: 0 };
  }
  removeBatch(input: unknown, maximum = 250) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 250)
      throw Error('CLEANUP_BATCH_INVALID');
    const { where, params } = this.selection(input);
    return transaction(this.db, () => {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO task_record_deletions SELECT s.id,? FROM task_steps s JOIN task_plans p ON p.id=s.job_id WHERE ${where} AND p.state IN ('COMPLETED','STOPPED','FAILED') LIMIT ? RETURNING step_id`,
        )
        .all(Date.now(), ...params, maximum);
      // Remove selected display rows immediately; compact fully selected ordinary plans below.
      this.db
        .prepare(
          'DELETE FROM task_record_projection WHERE step_id IN(SELECT value FROM json_each(?))',
        )
        .run(JSON.stringify(result.map((r) => r.step_id)));
      this.purgeHiddenPlans();
      return result.length;
    });
  }
  private purgeHiddenPlans() {
    const rows = this.db
      .prepare(`SELECT p.id FROM task_plans p WHERE ${purgeablePlan} LIMIT 250`)
      .all();
    for (const row of rows) {
      const id = String(row.id);
      // Keep tombstones until all child deletions finish: retention triggers use them.
      this.db
        .prepare(
          'DELETE FROM task_settlement_delivery WHERE operation_id IN(SELECT id FROM task_outbox WHERE job_id=?)',
        )
        .run(id);
      this.db
        .prepare(
          'DELETE FROM task_settlement_notices WHERE operation_id IN(SELECT id FROM task_outbox WHERE job_id=?)',
        )
        .run(id);
      this.db.prepare('DELETE FROM task_browse_intents WHERE job_id=?').run(id);
      this.db
        .prepare(
          'DELETE FROM task_dispatch_bindings WHERE operation_id IN(SELECT id FROM task_outbox WHERE job_id=?)',
        )
        .run(id);
      this.db.prepare('DELETE FROM task_outbox WHERE job_id=?').run(id);
      this.db
        .prepare(
          'DELETE FROM task_control_receipts WHERE request_id IN(SELECT request_id FROM task_control_bindings WHERE job_id=?)',
        )
        .run(id);
      this.db.prepare('DELETE FROM task_control_bindings WHERE job_id=?').run(id);
      this.db.prepare('DELETE FROM task_tab_state WHERE job_id=?').run(id);
      this.db.prepare('DELETE FROM task_tab_ownership WHERE job_id=?').run(id);
      this.db.prepare('DELETE FROM task_account_locks WHERE job_id=?').run(id);
      this.db.prepare('DELETE FROM task_resource_bindings WHERE job_id=?').run(id);
      this.db.prepare('DELETE FROM task_events WHERE job_id=?').run(id);
      // The plan can reference its ending step; defer this cycle until both are deleted.
      this.db.exec('PRAGMA defer_foreign_keys=ON');
      const stepIds = this.db.prepare('SELECT id FROM task_steps WHERE job_id=?').all(id);
      this.db.prepare('DELETE FROM task_steps WHERE job_id=?').run(id);
      this.db.prepare('DELETE FROM task_plans WHERE id=?').run(id);
      this.db
        .prepare(
          'DELETE FROM task_record_deletions WHERE step_id IN(SELECT value FROM json_each(?))',
        )
        .run(JSON.stringify(stepIds.map((r) => r.id)));
    }
    return rows.length;
  }
  hiddenIds() {
    return this.db
      .prepare('SELECT step_id FROM task_record_deletions')
      .all()
      .map((r) => String(r.step_id));
  }
  assertResettable() {
    const row = this.db
      .prepare("SELECT count(*) AS n FROM task_plans WHERE state IN ('RUNNING','QUEUED')")
      .get();
    if (Number(row?.n))
      throw new ProductError('RESET_TASKS_ACTIVE', '请先停止当前正在运行或等待启动的任务', 409);
  }
  compact() {
    this.assertResettable();
    // Also release ordinary records hidden by an older software version.
    while (transaction(this.db, () => this.purgeHiddenPlans()) > 0) {}
    this.db.exec('VACUUM');
    return { completed: true };
  }
}
