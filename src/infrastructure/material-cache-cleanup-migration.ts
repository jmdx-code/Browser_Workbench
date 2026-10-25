// Append-only migration11. Do not alter migrations1..10 or open archive completion.
export const materialCacheCleanupMigration = [
  'CREATE TABLE material_cache_cleanup_requests(stage_id TEXT PRIMARY KEY REFERENCES material_upload_stage_owners(stage_id),stop_request_id TEXT NOT NULL REFERENCES task_control_receipts(request_id),body TEXT NOT NULL,created_at INTEGER NOT NULL)',
  "CREATE TABLE material_cache_cleanup_state(stage_id TEXT PRIMARY KEY REFERENCES material_cache_cleanup_requests(stage_id),state TEXT NOT NULL CHECK(state IN ('PENDING','DELETING','REVIEW','CLEANED')),revision INTEGER NOT NULL,claim_token TEXT,reason TEXT NOT NULL,updated_at INTEGER NOT NULL)",
  'CREATE TABLE material_cache_cleanup_scopes(stage_id TEXT PRIMARY KEY REFERENCES material_cache_cleanup_requests(stage_id),body TEXT NOT NULL)',
  "CREATE TABLE material_cache_cleanup_files(stage_id TEXT NOT NULL REFERENCES material_cache_cleanup_scopes(stage_id),name TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('DELETING','DELETED')),PRIMARY KEY(stage_id,name))",
  'CREATE TABLE material_cache_directory_removals(stage_id TEXT PRIMARY KEY REFERENCES material_cache_cleanup_scopes(stage_id),created_at INTEGER NOT NULL)',
  'CREATE TABLE material_cache_cleanup_completions(stage_id TEXT PRIMARY KEY REFERENCES material_cache_directory_removals(stage_id),body TEXT NOT NULL,created_at INTEGER NOT NULL)',
  ...[
    'material_cache_cleanup_requests',
    'material_cache_cleanup_scopes',
    'material_cache_directory_removals',
    'material_cache_cleanup_completions',
  ].flatMap((table) => [
    `CREATE TRIGGER immutable_${table} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CACHE_CLEANUP_RECORD'); END`,
    `CREATE TRIGGER retain_${table} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'RETAIN_CACHE_CLEANUP_RECORD'); END`,
  ]),
  "CREATE TRIGGER retain_material_cache_cleanup_files BEFORE DELETE ON material_cache_cleanup_files BEGIN SELECT RAISE(ABORT,'RETAIN_CACHE_CLEANUP_FILE'); END",
  "CREATE TRIGGER immutable_material_cache_cleanup_files BEFORE UPDATE ON material_cache_cleanup_files WHEN NEW.stage_id<>OLD.stage_id OR NEW.name<>OLD.name OR NEW.body<>OLD.body OR OLD.state<>'DELETING' OR NEW.state<>'DELETED' BEGIN SELECT RAISE(ABORT,'CACHE_CLEANUP_FILE_TRANSITION'); END",
  "CREATE TRIGGER cache_cleanup_initial_state BEFORE INSERT ON material_cache_cleanup_state WHEN NEW.state<>'PENDING' OR NEW.revision<>0 OR NEW.claim_token IS NOT NULL BEGIN SELECT RAISE(ABORT,'CACHE_CLEANUP_INITIAL_STATE'); END",
  "CREATE TRIGGER cache_cleanup_transition BEFORE UPDATE ON material_cache_cleanup_state WHEN NEW.stage_id<>OLD.stage_id OR NEW.revision<>OLD.revision+1 OR NOT ((OLD.state IN ('PENDING','REVIEW') AND NEW.state='DELETING' AND NEW.claim_token IS NOT NULL) OR (OLD.state='DELETING' AND NEW.state IN ('REVIEW','CLEANED') AND NEW.claim_token IS NULL)) BEGIN SELECT RAISE(ABORT,'CACHE_CLEANUP_TRANSITION'); END",
  "CREATE TRIGGER cache_cleanup_completion_required BEFORE UPDATE OF state ON material_cache_cleanup_state WHEN NEW.state='CLEANED' AND NOT EXISTS(SELECT 1 FROM material_cache_cleanup_completions WHERE stage_id=NEW.stage_id) BEGIN SELECT RAISE(ABORT,'CACHE_CLEANUP_COMPLETION_REQUIRED'); END",
  "CREATE TRIGGER retain_material_cache_cleanup_state BEFORE DELETE ON material_cache_cleanup_state BEGIN SELECT RAISE(ABORT,'RETAIN_CACHE_CLEANUP_STATE'); END",
].join(';');
