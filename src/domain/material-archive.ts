import type { Awaitable } from './persistence.js';
import type {
  ArchiveClaim,
  ArchivePlan,
  ArchivePreparationRecord,
} from '../shared/material-archive.js';
export interface MaterialArchivePreparationRepository {
  pending(limit?: number): Awaitable<string[]>;
  get(attemptId: string): Awaitable<ArchivePreparationRecord | null>;
  claim(attemptId: string): Awaitable<ArchiveClaim>;
  assertCurrent(claim: ArchiveClaim): Awaitable<void>;
  ready(claim: ArchiveClaim, plan: ArchivePlan): Awaitable<ArchivePreparationRecord>;
  review(claim: ArchiveClaim, reason: string): Awaitable<void>;
  recoverOnStartup(): Awaitable<number>;
}
