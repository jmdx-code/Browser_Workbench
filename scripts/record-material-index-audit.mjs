import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { materialIndexMigration } from '../dist/src/infrastructure/material-index-migration.js';
const read = async (name) => JSON.parse(await readFile('audit/' + name, 'utf8'));
const [before, after, source, packaged, isolated, service] = await Promise.all(
  [
    'material-index-preflight.json',
    'material-index-postflight.json',
    'material-index-source-smoke.json',
    'material-index-packaged-smoke.json',
    'material-index-isolated.json',
    'material-index-service.json',
  ].map(read),
);
assert.equal(before.schema.product, 7);
assert.equal(after.schema.product, 8);
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
])
  assert.equal(after[name], 0);
for (const smoke of [source, packaged]) {
  assert.equal(smoke.ok, true);
  assert.equal(smoke.seedSchemaVersion, 7);
  assert.equal(smoke.workspaceDatabaseVersion, 8);
  assert.equal(smoke.closePersisted, true);
  assert.equal(smoke.htmlFacts.overflow, false);
  assert.equal(smoke.htmlFacts.nodeExposed, false);
  assert.equal(smoke.htmlFacts.desktopBridge, true);
}
assert.equal(isolated.state, 'PASSED');
assert.equal(isolated.facts.schema, 8);
assert.equal(isolated.simulatedTasksAndIdentities, true);
assert.equal(isolated.nativeBrowserOperations, 0);
assert.equal(isolated.checks.sourceFilesUnchanged, true);
assert.equal(service.httpStatus, 200);
assert.equal(service.support.comboExecution, false);
assert.equal(service.support.accountIdentity, false);
const backups = (await readdir(before.directory)).filter(
  (file) => file.startsWith('workspace.sqlite.before-v8-') && file.endsWith('.sqlite'),
);
assert.equal(backups.length, 1);
const backupFile = path.join(before.directory, backups[0]),
  db = new DatabaseSync(backupFile, { readOnly: true });
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
    materialSchemaAbsent:
      db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='material_reservations'").get()
        .n === 0,
  };
} finally {
  db.close();
}
assert.equal(original.schema, 7);
assert.deepEqual(original.preservation, before.preservation);
assert.equal(original.plans, 0);
assert.equal(original.materialSchemaAbsent, true);
await writeFile(
  'audit/material-index-migration-backup.json',
  JSON.stringify(
    { recordedAt: new Date().toISOString(), readOnly: true, file: backupFile, ...original },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
const log = await readFile('audit/check-material-index-final.log', 'utf8');
assert.match(log, /tests 274/);
assert.match(log, /pass 274/);
assert.match(log, /fail 0/);
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
assert.equal(version, '0.1.15');
const report = {
  recordedAt: new Date().toISOString(),
  state: 'FOUNDATION_CHECKS_PASSED',
  softwareVersion: version,
  extensionCandidateVersion: '0.3.5',
  actualOnlineExtensionVersions: [
    ...new Set(service.onlineProfiles.map((p) => p.extensionVersion)),
  ],
  programChecks: { passed: 274, failed: 0, newTests: 13 },
  sourceMigrationSmokePassed: true,
  packagedMigrationSmokePassed: true,
  schema: after.schema,
  appliedMigration8SqlDigest: createHash('sha256').update(materialIndexMigration).digest('hex'),
  formalBackup: backupFile,
  formalPreferencesPreserved: true,
  formalExecutionAndMaterialTablesEmpty: true,
  isolated: {
    catalogs: isolated.facts.catalogs,
    contents: isolated.facts.contents,
    sources: isolated.facts.sources,
    intents: isolated.facts.intents,
    reservations: isolated.facts.reservations,
    outbox: isolated.facts.outbox,
    twoProcessAtomicReservationProgramTestPassed: true,
    identities: 'simulated-fixture-only',
    nativeBrowserOperations: 0,
    published: false,
    archived: false,
  },
  scope: {
    immutableCatalogAndSources: true,
    stablePostIntentAndAtomicReservation: true,
    controlAndStartupRetainHolds: true,
    publicPreflightStillReadOnly: true,
    publicMaterialIndexOrReservationApi: false,
    materialSubOperationsAndDispatchBinding: false,
    publicationVerdictHistoryAndArchiveQueue: false,
    sourceRevalidationBeforeInput: false,
    realFacebookPostExecutor: false,
    productionEnabled: false,
  },
  next: [
    'associate each precursor and submit outbox operation with original post attempt; preserve intent on unknown',
    'append migration9 for independent publication verdict, account/content consumption and pending archive in same transaction with task checkpoint and settlement notification',
    'revalidate source content before actor-fenced Input/files; complete archive recovery',
    'continue production actor/FB identity, real browse/like and four-format publishing integration',
  ],
  evidence: [
    'check-material-index-final.log',
    'material-index-isolated.json',
    'material-index-source-smoke.json',
    'material-index-packaged-smoke.json',
    'material-index-preflight.json',
    'material-index-postflight.json',
    'material-index-migration-backup.json',
    'material-index-service.json',
  ],
};
await writeFile('audit/material-index-results.json', JSON.stringify(report, null, 2) + '\n', {
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
