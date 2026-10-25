import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { PublicationAcceptanceScope } from '../dist/src/infrastructure/publication-acceptance-scope.js';

// Preparation only: never assigns a task, loads a grant, or publishes.
const authorizationPath = process.argv[2];
assert.ok(authorizationPath, 'EXPLICIT_AUTHORIZATION_FILE_REQUIRED');
const authorization = (await readFile(authorizationPath, 'utf8')).replace(/\r\n/g, '\n');
const profileId = '066430e1-92cd-4ee4-8f43-98db3425239d';
assert.ok(authorization.startsWith('Profile: c2'));
assert.ok(authorization.includes(profileId));
assert.ok(
  authorization.includes('Destination: one text story\nAudience: Friends\nMedia uploads: none\n'),
);
const separator = authorization.indexOf('\n\n');
assert.ok(separator > 0);
const text = authorization.slice(separator + 2).replace(/\n$/, '');
assert.ok(text.length > 0 && text.length < 10000);
const origin = 'http://127.0.0.1:18767';
const cookie = (await fetch(origin + '/workbench/')).headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
const request = async (route, input) => {
  const response = await fetch(origin + '/api/workspace' + route, {
    method: input === undefined ? 'GET' : 'POST',
    headers: {
      cookie,
      'x-workbench-task-contract': '3',
      'x-workbench-workspace-contract': '5',
      ...(input === undefined ? {} : { origin, 'content-type': 'application/json' }),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  assert.ok(response.ok, route + ': ' + JSON.stringify(body));
  return body;
};
const tasks = await request('/tasks');
assert.ok(
  !tasks.plans.some((plan) => ['QUEUED', 'RUNNING', 'PAUSING', 'STOPPING'].includes(plan.state)),
);
assert.ok(
  !tasks.plans.some((plan) =>
    plan.snapshot.steps.some((step) => step.destination === 'story' && step.audience === 'friends'),
  ),
  'STORY_ATTEMPT_ALREADY_EXISTS_REVIEW_ORIGINAL',
);
const workspace = await request('');
assert.ok(
  !workspace.combinations.some((item) =>
    [item.saved, item.draft].some((value) =>
      value?.steps.some((step) => step.destination === 'story' && step.audience === 'friends'),
    ),
  ),
  'STORY_PREPARATION_ALREADY_EXISTS',
);
assert.ok(
  workspace.profiles.some(
    (profile) => profile.id === profileId && profile.online && profile.synced,
  ),
);
const root = path.resolve('audit/story-friends-' + randomUUID());
await mkdir(root);
const saved = await request('/combinations/create', {
  value: {
    name: 'Friends text story acceptance',
    note: 'One explicitly authorized sample; no replay.',
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
});
const rowId = randomUUID();
const table = await request('/resource-tables/save', {
  combinationId: saved.id,
  expectedRevision: 0,
  rows: [{ id: rowId, text, background: 'plain', purpose: 'story', media: [] }],
});
const scope = PublicationAcceptanceScope.parse({
  version: 4,
  id: randomUUID(),
  profileId,
  accountId: '10000000000004',
  combinationId: saved.id,
  combinationVersion: saved.version,
  resourceRevision: table.revision,
  audience: 'FRIENDS',
  maximumPublications: 1,
  resources: [
    {
      rowId,
      format: 'text',
      textSha256: createHash('sha256').update(text).digest('hex'),
      media: [],
    },
  ],
});
const assignment = {
  requestId: scope.id,
  combinationId: saved.id,
  version: saved.version,
  profileIds: [profileId],
  expectedResourceRevision: table.revision,
};
await writeFile(
  path.join(root, 'prepared.json'),
  JSON.stringify(
    {
      state: 'PREPARED_NOT_STARTED',
      root,
      authorizationPath: path.resolve(authorizationPath),
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
