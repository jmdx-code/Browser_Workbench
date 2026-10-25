// Migration18 preserves business notices byte-for-byte, with a separate administrative category.
export const taskEndingMigration = [
  'ALTER TABLE task_plans ADD COLUMN ending_id TEXT',
  'ALTER TABLE task_plans ADD COLUMN ending_stop TEXT',
  'ALTER TABLE task_outbox ADD COLUMN disposition TEXT',
  "CREATE TABLE ending_notices(operation_id TEXT NOT NULL REFERENCES task_dispatch_bindings(operation_id),kind TEXT NOT NULL CHECK(kind IN ('BUSINESS','END')),profile_id TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(operation_id,kind))",
  "CREATE TABLE ending_delivery(operation_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('PENDING','SENDING','DELIVERED')),claim_token TEXT,attempts INTEGER NOT NULL,next_attempt_at INTEGER NOT NULL,reason TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(operation_id,kind),FOREIGN KEY(operation_id,kind) REFERENCES ending_notices(operation_id,kind))",
  "INSERT INTO ending_notices SELECT operation_id,'BUSINESS',profile_id,body,created_at FROM task_settlement_notices",
  "INSERT INTO ending_delivery SELECT operation_id,'BUSINESS',state,claim_token,attempts,next_attempt_at,reason,updated_at FROM task_settlement_delivery",
  'DROP TABLE task_settlement_delivery',
  'DROP TABLE task_settlement_notices',
  'ALTER TABLE ending_notices RENAME TO task_settlement_notices',
  'ALTER TABLE ending_delivery RENAME TO task_settlement_delivery',
  "CREATE TRIGGER immutable_settlement_notice BEFORE UPDATE ON task_settlement_notices BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SETTLEMENT_NOTICE'); END",
  "CREATE TRIGGER retain_settlement_notice BEFORE DELETE ON task_settlement_notices BEGIN SELECT RAISE(ABORT,'RETAIN_SETTLEMENT_NOTICE'); END",
].join(';');
