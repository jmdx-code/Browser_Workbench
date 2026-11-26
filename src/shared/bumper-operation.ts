import { z } from 'zod';
import { Id, Sha256Hex, strictObj } from './contracts.js';
import { DispatchBinding } from './task-execution.js';
export const BumperActionKind = z.enum([
  'setup_navigate',
  'setup_open_group',
  'setup_welcome',
  'setup_watch',
  'setup_browse',
  'setup_expand_comment',
  'setup_fill_comment',
  'setup_open_share',
  'setup_scroll',
  'submit_like',
  'submit_comment',
  'submit_story_share',
]);
const nullStr = z.string().nullable().default(null);
export const BumperResolution = strictObj({
  id: Id,
  outcome: z.enum(['VERIFIED', 'NOT_APPLIED', 'ENDED_UNKNOWN']),
  evidenceDigest: Sha256Hex,
});
export const BumperOperation = strictObj({
  binding: DispatchBinding,
  runId: Id,
  actionKind: BumperActionKind,
  groupId: z.string(),
  groupName: z.string(),
  pageId: nullStr,
  pageName: nullStr,
  postId: nullStr,
  postUrl: nullStr,
  commentId: nullStr,
  commentText: nullStr,
  logId: Id.nullable().default(null),
  resolution: BumperResolution.nullable().default(null),
  status: z
    .enum(['PREPARED', 'SETTLEMENT_PENDING', 'SETTLED', 'PENDING_REVIEW'])
    .default('PREPARED'),
  reason: z.string().default(''),
});
export type BumperOperationValue = z.infer<typeof BumperOperation>;
export type BumperResolutionValue = z.infer<typeof BumperResolution>;
