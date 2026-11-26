import { z } from 'zod';
import { Id, NonNegInt, PosInt, Sha256Hex, strictObj } from './contracts.js';
import { ResourceMaterialOrigin, ResourceMaterialSnapshot } from './resource-materials.js';
import { ExecutionContext } from './task-execution.js';
import { OwnedTabProof } from './kernel-state.js';
export { MaterialFile, MaterialSnapshot } from './resource-materials.js';
// Trusted internal contracts. No catalog snapshot, account or target proof is accepted from HTTP.
const ReserveMaterial = strictObj({
  attemptId: Id,
  jobId: Id,
  stepId: Id,
  expectedProgressRevision: NonNegInt,
  catalogId: Id,
  sourceId: Id,
  context: ExecutionContext,
  proof: OwnedTabProof,
});
export const ResourceMaterialPostIntent = ReserveMaterial.extend({
  fingerprintVersion: z.literal(1),
  fingerprint: Sha256Hex,
  directory: z.null(),
  resource: ResourceMaterialOrigin,
  snapshot: ResourceMaterialSnapshot,
  allowRepeat: z.boolean(),
  ordinal: PosInt,
}).strict();
export const MaterialPostIntent = ResourceMaterialPostIntent;
export type PostIntent = z.infer<typeof MaterialPostIntent>;
