import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../dist/src/infrastructure/workspace-store.js';
const output = 'audit/task-resources-integration.json';
try {
  await access(output);
  console.log('Existing task-resource integration evidence retained.');
  process.exit(0);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const directory = path.resolve('audit/task-resources-generated-' + randomUUID());
await mkdir(directory);
const file = path.join(directory, 'workspace.sqlite');
let store = await WorkspaceStore.open(file);
try {
  const combination = store.createCombination({
    name: '生成任务资源固定验收',
    note: '50个生成资料；不连接/不执行FB',
    steps: [
      {
        id: randomUUID(),
        type: 'post',
        resourceMode: 'table',
        resourceDirectory: '',
        count: 1,
        allowRepeat: false,
        forbidSameAccountRepeat: true,
        archivePublished: true,
      },
    ],
    randomOrder: false,
    loop: { mode: 'finite', rounds: 2 },
  });
  const rows = Array.from({ length: 60 }, (_, index) => ({
    id: randomUUID(),
    text: '原明确内容' + (index + 1),
    media: [],
    background: 'plain',
  }));
  const original = store.resourceTables.save(combination.id, 0, rows);
  const runtime = Array.from({ length: 50 }, () => ({
    id: randomUUID(),
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: true,
    account: {
      state: 'logged-in',
      id: 'generated-account-' + randomUUID(),
      name: null,
      avatar: null,
    },
  }));
  const input = {
    requestId: randomUUID(),
    combinationId: combination.id,
    version: 1,
    profileIds: runtime.map((profile) => profile.id),
    expectedResourceRevision: 1,
  };
  const plans = store.tasks.assign(input, runtime);
  assert.equal(plans.length, 50);
  store.resourceTables.save(combination.id, 1, [
    { id: randomUUID(), text: '编辑后另一个版本', media: [], background: 'color' },
  ]);
  const fixedDigest = createHash('sha256').update(JSON.stringify(original)).digest('hex');
  store.close();
  store = await WorkspaceStore.open(file);
  assert.deepEqual(store.tasks.assign(input, runtime), plans);
  for (const plan of plans)
    assert.equal(
      createHash('sha256')
        .update(JSON.stringify(store.tasks.resources.snapshot(plan.id).table))
        .digest('hex'),
      fixedDigest,
    );
  assert.equal(store.tasks.claimNext(runtime, new Set(['post'])), null);
  assert.ok(
    store.tasks
      .list()
      .every(
        (plan) => plan.state === 'QUEUED' && plan.reason === 'RESOURCE_TABLE_EXECUTOR_REQUIRED',
      ),
  );
  const db = new DatabaseSync(file, { readOnly: true });
  let counts;
  try {
    counts = Object.fromEntries(
      [
        'task_resource_bindings',
        'task_plans',
        'task_account_locks',
        'task_outbox',
        'material_reservations',
        'material_publications',
      ].map((name) => [name, Number(db.prepare('SELECT COUNT(*) n FROM ' + name).get().n)]),
    );
  } finally {
    db.close();
  }
  assert.equal(counts.task_resource_bindings, 50);
  assert.equal(counts.task_account_locks, 0);
  assert.equal(counts.task_outbox, 0);
  assert.equal(counts.material_reservations, 0);
  assert.equal(counts.material_publications, 0);
  await writeFile(
    output,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        version: '0.1.37',
        directory,
        file,
        generatedFixture: true,
        realBrowserConcurrency: false,
        actualFacebook: false,
        assignmentId: input.requestId,
        planIds: plans.map((plan) => plan.id),
        fixedResourceRevision: 1,
        currentHeadRevision: 2,
        fixedSnapshotDigest: fixedDigest,
        reopenAndReplayPreserved: true,
        executionBlocked: true,
        counts,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  console.log(
    '50 generated plans retained resource revision 1 after head changed to 2 and reopen; no execution or consumption.',
  );
} finally {
  store.close();
}
