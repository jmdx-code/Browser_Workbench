import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../dist/src/infrastructure/workspace-store.js';
import { FilesystemMaterialScanner } from '../dist/src/infrastructure/material-scanner.js';
import { FilesystemMaterialSourceVerifier } from '../dist/src/infrastructure/material-source-verifier.js';
import { FilesystemMaterialUploadStage } from '../dist/src/infrastructure/material-upload-stage.js';
import { FilesystemMaterialCacheCleaner } from '../dist/src/infrastructure/material-cache-cleaner.js';
import { SqliteMaterialCacheCleanupRepository } from '../dist/src/infrastructure/material-cache-cleanup-store.js';
import { MaterialCacheCleanup } from '../dist/src/application/material-cache-cleanup.js';
import { MaterialPostSourceCheck } from '../dist/src/application/material-source-check.js';
import { MaterialUploadPreparation } from '../dist/src/application/material-upload-preparation.js';
import { PersistentMaterialUploadStage } from '../dist/src/application/persistent-material-upload-stage.js';
import { TaskControlBinding, SessionStopReceipt } from '../dist/src/shared/task-control.js';
import { KernelPersistentState } from '../dist/src/shared/kernel-state.js';
import { NegativeAttemptEvidence } from '../dist/src/shared/material-post.js';
import {
  postRequest,
  dispatchedPost,
  postReceipt,
  deliverPostNotices,
} from '../dist/tests/fixtures/material-post.js';

// New generated files/SQLite only. All identity/business/native-close/stop evidence is simulated.
// The worker performs actual per-file deletion; this script never touches a user resource directory.
const reportFile = 'audit/cache-cleanup-isolated.json';
const isolated = path.resolve('audit/cache-cleanup-isolated-' + randomUUID());
await writeFile(
  reportFile,
  JSON.stringify({ state: 'RESERVED', isolated, recordedAt: new Date().toISOString() }),
  { flag: 'wx' },
);
assert.equal(path.dirname(isolated), path.resolve('audit'));
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
class LostFileReceipt extends SqliteMaterialCacheCleanupRepository {
  deletedFile() {
    throw Error('SIMULATED_FILE_RECEIPT_LOST');
  }
}
const cases = [];
try {
  for (const [index, source] of ['image.png', 'album', 'video.mp4', 'image.png'].entries()) {
    const database = path.join(isolated, 'workspace-' + index + '.sqlite');
    let store = await WorkspaceStore.open(database);
    try {
      const catalog = store.materials.index(
        await new FilesystemMaterialScanner().scan(sourceRoot),
        randomUUID(),
      );
      const request = postRequest(store, catalog, { source });
      const intent = store.materials.reserve(request).intent;
      const operation = dispatchedPost(store, request, 'UPLOAD_MEDIA');
      const disk = new FilesystemMaterialUploadStage(path.join(isolated, 'cache-' + index));
      const stage = new PersistentMaterialUploadStage(store.uploadStages, disk);
      const sourceCheck = new MaterialPostSourceCheck(
        store.materials,
        store.materialPosts,
        store.taskTabs,
        new FilesystemMaterialSourceVerifier(),
      );
      const manifest = await new MaterialUploadPreparation(sourceCheck, stage).prepare(
        operation.binding,
        () => {},
      );
      const hashes = async () =>
        Promise.all(
          intent.snapshot.files.map(async (f) => ({
            name: f.relativePath,
            sha256: createHash('sha256')
              .update(await readFile(path.join(sourceRoot, f.relativePath)))
              .digest('hex'),
          })),
        );
      const before = await hashes();
      const verdict = index === 3 ? 'NOT_PUBLISHED' : 'PUBLISHED';
      const uploadReceipt = postReceipt(
        store,
        request,
        operation,
        verdict === 'PUBLISHED' ? 'APPLIED' : 'NOT_APPLIED',
      );
      store.materialPosts.verify(uploadReceipt);
      deliverPostNotices(store, request.context.profileId);
      if (verdict === 'PUBLISHED') {
        const submit = dispatchedPost(store, request, 'SUBMIT');
        store.materialPosts.verify(postReceipt(store, request, submit));
        deliverPostNotices(store, request.context.profileId);
      }
      const pending = store.tasks.requestControl(request.jobId, 'stop');
      const stop = TaskControlBinding.parse({
        ...request.context,
        requestId: pending.controlRequestId,
        jobId: request.jobId,
        mode: 'stop',
      });
      store.taskControls.bind(stop);
      const { jobId: _job, mode: _mode, ...stopFields } = stop;
      store.taskControls.confirm(
        stop,
        SessionStopReceipt.parse({ ...stopFields, state: 'stopped' }),
      );
      if (verdict === 'NOT_PUBLISHED') {
        const {
          purpose: _purpose,
          outcome: _outcome,
          postId: _post,
          basis: _basis,
          media: _media,
          ...fields
        } = uploadReceipt.evidence;
        store.materialPosts.resolveNotPublished(
          NegativeAttemptEvidence.parse({
            ...fields,
            outcome: 'NOT_PUBLISHED',
            basis: 'independently-verified-not-published',
          }),
        );
      }
      const tab = store.taskTabs.get(request.proof.ownershipId);
      store.taskTabs.confirmClosed(
        tab.proof.ownershipId,
        tab.revision,
        KernelPersistentState.parse({
          version: 1,
          profileId: tab.proof.profileId,
          browserSessionEpoch: tab.proof.browserSessionEpoch,
          operations: [],
          tabs: [
            {
              ownershipId: tab.proof.ownershipId,
              url: 'http://127.0.0.1/generated-only',
              state: 'CLOSED',
              proof: tab.proof,
              reason: 'SIMULATED_NATIVE_CLOSE',
            },
          ],
        }),
      );
      const business = store.materialPosts.result(request.attemptId),
        progress = store.tasks.steps(request.jobId)[0].progress;
      const prepared = store.cacheCleanup.prepare(manifest.stageId, stop.requestId);
      let interruption = null;
      if (index === 1) {
        const claim = store.cacheCleanup.claim(manifest.stageId, prepared.revision),
          db = new DatabaseSync(database);
        try {
          await assert.rejects(
            new FilesystemMaterialCacheCleaner(
              new LostFileReceipt(db, store.uploadStages, store.taskTabs),
              disk.cacheRoot,
            ).clean(claim),
            /SIMULATED_FILE_RECEIPT_LOST/,
          );
        } finally {
          db.close();
        }
        interruption = store.cacheCleanup.get(manifest.stageId);
        assert.equal(interruption.state, 'DELETING');
        assert.equal(interruption.files[0].state, 'DELETING');
        const names = await readdir(path.join(disk.cacheRoot, manifest.stageId));
        assert.equal(names.includes(interruption.files[0].file.name), false);
        store.close();
        store = await WorkspaceStore.open(database);
        assert.deepEqual(store.cacheCleanup.get(manifest.stageId), interruption);
        assert.equal(store.cacheCleanup.recoverOnStartup(), 1);
        assert.throws(() => store.cacheCleanup.assertCurrent(claim), /CLAIM_REVOKED/);
      }
      const worker = new MaterialCacheCleanup(
        store.cacheCleanup,
        new FilesystemMaterialCacheCleaner(store.cacheCleanup, disk.cacheRoot),
      );
      const cleaned = await worker.run(manifest.stageId, stop.requestId);
      assert.equal(cleaned.state, 'CLEANED');
      await assert.rejects(lstat(path.join(disk.cacheRoot, manifest.stageId)), { code: 'ENOENT' });
      assert.deepEqual(await hashes(), before);
      assert.deepEqual(store.materialPosts.result(request.attemptId), business);
      assert.deepEqual(store.tasks.steps(request.jobId)[0].progress, progress);
      assert.deepEqual(await worker.run(manifest.stageId, stop.requestId), cleaned);
      store.close();
      store = await WorkspaceStore.open(database);
      assert.deepEqual(store.cacheCleanup.get(manifest.stageId), cleaned);
      assert.equal(store.cacheCleanup.recoverOnStartup(), 0);
      const db = new DatabaseSync(database, { readOnly: true });
      let counts;
      try {
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11);
        counts = Object.fromEntries(
          [
            'material_publications',
            'material_archive_requests',
            'material_cache_cleanup_completions',
            'material_upload_stage_owners',
          ].map((table) => [table, db.prepare('SELECT count(*) AS n FROM ' + table).get().n]),
        );
        assert.equal(counts.material_publications, verdict === 'PUBLISHED' ? 1 : 0);
        assert.equal(counts.material_archive_requests, verdict === 'PUBLISHED' ? 1 : 0);
        assert.equal(counts.material_cache_cleanup_completions, 1);
        assert.equal(counts.material_upload_stage_owners, 1);
      } finally {
        db.close();
      }
      cases.push({
        database,
        source,
        verdict,
        manifest,
        binding: operation.binding,
        stop,
        cleaned,
        interruption,
        sourceHashes: before,
        sourceUnchanged: true,
        businessUnchanged: true,
        progressUnchanged: true,
        counts,
        deletedMediaFiles: manifest.files.length,
      });
    } finally {
      store.close();
    }
  }
  const report = {
    state: 'PASSED',
    recordedAt: new Date().toISOString(),
    isolated,
    softwareVersion: '0.1.23',
    schema: 11,
    actualCacheDeletion: true,
    actualBrowserOperations: 0,
    actualSdkFileTransfer: false,
    actualFacebookPublication: false,
    userResourceDirectoriesRead: false,
    simulation: [
      'account identity',
      'task target',
      'upload and publication/negative observations',
      'native CLOSED inventory',
      'stopped receipt',
      'notification receipt',
      'lost file callback',
    ],
    archivalMovement: false,
    cases,
  };
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      state: report.state,
      isolated,
      cases: cases.length,
      deletedMediaFiles: cases.reduce((n, row) => n + row.deletedMediaFiles, 0),
      interruptionRecovery: true,
      actualBrowserOperations: 0,
    }),
  );
} catch (error) {
  await writeFile(
    reportFile,
    JSON.stringify(
      {
        state: 'FAILED',
        isolated,
        cases,
        error: error.message,
        recordedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  throw error;
}
