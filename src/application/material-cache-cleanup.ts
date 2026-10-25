import type { MaterialCacheCleanupRepository } from '../domain/material-cache-cleanup.js';
import type { CleanupClaim } from '../shared/material-cache-cleanup.js';
export interface MaterialCacheCleaner {
  clean(claim: CleanupClaim): Promise<void>;
}
// Internal lifecycle invocation only. No HTTP mutation endpoint or automatic retry timer.
export class MaterialCacheCleanup {
  constructor(
    private readonly ledger: MaterialCacheCleanupRepository,
    private readonly files: MaterialCacheCleaner,
  ) {}
  async run(stageId: string, stopRequestId: string) {
    const original = await this.ledger.prepare(stageId, stopRequestId);
    if (original.state === 'CLEANED') return original;
    const claim = await this.ledger.claim(stageId, original.revision);
    try {
      await this.files.clean(claim);
      return await this.ledger.get(stageId);
    } catch (error) {
      await this.ledger.review(
        claim,
        error instanceof Error ? error.message : 'CACHE_CLEANUP_FAILED',
      );
      throw error;
    }
  }
}
