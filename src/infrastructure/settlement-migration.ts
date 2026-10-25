// Migration 5 is append-only. Native input outbox is not reused for notification retries.
export const settlementMigration = [
  'CREATE TABLE task_settlement_notices(operation_id TEXT PRIMARY KEY REFERENCES task_dispatch_bindings(operation_id),profile_id TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL)',
  "CREATE TRIGGER immutable_settlement_notice BEFORE UPDATE ON task_settlement_notices BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SETTLEMENT_NOTICE'); END",
  "CREATE TRIGGER retain_settlement_notice BEFORE DELETE ON task_settlement_notices BEGIN SELECT RAISE(ABORT,'RETAIN_SETTLEMENT_NOTICE'); END",
  "CREATE TABLE task_settlement_delivery(operation_id TEXT PRIMARY KEY REFERENCES task_settlement_notices(operation_id),state TEXT NOT NULL CHECK(state IN ('PENDING','SENDING','DELIVERED')),claim_token TEXT,attempts INTEGER NOT NULL,next_attempt_at INTEGER NOT NULL,reason TEXT NOT NULL,updated_at INTEGER NOT NULL)",
].join(';');
