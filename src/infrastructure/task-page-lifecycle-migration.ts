// Preserve immutable per-plan evidence while allowing one native page to serve later plans.
export const taskPageLifecycleMigration = [
  'DROP TRIGGER immutable_task_tab_proof',
  'DROP TRIGGER retain_task_tab_proof',
  'CREATE TABLE task_tab_ownership_next(ownership_id TEXT NOT NULL,job_id TEXT NOT NULL REFERENCES task_plans(id),account_id TEXT NOT NULL,proof TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(ownership_id,job_id))',
  'INSERT INTO task_tab_ownership_next SELECT * FROM task_tab_ownership',
  "CREATE TABLE task_tab_state_next(ownership_id TEXT NOT NULL,job_id TEXT NOT NULL,profile_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('READY','RECHECK_REQUIRED','RELEASED','LOST','CLOSED')),revision INTEGER NOT NULL,context TEXT,reason TEXT NOT NULL,updated_at INTEGER NOT NULL,last_context TEXT,release_receipt TEXT,PRIMARY KEY(ownership_id,job_id),FOREIGN KEY(ownership_id,job_id) REFERENCES task_tab_ownership_next(ownership_id,job_id))",
  'INSERT INTO task_tab_state_next SELECT s.ownership_id,o.job_id,s.profile_id,s.state,s.revision,s.context,s.reason,s.updated_at,s.context,NULL FROM task_tab_state s JOIN task_tab_ownership o USING(ownership_id)',
  'DROP TABLE task_tab_state',
  'DROP TABLE task_tab_ownership',
  'ALTER TABLE task_tab_ownership_next RENAME TO task_tab_ownership',
  'ALTER TABLE task_tab_state_next RENAME TO task_tab_state',
  "CREATE TRIGGER immutable_task_tab_proof BEFORE UPDATE ON task_tab_ownership BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_TASK_TAB_PROOF'); END",
  "CREATE TRIGGER retain_task_tab_proof BEFORE DELETE ON task_tab_ownership BEGIN SELECT RAISE(ABORT, 'RETAIN_TASK_TAB_PROOF'); END",
  "CREATE UNIQUE INDEX one_active_task_tab_per_profile ON task_tab_state(profile_id) WHERE state IN ('READY','RECHECK_REQUIRED')",
  'CREATE INDEX task_tab_plan ON task_tab_ownership(job_id,created_at)',
  "INSERT INTO workspace_execution_contracts(name,version) VALUES('task-page-lifecycle',1)",
].join(';');
