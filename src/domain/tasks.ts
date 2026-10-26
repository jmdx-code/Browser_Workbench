import type { Awaitable } from './persistence.js';
import type { Profile, Step } from '../shared/contracts.js';
import type { Action } from '../shared/browser-actions.js';
import type {
  Assignment,
  Event,
  Operation,
  Plan,
  Progress,
  RuntimeEvent,
  RuntimeRequest,
  Settings,
  StepInstance,
} from '../shared/task-contracts.js';
import { ProductError } from './workspace.js';
import type { Binding, ExecutionReceipt, ExecutionSession } from '../shared/task-execution.js';
import type { PendingDiagnostic } from '../shared/browse-execution.js';
import type { TabProof } from '../shared/kernel-state.js';
import type { ChildPageLifecycle } from '../shared/task-child-page.js';

export type RuntimeSnapshotResult = {
  settings: Settings;
  plans: Plan[];
  currentSteps: StepInstance[];
  recentTerminalPlans: Plan[];
  profileResults?: import('../shared/task-contracts.js').ProfileTaskResultValue[];
  events: RuntimeEvent[];
  lastEventSequence: number;
  lastScannedSequence: number;
  hasMore: boolean;
  resetRequired: boolean;
  visibleTerminalFloorSequence: number;
  epoch: string;
  cursor: string;
};
export type RuntimeProfile = Pick<
  Profile,
  'id' | 'online' | 'synced' | 'unresolved' | 'account'
> & {
  dispatchAllowed: boolean;
  // Private startup handoff only; never input authority or a public profile field.
  openingPlanId?: string;
  // Private first failure code; not a display identity or permission to resume.
  unreadyReason?: string;
};
export interface TaskRepository {
  hiddenRecordIds?(): Awaitable<string[]>;
  recordsPage?(
    input: unknown,
    profiles: readonly import('./task-record-projection.js').RecordProfile[],
  ): Awaitable<import('../shared/task-contracts.js').TaskRecordsResponse>;
  settings(): Awaitable<Settings>;
  setSettings(value: Settings): Awaitable<void>;
  assign(request: Assignment, profiles: RuntimeProfile[]): Awaitable<Plan[]>;
  batchExists(batchId: string): Awaitable<boolean>;
  plansForBatch(batchId: string): Awaitable<Plan[]>;
  plansForProfile(profileId: string, states?: readonly Plan['state'][]): Awaitable<Plan[]>;
  hasProfilePlanInStates(profileId: string, states: readonly Plan['state'][]): Awaitable<boolean>;
  hasPlanOrOperation?(jobId: string, operationId: string): Awaitable<boolean>;
  list(): Awaitable<Plan[]>;
  livePlans(): Awaitable<Plan[]>;
  get(id: string): Awaitable<Plan>;
  steps(id: string, round?: number): Awaitable<StepInstance[]>;
  currentStepForPlan?(id: string, round: number, position: number): Awaitable<StepInstance | null>;
  events(id: string): Awaitable<Event[]>;
  runtimeSnapshot?(options?: RuntimeRequest): Awaitable<RuntimeSnapshotResult>;
  cacheStateToken?(): Awaitable<string | null>;
  claimNext(
    profiles: RuntimeProfile[],
    supported: ReadonlySet<Step['type']>,
    sourceCapabilities?: { resourceTables: boolean; profileId?: string },
  ): Awaitable<Plan | null>;
  reviewFailedAdmission(id: string, expectedAccountId: string, reason: string): Awaitable<Plan>;
  noteQueuedWait?(id: string, reason: string): Awaitable<void>;
  noteRunningWait?(id: string, reason: string): Awaitable<void>;
  noteChildPageLifecycle?(binding: Binding, value: ChildPageLifecycle): Awaitable<void>;
  retainedTaskPage?(profileId: string): Awaitable<TabProof | null>;
  reconcileRuntime(profiles: RuntimeProfile[]): Awaitable<void>;
  reconcileProfileRuntime?(profile: RuntimeProfile): Awaitable<void>;
  requestControl(id: string, mode: 'pause' | 'stop', reason?: string): Awaitable<Plan>;
  confirmControl(id: string, requestId: string): Awaitable<Plan>;
  resume(id: string): Awaitable<Plan>;
  releaseErroredPausedPlans?(profileIds: readonly string[]): Awaitable<number>;
  recoverOnStartup(preserveFutureSchedules?: boolean): Awaitable<void>;
  unresolved?(id: string): Awaitable<boolean>;
  stopOfflineBrowse?(id: string, reason?: string): Awaitable<Plan | null>;
  prepareOperation(
    id: string,
    stepId: string,
    operationId: string,
    action: Action,
  ): Awaitable<Operation>;
  takeOperation(): Awaitable<Operation | null>;
  takeBoundOperation(context: ExecutionSession): Awaitable<Operation | null>;
  acknowledgeBound(receipt: ExecutionReceipt): Awaitable<void>;
  releaseBrowseControl?(receipt: ExecutionReceipt): Awaitable<void>;
  settleBound(
    receipt: ExecutionReceipt,
    outcome: 'VERIFIED' | 'NOT_APPLIED',
    progress?: Progress,
  ): Awaitable<void>;
  reconcileBound(
    receipt: ExecutionReceipt,
    outcome: 'VERIFIED' | 'NOT_APPLIED',
    progress?: Progress,
  ): Awaitable<void>;
  markBoundUnknown(
    binding: Binding,
    reason: string,
    observation?: ExecutionReceipt,
  ): Awaitable<void>;
  noteBrowseReadFailure(
    jobId: string,
    stepId: string,
    context: ExecutionSession,
    reason: string,
    diagnostic: PendingDiagnostic,
    kind?: 'timeout' | 'input-fence',
  ): Awaitable<void>;
  operations(id: string): Awaitable<Operation[]>;
  recentOperations?(id: string, limit: number): Awaitable<Operation[]>;
  findOperation?(jobId: string, operationId: string): Awaitable<Operation | null>;
  blockingOperations?(id: string): Awaitable<Operation[]>;
  noteStepFailure?(id: string, stepId: string, reason: string): Awaitable<void>;
  markAcknowledged(operationId: string, receipt: Operation['receipt']): Awaitable<void>;
  settleOperation(
    operationId: string,
    outcome: 'VERIFIED' | 'NOT_APPLIED' | 'UNKNOWN',
    evidence: Operation['receipt'],
    progress?: Progress,
  ): Awaitable<void>;
  checkpoint(
    id: string,
    stepId: string,
    expectedRevision: number,
    progress: Progress,
  ): Awaitable<void>;
  checkpointAsync?(
    id: string,
    stepId: string,
    expectedRevision: number,
    progress: Progress,
  ): Awaitable<Promise<void>>;
  completeStep(id: string, stepId: string): Awaitable<Plan>;
}
export interface TaskBrowserPort {
  profile?(profileId: string): Awaitable<RuntimeProfile | undefined>;
  // Complete inventory, including offline known profiles. A per-actor subset would mark other plans offline.
  profiles(): Awaitable<RuntimeProfile[]>;
  session(profileId: string): Awaitable<ExecutionSession | null>;
  send(operation: Operation & { binding: Binding }): Promise<ExecutionReceipt>;
}
export const terminal = (state: Plan['state']) =>
  ['STOPPED', 'COMPLETED', 'FAILED'].includes(state);
export const emptyProgress = (): Progress => ({
  revision: 0,
  effectiveMilliseconds: 0,
  likes: 0,
  published: 0,
  cursor: null,
});
export function orderedSteps(steps: Step[], randomOrder: boolean, random: () => number): Step[] {
  const result = [...steps];
  if (!randomOrder) return result;
  for (let i = result.length - 1; i > 0; i--) {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1)
      throw new ProductError('INVALID_RANDOM_SOURCE', '随机源不符合约束');
    const j = Math.floor(value * (i + 1));
    const one = result[i],
      two = result[j];
    if (!one || !two) throw new ProductError('STEP_ORDER_INVALID', '子任务顺序不完整');
    result[i] = two;
    result[j] = one;
  }
  return result;
}
// SHA-256('FRIENDS_REQUESTS_EXHAUSTED')
export const FRIENDS_EXHAUSTED_CURSOR =
  '254fb8397a7bf62865bc9b942b87fb8707d6d719c269527100c9f727ab4434da';
export function validateProgress(spec: Step, previous: Progress, next: Progress) {
  if (next.revision !== previous.revision + 1)
    throw new ProductError('CHECKPOINT_CONFLICT', '执行进度已变化', 409);
  if (
    next.effectiveMilliseconds < previous.effectiveMilliseconds ||
    next.likes < previous.likes ||
    next.published < previous.published ||
    (next.accepted ?? 0) < (previous.accepted ?? 0)
  )
    throw new ProductError('CHECKPOINT_REGRESSED', '执行进度不能回退', 409);
  if (
    spec.type === 'post'
      ? next.likes !== 0 ||
        next.effectiveMilliseconds !== 0 ||
        (next.accepted ?? 0) !== 0 ||
        next.published > spec.count
      : spec.type === 'friends'
        ? next.likes !== 0 ||
          next.published !== 0 ||
          (spec.acceptMode === 'count' && (next.accepted ?? 0) > spec.maxAccepts)
        : next.likes > spec.maxLikes || next.published !== 0 || (next.accepted ?? 0) !== 0
  )
    throw new ProductError('CHECKPOINT_OUT_OF_BOUNDS', '执行进度超出子任务约束', 409);
}
export function stepComplete(spec: Step, progress: Progress) {
  if (spec.type === 'post') return progress.published === spec.count;
  if (spec.type === 'friends')
    return (
      progress.cursor === FRIENDS_EXHAUSTED_CURSOR ||
      (spec.acceptMode === 'count' && (progress.accepted ?? 0) >= spec.maxAccepts) ||
      progress.effectiveMilliseconds >= spec.durationMinutes * 60_000
    );
  return progress.effectiveMilliseconds >= spec.durationMinutes * 60_000;
}
