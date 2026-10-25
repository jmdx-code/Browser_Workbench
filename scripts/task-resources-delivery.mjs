import assert from 'node:assert/strict';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const output = 'audit/task-resources-results.json';
try {
  await access(output);
  console.log('Existing task-resource delivery evidence retained.');
  process.exit(0);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const read = async (file) => JSON.parse(await readFile(file, 'utf8'));
const before = await read('audit/task-resources-preflight.json');
const after = await read('audit/task-resources-postflight.json');
assert.deepEqual(before.schema, { product: 13, journal: 2 });
assert.deepEqual(after.schema, { product: 14, journal: 2 });
assert.deepEqual(after.preservation, before.preservation);
for (const [key, value] of Object.entries(before))
  if (typeof value === 'number' && key !== 'profiles') assert.equal(after[key], value, key);
assert.equal(after.taskResourceBindings, 0);
const backups = (await readdir(after.directory)).filter((name) =>
  /^workspace\.sqlite\.before-v14-\d+\.sqlite$/.test(name),
);
assert.equal(backups.length, 1);
const previous = new DatabaseSync(path.join(after.directory, backups[0]), { readOnly: true });
const current = new DatabaseSync(path.join(after.directory, 'workspace.sqlite'), {
  readOnly: true,
});
let preservedDefinitions;
try {
  assert.equal(previous.prepare('PRAGMA user_version').get().user_version, 13);
  const definitions = previous
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  for (const definition of definitions)
    assert.equal(
      current.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(definition.name)?.sql,
      definition.sql,
      definition.name,
    );
  preservedDefinitions = definitions.length;
} finally {
  previous.close();
  current.close();
}
const integration = await read('audit/task-resources-integration.json');
assert.equal(integration.counts.task_resource_bindings, 50);
assert.equal(integration.reopenAndReplayPreserved, true);
const source = await read('audit/task-resources-source-smoke.json');
const packaged = await read('audit/task-resources-packaged-smoke.json');
for (const smoke of [source, packaged]) {
  assert.equal(smoke.ok, true);
  assert.equal(smoke.seedSchemaVersion, 13);
  assert.equal(smoke.workspaceDatabaseVersion, 14);
}
const live = await read('audit/task-resources-after-cutover.json');
assert.equal(live.dispatchEnabled, false);
assert.equal(live.plans, 0);
assert.equal(live.activeInspections, 0);
assert.equal(live.inspectionRequested, false);
const check = await readFile('audit/check-task-resources.log', 'utf8');
assert.match(check, /tests 472/);
assert.match(check, /pass 472/);
assert.match(check, /fail 0/);
await writeFile(
  output,
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      version: '0.1.37',
      checks: { pass: 472, fail: 0 },
      sourceDesktop: { passed: true, migration: '13->14' },
      packagedDesktop: { passed: true, migration: '13->14' },
      formalDatabase: {
        migration: '13->14',
        previousSqlDefinitionsPreserved: preservedDefinitions,
        configurationHashesPreserved: true,
        originalBusinessCountsPreserved: true,
        taskResourceBindings: 0,
        backup: path.join(after.directory, backups[0]),
      },
      generatedIntegration: {
        plans: 50,
        fixedRevision: 1,
        currentHead: 2,
        reopenAndReplayPreserved: true,
        executionBlocked: true,
      },
      actualFacebook: false,
      realBrowserConcurrency: false,
      sourceBytesPinned: false,
      consumption: false,
      publication: false,
      archive: false,
      fullV1Complete: false,
      pluginRefreshRequired: false,
      evidence: [
        'check-task-resources.log',
        'task-resources-integration.json',
        'task-resources-source-smoke.json',
        'task-resources-packaged-smoke.json',
        'task-resources-preflight.json',
        'task-resources-postflight.json',
        'task-resources-after-cutover.json',
      ],
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log(
  `Task-resource delivery verified; ${preservedDefinitions} prior SQL definitions unchanged.`,
);
