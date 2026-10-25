import type { Awaitable } from '../domain/persistence.js';
import path from 'node:path';
import { lstat, realpath, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { BigIntStats } from 'node:fs';
import type { MaterialMediaReader } from '../application/material-preflight.js';
import {
  materialMediaPreviewLimits,
  type MaterialMediaType,
  type MaterialPackageSnapshot,
} from '../shared/materials.js';
import { validateSnapshot } from './material-snapshot-validation.js';
import { contained, headerMatches, proofOf, roleOf, sameStat } from './material-file-utils.js';

const types: Record<string, MaterialMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};
const pathKey = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);

// Read-only display adapter: no PostIntent, upload cache, account or disk writes.
export class FilesystemMaterialMediaReader implements MaterialMediaReader {
  async read(
    directory: string,
    snapshot: MaterialPackageSnapshot,
    fileIndex: number,
    assertCurrent: () => Awaitable<void>,
  ) {
    validateSnapshot(snapshot);
    const expected = snapshot.files[fileIndex];
    if (
      !expected ||
      expected.role === 'text' ||
      !Number.isSafeInteger(expected.bytes) ||
      expected.bytes < 1 ||
      expected.bytes > materialMediaPreviewLimits[expected.role] ||
      !path.isAbsolute(directory) ||
      path.basename(directory).toLowerCase() === '已发'
    )
      throw Error('MATERIAL_MEDIA_INVALID');
    const started = performance.now();
    const check = async () => {
      await assertCurrent();
      if (performance.now() - started > 30_000) throw Error('MATERIAL_MEDIA_TIMEOUT');
    };
    const io = async <T>(operation: () => Promise<T>) => {
      await check();
      const result = await operation();
      await check();
      return result;
    };
    const root = path.resolve(directory),
      file = path.join(root, expected.relativePath),
      folder = path.dirname(file);
    const contentType = types[path.extname(file).toLowerCase()];
    if (!contained(root, file) || roleOf(file) !== expected.role || !contentType)
      throw Error('MATERIAL_MEDIA_INVALID');
    const rootBefore = await io(() => lstat(root, { bigint: true }));
    const folderBefore = await io(() => lstat(folder, { bigint: true }));
    const checkDirectory = async (target: string) => {
      const stat = await io(() => lstat(target, { bigint: true }));
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        pathKey(await io(() => realpath(target))) !== pathKey(target)
      )
        throw Error('MATERIAL_MEDIA_PATH_CHANGED');
      return stat;
    };
    await checkDirectory(root);
    await checkDirectory(folder);
    const sameProof = (stat: BigIntStats) =>
      JSON.stringify(proofOf(stat)) === JSON.stringify(expected.proof);
    const before = await io(() => lstat(file, { bigint: true }));
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      !sameProof(before) ||
      pathKey(await io(() => realpath(file))) !== pathKey(file)
    )
      throw Error('MATERIAL_MEDIA_CHANGED');
    await check();
    const handle = await open(file, 'r');
    try {
      await check();
      if (!sameProof(await io(() => handle.stat({ bigint: true }))))
        throw Error('MATERIAL_MEDIA_CHANGED');
      const bytes = Buffer.alloc(expected.bytes),
        hash = createHash('sha256');
      let offset = 0;
      while (offset < bytes.length) {
        const result = await io(() =>
          handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset),
        );
        if (!result.bytesRead) throw Error('MATERIAL_MEDIA_CHANGED');
        hash.update(bytes.subarray(offset, offset + result.bytesRead));
        offset += result.bytesRead;
      }
      if (hash.digest('hex') !== expected.digest || !headerMatches(file, bytes.subarray(0, 16)))
        throw Error('MATERIAL_MEDIA_CHANGED');
      const after = await io(() => lstat(file, { bigint: true }));
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        !sameProof(after) ||
        !sameProof(await io(() => handle.stat({ bigint: true }))) ||
        pathKey(await io(() => realpath(file))) !== pathKey(file) ||
        !sameStat(rootBefore, await checkDirectory(root)) ||
        !sameStat(folderBefore, await checkDirectory(folder))
      )
        throw Error('MATERIAL_MEDIA_CHANGED');
      await check();
      return { bytes, contentType };
    } finally {
      await handle.close();
    }
  }
}
