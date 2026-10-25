import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { WorkspaceSchema } from '../dist/src/shared/contracts.js';
import { TaskOverview } from '../dist/src/shared/task-contracts.js';

const load = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const metadata = await load('package.json'),
  manifest = await load('extension-build/manifest.json');
if (metadata.version !== '0.1.10' || manifest.version !== '0.3.3')
  throw Error('CYCLE_VERSION_MISMATCH');
const log = await readFile('audit/check-cycle.log', 'utf8');
const metric = (name) => {
  const value = log.match(new RegExp('(?:#|ℹ)\\s*' + name + '\\s+(\\d+)'));
  if (!value) throw Error('MISSING_METRIC_' + name);
  return Number(value[1]);
};
const checks = { total: metric('tests'), passed: metric('pass'), failed: metric('fail') };
if (checks.total !== 199 || checks.passed !== checks.total || checks.failed)
  throw Error('PROGRAM_CHECK_FAILED');
const semanticTests = ['tests/browse-policy.test.ts', 'tests/task-step-runner.test.ts'];
const before = await load('audit/cycle-preflight.json'),
  after = await load('audit/cycle-postflight.json');
if (
  before.schema.product !== 6 ||
  after.schema.product !== 7 ||
  after.schema.journal !== 2 ||
  before.profiles !== after.profiles ||
  JSON.stringify(before.preservation) !== JSON.stringify(after.preservation) ||
  after.plans ||
  after.bindings ||
  after.taskTabs ||
  after.settlementNotices ||
  after.controlBindings ||
  after.browseIntents ||
  after.unresolvedOutbox ||
  after.unresolvedBridgeOperations ||
  after.activeBridgeTasks
)
  throw Error('FORMAL_WORKSPACE_CHANGED');
const backupName = (await readdir(after.directory)).find((name) =>
  name.startsWith('workspace.sqlite.before-v7-'),
);
if (!backupName) throw Error('MIGRATION_BACKUP_MISSING');
const backupFile = path.join(after.directory, backupName),
  backup = new DatabaseSync(backupFile, { readOnly: true });
try {
  const digest = (sql) => hash(JSON.stringify(backup.prepare(sql).all()));
  if (
    backup.prepare('PRAGMA user_version').get()?.user_version !== 6 ||
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
  ['audit/cycle-source-migration-smoke.json', 'audit/cycle-packaged-migration-smoke.json'].map(
    load,
  ),
);
if (
  smoke.some(
    (row) =>
      !row.ok ||
      row.workspaceDatabaseVersion !== 7 ||
      row.seedSchemaVersion !== 6 ||
      !row.closePersisted ||
      row.htmlFacts.nodeExposed ||
      row.htmlFacts.overflow,
  )
)
  throw Error('DESKTOP_SMOKE_FAILED');
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
  stage: '2f-browse-step-loop-and-durable-semantic-intents',
  productVersion: metadata.version,
  extension: { version: manifest.version, changed: false, refreshRequired: false },
  programChecks: { ...checks, additional: 23, logSha256: hash(log) },
  semanticSimulation: {
    tests: await Promise.all(
      semanticTests.map(async (file) => ({ file, sha256: hash(await readFile(file)) })),
    ),
    videoDuration:
      '900 one-second virtual observations; 900000ms saved, not 15 minutes of real browser playback',
    combinations:
      'Repeated feed steps, finite and until-stopped rounds; full four-step combination blocked without publishing executor',
    concurrency:
      '29 simulated plans, budget 2; per-profile coalescing and independent progress under blocked peer',
    recovery:
      'ACK requires independent result; notification loss blocks new input; no automatic replay or resume',
    realBrowser: false,
    facebookBusinessEvidence: false,
  },
  migration: {
    from: 6,
    to: 7,
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
  production: {
    profiles: after.profiles,
    plans: after.plans,
    bindings: after.bindings,
    taskTabs: after.taskTabs,
    settlementNotices: after.settlementNotices,
    controlBindings: after.controlBindings,
    browseIntents: after.browseIntents,
    dispatchEnabled: tasks.dispatchEnabled,
    workspacePreserved: true,
    actorRegistryEnabled: false,
    onlineProfiles: workspace.profiles
      .filter((p) => p.online)
      .map((p) => ({ id: p.id, phase: p.phase, extensionVersion: p.extensionVersion })),
  },
  facebookOperations: false,
  limits: [
    'Application browse runner and cycle host tested with simulated sessions/observations only; no production SDK browse driver or timer connected',
    'Production owner factory, exact native tab source/turnover, API and trusted recovery of unconfirmed stop still pending',
    'Current action primitives do not yet provide complete FB navigation/scroll/file publishing capabilities',
    'No FB identity/avatar, business verification, material transaction, four publishing formats or real 29-profile/long-run acceptance',
    'Page visibility is conservatively sampled; current evidence does not prove continuous foreground viewing or FB view credit',
    'Second historical profile ACK remains blocked pending trusted notification; no historical replay',
  ],
};
await writeFile('audit/cycle-results.json', JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    productVersion: report.productVersion,
    programChecks: checks,
    migration: report.migration,
    realBrowserChecksThisStage: 0,
    dispatchEnabled: report.production.dispatchEnabled,
  }),
);
