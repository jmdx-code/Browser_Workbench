import { z } from 'zod';
import { Action } from '../shared/browser-actions.js';
export {
  Action,
  Spec,
  ORIGIN,
  TaskURL,
  allowedTaskURL,
  isWrite,
  canonicalAction,
} from '../shared/browser-actions.js';
export const VERSION = 2;

export const LEASE_MS = 4500;
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
    operationId: z.string().uuid(),
    commandId: z.string().uuid(),
    action: Action,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['DISPATCHING', 'ACKNOWLEDGED', 'VERIFIED', 'FAILED', 'UNKNOWN']),
    legacyFixture: z.boolean().default(false),
  })
  .strict();
export type JournalEntry = z.infer<typeof JournalEntry>;
export const Review = z
  .object({
    profileId: z.string().uuid(),
    commandId: z.string().uuid(),
    decision: z.enum(['CONFIRMED_SUCCESS', 'CONFIRMED_NOT_APPLIED', 'ABANDON']),
    note: z.string().min(5).max(2000),
  })
  .strict();
export const Intent = z
  .object({ profileId: z.string().uuid(), operationId: z.string().uuid(), action: Action })
  .strict();
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
export class BridgeError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
