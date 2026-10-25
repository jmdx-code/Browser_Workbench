import { z } from 'zod';
import { OwnedTabProof } from './kernel-state.js';
import { ExecutionContext } from './task-execution.js';

// Internal application contract. Neither ownership proof nor execution context comes from UI.
export const TaskTabRecord = z
  .object({
    jobId: z.uuid(),
    accountId: z.string().min(1).max(200),
    proof: OwnedTabProof,
    state: z.enum(['READY', 'RECHECK_REQUIRED', 'RELEASED', 'LOST', 'CLOSED']),
    revision: z.number().int().nonnegative(),
    context: ExecutionContext.nullable(),
    reason: z.string().max(200),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((row, issue) => {
    if (
      (row.state === 'READY' && !row.context) ||
      (row.state === 'RELEASED' && row.context !== null) ||
      (row.context &&
        (row.context.profileId !== row.proof.profileId || row.context.accountId !== row.accountId))
    )
      issue.addIssue({ code: 'custom', message: 'TASK_TAB_CONTEXT_INVALID' });
  });
export type TaskTab = z.infer<typeof TaskTabRecord>;
