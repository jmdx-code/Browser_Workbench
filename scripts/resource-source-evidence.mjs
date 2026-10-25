import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
const target = 'audit/resource-source-results.json';
try {
  await access(target);
  console.log('Existing source-check result preserved.');
  process.exit(0);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const get = async (file) => JSON.parse(await readFile('audit/' + file, 'utf8'));
const checkLog = await readFile('audit/check-resource-source-final.log', 'utf8');
assert.match(checkLog, /tests 464/);
assert.match(checkLog, /fail 0/);
const source = await get('resource-source-source-smoke-final.json');
const packaged = await get('resource-source-packaged-smoke-final.json');
for (const smoke of [source, packaged]) {
  assert.equal(smoke.ok, true);
  assert.equal(smoke.workspaceDatabaseVersion, 13);
  assert.equal(smoke.seedSchemaVersion, 13);
  assert.equal(smoke.closePersisted, true);
}
const initial = await get('resource-source-ui-check.json'),
  saved = await get('resource-source-ui-save-check.json'),
  subset = await get('resource-source-ui-subset.json'),
  narrow = await get('resource-source-ui-narrow.json');
assert.match(initial.summary, /4 条来源已核对.*3 条不同内容.*1 条重复/);
assert.ok(initial.rowStates.some((text) => text.includes('内容重复：第2行')));
for (const text of ['网盘文件待下载核验', '文件不存在或无法读取', '实际文件类型与扩展名不符'])
  assert.ok(initial.rowStates.some((row) => row.includes(text)));
assert.match(saved.summary, /4 条不同内容.*0 条重复/);
assert.equal(saved.dialogOpen, true);
assert.match(saved.dirty, /已保存/);
assert.match(subset.summary, /检查 2 行/);
assert.equal(subset.selected, 2);
assert.equal(subset.inspectedRows, 2);
assert.equal(narrow.width, 319);
assert.equal(narrow.overflow, false);
assert.equal(initial.overflow, false);
const after = await get('resource-source-live-after.json');
assert.equal(after.sourceUnchanged, true);
assert.equal(after.plans, 0);
assert.equal(after.table.revision, 2);
const api = await get('resource-source-formal-api.json');
assert.equal(api.configHashesPreserved, true);
assert.equal(api.sourceIORequested, false);
assert.equal(api.resourceTablesEmpty, true);
const ui = await get('resource-source-formal-ui.json');
assert.equal(ui.versionVisible, true);
assert.equal(ui.overflow, false);
assert.deepEqual(ui.alerts, []);
await writeFile(
  target,
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      version: '0.1.36',
      tests: { total: 464, failed: 0 },
      schema: { product: 13, journal: 2 },
      pluginVersion: '0.3.7',
      sourceSmoke: { passed: true, seedSchema: 13, actualSchema: 13 },
      packagedSmoke: { passed: true, seedSchema: 13, actualSchema: 13 },
      realGeneratedSourceUI: {
        initialVerifiedSources: 4,
        initialUniqueContents: 3,
        initialDuplicates: 1,
        afterCaptionEditUniqueContents: 4,
        saveAndCheckKeepsDialog: true,
        multiselectInspectionRows: 2,
        narrowWidth: 319,
        noOverflow: true,
        sourcesUnchanged: true,
      },
      formal: {
        servicePid: 35928,
        serviceSession: 39513,
        origin: 'http://127.0.0.1:18767',
        sourceIORequested: false,
        facebookInputRequested: false,
        configHashesPreserved: true,
        resourceTablesEmpty: true,
      },
      actualDriveDownload: false,
      nativeDesktopDragDrop: false,
      facebookPublished: false,
      consumptionOrArchive: false,
      fullV1Complete: false,
      remaining: [
        'Drive actual bytes and codec availability',
        'Immutable execution resource revision and original material allocation/consumption',
        'Stable acting personal/Page authority',
        'Original SDK upload and independent SUBMIT result',
        'Published archive and complete delivery',
      ],
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log('Source-check evidence recorded; full V1 remains incomplete.');
