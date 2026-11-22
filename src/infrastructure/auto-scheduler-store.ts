import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ProductError } from '../domain/workspace.js';
import {
  AutoSchedule,
  AutoScheduleRun,
  AutoScheduleRunItem,
  AutoSchedulerGlobalSettings,
  SaveAutoScheduleInput,
} from '../shared/auto-scheduler.js';
import { Id } from '../shared/contracts.js';
import { transaction } from './sqlite-transaction.js';

const ToggleScheduleInput = z.object({ id: Id, enabled: z.boolean() }).strict();
const ScheduleIdInput = z.object({ id: Id }).strict();

const DEFAULT_SETTINGS: AutoSchedulerGlobalSettings = AutoSchedulerGlobalSettings.parse({});

export class SqliteAutoSchedulerRepository {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auto_scheduler_settings(
        id INTEGER PRIMARY KEY CHECK(id = 1),
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auto_scheduler_schedules(
        id TEXT PRIMARY KEY,
        sort_order INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        carrier TEXT NOT NULL,
        body_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auto_scheduler_runs(
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        schedule_name TEXT NOT NULL,
        carrier TEXT NOT NULL,
        phase TEXT NOT NULL,
        slot_key TEXT NOT NULL,
        trigger_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        status_reason TEXT NOT NULL,
        total_targets INTEGER NOT NULL DEFAULT 0,
        completed_count INTEGER NOT NULL DEFAULT 0,
        soft_issue_count INTEGER NOT NULL DEFAULT 0,
        hard_blocked_count INTEGER NOT NULL DEFAULT 0,
        watchdog_timeout_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        scheduled_for INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        hidden_from_history INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_auto_scheduler_runs_schedule_slot
        ON auto_scheduler_runs(schedule_id, slot_key);
      CREATE INDEX IF NOT EXISTS idx_auto_scheduler_runs_started
        ON auto_scheduler_runs(started_at DESC);
      CREATE TABLE IF NOT EXISTS auto_scheduler_run_items(
        run_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_name TEXT NOT NULL,
        status TEXT NOT NULL,
        current_step TEXT NOT NULL,
        summary TEXT NOT NULL,
        bumped_count INTEGER NOT NULL DEFAULT 0,
        posted_count INTEGER NOT NULL DEFAULT 0,
        soft_issues INTEGER NOT NULL DEFAULT 0,
        hard_block_reason TEXT,
        seamless_handoff INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER,
        finished_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(run_id, target_id)
      );
    `);
    const runCols = db.prepare('PRAGMA table_info(auto_scheduler_runs)').all() as Array<{
      name?: string;
    }>;
    if (!runCols.some((c) => c.name === 'hidden_from_history')) {
      db.exec(
        'ALTER TABLE auto_scheduler_runs ADD COLUMN hidden_from_history INTEGER NOT NULL DEFAULT 0',
      );
    }
  }

  settings(): AutoSchedulerGlobalSettings {
    const row = this.db.prepare('SELECT json FROM auto_scheduler_settings WHERE id = 1').get() as
      { json?: string } | undefined;
    if (!row?.json) return { ...DEFAULT_SETTINGS };
    try {
      return AutoSchedulerGlobalSettings.parse(JSON.parse(row.json));
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  saveSettings(input: unknown): AutoSchedulerGlobalSettings {
    const current = this.settings();
    const patch =
      typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    const merged = AutoSchedulerGlobalSettings.parse({ ...current, ...patch });
    this.db
      .prepare(
        `INSERT INTO auto_scheduler_settings(id, json, updated_at) VALUES(1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(merged), Date.now());
    return merged;
  }

  listSchedules(): AutoSchedule[] {
    const rows = this.db
      .prepare(
        'SELECT body_json FROM auto_scheduler_schedules ORDER BY sort_order ASC, created_at ASC',
      )
      .all() as Array<{ body_json: string }>;
    const out: AutoSchedule[] = [];
    for (const row of rows) {
      try {
        out.push(AutoSchedule.parse(JSON.parse(row.body_json)));
      } catch {
        /* ignore malformed legacy row */
      }
    }
    return out;
  }

  getSchedule(id: string): AutoSchedule | null {
    const row = this.db
      .prepare('SELECT body_json FROM auto_scheduler_schedules WHERE id = ?')
      .get(id) as { body_json?: string } | undefined;
    if (!row?.body_json) return null;
    try {
      return AutoSchedule.parse(JSON.parse(row.body_json));
    } catch {
      return null;
    }
  }

  saveSchedule(input: unknown): AutoSchedule {
    const parsed = SaveAutoScheduleInput.parse(input);
    const now = Date.now();
    return transaction(this.db, () => {
      const existing = parsed.id ? this.getSchedule(parsed.id) : null;
      const id = existing ? existing.id : (parsed.id ?? randomUUID());
      const sortOrder = existing
        ? existing.sortOrder
        : Number(
            (
              this.db
                .prepare(
                  'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM auto_scheduler_schedules',
                )
                .get() as { next_order?: number } | undefined
            )?.next_order ?? 0,
          );
      const createdAt = existing ? existing.createdAt : now;
      const full: AutoSchedule = AutoSchedule.parse({
        ...parsed,
        id,
        sortOrder,
        createdAt,
        updatedAt: now,
      });
      this.db
        .prepare(
          `INSERT INTO auto_scheduler_schedules(id, sort_order, enabled, carrier, body_json, created_at, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             sort_order = excluded.sort_order,
             enabled = excluded.enabled,
             carrier = excluded.carrier,
             body_json = excluded.body_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          full.id,
          full.sortOrder,
          full.enabled ? 1 : 0,
          full.carrier,
          JSON.stringify(full),
          full.createdAt,
          full.updatedAt,
        );
      return full;
    });
  }

  toggleSchedule(input: unknown): AutoSchedule {
    const { id, enabled } = ToggleScheduleInput.parse(input);
    return transaction(this.db, () => {
      const existing = this.getSchedule(id);
      if (!existing) throw new ProductError('SCHEDULE_NOT_FOUND', '未找到该定时排班', 404);
      const updated: AutoSchedule = {
        ...existing,
        enabled,
        updatedAt: Date.now(),
      };
      this.db
        .prepare(
          'UPDATE auto_scheduler_schedules SET enabled = ?, body_json = ?, updated_at = ? WHERE id = ?',
        )
        .run(enabled ? 1 : 0, JSON.stringify(updated), updated.updatedAt, id);
      return updated;
    });
  }

  duplicateSchedule(input: unknown): AutoSchedule {
    const { id } = ScheduleIdInput.parse(input);
    return transaction(this.db, () => {
      const existing = this.getSchedule(id);
      if (!existing) throw new ProductError('SCHEDULE_NOT_FOUND', '未找到要复制的排班', 404);
      const now = Date.now();
      const nextOrder = Number(
        (
          this.db
            .prepare(
              'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM auto_scheduler_schedules',
            )
            .get() as { next_order?: number } | undefined
        )?.next_order ?? 0,
      );
      const baseName = existing.name.replace(/\s*副本(?:\s*\d+)?$/, '').slice(0, 70);
      const copyId = randomUUID();
      const cloned: AutoSchedule =
        existing.carrier === 'browser'
          ? AutoSchedule.parse({
              ...existing,
              id: copyId,
              name: `${baseName} 副本`,
              enabled: false,
              prewarm: {
                ...existing.prewarm,
                steps: existing.prewarm.steps.map((s) => ({ ...s, id: randomUUID() })),
              },
              steps: existing.steps.map((s) => ({ ...s, id: randomUUID() })),
              sortOrder: nextOrder,
              createdAt: now,
              updatedAt: now,
            })
          : AutoSchedule.parse({
              ...existing,
              id: copyId,
              name: `${baseName} 副本`,
              enabled: false,
              steps: existing.steps.map((s) => ({ ...s, id: randomUUID() })),
              sortOrder: nextOrder,
              createdAt: now,
              updatedAt: now,
            });
      this.db
        .prepare(
          `INSERT INTO auto_scheduler_schedules(id, sort_order, enabled, carrier, body_json, created_at, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          cloned.id,
          cloned.sortOrder,
          cloned.enabled ? 1 : 0,
          cloned.carrier,
          JSON.stringify(cloned),
          cloned.createdAt,
          cloned.updatedAt,
        );
      return cloned;
    });
  }

  deleteSchedule(input: unknown): boolean {
    const { id } = ScheduleIdInput.parse(input);
    const res = this.db.prepare('DELETE FROM auto_scheduler_schedules WHERE id = ?').run(id);
    return res.changes > 0;
  }

  saveRun(run: AutoScheduleRun): AutoScheduleRun {
    const parsed = AutoScheduleRun.parse({
      ...run,
      scheduleName: run.scheduleName.slice(0, 120),
      statusReason: run.statusReason.slice(0, 300),
    });
    this.db
      .prepare(
        `INSERT INTO auto_scheduler_runs(
          id, schedule_id, schedule_name, carrier, phase, slot_key, trigger_mode,
          status, status_reason, total_targets, completed_count, soft_issue_count,
          hard_blocked_count, watchdog_timeout_count, skipped_count,
          scheduled_for, started_at, finished_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          status_reason = excluded.status_reason,
          total_targets = excluded.total_targets,
          completed_count = excluded.completed_count,
          soft_issue_count = excluded.soft_issue_count,
          hard_blocked_count = excluded.hard_blocked_count,
          watchdog_timeout_count = excluded.watchdog_timeout_count,
          skipped_count = excluded.skipped_count,
          finished_at = excluded.finished_at`,
      )
      .run(
        parsed.id,
        parsed.scheduleId,
        parsed.scheduleName,
        parsed.carrier,
        parsed.phase,
        parsed.slotKey,
        parsed.triggerMode,
        parsed.status,
        parsed.statusReason,
        parsed.totalTargets,
        parsed.completedCount,
        parsed.softIssueCount,
        parsed.hardBlockedCount,
        parsed.watchdogTimeoutCount,
        parsed.skippedCount,
        parsed.scheduledFor,
        parsed.startedAt,
        parsed.finishedAt,
      );
    return parsed;
  }

  saveRunItem(item: AutoScheduleRunItem): void {
    const parsed = AutoScheduleRunItem.parse({
      ...item,
      targetName: item.targetName.slice(0, 200),
      currentStep: item.currentStep.slice(0, 200),
      summary: item.summary.slice(0, 400),
      hardBlockReason: item.hardBlockReason ? item.hardBlockReason.slice(0, 240) : null,
    });
    this.db
      .prepare(
        `INSERT INTO auto_scheduler_run_items(
          run_id, target_id, target_name, status, current_step, summary,
          bumped_count, posted_count, soft_issues, hard_block_reason,
          seamless_handoff, started_at, finished_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, target_id) DO UPDATE SET
          target_name = excluded.target_name,
          status = excluded.status,
          current_step = excluded.current_step,
          summary = excluded.summary,
          bumped_count = excluded.bumped_count,
          posted_count = excluded.posted_count,
          soft_issues = excluded.soft_issues,
          hard_block_reason = excluded.hard_block_reason,
          seamless_handoff = excluded.seamless_handoff,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        parsed.runId,
        parsed.targetId,
        parsed.targetName,
        parsed.status,
        parsed.currentStep,
        parsed.summary,
        parsed.bumpedCount,
        parsed.postedCount,
        parsed.softIssues,
        parsed.hardBlockReason,
        parsed.seamlessHandoff ? 1 : 0,
        parsed.startedAt,
        parsed.finishedAt,
        parsed.updatedAt,
      );
  }

  saveRunWithItems(run: AutoScheduleRun, items: readonly AutoScheduleRunItem[]): void {
    transaction(this.db, () => {
      this.saveRun(run);
      for (const item of items) this.saveRunItem(item);
    });
  }

  private mapRunRow(
    row: Record<string, unknown>,
    items?: AutoScheduleRunItem[],
  ): AutoScheduleRun | null {
    try {
      return AutoScheduleRun.parse({
        id: String(row.id),
        scheduleId: String(row.schedule_id),
        scheduleName: String(row.schedule_name ?? '').slice(0, 120),
        carrier: String(row.carrier),
        phase: String(row.phase),
        slotKey: String(row.slot_key),
        triggerMode: String(row.trigger_mode),
        status: String(row.status),
        statusReason: String(row.status_reason ?? '').slice(0, 300),
        totalTargets: Number(row.total_targets ?? 0),
        completedCount: Number(row.completed_count ?? 0),
        softIssueCount: Number(row.soft_issue_count ?? 0),
        hardBlockedCount: Number(row.hard_blocked_count ?? 0),
        watchdogTimeoutCount: Number(row.watchdog_timeout_count ?? 0),
        skippedCount: Number(row.skipped_count ?? 0),
        scheduledFor: Number(row.scheduled_for ?? 0),
        startedAt: Number(row.started_at ?? 0),
        finishedAt:
          row.finished_at === null || row.finished_at === undefined
            ? null
            : Number(row.finished_at),
        ...(items ? { items } : {}),
      });
    } catch {
      return null;
    }
  }

  private listItemsForRun(runId: string): AutoScheduleRunItem[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM auto_scheduler_run_items WHERE run_id = ? ORDER BY COALESCE(started_at, 9999999999999) ASC, target_name ASC',
      )
      .all(runId) as Array<Record<string, unknown>>;
    const out: AutoScheduleRunItem[] = [];
    for (const r of rows) {
      try {
        out.push(
          AutoScheduleRunItem.parse({
            runId: String(r.run_id),
            targetId: String(r.target_id),
            targetName: String(r.target_name ?? '').slice(0, 200),
            status: String(r.status),
            currentStep: String(r.current_step ?? '').slice(0, 200),
            summary: String(r.summary ?? '').slice(0, 400),
            bumpedCount: Number(r.bumped_count ?? 0),
            postedCount: Number(r.posted_count ?? 0),
            softIssues: Number(r.soft_issues ?? 0),
            hardBlockReason:
              r.hard_block_reason === null || r.hard_block_reason === undefined
                ? null
                : String(r.hard_block_reason).slice(0, 240),
            seamlessHandoff: Number(r.seamless_handoff ?? 0) === 1,
            startedAt:
              r.started_at === null || r.started_at === undefined ? null : Number(r.started_at),
            finishedAt:
              r.finished_at === null || r.finished_at === undefined ? null : Number(r.finished_at),
            updatedAt: Number(r.updated_at ?? 0),
          }),
        );
      } catch {
        /* ignore malformed legacy row */
      }
    }
    return out;
  }

  getRun(runId: string): AutoScheduleRun | null {
    const row = this.db.prepare('SELECT * FROM auto_scheduler_runs WHERE id = ?').get(runId) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRunRow(row, this.listItemsForRun(runId));
  }

  listRuns(limit = 20, includeItemsLimit = 8): AutoScheduleRun[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.db
      .prepare(
        'SELECT * FROM auto_scheduler_runs WHERE hidden_from_history = 0 ORDER BY started_at DESC LIMIT ?',
      )
      .all(safeLimit) as Array<Record<string, unknown>>;
    const out: AutoScheduleRun[] = [];
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      if (!row) continue;
      const mapped = this.mapRunRow(
        row,
        idx < includeItemsLimit ? this.listItemsForRun(String(row.id)) : undefined,
      );
      if (mapped) out.push(mapped);
    }
    return out;
  }

  /**
   * 返回指定排班在最近窗口内已经完整结束（非软件重启半途中断）的 Cron 场次键。
   * 若某场次上次因软件重启中断（status='stopped' 且 status_reason 含「工作台重启收尾」），不列入已完结键，
   * 以便在补跑有效期内自动恢复并仅续跑剩余未完成账号。
   */
  listHandledSlotKeys(scheduleId: string, sinceMs: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT slot_key, status, status_reason
         FROM auto_scheduler_runs
         WHERE schedule_id = ? AND trigger_mode = 'cron' AND scheduled_for >= ?`,
      )
      .all(scheduleId, sinceMs) as Array<{
      slot_key: string;
      status: string;
      status_reason: string;
    }>;
    const out = new Set<string>();
    for (const r of rows) {
      if (r.status === 'stopped' && r.status_reason.includes('工作台重启收尾')) continue;
      out.add(String(r.slot_key));
    }
    return [...out];
  }

  listFinishedTargetIdsForSlot(scheduleId: string, slotKey: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT i.target_id
         FROM auto_scheduler_run_items i
         JOIN auto_scheduler_runs r ON r.id = i.run_id
         WHERE r.schedule_id = ? AND r.slot_key = ?
           AND i.status IN ('completed', 'soft_warning', 'hard_blocked', 'watchdog_timeout')`,
      )
      .all(scheduleId, slotKey) as Array<{ target_id: string }>;
    return rows.map((r) => String(r.target_id));
  }

  listHardBlockedTargetIdsSince(scheduleId: string, sinceMs: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT i.target_id
         FROM auto_scheduler_run_items i
         JOIN auto_scheduler_runs r ON r.id = i.run_id
         WHERE r.schedule_id = ? AND r.started_at >= ? AND i.status = 'hard_blocked'`,
      )
      .all(scheduleId, sinceMs) as Array<{ target_id: string }>;
    return rows.map((r) => String(r.target_id));
  }

  recoverInterruptedRunsOnStartup(nowMs = Date.now()): number {
    return transaction(this.db, () => {
      const runningRows = this.db
        .prepare("SELECT id FROM auto_scheduler_runs WHERE status = 'running'")
        .all() as Array<{ id: string }>;
      if (runningRows.length === 0) return 0;
      for (const row of runningRows) {
        this.db
          .prepare(
            `UPDATE auto_scheduler_run_items
             SET status = 'stopped',
                 current_step = '已结束',
                 summary = '工作台重启收尾',
                 finished_at = ?,
                 updated_at = ?
             WHERE run_id = ? AND status IN ('queued', 'running')`,
          )
          .run(nowMs, nowMs, row.id);
        this.db
          .prepare(
            `UPDATE auto_scheduler_runs
             SET status = 'stopped',
                 status_reason = '工作台重启收尾（已完成账号保留记录，补跑窗内自动续跑剩余账号）',
                 finished_at = ?
             WHERE id = ?`,
          )
          .run(nowMs, row.id);
      }
      return runningRows.length;
    });
  }

  pruneOldRuns(keepMaxRuns = 120): number {
    const safeKeep = Math.max(20, Math.floor(keepMaxRuns));
    return transaction(this.db, () => {
      const stale = this.db
        .prepare(
          `SELECT id FROM auto_scheduler_runs
           WHERE status != 'running'
           ORDER BY started_at DESC
           LIMIT -1 OFFSET ?`,
        )
        .all(safeKeep) as Array<{ id: string }>;
      if (stale.length === 0) return 0;
      const delItems = this.db.prepare('DELETE FROM auto_scheduler_run_items WHERE run_id = ?');
      const delRun = this.db.prepare('DELETE FROM auto_scheduler_runs WHERE id = ?');
      for (const r of stale) {
        delItems.run(r.id);
        delRun.run(r.id);
      }
      return stale.length;
    });
  }

  clearHistoryRuns(): number {
    return transaction(this.db, () => {
      // Soft-hide recent completed runs from UI history while retaining 48h slot-dedup &
      // 18h hard-blocked markers so cron slots never double-fire after clearing history.
      const hidden = Number(
        this.db
          .prepare(
            "UPDATE auto_scheduler_runs SET hidden_from_history = 1 WHERE status != 'running' AND hidden_from_history = 0",
          )
          .run().changes,
      );
      const cutoffMs = Date.now() - 48 * 3600_000;
      const expired = this.db
        .prepare(
          "SELECT id FROM auto_scheduler_runs WHERE status != 'running' AND hidden_from_history = 1 AND started_at < ?",
        )
        .all(cutoffMs) as Array<{ id: string }>;
      if (expired.length > 0) {
        const delItems = this.db.prepare('DELETE FROM auto_scheduler_run_items WHERE run_id = ?');
        const delRun = this.db.prepare('DELETE FROM auto_scheduler_runs WHERE id = ?');
        for (const r of expired) {
          delItems.run(r.id);
          delRun.run(r.id);
        }
      }
      return hidden;
    });
  }
}
