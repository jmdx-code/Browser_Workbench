import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { WorkspaceSchema } from '../dist/src/shared/contracts.js';
import { TaskOverview } from '../dist/src/shared/task-contracts.js';

const load = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const metadata = await load('package.json');
const manifest = await load('extension-build/manifest.json');
const identity = await load('config/extension-identity.json');
if (
  metadata.version !== '0.1.5' ||
  manifest.version !== '0.3.3' ||
  JSON.stringify(manifest.permissions) !== JSON.stringify(['debugger', 'storage', 'alarms'])
)
  throw Error('JOURNAL_VERSION_OR_PERMISSION_MISMATCH');
const log = await readFile('audit/check-kernel-journal.log', 'utf8');
const metric = (name) => {
  const match = log.match(new RegExp('(?:#|ℹ)\\s*' + name + '\\s+(\\d+)'));
  if (!match) throw Error('MISSING_CHECK_METRIC_' + name);
  return Number(match[1]);
};
const checks = { total: metric('tests'), passed: metric('pass'), failed: metric('fail') };
if (checks.total !== 125 || checks.passed !== checks.total || checks.failed)
  throw Error('JOURNAL_CHECK_FAILED');
const smoke = await Promise.all(
  ['audit/journal-source-smoke.json', 'audit/journal-packaged-smoke.json'].map(load),
);
if (
  smoke.some(
    (row) =>
      !row.ok ||
      row.workspaceDatabaseVersion !== 3 ||
      !row.closePersisted ||
      row.htmlFacts.overflow ||
      row.htmlFacts.nodeExposed,
  ) ||
  smoke[1].seedSchemaVersion !== 3
)
  throw Error('JOURNAL_DESKTOP_SMOKE_FAILED');
const before = await load('audit/journal-preflight.json'),
  after = await load('audit/journal-postflight.json');
if (
  before.schema.product !== 3 ||
  after.schema.product !== 3 ||
  before.schema.journal !== 2 ||
  after.schema.journal !== 2 ||
  before.profiles !== after.profiles ||
  JSON.stringify(before.preservation) !== JSON.stringify(after.preservation) ||
  after.plans ||
  after.bindings ||
  after.unresolvedOutbox ||
  after.unresolvedBridgeOperations ||
  after.activeBridgeTasks
)
  throw Error('JOURNAL_WORKSPACE_CHANGED_OR_BUSY');
const landing = await fetch('http://127.0.0.1:18767/');
const cookie = landing.headers.get('set-cookie')?.split(';')[0];
if (!landing.ok || !cookie) throw Error('ADMIN_SESSION_MISSING');
const get = async (route, schema) => {
  const response = await fetch('http://127.0.0.1:18767' + route, { headers: { cookie } });
  if (!response.ok) throw Error('HTTP_' + response.status);
  return schema.parse(await response.json());
};
const workspace = await get('/api/workspace', WorkspaceSchema),
  tasks = await get('/api/workspace/tasks', TaskOverview);
if (tasks.dispatchEnabled || tasks.plans.length || workspace.profiles.length !== after.profiles)
  throw Error('UNEXPECTED_PRODUCTION_EXECUTION');
const report = {
  recordedAt: new Date().toISOString(),
  stage: '2c-extension-journal-foundation',
  productVersion: metadata.version,
  candidateExtension: {
    version: manifest.version,
    id: identity.extensionId,
    unchangedPermissions: manifest.permissions,
    realValidationPending: true,
  },
  checks: {
    ...checks,
    additional: 18,
    logSha256: createHash('sha256').update(log).digest('hex'),
    scope: 'Isolated journal/native-event/RPC/SQLite tests and existing baselines; not FB tests.',
  },
  desktop: smoke.map((row, index) => ({
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
  workspacePreserved: true,
  liveWorkspace: {
    profiles: workspace.profiles.length,
    online: workspace.profiles.filter((row) => row.online).length,
    extensionVersions: [
      ...new Set(workspace.profiles.filter((row) => row.online).map((row) => row.extensionVersion)),
    ],
    plans: tasks.plans.length,
    dispatchEnabled: tasks.dispatchEnabled,
    unresolvedOutbox: after.unresolvedOutbox,
    bindings: after.bindings,
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
  actualBrowserOperationsThisStage: false,
  memoryHandoff: 'docs/CONTINUITY.md',
  pending: [
    'Refresh two existing profiles to 0.3.3; then inspect real kernel-persistence-live-UUID reports',
    'Software task-tab/plan association and kernel startup summary readiness',
    'Full actor, real FB identity and semantic executors',
    'Durable summary archival/capacity policy before long-run release',
  ],
  sources: [
    'https://developer.chrome.com/docs/extensions/reference/api/storage',
    'https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab',
    'https://developer.chrome.com/docs/extensions/reference/api/debugger#type-TargetInfo',
  ],
};
await writeFile('audit/journal-foundation-results.json', JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    productVersion: metadata.version,
    candidateExtension: manifest.version,
    checks,
    workspacePreserved: true,
    liveWorkspace: report.liveWorkspace,
    realValidationPending: true,
  }),
);
