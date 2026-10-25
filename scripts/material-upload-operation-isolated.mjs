import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceStore } from '../dist/src/infrastructure/workspace-store.js';
import { FilesystemMaterialScanner } from '../dist/src/infrastructure/material-scanner.js';
import { FilesystemMaterialSourceVerifier } from '../dist/src/infrastructure/material-source-verifier.js';
import { FilesystemMaterialUploadStage } from '../dist/src/infrastructure/material-upload-stage.js';
import { MaterialPostSourceCheck } from '../dist/src/application/material-source-check.js';
import { MaterialUploadOperationGuard } from '../dist/src/application/material-upload-guard.js';
import { MaterialUploadPreparation } from '../dist/src/application/material-upload-preparation.js';
import { guardNativeInput } from '../dist/src/application/native-input-gate.js';
import {
  postRequest,
  dispatchedPost,
  postAction,
  postReceipt,
} from '../dist/tests/fixtures/material-post.js';
const historical = JSON.parse(await readFile('audit/material-preflight-http-live.json', 'utf8'));
const directory = path.resolve(historical.directory),
  audit = path.resolve('audit');
if (
  !historical.generatedFixture ||
  historical.userResourceDirectoriesRead ||
  path.dirname(directory) !== audit ||
  !path.basename(directory).startsWith('material-preflight-fixture-')
)
  throw Error('GENERATED_FIXTURE_REQUIRED');
const isolated = await mkdtemp(path.join(audit, 'material-upload-operation-isolated-'));
const cases = [];
for (const [ordinal, source] of ['image.png', 'album', 'video.mp4'].entries()) {
  const database = path.join(isolated, 'workspace-' + ordinal + '.sqlite');
  let store = await WorkspaceStore.open(database);
  try {
    const catalog = store.materials.index(
      await new FilesystemMaterialScanner().scan(directory),
      randomUUID(),
    );
    const intent = store.materials.reserve(postRequest(store, catalog, { source })).intent;
    const operation = dispatchedPost(store, intent, 'UPLOAD_MEDIA');
    assert.ok(operation.binding);
    const hashes = async () =>
      await Promise.all(
        intent.snapshot.files.map(async (file) => ({
          file: file.relativePath,
          hash: createHash('sha256')
            .update(await readFile(path.join(directory, file.relativePath)))
            .digest('hex'),
        })),
      );
    const before = await hashes();
    const cacheRoot = path.join(isolated, 'cache-' + ordinal);
    const cache = new FilesystemMaterialUploadStage(cacheRoot);
    const sourceCheck = new MaterialPostSourceCheck(
      store.materials,
      store.materialPosts,
      store.taskTabs,
      new FilesystemMaterialSourceVerifier(),
    );
    const manifest = await new MaterialUploadPreparation(sourceCheck, cache).prepare(
      operation.binding,
      () => {},
    );
    const paths = await cache.verify(intent, operation.binding, manifest, () => {});
    const guard = new MaterialUploadOperationGuard(sourceCheck, cache).forOperation(
      operation.binding,
      manifest,
      () => {},
    );
    const command = {
      target: { tabId: intent.proof.tabId },
      method: 'DOM.setFileInputFiles',
      params: { files: paths },
    };
    if (paths.length) await guardNativeInput(command, () => {}, guard);
    else
      await assert.rejects(
        guardNativeInput(command, () => {}, guard),
        /UPLOAD_STAGE_FILES_MISMATCH/,
      );
    await assert.rejects(
      guardNativeInput(
        { ...command, params: { files: [path.join(directory, source)] } },
        () => {},
        guard,
      ),
      /UPLOAD_STAGE_FILES_MISMATCH/,
    );
    let active = true;
    await assert.rejects(
      guardNativeInput(
        { target: command.target, method: 'Input.dispatchMouseEvent', params: {} },
        () => {
          if (!active) throw Error('SIMULATED_ACTOR_REPLACED');
        },
        async () => {
          active = false;
        },
      ),
      /SIMULATED_ACTOR_REPLACED/,
    );
    assert.throws(
      () => store.materialPosts.prepare(postAction(store, intent)),
      /POST_MEDIA_UPLOAD_NOT_VERIFIED/,
    );
    const receipt = postReceipt(store, intent, operation);
    store.materialPosts.verify(receipt);
    assert.equal(store.tasks.steps(intent.jobId)[0].progress.published, 0);
    assert.equal(store.tasks.settlements.list(intent.context.profileId).length, 1);
    store.close();
    store = await WorkspaceStore.open(database);
    store.materialPosts.verify(receipt);
    assert.equal(store.tasks.settlements.list(intent.context.profileId).length, 1);
    assert.deepEqual(store.materials.reservation(intent.attemptId).intent, intent);
    assert.deepEqual(
      await new FilesystemMaterialUploadStage(cacheRoot).verify(
        intent,
        operation.binding,
        manifest,
        () => {},
      ),
      paths,
    );
    assert.equal(store.tasks.steps(intent.jobId)[0].progress.published, 0);
    assert.equal(store.materialPosts.result(intent.attemptId), null);
    assert.equal(store.materialPosts.archives().length, 0);
    assert.equal(store.materials.reservation(intent.attemptId).state, 'RESERVED');
    const after = await hashes();
    assert.deepEqual(after, before);
    cases.push({
      source,
      format: intent.snapshot.format,
      database,
      cacheRoot,
      manifest,
      stagedFiles: paths.length,
      sourceHashes: after,
      reopenPreserved: true,
      published: 0,
      archives: 0,
      reservationState: 'RESERVED',
      outboxState: store.tasks.operations(intent.jobId)[0].status,
      originalUploadPurpose: store.materialPosts.link(operation.binding.operationId).purpose,
      independentUploadObservation: 'simulated-only',
      auxiliaryVerifiedWithoutPublication: true,
      originalNotificationCount: 1,
      submitDeniedBeforeUploadVerified: true,
    });
  } finally {
    store.close();
  }
}
const report = {
  state: 'PASSED',
  recordedAt: new Date().toISOString(),
  softwareVersion: JSON.parse(await readFile('package.json', 'utf8')).version,
  isolated,
  directory,
  generatedFixture: true,
  simulatedTasksIdentitiesTargetsAndNativeCommands: true,
  userResourceDirectoriesRead: false,
  nativeBrowserOperations: 0,
  actualFacebookUploaded: false,
  actualFacebookPublished: false,
  userMaterialFilesMoved: false,
  generatedPrivateUploadCopiesCreated: true,
  productionEnabled: false,
  cases,
  checks: {
    allThreeMediaFormatsBoundStagedAndReopened: true,
    originalUploadPurposeAndBusinessGuard: true,
    independentMediaObservationWithoutPublication: true,
    notificationReopenIdempotent: true,
    submitRejectedBeforeVerifiedUpload: true,
    originalFilesUnchanged: true,
    sourcePathsDenied: true,
    revokedOwnerDenied: true,
    verificationDidNotPublishConsumeArchiveOrRelease: true,
  },
  limits: {
    stableInternalUploadActionImplemented: true,
    publicMaterialMutationApi: false,
    sessionFileGrantImplemented: false,
    actualBrowserValidation: false,
    localUserTamperSandbox: false,
    retentionCleanupNotImplemented: true,
  },
};
await writeFile(
  'audit/material-upload-operation-isolated.json',
  JSON.stringify(report, null, 2) + '\n',
  {
    flag: 'wx',
  },
);
console.log(
  JSON.stringify({
    state: report.state,
    isolated,
    stagedMediaFiles: cases.reduce((n, c) => n + c.stagedFiles, 0),
    nativeBrowserOperations: 0,
  }),
);
