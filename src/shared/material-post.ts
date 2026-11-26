import { z } from 'zod';
import { Id, Sha256Hex, addIssue, intRange, sReq, strictObj } from './contracts.js';
import { OwnedTabProof } from './kernel-state.js';
import { BoundReceipt } from './task-execution.js';
const PostPurpose = z.enum([
  'PREPARE_HOME',
  'PREPARE_STORY',
  'OPEN_COMPOSER',
  'OPEN_AUDIENCE',
  'SELECT_SELF',
  'SELECT_FRIENDS',
  'VERIFY_AUDIENCE',
  'CLOSE_AUDIENCE',
  'CONFIRM_AUDIENCE',
  'OPEN_BACKGROUND',
  'SET_BACKGROUND',
  'OPEN_AI_LABEL',
  'SET_AI_LABEL',
  'CONFIRM_AI_LABEL',
  'SET_TEXT',
  'PREPARE_MEDIA',
  'UPLOAD_MEDIA',
  'ADVANCE_COMPOSER',
  'SUBMIT',
]);
const PostEvidenceBase = strictObj({
  kind: z.literal('material-post-verification'),
  independent: z.literal(true),
  attemptId: Id,
  fingerprint: Sha256Hex,
  purpose: PostPurpose,
  proof: OwnedTabProof,
  observedAccountId: sReq(200),
  observationId: Id,
  checkedAt: z.string().datetime(),
  outcome: z.enum(['APPLIED', 'NOT_APPLIED', 'PUBLISHED', 'NOT_PUBLISHED']),
  basis: z.enum([
    'page-preparation-observed',
    'composer-effect-observed',
    'media-upload-observed',
    'verified-action-not-applied',
    'own-post-observed',
    'submission-confirmed-not-published',
  ]),
  postId: sReq(200).nullable(),
  media: strictObj({
    ready: z.literal(true),
    format: z.enum(['single-image', 'multi-image', 'video']),
    count: intRange(1, 20),
  }).optional(),
});
const PostEvidence = PostEvidenceBase.superRefine((e, ctx) => {
  if (
    (e.purpose === 'SUBMIT') !== ['PUBLISHED', 'NOT_PUBLISHED'].includes(e.outcome) ||
    (e.outcome === 'PUBLISHED') !== (e.postId !== null)
  )
    addIssue(ctx, 'POST_EVIDENCE_PHASE_INVALID');
  const expectedBasis = {
    APPLIED:
      e.purpose === 'UPLOAD_MEDIA'
        ? 'media-upload-observed'
        : ['PREPARE_HOME', 'PREPARE_STORY'].includes(e.purpose)
          ? 'page-preparation-observed'
          : 'composer-effect-observed',
    NOT_APPLIED: 'verified-action-not-applied',
    PUBLISHED: 'own-post-observed',
    NOT_PUBLISHED: 'submission-confirmed-not-published',
  };
  if (e.basis !== expectedBasis[e.outcome]) addIssue(ctx, 'POST_EVIDENCE_BASIS_INVALID');
  if ((e.purpose === 'UPLOAD_MEDIA' && e.outcome === 'APPLIED') !== (e.media !== undefined))
    addIssue(ctx, 'POST_MEDIA_OBSERVATION_REQUIRED');
});
const PostReceipt = BoundReceipt.extend({ evidence: PostEvidence }).strict();
const NegativeAttemptEvidence = PostEvidenceBase.pick({
  kind: true,
  independent: true,
  attemptId: true,
  fingerprint: true,
  proof: true,
  observedAccountId: true,
  observationId: true,
  checkedAt: true,
})
  .extend({
    outcome: z.literal('NOT_PUBLISHED'),
    basis: z.literal('independently-verified-not-published'),
  })
  .strict();
const idList = z.array(Id).max(200);
export const AttemptVerdict = z.discriminatedUnion('basis', [
  strictObj({
    attemptId: Id,
    outcome: z.literal('NOT_PUBLISHED'),
    basis: z.literal('CURRENT_STOP_NO_SUBMIT'),
    endingId: Id,
    operationIds: idList,
  }),
  strictObj({
    attemptId: Id,
    outcome: z.enum(['PUBLISHED', 'NOT_PUBLISHED']),
    basis: z.literal('SUBMIT_OPERATION'),
    receipt: PostReceipt,
  }),
  strictObj({
    attemptId: Id,
    outcome: z.literal('NOT_PUBLISHED'),
    basis: z.literal('LOCAL_NEVER_DISPATCHED'),
    operationIds: idList,
  }),
  strictObj({
    attemptId: Id,
    outcome: z.literal('NOT_PUBLISHED'),
    basis: z.literal('INDEPENDENT_ATTEMPT'),
    evidence: NegativeAttemptEvidence,
  }),
]);
