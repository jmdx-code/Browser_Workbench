import { readFile, writeFile } from 'node:fs/promises';
const load = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const metadata = await load('package.json'),
  manifest = await load('extension-build/manifest.json');
if (metadata.version !== '0.1.14' || manifest.version !== '0.3.5')
  throw Error('MATERIAL_PREFLIGHT_VERSION_MISMATCH');
const log = await readFile('audit/check-material-preflight-final.log', 'utf8');
const metric = (key) =>
  Number(log.match(new RegExp('(?:#|ℹ)\\s*' + key + '\\s+(\\d+)'))?.[1] ?? -1);
const checks = { total: metric('tests'), passed: metric('pass'), failed: metric('fail') };
if (checks.total !== 261 || checks.passed !== checks.total || checks.failed)
  throw Error('MATERIAL_PREFLIGHT_CHECK_FAILED');
const before = await load('audit/material-preflight-preflight.json'),
  after = await load('audit/material-preflight-postflight.json');
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
  throw Error('MATERIAL_PREFLIGHT_FORMAL_STATE_CHANGED');
const smokes = await Promise.all(
  [
    'audit/material-preflight-source-smoke.json',
    'audit/material-preflight-packaged-smoke.json',
  ].map(load),
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
  throw Error('MATERIAL_PREFLIGHT_SMOKE_FAILED');
const http = await load('audit/material-preflight-http-live.json');
if (
  http.state !== 'COMPLETED' ||
  http.httpStatus !== 200 ||
  !http.generatedFixture ||
  http.userResourceDirectoriesRead ||
  http.nativeBrowserOperations ||
  http.published ||
  http.archived ||
  !http.filesUnchanged ||
  http.report.publishingReady ||
  http.report.packages.length !== 5 ||
  http.report.uniqueContents !== 4 ||
  http.report.issues.length !== 1
)
  throw Error('MATERIAL_PREFLIGHT_HTTP_FAILED');
await writeFile(
  'audit/material-preflight-results.json',
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      softwareVersion: metadata.version,
      candidateExtensionVersion: manifest.version,
      checks,
      schema: after.schema,
      formalStatePreserved: true,
      knownProfiles: after.profiles,
      sourceAndPackagedSmoke: true,
      localHTTP: {
        status: http.httpStatus,
        generatedFixture: true,
        formats: [...new Set(http.report.packages.map((item) => item.format))].sort(),
        packages: http.report.packages.length,
        uniqueContents: http.report.uniqueContents,
        problems: http.report.issues.length,
        excluded: http.report.excluded,
        sourceFilesUnchanged: http.filesUnchanged,
      },
      editorPreflightEntryImplemented: true,
      publishingReady: false,
      persistentIndexAndReservationImplemented: false,
      archivalImplemented: false,
      facebookBusinessCompleted: false,
      productionDispatchEnabled: false,
      pending: [
        'Append material index/reservation/publish-intent/archive-ledger migration; do not modify applied 1..7',
        'Original single Chrome 0.3.5 refresh remains pending; do not notify again while unchanged',
        'Current acting identity, production actor/tab/API, real browse/like/publish and full acceptance',
      ],
    },
    null,
    2,
  ) + '\n',
);
console.log(
  'Material preflight evidence recorded; no publishing/reservation/archive completion claimed.',
);
