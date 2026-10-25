import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, rename, symlink, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { FilesystemMaterialSourceVerifier } from '../src/infrastructure/material-source-verifier.js';
import { MaterialPostSourceCheck } from '../src/application/material-source-check.js';
import {
  FilesystemMaterialScanner,
  materialScanBudget,
} from '../src/infrastructure/material-scanner.js';
import { proofOf } from '../src/infrastructure/material-file-utils.js';
import { postFixture, postRequest, dispatchedPost } from './fixtures/material-post.js';

const verifier = new FilesystemMaterialSourceVerifier();
const noop = () => {};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
  'base64',
);

test('source verification re-reads all four formats without modifying files or material state', async () => {
  for (const source of ['text.txt', 'image.png', 'album', 'video.mp4']) {
    await postFixture(async (store, _file, catalog) => {
      const root = catalog.directory;
      await writeFile(path.join(root, 'image.png'), png);
      await writeFile(path.join(root, 'image.txt'), 'image caption');
      await mkdir(path.join(root, 'album'));
      await writeFile(path.join(root, 'album', '正文.txt'), 'album caption');
      await writeFile(path.join(root, 'album', '1.png'), png);
      await writeFile(path.join(root, 'album', '2.png'), png);
      await writeFile(path.join(root, 'video.mp4'), await readFile('public/sample.mp4'));
      const current = await store.materials.index(
        await new FilesystemMaterialScanner().scan(root),
        randomUUID(),
      );

      const held = await store.materials.reserve(await postRequest(store, current, { source }));
      const hashes = await Promise.all(
        held.intent.snapshot.files.map(async (item) =>
          createHash('sha256')
            .update(await readFile(path.join(root, item.relativePath)))
            .digest('hex'),
        ),
      );
      const observation = await verifier.verify(held.intent, noop);
      assert.equal(observation.fingerprint, held.intent.fingerprint);
      assert.deepEqual(observation.files, held.intent.snapshot.files);
      assert.equal((await store.materials.reservation(held.intent.attemptId)).state, 'RESERVED');
      assert.deepEqual(
        await Promise.all(
          held.intent.snapshot.files.map(async (item) =>
            createHash('sha256')
              .update(await readFile(path.join(root, item.relativePath)))
              .digest('hex'),
          ),
        ),
        hashes,
      );
    });
  }
});

test('source verification refuses edited content including identical normalized text', async () => {
  await postFixture(async (store, _file, catalog) => {
    const held = await store.materials.reserve(await postRequest(store, catalog));
    await writeFile(path.join(catalog.directory, 'text.txt'), '生成发布事务测试正文\r\n');
    await assert.rejects(verifier.verify(held.intent, noop), /MATERIAL_SOURCE_FILE_CHANGED/);
    assert.equal((await store.materials.reservation(held.intent.attemptId)).state, 'RESERVED');
  });
});

test('full file digest is checked even if supplied metadata matches edited file', async () => {
  await postFixture(async (store, _file, catalog) => {
    const held = await store.materials.reserve(await postRequest(store, catalog));
    const file = path.join(catalog.directory, 'text.txt');
    const original = held.intent.snapshot.files[0];
    assert.ok(original);
    await writeFile(file, '另一个发布事务测试正文');
    const stat = await lstat(file, { bigint: true });
    const forged = structuredClone(held.intent);
    forged.snapshot.files[0] = { ...original, bytes: Number(stat.size), proof: proofOf(stat) };
    await assert.rejects(verifier.verify(forged, noop), /MATERIAL_SOURCE_CONTENT_CHANGED/);
  });
});

test('renamed equivalent content is not silently substituted for original source', async () => {
  await postFixture(async (store, _file, catalog) => {
    const held = await store.materials.reserve(await postRequest(store, catalog));
    await rename(
      path.join(catalog.directory, 'text.txt'),
      path.join(catalog.directory, 'renamed.txt'),
    );
    await assert.rejects(verifier.verify(held.intent, noop), /MATERIAL_SOURCE_MEMBERS_CHANGED/);
  });
});

test('new loose media caption or ambiguous same-stem media invalidates the original package', async () => {
  await postFixture(async (store, _file, catalog) => {
    const held = await store.materials.reserve(await postRequest(store, catalog));
    await writeFile(path.join(catalog.directory, 'text.png'), png);
    await assert.rejects(verifier.verify(held.intent, noop), /MATERIAL_SOURCE_MEMBERS_CHANGED/);
  });
});

test('added package member is rejected instead of uploading a partial original package', async () => {
  await postFixture(async (store, _file, catalog) => {
    const root = catalog.directory;
    await mkdir(path.join(root, 'album'));
    await writeFile(path.join(root, 'album', '1.png'), png);
    const current = await store.materials.index(
      await new FilesystemMaterialScanner().scan(root),
      randomUUID(),
    );
    const held = await store.materials.reserve(
      await postRequest(store, current, { source: 'album' }),
    );
    await writeFile(path.join(root, 'album', '2.png'), png);
    await assert.rejects(verifier.verify(held.intent, noop), /MATERIAL_SOURCE_MEMBERS_CHANGED/);
  });
});

test('file replaced by an outside directory junction is rejected before reading content', async () => {
  await postFixture(async (store, file, catalog) => {
    const held = await store.materials.reserve(await postRequest(store, catalog));
    const source = path.join(catalog.directory, 'text.txt');
    const outside = path.join(path.dirname(file), 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'outside');
    await unlink(source);
    await symlink(outside, source, 'junction');
    await assert.rejects(verifier.verify(held.intent, noop), /MATERIAL_SOURCE_FILE_CHANGED/);
  });
});

test('folder junction replacement is rejected before opening its members', async () => {
  await postFixture(async (store, file, catalog) => {
    const root = catalog.directory;
    await mkdir(path.join(root, 'album'));
    await writeFile(path.join(root, 'album', '1.png'), png);
    const current = await store.materials.index(
      await new FilesystemMaterialScanner().scan(root),
      randomUUID(),
    );
    const held = await store.materials.reserve(
      await postRequest(store, current, { source: 'album' }),
    );
    await rename(path.join(root, 'album'), path.join(path.dirname(file), 'original-album'));
    await symlink(
      path.join(path.dirname(file), 'original-album'),
      path.join(root, 'album'),
      'junction',
    );
    await assert.rejects(verifier.verify(held.intent, noop), /MATERIAL_SOURCE_FOLDER_CHANGED/);
  });
});

test('source budgets and actor cancellation abort without consuming or releasing material', async () => {
  await postFixture(async (store, _file, catalog) => {
    const held = await store.materials.reserve(await postRequest(store, catalog));
    const bounded = new FilesystemMaterialSourceVerifier({ ...materialScanBudget, totalBytes: 1 });
    await assert.rejects(bounded.verify(held.intent, noop), /MATERIAL_SOURCE_BUDGET/);
    let active = true;
    const check = verifier.verify(held.intent, () => {
      if (!active) throw Error('ACTOR_REVOKED');
    });
    queueMicrotask(() => {
      active = false;
    });
    await assert.rejects(check, /ACTOR_REVOKED/);
    assert.equal((await store.materials.reservation(held.intent.attemptId)).state, 'RESERVED');
    assert.equal(await store.materialPosts.result(held.intent.attemptId), null);
  });
});

test('snapshot path escape and mismatched intent fingerprint are rejected before filesystem IO', async () => {
  await postFixture(async (store, _file, catalog) => {
    const held = await store.materials.reserve(await postRequest(store, catalog));
    const escaped = structuredClone(held.intent);
    const member = escaped.snapshot.files[0];
    assert.ok(member);
    member.relativePath = '../outside.txt';
    await assert.rejects(verifier.verify(escaped, noop), /MATERIAL_SOURCE_INVALID/);
    await assert.rejects(
      verifier.verify({ ...held.intent, fingerprint: '0'.repeat(64) }, noop),
      /MATERIAL_SOURCE_INTENT_INVALID/,
    );
  });
});

test('source check uses original bound operation and checks actor after asynchronous verification', async () => {
  await postFixture(async (store, _file, catalog) => {
    const held = await store.materials.reserve(await postRequest(store, catalog));
    const operation = await dispatchedPost(store, held.intent, 'OPEN_COMPOSER');
    assert.ok(operation.binding);
    let active = true;
    const service = new MaterialPostSourceCheck(
      store.materials,
      store.materialPosts,
      store.taskTabs,
      {
        async verify(intent, assertCurrent) {
          await assertCurrent();
          await Promise.resolve();
          active = false;
          return {
            fingerprint: intent.fingerprint,
            checkedAt: new Date().toISOString(),
            files: intent.snapshot.files,
          };
        },
      },
    );
    await assert.rejects(
      service.check(operation.binding, () => {
        if (!active) throw Error('ACTOR_REPLACED');
      }),
      /ACTOR_REPLACED/,
    );
    assert.equal((await store.tasks.operations(held.intent.jobId))[0]?.status, 'DISPATCHING');
    assert.equal(await store.materialPosts.result(held.intent.attemptId), null);
  });
});

test('source check rejects changed reservation and mismatched original binding', async () => {
  await postFixture(async (store, _file, catalog) => {
    const held = await store.materials.reserve(await postRequest(store, catalog));
    const operation = await dispatchedPost(store, held.intent, 'OPEN_COMPOSER');
    assert.ok(operation.binding);
    const service = new MaterialPostSourceCheck(
      store.materials,
      store.materialPosts,
      store.taskTabs,
      verifier,
    );
    const observation = await service.check(operation.binding, noop);
    assert.equal(observation.attemptId, held.intent.attemptId);
    await assert.rejects(
      service.check({ ...operation.binding, leaseId: randomUUID() }, noop),
      /MATERIAL_SOURCE_BINDING_MISMATCH/,
    );
    await store.tasks.requestControl(held.intent.jobId, 'stop');
    await assert.rejects(
      service.check(operation.binding, noop),
      /MATERIAL_SOURCE_RESERVATION_NOT_READY/,
    );
  });
});
