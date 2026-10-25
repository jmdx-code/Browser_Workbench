import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const root = path.resolve('audit/publication-upgrade-baseline-' + randomUUID());
await mkdir(root);
const origin = 'http://127.0.0.1:18767';
const landing = await fetch(origin + '/workbench/');
const cookie = landing.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
const request = async (route, input) => {
  const response = await fetch(origin + '/api/workspace' + route, {
    method: input === undefined ? 'GET' : 'POST',
    headers: {
      cookie,
      'x-workbench-task-contract': '2',
      'x-workbench-workspace-contract': '4',
      ...(input === undefined ? {} : { origin, 'content-type': 'application/json' }),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, route + ': HTTP ' + response.status);
  return response.json();
};
const tasks = await request('/tasks');
assert.ok(
  !tasks.plans.some((plan) => ['QUEUED', 'RUNNING', 'PAUSING', 'STOPPING'].includes(plan.state)),
);
const profiles = ['066430e1-92cd-4ee4-8f43-98db3425239d', '9e4d39b2-90b0-4267-aee2-311089b78336'];
const native = [];
for (const profileId of profiles) {
  const observed = await request('/profiles/native-review', { profileId });
  assert.equal(observed.blockingCount, 0);
  assert.equal(observed.activeTabCount, 0);
  native.push(observed);
}
const backup = await request('/backups/create', { directory: root });
const db = new DatabaseSync(path.join(backup.directory, 'workspace.sqlite'), { readOnly: true });
let snapshot;
try {
  snapshot = {
    schema: db.prepare('PRAGMA user_version').get().user_version,
    unknown: db
      .prepare("SELECT * FROM task_outbox WHERE status='UNKNOWN' ORDER BY id")
      .all()
      .map((row) => {
        delete row.control_ended;
        return {
          id: row.id,
          digest: createHash('sha256').update(JSON.stringify(row)).digest('hex'),
        };
      }),
  };
} finally {
  db.close();
}
await writeFile(
  path.join(root, 'baseline.json'),
  JSON.stringify(
    { backup, snapshot, tasks, native, browserRestarts: 0, taskAssignments: 0 },
    null,
    2,
  ),
  { flag: 'wx' },
);
console.log(
  JSON.stringify({
    root,
    backup,
    schema: snapshot.schema,
    unknown: snapshot.unknown.length,
    paused: tasks.plans.filter((plan) => plan.state === 'PAUSED').map((plan) => plan.id),
  }),
);
