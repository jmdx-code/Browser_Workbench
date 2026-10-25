import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, lstat, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { materialIndexMigration } from '../dist/src/infrastructure/material-index-migration.js';
import { materialPostMigration } from '../dist/src/infrastructure/material-post-migration.js';
import { materialUploadStageMigration } from '../dist/src/infrastructure/material-upload-stage-migration.js';
import { materialCacheCleanupMigration } from '../dist/src/infrastructure/material-cache-cleanup-migration.js';

const json = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const [before, after, source, packaged, isolated, service, owner, manifest, identity] =
  await Promise.all(
    [
      'audit/cache-cleanup-preflight.json',
      'audit/cache-cleanup-postflight.json',
      'audit/cache-cleanup-source-smoke.json',
      'audit/cache-cleanup-packaged-smoke.json',
      'audit/cache-cleanup-isolated.json',
      'audit/cache-cleanup-service.json',
      'audit/cache-cleanup-owner-after.json',
      'extension-build/manifest.json',
      'config/extension-identity.json',
    ].map(json),
  );
assert.deepEqual(before.schema, { product: 10, journal: 2 });
assert.deepEqual(after.schema, { product: 11, journal: 2 });
assert.deepEqual(after.preservation, before.preservation);
assert.equal(after.profiles, 9);
for (const [key, value] of Object.entries(after))
  if (typeof value === 'number' && key !== 'profiles') assert.equal(value, 0);
for (const smoke of [source, packaged]) {
  assert.equal(smoke.ok, true);
  assert.equal(smoke.seedSchemaVersion, 10);
  assert.equal(smoke.workspaceDatabaseVersion, 11);
  assert.equal(smoke.closePersisted, true);
  assert.equal(smoke.htmlFacts.overflow, false);
  assert.equal(smoke.htmlFacts.nodeExposed, false);
}
assert.equal(service.httpStatus, 200);
assert.equal(service.softwareVersion, '0.1.23');
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
  .map((d) => String.fromCharCode(97 + parseInt(d, 16)))
  .join('');
assert.equal(extensionId, identity.extensionId);
assert.equal(extensionId, 'eehghiicklfpnhliknglhagcipkjkjjf');
assert.equal(isolated.state, 'PASSED');
assert.equal(isolated.actualCacheDeletion, true);
assert.equal(isolated.actualBrowserOperations, 0);
assert.equal(isolated.actualFacebookPublication, false);
assert.equal(isolated.userResourceDirectoriesRead, false);
assert.equal(isolated.archivalMovement, false);
assert.equal(isolated.cases.length, 4);
const parent = path.resolve(isolated.isolated);
assert.equal(path.dirname(parent), path.resolve('audit'));
assert.ok(path.basename(parent).startsWith('cache-cleanup-isolated-'));
for (const row of isolated.cases) {
  assert.equal(path.dirname(path.resolve(row.database)), parent);
  assert.equal(row.sourceUnchanged, true);
  assert.equal(row.businessUnchanged, true);
  assert.equal(row.progressUnchanged, true);
  assert.equal(row.cleaned.state, 'CLEANED');
  assert.deepEqual(row.cleaned.plan.owner.binding, row.binding);
  const root = path.resolve(row.cleaned.plan.owner.cacheRoot);
  assert.equal(path.dirname(root), parent);
  await assert.rejects(lstat(path.join(root, row.manifest.stageId)), { code: 'ENOENT' });
  for (const file of row.sourceHashes)
    assert.equal(
      createHash('sha256')
        .update(await readFile(path.join(parent, 'generated-materials', file.name)))
        .digest('hex'),
      file.sha256,
    );
  const db = new DatabaseSync(row.database, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11);
    assert.equal(
      db.prepare('SELECT state FROM material_cache_cleanup_state').get().state,
      'CLEANED',
    );
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM material_cache_cleanup_completions').get().n,
      1,
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM material_upload_stage_owners').get().n, 1);
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM material_upload_stage_manifests').get().n,
      1,
    );
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM material_cache_cleanup_files WHERE state='DELETED'")
        .get().n,
      row.manifest.files.length + 1,
    );
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM material_publications').get().n,
      row.verdict === 'PUBLISHED' ? 1 : 0,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM material_archive_state WHERE state='PENDING'").get().n,
      row.verdict === 'PUBLISHED' ? 1 : 0,
    );
  } finally {
    db.close();
  }
}
const sha = (text) => createHash('sha256').update(text).digest('hex');
const migrationSqlSha256 = {
  8: sha(materialIndexMigration),
  9: sha(materialPostMigration),
  10: sha(materialUploadStageMigration),
  11: sha(materialCacheCleanupMigration),
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
const candidates = (await readdir(after.directory)).filter((name) =>
  name.startsWith('workspace.sqlite.before-v11-'),
);
assert.equal(candidates.length, 1);
const backupFile = path.join(after.directory, candidates[0]),
  backup = new DatabaseSync(backupFile, { readOnly: true }),
  product = new DatabaseSync(path.join(after.directory, 'workspace.sqlite'), { readOnly: true });
let priorSchemaEntries;
try {
  assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 10);
  assert.equal(product.prepare('PRAGMA user_version').get().user_version, 11);
  const original = backup
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
  priorSchemaEntries = original.length;
  for (const entry of original)
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
const log = await readFile('audit/check-cache-cleanup-final.log', 'utf8');
assert.match(log, /tests 377/);
assert.match(log, /pass 377/);
assert.match(log, /fail 0/);
await assert.rejects(access('audit/kernel-upload-live-2b32bd78-51d0-4576-a12b-252c4d3c2d9b.json'), {
  code: 'ENOENT',
});
const report = {
  state: 'PASSED_INTERNAL_CACHE_CLEANUP',
  recordedAt: new Date().toISOString(),
  softwareVersion: '0.1.23',
  schema: { product: 11, journal: 2 },
  checks: {
    total: 377,
    newSemanticTests: 14,
    failed: 0,
    sourceDesktopUpgrade: true,
    packagedDesktopUpgrade: true,
    formalPreferencesPreserved: true,
    formalExecutionAndMaterialTablesEmpty: true,
    priorSchemaEntriesPreserved: priorSchemaEntries,
    originalTerminalCloseAndStopGate: true,
    unknownAndAuxiliaryNotReclaimable: true,
    persistentPerFileAndDirectoryIntent: true,
    passiveReopenPreserved: true,
    explicitRecoveryRevokesStaleClaim: true,
    completionAndCapacityAtomic: true,
    sourceAndBusinessFactsPreserved: true,
  },
  backupFile,
  migrationSqlSha256,
  isolated: isolated.isolated,
  actualDeletedGeneratedMedia: 5,
  actualBrowserOperations: 0,
  actualSdkFileTransfer: false,
  actualFacebookPublication: false,
  archivalMovement: false,
  userResourceDirectoriesRead: false,
  productionEnabled: false,
  limitations: [
    'internal explicit component only; no production cleanup scheduler or public deletion API',
    'no persisted manifest means partial WRITING cache retained; cleanup still pending',
    'identity/business/native close/stop simulated in these isolated records',
    'OS privilege races and sudden power loss not proved',
    'archive remains PENDING; actual 已发 movement not implemented',
    'Chrome0.3.6 upload diagnostic still waits; no repeat notification',
  ],
  evidence: [
    'audit/check-cache-cleanup-final.log',
    'audit/cache-cleanup-focused-first.log',
    'audit/cache-cleanup-focused-second.log',
    'audit/cache-cleanup-isolated.json',
    'audit/cache-cleanup-source-smoke.json',
    'audit/cache-cleanup-packaged-smoke.json',
    'audit/cache-cleanup-preflight.json',
    'audit/cache-cleanup-postflight.json',
    'audit/cache-cleanup-service.json',
  ],
};
await writeFile('audit/cache-cleanup-results.json', JSON.stringify(report, null, 2) + '\n', {
  flag: 'wx',
});
console.log(JSON.stringify(report));
