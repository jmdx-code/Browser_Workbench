// Append-only migration 8. No publish/settlement API is opened by this foundation.
export const materialIndexMigration = [
  'CREATE TABLE material_catalogs(id TEXT PRIMARY KEY,directory_key TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(directory_key,revision))',
  'CREATE TABLE material_roots(directory_key TEXT PRIMARY KEY,catalog_id TEXT NOT NULL REFERENCES material_catalogs(id))',
  'CREATE TABLE material_contents(fingerprint TEXT PRIMARY KEY,version INTEGER NOT NULL CHECK(version=1),payload TEXT NOT NULL)',
  'CREATE TABLE material_sources(id TEXT PRIMARY KEY,catalog_id TEXT NOT NULL REFERENCES material_catalogs(id),fingerprint TEXT NOT NULL REFERENCES material_contents(fingerprint),source TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(catalog_id,source))',
  'CREATE INDEX material_source_content ON material_sources(fingerprint)',
  'CREATE TABLE material_post_intents(attempt_id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES task_plans(id),step_id TEXT NOT NULL REFERENCES task_steps(id),account_id TEXT NOT NULL,fingerprint TEXT NOT NULL REFERENCES material_contents(fingerprint),source_id TEXT NOT NULL REFERENCES material_sources(id),ordinal INTEGER NOT NULL CHECK(ordinal>0),body TEXT NOT NULL,created_at INTEGER NOT NULL)',
  "CREATE TABLE material_reservations(attempt_id TEXT PRIMARY KEY REFERENCES material_post_intents(attempt_id),job_id TEXT NOT NULL REFERENCES task_plans(id),fingerprint TEXT NOT NULL REFERENCES material_contents(fingerprint),state TEXT NOT NULL CHECK(state IN ('RESERVED','REVIEW','PUBLISHED','NOT_PUBLISHED')),reason TEXT NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE UNIQUE INDEX one_active_material_per_plan ON material_reservations(job_id) WHERE state IN ('RESERVED','REVIEW')",
  "CREATE UNIQUE INDEX one_active_material_per_content ON material_reservations(fingerprint) WHERE state IN ('RESERVED','REVIEW')",
  ...[
    'material_catalogs',
    'material_contents',
    'material_sources',
    'material_post_intents',
  ].flatMap((table) => [
    `CREATE TRIGGER immutable_${table} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MATERIAL_RECORD'); END`,
    `CREATE TRIGGER retain_${table} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'RETAIN_MATERIAL_RECORD'); END`,
  ]),
  "CREATE TRIGGER immutable_material_reservation BEFORE UPDATE OF attempt_id,job_id,fingerprint ON material_reservations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MATERIAL_RESERVATION'); END",
  "CREATE TRIGGER retain_material_reservation BEFORE DELETE ON material_reservations BEGIN SELECT RAISE(ABORT,'RETAIN_MATERIAL_RESERVATION'); END",
  "CREATE TRIGGER material_review_not_revived BEFORE UPDATE OF state ON material_reservations WHEN OLD.state='REVIEW' AND NEW.state='RESERVED' BEGIN SELECT RAISE(ABORT,'MATERIAL_REVIEW_REQUIRED'); END",
  "CREATE TRIGGER material_terminal_not_reopened BEFORE UPDATE OF state ON material_reservations WHEN OLD.state IN ('PUBLISHED','NOT_PUBLISHED') AND NEW.state<>OLD.state BEGIN SELECT RAISE(ABORT,'MATERIAL_TERMINAL_IMMUTABLE'); END",
  // Future append-only settlement migration replaces this guard with evidence/history checks.
  "CREATE TRIGGER material_settlement_not_implemented BEFORE UPDATE OF state ON material_reservations WHEN NEW.state IN ('PUBLISHED','NOT_PUBLISHED') BEGIN SELECT RAISE(ABORT,'MATERIAL_SETTLEMENT_NOT_IMPLEMENTED'); END",
  "CREATE TRIGGER material_initial_reserved BEFORE INSERT ON material_reservations WHEN NEW.state<>'RESERVED' BEGIN SELECT RAISE(ABORT,'MATERIAL_INITIAL_RESERVED'); END",
].join(';');
