import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { WorkspaceStore } from '../dist/src/infrastructure/workspace-store.js';
import { FilesystemMaterialScanner } from '../dist/src/infrastructure/material-scanner.js';
import { FilesystemMaterialSourceVerifier } from '../dist/src/infrastructure/material-source-verifier.js';
import { FilesystemMaterialUploadStage } from '../dist/src/infrastructure/material-upload-stage.js';
import { MaterialPostSourceCheck } from '../dist/src/application/material-source-check.js';
import { MaterialUploadPreparation } from '../dist/src/application/material-upload-preparation.js';
import { MaterialFileGrantPreparation } from '../dist/src/application/material-file-grant-preparation.js';
import { KernelExecutor } from '../dist/src/application/kernel-executor.js';
import { KernelLease } from '../dist/src/domain/kernel-lease.js';
import { postRequest, dispatchedPost } from '../dist/tests/fixtures/material-post.js';

const historical = JSON.parse(await readFile('audit/material-preflight-http-live.json', 'utf8'));
const directory = path.resolve(historical.directory),
  audit = path.resolve('audit');
assert.equal(historical.generatedFixture, true);
assert.equal(historical.userResourceDirectoriesRead, false);
assert.equal(path.dirname(directory), audit);
assert.ok(path.basename(directory).startsWith('material-preflight-fixture-'));
const isolated = await mkdtemp(path.join(audit, 'operation-files-isolated-')),
  cases = [];
for (const [ordinal, source] of ['image.png', 'album', 'video.mp4'].entries()) {
  const database = path.join(isolated, `workspace-${ordinal}.sqlite`);
  const store = await WorkspaceStore.open(database);
  try {
    const catalog = store.materials.index(
      await new FilesystemMaterialScanner().scan(directory),
      randomUUID(),
    );
    const intent = store.materials.reserve(postRequest(store, catalog, { source })).intent;
    const operation = dispatchedPost(store, intent, 'UPLOAD_MEDIA');
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
    const cache = new FilesystemMaterialUploadStage(path.join(isolated, `cache-${ordinal}`));
    const check = new MaterialPostSourceCheck(
      store.materials,
      store.materialPosts,
      store.taskTabs,
      new FilesystemMaterialSourceVerifier(),
    );
    const manifest = await new MaterialUploadPreparation(check, cache).prepare(
      operation.binding,
      () => {},
    );
    const grant = await new MaterialFileGrantPreparation(check, cache).prepare(
      operation.binding,
      manifest,
      () => {},
    );
    const commands = [];
    const backend = {
      scope: async () => {},
      attach: async () => ({
        targetId: intent.proof.targetId,
        type: 'page',
        title: 'Simulated native target',
        url: 'http://127.0.0.1:18767/kernel-fixture',
        attached: true,
      }),
      detach: async () => {},
      create: async () => ({ tabId: intent.proof.tabId }),
      remove: async () => {},
      send: async (target, method, params) => {
        commands.push({ target, method, params });
        return {};
      },
    };
    const executor = new KernelExecutor(
      new KernelLease(operation.binding.profileId, operation.binding.connectionEpoch),
      backend,
      [intent.proof.tabId],
    );
    const { profileId, connectionEpoch, leaseId, generation } = operation.binding;
    executor.grant({
      profileId,
      connectionEpoch,
      leaseId,
      generation,
      expiresAt: Date.now() + 10_000,
    });
    await executor.attach(intent.proof.tabId);
    await executor.grantFiles(grant, () => check.currentUpload(operation.binding, () => {}));
    await executor.send({ tabId: intent.proof.tabId }, 'DOM.setFileInputFiles', {
      files: grant.files,
      backendNodeId: 1,
    });
    executor.revokeFiles();
    await assert.rejects(
      executor.send({ tabId: intent.proof.tabId }, 'DOM.setFileInputFiles', {
        files: grant.files,
        backendNodeId: 1,
      }),
      /REVOKED/,
    );
    await assert.rejects(
      executor.grantFiles(grant, () => {}),
      /REVOKED/,
    );
    assert.equal(commands.length, 1);
    assert.equal((await executor.stop(randomUUID())).state, 'stopped');
    assert.deepEqual(await hashes(), before);
    assert.equal(store.materialPosts.result(intent.attemptId), null);
    assert.equal(store.materials.reservation(intent.attemptId).state, 'RESERVED');
    assert.equal(store.tasks.operations(intent.jobId)[0]?.status, 'DISPATCHING');
    cases.push({
      source,
      database,
      grant,
      simulatedCommands: commands,
      originalHashes: before,
      sourceUnchanged: true,
      lateUploadRejected: true,
      grantResurrectionRejected: true,
      businessVerified: false,
    });
  } finally {
    store.close();
  }
  const reopened = await WorkspaceStore.open(database);
  try {
    assert.equal(
      reopened.tasks.operations(cases.at(-1).grant.binding.jobId)[0]?.status,
      'DISPATCHING',
    );
  } finally {
    reopened.close();
  }
}
await writeFile(
  'audit/operation-files-isolated.json',
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      softwareVersion: '0.1.20',
      state: 'PASSED',
      isolated,
      generatedFixture: true,
      userResourceDirectoriesRead: false,
      nativeBackendSimulated: true,
      actualBrowserOperations: 0,
      actualSdkFileTransfer: false,
      actualFacebookUploaded: false,
      actualFacebookPublished: false,
      materialsMoved: false,
      cases,
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
console.log(
  JSON.stringify({
    state: 'PASSED',
    isolated,
    mediaFormats: cases.length,
    actualBrowserOperations: 0,
  }),
);
