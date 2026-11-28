import type { SynchronousRepository } from '../domain/persistence.js';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  ResourceTable,
  SaveResourceTable,
  ResourceSummary,
  type ResourceRowValue,
  type ResourceUsageSummaryValue,
} from '../shared/resource-table.js';
import {
  validateResourceRows,
  hasResource,
  ResourceTableRepository as CompatibleResourceTableRepository,
} from '../domain/resource-table.js';
import { ProductError, failError } from '../domain/workspace.js';
import { readSnapshot, transaction } from './sqlite-transaction.js';
import { ResourceMaterialPostIntent } from '../shared/material-index.js';
import { AttemptVerdict } from '../shared/material-post.js';
import { ResourceMaterialOrigin } from '../shared/resource-materials.js';
import {
  summarizeResourceUsage,
  type ResourceUsageFact,
} from '../domain/resource-material-rules.js';
import * as Q from './persistence/sqlite-query-helpers.js';
export class SqliteResourceTableRepository implements ResourceTableRepository {
  private usageCache: {
    dataVersion: number;
    changes: number;
    values: ResourceUsageSummaryValue[];
  } | null = null;
  constructor(private readonly db: DatabaseSync) {}
  private consumed(combinationId: string, row: ResourceRowValue) {
    const key = 'resource:' + combinationId + ':' + JSON.stringify(row);
    const s1 =
      "SELECT 1 FROM material_publications p JOIN material_post_intents i USING(attempt_id) WHERE p.usage_source_key=? AND p.usage_generation=(SELECT generation FROM material_usage_policy WHERE id=1) AND coalesce(json_extract(i.body,'$.allowRepeat'),0)=0 LIMIT 1";
    const s2 =
      'SELECT 1 FROM direct_material_publications WHERE usage_source_key=? AND usage_generation=(SELECT generation FROM material_usage_policy WHERE id=1) AND allow_repeat=0 LIMIT 1';
    return Boolean(
      this.db.prepare(s1).get(key) ||
      (Q.sqliteTableExists(this.db, 'direct_material_publications') &&
        this.db.prepare(s2).get(key)),
    );
  }
  private append(
    combinationId: string,
    revision: number,
    rows: ResourceRowValue[],
    now = Date.now(),
  ) {
    const hSql =
      'INSERT INTO resource_table_heads VALUES(?,?) ON CONFLICT(combination_id) DO UPDATE SET revision=excluded.revision';
    Q.run(
      this.db,
      'INSERT INTO resource_table_versions VALUES(?,?,?,?)',
      combinationId,
      revision,
      JSON.stringify(rows),
      now,
    );
    Q.run(this.db, hSql, combinationId, revision);
    this.usageCache = null;
  }
  removePublishedRow(combinationId: string, consumed: ResourceRowValue, now: number) {
    transaction(this.db, () => {
      const cur = this.read(combinationId),
        cJson = JSON.stringify(consumed),
        rows = cur.rows.filter((r) => JSON.stringify(r) !== cJson);
      if (rows.length !== cur.rows.length) this.append(combinationId, cur.revision + 1, rows, now);
    });
  }
  pruneConsumedRows() {
    transaction(this.db, () => {
      for (const head of this.db.prepare('SELECT combination_id FROM resource_table_heads').all()) {
        const cur = this.read(String(head.combination_id)),
          rows = cur.rows.filter((r) => !this.consumed(cur.combinationId, r));
        if (rows.length !== cur.rows.length) this.append(cur.combinationId, cur.revision + 1, rows);
      }
    });
  }
  readVersion(combinationId: string, revision: number) {
    z.uuid().parse(combinationId);
    z.number().int().positive().parse(revision);
    const sql =
      'SELECT body,updated_at FROM resource_table_versions WHERE combination_id=? AND revision=?';
    const row = Q.getRow(this.db, sql, combinationId, revision);
    if (!row) throw new ProductError('RESOURCE_VERSION_NOT_FOUND', '任务固定的资源版本不存在', 404);
    return ResourceTable.parse({
      combinationId,
      revision,
      updatedAt: Number(row.updated_at),
      rows: JSON.parse(String(row.body)) as unknown,
      publishingReady: false,
    });
  }
  revision(combinationId: string) {
    z.uuid().parse(combinationId);
    const sql =
      'SELECT c.id,h.revision FROM combinations c LEFT JOIN resource_table_heads h ON c.id=h.combination_id WHERE c.id=?';
    const row = Q.getRow(this.db, sql, combinationId);
    if (!row) throw new ProductError('COMBINATION_NOT_FOUND', '任务组合不存在', 404);
    return row.revision === null ? 0 : Number(row.revision);
  }
  read(combinationId: string) {
    z.uuid().parse(combinationId);
    if (!this.db.prepare('SELECT id FROM combinations WHERE id=?').get(combinationId))
      throw new ProductError('COMBINATION_NOT_FOUND', '任务组合不存在', 404);
    const sql =
      'SELECT v.* FROM resource_table_versions v JOIN resource_table_heads h ON v.combination_id=h.combination_id AND v.revision=h.revision WHERE v.combination_id=?';
    const row = Q.getRow(this.db, sql, combinationId);
    return ResourceTable.parse({
      combinationId,
      revision: row ? Number(row.revision) : 0,
      updatedAt: row ? Number(row.updated_at) : 0,
      rows: row ? (JSON.parse(String(row.body)) as unknown) : [],
      publishingReady: false,
    });
  }
  save(combinationId: string, expectedRevision: number, input: ResourceRowValue[]) {
    const value = SaveResourceTable.parse({ combinationId, expectedRevision, rows: input });
    let rows = validateResourceRows(value.rows);
    return transaction(this.db, () => {
      const cur = this.read(value.combinationId);
      if (cur.revision !== value.expectedRevision) {
        let merged = false;
        if (cur.revision > value.expectedRevision && value.expectedRevision > 0) {
          const base = this.readVersion(combinationId, value.expectedRevision),
            keys = new Set(cur.rows.map((r) => JSON.stringify(r))),
            removed = base.rows.filter((r) => !keys.has(JSON.stringify(r)));
          if (
            removed.length > 0 &&
            JSON.stringify(base.rows.filter((r) => keys.has(JSON.stringify(r)))) ===
              JSON.stringify(cur.rows) &&
            removed.every((r) => this.consumed(combinationId, r))
          ) {
            const ids = new Set(removed.map((r) => r.id));
            rows = rows.filter((r) => !ids.has(r.id));
            merged = true;
          }
        }
        if (!merged)
          failError(
            'RESOURCE_REVISION_CONFLICT',
            '资源表已在其他窗口修改，当前内容保留；请重新打开核对',
            409,
          );
      }
      this.append(combinationId, cur.revision + 1, rows);
      return this.read(combinationId);
    });
  }
  summaries = () =>
    this.db
      .prepare('SELECT combination_id FROM resource_table_heads ORDER BY combination_id')
      .all()
      .map((row) => {
        const t = this.read(String(row.combination_id));
        return ResourceSummary.parse({
          combinationId: t.combinationId,
          revision: t.revision,
          remaining: t.rows.filter(hasResource).length,
          verifiedReady: 0,
        });
      });
  usageSummaries() {
    const read = () => {
      const facts = new Map<string, ResourceUsageFact[]>(),
        pushFact = (id: string, fact: ResourceUsageFact) => {
          const list = facts.get(id) ?? [];
          list.push(fact);
          facts.set(id, list);
        };
      const sql = `SELECT i.body,r.state,b.combination_id,b.resource_revision,p.account_id,p.fingerprint,p.post_id,v.body AS verdict, EXISTS(SELECT 1 FROM material_post_operations m JOIN task_outbox o ON o.id=m.operation_id WHERE m.attempt_id=i.attempt_id AND o.status='UNKNOWN') AS unresolved FROM material_post_intents i JOIN material_reservations r USING(attempt_id) JOIN task_resource_bindings b ON b.job_id=i.job_id LEFT JOIN material_publications p USING(attempt_id) LEFT JOIN material_attempt_verdicts v USING(attempt_id) WHERE r.state IN ('RESERVED','REVIEW','PUBLISHED') AND (r.state<>'PUBLISHED' OR p.usage_generation=(SELECT generation FROM material_usage_policy WHERE id=1)) AND json_type(i.body,'$.resource') IS NOT NULL`;
      for (const rec of Q.allRows(this.db, sql)) {
        const intent = ResourceMaterialPostIntent.parse(JSON.parse(String(rec.body)) as unknown);
        if (
          intent.resource.combinationId !== rec.combination_id ||
          intent.resource.revision !== Number(rec.resource_revision)
        )
          throw Error('RESOURCE_USAGE_LEDGER_INVALID');
        if (rec.state === 'PUBLISHED') {
          const verdict = AttemptVerdict.parse(JSON.parse(String(rec.verdict)) as unknown);
          if (
            verdict.basis !== 'SUBMIT_OPERATION' ||
            verdict.outcome !== 'PUBLISHED' ||
            verdict.attemptId !== intent.attemptId ||
            verdict.receipt.evidence.fingerprint !== intent.fingerprint ||
            verdict.receipt.evidence.observedAccountId !== intent.context.accountId ||
            verdict.receipt.evidence.postId !== rec.post_id ||
            rec.account_id !== intent.context.accountId ||
            rec.fingerprint !== intent.fingerprint
          )
            throw Error('RESOURCE_USAGE_LEDGER_INVALID');
        } else if (rec.post_id !== null || rec.verdict !== null)
          throw Error('RESOURCE_USAGE_LEDGER_INVALID');
        pushFact(intent.resource.combinationId, {
          attemptId: intent.attemptId,
          resource: intent.resource,
          state:
            rec.state === 'PUBLISHED'
              ? 'PUBLISHED'
              : rec.state === 'REVIEW' || rec.unresolved === 1
                ? 'REVIEW'
                : 'RESERVED',
        });
      }
      if (Q.sqliteTableExists(this.db, 'direct_material_publications')) {
        const dSql =
          'SELECT id, resource_origin FROM direct_material_publications WHERE usage_generation=(SELECT generation FROM material_usage_policy WHERE id=1) AND resource_origin IS NOT NULL';
        for (const rec of Q.allRows(this.db, dSql)) {
          const parsed = ResourceMaterialOrigin.safeParse(
            JSON.parse(String(rec.resource_origin)) as unknown,
          );
          if (parsed.success)
            pushFact(parsed.data.combinationId, {
              attemptId: String(rec.id),
              resource: parsed.data,
              state: 'PUBLISHED',
            });
        }
      }
      return this.db
        .prepare('SELECT combination_id FROM resource_table_heads ORDER BY combination_id')
        .all()
        .map((head) => {
          const id = String(head.combination_id);
          return summarizeResourceUsage(this.read(id), facts.get(id) ?? []);
        });
    };
    if (this.db.isTransaction) return readSnapshot(this.db, read);
    const dataVersion = Number(this.db.prepare('PRAGMA data_version').get()?.data_version),
      changes = Number(this.db.prepare('SELECT total_changes() AS n').get()?.n);
    if (this.usageCache?.dataVersion === dataVersion && this.usageCache.changes === changes)
      return structuredClone(this.usageCache.values);
    const result = readSnapshot(this.db, read);
    this.usageCache = { dataVersion, changes, values: result };
    return structuredClone(result);
  }
}
type ResourceTableRepository = SynchronousRepository<CompatibleResourceTableRepository>;
