// Disposable one-row-per-profile display projection, never execution authority.
export const profileTaskResultMigration = `
CREATE TABLE profile_task_results(
 profile_id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK(source IN ('task','group-inviter')),
 run_id TEXT NOT NULL, name TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('COMPLETED','FAILED','STOPPED')),
 reason TEXT NOT NULL, finished_at INTEGER NOT NULL, failed_steps INTEGER NOT NULL DEFAULT 0, skipped_steps INTEGER NOT NULL DEFAULT 0
);
INSERT INTO profile_task_results
 SELECT p.profile_id,'task',p.id,json_extract(p.snapshot,'$.name'),p.state,p.reason,e.created_at,
 (SELECT count(*) FROM task_steps WHERE job_id=p.id AND json_extract(outcome,'$.kind')='FAILED'),
 (SELECT count(*) FROM task_steps WHERE job_id=p.id AND json_extract(outcome,'$.kind')='SKIPPED')
 FROM task_plans p JOIN task_events e ON e.job_id=p.id
 WHERE e.sequence IN (
  SELECT max(e2.sequence) FROM task_events e2 JOIN task_plans p2 ON p2.id=e2.job_id
  WHERE e2.type IN ('COMPLETED','FAILED','STOPPED') AND p2.state IN ('COMPLETED','FAILED','STOPPED')
  GROUP BY p2.profile_id
 );
CREATE TRIGGER profile_task_result_terminal AFTER INSERT ON task_events
 WHEN NEW.type IN ('COMPLETED','FAILED','STOPPED') BEGIN
 INSERT INTO profile_task_results
  SELECT profile_id,'task',id,json_extract(snapshot,'$.name'),state,reason,NEW.created_at,
   (SELECT count(*) FROM task_steps WHERE job_id=NEW.job_id AND json_extract(outcome,'$.kind')='FAILED'),
   (SELECT count(*) FROM task_steps WHERE job_id=NEW.job_id AND json_extract(outcome,'$.kind')='SKIPPED')
  FROM task_plans WHERE id=NEW.job_id AND state IN ('COMPLETED','FAILED','STOPPED')
 ON CONFLICT(profile_id) DO UPDATE SET source=excluded.source,run_id=excluded.run_id,
 name=excluded.name,state=excluded.state,reason=excluded.reason,finished_at=excluded.finished_at,failed_steps=excluded.failed_steps,skipped_steps=excluded.skipped_steps;
END;
`;
