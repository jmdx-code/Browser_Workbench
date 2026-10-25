import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { materialIndexMigration } from '../dist/src/infrastructure/material-index-migration.js';
import { materialPostMigration } from '../dist/src/infrastructure/material-post-migration.js';
const read = async (file) => JSON.parse(await readFile(file, 'utf8'));
const [before, after, source, packaged, service, previous, manifest] = await Promise.all(
  [
    'audit/kernel-upload-diagnostic-preflight.json',
    'audit/kernel-upload-diagnostic-postflight.json',
    'audit/kernel-upload-diagnostic-source-smoke.json',
    'audit/kernel-upload-diagnostic-packaged-smoke.json',
    'audit/kernel-upload-diagnostic-service.json',
    'audit/operation-files-results.json',
    'extension-build/manifest.json',
  ].map(read),
);
assert.deepEqual(after.schema, { product: 9, journal: 2 });
assert.deepEqual(before.schema, after.schema);
assert.deepEqual(before.preservation, after.preservation);
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
assert.equal(service.httpStatus, 200);
assert.equal(service.legacyAuditFlagsEnabled, false);
assert.equal(service.uploadAuditEnabled, true);
assert.equal(service.support.comboExecution, false);
assert.equal(service.support.accountIdentity, false);
assert.equal(service.liveReportExists, false);
const digest = (value) => createHash('sha256').update(value).digest('hex');
assert.equal(digest(materialIndexMigration), previous.appliedMigration8SqlDigestUnchanged);
assert.equal(digest(materialPostMigration), previous.appliedMigration9SqlDigestUnchanged);
const log = await readFile('audit/check-kernel-upload-diagnostic-final.log', 'utf8');
assert.match(log, /tests 353/);
assert.match(log, /pass 353/);
assert.match(log, /fail 0/);
assert.equal((await read('package.json')).version, '0.1.21');
await writeFile(
  'audit/kernel-upload-diagnostic-results.json',
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      state: 'PREPARED_WAITING_CHROME_036',
      softwareVersion: '0.1.21',
      candidateExtensionVersion: '0.3.6',
      programChecks: { passed: 353, failed: 0, newTests: 5 },
      schema: after.schema,
      databaseMigration: false,
      formalPreferencesPreserved: true,
      formalExecutionAndMaterialTablesEmpty: true,
      sourceDesktopSmokePassed: true,
      packagedDesktopSmokePassed: true,
      appliedMigration8SqlDigestUnchanged: digest(materialIndexMigration),
      appliedMigration9SqlDigestUnchanged: digest(materialPostMigration),
      servicePid: service.servicePid,
      toolSession: service.toolSession,
      legacyAuditFlagsEnabled: false,
      uploadAuditEnabled: true,
      actualOnlineExtensionVersions: [
        ...new Set(service.onlineProfiles.map((peer) => peer.extensionVersion)),
      ],
      actualSdkFileTransfer: false,
      actualFacebookUploaded: false,
      actualFacebookPublished: false,
      sdkWaitingCancellationVerified: false,
      threeFormatsAndExactNativeCloseDiagnosticPrepared: true,
      durableOneShotReportReservation: true,
      remoteReviewAndFormalPlanGate: true,
      browserFileBytesHashProbePrepared: true,
      localVmProbeChecksAreNotRealBrowser: true,
      manualAction:
        'One confirmed Chrome refresh to 0.3.6 requested once; replaces old 0.3.5 pending item.',
      acceptanceContract: 'docs/KERNEL_UPLOAD_ACCEPTANCE.md',
      actualResultPath: 'audit/kernel-upload-live-2b32bd78-51d0-4576-a12b-252c4d3c2d9b.json',
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
console.log('Prepared; actual Chrome file transfer remains unverified');
