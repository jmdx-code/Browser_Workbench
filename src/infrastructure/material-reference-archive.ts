import type { Awaitable } from '../domain/persistence.js';
import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { ResourceArchiveRequest, type PendingArchive } from '../shared/material-post.js';
import { ReferenceArchivePlan, type ArchivePlan } from '../shared/material-archive.js';
import { validateResourceMaterial, resourceEffectiveRow } from '../domain/resource-materials.js';
import { FilesystemMaterialSourceVerifier } from './material-source-verifier.js';
import { contained } from './material-file-utils.js';

const key = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
const identity = (value: BigIntStats) => ({ dev: String(value.dev), ino: String(value.ino) });
export function referenceArchiveLayout(input: PendingArchive) {
  const request = ResourceArchiveRequest.parse(input);
  validateResourceMaterial(request.intent.snapshot, request.intent.resource);
  const row = resourceEffectiveRow(request.intent.resource.row, request.intent.snapshot);
  if (request.attemptId !== request.intent.attemptId) throw Error('ARCHIVE_REFERENCE_SCOPE');
  const files = request.intent.snapshot.files.map((original, index) => {
    const media = row.media[index];
    if (!media) throw Error('ARCHIVE_REFERENCE_MEMBER_REQUIRED');
    const sourcePath = path.resolve(media.source);
    if (
      process.platform === 'win32' &&
      (!/^[a-z]:\\/i.test(media.source) || media.source.slice(2).includes(':'))
    )
      throw Error('ARCHIVE_REFERENCE_PATH_INVALID');
    if (!path.isAbsolute(media.source) || key(sourcePath) !== key(media.source))
      throw Error('ARCHIVE_REFERENCE_PATH_INVALID');
    const parent = path.dirname(sourcePath);
    const name = path.basename(sourcePath);
    if (
      /[<>:"/\\|?*\u0000-\u001f]/.test(name) ||
      /[. ]$/.test(name) ||
      path.basename(parent).toLowerCase() === '已发'
    )
      throw Error('ARCHIVE_REFERENCE_PATH_INVALID');
    const archive = path.join(parent, '已发');
    const folder = path.join(
      archive,
      request.intent.fingerprint.slice(0, 16) + '-' + request.attemptId,
    );
    const targetPath = path.join(folder, String(index + 1).padStart(3, '0') + '-' + name);
    if (!contained(archive, targetPath) || path.dirname(path.dirname(targetPath)) !== archive)
      throw Error('ARCHIVE_REFERENCE_DESTINATION_SCOPE');
    return {
      original,
      sourcePath,
      targetPath,
      parent,
      archive,
      preserveSource:
        request.intent.allowRepeat || request.intent.resource.row.media[index]?.kind === 'drive',
    };
  });
  return { request, files };
}
export function assertArchivePlanLayout(request: PendingArchive, plan: ArchivePlan) {
  if (plan.version !== 2) throw Error('ARCHIVE_REFERENCE_PLAN_REQUIRED');
  const layout = referenceArchiveLayout(request);
  if (
    JSON.stringify(plan.request) !== JSON.stringify(layout.request) ||
    JSON.stringify(
      plan.files.map(({ original, sourcePath, targetPath, preserveSource }) => ({
        original,
        sourcePath,
        targetPath,
        preserveSource,
      })),
    ) !==
      JSON.stringify(
        layout.files.map(({ original, sourcePath, targetPath, preserveSource }) => ({
          original,
          sourcePath,
          targetPath,
          preserveSource,
        })),
      )
  )
    throw Error('ARCHIVE_PLAN_MISMATCH');
  return layout;
}
export class FilesystemReferenceArchivePlanner {
  constructor(private readonly source = new FilesystemMaterialSourceVerifier()) {}
  async inspect(input: PendingArchive, assertCurrent: () => Awaitable<void>) {
    const layout = referenceArchiveLayout(input);
    const directory = async (file: string) => {
      await assertCurrent();
      const stat = await lstat(file, { bigint: true });
      await assertCurrent();
      if (!stat.isDirectory() || stat.isSymbolicLink() || key(await realpath(file)) !== key(file))
        throw Error('ARCHIVE_DIRECTORY_CHANGED');
      await assertCurrent();
      return identity(stat);
    };
    const optionalDirectory = async (file: string) => {
      try {
        return await directory(file);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      }
    };
    const emptyTarget = async (file: string) => {
      await assertCurrent();
      try {
        await lstat(file);
        throw Error('ARCHIVE_DESTINATION_OCCUPIED');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
      await assertCurrent();
    };
    const files: ReturnType<typeof ReferenceArchivePlan.parse>['files'] = [];
    for (const file of layout.files) {
      files.push({
        original: file.original,
        sourcePath: file.sourcePath,
        targetPath: file.targetPath,
        sourceParent: await directory(file.parent),
        archiveParent: await optionalDirectory(file.archive),
        preserveSource: file.preserveSource,
      });
      await emptyTarget(path.dirname(file.targetPath));
    }
    await this.source.verify(layout.request.intent, assertCurrent);
    for (const [index, file] of layout.files.entries()) {
      const before = files[index];
      if (
        !before ||
        JSON.stringify(before.sourceParent) !== JSON.stringify(await directory(file.parent)) ||
        JSON.stringify(before.archiveParent) !==
          JSON.stringify(await optionalDirectory(file.archive))
      )
        throw Error('ARCHIVE_DIRECTORY_REPLACED');
      await emptyTarget(path.dirname(file.targetPath));
    }
    await assertCurrent();
    return ReferenceArchivePlan.parse({
      version: 2,
      request: layout.request,
      files,
      checkedAt: new Date().toISOString(),
    });
  }
}
