import { backup, type DatabaseSync } from 'node:sqlite';
import { ProductError } from '../../domain/workspace.js';
import { applyBaselineSchemaV62 } from './baseline-schema-v62.js';
import { ensureColumns, sqliteTableExists, tableColumns } from './sqlite-query-helpers.js';
import {
  backfillPostBumpRecordsMigration,
  ensurePostBumpRecordsSchema,
} from '../post-bump-records-store.js';
import { backfillActivityStatsV63, ensureActivityStatsSchema } from '../activity-stats-store.js';
export const workspaceSchemaVersion = 64;
const LEGACY_REBUILD_BEFORE_VERSION = 59;
const LEGACY_SINGLETON_TABLES: readonly string[] = [
  'workspace_preferences',
  'scheduler_settings',
  'data_cleanup_settings',
  'material_usage_policy',
  'group_inviter_settings',
  'group_bumper_settings',
  'page_bumper_settings',
  'group_poster_settings',
  'auto_scheduler_settings',
  'google_sheets_config',
  'bluestacks_settings',
  'browser_risk_limit_settings',
];
const LEGACY_DATA_TABLES: readonly string[] = [
  'groups',
  'profile_metadata',
  'profile_launch_bindings',
  'profile_account_cache',
  'bluestacks_folders',
  'bluestacks_instances',
  'bluestacks_daily_actions',
  'account_daily_activity_stats',
  'combinations',
  'combination_versions',
  'resource_table_heads',
  'resource_table_versions',
  'target_list_folders',
  'shared_facebook_groups',
  'group_bumper_pages',
  'group_bumper_comments',
  'group_poster_materials',
  'group_poster_tasks',
  'auto_scheduler_schedules',
  'google_sheet_links',
  'sheet_image_cache',
  'sheet_schedule_items',
  'sheet_record_posts',
  'group_inviter_logs',
  'group_poster_usage',
  'group_bumper_effects',
  'post_bump_records',
  'record_avatar_cache',
  'task_account_likes',
];
const quotedIdent = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;
function schemaTableExists(db: DatabaseSync, schema: 'main' | 'legacy', table: string): boolean {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=? LIMIT 1`)
      .get(table),
  );
}
function schemaTableColumns(db: DatabaseSync, schema: 'main' | 'legacy', table: string): string[] {
  return db
    .prepare(`PRAGMA ${schema}.table_info(${quotedIdent(table)})`)
    .all()
    .map((c) => String(c.name));
}
function commonQuotedColumns(db: DatabaseSync, table: string): string | null {
  if (!schemaTableExists(db, 'legacy', table) || !schemaTableExists(db, 'main', table)) return null;
  const legacySet = new Set(schemaTableColumns(db, 'legacy', table));
  const common = schemaTableColumns(db, 'main', table).filter((col) => legacySet.has(col));
  return common.length ? common.map(quotedIdent).join(',') : null;
}
function runInSavepoint(db: DatabaseSync, name: string, work: () => boolean): void {
  db.exec(`SAVEPOINT ${name}`);
  try {
    const keep = work();
    if (!keep) db.exec(`ROLLBACK TO ${name}`);
  } catch {
    db.exec(`ROLLBACK TO ${name}`);
  } finally {
    db.exec(`RELEASE ${name}`);
  }
}
function migrateAttachedLegacyTables(db: DatabaseSync): void {
  for (const table of LEGACY_SINGLETON_TABLES) {
    const colsSql = commonQuotedColumns(db, table);
    if (!colsSql) continue;
    const qt = quotedIdent(table);
    runInSavepoint(db, 'sp_copy', () => {
      db.exec(`DELETE FROM main.${qt}`);
      const res = db
        .prepare(`INSERT OR IGNORE INTO main.${qt}(${colsSql}) SELECT ${colsSql} FROM legacy.${qt}`)
        .run();
      return Number(res.changes ?? 0) > 0;
    });
  }
  for (const table of LEGACY_DATA_TABLES) {
    const colsSql = commonQuotedColumns(db, table);
    if (!colsSql) continue;
    const qt = quotedIdent(table);
    runInSavepoint(db, 'sp_copy', () => {
      db.exec(`INSERT OR IGNORE INTO main.${qt}(${colsSql}) SELECT ${colsSql} FROM legacy.${qt}`);
      return true;
    });
  }
  migrateAttachedLegacyLogs(db);
  db.exec(`
    UPDATE main.profile_metadata SET group_id = NULL WHERE group_id IS NOT NULL AND group_id NOT IN (SELECT id FROM main.groups);
    UPDATE main.bluestacks_instances SET folder_id = NULL WHERE folder_id IS NOT NULL AND folder_id NOT IN (SELECT id FROM main.bluestacks_folders);
    DELETE FROM main.combination_versions WHERE combination_id NOT IN (SELECT id FROM main.combinations);
    DELETE FROM main.resource_table_heads WHERE combination_id NOT IN (SELECT id FROM main.combinations);
    DELETE FROM main.resource_table_versions WHERE combination_id NOT IN (SELECT id FROM main.combinations);
  `);
}
function migrateAttachedLegacyLogs(db: DatabaseSync): void {
  const bsNameExpr = `(SELECT COALESCE(NULLIF(TRIM(bs.account_name), ''), NULLIF(TRIM(bs.alias), ''), NULLIF(TRIM(bs.display_name), '')) FROM main.bluestacks_instances bs WHERE bs.id = t.profile_id LIMIT 1)`;
  const cacheNameExpr = `(SELECT NULLIF(TRIM(pac.account_name), '') FROM main.profile_account_cache pac WHERE pac.profile_id = t.profile_id LIMIT 1)`;
  const fallbackNameFor = (acctIdExpr: string) =>
    `COALESCE(${cacheNameExpr}, ${bsNameExpr}, NULLIF(TRIM(${acctIdExpr}), ''), '')`;
  const carrierExpr = `CASE WHEN EXISTS(SELECT 1 FROM main.bluestacks_instances bs WHERE bs.id = t.profile_id) THEN 'bluestacks' ELSE 'browser' END`;
  const pbCols =
    'id, record_type, carrier, status, profile_id, account_id, account_name, group_id, group_name, page_id, page_name, post_id, post_url, liked, comment_text, story_shared, caption_preview, error_reason, source_log_id, created_at';
  if (schemaTableExists(db, 'legacy', 'group_poster_logs')) {
    const pCols = new Set(schemaTableColumns(db, 'legacy', 'group_poster_logs'));
    if (
      pCols.has('id') &&
      pCols.has('profile_id') &&
      pCols.has('group_id') &&
      pCols.has('posted_at')
    ) {
      if (pCols.has('material_id')) {
        runInSavepoint(db, 'sp_legacy_poster_usage', () => {
          db.exec(
            'INSERT OR IGNORE INTO main.group_poster_usage(log_id, profile_id, group_id, material_id, posted_at) SELECT id, profile_id, group_id, material_id, posted_at FROM legacy.group_poster_logs',
          );
          return true;
        });
      }
      runInSavepoint(db, 'sp_legacy_poster_records', () => {
        const acctId = pCols.has('account_id') ? "COALESCE(t.account_id,'')" : "''";
        const fbName = fallbackNameFor(acctId);
        const acctName = pCols.has('account_name')
          ? `COALESCE(NULLIF(TRIM(t.account_name), ''), ${fbName})`
          : fbName;
        const pageId = pCols.has('identity_type')
          ? `CASE WHEN t.identity_type='page' THEN ${acctId} ELSE '' END`
          : "''";
        const pageName = pCols.has('identity_type')
          ? `CASE WHEN t.identity_type='page' THEN ${acctName} ELSE '' END`
          : "''";
        const gName = pCols.has('group_name') ? "COALESCE(t.group_name,'')" : "''";
        const postId = pCols.has('post_id') ? "COALESCE(t.post_id,'')" : "''";
        const postUrl = pCols.has('post_url') ? "COALESCE(t.post_url,'')" : "''";
        const caption = pCols.has('caption_preview') ? "COALESCE(t.caption_preview,'')" : "''";
        db.exec(
          `INSERT OR IGNORE INTO main.post_bump_records(${pbCols}) SELECT 'pbp:'||t.id, 'post', ${carrierExpr}, 'success', t.profile_id, ${acctId}, ${acctName}, COALESCE(t.group_id,''), ${gName}, ${pageId}, ${pageName}, ${postId}, ${postUrl}, 0, NULL, 0, ${caption}, '', t.id, t.posted_at FROM legacy.group_poster_logs t`,
        );
        return true;
      });
    }
  }
  if (schemaTableExists(db, 'legacy', 'group_bumper_logs')) {
    const bCols = new Set(schemaTableColumns(db, 'legacy', 'group_bumper_logs'));
    if (bCols.has('id') && bCols.has('profile_id') && bCols.has('bumped_at')) {
      const groupId = bCols.has('group_id') ? "COALESCE(t.group_id,'')" : "''";
      const pageId = bCols.has('page_id') ? "COALESCE(t.page_id,'')" : "''";
      const postId = bCols.has('post_id') ? "COALESCE(t.post_id,'')" : "''";
      const srcMode = bCols.has('source_mode')
        ? `COALESCE(t.source_mode, CASE WHEN ${groupId}='-' THEN 'page' ELSE 'group' END)`
        : `CASE WHEN ${groupId}='-' THEN 'page' ELSE 'group' END`;
      const acctId = bCols.has('account_id') ? "COALESCE(t.account_id,'')" : "''";
      const liked = bCols.has('liked') ? 'COALESCE(t.liked, 0)' : '0';
      const cmtText = bCols.has('comment_text') ? 't.comment_text' : 'NULL';
      const story = bCols.has('story_shared') ? 'COALESCE(t.story_shared, 0)' : '0';
      runInSavepoint(db, 'sp_legacy_bumper_effects', () => {
        db.exec(
          `INSERT OR IGNORE INTO main.group_bumper_effects(log_id, profile_id, account_id, group_id, page_id, post_id, source_mode, liked, commented, comment_digest, applied_at, story_shared) SELECT t.id, t.profile_id, ${acctId}, ${groupId}, ${pageId}, ${postId}, ${srcMode}, ${liked}, ${cmtText} IS NOT NULL, NULL, t.bumped_at, ${story} FROM legacy.group_bumper_logs t`,
        );
        return true;
      });
      runInSavepoint(db, 'sp_legacy_bumper_records', () => {
        const recType = `CASE WHEN (${srcMode})='page' OR ${groupId}='-' THEN 'page_bump' ELSE 'group_bump' END`;
        const cleanGId = `CASE WHEN ${groupId}='-' THEN '' ELSE ${groupId} END`;
        const gName = bCols.has('group_name') ? "COALESCE(t.group_name,'')" : "''";
        const cleanGName = `CASE WHEN ${groupId}='-' THEN '' ELSE ${gName} END`;
        const pName = bCols.has('page_name') ? "COALESCE(t.page_name,'')" : "''";
        const postUrl = bCols.has('post_url') ? "COALESCE(t.post_url,'')" : "''";
        db.exec(
          `INSERT OR IGNORE INTO main.post_bump_records(${pbCols}) SELECT 'pbb:'||t.id, ${recType}, ${carrierExpr}, 'success', t.profile_id, ${acctId}, ${fallbackNameFor(acctId)}, ${cleanGId}, ${cleanGName}, ${pageId}, ${pName}, ${postId}, ${postUrl}, ${liked}, ${cmtText}, ${story}, '', '', t.id, t.bumped_at FROM legacy.group_bumper_logs t`,
        );
        return true;
      });
    }
  }
}
function rebuildLegacyWorkspaceDbToV62(db: DatabaseSync, backupFile: string | null): void {
  db.exec('PRAGMA foreign_keys=OFF');
  let attached = false;
  if (backupFile) {
    db.exec(`ATTACH DATABASE '${backupFile.replace(/'/g, "''")}' AS legacy`);
    attached = true;
  }
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const objects = db
        .prepare(
          "SELECT type, name FROM main.sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('trigger','view','table') ORDER BY CASE type WHEN 'trigger' THEN 0 WHEN 'view' THEN 1 ELSE 2 END",
        )
        .all() as Array<{ type: string; name: string }>;
      for (const obj of objects) {
        const kind = obj.type === 'trigger' ? 'TRIGGER' : obj.type === 'view' ? 'VIEW' : 'TABLE';
        db.exec(`DROP ${kind} IF EXISTS main.${quotedIdent(obj.name)}`);
      }
      applyBaselineSchemaV62(db);
      ensureActivityStatsSchema(db);
      if (attached) migrateAttachedLegacyTables(db);
      backfillActivityStatsV63(db);
      cleanupW2LegacyArtifactsV64(db);
      if (db.prepare('PRAGMA main.foreign_key_check').all().length)
        throw Error('V64_LEGACY_REBUILD_FOREIGN_KEY_FAILED');
      db.exec(`PRAGMA main.user_version=${workspaceSchemaVersion}; COMMIT`);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    if (attached) {
      try {
        db.exec('DETACH DATABASE legacy');
      } catch {}
    }
    db.exec('PRAGMA foreign_keys=ON');
  }
}
const ZOMBIE_TASK_TABLES_SQL = `
  DROP TRIGGER IF EXISTS retain_settlement_notice; DROP TRIGGER IF EXISTS immutable_settlement_notice;
  DROP TRIGGER IF EXISTS retain_browse_intent; DROP TRIGGER IF EXISTS immutable_browse_intent;
  DROP TRIGGER IF EXISTS retain_task_control_receipt; DROP TRIGGER IF EXISTS immutable_task_control_receipt;
  DROP TRIGGER IF EXISTS retain_task_control_binding; DROP TRIGGER IF EXISTS immutable_task_control_binding;
  DROP TRIGGER IF EXISTS retain_task_tab_proof; DROP TRIGGER IF EXISTS immutable_task_tab_proof;
  DROP INDEX IF EXISTS task_tab_state_job; DROP INDEX IF EXISTS task_control_bindings_job;
  DROP TABLE IF EXISTS task_settlement_delivery; DROP TABLE IF EXISTS task_settlement_notices;
  DROP TABLE IF EXISTS task_control_receipts; DROP TABLE IF EXISTS task_control_bindings;
  DROP TABLE IF EXISTS task_tab_state; DROP TABLE IF EXISTS task_tab_ownership; DROP TABLE IF EXISTS task_browse_intents;
`;
function ensureLegacyUpgradeColumns(db: DatabaseSync): void {
  ensureColumns(db, 'workspace_preferences', [
    ['combination_colors', "TEXT NOT NULL DEFAULT '{}'"],
  ]);
  ensureColumns(db, 'combinations', [['deleted_at', 'INTEGER DEFAULT NULL']]);
  ensureColumns(db, 'google_sheet_links', [['daily_schedule_limit', 'INTEGER DEFAULT 0']]);
  ensureColumns(db, 'task_plans', [['close_browser_on_finish', 'INTEGER NOT NULL DEFAULT 0']]);
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_account_cache(profile_id TEXT PRIMARY KEY, account_state TEXT NOT NULL DEFAULT 'unknown', account_id TEXT, account_name TEXT, avatar_url TEXT, avatar_updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS record_account_avatar ON profile_account_cache(account_id);
    CREATE TABLE IF NOT EXISTS profile_launch_bindings(profile_id TEXT PRIMARY KEY, browser_kind TEXT NOT NULL, executable_path TEXT NOT NULL, user_data_dir TEXT NOT NULL, profile_directory TEXT NOT NULL, browser_name TEXT NOT NULL, window_name TEXT NOT NULL, verified_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS group_poster_usage(log_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, group_id TEXT NOT NULL, material_id TEXT NOT NULL, posted_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS group_poster_usage_lookup ON group_poster_usage(group_id, material_id); CREATE INDEX IF NOT EXISTS group_poster_usage_day ON group_poster_usage(profile_id, posted_at);
    CREATE TABLE IF NOT EXISTS group_bumper_effects(log_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, account_id TEXT NOT NULL, group_id TEXT NOT NULL, page_id TEXT NOT NULL, post_id TEXT NOT NULL, source_mode TEXT NOT NULL DEFAULT 'group', liked INTEGER NOT NULL DEFAULT 0, commented INTEGER NOT NULL DEFAULT 0, comment_digest TEXT, applied_at INTEGER NOT NULL, story_shared INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS group_bumper_effects_post ON group_bumper_effects(post_id); CREATE INDEX IF NOT EXISTS group_bumper_effects_day ON group_bumper_effects(account_id, source_mode, applied_at); CREATE INDEX IF NOT EXISTS group_bumper_effects_week ON group_bumper_effects(source_mode, applied_at);
  `);
  ensureColumns(db, 'group_bumper_effects', [['story_shared', 'INTEGER NOT NULL DEFAULT 0']]);
}
function retireLegacyLogTables(db: DatabaseSync): void {
  if (sqliteTableExists(db, 'group_poster_logs'))
    db.exec(
      'INSERT OR IGNORE INTO group_poster_usage(log_id, profile_id, group_id, material_id, posted_at) SELECT id, profile_id, group_id, material_id, posted_at FROM group_poster_logs;',
    );
  if (sqliteTableExists(db, 'group_bumper_logs')) {
    const cols = tableColumns(db, 'group_bumper_logs');
    const src = cols.has('source_mode')
      ? "COALESCE(source_mode, CASE WHEN group_id='-' THEN 'page' ELSE 'group' END)"
      : "CASE WHEN group_id='-' THEN 'page' ELSE 'group' END";
    const story = cols.has('story_shared') ? 'COALESCE(story_shared, 0)' : '0';
    db.exec(
      `INSERT OR IGNORE INTO group_bumper_effects(log_id, profile_id, account_id, group_id, page_id, post_id, source_mode, liked, commented, comment_digest, applied_at, story_shared) SELECT id, profile_id, account_id, group_id, page_id, post_id, ${src}, liked, comment_text IS NOT NULL, NULL, bumped_at, ${story} FROM group_bumper_logs;`,
    );
  }
  backfillPostBumpRecordsMigration(db);
  db.exec(`
    DROP TRIGGER IF EXISTS bumper_effect_insert; DROP TRIGGER IF EXISTS bumper_effect_update; DROP TRIGGER IF EXISTS poster_usage_insert;
    DROP TABLE IF EXISTS group_poster_logs; DROP TABLE IF EXISTS group_bumper_logs;
  `);
}
export function cleanupW2LegacyArtifactsV64(db: DatabaseSync): void {
  const now = Date.now();
  const isLeakedExpr = (col: string) =>
    `(json_valid(${col}) AND (` +
    `json_extract(${col}, '$.name') LIKE '单项测试：%' OR ` +
    `json_extract(${col}, '$.name') LIKE '单项测试:%' OR ` +
    `json_extract(${col}, '$.name') LIKE '单项测试 · %' OR ` +
    `json_extract(${col}, '$.name') = '排班快捷' OR ` +
    `json_extract(${col}, '$.name') LIKE '排班 · %' OR ` +
    `json_extract(${col}, '$.note') LIKE '单项测试工作台：%'` +
    `))`;
  if (sqliteTableExists(db, 'combinations') && sqliteTableExists(db, 'combination_versions')) {
    const leakedRows = db
      .prepare(
        `SELECT DISTINCT combination_id AS id FROM combination_versions WHERE ${isLeakedExpr('body')}
         UNION
         SELECT id FROM combinations WHERE draft IS NOT NULL AND ${isLeakedExpr('draft')}`,
      )
      .all() as Array<{ id: string }>;
    if (leakedRows.length > 0) {
      const delUnusedVersions = db.prepare(
        `DELETE FROM combination_versions
         WHERE combination_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM task_plans p
             WHERE p.combination_id = combination_versions.combination_id
               AND p.version = combination_versions.version
           )`,
      );
      const canHardDeleteCombo = db.prepare(
        `SELECT 1 FROM combinations c
         WHERE c.id = ?
           AND NOT EXISTS (SELECT 1 FROM combination_versions cv WHERE cv.combination_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM resource_table_heads rth WHERE rth.combination_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM resource_table_versions rtv WHERE rtv.combination_id = c.id)
         LIMIT 1`,
      );
      const hardDeleteCombo = db.prepare('DELETE FROM combinations WHERE id = ?');
      const softDeleteCombo = db.prepare(
        'UPDATE combinations SET deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE id = ?',
      );
      for (const { id } of leakedRows) {
        delUnusedVersions.run(id);
        if (canHardDeleteCombo.get(id)) hardDeleteCombo.run(id);
        else softDeleteCombo.run(now, now, id);
      }
    }
    db.exec(`
      DELETE FROM combination_versions WHERE combination_id NOT IN (SELECT id FROM combinations);
      DELETE FROM resource_table_heads WHERE combination_id NOT IN (SELECT id FROM combinations);
    `);
  }
  if (sqliteTableExists(db, 'task_steps') && sqliteTableExists(db, 'task_plans')) {
    const zombies = db
      .prepare(
        `SELECT s.id, s.status, json_extract(s.spec, '$.type') AS step_type,
                COALESCE(NULLIF(p.reason, ''), CASE WHEN p.state = 'FAILED' THEN 'TASK_FAILED' ELSE 'USER_STOP' END) AS plan_reason,
                p.updated_at AS plan_updated_at
         FROM task_steps s
         JOIN task_plans p ON p.id = s.job_id
         WHERE p.state IN ('FAILED', 'STOPPED', 'COMPLETED')
           AND s.status IN ('ACTIVE', 'PENDING')`,
      )
      .all() as Array<{
      id: string;
      status: string;
      step_type: string | null;
      plan_reason: string;
      plan_updated_at: number | null;
    }>;
    if (zombies.length > 0) {
      const upd = db.prepare('UPDATE task_steps SET status = ?, outcome = ? WHERE id = ?');
      for (const z of zombies) {
        const endedAt = Math.max(0, Math.floor(Number(z.plan_updated_at) || now));
        if (z.status === 'ACTIVE') {
          const isPost = z.step_type === 'post';
          const outcome = JSON.stringify({
            version: 1,
            kind: 'FAILED',
            reason: String(z.plan_reason || 'USER_STOP').slice(0, 200),
            endedAt,
            submissionPhase: isPost ? 'UNKNOWN' : 'NOT_APPLICABLE',
            businessResult: isPost ? 'UNKNOWN' : 'NOT_APPLICABLE',
          });
          upd.run('FAILED', outcome, z.id);
        } else {
          const outcome = JSON.stringify({
            version: 1,
            kind: 'SKIPPED',
            reason: 'FEATURE_UNAVAILABLE',
            endedAt,
          });
          upd.run('SKIPPED', outcome, z.id);
        }
      }
    }
  }
}
export async function initializeOrMigrateWorkspaceDb(
  db: DatabaseSync,
  file: string,
  existed: boolean,
  onProgress?: (completed: number, total: number) => void,
): Promise<number> {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  if (typeof version !== 'number' || version > workspaceSchemaVersion)
    throw new ProductError('DATABASE_VERSION_TOO_NEW', '数据库版本不兼容，已停止打开', 409);
  let backupFile: string | null = null;
  if (existed && version < workspaceSchemaVersion) {
    onProgress?.(0, 0);
    backupFile = `${file}.before-v${workspaceSchemaVersion}-${Date.now()}.sqlite`;
    await backup(db, backupFile);
  }
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
  try {
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  } catch {}
  if (version > 0 && version < LEGACY_REBUILD_BEFORE_VERSION) {
    rebuildLegacyWorkspaceDbToV62(db, backupFile);
    return version;
  }
  if (version === 0 || version < workspaceSchemaVersion) {
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    try {
      if (version === 0) {
        applyBaselineSchemaV62(db);
        ensureActivityStatsSchema(db);
        if (db.prepare('PRAGMA foreign_key_check').all().length)
          throw Error('BASELINE_SCHEMA_FOREIGN_KEY_FAILED');
      } else {
        ensurePostBumpRecordsSchema(db);
        ensureLegacyUpgradeColumns(db);
        if (version < 61) db.exec(ZOMBIE_TASK_TABLES_SQL);
        if (version < 62) retireLegacyLogTables(db);
        if (version < 63) backfillActivityStatsV63(db);
        else ensureActivityStatsSchema(db);
        if (version < 64) cleanupW2LegacyArtifactsV64(db);
        if (db.prepare('PRAGMA foreign_key_check').all().length)
          throw Error('V64_UPGRADE_FOREIGN_KEY_FAILED');
      }
      db.exec(`PRAGMA user_version=${workspaceSchemaVersion}; COMMIT`);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      db.exec('PRAGMA foreign_keys=ON');
    }
  }
  return version;
}
