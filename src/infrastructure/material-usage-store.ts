import type { SynchronousRepository } from '../domain/persistence.js';
import type { DatabaseSync } from 'node:sqlite';
import type { MaterialUsageRepository as CompatibleMaterialUsageRepository } from '../domain/resource-material-rules.js';
import {
  MaterialUsageSnapshot,
  ClearMaterialUsage,
  ClearedMaterialUsage,
  type MaterialUsageClearRequest,
} from '../shared/material-usage.js';
import { ProductError } from '../domain/workspace.js';
import { sqliteTableExists } from './persistence/sqlite-query-helpers.js';
import { transaction } from './sqlite-transaction.js';
import type { ResourceOrigin } from '../shared/resource-materials.js';

export const materialUsageSourceKey = (resource: ResourceOrigin) =>
  'resource:' + resource.combinationId + ':' + JSON.stringify(resource.row);

export class SqliteMaterialUsageRepository implements MaterialUsageRepository {
  constructor(private readonly db: DatabaseSync) {}
  snapshot() {
    const policy = this.db
      .prepare('SELECT generation,last_cleared_at FROM material_usage_policy WHERE id=1')
      .get();
    const generation = Number(policy?.generation);
    const legacyRows = this.db
      .prepare('SELECT usage_source_key FROM material_publications WHERE usage_generation=?')
      .all(generation);
    const directRows = sqliteTableExists(this.db, 'direct_material_publications')
      ? this.db
          .prepare(
            'SELECT usage_source_key FROM direct_material_publications WHERE usage_generation=?',
          )
          .all(generation)
      : [];
    const distinctKeys = new Set<string>();
    for (const row of legacyRows) distinctKeys.add(String(row.usage_source_key));
    for (const row of directRows) distinctKeys.add(String(row.usage_source_key));
    const active = this.db
      .prepare(
        "SELECT id FROM task_plans p WHERE p.state NOT IN ('COMPLETED','STOPPED','FAILED') AND EXISTS(SELECT 1 FROM json_each(p.snapshot,'$.steps') s WHERE json_extract(s.value,'$.type')='post') LIMIT 1",
      )
      .get();
    return MaterialUsageSnapshot.parse({
      generation,
      published: legacyRows.length + directRows.length,
      contents: distinctKeys.size,
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
      ) {
        throw new ProductError(
          'MATERIAL_USAGE_CHANGED',
          '素材使用记录已变化，请重新读取后确认清空',
          409,
        );
      }
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
