import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { materialIndexMigration } from '../dist/src/infrastructure/material-index-migration.js';
import { materialPostMigration } from '../dist/src/infrastructure/material-post-migration.js';
const read = async (file) => JSON.parse(await readFile(file, 'utf8'));
const [before, after, source, packaged, isolated, service, previous, manifest, identity] =
  await Promise.all(
    [
      'audit/operation-files-preflight.json',
      'audit/operation-files-final-postflight.json',
      'audit/operation-files-source-final-smoke.json',
      'audit/operation-files-packaged-final-smoke.json',
      'audit/operation-files-isolated.json',
      'audit/operation-files-service-final.json',
      'audit/material-upload-operation-results.json',
      'extension-build/manifest.json',
      'config/extension-identity.json',
    ].map(read),
  );
assert.deepEqual(after.schema, { product: 9, journal: 2 });
assert.deepEqual(after.schema, before.schema);
assert.deepEqual(after.preservation, before.preservation);
assert.equal(after.profiles, 9);
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
assert.equal(manifest.version, '0.3.6');
assert.deepEqual(manifest.permissions, ['debugger', 'storage', 'alarms']);
assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*', 'http://localhost/*']);
const keyHash = createHash('sha256')
  .update(Buffer.from(manifest.key, 'base64'))
  .digest('hex')
  .slice(0, 32);
const extensionId = [...keyHash]
  .map((digit) => String.fromCharCode(97 + parseInt(digit, 16)))
  .join('');
assert.equal(extensionId, identity.extensionId);
assert.equal(extensionId, 'eehghiicklfpnhliknglhagcipkjkjjf');
assert.equal(service.httpStatus, 200);
assert.equal(service.auditFlagsEnabled, false);
assert.equal(service.support.comboExecution, false);
assert.equal(service.support.accountIdentity, false);
assert.equal(isolated.state, 'PASSED');
assert.equal(isolated.actualBrowserOperations, 0);
assert.equal(isolated.actualSdkFileTransfer, false);
assert.equal(isolated.nativeBackendSimulated, true);
assert.equal(isolated.userResourceDirectoriesRead, false);
assert.equal(isolated.cases.length, 3);
const root = path.resolve(isolated.isolated);
assert.equal(path.dirname(root), path.resolve('audit'));
assert.ok(path.basename(root).startsWith('operation-files-isolated-'));
for (const scenario of isolated.cases) {
  assert.equal(scenario.sourceUnchanged, true);
  assert.equal(scenario.businessVerified, false);
  assert.equal(scenario.lateUploadRejected, true);
  assert.equal(scenario.grantResurrectionRejected, true);
  assert.equal(scenario.simulatedCommands.length, 1);
  assert.equal(path.dirname(path.resolve(scenario.database)), root);
  const db = new DatabaseSync(scenario.database, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
    assert.equal(db.prepare('SELECT status FROM task_outbox').get().status, 'DISPATCHING');
    assert.equal(
      db.prepare('SELECT purpose FROM material_post_operations').get().purpose,
      'UPLOAD_MEDIA',
    );
    assert.equal(db.prepare('SELECT state FROM material_reservations').get().state, 'RESERVED');
    for (const table of [
      'material_operation_verdicts',
      'material_attempt_verdicts',
      'material_publications',
      'material_archive_requests',
      'task_settlement_notices',
    ])
      assert.equal(db.prepare('SELECT count(*) AS n FROM ' + table).get().n, 0);
  } finally {
    db.close();
  }
}
const digest = (value) => createHash('sha256').update(value).digest('hex');
assert.equal(digest(materialIndexMigration), previous.appliedMigration8SqlDigestUnchanged);
assert.equal(digest(materialPostMigration), previous.appliedMigration9SqlDigestUnchanged);
const log = await readFile('audit/check-operation-files-hardened-final.log', 'utf8');
assert.match(log, /tests 348/);
assert.match(log, /pass 348/);
assert.match(log, /fail 0/);
assert.equal((await read('package.json')).version, '0.1.20');
const report = {
  recordedAt: new Date().toISOString(),
  state: 'OPERATION_FILE_GRANT_PROGRAM_CHECKS_PASSED',
  softwareVersion: '0.1.20',
  candidateExtensionVersion: manifest.version,
  extensionId,
  programChecks: { passed: 348, failed: 0, newTests: 13 },
  schema: after.schema,
  databaseMigration: false,
  appliedMigration8SqlDigestUnchanged: digest(materialIndexMigration),
  appliedMigration9SqlDigestUnchanged: digest(materialPostMigration),
  formalPreferencesPreserved: true,
  formalExecutionAndMaterialTablesEmpty: true,
  sourceDesktopSmokePassed: true,
  packagedDesktopSmokePassed: true,
  isolatedEvidence: 'audit/operation-files-isolated.json',
  serviceEvidence: 'audit/operation-files-service-final.json',
  servicePid: service.servicePid,
  toolSession: service.toolSession,
  actualOnlineExtensionVersions: [
    ...new Set(service.onlineProfiles.map((p) => p.extensionVersion)),
  ],
  scope: {
    strictOriginalBindingActionDigestTargetAndOrderedPaths: true,
    bothKernelExecutorsGrantAndFinalFence: true,
    inFlightInputsBlockGrantReplacement: true,
    finishStopReloadRevocation: true,
    emptyFileListRejectedBeforeGrant: true,
    sdkPublicApiCallerImplemented: true,
    actualSdkFileTransfer: false,
    actualFacebookUploadOrPublication: false,
    sourceMoves: false,
    productionEnabled: false,
  },
  remaining: [
    'actual Chrome 0.3.6 scoped SDK fixture transfer and cancellation',
    'persistent stage ownership and cleanup',
    'archive migration 10 and resumable moves',
    'real action identity and production actor/browser/tab adapters',
    'real browse/video/like/media observers and four publication formats',
    'complete V1 acceptance',
  ],
};
await writeFile('audit/operation-files-results.json', JSON.stringify(report, null, 2), {
  flag: 'wx',
});
console.log(
  JSON.stringify({
    state: report.state,
    programChecks: report.programChecks,
    servicePid: report.servicePid,
  }),
);
