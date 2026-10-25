import { z } from 'zod';
import { TaskState } from './task-contracts.js';
export const NativeReviewRequest = z.object({ profileId: z.uuid() }).strict();
export const NativeReleaseResult = z
  .object({
    released: z.number().int().nonnegative(),
    endedOperations: z.number().int().nonnegative().default(0),
  })
  .strict();
export const NativeReviewReport = z
  .object({
    profileId: z.uuid(),
    checkedAt: z.iso.datetime(),
    unresolvedCount: z.number().int().nonnegative(),
    blockingCount: z.number().int().nonnegative().optional(),
    activeTabCount: z.number().int().nonnegative().optional(),
    unclosedTabCount: z.number().int().nonnegative(),
    tabs: z
      .array(
        z
          .object({
            id: z.uuid(),
            state: z.enum(['CREATING', 'READY', 'UNKNOWN']),
            hasProof: z.boolean(),
            reason: z.string().max(200),
          })
          .strict(),
      )
      .max(500)
      .optional(),
    operations: z
      .array(
        z
          .object({
            id: z.uuid(),
            nativeState: z.enum(['DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN']),
            ended: z.boolean().optional(),
            accountId: z.string().min(1).max(200),
            local: z
              .object({
                planId: z.uuid(),
                name: z.string(),
                planState: TaskState,
                operationState: z.string(),
                kind: z.string(),
                controlConfirmed: z.boolean(),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .max(100),
    truncated: z.boolean(),
  })
  .strict();
export type NativeReview = z.infer<typeof NativeReviewReport>;
export const NATIVE_REVIEW_CONTRACT_HEADER = 'x-workbench-native-review-contract';
export const NativeReviewReportV2 = NativeReviewReport.extend({
  version: z.literal(2),
  browserSessionEpoch: z.uuid(),
}).strict();
export type NativeReviewV2 = z.infer<typeof NativeReviewReportV2>;
