import type { Awaitable } from './persistence.js';
import type { ResourceBinding, FixedResourceSnapshot } from '../shared/task-resources.js';
import type { Combination } from '../shared/contracts.js';
export const needsResourceTable = (snapshot: Combination) =>
  snapshot.steps.some((step) => step.type === 'post' && step.resourceMode === 'table');
export interface TaskResourceRepository {
  binding(jobId: string): Awaitable<ResourceBinding | null>;
  snapshot(jobId: string): Awaitable<FixedResourceSnapshot>;
}
