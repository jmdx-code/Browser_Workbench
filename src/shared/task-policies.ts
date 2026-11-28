import { z } from 'zod';
import { Id, NonNegInt, PosInt, addIssue, strictObj } from './contracts.js';
import { ResourceTable } from './resource-table.js';
import { TaskStep } from './task-contracts.js';
export {
  CurrentStopReceipt,
  DEFAULT_CONCURRENT_PROFILES,
  MAX_CONCURRENT_PROFILES,
  MAX_CONCURRENT_STARTUPS,
  MAX_CONCURRENT_UPLOAD_PREPARATIONS,
  OperationDisposition,
  TASK_CAPACITY_HEADER,
  TASK_CAPACITY_VERSION,
  type CurrentStop,
  type Disposition,
} from './contracts.js';
export const TaskStepV2 = TaskStep.superRefine((value, issue) => {
  const terminal = value.status === 'FAILED' || value.status === 'SKIPPED';
  if (terminal ? value.outcome?.kind !== value.status : value.outcome !== undefined)
    addIssue(issue, 'STEP_STATUS_OUTCOME_MISMATCH');
  if (
    value.outcome?.kind === 'FAILED' &&
    (value.spec.type === 'post') === (value.outcome.submissionPhase === 'NOT_APPLICABLE')
  )
    addIssue(issue, 'STEP_TYPE_SUBMISSION_MISMATCH');
  if (value.outcome?.kind === 'SKIPPED') {
    if (value.outcome.dependencyStepId === value.id) addIssue(issue, 'STEP_SKIP_SELF_DEPENDENCY');
    if (value.outcome.reason === 'MARKETPLACE_UNAVAILABLE' && value.spec.type !== 'marketplace')
      addIssue(issue, 'MARKETPLACE_SKIP_STEP_REQUIRED');
  }
});
const MARKETPLACE_MIN_BRIDGE = '0.3.19';
export function marketplaceBridgeSupported(
  version: string | null | undefined,
  minimumVersion = MARKETPLACE_MIN_BRIDGE,
) {
  if (!version || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version)) return false;
  const actual = version.split('.').map(Number),
    minimum = minimumVersion.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const a = actual[i],
      b = minimum[i];
    if (a === undefined || b === undefined) return false;
    if (a !== b) return a > b;
  }
  return true;
}
export type TaskFeatureId = 'feed' | 'video' | 'post' | 'marketplace' | 'story';
export const TaskResourceBinding = strictObj({
  jobId: Id,
  combinationId: Id,
  resourceRevision: PosInt,
  createdAt: NonNegInt,
});
export const TaskResourceSnapshot = strictObj({
  binding: TaskResourceBinding,
  table: ResourceTable,
}).superRefine((v, ctx) => {
  if (
    v.binding.combinationId !== v.table.combinationId ||
    v.binding.resourceRevision !== v.table.revision
  )
    addIssue(ctx, '任务资源版本不一致');
});
export type ResourceBinding = z.infer<typeof TaskResourceBinding>;
export type FixedResourceSnapshot = z.infer<typeof TaskResourceSnapshot>;
