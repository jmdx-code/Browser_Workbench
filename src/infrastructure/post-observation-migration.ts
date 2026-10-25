// Appended compatibility gate15. All shipped migrations1..14 remain byte-for-byte unchanged.
export const postObservationMigration = [
  'CREATE TABLE workspace_execution_contracts(name TEXT PRIMARY KEY,version INTEGER NOT NULL)',
  ...[
    'resource-post-intent',
    'composer-advance',
    'public-drive-cache',
    'reference-archive-plan',
    'submission-baseline',
  ].map((name) => `INSERT INTO workspace_execution_contracts VALUES('${name}',1)`),
  'CREATE TABLE facebook_submission_observations(operation_id TEXT PRIMARY KEY REFERENCES material_post_operations(operation_id),attempt_id TEXT NOT NULL REFERENCES material_post_intents(attempt_id),body TEXT NOT NULL,created_at INTEGER NOT NULL)',
  'CREATE TABLE facebook_submission_results(operation_id TEXT PRIMARY KEY REFERENCES facebook_submission_observations(operation_id),body TEXT NOT NULL,created_at INTEGER NOT NULL)',
  "CREATE TRIGGER immutable_facebook_submission_result BEFORE UPDATE ON facebook_submission_results BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SUBMISSION_RESULT'); END",
  "CREATE TRIGGER retain_facebook_submission_result BEFORE DELETE ON facebook_submission_results BEGIN SELECT RAISE(ABORT,'RETAIN_SUBMISSION_RESULT'); END",
  "CREATE TRIGGER original_submission_result BEFORE INSERT ON facebook_submission_results WHEN NOT EXISTS(SELECT 1 FROM task_outbox WHERE id=NEW.operation_id AND status IN ('DISPATCHING','ACKNOWLEDGED')) BEGIN SELECT RAISE(ABORT,'ORIGINAL_PENDING_SUBMISSION_REQUIRED'); END",
  "CREATE TRIGGER immutable_facebook_submission_observation BEFORE UPDATE ON facebook_submission_observations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SUBMISSION_OBSERVATION'); END",
  "CREATE TRIGGER retain_facebook_submission_observation BEFORE DELETE ON facebook_submission_observations BEGIN SELECT RAISE(ABORT,'RETAIN_SUBMISSION_OBSERVATION'); END",
  "CREATE TRIGGER original_submission_observation BEFORE INSERT ON facebook_submission_observations WHEN NOT EXISTS(SELECT 1 FROM material_post_operations p JOIN task_outbox o ON o.id=p.operation_id JOIN material_reservations r USING(attempt_id) WHERE p.operation_id=NEW.operation_id AND p.attempt_id=NEW.attempt_id AND p.purpose='SUBMIT' AND o.status='DISPATCHING' AND r.state='RESERVED') BEGIN SELECT RAISE(ABORT,'ORIGINAL_ACTIVE_SUBMISSION_REQUIRED'); END",
].join(';');
