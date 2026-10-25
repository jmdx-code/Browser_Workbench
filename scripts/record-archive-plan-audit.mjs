import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, lstat, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { materialIndexMigration } from '../dist/src/infrastructure/material-index-migration.js';
import { materialPostMigration } from '../dist/src/infrastructure/material-post-migration.js';
import { materialUploadStageMigration } from '../dist/src/infrastructure/material-upload-stage-migration.js';
import { materialCacheCleanupMigration } from '../dist/src/infrastructure/material-cache-cleanup-migration.js';
import { materialArchivePreparationMigration } from '../dist/src/infrastructure/material-archive-migration.js';

const json = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const [before, after, source, packaged, isolated, service, owner, manifest, identity] =
  await Promise.all(
    [
      'audit/archive-plan-preflight.json',
      'audit/archive-plan-postflight.json',
      'audit/archive-plan-source-smoke.json',
      'audit/archive-plan-packaged-smoke.json',
      'audit/archive-plan-isolated.json',
      'audit/archive-plan-service.json',
      'audit/archive-plan-owner-after.json',
      'extension-build/manifest.json',
      'config/extension-identity.json',
    ].map(json),
  );
assert.deepEqual(before.schema, { product: 11, journal: 2 });
assert.deepEqual(after.schema, { product: 12, journal: 2 });
assert.deepEqual(after.preservation, before.preservation);
assert.equal(after.profiles, 9);
for (const [key, value] of Object.entries(after))
  if (typeof value === 'number' && key !== 'profiles') assert.equal(value, 0);
for (const smoke of [source, packaged]) {
  assert.equal(smoke.ok, true);
  assert.equal(smoke.seedSchemaVersion, 11);
  assert.equal(smoke.workspaceDatabaseVersion, 12);
  assert.equal(smoke.closePersisted, true);
  assert.equal(smoke.htmlFacts.overflow, false);
  assert.equal(smoke.htmlFacts.nodeExposed, false);
}
assert.equal(service.httpStatus, 200);
assert.equal(service.softwareVersion, '0.1.24');
assert.equal(service.legacyAuditFlagsEnabled, false);
assert.equal(service.uploadAuditEnabled, true);
assert.equal(service.productionEnabled, false);
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
  .map((d) => String.fromCharCode(97 + parseInt(d, 16)))
  .join('');
assert.equal(extensionId, identity.extensionId);
assert.equal(extensionId, 'eehghiicklfpnhliknglhagcipkjkjjf');
assert.equal(isolated.state, 'PASSED');
assert.equal(isolated.actualSourceVerification, true);
assert.equal(isolated.actualArchiveMovement, false);
assert.equal(isolated.destinationDirectoriesCreated, false);
assert.equal(isolated.actualBrowserOperations, 0);
assert.equal(isolated.actualSdkFileTransfer, false);
assert.equal(isolated.actualFacebookPublication, false);
assert.equal(isolated.userResourceDirectoriesRead, false);
assert.equal(isolated.cases.length, 4);
assert.deepEqual(
  isolated.cases.map((row) => row.format),
  ['text', 'single-image', 'multi-image', 'video'],
);
const parent = path.resolve(isolated.isolated);
assert.equal(path.dirname(parent), path.resolve('audit'));
assert.ok(path.basename(parent).startsWith('archive-plan-isolated-'));
let preparedFiles = 0;
for (const row of isolated.cases) {
  assert.equal(path.dirname(path.resolve(row.database)), parent);
  assert.equal(row.saved.state, 'READY');
  assert.equal(row.sourceUnchanged, true);
  assert.equal(row.businessUnchanged, true);
  assert.equal(row.progressUnchanged, true);
  assert.equal(row.archiveStillPending, true);
  assert.equal(row.destinationAbsent, true);
  preparedFiles += row.saved.plan.files.length;
  assert.equal(path.dirname(row.saved.plan.destination), row.saved.request.archiveDirectory);
  await assert.rejects(lstat(row.saved.plan.destination), { code: 'ENOENT' });
  await assert.rejects(lstat(row.saved.request.archiveDirectory), { code: 'ENOENT' });
  for (const f of row.sourceHashes)
    assert.equal(
      createHash('sha256')
        .update(await readFile(path.join(parent, 'generated-materials', f.name)))
        .digest('hex'),
      f.sha256,
    );
  const db = new DatabaseSync(row.database, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
    assert.equal(db.prepare('SELECT state FROM material_archive_state').get().state, 'PENDING');
    assert.equal(db.prepare('SELECT state FROM material_archive_preparation').get().state, 'READY');
    assert.equal(db.prepare('SELECT count(*) AS n FROM material_archive_plans').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM material_publications').get().n, 1);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name='archive_completion_not_implemented'",
        )
        .get().n,
      1,
    );
  } finally {
    db.close();
  }
}
assert.equal(preparedFiles, 7);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const migrationSqlSha256 = {
  8: sha(materialIndexMigration),
  9: sha(materialPostMigration),
  10: sha(materialUploadStageMigration),
  11: sha(materialCacheCleanupMigration),
  12: sha(materialArchivePreparationMigration),
};
assert.equal(
  migrationSqlSha256[8],
  '322d9aa2ecd630f8f76a136dcbafe7f350a0b1c1fd3a3364156c8e9c1ed6aa18',
);
assert.equal(
  migrationSqlSha256[9],
  '832587863cb9976fd6da3ad11c266aa49a00431423113c977d2004bafddd4662',
);
assert.equal(
  migrationSqlSha256[10],
  '080c147f93239c819098ddda961e2ec741d6a45bed98d6d28bd0f2182c3100ca',
);
assert.equal(
  migrationSqlSha256[11],
  '60f0a469d4b9fa0ab72742c074c2d7cb5bc0da0a9db7820d10deb12244cccbd3',
);
const candidates = (await readdir(after.directory)).filter((name) =>
  name.startsWith('workspace.sqlite.before-v12-'),
);
assert.equal(candidates.length, 1);
const backupFile = path.join(after.directory, candidates[0]),
  backup = new DatabaseSync(backupFile, { readOnly: true }),
  product = new DatabaseSync(path.join(after.directory, 'workspace.sqlite'), { readOnly: true });
let priorSchemaEntries;
try {
  assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 11);
  assert.equal(product.prepare('PRAGMA user_version').get().user_version, 12);
  const originals = backup
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
  priorSchemaEntries = originals.length;
  for (const entry of originals)
    assert.deepEqual(
      product
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
    assert.equal(sha(JSON.stringify(backup.prepare(sql).all())), before.preservation[field]);
} finally {
  backup.close();
  product.close();
}
const log = await readFile('audit/check-archive-plan-final.log', 'utf8');
assert.match(log, /tests 389/);
assert.match(log, /pass 389/);
assert.match(log, /fail 0/);
await assert.rejects(access('audit/kernel-upload-live-2b32bd78-51d0-4576-a12b-252c4d3c2d9b.json'), {
  code: 'ENOENT',
});
const report = {
  state: 'PASSED_INTERNAL_ARCHIVE_PLANNING',
  recordedAt: new Date().toISOString(),
  softwareVersion: '0.1.24',
  schema: { product: 12, journal: 2 },
  checks: {
    total: 389,
    newSemanticTests: 12,
    failed: 0,
    sourceDesktopUpgrade: true,
    packagedDesktopUpgrade: true,
    formalPreferencesPreserved: true,
    formalExecutionAndMaterialTablesEmpty: true,
    priorSchemaEntriesPreserved: priorSchemaEntries,
    publicationAndNoticeGate: true,
    immutableDeterministicTargets: true,
    wholePackageSourceVerification: true,
    foreignDestinationRetained: true,
    passiveReopenPreserved: true,
    explicitRecoveryAndLateResultFenced: true,
    planAndReadyAtomic: true,
    completionStillBlocked: true,
  },
  backupFile,
  migrationSqlSha256,
  isolated: isolated.isolated,
  preparedGeneratedFiles: 7,
  actualArchiveMovement: false,
  destinationDirectoriesCreated: false,
  actualBrowserOperations: 0,
  actualSdkFileTransfer: false,
  actualFacebookPublication: false,
  userResourceDirectoriesRead: false,
  productionEnabled: false,
  limitations: [
    'READY is an immutable planning witness, never permission to move files; source/target need fresh checks before side effects',
    'actual copy-verify-delete ledger, destination creation ownership, per-file proof, interrupted/cross-volume recovery and COMPLETED not implemented',
    'incomplete WRITING caches without manifest still retained',
    'no production archive scheduler or public mutation API',
    'all publication/account/target/notification observations simulated',
    'Chrome0.3.6 real upload diagnostic still waiting; no repeat notification',
  ],
  evidence: [
    'audit/check-archive-plan-final.log',
    'audit/archive-plan-focused-first.log',
    'audit/archive-plan-focused-second.log',
    'audit/archive-plan-isolated.json',
    'audit/archive-plan-source-smoke.json',
    'audit/archive-plan-packaged-smoke.json',
    'audit/archive-plan-preflight.json',
    'audit/archive-plan-postflight.json',
    'audit/archive-plan-service.json',
  ],
};
await writeFile('audit/archive-plan-results.json', JSON.stringify(report, null, 2) + '\n', {
  flag: 'wx',
});
console.log(JSON.stringify(report));
