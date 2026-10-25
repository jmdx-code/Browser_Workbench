import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { FilesystemMaterialScanner } from '../src/infrastructure/material-scanner.js';
import { FilesystemMaterialUploadStage } from '../src/infrastructure/material-upload-stage.js';
import { PersistentMaterialUploadStage } from '../src/application/persistent-material-upload-stage.js';
import { UploadStageManifest } from '../src/shared/material-upload.js';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import { postFixture, postRequest, dispatchedPost } from './fixtures/material-post.js';
import { settlementFixture, prepareBound } from './fixtures/settlement.js';
import { dropVideoDerivationSchema } from './fixtures/workspace-schema.js';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
for (const capacityFits of [true, false])
  test(`derived video stage preserves source and ${capacityFits ? 'verifies actual bytes under schema33' : 'rejects expanded media exceeding retained capacity'}`, async () => {
    await postFixture(async (store, file, initial) => {
      const bytes = await readFile('public/sample.mp4');
      const source = path.join(initial.directory, 'video.mp4');
      await writeFile(source, bytes);
      await writeFile(path.join(initial.directory, 'video.txt'), 'Complete caption');
      const catalog = await store.materials.index(
        await new FilesystemMaterialScanner().scan(initial.directory),
        randomUUID(),
      );
      const request = await postRequest(store, catalog, {
        source: 'video.mp4',
        destination: 'story',
        audience: 'friends',
      });
      const intent = (await store.materials.reserve(request)).intent,
        original = structuredClone(intent);
      const operation = await dispatchedPost(store, request, 'UPLOAD_MEDIA');
      const derived = Buffer.concat([bytes, Buffer.from('generated-derived-media-fixture')]);
      const root = path.join(path.dirname(file), 'derived-cache');
      const writer = new FilesystemMaterialUploadStage(root, undefined, {
        enabled: () => true,
        derive: async (_source, folder, text, sourceSha256, guard, created) => {
          await guard();
          const digest = sha(derived),
            name = '00-' + digest + '.mp4';
          await writeFile(path.join(folder, name), derived, { flag: 'wx' });
          created(path.join(folder, name));
          await guard();
          return {
            name,
            derivation: {
              version: 1,
              kind: 'story-caption-video',
              text,
              sourceSha256,
              textSha256: sha(text),
              captionSha256: 'b'.repeat(64),
              rendererVersion: 1,
              runtimeArchiveSha256: 'c'.repeat(64),
              digest,
              bytes: derived.length,
              width: 720,
              height: 1280,
              duration: 6,
            },
          };
        },
      });
      const stage = new PersistentMaterialUploadStage(
        store.uploadStages,
        writer,
        capacityFits ? derived.length : bytes.length,
      );
      if (!capacityFits) {
        await assert.rejects(
          stage.stage(intent, operation.binding, () => {}),
          /UPLOAD_STAGE_RETAINED_BUDGET/,
        );
        const retained = (await store.uploadStages.list()).find(
          (row) => row.owner.binding.operationId === operation.binding.operationId,
        );
        assert.equal(retained?.state, 'REVIEW');
        assert.equal(retained?.manifest?.files[0]?.derivation?.bytes, derived.length);
        assert.ok(retained);
        assert.equal(await store.uploadStages.cacheBytes(retained.owner.stageId), derived.length);
        await assert.rejects(
          async () => await store.uploadStages.assertReady(retained.manifest!),
          /NOT_READY/,
        );
        assert.deepEqual(await readFile(source), bytes);
        assert.equal(await store.materialPosts.result(request.attemptId), null);
        return;
      }
      const manifest = await stage.stage(intent, operation.binding, () => {});
      assert.equal(manifest.version, 2);
      assert.deepEqual((await store.materials.reservation(request.attemptId)).intent, original);
      assert.equal(manifest.files[0]?.original.digest, sha(bytes));
      assert.equal(manifest.files[0]?.derivation?.digest, sha(derived));
      const [uploaded] = await stage.verify(intent, operation.binding, manifest, () => {});
      assert.ok(uploaded);
      assert.deepEqual(await readFile(uploaded), derived);
      assert.deepEqual(await readFile(source), bytes);
      assert.equal((await store.uploadStages.get(manifest.stageId)).state, 'READY');
      assert.equal(await store.uploadStages.cacheBytes(manifest.stageId), derived.length);
      const legacy = { ...manifest, version: 1 };
      assert.equal(UploadStageManifest.safeParse(legacy).success, false);
      const wrong = structuredClone(manifest);
      wrong.files[0]!.derivation!.text = 'changed caption';
      await assert.rejects(
        writer.verify(intent, operation.binding, wrong, () => {}),
        /DERIVED_TEXT_MISMATCH/,
      );
      const db = new DatabaseSync(file);
      db.exec(dropVideoDerivationSchema);
      db.close();
      await assert.rejects(
        async () => await store.uploadStages.assertDerivationContract(intent),
        /CONTRACT_REQUIRED/,
      );
      assert.equal(await store.materialPosts.result(request.attemptId), null);
    });
  });

test('schema33 appends only the derivation gate and preserves original UNKNOWN and all task records from32', async () => {
  await settlementFixture(async (store, file) => {
    const old = await prepareBound(store);
    await store.tasks.markBoundUnknown(old.binding, 'GENERATED_OLD_UNKNOWN');
    const before = {
      plan: await store.tasks.get(old.plan.id),
      steps: await store.tasks.steps(old.plan.id),
      operations: await store.tasks.operations(old.plan.id),
    };
    const raw = new DatabaseSync(file);
    raw.exec(dropVideoDerivationSchema + 'PRAGMA user_version=32');
    raw.close();
    const upgraded = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(
        {
          plan: upgraded.tasks.get(old.plan.id),
          steps: upgraded.tasks.steps(old.plan.id),
          operations: upgraded.tasks.operations(old.plan.id),
        },
        before,
      );
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, workspaceSchemaVersion);
        assert.equal(
          db
            .prepare(
              "SELECT version FROM workspace_execution_contracts WHERE name='story-video-derived-media'",
            )
            .get()?.version,
          1,
        );
      } finally {
        db.close();
      }
    } finally {
      upgraded.close();
    }
  });
});
