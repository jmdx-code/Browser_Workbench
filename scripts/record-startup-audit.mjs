import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { WorkspaceSchema } from '../dist/src/shared/contracts.js';
import { TaskOverview } from '../dist/src/shared/task-contracts.js';
import { SettlementReceipt, sameNotice } from '../dist/src/shared/settlement.js';

const load = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const hash = (input) => createHash('sha256').update(input).digest('hex');
const metadata = await load('package.json'),
  manifest = await load('extension-build/manifest.json');
if (metadata.version !== '0.1.7' || manifest.version !== '0.3.3')
  throw Error('STARTUP_VERSION_MISMATCH');
const log = await readFile('audit/check-startup.log', 'utf8');
const metric = (name) => {
  const match = log.match(new RegExp('(?:#|ℹ)\\s*' + name + '\\s+(\\d+)'));
  if (!match) throw Error('MISSING_CHECK_' + name);
  return Number(match[1]);
};
const checks = { total: metric('tests'), passed: metric('pass'), failed: metric('fail') };
if (checks.total !== 151 || checks.passed !== checks.total || checks.failed)
  throw Error('STARTUP_CHECK_FAILED');
const before = await load('audit/startup-preflight.json'),
  after = await load('audit/startup-postflight.json');
if (
  before.schema.product !== 4 ||
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
  throw Error('LIVE_MIGRATION_OR_PRESERVATION_FAILED');
const smoke = await Promise.all(
  ['audit/startup-source-smoke.json', 'audit/startup-packaged-migration-smoke.json'].map(load),
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
  smoke[1].seedSchemaVersion !== 4
)
  throw Error('STARTUP_DESKTOP_SMOKE_FAILED');
const backupName = (await readdir(after.directory))
  .filter((name) => /^workspace\.sqlite\.before-v5-\d+\.sqlite$/.test(name))
  .sort()
  .at(-1);
if (!backupName) throw Error('MIGRATION_BACKUP_MISSING');
const backup = new DatabaseSync(path.join(after.directory, backupName), { readOnly: true });
try {
  if (backup.prepare('PRAGMA user_version').get()?.user_version !== 4)
    throw Error('BACKUP_VERSION_MISMATCH');
  for (const [key, sql] of Object.entries({
    groups: 'SELECT * FROM groups ORDER BY id',
    profileMetadata: 'SELECT * FROM profile_metadata ORDER BY profile_id',
    combinations: 'SELECT * FROM combinations ORDER BY id',
    savedVersions: 'SELECT * FROM combination_versions ORDER BY combination_id,version',
  }))
    if (hash(JSON.stringify(backup.prepare(sql).all())) !== before.preservation[key])
      throw Error('BACKUP_CONTENT_MISMATCH_' + key);
} finally {
  backup.close();
}
const ids = ['2b32bd78-51d0-4576-a12b-252c4d3c2d9b', '066430e1-92cd-4ee4-8f43-98db3425239d'];
const browserReports = await Promise.all(
  ids.map((id) => load('audit/kernel-startup-live-' + id + '.json')),
);
const allowed = new Set([
  'rpc:open',
  'rpc:inventory',
  'rpc:renew',
  'rpc:reconcileOperation',
  'rpc:stop',
]);
for (const [index, row] of browserReports.entries()) {
  if (
    row.profileId !== ids[index] ||
    !row.passed ||
    !row.realBrowser ||
    row.facebookOperations ||
    row.checks.length !== 7 ||
    row.failures.length ||
    row.evidence.nativeInputCalls !== 0 ||
    row.evidence.debuggerAttachCalls !== 0 ||
    row.evidence.pageCreationCalls !== 0 ||
    row.traces.length !== 2 ||
    row.traces.some(
      (trace) =>
        trace.some((event) => !allowed.has(event.event)) ||
        trace.filter((event) => event.event === 'rpc:stop').length !== 1,
    ) ||
    row.evidence.canonicalReadinessBefore.ready ||
    row.evidence.canonicalReadinessAfter.ready ||
    !row.evidence.canonicalReadinessAfter.issues.some(
      (issue) => issue.reason === 'ORPHAN_OPERATION',
    ) ||
    row.evidence.deliveredNotice.state !== 'DELIVERED' ||
    row.evidence.deliveredNotice.attempts !== 2 ||
    !sameNotice(row.evidence.notice, row.evidence.deliveredNotice)
  )
    throw Error('REAL_SUMMARY_CHECK_FAILED');
  const historical = await load('audit/kernel-task-tab-live-' + row.profileId + '.json');
  if (
    hash(await readFile(path.join(historical.isolatedDirectory, 'workspace.sqlite'))) !==
    row.evidence.sourceDatabaseSha256
  )
    throw Error('HISTORICAL_DATABASE_CHANGED');
  const db = new DatabaseSync(path.join(row.isolatedDirectory, 'workspace.sqlite'), {
    readOnly: true,
  });
  try {
    const persisted = db
      .prepare(
        'SELECT n.body,d.state,d.attempts FROM task_settlement_notices n JOIN task_settlement_delivery d USING(operation_id) WHERE operation_id=?',
      )
      .get(row.evidence.operationId);
    if (
      db.prepare('PRAGMA user_version').get()?.user_version !== 5 ||
      persisted?.state !== 'DELIVERED' ||
      persisted.attempts !== 2 ||
      !sameNotice(SettlementReceipt.parse(JSON.parse(persisted.body)), row.evidence.notice)
    )
      throw Error('NOTICE_RETRY_NOT_PERSISTED');
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
  stage: '2c-durable-settlement-and-summary-assessment',
  productVersion: metadata.version,
  extension: { version: manifest.version, changed: false, refreshRequired: false },
  programChecks: { ...checks, additional: 17, logSha256: hash(log) },
  desktop: smoke.map((row, index) => ({
    target: index ? 'packaged-exe' : 'source',
    ok: row.ok,
    schema: row.workspaceDatabaseVersion,
    seedSchema: row.seedSchemaVersion,
    closePersisted: row.closePersisted,
    isolated: true,
  })),
  executableSha256: hash(await readFile('release/win-unpacked/Browser Workbench.exe')),
  migration: { from: 4, to: 5, backupName, backupContentVerified: true, workspacePreserved: true },
  production: {
    profiles: after.profiles,
    plans: after.plans,
    bindings: after.bindings,
    taskTabs: after.taskTabs,
    settlementNotices: after.settlementNotices,
    dispatchEnabled: tasks.dispatchEnabled,
    formalProfilesPaused: true,
    lifecycleGateIntegrated: false,
  },
  realBrowserChecks: 14,
  browserReports: browserReports.map((row) => ({
    profileId: row.profileId,
    passed: row.passed,
    checks: row.checks,
    operationId: row.evidence.operationId,
    isolatedDirectory: row.isolatedDirectory,
    readinessAfter: row.evidence.canonicalReadinessAfter,
    nativeInputCalls: 0,
    debuggerAttachCalls: 0,
    pageCreationCalls: 0,
  })),
  facebookOperations: false,
  limits: [
    'Injected software receipt loss after actual remote commit; not network loss or unexpected process/browser crash',
    'Readiness assessment is pure and summary adapter is diagnostic; production actor current-lease input gate remains pending',
    'Historical orphan ACK retained and blocks readiness; no import into formal plans or deletion to bypass it',
    'FB identity/semantics/material transactions, 29-profile/long-run capacity and complete delivery remain pending',
    'Second browser vendor unconfirmed',
  ],
};
await writeFile('audit/startup-results.json', JSON.stringify(report, null, 2) + '\n');
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
