import { z } from 'zod';
import { OwnedTabProof } from './kernel-state.js';

// Audit evidence only. A recorded role never grants input or permission to close a tab.
export const TaskChildPageLifecycle = z
  .object({
    version: z.literal(1),
    role: z.literal('publication-result'),
    ownershipId: z.uuid(),
    parent: OwnedTabProof,
    child: OwnedTabProof.nullable(),
    state: z.enum(['REQUESTED', 'READY', 'CLOSED']),
  })
  .strict()
  .superRefine((value, context) => {
    const child = value.child;
    if (
      value.ownershipId === value.parent.ownershipId ||
      (value.state === 'REQUESTED' ? child !== null : child === null) ||
      (child &&
        (child.ownershipId !== value.ownershipId ||
          child.profileId !== value.parent.profileId ||
          child.browserSessionEpoch !== value.parent.browserSessionEpoch ||
          child.tabId === value.parent.tabId ||
          child.targetId === value.parent.targetId))
    )
      context.addIssue({ code: 'custom', message: 'TASK_CHILD_PAGE_SCOPE_INVALID' });
  });
export type ChildPageLifecycle = z.infer<typeof TaskChildPageLifecycle>;
