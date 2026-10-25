import { z } from 'zod';
import { MaterialIssue } from './materials.js';
import { MaterialSnapshot } from './material-snapshot.js';
import { ResourceMaterialOrigin, ResourceMaterialSnapshot } from './resource-materials.js';
export { MaterialFile, MaterialSnapshot } from './material-snapshot.js';
import { ExecutionContext } from './task-execution.js';
import { OwnedTabProof } from './kernel-state.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const CompleteMaterialScan = z
  .object({
    directory: z.string().min(1).max(2048),
    complete: z.literal(true),
    packages: z.array(MaterialSnapshot).max(500),
    issues: z.array(MaterialIssue).max(200),
    excluded: z.number().int().nonnegative(),
  })
  .strict();
// Trusted internal contracts. No catalog snapshot, account or target proof is accepted from HTTP.
export const MaterialCatalog = z
  .object({
    id: z.uuid(),
    directory: z.string().min(1).max(2048),
    revision: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    scan: CompleteMaterialScan,
    sources: z.array(z.object({ id: z.uuid(), snapshot: MaterialSnapshot }).strict()).max(500),
  })
  .strict();
export const ReserveMaterial = z
  .object({
    attemptId: z.uuid(),
    jobId: z.uuid(),
    stepId: z.uuid(),
    expectedProgressRevision: z.number().int().nonnegative(),
    catalogId: z.uuid(),
    sourceId: z.uuid(),
    context: ExecutionContext,
    proof: OwnedTabProof,
  })
  .strict();
export const DirectoryMaterialPostIntent = ReserveMaterial.extend({
  fingerprintVersion: z.literal(1),
  fingerprint: digest,
  directory: z.string().min(1).max(2048),
  snapshot: MaterialSnapshot,
  allowRepeat: z.boolean(),
  ordinal: z.number().int().positive(),
}).strict();
export const ResourceMaterialPostIntent = DirectoryMaterialPostIntent.extend({
  directory: z.null(),
  resource: ResourceMaterialOrigin,
  snapshot: ResourceMaterialSnapshot,
}).strict();
export const MaterialPostIntent = z.union([
  DirectoryMaterialPostIntent,
  ResourceMaterialPostIntent,
]);
export const MaterialReservation = z
  .object({
    intent: MaterialPostIntent,
    state: z.enum(['RESERVED', 'REVIEW', 'PUBLISHED', 'NOT_PUBLISHED']),
    reason: z.string().max(200),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type Catalog = z.infer<typeof MaterialCatalog>;
export type ReservationRequest = z.infer<typeof ReserveMaterial>;
export type PostIntent = z.infer<typeof MaterialPostIntent>;
export type Reservation = z.infer<typeof MaterialReservation>;
