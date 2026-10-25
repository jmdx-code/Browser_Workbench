import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { PublicationAcceptanceScope } from '../dist/src/infrastructure/publication-acceptance-scope.js';

assert.ok(process.argv[2] && process.argv[3], 'ORIGINAL_DIRECTORY_AND_FAILED_PLAN_REQUIRED');
const originalRoot = path.resolve(process.argv[2]),
  failedPlanId = process.argv[3];
const prepared = JSON.parse(await readFile(path.join(originalRoot, 'prepared.json'), 'utf8'));
assert.ok([2, 3, 4, 5, 6, 7].includes(prepared.scope.version));
assert.equal(
  prepared.scope.maximumPublications,
  prepared.scope.version === 7
    ? prepared.scope.resources.length
    : [4, 5, 6].includes(prepared.scope.version)
      ? 1
      : prepared.scope.version === 3
        ? 2
        : 3,
);
const db = new DatabaseSync(
  path.join(process.env.APPDATA, 'Browser Workbench/data/workspace.sqlite'),
  { readOnly: true },
);
let ended;
try {
  const plan = db.prepare('SELECT * FROM task_plans WHERE id=?').get(failedPlanId);
  assert.ok(plan);
  assert.equal(plan.batch_id, prepared.scope.id);
  assert.equal(plan.profile_id, prepared.scope.profileId);
  if (plan.state === 'STOPPED' && plan.account_id === null) {
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM task_outbox WHERE job_id=?').get(failedPlanId).n,
      0,
    );
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM material_reservations WHERE job_id=?').get(failedPlanId)
        .n,
      0,
    );
    const events = db.prepare('SELECT type FROM task_events WHERE job_id=?').all(failedPlanId);
    assert.ok(
      events.every((event) =>
        ['ROUND_CREATED', 'ASSIGNED', 'QUEUED', 'STOPPED'].includes(event.type),
      ),
    );
    ended = {
      failedPlanId,
      neverAdmitted: true,
      submissions: 0,
      originalHistoricalControlConfirmed: Boolean(plan.control_confirmed),
    };
  } else {
    assert.ok(['FAILED', 'STOPPED'].includes(plan.state));
    if (plan.state === 'STOPPED') {
      assert.equal(plan.control_confirmed, 1);
      assert.equal(plan.control_mode, 'stop');
    }
    const failedSteps = db
      .prepare("SELECT outcome FROM task_steps WHERE job_id=? AND status='FAILED'")
      .all(failedPlanId);
    assert.ok(plan.state === 'STOPPED' || failedSteps.length > 0);
    const outcomes = failedSteps.map((step) => JSON.parse(step.outcome));
    for (const outcome of outcomes) {
      assert.equal(outcome.submissionPhase, 'BEFORE_SUBMIT');
      assert.equal(outcome.businessResult, 'NOT_PUBLISHED');
      assert.equal(outcome.currentStop?.state, 'stopped');
      assert.equal(outcome.currentStop.requestId, outcome.endingId);
      assert.equal(outcome.currentStop.profileId, prepared.scope.profileId);
    }
    const outcome = outcomes.at(-1);
    const stop = JSON.parse(plan.ending_stop ?? 'null') ?? outcome?.currentStop;
    assert.equal(stop?.state, 'stopped');
    assert.equal(stop.requestId, plan.ending_id ?? outcome?.endingId);
    assert.equal(stop.profileId, prepared.scope.profileId);
    const purposes = db
      .prepare(
        'SELECT purpose FROM material_post_operations WHERE operation_id IN (SELECT id FROM task_outbox WHERE job_id=?)',
      )
      .all(failedPlanId);
    assert.ok(
      purposes.length > 0 && purposes.every((row) => row.purpose !== 'SUBMIT'),
      'ORIGINAL_SUBMIT_MUST_NOT_REPLAY',
    );
    const materials = db
      .prepare('SELECT state FROM material_reservations WHERE job_id=?')
      .all(failedPlanId);
    assert.ok(materials.length > 0 && materials.every((row) => row.state === 'NOT_PUBLISHED'));
    ended = {
      failedPlanId,
      originalHistoricalControlConfirmed: Boolean(plan.control_confirmed),
      currentStop: stop,
      stoppedStepOutcomes: outcomes,
      contentInputOperations: purposes.filter((row) => row.purpose === 'SET_TEXT').length,
      uploadOperations: purposes.filter((row) => row.purpose === 'UPLOAD_MEDIA').length,
      submissions: 0,
    };
  }
} finally {
  db.close();
}
const origin = 'http://127.0.0.1:18767',
  cookie = (await fetch(origin + '/workbench/')).headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
const response = await fetch(origin + '/api/workspace/profiles/native-review', {
  method: 'POST',
  headers: { cookie, origin, 'content-type': 'application/json' },
  body: JSON.stringify({ profileId: prepared.scope.profileId }),
  signal: AbortSignal.timeout(10000),
});
assert.ok(response.ok);
const native = await response.json();
assert.equal(native.blockingCount, 0);
assert.ok(
  native.activeTabCount === 0 ||
    (native.activeTabCount === 1 &&
      native.tabs?.length === 1 &&
      native.tabs.every((tab) => tab.state === 'READY' && tab.hasProof)),
);
const softwareVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const root = path.resolve('audit/private-publication-' + softwareVersion + '-' + randomUUID());
await mkdir(root);
const scope = PublicationAcceptanceScope.parse({ ...prepared.scope, id: randomUUID() });
const assignment = { ...prepared.assignment, requestId: scope.id };
await writeFile(
  path.join(root, 'prepared.json'),
  JSON.stringify(
    {
      ...prepared,
      root,
      scope,
      assignment,
      previousUnsubmitted: ended,
      state: 'PREPARED_NOT_STARTED',
      originalRoot,
      taskAssignments: 0,
      publications: 0,
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
console.log(JSON.stringify({ root, scope, ended }));
