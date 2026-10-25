import type { Awaitable } from '../domain/persistence.js';
import {
  MaterialCacheCleanRequest,
  MaterialCacheCleanResult,
  MaterialCacheOverview,
  type CacheOverview,
} from '../shared/material-cache-management.js';
import type { MaterialCacheCleanup } from './material-cache-cleanup.js';
import { ProductError } from '../domain/workspace.js';

export interface MaterialCacheCatalog {
  snapshot(): Awaitable<CacheOverview>;
  cleanupStop(stageId: string): Awaitable<string>;
}
export class MaterialCacheManagement {
  private busy = false;
  constructor(
    private readonly catalog: MaterialCacheCatalog,
    private readonly cleanup: MaterialCacheCleanup,
  ) {}
  async snapshot() {
    return MaterialCacheOverview.parse(await this.catalog.snapshot());
  }
  async clean(input: unknown) {
    const request = MaterialCacheCleanRequest.parse(input);
    if (this.busy) throw new ProductError('CACHE_CLEANUP_BUSY', '缓存清理正在执行', 409);
    this.busy = true;
    try {
      const results = [];
      const started = performance.now();
      for (const stageId of request.stageIds) {
        if (performance.now() - started >= 60_000) {
          results.push({ stageId, cleaned: false, reason: 'CACHE_CLEANUP_BATCH_BUDGET' });
          continue;
        }
        try {
          const stop = await this.catalog.cleanupStop(stageId);
          const result = await this.cleanup.run(stageId, stop);
          results.push({ stageId, cleaned: result.state === 'CLEANED', reason: '' });
        } catch (error) {
          results.push({
            stageId,
            cleaned: false,
            reason: error instanceof Error ? error.message.slice(0, 200) : 'CACHE_CLEANUP_FAILED',
          });
        }
      }
      return MaterialCacheCleanResult.parse({ results });
    } finally {
      this.busy = false;
    }
  }
}
