import path from 'node:path';
import { lstat, realpath, readdir, open, unlink, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import type { MaterialCacheCleaner } from '../application/material-cache-cleanup.js';
import type { MaterialCacheCleanupRepository } from '../domain/material-cache-cleanup.js';
import {
  CacheCleanupClaim,
  type CleanupClaim,
  type CleanupScope,
  type CleanupFile,
} from '../shared/material-cache-cleanup.js';
import { proofOf } from './material-file-utils.js';
import { uploadedFileContent } from '../shared/material-upload.js';

const key = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
const identity = (stat: BigIntStats) => ({ dev: String(stat.dev), ino: String(stat.ino) });
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
// Cooperative private-cache validation. This is not an OS sandbox against another privileged process.
export class FilesystemMaterialCacheCleaner implements MaterialCacheCleaner {
  constructor(
    private readonly ledger: MaterialCacheCleanupRepository,
    private readonly cacheRoot: string,
    private readonly milliseconds = 30_000,
  ) {}
  async clean(input: CleanupClaim) {
    const claim = CacheCleanupClaim.parse(input),
      stageId = claim.plan.owner.stageId;
    const root = path.resolve(this.cacheRoot),
      folder = path.join(root, stageId);
    if (
      !path.isAbsolute(this.cacheRoot) ||
      key(root) !== key(claim.plan.owner.cacheRoot) ||
      path.dirname(folder) !== root
    )
      throw Error('CACHE_CLEANUP_PATH_SCOPE');
    const started = performance.now();
    const check = async () => {
      await this.ledger.assertCurrent(claim);
      if (performance.now() - started > this.milliseconds) throw Error('CACHE_CLEANUP_BUDGET');
    };
    const directory = async (file: string) => {
      await check();
      const stat = await lstat(file, { bigint: true });
      await check();
      if (!stat.isDirectory() || stat.isSymbolicLink() || key(await realpath(file)) !== key(file))
        throw Error('CACHE_CLEANUP_DIRECTORY_CHANGED');
      await check();
      return identity(stat);
    };
    const rootIdentity = await directory(root);
    let folderIdentity: CleanupScope['folder'];
    try {
      folderIdentity = await directory(folder);
    } catch (error) {
      if (!missing(error)) throw error;
      const saved = await this.ledger.get(stageId);
      if (
        !saved.scope ||
        !saved.directoryRemovalStarted ||
        JSON.stringify(saved.scope.root) !== JSON.stringify(rootIdentity)
      )
        throw Error('CACHE_CLEANUP_DIRECTORY_MISSING_WITHOUT_INTENT');
      await check();
      await this.ledger.complete(claim, {
        stageId,
        scope: saved.scope,
        folderAbsent: true,
        checkedAt: new Date().toISOString(),
      });
      return;
    }
    const scope = { root: rootIdentity, folder: folderIdentity };
    await this.ledger.bindScope(claim, scope);
    const assertScope = async () => {
      const current = { root: await directory(root), folder: await directory(folder) };
      if (JSON.stringify(current) !== JSON.stringify(scope))
        throw Error('CACHE_CLEANUP_SCOPE_CHANGED');
      await check();
    };
    const ready = JSON.stringify(claim.plan.manifest);
    const expected = [
      ...claim.plan.manifest.files.map((file) => ({
        name: file.name,
        bytes: uploadedFileContent(file).bytes,
        digest: uploadedFileContent(file).digest,
        proof: file.proof,
      })),
      {
        name: 'ready.json',
        bytes: Buffer.byteLength(ready),
        digest: createHash('sha256').update(ready).digest('hex'),
        proof: null,
      },
    ];
    const known = new Set(expected.map((file) => file.name));
    const verifyMembers = async () => {
      await assertScope();
      const names = await readdir(folder);
      await check();
      if (names.some((name) => !known.has(name))) throw Error('CACHE_CLEANUP_UNEXPECTED_MEMBER');
      return names;
    };
    const names = await verifyMembers();
    const verified = new Map<string, CleanupFile>();
    for (const file of expected) {
      await check();
      const recorded = (await this.ledger.get(stageId)).files.find(
        (row) => row.file.name === file.name,
      );
      if (!names.includes(file.name)) {
        if (!recorded) throw Error('CACHE_CLEANUP_FILE_MISSING_WITHOUT_INTENT');
        continue;
      }
      if (recorded?.state === 'DELETED') throw Error('CACHE_CLEANUP_DELETED_FILE_REAPPEARED');
      const target = path.join(folder, file.name);
      await assertScope();
      const before = await lstat(target, { bigint: true });
      await check();
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        key(await realpath(target)) !== key(target) ||
        before.size !== BigInt(file.bytes)
      )
        throw Error('CACHE_CLEANUP_FILE_CHANGED');
      await check();
      const proof = proofOf(before),
        required = recorded?.file.proof ?? file.proof;
      if (required && JSON.stringify(proof) !== JSON.stringify(required))
        throw Error('CACHE_CLEANUP_FILE_CHANGED');
      const handle = await open(target, 'r');
      try {
        await check();
        const hash = createHash('sha256'),
          buffer = Buffer.alloc(64 * 1024);
        let bytes = 0;
        while (true) {
          await check();
          const chunk = await handle.read(buffer, 0, buffer.length, null);
          await check();
          if (!chunk.bytesRead) break;
          bytes += chunk.bytesRead;
          if (bytes > file.bytes) throw Error('CACHE_CLEANUP_FILE_CHANGED');
          hash.update(buffer.subarray(0, chunk.bytesRead));
        }
        if (
          bytes !== file.bytes ||
          hash.digest('hex') !== file.digest ||
          JSON.stringify(proofOf(await handle.stat({ bigint: true }))) !== JSON.stringify(proof) ||
          JSON.stringify(proofOf(await lstat(target, { bigint: true }))) !== JSON.stringify(proof)
        )
          throw Error('CACHE_CLEANUP_CONTENT_CHANGED');
        await check();
      } finally {
        await handle.close();
      }
      verified.set(file.name, { name: file.name, bytes: file.bytes, digest: file.digest, proof });
    }
    // All remaining members are checked before the first deletion; every unlink has a durable intent.
    for (const file of expected) {
      await verifyMembers();
      await check();
      const target = path.join(folder, file.name),
        recorded = (await this.ledger.get(stageId)).files.find(
          (row) => row.file.name === file.name,
        );
      const current = verified.get(file.name);
      if (current) {
        await this.ledger.beginFile(claim, current);
        const latest = await lstat(target, { bigint: true });
        await check();
        if (
          !latest.isFile() ||
          latest.isSymbolicLink() ||
          JSON.stringify(proofOf(latest)) !== JSON.stringify(current.proof) ||
          key(await realpath(target)) !== key(target)
        )
          throw Error('CACHE_CLEANUP_FILE_CHANGED');
        await check();
        await assertScope();
        await check();
        await unlink(target);
        await check();
      } else if (!recorded) throw Error('CACHE_CLEANUP_DELETE_INTENT_REQUIRED');
      await assertScope();
      try {
        await lstat(target);
        throw Error('CACHE_CLEANUP_FILE_STILL_PRESENT');
      } catch (error) {
        if (!missing(error)) throw error;
      }
      await check();
      await this.ledger.deletedFile(claim, file.name);
    }
    const remaining = await verifyMembers();
    if (remaining.length) throw Error('CACHE_CLEANUP_FOLDER_NOT_EMPTY');
    await this.ledger.beginDirectoryRemoval(claim);
    await assertScope();
    await check();
    await rmdir(folder);
    await check();
    const afterRoot = await directory(root);
    if (JSON.stringify(afterRoot) !== JSON.stringify(scope.root))
      throw Error('CACHE_CLEANUP_SCOPE_CHANGED');
    try {
      await lstat(folder);
      throw Error('CACHE_CLEANUP_DIRECTORY_STILL_PRESENT');
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await check();
    await this.ledger.complete(claim, {
      stageId,
      scope,
      folderAbsent: true,
      checkedAt: new Date().toISOString(),
    });
  }
}
