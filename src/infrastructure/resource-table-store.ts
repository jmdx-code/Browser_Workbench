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
import { ProductError } from '../domain/workspace.js';
import { readSnapshot, transaction } from './sqlite-transaction.js';
import { assertArchiveSourcesAvailable } from './material-archive-source-protection.js';
import { ResourceMaterialPostIntent } from '../shared/material-index.js';
import { AttemptVerdict } from '../shared/material-post.js';
import { summarizeResourceUsage, type ResourceUsageFact } from '../domain/resource-usage.js';

export class SqliteResourceTableRepository implements ResourceTableRepository {
  private usageCache: {
    dataVersion: number;
    changes: number;
    values: ResourceUsageSummaryValue[];
  } | null = null;
  constructor(private readonly db: DatabaseSync) {}
  readVersion(combinationId: string, revision: number) {
    z.uuid().parse(combinationId);
    z.number().int().positive().parse(revision);
    const row = this.db
      .prepare(
        'SELECT body,updated_at FROM resource_table_versions WHERE combination_id=? AND revision=?',
      )
      .get(combinationId, revision);
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
    const row = this.db
      .prepare(
        'SELECT c.id,h.revision FROM combinations c LEFT JOIN resource_table_heads h ON c.id=h.combination_id WHERE c.id=?',
      )
      .get(combinationId);
    if (!row) throw new ProductError('COMBINATION_NOT_FOUND', '任务组合不存在', 404);
    return row.revision === null ? 0 : Number(row.revision);
  }
  read(combinationId: string) {
    z.uuid().parse(combinationId);
    if (!this.db.prepare('SELECT id FROM combinations WHERE id=?').get(combinationId))
      throw new ProductError('COMBINATION_NOT_FOUND', '任务组合不存在', 404);
    const row = this.db
      .prepare(
        'SELECT v.* FROM resource_table_versions v JOIN resource_table_heads h ON v.combination_id=h.combination_id AND v.revision=h.revision WHERE v.combination_id=?',
      )
      .get(combinationId);
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
    const rows = validateResourceRows(value.rows);
    return transaction(this.db, () => {
      const current = this.read(value.combinationId);
      assertArchiveSourcesAvailable(
        this.db,
        rows.flatMap((row) => row.media.filter((m) => m.kind === 'local').map((m) => m.source)),
      );
      if (current.revision !== value.expectedRevision)
        throw new ProductError(
          'RESOURCE_REVISION_CONFLICT',
          '资源表已在其他窗口修改，当前内容保留；请重新打开核对',
          409,
        );
      const revision = current.revision + 1;
      this.db
        .prepare('INSERT INTO resource_table_versions VALUES(?,?,?,?)')
        .run(combinationId, revision, JSON.stringify(rows), Date.now());
      this.db
        .prepare(
          'INSERT INTO resource_table_heads VALUES(?,?) ON CONFLICT(combination_id) DO UPDATE SET revision=excluded.revision',
        )
        .run(combinationId, revision);
      return this.read(combinationId);
    });
  }
  summaries() {
    return this.db
      .prepare('SELECT combination_id FROM resource_table_heads ORDER BY combination_id')
      .all()
      .map((row) => {
        const table = this.read(String(row.combination_id));
        return ResourceSummary.parse({
          combinationId: table.combinationId,
          revision: table.revision,
          remaining: table.rows.filter(hasResource).length,
          verifiedReady: 0,
        });
      });
  }
  usageSummaries() {
    // One read transaction observes the head and the original settlement atomically, including
    // writes from other handles. It acquires no write lock and creates no usage ledger.
    const read = () => {
      const facts = new Map<string, ResourceUsageFact[]>();
      const records = this.db
        .prepare(
          `SELECT i.body,r.state,b.combination_id,b.resource_revision,
            p.account_id,p.fingerprint,p.post_id,v.body AS verdict,
            EXISTS(SELECT 1 FROM material_post_operations m JOIN task_outbox o ON o.id=m.operation_id
              WHERE m.attempt_id=i.attempt_id AND o.status='UNKNOWN') AS unresolved
          FROM material_post_intents i JOIN material_reservations r USING(attempt_id)
          JOIN task_resource_bindings b ON b.job_id=i.job_id
          LEFT JOIN material_publications p USING(attempt_id)
          LEFT JOIN material_attempt_verdicts v USING(attempt_id)
          WHERE r.state IN ('RESERVED','REVIEW','PUBLISHED')
            AND (r.state<>'PUBLISHED' OR p.usage_generation=(SELECT generation FROM material_usage_policy WHERE id=1))
            AND json_type(i.body,'$.resource') IS NOT NULL`,
        )
        .all();
      for (const record of records) {
        const intent = ResourceMaterialPostIntent.parse(JSON.parse(String(record.body)) as unknown);
        if (
          intent.resource.combinationId !== record.combination_id ||
          intent.resource.revision !== Number(record.resource_revision)
        )
          throw Error('RESOURCE_USAGE_LEDGER_INVALID');
        if (record.state === 'PUBLISHED') {
          const verdict = AttemptVerdict.parse(JSON.parse(String(record.verdict)) as unknown);
          if (
            verdict.basis !== 'SUBMIT_OPERATION' ||
            verdict.outcome !== 'PUBLISHED' ||
            verdict.attemptId !== intent.attemptId ||
            verdict.receipt.evidence.fingerprint !== intent.fingerprint ||
            verdict.receipt.evidence.observedAccountId !== intent.context.accountId ||
            verdict.receipt.evidence.postId !== record.post_id ||
            record.account_id !== intent.context.accountId ||
            record.fingerprint !== intent.fingerprint
          )
            throw Error('RESOURCE_USAGE_LEDGER_INVALID');
        } else if (record.post_id !== null || record.verdict !== null)
          throw Error('RESOURCE_USAGE_LEDGER_INVALID');
        const combinationId = intent.resource.combinationId;
        const list = facts.get(combinationId) ?? [];
        list.push({
          attemptId: intent.attemptId,
          resource: intent.resource,
          state:
            record.state === 'PUBLISHED'
              ? 'PUBLISHED'
              : record.state === 'REVIEW' || record.unresolved === 1
                ? 'REVIEW'
                : 'RESERVED',
        });
        facts.set(combinationId, list);
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
    // Five-second UI polling must not reparse an unchanged publication history. Both counters
    // matter: data_version changes for other handles, total_changes for this connection.
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
