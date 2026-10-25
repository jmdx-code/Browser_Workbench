import { workspaceSchemaVersion } from '../../src/infrastructure/workspace-store.js';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { settlementMigration } from '../../src/infrastructure/settlement-migration.js';
import { taskEndingMigration } from '../../src/infrastructure/task-ending-migration.js';
import { materialPostMigration } from '../../src/infrastructure/material-post-migration.js';
import { materialUsageMigration } from '../../src/infrastructure/material-usage-migration.js';
import { taskMigration } from '../../src/infrastructure/task-migration.js';
import { taskStepOutcomeMigration } from '../../src/infrastructure/task-step-outcome-migration.js';
import { taskCapacityMigration } from '../../src/infrastructure/task-capacity-migration.js';
import { physicalHistoryCleanupMigration } from '../../src/infrastructure/data-cleanup-store.js';
export const latestMigrationBackupMarker = '.before-v' + workspaceSchemaVersion + '-';
// Generated downgrade fixtures only; never product databases or retained audit evidence.
export const dropPhysicalCleanupSchema = [
  ['retain_browse_intent', 'task_browse_intents', 'RETAIN_BROWSE_INTENT'],
  ['retain_dispatch_binding', 'task_dispatch_bindings', 'RETAIN_DISPATCH_BINDING'],
  ['retain_settlement_notice', 'task_settlement_notices', 'RETAIN_SETTLEMENT_NOTICE'],
  ['retain_task_control_binding', 'task_control_bindings', 'RETAIN_TASK_CONTROL_BINDING'],
  ['retain_task_control_receipt', 'task_control_receipts', 'RETAIN_TASK_CONTROL_RECEIPT'],
  ['retain_task_tab_proof', 'task_tab_ownership', 'RETAIN_TASK_TAB_PROOF'],
]
  .map(
    ([name, table, error]) =>
      `DROP TRIGGER IF EXISTS ${name};CREATE TRIGGER ${name} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'${error}'); END;`,
  )
  .join('');
export const dropReleasePolishSchema =
  dropPhysicalCleanupSchema +
  'DROP TRIGGER IF EXISTS profile_task_result_terminal;DROP TABLE IF EXISTS profile_task_results;ALTER TABLE group_inviter_logs DROP COLUMN operation_id;ALTER TABLE group_inviter_logs DROP COLUMN confirmation;';
export const dropDataCleanupSchema =
  dropReleasePolishSchema +
  'ALTER TABLE workspace_preferences DROP COLUMN window_layout;DROP TABLE IF EXISTS task_record_deletions;DROP TABLE IF EXISTS data_cleanup_settings;DROP INDEX IF EXISTS task_plans_cleanup;';
export const dropVideoDerivationSchema =
  dropDataCleanupSchema +
  "DELETE FROM workspace_execution_contracts WHERE name='task-capacity';" +
  "DROP TRIGGER IF EXISTS task_record_plan_time_update;DROP TRIGGER IF EXISTS task_record_step_insert;DROP TRIGGER IF EXISTS task_record_step_update;DROP TRIGGER IF EXISTS task_record_step_delete;DROP TRIGGER IF EXISTS task_record_event_insert;DROP TRIGGER IF EXISTS task_record_event_update;DROP TRIGGER IF EXISTS task_record_event_delete;DROP TRIGGER IF EXISTS task_record_outbox_insert;DROP TRIGGER IF EXISTS task_record_outbox_update;DROP TRIGGER IF EXISTS task_record_outbox_delete;DROP TABLE IF EXISTS task_record_projection;DROP TABLE IF EXISTS task_record_dirty;DROP INDEX IF EXISTS task_plans_profile_history;DROP INDEX IF EXISTS task_plans_batch_lookup;DROP INDEX IF EXISTS task_events_step_lookup;DROP INDEX IF EXISTS task_events_round_lookup;DROP INDEX IF EXISTS task_outbox_step_lookup;DELETE FROM workspace_execution_contracts WHERE name='story-video-derived-media';";
export const dropAILabelSchema =
  dropVideoDerivationSchema +
  "DROP INDEX IF EXISTS one_original_post_ai_open; DROP INDEX IF EXISTS one_original_post_ai_set; DROP INDEX IF EXISTS one_original_post_ai_confirm; DELETE FROM workspace_execution_contracts WHERE name='post-ai-label';";
export const dropStoryPrivacySchema =
  dropAILabelSchema +
  "DROP INDEX IF EXISTS one_original_story_friends; DROP INDEX IF EXISTS one_original_story_audience_check; DROP INDEX IF EXISTS one_original_story_audience_close; DELETE FROM workspace_execution_contracts WHERE name='story-friends-privacy';";
// Keep trigger bodies intact: their BEGIN/CASE statements contain internal semicolons.
const statements = (sql: string) => sql.split(/;(?=(?:CREATE|DROP|ALTER|INSERT|UPDATE|PRAGMA)\b)/);
const legacyStepTable = statements(taskMigration).find((sql) =>
  sql.startsWith('CREATE TABLE task_steps('),
);
const legacyStepOrder = statements(taskMigration).find((sql) =>
  sql.startsWith('CREATE TRIGGER immutable_step_order '),
);
assert.ok(legacyStepTable && legacyStepOrder);
export const dropStepOutcomeSchema =
  dropStoryPrivacySchema +
  "DROP INDEX IF EXISTS one_original_post_background; DELETE FROM workspace_execution_contracts WHERE name='post-native-background';" +
  'DROP TABLE IF EXISTS workspace_preferences;' +
  "DELETE FROM workspace_execution_contracts WHERE name='browse-wheel-visual-anchor';" +
  "DELETE FROM workspace_execution_contracts WHERE name='task-page-lifecycle';" +
  "DELETE FROM workspace_execution_contracts WHERE name='post-home-preparation';" +
  'PRAGMA foreign_keys=OFF;DROP TRIGGER immutable_terminal_step;DROP TRIGGER ended_operation_requires_step_stop;DROP TRIGGER ended_material_requires_step_stop;DROP TRIGGER new_operation_requires_active_control;DROP TRIGGER new_material_requires_active_control;DROP TRIGGER immutable_step_order;' +
  'ALTER TABLE task_plans DROP COLUMN ending_step_id;ALTER TABLE task_plans DROP COLUMN ending_step_reason;ALTER TABLE task_plans DROP COLUMN ending_finished;' +
  'DROP INDEX one_pending_operation_per_job;ALTER TABLE task_outbox DROP COLUMN control_ended;' +
  'DROP INDEX one_active_material_per_plan;ALTER TABLE material_reservations DROP COLUMN control_ended;' +
  legacyStepTable.replace('task_steps(', 'task_steps_legacy(') +
  ';' +
  'INSERT INTO task_steps_legacy SELECT id,job_id,round,position,spec,status,progress FROM task_steps;DROP TABLE task_steps;ALTER TABLE task_steps_legacy RENAME TO task_steps;' +
  legacyStepOrder +
  ';' +
  "CREATE UNIQUE INDEX one_pending_operation_per_job ON task_outbox(job_id) WHERE status IN ('PREPARED','DISPATCHING','ACKNOWLEDGED','UNKNOWN');" +
  "CREATE UNIQUE INDEX one_active_material_per_plan ON material_reservations(job_id) WHERE state IN ('RESERVED','REVIEW');PRAGMA foreign_keys=ON;";
// Generated test databases only. Never run against product data or retained evidence.
export const dropMaterialUsageSchema =
  dropStepOutcomeSchema +
  "DROP TABLE IF EXISTS task_batch_timing;DELETE FROM workspace_execution_contracts WHERE name IN ('task-timing','scroll-content-baseline');" +
  "DELETE FROM workspace_execution_contracts WHERE name IN ('marketplace-filters','publication-destination');" +
  "PRAGMA foreign_keys=OFF;DROP TRIGGER material_terminal_evidence_required;DROP INDEX one_active_material_per_resource;ALTER TABLE material_reservations DROP COLUMN usage_source_key;ALTER TABLE material_reservations DROP COLUMN allow_repeat;CREATE UNIQUE INDEX one_active_material_per_content ON material_reservations(fingerprint) WHERE state IN ('RESERVED','REVIEW');" +
  'CREATE TABLE publication_legacy_copy AS SELECT attempt_id,account_id,fingerprint,post_id,created_at FROM material_publications;' +
  'DROP TABLE material_publications;' +
  statements(materialPostMigration)
    .filter(
      (sql) =>
        sql.startsWith('CREATE TABLE material_publications(') ||
        sql.startsWith('CREATE INDEX material_publication_content ') ||
        sql.startsWith('CREATE TRIGGER immutable_material_publications ') ||
        sql.startsWith('CREATE TRIGGER retain_material_publications ') ||
        sql.startsWith('CREATE TRIGGER material_terminal_evidence_required '),
    )
    .join(';') +
  ';INSERT INTO material_publications SELECT * FROM publication_legacy_copy;DROP TABLE publication_legacy_copy;DROP TABLE material_usage_resets;DROP TABLE material_usage_policy;' +
  "DELETE FROM workspace_execution_contracts WHERE name='material-use-records';PRAGMA foreign_keys=ON;";
export const dropTaskEndingSchema =
  dropMaterialUsageSchema +
  "DELETE FROM workspace_execution_contracts WHERE name='marketplace-task';" +
  "CREATE TEMP TABLE ending_old_notices AS SELECT operation_id,profile_id,body,created_at FROM task_settlement_notices WHERE kind='BUSINESS';" +
  "CREATE TEMP TABLE ending_old_delivery AS SELECT operation_id,state,claim_token,attempts,next_attempt_at,reason,updated_at FROM task_settlement_delivery WHERE kind='BUSINESS';" +
  'DROP TABLE task_settlement_delivery;DROP TABLE task_settlement_notices;' +
  settlementMigration +
  ';' +
  'INSERT INTO task_settlement_notices SELECT * FROM ending_old_notices;INSERT INTO task_settlement_delivery SELECT * FROM ending_old_delivery;' +
  'DROP TABLE ending_old_notices;DROP TABLE ending_old_delivery;' +
  'ALTER TABLE task_plans DROP COLUMN ending_id;ALTER TABLE task_plans DROP COLUMN ending_stop;ALTER TABLE task_outbox DROP COLUMN disposition;';
export const dropArchiveExecutionSchema =
  dropTaskEndingSchema +
  "DELETE FROM workspace_execution_contracts WHERE name='owned-browse-actions';" +
  "DROP TRIGGER archive_completion_proof_required;DROP TRIGGER archive_completed_not_reopened;DROP TABLE material_archive_completions;DROP TABLE material_archive_source_locks;DROP TABLE material_archive_io_proofs;DROP TABLE material_archive_io;DROP TABLE material_archive_workers;CREATE TRIGGER archive_completion_not_implemented BEFORE UPDATE OF state ON material_archive_state WHEN NEW.state='COMPLETED' BEGIN SELECT RAISE(ABORT,'ARCHIVE_COMPLETION_NOT_IMPLEMENTED'); END;";
export const dropPostObservationSchema =
  dropArchiveExecutionSchema +
  'DROP TABLE facebook_submission_results;DROP TABLE facebook_submission_observations;DROP TABLE workspace_execution_contracts;';
export const dropTaskResourceSchema =
  dropPostObservationSchema + 'DROP TABLE task_resource_bindings;';
export const dropResourceTableSchema =
  dropTaskResourceSchema + 'DROP TABLE resource_table_heads;DROP TABLE resource_table_versions;';

// The one guard deliberately replaced by append-only migration16. All other original SQL
// definitions must remain byte-for-byte identical, rather than broadly ignoring triggers.
export function assertSchemaDefinitionPreserved(
  db: DatabaseSync,
  definition: Record<string, unknown>,
) {
  const actual = db
    .prepare('SELECT name,type,sql FROM sqlite_master WHERE name=?')
    .get(String(definition.name));
  const cleanupTrigger = statements(physicalHistoryCleanupMigration).find((sql) =>
    sql.startsWith('CREATE TRIGGER ' + String(definition.name) + ' '),
  );
  if (definition.type === 'trigger' && cleanupTrigger) {
    assert.ok(actual);
    assert.equal(actual.sql, cleanupTrigger);
  } else if (definition.name === 'one_active_material_per_content') {
    assert.equal(actual, undefined);
    const replacement = db
      .prepare("SELECT sql FROM sqlite_master WHERE name='one_active_material_per_resource'")
      .get();
    assert.match(String(replacement?.sql), /usage_source_key.*allow_repeat=0/);
  } else if (definition.name === 'material_reservations') {
    assert.ok(actual);
    assert.equal(
      String(actual.sql)
        .replace(', control_ended INTEGER NOT NULL DEFAULT 0 CHECK(control_ended IN (0,1))', '')
        .replace(
          ", usage_source_key TEXT NOT NULL DEFAULT '', allow_repeat INTEGER NOT NULL DEFAULT 0 CHECK(allow_repeat IN (0,1))",
          '',
        ),
      definition.sql,
    );
  } else if (
    definition.name === 'material_publications' ||
    definition.name === 'material_terminal_evidence_required' ||
    definition.name === 'material_publication_content'
  ) {
    assert.ok(actual);
    const prefix =
      definition.name === 'material_publications'
        ? 'CREATE TABLE publication_usage_new('
        : definition.name === 'material_terminal_evidence_required'
          ? 'CREATE TRIGGER material_terminal_evidence_required '
          : 'CREATE INDEX material_publication_content ';
    const expected = statements(materialUsageMigration).find((sql) => sql.startsWith(prefix));
    assert.ok(expected);
    assert.equal(
      String(actual.sql).replaceAll('"', ''),
      expected.replace('publication_usage_new', 'material_publications'),
    );
  } else if (definition.name === 'archive_completion_not_implemented') {
    assert.equal(actual, undefined);
    const guard = db
      .prepare("SELECT sql FROM sqlite_master WHERE name='archive_completion_proof_required'")
      .get();
    assert.match(String(guard?.sql), /NOT EXISTS\(SELECT 1 FROM material_archive_completions/);
  } else if (definition.name === 'task_plans' || definition.name === 'task_outbox') {
    assert.ok(actual);
    const suffix =
      definition.name === 'task_plans'
        ? ', ending_id TEXT, ending_stop TEXT'
        : ', disposition TEXT';
    const newSuffix =
      definition.name === 'task_plans'
        ? ', ending_step_id TEXT REFERENCES task_steps(id), ending_step_reason TEXT, ending_finished INTEGER NOT NULL DEFAULT 0 CHECK(ending_finished IN (0,1))'
        : ', control_ended INTEGER NOT NULL DEFAULT 0 CHECK(control_ended IN (0,1))';
    assert.deepEqual(
      { ...actual, sql: String(actual.sql).replace(newSuffix, '').replace(suffix, '') },
      { ...definition },
    );
  } else if (
    [
      'task_steps',
      'immutable_step_order',
      'one_pending_operation_per_job',
      'one_active_material_per_plan',
    ].includes(String(definition.name))
  ) {
    assert.ok(actual);
    const expected = statements(taskStepOutcomeMigration).find((sql) =>
      definition.name === 'task_steps'
        ? sql.startsWith('CREATE TABLE task_steps_next(')
        : sql.includes(' ' + String(definition.name) + ' '),
    );
    assert.ok(expected);
    assert.equal(
      String(actual.sql).replaceAll('"', ''),
      expected.replace('task_steps_next', 'task_steps'),
    );
  } else if (
    definition.name === 'task_settlement_notices' ||
    definition.name === 'task_settlement_delivery'
  ) {
    const temporary =
      definition.name === 'task_settlement_notices' ? 'ending_notices' : 'ending_delivery';
    const statement = taskEndingMigration
      .split(';')
      .find((sql) => sql.startsWith('CREATE TABLE ' + temporary + '('));
    assert.ok(statement && actual);
    const expected = statement
      .replaceAll('ending_notices', 'task_settlement_notices')
      .replaceAll('ending_delivery', 'task_settlement_delivery');
    assert.equal(String(actual.sql).replaceAll('"', ''), expected);
  } else if (definition.name === 'scheduler_settings') {
    assert.ok(actual);
    const expected = taskCapacityMigration
      .split(';')
      .find((sql) => sql.startsWith('CREATE TABLE scheduler_settings('));
    assert.equal(String(actual.sql).replaceAll('"', ''), expected);
  } else if (definition.name === 'group_inviter_logs') {
    assert.ok(actual);
    // Migration39 appends pending-recipient evidence to the existing log;
    // every original column, constraint and index must remain identical.
    const suffix =
      ", confirmation TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK(confirmation IN ('PENDING','CONFIRMED')), operation_id TEXT";
    assert.deepEqual({ ...actual, sql: String(actual.sql).replace(suffix, '') }, { ...definition });
  } else assert.deepEqual(actual, definition);
}
