import path from 'node:path';
import type { PendingArchive } from '../shared/material-post.js';
import { validateSnapshot } from './material-snapshot-validation.js';
import { contained } from './material-file-utils.js';

export function archiveLayout(request: PendingArchive) {
  if (request.archiveDirectory === null) throw Error('ARCHIVE_RESOURCE_TABLE_PLANNER_REQUIRED');
  const intent = request.intent,
    root = path.resolve(intent.directory);
  validateSnapshot(intent.snapshot);
  if (
    !path.isAbsolute(intent.directory) ||
    root !== intent.directory ||
    request.attemptId !== intent.attemptId ||
    request.archiveDirectory !== path.join(root, '已发')
  )
    throw Error('ARCHIVE_PLAN_SOURCE_SCOPE');
  const folderPackage = intent.snapshot.files.every(
    (file) => path.dirname(file.relativePath) === intent.snapshot.source,
  );
  const folder = folderPackage ? path.join(root, intent.snapshot.source) : root;
  if (folderPackage && (!contained(root, folder) || path.dirname(folder) !== root))
    throw Error('ARCHIVE_PLAN_FOLDER_SCOPE');
  const stem =
    path
      .parse(path.basename(intent.snapshot.source))
      .name.normalize('NFC')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 60) || '素材';
  const destination = path.join(
    request.archiveDirectory,
    stem + '-' + intent.fingerprint.slice(0, 16) + '-' + intent.attemptId,
  );
  const names = new Set<string>();
  const files = intent.snapshot.files.map((original) => {
    const name = path.basename(original.relativePath),
      sourcePath = path.join(root, original.relativePath),
      targetPath = path.join(destination, name),
      key = name.normalize('NFC').toLocaleLowerCase('en-US');
    if (
      !contained(root, sourcePath) ||
      path.dirname(sourcePath) !== folder ||
      names.has(key) ||
      name === '.' ||
      name === '..' ||
      /[<>:"/\\|?*\u0000-\u001f]/.test(name) ||
      /[. ]$/.test(name)
    )
      throw Error('ARCHIVE_PLAN_FILE_SCOPE');
    names.add(key);
    return { original, sourcePath, targetPath };
  });
  return { root, folder, folderPackage, destination, files };
}
