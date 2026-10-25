import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MaterialPostIntent, MaterialCatalog, type PostIntent } from '../shared/material-index.js';
import { ResourceMaterialCatalog } from '../shared/resource-materials.js';
import { ResourceRows } from '../shared/resource-table.js';
import { resourceEffectiveRow } from '../domain/resource-materials.js';
import { contained } from './material-file-utils.js';

export const archiveSourceKey = (value: string) => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
export function materialSourcePaths(intent: PostIntent) {
  if ('resource' in intent)
    return resourceEffectiveRow(intent.resource.row, intent.snapshot).media.map((m) => m.source);
  return intent.snapshot.files.map((f) => path.join(intent.directory, f.relativePath));
}
// Call inside the original write transaction: all product source writers share this fence.
export function assertArchiveSourcesAvailable(db: DatabaseSync, paths: string[]) {
  for (const source of new Set(paths.map(archiveSourceKey))) {
    if (
      db
        .prepare(
          "SELECT attempt_id FROM material_archive_source_locks WHERE source_key=? AND state='LOCKED'",
        )
        .get(source)
    )
      throw Error('MATERIAL_SOURCE_ARCHIVING');
  }
}
export function sharedArchiveSource(
  db: DatabaseSync,
  original: PostIntent,
  source: string,
): boolean {
  const key = archiveSourceKey(source),
    matches = (paths: string[]) => paths.some((p) => archiveSourceKey(p) === key);
  // Current tables and nonterminal pinned versions, including versions no longer at the head.
  const tables = db
    .prepare(
      `SELECT v.combination_id,v.body,
    (EXISTS(SELECT 1 FROM combinations c JOIN combination_versions cv ON cv.combination_id=c.id AND cv.version=c.current_version,json_each(cv.body,'$.steps') step
      WHERE c.id=v.combination_id AND json_extract(step.value,'$.type')='post' AND json_extract(step.value,'$.resourceMode')='table' AND json_extract(step.value,'$.allowRepeat')=1)
    OR EXISTS(SELECT 1 FROM task_resource_bindings b JOIN task_plans p ON p.id=b.job_id,json_each(p.snapshot,'$.steps') step
      WHERE b.combination_id=v.combination_id AND b.resource_revision=v.revision AND p.state NOT IN ('COMPLETED','STOPPED')
      AND json_extract(step.value,'$.type')='post' AND json_extract(step.value,'$.resourceMode')='table' AND json_extract(step.value,'$.allowRepeat')=1)) AS repeat_needed
    FROM resource_table_versions v WHERE
    EXISTS(SELECT 1 FROM resource_table_heads h WHERE h.combination_id=v.combination_id AND h.revision=v.revision)
    OR EXISTS(SELECT 1 FROM task_resource_bindings b JOIN task_plans p ON p.id=b.job_id
      WHERE b.combination_id=v.combination_id AND b.resource_revision=v.revision AND p.state NOT IN ('COMPLETED','STOPPED'))`,
    )
    .all();
  for (const table of tables)
    for (const row of ResourceRows.parse(JSON.parse(String(table.body)) as unknown)) {
      if (
        'resource' in original &&
        table.combination_id === original.resource.combinationId &&
        JSON.stringify(row) === JSON.stringify(original.resource.row) &&
        !original.allowRepeat &&
        Number(table.repeat_needed) === 0
      )
        continue;
      if (matches(row.media.filter((m) => m.kind === 'local').map((m) => m.source))) return true;
    }
  // Other held attempts and published requests still needing their own archive copy.
  const held = db
    .prepare(
      `SELECT i.body FROM material_post_intents i JOIN material_reservations r USING(attempt_id)
    LEFT JOIN material_archive_state a USING(attempt_id) WHERE i.attempt_id<>?
    AND (r.state IN ('RESERVED','REVIEW') OR (r.state='PUBLISHED' AND a.state<>'COMPLETED'))`,
    )
    .all(original.attemptId);
  for (const row of held)
    if (
      matches(
        materialSourcePaths(MaterialPostIntent.parse(JSON.parse(String(row.body)) as unknown)),
      )
    )
      return true;
  // A later saved combination or another pinned plan may permit reusing the original bytes.
  const repeats = db
    .prepare(
      `SELECT json_extract(step.value,'$.resourceDirectory') AS root FROM combinations c JOIN combination_versions cv ON cv.combination_id=c.id AND cv.version=c.current_version,json_each(cv.body,'$.steps') step
    WHERE json_extract(step.value,'$.type')='post' AND coalesce(json_extract(step.value,'$.resourceMode'),'directory')='directory' AND json_extract(step.value,'$.allowRepeat')=1
    UNION SELECT json_extract(step.value,'$.resourceDirectory') AS root FROM task_plans p,json_each(p.snapshot,'$.steps') step
    WHERE p.state NOT IN ('COMPLETED','STOPPED') AND json_extract(step.value,'$.type')='post' AND coalesce(json_extract(step.value,'$.resourceMode'),'directory')='directory' AND json_extract(step.value,'$.allowRepeat')=1`,
    )
    .all();
  if (
    repeats.some(
      (r) =>
        typeof r.root === 'string' &&
        path.isAbsolute(r.root) &&
        contained(archiveSourceKey(r.root), key),
    )
  )
    return true;
  // Directory roots are live snapshots. Historical inactive catalogs are not future tasks.
  for (const row of db
    .prepare('SELECT c.body FROM material_roots r JOIN material_catalogs c ON c.id=r.catalog_id')
    .all()) {
    const catalog = MaterialCatalog.parse(JSON.parse(String(row.body)) as unknown);
    for (const entry of catalog.sources)
      if (
        entry.snapshot.fingerprint !== original.fingerprint &&
        matches(entry.snapshot.files.map((f) => path.join(catalog.directory, f.relativePath)))
      )
        return true;
  }
  return false;
}
export function resourceCatalogPaths(catalog: ReturnType<typeof ResourceMaterialCatalog.parse>) {
  return catalog.sources.flatMap((s) =>
    resourceEffectiveRow(s.origin.row, s.snapshot).media.map((m) => m.source),
  );
}
