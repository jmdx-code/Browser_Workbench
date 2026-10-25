import type { Awaitable } from '../domain/persistence.js';
import path from 'node:path';
import { lstat, realpath, opendir, open, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { BigIntStats } from 'node:fs';
import type {
  MaterialSourceVerifier,
  SourceObservation,
  MaterialSnapshotVerifier,
} from '../application/material-source-check.js';
import { MaterialPostIntent, MaterialSnapshot, type PostIntent } from '../shared/material-index.js';
import type { MaterialPackageSnapshot } from '../shared/materials.js';
import { materialFingerprintPayload, normalizeMaterialText } from '../domain/materials.js';
import { validateSnapshot } from './material-snapshot-validation.js';
import { materialScanBudget } from './material-scanner.js';
import { FilesystemResourceMaterialVerifier } from './resource-material-verifier.js';
import {
  contained,
  proofOf,
  sameStat,
  roleOf,
  headerMatches,
  temporaryMaterialFile,
} from './material-file-utils.js';

export interface SourceVerificationPolicy {
  entries: number;
  totalBytes: number;
  textBytes: number;
  milliseconds: number;
}
const policyDefaults: SourceVerificationPolicy = materialScanBudget;
const pathKey = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
const stem = (name: string) => path.parse(name).name.normalize('NFC').toLocaleLowerCase('en-US');
const sameProof = (actual: BigIntStats, expected: PostIntent['snapshot']['files'][number]) =>
  JSON.stringify(proofOf(actual)) === JSON.stringify(expected.proof);

export class FilesystemMaterialSourceVerifier implements MaterialSourceVerifier {
  constructor(private readonly policy: SourceVerificationPolicy = policyDefaults) {}
  async verify(
    input: PostIntent,
    assertCurrent: () => Awaitable<void>,
  ): Promise<SourceObservation> {
    return this.inspectOriginal(input, assertCurrent);
  }
  async copyVerified(
    input: PostIntent,
    assertCurrent: () => Awaitable<void>,
    copyMedia: (file: PostIntent['snapshot']['files'][number], chunk: Uint8Array) => Promise<void>,
  ): Promise<SourceObservation> {
    return this.inspectOriginal(input, assertCurrent, copyMedia);
  }
  private async inspectOriginal(
    input: PostIntent,
    assertCurrent: () => Awaitable<void>,
    copyMedia?: (file: PostIntent['snapshot']['files'][number], chunk: Uint8Array) => Promise<void>,
  ): Promise<SourceObservation> {
    const intent = MaterialPostIntent.parse(input);
    if (intent.fingerprint !== intent.snapshot.fingerprint)
      throw Error('MATERIAL_SOURCE_INTENT_INVALID');
    if ('resource' in intent)
      return new FilesystemResourceMaterialVerifier(undefined, this.policy).verify(
        intent,
        assertCurrent,
        copyMedia,
      );
    return new FilesystemMaterialSnapshotVerifier(this.policy).verifySnapshot(
      { directory: intent.directory, snapshot: intent.snapshot },
      assertCurrent,
      copyMedia,
    );
  }
}

// Shared read-only inspection for explicit content preparation. Original PostIntent callers
// still parse their full immutable intent above and retain their application input fences.
export class FilesystemMaterialSnapshotVerifier implements MaterialSnapshotVerifier {
  constructor(private readonly policy: SourceVerificationPolicy = policyDefaults) {}
  async verifySnapshot(
    input: { directory: string; snapshot: MaterialPackageSnapshot },
    assertCurrent: () => Awaitable<void>,
    copyMedia?: (
      file: MaterialPackageSnapshot['files'][number],
      chunk: Uint8Array,
    ) => Promise<void>,
  ): Promise<SourceObservation> {
    const snapshot = MaterialSnapshot.parse(input.snapshot);
    const intent = { directory: input.directory, snapshot, fingerprint: snapshot.fingerprint };
    validateSnapshot(intent.snapshot);
    if (
      !path.isAbsolute(intent.directory) ||
      path.basename(intent.directory).toLowerCase() === '已发'
    )
      throw Error('MATERIAL_SOURCE_INTENT_INVALID');
    let started = performance.now();
    const check = async () => {
      await assertCurrent();
      if (performance.now() - started > this.policy.milliseconds)
        throw Error('MATERIAL_SOURCE_BUDGET');
    };
    const io = async <T>(operation: () => Promise<T>): Promise<T> => {
      await check();
      const value = await operation();
      await check();
      started = performance.now();
      return value;
    };
    const root = path.resolve(intent.directory);
    const rootBefore = await io(() => lstat(root, { bigint: true }));
    if (
      !rootBefore.isDirectory() ||
      rootBefore.isSymbolicLink() ||
      pathKey(await io(() => realpath(root))) !== pathKey(root)
    )
      throw Error('MATERIAL_SOURCE_ROOT_CHANGED');
    const folderPackage = intent.snapshot.files.every(
      (file) => path.dirname(file.relativePath) === intent.snapshot.source,
    );
    const folder = folderPackage ? path.join(root, intent.snapshot.source) : root;
    const folderBefore = await io(() => lstat(folder, { bigint: true }));
    if (
      !folderBefore.isDirectory() ||
      folderBefore.isSymbolicLink() ||
      pathKey(await io(() => realpath(folder))) !== pathKey(folder)
    )
      throw Error('MATERIAL_SOURCE_FOLDER_CHANGED');
    let entries = 0;
    const members = async () => {
      const names: string[] = [];
      await check();
      const iterator = await opendir(folder);
      try {
        await check();
        while (true) {
          const entry = await io(() => iterator.read());
          if (!entry) break;
          if (++entries > this.policy.entries) throw Error('MATERIAL_SOURCE_BUDGET');
          if (temporaryMaterialFile(entry.name) || (!folderPackage && entry.name === '已发'))
            continue;
          if (
            folderPackage ||
            (roleOf(entry.name) && stem(entry.name) === stem(intent.snapshot.source))
          )
            names.push(folderPackage ? path.join(intent.snapshot.source, entry.name) : entry.name);
        }
      } finally {
        await iterator.close();
      }
      const expected = intent.snapshot.files.map((file) => file.relativePath).sort();
      if (JSON.stringify(names.sort()) !== JSON.stringify(expected))
        throw Error('MATERIAL_SOURCE_MEMBERS_CHANGED');
    };
    await members();
    let totalBytes = 0;
    let text = '';
    const opened: {
      handle: FileHandle;
      file: string;
      expected: PostIntent['snapshot']['files'][number];
    }[] = [];
    try {
      for (const expected of intent.snapshot.files) {
        const file = path.join(root, expected.relativePath);
        if (!contained(root, file) || roleOf(file) !== expected.role)
          throw Error('MATERIAL_SOURCE_FILE_INVALID');
        const before = await io(() => lstat(file, { bigint: true }));
        if (!before.isFile() || before.isSymbolicLink() || !sameProof(before, expected))
          throw Error('MATERIAL_SOURCE_FILE_CHANGED');
        if (
          expected.bytes > this.policy.totalBytes - totalBytes ||
          (expected.role === 'text' && expected.bytes > this.policy.textBytes)
        )
          throw Error('MATERIAL_SOURCE_BUDGET');
        // Register the handle before invoking the post-open fence, so cancellation cannot leak it.
        await check();
        const handle = await open(file, 'r');
        opened.push({ handle, file, expected });
        await check();
        if (
          !sameProof(await io(() => handle.stat({ bigint: true })), expected) ||
          pathKey(await io(() => realpath(file))) !== pathKey(file)
        )
          throw Error('MATERIAL_SOURCE_FILE_CHANGED');
        const hash = createHash('sha256'),
          chunks: Buffer[] = [],
          buffer = Buffer.alloc(64 * 1024);
        let bytes = 0,
          head = Buffer.alloc(0);
        while (true) {
          const { bytesRead } = await io(() => handle.read(buffer, 0, buffer.length, null));
          if (!bytesRead) break;
          const chunk = buffer.subarray(0, bytesRead);
          if (!bytes) head = Buffer.from(chunk.subarray(0, 16));
          bytes += bytesRead;
          totalBytes += bytesRead;
          if (
            totalBytes > this.policy.totalBytes ||
            bytes > expected.bytes ||
            (expected.role === 'text' && bytes > this.policy.textBytes)
          )
            throw Error('MATERIAL_SOURCE_BUDGET');
          hash.update(chunk);
          if (expected.role === 'text') chunks.push(Buffer.from(chunk));
          else if (copyMedia) await io(() => copyMedia(expected, chunk));
        }
        if (
          bytes !== expected.bytes ||
          hash.digest('hex') !== expected.digest ||
          !headerMatches(file, head)
        )
          throw Error('MATERIAL_SOURCE_CONTENT_CHANGED');
        if (expected.role === 'text')
          text = normalizeMaterialText(
            new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
          );
      }
      await members();
      for (const item of opened) {
        const current = await io(() => lstat(item.file, { bigint: true }));
        if (
          !current.isFile() ||
          current.isSymbolicLink() ||
          !sameProof(current, item.expected) ||
          !sameProof(await io(() => item.handle.stat({ bigint: true })), item.expected) ||
          pathKey(await io(() => realpath(item.file))) !== pathKey(item.file)
        )
          throw Error('MATERIAL_SOURCE_FILE_CHANGED');
      }
      if (
        !sameStat(rootBefore, await io(() => lstat(root, { bigint: true }))) ||
        !sameStat(folderBefore, await io(() => lstat(folder, { bigint: true }))) ||
        pathKey(await io(() => realpath(root))) !== pathKey(root)
      )
        throw Error('MATERIAL_SOURCE_FOLDER_CHANGED');
      const fingerprint = createHash('sha256')
        .update(materialFingerprintPayload(text, intent.snapshot.files))
        .digest('hex');
      if (text !== intent.snapshot.text || fingerprint !== intent.fingerprint)
        throw Error('MATERIAL_SOURCE_CONTENT_CHANGED');
      await check();
      return {
        fingerprint,
        checkedAt: new Date().toISOString(),
        files: structuredClone(intent.snapshot.files),
      };
    } finally {
      const closed = await Promise.allSettled(opened.map((item) => item.handle.close()));
      if (closed.some((result) => result.status === 'rejected'))
        throw Error('MATERIAL_SOURCE_CLOSE_FAILED');
    }
  }
}
