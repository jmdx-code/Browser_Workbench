import type { Awaitable } from './persistence.js';
import type { Profile, Step } from '../shared/contracts.js';
import type {
  Assignment,
  Event,
  Operation,
  Plan,
  ProfileTaskResultValue,
  Progress,
  RuntimeEvent,
  RuntimeRequest,
  Settings,
  StepInstance,
  TaskRecord,
  TaskRecordsResponse,
} from '../shared/task-contracts.js';
import type { ResourceOrigin } from '../shared/resource-materials.js';
import type { RecordProfile } from './task-record-projection.js';
import { ProductError } from './workspace.js';
export type RuntimeSnapshotResult = {
  settings: Settings;
  plans: Plan[];
  currentSteps: StepInstance[];
  roundSteps?: StepInstance[];
  recentTerminalPlans: Plan[];
  profileResults?: ProfileTaskResultValue[];
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
export interface DirectPublicationInput {
  id?: string;
  jobId: string;
  stepId: string;
  accountId: string;
  combinationId: string;
  fingerprint: string;
  postId: string;
  usageSourceKey: string;
  allowRepeat: boolean;
  resourceOrigin?: ResourceOrigin;
}
export interface TaskRepository {
  hiddenRecordIds?(): Awaitable<string[]>;
  finalRecords?(id: string, round: number): Awaitable<TaskRecord[] | null>;
  recordsPage?(input: unknown, profiles: readonly RecordProfile[]): Awaitable<TaskRecordsResponse>;
  settings(): Awaitable<Settings>;
  setSettings(value: Settings): Awaitable<void>;
  assign(request: Assignment, profiles: RuntimeProfile[]): Awaitable<Plan[]>;
  batchExists(batchId: string): Awaitable<boolean>;
  plansForBatch(batchId: string): Awaitable<Plan[]>;
  plansForProfile(profileId: string, states?: readonly Plan['state'][]): Awaitable<Plan[]>;
  historyPlans?(profileId: string, selectedId?: string): Awaitable<Plan[]>;
  hasProfilePlanInStates(profileId: string, states: readonly Plan['state'][]): Awaitable<boolean>;
  hasPlanOrOperation?(jobId: string, operationId: string): Awaitable<boolean>;
  list(): Awaitable<Plan[]>;
  livePlans(): Awaitable<Plan[]>;
  get(id: string): Awaitable<Plan>;
  ensurePlanExists?(id: string): Awaitable<void>;
  steps(id: string, round?: number): Awaitable<StepInstance[]>;
  currentStepForPlan?(id: string, round: number, position: number): Awaitable<StepInstance | null>;
  events(id: string): Awaitable<Event[]>;
  runtimeSnapshot?(options?: RuntimeRequest): Awaitable<RuntimeSnapshotResult>;
  cacheStateToken?(): Awaitable<string | null>;
  claimPlanForProfile(profileId: string, accountId: string | null): Awaitable<Plan | null>;
  bindPlanAccount(id: string, accountId: string): Awaitable<Plan>;
  updateStepProgress(id: string, stepId: string, progress: Progress): Awaitable<void>;
  completeStepDirect(id: string, stepId: string, finalProgress?: Progress): Awaitable<Plan>;
  skipStepDirect(
    id: string,
    stepId: string,
    reason:
      | 'DEPENDENCY_FAILED'
      | 'RESOURCE_EXHAUSTED'
      | 'FEATURE_UNAVAILABLE'
      | 'MARKETPLACE_UNAVAILABLE',
    dependencyStepId?: string,
  ): Awaitable<Plan>;
  failStepDirect(
    id: string,
    stepId: string,
    reason: string,
    businessResult?: 'NOT_APPLICABLE' | 'PUBLISHED' | 'NOT_PUBLISHED' | 'UNKNOWN',
  ): Awaitable<Plan>;
  stopPlanDirect(id: string, reason?: string): Awaitable<Plan>;
  failPlanDirect(id: string, reason: string): Awaitable<Plan>;
  recordAccountLike(accountId: string, targetKey: string): Awaitable<void>;
  hasAccountLiked(accountId: string, targetKey: string): Awaitable<boolean>;
  recordDirectPublication(input: DirectPublicationInput): Awaitable<void>;
  hasAccountPublishedFingerprint(accountId: string, fingerprint: string): Awaitable<boolean>;
  isMaterialSourceUsed(usageSourceKey: string): Awaitable<boolean>;
  noteQueuedWait?(id: string, reason: string): Awaitable<void>;
  noteRunningWait?(id: string, reason: string): Awaitable<void>;
  recoverOnStartup(preserveFutureSchedules?: boolean): Awaitable<void>;
  operations(id: string): Awaitable<Operation[]>;
  recentOperations?(id: string, limit: number): Awaitable<Operation[]>;
  findOperation?(jobId: string, operationId: string): Awaitable<Operation | null>;
  blockingOperations?(id: string): Awaitable<Operation[]>;
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
    const v = random();
    if (!Number.isFinite(v) || v < 0 || v >= 1)
      throw new ProductError('INVALID_RANDOM_SOURCE', '随机源不符合约束');
    const j = Math.floor(v * (i + 1)),
      a = result[i],
      b = result[j];
    if (!a || !b) throw new ProductError('STEP_ORDER_INVALID', '子任务顺序不完整');
    result[i] = b;
    result[j] = a;
  }
  return result;
}
// SHA-256('FRIENDS_REQUESTS_EXHAUSTED')
export const FRIENDS_EXHAUSTED_CURSOR =
  '254fb8397a7bf62865bc9b942b87fb8707d6d719c269527100c9f727ab4434da';
export function validateProgress(spec: Step, previous: Progress, next: Progress) {
  if (next.revision !== previous.revision + 1)
    throw new ProductError('CHECKPOINT_CONFLICT', '执行进度已变化', 409);
  const acc = next.accepted ?? 0;
  if (
    next.effectiveMilliseconds < previous.effectiveMilliseconds ||
    next.likes < previous.likes ||
    next.published < previous.published ||
    acc < (previous.accepted ?? 0)
  )
    throw new ProductError('CHECKPOINT_REGRESSED', '执行进度不能回退', 409);
  const bad =
    spec.type === 'post'
      ? next.likes !== 0 ||
        next.effectiveMilliseconds !== 0 ||
        acc !== 0 ||
        next.published > spec.count
      : spec.type === 'friends'
        ? next.likes !== 0 ||
          next.published !== 0 ||
          (spec.acceptMode === 'count' && acc > spec.maxAccepts)
        : next.likes > spec.maxLikes || next.published !== 0 || acc !== 0;
  if (bad) throw new ProductError('CHECKPOINT_OUT_OF_BOUNDS', '执行进度超出子任务约束', 409);
}
