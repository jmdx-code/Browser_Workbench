import { z } from 'zod';
import {
  CombinationSchema,
  Id,
  MAX_CONCURRENT_PROFILES,
  NonNegInt,
  NumNull,
  OperationDisposition,
  PosInt,
  StepSchema,
  intRange,
  optBool,
  sMax,
  sReq,
  strictObj,
} from './contracts.js';
import { Action } from './browser-actions.js';
import { DispatchBinding } from './task-execution.js';
import { TaskTiming } from './task-timing.js';
import { TaskStepOutcome } from './task-step-outcome.js';
const ts = { createdAt: z.number(), updatedAt: z.number() },
  errStr = sMax(200),
  cursorStr = sReq(600),
  optNumNull = NumNull.optional(),
  TaskState = z.enum(['QUEUED', 'RUNNING', 'STOPPED', 'COMPLETED', 'FAILED']);
export const TaskProgress = strictObj({
  revision: NonNegInt,
  effectiveMilliseconds: NonNegInt,
  likes: NonNegInt,
  published: NonNegInt,
  accepted: NonNegInt.optional(),
  cursor: sMax(4096).nullable(),
});
export const TaskStepLegacy = strictObj({
  id: Id,
  jobId: Id,
  round: PosInt,
  position: NonNegInt,
  spec: StepSchema,
  status: z.enum(['PENDING', 'ACTIVE', 'COMPLETED']),
  progress: TaskProgress,
});
export const TaskStep = TaskStepLegacy.extend({
  status: z.enum(['PENDING', 'ACTIVE', 'COMPLETED', 'FAILED', 'SKIPPED']),
  outcome: TaskStepOutcome.optional(),
});
export const TaskPlan = strictObj({
  id: Id,
  batchId: Id,
  profileId: Id,
  combinationId: Id,
  version: PosInt,
  accountId: sReq(200).nullable(),
  snapshot: CombinationSchema,
  state: TaskState,
  reason: errStr,
  controlMode: z.enum(['pause', 'stop']).nullable(),
  controlRequestId: Id.nullable(),
  controlConfirmed: z.boolean(),
  round: PosInt,
  position: NonNegInt,
  ...ts,
  timing: TaskTiming.optional(),
  timingReleased: optBool,
  closeBrowserOnFinish: optBool,
});
export const TaskOperation = strictObj({
  id: Id,
  jobId: Id,
  stepId: Id,
  action: Action,
  binding: DispatchBinding.nullable(),
  status: z.enum([
    'PREPARED',
    'DISPATCHING',
    'ACKNOWLEDGED',
    'VERIFIED',
    'FAILED',
    'UNKNOWN',
    'CANCELLED',
  ]),
  receipt: z.json().nullable(),
  checkpointApplied: z.boolean(),
  disposition: OperationDisposition.optional(),
  inertBrowseProof: strictObj({
    verified: z.literal(true),
    purpose: z.enum(['play', 'advance', 'dismiss', 'activate']).optional(),
    planConfirmedStopped: z.boolean(),
  }).optional(),
  ...ts,
});
export const TaskEvent = strictObj({
  sequence: PosInt,
  jobId: Id,
  type: z.string(),
  detail: z.json(),
  createdAt: z.number(),
});
export const SchedulerSettings = strictObj({
  maxConcurrentProfiles: intRange(1, MAX_CONCURRENT_PROFILES),
});
export const AssignTasks = strictObj({
  requestId: Id,
  combinationId: Id,
  version: PosInt,
  profileIds: z.array(Id).min(1).max(1000),
  expectedResourceRevision: PosInt.optional(),
  timing: TaskTiming.optional(),
  closeBrowserOnFinish: optBool,
});
export const TaskOverview = strictObj({
  dispatchEnabled: z.boolean(),
  settings: SchedulerSettings,
  plans: z.array(TaskPlan),
});
export const TaskHistoryRequest = strictObj({
  profileId: Id,
  planId: Id.optional(),
  round: PosInt.optional(),
});
export const TaskStepBudget = z.discriminatedUnion('kind', [
  strictObj({ kind: z.literal('time'), milliseconds: PosInt }),
  strictObj({ kind: z.literal('posts'), count: PosInt }),
  strictObj({
    kind: z.literal('friends'),
    mode: z.enum(['count', 'all']),
    count: PosInt.nullable(),
  }),
]);
const stepDescriptor = {
  type: z.enum(['feed', 'video', 'post', 'marketplace', 'friends']),
  destination: z.enum(['post', 'story']).optional(),
  friendAction: z.enum(['accept', 'add_suggested']).optional(),
  feedMode: z.enum(['home', 'random_profile', 'random_page', 'search_pages']).optional(),
  maxLikes: NonNegInt.optional(),
  budget: TaskStepBudget.optional(),
};
const HistoryPlan = TaskPlan.pick({
  timing: true,
  id: true,
  combinationId: true,
  version: true,
  accountId: true,
  state: true,
  reason: true,
  controlConfirmed: true,
  round: true,
  position: true,
  createdAt: true,
  updatedAt: true,
})
  .extend({ name: errStr })
  .strict();
const stepPick = {
  id: true as const,
  round: true as const,
  position: true as const,
  status: true as const,
  outcome: true as const,
  progress: true as const,
};
export const TaskHistory = strictObj({
  detailsReclaimed: optBool,
  profileId: Id,
  plans: z.array(HistoryPlan).max(50),
  selectedPlanId: Id.nullable(),
  steps: z.array(
    TaskStep.pick(stepPick)
      .extend({ ...stepDescriptor, startedAt: optNumNull, finishedAt: optNumNull })
      .strict(),
  ),
  operations: z
    .array(
      TaskOperation.pick({ id: true, stepId: true, status: true, createdAt: true, updatedAt: true })
        .extend({ kind: sMax(40) })
        .strict(),
    )
    .max(100),
  events: z
    .array(TaskEvent.pick({ sequence: true, type: true, createdAt: true }).strict())
    .max(100),
  truncated: strictObj({ plans: z.boolean(), operations: z.boolean(), events: z.boolean() }),
});
export type History = z.infer<typeof TaskHistory>;
export type Plan = z.infer<typeof TaskPlan>;
export type StepInstance = z.infer<typeof TaskStep>;
export type Progress = z.infer<typeof TaskProgress>;
export type Operation = z.infer<typeof TaskOperation>;
export type Assignment = z.infer<typeof AssignTasks>;
export type Settings = z.infer<typeof SchedulerSettings>;
export type Event = z.infer<typeof TaskEvent>;
export const TaskCapabilities = strictObj({
  types: z.array(stepDescriptor.type).max(5),
  combinations: z.array(
    strictObj({ id: Id, version: NonNegInt, enabled: z.boolean(), reason: errStr }),
  ),
});
export const TaskStartResult = strictObj({ plans: z.array(TaskPlan).max(1000) });
export const TaskCommandRequest = strictObj({
  command: z.enum(['pause', 'resume', 'stop']),
  plans: z
    .array(
      strictObj({
        profileId: Id,
        planId: Id,
        expectedState: TaskState,
        expectedUpdatedAt: z.number(),
      }),
    )
    .min(1)
    .max(1000),
}).refine((v) => new Set(v.plans.map((p) => p.planId)).size === v.plans.length, '任务不能重复');
export type TaskCommand = z.infer<typeof TaskCommandRequest>;
export const TaskCommandResult = strictObj({
  results: z
    .array(
      strictObj({
        profileId: Id,
        planId: Id,
        accepted: z.boolean(),
        state: TaskState.nullable(),
        controlConfirmed: z.boolean(),
        reason: errStr,
      }),
    )
    .max(1000),
});
const TaskRuntimeEventCategory = z.enum([
  'PLAN_TERMINAL',
  'PLAN_STATE',
  'STEP_EVENT',
  'OPERATION_EVENT',
]);
export const TaskRuntimeEvent = TaskEvent.extend({ category: TaskRuntimeEventCategory }).strict();
export type RuntimeEvent = z.infer<typeof TaskRuntimeEvent>;
export const TaskRuntimeRequest = strictObj({
  afterSequence: NonNegInt.optional(),
  cursor: cursorStr.optional(),
  limit: intRange(1, 200).optional(),
  maxBytes: intRange(256, 262_144).optional(),
});
export type RuntimeRequest = z.infer<typeof TaskRuntimeRequest>;
export const ProfileTaskResult = strictObj({
  profileId: Id,
  source: z.enum(['task', 'group-inviter', 'group-bumper', 'page-bumper', 'group-poster']),
  runId: sReq(200),
  name: sMax(300),
  state: z.enum(['COMPLETED', 'FAILED', 'STOPPED']),
  reason: sMax(500),
  finishedAt: NonNegInt,
  failedSteps: NonNegInt.default(0),
  skippedSteps: NonNegInt.default(0),
});
export type ProfileTaskResultValue = z.infer<typeof ProfileTaskResult>;
const projectedStepSchema = TaskStep.pick({ ...stepPick, jobId: true })
  .extend(stepDescriptor)
  .strict();
export const TaskRuntimeOverview = TaskOverview.extend({
  profileResults: z.array(ProfileTaskResult).optional(),
  currentSteps: z.array(projectedStepSchema),
  roundSteps: z.array(projectedStepSchema).optional(),
  recentTerminalPlans: z.array(TaskPlan).max(200).optional(),
  events: z.array(TaskRuntimeEvent).max(200).optional(),
  lastEventSequence: NonNegInt.optional(),
  lastScannedSequence: NonNegInt.optional(),
  hasMore: optBool,
  resetRequired: optBool,
  visibleTerminalFloorSequence: NonNegInt.optional(),
  epoch: sReq(200).optional(),
  cursor: cursorStr.optional(),
}).strict();
export const TaskRecordsRequest = strictObj({
  groupBy: z.literal('run').optional(),
  profileId: Id.optional(),
  status: z.enum(['all', 'running', 'completed', 'failed', 'review']).default('all'),
  query: sMax(100).optional(),
  cursor: sMax(600).optional(),
  limit: intRange(1, 200).default(100),
});
const TaskRecordRow = strictObj({
  stepId: Id,
  planId: Id,
  profileId: Id,
  combinationId: Id,
  combinationName: errStr,
  combinationVersion: PosInt,
  round: PosInt,
  position: NonNegInt,
  ...stepDescriptor,
  status: TaskStep.shape.status,
  planState: TaskState,
  planReason: errStr,
  outcome: TaskStepOutcome.optional(),
  progress: TaskProgress,
  startedAt: NumNull,
  finishedAt: NumNull,
  planCreatedAt: z.number(),
  planUpdatedAt: z.number(),
});
export const TaskRecords = strictObj({
  records: z.array(TaskRecordRow).max(200),
  viewVersion: sMax(100).optional(),
  nextCursor: sMax(600).nullable(),
  total: NonNegInt,
  counts: strictObj({
    all: NonNegInt,
    running: NonNegInt,
    completed: NonNegInt,
    failed: NonNegInt,
    review: NonNegInt,
  }),
});
export type TaskRecord = z.infer<typeof TaskRecordRow>;
export type TaskRecordsResponse = z.infer<typeof TaskRecords>;
