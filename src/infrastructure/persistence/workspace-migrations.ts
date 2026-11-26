import { backup, type DatabaseSync } from 'node:sqlite';
import { ProductError } from '../../domain/workspace.js';
import { applyBaselineSchemaV62 } from './baseline-schema-v62.js';
import { ensureColumns, sqliteTableExists, tableColumns } from './sqlite-query-helpers.js';
import {
  backfillPostBumpRecordsMigration,
  ensurePostBumpRecordsSchema,
} from '../post-bump-records-store.js';

export const workspaceSchemaVersion = 62;

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
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_account_cache(profile_id TEXT PRIMARY KEY, account_state TEXT NOT NULL DEFAULT 'unknown', account_id TEXT, account_name TEXT, avatar_url TEXT, avatar_updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS record_account_avatar ON profile_account_cache(account_id);
    CREATE TABLE IF NOT EXISTS profile_launch_bindings(profile_id TEXT PRIMARY KEY, browser_kind TEXT NOT NULL, executable_path TEXT NOT NULL, user_data_dir TEXT NOT NULL, profile_directory TEXT NOT NULL, browser_name TEXT NOT NULL, window_name TEXT NOT NULL, verified_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS group_poster_usage(log_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, group_id TEXT NOT NULL, material_id TEXT NOT NULL, posted_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS group_poster_usage_lookup ON group_poster_usage(group_id, material_id); CREATE INDEX IF NOT EXISTS group_poster_usage_day ON group_poster_usage(profile_id, posted_at);
    CREATE TABLE IF NOT EXISTS group_bumper_effects(log_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, account_id TEXT NOT NULL, group_id TEXT NOT NULL, page_id TEXT NOT NULL, post_id TEXT NOT NULL, source_mode TEXT NOT NULL DEFAULT 'group', liked INTEGER NOT NULL DEFAULT 0, commented INTEGER NOT NULL DEFAULT 0, comment_digest TEXT, applied_at INTEGER NOT NULL, story_shared INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS group_bumper_effects_post ON group_bumper_effects(post_id); CREATE INDEX IF NOT EXISTS group_bumper_effects_day ON group_bumper_effects(account_id, source_mode, applied_at); CREATE INDEX IF NOT EXISTS group_bumper_effects_week ON group_bumper_effects(source_mode, applied_at);
  `);
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

export async function initializeOrMigrateWorkspaceDb(
  db: DatabaseSync,
  file: string,
  existed: boolean,
  onProgress?: (completed: number, total: number) => void,
): Promise<number> {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  if (typeof version !== 'number' || version > workspaceSchemaVersion)
    throw new ProductError('DATABASE_VERSION_TOO_NEW', '数据库版本不兼容，已停止打开', 409);
  if (version > 0 && version < 59)
    throw new ProductError(
      'DATABASE_VERSION_TOO_OLD',
      `数据库版本 v${version} 过旧，请先使用过渡版本升级至 v60+ 后再打开`,
      409,
    );
  if (existed && version < workspaceSchemaVersion) {
    onProgress?.(0, 0);
    await backup(db, `${file}.before-v${workspaceSchemaVersion}-${Date.now()}.sqlite`);
  }
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
  try {
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  } catch {}
  if (version === 0 || version < workspaceSchemaVersion) {
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    try {
      if (version === 0) {
        applyBaselineSchemaV62(db);
        if (db.prepare('PRAGMA foreign_key_check').all().length)
          throw Error('BASELINE_SCHEMA_FOREIGN_KEY_FAILED');
      } else {
        ensurePostBumpRecordsSchema(db);
        ensureLegacyUpgradeColumns(db);
        if (version < 61) db.exec(ZOMBIE_TASK_TABLES_SQL);
        retireLegacyLogTables(db);
        if (db.prepare('PRAGMA foreign_key_check').all().length)
          throw Error('V62_UPGRADE_FOREIGN_KEY_FAILED');
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
