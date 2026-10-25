import type { Awaitable } from '../domain/persistence.js';
import type { MaterialArchivePreparationRepository } from '../domain/material-archive.js';
import type { ArchivePlan } from '../shared/material-archive.js';
import type { PendingArchive } from '../shared/material-post.js';
export interface MaterialArchivePlanner {
  inspect(request: PendingArchive, assertCurrent: () => Awaitable<void>): Promise<ArchivePlan>;
}
export class MaterialArchivePreparation {
  constructor(
    private readonly ledger: MaterialArchivePreparationRepository,
    private readonly planner: MaterialArchivePlanner,
  ) {}
  async prepare(attemptId: string, assertAllowed: () => Awaitable<void> = () => {}) {
    await assertAllowed();
    const existing = await this.ledger.get(attemptId);
    if (existing?.state === 'READY') return existing;
    const claim = await this.ledger.claim(attemptId);
    try {
      const plan = await this.planner.inspect(claim.request, async () => {
        await assertAllowed();
        await this.ledger.assertCurrent(claim);
      });
      await assertAllowed();
      await this.ledger.assertCurrent(claim);
      return await this.ledger.ready(claim, plan);
    } catch (error) {
      await this.ledger.review(
        claim,
        error instanceof Error ? error.message : 'ARCHIVE_PREPARATION_FAILED',
      );
      throw error;
    }
  }
}
