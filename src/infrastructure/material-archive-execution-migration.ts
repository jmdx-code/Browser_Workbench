// Append-only 16. Original publications, consumption and immutable plans remain unchanged.
export const materialArchiveExecutionMigration = [
  'CREATE TABLE material_archive_workers(attempt_id TEXT PRIMARY KEY REFERENCES material_archive_plans(attempt_id),token TEXT,revision INTEGER NOT NULL)',
  'CREATE TABLE material_archive_io(attempt_id TEXT NOT NULL REFERENCES material_archive_plans(attempt_id),step_key TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(attempt_id,step_key))',
  'CREATE TABLE material_archive_io_proofs(attempt_id TEXT NOT NULL,step_key TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(attempt_id,step_key),FOREIGN KEY(attempt_id,step_key) REFERENCES material_archive_io(attempt_id,step_key))',
  "CREATE TABLE material_archive_source_locks(attempt_id TEXT NOT NULL REFERENCES material_archive_plans(attempt_id),source_key TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('LOCKED','RELEASED')),PRIMARY KEY(attempt_id,source_key))",
  "CREATE UNIQUE INDEX archive_source_single_owner ON material_archive_source_locks(source_key) WHERE state='LOCKED'",
  'CREATE TABLE material_archive_completions(attempt_id TEXT PRIMARY KEY REFERENCES material_archive_plans(attempt_id),body TEXT NOT NULL,created_at INTEGER NOT NULL)',
  ...['material_archive_io', 'material_archive_io_proofs', 'material_archive_completions'].flatMap(
    (table) => [
      `CREATE TRIGGER immutable_${table} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_IO'); END`,
      `CREATE TRIGGER retain_${table} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'RETAIN_ARCHIVE_IO'); END`,
    ],
  ),
  "CREATE TRIGGER retain_material_archive_workers BEFORE DELETE ON material_archive_workers BEGIN SELECT RAISE(ABORT,'RETAIN_ARCHIVE_WORKER'); END",
  "CREATE TRIGGER retain_material_archive_source_locks BEFORE DELETE ON material_archive_source_locks BEGIN SELECT RAISE(ABORT,'RETAIN_ARCHIVE_SOURCE_LOCK'); END",
  "CREATE TRIGGER immutable_archive_source_key BEFORE UPDATE OF attempt_id,source_key ON material_archive_source_locks BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_SOURCE_LOCK'); END",
  'DROP TRIGGER archive_completion_not_implemented',
  `CREATE TRIGGER archive_completion_entry_valid BEFORE INSERT ON material_archive_completions WHEN
    NOT EXISTS(SELECT 1 FROM material_archive_state s JOIN material_archive_plans p USING(attempt_id)
      WHERE s.attempt_id=NEW.attempt_id AND s.state='MOVING' AND json_extract(NEW.body,'$.version')=1 AND json_extract(NEW.body,'$.plan')=p.body)
    OR EXISTS(SELECT 1 FROM material_archive_plans p,json_each(p.body,'$.files') f WHERE p.attempt_id=NEW.attempt_id AND
      (NOT EXISTS(SELECT 1 FROM material_archive_io_proofs c WHERE c.attempt_id=NEW.attempt_id AND c.step_key='COPY:'||json_extract(f.value,'$.targetPath')
        AND json_extract(c.body,'$.kind')='COPY' AND json_extract(c.body,'$.digest')=json_extract(f.value,'$.original.digest')
        AND json_extract(c.body,'$.stat.size')=CAST(json_extract(f.value,'$.original.bytes') AS TEXT))
      OR NOT EXISTS(SELECT 1 FROM material_archive_io_proofs d WHERE d.attempt_id=NEW.attempt_id AND
        ((d.step_key='KEEP:'||json_extract(f.value,'$.sourcePath') AND json_extract(d.body,'$.kind')='KEEP')
        OR (d.step_key='DELETE:'||json_extract(f.value,'$.sourcePath') AND json_extract(d.body,'$.kind')='DELETE' AND json_extract(d.body,'$.absent')=1)))))
    BEGIN SELECT RAISE(ABORT,'ARCHIVE_COMPLETION_PROOF_REQUIRED'); END`,
  "CREATE TRIGGER archive_lock_release_required BEFORE UPDATE OF state ON material_archive_source_locks WHEN NEW.state='RELEASED' AND NOT EXISTS(SELECT 1 FROM material_archive_state WHERE attempt_id=NEW.attempt_id AND state='COMPLETED') BEGIN SELECT RAISE(ABORT,'ARCHIVE_LOCK_COMPLETION_REQUIRED'); END",
  "CREATE TRIGGER archive_completion_proof_required BEFORE UPDATE OF state ON material_archive_state WHEN NEW.state='COMPLETED' AND NOT EXISTS(SELECT 1 FROM material_archive_completions WHERE attempt_id=NEW.attempt_id) BEGIN SELECT RAISE(ABORT,'ARCHIVE_COMPLETION_PROOF_REQUIRED'); END",
  "CREATE TRIGGER archive_completed_not_reopened BEFORE UPDATE ON material_archive_state WHEN OLD.state='COMPLETED' BEGIN SELECT RAISE(ABORT,'ARCHIVE_COMPLETED_IMMUTABLE'); END",
  // Compatibility gate for newer archive journals; older software must not open this schema.
].join(';');
