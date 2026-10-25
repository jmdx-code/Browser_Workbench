import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { productDataDirectory } from '../dist/src/infrastructure/paths.js';
import { workspaceSchemaVersion } from '../dist/src/infrastructure/workspace-store.js';

// Read-only snapshot, without constructing stores or running recovery.
const directory = productDataDirectory();
const product = new DatabaseSync(path.join(directory, 'workspace.sqlite'), { readOnly: true });
const journal = new DatabaseSync(path.join(directory, 'journal.sqlite'), { readOnly: true });
try {
  const count = (db, sql) => Number(db.prepare(sql).get().count);
  const schema = product.prepare('PRAGMA user_version').get().user_version;
  const digestRows = (sql) =>
    createHash('sha256')
      .update(JSON.stringify(product.prepare(sql).all()))
      .digest('hex');
  const report = {
    recordedAt: new Date().toISOString(),
    readOnly: true,
    directory,
    schema: { product: schema, journal: journal.prepare('PRAGMA user_version').get().user_version },
    profiles: count(journal, 'SELECT count(*) AS count FROM profiles'),
    groups: product.prepare('SELECT name FROM groups ORDER BY sort_order,id').all(),
    plans: count(product, 'SELECT count(*) AS count FROM task_plans'),
    unresolvedOutbox: count(
      product,
      "SELECT count(*) AS count FROM task_outbox WHERE status IN ('PREPARED','DISPATCHING','ACKNOWLEDGED','UNKNOWN')",
    ),
    bindings:
      schema >= 3 ? count(product, 'SELECT count(*) AS count FROM task_dispatch_bindings') : null,
    taskTabs:
      schema >= 4 ? count(product, 'SELECT count(*) AS count FROM task_tab_ownership') : null,
    settlementNotices:
      schema >= 5 ? count(product, 'SELECT count(*) AS count FROM task_settlement_notices') : null,
    controlBindings:
      schema >= 6 ? count(product, 'SELECT count(*) AS count FROM task_control_bindings') : null,
    browseIntents:
      schema >= 7 ? count(product, 'SELECT count(*) AS count FROM task_browse_intents') : null,
    materialCatalogs:
      schema >= 8 ? count(product, 'SELECT count(*) AS count FROM material_catalogs') : null,
    materialIntents:
      schema >= 8 ? count(product, 'SELECT count(*) AS count FROM material_post_intents') : null,
    materialReservations:
      schema >= 8 ? count(product, 'SELECT count(*) AS count FROM material_reservations') : null,
    materialOperations:
      schema >= 9 ? count(product, 'SELECT count(*) AS count FROM material_post_operations') : null,
    materialOperationVerdicts:
      schema >= 9
        ? count(product, 'SELECT count(*) AS count FROM material_operation_verdicts')
        : null,
    materialAttemptVerdicts:
      schema >= 9
        ? count(product, 'SELECT count(*) AS count FROM material_attempt_verdicts')
        : null,
    materialPublications:
      schema >= 9 ? count(product, 'SELECT count(*) AS count FROM material_publications') : null,
    materialArchives:
      schema >= 9
        ? count(product, 'SELECT count(*) AS count FROM material_archive_requests')
        : null,
    uploadStageOwners:
      schema >= 10
        ? count(product, 'SELECT count(*) AS count FROM material_upload_stage_owners')
        : null,
    uploadStageManifests:
      schema >= 10
        ? count(product, 'SELECT count(*) AS count FROM material_upload_stage_manifests')
        : null,
    cacheCleanupRequests:
      schema >= 11
        ? count(product, 'SELECT count(*) AS count FROM material_cache_cleanup_requests')
        : null,
    cacheCleanupCompletions:
      schema >= 11
        ? count(product, 'SELECT count(*) AS count FROM material_cache_cleanup_completions')
        : null,
    archivePreparations:
      schema >= 12
        ? count(product, 'SELECT count(*) AS count FROM material_archive_preparation')
        : null,
    archivePlans:
      schema >= 12 ? count(product, 'SELECT count(*) AS count FROM material_archive_plans') : null,
    resourceTableHeads:
      schema >= 13 ? count(product, 'SELECT count(*) AS count FROM resource_table_heads') : null,
    resourceTableVersions:
      schema >= 13 ? count(product, 'SELECT count(*) AS count FROM resource_table_versions') : null,
    taskResourceBindings:
      schema >= 14 ? count(product, 'SELECT count(*) AS count FROM task_resource_bindings') : null,
    unresolvedBridgeOperations: count(
      journal,
      "SELECT count(*) AS count FROM operations WHERE status IN ('PREPARED','DISPATCHING','ACKNOWLEDGED','UNKNOWN')",
    ),
    activeBridgeTasks: count(
      journal,
      "SELECT count(*) AS count FROM tasks WHERE status IN ('PREPARED','RUNNING')",
    ),
    preservation: {
      groups: digestRows('SELECT * FROM groups ORDER BY id'),
      profileMetadata: digestRows('SELECT * FROM profile_metadata ORDER BY profile_id'),
      combinations: digestRows('SELECT * FROM combinations ORDER BY id'),
      savedVersions: digestRows(
        'SELECT * FROM combination_versions ORDER BY combination_id,version',
      ),
    },
  };
  await writeFile(
    process.env.WORKBENCH_EXECUTION_SNAPSHOT ?? 'audit/execution-preflight.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  if (
    !Number.isInteger(schema) ||
    schema < 2 ||
    schema > workspaceSchemaVersion ||
    report.schema.journal !== 2 ||
    report.plans ||
    report.unresolvedOutbox ||
    report.materialIntents ||
    report.materialReservations ||
    report.uploadStageOwners ||
    report.cacheCleanupRequests ||
    report.archivePreparations ||
    report.unresolvedBridgeOperations ||
    report.activeBridgeTasks
  )
    throw Error('EXECUTION_STAGE_REQUIRES_REVIEW');
  console.log(JSON.stringify(report));
} finally {
  product.close();
  journal.close();
}
