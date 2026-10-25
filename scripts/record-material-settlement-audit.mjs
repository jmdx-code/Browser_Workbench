import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { materialIndexMigration } from '../dist/src/infrastructure/material-index-migration.js';
import { materialPostMigration } from '../dist/src/infrastructure/material-post-migration.js';

const read = async (name) => JSON.parse(await readFile('audit/' + name, 'utf8'));
const [before, after, source, packaged, isolated, service, previous] = await Promise.all(
  [
    'material-settlement-preflight.json',
    'material-settlement-postflight.json',
    'material-settlement-source-smoke.json',
    'material-settlement-packaged-smoke.json',
    'material-settlement-isolated.json',
    'material-settlement-service.json',
    'material-index-results.json',
  ].map(read),
);
assert.equal(before.schema.product, 8);
assert.equal(after.schema.product, 9);
assert.deepEqual(after.preservation, before.preservation);
assert.equal(after.profiles, before.profiles);
for (const name of [
  'plans',
  'bindings',
  'taskTabs',
  'settlementNotices',
  'controlBindings',
  'browseIntents',
  'unresolvedOutbox',
  'unresolvedBridgeOperations',
  'activeBridgeTasks',
  'materialCatalogs',
  'materialIntents',
  'materialReservations',
  'materialOperations',
  'materialOperationVerdicts',
  'materialAttemptVerdicts',
  'materialPublications',
  'materialArchives',
])
  assert.equal(after[name], 0);
for (const smoke of [source, packaged]) {
  assert.equal(smoke.ok, true);
  assert.equal(smoke.seedSchemaVersion, 8);
  assert.equal(smoke.workspaceDatabaseVersion, 9);
  assert.equal(smoke.closePersisted, true);
  assert.equal(smoke.htmlFacts.overflow, false);
  assert.equal(smoke.htmlFacts.nodeExposed, false);
  assert.equal(smoke.htmlFacts.desktopBridge, true);
}
assert.equal(isolated.state, 'PASSED');
assert.equal(isolated.facts.schema, 9);
assert.equal(isolated.simulatedTasksIdentitiesTargetsAndBusinessEvidence, true);
assert.equal(isolated.simulatedNativeStopConfirmation, true);
assert.equal(isolated.simulatedNotificationReceipts, true);
assert.equal(isolated.nativeBrowserOperations, 0);
assert.equal(isolated.actualFacebookPublished, false);
assert.equal(isolated.materialFilesMoved, false);
assert.equal(isolated.userResourceDirectoriesRead, false);
for (const passed of Object.values(isolated.checks)) assert.equal(passed, true);
assert.equal(isolated.cases.length, 4);
assert.equal(isolated.facts.material_publications, 4);
assert.equal(isolated.facts.pendingArchives, 4);
assert.equal(service.httpStatus, 200);
assert.equal(service.support.comboExecution, false);
assert.equal(service.support.accountIdentity, false);
assert.equal(service.productionEnabled, false);
assert.equal(service.auditFlagsEnabled, false);
const migration8Digest = createHash('sha256').update(materialIndexMigration).digest('hex');
assert.equal(migration8Digest, previous.appliedMigration8SqlDigest);
const backups = (await readdir(before.directory)).filter(
  (file) => file.startsWith('workspace.sqlite.before-v9-') && file.endsWith('.sqlite'),
);
assert.equal(backups.length, 1);
const backupFile = path.join(before.directory, backups[0]);
const db = new DatabaseSync(backupFile, { readOnly: true });
let original;
try {
  const digestRows = (sql) =>
    createHash('sha256')
      .update(JSON.stringify(db.prepare(sql).all()))
      .digest('hex');
  original = {
    schema: db.prepare('PRAGMA user_version').get().user_version,
    preservation: {
      groups: digestRows('SELECT * FROM groups ORDER BY id'),
      profileMetadata: digestRows('SELECT * FROM profile_metadata ORDER BY profile_id'),
      combinations: digestRows('SELECT * FROM combinations ORDER BY id'),
      savedVersions: digestRows(
        'SELECT * FROM combination_versions ORDER BY combination_id,version',
      ),
    },
    plans: db.prepare('SELECT count(*) AS n FROM task_plans').get().n,
    materialReservations: db.prepare('SELECT count(*) AS n FROM material_reservations').get().n,
    settlementSchemaAbsent:
      db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='material_post_operations'")
        .get().n === 0,
  };
} finally {
  db.close();
}
assert.equal(original.schema, 8);
assert.deepEqual(original.preservation, before.preservation);
assert.equal(original.plans, 0);
assert.equal(original.materialReservations, 0);
assert.equal(original.settlementSchemaAbsent, true);
await writeFile(
  'audit/material-settlement-migration-backup.json',
  JSON.stringify(
    { recordedAt: new Date().toISOString(), readOnly: true, file: backupFile, ...original },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
const log = await readFile('audit/check-material-settlement-final.log', 'utf8');
assert.match(log, /tests 294/);
assert.match(log, /pass 294/);
assert.match(log, /fail 0/);
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
assert.equal(version, '0.1.16');
const report = {
  recordedAt: new Date().toISOString(),
  state: 'INTERNAL_SETTLEMENT_CHECKS_PASSED',
  softwareVersion: version,
  extensionCandidateVersion: '0.3.5',
  actualOnlineExtensionVersions: [
    ...new Set(service.onlineProfiles.map((p) => p.extensionVersion)),
  ],
  programChecks: { passed: 294, failed: 0, newTests: 20 },
  sourceMigrationSmokePassed: true,
  packagedMigrationSmokePassed: true,
  schema: after.schema,
  priorMigration8SqlDigestUnchanged: migration8Digest,
  appliedMigration9SqlDigest: createHash('sha256').update(materialPostMigration).digest('hex'),
  formalBackup: backupFile,
  formalPreferencesPreserved: true,
  formalExecutionAndMaterialTablesEmpty: true,
  isolated: {
    database: isolated.database,
    facts: isolated.facts,
    identitiesTargetsAndBusinessEvidence: 'simulated-fixture-only',
    nativeBrowserOperations: 0,
    actualFacebookPublished: false,
    materialFilesMoved: false,
    sourceFilesUnchanged: true,
  },
  scope: {
    originalAttemptAndAuxiliarySubmitOutboxAssociation: true,
    atomicPublicationVerdictHistoryCheckpointNoticeArchiveQueue: true,
    originalBindingIndependentUnknownReconciliation: true,
    accountAndGlobalContentHistoryEligibility: true,
    pendingArchiveBlocksContentReuse: true,
    publicPreflightStillReadOnly: true,
    publicMaterialMutationApi: false,
    sourceRevalidationBeforeInput: false,
    actualFileUploadPrimitive: false,
    durableFileMovementAndCompletionProof: false,
    realFacebookPostExecutor: false,
    productionEnabled: false,
  },
  next: [
    'revalidate complete original source snapshots before actor-fenced Input/files',
    'implement durable archive movement, destination collision policy, recovery and indexed availability',
    'extend stable input/file primitives where necessary; existing typeText limits full text to 4000 characters',
    'continue production actor and actual Facebook action identity, browse/like and all four publishing formats',
  ],
  evidence: [
    'check-material-settlement-first.log',
    'check-material-settlement-second.log',
    'check-material-settlement-final.log',
    'material-settlement-isolated.json',
    'material-settlement-source-smoke.json',
    'material-settlement-packaged-smoke.json',
    'material-settlement-preflight.json',
    'material-settlement-postflight.json',
    'material-settlement-migration-backup.json',
    'material-settlement-service.json',
  ],
};
await writeFile('audit/material-settlement-results.json', JSON.stringify(report, null, 2) + '\n', {
  flag: 'wx',
});
console.log(
  JSON.stringify({
    state: report.state,
    softwareVersion: version,
    programChecks: report.programChecks,
    schema: report.schema,
    formalBackup: backupFile,
  }),
);
