import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

const planId = process.argv[2];
assert.ok(planId, 'EXACT_INTERRUPTED_PLAN_REQUIRED');
const data = path.join(process.env.APPDATA, 'Browser Workbench/data');
const root = path.resolve('audit/interrupted-control-snapshot-' + randomUUID());
await mkdir(root);
const workspace = new DatabaseSync(path.join(data, 'workspace.sqlite'), { readOnly: true });
const journal = new DatabaseSync(path.join(data, 'journal.sqlite'), { readOnly: true });
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
  const active = workspace
    .prepare(
      'SELECT id,state,control_confirmed,updated_at FROM task_plans WHERE state IN (?,?,?,?)',
    )
    .all('QUEUED', 'RUNNING', 'PAUSING', 'STOPPING');
  assert.equal(active.length, 1);
  assert.equal(active[0].id, planId);
  assert.ok(['PAUSING', 'STOPPING'].includes(active[0].state));
  const steps = workspace
    .prepare(
      'SELECT purpose FROM material_post_operations WHERE operation_id IN (SELECT id FROM task_outbox WHERE job_id=?)',
    )
    .all(planId);
  assert.ok(
    steps.every((step) =>
      ['OPEN_COMPOSER', 'OPEN_AUDIENCE', 'SELECT_SELF', 'CONFIRM_AUDIENCE'].includes(step.purpose),
    ),
    'CONTENT_INPUT_OR_SUBMISSION_REQUIRES_SEPARATE_RECOVERY',
  );
  const unknown = workspace
    .prepare('SELECT * FROM task_outbox WHERE status=? ORDER BY id')
    .all('UNKNOWN')
    .map((row) => ({ id: row.id, digest: hash(row) }));
  await backup(workspace, path.join(root, 'workspace.sqlite'));
  await backup(journal, path.join(root, 'journal.sqlite'));
  assert.deepEqual(
    workspace
      .prepare('SELECT id,state,control_confirmed,updated_at FROM task_plans WHERE id=?')
      .get(planId),
    active[0],
  );
  await writeFile(
    path.join(root, 'snapshot.json'),
    JSON.stringify(
      {
        kind: 'readonly-interrupted-control-backup',
        planId,
        active,
        unknown,
        schema: workspace.prepare('PRAGMA user_version').get().user_version,
        runtimeBefore: null,
        sourceVersion: JSON.parse(await readFile('package.json', 'utf8')).version,
        browserRestarts: 0,
        taskAssignments: 0,
        originalStopConfirmed: false,
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  console.log(root);
} finally {
  workspace.close();
  journal.close();
}
