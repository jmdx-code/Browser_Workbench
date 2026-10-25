import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
export const config = JSON.parse(readFileSync(process.env.WORKBENCH_LAB_CONFIG, 'utf8'));
export function safeFile(file) {
  const relative = path.relative(config.scratch, path.resolve(file));
  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    readFileSync(path.join(config.scratch, '.isolated-lab'), 'utf8') !== config.id
  )
    throw Error('LAB_FILE_REJECTED');
  return file;
}
export function open(file, timeout = 5000) {
  const db = new DatabaseSync(safeFile(file));
  if (![100, 5000].includes(timeout)) throw Error('LAB_TIMEOUT_VALUE');
  db.exec(`PRAGMA busy_timeout=${timeout}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`);
  return db;
}
export function prepare(file) {
  const db = open(file);
  db.exec(
    "CREATE TABLE probe(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO probe VALUES(1,'seed')",
  );
  return db;
}
export function action(db, spec) {
  const start = performance.now();
  let value,
    error = null;
  try {
    if (spec.action === 'checkpoint') {
      db.prepare('UPDATE probe SET value=? WHERE id=1').run('new-value');
      value = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } else value = db.prepare('INSERT INTO probe(value) VALUES(?)').run('synthetic');
  } catch (e) {
    error = { code: e.code, errcode: e.errcode, errstr: e.errstr, message: e.message };
  }
  const durationMs = performance.now() - start;
  return {
    durationMs,
    error,
    value,
    count: db.prepare('SELECT count(*) AS n FROM probe').get().n,
    pragmas: {
      busy: db.prepare('PRAGMA busy_timeout').get(),
      journal: db.prepare('PRAGMA journal_mode').get(),
      sync: db.prepare('PRAGMA synchronous').get(),
      page: db.prepare('PRAGMA page_size').get(),
      autocheckpoint: db.prepare('PRAGMA wal_autocheckpoint').get(),
    },
  };
}
