import { latestMigrationBackupMarker } from './fixtures/workspace-schema.js';
import test from 'node:test';
import { directoryIntent } from './fixtures/material-post.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, lstat, symlink, rename } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { FilesystemMaterialScanner } from '../src/infrastructure/material-scanner.js';
import { FilesystemMaterialArchivePlanner } from '../src/infrastructure/material-archive-planner.js';
import { MaterialArchivePreparation } from '../src/application/material-archive-preparation.js';
import { archiveLayout } from '../src/infrastructure/material-archive-layout.js';
import {
  postFixture,
  postRequest,
  dispatchedPost,
  postReceipt,
  deliverPostNotices,
} from './fixtures/material-post.js';
import { dropMaterialArchivePreparationSchema } from './fixtures/material-archive-schema.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
  'base64',
);
async function source(store: WorkspaceStore, directory: string, name = 'text.txt') {
  await writeFile(path.join(directory, 'image.png'), png);
  await writeFile(path.join(directory, 'image.txt'), '图片配文');
  await mkdir(path.join(directory, 'album'));
  for (const file of ['a.png', 'b.png']) await writeFile(path.join(directory, 'album', file), png);
  await writeFile(path.join(directory, 'album', '正文.txt'), '整包配文');
  await writeFile(path.join(directory, 'video.mp4'), await readFile('public/sample.mp4'));
  const catalog = await store.materials.index(
      await new FilesystemMaterialScanner().scan(directory),
      randomUUID(),
    ),
    request = await postRequest(store, catalog, { source: name });
  await store.materials.reserve(request);
  return request;
}
type Request = Awaited<ReturnType<typeof source>>;
async function publish(store: WorkspaceStore, request: Request, notice = true) {
  if ((await store.materials.reservation(request.attemptId)).intent.snapshot.format !== 'text') {
    const upload = await dispatchedPost(store, request, 'UPLOAD_MEDIA');
    await store.materialPosts.verify(await postReceipt(store, request, upload));
    await deliverPostNotices(store, request.context.profileId);
  }
  const submit = await dispatchedPost(store, request, 'SUBMIT');
  await store.materialPosts.verify(await postReceipt(store, request, submit));
  if (notice) await deliverPostNotices(store, request.context.profileId);
}
const preparation = (store: WorkspaceStore) =>
  new MaterialArchivePreparation(store.archivePreparation, new FilesystemMaterialArchivePlanner());
test('revocation during asynchronous filesystem inspection leaves REVIEW and cannot commit a late plan', async () => {
  await postFixture(async (store, _file, catalog) => {
    const request = await source(store, catalog.directory);
    await publish(store, request);
    const planner = new FilesystemMaterialArchivePlanner();
    const worker = new MaterialArchivePreparation(store.archivePreparation, {
      inspect: async (value, current) => {
        await Promise.resolve();
        await store.archivePreparation.recoverOnStartup();
        return planner.inspect(value, current);
      },
    });
    await assert.rejects(worker.prepare(request.attemptId), /CLAIM_REVOKED/);
    assert.equal((await store.archivePreparation.get(request.attemptId))?.state, 'REVIEW');
    assert.equal((await store.archivePreparation.get(request.attemptId))?.plan, null);
    assert.equal((await store.materialPosts.result(request.attemptId))?.outcome, 'PUBLISHED');
  });
});
const pending = async (store: WorkspaceStore, id: string) => {
  const row = (await store.materialPosts.archives()).find((r) => r.attemptId === id);
  assert.ok(row);
  return row;
};

test('four-format immutable archive plans include all original media and text without creating or moving files', async () => {
  for (const name of ['text.txt', 'image.png', 'album', 'video.mp4'])
    await postFixture(async (store, file, catalog) => {
      const request = await source(store, catalog.directory, name);
      await publish(store, request);
      const intent = directoryIntent(store, request.attemptId);
      const before = await Promise.all(
        intent.snapshot.files.map((f) => readFile(path.join(intent.directory, f.relativePath))),
      );
      const worker = preparation(store),
        saved = await worker.prepare(request.attemptId);
      assert.equal(saved.state, 'READY');
      assert.ok(saved.plan);
      assert.equal(saved.plan.version, 1);
      if (saved.plan.version !== 1) throw Error('DIRECTORY_PLAN_REQUIRED');
      assert.equal(saved.plan.files.length, intent.snapshot.files.length);
      assert.equal(saved.plan.folderPackage, name === 'album');
      assert.equal(path.dirname(saved.plan.destination), path.join(intent.directory, '已发'));
      assert.ok(path.basename(saved.plan.destination).includes(intent.fingerprint.slice(0, 16)));
      assert.ok(path.basename(saved.plan.destination).endsWith(request.attemptId));
      await assert.rejects(lstat(path.join(intent.directory, '已发')), { code: 'ENOENT' });
      assert.deepEqual(
        await Promise.all(
          intent.snapshot.files.map((f) => readFile(path.join(intent.directory, f.relativePath))),
        ),
        before,
      );
      assert.deepEqual(await worker.prepare(request.attemptId), saved);
      const reopened = await WorkspaceStore.open(file);
      try {
        assert.deepEqual(reopened.archivePreparation.get(request.attemptId), saved);
        assert.equal(reopened.archivePreparation.recoverOnStartup(), 0);
      } finally {
        reopened.close();
      }
      assert.equal((await store.materialPosts.archives()).length, 1);
      assert.equal((await store.tasks.steps(request.jobId))[0]?.progress.published, 1);
    });
});

test('transport ACK, unknown submission and locally NOT_PUBLISHED cannot create an archive plan', async () => {
  for (const status of ['ACK', 'UNKNOWN', 'NOT_PUBLISHED'])
    await postFixture(async (store, _file, catalog) => {
      const request = await source(store, catalog.directory);
      if (status === 'NOT_PUBLISHED') await store.materialPosts.cancelUnsent(request.attemptId);
      else {
        const op = await dispatchedPost(store, request);
        if (status === 'ACK')
          await store.tasks.acknowledgeBound({
            binding: op.binding,
            evidence: { transport: true },
          });
        else await store.tasks.markBoundUnknown(op.binding, 'simulated uncertainty');
      }
      await assert.rejects(
        preparation(store).prepare(request.attemptId),
        /PUBLISHED_REQUEST_REQUIRED/,
      );
      assert.equal(await store.archivePreparation.get(request.attemptId), null);
    });
});

test('original publication notice must be delivered before planning; no failure can undo publication', async () => {
  await postFixture(async (store, _file, catalog) => {
    const request = await source(store, catalog.directory);
    await publish(store, request, false);
    await assert.rejects(preparation(store).prepare(request.attemptId), /NOTICE_PENDING/);
    assert.equal(await store.archivePreparation.get(request.attemptId), null);
    assert.equal((await store.materialPosts.result(request.attemptId))?.outcome, 'PUBLISHED');
    await deliverPostNotices(store, request.context.profileId);
    assert.equal((await preparation(store).prepare(request.attemptId)).state, 'READY');
  });
});

test('modified, missing and extra package members including temporary files retain PENDING archive and published checkpoint', async () => {
  for (const changed of ['tamper', 'missing', 'extra', 'temporary'])
    await postFixture(async (store, _file, catalog) => {
      const request = await source(
        store,
        catalog.directory,
        changed === 'tamper' || changed === 'missing' ? 'text.txt' : 'album',
      );
      await publish(store, request);
      if (changed === 'tamper')
        await writeFile(path.join(catalog.directory, 'text.txt'), 'changed');
      if (changed === 'missing')
        await rename(
          path.join(catalog.directory, 'text.txt'),
          path.join(catalog.directory, 'moved-by-test.txt'),
        );
      if (changed === 'extra' || changed === 'temporary')
        await writeFile(
          path.join(
            catalog.directory,
            'album',
            changed === 'extra' ? 'extra.png' : '.working.part',
          ),
          'keep',
        );
      await assert.rejects(preparation(store).prepare(request.attemptId));
      assert.equal((await store.archivePreparation.get(request.attemptId))?.state, 'REVIEW');
      assert.equal((await store.archivePreparation.get(request.attemptId))?.plan, null);
      assert.equal((await store.materialPosts.archives()).length, 1);
      assert.equal((await store.tasks.steps(request.jobId))[0]?.progress.published, 1);
    });
});

test('occupied deterministic target is preserved; retry does not select a different destination', async () => {
  await postFixture(async (store, _file, catalog) => {
    const request = await source(store, catalog.directory);
    await publish(store, request);
    const target = archiveLayout(await pending(store, request.attemptId)).destination;
    assert.equal(path.dirname(path.dirname(target)), catalog.directory);
    await mkdir(path.dirname(target));
    await mkdir(target);
    await writeFile(path.join(target, 'sentinel.txt'), 'keep');
    for (let n = 0; n < 2; n++)
      await assert.rejects(preparation(store).prepare(request.attemptId), /DESTINATION_OCCUPIED/);
    assert.equal(await readFile(path.join(target, 'sentinel.txt'), 'utf8'), 'keep');
    assert.deepEqual(await readdir(path.dirname(target)), [path.basename(target)]);
  });
});

test('archive-root junction rejects planning and leaves external directory untouched', async () => {
  await postFixture(async (store, file, catalog) => {
    const request = await source(store, catalog.directory);
    await publish(store, request);
    const outside = path.join(path.dirname(file), 'outside');
    assert.equal(path.dirname(outside), path.dirname(file));
    await mkdir(outside);
    await writeFile(path.join(outside, 'sentinel.txt'), 'keep');
    await symlink(outside, path.join(catalog.directory, '已发'), 'junction');
    await assert.rejects(preparation(store).prepare(request.attemptId), /DIRECTORY_CHANGED/);
    assert.deepEqual(await readdir(outside), ['sentinel.txt']);
  });
});

test('two controllers cannot claim overlapping preparation; passive open preserves and explicit recovery revokes old async results', async () => {
  await postFixture(async (store, file, catalog) => {
    const request = await source(store, catalog.directory);
    await publish(store, request);
    const claim = await store.archivePreparation.claim(request.attemptId),
      second = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(
        second.archivePreparation.get(request.attemptId),
        await store.archivePreparation.get(request.attemptId),
      );
      assert.throws(() => second.archivePreparation.claim(request.attemptId), /CLAIM_REJECTED/);
      const plan = await new FilesystemMaterialArchivePlanner().inspect(
        claim.request,
        async () => await store.archivePreparation.assertCurrent(claim),
      );
      assert.equal(second.archivePreparation.recoverOnStartup(), 1);
      await assert.rejects(
        async () => await store.archivePreparation.ready(claim, plan),
        /CLAIM_REVOKED/,
      );
      assert.equal((await preparation(second).prepare(request.attemptId)).state, 'READY');
      assert.equal(plan.version, 1);
      if (plan.version !== 1) throw Error('DIRECTORY_PLAN_REQUIRED');
      const storedPlan = second.archivePreparation.get(request.attemptId)?.plan;
      assert.equal(storedPlan?.version === 1 ? storedPlan.destination : null, plan.destination);
    } finally {
      second.close();
    }
  });
});

test('preparation completion rolls back immutable plan on failed state commit, retaining the original publication and allowing read-only retry', async () => {
  await postFixture(async (store, file, catalog) => {
    const request = await source(store, catalog.directory);
    await publish(store, request);
    const db = new DatabaseSync(file);
    try {
      db.exec(
        "CREATE TRIGGER fail_archive_ready BEFORE UPDATE ON material_archive_preparation WHEN NEW.state='READY' BEGIN SELECT RAISE(ABORT,'SIMULATED_ARCHIVE_READY_COMMIT_FAILED'); END",
      );
      await assert.rejects(
        preparation(store).prepare(request.attemptId),
        /SIMULATED_ARCHIVE_READY_COMMIT_FAILED/,
      );
      assert.equal(db.prepare('SELECT count(*) AS n FROM material_archive_plans').get()?.n, 0);
      assert.equal((await store.archivePreparation.get(request.attemptId))?.state, 'REVIEW');
      db.exec('DROP TRIGGER fail_archive_ready');
      assert.equal((await preparation(store).prepare(request.attemptId)).state, 'READY');
      assert.throws(
        () => db.exec("UPDATE material_archive_plans SET body='{}'"),
        /IMMUTABLE_ARCHIVE_PLAN/,
      );
      assert.throws(() => db.exec('DELETE FROM material_archive_plans'), /RETAIN_ARCHIVE_PLAN/);
      assert.throws(
        () => db.exec("UPDATE material_archive_state SET state='COMPLETED'"),
        /ARCHIVE_COMPLETION_PROOF_REQUIRED/,
      );
    } finally {
      db.close();
    }
  });
});

test('forged target or missing member cannot be committed as an immutable plan', async () => {
  await postFixture(async (store, _file, catalog) => {
    const request = await source(store, catalog.directory, 'album');
    await publish(store, request);
    const claim = await store.archivePreparation.claim(request.attemptId),
      plan = await new FilesystemMaterialArchivePlanner().inspect(
        claim.request,
        async () => await store.archivePreparation.assertCurrent(claim),
      );
    assert.equal(plan.version, 1);
    if (plan.version !== 1) throw Error('DIRECTORY_PLAN_REQUIRED');
    await assert.rejects(
      async () =>
        await store.archivePreparation.ready(claim, {
          ...plan,
          destination: path.dirname(plan.destination),
        }),
      /PLAN_MISMATCH/,
    );
    await assert.rejects(
      async () =>
        await store.archivePreparation.ready(claim, { ...plan, files: plan.files.slice(1) }),
      /PLAN_MISMATCH/,
    );
    assert.equal((await store.archivePreparation.get(request.attemptId))?.state, 'PREPARING');
    await store.archivePreparation.ready(claim, plan);
  });
});

test('stored READY plan is a historical witness, not automatic movement or authorization after source changes', async () => {
  await postFixture(async (store, _file, catalog) => {
    const request = await source(store, catalog.directory);
    await publish(store, request);
    const saved = await preparation(store).prepare(request.attemptId);
    await writeFile(path.join(catalog.directory, 'text.txt'), 'external change');
    assert.deepEqual(await preparation(store).prepare(request.attemptId), saved);
    assert.equal(
      await readFile(path.join(catalog.directory, 'text.txt'), 'utf8'),
      'external change',
    );
    await assert.rejects(
      new FilesystemMaterialArchivePlanner().inspect(
        await pending(store, request.attemptId),
        () => {},
      ),
    );
    assert.equal((await store.materialPosts.archives()).length, 1);
  });
});

test('schema11 upgrade preserves original PUBLISHED and PENDING archive without automatic preparation', async () => {
  await postFixture(async (store, file, catalog) => {
    const request = await source(store, catalog.directory);
    await publish(store, request);
    const original = await pending(store, request.attemptId),
      db = new DatabaseSync(file);
    db.exec(dropMaterialArchivePreparationSchema + 'PRAGMA user_version=11');
    db.close();
    const upgraded = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(await pending(upgraded, request.attemptId), original);
      assert.equal(upgraded.archivePreparation.get(request.attemptId), null);
      const backupFile = (await readdir(path.dirname(file))).find((name) =>
        name.includes(latestMigrationBackupMarker),
      );
      assert.ok(backupFile);
      const backup = new DatabaseSync(path.join(path.dirname(file), backupFile), {
        readOnly: true,
      });
      try {
        assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 11);
        assert.equal(
          backup
            .prepare("SELECT count(*) AS n FROM material_archive_state WHERE state='PENDING'")
            .get()?.n,
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
