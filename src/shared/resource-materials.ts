import { z } from 'zod';
import { MaterialFile, MaterialSnapshot } from './material-snapshot.js';
import { ResourceRow } from './resource-table.js';

export const DownloadedResource = z
  .object({
    index: z.number().int().min(0).max(19),
    source: z.string().min(1).max(2048),
    path: z.string().min(1).max(4096),
    extension: z.enum(['.png', '.jpg', '.webp', '.mp4']),
    digest: MaterialFile.shape.digest,
    bytes: MaterialFile.shape.bytes,
    proof: MaterialFile.shape.proof,
  })
  .strict();
export type DownloadedResourceMedia = z.infer<typeof DownloadedResource>;

// Media keys identify saved row members; they are not paths in a fabricated source directory.
export const ResourceMaterialSnapshot = MaterialSnapshot.extend({
  source: z.uuid(),
  files: z.array(MaterialFile).max(20),
  downloads: z.array(DownloadedResource).max(20).optional(),
}).strict();
export const ResourceMaterialOrigin = z
  .object({
    version: z.literal(1),
    combinationId: z.uuid(),
    revision: z.number().int().positive(),
    row: ResourceRow,
  })
  .strict();
export const ResourceMaterialCatalog = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    combinationId: z.uuid(),
    resourceRevision: z.number().int().positive(),
    revision: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    sources: z
      .array(
        z
          .object({
            id: z.uuid(),
            origin: ResourceMaterialOrigin,
            snapshot: ResourceMaterialSnapshot,
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export type ResourceMaterial = z.infer<typeof ResourceMaterialSnapshot>;
export type ResourceCatalog = z.infer<typeof ResourceMaterialCatalog>;
export type ResourceOrigin = z.infer<typeof ResourceMaterialOrigin>;
