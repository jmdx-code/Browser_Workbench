import { z } from 'zod';
import { MaterialFormat, MaterialPublishingReview } from './materials.js';
const Override = z
  .object({
    profileId: z.uuid(),
    ordinal: z.number().int().min(1).max(20),
    sourceIndex: z.number().int().min(0).max(499).nullable(),
  })
  .strict();
export const MaterialArrangementRequest = z
  .object({
    scanId: z.uuid(),
    profileIds: z
      .array(z.uuid())
      .min(1)
      .max(1000)
      .refine((ids) => new Set(ids).size === ids.length),
    count: z.number().int().min(1).max(20),
    allowRepeat: z.boolean(),
    overrides: z.array(Override).max(1000).optional(),
  })
  .strict()
  .refine((value) => value.profileIds.length * value.count <= 1000, '排贴草案最多1000行');
export const MaterialArrangement = z
  .object({
    scanId: z.uuid(),
    directory: z.string().max(2048),
    scannedAt: z.string().datetime(),
    count: z.number().int().min(1).max(20),
    allowRepeat: z.boolean(),
    readonly: z.literal(true),
    publishingReady: z.literal(false),
    currentness: z.literal('scan-snapshot'),
    targets: MaterialPublishingReview.shape.targets,
    candidates: z
      .array(
        z
          .object({
            source: z.string().min(1).max(2048),
            format: MaterialFormat,
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            textLength: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(500),
    rows: z
      .array(
        Override.extend({
          blockers: z
            .array(
              z.enum([
                'MISSING_CONTENT',
                'TEXT_INPUT_LIMIT',
                'DUPLICATE_CONTENT',
                'SAME_PROFILE_CONTENT_REPEATED',
              ]),
            )
            .max(4),
        }).strict(),
      )
      .min(1)
      .max(1000),
    missing: z.number().int().min(0).max(1000),
    conflicted: z.number().int().min(0).max(1000),
    blockers: z.tuple([
      z.literal('SOURCE_UNVERIFIED'),
      z.literal('HISTORY_UNCHECKED'),
      z.literal('PUBLISHER_UNAVAILABLE'),
    ]),
  })
  .strict();
export type ArrangementRequest = z.infer<typeof MaterialArrangementRequest>;
export type Arrangement = z.infer<typeof MaterialArrangement>;
