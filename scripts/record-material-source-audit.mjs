import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { materialIndexMigration } from '../dist/src/infrastructure/material-index-migration.js';
import { materialPostMigration } from '../dist/src/infrastructure/material-post-migration.js';
const read = async (name) => JSON.parse(await readFile('audit/' + name, 'utf8'));
const [before, after, source, packaged, isolated, service, previous] = await Promise.all(
  [
    'material-source-preflight.json',
    'material-source-postflight.json',
    'material-source-source-smoke.json',
    'material-source-packaged-smoke.json',
    'material-source-isolated.json',
    'material-source-service.json',
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
assert.equal(isolated.nativeBrowserOperations, 0);
assert.equal(isolated.actualFacebookPublished, false);
assert.equal(isolated.materialFilesMoved, false);
assert.equal(isolated.userResourceDirectoriesRead, false);
for (const passed of Object.values(isolated.checks)) assert.equal(passed, true);
assert.equal(service.httpStatus, 200);
assert.equal(service.support.comboExecution, false);
assert.equal(service.support.accountIdentity, false);
assert.equal(service.auditFlagsEnabled, false);
const migration8Digest = createHash('sha256').update(materialIndexMigration).digest('hex');
const migration9Digest = createHash('sha256').update(materialPostMigration).digest('hex');
assert.equal(migration8Digest, previous.priorMigration8SqlDigestUnchanged);
assert.equal(migration9Digest, previous.appliedMigration9SqlDigest);
const log = await readFile('audit/check-material-source-final.log', 'utf8');
assert.match(log, /tests 306/);
assert.match(log, /pass 306/);
assert.match(log, /fail 0/);
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
assert.equal(version, '0.1.17');
const report = {
  state: 'SOURCE_VERIFICATION_CHECKS_PASSED',
  recordedAt: new Date().toISOString(),
  softwareVersion: version,
  extensionCandidateVersion: '0.3.5',
  actualOnlineExtensionVersions: [
    ...new Set(service.onlineProfiles.map((p) => p.extensionVersion)),
  ],
  programChecks: { passed: 306, failed: 0, newTests: 12 },
  schema: after.schema,
  databaseMigration: false,
  appliedMigration8SqlDigestUnchanged: migration8Digest,
  appliedMigration9SqlDigestUnchanged: migration9Digest,
  formalPreferencesPreserved: true,
  formalExecutionAndMaterialTablesEmpty: true,
  sourceDesktopSmokePassed: true,
  packagedDesktopSmokePassed: true,
  scope: {
    fullOriginalPackageContentReRead: true,
    orderedSnapshotAndFileProofRechecked: true,
    packageMembersAndPathOwnershipRechecked: true,
    asynchronousTaskActorFenceChecks: true,
    observationIsNotReusableInputPermit: true,
    verificationDidNotSettleOrRelease: true,
    publicMaterialMutationApi: false,
    nativeInputSourceHookConnected: false,
    pathBasedUploadRaceClosed: false,
    stagedImmutableUploadContent: false,
    fileUpload: false,
    archiveMovement: false,
    realFacebookExecution: false,
    productionEnabled: false,
  },
  isolated: {
    directory: isolated.isolated,
    formats: isolated.cases.map((c) => c.format),
    originalIntentsAfterReopen: true,
    identitiesAndTargets: 'simulated-fixture-only',
    nativeBrowserOperations: 0,
    published: false,
    filesMoved: false,
    sourceFilesUnchanged: true,
  },
  limitations: [
    'Windows does not permit file symlink creation in this runtime; actual filesystem tests cover file replacement by directory junction and folder junction, not a real file symlink',
    'Verification detects observed changes but is not a filesystem sandbox; later path reopening by the browser requires trusted staged content and a final per-native-command fence',
    'Native IO budget is cooperative, not a guaranteed cancellation of in-flight OS IO',
  ],
  next: [
    'bind verified original content to trusted upload staging and per-native Input/file fence',
    'append migration10 for durable archive movement/proof/recovery and indexed availability',
    'continue actual action identity, production actor and Facebook browse/like/four-format publishing',
  ],
  evidence: [
    'material-source-build-first.log',
    'material-source-focused-first.log',
    'material-source-focused-second.log',
    'check-material-source-final.log',
    'material-source-isolated.json',
    'material-source-source-smoke.json',
    'material-source-packaged-smoke.json',
    'material-source-preflight.json',
    'material-source-postflight.json',
    'material-source-service.json',
  ],
};
await writeFile('audit/material-source-results.json', JSON.stringify(report, null, 2) + '\n', {
  flag: 'wx',
});
console.log(
  JSON.stringify({
    state: report.state,
    softwareVersion: version,
    programChecks: report.programChecks,
    schema: report.schema,
  }),
);
