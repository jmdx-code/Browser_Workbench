export const taskControlMigration = [
  'CREATE TABLE task_control_bindings(request_id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES task_plans(id),profile_id TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL)',
  'CREATE INDEX task_control_profile ON task_control_bindings(profile_id,created_at)',
  "CREATE TRIGGER immutable_task_control_binding BEFORE UPDATE ON task_control_bindings BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_TASK_CONTROL_BINDING'); END",
  "CREATE TRIGGER retain_task_control_binding BEFORE DELETE ON task_control_bindings BEGIN SELECT RAISE(ABORT, 'RETAIN_TASK_CONTROL_BINDING'); END",
  'CREATE TABLE task_control_receipts(request_id TEXT PRIMARY KEY REFERENCES task_control_bindings(request_id),body TEXT NOT NULL,created_at INTEGER NOT NULL)',
  "CREATE TRIGGER immutable_task_control_receipt BEFORE UPDATE ON task_control_receipts BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_TASK_CONTROL_RECEIPT'); END",
  "CREATE TRIGGER retain_task_control_receipt BEFORE DELETE ON task_control_receipts BEGIN SELECT RAISE(ABORT, 'RETAIN_TASK_CONTROL_RECEIPT'); END",
].join(';');
