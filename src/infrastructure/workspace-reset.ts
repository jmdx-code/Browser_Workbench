import { lstat, readFile, writeFile, realpath, rename, mkdir, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const Request = z
  .object({ version: z.literal(1), id: z.uuid(), requestedAt: z.number().int().nonnegative() })
  .strict();
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
const marker = (directory: string) => path.resolve(directory) + '.reset-request.json';
export async function prepareWorkspaceReset(directory: string) {
  const root = await realpath(directory);
  if (path.resolve(root).toLowerCase() !== path.resolve(directory).toLowerCase())
    throw Error('RESET_DIRECTORY_CHANGED');
  if ((await lstat(directory)).isSymbolicLink()) throw Error('RESET_DIRECTORY_CHANGED');
  const request = Request.parse({ version: 1, id: randomUUID(), requestedAt: Date.now() });
  await writeFile(marker(root), JSON.stringify(request), { flag: 'wx' });
  return request;
}

// Startup only, before opening either DB or any writer. The sibling marker survives crashes
// between renaming the old directory, removing its contents and recreating the empty directory.
export async function applyPendingWorkspaceReset(directory: string): Promise<boolean> {
  const root = path.resolve(directory),
    file = marker(root);
  let request;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
      throw Error('RESET_REQUEST_REJECTED');
    request = Request.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
  if (root === path.parse(root).root || !path.basename(root)) throw Error('RESET_ROOT_REJECTED');
  const parent = await realpath(path.dirname(root));
  if (parent.toLowerCase() !== path.dirname(root).toLowerCase())
    throw Error('RESET_PARENT_CHANGED');
  const trash = path.resolve(parent, '.workbench-reset-' + request.id);
  if (path.dirname(trash) !== parent || !path.basename(trash).startsWith('.workbench-reset-'))
    throw Error('RESET_TARGET_REJECTED');
  let staged = false;
  try {
    const stat = await lstat(trash);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('RESET_TARGET_CHANGED');
    staged = true;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if (!staged) {
    try {
      const stat = await lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('RESET_DIRECTORY_CHANGED');
      if ((await realpath(root)).toLowerCase() !== root.toLowerCase())
        throw Error('RESET_DIRECTORY_CHANGED');
      await rename(root, trash);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  // rm unlinks child symlinks rather than following them. Never accept a linked root/stage.
  await rm(trash, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await unlink(file);
  return true;
}
