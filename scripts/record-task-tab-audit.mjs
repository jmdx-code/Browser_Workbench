import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { WorkspaceSchema } from '../dist/src/shared/contracts.js';
import { TaskOverview } from '../dist/src/shared/task-contracts.js';

const load = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const metadata = await load('package.json'),
  manifest = await load('extension-build/manifest.json');
if (metadata.version !== '0.1.6' || manifest.version !== '0.3.3')
  throw Error('TASK_TAB_VERSION_MISMATCH');
const log = await readFile('audit/check-task-tabs.log', 'utf8');
const metric = (name) => {
  const match = log.match(new RegExp('(?:#|ℹ)\\s*' + name + '\\s+(\\d+)'));
  if (!match) throw Error('MISSING_CHECK_' + name);
  return Number(match[1]);
};
const checks = { total: metric('tests'), passed: metric('pass'), failed: metric('fail') };
if (checks.total !== 134 || checks.passed !== checks.total || checks.failed)
  throw Error('TASK_TAB_CHECK_FAILED');
const before = await load('audit/task-tab-preflight.json'),
  after = await load('audit/task-tab-postflight.json');
if (
  before.schema.product !== 3 ||
  after.schema.product !== 4 ||
  after.schema.journal !== 2 ||
  before.profiles !== after.profiles ||
  JSON.stringify(before.preservation) !== JSON.stringify(after.preservation) ||
  after.plans ||
  after.bindings ||
  after.taskTabs ||
  after.unresolvedOutbox ||
  after.unresolvedBridgeOperations ||
  after.activeBridgeTasks
)
  throw Error('LIVE_MIGRATION_OR_PRESERVATION_FAILED');
const smoke = await Promise.all(
  ['audit/task-tab-source-smoke.json', 'audit/task-tab-packaged-migration-smoke.json'].map(load),
);
if (
  smoke.some(
    (row) =>
      !row.ok ||
      row.workspaceDatabaseVersion !== 4 ||
      !row.closePersisted ||
      row.htmlFacts.nodeExposed ||
      row.htmlFacts.overflow,
  ) ||
  smoke[1].seedSchemaVersion !== 3
)
  throw Error('TASK_TAB_SMOKE_FAILED');
const backups = (await readdir(after.directory))
  .filter((name) => /^workspace\.sqlite\.before-v4-\d+\.sqlite$/.test(name))
  .sort();
const backupName = backups.at(-1);
if (!backupName) throw Error('MIGRATION_BACKUP_MISSING');
const backup = new DatabaseSync(path.join(after.directory, backupName), { readOnly: true });
try {
  if (backup.prepare('PRAGMA user_version').get()?.user_version !== 3)
    throw Error('BACKUP_VERSION_MISMATCH');
  for (const [key, sql] of Object.entries({
    groups: 'SELECT * FROM groups ORDER BY id',
    profileMetadata: 'SELECT * FROM profile_metadata ORDER BY profile_id',
    combinations: 'SELECT * FROM combinations ORDER BY id',
    savedVersions: 'SELECT * FROM combination_versions ORDER BY combination_id,version',
  }))
    if (
      createHash('sha256')
        .update(JSON.stringify(backup.prepare(sql).all()))
        .digest('hex') !== before.preservation[key]
    )
      throw Error('BACKUP_CONTENT_MISMATCH_' + key);
} finally {
  backup.close();
}
const ids = ['2b32bd78-51d0-4576-a12b-252c4d3c2d9b', '066430e1-92cd-4ee4-8f43-98db3425239d'];
const browserReports = await Promise.all(
  ids.map((id) => load('audit/kernel-task-tab-live-' + id + '.json')),
);
for (const [index, row] of browserReports.entries()) {
  if (
    row.profileId !== ids[index] ||
    !row.passed ||
    !row.associationAudit ||
    !row.realBrowser ||
    row.facebookOperations ||
    row.checks.length !== 11 ||
    row.failures.length ||
    row.evidence.nativeInputsBeforeWaitingStop !== 0 ||
    row.evidence.isolatedFinalPlanState !== 'PAUSED' ||
    row.evidence.taskTabAfterExplicitRecovery.state !== 'RECHECK_REQUIRED' ||
    row.evidence.taskTabAfterExplicitRecovery.context !== null
  )
    throw Error('REAL_TASK_TAB_CHECK_FAILED');
  const db = new DatabaseSync(path.join(row.isolatedDirectory, 'workspace.sqlite'), {
    readOnly: true,
  });
  try {
    if (
      db.prepare('PRAGMA user_version').get()?.user_version !== 4 ||
      db
        .prepare(
          "SELECT count(*) AS count FROM task_outbox WHERE status IN ('DISPATCHING','ACKNOWLEDGED','UNKNOWN')",
        )
        .get()?.count !== 0
    )
      throw Error('ISOLATED_JOURNAL_UNSETTLED');
    const persisted = db
      .prepare('SELECT proof FROM task_tab_ownership WHERE ownership_id=?')
      .get(row.evidence.owned.ownershipId);
    if (
      !persisted ||
      JSON.stringify(JSON.parse(persisted.proof)) !== JSON.stringify(row.evidence.owned)
    )
      throw Error('REAL_TAB_PROOF_NOT_PERSISTED');
  } finally {
    db.close();
  }
}
const landing = await fetch('http://127.0.0.1:18767/'),
  cookie = landing.headers.get('set-cookie')?.split(';')[0];
if (!landing.ok || !cookie) throw Error('ADMIN_SESSION_MISSING');
const get = async (route, schema) => {
  const response = await fetch('http://127.0.0.1:18767' + route, { headers: { cookie } });
  if (!response.ok) throw Error('HTTP_' + response.status);
  return schema.parse(await response.json());
};
const workspace = await get('/api/workspace', WorkspaceSchema),
  tasks = await get('/api/workspace/tasks', TaskOverview);
if (
  tasks.dispatchEnabled ||
  tasks.plans.length ||
  ids.some(
    (id) =>
      !workspace.profiles.some(
        (row) =>
          row.id === id && row.online && row.extensionVersion === '0.3.3' && row.phase === 'PAUSED',
      ),
  )
)
  throw Error('PRODUCTION_NOT_PAUSED');
const report = {
  recordedAt: new Date().toISOString(),
  stage: '2c-software-plan-tab-association',
  productVersion: metadata.version,
  extension: { version: manifest.version, changed: false, refreshRequired: false },
  programChecks: {
    ...checks,
    additional: 9,
    logSha256: createHash('sha256').update(log).digest('hex'),
  },
  desktop: smoke.map((row, index) => ({
    target: index ? 'packaged-exe' : 'source',
    ok: row.ok,
    schema: row.workspaceDatabaseVersion,
    seedSchema: row.seedSchemaVersion,
    closePersisted: row.closePersisted,
    isolated: true,
  })),
  executableSha256: createHash('sha256')
    .update(await readFile('release/win-unpacked/Browser Workbench.exe'))
    .digest('hex'),
  migration: { from: 3, to: 4, backupName, backupContentVerified: true, workspacePreserved: true },
  production: {
    profiles: after.profiles,
    plans: after.plans,
    bindings: after.bindings,
    taskTabs: after.taskTabs,
    dispatchEnabled: tasks.dispatchEnabled,
    formalProfilesPaused: true,
  },
  realBrowserChecks: 22,
  browserReports: browserReports.map((row) => ({
    profileId: row.profileId,
    passed: row.passed,
    checks: row.checks,
    owned: row.evidence.owned,
    isolatedDirectory: row.isolatedDirectory,
  })),
  facebookOperations: false,
  limits: [
    'Same-session local fixtures; no FB/29-profile/long-run verification',
    'Explicit recovery callback in isolated stores, not browser restart or unexpected process-crash recovery',
    'Startup kernel-summary readiness/settlement-notice retry, complete actors/FB identity/semantic results and journal capacity remain pending',
    'Second browser vendor unconfirmed',
  ],
};
await writeFile('audit/task-tab-results.json', JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    productVersion: report.productVersion,
    checks,
    realBrowserChecks: report.realBrowserChecks,
    migration: report.migration,
    production: report.production,
    facebookOperations: false,
  }),
);
