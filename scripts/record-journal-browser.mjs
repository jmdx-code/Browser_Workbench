import { readFile, writeFile } from 'node:fs/promises';
const load = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const ids = ['2b32bd78-51d0-4576-a12b-252c4d3c2d9b', '066430e1-92cd-4ee4-8f43-98db3425239d'];
const reports = await Promise.all(
  ids.map((id) => load('audit/kernel-persistence-live-' + id + '.json')),
);
if (
  reports.some(
    (row, index) =>
      !row.passed ||
      row.profileId !== ids[index] ||
      row.extensionVersion !== '0.3.3' ||
      row.checks.length !== 8 ||
      row.failures.length ||
      row.facebookOperations ||
      !row.realBrowser ||
      row.evidence.nativeInputsBeforeWaitingStop !== 0 ||
      row.evidence.isolatedFinalPlanState !== 'PAUSED',
  )
)
  throw Error('REAL_JOURNAL_AUDIT_INCOMPLETE');
const before = await load('audit/journal-postflight.json'),
  after = await load('audit/journal-browser-postflight.json');
if (
  JSON.stringify(before.preservation) !== JSON.stringify(after.preservation) ||
  before.profiles !== after.profiles ||
  after.plans ||
  after.bindings ||
  after.unresolvedOutbox ||
  after.unresolvedBridgeOperations ||
  after.activeBridgeTasks
)
  throw Error('PRODUCTION_WORKSPACE_CHANGED_OR_BUSY');
const landing = await fetch('http://127.0.0.1:18767/');
const cookie = landing.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw Error('ADMIN_SESSION_MISSING');
const workspace = await (
  await fetch('http://127.0.0.1:18767/api/workspace', { headers: { cookie } })
).json();
const online = workspace.profiles.filter((row) => row.online);
if (
  ids.some(
    (id) =>
      !online.some(
        (row) => row.id === id && row.extensionVersion === '0.3.3' && row.phase === 'PAUSED',
      ),
  )
)
  throw Error('REAL_PROFILE_NOT_PAUSED');
const result = {
  recordedAt: new Date().toISOString(),
  stage: '2c-extension-journal-real-browser',
  productVersion: '0.1.5',
  extensionVersion: '0.3.3',
  profiles: reports.map((row) => ({
    profileId: row.profileId,
    checks: row.checks,
    passed: row.passed,
    evidence: row.evidence,
    isolatedDirectory: row.isolatedDirectory,
  })),
  realBrowserChecks: 16,
  production: {
    schema: after.schema,
    workspacePreserved: true,
    profiles: after.profiles,
    plans: after.plans,
    unresolved: after.unresolvedOutbox,
    loadedProfilesPaused: true,
  },
  facebookOperations: false,
  limits: [
    'Short local fixture checks, not FB/29-profile/long-run verification',
    'Second browser vendor unconfirmed',
    'No browser restart/extension reload recovery was performed in this real run; program coverage is separate',
  ],
};
await writeFile('audit/journal-browser-results.json', JSON.stringify(result, null, 2) + '\n');
console.log(
  JSON.stringify({
    passed: true,
    realBrowserChecks: 16,
    productionPreserved: true,
    facebookOperations: false,
  }),
);
