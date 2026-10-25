import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceStore } from '../dist/src/infrastructure/workspace-store.js';
import { FilesystemMaterialScanner } from '../dist/src/infrastructure/material-scanner.js';
import { FilesystemMaterialSourceVerifier } from '../dist/src/infrastructure/material-source-verifier.js';
import { postRequest } from '../dist/tests/fixtures/material-post.js';

const historical = JSON.parse(await readFile('audit/material-preflight-http-live.json', 'utf8'));
const directory = path.resolve(historical.directory);
const audit = path.resolve('audit');
if (
  !historical.generatedFixture ||
  historical.userResourceDirectoriesRead ||
  path.dirname(directory) !== audit ||
  !path.basename(directory).startsWith('material-preflight-fixture-')
)
  throw Error('GENERATED_FIXTURE_REQUIRED');
const isolated = await mkdtemp(path.join(audit, 'material-source-isolated-'));
const verifier = new FilesystemMaterialSourceVerifier();
const cases = [];
for (const [ordinal, source] of ['text.txt', 'image.png', 'album', 'video.mp4'].entries()) {
  const file = path.join(isolated, 'workspace-' + ordinal + '.sqlite');
  let store = await WorkspaceStore.open(file);
  try {
    const catalog = store.materials.index(
      await new FilesystemMaterialScanner().scan(directory),
      randomUUID(),
    );
    const held = store.materials.reserve(postRequest(store, catalog, { source }));
    const hashes = async () =>
      await Promise.all(
        held.intent.snapshot.files.map(async (item) => ({
          file: item.relativePath,
          hash: createHash('sha256')
            .update(await readFile(path.join(directory, item.relativePath)))
            .digest('hex'),
        })),
      );
    const before = await hashes();
    const observation = await verifier.verify(held.intent, () => {});
    assert.equal(observation.fingerprint, held.intent.fingerprint);
    store.close();
    store = await WorkspaceStore.open(file);
    const original = store.materials.reservation(held.intent.attemptId);
    assert.equal(original.state, 'RESERVED');
    assert.deepEqual(original.intent, held.intent);
    const reopened = await verifier.verify(original.intent, () => {});
    assert.deepEqual(reopened.files, observation.files);
    assert.equal(store.tasks.steps(held.intent.jobId)[0].progress.published, 0);
    assert.equal(store.tasks.operations(held.intent.jobId).length, 0);
    assert.equal(store.materialPosts.archives().length, 0);
    assert.equal(store.materialPosts.result(held.intent.attemptId), null);
    const after = await hashes();
    assert.deepEqual(after, before);
    cases.push({
      source,
      format: original.intent.snapshot.format,
      database: file,
      attemptId: held.intent.attemptId,
      verifiedFiles: observation.files.length,
      observation,
      reopenedVerified: true,
      sourceHashes: after,
      published: 0,
      outbox: 0,
      archives: 0,
      reservationState: 'RESERVED',
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
  simulatedTasksIdentitiesAndTargets: true,
  userResourceDirectoriesRead: false,
  nativeBrowserOperations: 0,
  actualFacebookPublished: false,
  materialFilesMoved: false,
  productionEnabled: false,
  cases,
  checks: {
    allFourFormatsFullyReRead: true,
    originalIntentPreservedAfterReopen: true,
    sourceFilesUnchanged: true,
    verificationDidNotSettleOrRelease: true,
  },
  limits: {
    observationIsNotReusableInputPermit: true,
    nativeInputHookNotConnected: true,
    pathBasedUploadRaceNotClosed: true,
  },
};
await writeFile('audit/material-source-isolated.json', JSON.stringify(report, null, 2) + '\n', {
  flag: 'wx',
});
console.log(
  JSON.stringify({
    state: report.state,
    formats: cases.map((c) => c.format),
    isolated,
    nativeBrowserOperations: 0,
  }),
);
