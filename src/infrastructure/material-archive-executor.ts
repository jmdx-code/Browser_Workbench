import type { Awaitable } from '../domain/persistence.js';
import path from 'node:path';
import { lstat, realpath, mkdir, open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { BigIntStats } from 'node:fs';
import type { MaterialArchiveExecutionRepository } from '../domain/material-archive-execution.js';
import type { ArchivePlan } from '../shared/material-archive.js';
import type { ArchiveStep, ArchiveProof } from '../shared/material-archive-execution.js';
import { archiveLayout } from './material-archive-layout.js';
import { assertArchivePlanLayout } from './material-reference-archive.js';
import { archiveSourceKey } from './material-archive-source-protection.js';
import { proofOf, sameStat } from './material-file-utils.js';

const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
const identity = (stat: BigIntStats) => ({ dev: String(stat.dev), ino: String(stat.ino) });
type Identity = ReturnType<typeof identity>;

// All copies are flushed and re-hashed before the first source deletion. Cross-volume moves
// use the same sequence; no rename overwrite, recursive deletion, or adoption of unknown files.
export class FilesystemMaterialArchiveExecutor {
  constructor(private readonly journal: MaterialArchiveExecutionRepository) {}
  async execute(attemptId: string, assertAllowed: () => Awaitable<void> = () => {}) {
    await assertAllowed();
    if (await this.journal.completed(attemptId)) return;
    const claim = await this.journal.claim(attemptId),
      started = performance.now();
    const check = async () => {
      await assertAllowed();
      await this.journal.assertCurrent(claim);
      if (performance.now() - started > 300_000) throw Error('ARCHIVE_IO_DEADLINE');
    };
    const io = async <T>(action: () => Promise<T>): Promise<T> => {
      await check();
      const result = await action();
      await check();
      return result;
    };
    const resource = async <T extends { close(): Promise<void> }>(action: () => Promise<T>) => {
      await check();
      const result = await action();
      try {
        await check();
        return result;
      } catch (error) {
        await result.close();
        throw error;
      }
    };
    try {
      this.validatePlan(claim.plan);
      if (claim.plan.files.reduce((n, f) => n + f.original.bytes, 0) > 10 * 1024 ** 3)
        throw Error('ARCHIVE_IO_CAPACITY');
      const directory = async (name: string, expected?: Identity | null) => {
        const stat = await io(() => lstat(name, { bigint: true }));
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          archiveSourceKey(await io(() => realpath(name))) !== archiveSourceKey(name)
        )
          throw Error('ARCHIVE_DIRECTORY_CHANGED');
        const actual = identity(stat);
        if (expected && (actual.dev !== expected.dev || actual.ino !== expected.ino))
          throw Error('ARCHIVE_DIRECTORY_REPLACED');
        return actual;
      };
      const sourceParent = async (file: ArchivePlan['files'][number]) => {
        if (claim.plan.version === 1) {
          const layout = archiveLayout(claim.plan.request);
          await directory(layout.root, claim.plan.sourceRoot);
          await directory(layout.folder, claim.plan.sourceFolder);
        } else {
          const reference = claim.plan.files.find((f) => f.targetPath === file.targetPath);
          if (!reference) throw Error('ARCHIVE_REFERENCE_MEMBER_REQUIRED');
          await directory(path.dirname(file.sourcePath), reference.sourceParent);
        }
      };
      const makeDirectory = async (
        name: string,
        expected: Identity | null,
        sharedRoot: boolean,
      ) => {
        const step: ArchiveStep = { key: 'DIRECTORY:' + name, kind: 'DIRECTORY', path: name };
        const record = await this.journal.step(claim, step);
        if (record.proof) {
          if (record.proof.kind !== 'DIRECTORY') throw Error('ARCHIVE_DIRECTORY_PROOF_SCOPE');
          return directory(name, { dev: record.proof.dev, ino: record.proof.ino });
        }
        let actual: Identity | null = null;
        try {
          actual = await directory(name, expected);
        } catch (error) {
          if (!missing(error)) throw error;
        }
        if (actual && (!sharedRoot || !record.fresh)) throw Error('ARCHIVE_DIRECTORY_UNOWNED');
        if (!actual) {
          if (expected) throw Error('ARCHIVE_DIRECTORY_MISSING');
          await io(() => mkdir(name)); // Nonrecursive, deterministic parent already proved.
          actual = await directory(name);
        }
        await this.journal.prove(claim, step, { kind: 'DIRECTORY', ...actual });
        return actual;
      };
      const targets = new Map<string, Identity>();
      for (const file of claim.plan.files) {
        await sourceParent(file);
        const archive = path.dirname(path.dirname(file.targetPath));
        let expected: Identity | null;
        if (claim.plan.version === 1) expected = claim.plan.archiveRoot;
        else {
          const reference = claim.plan.files.find((f) => f.targetPath === file.targetPath);
          if (!reference) throw Error('ARCHIVE_REFERENCE_MEMBER_REQUIRED');
          expected = reference.archiveParent;
        }
        // An archive root may be shared by different requests, but an attempt folder never is.
        await makeDirectory(archive, expected, true);
        const folder = path.dirname(file.targetPath);
        if (!targets.has(folder)) targets.set(folder, await makeDirectory(folder, null, false));
      }
      const targetParent = async (file: ArchivePlan['files'][number]) => {
        await sourceParent(file);
        const root = path.dirname(path.dirname(file.targetPath));
        const rootProof = (
          await this.journal.step(claim, {
            key: 'DIRECTORY:' + root,
            kind: 'DIRECTORY',
            path: root,
          })
        ).proof;
        if (rootProof?.kind !== 'DIRECTORY') throw Error('ARCHIVE_DIRECTORY_PROOF_REQUIRED');
        await directory(root, rootProof);
        await directory(path.dirname(file.targetPath), targets.get(path.dirname(file.targetPath)));
      };
      const inspect = async (
        name: string,
        digest: string,
        bytes: number,
        expected?: ReturnType<typeof proofOf>,
      ) => {
        const before = await io(() => lstat(name, { bigint: true }));
        if (
          !before.isFile() ||
          before.isSymbolicLink() ||
          Number(before.size) !== bytes ||
          archiveSourceKey(await io(() => realpath(name))) !== archiveSourceKey(name) ||
          (expected && JSON.stringify(proofOf(before)) !== JSON.stringify(expected))
        )
          throw Error('ARCHIVE_FILE_CHANGED');
        const handle = await resource(() => open(name, 'r'));
        try {
          if (!sameStat(before, await io(() => handle.stat({ bigint: true }))))
            throw Error('ARCHIVE_FILE_REPLACED');
          const hash = createHash('sha256'),
            buffer = Buffer.alloc(64 * 1024);
          let read = 0;
          while (read < bytes) {
            const result = await io(() =>
              handle.read(buffer, 0, Math.min(buffer.length, bytes - read), read),
            );
            if (!result.bytesRead) throw Error('ARCHIVE_FILE_TRUNCATED');
            hash.update(buffer.subarray(0, result.bytesRead));
            read += result.bytesRead;
          }
          if (
            hash.digest('hex') !== digest ||
            !sameStat(before, await io(() => handle.stat({ bigint: true }))) ||
            !sameStat(before, await io(() => lstat(name, { bigint: true })))
          )
            throw Error('ARCHIVE_FILE_CHANGED');
          return proofOf(before);
        } finally {
          await handle.close();
        }
      };
      const verifyCopy = async (file: ArchivePlan['files'][number], proof: ArchiveProof | null) => {
        if (proof?.kind !== 'COPY' || proof.digest !== file.original.digest)
          throw Error('ARCHIVE_COPY_PROOF_REQUIRED');
        await targetParent(file);
        await inspect(file.targetPath, proof.digest, file.original.bytes, proof.stat);
      };
      for (const file of claim.plan.files) {
        const step: ArchiveStep = {
          key: 'COPY:' + file.targetPath,
          kind: 'COPY',
          path: file.targetPath,
        };
        const record = await this.journal.step(claim, step);
        if (record.proof) {
          await verifyCopy(file, record.proof);
          continue;
        }
        await targetParent(file);
        await inspect(
          file.sourcePath,
          file.original.digest,
          file.original.bytes,
          file.original.proof,
        );
        // wx rejects both unknown partial outputs and an occupied deterministic target.
        const source = await resource(() => open(file.sourcePath, 'r'));
        try {
          if (
            JSON.stringify(proofOf(await io(() => source.stat({ bigint: true })))) !==
            JSON.stringify(file.original.proof)
          )
            throw Error('ARCHIVE_SOURCE_REPLACED');
          const output = await resource(() => open(file.targetPath, 'wx', 0o600));
          try {
            const buffer = Buffer.alloc(64 * 1024);
            let offset = 0;
            while (offset < file.original.bytes) {
              const chunk = await io(() =>
                source.read(
                  buffer,
                  0,
                  Math.min(buffer.length, file.original.bytes - offset),
                  offset,
                ),
              );
              if (!chunk.bytesRead) throw Error('ARCHIVE_SOURCE_TRUNCATED');
              let written = 0;
              while (written < chunk.bytesRead) {
                const result = await io(() =>
                  output.write(buffer, written, chunk.bytesRead - written, offset + written),
                );
                if (!result.bytesWritten) throw Error('ARCHIVE_COPY_WRITE_FAILED');
                written += result.bytesWritten;
              }
              offset += chunk.bytesRead;
            }
            await io(() => output.sync());
          } finally {
            await output.close();
          }
        } finally {
          await source.close();
        }
        await targetParent(file);
        await inspect(
          file.sourcePath,
          file.original.digest,
          file.original.bytes,
          file.original.proof,
        );
        const stat = await inspect(file.targetPath, file.original.digest, file.original.bytes);
        await this.journal.prove(claim, step, { kind: 'COPY', stat, digest: file.original.digest });
      }
      // Re-check every flushed copy before any destructive action, also on explicit recovery.
      for (const file of claim.plan.files)
        await verifyCopy(
          file,
          (
            await this.journal.step(claim, {
              key: 'COPY:' + file.targetPath,
              kind: 'COPY',
              path: file.targetPath,
            })
          ).proof,
        );
      for (const file of claim.plan.files) {
        const deleteStep: ArchiveStep = {
          key: 'DELETE:' + file.sourcePath,
          kind: 'DELETE',
          path: file.sourcePath,
        };
        // Existing records are read without creating a delete intent until source eligibility is known.
        const keepStep: ArchiveStep = {
          key: 'KEEP:' + file.sourcePath,
          kind: 'KEEP',
          path: file.sourcePath,
        };
        const priorKeep = (await this.journal.step(claim, keepStep)).proof;
        const preserve =
          claim.plan.request.intent.allowRepeat ||
          (claim.plan.version === 2 &&
            claim.plan.files.some((f) => f.sourcePath === file.sourcePath && f.preserveSource));
        const disposition =
          preserve || priorKeep ? 'KEEP' : await this.journal.protectSource(claim, file.sourcePath);
        if (disposition === 'KEEP') {
          await sourceParent(file);
          await inspect(
            file.sourcePath,
            file.original.digest,
            file.original.bytes,
            file.original.proof,
          );
          const record = await this.journal.step(claim, keepStep);
          if (!record.proof)
            await this.journal.prove(claim, keepStep, {
              kind: 'KEEP',
              reason: preserve ? 'REPEAT_OR_CACHE' : 'SHARED_SOURCE',
            });
          continue;
        }
        const record = await this.journal.step(claim, deleteStep);
        await verifyCopy(
          file,
          (
            await this.journal.step(claim, {
              key: 'COPY:' + file.targetPath,
              kind: 'COPY',
              path: file.targetPath,
            })
          ).proof,
        );
        if (record.proof) {
          if (record.proof.kind !== 'DELETE') throw Error('ARCHIVE_DELETE_PROOF_SCOPE');
          try {
            await io(() => lstat(file.sourcePath));
            throw Error('ARCHIVE_DELETED_SOURCE_REAPPEARED');
          } catch (error) {
            if (!missing(error)) throw error;
          }
          continue;
        }
        await sourceParent(file);
        // Missing after an unconfirmed unlink is REVIEW, never silently treated as our success.
        await inspect(
          file.sourcePath,
          file.original.digest,
          file.original.bytes,
          file.original.proof,
        );
        await check();
        await io(() => unlink(file.sourcePath));
        try {
          await io(() => lstat(file.sourcePath));
          throw Error('ARCHIVE_DELETE_NOT_CONFIRMED');
        } catch (error) {
          if (!missing(error)) throw error;
        }
        await this.journal.prove(claim, deleteStep, { kind: 'DELETE', absent: true });
      }
      await check();
      await this.journal.complete(claim);
    } catch (error) {
      await this.journal.review(
        claim,
        error instanceof Error ? error.message : 'ARCHIVE_IO_FAILED',
      );
      throw error;
    }
  }
  private validatePlan(plan: ArchivePlan) {
    if (plan.version === 2) {
      assertArchivePlanLayout(plan.request, plan);
      return;
    }
    const layout = archiveLayout(plan.request);
    if (
      plan.destination !== layout.destination ||
      plan.folderPackage !== layout.folderPackage ||
      JSON.stringify(plan.files) !== JSON.stringify(layout.files)
    )
      throw Error('ARCHIVE_PLAN_MISMATCH');
  }
}
