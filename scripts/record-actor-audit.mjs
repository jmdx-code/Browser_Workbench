import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { WorkspaceSchema } from '../dist/src/shared/contracts.js';
import { TaskOverview } from '../dist/src/shared/task-contracts.js';
import { SettlementReceipt, sameNotice } from '../dist/src/shared/settlement.js';
const load = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const metadata = await load('package.json'),
  manifest = await load('extension-build/manifest.json');
if (metadata.version !== '0.1.8' || manifest.version !== '0.3.3')
  throw Error('ACTOR_VERSION_MISMATCH');
const log = await readFile('audit/check-actor.log', 'utf8');
const metric = (name) => {
  const found = log.match(new RegExp('(?:#|ℹ)\\s*' + name + '\\s+(\\d+)'));
  if (!found) throw Error('MISSING_METRIC_' + name);
  return Number(found[1]);
};
const checks = { total: metric('tests'), passed: metric('pass'), failed: metric('fail') };
if (checks.total !== 161 || checks.passed !== checks.total || checks.failed)
  throw Error('ACTOR_PROGRAM_CHECK_FAILED');
const before = await load('audit/actor-preflight.json'),
  after = await load('audit/actor-postflight.json');
if (
  before.schema.product !== 5 ||
  after.schema.product !== 5 ||
  after.schema.journal !== 2 ||
  before.profiles !== after.profiles ||
  JSON.stringify(before.preservation) !== JSON.stringify(after.preservation) ||
  after.plans ||
  after.bindings ||
  after.taskTabs ||
  after.settlementNotices ||
  after.unresolvedOutbox ||
  after.unresolvedBridgeOperations ||
  after.activeBridgeTasks
)
  throw Error('FORMAL_WORKSPACE_CHANGED');
const smoke = await Promise.all(
  ['audit/actor-source-smoke.json', 'audit/actor-packaged-smoke.json'].map(load),
);
if (
  smoke.some(
    (row) =>
      !row.ok ||
      row.workspaceDatabaseVersion !== 5 ||
      !row.closePersisted ||
      row.htmlFacts.nodeExposed ||
      row.htmlFacts.overflow,
  ) ||
  smoke[1].seedSchemaVersion !== 5
)
  throw Error('ACTOR_DESKTOP_SMOKE_FAILED');
const profileId = '2b32bd78-51d0-4576-a12b-252c4d3c2d9b';
const browser = await load('audit/kernel-actor-live-' + profileId + '.json');
if (
  browser.profileId !== profileId ||
  !browser.realBrowser ||
  !browser.passed ||
  browser.facebookOperations ||
  browser.checks.length !== 7 ||
  browser.failures.length ||
  browser.evidence.nativeInputCalls !== 0 ||
  browser.evidence.finalPlanState !== 'STOPPED' ||
  !browser.evidence.nativeFenceTrace.some((row) => row.event === 'actor-input-fenced') ||
  browser.evidence.nativeFenceTrace.some((row) =>
    /^rpc:send:(Input\.|DOM\.setFileInputFiles)/.test(row.event),
  ) ||
  browser.evidence.deliveredNotice.state !== 'DELIVERED' ||
  browser.evidence.deliveredNotice.resolution.outcome !== 'NOT_APPLIED'
)
  throw Error('ACTOR_REAL_FENCE_NOT_PROVEN');
if (hash(await readFile(browser.evidence.historicalSource)) !== browser.evidence.historicalSha256)
  throw Error('HISTORICAL_DATABASE_CHANGED');
const db = new DatabaseSync(path.join(browser.isolatedDirectory, 'workspace.sqlite'), {
  readOnly: true,
});
try {
  const operation = db
    .prepare('SELECT status,job_id AS jobId,step_id AS stepId FROM task_outbox WHERE id=?')
    .get(browser.evidence.operationId);
  const notice = db
    .prepare(
      'SELECT n.body,d.state FROM task_settlement_notices n JOIN task_settlement_delivery d USING(operation_id) WHERE operation_id=?',
    )
    .get(browser.evidence.operationId);
  if (
    db.prepare('PRAGMA user_version').get()?.user_version !== 5 ||
    operation?.status !== 'FAILED' ||
    notice?.state !== 'DELIVERED' ||
    !sameNotice(SettlementReceipt.parse(JSON.parse(notice.body)), browser.evidence.deliveredNotice)
  )
    throw Error('ACTOR_SETTLEMENT_NOT_PERSISTED');
  const plan = db
    .prepare('SELECT state,control_request_id,control_confirmed FROM task_plans WHERE id=?')
    .get(operation.jobId);
  const step = db.prepare('SELECT progress FROM task_steps WHERE id=?').get(operation.stepId);
  if (
    plan?.state !== 'STOPPED' ||
    plan.control_request_id !== browser.evidence.controlRequestId ||
    plan.control_confirmed !== 1 ||
    !step ||
    JSON.parse(step.progress).likes !== 0 ||
    db.prepare('SELECT count(*) AS count FROM task_account_locks').get()?.count !== 0
  )
    throw Error('ACTOR_CONTROL_OR_BUSINESS_STATE_MISMATCH');
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
    (row) =>
      row.id === profileId &&
      row.online &&
      row.phase === 'PAUSED' &&
      row.extensionVersion === '0.3.3',
  )
)
  throw Error('PRODUCTION_NOT_PAUSED');
const report = {
  recordedAt: new Date().toISOString(),
  stage: '2d-profile-actor-current-session-native-fence',
  productVersion: metadata.version,
  extension: { version: manifest.version, changed: false, refreshRequired: false },
  programChecks: { ...checks, additional: 10, logSha256: hash(log) },
  schema: { product: 5, unchanged: true },
  desktop: smoke.map((row, index) => ({
    target: index ? 'packaged-exe' : 'source',
    ok: row.ok,
    schema: row.workspaceDatabaseVersion,
    seedSchema: row.seedSchemaVersion,
    closePersisted: row.closePersisted,
    isolated: true,
  })),
  executableSha256: hash(await readFile('release/win-unpacked/Browser Workbench.exe')),
  realBrowserChecks: 7,
  realBrowser: {
    profileId,
    browser: browser.browser,
    checks: browser.checks,
    nativeInputCalls: 0,
    injectedRevocation: true,
    isolatedDirectory: browser.isolatedDirectory,
    historicalOperationReconciled: browser.evidence.historicalOperationId,
  },
  production: {
    profiles: after.profiles,
    plans: 0,
    bindings: 0,
    taskTabs: 0,
    settlementNotices: 0,
    dispatchEnabled: tasks.dispatchEnabled,
    workspacePreserved: true,
    actorRegistryEnabled: false,
  },
  facebookOperations: false,
  limits: [
    'Fixture identity is explicit simulation, not FB account recognition',
    'Only user-confirmed Chrome tested this phase; second-profile pending historical ACK remains',
    'Actor gate/guarded port implemented; service registry, actual stop ownership, business-step loop and FB adapters remain pending',
    'Input fence blocks writes but does not itself cancel SDK reads/waits; lifecycle owner must close SDK and confirm actual stop promptly',
    'No unexpected browser/process restart, FB/29-profile/long-run verification',
  ],
};
await writeFile('audit/actor-results.json', JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    productVersion: report.productVersion,
    checks,
    realBrowserChecks: report.realBrowserChecks,
    production: report.production,
    facebookOperations: false,
  }),
);
