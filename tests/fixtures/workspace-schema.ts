import type { DatabaseSync } from 'node:sqlite';
import { workspaceSchemaVersion } from '../../src/infrastructure/workspace-store.js';

export const latestMigrationBackupMarker = '.before-v' + workspaceSchemaVersion + '-';

export function seedLegacyLogTablesForV61Upgrade(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_poster_logs (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      account_name TEXT NOT NULL DEFAULT '',
      account_avatar TEXT,
      identity_type TEXT NOT NULL DEFAULT 'personal',
      group_id TEXT NOT NULL,
      group_name TEXT NOT NULL,
      group_avatar TEXT,
      material_id TEXT NOT NULL,
      caption_preview TEXT NOT NULL DEFAULT '',
      post_id TEXT NOT NULL,
      post_url TEXT NOT NULL,
      posted_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_bumper_logs (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      group_name TEXT NOT NULL,
      page_id TEXT NOT NULL,
      page_name TEXT NOT NULL,
      post_id TEXT NOT NULL,
      post_url TEXT NOT NULL,
      liked INTEGER NOT NULL DEFAULT 0,
      comment_text TEXT,
      bumped_at INTEGER NOT NULL,
      source_mode TEXT NOT NULL DEFAULT 'group',
      story_shared INTEGER NOT NULL DEFAULT 0
    );
  `);
}
