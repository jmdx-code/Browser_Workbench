import { z } from 'zod';

export const ArchiveListRequest = z.object({ profileId: z.uuid(), planId: z.uuid() }).strict();
export const ArchiveResumeRequest = ArchiveListRequest.extend({
  attemptId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  expectedPreparationRevision: z.number().int().nonnegative(),
}).strict();
export const ArchiveManagementList = z
  .object({
    profileId: z.uuid(),
    planId: z.uuid(),
    executionEnabled: z.boolean(),
    truncated: z.boolean(),
    archives: z
      .array(
        z
          .object({
            attemptId: z.uuid(),
            state: z.enum(['PENDING', 'MOVING', 'REVIEW', 'COMPLETED']),
            revision: z.number().int().nonnegative(),
            preparationRevision: z.number().int().nonnegative(),
            preparationState: z.enum(['PREPARING', 'READY', 'REVIEW']).nullable(),
            reason: z.string().max(500),
            resumable: z.boolean(),
            files: z
              .array(
                z
                  .object({
                    source: z.string().max(4096),
                    target: z.string().max(4096),
                    preserveSource: z.boolean(),
                  })
                  .strict(),
              )
              .max(21),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const ArchiveResumeResult = z
  .object({ accepted: z.literal(true), attemptId: z.uuid() })
  .strict();
export type ManagedArchiveList = z.infer<typeof ArchiveManagementList>;
export type ArchiveResume = z.infer<typeof ArchiveResumeRequest>;
