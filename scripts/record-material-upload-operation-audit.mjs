import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { materialIndexMigration } from '../dist/src/infrastructure/material-index-migration.js';
import { materialPostMigration } from '../dist/src/infrastructure/material-post-migration.js';

const read = async (name) => JSON.parse(await readFile('audit/' + name, 'utf8'));
const [before, after, source, packaged, isolated, service, previous] = await Promise.all(
  [
    'material-upload-operation-preflight.json',
    'material-upload-operation-postflight.json',
    'material-upload-operation-source-smoke.json',
    'material-upload-operation-packaged-smoke.json',
    'material-upload-operation-isolated.json',
    'material-upload-operation-service.json',
    'material-upload-release-results.json',
  ].map(read),
);
assert.deepEqual(before.schema, { product: 9, journal: 2 });
assert.deepEqual(after.schema, before.schema);
assert.deepEqual(after.preservation, before.preservation);
assert.equal(after.profiles, before.profiles);
for (const [field, value] of Object.entries(after))
  if (typeof value === 'number' && field !== 'profiles') assert.equal(value, 0);
for (const smoke of [source, packaged]) {
  assert.equal(smoke.ok, true);
  assert.equal(smoke.seedSchemaVersion, 9);
  assert.equal(smoke.workspaceDatabaseVersion, 9);
  assert.equal(smoke.closePersisted, true);
  assert.equal(smoke.htmlFacts.nodeExposed, false);
  assert.equal(smoke.htmlFacts.overflow, false);
}
assert.equal(isolated.state, 'PASSED');
assert.equal(isolated.softwareVersion, '0.1.19');
assert.equal(isolated.generatedFixture, true);
assert.equal(isolated.userResourceDirectoriesRead, false);
assert.equal(isolated.simulatedTasksIdentitiesTargetsAndNativeCommands, true);
assert.equal(isolated.nativeBrowserOperations, 0);
assert.equal(isolated.actualFacebookUploaded, false);
assert.equal(isolated.actualFacebookPublished, false);
assert.equal(isolated.userMaterialFilesMoved, false);
assert.equal(isolated.cases.length, 3);
for (const passed of Object.values(isolated.checks)) assert.equal(passed, true);
const audit = path.resolve('audit'),
  root = path.resolve(isolated.isolated);
assert.equal(path.dirname(root), audit);
assert.ok(path.basename(root).startsWith('material-upload-operation-isolated-'));
for (const scenario of isolated.cases) {
  assert.equal(path.dirname(path.resolve(scenario.database)), root);
  const db = new DatabaseSync(scenario.database, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
    const count = (table) => Number(db.prepare('SELECT count(*) AS n FROM ' + table).get().n);
    assert.equal(count('material_post_operations'), 1);
    assert.equal(count('material_operation_verdicts'), 1);
    assert.equal(count('task_settlement_notices'), 1);
    for (const table of [
      'material_attempt_verdicts',
      'material_publications',
      'material_archive_requests',
    ])
      assert.equal(count(table), 0);
    assert.equal(
      db.prepare('SELECT purpose FROM material_post_operations').get().purpose,
      'UPLOAD_MEDIA',
    );
    assert.equal(db.prepare('SELECT state FROM material_reservations').get().state, 'RESERVED');
    assert.equal(db.prepare('SELECT status FROM task_outbox').get().status, 'VERIFIED');
  } finally {
    db.close();
  }
}
assert.equal(service.httpStatus, 200);
assert.equal(service.support.comboExecution, false);
assert.equal(service.support.accountIdentity, false);
assert.equal(service.auditFlagsEnabled, false);
const digest = (sql) => createHash('sha256').update(sql).digest('hex');
assert.equal(digest(materialIndexMigration), previous.appliedMigration8SqlDigestUnchanged);
assert.equal(digest(materialPostMigration), previous.appliedMigration9SqlDigestUnchanged);
const log = await readFile('audit/check-material-upload-operation-final.log', 'utf8');
assert.match(log, /tests 335/);
assert.match(log, /pass 335/);
assert.match(log, /fail 0/);
assert.equal(JSON.parse(await readFile('package.json', 'utf8')).version, '0.1.19');
const report = {
  state: 'BOUND_UPLOAD_CONTRACT_CHECKS_PASSED',
  recordedAt: new Date().toISOString(),
  softwareVersion: '0.1.19',
  programChecks: { passed: 335, failed: 0, newTests: 10 },
  schema: after.schema,
  databaseMigration: false,
  appliedMigration8SqlDigestUnchanged: digest(materialIndexMigration),
  appliedMigration9SqlDigestUnchanged: digest(materialPostMigration),
  formalPreferencesPreserved: true,
  formalExecutionAndMaterialTablesEmpty: true,
  sourceDesktopSmokePassed: true,
  packagedDesktopSmokePassed: true,
  actualOnlineExtensionVersions: [
    ...new Set(service.onlineProfiles.map((p) => p.extensionVersion)),
  ],
  scope: {
    stableInternalUploadActionWithoutPaths: true,
    originalUploadPurposeOutboxAndBinding: true,
    legacyClickTransportRejectsUpload: true,
    uploadPreparationRequiresOriginalPurpose: true,
    currentBusinessPurposeAroundAsyncResourceGuard: true,
    independentReadyFormatAndCountRequired: true,
    mediaSubmitRequiresVerifiedOriginalUpload: true,
    uploadVerificationDoesNotPublishOrConsume: true,
    unknownNoReplayOrRelease: true,
    sessionFileGrant: false,
    actualSdkFileTransfer: false,
    actualFacebookUploadOrPublication: false,
    productionEnabled: false,
  },
  isolated: {
    directory: isolated.isolated,
    formats: isolated.cases.map((c) => c.format),
    stagedMediaFiles: isolated.cases.reduce((n, c) => n + c.stagedFiles, 0),
    simulatedUploadObservationsAndNotifications: 3,
    sourceFilesUnchanged: true,
    originalIntentBindingAndNoticeReopenPreserved: true,
    nativeBrowserOperations: 0,
    actualPublished: false,
    originalFilesMoved: false,
  },
  limitations: [
    'Media ready/count/format are trusted observer schema and simulated evidence here, not an implemented Facebook observer or proof of real uploaded content',
    'No operation-bound session file grant or actual SDK upload caller exists; the legacy bridge rejects uploadMedia, and production remains closed',
    'Text remains a separate publishing path; existing typeText 4000-character limit must be expanded without truncation',
    'Private stage ownership, cleanup, capacity recovery and archive movement remain incomplete',
    'No actual browser or Facebook operations, user resource scans or source movement in this stage',
  ],
  next: [
    'implement private exact original-operation file grant on software and thin extension with final native fences',
    'bind action digest, proof, staged manifest and ordered paths; deny grant replacement while input is in flight',
    'verify generated local media through actual public SDK setInputFiles before Facebook publishing',
    'append migration10 for durable stage ownership and archive proof/recovery',
    'complete production actor, actual action account, browser executors and four-format publishing',
  ],
  evidence: [
    'material-upload-operation-build-first.log',
    'material-upload-operation-build-second.log',
    'material-upload-operation-focused-first.log',
    'check-material-upload-operation-final.log',
    'material-upload-operation-isolated.json',
    'material-upload-operation-source-smoke.json',
    'material-upload-operation-packaged-smoke.json',
    'material-upload-operation-preflight.json',
    'material-upload-operation-postflight.json',
    'material-upload-operation-service.json',
  ],
};
await writeFile(
  'audit/material-upload-operation-results.json',
  JSON.stringify(report, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(
  JSON.stringify({
    state: report.state,
    softwareVersion: report.softwareVersion,
    programChecks: report.programChecks,
    schema: report.schema,
  }),
);
