import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { ProductError } from '../domain/workspace.js';
import {
  CleanupSettings,
  RecordCleanupScope,
  SaveCleanupSettings,
} from '../shared/data-cleanup.js';
import * as Q from './persistence/sqlite-query-helpers.js';
import { readRecordAvatar, RecordAvatarKind } from './record-avatar-store.js';
import { SqliteRecordRetention } from './record-retention-store.js';
import { transaction } from './sqlite-transaction.js';

const purgeablePlan = `p.state IN ('COMPLETED','STOPPED','FAILED')
 AND NOT EXISTS(SELECT 1 FROM task_steps s WHERE s.job_id=p.id AND NOT EXISTS(SELECT 1 FROM task_record_deletions d WHERE d.step_id=s.id))
 AND NOT EXISTS(SELECT 1 FROM material_post_intents m WHERE m.job_id=p.id)
 AND NOT EXISTS(SELECT 1 FROM task_outbox o WHERE o.job_id=p.id AND o.status IN ('PREPARED','DISPATCHING','ACKNOWLEDGED','UNKNOWN'))`;

export class SqliteDataCleanup {
  constructor(
    private readonly db: DatabaseSync,
    private readonly onInvalidate?: () => void,
  ) {}
  detailHead = (maximum: number) => new SqliteRecordRetention(this.db).detailHead(maximum);
  protectedOperationIds = () => new SqliteRecordRetention(this.db).protectedOperationIds();
  pruneDetails = (input: unknown, maximum = 100) =>
    new SqliteRecordRetention(this.db).pruneDetails(input, maximum);
  pruneResults = (bumper: number, poster: number, maximum = 100) =>
    new SqliteRecordRetention(this.db).pruneResults(bumper, poster, maximum);
  recordAvatar = (kind: unknown, id: string) =>
    readRecordAvatar(this.db, RecordAvatarKind.parse(kind), id);
  settings() {
    const sql =
      'SELECT revision,history_retention_days AS historyRetentionDays,history_max_count AS historyMaxCount,automatic_logs,bumper_max_count,poster_max_count,detail_max_count,(SELECT log_retention_days FROM workspace_preferences WHERE id=1) AS logRetentionDays FROM data_cleanup_settings WHERE id=1';
    const r = Q.getRow(this.db, sql);
    return CleanupSettings.parse({
      revision: r?.revision,
      historyRetentionDays: r?.historyRetentionDays,
      historyMaxCount: r?.historyMaxCount ?? null,
      logRetentionDays: r?.logRetentionDays,
      automaticLogs: r?.automatic_logs === 1,
      bumperMaxCount: r?.bumper_max_count,
      posterMaxCount: r?.poster_max_count,
      detailMaxCount: r?.detail_max_count,
    });
  }
  saveSettings(input: unknown) {
    const req = SaveCleanupSettings.parse(input),
      sql =
        'UPDATE data_cleanup_settings SET revision=revision+1,history_retention_days=?,history_max_count=?,automatic_logs=?,bumper_max_count=?,poster_max_count=?,detail_max_count=? WHERE id=1 AND revision=?';
    return transaction(this.db, () => {
      const cur = this.settings();
      const res = Q.run(
        this.db,
        sql,
        req.historyRetentionDays,
        req.historyMaxCount === undefined ? (cur.historyMaxCount ?? null) : req.historyMaxCount,
        req.automaticLogs ? 1 : 0,
        req.bumperMaxCount ?? cur.bumperMaxCount,
        req.posterMaxCount ?? cur.posterMaxCount,
        req.detailMaxCount ?? cur.detailMaxCount,
        req.expectedRevision,
      );
      if (!res.changes)
        throw new ProductError('CLEANUP_SETTINGS_CHANGED', '清理设置已变化，请重新读取', 409);
      return this.settings();
    });
  }
  reclaimHiddenRounds(maximum = 100): number {
    const delSql =
      'DELETE FROM task_record_deletions WHERE step_id IN(SELECT id FROM task_steps WHERE job_id=? AND round=?)';
    return transaction(this.db, () => {
      const sql = `SELECT DISTINCT s.job_id,s.round FROM task_steps s JOIN task_plans p ON p.id=s.job_id WHERE s.round<p.round
        AND NOT EXISTS(SELECT 1 FROM task_steps v WHERE v.job_id=s.job_id AND v.round=s.round AND NOT EXISTS(SELECT 1 FROM task_record_deletions d WHERE d.step_id=v.id))
        AND NOT EXISTS(SELECT 1 FROM task_outbox o JOIN task_steps v ON v.id=o.step_id WHERE v.job_id=s.job_id AND v.round=s.round)
        AND NOT EXISTS(SELECT 1 FROM material_post_intents m JOIN task_steps v ON v.id=m.step_id WHERE v.job_id=s.job_id AND v.round=s.round)
        AND NOT EXISTS(SELECT 1 FROM task_events e WHERE e.job_id=s.job_id AND (json_extract(e.detail,'$.round')=s.round OR json_extract(e.detail,'$.stepId') IN(SELECT id FROM task_steps v WHERE v.job_id=s.job_id AND v.round=s.round))) LIMIT ?`;
      const rounds = Q.allRows(this.db, sql, maximum);
      for (const r of rounds) {
        const jid = Q.s(r.job_id),
          rnd = Q.n(r.round);
        Q.run(this.db, delSql, jid, rnd);
        for (const t of ['task_steps', 'task_run_summaries', 'task_record_dirty'])
          Q.run(this.db, `DELETE FROM ${t} WHERE job_id=? AND round=?`, jid, rnd);
      }
      return rounds.length;
    });
  }
  private selection(input: unknown) {
    const scope = RecordCleanupScope.parse(input),
      params: SQLInputValue[] = [];
    let where = 'NOT EXISTS(SELECT 1 FROM task_record_deletions d WHERE d.step_id=s.id)';
    if (scope.stepIds) {
      where += ` AND (s.id IN(SELECT value FROM json_each(?)) OR (s.status='PENDING' AND p.state IN ('STOPPED','COMPLETED','FAILED') AND s.job_id IN(SELECT job_id FROM task_steps WHERE id IN(SELECT value FROM json_each(?)))))`;
      params.push(JSON.stringify(scope.stepIds), JSON.stringify(scope.stepIds));
    }
    const limits: string[] = [];
    if (scope.before !== undefined) {
      limits.push('p.updated_at<?');
      params.push(scope.before);
    }
    if (scope.keepLatestRuns !== undefined) {
      limits.push(
        `(s.job_id,s.round) IN (SELECT qs.job_id,qs.round FROM task_steps qs JOIN task_plans qp ON qp.id=qs.job_id LEFT JOIN task_record_projection qr ON qr.step_id=qs.id WHERE (qp.state IN ('STOPPED','COMPLETED','FAILED') OR qs.round<qp.round) AND NOT EXISTS(SELECT 1 FROM task_record_deletions qd WHERE qd.step_id=qs.id) ${scope.profileId ? 'AND qp.profile_id=?' : ''} GROUP BY qs.job_id,qs.round ORDER BY max(coalesce(qr.stable_sort,CASE WHEN qs.status='PENDING' THEN qp.created_at ELSE qp.updated_at END)) DESC, max(qp.created_at) DESC,qs.round DESC,qs.job_id DESC LIMIT -1 OFFSET ?)`,
      );
      if (scope.profileId) params.push(scope.profileId);
      params.push(scope.keepLatestRuns);
    }
    if (limits.length) where += ' AND (' + limits.join(' OR ') + ')';
    if (scope.profileId) {
      where += ' AND p.profile_id=?';
      params.push(scope.profileId);
    }
    return { where, params };
  }
  preview(input: unknown) {
    const { where, params } = this.selection(input);
    const sql = `SELECT count(*) AS total,coalesce(sum(p.state IN ('COMPLETED','STOPPED','FAILED') OR s.round<p.round),0) AS eligible FROM task_steps s JOIN task_plans p ON p.id=s.job_id WHERE ${where}`;
    const row = Q.getRow(this.db, sql, ...params),
      eligible = Q.n(row?.eligible);
    return { eligible, protected: Q.n(row?.total) - eligible, bytes: 0 };
  }
  removeBatch(input: unknown, maximum = 250) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 250)
      throw Error('CLEANUP_BATCH_INVALID');
    const scope = RecordCleanupScope.parse(input),
      { where, params } = this.selection(input);
    return transaction(this.db, () => {
      const insSql = `INSERT OR IGNORE INTO task_record_deletions SELECT s.id,? FROM task_steps s JOIN task_plans p ON p.id=s.job_id WHERE ${where} AND (p.state IN ('COMPLETED','STOPPED','FAILED') OR s.round<p.round) LIMIT ? RETURNING step_id`;
      const result = Q.allRows(this.db, insSql, Date.now(), ...params, maximum),
        stepIds = result.map((r) => Q.s(r.step_id));
      Q.deleteByJsonIds(this.db, 'task_record_projection', 'step_id', stepIds);
      const affected = Q.allRows(
        this.db,
        'SELECT DISTINCT job_id FROM task_steps WHERE id IN(SELECT value FROM json_each(?))',
        JSON.stringify(stepIds),
      ).map((r) => Q.s(r.job_id));
      if (affected.length) this.purgeHiddenPlans(affected);
      if (scope.before !== undefined && !scope.stepIds)
        this.purgeExpiredFeatureOperationsByCutoff(scope.before, scope.profileId);
      return result.length;
    });
  }
  purgeExpiredFeatureOperations(input: unknown): number {
    const scope = RecordCleanupScope.parse(input);
    return scope.stepIds || scope.before === undefined
      ? 0
      : transaction(this.db, () =>
          this.purgeExpiredFeatureOperationsByCutoff(scope.before as number, scope.profileId),
        );
  }
  private purgeExpiredFeatureOperationsByCutoff(before: number, profileId?: string): number {
    const pid = profileId ?? null;
    const del = (table: string, sql: string, ...args: SQLInputValue[]) =>
      Q.sqliteTableExists(this.db, table) ? Number(Q.run(this.db, sql, ...args).changes ?? 0) : 0;
    const bSql =
      "DELETE FROM group_bumper_operations WHERE status='SETTLED' AND resolution_outcome<>'ENDED_UNKNOWN' AND updated_at<? AND (? IS NULL OR profile_id=?)";
    const pSql =
      "DELETE FROM group_poster_operations WHERE kernel_settled=1 AND status IN ('VERIFIED','NOT_APPLIED') AND updated_at<? AND (? IS NULL OR profile_id=?)";
    let removed =
      del('group_bumper_operations', bSql, before, pid, pid) +
      del('group_poster_operations', pSql, before, pid, pid) +
      del(
        'post_bump_records',
        'DELETE FROM post_bump_records WHERE created_at<? AND (? IS NULL OR profile_id=?)',
        before,
        pid,
        pid,
      );
    if (!profileId) {
      if (Q.sqliteTableExists(this.db, 'auto_scheduler_runs')) {
        const iSql =
          "DELETE FROM auto_scheduler_run_items WHERE run_id IN (SELECT id FROM auto_scheduler_runs WHERE started_at<? AND status IN ('completed','failed','stopped'))";
        const rSql =
          "DELETE FROM auto_scheduler_runs WHERE started_at<? AND status IN ('completed','failed','stopped')";
        del('auto_scheduler_run_items', iSql, before);
        removed += del('auto_scheduler_runs', rSql, before);
      }
      const tSql =
        "DELETE FROM group_poster_tasks WHERE finished_at IS NOT NULL AND finished_at<? AND status IN ('completed','failed','cancelled')";
      removed += del('group_poster_tasks', tSql, before);
    }
    return removed;
  }
  private purgeHiddenPlans(affectedJobIds?: string[]) {
    const sql = `SELECT p.id FROM task_plans p WHERE ${affectedJobIds ? 'p.id IN(SELECT value FROM json_each(?)) AND ' : ''}${purgeablePlan} LIMIT 50`;
    const rows = Q.allRows(
      this.db,
      sql,
      ...(affectedJobIds ? [JSON.stringify(affectedJobIds)] : []),
    );
    if (!rows.length) return 0;
    const jobIds = rows.map((r) => Q.s(r.id)),
      jobs = JSON.stringify(jobIds);
    const sSql = 'SELECT id FROM task_steps WHERE job_id IN(SELECT value FROM json_each(?))';
    const stepIds = Q.allRows(this.db, sSql, jobs).map((r) => Q.s(r.id));
    this.db.exec('PRAGMA defer_foreign_keys=ON');
    Q.deleteByJsonIds(this.db, 'task_steps', 'job_id', jobIds);
    const bSql =
      'DELETE FROM task_dispatch_bindings WHERE operation_id IN(SELECT id FROM task_outbox WHERE job_id IN(SELECT value FROM json_each(?)))';
    Q.run(this.db, bSql, jobs);
    for (const table of [
      'task_account_locks',
      'task_resource_bindings',
      'task_outbox',
      'task_events',
      'task_record_dirty',
    ])
      Q.deleteByJsonIds(this.db, table, 'job_id', jobIds);
    Q.deleteByJsonIds(this.db, 'task_plans', 'id', jobIds);
    Q.deleteByJsonIds(this.db, 'task_record_deletions', 'step_id', stepIds);
    this.onInvalidate?.();
    return rows.length;
  }
  assertResettable() {
    const chk = (cond: boolean, code: string, msg: string) => {
      if (cond) throw new ProductError(code, msg, 409);
    };
    const tSql = "SELECT count(*) AS n FROM task_plans WHERE state IN ('RUNNING','QUEUED')",
      pSql = 'SELECT count(*) AS n FROM group_poster_operations WHERE kernel_settled=0',
      bSql = "SELECT count(*) AS n FROM group_bumper_operations WHERE status<>'SETTLED'";
    chk(
      Q.countSql(this.db, tSql) > 0,
      'RESET_TASKS_ACTIVE',
      '请先停止当前正在运行或等待启动的任务',
    );
    chk(
      Q.sqliteTableExists(this.db, 'group_poster_operations') && Q.countSql(this.db, pSql) > 0,
      'RESET_POSTER_UNSETTLED',
      '小组发帖存在未结清的内核操作锁，请先停止或等待恢复结清',
    );
    chk(
      Q.sqliteTableExists(this.db, 'group_bumper_operations') && Q.countSql(this.db, bSql) > 0,
      'RESET_BUMPER_UNSETTLED',
      '顶贴模块存在未结清的内核操作锁，请先停止或等待恢复结清',
    );
  }
  compact() {
    this.assertResettable();
    while (transaction(this.db, () => this.purgeHiddenPlans()) > 0) {}
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
    return { completed: true };
  }
}
