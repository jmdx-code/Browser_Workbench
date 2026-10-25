import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { materialIndexMigration } from '../dist/src/infrastructure/material-index-migration.js';
import { materialPostMigration } from '../dist/src/infrastructure/material-post-migration.js';
import { materialUploadStageMigration } from '../dist/src/infrastructure/material-upload-stage-migration.js';

const json = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const [before, after, source, packaged, isolated, service, owner, manifest, identity] =
  await Promise.all(
    [
      'audit/upload-stage-ledger-preflight.json',
      'audit/upload-stage-ledger-postflight.json',
      'audit/upload-stage-ledger-source-smoke.json',
      'audit/upload-stage-ledger-packaged-smoke.json',
      'audit/upload-stage-ledger-isolated.json',
      'audit/upload-stage-ledger-service.json',
      'audit/upload-stage-ledger-owner-after.json',
      'extension-build/manifest.json',
      'config/extension-identity.json',
    ].map(json),
  );
assert.deepEqual(before.schema, { product: 9, journal: 2 });
assert.deepEqual(after.schema, { product: 10, journal: 2 });
assert.deepEqual(after.preservation, before.preservation);
assert.equal(after.profiles, 9);
for (const [field, value] of Object.entries(after))
  if (typeof value === 'number' && field !== 'profiles') assert.equal(value, 0);
for (const smoke of [source, packaged]) {
  assert.equal(smoke.ok, true);
  assert.equal(smoke.seedSchemaVersion, 9);
  assert.equal(smoke.workspaceDatabaseVersion, 10);
  assert.equal(smoke.closePersisted, true);
  assert.equal(smoke.htmlFacts.overflow, false);
  assert.equal(smoke.htmlFacts.nodeExposed, false);
}
assert.equal(service.httpStatus, 200);
assert.equal(service.softwareVersion, '0.1.22');
assert.equal(service.legacyAuditFlagsEnabled, false);
assert.equal(service.uploadAuditEnabled, true);
assert.equal(service.support.comboExecution, false);
assert.equal(service.support.accountIdentity, false);
assert.equal(service.liveReportExists, false);
assert.equal(owner.ProcessId, service.servicePid);
assert.equal(
  owner.ExecutablePath,
  'C:\\Users\\jj\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\bin\\node.exe',
);
assert.equal(owner.CommandLine, '"' + owner.ExecutablePath + '" dist/src/server.js');
assert.equal(manifest.version, '0.3.6');
assert.deepEqual(manifest.permissions, ['debugger', 'storage', 'alarms']);
assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*', 'http://localhost/*']);
const extensionId = [
  ...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32),
]
  .map((digit) => String.fromCharCode(97 + parseInt(digit, 16)))
  .join('');
assert.equal(extensionId, identity.extensionId);
assert.equal(extensionId, 'eehghiicklfpnhliknglhagcipkjkjjf');
assert.equal(isolated.state, 'PASSED');
assert.equal(isolated.actualBrowserOperations, 0);
assert.equal(isolated.actualSdkFileTransfer, false);
assert.equal(isolated.userResourceDirectoriesRead, false);
assert.equal(isolated.cases.length, 3);
const parent = path.resolve(isolated.isolated);
assert.equal(path.dirname(parent), path.resolve('audit'));
assert.ok(path.basename(parent).startsWith('upload-stage-ledger-isolated-'));
for (const row of isolated.cases) {
  assert.equal(row.sourceUnchanged, true);
  assert.equal(row.cacheRetainedAfterRecovery, true);
  assert.equal(row.beforeIO, true);
  assert.equal(row.recovered.state, 'REVIEW');
  assert.equal(row.restagingRejected, true);
  assert.deepEqual(row.recovered.owner.binding, row.binding);
  assert.deepEqual(row.recovered.manifest, row.manifest);
  assert.equal(path.dirname(path.resolve(row.database)), parent);
  const db = new DatabaseSync(row.database, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10);
    assert.equal(db.prepare('SELECT state FROM material_upload_stage_state').get().state, 'REVIEW');
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM material_upload_stage_manifests').get().n,
      1,
    );
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
const sha = (text) => createHash('sha256').update(text).digest('hex');
const migration8 = sha(materialIndexMigration),
  migration9 = sha(materialPostMigration);
assert.equal(migration8, '322d9aa2ecd630f8f76a136dcbafe7f350a0b1c1fd3a3364156c8e9c1ed6aa18');
assert.equal(migration9, '832587863cb9976fd6da3ad11c266aa49a00431423113c977d2004bafddd4662');
const candidates = (await readdir(after.directory))
  .filter((name) => name.startsWith('workspace.sqlite.before-v10-'))
  .sort();
assert.equal(candidates.length, 1);
const backupFile = path.join(after.directory, candidates[0]);
const backupDb = new DatabaseSync(backupFile, { readOnly: true }),
  productDb = new DatabaseSync(path.join(after.directory, 'workspace.sqlite'), { readOnly: true });
let oldSchemaEntries = 0;
try {
  assert.equal(backupDb.prepare('PRAGMA user_version').get().user_version, 9);
  assert.equal(productDb.prepare('PRAGMA user_version').get().user_version, 10);
  const originals = backupDb
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
  oldSchemaEntries = originals.length;
  for (const entry of originals)
    assert.deepEqual(
      productDb
        .prepare('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name=?')
        .get(entry.name),
      entry,
    );
  for (const [field, sql] of Object.entries({
    groups: 'SELECT * FROM groups ORDER BY id',
    profileMetadata: 'SELECT * FROM profile_metadata ORDER BY profile_id',
    combinations: 'SELECT * FROM combinations ORDER BY id',
    savedVersions: 'SELECT * FROM combination_versions ORDER BY combination_id,version',
  }))
    assert.equal(sha(JSON.stringify(backupDb.prepare(sql).all())), before.preservation[field]);
} finally {
  backupDb.close();
  productDb.close();
}
const log = await readFile('audit/check-upload-stage-ledger-final.log', 'utf8');
assert.match(log, /tests 363/);
assert.match(log, /pass 363/);
assert.match(log, /fail 0/);
try {
  await access('audit/kernel-upload-live-2b32bd78-51d0-4576-a12b-252c4d3c2d9b.json');
  throw Error('LIVE_DIAGNOSTIC_PRESENT_REVIEW_SEPARATELY');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const report = {
  state: 'PASSED_INTERNAL_CACHE_LEDGER',
  recordedAt: new Date().toISOString(),
  softwareVersion: '0.1.22',
  schema: { product: 10, journal: 2 },
  checks: {
    total: 363,
    newSemanticTests: 10,
    failed: 0,
    sourceDesktopUpgrade: true,
    packagedDesktopUpgrade: true,
    formalPreferencesPreserved: true,
    formalExecutionAndMaterialTablesEmpty: true,
    priorSchemaEntriesPreserved: oldSchemaEntries,
    originalBindingBeforeIO: true,
    passiveReopenPreserved: true,
    explicitStartupRevokesReadyAndWriting: true,
    lateCompletionAndChangedActorRetained: true,
    transactionalRetainedCapacity: true,
    manifestCommitRollback: true,
    noRestagingOrReviewRevival: true,
  },
  backupFile,
  migrationSqlSha256: { 8: migration8, 9: migration9, 10: sha(materialUploadStageMigration) },
  isolated: isolated.isolated,
  retainedMediaFiles: 4,
  actualBrowserOperations: 0,
  actualSdkFileTransfer: false,
  facebookBusinessVerified: false,
  userMaterialFilesMoved: false,
  productionEnabled: false,
  cacheCleanupImplemented: false,
  archiveWorkerImplemented: false,
  nextArchiveMigration: 11,
  service,
  sourceEvidence: 'audit/upload-stage-ledger-source-smoke.json',
  packagedEvidence: 'audit/upload-stage-ledger-packaged-smoke.json',
  liveSdkDiagnostic: 'WAITING_CONFIRMED_CHROME_036',
  limits: {
    budgetIsRetainedMediaPayloadNotOsQuota: true,
    unknownStagesRemainCharged: true,
    nativeFileGrantIsStillVolatile: true,
    noAutomaticCacheAdoption: true,
    cleanupNeedsIndependentTerminalAndNativeReleaseProof: true,
  },
};
await writeFile('audit/upload-stage-ledger-results.json', JSON.stringify(report, null, 2) + '\n', {
  flag: 'wx',
});
console.log(
  JSON.stringify({
    state: report.state,
    checks: report.checks,
    backupFile,
    servicePid: service.servicePid,
    actualBrowserOperations: 0,
  }),
);
