import { z } from 'zod';
import { DispatchBinding } from './task-execution.js';

export const BumperActionKind = z.enum([
  'setup_navigate',
  'setup_open_group',
  'setup_welcome',
  'setup_watch',
  'setup_browse',
  'setup_expand_comment',
  'setup_fill_comment',
  'setup_scroll',
  'submit_like',
  'submit_comment',
]);
export const BumperResolution = z
  .object({
    id: z.uuid(),
    outcome: z.enum(['VERIFIED', 'NOT_APPLIED', 'ENDED_UNKNOWN']),
    evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const BumperOperation = z
  .object({
    binding: DispatchBinding,
    runId: z.uuid(),
    actionKind: BumperActionKind,
    groupId: z.string(),
    groupName: z.string(),
    pageId: z.string().nullable().default(null),
    pageName: z.string().nullable().default(null),
    postId: z.string().nullable().default(null),
    postUrl: z.string().nullable().default(null),
    commentId: z.string().nullable().default(null),
    commentText: z.string().nullable().default(null),
    logId: z.uuid().nullable().default(null),
    resolution: BumperResolution.nullable().default(null),
    status: z
      .enum(['PREPARED', 'SETTLEMENT_PENDING', 'SETTLED', 'PENDING_REVIEW'])
      .default('PREPARED'),
    reason: z.string().default(''),
  })
  .strict();
export type BumperOperationValue = z.infer<typeof BumperOperation>;
export type BumperResolutionValue = z.infer<typeof BumperResolution>;
