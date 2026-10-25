import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { taskStepOutcomeMigration } from '../src/infrastructure/task-step-outcome-migration.js';
import { workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import { settlementFixture, prepareBound } from './fixtures/settlement.js';
import { dropStepOutcomeSchema } from './fixtures/workspace-schema.js';

function legacyDb(file: string) {
  const db = new DatabaseSync(file);
  db.exec(dropStepOutcomeSchema + 'PRAGMA user_version=22');
  return db;
}

function applyCandidate(db: DatabaseSync) {
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(taskStepOutcomeMigration);
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw Error('STEP_MIGRATION_FOREIGN_KEY_FAILED');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
  }
}

test('migration23 preserves exact old rows, UNKNOWN and foreign keys', async () => {
  assert.ok(workspaceSchemaVersion >= 23);
  await settlementFixture(async (store, file) => {
    const f = await prepareBound(store);
    await store.tasks.markBoundUnknown(f.binding, 'RETAIN_ORIGINAL_UNKNOWN');
    const db = legacyDb(file);
    try {
      const before = db.prepare('SELECT * FROM task_steps').all();
      const operations = db
        .prepare('SELECT * FROM task_outbox')
        .all()
        .map((row) => ({ ...row }));
      const definitions = db
        .prepare(
          "SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT IN ('task_steps','task_plans','task_outbox','material_reservations','immutable_step_order','one_pending_operation_per_job','one_active_material_per_plan') ORDER BY name",
        )
        .all();
      applyCandidate(db);
      assert.deepEqual(
        db.prepare('SELECT id,job_id,round,position,spec,status,progress FROM task_steps').all(),
        before,
      );
      assert.deepEqual(
        db
          .prepare('SELECT * FROM task_outbox')
          .all()
          .map(({ control_ended, ...row }) => {
            assert.equal(control_ended, 0);
            return row;
          }),
        operations,
      );
      assert.deepEqual(
        db
          .prepare(
            "SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT IN ('task_steps','task_plans','task_outbox','material_reservations','immutable_step_order','immutable_terminal_step','one_pending_operation_per_job','one_active_material_per_plan','ended_operation_requires_step_stop','ended_material_requires_step_stop','new_operation_requires_active_control','new_material_requires_active_control') ORDER BY name",
          )
          .all(),
        definitions,
      );
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 22);
      assert.throws(
        () => db.prepare('UPDATE task_steps SET id=? WHERE id=?').run(randomUUID(), f.step.id),
        /IMMUTABLE_STEP_ORDER/,
      );
      // Raw UNKNOWN remains blocking; only the original stopped/disposed step can release it.
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO task_outbox(id,job_id,step_id,action,status,created_at,updated_at) VALUES(?,?,?,'{}','PREPARED',1,1)",
            )
            .run(randomUUID(), f.plan.id, f.step.id),
        /UNIQUE/,
      );
    } finally {
      db.close();
    }
  });
});

test('candidate database rejects status/outcome mismatches and reopening terminal steps', async () => {
  await settlementFixture(async (store, file) => {
    const f = await prepareBound(store),
      db = legacyDb(file);
    try {
      applyCandidate(db);
      for (const outcome of [
        null,
        '{}',
        'not-json',
        '{"version":2,"kind":"FAILED"}',
        '{"version":1,"kind":"SKIPPED"}',
      ]) {
        assert.throws(
          () =>
            db
              .prepare("UPDATE task_steps SET status='FAILED',outcome=? WHERE id=?")
              .run(outcome, f.step.id),
          /CHECK/,
        );
      }
      db.prepare("UPDATE task_steps SET status='FAILED',outcome=? WHERE id=?").run(
        '{"version":1,"kind":"FAILED"}',
        f.step.id,
      );
      assert.throws(
        () =>
          db
            .prepare("UPDATE task_steps SET status='ACTIVE',outcome=NULL WHERE id=?")
            .run(f.step.id),
        /IMMUTABLE_TERMINAL_STEP/,
      );
      assert.throws(
        () => db.prepare("UPDATE task_steps SET progress='{}' WHERE id=?").run(f.step.id),
        /IMMUTABLE_TERMINAL_STEP/,
      );
      assert.throws(
        () =>
          db
            .prepare('UPDATE task_steps SET outcome=? WHERE id=?')
            .run('{"version":1,"kind":"FAILED","changed":true}', f.step.id),
        /IMMUTABLE_TERMINAL_STEP/,
      );
      db.prepare(
        'UPDATE task_steps SET status=status,progress=progress,outcome=outcome WHERE id=?',
      ).run(f.step.id);
      db.prepare(
        'INSERT INTO task_steps(id,job_id,round,position,spec,status,progress) VALUES(?,?,1,1,?,?,?)',
      ).run(
        randomUUID(),
        f.plan.id,
        JSON.stringify(f.step.spec),
        'COMPLETED',
        JSON.stringify(f.step.progress),
      );
      assert.throws(
        () =>
          db
            .prepare("UPDATE task_steps SET status='ACTIVE' WHERE job_id=? AND position=1")
            .run(f.plan.id),
        /IMMUTABLE_TERMINAL_STEP/,
      );
    } finally {
      db.close();
    }
  });
});

test('candidate rebuild rolls back if a retained foreign-key violation is discovered', async () => {
  await settlementFixture(async (store, file) => {
    await prepareBound(store);
    const db = legacyDb(file);
    try {
      db.exec('PRAGMA foreign_keys=OFF');
      db.prepare('INSERT INTO task_account_locks(account_id,job_id) VALUES(?,?)').run(
        'broken-fixture',
        randomUUID(),
      );
      const original = db.prepare("SELECT sql FROM sqlite_master WHERE name='task_steps'").get();
      const rows = db.prepare('SELECT * FROM task_steps').all();
      assert.throws(() => applyCandidate(db), /STEP_MIGRATION_FOREIGN_KEY_FAILED/);
      assert.deepEqual(
        db.prepare("SELECT sql FROM sqlite_master WHERE name='task_steps'").get(),
        original,
      );
      assert.deepEqual(db.prepare('SELECT * FROM task_steps').all(), rows);
      assert.equal(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('task_steps_next','immutable_terminal_step')",
          )
          .all().length,
        0,
      );
      assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
    } finally {
      db.close();
    }
  });
});
