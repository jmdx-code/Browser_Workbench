import { z } from 'zod';
import { Id, ProfileSchema } from './contracts.js';
import { AvatarObservation, NameObservation } from './account-display.js';

export const InspectProfiles = z.object({ profileIds: z.array(Id).min(1).max(1000) }).strict();
export const InspectionReason = z.enum([
  'ACTING_ACCOUNT_UNVERIFIED',
  'VISIBLE_LOGIN_FORM',
  'CHECKPOINT_ROUTE',
  'PROFILE_OFFLINE',
  'INSPECTION_EXTENSION_UPDATE_REQUIRED',
  'INSPECTION_PROFILE_NOT_IDLE',
  'INSPECTION_PLAN_PENDING',
  'INSPECTION_OPERATION_PENDING',
  'INSPECTION_NATIVE_REVIEW_REQUIRED',
  'INSPECTION_CONNECTION_CHANGED',
  'INSPECTION_EXPIRED',
  'INSPECTION_CANCELLED',
  'INSPECTION_RELEASE_PENDING',
  'INSPECTION_DOCUMENT_NOT_READY',
  'INSPECTION_DOCUMENT_CHANGED',
  'INSPECTION_READ_RELEASE_UNCONFIRMED',
  'INSPECTION_TRANSPORT_UNCONFIRMED',
  'INSPECTION_CONTROL_INTERRUPTED',
  'INSPECTION_FAILED',
]);
export type InspectionReasonCode = z.infer<typeof InspectionReason>;
export const ProfileInspection = z
  .object({
    profileId: Id,
    state: z.enum(['QUEUED', 'READING', 'OBSERVED', 'BLOCKED', 'FAILED']),
    reason: InspectionReason.or(z.literal('')),
    checkedAt: z.number().int().nonnegative().nullable(),
    account: ProfileSchema.shape.account,
    avatarObservation: AvatarObservation.nullable().default(null),
    nameObservation: NameObservation.nullable().default(null),
  })
  .strict();
export const ProfileInspections = z
  .object({ results: z.array(ProfileInspection).max(1000) })
  .strict();
export type Inspection = z.infer<typeof ProfileInspection>;

export const INSPECTION_DISPLAY_HEADER = 'x-workbench-inspection-display';
// Existing open clients use a strict schema. Add display fields only after negotiation.
export function inspectionResponse(input: unknown, displayVersion: unknown) {
  const result = ProfileInspections.parse(input);
  return displayVersion === '2'
    ? result
    : displayVersion === '1'
      ? { results: result.results.map(({ nameObservation: _name, ...row }) => row) }
      : {
          results: result.results.map(({ profileId, state, reason, checkedAt, account }) => ({
            profileId,
            state,
            reason,
            checkedAt,
            account,
          })),
        };
}
