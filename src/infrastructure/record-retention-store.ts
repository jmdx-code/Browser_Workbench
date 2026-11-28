import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { DetailBoundary, type DetailBoundaryValue } from '../shared/data-cleanup.js';
import {
  countSql,
  deleteByJsonIds,
  sqliteTableExists,
} from './persistence/sqlite-query-helpers.js';
import { transaction } from './sqlite-transaction.js';
const safeRounds = `WITH safe_rounds AS MATERIALIZED (SELECT DISTINCT s.job_id,s.round FROM task_steps s JOIN task_plans p ON p.id=s.job_id WHERE (p.state IN ('STOPPED','COMPLETED','FAILED') OR s.round<p.round)) `;
const detailRows = `
 SELECT 'event' AS source,CAST(e.sequence AS TEXT) AS id,e.created_at AS at,'event:'||e.sequence AS key,e.job_id AS job_id FROM task_events e JOIN task_plans p ON p.id=e.job_id
 WHERE EXISTS(SELECT 1 FROM safe_rounds r WHERE r.job_id=e.job_id AND (EXISTS(SELECT 1 FROM task_steps s WHERE s.id=json_extract(e.detail,'$.stepId') AND s.job_id=r.job_id AND s.round=r.round) OR json_extract(e.detail,'$.round')=r.round OR (json_extract(e.detail,'$.stepId') IS NULL AND json_extract(e.detail,'$.round') IS NULL AND p.state IN ('STOPPED','COMPLETED','FAILED'))))
 UNION ALL
 SELECT 'operation',o.id,o.updated_at,'operation:'||o.id,o.job_id FROM task_outbox o JOIN task_steps s ON s.id=o.step_id JOIN safe_rounds r ON r.job_id=s.job_id AND r.round=s.round WHERE o.status IN ('VERIFIED','FAILED','CANCELLED') AND NOT EXISTS(SELECT 1 FROM material_post_operations m WHERE m.operation_id=o.id)
 UNION ALL
 SELECT 'bumper',operation_id,updated_at,'bumper:'||operation_id,job_id FROM group_bumper_operations WHERE status='SETTLED' AND resolution_outcome<>'ENDED_UNKNOWN'
 UNION ALL
 SELECT 'poster',operation_id,updated_at,'poster:'||operation_id,job_id FROM group_poster_operations WHERE kernel_settled=1 AND status IN ('VERIFIED','NOT_APPLIED')`;
export class SqliteRecordRetention {
  constructor(private readonly db: DatabaseSync) {}
  detailHead(maximum: number): DetailBoundaryValue[] {
    const n = z.number().int().min(1).max(100000).parse(maximum);
    return this.db
      .prepare(`${safeRounds}SELECT at,key FROM (${detailRows}) ORDER BY at DESC,key DESC LIMIT ?`)
      .all(n)
      .map((r) => ({ at: Number(r.at), key: String(r.key) }));
  }
  protectedOperationIds(): string[] {
    return this.db
      .prepare(
        `SELECT id FROM task_outbox WHERE status IN ('PREPARED','DISPATCHING','ACKNOWLEDGED','UNKNOWN')
         UNION SELECT operation_id FROM group_bumper_operations WHERE status<>'SETTLED' OR resolution_outcome='ENDED_UNKNOWN'
         UNION SELECT operation_id FROM group_poster_operations WHERE kernel_settled=0 OR status='PENDING_REVIEW'
         UNION SELECT operation_id FROM group_inviter_logs WHERE confirmation='PENDING' AND operation_id IS NOT NULL`,
      )
      .all()
      .map((r) => String(r.id));
  }
  pruneResults(bumperMaximum: number, posterMaximum: number, maximum = 100): number {
    return transaction(this.db, () => {
      if (!sqliteTableExists(this.db, 'post_bump_records')) return 0;
      let removed = 0;
      const specs = [
        [
          "record_type = 'post'",
          posterMaximum,
          "AND NOT EXISTS(SELECT 1 FROM group_poster_operations o WHERE o.log_id=post_bump_records.source_log_id AND (o.kernel_settled=0 OR o.status='PENDING_REVIEW'))",
        ],
        [
          "record_type IN ('group_bump','page_bump')",
          bumperMaximum,
          "AND NOT EXISTS(SELECT 1 FROM group_bumper_operations o WHERE o.log_id=post_bump_records.source_log_id AND (o.status<>'SETTLED' OR o.resolution_outcome='ENDED_UNKNOWN'))",
        ],
      ] as const;
      for (const [typeClause, keep, protectedClause] of specs) {
        z.number().int().min(1).max(1000000).parse(keep);
        if (
          countSql(this.db, `SELECT count(*) AS n FROM post_bump_records WHERE ${typeClause}`) <=
          keep
        )
          continue;
        const boundary = this.db
          .prepare(
            `SELECT created_at AS at, id FROM post_bump_records WHERE ${typeClause} ${protectedClause} ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET ?`,
          )
          .get(keep - 1);
        if (!boundary) continue;
        removed += Number(
          this.db
            .prepare(
              `DELETE FROM post_bump_records WHERE id IN(SELECT id FROM post_bump_records WHERE ${typeClause} ${protectedClause} AND (created_at, id) < (?, ?) ORDER BY created_at, id LIMIT ?)`,
            )
            .run(boundary.at as number, boundary.id as string, maximum).changes,
        );
      }
      return removed;
    });
  }
  pruneDetails(input: unknown, maximum = 100): number {
    const boundary = DetailBoundary.parse(input),
      limit = z.number().int().min(1).max(200).parse(maximum);
    return transaction(this.db, () => {
      const rows = this.db
        .prepare(
          `${safeRounds}SELECT * FROM (${detailRows}) WHERE (at,key)<(?,?) ORDER BY at,key LIMIT ?`,
        )
        .all(boundary.at, boundary.key, limit);
      if (!rows.length) return 0;
      const taskJobs = [
        ...new Set(
          rows
            .filter((r) => r.source === 'event' || r.source === 'operation')
            .map((r) => String(r.job_id)),
        ),
      ];
      if (taskJobs.length) {
        this.db
          .prepare(
            'UPDATE task_run_summaries SET details_pruned=1 WHERE details_pruned=0 AND job_id IN(SELECT value FROM json_each(?))',
          )
          .run(JSON.stringify(taskJobs));
      }
      const ids = (source: string) =>
        rows.filter((r) => r.source === source).map((r) => String(r.id));
      const operations = ids('operation');
      deleteByJsonIds(this.db, 'task_dispatch_bindings', 'operation_id', operations);
      deleteByJsonIds(this.db, 'task_outbox', 'id', operations);
      deleteByJsonIds(this.db, 'task_events', 'sequence', ids('event'));
      deleteByJsonIds(this.db, 'group_bumper_operations', 'operation_id', ids('bumper'));
      deleteByJsonIds(this.db, 'group_poster_operations', 'operation_id', ids('poster'));
      return rows.length;
    });
  }
}
