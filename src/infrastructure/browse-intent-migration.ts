export const browseIntentMigration = [
  'CREATE TABLE task_browse_intents(operation_id TEXT PRIMARY KEY REFERENCES task_outbox(id),job_id TEXT NOT NULL REFERENCES task_plans(id),step_id TEXT NOT NULL REFERENCES task_steps(id),body TEXT NOT NULL,created_at INTEGER NOT NULL)',
  'CREATE INDEX task_browse_intent_job ON task_browse_intents(job_id,step_id)',
  "CREATE TRIGGER immutable_browse_intent BEFORE UPDATE ON task_browse_intents BEGIN SELECT RAISE(ABORT,'IMMUTABLE_BROWSE_INTENT'); END",
  "CREATE TRIGGER retain_browse_intent BEFORE DELETE ON task_browse_intents BEGIN SELECT RAISE(ABORT,'RETAIN_BROWSE_INTENT'); END",
].join(';');
