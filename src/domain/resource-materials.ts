import type { Awaitable } from './persistence.js';
import { normalizeMaterialText, materialFingerprintPayload } from './materials.js';
import { validateResourceRows, hasResource } from './resource-table.js';
import {
  ResourceMaterialOrigin,
  ResourceMaterialSnapshot,
  type ResourceMaterial,
  type ResourceCatalog,
  type DownloadedResourceMedia,
} from '../shared/resource-materials.js';
import type { ResourceRowValue } from '../shared/resource-table.js';
export interface ResourceMaterialReader {
  snapshot(
    row: ResourceRowValue,
    assertCurrent: (bytesRead?: number) => Awaitable<void>,
  ): Promise<ResourceMaterial>;
}
export interface ResourceMaterialIndex {
  indexResources(
    jobId: string,
    catalogId: string,
    snapshots: ResourceMaterial[],
  ): Awaitable<ResourceCatalog>;
}

export function resourceMemberKey(
  row: ResourceRowValue,
  index: number,
  download?: DownloadedResourceMedia,
) {
  const media = row.media[index];
  if (!media) throw Error('RESOURCE_MEDIA_SOURCE_REQUIRED');
  const extension =
    media.kind === 'drive'
      ? download?.extension
      : /\.(png|jpe?g|webp|mp4|mov)$/i.exec(media.source)?.[0].toLowerCase();
  if (!extension) throw Error('RESOURCE_MEDIA_TYPE_REQUIRED');
  return row.id + '/' + String(index + 1).padStart(3, '0') + extension;
}
export function resourceFormat(
  row: ResourceRowValue,
  files?: ResourceMaterial['files'],
): ResourceMaterial['format'] {
  validateResourceRows([row]);
  if (!hasResource(row)) throw Error('RESOURCE_EMPTY');
  if (!row.media.length) return 'text';
  const role = row.media[0]?.mediaType === 'unknown' ? files?.[0]?.role : row.media[0]?.mediaType;
  if (role !== 'image' && role !== 'video') throw Error('RESOURCE_MEDIA_TYPE_REQUIRED');
  if (role === 'video') return 'video';
  return row.media.length === 1 ? 'single-image' : 'multi-image';
}
export function resourceEffectiveRow(
  row: ResourceRowValue,
  snapshot: ResourceMaterial,
): ResourceRowValue {
  const downloads = snapshot.downloads ?? [];
  if (new Set(downloads.map((item) => item.index)).size !== downloads.length)
    throw Error('RESOURCE_DOWNLOAD_DUPLICATED');
  const media = row.media.map((item, index) => {
    const download = downloads.find((entry) => entry.index === index);
    if (item.kind === 'local') {
      if (download) throw Error('RESOURCE_DOWNLOAD_SCOPE');
      return item;
    }
    const original = snapshot.files[index];
    if (
      !download ||
      download.source !== item.source ||
      download.index !== index ||
      !original ||
      original.digest !== download.digest ||
      original.bytes !== download.bytes ||
      JSON.stringify(original.proof) !== JSON.stringify(download.proof) ||
      !download.path.endsWith(download.extension)
    )
      throw Error('RESOURCE_DOWNLOAD_SCOPE');
    const name = download.path.split(/[\\/]/).at(-1);
    if (!name) throw Error('RESOURCE_DOWNLOAD_SCOPE');
    return {
      kind: 'local' as const,
      source: download.path,
      name,
      mediaType: download.extension === '.mp4' ? ('video' as const) : ('image' as const),
    };
  });
  if (downloads.some((item) => row.media[item.index]?.kind !== 'drive'))
    throw Error('RESOURCE_DOWNLOAD_SCOPE');
  const effective = { ...row, media };
  validateResourceRows([effective]);
  return effective;
}
export function validateResourceMaterial(input: unknown, originInput: unknown) {
  const snapshot = ResourceMaterialSnapshot.parse(input),
    origin = ResourceMaterialOrigin.parse(originInput);
  validateResourceRows([origin.row]);
  const effective = resourceEffectiveRow(origin.row, snapshot);
  if (
    snapshot.source !== origin.row.id ||
    snapshot.text !== normalizeMaterialText(origin.row.text) ||
    snapshot.format !== resourceFormat(effective) ||
    snapshot.files.length !== origin.row.media.length
  )
    throw Error('RESOURCE_MATERIAL_SNAPSHOT_MISMATCH');
  for (const [index, file] of snapshot.files.entries())
    if (
      file.relativePath !==
        resourceMemberKey(
          origin.row,
          index,
          snapshot.downloads?.find((item) => item.index === index),
        ) ||
      file.role !== effective.media[index]?.mediaType ||
      file.proof.size !== String(file.bytes) ||
      file.bytes < 1
    )
      throw Error('RESOURCE_MATERIAL_MEMBER_MISMATCH');
  return materialFingerprintPayload(snapshot.text, snapshot.files);
}
