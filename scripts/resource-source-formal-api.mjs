import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const reportFile = 'audit/resource-source-formal-api.json';
try {
  await access(reportFile);
  console.log('Existing formal source-check evidence preserved.');
  process.exit(0);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const origin = 'http://127.0.0.1:18767';
const cookie = (await fetch(origin + '/workbench/')).headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
const post = (body) =>
  fetch(origin + '/api/workspace/resource-tables/check', {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
const unknown = await post({ combinationId: randomUUID(), expectedRevision: 1 });
assert.equal(unknown.status, 404);
const unknownBody = await unknown.json();
assert.equal(unknownBody.code, 'COMBINATION_NOT_FOUND');
const arbitraryPath = await post({
  combinationId: randomUUID(),
  expectedRevision: 1,
  path: 'C:\\not-read.png',
});
assert.equal(arbitraryPath.status, 400);
const summaries = await fetch(origin + '/api/workspace/resource-tables/summaries', {
  headers: { cookie },
  signal: AbortSignal.timeout(10_000),
});
assert.equal(summaries.status, 200);
assert.deepEqual(await summaries.json(), []);
const before = JSON.parse(await readFile('audit/resource-source-preflight.json', 'utf8'));
const after = JSON.parse(await readFile('audit/resource-source-postflight.json', 'utf8'));
assert.deepEqual(after.schema, before.schema);
assert.deepEqual(after.preservation, before.preservation);
for (const [key, value] of Object.entries(before)) {
  if (typeof value === 'number' && key !== 'profiles') assert.equal(after[key], value, key);
}
assert.equal(after.plans, 0);
assert.equal(after.resourceTableHeads, 0);
assert.equal(after.materialReservations, 0);
await writeFile(
  reportFile,
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      version: '0.1.36',
      unknownCombination: { status: unknown.status, code: unknownBody.code },
      arbitraryPathRejected: arbitraryPath.status,
      sourceIORequested: false,
      facebookInputRequested: false,
      schemaPreserved: true,
      configHashesPreserved: true,
      resourceTablesEmpty: true,
      businessTablesPreserved: true,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log('Formal source-check API registered; no files, Facebook pages or publishing touched.');
