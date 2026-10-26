import { z } from 'zod';
import { CombinationSchema, Id, StepSchema } from './contracts.js';
import { Action } from './browser-actions.js';
import { DispatchBinding } from './task-execution.js';
import { OperationDisposition } from './task-ending.js';
import { TaskTiming } from './task-timing.js';
import { TaskStepOutcome } from './task-step-outcome.js';
import { MAX_CONCURRENT_PROFILES } from './task-capacity.js';

export const TaskState = z.enum([
  'QUEUED',
  'RUNNING',
  'PAUSING',
  'PAUSED',
  'STOPPING',
  'STOPPED',
  'REVIEW',
  'COMPLETED',
  'FAILED',
]);
export const TaskProgress = z
  .object({
    revision: z.number().int().nonnegative(),
    effectiveMilliseconds: z.number().int().nonnegative(),
    likes: z.number().int().nonnegative(),
    published: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative().optional(),
    cursor: z.string().max(4096).nullable(),
  })
  .strict();
export const TaskStepLegacy = z
  .object({
    id: Id,
    jobId: Id,
    round: z.number().int().positive(),
    position: z.number().int().nonnegative(),
    spec: StepSchema,
    status: z.enum(['PENDING', 'ACTIVE', 'COMPLETED']),
    progress: TaskProgress,
  })
  .strict();
export const TaskStep = TaskStepLegacy.extend({
  status: z.enum(['PENDING', 'ACTIVE', 'COMPLETED', 'FAILED', 'SKIPPED']),
  outcome: TaskStepOutcome.optional(),
});
export const TaskPlan = z
  .object({
    id: Id,
    batchId: Id,
    profileId: Id,
    combinationId: Id,
    version: z.number().int().positive(),
    accountId: z.string().min(1).max(200).nullable(),
    snapshot: CombinationSchema,
    state: TaskState,
    reason: z.string().max(200),
    controlMode: z.enum(['pause', 'stop']).nullable(),
    controlRequestId: Id.nullable(),
    controlConfirmed: z.boolean(),
    round: z.number().int().positive(),
    position: z.number().int().nonnegative(),
    createdAt: z.number(),
    updatedAt: z.number(),
    timing: TaskTiming.optional(),
    timingReleased: z.boolean().optional(),
  })
  .strict();
export const TaskOperation = z
  .object({
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
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export const TaskEvent = z
  .object({
    sequence: z.number().int().positive(),
    jobId: Id,
    type: z.string(),
    detail: z.json(),
    createdAt: z.number(),
  })
  .strict();
export const SchedulerSettings = z
  .object({ maxConcurrentProfiles: z.number().int().min(1).max(MAX_CONCURRENT_PROFILES) })
  .strict();
export const AssignTasks = z
  .object({
    requestId: Id,
    combinationId: Id,
    version: z.number().int().positive(),
    profileIds: z.array(Id).min(1).max(1000),
    expectedResourceRevision: z.number().int().positive().optional(),
    timing: TaskTiming.optional(),
  })
  .strict();
export const TaskOverview = z
  .object({
    dispatchEnabled: z.boolean(),
    settings: SchedulerSettings,
    plans: z.array(TaskPlan),
  })
  .strict();
export const TaskHistoryRequest = z
  .object({ profileId: Id, planId: Id.optional(), round: z.number().int().positive().optional() })
  .strict();
// Public display budget follows the persisted step instance, including shuffled rounds.
// Optional for older controller responses and historical exports; never an input grant.
export const TaskStepBudget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('time'), milliseconds: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('posts'), count: z.number().int().positive() }).strict(),
  z
    .object({
      kind: z.literal('friends'),
      mode: z.enum(['count', 'all']),
      count: z.number().int().positive().nullable(),
    })
    .strict(),
]);
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
  .extend({ name: z.string().max(200) })
  .strict();
export const TaskHistory = z
  .object({
    profileId: Id,
    plans: z.array(HistoryPlan).max(50),
    selectedPlanId: Id.nullable(),
    steps: z.array(
      TaskStep.pick({
        id: true,
        round: true,
        position: true,
        status: true,
        outcome: true,
        progress: true,
      })
        .extend({
          type: z.enum(['video', 'feed', 'post', 'marketplace', 'friends']),
          destination: z.enum(['post', 'story']).optional(),
          budget: TaskStepBudget.optional(),
          startedAt: z.number().nullable().optional(),
          finishedAt: z.number().nullable().optional(),
        })
        .strict(),
    ),
    operations: z
      .array(
        TaskOperation.pick({
          id: true,
          stepId: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        })
          .extend({ kind: z.string().max(40) })
          .strict(),
      )
      .max(100),
    events: z
      .array(TaskEvent.pick({ sequence: true, type: true, createdAt: true }).strict())
      .max(100),
    truncated: z
      .object({ plans: z.boolean(), operations: z.boolean(), events: z.boolean() })
      .strict(),
  })
  .strict();
export type History = z.infer<typeof TaskHistory>;
export type Plan = z.infer<typeof TaskPlan>;
export type StepInstance = z.infer<typeof TaskStep>;
export type Progress = z.infer<typeof TaskProgress>;
export type Operation = z.infer<typeof TaskOperation>;
export type Assignment = z.infer<typeof AssignTasks>;
export type Settings = z.infer<typeof SchedulerSettings>;
export type Event = z.infer<typeof TaskEvent>;
export const TaskCapabilities = z
  .object({
    types: z.array(z.enum(['feed', 'video', 'post', 'marketplace', 'friends'])).max(5),
    combinations: z.array(
      z
        .object({
          id: Id,
          version: z.number().int().nonnegative(),
          enabled: z.boolean(),
          reason: z.string().max(200),
        })
        .strict(),
    ),
  })
  .strict();
export const TaskStartResult = z.object({ plans: z.array(TaskPlan).max(1000) }).strict();
export const TaskCommandRequest = z
  .object({
    command: z.enum(['pause', 'resume', 'stop']),
    plans: z
      .array(
        z
          .object({
            profileId: Id,
            planId: Id,
            expectedState: TaskState,
            expectedUpdatedAt: z.number(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict()
  .refine(
    (value) => new Set(value.plans.map((plan) => plan.planId)).size === value.plans.length,
    '任务不能重复',
  );
export type TaskCommand = z.infer<typeof TaskCommandRequest>;
export const TaskCommandResult = z
  .object({
    results: z
      .array(
        z
          .object({
            profileId: Id,
            planId: Id,
            accepted: z.boolean(),
            state: TaskState.nullable(),
            controlConfirmed: z.boolean(),
            reason: z.string().max(200),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export const TaskRuntimeEventCategory = z.enum([
  'PLAN_TERMINAL',
  'PLAN_STATE',
  'STEP_EVENT',
  'OPERATION_EVENT',
]);
export const TaskRuntimeEvent = TaskEvent.extend({
  category: TaskRuntimeEventCategory,
}).strict();
export type RuntimeEvent = z.infer<typeof TaskRuntimeEvent>;
export const TaskRuntimeRequest = z
  .object({
    afterSequence: z.number().int().nonnegative().optional(),
    cursor: z.string().min(1).max(600).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    maxBytes: z.number().int().min(256).max(262_144).optional(),
  })
  .strict();
export type RuntimeRequest = z.infer<typeof TaskRuntimeRequest>;
export const ProfileTaskResult = z
  .object({
    profileId: Id,
    source: z.enum(['task', 'group-inviter']),
    runId: z.string().min(1).max(200),
    name: z.string().max(300),
    state: z.enum(['COMPLETED', 'FAILED', 'STOPPED']),
    reason: z.string().max(500),
    finishedAt: z.number().int().nonnegative(),
    failedSteps: z.number().int().nonnegative().default(0),
    skippedSteps: z.number().int().nonnegative().default(0),
  })
  .strict();
export type ProfileTaskResultValue = z.infer<typeof ProfileTaskResult>;
export const TaskRuntimeOverview = TaskOverview.extend({
  profileResults: z.array(ProfileTaskResult).optional(),
  currentSteps: z.array(
    TaskStep.pick({
      id: true,
      jobId: true,
      round: true,
      position: true,
      status: true,
      outcome: true,
      progress: true,
    })
      .extend({
        type: z.enum(['feed', 'video', 'post', 'marketplace', 'friends']),
        destination: z.enum(['post', 'story']).optional(),
        budget: TaskStepBudget.optional(),
      })
      .strict(),
  ),
  recentTerminalPlans: z.array(TaskPlan).max(200).optional(),
  events: z.array(TaskRuntimeEvent).max(200).optional(),
  lastEventSequence: z.number().int().nonnegative().optional(),
  lastScannedSequence: z.number().int().nonnegative().optional(),
  hasMore: z.boolean().optional(),
  resetRequired: z.boolean().optional(),
  visibleTerminalFloorSequence: z.number().int().nonnegative().optional(),
  epoch: z.string().min(1).max(200).optional(),
  cursor: z.string().min(1).max(600).optional(),
}).strict();
export const TaskRecordsRequest = z
  .object({
    groupBy: z.literal('run').optional(),
    profileId: Id.optional(),
    status: z.enum(['all', 'running', 'completed', 'failed', 'review']).default('all'),
    query: z.string().max(100).optional(),
    cursor: z.string().max(600).optional(),
    limit: z.number().int().min(1).max(200).default(100),
  })
  .strict();
export const TaskRecordRow = z
  .object({
    stepId: Id,
    planId: Id,
    profileId: Id,
    combinationId: Id,
    combinationName: z.string().max(200),
    combinationVersion: z.number().int().positive(),
    round: z.number().int().positive(),
    position: z.number().int().nonnegative(),
    type: z.enum(['feed', 'video', 'post', 'marketplace', 'friends']),
    destination: z.enum(['post', 'story']).optional(),
    status: z.enum(['PENDING', 'ACTIVE', 'COMPLETED', 'FAILED', 'SKIPPED']),
    planState: TaskState,
    planReason: z.string().max(200),
    outcome: TaskStepOutcome.optional(),
    progress: TaskProgress,
    budget: TaskStepBudget.optional(),
    startedAt: z.number().nullable(),
    finishedAt: z.number().nullable(),
    planCreatedAt: z.number(),
    planUpdatedAt: z.number(),
  })
  .strict();
export const TaskRecords = z
  .object({
    records: z.array(TaskRecordRow).max(200),
    viewVersion: z.string().max(100).optional(),
    nextCursor: z.string().max(600).nullable(),
    total: z.number().int().nonnegative(),
    counts: z
      .object({
        all: z.number().int().nonnegative(),
        running: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        review: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type TaskRecord = z.infer<typeof TaskRecordRow>;
export type TaskRecordsResponse = z.infer<typeof TaskRecords>;
