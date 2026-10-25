import { z } from 'zod';
import { OwnedTabProof } from './kernel-state.js';
import { Id } from './contracts.js';
import { Action } from './browser-actions.js';
import { BoundReceipt } from './task-execution.js';

export const BrowseScrollRoot = z
  .object({
    tag: z.string().max(12),
    role: z.string().max(40).nullable(),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
    top: z.number().finite().nonnegative(),
    max: z.number().finite().nonnegative(),
  })
  .strict();
export const BrowseCenterHit = z
  .object({
    tag: z.string().max(12),
    role: z.string().max(40).nullable(),
    withinMain: z.boolean(),
  })
  .strict();
export const BrowseVisiblePlayer = z
  .object({
    area: z.number().finite().nonnegative(),
    sourceLength: z.number().int().nonnegative(),
    srcObject: z.boolean(),
    readyState: z.number().int().min(0).max(4),
    paused: z.boolean(),
    ended: z.boolean(),
    timeSeconds: z.number().finite().nonnegative(),
    errorCode: z.number().int().nullable(),
    videoWidth: z.number().finite().nonnegative().optional(),
    videoHeight: z.number().finite().nonnegative().optional(),
  })
  .strict();
export const BrowseContentPosition = z
  .object({
    left: z.number().finite(),
    top: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
    viewportHeight: z.number().finite().positive(),
  })
  .strict();
const BrowseWheelStartV1 = z
  .object({
    version: z.literal(1),
    url: z.string().max(4096),
    timeOrigin: z.number().finite().nonnegative(),
    scrollY: z.number().finite().nonnegative(),
  })
  .strict();
export const BrowseWheelStart = z.discriminatedUnion('version', [
  BrowseWheelStartV1,
  BrowseWheelStartV1.extend({
    version: z.literal(2),
    anchor: z
      .object({ contentId: z.string().regex(/^[a-f0-9]{64}$/), position: BrowseContentPosition })
      .strict()
      .nullable(),
  }).strict(),
]);
const BrowsePendingDiagnosticV1 = z
  .object({
    version: z.literal(1),
    independent: z.literal(true),
    url: z.string().max(4096),
    timeOrigin: z.number().finite().nonnegative(),
    ready: z.boolean(),
    visible: z.boolean(),
    blocked: z.boolean(),
    scrollY: z.number().finite().nonnegative(),
    scrollMaxY: z.number().finite().nonnegative().nullable(),
    viewportHeight: z.number().finite().nonnegative(),
    contentId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    mainCount: z.number().int().nonnegative().nullable(),
    scrollRoots: z.array(BrowseScrollRoot).max(4),
    centerHit: BrowseCenterHit.nullable(),
    visiblePlayers: z.array(BrowseVisiblePlayer).max(8).optional(),
    structuralPosts: z.number().int().nonnegative().nullable().optional(),
    inputFence: z
      .object({
        fromY: z.number().finite().nonnegative(),
        requestedDelta: z.number().finite(),
        appliedDelta: z.number().finite().nullable(),
        positionMatches: z.boolean(),
        movementValid: z.boolean(),
        sameUrl: z.boolean(),
        sameTimeOrigin: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const BrowsePendingDiagnostic = z.discriminatedUnion('version', [
  BrowsePendingDiagnosticV1,
  BrowsePendingDiagnosticV1.extend({
    version: z.literal(2),
    contentPosition: BrowseContentPosition.nullable(),
    wheelStart: BrowseWheelStart.optional(),
  }).strict(),
]);
export type PendingDiagnostic = z.infer<typeof BrowsePendingDiagnostic>;
export class BrowseReadTimeout extends Error {
  constructor(
    reason: string,
    readonly diagnostic: PendingDiagnostic,
  ) {
    super(reason);
    BrowsePendingDiagnostic.parse(diagnostic);
  }
}

const purpose = z.enum(['play', 'advance', 'dismiss', 'activate', 'acceptFriend']);
const scope = {
  proof: OwnedTabProof,
  documentEpoch: z.number().int().nonnegative(),
  routeEpoch: z.number().int().nonnegative(),
};
export const BrowseIntent = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('auxiliary'),
      purpose,
      beforeContentId: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      ...scope,
    })
    .strict(),
  z
    .object({
      kind: z.literal('like'),
      contentId: z.string().min(1).max(500),
      observedLikeCount: z.number().int().nonnegative(),
      observedLiked: z.literal(false),
      ...scope,
    })
    .strict(),
]);
export const BrowseOperationIntent = z
  .object({ operationId: Id, jobId: Id, stepId: Id, intent: BrowseIntent })
  .strict();
const observed = {
  ...scope,
  contentId: z.string().min(1).max(500),
  visible: z.boolean(),
  ready: z.boolean(),
};
export const BrowseObservation = z.discriminatedUnion('type', [
  z.object({ type: z.literal('feed'), ...observed }).strict(),
  z.object({ type: z.literal('marketplace'), ...observed }).strict(),
  z.object({ type: z.literal('friends'), ...observed }).strict(),
  z
    .object({
      type: z.literal('video'),
      ...observed,
      paused: z.boolean(),
      buffering: z.boolean(),
      timeSeconds: z.number().finite().nonnegative(),
      playbackRate: z.number().min(0.25).max(4),
    })
    .strict(),
]);
export const BrowseDecision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('observe'), observation: BrowseObservation }).strict(),
  z
    .object({
      kind: z.literal('action'),
      action: Action,
      intent: BrowseIntent,
      observation: BrowseObservation.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('wait'), reason: z.string().min(1).max(200) }).strict(),
]);
export const BrowseEffect = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('auxiliary'),
      purpose,
      observed: z.literal(true),
      afterContentId: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('liked'),
      contentId: z.string().min(1).max(500),
      observedLiked: z.literal(true),
    })
    .strict(),
]);
export const BrowseVerdict = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('WAIT'),
      receipt: BoundReceipt,
      reason: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('VERIFIED'),
      receipt: BoundReceipt,
      effect: BrowseEffect,
      observation: BrowseObservation.optional(),
    })
    .strict(),
  z.object({ outcome: z.literal('NOT_APPLIED'), receipt: BoundReceipt }).strict(),
  z
    .object({
      outcome: z.literal('UNKNOWN'),
      receipt: BoundReceipt,
      reason: z.string().min(1).max(200),
    })
    .strict(),
]);
export type Intent = z.infer<typeof BrowseIntent>;
export type IntentRecord = z.infer<typeof BrowseOperationIntent>;
export type BrowseReading = z.infer<typeof BrowseObservation>;
export type Decision = z.infer<typeof BrowseDecision>;
export type Verdict = z.infer<typeof BrowseVerdict>;
