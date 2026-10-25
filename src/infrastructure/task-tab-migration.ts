// Append-only migration 4. Original plan/proof association is retained even when the tab is lost.
export const taskTabMigration = [
  'CREATE TABLE task_tab_ownership(ownership_id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES task_plans(id),account_id TEXT NOT NULL,proof TEXT NOT NULL,created_at INTEGER NOT NULL)',
  "CREATE TRIGGER immutable_task_tab_proof BEFORE UPDATE ON task_tab_ownership BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_TASK_TAB_PROOF'); END",
  "CREATE TRIGGER retain_task_tab_proof BEFORE DELETE ON task_tab_ownership BEGIN SELECT RAISE(ABORT, 'RETAIN_TASK_TAB_PROOF'); END",
  "CREATE TABLE task_tab_state(ownership_id TEXT PRIMARY KEY REFERENCES task_tab_ownership(ownership_id),profile_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('READY','RECHECK_REQUIRED','LOST','CLOSED')),revision INTEGER NOT NULL,context TEXT,reason TEXT NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE UNIQUE INDEX one_active_task_tab_per_profile ON task_tab_state(profile_id) WHERE state IN ('READY','RECHECK_REQUIRED')",
].join(';');
