import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, access } from 'node:fs/promises';
import path from 'node:path';
const [sourceArg, targetArg] = process.argv.slice(2);
if (!sourceArg || !targetArg)
  throw Error('Usage: node scripts/import-validation.mjs SOURCE_JOURNAL TARGET_JOURNAL');
const source = path.resolve(sourceArg),
  target = path.resolve(targetArg);
if (source.toLowerCase() === target.toLowerCase()) throw Error('IMPORT_SOURCE_EQUALS_TARGET');
let targetExists = true;
try {
  await access(target);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  targetExists = false;
}
if (targetExists) throw Error('IMPORT_TARGET_EXISTS; refusing to overwrite');
await mkdir(path.dirname(target), { recursive: true });
const db = new DatabaseSync(source, { readOnly: true });
try {
  if (db.prepare('PRAGMA user_version').get()?.user_version !== 2)
    throw Error('VALIDATION_SCHEMA_UNSUPPORTED');
  await backup(db, target);
} finally {
  db.close();
}
console.log('Consistent one-time journal import completed; original database unchanged.');
