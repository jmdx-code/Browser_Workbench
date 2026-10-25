import { readFile, writeFile, access, readdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { productDataDirectory } from '../dist/src/infrastructure/paths.js';
const reportPath = 'audit/resource-table-formal-api.json';
try {
  await access(reportPath);
  console.log('Existing formal evidence preserved.');
  process.exit(0);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const origin = 'http://127.0.0.1:18767';
const cookie = (await fetch(origin + '/workbench/')).headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
const summariesResponse = await fetch(origin + '/api/workspace/resource-tables/summaries', {
  headers: { cookie },
  signal: AbortSignal.timeout(10000),
});
assert.equal(summariesResponse.status, 200);
const summaries = await summariesResponse.json();
assert.deepEqual(summaries, []);
const response = await fetch(origin + '/api/workspace/resource-tables/read', {
  method: 'POST',
  headers: { cookie, origin, 'content-type': 'application/json' },
  body: JSON.stringify({ combinationId: randomUUID() }),
  signal: AbortSignal.timeout(10000),
});
assert.equal(response.status, 404);
assert.equal((await response.json()).code, 'COMBINATION_NOT_FOUND');
const after = JSON.parse(await readFile('audit/resource-table-postflight-verified.json', 'utf8'));
const before = JSON.parse(await readFile('audit/resource-table-preflight.json', 'utf8'));
assert.equal(after.schema.product, 13);
assert.deepEqual(after.preservation, before.preservation);
assert.equal(after.resourceTableHeads, 0);
assert.equal(after.resourceTableVersions, 0);
assert.equal(after.plans, 0);
assert.equal(after.activeBridgeTasks, 0);
assert.equal(after.unresolvedOutbox, 0);
assert.equal(after.unresolvedBridgeOperations, 0);
const directory = productDataDirectory();
const backups = (await readdir(directory))
  .filter((file) => file.startsWith('workspace.sqlite.before-v13-'))
  .sort();
const backupFile = backups.at(-1);
assert.ok(backupFile);
const backup = new DatabaseSync(path.join(directory, backupFile), { readOnly: true });
const current = new DatabaseSync(path.join(directory, 'workspace.sqlite'), { readOnly: true });
let originalDefinitions = 0;
try {
  assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 12);
  const original = backup
    .prepare('SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name')
    .all();
  originalDefinitions = original.length;
  for (const definition of original)
    assert.deepEqual(
      current.prepare('SELECT name,type,sql FROM sqlite_master WHERE name=?').get(definition.name),
      definition,
    );
} finally {
  backup.close();
  current.close();
}
await writeFile(
  reportPath,
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      version: JSON.parse(await readFile('package.json', 'utf8')).version,
      schema: after.schema,
      originalDefinitionsPreserved: originalDefinitions,
      backupFile,
      authenticatedSummaryStatus: summariesResponse.status,
      emptyResourceTables: true,
      unknownCombinationStatus: response.status,
      configurationPreserved: true,
      businessTablesUnchanged: true,
      actualFacebook: false,
      publishingReady: false,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log('Formal resource API, schema13 backup and original configuration preservation passed.');
