import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { WorkspaceSchema } from '../dist/src/shared/contracts.js';
import { TaskOverview } from '../dist/src/shared/task-contracts.js';

const load = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const metadata = await load('package.json');
const manifest = await load('extension-build/manifest.json');
if (metadata.version !== '0.1.4' || manifest.version !== '0.3.2')
  throw Error('EXECUTION_VERSION_MISMATCH');
const log = await readFile('audit/check-execution.log', 'utf8');
const metric = (name) => {
  const match = log.match(new RegExp('(?:#|ℹ)\\s*' + name + '\\s+(\\d+)'));
  if (!match) throw Error('MISSING_CHECK_METRIC_' + name);
  return Number(match[1]);
};
const tests = { total: metric('tests'), passed: metric('pass'), failed: metric('fail') };
if (tests.total !== 107 || tests.passed !== tests.total || tests.failed)
  throw Error('PROGRAM_CHECK_FAILED');
const before = await load('audit/execution-preflight.json');
const after = await load('audit/execution-postflight.json');
if (
  before.schema.product !== 2 ||
  after.schema.product !== 3 ||
  before.schema.journal !== 2 ||
  after.schema.journal !== 2 ||
  before.profiles !== after.profiles ||
  JSON.stringify(before.preservation) !== JSON.stringify(after.preservation) ||
  after.plans ||
  after.unresolvedOutbox ||
  after.bindings ||
  after.unresolvedBridgeOperations ||
  after.activeBridgeTasks
)
  throw Error('LIVE_MIGRATION_OR_PRESERVATION_FAILED');
const source = await load('audit/execution-source-smoke.json');
const packaged = await load('audit/execution-packaged-migration-smoke.json');
if (
  [source, packaged].some(
    (row) =>
      !row.ok ||
      row.workspaceDatabaseVersion !== 3 ||
      !row.closePersisted ||
      row.htmlFacts.nodeExposed ||
      row.htmlFacts.overflow,
  ) ||
  packaged.seedSchemaVersion !== 2
)
  throw Error('DESKTOP_SMOKE_FAILED');
const backups = (await readdir(after.directory))
  .filter((name) => /^workspace\.sqlite\.before-v3-\d+\.sqlite$/.test(name))
  .sort();
const backupName = backups.at(-1);
if (!backupName) throw Error('MIGRATION_BACKUP_MISSING');
const backup = new DatabaseSync(path.join(after.directory, backupName), { readOnly: true });
let backupSchema;
try {
  backupSchema = backup.prepare('PRAGMA user_version').get().user_version;
  const digest = (sql) =>
    createHash('sha256')
      .update(JSON.stringify(backup.prepare(sql).all()))
      .digest('hex');
  if (
    backupSchema !== 2 ||
    digest('SELECT * FROM groups ORDER BY id') !== before.preservation.groups ||
    digest('SELECT * FROM profile_metadata ORDER BY profile_id') !==
      before.preservation.profileMetadata ||
    digest('SELECT * FROM combinations ORDER BY id') !== before.preservation.combinations ||
    digest('SELECT * FROM combination_versions ORDER BY combination_id,version') !==
      before.preservation.savedVersions
  )
    throw Error('MIGRATION_BACKUP_CONTENT_MISMATCH');
} finally {
  backup.close();
}
const landing = await fetch('http://127.0.0.1:18767/');
const cookie = landing.headers.get('set-cookie')?.split(';')[0];
if (!landing.ok || !cookie) throw Error('ADMIN_SESSION_MISSING');
const get = async (route, schema) => {
  const response = await fetch('http://127.0.0.1:18767' + route, { headers: { cookie } });
  if (!response.ok) throw Error('HTTP_' + response.status);
  return schema.parse(await response.json());
};
const workspace = await get('/api/workspace', WorkspaceSchema);
const tasks = await get('/api/workspace/tasks', TaskOverview);
if (tasks.dispatchEnabled || tasks.plans.length || workspace.profiles.length !== after.profiles)
  throw Error('UNEXPECTED_PRODUCT_EXECUTION');
const report = {
  recordedAt: new Date().toISOString(),
  stage: '2c-software-dispatch-binding',
  productVersion: metadata.version,
  extension: { version: manifest.version, changed: false, refreshRequired: false },
  programChecks: {
    ...tests,
    additional: 8,
    scope:
      'Isolated SQLite and simulated execution ports; original bridge and SDK protections retained.',
    logSha256: createHash('sha256').update(log).digest('hex'),
  },
  desktop: [source, packaged].map((row, index) => ({
    target: index ? 'packaged-exe' : 'source',
    ok: row.ok,
    schema: row.workspaceDatabaseVersion,
    seedSchema: row.seedSchemaVersion,
    closePersisted: row.closePersisted,
    electron: row.runtime.electron,
    node: row.runtime.node,
    sqlite: row.runtime.sqlite,
    isolated: true,
  })),
  executableSha256: createHash('sha256')
    .update(await readFile('release/win-unpacked/Browser Workbench.exe'))
    .digest('hex'),
  migration: {
    from: before.schema.product,
    to: after.schema.product,
    journal: after.schema.journal,
    backupName,
    backupSchema,
    preservationVerified: true,
  },
  liveWorkspace: {
    profiles: workspace.profiles.length,
    online: workspace.profiles.filter((row) => row.online).length,
    phases: workspace.profiles.reduce((counts, row) => {
      counts[row.phase] = (counts[row.phase] ?? 0) + 1;
      return counts;
    }, {}),
    plans: tasks.plans.length,
    dispatchEnabled: tasks.dispatchEnabled,
    bindings: after.bindings,
    unresolvedOutbox: after.unresolvedOutbox,
    groups: workspace.groups.map((group) => ({
      name: group.name,
      members: workspace.profiles.filter((profile) => profile.groupId === group.id).length,
    })),
    combinations: workspace.combinations.map((row) => ({
      name: row.saved?.name,
      version: row.version,
      steps: row.saved?.steps.length,
    })),
  },
  businessReady: false,
  realBrowserOperationsThisStage: false,
  pending: [
    'SDK business execution port',
    'extension durable operation summary',
    'task-tab persistent ownership',
    'matched business stop receipt',
    'FB identity and outcome verification',
    'full video/feed/post executors and materials',
  ],
  preservedFailureEvidence: [
    'audit/check-execution-initial-ordering-failure.log',
    'audit/execution-packaged-previous-build-failure.json',
  ],
};
await writeFile('audit/execution-results.json', JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    productVersion: report.productVersion,
    tests: report.programChecks.total,
    migration: report.migration,
    liveWorkspace: report.liveWorkspace,
  }),
);
