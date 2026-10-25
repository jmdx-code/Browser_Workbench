import type { Awaitable } from './persistence.js';
import type {
  ArchiveExecution,
  ArchiveStep,
  ArchiveProof,
} from '../shared/material-archive-execution.js';

// This journal belongs to the original archive request. It cannot settle a post or consume content.
export interface MaterialArchiveExecutionRepository {
  completed(attemptId: string): Awaitable<boolean>;
  claim(attemptId: string): Awaitable<ArchiveExecution>;
  assertCurrent(claim: ArchiveExecution): Awaitable<void>;
  step(
    claim: ArchiveExecution,
    step: ArchiveStep,
  ): Awaitable<{ fresh: boolean; proof: ArchiveProof | null }>;
  prove(claim: ArchiveExecution, step: ArchiveStep, proof: ArchiveProof): Awaitable<void>;
  protectSource(claim: ArchiveExecution, sourcePath: string): Awaitable<'KEEP' | 'DELETE'>;
  complete(claim: ArchiveExecution): Awaitable<void>;
  review(claim: ArchiveExecution, reason: string): Awaitable<void>;
  recoverOnStartup(): Awaitable<number>;
}
