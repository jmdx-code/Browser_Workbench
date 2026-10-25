import test from 'node:test';
import { directoryIntent } from './fixtures/material-post.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Action, isWrite, canonicalAction } from '../src/shared/browser-actions.js';
import { Core } from '../src/bridge/core.js';
import { Store } from '../src/bridge/store.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { FilesystemMaterialScanner } from '../src/infrastructure/material-scanner.js';
import { FilesystemMaterialSourceVerifier } from '../src/infrastructure/material-source-verifier.js';
import { FilesystemMaterialUploadStage } from '../src/infrastructure/material-upload-stage.js';
import { MaterialPostSourceCheck } from '../src/application/material-source-check.js';
import { MaterialUploadPreparation } from '../src/application/material-upload-preparation.js';
import { MaterialUploadOperationGuard } from '../src/application/material-upload-guard.js';
import { MaterialFileGrantPreparation } from '../src/application/material-file-grant-preparation.js';
import { assertFileGrantActionDigest } from '../src/shared/kernel-file-grant.js';
import { guardNativeInput } from '../src/application/native-input-gate.js';
import { PostReceipt } from '../src/shared/material-post.js';
import type { ReservationRequest, Catalog } from '../src/shared/material-index.js';
import {
  postFixture,
  postRequest,
  postAction,
  dispatchedPost,
  postReceipt,
  deliverPostNotices,
} from './fixtures/material-post.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
  'base64',
);
const noop = () => {};
async function mediaFixture(
  work: (
    store: WorkspaceStore,
    file: string,
    request: ReservationRequest,
    catalog: Catalog,
  ) => Promise<void> | void,
  source = 'image.png',
) {
  await postFixture(async (store, file, initial) => {
    await writeFile(path.join(initial.directory, 'image.png'), png);
    await mkdir(path.join(initial.directory, 'album'));
    await writeFile(path.join(initial.directory, 'album', 'a.png'), png);
    await writeFile(path.join(initial.directory, 'album', 'b.png'), png);
    await writeFile(path.join(initial.directory, 'video.mp4'), await readFile('public/sample.mp4'));
    const catalog = await store.materials.index(
      await new FilesystemMaterialScanner().scan(initial.directory),
      randomUUID(),
    );
    const request = await postRequest(store, catalog, { source });
    await store.materials.reserve(request);
    await work(store, file, request, catalog);
  });
}
const sourceCheck = (store: WorkspaceStore) =>
  new MaterialPostSourceCheck(
    store.materials,
    store.materialPosts,
    store.taskTabs,
    new FilesystemMaterialSourceVerifier(),
  );

test('file grant preparation derives verified staged paths from original upload for all three media formats', async () => {
  for (const source of ['image.png', 'album', 'video.mp4'])
    await mediaFixture(async (store, file, request) => {
      const original = await dispatchedPost(store, request, 'UPLOAD_MEDIA');
      const check = sourceCheck(store);
      const cache = new FilesystemMaterialUploadStage(path.join(path.dirname(file), 'grant-cache'));
      const manifest = await new MaterialUploadPreparation(check, cache).prepare(
        original.binding,
        noop,
      );
      const grant = await new MaterialFileGrantPreparation(check, cache).prepare(
        original.binding,
        manifest,
        noop,
      );
      assert.deepEqual(grant.binding, original.binding);
      assert.deepEqual(
        grant.proof,
        (await store.materials.reservation(request.attemptId)).intent.proof,
      );
      await assertFileGrantActionDigest(grant);
      const intent = (await store.materials.reservation(request.attemptId)).intent;
      assert.deepEqual(grant.files, await cache.verify(intent, original.binding, manifest, noop));
      for (const [index, staged] of grant.files.entries()) {
        const member = manifest.files[index];
        assert.ok(member);
        assert.deepEqual(
          await readFile(staged),
          await readFile(
            path.join(
              directoryIntent(store, request.attemptId).directory,
              member.original.relativePath,
            ),
          ),
        );
      }
      assert.equal(await store.materialPosts.result(request.attemptId), null);
      assert.equal((await store.tasks.operations(request.jobId))[0]?.status, 'DISPATCHING');
    }, source);
});

test('file grant preparation rechecks actor after cache verification and cannot grant an obsolete operation', async () => {
  await mediaFixture(async (store, file, request) => {
    const original = await dispatchedPost(store, request, 'UPLOAD_MEDIA');
    const check = sourceCheck(store);
    const cache = new FilesystemMaterialUploadStage(path.join(path.dirname(file), 'grant-cache'));
    const manifest = await new MaterialUploadPreparation(check, cache).prepare(
      original.binding,
      noop,
    );
    let current = true;
    const preparation = new MaterialFileGrantPreparation(check, {
      verify: async (intent, binding, stage, fence) => {
        const files = await cache.verify(intent, binding, stage, fence);
        current = false;
        return files;
      },
    });
    await assert.rejects(
      preparation.prepare(original.binding, manifest, () => {
        if (!current) throw Error('ACTOR_CHANGED');
      }),
      /ACTOR_CHANGED/,
    );
    await assert.rejects(
      new MaterialFileGrantPreparation(check, cache).prepare(
        { ...original.binding, operationId: randomUUID() },
        manifest,
        noop,
      ),
    );
    assert.equal(await store.materialPosts.result(request.attemptId), null);
  });
});

test('stable upload action is a write but contains no paths; legacy bridge rejects it before queuing', async () => {
  await mediaFixture(async (store, _file, request) => {
    const action = (await postAction(store, request, 'UPLOAD_MEDIA')).action;
    assert.equal(isWrite(action), true);
    assert.equal(Action.parse(action).kind, 'uploadMedia');
    assert.equal(canonicalAction(action).includes('files'), false);
    assert.throws(() => Action.parse({ ...action, files: ['C:/private/source.png'] }));
    assert.throws(() => Action.parse({ ...action, stageId: randomUUID() }));
    const journal = new Store(':memory:'),
      core = new Core(journal);
    try {
      await assert.rejects(
        async () =>
          await core.submit({
            profileId: request.context.profileId,
            operationId: randomUUID(),
            action,
          }),
        /SDK_BOUND_UPLOAD_REQUIRED/,
      );
      assert.equal(journal.unresolved(request.context.profileId).length, 0);
    } finally {
      await core.shutdown();
      journal.close();
    }
  });
});
test('all three media formats persist the original upload purpose and immutable binding after reopen', async () => {
  for (const source of ['image.png', 'album', 'video.mp4'])
    await mediaFixture(async (store, file, request) => {
      const original = await dispatchedPost(store, request, 'UPLOAD_MEDIA');
      const operation = (await store.tasks.operations(request.jobId))[0];
      assert.equal(operation?.action.kind, 'uploadMedia');
      const reopened = await WorkspaceStore.open(file);
      try {
        assert.deepEqual(
          reopened.materialPosts.link(original.binding.operationId),
          await store.materialPosts.link(original.binding.operationId),
        );
        assert.deepEqual(reopened.tasks.operations(request.jobId)[0]?.binding, original.binding);
        assert.equal(reopened.materials.reservation(request.attemptId).state, 'RESERVED');
        assert.equal(reopened.materialPosts.result(request.attemptId), null);
      } finally {
        reopened.close();
      }
    }, source);
});
test('upload purpose rejects click, wrong attempt, content or target and cannot masquerade as a prepare click', async () => {
  await mediaFixture(async (store, _file, request) => {
    const prepared = await postAction(store, request, 'UPLOAD_MEDIA');
    assert.equal(prepared.action.kind, 'uploadMedia');
    if (prepared.action.kind !== 'uploadMedia') throw Error('FIXTURE_ACTION');
    const wrong = [
      { ...prepared.action, attemptId: randomUUID() },
      { ...prepared.action, fingerprint: '0'.repeat(64) },
      { ...prepared.action, tabId: 43 },
      { ...prepared.action, kind: 'click', attemptId: undefined, fingerprint: undefined },
    ];
    for (const action of wrong)
      await assert.rejects(
        async () =>
          await store.materialPosts.prepare({ ...prepared, action: Action.parse(action) }),
      );
    await assert.rejects(
      async () => await store.materialPosts.prepare({ ...prepared, purpose: 'PREPARE_MEDIA' }),
      /POST_ACTION_PURPOSE_INVALID/,
    );
    assert.equal((await store.tasks.operations(request.jobId)).length, 0);
  });
});
test('text packages cannot prepare a media upload operation', async () => {
  await postFixture(async (store, _file, catalog) => {
    const request = await postRequest(store, catalog);
    await store.materials.reserve(request);
    await assert.rejects(
      async () =>
        await store.materialPosts.prepare(await postAction(store, request, 'UPLOAD_MEDIA')),
      /POST_MEDIA_REQUIRED/,
    );
    assert.equal((await store.tasks.operations(request.jobId)).length, 0);
  });
});
test('application upload preparation rejects composer clicks before invoking cache', async () => {
  await mediaFixture(async (store, _file, request) => {
    const operation = await dispatchedPost(store, request, 'OPEN_COMPOSER');
    let writes = 0;
    const preparation = new MaterialUploadPreparation(sourceCheck(store), {
      async stage() {
        writes++;
        throw Error('UNEXPECTED_CACHE');
      },
    });
    await assert.rejects(
      preparation.prepare(operation.binding, noop),
      /UPLOAD_OPERATION_PURPOSE_REQUIRED/,
    );
    assert.equal(writes, 0);
    assert.equal(await store.materialPosts.result(request.attemptId), null);
  });
});
test('business upload guard rejects an old composer-bound manifest before resource guard creation', async () => {
  await mediaFixture(async (store, file, request) => {
    const operation = await dispatchedPost(store, request, 'OPEN_COMPOSER');
    const cache = new FilesystemMaterialUploadStage(path.join(path.dirname(file), 'cache'));
    const manifest = await cache.stage(
      (await store.materials.reservation(request.attemptId)).intent,
      operation.binding,
      noop,
    );
    let inspections = 0;
    const guard = new MaterialUploadOperationGuard(sourceCheck(store), {
      guard() {
        inspections++;
        throw Error('UNEXPECTED_RESOURCE_GUARD');
      },
    });
    await assert.rejects(
      async () => await guard.forOperation(operation.binding, manifest, noop),
      /UPLOAD_OPERATION_PURPOSE_REQUIRED/,
    );
    assert.equal(inspections, 0);
  });
});
test('business guard rechecks original upload and stops input after async actor revocation or task stop', async () => {
  await mediaFixture(async (store, file, request) => {
    const operation = await dispatchedPost(store, request, 'UPLOAD_MEDIA');
    const cache = new FilesystemMaterialUploadStage(path.join(path.dirname(file), 'cache'));
    const check = sourceCheck(store),
      preparation = new MaterialUploadPreparation(check, cache);
    const manifest = await preparation.prepare(operation.binding, noop);
    const files = await cache.verify(
      (await store.materials.reservation(request.attemptId)).intent,
      operation.binding,
      manifest,
      noop,
    );
    const command = { target: { tabId: 42 }, method: 'DOM.setFileInputFiles', params: { files } };
    let active = true,
      sends = 0;
    const current = () => {
      if (!active) throw Error('ACTOR_REVOKED');
    };
    const gate = await new MaterialUploadOperationGuard(check, {
      guard(...args) {
        const inspect = cache.guard(...args);
        return async (value) => {
          await inspect(value);
          active = false;
        };
      },
    }).forOperation(operation.binding, manifest, current);
    await assert.rejects(async () => {
      await guardNativeInput(command, current, gate);
      sends++;
    }, /ACTOR_REVOKED/);
    assert.equal(sends, 0);
    active = true;
    const actualGuard = await new MaterialUploadOperationGuard(check, cache).forOperation(
      operation.binding,
      manifest,
      current,
    );
    await assert.rejects(
      async () =>
        await new MaterialUploadOperationGuard(check, cache).forOperation(
          { ...operation.binding, operationId: randomUUID() },
          manifest,
          current,
        ),
      /UPLOAD_GUARD_BINDING_MISMATCH/,
    );
    await store.tasks.requestControl(request.jobId, 'stop');
    await assert.rejects(
      guardNativeInput(command, current, actualGuard),
      /MATERIAL_SOURCE_RESERVATION_NOT_READY/,
    );
    assert.equal((await store.materials.reservation(request.attemptId)).state, 'REVIEW');
    assert.equal(await store.materialPosts.result(request.attemptId), null);
  });
});
test('media Next and Submit need independent ready upload evidence; ACK, wrong count or format do not settle', async () => {
  await mediaFixture(async (store, file, request) => {
    for (const purpose of ['SUBMIT', 'ADVANCE_COMPOSER'] as const)
      await assert.rejects(
        async () => await store.materialPosts.prepare(await postAction(store, request, purpose)),
        /POST_MEDIA_UPLOAD_NOT_VERIFIED/,
      );
    const operation = await dispatchedPost(store, request, 'UPLOAD_MEDIA');
    await store.tasks.acknowledgeBound({
      binding: operation.binding,
      evidence: { inputReturned: true },
    });
    for (const purpose of ['SUBMIT', 'ADVANCE_COMPOSER'] as const)
      await assert.rejects(
        async () => await store.materialPosts.prepare(await postAction(store, request, purpose)),
      );
    const receipt = await postReceipt(store, request, operation);
    assert.ok(receipt.evidence.media);
    assert.throws(
      () => PostReceipt.parse({ ...receipt, evidence: { ...receipt.evidence, media: undefined } }),
      /POST_MEDIA_OBSERVATION_REQUIRED/,
    );
    assert.throws(
      () =>
        PostReceipt.parse({
          ...receipt,
          evidence: { ...receipt.evidence, basis: 'composer-effect-observed' },
        }),
      /POST_EVIDENCE_BASIS_INVALID/,
    );
    assert.throws(() =>
      PostReceipt.parse({
        ...receipt,
        evidence: { ...receipt.evidence, media: { ...receipt.evidence.media, ready: false } },
      }),
    );
    for (const media of [
      { ...receipt.evidence.media, count: 2 },
      { ...receipt.evidence.media, format: 'video' as const },
    ])
      await assert.rejects(
        async () =>
          await store.materialPosts.verify({
            ...receipt,
            evidence: { ...receipt.evidence, media },
          }),
        /POST_MEDIA_OBSERVATION_MISMATCH/,
      );
    assert.equal((await store.tasks.operations(request.jobId))[0]?.status, 'ACKNOWLEDGED');
    assert.equal((await store.materialPosts.archives()).length, 0);
    await store.materialPosts.verify(receipt);
    await store.materialPosts.verify(receipt);
    assert.equal((await store.tasks.steps(request.jobId))[0]?.progress.published, 0);
    assert.equal((await store.materials.reservation(request.attemptId)).state, 'RESERVED');
    assert.equal(await store.materialPosts.result(request.attemptId), null);
    const reopened = await WorkspaceStore.open(file);
    try {
      reopened.materialPosts.verify(receipt);
      assert.equal(reopened.tasks.settlements.list(request.context.profileId).length, 1);
    } finally {
      reopened.close();
    }
    await deliverPostNotices(store, request.context.profileId);
    await assert.rejects(
      async () =>
        await store.materialPosts.prepare(await postAction(store, request, 'UPLOAD_MEDIA')),
      /POST_MEDIA_ALREADY_UPLOADED/,
    );
    assert.equal(
      (await store.materialPosts.prepare(await postAction(store, request))).status,
      'PREPARED',
    );
  });
});
test('unknown media upload cannot accept late ordinary evidence or replay; original reconciliation retains material', async () => {
  await mediaFixture(async (store, _file, request) => {
    const operation = await dispatchedPost(store, request, 'UPLOAD_MEDIA');
    await store.tasks.markBoundUnknown(operation.binding, 'UPLOAD_RESULT_UNKNOWN');
    const receipt = await postReceipt(store, request, operation);
    await assert.rejects(
      async () => await store.materialPosts.verify(receipt),
      /POST_EXPLICIT_RECONCILIATION_REQUIRED/,
    );
    await assert.rejects(
      async () =>
        await store.materialPosts.prepare(await postAction(store, request, 'UPLOAD_MEDIA')),
    );
    await store.materialPosts.reconcile(receipt);
    assert.equal((await store.tasks.operations(request.jobId))[0]?.status, 'VERIFIED');
    assert.equal((await store.materials.reservation(request.attemptId)).state, 'REVIEW');
    assert.equal((await store.tasks.steps(request.jobId))[0]?.progress.published, 0);
    assert.equal(await store.materialPosts.result(request.attemptId), null);
  });
});
test('verified not-applied upload allows a later explicit new operation but never resends the old binding', async () => {
  await mediaFixture(async (store, _file, request) => {
    const operation = await dispatchedPost(store, request, 'UPLOAD_MEDIA');
    await store.materialPosts.verify(await postReceipt(store, request, operation, 'NOT_APPLIED'));
    await assert.rejects(
      async () => await store.materialPosts.prepare(await postAction(store, request)),
    );
    await deliverPostNotices(store, request.context.profileId);
    const next = await dispatchedPost(store, request, 'UPLOAD_MEDIA');
    assert.notEqual(next.binding.operationId, operation.binding.operationId);
    assert.equal((await store.tasks.operations(request.jobId))[0]?.status, 'FAILED');
    assert.equal((await store.tasks.operations(request.jobId))[1]?.status, 'DISPATCHING');
  });
});
