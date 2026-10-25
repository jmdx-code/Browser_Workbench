// Append-only migration 3. Migration 2 has already shipped to live user data.
export const taskExecutionMigration = [
  'CREATE TABLE task_dispatch_bindings(operation_id TEXT PRIMARY KEY REFERENCES task_outbox(id),body TEXT NOT NULL,created_at INTEGER NOT NULL)',
  "CREATE TRIGGER immutable_dispatch_binding BEFORE UPDATE ON task_dispatch_bindings BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_DISPATCH_BINDING'); END",
  "CREATE TRIGGER retain_dispatch_binding BEFORE DELETE ON task_dispatch_bindings BEGIN SELECT RAISE(ABORT, 'RETAIN_DISPATCH_BINDING'); END",
].join(';');
