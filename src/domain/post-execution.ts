import type { Awaitable } from './persistence.js';
import type { StepExecution } from './browse-execution.js';
import type { MaterialIndexRepository } from './material-index.js';
import type { MaterialPostRepository } from './material-post.js';
import type { Reservation, PostIntent } from '../shared/material-index.js';
import type { PostLink } from '../shared/material-post.js';
import type { Operation } from '../shared/task-contracts.js';
import type { Binding } from '../shared/task-execution.js';
import type { PostExecutionDecision, PostExecutionVerdict } from '../shared/post-execution.js';

// decide/verify inspect the current page and original records, and never perform browser input.
// Readiness requires the real identity/purpose/media/result adapters, not a display observation.
export interface PostStepExecutor {
  available(): Awaitable<boolean>;
  decide(
    execution: StepExecution,
    reservations: Reservation[],
    assertCurrent: () => Awaitable<void>,
  ): Promise<PostExecutionDecision>;
  verify(
    execution: StepExecution,
    operation: Operation & { binding: Binding },
    original: { intent: PostIntent; link: PostLink },
    assertCurrent: () => Awaitable<void>,
  ): Promise<PostExecutionVerdict>;
}
export interface PostStepAdapter {
  materials: MaterialIndexRepository;
  posts: MaterialPostRepository;
  executor: PostStepExecutor;
  // Internal executable source capability, never inferred from a saved resource count.
  resourceTablesAvailable?: () => boolean;
}
