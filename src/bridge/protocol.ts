import { z } from 'zod';
import { Action } from '../shared/browser-actions.js';
import { Id, Sha256Hex } from '../shared/contracts.js';
export { Action, Spec, ORIGIN, isWrite, canonicalAction } from '../shared/browser-actions.js';
export const VERSION = 2;
export const LEASE_MS = 10_000;
export type Status =
  | 'PREPARED'
  | 'DISPATCHING'
  | 'ACKNOWLEDGED'
  | 'VERIFIED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'CANCELLED'
  | 'ABANDONED';
export const JournalEntry = z
  .object({
    operationId: Id,
    commandId: Id,
    action: Action,
    digest: Sha256Hex,
    status: z.enum(['DISPATCHING', 'ACKNOWLEDGED', 'VERIFIED', 'FAILED', 'UNKNOWN']),
    legacyFixture: z.boolean().default(false),
  })
  .strict();
export type JournalEntry = z.infer<typeof JournalEntry>;
export const Review = z
  .object({
    profileId: Id,
    commandId: Id,
    decision: z.enum(['CONFIRMED_SUCCESS', 'CONFIRMED_NOT_APPLIED', 'ABANDON']),
    note: z.string().min(5).max(2000),
  })
  .strict();
export const Intent = z.object({ profileId: Id, operationId: Id, action: Action }).strict();
export type Intent = z.infer<typeof Intent>;
export type Command = {
  type: 'COMMAND';
  version: number;
  commandId: string;
  operationId: string;
  connectionEpoch: string;
  deadline: number;
  action: Action;
};
export type Reply = {
  type: 'RESULT';
  commandId: string;
  status: 'ACKNOWLEDGED' | 'VERIFIED' | 'FAILED' | 'UNKNOWN';
  evidence?: unknown;
  error?: string;
};
export type WindowBounds = { left: number; top: number; width: number; height: number };
export type WindowDisplayBounds = WindowBounds & { id: string };
export class BridgeError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
