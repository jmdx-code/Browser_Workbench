// Extend the existing step-ending proof to a whole, durably stopped task.
// UNKNOWN and its exact-content reservation remain; only execution control ends.
export const taskSessionEndMigration = `
DROP TRIGGER ended_operation_requires_step_stop;
CREATE TRIGGER ended_operation_requires_step_stop BEFORE UPDATE OF control_ended ON task_outbox
WHEN NEW.control_ended<>OLD.control_ended AND (OLD.control_ended=1 OR
 NEW.status<>'UNKNOWN' OR NEW.disposition IS NULL OR NOT EXISTS(
  SELECT 1 FROM task_steps s JOIN task_plans p ON p.id=s.job_id
  JOIN task_settlement_notices n ON n.operation_id=NEW.id AND n.kind='END'
  JOIN task_settlement_delivery d ON d.operation_id=n.operation_id AND d.kind=n.kind
  WHERE s.id=NEW.step_id AND s.job_id=NEW.job_id
   AND ((s.status='FAILED' AND p.ending_finished=1 AND p.ending_step_id=s.id
     AND json_extract(s.outcome,'$.endingId')=p.ending_id
     AND json_extract(s.outcome,'$.currentStop.requestId')=p.ending_id
     AND json_extract(s.outcome,'$.currentStop.profileId')=p.profile_id
     AND json_extract(s.outcome,'$.currentStop.state')='stopped')
    OR (p.state IN ('STOPPED','FAILED') AND p.ending_step_id IS NULL
     AND json_extract(p.ending_stop,'$.requestId')=p.ending_id
     AND json_extract(p.ending_stop,'$.profileId')=p.profile_id
     AND json_extract(p.ending_stop,'$.state')='stopped'))
   AND d.state='DELIVERED' AND n.profile_id=p.profile_id
   AND json_extract(n.body,'$.binding.operationId')=NEW.id
   AND json_extract(n.body,'$.binding.jobId')=NEW.job_id
   AND json_extract(n.body,'$.binding.stepId')=NEW.step_id
   AND json_extract(n.body,'$.resolution.id')=json_extract(NEW.disposition,'$.id')
   AND json_extract(n.body,'$.resolution.evidenceDigest')=json_extract(NEW.disposition,'$.evidenceDigest')
 )) BEGIN SELECT RAISE(ABORT,'STEP_END_STOP_AND_NOTICE_REQUIRED'); END;
DROP TRIGGER ended_material_requires_step_stop;
CREATE TRIGGER ended_material_requires_step_stop BEFORE UPDATE OF control_ended ON material_reservations
WHEN NEW.control_ended<>OLD.control_ended AND (OLD.control_ended=1 OR NEW.state<>'REVIEW' OR NOT EXISTS(
 SELECT 1 FROM material_post_intents i JOIN task_steps s ON s.id=i.step_id JOIN task_plans p ON p.id=s.job_id
 WHERE i.attempt_id=NEW.attempt_id AND p.id=NEW.job_id
  AND ((p.ending_step_id=s.id AND p.ending_finished=1 AND s.status='FAILED'
    AND json_extract(s.outcome,'$.endingId')=p.ending_id
    AND json_extract(s.outcome,'$.currentStop.requestId')=p.ending_id
    AND json_extract(s.outcome,'$.currentStop.profileId')=p.profile_id
    AND json_extract(s.outcome,'$.currentStop.state')='stopped')
   OR (p.state IN ('STOPPED','FAILED') AND p.ending_step_id IS NULL
    AND json_extract(p.ending_stop,'$.requestId')=p.ending_id
    AND json_extract(p.ending_stop,'$.profileId')=p.profile_id
    AND json_extract(p.ending_stop,'$.state')='stopped'))
 )) BEGIN SELECT RAISE(ABORT,'MATERIAL_END_STEP_STOP_REQUIRED'); END;
`;
