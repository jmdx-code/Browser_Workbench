// Rebuildable read projection only. Original task/operation/event rows remain authoritative.
export const taskRecordMigration = `
CREATE INDEX task_plans_profile_history ON task_plans(profile_id,created_at,id);
CREATE INDEX task_plans_batch_lookup ON task_plans(batch_id);
CREATE INDEX task_events_step_lookup ON task_events(job_id,json_extract(detail,'$.stepId'),sequence);
CREATE INDEX task_events_round_lookup ON task_events(job_id,type,json_extract(detail,'$.round'),sequence);
CREATE INDEX task_outbox_step_lookup ON task_outbox(step_id,created_at,updated_at);
CREATE TABLE task_record_dirty(job_id TEXT NOT NULL REFERENCES task_plans(id) ON DELETE CASCADE,round INTEGER NOT NULL,PRIMARY KEY(job_id,round));
CREATE TABLE task_record_projection(
step_id TEXT PRIMARY KEY REFERENCES task_steps(id) ON DELETE CASCADE,job_id TEXT NOT NULL REFERENCES task_plans(id) ON DELETE CASCADE,
round INTEGER NOT NULL,position INTEGER NOT NULL,profile_id TEXT NOT NULL,combination_name TEXT NOT NULL,type TEXT NOT NULL,destination TEXT NOT NULL,
status TEXT NOT NULL,outcome_kind TEXT,business_unknown INTEGER NOT NULL,payload TEXT NOT NULL,created_at REAL NOT NULL,id_order TEXT NOT NULL,
ls REAL,lsu INTEGER NOT NULL,lf REAL,lfu INTEGER NOT NULL,es REAL,esu INTEGER NOT NULL,ef REAL,efu INTEGER NOT NULL,
stable_sort REAL
);
CREATE INDEX task_record_order ON task_record_projection(stable_sort DESC,created_at DESC,round DESC,position DESC,id_order DESC);
CREATE INDEX task_record_profile ON task_record_projection(profile_id,stable_sort DESC,created_at DESC,round DESC,position DESC,id_order DESC);
CREATE INDEX task_record_job_round ON task_record_projection(job_id,round);
CREATE INDEX task_record_status ON task_record_projection(status,profile_id,job_id);
CREATE INDEX task_record_unknown ON task_record_projection(business_unknown) WHERE business_unknown=1;
CREATE INDEX task_record_tuples ON task_record_projection(combination_name,profile_id,type,destination);
CREATE TRIGGER task_record_step_insert AFTER INSERT ON task_steps BEGIN INSERT OR IGNORE INTO task_record_dirty VALUES(NEW.job_id,NEW.round); END;
CREATE TRIGGER task_record_step_update AFTER UPDATE ON task_steps BEGIN INSERT OR IGNORE INTO task_record_dirty VALUES(NEW.job_id,NEW.round); END;
CREATE TRIGGER task_record_step_delete AFTER DELETE ON task_steps BEGIN INSERT OR IGNORE INTO task_record_dirty VALUES(OLD.job_id,OLD.round); END;
CREATE TRIGGER task_record_event_insert AFTER INSERT ON task_events BEGIN
INSERT OR IGNORE INTO task_record_dirty SELECT job_id,round FROM task_steps WHERE job_id=NEW.job_id AND id=json_extract(NEW.detail,'$.stepId');
INSERT OR IGNORE INTO task_record_dirty SELECT job_id,round FROM task_steps WHERE job_id=NEW.job_id AND NEW.type='RUNNING' AND (SELECT count(*) FROM task_events WHERE job_id=NEW.job_id AND type='RUNNING')=1;
INSERT OR IGNORE INTO task_record_dirty SELECT job_id,round FROM task_steps WHERE job_id=NEW.job_id AND NEW.type='ROUND_CREATED' AND round=json_extract(NEW.detail,'$.round');
END;
CREATE TRIGGER task_record_event_delete AFTER DELETE ON task_events BEGIN
INSERT OR IGNORE INTO task_record_dirty SELECT job_id,round FROM task_steps WHERE job_id=OLD.job_id AND (id=json_extract(OLD.detail,'$.stepId') OR OLD.type IN ('RUNNING','ROUND_CREATED'));
END;
CREATE TRIGGER task_record_event_update AFTER UPDATE ON task_events BEGIN
INSERT OR IGNORE INTO task_record_dirty SELECT job_id,round FROM task_steps WHERE job_id=NEW.job_id AND (id=json_extract(NEW.detail,'$.stepId') OR id=json_extract(OLD.detail,'$.stepId') OR NEW.type IN ('RUNNING','ROUND_CREATED') OR OLD.type IN ('RUNNING','ROUND_CREATED'));
END;
CREATE TRIGGER task_record_outbox_insert AFTER INSERT ON task_outbox BEGIN INSERT OR IGNORE INTO task_record_dirty SELECT job_id,round FROM task_steps WHERE id=NEW.step_id; END;
CREATE TRIGGER task_record_outbox_update AFTER UPDATE ON task_outbox BEGIN INSERT OR IGNORE INTO task_record_dirty SELECT job_id,round FROM task_steps WHERE id=NEW.step_id; END;
CREATE TRIGGER task_record_outbox_delete AFTER DELETE ON task_outbox BEGIN INSERT OR IGNORE INTO task_record_dirty SELECT job_id,round FROM task_steps WHERE id=OLD.step_id; END;
CREATE TRIGGER task_record_plan_time_update AFTER UPDATE OF state,updated_at ON task_plans BEGIN
UPDATE task_record_projection SET stable_sort=CASE
WHEN NEW.state IN ('STOPPED','COMPLETED','FAILED') THEN coalesce(CASE WHEN efu=0 THEN ef WHEN ef IS NULL THEN NEW.updated_at ELSE min(ef,NEW.updated_at) END,CASE WHEN esu=0 THEN es WHEN es IS NULL THEN NEW.updated_at ELSE min(es,NEW.updated_at) END,created_at)
WHEN lsu=0 AND lfu=0 AND esu=0 AND efu=0 AND ls IS es AND lf IS ef THEN coalesce(lf,ls,created_at)
ELSE NULL END
WHERE job_id=NEW.id AND (OLD.state<>NEW.state OR stable_sort IS NULL OR esu=1 OR efu=1);
END;
INSERT INTO task_record_dirty SELECT DISTINCT job_id,round FROM task_steps;
`;
