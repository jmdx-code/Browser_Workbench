// Append-only migration10. Existing migrations1..9 and archive completion guard stay unchanged.
export const materialUploadStageMigration = [
  'CREATE TABLE material_upload_stage_owners(stage_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE REFERENCES task_dispatch_bindings(operation_id),attempt_id TEXT NOT NULL REFERENCES material_post_intents(attempt_id),expected_bytes INTEGER NOT NULL CHECK(expected_bytes>0),body TEXT NOT NULL,created_at INTEGER NOT NULL)',
  "CREATE TABLE material_upload_stage_state(stage_id TEXT PRIMARY KEY REFERENCES material_upload_stage_owners(stage_id),claim_token TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('WRITING','READY','REVIEW')),revision INTEGER NOT NULL CHECK(revision>=0),reason TEXT NOT NULL,updated_at INTEGER NOT NULL)",
  'CREATE TABLE material_upload_stage_manifests(stage_id TEXT PRIMARY KEY REFERENCES material_upload_stage_owners(stage_id),body TEXT NOT NULL,created_at INTEGER NOT NULL)',
  ...['material_upload_stage_owners', 'material_upload_stage_manifests'].flatMap((table) => [
    `CREATE TRIGGER immutable_${table} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'IMMUTABLE_UPLOAD_STAGE_RECORD'); END`,
    `CREATE TRIGGER retain_${table} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'RETAIN_UPLOAD_STAGE_RECORD'); END`,
  ]),
  "CREATE TRIGGER upload_stage_initial_state BEFORE INSERT ON material_upload_stage_state WHEN NEW.state<>'WRITING' OR NEW.revision<>0 BEGIN SELECT RAISE(ABORT,'UPLOAD_STAGE_INITIAL_STATE'); END",
  "CREATE TRIGGER upload_stage_manifest_state BEFORE INSERT ON material_upload_stage_manifests WHEN NOT EXISTS(SELECT 1 FROM material_upload_stage_state WHERE stage_id=NEW.stage_id AND state='WRITING') BEGIN SELECT RAISE(ABORT,'UPLOAD_STAGE_NOT_WRITING'); END",
  "CREATE TRIGGER upload_stage_transition BEFORE UPDATE ON material_upload_stage_state WHEN NEW.stage_id<>OLD.stage_id OR NEW.claim_token<>OLD.claim_token OR NEW.revision<>OLD.revision+1 OR NOT ((OLD.state='WRITING' AND NEW.state='READY') OR (OLD.state IN ('WRITING','READY') AND NEW.state='REVIEW')) BEGIN SELECT RAISE(ABORT,'UPLOAD_STAGE_TRANSITION_REJECTED'); END",
  "CREATE TRIGGER upload_stage_ready_manifest BEFORE UPDATE OF state ON material_upload_stage_state WHEN NEW.state='READY' AND NOT EXISTS(SELECT 1 FROM material_upload_stage_manifests WHERE stage_id=NEW.stage_id) BEGIN SELECT RAISE(ABORT,'UPLOAD_STAGE_MANIFEST_REQUIRED'); END",
  "CREATE TRIGGER retain_material_upload_stage_state BEFORE DELETE ON material_upload_stage_state BEGIN SELECT RAISE(ABORT,'RETAIN_UPLOAD_STAGE_STATE'); END",
].join(';');
