import { z } from 'zod';

export const ProfilePresentationStatus = z
  .object({
    active: z.boolean(),
    checkedAt: z.number().finite().nonnegative(),
    visibility: z.enum(['hidden', 'visible']).nullable(),
    visibilityAt: z.number().finite().nonnegative().nullable(),
    windowFocused: z.boolean().nullable(),
    lastRecoveryAt: z.number().finite().nonnegative().nullable(),
    reportedFocused: z.boolean().nullable(),
    error: z.string().max(200).nullable(),
    recoveryAction: z.enum(['FOCUS', 'LAYOUT_MOVE']).nullable().optional(),
  })
  .strict();
export type ProfilePresentationStatus = z.infer<typeof ProfilePresentationStatus>;
