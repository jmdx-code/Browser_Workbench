import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { ProductError } from '../../domain/workspace.js';
import { ProfileTaskResult } from '../../shared/task-contracts.js';
export const s = (v: unknown, def = ''): string => (v == null ? def : String(v));
export const sn = (v: unknown): string | null => (v == null ? null : String(v));
export const n = (v: unknown, def = 0): number => (v == null ? def : Number(v));
export const nn = (v: unknown): number | null => (v == null ? null : Number(v));
export const b = (v: unknown): boolean => Number(v ?? 0) === 1;
export const formatLocalYmd = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export function localDayStartMs(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
export const sqliteTableExists = (db: DatabaseSync, table: string): boolean =>
  Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").get(table),
  );
export const tableColumns = (db: DatabaseSync, table: string): Set<string> =>
  new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => String(c.name)),
  );
export const countSql = (db: DatabaseSync, sql: string, ...params: SQLInputValue[]): number =>
  Number((db.prepare(sql).get(...params) as { n?: number } | undefined)?.n ?? 0);
export const getRow = (db: DatabaseSync, sql: string, ...params: SQLInputValue[]) =>
  db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
export const allRows = (db: DatabaseSync, sql: string, ...params: SQLInputValue[]) =>
  db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
export function camel(
  row: Record<string, unknown>,
  boolCsv = '',
  jsonCsv = '',
  omitNullCsv = '',
): Record<string, unknown> {
  const bSet = boolCsv ? new Set(boolCsv.split(',')) : null,
    jSet = jsonCsv ? new Set(jsonCsv.split(',')) : null,
    oSet = omitNullCsv ? new Set(omitNullCsv.split(',')) : null,
    out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!v && v !== 0 && v !== false && oSet?.has(k)) continue;
    const key = k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    out[key] = bSet?.has(k)
      ? Number(v ?? 0) === 1
      : jSet?.has(k) && typeof v === 'string'
        ? (JSON.parse(v) as unknown)
        : v;
  }
  return out;
}
const sqlVal = (v: unknown): SQLInputValue =>
  v === undefined || v === null
    ? null
    : typeof v === 'boolean'
      ? v
        ? 1
        : 0
      : typeof v === 'string' ||
          typeof v === 'number' ||
          typeof v === 'bigint' ||
          v instanceof Uint8Array
        ? v
        : JSON.stringify(v);
const colVals = (
  cols: readonly string[],
  obj: object,
  extra?: Record<string, SQLInputValue>,
): SQLInputValue[] => {
  const rec = obj as Record<string, unknown>;
  return cols.map((c) =>
    extra && Object.prototype.hasOwnProperty.call(extra, c)
      ? (extra[c] ?? null)
      : sqlVal(rec[c.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())] ?? rec[c]),
  );
};
export const pickVals = (
  colsCsv: string,
  obj: object,
  extra?: Record<string, SQLInputValue>,
): SQLInputValue[] => colVals(colsCsv.split(','), obj, extra);
export const run = (db: DatabaseSync, sql: string, ...vals: SQLInputValue[]) =>
  db.prepare(sql).run(...vals);
export const rowBinding = (r: Record<string, unknown>) => ({
  operationId: s(r.operation_id),
  profileId: s(r.profile_id),
  accountId: s(r.account_id),
  connectionEpoch: s(r.connection_epoch),
  leaseId: s(r.lease_id),
  generation: n(r.generation),
  jobId: s(r.job_id),
  stepId: s(r.step_id),
  actionDigest: s(r.action_digest),
});
export function upsert(
  db: DatabaseSync,
  table: string,
  conflictTarget: string,
  colsCsv: string,
  updateCsv: string,
  ...vals: SQLInputValue[]
): void {
  const cols = colsCsv.split(','),
    skip = new Set(conflictTarget.split(','));
  const updCols =
    updateCsv === '*' ? cols.filter((c) => !skip.has(c)) : updateCsv ? updateCsv.split(',') : [];
  const conflict = updCols.length
    ? `DO UPDATE SET ${updCols.map((c) => `${c}=excluded.${c}`).join(',')}`
    : 'DO NOTHING';
  db.prepare(
    `INSERT INTO ${table}(${colsCsv}) VALUES(${cols.map(() => '?').join(',')}) ON CONFLICT(${conflictTarget}) ${conflict}`,
  ).run(...vals);
}
export const upsertFrom = (
  db: DatabaseSync,
  table: string,
  conflictTarget: string,
  colsCsv: string,
  updateCsv: string,
  obj: object,
  extra?: Record<string, SQLInputValue>,
): void =>
  upsert(db, table, conflictTarget, colsCsv, updateCsv, ...colVals(colsCsv.split(','), obj, extra));
export function insertFrom(
  db: DatabaseSync,
  table: string,
  colsCsv: string,
  obj: object,
  extra?: Record<string, SQLInputValue>,
  prefix = 'INSERT INTO',
): void {
  const cols = colsCsv.split(',');
  db.prepare(`${prefix} ${table}(${colsCsv}) VALUES(${cols.map(() => '?').join(',')})`).run(
    ...colVals(cols, obj, extra),
  );
}
export function ensureColumns(
  db: DatabaseSync,
  table: string,
  specs: ReadonlyArray<readonly [col: string, def: string]>,
): void {
  const cols = tableColumns(db, table);
  if (cols.size)
    for (const [col, def] of specs)
      if (!cols.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
export const ensureProfileTaskResultsSchema = (db: DatabaseSync): void => {
  const ddl = `CREATE TABLE IF NOT EXISTS profile_task_results(profile_id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK(source IN ('task','group-inviter','group-bumper','page-bumper','group-poster')), run_id TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('COMPLETED','FAILED','STOPPED')), reason TEXT NOT NULL, finished_at INTEGER NOT NULL, failed_steps INTEGER NOT NULL DEFAULT 0, skipped_steps INTEGER NOT NULL DEFAULT 0);`;
  db.exec(ddl);
};
export const ensureRecordAvatarSchema = (db: DatabaseSync): void => {
  const ddl = `CREATE TABLE IF NOT EXISTS record_avatar_cache(kind TEXT NOT NULL, entity_id TEXT NOT NULL, image TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(kind, entity_id));`;
  db.exec(ddl);
};
export const likePattern = (q: string): string =>
  `%${q
    .trim()
    .toLowerCase()
    .replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
export const nextSortOrder = (
  db: DatabaseSync,
  table: string,
  where?: string,
  ...params: SQLInputValue[]
): number =>
  countSql(
    db,
    `SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`,
    ...params,
  );
export function assertCompleteIdOrder(
  ids: readonly string[],
  known: ReadonlySet<string>,
  code: string,
  msg: string,
): void {
  if (
    ids.length !== known.size ||
    new Set(ids).size !== known.size ||
    ids.some((id) => !known.has(id))
  )
    throw new ProductError(code, msg);
}
export const deleteByJsonIds = (
  db: DatabaseSync,
  table: string,
  idCol: string,
  ids: readonly string[],
): number => {
  if (!ids.length) return 0;
  const sql = `DELETE FROM ${table} WHERE ${idCol} IN (SELECT value FROM json_each(?))`;
  return Number(db.prepare(sql).run(JSON.stringify(ids)).changes ?? 0);
};
export const nonEmptyTrimmed = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;
export function parseWithFallback<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
export const parseJsonObject = (raw: unknown): Record<string, unknown> =>
  typeof raw !== 'string' || !raw.trim()
    ? {}
    : parseWithFallback(() => {
        const p: unknown = JSON.parse(raw);
        return typeof p === 'object' && p !== null && !Array.isArray(p)
          ? (p as Record<string, unknown>)
          : {};
      }, {});
export const parseJsonStringArray = (raw: unknown): string[] =>
  typeof raw !== 'string' || !raw.trim()
    ? []
    : parseWithFallback(() => {
        const p: unknown = JSON.parse(raw);
        return Array.isArray(p) ? p.map(String) : [];
      }, []);
export function readSingletonJson<T>(
  db: DatabaseSync,
  table: string,
  col: string,
  parse: (rawObj: Record<string, unknown>) => T,
  fallback: () => T,
): T {
  const row = getRow(db, `SELECT ${col} FROM ${table} WHERE id=1`);
  return parseWithFallback(() => parse(parseJsonObject(row?.[col])), fallback());
}
export const clampLimit = (limit: number, min = 1, max = 500): number =>
  Math.max(min, Math.min(max, limit));
export const cursorPaginationParams = (
  before: number,
  beforeId = '\uffff',
): readonly [number, number, string] => [before, before, beforeId];
export function upsertProfileTaskResult(
  db: DatabaseSync,
  input: unknown,
  requireTable = false,
): void {
  const r = ProfileTaskResult.parse(input);
  if (requireTable && !sqliteTableExists(db, 'profile_task_results')) return;
  const cols = 'profile_id,source,run_id,name,state,reason,finished_at,failed_steps,skipped_steps';
  upsertFrom(db, 'profile_task_results', 'profile_id', cols, '*', r);
}
