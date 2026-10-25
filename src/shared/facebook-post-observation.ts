import { z } from 'zod';
import { DispatchBinding } from './task-execution.js';
import { OwnedTabProof } from './kernel-state.js';

// Private DOM observations from the owned task page, never a public publishing permission.
const media = z
  .object({
    kind: z.enum(['image', 'video']),
    name: z.string().max(200).nullable(),
    ready: z.boolean(),
    durationSeconds: z.number().finite().positive().optional(),
    previewBytes: z
      .object({
        source: z.literal('owned-preview-blob'),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        size: z
          .number()
          .int()
          .nonnegative()
          .max(32 * 1024 * 1024),
      })
      .strict()
      .optional(),
  })
  .strict();
export const FacebookPostEffects = z
  .object({
    url: z.string().max(4096),
    timeOrigin: z.number().finite().nonnegative(),
    ready: z.enum(['loading', 'interactive', 'complete']),
    composer: z
      .object({
        text: z.string().max(100_000),
        files: z
          .array(
            z.object({ name: z.string().max(200), size: z.number().int().nonnegative() }).strict(),
          )
          .max(20),
        media: z.array(media).max(20),
        uploaded: z.boolean(),
        busy: z.boolean(),
        submitEnabled: z.boolean(),
        advanceEnabled: z.boolean().optional(),
      })
      .strict()
      .nullable(),
    posts: z
      .array(
        z
          .object({
            accountId: z
              .string()
              .regex(/^\d{1,30}$/)
              .nullable(),
            postId: z.string().max(200).nullable(),
            permalink: z.string().max(4096).nullable(),
            text: z.string().max(100_000).nullable(),
            expanded: z.boolean(),
            nestedShare: z.boolean(),
            photos: z.array(z.string().regex(/^\d{1,30}$/)).max(20),
            videoId: z
              .string()
              .regex(/^\d{1,30}$/)
              .nullable(),
            videoReady: z.boolean(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export type PostEffects = z.infer<typeof FacebookPostEffects>;

// A before-submit inventory excludes pre-existing identical posts. It cannot be invented after ACK.
export const FacebookSubmissionBaseline = z
  .object({
    operationId: z.uuid(),
    binding: DispatchBinding,
    proof: OwnedTabProof,
    attemptId: z.uuid(),
    accountId: z.string().regex(/^\d{1,30}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    postIds: z.array(z.string().min(1).max(200)).max(20),
    checkedAt: z.number().int().nonnegative(),
    url: z.string().max(4096),
    timeOrigin: z.number().finite().nonnegative(),
  })
  .strict()
  .refine(
    (value) =>
      value.operationId === value.binding.operationId &&
      value.accountId === value.binding.accountId &&
      value.proof.profileId === value.binding.profileId,
    { message: 'FACEBOOK_SUBMISSION_BASELINE_SCOPE' },
  );
export type SubmissionBaseline = z.infer<typeof FacebookSubmissionBaseline>;

export const FacebookPostResultCorrelation = z
  .object({
    binding: DispatchBinding,
    proof: OwnedTabProof,
    attemptId: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    postId: z.string().regex(/^[a-zA-Z0-9]{1,200}$/),
    photos: z.array(z.string().regex(/^\d{1,30}$/)).max(20),
    videoId: z
      .string()
      .regex(/^\d{1,30}$/)
      .nullable(),
  })
  .strict();
export type PostResultCorrelation = z.infer<typeof FacebookPostResultCorrelation>;
