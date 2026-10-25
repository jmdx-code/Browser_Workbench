import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { materialIndexMigration } from '../dist/src/infrastructure/material-index-migration.js';
import { materialPostMigration } from '../dist/src/infrastructure/material-post-migration.js';
const read = async (name) => JSON.parse(await readFile('audit/' + name, 'utf8'));
const [before, after, source, packaged, isolated, service, previous] = await Promise.all(
  [
    'material-upload-preflight.json',
    'material-upload-release-postflight.json',
    'material-upload-release-source-smoke.json',
    'material-upload-release-packaged-smoke.json',
    'material-upload-isolated.json',
    'material-upload-release-service.json',
    'material-settlement-results.json',
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
assert.equal(isolated.cases.length, 4);
assert.equal(isolated.generatedFixture, true);
assert.equal(isolated.simulatedTasksIdentitiesTargetsAndNativeCommands, true);
assert.equal(isolated.nativeBrowserOperations, 0);
assert.equal(isolated.actualFacebookUploaded, false);
assert.equal(isolated.actualFacebookPublished, false);
assert.equal(isolated.userMaterialFilesMoved, false);
assert.equal(isolated.generatedPrivateUploadCopiesCreated, true);
assert.equal(isolated.userResourceDirectoriesRead, false);
for (const passed of Object.values(isolated.checks)) assert.equal(passed, true);
assert.equal(service.httpStatus, 200);
assert.equal(service.support.comboExecution, false);
assert.equal(service.support.accountIdentity, false);
assert.equal(service.auditFlagsEnabled, false);
const migration8Digest = createHash('sha256').update(materialIndexMigration).digest('hex'),
  migration9Digest = createHash('sha256').update(materialPostMigration).digest('hex');
assert.equal(migration8Digest, previous.priorMigration8SqlDigestUnchanged);
assert.equal(migration9Digest, previous.appliedMigration9SqlDigest);
const log = await readFile('audit/check-material-upload-release.log', 'utf8');
assert.match(log, /tests 325/);
assert.match(log, /pass 325/);
assert.match(log, /fail 0/);
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
assert.equal(version, '0.1.18');
const report = {
  state: 'UPLOAD_PREPARATION_CHECKS_PASSED',
  recordedAt: new Date().toISOString(),
  softwareVersion: version,
  extensionCandidateVersion: '0.3.5',
  actualOnlineExtensionVersions: [
    ...new Set(service.onlineProfiles.map((p) => p.extensionVersion)),
  ],
  programChecks: { passed: 325, failed: 0, newTests: 19 },
  schema: after.schema,
  databaseMigration: false,
  appliedMigration8SqlDigestUnchanged: migration8Digest,
  appliedMigration9SqlDigestUnchanged: migration9Digest,
  formalPreferencesPreserved: true,
  formalExecutionAndMaterialTablesEmpty: true,
  sourceDesktopSmokePassed: true,
  packagedDesktopSmokePassed: true,
  scope: {
    stageFromSameVerifiedMediaStream: true,
    originalBoundIntentAndPreparationFence: true,
    exclusiveFilesAndReadyManifest: true,
    stagedMediaDigestAndOrderedPathsRechecked: true,
    stageAndResourceRootsCannotOverlap: true,
    cooperativeSpaceAndSerialPreparationLimits: true,
    genericSdkNativeAsyncResourceGateConnected: true,
    currentFenceRepeatedImmediatelyBeforeTransportSend: true,
    closedRenewalOwnerCannotStopPeer: true,
    renewalTrackingPerSession: true,
    inputAfterBoundOperationEndsRejected: true,
    productionMaterialFileAction: false,
    sessionFileGrant: false,
    publicMaterialMutationApi: false,
    realFacebookUpload: false,
    realFacebookPublication: false,
    archiveMovement: false,
    productionEnabled: false,
  },
  isolated: {
    directory: isolated.isolated,
    formats: isolated.cases.map((c) => c.format),
    stagedMediaFiles: isolated.cases.reduce((n, c) => n + c.stagedFiles, 0),
    sourceFilesUnchanged: true,
    originalIntentAndManifestPreservedAfterReopen: true,
    identitiesTargetsAndNativeCommands: 'simulated-fixture-only',
    nativeBrowserOperations: 0,
    published: false,
    originalFilesMoved: false,
  },
  limitations: [
    'Stage resource validation does not validate business upload purpose; stable upload Action/outbox intent and session file grant must be implemented before production use',
    'The final bound-input lifetime guard is included in the final 325-check regression and source/package smoke; no dedicated real browser race test is claimed',
    'Private stage paths remove dependence on later user-source edits but do not sandbox a malicious process or user with the same OS permissions',
    'Successful stages are retained; durable ownership/capacity/cleanup for unknown and settled operations is not implemented',
    'Capacity and IO budgets are local cooperative checks; no full-disk, power-loss, large-media or real browser upload test is claimed',
    'Readonly flags are defense in depth, not cryptographic immutability',
  ],
  next: [
    'add explicit stable media-upload action and original upload outbox purpose; no file upload under PREPARE_MEDIA click',
    'bind newly staged file grants to original active operation/context in thin bridge without broadening arbitrary path access',
    'integrate material guard with actual SDK upload and verify generated local media before Facebook publishing',
    'append migration10 for persistent archive movement/proof/recovery and stage retention/indexed availability',
    'continue production actor, actual action identity and complete browse/like/four-format publishing',
  ],
  evidence: [
    'material-upload-focused-first.log',
    'material-upload-results.json',
    'material-upload-release-package.log',
    'check-material-upload-release.log',
    'material-upload-isolated.json',
    'material-upload-release-source-smoke.json',
    'material-upload-release-packaged-smoke.json',
    'material-upload-preflight.json',
    'material-upload-release-postflight.json',
    'material-upload-release-service.json',
  ],
};
await writeFile(
  'audit/material-upload-release-results.json',
  JSON.stringify(report, null, 2) + '\n',
  {
    flag: 'wx',
  },
);
console.log(
  JSON.stringify({
    state: report.state,
    softwareVersion: version,
    programChecks: report.programChecks,
    schema: report.schema,
  }),
);
