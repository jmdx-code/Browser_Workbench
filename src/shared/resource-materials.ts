import { z } from 'zod';
import { Id, NonNegInt, PosInt, Sha256Hex, intRange, sMax, sReq, strictObj } from './contracts.js';
import { MaterialFormat } from './materials.js';
import { ResourceRow } from './resource-table.js';
const uintText = z.string().regex(/^\d+$/),
  signedText = z.string().regex(/^-?\d+$/),
  srcStr = sReq(2048);
export const MaterialFile = strictObj({
  relativePath: srcStr,
  role: z.enum(['text', 'image', 'video']),
  digest: Sha256Hex,
  bytes: NonNegInt.max(Number.MAX_SAFE_INTEGER),
  proof: strictObj({
    dev: uintText,
    ino: uintText,
    size: uintText,
    mtimeNs: signedText,
    ctimeNs: signedText,
  }),
});
export const MaterialSnapshot = strictObj({
  source: srcStr,
  format: MaterialFormat,
  text: sMax(262144),
  fingerprint: Sha256Hex,
  files: z.array(MaterialFile).min(1).max(21),
});
export const DownloadedResource = strictObj({
  index: intRange(0, 19),
  source: srcStr,
  path: sReq(4096),
  extension: z.enum(['.png', '.jpg', '.webp', '.mp4']),
  digest: Sha256Hex,
  bytes: MaterialFile.shape.bytes,
  proof: MaterialFile.shape.proof,
});
export type DownloadedResourceMedia = z.infer<typeof DownloadedResource>;
// Media keys identify saved row members; they are not paths in a fabricated source directory.
export const ResourceMaterialSnapshot = MaterialSnapshot.extend({
  source: Id,
  files: z.array(MaterialFile).max(20),
  downloads: z.array(DownloadedResource).max(20).optional(),
}).strict();
export const ResourceMaterialOrigin = strictObj({
  version: z.literal(1),
  combinationId: Id,
  revision: PosInt,
  row: ResourceRow,
});
export type ResourceMaterial = z.infer<typeof ResourceMaterialSnapshot>;
export type ResourceOrigin = z.infer<typeof ResourceMaterialOrigin>;
