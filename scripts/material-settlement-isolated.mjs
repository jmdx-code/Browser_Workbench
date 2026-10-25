import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../dist/src/infrastructure/workspace-store.js';
import { FilesystemMaterialScanner } from '../dist/src/infrastructure/material-scanner.js';
import {
  postRequest,
  dispatchedPost,
  postReceipt,
  deliverPostNotices,
} from '../dist/tests/fixtures/material-post.js';

const historical = JSON.parse(await readFile('audit/material-preflight-http-live.json', 'utf8')),
  directory = path.resolve(historical.directory),
  audit = path.resolve('audit');
if (
  !historical.generatedFixture ||
  historical.userResourceDirectoriesRead ||
  path.dirname(directory) !== audit ||
  !path.basename(directory).startsWith('material-preflight-fixture-')
)
  throw Error('GENERATED_FIXTURE_REQUIRED');
async function hashes(root) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw Error('FIXTURE_LINK_REJECTED');
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile())
        files.push({
          file: path.relative(root, file),
          hash: createHash('sha256')
            .update(await readFile(file))
            .digest('hex'),
        });
    }
  }
  await visit(root);
  return files.sort((a, b) => a.file.localeCompare(b.file));
}
const before = await hashes(directory),
  isolated = await mkdtemp(path.join(audit, 'material-settlement-isolated-')),
  file = path.join(isolated, 'workspace.sqlite');
let store = await WorkspaceStore.open(file);
const cases = [];
try {
  const catalog = store.materials.index(
    await new FilesystemMaterialScanner().scan(directory),
    randomUUID(),
  );
  for (const anchor of ['text.txt', 'image.png', 'album', 'video.mp4']) {
    const r = postRequest(store, catalog, { source: anchor });
    store.materials.reserve(r);
    const aux = dispatchedPost(store, r, 'OPEN_COMPOSER');
    store.materialPosts.verify(postReceipt(store, r, aux));
    deliverPostNotices(store, r.context.profileId);
    assert.equal(store.tasks.steps(r.jobId)[0].progress.published, 0);
    const submit = dispatchedPost(store, r),
      receipt = postReceipt(store, r, submit);
    store.tasks.acknowledgeBound({
      binding: submit.binding,
      evidence: { simulatedTransportAck: true },
    });
    assert.equal(store.tasks.steps(r.jobId)[0].progress.published, 0);
    if (anchor === 'text.txt') {
      store.tasks.markBoundUnknown(submit.binding, 'simulated-software-response-loss');
      assert.throws(
        () => store.materialPosts.verify(receipt),
        /POST_EXPLICIT_RECONCILIATION_REQUIRED/,
      );
      const stopped = store.tasks.requestControl(r.jobId, 'stop');
      assert.ok(stopped.controlRequestId);
      store.tasks.confirmControl(r.jobId, stopped.controlRequestId);
      assert.equal(store.tasks.get(r.jobId).state, 'REVIEW');
      store.materialPosts.reconcile(receipt);
    } else {
      store.materialPosts.verify(receipt);
      store.tasks.completeStep(r.jobId, r.stepId);
    }
    deliverPostNotices(store, r.context.profileId);
    store.materialPosts.verify(receipt);
    assert.equal(store.tasks.steps(r.jobId)[0].progress.published, 1);
    cases.push({
      anchor,
      format: store.materials.reservation(r.attemptId).intent.snapshot.format,
      attemptId: r.attemptId,
      jobId: r.jobId,
      simulatedPostId: receipt.evidence.postId,
      originalSubmitOperationId: receipt.binding.operationId,
      state: store.materials.reservation(r.attemptId).state,
      publishedCheckpoint: 1,
      receipt,
    });
  }
  assert.equal(store.materialPosts.archives().length, 4);
  store.close();
  store = await WorkspaceStore.open(file);
  for (const entry of cases) store.materialPosts.verify(entry.receipt);
  const db = new DatabaseSync(file, { readOnly: true });
  let facts;
  try {
    facts = {
      schema: db.prepare('PRAGMA user_version').get().user_version,
      ...Object.fromEntries(
        [
          'material_post_operations',
          'material_operation_verdicts',
          'material_attempt_verdicts',
          'material_publications',
          'material_archive_requests',
          'task_outbox',
          'task_settlement_notices',
        ].map((table) => [table, Number(db.prepare('SELECT count(*) AS n FROM ' + table).get().n)]),
      ),
      pendingArchives: Number(
        db.prepare("SELECT count(*) AS n FROM material_archive_state WHERE state='PENDING'").get()
          .n,
      ),
    };
  } finally {
    db.close();
  }
  assert.equal(facts.schema, 9);
  assert.equal(facts.material_publications, 4);
  assert.equal(facts.material_archive_requests, 4);
  assert.equal(facts.task_settlement_notices, 8);
  assert.equal(facts.pendingArchives, 4);
  const after = await hashes(directory);
  assert.deepEqual(after, before);
  const report = {
    state: 'PASSED',
    recordedAt: new Date().toISOString(),
    softwareVersion: JSON.parse(await readFile('package.json', 'utf8')).version,
    database: file,
    directory,
    generatedFixture: true,
    simulatedTasksIdentitiesTargetsAndBusinessEvidence: true,
    simulatedNativeStopConfirmation: true,
    simulatedNotificationReceipts: true,
    userResourceDirectoriesRead: false,
    nativeBrowserOperations: 0,
    actualFacebookPublished: false,
    materialFilesMoved: false,
    productionEnabled: false,
    facts,
    cases: cases.map(({ receipt: _receipt, ...entry }) => entry),
    checks: {
      allFourMaterialFormatsAssociated: true,
      ackDidNotPublish: true,
      auxiliaryDidNotPublish: true,
      unknownNormalReceiptRejected: true,
      explicitOriginalBindingReconciliation: true,
      publicationAndCheckpointAndNoticeAndArchiveCommitted: true,
      duplicateAndReopenDidNotRecount: true,
      archivesRemainPending: true,
      sourceFilesUnchanged: true,
    },
    hashes: after,
  };
  await writeFile(
    'audit/material-settlement-isolated.json',
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log(
    JSON.stringify({
      state: report.state,
      facts,
      database: file,
      actualFacebookPublished: false,
      materialFilesMoved: false,
    }),
  );
} finally {
  store.close();
}
