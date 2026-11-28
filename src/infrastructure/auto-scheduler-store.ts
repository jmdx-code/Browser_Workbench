import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ProductError } from '../domain/workspace.js';
import * as AS from '../shared/auto-scheduler.js';
import { Id } from '../shared/contracts.js';
import * as Q from './persistence/sqlite-query-helpers.js';
import { transaction } from './sqlite-transaction.js';
const ToggleScheduleInput = z.object({ id: Id, enabled: z.boolean() }).strict(),
  ScheduleIdInput = z.object({ id: Id }).strict(),
  DEFAULT_SETTINGS = AS.AutoSchedulerGlobalSettings.parse({});
function triggerTimingChanged(
  prev: AS.AutoSchedule['trigger'],
  next: AS.AutoSchedule['trigger'],
): boolean {
  return (
    prev.mode !== next.mode ||
    (prev.onceAt ?? null) !== (next.onceAt ?? null) ||
    prev.timeZone !== next.timeZone ||
    [...prev.weekdays].sort().join(',') !== [...next.weekdays].sort().join(',') ||
    [...prev.times].sort().join(',') !== [...next.times].sort().join(',')
  );
}
function deleteRunRows(db: DatabaseSync, ids: Array<Record<string, unknown>>): void {
  const delItems = db.prepare('DELETE FROM auto_scheduler_run_items WHERE run_id=?'),
    delRun = db.prepare('DELETE FROM auto_scheduler_runs WHERE id=?');
  for (const r of ids) {
    delItems.run(String(r.id));
    delRun.run(String(r.id));
  }
}
export class SqliteAutoSchedulerRepository {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auto_scheduler_settings( id INTEGER PRIMARY KEY CHECK(id = 1), json TEXT NOT NULL, updated_at INTEGER NOT NULL );
      CREATE TABLE IF NOT EXISTS auto_scheduler_schedules( id TEXT PRIMARY KEY, sort_order INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, carrier TEXT NOT NULL, body_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL );
      CREATE TABLE IF NOT EXISTS auto_scheduler_runs( id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, schedule_name TEXT NOT NULL, carrier TEXT NOT NULL, phase TEXT NOT NULL, slot_key TEXT NOT NULL, trigger_mode TEXT NOT NULL, status TEXT NOT NULL, status_reason TEXT NOT NULL, total_targets INTEGER NOT NULL DEFAULT 0, completed_count INTEGER NOT NULL DEFAULT 0, soft_issue_count INTEGER NOT NULL DEFAULT 0, hard_blocked_count INTEGER NOT NULL DEFAULT 0, watchdog_timeout_count INTEGER NOT NULL DEFAULT 0, skipped_count INTEGER NOT NULL DEFAULT 0, scheduled_for INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, hidden_from_history INTEGER NOT NULL DEFAULT 0 );
      CREATE INDEX IF NOT EXISTS idx_auto_scheduler_runs_schedule_slot ON auto_scheduler_runs(schedule_id, slot_key); CREATE INDEX IF NOT EXISTS idx_auto_scheduler_runs_started ON auto_scheduler_runs(started_at DESC);
      CREATE TABLE IF NOT EXISTS auto_scheduler_run_items( run_id TEXT NOT NULL, target_id TEXT NOT NULL, target_name TEXT NOT NULL, status TEXT NOT NULL, current_step TEXT NOT NULL, summary TEXT NOT NULL, bumped_count INTEGER NOT NULL DEFAULT 0, posted_count INTEGER NOT NULL DEFAULT 0, soft_issues INTEGER NOT NULL DEFAULT 0, hard_block_reason TEXT, seamless_handoff INTEGER NOT NULL DEFAULT 0, started_at INTEGER, finished_at INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY(run_id, target_id) );
    `);
    Q.ensureColumns(db, 'auto_scheduler_runs', [
      ['hidden_from_history', 'INTEGER NOT NULL DEFAULT 0'],
    ]);
  }
  settings = (): AS.AutoSchedulerGlobalSettings =>
    Q.readSingletonJson(
      this.db,
      'auto_scheduler_settings',
      'json',
      (o) => AS.AutoSchedulerGlobalSettings.parse(o),
      () => ({ ...DEFAULT_SETTINGS }),
    );
  saveSettings(input: unknown): AS.AutoSchedulerGlobalSettings {
    const patch =
        typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {},
      merged = AS.AutoSchedulerGlobalSettings.parse({ ...this.settings(), ...patch });
    Q.upsert(
      this.db,
      'auto_scheduler_settings',
      'id',
      'id,json,updated_at',
      '*',
      1,
      JSON.stringify(merged),
      Date.now(),
    );
    return merged;
  }
  listSchedules = (): AS.AutoSchedule[] => {
    const sql =
      'SELECT body_json FROM auto_scheduler_schedules ORDER BY sort_order ASC, created_at ASC';
    return Q.allRows(this.db, sql).flatMap((r) => {
      const p = Q.parseWithFallback(
        () => AS.AutoSchedule.parse(JSON.parse(String(r.body_json))),
        null,
      );
      return p ? [p] : [];
    });
  };
  getSchedule(id: string): AS.AutoSchedule | null {
    const row = Q.getRow(this.db, 'SELECT body_json FROM auto_scheduler_schedules WHERE id=?', id);
    return row?.body_json
      ? Q.parseWithFallback(() => AS.AutoSchedule.parse(JSON.parse(String(row.body_json))), null)
      : null;
  }
  saveSchedule(input: unknown): AS.AutoSchedule {
    const parsed = AS.SaveAutoScheduleInput.parse(input),
      now = Date.now(),
      cols = 'id,sort_order,enabled,carrier,body_json,created_at,updated_at';
    return transaction(this.db, () => {
      const ex = parsed.id ? this.getSchedule(parsed.id) : null;
      const armedAt = !ex
        ? (parsed.armedAt ?? now)
        : (!ex.enabled && parsed.enabled) || triggerTimingChanged(ex.trigger, parsed.trigger)
          ? now
          : (ex.armedAt ?? ex.createdAt);
      const full = AS.AutoSchedule.parse({
        ...parsed,
        id: ex ? ex.id : (parsed.id ?? randomUUID()),
        sortOrder: ex ? ex.sortOrder : Q.nextSortOrder(this.db, 'auto_scheduler_schedules'),
        armedAt,
        createdAt: ex ? ex.createdAt : now,
        updatedAt: now,
      });
      Q.upsertFrom(
        this.db,
        'auto_scheduler_schedules',
        'id',
        cols,
        'sort_order,enabled,carrier,body_json,updated_at',
        full,
        { body_json: JSON.stringify(full) },
      );
      return full;
    });
  }
  toggleSchedule(input: unknown): AS.AutoSchedule {
    const { id, enabled } = ToggleScheduleInput.parse(input),
      sql = 'UPDATE auto_scheduler_schedules SET enabled=?, body_json=?, updated_at=? WHERE id=?';
    return transaction(this.db, () => {
      const existing = this.getSchedule(id);
      if (!existing) throw new ProductError('SCHEDULE_NOT_FOUND', '未找到该定时排班', 404);
      const now = Date.now();
      const armedAt = !existing.enabled && enabled ? now : (existing.armedAt ?? existing.createdAt);
      const updated: AS.AutoSchedule = { ...existing, enabled, armedAt, updatedAt: now };
      Q.run(this.db, sql, enabled ? 1 : 0, JSON.stringify(updated), updated.updatedAt, id);
      return updated;
    });
  }
  duplicateSchedule(input: unknown): AS.AutoSchedule {
    const { id } = ScheduleIdInput.parse(input),
      cols = 'id,sort_order,enabled,carrier,body_json,created_at,updated_at';
    return transaction(this.db, () => {
      const ex = this.getSchedule(id);
      if (!ex) throw new ProductError('SCHEDULE_NOT_FOUND', '未找到要复制的排班', 404);
      const now = Date.now();
      const cloned = AS.AutoSchedule.parse({
        ...ex,
        id: randomUUID(),
        name: `${ex.name.replace(/\s*副本(?:\s*\d+)?$/, '').slice(0, 70)} 副本`,
        enabled: false,
        steps: ex.steps.map((s) => ({ ...s, id: randomUUID() })),
        sortOrder: Q.nextSortOrder(this.db, 'auto_scheduler_schedules'),
        armedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      Q.insertFrom(this.db, 'auto_scheduler_schedules', cols, cloned, {
        body_json: JSON.stringify(cloned),
      });
      return cloned;
    });
  }
  deleteSchedule = (input: unknown): boolean =>
    Q.run(
      this.db,
      'DELETE FROM auto_scheduler_schedules WHERE id=?',
      ScheduleIdInput.parse(input).id,
    ).changes > 0;
  saveRun(run: AS.AutoScheduleRun): AS.AutoScheduleRun {
    const p = AS.AutoScheduleRun.parse({
      ...run,
      scheduleName: run.scheduleName.slice(0, 120),
      statusReason: run.statusReason.slice(0, 300),
    });
    const cols =
      'id,schedule_id,schedule_name,carrier,phase,slot_key,trigger_mode,status,status_reason,total_targets,completed_count,soft_issue_count,hard_blocked_count,watchdog_timeout_count,skipped_count,scheduled_for,started_at,finished_at';
    const upd =
      'status,status_reason,total_targets,completed_count,soft_issue_count,hard_blocked_count,watchdog_timeout_count,skipped_count,finished_at';
    Q.upsertFrom(this.db, 'auto_scheduler_runs', 'id', cols, upd, p);
    return p;
  }
  saveRunItem(item: AS.AutoScheduleRunItem): void {
    const p = AS.AutoScheduleRunItem.parse({
      ...item,
      targetName: item.targetName.slice(0, 200),
      currentStep: item.currentStep.slice(0, 200),
      summary: item.summary.slice(0, 400),
      hardBlockReason: item.hardBlockReason ? item.hardBlockReason.slice(0, 240) : null,
    });
    Q.upsertFrom(
      this.db,
      'auto_scheduler_run_items',
      'run_id,target_id',
      'run_id,target_id,target_name,status,current_step,summary,bumped_count,posted_count,soft_issues,hard_block_reason,started_at,finished_at,updated_at',
      '*',
      p,
    );
  }
  saveRunWithItems(run: AS.AutoScheduleRun, items: readonly AS.AutoScheduleRunItem[]): void {
    transaction(this.db, () => {
      this.saveRun(run);
      for (const item of items) this.saveRunItem(item);
    });
  }
  private listItemsForRun(runId: string): AS.AutoScheduleRunItem[] {
    const sql =
      'SELECT run_id,target_id,substr(target_name,1,200) AS target_name,status,substr(current_step,1,200) AS current_step,substr(summary,1,400) AS summary,bumped_count,posted_count,soft_issues,CASE WHEN hard_block_reason IS NULL THEN NULL ELSE substr(hard_block_reason,1,240) END AS hard_block_reason,started_at,finished_at,updated_at FROM auto_scheduler_run_items WHERE run_id = ? ORDER BY COALESCE(started_at, 9999999999999) ASC, target_name ASC';
    return Q.allRows(this.db, sql, runId).flatMap((r) => {
      const p = Q.parseWithFallback(() => AS.AutoScheduleRunItem.parse(Q.camel(r)), null);
      return p ? [p] : [];
    });
  }
  listRuns(limit = 20, includeItemsLimit = 8): AS.AutoScheduleRun[] {
    const sql =
      'SELECT id,schedule_id,substr(schedule_name,1,120) AS schedule_name,carrier,phase,slot_key,trigger_mode,status,substr(status_reason,1,300) AS status_reason,total_targets,completed_count,soft_issue_count,hard_blocked_count,watchdog_timeout_count,skipped_count,scheduled_for,started_at,finished_at FROM auto_scheduler_runs WHERE hidden_from_history = 0 ORDER BY started_at DESC LIMIT ?';
    return Q.allRows(this.db, sql, Q.clampLimit(Math.floor(limit), 1, 100)).flatMap((r, idx) => {
      const items = idx < includeItemsLimit ? this.listItemsForRun(String(r.id)) : undefined;
      const mapped = Q.parseWithFallback(
        () => AS.AutoScheduleRun.parse({ ...Q.camel(r), ...(items ? { items } : {}) }),
        null,
      );
      return mapped ? [mapped] : [];
    });
  }
  listHandledSlotKeys(scheduleId: string, sinceMs: number): string[] {
    const sql =
      "SELECT DISTINCT slot_key, status, status_reason FROM auto_scheduler_runs WHERE schedule_id = ? AND trigger_mode = 'cron' AND scheduled_for >= ?";
    return [
      ...new Set(
        Q.allRows(this.db, sql, scheduleId, sinceMs)
          .filter(
            (r) => !(r.status === 'stopped' && String(r.status_reason).includes('工作台重启收尾')),
          )
          .map((r) => String(r.slot_key)),
      ),
    ];
  }
  listFinishedTargetIdsForSlot = (scheduleId: string, slotKey: string): string[] => {
    const sql =
      "SELECT DISTINCT i.target_id FROM auto_scheduler_run_items i JOIN auto_scheduler_runs r ON r.id=i.run_id WHERE r.schedule_id=? AND r.slot_key=? AND i.status IN ('completed','soft_warning','hard_blocked','watchdog_timeout')";
    return Q.allRows(this.db, sql, scheduleId, slotKey).map((r) => String(r.target_id));
  };
  listHardBlockedTargetIdsSince = (scheduleId: string, sinceMs: number): string[] => {
    const sql =
      "SELECT DISTINCT i.target_id FROM auto_scheduler_run_items i JOIN auto_scheduler_runs r ON r.id=i.run_id WHERE r.schedule_id=? AND r.started_at>=? AND i.status='hard_blocked'";
    return Q.allRows(this.db, sql, scheduleId, sinceMs).map((r) => String(r.target_id));
  };
  recoverInterruptedRunsOnStartup(nowMs = Date.now()): number {
    return transaction(this.db, () => {
      const running = Q.allRows(
        this.db,
        "SELECT id FROM auto_scheduler_runs WHERE status='running'",
      );
      if (!running.length) return 0;
      const updItems = this.db.prepare(
        "UPDATE auto_scheduler_run_items SET status='stopped', current_step='已结束', summary='工作台重启收尾', finished_at=?, updated_at=? WHERE run_id=? AND status IN ('queued','running')",
      );
      const updRun = this.db.prepare(
        "UPDATE auto_scheduler_runs SET status='stopped', status_reason='工作台重启收尾（已完成账号保留记录，补跑窗内自动续跑剩余账号）', finished_at=? WHERE id=?",
      );
      for (const row of running) {
        updItems.run(nowMs, nowMs, String(row.id));
        updRun.run(nowMs, String(row.id));
      }
      return running.length;
    });
  }
  pruneOldRuns(keepMaxRuns = 120): number {
    const cutoffMs = Date.now() - 48 * 3600_000;
    const sql =
      "SELECT id FROM auto_scheduler_runs WHERE status!='running' AND scheduled_for < ? AND started_at < ? AND id NOT IN (SELECT id FROM auto_scheduler_runs ORDER BY started_at DESC LIMIT ?)";
    return transaction(this.db, () => {
      const stale = Q.allRows(
        this.db,
        sql,
        cutoffMs,
        cutoffMs,
        Math.max(20, Math.floor(keepMaxRuns)),
      );
      deleteRunRows(this.db, stale);
      return stale.length;
    });
  }
  clearHistoryRuns(): number {
    const hideSql =
        "UPDATE auto_scheduler_runs SET hidden_from_history=1 WHERE status!='running' AND hidden_from_history=0",
      oldSql =
        "SELECT id FROM auto_scheduler_runs WHERE status!='running' AND hidden_from_history=1 AND started_at < ?";
    return transaction(this.db, () => {
      const hidden = Number(Q.run(this.db, hideSql).changes);
      deleteRunRows(this.db, Q.allRows(this.db, oldSql, Date.now() - 48 * 3600_000));
      return hidden;
    });
  }
}
