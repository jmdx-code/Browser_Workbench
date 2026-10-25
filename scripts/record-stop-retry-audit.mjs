import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import {
  TaskControlBinding,
  SessionStopReceipt,
  sameStop,
} from '../dist/src/shared/task-control.js';
import { WorkspaceSchema } from '../dist/src/shared/contracts.js';
import { TaskOverview } from '../dist/src/shared/task-contracts.js';
const load = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const metadata = await load('package.json'),
  manifest = await load('extension-build/manifest.json');
if (metadata.version !== '0.1.11' || manifest.version !== '0.3.3')
  throw Error('RETRY_VERSION_MISMATCH');
const log = await readFile('audit/check-stop-retry-final.log', 'utf8');
const metric = (name) => {
  const value = log.match(new RegExp('(?:#|ℹ)\\s*' + name + '\\s+(\\d+)'));
  if (!value) throw Error('MISSING_METRIC_' + name);
  return Number(value[1]);
};
const checks = { total: metric('tests'), passed: metric('pass'), failed: metric('fail') };
if (checks.total !== 210 || checks.passed !== checks.total || checks.failed)
  throw Error('CHECK_FAILED');
const before = await load('audit/stop-retry-preflight.json'),
  after = await load('audit/stop-retry-postflight.json');
const zeroFields = [
  'plans',
  'bindings',
  'taskTabs',
  'settlementNotices',
  'controlBindings',
  'browseIntents',
  'unresolvedOutbox',
  'unresolvedBridgeOperations',
  'activeBridgeTasks',
];
if (
  before.schema.product !== 7 ||
  after.schema.product !== 7 ||
  after.schema.journal !== 2 ||
  before.profiles !== after.profiles ||
  JSON.stringify(before.preservation) !== JSON.stringify(after.preservation) ||
  zeroFields.some((field) => before[field] || after[field])
)
  throw Error('FORMAL_STATE_CHANGED');
const smoke = await Promise.all(
  ['audit/stop-retry-source-smoke.json', 'audit/stop-retry-packaged-smoke.json'].map(load),
);
if (
  smoke.some(
    (row) =>
      !row.ok ||
      row.workspaceDatabaseVersion !== 7 ||
      row.seedSchemaVersion !== 7 ||
      !row.closePersisted ||
      row.htmlFacts.nodeExposed ||
      row.htmlFacts.overflow,
  )
)
  throw Error('SMOKE_FAILED');
const real = await load('audit/kernel-stop-retry-live.json');
if (
  !real.passed ||
  !real.realBrowser ||
  real.facebookOperations ||
  real.checks.length !== 4 ||
  real.failures.length ||
  real.evidence.nativeInputCalls !== 0 ||
  real.evidence.nativeStopRequests !== 1 ||
  real.evidence.finalPlanState !== 'STOPPED' ||
  real.faultBoundary !==
    'managed service result lost after actual native stop; not wire disconnection'
)
  throw Error('REAL_RETRY_FAILED');
const relative = path.relative(path.resolve('audit'), real.isolatedDirectory);
if (
  relative.startsWith('..') ||
  path.isAbsolute(relative) ||
  !relative.startsWith('stop-retry-isolated-')
)
  throw Error('AUDIT_PATH_REJECTED');
const receipt = SessionStopReceipt.parse(real.evidence.nativeReceiptBeforeLoss),
  binding = TaskControlBinding.parse(real.evidence.controlAfterRetry.binding);
if (!sameStop(binding, receipt) || real.evidence.controlBeforeRetry.receipt !== null)
  throw Error('NATIVE_BINDING_CHANGED');
const db = new DatabaseSync(path.join(real.isolatedDirectory, 'workspace.sqlite'), {
  readOnly: true,
});
try {
  const row = db
    .prepare(
      'SELECT b.body,r.body AS receipt FROM task_control_bindings b JOIN task_control_receipts r USING(request_id)',
    )
    .get();
  const plan = db.prepare('SELECT * FROM task_plans WHERE id=?').get(binding.jobId);
  if (
    !row ||
    !sameStop(TaskControlBinding.parse(JSON.parse(row.body)), receipt) ||
    !sameStop(SessionStopReceipt.parse(JSON.parse(row.receipt)), receipt) ||
    plan?.state !== 'STOPPED' ||
    !plan.control_confirmed ||
    plan.control_request_id !== receipt.requestId ||
    db.prepare('SELECT count(*) AS count FROM task_account_locks').get()?.count ||
    db.prepare('SELECT count(*) AS count FROM task_outbox').get()?.count ||
    db.prepare('SELECT state FROM task_tab_state').get()?.state !== 'RECHECK_REQUIRED'
  )
    throw Error('PERSISTED_STOP_NOT_MATCHED');
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
  workspace.support.comboExecution ||
  workspace.support.accountIdentity ||
  workspace.profiles.length !== after.profiles
)
  throw Error('PRODUCTION_GATE_CHANGED');
const report = {
  recordedAt: new Date().toISOString(),
  stage: '2e-explicit-same-owner-stop-recovery',
  productVersion: metadata.version,
  extension: { version: manifest.version, changed: false, refreshRequired: false },
  schema: after.schema,
  programChecks: { ...checks, additional: 11, logSha256: hash(log) },
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
    profileId: real.profileId,
    browser: real.browser,
    checks: real.checks,
    isolatedDirectory: real.isolatedDirectory,
    faultBoundary: real.faultBoundary,
    nativeInputCalls: 0,
    nativeStopRequests: 1,
    finalPlanState: 'STOPPED',
    nativeTabClosed: false,
  },
  production: {
    profiles: after.profiles,
    plans: 0,
    bindings: 0,
    taskTabs: 0,
    settlementNotices: 0,
    controlBindings: 0,
    browseIntents: 0,
    dispatchEnabled: false,
    actorRegistryEnabled: false,
    workspacePreserved: true,
  },
  facebookOperations: false,
  limits: [
    'Real test injected managed-service result loss after confirmed native stop; wire response loss only covered by simulated port tests',
    'Explicit original-session recovery; changed transport, restart invalidated request or unconfirmed local endpoint remains blocked',
    'No public retry API, production session factory/tab turnover, FB identity or SDK browse driver yet',
    'No material transaction, publishing formats, real 29-profile or long-run acceptance; full V1 not complete',
    'Second historical ACK still needs trusted historical notification; original evidence retained',
  ],
};
await writeFile('audit/stop-retry-results.json', JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    productVersion: report.productVersion,
    programChecks: checks,
    realBrowserChecks: real.checks.length,
    nativeInputCalls: 0,
    nativeStopRequests: 1,
    dispatchEnabled: false,
  }),
);
