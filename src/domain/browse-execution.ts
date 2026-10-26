import type { Awaitable } from './persistence.js';
import type { Action } from '../shared/browser-actions.js';
import type { Plan, StepInstance, Operation } from '../shared/task-contracts.js';
import type { ExecutionSession, Binding } from '../shared/task-execution.js';
import type { Intent, IntentRecord, Decision, Verdict } from '../shared/browse-execution.js';
import type { TabProof } from '../shared/kernel-state.js';
import type { TaskBrowserPort } from './tasks.js';

export interface BrowseIntentRepository {
  prepare(
    jobId: string,
    stepId: string,
    operationId: string,
    action: Action,
    intent: Intent,
  ): Awaitable<Operation>;
  get(operationId: string): Awaitable<IntentRecord>;
  hasAccountLiked?(accountId: string | null, contentId: string): Awaitable<boolean>;
}
export type StepExecution = { plan: Plan; step: StepInstance; session: ExecutionSession };
// decide/verify may read the owned page, never perform browser input themselves.
export interface BrowseStepExecutor {
  readonly type: 'video' | 'feed' | 'marketplace' | 'friends';
  available(): boolean;
  decide(execution: StepExecution, assertCurrent: () => Awaitable<void>): Promise<Decision>;
  verify(
    execution: StepExecution,
    operation: Operation & { binding: Binding },
    intent: Intent,
    assertCurrent: () => Awaitable<void>,
  ): Promise<Verdict>;
}
export interface TaskCycleRuntime extends TaskBrowserPort {
  hasOwner?(profileId: string): boolean;
  supportsControlRelease?(profileId: string): boolean;
  profile?(
    profileId: string,
  ): Awaitable<Awaited<ReturnType<TaskBrowserPort['profiles']>>[number] | undefined>;
  schedulingProfiles(): Awaitable<Awaited<ReturnType<TaskBrowserPort['profiles']>>>;
  observe(profileId: string): Promise<TabProof | void>;
  preparePlan(plan: Plan, context: ExecutionSession, observedProof?: TabProof): Promise<void>;
  control(jobId: string, mode: 'pause' | 'stop', reason?: string): Promise<Plan>;
  detach(profileId: string, expected: ExecutionSession, reason: string): Promise<void>;
}
export interface CurrentTaskTabSource {
  // Authenticated current inventory and exact proof; cannot infer ownership from URL/tabId.
  currentTaskTab(plan: Plan, context: ExecutionSession): Promise<TabProof>;
}
export interface ExecutionClock {
  nowMilliseconds(): number;
}
