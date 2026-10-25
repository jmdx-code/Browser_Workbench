import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, access } from 'node:fs/promises';
import path from 'node:path';
const [sourceArg, targetArg] = process.argv.slice(2);
if (!sourceArg || !targetArg)
  throw Error('Usage: import-development-workspace SOURCE_DIR TARGET_DIR');
const source = path.resolve(sourceArg),
  target = path.resolve(targetArg);
if (source.toLowerCase() === target.toLowerCase()) throw Error('SAME_IMPORT_DIRECTORY');
const files = ['journal.sqlite', 'workspace.sqlite'];
for (const file of files) {
  await access(path.join(source, file));
  let exists = true;
  try {
    await access(path.join(target, file));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    exists = false;
  }
  if (exists) throw Error('TARGET_EXISTS; refusing to overwrite ' + file);
}
await mkdir(target, { recursive: true });
for (const file of files) {
  const db = new DatabaseSync(path.join(source, file), { readOnly: true });
  try {
    await backup(db, path.join(target, file));
  } finally {
    db.close();
  }
}
console.log('Workspace copied consistently to canonical product directory; source unchanged.');
