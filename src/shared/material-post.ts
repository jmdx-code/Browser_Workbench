import { z } from 'zod';
import { Action } from './browser-actions.js';
import { BoundReceipt } from './task-execution.js';
import { OwnedTabProof } from './kernel-state.js';
import { DirectoryMaterialPostIntent, ResourceMaterialPostIntent } from './material-index.js';

export const PostPurpose = z.enum([
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
export const PreparePostOperation = z
  .object({ attemptId: z.uuid(), operationId: z.uuid(), purpose: PostPurpose, action: Action })
  .strict();
export const PostOperation = PreparePostOperation.extend({
  sequence: z.number().int().positive(),
}).strict();
// Produced by a trusted independent business observer, never by transport ACK or public HTTP.
export const PostEvidence = z
  .object({
    kind: z.literal('material-post-verification'),
    independent: z.literal(true),
    attemptId: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    purpose: PostPurpose,
    proof: OwnedTabProof,
    observedAccountId: z.string().min(1).max(200),
    observationId: z.uuid(),
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
    postId: z.string().min(1).max(200).nullable(),
    media: z
      .object({
        ready: z.literal(true),
        format: z.enum(['single-image', 'multi-image', 'video']),
        count: z.number().int().min(1).max(20),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    if (
      (evidence.purpose === 'SUBMIT') !==
        ['PUBLISHED', 'NOT_PUBLISHED'].includes(evidence.outcome) ||
      (evidence.outcome === 'PUBLISHED') !== (evidence.postId !== null)
    )
      ctx.addIssue({ code: 'custom', message: 'POST_EVIDENCE_PHASE_INVALID' });
    const basis = {
      APPLIED:
        evidence.purpose === 'UPLOAD_MEDIA'
          ? 'media-upload-observed'
          : ['PREPARE_HOME', 'PREPARE_STORY'].includes(evidence.purpose)
            ? 'page-preparation-observed'
            : 'composer-effect-observed',
      NOT_APPLIED: 'verified-action-not-applied',
      PUBLISHED: 'own-post-observed',
      NOT_PUBLISHED: 'submission-confirmed-not-published',
    };
    if (evidence.basis !== basis[evidence.outcome])
      ctx.addIssue({ code: 'custom', message: 'POST_EVIDENCE_BASIS_INVALID' });
    if (
      (evidence.purpose === 'UPLOAD_MEDIA' && evidence.outcome === 'APPLIED') !==
      (evidence.media !== undefined)
    )
      ctx.addIssue({ code: 'custom', message: 'POST_MEDIA_OBSERVATION_REQUIRED' });
  });
export const PostReceipt = BoundReceipt.extend({ evidence: PostEvidence }).strict();
// This verdict is for the whole attempt, not an operation purpose. Define its
// actual shared fields explicitly; operation-only cross-field checks do not
// apply here and current Zod correctly rejects omitting refined fields.
export const NegativeAttemptEvidence = z
  .object({
    kind: PostEvidence.shape.kind,
    independent: PostEvidence.shape.independent,
    attemptId: PostEvidence.shape.attemptId,
    fingerprint: PostEvidence.shape.fingerprint,
    proof: PostEvidence.shape.proof,
    observedAccountId: PostEvidence.shape.observedAccountId,
    observationId: PostEvidence.shape.observationId,
    checkedAt: PostEvidence.shape.checkedAt,
    outcome: z.literal('NOT_PUBLISHED'),
    basis: z.literal('independently-verified-not-published'),
  })
  .strict();
export const AttemptVerdict = z.discriminatedUnion('basis', [
  z
    .object({
      attemptId: z.uuid(),
      outcome: z.literal('NOT_PUBLISHED'),
      basis: z.literal('CURRENT_STOP_NO_SUBMIT'),
      endingId: z.uuid(),
      operationIds: z.array(z.uuid()).max(200),
    })
    .strict(),
  z
    .object({
      attemptId: z.uuid(),
      outcome: z.enum(['PUBLISHED', 'NOT_PUBLISHED']),
      basis: z.literal('SUBMIT_OPERATION'),
      receipt: PostReceipt,
    })
    .strict(),
  z
    .object({
      attemptId: z.uuid(),
      outcome: z.literal('NOT_PUBLISHED'),
      basis: z.literal('LOCAL_NEVER_DISPATCHED'),
      operationIds: z.array(z.uuid()).max(200),
    })
    .strict(),
  z
    .object({
      attemptId: z.uuid(),
      outcome: z.literal('NOT_PUBLISHED'),
      basis: z.literal('INDEPENDENT_ATTEMPT'),
      evidence: NegativeAttemptEvidence,
    })
    .strict(),
]);
const DirectoryArchiveRequest = z
  .object({
    attemptId: z.uuid(),
    intent: DirectoryMaterialPostIntent,
    postId: z.string().min(1).max(200),
    archiveDirectory: z.string().min(1).max(2048),
  })
  .strict();
export const ResourceArchiveRequest = DirectoryArchiveRequest.extend({
  intent: ResourceMaterialPostIntent,
  archiveDirectory: z.null(),
}).strict();
export const ArchiveRequest = z.union([DirectoryArchiveRequest, ResourceArchiveRequest]);
export type PreparePost = z.infer<typeof PreparePostOperation>;
export type PostLink = z.infer<typeof PostOperation>;
export type VerifiedPostReceipt = z.infer<typeof PostReceipt>;
export type AttemptResult = z.infer<typeof AttemptVerdict>;
export type NegativePostEvidence = z.infer<typeof NegativeAttemptEvidence>;
export type PendingArchive = z.infer<typeof ArchiveRequest>;
