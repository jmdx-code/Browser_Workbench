import { z } from 'zod';
import { CurrentStopReceipt, Id, NonNegInt, addIssue, sReq, strictObj } from './contracts.js';
// Parsing describes evidence, never grants continuation. Business result describes the
// failed attempt, not previously confirmed publications counted in this step's progress.
export const StepSubmissionPhase = z.enum([
  'NOT_APPLICABLE',
  'BEFORE_SUBMIT',
  'SUBMIT_DISPATCHED',
  'RESULT_CONFIRMED',
  'UNKNOWN',
]);
const allowedResults: Record<z.infer<typeof StepSubmissionPhase>, readonly string[]> = {
  NOT_APPLICABLE: ['NOT_APPLICABLE'],
  BEFORE_SUBMIT: ['NOT_PUBLISHED'],
  SUBMIT_DISPATCHED: ['UNKNOWN'],
  RESULT_CONFIRMED: ['PUBLISHED', 'NOT_PUBLISHED'],
  UNKNOWN: ['UNKNOWN'],
};
const stopFields = {
  endedAt: NonNegInt,
  endingId: Id.optional(),
  currentStop: CurrentStopReceipt.optional(),
};
export const TaskStepFailure = strictObj({
  version: z.literal(1),
  kind: z.literal('FAILED'),
  reason: sReq(200),
  ...stopFields,
  submissionPhase: StepSubmissionPhase,
  businessResult: z.enum(['NOT_APPLICABLE', 'PUBLISHED', 'NOT_PUBLISHED', 'UNKNOWN']),
}).superRefine((v, ctx) => {
  if (
    (v.endingId !== undefined) !== (v.currentStop !== undefined) ||
    (v.endingId && v.currentStop && v.currentStop.requestId !== v.endingId)
  )
    addIssue(ctx, 'STEP_ENDING_STOP_MISMATCH');
  if (!allowedResults[v.submissionPhase].includes(v.businessResult))
    addIssue(ctx, 'STEP_SUBMISSION_RESULT_MISMATCH');
});
export const TaskStepSkip = strictObj({
  version: z.literal(1),
  kind: z.literal('SKIPPED'),
  reason: z.enum([
    'DEPENDENCY_FAILED',
    'RESOURCE_EXHAUSTED',
    'FEATURE_UNAVAILABLE',
    'MARKETPLACE_UNAVAILABLE',
    'USER_STOP',
  ]),
  dependencyStepId: Id.optional(),
  ...stopFields,
}).superRefine((v, ctx) => {
  if ((v.reason === 'DEPENDENCY_FAILED') !== (v.dependencyStepId !== undefined))
    addIssue(ctx, 'STEP_SKIP_DEPENDENCY_MISMATCH');
  if (v.reason === 'MARKETPLACE_UNAVAILABLE') {
    if (v.endingId && v.currentStop && v.currentStop.requestId !== v.endingId)
      addIssue(ctx, 'STEP_ENDING_STOP_MISMATCH');
  } else if (v.endingId || v.currentStop) addIssue(ctx, 'STEP_SKIP_UNEXPECTED_STOP');
});
export const TaskStepOutcome = z.union([TaskStepFailure, TaskStepSkip]);
export type StepOutcome = z.infer<typeof TaskStepOutcome>;
export const isMarketplaceUnavailableSkip = (
  type: string,
  status: string,
  outcome?: Pick<StepOutcome, 'kind' | 'reason'>,
): boolean =>
  type === 'marketplace' &&
  status === 'SKIPPED' &&
  outcome?.kind === 'SKIPPED' &&
  outcome.reason === 'MARKETPLACE_UNAVAILABLE';
export const isSuccessfulTaskStep = (
  type: string,
  status: string,
  outcome?: Pick<StepOutcome, 'kind' | 'reason'>,
): boolean => status === 'COMPLETED' || isMarketplaceUnavailableSkip(type, status, outcome);
