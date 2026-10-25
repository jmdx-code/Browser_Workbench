// Migration23 extends the original ending/outbox chain. Rebuild with foreign keys
// disabled outside the transaction, then check all retained links before commit.
export const taskStepOutcomeMigration = [
  `CREATE TABLE task_steps_next(
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES task_plans(id),
    round INTEGER NOT NULL CHECK(round>0),
    position INTEGER NOT NULL CHECK(position>=0),
    spec TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('PENDING','ACTIVE','COMPLETED','FAILED','SKIPPED')),
    progress TEXT NOT NULL,
    outcome TEXT,
    UNIQUE(job_id,round,position),
    CHECK(CASE WHEN status IN ('FAILED','SKIPPED') THEN
      CASE WHEN outcome IS NOT NULL AND json_valid(outcome) THEN
        COALESCE(json_extract(outcome,'$.version')=1 AND json_extract(outcome,'$.kind')=status,0)
      ELSE 0 END
    ELSE outcome IS NULL END)
  )`,
  'INSERT INTO task_steps_next(id,job_id,round,position,spec,status,progress) SELECT id,job_id,round,position,spec,status,progress FROM task_steps',
  'DROP TABLE task_steps',
  'ALTER TABLE task_steps_next RENAME TO task_steps',
  "CREATE TRIGGER immutable_step_order BEFORE UPDATE OF id,job_id,round,position,spec ON task_steps BEGIN SELECT RAISE(ABORT,'IMMUTABLE_STEP_ORDER'); END",
  `CREATE TRIGGER immutable_terminal_step BEFORE UPDATE OF status,progress,outcome ON task_steps
    WHEN OLD.status IN ('COMPLETED','FAILED','SKIPPED') AND
      (NEW.status IS NOT OLD.status OR NEW.progress IS NOT OLD.progress OR NEW.outcome IS NOT OLD.outcome)
    BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TERMINAL_STEP'); END`,
  'ALTER TABLE task_plans ADD COLUMN ending_step_id TEXT REFERENCES task_steps(id)',
  'ALTER TABLE task_plans ADD COLUMN ending_step_reason TEXT',
  'ALTER TABLE task_plans ADD COLUMN ending_finished INTEGER NOT NULL DEFAULT 0 CHECK(ending_finished IN (0,1))',
  'ALTER TABLE task_outbox ADD COLUMN control_ended INTEGER NOT NULL DEFAULT 0 CHECK(control_ended IN (0,1))',
  'ALTER TABLE material_reservations ADD COLUMN control_ended INTEGER NOT NULL DEFAULT 0 CHECK(control_ended IN (0,1))',
  "CREATE TRIGGER new_operation_requires_active_control BEFORE INSERT ON task_outbox WHEN NEW.control_ended<>0 BEGIN SELECT RAISE(ABORT,'NEW_OPERATION_CONTROL_ENDED'); END",
  "CREATE TRIGGER new_material_requires_active_control BEFORE INSERT ON material_reservations WHEN NEW.control_ended<>0 BEGIN SELECT RAISE(ABORT,'NEW_MATERIAL_CONTROL_ENDED'); END",
  'DROP INDEX one_active_material_per_plan',
  "CREATE UNIQUE INDEX one_active_material_per_plan ON material_reservations(job_id) WHERE state IN ('RESERVED','REVIEW') AND control_ended=0",
  `CREATE TRIGGER ended_material_requires_step_stop BEFORE UPDATE OF control_ended ON material_reservations
    WHEN NEW.control_ended<>OLD.control_ended AND (OLD.control_ended=1 OR NEW.state<>'REVIEW' OR NOT EXISTS(
      SELECT 1 FROM material_post_intents i JOIN task_steps s ON s.id=i.step_id JOIN task_plans p ON p.id=s.job_id
      WHERE i.attempt_id=NEW.attempt_id AND p.id=NEW.job_id AND p.ending_step_id=s.id
        AND p.ending_finished=1 AND s.status='FAILED'
        AND json_extract(s.outcome,'$.endingId')=p.ending_id
        AND json_extract(s.outcome,'$.currentStop.requestId')=p.ending_id
        AND json_extract(s.outcome,'$.currentStop.profileId')=p.profile_id
        AND json_extract(s.outcome,'$.currentStop.state')='stopped'
    )) BEGIN SELECT RAISE(ABORT,'MATERIAL_END_STEP_STOP_REQUIRED'); END`,
  'DROP INDEX one_pending_operation_per_job',
  "CREATE UNIQUE INDEX one_pending_operation_per_job ON task_outbox(job_id) WHERE status IN ('PREPARED','DISPATCHING','ACKNOWLEDGED') OR (status='UNKNOWN' AND control_ended=0)",
  `CREATE TRIGGER ended_operation_requires_step_stop BEFORE UPDATE OF control_ended ON task_outbox
    WHEN NEW.control_ended<>OLD.control_ended AND (OLD.control_ended=1 OR
      NEW.status<>'UNKNOWN' OR NEW.disposition IS NULL OR NOT EXISTS(
        SELECT 1 FROM task_steps s JOIN task_plans p ON p.id=s.job_id
        JOIN task_settlement_notices n ON n.operation_id=NEW.id AND n.kind='END'
        JOIN task_settlement_delivery d ON d.operation_id=n.operation_id AND d.kind=n.kind
        WHERE s.id=NEW.step_id AND s.job_id=NEW.job_id AND s.status='FAILED'
          AND p.ending_finished=1 AND p.ending_step_id=s.id
          AND json_extract(s.outcome,'$.endingId')=p.ending_id
          AND json_extract(s.outcome,'$.currentStop.requestId')=p.ending_id
          AND json_extract(s.outcome,'$.currentStop.profileId')=p.profile_id
          AND json_extract(s.outcome,'$.currentStop.state')='stopped'
          AND d.state='DELIVERED'
          AND n.profile_id=p.profile_id
          AND json_extract(n.body,'$.binding.operationId')=NEW.id
          AND json_extract(n.body,'$.binding.jobId')=NEW.job_id
          AND json_extract(n.body,'$.binding.stepId')=NEW.step_id
          AND json_extract(n.body,'$.resolution.id')=json_extract(NEW.disposition,'$.id')
          AND json_extract(n.body,'$.resolution.evidenceDigest')=json_extract(NEW.disposition,'$.evidenceDigest')
      )) BEGIN SELECT RAISE(ABORT,'STEP_END_STOP_AND_NOTICE_REQUIRED'); END`,
].join(';');
