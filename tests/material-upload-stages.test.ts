import { latestMigrationBackupMarker } from './fixtures/workspace-schema.js';
import test from 'node:test';
import { directoryIntent } from './fixtures/material-post.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, symlink, realpath } from 'node:fs/promises';
import { canonicalDataDirectory } from '../src/infrastructure/paths.js';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { FilesystemMaterialScanner } from '../src/infrastructure/material-scanner.js';
import { FilesystemMaterialSourceVerifier } from '../src/infrastructure/material-source-verifier.js';
import { FilesystemMaterialUploadStage } from '../src/infrastructure/material-upload-stage.js';
import { MaterialPostSourceCheck } from '../src/application/material-source-check.js';
import { MaterialUploadPreparation } from '../src/application/material-upload-preparation.js';
import { MaterialFileGrantPreparation } from '../src/application/material-file-grant-preparation.js';
import { PersistentMaterialUploadStage } from '../src/application/persistent-material-upload-stage.js';
import { dropMaterialUploadStageSchema } from './fixtures/material-upload-stage-schema.js';
import { postFixture, postRequest, dispatchedPost } from './fixtures/material-post.js';
import type { ReservationRequest, Catalog } from '../src/shared/material-index.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
  'base64',
);
const noop = () => {};
const sourceCheck = (store: WorkspaceStore) =>
  new MaterialPostSourceCheck(
    store.materials,
    store.materialPosts,
    store.taskTabs,
    new FilesystemMaterialSourceVerifier(),
  );
async function fixture(
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
    await writeFile(
      path.join(initial.directory, 'different.png'),
      Buffer.concat([png, Buffer.from([0])]),
    );
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

test('persistent stage precedes file IO and retains exact binding and real bytes for all three media formats', async () => {
  for (const source of ['image.png', 'album', 'video.mp4'])
    await fixture(async (store, file, request) => {
      const original = await dispatchedPost(store, request, 'UPLOAD_MEDIA'),
        check = sourceCheck(store);
      const disk = new FilesystemMaterialUploadStage(path.join(path.dirname(file), 'owned-cache'));
      let observedBeforeIO = false;
      const cache = new PersistentMaterialUploadStage(store.uploadStages, {
        cacheRoot: disk.cacheRoot,
        stageReserved: async (intent, binding, id, current) => {
          const record = await store.uploadStages.get(id);
          assert.equal(record.state, 'WRITING');
          assert.deepEqual(record.owner.binding, original.binding);
          assert.equal(existsSync(path.join(disk.cacheRoot, id)), false);
          observedBeforeIO = true;
          return disk.stageReserved(intent, binding, id, current);
        },
        verify: disk.verify.bind(disk),
      });
      const manifest = await new MaterialUploadPreparation(check, cache).prepare(
        original.binding,
        noop,
      );
      const record = await store.uploadStages.get(manifest.stageId);
      assert.equal(observedBeforeIO, true);
      assert.equal(record.state, 'READY');
      assert.equal(record.revision, 1);
      assert.deepEqual(record.manifest, manifest);
      const grant = await new MaterialFileGrantPreparation(check, cache).prepare(
        original.binding,
        manifest,
        noop,
      );
      for (const [index, target] of grant.files.entries()) {
        const member = manifest.files[index];
        assert.ok(member);
        assert.deepEqual(
          await readFile(target),
          await readFile(
            path.join(
              directoryIntent(store, request.attemptId).directory,
              member.original.relativePath,
            ),
          ),
        );
      }
      const reopened = await WorkspaceStore.open(file);
      try {
        assert.deepEqual(reopened.uploadStages.get(manifest.stageId), record);
        assert.equal(reopened.materialPosts.result(request.attemptId), null);
      } finally {
        reopened.close();
      }
      assert.equal((await store.tasks.operations(request.jobId))[0]?.status, 'DISPATCHING');
      assert.equal((await store.materialPosts.archives()).length, 0);
    }, source);
});

test('canonical product data path supports a redirected parent while upload root and original file guards stay strict', async () => {
  await fixture(async (store, file, request) => {
    const physical = path.join(path.dirname(file), 'physical-product-data'),
      alias = path.join(path.dirname(file), 'product-data-alias');
    await mkdir(physical);
    await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const canonical = await canonicalDataDirectory(alias);
    assert.equal(canonical, await realpath(physical));
    const physicalCache = path.join(path.dirname(file), 'physical-upload-cache');
    await mkdir(physicalCache);
    await symlink(
      physicalCache,
      path.join(canonical, 'upload-cache'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const cacheRoot = await canonicalDataDirectory(path.join(canonical, 'upload-cache'));
    assert.equal(cacheRoot, await realpath(physicalCache));
    const original = await dispatchedPost(store, request, 'UPLOAD_MEDIA'),
      disk = new FilesystemMaterialUploadStage(cacheRoot);
    const cache = new PersistentMaterialUploadStage(store.uploadStages, disk),
      check = sourceCheck(store);
    const manifest = await new MaterialUploadPreparation(check, cache).prepare(
      original.binding,
      noop,
    );
    assert.equal((await store.uploadStages.get(manifest.stageId)).owner.cacheRoot, cacheRoot);
    const grant = await new MaterialFileGrantPreparation(check, cache).prepare(
      original.binding,
      manifest,
      noop,
    );
    assert.equal(grant.files.length, 1);
    assert.deepEqual(await readFile(grant.files[0]!), png);
  });
});

test('same operation cannot restage or revive a reviewed cache even with a different cache root', async () => {
  await fixture(async (store, file, request) => {
    const original = await dispatchedPost(store, request, 'UPLOAD_MEDIA'),
      intent = (await store.materials.reservation(request.attemptId)).intent,
      root = path.join(path.dirname(file), 'cache');
    const claim = await store.uploadStages.reserve(intent, original.binding, root, 1024);
    await assert.rejects(
      async () => await store.uploadStages.reserve(intent, original.binding, root, 1024),
      /ALREADY_OWNED/,
    );
    await store.uploadStages.review(claim, 'owner stopped');
    await assert.rejects(
      async () => await store.uploadStages.reserve(intent, original.binding, root + '-new', 1024),
      /ALREADY_OWNED/,
    );
    await assert.rejects(
      async () => await store.uploadStages.assertWriting(claim),
      /WRITER_REVOKED/,
    );
    assert.equal(existsSync(root), false);
  });
});

test('retained byte capacity is transactional across controller connections and includes REVIEW entries', async () => {
  await fixture(async (store, file, request, catalog) => {
    const first = await dispatchedPost(store, request, 'UPLOAD_MEDIA'),
      intent = (await store.materials.reservation(request.attemptId)).intent,
      root = path.join(path.dirname(file), 'cache');
    const claim = await store.uploadStages.reserve(intent, first.binding, root, png.length + 1);
    await store.uploadStages.review(claim, 'retain unknown preparation');
    const other = await postRequest(store, catalog, { source: 'different.png' });
    await store.materials.reserve(other);
    const second = await dispatchedPost(store, other, 'UPLOAD_MEDIA'),
      reopened = await WorkspaceStore.open(file);
    try {
      await assert.rejects(
        async () =>
          reopened.uploadStages.reserve(
            (await store.materials.reservation(other.attemptId)).intent,
            second.binding,
            root + '-2',
            png.length + 1,
          ),
        /RETAINED_BUDGET/,
      );
      assert.equal(reopened.uploadStages.list().length, 1);
    } finally {
      reopened.close();
    }
  });
});

test('stage ownership refuses obsolete bindings, wrong intent and non-upload purpose before creating files', async () => {
  await fixture(async (store, file, request) => {
    const original = await dispatchedPost(store, request, 'UPLOAD_MEDIA'),
      intent = (await store.materials.reservation(request.attemptId)).intent,
      root = path.join(path.dirname(file), 'cache');
    await assert.rejects(
      async () =>
        await store.uploadStages.reserve(
          intent,
          { ...original.binding, leaseId: randomUUID() },
          root,
          1024,
        ),
    );
    await assert.rejects(
      async () =>
        await store.uploadStages.reserve(
          { ...intent, fingerprint: '0'.repeat(64) },
          original.binding,
          root,
          1024,
        ),
    );
    await assert.rejects(
      async () => await store.uploadStages.reserve(intent, original.binding, 'relative', 1024),
      /CONFIG_INVALID/,
    );
    await assert.rejects(
      async () => await store.uploadStages.reserve(intent, original.binding, root, NaN),
      /CONFIG_INVALID/,
    );
    assert.equal((await store.uploadStages.list()).length, 0);
    assert.equal(existsSync(root), false);
  });
  await fixture(async (store, file, request) => {
    const original = await dispatchedPost(store, request, 'OPEN_COMPOSER');
    await assert.rejects(
      async () =>
        await store.uploadStages.reserve(
          (await store.materials.reservation(request.attemptId)).intent,
          original.binding,
          path.join(path.dirname(file), 'cache'),
          1024,
        ),
      /UPLOAD_REQUIRED/,
    );
  });
});

test('explicit startup recovery revokes both WRITING and READY; merely opening has no recovery side effects', async () => {
  for (const prepared of [false, true])
    await fixture(async (store, file, request) => {
      const original = await dispatchedPost(store, request, 'UPLOAD_MEDIA'),
        intent = (await store.materials.reservation(request.attemptId)).intent,
        disk = new FilesystemMaterialUploadStage(path.join(path.dirname(file), 'cache'));
      const claim = await store.uploadStages.reserve(
        intent,
        original.binding,
        disk.cacheRoot,
        1024,
      );
      const manifest = await disk.stageReserved(
        intent,
        original.binding,
        claim.owner.stageId,
        async () => await store.uploadStages.assertWriting(claim),
      );
      if (prepared) await store.uploadStages.complete(claim, manifest);
      const before = await store.uploadStages.get(manifest.stageId),
        reopened = await WorkspaceStore.open(file);
      try {
        assert.deepEqual(reopened.uploadStages.get(manifest.stageId), before);
        assert.equal(reopened.uploadStages.recoverOnStartup(), 1);
        assert.equal(reopened.uploadStages.recoverOnStartup(), 0);
        const review = reopened.uploadStages.get(manifest.stageId);
        assert.equal(review.state, 'REVIEW');
        assert.equal(review.reason, 'STARTUP_RECHECK_REQUIRED');
        assert.equal(review.revision, before.revision + 1);
        assert.deepEqual(review.owner, before.owner);
        assert.deepEqual(review.manifest, before.manifest);
        await assert.rejects(
          async () => await store.uploadStages.complete(claim, manifest),
          /WRITER_REVOKED/,
        );
        await assert.rejects(
          async () => await store.uploadStages.assertReady(manifest),
          /NOT_READY/,
        );
        assert.ok(await readFile(path.join(disk.cacheRoot, manifest.stageId, 'ready.json')));
        assert.equal((await store.materials.reservation(request.attemptId)).state, 'RESERVED');
        assert.equal(await store.materialPosts.result(request.attemptId), null);
      } finally {
        reopened.close();
      }
    });
});

test('late completion after recovery retains generated cache without manufacturing READY or a browser grant', async () => {
  await fixture(async (store, file, request) => {
    const original = await dispatchedPost(store, request, 'UPLOAD_MEDIA'),
      disk = new FilesystemMaterialUploadStage(path.join(path.dirname(file), 'cache'));
    const cache = new PersistentMaterialUploadStage(store.uploadStages, {
      cacheRoot: disk.cacheRoot,
      stageReserved: async (intent, binding, id, current) => {
        const manifest = await disk.stageReserved(intent, binding, id, current);
        await store.uploadStages.recoverOnStartup();
        return manifest;
      },
      verify: disk.verify.bind(disk),
    });
    await assert.rejects(
      new MaterialUploadPreparation(sourceCheck(store), cache).prepare(original.binding, noop),
      /WRITER_REVOKED/,
    );
    const record = (await store.uploadStages.list())[0];
    assert.ok(record);
    assert.equal(record.state, 'REVIEW');
    assert.equal(record.manifest, null);
    assert.ok(await readFile(path.join(disk.cacheRoot, record.owner.stageId, 'ready.json')));
    assert.equal((await store.tasks.operations(request.jobId))[0]?.status, 'DISPATCHING');
  });
});

test('reserved filesystem preparation failure retains partial evidence and owner; it never removes source files', async () => {
  await fixture(async (store, file, request) => {
    const original = await dispatchedPost(store, request, 'UPLOAD_MEDIA'),
      disk = new FilesystemMaterialUploadStage(path.join(path.dirname(file), 'cache'));
    let stageId = '';
    const cache = new PersistentMaterialUploadStage(store.uploadStages, {
      cacheRoot: disk.cacheRoot,
      stageReserved: (intent, binding, id, current) => {
        stageId = id;
        return disk.stageReserved(intent, binding, id, async () => {
          await current();
          if (existsSync(path.join(disk.cacheRoot, id, 'ready.json')))
            throw Error('SIMULATED_ACTOR_CHANGED');
        });
      },
      verify: disk.verify.bind(disk),
    });
    await assert.rejects(
      new MaterialUploadPreparation(sourceCheck(store), cache).prepare(original.binding, noop),
      /SIMULATED_ACTOR_CHANGED/,
    );
    const record = await store.uploadStages.get(stageId);
    assert.equal(record.state, 'REVIEW');
    assert.equal(record.manifest, null);
    assert.equal(record.reason, 'SIMULATED_ACTOR_CHANGED');
    assert.ok(await readFile(path.join(disk.cacheRoot, stageId, 'ready.json')));
    assert.deepEqual(
      await readFile(path.join(directoryIntent(store, request.attemptId).directory, 'image.png')),
      png,
    );
  });
});

test('cache verification observes ledger revocation during asynchronous filesystem inspection and rejects a different writer root', async () => {
  await fixture(async (store, file, request) => {
    const original = await dispatchedPost(store, request, 'UPLOAD_MEDIA'),
      disk = new FilesystemMaterialUploadStage(path.join(path.dirname(file), 'cache'));
    const cache = new PersistentMaterialUploadStage(store.uploadStages, disk),
      manifest = await new MaterialUploadPreparation(sourceCheck(store), cache).prepare(
        original.binding,
        noop,
      );
    const other = new PersistentMaterialUploadStage(
      store.uploadStages,
      new FilesystemMaterialUploadStage(disk.cacheRoot + '-different'),
    );
    await assert.rejects(
      other.verify(
        (await store.materials.reservation(request.attemptId)).intent,
        original.binding,
        manifest,
        noop,
      ),
      /CACHE_ROOT_MISMATCH/,
    );
    const delayed = new PersistentMaterialUploadStage(store.uploadStages, {
      cacheRoot: disk.cacheRoot,
      stageReserved: disk.stageReserved.bind(disk),
      verify: async (intent, binding, value, current) => {
        const paths = await disk.verify(intent, binding, value, current);
        await store.uploadStages.recoverOnStartup();
        return paths;
      },
    });
    await assert.rejects(
      new MaterialFileGrantPreparation(sourceCheck(store), delayed).prepare(
        original.binding,
        manifest,
        noop,
      ),
      /NOT_READY/,
    );
    assert.equal((await store.uploadStages.get(manifest.stageId)).state, 'REVIEW');
  });
});

test('manifest commitment is atomic and immutable; foreign tokens and altered ordered members cannot commit', async () => {
  await fixture(async (store, file, request) => {
    const original = await dispatchedPost(store, request, 'UPLOAD_MEDIA'),
      intent = (await store.materials.reservation(request.attemptId)).intent,
      disk = new FilesystemMaterialUploadStage(path.join(path.dirname(file), 'cache'));
    const claim = await store.uploadStages.reserve(intent, original.binding, disk.cacheRoot, 1024);
    const manifest = await disk.stageReserved(intent, original.binding, claim.owner.stageId, noop);
    await assert.rejects(
      async () =>
        await store.uploadStages.complete({ ...claim, claimToken: randomUUID() }, manifest),
      /WRITER_REVOKED/,
    );
    await assert.rejects(
      async () =>
        await store.uploadStages.complete(claim, {
          ...manifest,
          files: [...manifest.files].reverse(),
        }),
      /READY_MISMATCH/,
    );
    const db = new DatabaseSync(file);
    try {
      db.exec(
        "CREATE TRIGGER injected_stage_commit BEFORE UPDATE ON material_upload_stage_state WHEN NEW.state='READY' BEGIN SELECT RAISE(ABORT,'SIMULATED_STATE_WRITE_FAILURE'); END",
      );
      await assert.rejects(
        async () => await store.uploadStages.complete(claim, manifest),
        /SIMULATED_STATE_WRITE_FAILURE/,
      );
      assert.equal((await store.uploadStages.get(claim.owner.stageId)).manifest, null);
      assert.equal((await store.uploadStages.get(claim.owner.stageId)).state, 'WRITING');
      db.exec('DROP TRIGGER injected_stage_commit');
      await store.uploadStages.complete(claim, manifest);
      assert.throws(
        () => db.exec('UPDATE material_upload_stage_owners SET expected_bytes=1'),
        /IMMUTABLE_UPLOAD_STAGE_RECORD/,
      );
      assert.throws(
        () => db.exec("UPDATE material_upload_stage_manifests SET body='{}'"),
        /IMMUTABLE_UPLOAD_STAGE_RECORD/,
      );
      assert.throws(
        () => db.exec('DELETE FROM material_upload_stage_state'),
        /RETAIN_UPLOAD_STAGE_STATE/,
      );
      await store.uploadStages.review(claim, 'unknown result');
      assert.throws(
        () => db.exec("UPDATE material_upload_stage_state SET state='READY',revision=revision+1"),
        /TRANSITION_REJECTED/,
      );
    } finally {
      db.close();
    }
  }, 'album');
});

test('schema9 migration backs up original running upload without preparing cache or recovering original binding', async () => {
  await fixture(async (store, file, request) => {
    const original = await dispatchedPost(store, request, 'UPLOAD_MEDIA');
    const db = new DatabaseSync(file);
    db.exec(dropMaterialUploadStageSchema + 'PRAGMA user_version=9');
    db.close();
    const upgraded = await WorkspaceStore.open(file);
    try {
      assert.equal(upgraded.uploadStages.list().length, 0);
      assert.deepEqual(upgraded.tasks.operations(request.jobId)[0]?.binding, original.binding);
      assert.equal(upgraded.tasks.operations(request.jobId)[0]?.status, 'DISPATCHING');
      assert.equal(upgraded.materials.reservation(request.attemptId).state, 'RESERVED');
      const saved = (await readdir(path.dirname(file))).find((name) =>
        name.includes(latestMigrationBackupMarker),
      );
      assert.ok(saved);
      const backup = new DatabaseSync(path.join(path.dirname(file), saved), { readOnly: true });
      try {
        assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 9);
        assert.equal(
          backup.prepare('SELECT count(*) AS n FROM task_dispatch_bindings').get()?.n,
          1,
        );
      } finally {
        backup.close();
      }
    } finally {
      upgraded.close();
    }
  });
});
