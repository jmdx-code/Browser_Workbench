import { TaskStep } from './task-contracts.js';

export const TaskStepV2 = TaskStep.superRefine((value, issue) => {
  const terminalOutcome = value.status === 'FAILED' || value.status === 'SKIPPED';
  if (terminalOutcome ? value.outcome?.kind !== value.status : value.outcome !== undefined)
    issue.addIssue({ code: 'custom', message: 'STEP_STATUS_OUTCOME_MISMATCH' });
  if (value.outcome?.kind === 'FAILED') {
    const posting = value.spec.type === 'post';
    if (posting === (value.outcome.submissionPhase === 'NOT_APPLICABLE'))
      issue.addIssue({ code: 'custom', message: 'STEP_TYPE_SUBMISSION_MISMATCH' });
  }
  if (value.outcome?.kind === 'SKIPPED' && value.outcome.dependencyStepId === value.id)
    issue.addIssue({ code: 'custom', message: 'STEP_SKIP_SELF_DEPENDENCY' });
});
