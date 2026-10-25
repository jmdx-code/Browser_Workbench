import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PublicationAcceptanceScope } from '../dist/src/infrastructure/publication-acceptance-scope.js';

const color = process.argv[2] === 'color';
const remaining = process.argv[2] === 'remaining-two';
assert.ok(
  (remaining && process.argv.length === 5) ||
    (process.argv.length === 3 && ['four-formats', 'color'].includes(process.argv[2])),
);
const authorizationPath = 'audit/ordinary-post-authorization-097-20261015.json';
const authorization = JSON.parse(await readFile(authorizationPath, 'utf8'));
assert.equal(authorization.approval, '批准这5条仅自己测试帖');
assert.equal(authorization.maximumNewPublications, 5);
assert.equal(authorization.allowHistoricalReplay, false);
assert.equal(authorization.audience, 'SELF');
assert.equal(authorization.text, '工作台功能验收 2026-10-15');
const formats = color
  ? ['text']
  : remaining
    ? ['multi-image', 'video']
    : ['text', 'single-image', 'multi-image', 'video'];
let predecessor;
if (remaining) {
  const original = JSON.parse(await readFile(path.join(process.argv[3], 'prepared.json'), 'utf8'));
  assert.equal(original.authorizationPath, authorizationPath);
  assert.equal(original.scope.accountId, authorization.accountId);
  const db = new DatabaseSync(
    path.join(process.env.APPDATA, 'Browser Workbench/data/workspace.sqlite'),
    { readOnly: true },
  );
  try {
    const plan = db.prepare('SELECT * FROM task_plans WHERE id=?').get(process.argv[4]);
    assert.equal(plan.batch_id, original.scope.id);
    assert.equal(plan.profile_id, authorization.profileId);
    assert.equal(plan.account_id, authorization.accountId);
    assert.equal(plan.state, 'FAILED');
    assert.equal(plan.control_confirmed, 1);
    assert.equal(JSON.parse(plan.ending_stop).state, 'stopped');
    const issued = db
      .prepare(
        'SELECT i.body FROM material_post_operations m JOIN task_outbox o ON o.id=m.operation_id JOIN material_post_intents i ON i.attempt_id=m.attempt_id WHERE o.job_id=? AND m.purpose=?',
      )
      .all(plan.id, 'SUBMIT')
      .map((r) => JSON.parse(r.body).snapshot.format);
    assert.deepEqual(issued.toSorted(), ['single-image', 'text']);
    assert.ok(
      db
        .prepare('SELECT state FROM material_reservations WHERE job_id=?')
        .all(plan.id)
        .every((r) => ['PUBLISHED', 'NOT_PUBLISHED'].includes(r.state)),
    );
    predecessor = {
      planId: plan.id,
      submittedFormats: issued,
      newFormats: formats,
      originalSubmissions: 2,
      replayedSubmissions: 0,
    };
  } finally {
    db.close();
  }
}
assert.ok(
  (color
    ? authorization.samples.filter((s) => s.kind === 'native-color-post')
    : authorization.samples.filter((s) => formats.includes(s.kind))
  ).every((s) => s.state === 'UNUSED'),
);
const manifest = JSON.parse(
  await readFile(
    'audit/private-test-media-219445ae-68f5-4e00-9345-7a119eba9dc1/manifest.json',
    'utf8',
  ),
);
for (const file of manifest.assets) {
  const bytes = await readFile(file.source);
  assert.equal(bytes.length, file.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.digest);
}
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
assert.ok(
  !(await request('/tasks')).plans.some((p) =>
    ['QUEUED', 'RUNNING', 'PAUSING', 'STOPPING'].includes(p.state),
  ),
);
const workspace = await request('');
const profile = workspace.profiles.find((p) => p.id === authorization.profileId);
assert.ok(profile?.online && profile.synced);
assert.ok(profile.account.id === null || profile.account.id === authorization.accountId);
const note =
  'New ordinary authorization 097 20261015: ' + process.argv[2] + '; no historical replay.';
assert.ok(
  !workspace.combinations.some((c) => c.saved?.note === note),
  'PREPARATION_ALREADY_EXISTS',
);
const root = path.resolve('audit/ordinary-post-097-' + process.argv[2] + '-' + randomUUID());
await mkdir(root);
const saved = await request('/combinations/create', {
  value: {
    name: color
      ? '仅自己 · 原生彩贴自动结算验收'
      : remaining
        ? '仅自己 · 剩余多图与视频自动结算验收'
        : '仅自己 · 四格式自动结算验收',
    note,
    steps: formats.map(() => ({
      id: randomUUID(),
      type: 'post',
      audience: 'self',
      aiLabel: 'preserve-current',
      resourceMode: 'table',
      resourceDirectory: '',
      count: 1,
      allowRepeat: false,
      forbidSameAccountRepeat: true,
      archivePublished: false,
    })),
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
  },
});
const images = manifest.assets.filter((f) => f.role === 'image');
assert.equal(images.length, 3);
const resources = formats.map((format) => ({
  rowId: randomUUID(),
  format,
  textSha256: createHash('sha256').update(authorization.text).digest('hex'),
  media:
    format === 'text'
      ? []
      : format === 'single-image'
        ? images.slice(0, 1)
        : format === 'multi-image'
          ? images.slice(1)
          : manifest.assets.filter((f) => f.role === 'video'),
}));
const table = await request('/resource-tables/save', {
  combinationId: saved.id,
  expectedRevision: 0,
  rows: resources.map((r) => ({
    id: r.rowId,
    purpose: 'post',
    text: authorization.text,
    background: color ? 'color' : 'plain',
    media: r.media.map((f) => ({
      kind: 'local',
      source: f.source,
      name: path.basename(f.source),
      mediaType: f.role,
    })),
  })),
});
const scope = PublicationAcceptanceScope.parse({
  version: color ? 5 : 7,
  id: randomUUID(),
  profileId: authorization.profileId,
  accountId: authorization.accountId,
  ...(color ? { background: 'color' } : {}),
  combinationId: saved.id,
  combinationVersion: saved.version,
  resourceRevision: table.revision,
  audience: 'SELF',
  maximumPublications: formats.length,
  resources,
});
const prepared = {
  root,
  authorizationPath,
  ...(predecessor ? { predecessor } : {}),
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
  browserRestarts: 0,
};
await writeFile(path.join(root, 'prepared.json'), JSON.stringify(prepared, null, 2), {
  flag: 'wx',
});
console.log(JSON.stringify(prepared));
