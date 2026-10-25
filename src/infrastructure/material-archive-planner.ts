import type { Awaitable } from '../domain/persistence.js';
import { lstat, realpath, readdir } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import type { MaterialArchivePlanner } from '../application/material-archive-preparation.js';
import { ArchiveRequest, type PendingArchive } from '../shared/material-post.js';
import { MaterialArchivePlan } from '../shared/material-archive.js';
import { archiveLayout } from './material-archive-layout.js';
import { FilesystemMaterialSourceVerifier } from './material-source-verifier.js';
import { FilesystemReferenceArchivePlanner } from './material-reference-archive.js';

const identity = (stat: BigIntStats) => ({ dev: String(stat.dev), ino: String(stat.ino) });
const key = (file: string) => (process.platform === 'win32' ? file.toLowerCase() : file);
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
export class FilesystemMaterialArchivePlanner implements MaterialArchivePlanner {
  constructor(private readonly source = new FilesystemMaterialSourceVerifier()) {}
  async inspect(input: PendingArchive, assertCurrent: () => Awaitable<void>) {
    const request = ArchiveRequest.parse(input);
    if (request.archiveDirectory === null)
      return new FilesystemReferenceArchivePlanner(this.source).inspect(request, assertCurrent);
    const layout = archiveLayout(request);
    const directory = async (file: string) => {
      await assertCurrent();
      const stat = await lstat(file, { bigint: true });
      await assertCurrent();
      if (!stat.isDirectory() || stat.isSymbolicLink() || key(await realpath(file)) !== key(file))
        throw Error('ARCHIVE_DIRECTORY_CHANGED');
      await assertCurrent();
      return identity(stat);
    };
    const root = await directory(layout.root),
      folder = await directory(layout.folder);
    let archiveRoot: ReturnType<typeof identity> | null;
    try {
      archiveRoot = await directory(request.archiveDirectory);
    } catch (error) {
      if (!missing(error)) throw error;
      archiveRoot = null;
    }
    try {
      await lstat(layout.destination);
      throw Error('ARCHIVE_DESTINATION_OCCUPIED');
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await assertCurrent();
    if (layout.folderPackage) {
      const members = (await readdir(layout.folder)).sort(),
        expected = layout.files.map((file) => path.basename(file.sourcePath)).sort();
      await assertCurrent();
      if (JSON.stringify(members) !== JSON.stringify(expected))
        throw Error('ARCHIVE_PACKAGE_MEMBERS_CHANGED');
    }
    await this.source.verify(request.intent, assertCurrent);
    if (
      JSON.stringify(root) !== JSON.stringify(await directory(layout.root)) ||
      JSON.stringify(folder) !== JSON.stringify(await directory(layout.folder))
    )
      throw Error('ARCHIVE_DIRECTORY_REPLACED');
    let finalArchive: ReturnType<typeof identity> | null;
    try {
      finalArchive = await directory(request.archiveDirectory);
    } catch (error) {
      if (!missing(error)) throw error;
      finalArchive = null;
    }
    if (JSON.stringify(finalArchive) !== JSON.stringify(archiveRoot))
      throw Error('ARCHIVE_ROOT_REPLACED');
    try {
      await lstat(layout.destination);
      throw Error('ARCHIVE_DESTINATION_OCCUPIED');
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await assertCurrent();
    return MaterialArchivePlan.parse({
      version: 1,
      request,
      sourceRoot: root,
      sourceFolder: folder,
      folderPackage: layout.folderPackage,
      archiveRoot,
      destination: layout.destination,
      files: layout.files,
      checkedAt: new Date().toISOString(),
    });
  }
}
