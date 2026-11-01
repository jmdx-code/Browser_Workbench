import type { DatabaseSync, StatementSync } from 'node:sqlite';

const MAX_CACHED_STATEMENTS_PER_DB = 256;
const statementCaches = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

export function prepareCached(db: DatabaseSync, sql: string): StatementSync {
  let cache = statementCaches.get(db);
  if (!cache) {
    cache = new Map<string, StatementSync>();
    statementCaches.set(db, cache);
  }
  const existing = cache.get(sql);
  if (existing) {
    cache.delete(sql);
    cache.set(sql, existing);
    return existing;
  }
  const stmt = db.prepare(sql);
  cache.set(sql, stmt);
  if (cache.size > MAX_CACHED_STATEMENTS_PER_DB) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return stmt;
}
