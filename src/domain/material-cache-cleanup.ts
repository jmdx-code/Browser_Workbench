import type { Awaitable } from './persistence.js';
import type {
  CleanupClaim,
  CleanupScope,
  CleanupFile,
  CleanupRecord,
  CleanupCompletion,
} from '../shared/material-cache-cleanup.js';
export interface MaterialCacheCleanupRepository {
  prepare(stageId: string, stopRequestId: string): Awaitable<CleanupRecord>;
  get(stageId: string): Awaitable<CleanupRecord>;
  claim(stageId: string, expectedRevision: number): Awaitable<CleanupClaim>;
  assertCurrent(claim: CleanupClaim): Awaitable<void>;
  bindScope(claim: CleanupClaim, scope: CleanupScope): Awaitable<void>;
  beginFile(claim: CleanupClaim, file: CleanupFile): Awaitable<void>;
  deletedFile(claim: CleanupClaim, name: string): Awaitable<void>;
  beginDirectoryRemoval(claim: CleanupClaim): Awaitable<void>;
  complete(claim: CleanupClaim, completion: CleanupCompletion): Awaitable<void>;
  review(claim: CleanupClaim, reason: string): Awaitable<void>;
  recoverOnStartup(): Awaitable<number>;
}
