import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { PublicationAcceptanceScope } from '../dist/src/infrastructure/publication-acceptance-scope.js';

const originalRoot = path.resolve(process.argv[2] ?? ''),
  planId = process.argv[3];
assert.ok(originalRoot.startsWith(path.resolve('audit') + path.sep) && planId);
const original = JSON.parse(await readFile(path.join(originalRoot, 'prepared.json'), 'utf8'));
assert.equal(original.scope.version, 7);
const db = new DatabaseSync(
  path.join(process.env.APPDATA, 'Browser Workbench/data/workspace.sqlite'),
  { readOnly: true },
);
try {
  const plan = db.prepare('SELECT batch_id,state FROM task_plans WHERE id=?').get(planId);
  assert.equal(plan.batch_id, original.scope.id);
  if (plan.state !== 'COMPLETED') {
    assert.equal(plan.state, 'FAILED');
    const reviewed = JSON.parse(
      await readFile(path.join(originalRoot, 'original-business-page-reviewed.json'), 'utf8'),
    );
    assert.equal(reviewed.originalHistoryUnchanged, true);
    assert.equal(reviewed.receipt?.evidence?.outcome, 'PUBLISHED');
  }
  const rows = db
    .prepare('SELECT state,usage_source_key FROM material_reservations WHERE job_id=?')
    .all(planId);
  assert.equal(rows.length, original.scope.resources.length);
  for (const row of rows) {
    assert.equal(row.state, 'PUBLISHED');
    assert.ok(
      db
        .prepare(
          'SELECT 1 FROM material_publications WHERE usage_source_key=? AND usage_generation=(SELECT generation FROM material_usage_policy WHERE id=1)',
        )
        .get(row.usage_source_key),
    );
  }
} finally {
  db.close();
}
const origin = 'http://127.0.0.1:18767';
const cookie = (await fetch(origin + '/workbench/')).headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
async function request(route, value) {
  const response = await fetch(origin + '/api/workspace' + route, {
    method: value === undefined ? 'GET' : 'POST',
    headers: {
      cookie,
      origin,
      'content-type': 'application/json',
      'x-workbench-task-contract': '4',
      'x-workbench-workspace-contract': '6',
    },
    body: value === undefined ? undefined : JSON.stringify(value),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  assert.ok(response.ok, JSON.stringify(body));
  return body;
}
assert.ok(
  !(await request('/tasks')).plans.some((p) =>
    ['QUEUED', 'RUNNING', 'PAUSING', 'STOPPING'].includes(p.state),
  ),
);
const workspace = await request('');
const row = workspace.combinations.find((c) => c.id === original.scope.combinationId);
assert.equal(row.version, original.scope.combinationVersion);
assert.ok(row.saved && !row.draft);
const value = {
  ...row.saved,
  name: '资源耗尽后继续浏览',
  note: 'Used-resource continuation; SUBMIT disabled; no new publications.',
  steps: [
    ...row.saved.steps,
    { id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
  ],
};
const draft = await request('/combinations/draft', {
  id: row.id,
  expectedRevision: row.revision,
  value,
});
const saved = await request('/combinations/publish', {
  id: row.id,
  expectedRevision: draft.revision,
});
const scope = PublicationAcceptanceScope.parse({
  ...original.scope,
  id: randomUUID(),
  combinationVersion: saved.version,
  submitDisabled: true,
});
const root = path.resolve('audit/used-resource-continuation-097-' + randomUUID());
await mkdir(root);
await writeFile(
  path.join(root, 'prepared.json'),
  JSON.stringify(
    {
      root,
      originalRoot,
      originalPlanId: planId,
      scope,
      assignment: { ...original.assignment, requestId: scope.id, version: saved.version },
      maximumNewPublications: 0,
      expected: { skippedPosts: scope.resources.length, feedMilliseconds: 60000, submissions: 0 },
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
console.log(JSON.stringify({ root, scope }));
