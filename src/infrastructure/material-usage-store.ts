import type { SynchronousRepository } from '../domain/persistence.js';
import type { DatabaseSync } from 'node:sqlite';
import type { MaterialUsageRepository as CompatibleMaterialUsageRepository } from '../domain/material-usage.js';
import {
  MaterialUsageSnapshot,
  ClearMaterialUsage,
  ClearedMaterialUsage,
  type MaterialUsageClearRequest,
} from '../shared/material-usage.js';
import { ProductError } from '../domain/workspace.js';
import { transaction } from './sqlite-transaction.js';
import type { ResourceOrigin } from '../shared/resource-materials.js';

export const materialUsageSourceKey = (
  directory: string | null,
  source: string,
  resource?: ResourceOrigin,
) =>
  resource
    ? 'resource:' + resource.combinationId + ':' + JSON.stringify(resource.row)
    : 'directory:' + String(directory).toLowerCase() + ':' + source.toLowerCase();
export const materialSourceAlreadyUsed = (db: DatabaseSync, key: string) =>
  !!db
    .prepare(
      'SELECT attempt_id FROM material_publications WHERE usage_source_key=? AND usage_generation=(SELECT generation FROM material_usage_policy WHERE id=1) LIMIT 1',
    )
    .get(key);

export const currentMaterialUsageAccounts = (db: DatabaseSync, fingerprint: string) =>
  db
    .prepare(
      'SELECT account_id FROM material_publications WHERE fingerprint=? AND usage_generation=(SELECT generation FROM material_usage_policy WHERE id=1)',
    )
    .all(fingerprint);
// Retained solely for generated historical archive regression fixtures. The product server
// never launches archive IO and the user API cannot change this policy.
export const historicalArchiveTestEnabled = (db: DatabaseSync) =>
  db.prepare('SELECT file_policy FROM material_usage_policy WHERE id=1').get()?.file_policy ===
  'archive-test';

export class SqliteMaterialUsageRepository implements MaterialUsageRepository {
  constructor(private readonly db: DatabaseSync) {}
  snapshot() {
    const policy = this.db
      .prepare('SELECT generation,last_cleared_at FROM material_usage_policy WHERE id=1')
      .get();
    const count = this.db
      .prepare(
        'SELECT count(*) AS published,count(DISTINCT usage_source_key) AS contents FROM material_publications WHERE usage_generation=?',
      )
      .get(Number(policy?.generation));
    const active = this.db
      .prepare(
        "SELECT id FROM task_plans p WHERE p.state NOT IN ('COMPLETED','STOPPED','FAILED') AND EXISTS(SELECT 1 FROM json_each(p.snapshot,'$.steps') s WHERE json_extract(s.value,'$.type')='post') LIMIT 1",
      )
      .get();
    return MaterialUsageSnapshot.parse({
      generation: Number(policy?.generation),
      published: Number(count?.published),
      contents: Number(count?.contents),
      lastClearedAt: policy?.last_cleared_at ?? null,
      activePublishing: !!active,
    });
  }
  clear(input: MaterialUsageClearRequest) {
    const request = ClearMaterialUsage.parse(input);
    return transaction(this.db, () => {
      const existing = this.db
        .prepare('SELECT request,body FROM material_usage_resets WHERE id=?')
        .get(request.requestId);
      if (existing) {
        if (existing.request !== JSON.stringify(request))
          throw new ProductError('MATERIAL_USAGE_CLEAR_CONFLICT', '清空标识与原请求不一致', 409);
        return ClearedMaterialUsage.parse(JSON.parse(String(existing.body)));
      }
      const current = this.snapshot();
      if (current.activePublishing)
        throw new ProductError(
          'MATERIAL_USAGE_PUBLISHING_ACTIVE',
          '有发帖任务尚未结束，请先停止后再清空使用记录',
          409,
        );
      if (
        current.generation !== request.expectedGeneration ||
        current.published !== request.expectedPublished
      )
        throw new ProductError(
          'MATERIAL_USAGE_CHANGED',
          '素材使用记录已变化，请重新读取后确认清空',
          409,
        );
      const result = ClearedMaterialUsage.parse({
        requestId: request.requestId,
        previousGeneration: current.generation,
        generation: current.generation + 1,
        clearedPublications: current.published,
        clearedAt: Date.now(),
      });
      this.db
        .prepare('UPDATE material_usage_policy SET generation=?,last_cleared_at=? WHERE id=1')
        .run(result.generation, result.clearedAt);
      this.db
        .prepare('INSERT INTO material_usage_resets VALUES(?,?,?,?)')
        .run(request.requestId, JSON.stringify(request), JSON.stringify(result), result.clearedAt);
      return result;
    });
  }
}

type MaterialUsageRepository = SynchronousRepository<CompatibleMaterialUsageRepository>;
