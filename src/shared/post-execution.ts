import { z } from 'zod';
import { ReserveMaterial } from './material-index.js';
import { PreparePostOperation, PostReceipt } from './material-post.js';

// Private executor decisions only. Never accept these observations through HTTP or the renderer.
export const PostDecision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wait'), reason: z.string().max(200) }).strict(),
  z.object({ kind: z.literal('reserve'), request: ReserveMaterial }).strict(),
  z
    .object({ kind: z.literal('reserve-next'), request: ReserveMaterial.omit({ sourceId: true }) })
    .strict(),
  z.object({ kind: z.literal('action'), operation: PreparePostOperation }).strict(),
]);
export const PostVerdict = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wait'), reason: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('unknown'), reason: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('verified'), receipt: PostReceipt }).strict(),
]);
export type PostExecutionDecision = z.infer<typeof PostDecision>;
export type PostExecutionVerdict = z.infer<typeof PostVerdict>;
