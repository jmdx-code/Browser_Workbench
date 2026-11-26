import { z } from 'zod';
import { Id, NonNegFinite, NonNegInt, optBool, sMax, strictObj } from './contracts.js';
import { OwnedTabProof } from './kernel-state.js';
export { ProfilePresentationStatus } from './contracts.js';
export type PresentationRecoveryDecision = boolean | 'focus';
export const PresentationMonitorState = strictObj({
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
  windowFocused: optBool.nullable(),
  visibility: z.enum(['hidden', 'visible']).nullable().optional(),
  visibilityAt: NonNegFinite.optional(),
  probePending: optBool,
  reason: sMax(200).optional(),
});
const scope = { requestId: Id, connectionEpoch: Id, leaseId: Id, generation: NonNegInt };
export const PresentationRecoveryRequest = strictObj({
  type: z.literal('PRESENTATION_RECOVERY_REQUEST'),
  ...scope,
  proof: OwnedTabProof,
  positionOnly: optBool,
});
export const PresentationRecoveryPermit = strictObj({
  type: z.literal('PRESENTATION_RECOVERY_PERMIT'),
  ...scope,
  granted: z.boolean(),
  focusFallback: z.literal(true).optional(),
  expiresAt: NonNegFinite,
});
