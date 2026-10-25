import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, chmod, rename, symlink } from 'node:fs/promises';
import path from 'node:path';
import { FilesystemMaterialUploadStage } from '../src/infrastructure/material-upload-stage.js';
import { FilesystemMaterialScanner } from '../src/infrastructure/material-scanner.js';
import { postFixture, postRequest, dispatchedPost } from './fixtures/material-post.js';
import type { PostIntent } from '../src/shared/material-index.js';
import type { Binding } from '../src/shared/task-execution.js';
import type { UploadManifest } from '../src/shared/material-upload.js';
import { guardNativeInput } from '../src/application/native-input-gate.js';
import { MaterialPostSourceCheck } from '../src/application/material-source-check.js';
import { MaterialUploadPreparation } from '../src/application/material-upload-preparation.js';
import { FilesystemMaterialSourceVerifier } from '../src/infrastructure/material-source-verifier.js';
const noop = () => {};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
  'base64',
);
async function uploadFixture(
  work: (f: {
    intent: PostIntent;
    binding: Binding;
    cache: FilesystemMaterialUploadStage;
    cacheRoot: string;
    resourceRoot: string;
    manifest: UploadManifest;
  }) => Promise<void>,
  source = 'image.png',
) {
  await postFixture(async (store, file, catalog) => {
    const root = catalog.directory;
    await writeFile(path.join(root, 'image.png'), png);
    await writeFile(path.join(root, 'image.txt'), 'single');
    await mkdir(path.join(root, 'album'));
    await writeFile(path.join(root, 'album', '1.png'), png);
    await writeFile(path.join(root, 'album', '2.png'), png);
    await writeFile(path.join(root, 'album', '正文.txt'), 'album');
    await writeFile(path.join(root, 'video.mp4'), await readFile('public/sample.mp4'));
    const current = await store.materials.index(
      await new FilesystemMaterialScanner().scan(root),
      randomUUID(),
    );
    const intent = (await store.materials.reserve(await postRequest(store, current, { source })))
      .intent;
    const op = await dispatchedPost(store, intent, 'OPEN_COMPOSER');
    assert.ok(op.binding);
    const cacheRoot = path.join(path.dirname(file), 'upload-cache');
    const cache = new FilesystemMaterialUploadStage(cacheRoot);
    const manifest = await cache.stage(intent, op.binding, noop);
    await work({ intent, binding: op.binding, cache, cacheRoot, resourceRoot: root, manifest });
    assert.equal((await store.tasks.steps(intent.jobId))[0]?.progress.published, 0);
    assert.equal((await store.materials.reservation(intent.attemptId)).state, 'RESERVED');
    assert.equal(await store.materialPosts.result(intent.attemptId), null);
  });
}

test('upload staging copies only original media from verified stream in all four formats and reopens exact manifest', async () => {
  for (const source of ['text.txt', 'image.png', 'album', 'video.mp4'])
    await uploadFixture(async (f) => {
      const files = await f.cache.verify(f.intent, f.binding, f.manifest, noop);
      assert.equal(
        files.length,
        f.intent.snapshot.files.filter((item) => item.role !== 'text').length,
      );
      const originals = f.intent.snapshot.files.filter((item) => item.role !== 'text');
      for (const [index, file] of files.entries()) {
        const original = originals[index];
        assert.ok(original);
        assert.deepEqual(
          await readFile(file),
          await readFile(path.join(f.resourceRoot, original.relativePath)),
        );
        assert.equal(path.dirname(path.dirname(file)), f.cacheRoot);
      }
      const reopened = new FilesystemMaterialUploadStage(f.cacheRoot);
      assert.deepEqual(await reopened.verify(f.intent, f.binding, f.manifest, noop), files);
    }, source);
});
test('upload stage remains the original byte content when resource source is subsequently edited', async () => {
  await uploadFixture(async (f) => {
    const before = await f.cache.verify(f.intent, f.binding, f.manifest, noop);
    await writeFile(path.join(f.resourceRoot, 'image.png'), 'source edited after staging');
    const after = await f.cache.verify(f.intent, f.binding, f.manifest, noop);
    assert.deepEqual(after, before);
    assert.deepEqual(await readFile(after[0] ?? ''), png);
  });
});
test('stage file modifications are rejected even though original resource is unchanged', async () => {
  await uploadFixture(async (f) => {
    const files = await f.cache.verify(f.intent, f.binding, f.manifest, noop);
    const file = files[0];
    assert.ok(file);
    await chmod(file, 0o600);
    await writeFile(file, 'modified');
    await assert.rejects(
      f.cache.verify(f.intent, f.binding, f.manifest, noop),
      /UPLOAD_STAGE_FILE_CHANGED/,
    );
  });
});
test('stage proof cannot be rebound to another operation, lease or attempt', async () => {
  await uploadFixture(async (f) => {
    await assert.rejects(
      f.cache.verify(f.intent, { ...f.binding, operationId: randomUUID() }, f.manifest, noop),
      /UPLOAD_STAGE_MANIFEST_MISMATCH/,
    );
    await assert.rejects(
      f.cache.verify(f.intent, { ...f.binding, leaseId: randomUUID() }, f.manifest, noop),
      /UPLOAD_STAGE_BINDING_MISMATCH/,
    );
    await assert.rejects(
      f.cache.verify({ ...f.intent, attemptId: randomUUID() }, f.binding, f.manifest, noop),
      /UPLOAD_STAGE_MANIFEST_MISMATCH/,
    );
  });
});
test('changing ready manifest or media order cannot rewrite the accepted stage', async () => {
  await uploadFixture(async (f) => {
    const ready = path.join(f.cacheRoot, f.manifest.stageId, 'ready.json');
    await chmod(ready, 0o600);
    await writeFile(
      ready,
      JSON.stringify({ ...f.manifest, createdAt: '2026-01-01T00:00:00.000Z' }),
    );
    await assert.rejects(
      f.cache.verify(f.intent, f.binding, f.manifest, noop),
      /UPLOAD_STAGE_MANIFEST_CHANGED/,
    );
  });
  await uploadFixture(async (f) => {
    const reversed = { ...f.manifest, files: [...f.manifest.files].reverse() };
    await assert.rejects(
      f.cache.verify(f.intent, f.binding, reversed, noop),
      /UPLOAD_STAGE_MANIFEST_MISMATCH/,
    );
  }, 'album');
});
test('stage folder junction replacement is rejected before reading ready manifest outside cache', async () => {
  await uploadFixture(async (f) => {
    const folder = path.join(f.cacheRoot, f.manifest.stageId),
      outside = path.join(path.dirname(f.cacheRoot), 'outside-stage');
    await rename(folder, outside);
    await symlink(outside, folder, 'junction');
    await assert.rejects(
      f.cache.verify(f.intent, f.binding, f.manifest, noop),
      /UPLOAD_STAGE_FOLDER_CHANGED/,
    );
  });
});
test('stage failure cleans only its own files and never mutates source or settlement', async () => {
  await uploadFixture(async (f) => {
    await writeFile(path.join(f.resourceRoot, 'image.png'), 'changed');
    const before = await readdir(f.cacheRoot);
    await assert.rejects(f.cache.stage(f.intent, f.binding, noop), /MATERIAL_SOURCE_FILE_CHANGED/);
    assert.deepEqual(await readdir(f.cacheRoot), before);
    assert.equal(await readFile(path.join(f.resourceRoot, 'image.png'), 'utf8'), 'changed');
  });
});
test('stage capacity limits and concurrent calls fail without bypassing bounds or publishing', async () => {
  await uploadFixture(async (f) => {
    const small = new FilesystemMaterialUploadStage(f.cacheRoot, {
      totalBytes: 1,
      reserveBytes: 0,
      milliseconds: 30000,
    });
    await assert.rejects(small.stage(f.intent, f.binding, noop), /UPLOAD_STAGE_BUDGET/);
    const noSpace = new FilesystemMaterialUploadStage(f.cacheRoot, {
      totalBytes: 1024,
      reserveBytes: Number.MAX_SAFE_INTEGER,
      milliseconds: 30000,
    });
    await assert.rejects(noSpace.stage(f.intent, f.binding, noop), /UPLOAD_STAGE_NO_SPACE/);
    const staging = f.cache.stage(f.intent, f.binding, noop);
    await assert.rejects(f.cache.stage(f.intent, f.binding, noop), /UPLOAD_STAGE_BUSY/);
    await staging;
  });
});
test('upload cache cannot overlap original resource directories or write inside their packages', async () => {
  await uploadFixture(async (f) => {
    const originalNames = await readdir(f.resourceRoot);
    for (const directory of [
      f.resourceRoot,
      path.join(f.resourceRoot, 'cache'),
      path.dirname(f.resourceRoot),
    ]) {
      await assert.rejects(
        new FilesystemMaterialUploadStage(directory).stage(f.intent, f.binding, noop),
        /UPLOAD_STAGE_RESOURCE_OVERLAP/,
      );
    }
    assert.deepEqual(await readdir(f.resourceRoot), originalNames);
  });
});
test('native file resource guard permits only exact ordered staged files and original tab', async () => {
  await uploadFixture(async (f) => {
    const files = await f.cache.verify(f.intent, f.binding, f.manifest, noop);
    const guard = f.cache.guard(f.intent, f.binding, f.manifest, noop);
    await guardNativeInput(
      {
        target: { tabId: f.intent.proof.tabId },
        method: 'DOM.setFileInputFiles',
        params: { files },
      },
      noop,
      guard,
    );
    await assert.rejects(
      guardNativeInput(
        {
          target: { tabId: f.intent.proof.tabId },
          method: 'DOM.setFileInputFiles',
          params: { files: [path.join(f.resourceRoot, 'image.png')] },
        },
        noop,
        guard,
      ),
      /UPLOAD_STAGE_FILES_MISMATCH/,
    );
    await assert.rejects(
      guardNativeInput(
        {
          target: { tabId: f.intent.proof.tabId + 1 },
          method: 'Input.dispatchMouseEvent',
          params: {},
        },
        noop,
        guard,
      ),
      /UPLOAD_STAGE_TARGET_MISMATCH/,
    );
  });
});
test('empty text stage cannot authorize file upload and revoked actor blocks ready stage', async () => {
  await uploadFixture(async (f) => {
    await assert.rejects(
      guardNativeInput(
        {
          target: { tabId: f.intent.proof.tabId },
          method: 'DOM.setFileInputFiles',
          params: { files: [] },
        },
        noop,
        f.cache.guard(f.intent, f.binding, f.manifest, noop),
      ),
      /UPLOAD_STAGE_FILES_MISMATCH/,
    );
  }, 'text.txt');
  await uploadFixture(async (f) => {
    await assert.rejects(
      f.cache.verify(f.intent, f.binding, f.manifest, () => {
        throw Error('ACTOR_REVOKED');
      }),
      /ACTOR_REVOKED/,
    );
  });
});
test('application stage preparation uses current original outbox and rejects stopped plan before creating cache', async () => {
  await postFixture(async (store, file, catalog) => {
    await writeFile(path.join(catalog.directory, 'image.png'), png);
    const current = await store.materials.index(
      await new FilesystemMaterialScanner().scan(catalog.directory),
      randomUUID(),
    );
    const held = await store.materials.reserve(
      await postRequest(store, current, { source: 'image.png' }),
    );
    const operation = await dispatchedPost(store, held.intent, 'UPLOAD_MEDIA');
    assert.ok(operation.binding);
    const root = path.join(path.dirname(file), 'application-cache');
    const source = new MaterialPostSourceCheck(
      store.materials,
      store.materialPosts,
      store.taskTabs,
      new FilesystemMaterialSourceVerifier(),
    );
    const preparation = new MaterialUploadPreparation(
      source,
      new FilesystemMaterialUploadStage(root),
    );
    const manifest = await preparation.prepare(operation.binding, noop);
    assert.equal(manifest.attemptId, held.intent.attemptId);
    const before = await readdir(root);
    await store.tasks.requestControl(held.intent.jobId, 'stop');
    await assert.rejects(
      preparation.prepare(operation.binding, noop),
      /MATERIAL_SOURCE_RESERVATION_NOT_READY/,
    );
    assert.deepEqual(await readdir(root), before);
  });
});
test('late stage completion after actor replacement cannot return preparation to the caller', async () => {
  await postFixture(async (store, file, catalog) => {
    await writeFile(path.join(catalog.directory, 'image.png'), png);
    const current = await store.materials.index(
      await new FilesystemMaterialScanner().scan(catalog.directory),
      randomUUID(),
    );
    const held = await store.materials.reserve(
      await postRequest(store, current, { source: 'image.png' }),
    );
    const operation = await dispatchedPost(store, held.intent, 'UPLOAD_MEDIA');
    assert.ok(operation.binding);
    let active = true;
    const source = new MaterialPostSourceCheck(
      store.materials,
      store.materialPosts,
      store.taskTabs,
      new FilesystemMaterialSourceVerifier(),
    );
    const cache = new FilesystemMaterialUploadStage(
      path.join(path.dirname(file), 'application-cache'),
    );
    const preparation = new MaterialUploadPreparation(source, {
      async stage(intent, binding, assertCurrent) {
        const manifest = await cache.stage(intent, binding, assertCurrent);
        active = false;
        return manifest;
      },
    });
    await assert.rejects(
      preparation.prepare(operation.binding, () => {
        if (!active) throw Error('ACTOR_REPLACED');
      }),
      /ACTOR_REPLACED/,
    );
    assert.equal(await store.materialPosts.result(held.intent.attemptId), null);
    assert.equal((await store.materials.reservation(held.intent.attemptId)).state, 'RESERVED');
  });
});
