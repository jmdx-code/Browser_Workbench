import type { Awaitable } from '../domain/persistence.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, realpath, open } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { ResourceSourceReader, ResourceSourceResult } from '../domain/resource-source.js';
import { hasResource, validateResourceRows } from '../domain/resource-table.js';
import { materialFingerprintPayload } from '../domain/materials.js';
import type { ResourceRowValue } from '../shared/resource-table.js';
import type {
  ResourceSourceFileValue,
  ResourceSourceIssueValue,
} from '../shared/resource-source.js';
import { headerMatches, roleOf, sameStat, proofOf } from './material-file-utils.js';
import {
  materialMediaPreviewLimits,
  type MaterialPackageSnapshot,
  type MaterialMediaType,
} from '../shared/materials.js';

export interface ResourceFileHooks {
  beforeRead?(
    index: number,
    proof: MaterialPackageSnapshot['files'][number]['proof'],
  ): Awaitable<void>;
  copyMedia?(index: number, chunk: Uint8Array): Promise<void>;
  verifiedFile?(
    index: number,
    proof: MaterialPackageSnapshot['files'][number]['proof'],
  ): Awaitable<void>;
}

const key = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
class SourceFailure extends Error {
  constructor(readonly issue: ResourceSourceIssueValue) {
    super(issue);
  }
}
// SHA-256 inspection streams bounded chunks, preserving media order separately from v1 dedupe.
export class FilesystemResourceSourceReader implements ResourceSourceReader {
  async previewMedia(
    row: ResourceRowValue,
    fileIndex: number,
    assertCurrent: () => Awaitable<void>,
  ) {
    validateResourceRows([row]);
    const media = row.media[fileIndex];
    if (!media || media.kind !== 'local' || media.mediaType === 'unknown')
      throw Error('RESOURCE_PREVIEW_LOCAL_MEDIA_REQUIRED');
    const chunks: Buffer[] = [];
    let length = 0;
    const result = await this.verify({ ...row, media: [media] }, assertCurrent, {
      beforeRead: (_index, proof) => {
        if (
          BigInt(proof.size) >
          BigInt(materialMediaPreviewLimits[media.mediaType as 'image' | 'video'])
        )
          throw Error('RESOURCE_PREVIEW_MEDIA_LIMIT');
      },
      copyMedia: async (_index, chunk) => {
        await assertCurrent();
        length += chunk.byteLength;
        if (length > materialMediaPreviewLimits[media.mediaType as 'image' | 'video'])
          throw Error('RESOURCE_PREVIEW_MEDIA_LIMIT');
        chunks.push(Buffer.from(chunk));
      },
    });
    await assertCurrent();
    if (!result.verified) throw Error('RESOURCE_PREVIEW_' + result.issue);
    const types: Record<string, MaterialMediaType> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
    };
    const contentType = types[path.extname(media.source).toLowerCase()];
    if (!contentType || result.files[0]?.bytes !== length)
      throw Error('RESOURCE_PREVIEW_TYPE_MISMATCH');
    return { bytes: Buffer.concat(chunks, length), contentType };
  }
  async verify(
    row: ResourceRowValue,
    assertCurrent: (bytesRead?: number) => Awaitable<void>,
    hooks?: ResourceFileHooks,
  ): Promise<ResourceSourceResult> {
    validateResourceRows([row]);
    await assertCurrent();
    if (!hasResource(row)) return { verified: false, issue: 'EMPTY' };
    if (row.media.some((media) => media.kind === 'drive'))
      return { verified: false, issue: 'DRIVE_DOWNLOAD_PENDING' };
    let started = performance.now();
    const check = async () => {
      await assertCurrent();
      if (performance.now() - started > 30_000) throw Error('RESOURCE_SOURCE_TIMEOUT');
    };
    const io = async <T>(operation: () => Promise<T>) => {
      await check();
      const value = await operation();
      await check();
      started = performance.now();
      return value;
    };
    const files: ResourceSourceFileValue[] = [];
    try {
      for (const [index, media] of row.media.entries()) {
        const source = path.resolve(media.source);
        // No UNC/device paths, alternate streams, traversal or foreign-OS relative interpretation.
        if (
          !path.isAbsolute(media.source) ||
          key(source) !== key(media.source) ||
          (process.platform === 'win32' &&
            (!/^[a-z]:\\/i.test(source) || source.slice(2).includes(':')))
        )
          throw new SourceFailure('PATH_UNSUPPORTED');
        const role = roleOf(source);
        if ((role !== 'image' && role !== 'video') || role !== media.mediaType)
          throw new SourceFailure('TYPE_MISMATCH');
        const parents: { path: string; stat: BigIntStats }[] = [];
        let parent = path.dirname(source);
        for (;;) {
          const stat = await io(() => lstat(parent, { bigint: true }));
          if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            key(await io(() => realpath(parent))) !== key(parent)
          )
            throw new SourceFailure('PATH_UNSUPPORTED');
          parents.push({ path: parent, stat });
          const next = path.dirname(parent);
          if (next === parent) break;
          parent = next;
        }
        const assertPaths = async () => {
          for (const entry of parents) {
            const current = await io(() => lstat(entry.path, { bigint: true }));
            // Unrelated directory entries may change; only directory identity must stay fixed.
            if (
              !current.isDirectory() ||
              current.isSymbolicLink() ||
              current.dev !== entry.stat.dev ||
              current.ino !== entry.stat.ino ||
              key(await io(() => realpath(entry.path))) !== key(entry.path)
            )
              throw new SourceFailure('FILE_CHANGED');
          }
          if (key(await io(() => realpath(source))) !== key(source))
            throw new SourceFailure('FILE_CHANGED');
        };
        const before = await io(() => lstat(source, { bigint: true }));
        if (!before.isFile() || before.isSymbolicLink())
          throw new SourceFailure('PATH_UNSUPPORTED');
        if (before.size < 1n || before.size > BigInt(10 * 1024 ** 3))
          throw new SourceFailure('FILE_SIZE_LIMIT');
        await assertPaths();
        await hooks?.beforeRead?.(index, proofOf(before));
        await check();
        const handle = await open(source, 'r');
        try {
          await check();
          if (!sameStat(before, await io(() => handle.stat({ bigint: true }))))
            throw new SourceFailure('FILE_CHANGED');
          await assertPaths();
          const hash = createHash('sha256'),
            buffer = Buffer.alloc(64 * 1024);
          let offset = 0;
          const bytes = Number(before.size);
          while (offset < bytes) {
            const result = await io(() =>
              handle.read(buffer, 0, Math.min(buffer.length, bytes - offset), offset),
            );
            if (!result.bytesRead) throw new SourceFailure('FILE_CHANGED');
            await assertCurrent(result.bytesRead);
            if (offset === 0 && !headerMatches(source, buffer.subarray(0, result.bytesRead)))
              throw new SourceFailure('TYPE_MISMATCH');
            hash.update(buffer.subarray(0, result.bytesRead));
            const copyMedia = hooks?.copyMedia;
            if (copyMedia) await io(() => copyMedia(index, buffer.subarray(0, result.bytesRead)));
            offset += result.bytesRead;
          }
          const after = await io(() => lstat(source, { bigint: true }));
          if (
            !after.isFile() ||
            after.isSymbolicLink() ||
            !sameStat(before, after) ||
            !sameStat(before, await io(() => handle.stat({ bigint: true })))
          )
            throw new SourceFailure('FILE_CHANGED');
          await assertPaths();
          await check();
          files.push({ name: media.name, role, bytes, digest: hash.digest('hex') });
          await hooks?.verifiedFile?.(index, proofOf(before));
        } finally {
          await handle.close();
        }
      }
      await check();
      return {
        verified: true,
        files,
        fingerprint: createHash('sha256')
          .update(materialFingerprintPayload(row.text, files))
          .digest('hex'),
      };
    } catch (failure) {
      // Cancellation/revision/deadline failures invalidate the entire request, never just one row.
      await check();
      if (failure instanceof SourceFailure) return { verified: false, issue: failure.issue };
      const code = failure instanceof Error && 'code' in failure ? failure.code : null;
      if (
        ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'ELOOP', 'EINVAL'].includes(String(code))
      )
        return { verified: false, issue: 'FILE_UNAVAILABLE' };
      throw failure;
    }
  }
}
