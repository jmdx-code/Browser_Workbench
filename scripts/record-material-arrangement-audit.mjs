import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const load = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const files = {
  before: 'audit/material-arrangement-preflight.json',
  after: 'audit/material-arrangement-postflight.json',
  ui: 'audit/material-arrangement-ui-observation.json',
  sources: 'audit/material-arrangement-live-source-after.json',
  sourceSmoke: 'audit/material-arrangement-source-smoke.json',
  packagedSmoke: 'audit/material-arrangement-packaged-smoke.json',
  formal: 'audit/material-arrangement-formal-api.json',
  owner: 'audit/material-arrangement-owner-after.json',
};
const data = Object.fromEntries(
  await Promise.all(Object.entries(files).map(async ([key, file]) => [key, await load(file)])),
);
assert.equal((await load('package.json')).version, '0.1.34');
assert.equal((await load('extension-build/manifest.json')).version, '0.3.7');
const log = await readFile('audit/check-material-arrangement-final.log', 'utf8');
const metric = (key) =>
  Number(log.match(new RegExp('(?:#|ℹ)\\s*' + key + '\\s+(\\d+)'))?.[1] ?? -1);
assert.equal(metric('tests'), 451);
assert.equal(metric('pass'), 451);
assert.equal(metric('fail'), 0);
assert.deepEqual(data.after.schema, { product: 12, journal: 2 });
assert.deepEqual(data.before.schema, data.after.schema);
assert.deepEqual(data.before.preservation, data.after.preservation);
for (const [key, value] of Object.entries(data.after))
  if (typeof value === 'number' && key !== 'profiles') assert.equal(value, 0, key);
assert.equal(data.sources.sourceUnchanged, true);
assert.equal(data.ui.generatedFixture, true);
assert.equal(data.ui.actualFacebook, false);
const observation = (stage) => {
  const row = data.ui.observations.find((item) => item.stage === stage);
  assert.ok(row, stage);
  return row;
};
const first = observation('50-profiles').dom;
assert.equal(first.rows, 50);
assert.equal(first.selectedProfiles, 50);
assert.equal(first.sections, 1);
assert.equal(first.publishDisabled, true);
assert.equal(first.overflow, false);
assert.match(first.status, /已分配 50 条.*缺 0/);
assert.ok(first.options < 100);
assert.match(observation('single-conflict').status, /2 条内容冲突/);
assert.match(observation('bulk-clear').status, /已分配 48 条.*缺 2/);
assert.equal(observation('bulk-clear').selectedRows, 2);
assert.equal(observation('row-content-preview').dom.source, '多图');
assert.equal(observation('row-content-preview').dom.media, 1);
assert.equal(observation('count-change').oldRows, 0);
assert.equal(observation('scope-change').oldRows, 0);
assert.match(observation('100-rows-shortage').status, /共 100 条.*缺 50/);
assert.equal(observation('100-rows-shortage').rowsVisible, 50);
assert.match(observation('second-page').firstRow, /资料26/);
assert.equal(observation('narrow').dom.width, 319);
assert.equal(observation('narrow').dom.overflow, false);
assert.equal(observation('narrow').dom.sections, 1);
for (const smoke of [data.sourceSmoke, data.packagedSmoke]) {
  assert.equal(smoke.ok, true);
  assert.equal(smoke.seedSchemaVersion, 12);
}
assert.equal(data.formal.arrangementRouteStatus, 409);
assert.equal(data.formal.arrangementRouteCode, 'MATERIAL_PREVIEW_EXPIRED');
assert.equal(data.formal.formalScanRequests, 0);
assert.equal(data.formal.plans, 0);
assert.equal(data.formal.dispatchEnabled, false);
await writeFile(
  'audit/material-arrangement-results.json',
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      sourceVersion: '0.1.34',
      extensionVersion: '0.3.7',
      schema: data.after.schema,
      delivered:
        'bounded readonly material allocation draft for explicitly selected browser profiles',
      fullV1Complete: false,
      publishingImplemented: false,
      persistentScheduleImplemented: false,
      programChecks: { total: 451, passed: 451, failed: 0 },
      generatedUI: data.ui,
      sourceUnchanged: true,
      formalOwner: data.owner,
      formalApi: data.formal,
      preservedConfigurationHashes: data.after.preservation,
      formalBusinessCounts: Object.fromEntries(
        Object.entries(data.after).filter(
          ([key, value]) => typeof value === 'number' && key !== 'profiles',
        ),
      ),
      sourceSmoke: { ok: true, seedSchemaVersion: 12 },
      packagedSmoke: { ok: true, seedSchemaVersion: 12 },
      automaticAuditFlags: 'all ten disabled; DIAGNOSTICS=1',
      limitations: [
        'Local draft only: not persisted, reserved, queued or timed.',
        'Different profiles are not proven different FB accounts; history and acting identity remain unchecked.',
        'Uses original scan snapshot; preparation/submission require independent fresh source verification.',
        '50-profile UI uses explicitly generated offline fixtures, not real account or concurrency acceptance.',
      ],
      pending: [
        'real personal/Page acting identity authority',
        'durable explicit-content approval and task/material integration',
        'independent publishing result verification and archive execution',
        'complete product acceptance',
      ],
      evidence: files,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log(
  'Readonly allocation draft evidence saved; full V1 and real publishing remain incomplete.',
);
