// Append-only migration12. This does not open COMPLETED or change migrations1..11.
export const materialArchivePreparationMigration = [
  "CREATE TABLE material_archive_preparation(attempt_id TEXT PRIMARY KEY REFERENCES material_archive_requests(attempt_id),state TEXT NOT NULL CHECK(state IN ('PREPARING','READY','REVIEW')),revision INTEGER NOT NULL,claim_token TEXT,reason TEXT NOT NULL,updated_at INTEGER NOT NULL)",
  'CREATE TABLE material_archive_plans(attempt_id TEXT PRIMARY KEY REFERENCES material_archive_preparation(attempt_id),destination TEXT NOT NULL COLLATE NOCASE UNIQUE,body TEXT NOT NULL,created_at INTEGER NOT NULL)',
  "CREATE TRIGGER immutable_material_archive_plans BEFORE UPDATE ON material_archive_plans BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_PLAN'); END",
  "CREATE TRIGGER retain_material_archive_plans BEFORE DELETE ON material_archive_plans BEGIN SELECT RAISE(ABORT,'RETAIN_ARCHIVE_PLAN'); END",
  "CREATE TRIGGER archive_preparation_initial BEFORE INSERT ON material_archive_preparation WHEN NEW.state<>'PREPARING' OR NEW.revision<>1 OR NEW.claim_token IS NULL BEGIN SELECT RAISE(ABORT,'ARCHIVE_PREPARATION_INITIAL'); END",
  "CREATE TRIGGER archive_preparation_transition BEFORE UPDATE ON material_archive_preparation WHEN NEW.attempt_id<>OLD.attempt_id OR NEW.revision<>OLD.revision+1 OR NOT ((OLD.state='REVIEW' AND NEW.state='PREPARING' AND NEW.claim_token IS NOT NULL) OR (OLD.state='PREPARING' AND NEW.state IN ('READY','REVIEW') AND NEW.claim_token IS NULL)) BEGIN SELECT RAISE(ABORT,'ARCHIVE_PREPARATION_TRANSITION'); END",
  "CREATE TRIGGER archive_preparation_plan_required BEFORE UPDATE OF state ON material_archive_preparation WHEN NEW.state='READY' AND NOT EXISTS(SELECT 1 FROM material_archive_plans WHERE attempt_id=NEW.attempt_id) BEGIN SELECT RAISE(ABORT,'ARCHIVE_PREPARATION_PLAN_REQUIRED'); END",
  "CREATE TRIGGER retain_material_archive_preparation BEFORE DELETE ON material_archive_preparation BEGIN SELECT RAISE(ABORT,'RETAIN_ARCHIVE_PREPARATION'); END",
].join(';');
