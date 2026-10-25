import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../dist/src/infrastructure/workspace-store.js';
import { FilesystemMaterialScanner } from '../dist/src/infrastructure/material-scanner.js';
import { FilesystemMaterialArchivePlanner } from '../dist/src/infrastructure/material-archive-planner.js';
import { MaterialArchivePreparation } from '../dist/src/application/material-archive-preparation.js';
import {
  postRequest,
  dispatchedPost,
  postReceipt,
  deliverPostNotices,
} from '../dist/tests/fixtures/material-post.js';

// New generated resources/SQLite only. Publication and notification observations are simulated.
// The planner performs real read-only source checks, never creates destination directories or moves files.
const reportFile = 'audit/archive-plan-isolated.json';
const isolated = path.resolve('audit/archive-plan-isolated-' + randomUUID());
await writeFile(
  reportFile,
  JSON.stringify({ state: 'RESERVED', isolated, recordedAt: new Date().toISOString() }),
  { flag: 'wx' },
);
assert.equal(path.dirname(isolated), path.resolve('audit'));
await mkdir(isolated);
const root = path.join(isolated, 'generated-materials');
await mkdir(root);
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
  'base64',
);
await writeFile(path.join(root, 'text.txt'), '生成归档计划正文', { flag: 'wx' });
await writeFile(path.join(root, 'image.png'), png, { flag: 'wx' });
await writeFile(path.join(root, 'image.txt'), '图片配文', { flag: 'wx' });
await mkdir(path.join(root, 'album'));
for (const name of ['a.png', 'b.png'])
  await writeFile(path.join(root, 'album', name), png, { flag: 'wx' });
await writeFile(path.join(root, 'album', '正文.txt'), '多图正文', { flag: 'wx' });
await writeFile(path.join(root, 'video.mp4'), await readFile('public/sample.mp4'), { flag: 'wx' });
const cases = [];
try {
  for (const [index, name] of ['text.txt', 'image.png', 'album', 'video.mp4'].entries()) {
    const database = path.join(isolated, 'workspace-' + index + '.sqlite');
    let store = await WorkspaceStore.open(database);
    try {
      const catalog = store.materials.index(
          await new FilesystemMaterialScanner().scan(root),
          randomUUID(),
        ),
        request = postRequest(store, catalog, { source: name });
      const intent = store.materials.reserve(request).intent;
      const hashes = async () =>
        Promise.all(
          intent.snapshot.files.map(async (file) => ({
            name: file.relativePath,
            sha256: createHash('sha256')
              .update(await readFile(path.join(root, file.relativePath)))
              .digest('hex'),
          })),
        );
      const before = await hashes();
      if (intent.snapshot.format !== 'text') {
        const upload = dispatchedPost(store, request, 'UPLOAD_MEDIA');
        store.materialPosts.verify(postReceipt(store, request, upload));
        deliverPostNotices(store, request.context.profileId);
      }
      const submit = dispatchedPost(store, request, 'SUBMIT');
      store.materialPosts.verify(postReceipt(store, request, submit));
      deliverPostNotices(store, request.context.profileId);
      const originalResult = store.materialPosts.result(request.attemptId),
        progress = store.tasks.steps(request.jobId)[0].progress;
      const planner = new FilesystemMaterialArchivePlanner();
      let revokedClaim = null;
      if (index === 2) {
        const claim = store.archivePreparation.claim(request.attemptId),
          beforeClose = store.archivePreparation.get(request.attemptId);
        store.close();
        store = await WorkspaceStore.open(database);
        assert.deepEqual(store.archivePreparation.get(request.attemptId), beforeClose);
        assert.equal(store.archivePreparation.recoverOnStartup(), 1);
        assert.throws(() => store.archivePreparation.assertCurrent(claim), /CLAIM_REVOKED/);
        revokedClaim = claim;
      }
      const saved = await new MaterialArchivePreparation(store.archivePreparation, planner).prepare(
        request.attemptId,
      );
      assert.equal(saved.state, 'READY');
      assert.ok(saved.plan);
      assert.equal(saved.plan.files.length, intent.snapshot.files.length);
      assert.equal(saved.plan.archiveRoot, null);
      await assert.rejects(lstat(saved.plan.destination), { code: 'ENOENT' });
      await assert.rejects(lstat(saved.plan.request.archiveDirectory), { code: 'ENOENT' });
      assert.deepEqual(await hashes(), before);
      assert.deepEqual(store.materialPosts.result(request.attemptId), originalResult);
      assert.deepEqual(store.tasks.steps(request.jobId)[0].progress, progress);
      store.close();
      store = await WorkspaceStore.open(database);
      assert.deepEqual(store.archivePreparation.get(request.attemptId), saved);
      assert.equal(store.archivePreparation.recoverOnStartup(), 0);
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
        assert.equal(db.prepare('SELECT state FROM material_archive_state').get().state, 'PENDING');
        assert.equal(db.prepare('SELECT count(*) AS n FROM material_archive_plans').get().n, 1);
      } finally {
        db.close();
      }
      cases.push({
        database,
        format: intent.snapshot.format,
        attemptId: request.attemptId,
        saved,
        revokedClaim,
        sourceHashes: before,
        sourceUnchanged: true,
        businessUnchanged: true,
        progressUnchanged: true,
        destinationAbsent: true,
        archiveStillPending: true,
      });
    } finally {
      store.close();
    }
  }
  const report = {
    state: 'PASSED',
    recordedAt: new Date().toISOString(),
    softwareVersion: '0.1.24',
    schema: 12,
    isolated,
    actualSourceVerification: true,
    actualArchiveMovement: false,
    destinationDirectoriesCreated: false,
    actualBrowserOperations: 0,
    actualSdkFileTransfer: false,
    actualFacebookPublication: false,
    userResourceDirectoriesRead: false,
    simulation: [
      'account identity',
      'task target',
      'auxiliary and publication observations',
      'notification receipts',
      'explicit software restart',
    ],
    cases,
  };
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      state: report.state,
      isolated,
      cases: cases.length,
      files: cases.reduce((n, row) => n + row.saved.plan.files.length, 0),
      actualArchiveMovement: false,
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
