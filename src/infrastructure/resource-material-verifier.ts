import type { Awaitable } from '../domain/persistence.js';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { FilesystemResourceSourceReader } from './resource-source-reader.js';
import {
  resourceFormat,
  resourceMemberKey,
  validateResourceMaterial,
  resourceEffectiveRow,
} from '../domain/resource-materials.js';
import { ResourceMaterialSnapshot, type ResourceMaterial } from '../shared/resource-materials.js';
import { normalizeMaterialText } from '../domain/materials.js';
import type { ResourceRowValue } from '../shared/resource-table.js';
import type { PostIntent } from '../shared/material-index.js';
import type { SourceObservation } from '../application/material-source-check.js';
import type { MaterialFileSnapshot } from '../shared/materials.js';
import { mediaReference } from '../domain/resource-table.js';
import type { PublicDriveDownloader } from './public-drive-download.js';

export class FilesystemResourceMaterialVerifier {
  constructor(
    private readonly reader = new FilesystemResourceSourceReader(),
    private readonly policy = {
      totalBytes: 10 * 1024 ** 3,
      textBytes: 256 * 1024,
      milliseconds: 30_000,
    },
    private readonly downloads?: PublicDriveDownloader,
    private readonly inspectVideo?: (
      file: string,
      expected: MaterialFileSnapshot,
      guard: () => Awaitable<void>,
    ) => Promise<void>,
  ) {}
  private async budget(
    text: string,
    assertCurrent: (bytesRead?: number) => Awaitable<void>,
    milliseconds = this.policy.milliseconds,
  ) {
    let started = performance.now();
    let bytes = 0;
    const check = async (read = 0) => {
      await assertCurrent(read);
      bytes += read;
      if (
        bytes > this.policy.totalBytes ||
        Buffer.byteLength(text, 'utf8') > this.policy.textBytes ||
        performance.now() - started > milliseconds
      )
        throw Error('RESOURCE_MATERIAL_BUDGET');
      if (read > 0) started = performance.now();
    };
    await check();
    return check;
  }
  async snapshot(
    row: ResourceRowValue,
    assertCurrent: (bytesRead?: number) => Awaitable<void>,
  ): Promise<ResourceMaterial> {
    const bounded = await this.budget(
      row.text,
      assertCurrent,
      this.downloads && row.media.some((media) => media.kind === 'drive')
        ? 300_000
        : this.policy.milliseconds,
    );
    const downloaded: NonNullable<ResourceMaterial['downloads']> = [];
    const effective = structuredClone(row);
    for (const [index, media] of row.media.entries()) {
      if (media.kind !== 'drive') continue;
      if (!this.downloads) throw Error('RESOURCE_SOURCE_DRIVE_DOWNLOAD_PENDING');
      const result = await this.downloads.download(media.source, index, bounded);
      await bounded();
      downloaded.push(result);
      effective.media[index] = mediaReference(result.path);
    }
    const proofs: ResourceMaterial['files'][number]['proof'][] = [];
    const result = await this.reader.verify(effective, bounded, {
      verifiedFile: (index, proof) => {
        proofs[index] = proof;
      },
    });
    await assertCurrent();
    if (!result.verified) throw Error('RESOURCE_SOURCE_' + result.issue);
    if (this.inspectVideo)
      for (const [index, file] of result.files.entries()) {
        const reference = effective.media[index],
          proof = proofs[index];
        if (!reference || reference.kind !== 'local' || !proof)
          throw Error('RESOURCE_VIDEO_SOURCE_REQUIRED');
        await this.inspectVideo(
          reference.source,
          {
            relativePath: file.name,
            role: file.role,
            bytes: file.bytes,
            digest: file.digest,
            proof,
          },
          async () => await bounded(),
        );
        await bounded();
      }
    return ResourceMaterialSnapshot.parse({
      source: row.id,
      format: resourceFormat(effective),
      text: normalizeMaterialText(row.text),
      fingerprint: result.fingerprint,
      files: result.files.map((file, index) => ({
        relativePath: resourceMemberKey(
          row,
          index,
          downloaded.find((item) => item.index === index),
        ),
        role: file.role,
        bytes: file.bytes,
        digest: file.digest,
        proof: proofs[index],
      })),
      ...(downloaded.length ? { downloads: downloaded } : {}),
    });
  }
  async verify(
    intent: PostIntent,
    assertCurrent: () => Awaitable<void>,
    copyMedia?: (file: PostIntent['snapshot']['files'][number], chunk: Uint8Array) => Promise<void>,
  ): Promise<SourceObservation> {
    if (!('resource' in intent) || intent.directory !== null)
      throw Error('RESOURCE_MATERIAL_INTENT_REQUIRED');
    const payload = validateResourceMaterial(intent.snapshot, intent.resource);
    if (
      intent.fingerprint !== intent.snapshot.fingerprint ||
      createHash('sha256').update(payload).digest('hex') !== intent.fingerprint
    )
      throw Error('RESOURCE_MATERIAL_FINGERPRINT_MISMATCH');
    const bounded = await this.budget(intent.snapshot.text, assertCurrent);
    const result = await this.reader.verify(
      resourceEffectiveRow(intent.resource.row, intent.snapshot),
      bounded,
      {
        beforeRead: (index, proof) => {
          if (JSON.stringify(proof) !== JSON.stringify(intent.snapshot.files[index]?.proof))
            throw Error('RESOURCE_MATERIAL_SOURCE_CHANGED');
        },
        copyMedia: copyMedia
          ? async (index, chunk) => {
              const file = intent.snapshot.files[index];
              if (!file) throw Error('RESOURCE_MATERIAL_MEMBER_MISSING');
              await copyMedia(file, chunk);
            }
          : undefined,
      },
    );
    await assertCurrent();
    if (
      !result.verified ||
      result.fingerprint !== intent.fingerprint ||
      result.files.some(
        (file, index) =>
          file.digest !== intent.snapshot.files[index]?.digest ||
          file.bytes !== intent.snapshot.files[index]?.bytes,
      )
    )
      throw Error('RESOURCE_MATERIAL_SOURCE_CHANGED');
    return {
      fingerprint: intent.fingerprint,
      checkedAt: new Date().toISOString(),
      files: structuredClone(intent.snapshot.files),
    };
  }
}
