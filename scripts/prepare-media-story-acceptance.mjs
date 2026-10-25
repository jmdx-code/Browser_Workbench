import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PublicationAcceptanceScope } from '../dist/src/infrastructure/publication-acceptance-scope.js';

// Preparation only; execution remains in the original task/intent/outbox chain.
const role = process.argv[2];
assert.ok(['image', 'video'].includes(role));
const extraIndex = process.argv.indexOf('--new-authorization');
const additional = extraIndex >= 0;
assert.ok(
  !additional || (extraIndex === 3 && process.argv.length === 5 && role === 'video'),
  'EXACT_ADDITIONAL_VIDEO_AUTHORIZATION_REQUIRED',
);
const authorizationPath = path.resolve(
  additional ? process.argv[extraIndex + 1] : 'audit/new-publication-authorization-20261015.json',
);
const authorization = JSON.parse(await readFile(authorizationPath, 'utf8'));
const sample = authorization.samples.find((row) => row.kind === role + '-story');
assert.equal(sample?.state, 'UNUSED');
assert.equal(sample.audience, 'FRIENDS');
assert.equal(sample.textSource, 'user-message-call_9ec76c2cec734157b380ac2a3ba8c18a');
assert.equal(authorization.maximumNewPublications, additional ? 1 : 3);
if (additional) {
  assert.equal(authorization.approval, '批准新增1条好友视频快拍');
  assert.equal(authorization.samples.length, 1);
  assert.equal(authorization.profileId, '066430e1-92cd-4ee4-8f43-98db3425239d');
  assert.equal(authorization.accountId, '10000000000004');
}
assert.equal(authorization.allowHistoricalReplay, false);
const oldContent = (
  await readFile('audit/story-text-friends-authorization-20261015.txt', 'utf8')
).replace(/\r\n/g, '\n');
const originalText = oldContent.slice(oldContent.indexOf('\n\n') + 2).replace(/\n$/, '');
const text = sample.textAmendment?.text ?? originalText;
if (sample.textAmendment) {
  assert.equal(sample.textAmendment.selection, 'original-first-line');
  assert.equal(sample.textAmendment.additionalPublications, 0);
  assert.equal(text, originalText.split('\n')[0]);
}
assert.ok(text.length > 0);
const manifest = JSON.parse(
  await readFile(
    'audit/story-test-media-ac07d1eb-2eb9-4f53-bbb2-49a8e27ddac2/manifest.json',
    'utf8',
  ),
);
const asset = manifest.assets.find((row) => row.role === role);
assert.ok(asset);
const bytes = await readFile(asset.source);
assert.equal(bytes.length, asset.bytes);
assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.digest);
const origin = 'http://127.0.0.1:18767';
const cookie = (await fetch(origin + '/workbench/')).headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
async function request(route, input) {
  const response = await fetch(origin + '/api/workspace' + route, {
    method: input === undefined ? 'GET' : 'POST',
    headers: {
      cookie,
      'x-workbench-task-contract': '4',
      'x-workbench-workspace-contract': '6',
      ...(input === undefined ? {} : { origin, 'content-type': 'application/json' }),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  assert.ok(response.ok, route + ': ' + JSON.stringify(body));
  return body;
}
const tasks = await request('/tasks');
assert.ok(
  !tasks.plans.some((row) => ['QUEUED', 'RUNNING', 'PAUSING', 'STOPPING'].includes(row.state)),
);
const workspace = await request('');
assert.ok(
  workspace.profiles.some((row) => row.id === authorization.profileId && row.online && row.synced),
);
const note = additional
  ? 'Additional video story authorization ' +
    path.basename(authorizationPath) +
    '; no historical replay.'
  : 'New ' + role + ' story authorization 20261015; no historical replay.';
const existing = workspace.combinations.find((row) => row.saved?.note === note);
let previous;
if (existing) {
  assert.ok(!additional, 'ADDITIONAL_PREPARATION_ALREADY_EXISTS');
  assert.ok(
    sample.textAmendment && process.argv[3] && process.argv[4],
    'MEDIA_STORY_PREPARATION_ALREADY_EXISTS',
  );
  previous = JSON.parse(await readFile(path.join(process.argv[3], 'prepared.json'), 'utf8'));
  assert.equal(previous.scope.version, 6);
  assert.equal(previous.scope.combinationId, existing.id);
  assert.equal(
    previous.scope.resources[0].textSha256,
    createHash('sha256').update(originalText).digest('hex'),
  );
  assert.equal(previous.scope.profileId, authorization.profileId);
  assert.equal(previous.scope.accountId, authorization.accountId);
  const db = new DatabaseSync(
    path.join(process.env.APPDATA, 'Browser Workbench/data/workspace.sqlite'),
    { readOnly: true },
  );
  try {
    const plan = db.prepare('SELECT * FROM task_plans WHERE id=?').get(process.argv[4]);
    assert.equal(plan?.batch_id, previous.scope.id);
    assert.equal(plan.state, 'FAILED');
    const steps = db
      .prepare("SELECT outcome FROM task_steps WHERE job_id=? AND status='FAILED'")
      .all(plan.id);
    assert.equal(steps.length, 1);
    const outcome = JSON.parse(steps[0].outcome);
    assert.equal(outcome.submissionPhase, 'BEFORE_SUBMIT');
    assert.equal(outcome.businessResult, 'NOT_PUBLISHED');
    assert.equal(outcome.currentStop.state, 'stopped');
    assert.equal(outcome.currentStop.requestId, outcome.endingId);
    assert.equal(outcome.currentStop.profileId, authorization.profileId);
    const rows = db.prepare('SELECT state FROM material_reservations WHERE job_id=?').all(plan.id);
    assert.ok(rows.length > 0 && rows.every((row) => row.state === 'NOT_PUBLISHED'));
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM material_post_operations m JOIN task_outbox o ON o.id=m.operation_id JOIN task_plans p ON p.id=o.job_id WHERE p.combination_id=? AND m.purpose='SUBMIT'",
        )
        .get(existing.id).n,
      0,
    );
  } finally {
    db.close();
  }
}
const root = path.resolve('audit/media-story-' + role + '-' + randomUUID());
await mkdir(root);
const saved =
  existing ??
  (await request('/combinations/create', {
    value: {
      name: 'Friends ' + role + ' story acceptance',
      note,
      steps: [
        {
          id: randomUUID(),
          type: 'post',
          destination: 'story',
          audience: 'friends',
          resourceMode: 'table',
          resourceDirectory: '',
          count: 1,
          allowRepeat: false,
          forbidSameAccountRepeat: true,
          archivePublished: false,
        },
      ],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    },
  }));
const rowId = randomUUID();
const table = await request('/resource-tables/save', {
  combinationId: saved.id,
  expectedRevision: previous?.scope.resourceRevision ?? 0,
  rows: [
    {
      id: rowId,
      text,
      background: 'plain',
      purpose: 'story',
      media: [
        { kind: 'local', source: asset.source, name: path.basename(asset.source), mediaType: role },
      ],
    },
  ],
});
const scope = PublicationAcceptanceScope.parse({
  version: 6,
  id: randomUUID(),
  profileId: authorization.profileId,
  accountId: authorization.accountId,
  combinationId: saved.id,
  combinationVersion: saved.version,
  resourceRevision: table.revision,
  audience: 'FRIENDS',
  maximumPublications: 1,
  resources: [
    {
      rowId,
      textSha256: createHash('sha256').update(text).digest('hex'),
      format: role === 'image' ? 'single-image' : 'video',
      media: [asset],
    },
  ],
});
const assignment = {
  requestId: scope.id,
  combinationId: saved.id,
  version: saved.version,
  profileIds: [scope.profileId],
  expectedResourceRevision: table.revision,
};
await writeFile(
  path.join(root, 'prepared.json'),
  JSON.stringify(
    {
      state: 'PREPARED_NOT_STARTED',
      root,
      authorizationPath,
      scope,
      assignment,
      taskAssignments: 0,
      publications: 0,
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
console.log(JSON.stringify({ root, scope, taskAssignments: 0 }));
