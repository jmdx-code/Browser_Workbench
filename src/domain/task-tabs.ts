import type { Awaitable } from './persistence.js';
import type { TabProof, KernelState } from '../shared/kernel-state.js';
import type { TaskTab } from '../shared/task-tabs.js';
import type { Binding, ExecutionSession } from '../shared/task-execution.js';
import type { StopReceipt } from '../shared/task-control.js';
import { sameExecution } from '../shared/task-execution.js';
import { ProductError } from './workspace.js';

export const sameTabProof = (a: TabProof, b: TabProof): boolean =>
  a.ownershipId === b.ownershipId &&
  a.profileId === b.profileId &&
  a.browserSessionEpoch === b.browserSessionEpoch &&
  a.tabId === b.tabId &&
  a.targetId === b.targetId;

export interface TaskTabRepository {
  get(ownershipId: string, jobId?: string): Awaitable<TaskTab>;
  forPlan(jobId: string): Awaitable<TaskTab[]>;
  activeForProfile(profileId: string): Awaitable<TaskTab[]>;
  register(jobId: string, proof: TabProof, context: ExecutionSession): Awaitable<TaskTab>;
  requireRecheck(
    ownershipId: string,
    expectedRevision: number,
    reason: string,
    jobId?: string,
  ): Awaitable<TaskTab>;
  confirmObserved(
    ownershipId: string,
    expectedRevision: number,
    proof: TabProof,
    context: ExecutionSession,
    jobId?: string,
  ): Awaitable<TaskTab>;
  markLost(
    ownershipId: string,
    expectedRevision: number,
    reason: string,
    jobId?: string,
  ): Awaitable<TaskTab>;
  confirmClosed(
    ownershipId: string,
    expectedRevision: number,
    inventory: KernelState,
    jobId?: string,
  ): Awaitable<TaskTab>;
  confirmEndedLost?(
    ownershipId: string,
    expectedRevision: number,
    inventory: KernelState,
    jobId?: string,
  ): Awaitable<TaskTab>;
  confirmReleased?(
    ownershipId: string,
    expectedRevision: number,
    inventory: KernelState,
    stop: StopReceipt,
    jobId: string,
  ): Awaitable<TaskTab>;
  recoverOnStartup(): Awaitable<void>;
  assertForInput(binding: Binding, proof: TabProof): Awaitable<void>;
}

export function assertTaskTabInput(row: TaskTab, binding: Binding, proof: TabProof): void {
  if (
    row.jobId !== binding.jobId ||
    row.accountId !== binding.accountId ||
    row.state !== 'READY' ||
    !row.context ||
    !sameExecution(row.context, binding) ||
    !sameTabProof(row.proof, proof)
  )
    throw new ProductError('TASK_TAB_NOT_READY', '专用任务标签页尚未完成当前连接核对', 409);
}
