import { readFile, writeFile } from 'node:fs/promises';
const load = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const metadata = await load('package.json'),
  manifest = await load('extension-build/manifest.json');
if (metadata.version !== '0.1.12' || manifest.version !== '0.3.4')
  throw Error('IDENTITY_READ_VERSION_MISMATCH');
const log = await readFile('audit/check-identity-read-final.log', 'utf8');
const metric = (name) => {
  const value = log.match(new RegExp('(?:#|ℹ)\\s*' + name + '\\s+(\\d+)'));
  if (!value) throw Error('IDENTITY_READ_METRIC_MISSING_' + name);
  return Number(value[1]);
};
const checks = { total: metric('tests'), passed: metric('pass'), failed: metric('fail') };
if (checks.total !== 230 || checks.passed !== checks.total || checks.failed)
  throw Error('IDENTITY_READ_CHECK_FAILED');
const before = await load('audit/identity-read-preflight.json'),
  after = await load('audit/identity-read-postflight.json');
const empty = [
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
  after.schema.product !== 7 ||
  after.schema.journal !== 2 ||
  before.profiles !== after.profiles ||
  JSON.stringify(before.preservation) !== JSON.stringify(after.preservation) ||
  empty.some((key) => before[key] || after[key])
)
  throw Error('IDENTITY_READ_FORMAL_STATE_CHANGED');
const smokes = await Promise.all(
  ['audit/identity-read-source-smoke.json', 'audit/identity-read-packaged-smoke.json'].map(load),
);
if (
  smokes.some(
    (row) =>
      !row.ok ||
      row.workspaceDatabaseVersion !== 7 ||
      row.seedSchemaVersion !== 7 ||
      !row.closePersisted ||
      row.htmlFacts.nodeExposed ||
      row.htmlFacts.overflow ||
      row.workspace.support.comboExecution ||
      row.workspace.support.accountIdentity,
  )
)
  throw Error('IDENTITY_READ_SMOKE_FAILED');
const real = await load('audit/facebook-identity-read-v2-live.json');
if (
  real.state !== 'READ_COMPLETED' ||
  !real.realPageRead ||
  real.businessInputEnabled ||
  real.productionIdentityReady ||
  real.evidence.page.url !== 'https://www.facebook.com/' ||
  real.evidence.closed !== true ||
  real.evidence.stop.state !== 'stopped' ||
  real.evidence.inputRPCs !== 0 ||
  real.analysis.account.state !== 'unknown' ||
  real.analysis.account.id !== null ||
  real.evidence.proof.profileId !== real.profileId ||
  real.evidence.trace.filter((row) => row.event === 'rpc:remove').length !== 1 ||
  real.evidence.trace.filter((row) => row.event === 'rpc:stop').length !== 1
)
  throw Error('IDENTITY_READ_REAL_BOUNDARY_FAILED');
const first = await load('audit/facebook-identity-read-live.json');
if (first.state !== 'FAILED' || first.error !== 'KERNEL_SCOPE_CHANGED')
  throw Error('IDENTITY_READ_FIRST_FAILURE_MISSING');
await writeFile(
  'audit/identity-read-results.json',
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      softwareVersion: metadata.version,
      extensionVersion: manifest.version,
      checks,
      sourceAndPackagedSmoke: true,
      schema: after.schema,
      formalStatePreserved: true,
      realRead: {
        profileId: real.profileId,
        milliseconds: Date.parse(real.finishedAt) - Date.parse(real.startedAt),
        document: real.evidence.page.ready,
        visibility: real.evidence.page.visibility,
        proof: real.evidence.proof,
        inputRPCs: real.evidence.inputRPCs,
        ownInspectionTabClosed: real.evidence.closed,
        actualStop: real.evidence.stop,
      },
      accountIdentityReady: false,
      productionDispatchEnabled: false,
      facebookBusinessCompleted: false,
      historicalFailurePreserved: 'facebook-identity-read-live.json',
      pending: [
        'Prove current acting Facebook identity and avatar',
        'Reconcile the initial failed inspection tab using authenticated inventory and exact proof',
        'Production session/tab turnover and control API',
        'Real browse/video/like adapters',
        'Four-format material transaction/publishing/archive',
        '29-profile resources and long-run delivery',
      ],
    },
    null,
    2,
  ),
);
console.log('Identity read evidence recorded; acting identity and production remain unavailable.');
