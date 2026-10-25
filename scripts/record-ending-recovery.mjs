import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

assert.equal(process.argv.length, 6, 'Use --snapshot audit/directory --report audit/fresh.json');
assert.equal(process.argv[2], '--snapshot');
assert.equal(process.argv[4], '--report');
const snapshotDirectory = path.resolve(process.argv[3]),
  file = path.resolve(process.argv[5]);
for (const target of [snapshotDirectory, file])
  assert.ok(target.startsWith(path.resolve('audit') + path.sep));
const snapshot = JSON.parse(await readFile(path.join(snapshotDirectory, 'snapshot.json'), 'utf8'));
assert.equal(snapshot.kind, 'readonly-interrupted-control-backup');
const db = new DatabaseSync(
  path.join(process.env.APPDATA, 'Browser Workbench/data/workspace.sqlite'),
  { readOnly: true },
);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let report;
try {
  const plan = db
    .prepare(
      'SELECT id,profile_id,state,reason,control_confirmed,ending_id,ending_stop FROM task_plans WHERE id=?',
    )
    .get(snapshot.planId);
  assert.ok(plan?.ending_id);
  assert.equal(plan.state, 'FAILED');
  const currentStop = JSON.parse(plan.ending_stop);
  assert.equal(currentStop.requestId, plan.ending_id);
  assert.equal(currentStop.state, 'stopped');
  const unknown = snapshot.unknown.map((old) => {
    const row = db.prepare('SELECT * FROM task_outbox WHERE id=?').get(old.id);
    return { id: old.id, unchanged: hash(row) === old.digest };
  });
  assert.ok(
    unknown.every((row) => row.unchanged),
    'ORIGINAL_UNKNOWN_CHANGED',
  );
  const origin = 'http://127.0.0.1:18767';
  const landing = await fetch(origin + '/workbench/');
  const cookie = landing.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const natives = [];
  for (const profileId of ['066430e1-92cd-4ee4-8f43-98db3425239d', plan.profile_id]) {
    const response = await fetch(origin + '/api/workspace/profiles/native-review', {
      method: 'POST',
      headers: {
        cookie,
        origin,
        'content-type': 'application/json',
        'x-workbench-task-contract': '2',
        'x-workbench-workspace-contract': '4',
      },
      body: JSON.stringify({ profileId }),
      signal: AbortSignal.timeout(45_000),
    });
    const native = await response.json();
    natives.push({ profileId, httpStatus: response.status, native });
  }
  report = {
    observedAt: new Date().toISOString(),
    snapshotDirectory,
    plan,
    currentStop,
    unknown,
    natives,
    taskAssignments: 0,
    browserRestarts: 0,
    nativeInputs: 0,
    endingPassed: true,
    passed: natives.every(
      ({ httpStatus, native }) =>
        httpStatus === 200 &&
        native.blockingCount === 0 &&
        (native.activeTabCount === 0 ||
          (native.activeTabCount === 1 && native.tabs[0]?.reason === 'WORKSPACE_MAIN_IDLE')),
    ),
  };
  await writeFile(file, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(
    JSON.stringify({
      file,
      originalStopConfirmed: !!plan.control_confirmed,
      unchangedUnknown: unknown.length,
      native: natives.map(({ profileId, native }) => ({
        profileId,
        blocking: native.blockingCount,
        active: native.activeTabCount,
      })),
      passed: report.passed,
    }),
  );
} finally {
  db.close();
}
