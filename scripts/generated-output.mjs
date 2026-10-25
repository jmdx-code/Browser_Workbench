import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Only compiler-owned output can be removed. Source, releases and user data
// cannot be passed to this helper, including through a directory junction.
export async function clearGeneratedDirectory(name) {
  if (!['dist', 'extension-build'].includes(name)) throw Error('GENERATED_OUTPUT_NOT_ALLOWED');
  const root = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const target = path.join(root, name);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('GENERATED_OUTPUT_LINK_REJECTED');
  const resolved = await realpath(target);
  if (path.relative(root, resolved) !== name) throw Error('GENERATED_OUTPUT_OUTSIDE_PROJECT');
  await rm(resolved, { recursive: true, force: true });
}
