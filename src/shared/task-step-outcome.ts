import { z } from 'zod';
import { CurrentStopReceipt } from './task-ending.js';

// Parsing describes evidence, never grants continuation. Business result describes the
// failed attempt, not previously confirmed publications counted in this step's progress.
export const StepSubmissionPhase = z.enum([
  'NOT_APPLICABLE',
  'BEFORE_SUBMIT',
  'SUBMIT_DISPATCHED',
  'RESULT_CONFIRMED',
  'UNKNOWN',
]);
export const TaskStepFailure = z
  .object({
    version: z.literal(1),
    kind: z.literal('FAILED'),
    reason: z.string().min(1).max(200),
    endedAt: z.number().int().nonnegative(),
    endingId: z.uuid(),
    currentStop: CurrentStopReceipt,
    submissionPhase: StepSubmissionPhase,
    businessResult: z.enum(['NOT_APPLICABLE', 'PUBLISHED', 'NOT_PUBLISHED', 'UNKNOWN']),
  })
  .strict()
  .superRefine((value, issue) => {
    if (value.currentStop.requestId !== value.endingId)
      issue.addIssue({ code: 'custom', message: 'STEP_ENDING_STOP_MISMATCH' });
    const allowed = {
      NOT_APPLICABLE: ['NOT_APPLICABLE'],
      BEFORE_SUBMIT: ['NOT_PUBLISHED'],
      SUBMIT_DISPATCHED: ['UNKNOWN'],
      RESULT_CONFIRMED: ['PUBLISHED', 'NOT_PUBLISHED'],
      UNKNOWN: ['UNKNOWN'],
    };
    if (!allowed[value.submissionPhase].includes(value.businessResult))
      issue.addIssue({ code: 'custom', message: 'STEP_SUBMISSION_RESULT_MISMATCH' });
  });
export const TaskStepSkip = z
  .object({
    version: z.literal(1),
    kind: z.literal('SKIPPED'),
    reason: z.enum(['DEPENDENCY_FAILED', 'RESOURCE_EXHAUSTED', 'FEATURE_UNAVAILABLE']),
    endedAt: z.number().int().nonnegative(),
    dependencyStepId: z.uuid().optional(),
  })
  .strict()
  .superRefine((value, issue) => {
    if ((value.reason === 'DEPENDENCY_FAILED') !== (value.dependencyStepId !== undefined))
      issue.addIssue({ code: 'custom', message: 'STEP_SKIP_DEPENDENCY_MISMATCH' });
  });
export const TaskStepOutcome = z.union([TaskStepFailure, TaskStepSkip]);

export type StepOutcome = z.infer<typeof TaskStepOutcome>;
