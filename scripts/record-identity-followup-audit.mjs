import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const load = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const metadata = await load('package.json'),
  manifest = await load('extension-build/manifest.json');
if (metadata.version !== '0.1.13' || manifest.version !== '0.3.5')
  throw Error('FOLLOWUP_VERSION_MISMATCH');
const log = await readFile('audit/check-identity-followup-final.log', 'utf8');
const metric = (key) =>
  Number(log.match(new RegExp('(?:#|ℹ)\\s*' + key + '\\s+(\\d+)'))?.[1] ?? -1);
const checks = { total: metric('tests'), passed: metric('pass'), failed: metric('fail') };
if (checks.total !== 246 || checks.passed !== checks.total || checks.failed)
  throw Error('FOLLOWUP_CHECK_FAILED');
const before = await load('audit/identity-followup-preflight.json'),
  after = await load('audit/identity-followup-postflight.json');
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
  throw Error('FOLLOWUP_FORMAL_STATE_CHANGED');
const smokes = await Promise.all(
  ['audit/identity-followup-source-smoke.json', 'audit/identity-followup-packaged-smoke.json'].map(
    load,
  ),
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
  throw Error('FOLLOWUP_SMOKE_FAILED');
const real = await load('audit/facebook-identity-followup-live.json');
const sameProof = (a, b) =>
  ['ownershipId', 'profileId', 'browserSessionEpoch', 'tabId', 'targetId'].every(
    (key) => a?.[key] === b?.[key],
  );
if (
  real.state !== 'COMPLETED' ||
  real.extensionVersion !== '0.3.4' ||
  real.businessInputEnabled ||
  real.productionIdentityReady ||
  real.released.length !== 1 ||
  real.observation.identityReady ||
  real.observation.account.id !== null
)
  throw Error('FOLLOWUP_REAL_BOUNDARY_FAILED');
for (const item of real.released) {
  const source = real.inventory.tabs.find((row) => row.ownershipId === item.proof.ownershipId);
  if (
    source?.state !== 'READY' ||
    item.closed.state !== 'CLOSED' ||
    !sameProof(source.proof, item.proof) ||
    !sameProof(item.closed.proof, item.proof) ||
    item.stop.state !== 'stopped' ||
    !item.stop.requestId ||
    item.trace.filter((row) => row.event === 'rpc:adopt').length !== 1 ||
    item.trace.filter((row) => row.event === 'rpc:remove').length !== 1 ||
    item.trace.some((row) => /^rpc:send:(Input\.|DOM\.setFileInputFiles)/.test(row.event))
  )
    throw Error('FOLLOWUP_RELEASE_PROOF_FAILED');
}
for (const item of [real.home, real.self]) {
  if (
    !item.closed ||
    item.closedRecord.state !== 'CLOSED' ||
    !sameProof(item.proof, item.closedRecord.proof) ||
    item.stop.state !== 'stopped' ||
    item.inputRPCs !== 0 ||
    item.trace.filter((row) => row.event === 'rpc:remove').length !== 1 ||
    item.trace.filter((row) => row.event === 'rpc:stop').length !== 1 ||
    item.page.ready !== 'complete'
  )
    throw Error('FOLLOWUP_INSPECTION_PROOF_FAILED');
}
const historical = [
  'audit/facebook-identity-read-live.json',
  'audit/facebook-identity-read-v2-live.json',
];
const historicalHashes = Object.fromEntries(
  await Promise.all(
    historical.map(async (file) => [
      file,
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    ]),
  ),
);
await writeFile(
  'audit/identity-followup-results.json',
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      softwareVersion: metadata.version,
      candidateExtensionVersion: manifest.version,
      realTestExtensionVersion: real.extensionVersion,
      checks,
      sourceAndPackagedSmoke: true,
      schema: after.schema,
      formalStatePreserved: true,
      knownProfiles: after.profiles,
      realRead: {
        milliseconds: Date.parse(real.finishedAt) - Date.parse(real.startedAt),
        ownedUnassociatedTabReleased: real.released.map((item) => ({
          proof: item.proof,
          closed: item.closed,
          stop: item.stop,
        })),
        homeClosed: real.home.closedRecord,
        selfClosed: real.self.closedRecord,
        inputRPCs: 0,
        svgImageElementObserved: real.observation.avatarNodes.some((node) => node.tag === 'image'),
        actingIdentityReady: false,
      },
      historicalHashes,
      candidateOnly: {
        svgXlinkProjection: 'PROGRAM_CHECKED_REQUIRES_REFRESH_AND_REAL_READ',
        nativeReadonlyCloseFence: 'PROGRAM_CHECKED_REQUIRES_REFRESH',
        expandedHeadingSelector: 'PROGRAM_CHECKED_REQUIRES_REAL_READ',
      },
      productionDispatchEnabled: false,
      facebookBusinessCompleted: false,
      pending: [
        'Refresh confirmed Chrome bridge to 0.3.5 once; no new permissions',
        'Read SVG address and profile headings with negotiated v2; independently prove acting identity',
        'Production actor/session/tab/control API and real browse/like adapters',
        'Four-format materials/publish/archive and full acceptance',
      ],
    },
    null,
    2,
  ) + '\n',
);
console.log(
  'Followup evidence recorded; candidate 0.3.5 remains distinct from the real 0.3.4 test.',
);
