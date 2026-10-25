import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const load = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const files = {
  before: 'audit/material-media-preflight.json',
  after: 'audit/material-media-postflight.json',
  ui: 'audit/material-media-ui-observation.json',
  narrow: 'audit/material-media-ui-narrow-verified.json',
  sources: 'audit/material-media-live-source-after.json',
  sourceSmoke: 'audit/material-media-source-smoke.json',
  packagedSmoke: 'audit/material-media-packaged-smoke.json',
  formal: 'audit/material-media-formal-api.json',
  owner: 'audit/material-media-owner-after.json',
};
const values = Object.fromEntries(
  await Promise.all(Object.entries(files).map(async ([key, file]) => [key, await load(file)])),
);
const packageInfo = await load('package.json'),
  extension = await load('extension-build/manifest.json');
assert.equal(packageInfo.version, '0.1.32');
assert.equal(extension.version, '0.3.7');
const log = await readFile('audit/check-material-media-delivery.log', 'utf8');
const metric = (key) =>
  Number(log.match(new RegExp('(?:#|ℹ)\\s*' + key + '\\s+(\\d+)'))?.[1] ?? -1);
assert.equal(metric('tests'), 440);
assert.equal(metric('pass'), 440);
assert.equal(metric('fail'), 0);
assert.deepEqual(values.before.schema, { product: 12, journal: 2 });
assert.deepEqual(values.after.schema, values.before.schema);
assert.deepEqual(values.before.preservation, values.after.preservation);
for (const [key, value] of Object.entries(values.after))
  if (typeof value === 'number' && key !== 'profiles') assert.equal(value, 0, key);
assert.equal(values.sources.sourceUnchanged, true);
assert.equal(values.ui.generatedFixture, true);
assert.equal(values.ui.actualFacebook, false);
for (const name of ['album-first', 'album-second', 'single']) {
  const row = values.ui.checks.find((item) => item.case === name);
  assert.equal(row.complete, true);
  assert.equal(row.naturalWidth, 1);
}
const video = values.ui.checks.find((item) => item.case === 'video-play');
assert.equal(video.paused, false);
assert.ok(video.currentTime > 0);
assert.equal(video.duration, 12);
assert.equal(video.readyState, 4);
assert.equal(video.error, null);
assert.equal(values.ui.checks.find((item) => item.case === 'video-progress').currentTime, 12);
assert.equal(values.ui.checks.find((item) => item.case === 'active-before-switch').paused, false);
assert.equal(values.ui.checks.find((item) => item.case === 'active-switch-removed').videos, 0);
assert.equal(values.ui.checks.find((item) => item.case === 'active-switch-removed').selected, true);
assert.equal(values.narrow.width, 319);
assert.equal(values.narrow.overflow, false);
assert.equal(values.narrow.selected, true);
assert.equal(values.narrow.naturalWidth, 1);
for (const smoke of [values.sourceSmoke, values.packagedSmoke]) {
  assert.equal(smoke.ok, true);
  assert.equal(smoke.seedSchemaVersion, 12);
}
assert.equal(values.formal.mediaRouteStatus, 409);
assert.equal(values.formal.mediaRouteCode, 'MATERIAL_PREVIEW_EXPIRED');
assert.equal(values.formal.formalScanRequests, 0);
assert.equal(values.formal.plans, 0);
assert.equal(values.formal.dispatchEnabled, false);
await writeFile(
  'audit/material-media-results.json',
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      sourceVersion: packageInfo.version,
      extensionVersion: extension.version,
      schema: values.after.schema,
      delivered: 'local image selection and manual video preview',
      fullV1Complete: false,
      programChecks: { total: 440, passed: 440, failed: 0 },
      generatedUI: values.ui,
      actualNarrow: values.narrow,
      sourceUnchanged: true,
      preservedConfigurationHashes: values.after.preservation,
      formalBusinessCounts: Object.fromEntries(
        Object.entries(values.after).filter(
          ([key, value]) => typeof value === 'number' && key !== 'profiles',
        ),
      ),
      sourceSmoke: { ok: true, seedSchemaVersion: 12 },
      packagedSmoke: { ok: true, seedSchemaVersion: 12 },
      formalOwner: values.owner,
      formalApi: values.formal,
      automaticAuditFlags: 'all ten disabled; DIAGNOSTICS=1',
      oldUploadUnknownRecords: 'preserved; not replayed',
      pending: [
        'explicit content selection and submission',
        'real acting personal/Page identity authority',
        'original upload/submission independent verification',
        'archive execution and full delivery',
      ],
      limitations: [
        'image 20 MiB / video 128 MiB preview limits; larger video streaming not implemented',
        'full verified file loads before playback; codec support depends on browser',
        'loaded snapshots persist locally until selection, expiry or unmount; source can subsequently change',
      ],
      evidence: files,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log('Material visual preview evidence recorded; complete V1 remains pending.');
