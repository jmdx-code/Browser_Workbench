import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { saveRecordAvatar } from './record-avatar-store.js';
import { purgeablePlan } from './data-cleanup-store.js';
const bumperSchema = `CREATE TABLE group_bumper_effects(log_id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,account_id TEXT NOT NULL,group_id TEXT NOT NULL,page_id TEXT NOT NULL,post_id TEXT NOT NULL,source_mode TEXT NOT NULL,liked INTEGER NOT NULL,commented INTEGER NOT NULL,comment_digest TEXT,applied_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS bumper_effect_account_time ON group_bumper_effects(account_id,source_mode,applied_at);
CREATE INDEX IF NOT EXISTS bumper_effect_profile_time ON group_bumper_effects(profile_id,source_mode,applied_at);
CREATE INDEX IF NOT EXISTS bumper_effect_post ON group_bumper_effects(post_id,account_id,profile_id);
CREATE INDEX IF NOT EXISTS bumper_effect_group ON group_bumper_effects(group_id);
CREATE INDEX IF NOT EXISTS bumper_effect_page ON group_bumper_effects(page_id);
CREATE INDEX IF NOT EXISTS bumper_effect_time ON group_bumper_effects(applied_at,source_mode,profile_id);
CREATE TRIGGER bumper_effect_insert AFTER INSERT ON group_bumper_logs BEGIN
 INSERT OR IGNORE INTO group_bumper_effects VALUES(NEW.id,NEW.profile_id,NEW.account_id,NEW.group_id,NEW.page_id,NEW.post_id,NEW.source_mode,NEW.liked,NEW.comment_text IS NOT NULL,NULL,NEW.bumped_at);
END;
CREATE TRIGGER bumper_effect_update AFTER UPDATE OF liked,comment_text ON group_bumper_logs BEGIN
 UPDATE group_bumper_effects SET liked=NEW.liked,commented=NEW.comment_text IS NOT NULL WHERE log_id=NEW.id;
END;
`;
const posterSchema = `CREATE TABLE group_poster_usage(log_id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,group_id TEXT NOT NULL,material_id TEXT NOT NULL,posted_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS poster_usage_material ON group_poster_usage(group_id,material_id);
CREATE INDEX IF NOT EXISTS poster_usage_profile_time ON group_poster_usage(profile_id,posted_at);
CREATE INDEX IF NOT EXISTS poster_usage_time ON group_poster_usage(posted_at);
CREATE TRIGGER poster_usage_insert AFTER INSERT ON group_poster_logs BEGIN
 INSERT OR IGNORE INTO group_poster_usage VALUES(NEW.id,NEW.profile_id,NEW.group_id,NEW.material_id,NEW.posted_at);
END;
`;
const avatarSchema = `CREATE TABLE IF NOT EXISTS record_avatar_cache(kind TEXT NOT NULL,entity_id TEXT NOT NULL,image TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(kind,entity_id));

`;
export function ensureBumperEffects(db: DatabaseSync) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='group_bumper_effects'").get()) return;
  db.exec(bumperSchema);
  db.exec(
    'INSERT INTO group_bumper_effects SELECT id,profile_id,account_id,group_id,page_id,post_id,source_mode,liked,comment_text IS NOT NULL,NULL,bumped_at FROM group_bumper_logs',
  );
  for (const r of db
    .prepare('SELECT id,comment_text FROM group_bumper_logs WHERE comment_text IS NOT NULL')
    .all())
    db.prepare('UPDATE group_bumper_effects SET comment_digest=? WHERE log_id=?').run(
      createHash('sha256').update(String(r.comment_text)).digest('hex'),
      r.id as string,
    );
}
export function ensurePosterUsage(db: DatabaseSync) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='group_poster_usage'").get()) return;
  db.exec(posterSchema);
  db.exec(
    'INSERT INTO group_poster_usage SELECT id,profile_id,group_id,material_id,posted_at FROM group_poster_logs',
  );
}
export function ensureRecordAvatars(db: DatabaseSync) {
  db.exec(avatarSchema);
}
export function recordRetentionMigration(db: DatabaseSync) {
  const columns = db
    .prepare('PRAGMA table_info(data_cleanup_settings)')
    .all()
    .map((r) => r.name);
  for (const [name, value, max] of [
    ['bumper_max_count', 300000, 1000000],
    ['poster_max_count', 100000, 1000000],
    ['detail_max_count', 1000, 100000],
  ] as const)
    if (!columns.includes(name))
      db.exec(
        `ALTER TABLE data_cleanup_settings ADD COLUMN ${name} INTEGER NOT NULL DEFAULT ${value} CHECK(${name} BETWEEN 1 AND ${max})`,
      );
  db.exec(`UPDATE data_cleanup_settings SET history_max_count=10000 WHERE history_max_count IS NULL AND revision=0;CREATE TABLE IF NOT EXISTS task_run_summaries(job_id TEXT NOT NULL REFERENCES task_plans(id) ON DELETE CASCADE,round INTEGER NOT NULL,records TEXT NOT NULL,details_pruned INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(job_id,round));
`);
  ensureBumperEffects(db);
  ensurePosterUsage(db);
  ensureRecordAvatars(db);
  db.exec(
    "CREATE INDEX IF NOT EXISTS bumper_pending_log ON group_bumper_operations(log_id) WHERE status<>'SETTLED' OR resolution_outcome='ENDED_UNKNOWN';CREATE INDEX IF NOT EXISTS poster_pending_log ON group_poster_operations(log_id) WHERE kernel_settled=0 OR status='PENDING_REVIEW'",
  );
  for (const [name, table, job, operation] of [
    ['retain_browse_intent', 'task_browse_intents', 'OLD.job_id', 'OLD.operation_id'],
    [
      'retain_dispatch_binding',
      'task_dispatch_bindings',
      '(SELECT job_id FROM task_outbox WHERE id=OLD.operation_id)',
      'OLD.operation_id',
    ],
    [
      'retain_settlement_notice',
      'task_settlement_notices',
      '(SELECT job_id FROM task_outbox WHERE id=OLD.operation_id)',
      'OLD.operation_id',
    ],
  ] as const)
    db.exec(`DROP TRIGGER IF EXISTS ${name};CREATE TRIGGER ${name} BEFORE DELETE ON ${table}
 WHEN NOT EXISTS(SELECT 1 FROM task_plans p WHERE p.id=${job} AND ${purgeablePlan})
 AND NOT EXISTS(SELECT 1 FROM task_outbox o JOIN task_steps s ON s.id=o.step_id JOIN task_run_summaries a ON a.job_id=s.job_id AND a.round=s.round WHERE o.id=${operation} AND a.details_pruned=1 AND o.status IN ('VERIFIED','FAILED','CANCELLED') AND NOT EXISTS(SELECT 1 FROM task_settlement_delivery d WHERE d.operation_id=o.id AND d.state<>'DELIVERED'))
 BEGIN SELECT RAISE(ABORT,'${name.toUpperCase()}');END;`);
  db.exec(
    'CREATE INDEX IF NOT EXISTS task_events_retention ON task_events(created_at,sequence);CREATE INDEX IF NOT EXISTS task_outbox_retention ON task_outbox(updated_at,id);CREATE INDEX IF NOT EXISTS bumper_result_retention ON group_bumper_logs(bumped_at,id);CREATE INDEX IF NOT EXISTS poster_result_retention ON group_poster_logs(posted_at,id)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS bumper_detail_order ON group_bumper_operations(status,updated_at,operation_id);CREATE INDEX IF NOT EXISTS poster_detail_order ON group_poster_operations(kernel_settled,updated_at,operation_id)',
  );
  for (const r of db
    .prepare(
      'SELECT account_id,identity_type,account_avatar,group_id,group_avatar,posted_at FROM group_poster_logs ORDER BY posted_at',
    )
    .all()) {
    saveRecordAvatar(
      db,
      r.identity_type === 'page' ? 'page' : 'account',
      String(r.account_id),
      r.account_avatar as string | null,
      Number(r.posted_at),
    );
    saveRecordAvatar(
      db,
      'group',
      String(r.group_id),
      r.group_avatar as string | null,
      Number(r.posted_at),
    );
  }
  db.exec(
    'UPDATE group_poster_logs SET account_avatar=NULL,group_avatar=NULL;INSERT OR IGNORE INTO task_record_dirty SELECT DISTINCT job_id,round FROM task_steps',
  );
}
