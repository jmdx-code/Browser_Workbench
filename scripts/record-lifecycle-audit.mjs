import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { WorkspaceSchema } from '../dist/src/shared/contracts.js';
import { TaskOverview } from '../dist/src/shared/task-contracts.js';
import {
  TaskControlBinding,
  SessionStopReceipt,
  sameStop,
} from '../dist/src/shared/task-control.js';
const load = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const metadata = await load('package.json'),
  manifest = await load('extension-build/manifest.json');
if (metadata.version !== '0.1.9' || manifest.version !== '0.3.3')
  throw Error('LIFECYCLE_VERSION_MISMATCH');
const log = await readFile('audit/check-lifecycle.log', 'utf8');
const metric = (name) => {
  const value = log.match(new RegExp('(?:#|ℹ)\\s*' + name + '\\s+(\\d+)'));
  if (!value) throw Error('MISSING_METRIC_' + name);
  return Number(value[1]);
};
const checks = { total: metric('tests'), passed: metric('pass'), failed: metric('fail') };
if (checks.total !== 176 || checks.passed !== checks.total || checks.failed)
  throw Error('PROGRAM_CHECK_FAILED');
const before = await load('audit/lifecycle-preflight.json'),
  after = await load('audit/lifecycle-postflight.json');
if (
  before.schema.product !== 5 ||
  after.schema.product !== 6 ||
  after.schema.journal !== 2 ||
  before.profiles !== after.profiles ||
  JSON.stringify(before.preservation) !== JSON.stringify(after.preservation) ||
  after.plans ||
  after.bindings ||
  after.taskTabs ||
  after.settlementNotices ||
  after.controlBindings ||
  after.unresolvedOutbox ||
  after.unresolvedBridgeOperations ||
  after.activeBridgeTasks
)
  throw Error('FORMAL_WORKSPACE_CHANGED');
const backupName = (await readdir(after.directory)).find((name) =>
  name.startsWith('workspace.sqlite.before-v6-'),
);
if (!backupName) throw Error('MIGRATION_BACKUP_MISSING');
const backupFile = path.join(after.directory, backupName),
  backup = new DatabaseSync(backupFile, { readOnly: true });
try {
  const digest = (sql) => hash(JSON.stringify(backup.prepare(sql).all()));
  if (
    backup.prepare('PRAGMA user_version').get()?.user_version !== 5 ||
    digest('SELECT * FROM groups ORDER BY id') !== before.preservation.groups ||
    digest('SELECT * FROM profile_metadata ORDER BY profile_id') !==
      before.preservation.profileMetadata ||
    digest('SELECT * FROM combinations ORDER BY id') !== before.preservation.combinations ||
    digest('SELECT * FROM combination_versions ORDER BY combination_id,version') !==
      before.preservation.savedVersions
  )
    throw Error('MIGRATION_BACKUP_CHANGED');
} finally {
  backup.close();
}
const smoke = await Promise.all(
  ['audit/lifecycle-source-final-smoke.json', 'audit/lifecycle-packaged-smoke.json'].map(load),
);
if (
  smoke.some(
    (row) =>
      !row.ok ||
      row.workspaceDatabaseVersion !== 6 ||
      row.seedSchemaVersion !== 6 ||
      !row.closePersisted ||
      row.htmlFacts.nodeExposed ||
      row.htmlFacts.overflow,
  )
)
  throw Error('DESKTOP_SMOKE_FAILED');
const profileId = '2b32bd78-51d0-4576-a12b-252c4d3c2d9b';
const failed = await load('audit/kernel-lifecycle-live-' + profileId + '.json');
const real = await load('audit/kernel-lifecycle-v2-live-' + profileId + '.json');
if (
  failed.passed ||
  !failed.failures.includes('BUSINESS_RECONCILIATION_FAILED') ||
  !real.passed ||
  !real.realBrowser ||
  real.facebookOperations ||
  real.checks.length !== 5 ||
  real.failures.length ||
  real.evidence.nativeInputCalls ||
  real.evidence.cancellationMilliseconds >= 5000 ||
  real.evidence.finalPlanState !== 'STOPPED' ||
  real.evidence.unknownAccountLocks !== 1
)
  throw Error('REAL_LIFECYCLE_CHECK_FAILED');
const relative = path.relative(path.resolve('audit'), real.isolatedDirectory);
if (
  relative.startsWith('..') ||
  path.isAbsolute(relative) ||
  !relative.startsWith('lifecycle-isolated-')
)
  throw Error('AUDIT_DIRECTORY_REJECTED');
const db = new DatabaseSync(path.join(real.isolatedDirectory, 'workspace.sqlite'), {
  readOnly: true,
});
try {
  const row = db
    .prepare(
      'SELECT b.body,r.body AS receipt FROM task_control_bindings b JOIN task_control_receipts r USING(request_id)',
    )
    .get();
  if (!row) throw Error('CONTROL_RECEIPT_MISSING');
  const binding = TaskControlBinding.parse(JSON.parse(row.body)),
    receipt = SessionStopReceipt.parse(JSON.parse(row.receipt));
  const plan = db.prepare('SELECT * FROM task_plans WHERE id=?').get(binding.jobId);
  if (
    !sameStop(binding, receipt) ||
    plan?.control_request_id !== binding.requestId ||
    !plan.control_confirmed ||
    plan.control_mode !== 'stop' ||
    plan.state !== 'STOPPED' ||
    db.prepare('SELECT count(*) AS count FROM task_account_locks').get()?.count ||
    db.prepare('SELECT state FROM task_tab_state').get()?.state !== 'RECHECK_REQUIRED' ||
    db.prepare('SELECT state FROM task_settlement_delivery').get()?.state !== 'DELIVERED'
  )
    throw Error('PERSISTED_LIFECYCLE_NOT_MATCHED');
} finally {
  db.close();
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
  !workspace.profiles.some(
    (p) => p.id === profileId && p.online && p.phase === 'PAUSED' && p.extensionVersion === '0.3.3',
  )
)
  throw Error('PRODUCTION_NOT_PAUSED');
const report = {
  recordedAt: new Date().toISOString(),
  stage: '2e-profile-actor-lifecycle-and-persistent-stop',
  productVersion: metadata.version,
  extension: { version: manifest.version, changed: false, refreshRequired: false },
  programChecks: { ...checks, additional: 15, logSha256: hash(log) },
  migration: {
    from: 5,
    to: 6,
    backup: backupFile,
    backupPreserved: true,
    previousMigrationsChanged: false,
  },
  desktop: smoke.map((row, index) => ({
    target: index ? 'packaged-exe' : 'source',
    ok: row.ok,
    schema: row.workspaceDatabaseVersion,
    seedSchema: row.seedSchemaVersion,
    closePersisted: row.closePersisted,
    isolated: true,
  })),
  executableSha256: hash(await readFile('release/win-unpacked/Browser Workbench.exe')),
  realBrowser: {
    profileId,
    browser: real.browser,
    checks: real.checks,
    cancellationMilliseconds: real.evidence.cancellationMilliseconds,
    nativeInputCalls: 0,
    isolatedDirectory: real.isolatedDirectory,
    finalPlanState: 'STOPPED',
    nativeTabClosed: false,
  },
  correctedRace: {
    initialReport: 'audit/kernel-lifecycle-live-' + profileId + '.json',
    issue: 'SDK cancellation callback demoted user stop to pause',
    fixedAndRechecked: true,
    initialEvidencePreserved: true,
  },
  production: {
    profiles: after.profiles,
    plans: 0,
    bindings: 0,
    taskTabs: 0,
    settlementNotices: 0,
    controlBindings: 0,
    dispatchEnabled: false,
    workspacePreserved: true,
    actorRegistryEnabled: false,
  },
  facebookOperations: false,
  limits: [
    'Registry and native stop adapter integrated in isolated real fixture, production owner discovery/API still pending',
    'Unconfirmed/contradictory native stop retains fenced owner; recovery needs trusted transport stop evidence',
    'Fixture identity only; no FB identity, business loop, publishing or 29-profile/long-run acceptance',
    'Second profile historical ACK remains blocked pending trusted notification; no history replay',
  ],
};
await writeFile('audit/lifecycle-results.json', JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    productVersion: report.productVersion,
    programChecks: checks,
    realBrowserChecks: real.checks.length,
    cancellationMilliseconds: real.evidence.cancellationMilliseconds,
    production: report.production,
  }),
);
