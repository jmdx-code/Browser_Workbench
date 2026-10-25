import { workspaceSchemaVersion } from '../dist/src/infrastructure/workspace-store.js';
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const mode = process.argv[2];
const expectedExtension = JSON.parse(await readFile('extension/manifest.json', 'utf8')).version;
assert.ok(['before', 'after'].includes(mode));
const directory = path.resolve(process.argv[3] ?? '');
assert.ok(directory.startsWith(path.resolve('audit') + path.sep));
const data = path.join(process.env.APPDATA, 'Browser Workbench', 'data');
const origin = 'http://127.0.0.1:18767';
const landing = await fetch(origin + '/workbench/');
const cookie = landing.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
async function request(route, input) {
  const response = await fetch(origin + '/api/workspace' + route, {
    method: input === undefined ? 'GET' : 'POST',
    headers: {
      cookie,
      origin,
      'content-type': 'application/json',
      'x-workbench-workspace-contract': '6',
      'x-workbench-task-contract': '4',
      'x-workbench-task-capacity': '2',
      'x-workbench-runtime-contract': '1',
    },
    body: input === undefined ? undefined : JSON.stringify(input),
    signal: AbortSignal.timeout(45000),
  });
  const value = await response.json();
  assert.ok(response.ok, route + ':' + response.status + ':' + JSON.stringify(value));
  return value;
}
const workspace = await request('');
const tasks = await request('/tasks');
assert.ok(
  !tasks.plans.some((p) => ['QUEUED', 'RUNNING', 'STOPPING'].includes(p.state)),
  'ACTIVE_TASK_REQUIRES_COMPLETION_BEFORE_RELOAD',
);
// Existing offline PAUSING evidence is retained, never treated as a stopped task.
for (const plan of tasks.plans.filter((p) => p.state === 'PAUSING')) {
  assert.equal(workspace.profiles.find((p) => p.id === plan.profileId)?.online, false);
}
if (mode === 'before') await mkdir(directory);
const databases = {};
for (const name of ['workspace', 'journal']) {
  const db = new DatabaseSync(path.join(data, name + '.sqlite'), { readOnly: true });
  try {
    const quick = db.prepare('PRAGMA quick_check').all();
    assert.deepEqual(quick, [Object.assign(Object.create(null), { quick_check: 'ok' })]);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    databases[name] = { version: db.prepare('PRAGMA user_version').get().user_version, quick };
    if (name === 'workspace') {
      databases[name].unknown = db
        .prepare(
          "SELECT id,job_id,action,status FROM task_outbox WHERE status='UNKNOWN' ORDER BY id",
        )
        .all()
        .map((row) => ({
          id: row.id,
          hash: createHash('sha256').update(JSON.stringify(row)).digest('hex'),
        }));
      databases[name].settings = db
        .prepare('SELECT * FROM scheduler_settings')
        .all()
        .map((row) => ({ ...row }));
    }
    if (mode === 'before') await backup(db, path.join(directory, name + '.sqlite'));
  } finally {
    db.close();
  }
}
const report = {
  at: new Date().toISOString(),
  mode,
  data,
  databases,
  tasks,
  onlineProfiles: workspace.profiles.filter((p) => p.online).map((p) => p.id),
  profiles: workspace.profiles.map(({ id, online, synced, extensionVersion }) => ({
    id,
    online,
    synced,
    extensionVersion,
  })),
  browserRestarts: 0,
};
if (mode === 'after') {
  const before = JSON.parse(await readFile(path.join(directory, 'before.json'), 'utf8'));
  assert.equal(databases.workspace.version, workspaceSchemaVersion);
  assert.deepEqual(databases.workspace.unknown, before.databases.workspace.unknown);
  assert.deepEqual(databases.workspace.settings, before.databases.workspace.settings);
  for (const old of before.tasks.plans.filter((p) => ['PAUSED', 'PAUSING'].includes(p.state)))
    assert.ok(tasks.plans.some((p) => p.id === old.id && p.state === old.state));
  report.native = [];
  for (const profileId of [
    '066430e1-92cd-4ee4-8f43-98db3425239d',
    '9e4d39b2-90b0-4267-aee2-311089b78336',
  ]) {
    if (!report.onlineProfiles.includes(profileId)) continue;
    assert.equal(
      workspace.profiles.find((p) => p.id === profileId)?.extensionVersion,
      expectedExtension,
      'TEST_EXTENSION_UPGRADE_REQUIRED',
    );
    const review = await request('/profiles/native-review', { profileId });
    assert.equal(review.blockingCount, 0);
    assert.ok(review.tabs.every((tab) => tab.reason === 'WORKSPACE_MAIN_IDLE'));
    report.native.push(review);
  }
}
await writeFile(path.join(directory, mode + '.json'), JSON.stringify(report, null, 2), {
  flag: 'wx',
});
console.log(
  JSON.stringify({
    mode,
    directory,
    schema: databases.workspace.version,
    online: report.onlineProfiles.length,
    unknownPreserved: databases.workspace.unknown.length,
  }),
);
