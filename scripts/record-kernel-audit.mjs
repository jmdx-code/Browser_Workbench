import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { WorkspaceSchema } from '../dist/src/shared/contracts.js';
import { TaskOverview } from '../dist/src/shared/task-contracts.js';

const load = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const metadata = await load('package.json');
const lock = await load('package-lock.json');
const manifest = await load('extension-build/manifest.json');
const identity = await load('config/extension-identity.json');
if (
  metadata.version !== '0.1.3' ||
  manifest.version !== '0.3.2' ||
  lock.packages['node_modules/playwright-core'].version !== '1.64.0'
)
  throw Error('KERNEL_VERSION_MISMATCH');
const log = await readFile('audit/check-kernel-integration.log', 'utf8');
const metric = (name) => {
  const found = log.match(new RegExp('(?:#|ℹ)\\s*' + name + '\\s+(\\d+)'));
  if (!found) throw Error('MISSING_CHECK_METRIC_' + name);
  return Number(found[1]);
};
const tests = { total: metric('tests'), passed: metric('pass'), failed: metric('fail') };
if (!tests.total || tests.total !== tests.passed || tests.failed)
  throw Error('PROGRAM_CHECK_FAILED');
const smoke = await Promise.all(
  ['audit/kernel-source-smoke.json', 'audit/kernel-packaged-smoke.json'].map(load),
);
if (
  smoke.some(
    (row) =>
      !row.ok ||
      row.workspaceDatabaseVersion !== 2 ||
      !row.closePersisted ||
      row.htmlFacts.nodeExposed ||
      row.htmlFacts.overflow,
  )
)
  throw Error('DESKTOP_CHECK_FAILED');
const origin = 'http://127.0.0.1:18767';
const landing = await fetch(origin);
if (!landing.ok) throw Error('LANDING_HTTP_' + landing.status);
const cookie = landing.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw Error('ADMIN_COOKIE_MISSING');
const get = async (route, schema) => {
  const response = await fetch(origin + route, { headers: { cookie } });
  if (!response.ok) throw Error('HTTP_' + response.status);
  return schema.parse(await response.json());
};
const workspace = await get('/api/workspace', WorkspaceSchema);
const tasks = await get('/api/workspace/tasks', TaskOverview);
if (tasks.dispatchEnabled || tasks.plans.length) throw Error('UNEXPECTED_PRODUCT_EXECUTION');
const files = (await readdir('audit')).filter((name) =>
  /^kernel-live-[a-f0-9-]+\.json$/.test(name),
);
const live = await Promise.all(files.map((name) => load('audit/' + name)));
const currentLive = live.filter((row) => row.extensionVersion === manifest.version && row.passed);
const parallelPair = currentLive.slice(0, 2);
const overlapMs =
  parallelPair.length === 2 &&
  parallelPair.every(
    (row) =>
      row.parallelReady &&
      row.timeline?.interactionStartedAt > 0 &&
      row.timeline?.interactionEndedAt > row.timeline.interactionStartedAt,
  )
    ? Math.max(
        0,
        Math.min(...parallelPair.map((row) => row.timeline.interactionEndedAt)) -
          Math.max(...parallelPair.map((row) => row.timeline.interactionStartedAt)),
      )
    : 0;
const disconnected =
  currentLive.length === 2 &&
  currentLive.every((row) =>
    row.controlEvidence?.some(
      (event) =>
        event.kind === 'real-main-transport-disconnect' &&
        event.beforeInputs === 0 &&
        event.afterInputs === 0 &&
        event.waitingRejected &&
        event.epochChanged &&
        event.reconnectPaused,
    ),
  );
const dependencyAudit = await load('audit/dependencies-kernel.json');
const report = {
  recordedAt: new Date().toISOString(),
  stage: 'kernel-integration-2b-foundation',
  productVersion: metadata.version,
  extension: {
    version: manifest.version,
    id: identity.extensionId,
    capability: 'fixture-kernel-v1',
    unchangedPermissions: manifest.permissions,
  },
  sdk: {
    package: 'playwright-core',
    version: '1.64.0',
    publicEntry: 'chromium.connectOverCDP',
    privateSdkImports: false,
    patchedSdk: false,
    browserDownloadedBySdk: false,
  },
  programChecks: {
    ...tests,
    checkLogSha256: createHash('sha256').update(log).digest('hex'),
    scope:
      '78 baseline + integration semantic checks; SDK tests use simulated Chrome transport, not real Chrome.',
  },
  dependencyVulnerabilities: dependencyAudit.metadata.vulnerabilities,
  preflight: await load('audit/kernel-preflight.json'),
  desktop: smoke.map((row, index) => ({
    target: index ? 'packaged-exe' : 'source',
    ok: row.ok,
    electron: row.runtime.electron,
    node: row.runtime.node,
    sqlite: row.runtime.sqlite,
    schema: row.workspaceDatabaseVersion,
    closePersisted: row.closePersisted,
    isolated: true,
  })),
  packagedExecutableSha256: createHash('sha256')
    .update(await readFile('release/win-unpacked/Browser Workbench.exe'))
    .digest('hex'),
  liveWorkspace: {
    profiles: workspace.profiles.length,
    online: workspace.profiles.filter((row) => row.online).length,
    phases: workspace.profiles.reduce((counts, row) => {
      counts[row.phase] = (counts[row.phase] ?? 0) + 1;
      return counts;
    }, {}),
    groups: workspace.groups.map((group) => ({
      name: group.name,
      members: workspace.profiles.filter((row) => row.groupId === group.id).length,
    })),
    combinations: workspace.combinations.map((row) => ({
      name: row.saved?.name,
      version: row.version,
      steps: row.saved?.steps.length,
    })),
    dispatchEnabled: tasks.dispatchEnabled,
    plans: tasks.plans.length,
  },
  realFixtureReports: live.map((row) => ({
    profileId: row.profileId,
    recordedAt: row.recordedAt,
    extensionVersion: row.extensionVersion,
    passed: row.passed,
    stopped: row.stopped,
    checks: row.checks,
    failures: row.failures,
    majorNegativeEffects: row.majorNegativeEffects,
    parallelReady: row.parallelReady,
    timeline: row.timeline,
    controlEvidence: row.controlEvidence,
  })),
  concurrentFixtureEvidence: {
    profileIds: parallelPair.map((row) => row.profileId),
    overlapMs,
    scope:
      'Two real profile transports on local fixtures. Not 29-profile load testing or Facebook business concurrency.',
  },
  limitations: {
    realKernelBrowserTestPending: !live.some(
      (row) => row.extensionVersion === manifest.version && row.passed,
    ),
    realConcurrentIsolationVerified: overlapMs > 0,
    realDisconnectReconciliationVerified: disconnected,
    stoppedReceiptOnDisconnectedSocket: false,
    facebookIdentityImplemented: false,
    outerBusinessOperationBindingImplemented: false,
    facebookActionsThisStage: 0,
    fullInstallerVerified: false,
    detectionRankingProven: false,
  },
};
await writeFile('audit/kernel-results.json', JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    tests,
    profiles: report.liveWorkspace.profiles,
    online: report.liveWorkspace.online,
    onlineProfiles: workspace.profiles
      .filter((row) => row.online)
      .map((row) => ({
        id: row.id,
        extensionVersion: row.extensionVersion,
        phase: row.phase,
        capabilities: row.capabilities,
      })),
    realFixtureReports: report.realFixtureReports,
    productionDispatchEnabled: tasks.dispatchEnabled,
  }),
);
