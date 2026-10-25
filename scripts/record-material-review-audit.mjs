import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const load = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const files = {
  before: 'audit/material-review-preflight.json',
  after: 'audit/material-review-postflight.json',
  ui: 'audit/material-review-ui-observation.json',
  sources: 'audit/material-review-live-source-after.json',
  sourceSmoke: 'audit/material-review-source-smoke.json',
  packagedSmoke: 'audit/material-review-packaged-smoke.json',
  formal: 'audit/material-review-formal-api.json',
  owner: 'audit/material-review-owner-after.json',
};
const values = Object.fromEntries(
  await Promise.all(Object.entries(files).map(async ([key, file]) => [key, await load(file)])),
);
const pkg = await load('package.json'),
  extension = await load('extension-build/manifest.json');
assert.equal(pkg.version, '0.1.33');
assert.equal(extension.version, '0.3.7');
const log = await readFile('audit/check-material-review-final.log', 'utf8');
const metric = (key) =>
  Number(log.match(new RegExp('(?:#|ℹ)\\s*' + key + '\\s+(\\d+)'))?.[1] ?? -1);
assert.equal(metric('tests'), 446);
assert.equal(metric('pass'), 446);
assert.equal(metric('fail'), 0);
assert.deepEqual(values.after.schema, { product: 12, journal: 2 });
assert.deepEqual(values.after.schema, values.before.schema);
assert.deepEqual(values.after.preservation, values.before.preservation);
for (const [key, value] of Object.entries(values.after))
  if (typeof value === 'number' && key !== 'profiles') assert.equal(value, 0, key);
assert.equal(values.sources.sourceUnchanged, true);
assert.equal(values.ui.generatedFixture, true);
assert.equal(values.ui.actualFacebook, false);
const observation = (stage) => {
  const result = values.ui.observations.find((row) => row.stage === stage);
  assert.ok(result, stage);
  return result;
};
assert.equal(observation('no-selection').prepareDisabled, true);
assert.equal(observation('two-profile-review').dom.selected, 2);
assert.equal(observation('two-profile-review').dom.publishDisabled, true);
assert.equal(observation('scope-change').staleTargetCount, 0);
assert.equal(observation('scope-change').prepareEnabled, true);
assert.ok(!observation('one-profile-review').text.includes('资料乙'));
assert.equal(observation('content-change').oldReviewCount, 0);
assert.equal(observation('album-two-profile-review').dom.targetCount, 2);
assert.equal(observation('album-two-profile-review').dom.overflow, false);
assert.equal(observation('narrow').dom.width, 319);
assert.equal(observation('narrow').dom.overflow, false);
for (const smoke of [values.sourceSmoke, values.packagedSmoke]) {
  assert.equal(smoke.ok, true);
  assert.equal(smoke.seedSchemaVersion, 12);
}
assert.equal(values.formal.reviewRouteStatus, 409);
assert.equal(values.formal.reviewRouteCode, 'MATERIAL_PREVIEW_EXPIRED');
assert.equal(values.formal.formalScanRequests, 0);
assert.equal(values.formal.browserInputs, 0);
assert.equal(values.formal.plans, 0);
assert.equal(values.formal.dispatchEnabled, false);
await writeFile(
  'audit/material-review-results.json',
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      sourceVersion: pkg.version,
      extensionVersion: extension.version,
      schema: values.after.schema,
      delivered:
        'read-only whole-package preparation review for explicitly selected material and profiles',
      fullV1Complete: false,
      publishingImplemented: false,
      actingIdentityAuthorityImplemented: false,
      programChecks: { total: 446, passed: 446, failed: 0 },
      generatedUI: values.ui,
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
      limitations: [
        'Preparation review is not persisted, reserved, queued, uploaded or submitted.',
        'Whole-package source and target observations may subsequently change; submission requires independent fresh verification.',
        'Every acting identity remains unverified, even if a display name/avatar is observed.',
        'Original typeText supports at most 4000 UTF-16 units; longer body retained with blocker.',
      ],
      pending: [
        'real personal/Page acting identity authority',
        'explicit-content submission and independent business-result verification',
        'archive execution and full delivery',
      ],
      evidence: files,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log(
  'Read-only publication preparation evidence recorded; publishing and full V1 remain pending.',
);
