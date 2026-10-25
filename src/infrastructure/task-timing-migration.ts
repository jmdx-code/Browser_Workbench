export const taskTimingMigration = `
CREATE TABLE task_batch_timing(batch_id TEXT PRIMARY KEY REFERENCES task_batches(id),body TEXT NOT NULL);
CREATE TRIGGER immutable_task_batch_timing BEFORE UPDATE ON task_batch_timing BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TASK_BATCH_TIMING'); END;
CREATE TRIGGER retain_task_batch_timing BEFORE DELETE ON task_batch_timing BEGIN SELECT RAISE(ABORT,'RETAIN_TASK_BATCH_TIMING'); END;
INSERT INTO workspace_execution_contracts VALUES('task-timing',1);
INSERT INTO workspace_execution_contracts VALUES('scroll-content-baseline',1);
`;
