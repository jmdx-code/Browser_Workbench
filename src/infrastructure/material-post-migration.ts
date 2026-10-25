// Append-only migration9. Migration8 and all prior SQL remain immutable.
export const materialPostMigration = [
  'CREATE TABLE material_post_operations(operation_id TEXT PRIMARY KEY REFERENCES task_outbox(id) DEFERRABLE INITIALLY DEFERRED,attempt_id TEXT NOT NULL REFERENCES material_post_intents(attempt_id),purpose TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(attempt_id,sequence))',
  "CREATE UNIQUE INDEX one_original_post_submit ON material_post_operations(attempt_id) WHERE purpose='SUBMIT'",
  'CREATE TABLE material_operation_verdicts(operation_id TEXT PRIMARY KEY REFERENCES material_post_operations(operation_id),attempt_id TEXT NOT NULL REFERENCES material_post_intents(attempt_id),outcome TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL)',
  "CREATE TABLE material_attempt_verdicts(attempt_id TEXT PRIMARY KEY REFERENCES material_post_intents(attempt_id),outcome TEXT NOT NULL CHECK(outcome IN ('PUBLISHED','NOT_PUBLISHED')),body TEXT NOT NULL,created_at INTEGER NOT NULL)",
  'CREATE TABLE material_publications(attempt_id TEXT PRIMARY KEY REFERENCES material_attempt_verdicts(attempt_id),account_id TEXT NOT NULL,fingerprint TEXT NOT NULL REFERENCES material_contents(fingerprint),post_id TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(account_id,fingerprint),UNIQUE(account_id,post_id))',
  'CREATE INDEX material_publication_content ON material_publications(fingerprint)',
  'CREATE TABLE material_archive_requests(attempt_id TEXT PRIMARY KEY REFERENCES material_publications(attempt_id),body TEXT NOT NULL,created_at INTEGER NOT NULL)',
  "CREATE TABLE material_archive_state(attempt_id TEXT PRIMARY KEY REFERENCES material_archive_requests(attempt_id),state TEXT NOT NULL CHECK(state IN ('PENDING','MOVING','REVIEW','COMPLETED')),revision INTEGER NOT NULL,reason TEXT NOT NULL,updated_at INTEGER NOT NULL)",
  ...[
    'material_post_operations',
    'material_operation_verdicts',
    'material_attempt_verdicts',
    'material_publications',
    'material_archive_requests',
  ].flatMap((table) => [
    `CREATE TRIGGER immutable_${table} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POST_RECORD'); END`,
    `CREATE TRIGGER retain_${table} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'RETAIN_POST_RECORD'); END`,
  ]),
  'DROP TRIGGER material_settlement_not_implemented',
  "CREATE TRIGGER material_terminal_evidence_required BEFORE UPDATE OF state ON material_reservations WHEN NEW.state IN ('PUBLISHED','NOT_PUBLISHED') BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM material_attempt_verdicts v WHERE v.attempt_id=NEW.attempt_id AND v.outcome=NEW.state) THEN RAISE(ABORT,'MATERIAL_TERMINAL_EVIDENCE_REQUIRED') WHEN NEW.state='PUBLISHED' AND NOT EXISTS(SELECT 1 FROM material_publications p JOIN material_archive_requests r USING(attempt_id) JOIN material_archive_state s USING(attempt_id) WHERE p.attempt_id=NEW.attempt_id AND p.fingerprint=NEW.fingerprint) THEN RAISE(ABORT,'MATERIAL_PUBLICATION_ARCHIVE_REQUIRED') WHEN NEW.state='NOT_PUBLISHED' AND EXISTS(SELECT 1 FROM material_publications WHERE attempt_id=NEW.attempt_id) THEN RAISE(ABORT,'MATERIAL_PUBLICATION_VERDICT_CONFLICT') END; END",
  // File movement and its durable proof ledger will be appended separately before opening archiving.
  "CREATE TRIGGER archive_completion_not_implemented BEFORE UPDATE OF state ON material_archive_state WHEN NEW.state='COMPLETED' BEGIN SELECT RAISE(ABORT,'ARCHIVE_COMPLETION_NOT_IMPLEMENTED'); END",
  "CREATE TRIGGER retain_material_archive_state BEFORE DELETE ON material_archive_state BEGIN SELECT RAISE(ABORT,'RETAIN_ARCHIVE_STATE'); END",
].join(';');
