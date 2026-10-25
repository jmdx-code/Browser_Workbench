import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { WorkspaceStore } from '../dist/src/infrastructure/workspace-store.js';
import { FilesystemMaterialScanner } from '../dist/src/infrastructure/material-scanner.js';
import { FilesystemMaterialSourceVerifier } from '../dist/src/infrastructure/material-source-verifier.js';
import { FilesystemMaterialUploadStage } from '../dist/src/infrastructure/material-upload-stage.js';
import { PersistentMaterialUploadStage } from '../dist/src/application/persistent-material-upload-stage.js';
import { MaterialPostSourceCheck } from '../dist/src/application/material-source-check.js';
import { MaterialUploadPreparation } from '../dist/src/application/material-upload-preparation.js';
import { MaterialFileGrantPreparation } from '../dist/src/application/material-file-grant-preparation.js';
import { postRequest, dispatchedPost } from '../dist/tests/fixtures/material-post.js';

// A new generated filesystem/SQLite audit. No native browser API or user directory access.
const reportFile = 'audit/upload-stage-ledger-isolated.json';
const isolated = path.resolve('audit/upload-stage-ledger-isolated-' + randomUUID());
await writeFile(
  reportFile,
  JSON.stringify({ state: 'RESERVED', isolated, recordedAt: new Date().toISOString() }),
  { flag: 'wx' },
);
await mkdir(isolated);
const sourceRoot = path.join(isolated, 'generated-materials');
await mkdir(sourceRoot);
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
  'base64',
);
await writeFile(path.join(sourceRoot, 'image.png'), png, { flag: 'wx' });
await mkdir(path.join(sourceRoot, 'album'));
for (const name of ['a.png', 'b.png'])
  await writeFile(path.join(sourceRoot, 'album', name), png, { flag: 'wx' });
await writeFile(path.join(sourceRoot, 'video.mp4'), await readFile('public/sample.mp4'), {
  flag: 'wx',
});
const cases = [];
const noop = () => {};
for (const [index, source] of ['image.png', 'album', 'video.mp4'].entries()) {
  const database = path.join(isolated, 'workspace-' + index + '.sqlite');
  let store = await WorkspaceStore.open(database);
  try {
    const catalog = store.materials.index(
      await new FilesystemMaterialScanner().scan(sourceRoot),
      randomUUID(),
    );
    const request = postRequest(store, catalog, { source });
    const intent = store.materials.reserve(request).intent;
    const original = dispatchedPost(store, request, 'UPLOAD_MEDIA');
    const sourceCheck = new MaterialPostSourceCheck(
      store.materials,
      store.materialPosts,
      store.taskTabs,
      new FilesystemMaterialSourceVerifier(),
    );
    const disk = new FilesystemMaterialUploadStage(path.join(isolated, 'cache-' + index));
    let beforeIO = false;
    const cache = new PersistentMaterialUploadStage(store.uploadStages, {
      cacheRoot: disk.cacheRoot,
      stageReserved: async (value, binding, id, current) => {
        assert.equal(store.uploadStages.get(id).state, 'WRITING');
        assert.deepEqual(store.uploadStages.get(id).owner.binding, original.binding);
        beforeIO = true;
        return disk.stageReserved(value, binding, id, current);
      },
      verify: disk.verify.bind(disk),
    });
    const hashes = async () =>
      Promise.all(
        intent.snapshot.files.map(async (file) => ({
          file: file.relativePath,
          sha256: createHash('sha256')
            .update(await readFile(path.join(sourceRoot, file.relativePath)))
            .digest('hex'),
        })),
      );
    const before = await hashes();
    const manifest = await new MaterialUploadPreparation(sourceCheck, cache).prepare(
      original.binding,
      noop,
    );
    const files = (
      await new MaterialFileGrantPreparation(sourceCheck, cache).prepare(
        original.binding,
        manifest,
        noop,
      )
    ).files;
    for (const [ordinal, file] of files.entries())
      assert.equal(
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
        manifest.files[ordinal].original.digest,
      );
    const prepared = store.uploadStages.get(manifest.stageId);
    assert.equal(prepared.state, 'READY');
    assert.equal(beforeIO, true);
    store.close();
    store = await WorkspaceStore.open(database);
    assert.deepEqual(store.uploadStages.get(manifest.stageId), prepared);
    assert.equal(store.uploadStages.recoverOnStartup(), 1);
    assert.equal(store.uploadStages.recoverOnStartup(), 0);
    const recovered = store.uploadStages.get(manifest.stageId);
    assert.equal(recovered.state, 'REVIEW');
    assert.deepEqual(recovered.manifest, manifest);
    assert.throws(() => store.uploadStages.assertReady(manifest), /NOT_READY/);
    assert.throws(
      () => store.uploadStages.reserve(intent, original.binding, disk.cacheRoot, 10 * 1024 ** 3),
      /ALREADY_OWNED/,
    );
    // Ledger revocation retains bytes and the original manifest, but grants no input permission.
    for (const [ordinal, file] of files.entries())
      assert.equal(
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
        manifest.files[ordinal].original.digest,
      );
    assert.deepEqual(await hashes(), before);
    assert.equal(store.materials.reservation(request.attemptId).state, 'RESERVED');
    assert.equal(store.tasks.operations(request.jobId)[0].status, 'DISPATCHING');
    assert.equal(store.materialPosts.result(request.attemptId), null);
    const checkDb = new DatabaseSync(database, { readOnly: true });
    try {
      for (const table of [
        'material_operation_verdicts',
        'material_attempt_verdicts',
        'material_publications',
        'material_archive_requests',
        'task_settlement_notices',
      ])
        assert.equal(checkDb.prepare('SELECT count(*) AS n FROM ' + table).get().n, 0);
      assert.equal(checkDb.prepare('PRAGMA user_version').get().user_version, 10);
    } finally {
      checkDb.close();
    }
    cases.push({
      source,
      database,
      binding: original.binding,
      proof: intent.proof,
      manifest,
      files,
      beforeIO,
      persistedReady: true,
      passiveReopenPreserved: true,
      recovered,
      sourceHashes: before,
      sourceUnchanged: true,
      cacheRetainedAfterRecovery: true,
      restagingRejected: true,
      outbox: 'DISPATCHING',
      reservation: 'RESERVED',
      businessVerdicts: 0,
      publications: 0,
      archives: 0,
      notifications: 0,
    });
  } finally {
    store.close();
  }
}
const report = {
  state: 'PASSED',
  recordedAt: new Date().toISOString(),
  softwareVersion: '0.1.22',
  schema: 10,
  isolated,
  sourceRoot,
  generatedFixture: true,
  simulatedIdentitiesTargetsAndRecovery: true,
  actualBrowserOperations: 0,
  actualSdkFileTransfer: false,
  facebookPublished: false,
  userResourceDirectoriesRead: false,
  sourceFilesMoved: false,
  productionEnabled: false,
  cacheCleanupImplemented: false,
  archiveWorkerImplemented: false,
  cases,
};
await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    state: report.state,
    isolated,
    cases: cases.length,
    retainedFiles: cases.reduce((sum, row) => sum + row.files.length, 0),
    actualBrowserOperations: 0,
  }),
);
