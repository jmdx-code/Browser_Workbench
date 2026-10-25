import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const reportFile = process.argv[2];
assert.ok(
  reportFile && /^audit\/[a-z0-9-]+\.json$/.test(reportFile),
  'FRESH_AUDIT_REPORT_REQUIRED',
);
const origin = 'http://127.0.0.1:18767';
const initial = await fetch(origin + '/workbench/');
assert.equal(initial.status, 200);
const cookie = initial.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
const request = async (route, input) => {
  const response = await fetch(origin + '/api/workspace' + route, {
    method: input === undefined ? 'GET' : 'POST',
    headers: {
      cookie,
      origin,
      'content-type': 'application/json',
      'x-workbench-task-contract': '2',
      'x-workbench-workspace-contract': '4',
    },
    body: input === undefined ? undefined : JSON.stringify(input),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json() };
};
const before = await request('/materials/cache');
assert.equal(before.status, 200);
assert.equal(before.body.version, 1);
assert.ok(Array.isArray(before.body.entries));
const invalid = await request('/materials/cache/clean', { stageIds: [randomUUID()], path: 'C:/' });
assert.equal(invalid.status, 400);
const missingStage = randomUUID();
const missing = await request('/materials/cache/clean', { stageIds: [missingStage] });
assert.equal(missing.status, 200);
assert.equal(missing.body.results.length, 1);
assert.equal(missing.body.results[0].stageId, missingStage);
assert.equal(missing.body.results[0].cleaned, false);
const after = await request('/materials/cache');
assert.equal(after.status, 200);
assert.deepEqual(after.body, before.body);
const tasks = await request('/tasks');
assert.equal(tasks.status, 200);
assert.equal(
  tasks.body.plans.filter((plan) =>
    ['QUEUED', 'RUNNING', 'PAUSING', 'STOPPING'].includes(plan.state),
  ).length,
  0,
);
const report = {
  checkedAt: new Date().toISOString(),
  cache: before.body,
  arbitraryPathRejected: true,
  missingStageDeleted: false,
  cacheSnapshotUnchanged: true,
  actualCacheDeletion: false,
  activeTasks: 0,
  passed: true,
};
await writeFile(reportFile, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(
  JSON.stringify({
    reportFile,
    entries: report.cache.entries.length,
    eligible: report.cache.entries.filter((entry) => entry.eligible).length,
    actualCacheDeletion: false,
    passed: true,
  }),
);
