import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PublicationAcceptanceScope } from '../dist/src/infrastructure/publication-acceptance-scope.js';

// Preparation only. Original task assignment/outbox still own all execution.
const authorizationPath = path.resolve('audit/new-publication-authorization-20261015.json');
const authorization = JSON.parse(await readFile(authorizationPath, 'utf8'));
const sample = authorization.samples.find((row) => row.kind === 'native-color-post');
assert.equal(sample?.state, 'UNUSED');
assert.equal(sample.audience, 'SELF');
assert.equal(authorization.maximumNewPublications, 3);
assert.equal(authorization.allowHistoricalReplay, false);
const original = JSON.parse(
  await readFile('audit/post-only-me-authorized-content-20261013.json', 'utf8'),
);
const amendment = sample.textAmendment;
const text = amendment ? amendment.text : original.text;
if (amendment) {
  assert.equal(amendment.selection, 'original-first-line');
  assert.equal(amendment.additionalPublications, 0);
  assert.equal(text, original.text.split('\n')[0]);
}
assert.ok(typeof text === 'string' && text.length > 0);
assert.equal(original.profileId, authorization.profileId);
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
const existing = workspace.combinations.find(
  (row) => row.saved?.note === 'New color authorization 20261015; no historical replay.',
);
let previous;
if (existing) {
  assert.ok(amendment && process.argv[2] && process.argv[3], 'COLOR_PREPARATION_ALREADY_EXISTS');
  previous = JSON.parse(await readFile(path.join(process.argv[2], 'prepared.json'), 'utf8'));
  assert.equal(previous.scope.combinationId, existing.id);
  assert.equal(previous.scope.profileId, authorization.profileId);
  assert.equal(previous.scope.accountId, authorization.accountId);
  assert.equal(
    previous.scope.resources[0].textSha256,
    createHash('sha256').update(original.text).digest('hex'),
  );
  const db = new DatabaseSync(
    path.join(process.env.APPDATA, 'Browser Workbench/data/workspace.sqlite'),
    { readOnly: true },
  );
  try {
    const plan = db.prepare('SELECT * FROM task_plans WHERE id=?').get(process.argv[3]);
    assert.equal(plan?.batch_id, previous.scope.id);
    assert.equal(plan.state, 'FAILED');
    assert.equal(plan.control_confirmed, 1);
    const stop = JSON.parse(plan.ending_stop);
    assert.equal(stop.state, 'stopped');
    assert.equal(stop.requestId, plan.ending_id);
    assert.equal(stop.profileId, authorization.profileId);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM material_post_operations m JOIN task_outbox o ON o.id=m.operation_id WHERE o.job_id=? AND m.purpose='SUBMIT'",
        )
        .get(plan.id).n,
      0,
    );
    const reservations = db
      .prepare('SELECT state FROM material_reservations WHERE job_id=?')
      .all(plan.id);
    assert.ok(
      reservations.length > 0 && reservations.every((row) => row.state === 'NOT_PUBLISHED'),
    );
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
const root = path.resolve('audit/color-post-' + randomUUID());
await mkdir(root);
const saved =
  existing ??
  (await request('/combinations/create', {
    value: {
      name: '仅自己 · 原生彩贴验收',
      note: 'New color authorization 20261015; no historical replay.',
      steps: [
        {
          id: randomUUID(),
          type: 'post',
          audience: 'self',
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
  rows: [{ id: rowId, text, background: 'color', purpose: 'post', media: [] }],
});
const scope = PublicationAcceptanceScope.parse({
  version: 5,
  id: randomUUID(),
  profileId: authorization.profileId,
  accountId: authorization.accountId,
  combinationId: saved.id,
  combinationVersion: saved.version,
  resourceRevision: table.revision,
  audience: 'SELF',
  background: 'color',
  maximumPublications: 1,
  resources: [
    {
      rowId,
      textSha256: createHash('sha256').update(text).digest('hex'),
      format: 'text',
      media: [],
    },
  ],
});
await writeFile(
  path.join(root, 'prepared.json'),
  JSON.stringify(
    {
      state: 'PREPARED_NOT_STARTED',
      root,
      authorizationPath,
      scope,
      assignment: {
        requestId: scope.id,
        combinationId: saved.id,
        version: saved.version,
        profileIds: [scope.profileId],
        expectedResourceRevision: table.revision,
      },
      taskAssignments: 0,
      publications: 0,
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
console.log(JSON.stringify({ root, scope, textLength: text.length, taskAssignments: 0 }));
