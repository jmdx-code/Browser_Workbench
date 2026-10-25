export type PresentationRecoveryDecision = boolean | 'focus';

import { z } from 'zod';
import { OwnedTabProof } from './kernel-state.js';

export const PresentationMonitorState = z
  .object({
    phase: z.enum([
      'ARMED',
      'CHECK',
      'REQUEST',
      'DEFERRED',
      'FOCUS_RESULT',
      'LAYOUT_RESULT',
      'PROBE_ERROR',
      'MONITOR_ERROR',
    ]),
    windowFocused: z.boolean().nullable().optional(),
    visibility: z.enum(['hidden', 'visible']).nullable().optional(),
    visibilityAt: z.number().finite().nonnegative().optional(),
    probePending: z.boolean().optional(),
    reason: z.string().max(200).optional(),
  })
  .strict();

export { ProfilePresentationStatus } from './presentation-status.js';

const scope = {
  requestId: z.uuid(),
  connectionEpoch: z.uuid(),
  leaseId: z.uuid(),
  generation: z.number().int().nonnegative(),
};
export const PresentationRecoveryRequest = z
  .object({
    type: z.literal('PRESENTATION_RECOVERY_REQUEST'),
    ...scope,
    proof: OwnedTabProof,
    positionOnly: z.boolean().optional(),
  })
  .strict();
export const PresentationRecoveryPermit = z
  .object({
    type: z.literal('PRESENTATION_RECOVERY_PERMIT'),
    ...scope,
    granted: z.boolean(),
    focusFallback: z.literal(true).optional(),
    expiresAt: z.number().finite().nonnegative(),
  })
  .strict();
