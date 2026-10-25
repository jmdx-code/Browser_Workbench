import { latestMigrationBackupMarker } from './fixtures/workspace-schema.js';
import test from 'node:test';
import { directoryIntent } from './fixtures/material-post.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  lstat,
  unlink,
  rename,
  symlink,
  chmod,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { FilesystemMaterialScanner } from '../src/infrastructure/material-scanner.js';
import { FilesystemMaterialSourceVerifier } from '../src/infrastructure/material-source-verifier.js';
import { FilesystemMaterialUploadStage } from '../src/infrastructure/material-upload-stage.js';
import { FilesystemMaterialCacheCleaner } from '../src/infrastructure/material-cache-cleaner.js';
import { SqliteMaterialCacheCleanupRepository } from '../src/infrastructure/material-cache-cleanup-store.js';
import { MaterialCacheCleanup } from '../src/application/material-cache-cleanup.js';
import { MaterialCacheManagement } from '../src/application/material-cache-management.js';
import { MaterialPostSourceCheck } from '../src/application/material-source-check.js';
import { MaterialUploadPreparation } from '../src/application/material-upload-preparation.js';
import { PersistentMaterialUploadStage } from '../src/application/persistent-material-upload-stage.js';
import { TaskControlBinding, SessionStopReceipt } from '../src/shared/task-control.js';
import { NegativeAttemptEvidence } from '../src/shared/material-post.js';
import { KernelPersistentState } from '../src/shared/kernel-state.js';
import type { CleanupClaim, CleanupCompletion } from '../src/shared/material-cache-cleanup.js';
import {
  postFixture,
  postRequest,
  dispatchedPost,
  postReceipt,
  deliverPostNotices,
} from './fixtures/material-post.js';
import { dropMaterialCacheCleanupSchema } from './fixtures/material-cache-cleanup-schema.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
  'base64',
);
const noop = () => {};
async function setup(
  store: WorkspaceStore,
  file: string,
  directory: string,
  source = 'image.png',
  stage = true,
) {
  await writeFile(path.join(directory, 'image.png'), png);
  await writeFile(path.join(directory, 'different.png'), Buffer.concat([png, Buffer.from([0])]));
  await mkdir(path.join(directory, 'album'));
  for (const name of ['a.png', 'b.png']) await writeFile(path.join(directory, 'album', name), png);
  await writeFile(path.join(directory, 'video.mp4'), await readFile('public/sample.mp4'));
  const catalog = await store.materials.index(
    await new FilesystemMaterialScanner().scan(directory),
    randomUUID(),
  );
  const request = await postRequest(store, catalog, { source });
  await store.materials.reserve(request);
  const operation = await dispatchedPost(store, request, 'UPLOAD_MEDIA'),
    intent = directoryIntent(store, request.attemptId);
  const disk = new FilesystemMaterialUploadStage(path.join(path.dirname(file), 'cleanup-cache'));
  const sourceCheck = new MaterialPostSourceCheck(
    store.materials,
    store.materialPosts,
    store.taskTabs,
    new FilesystemMaterialSourceVerifier(),
  );
  const cache = new PersistentMaterialUploadStage(store.uploadStages, disk);
  const manifest = stage
    ? await new MaterialUploadPreparation(sourceCheck, cache).prepare(operation.binding, noop)
    : null;
  const owner = manifest
    ? (await store.uploadStages.get(manifest.stageId)).owner
    : (await store.uploadStages.reserve(intent, operation.binding, disk.cacheRoot, 1024)).owner;
  return { request, operation, intent, cache, disk, manifest, owner, catalog };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function stop(store: WorkspaceStore, f: Fixture, wrongLease = false) {
  const pending = await store.tasks.requestControl(f.request.jobId, 'stop');
  assert.ok(pending.controlRequestId);
  const binding = TaskControlBinding.parse({
    ...f.request.context,
    leaseId: wrongLease ? randomUUID() : f.request.context.leaseId,
    jobId: f.request.jobId,
    requestId: pending.controlRequestId,
    mode: 'stop',
  });
  await store.taskControls.bind(binding);
  const { jobId: _job, mode: _mode, ...context } = binding;
  await store.taskControls.confirm(
    binding,
    SessionStopReceipt.parse({ ...context, state: 'stopped' }),
  );
  return binding;
}
async function close(store: WorkspaceStore, f: Fixture) {
  const tab = await store.taskTabs.get(f.request.proof.ownershipId);
  await store.taskTabs.confirmClosed(
    tab.proof.ownershipId,
    tab.revision,
    KernelPersistentState.parse({
      version: 1,
      profileId: tab.proof.profileId,
      browserSessionEpoch: tab.proof.browserSessionEpoch,
      operations: [],
      tabs: [
        {
          ownershipId: tab.proof.ownershipId,
          url: 'http://127.0.0.1/local-generated',
          state: 'CLOSED',
          proof: tab.proof,
          reason: 'simulated native closed',
        },
      ],
    }),
  );
}
async function settle(
  store: WorkspaceStore,
  f: Fixture,
  outcome: 'PUBLISHED' | 'NOT_PUBLISHED' = 'PUBLISHED',
  closePage = true,
  wrongLease = false,
) {
  const receipt = await postReceipt(
    store,
    f.request,
    f.operation,
    outcome === 'PUBLISHED' ? 'APPLIED' : 'NOT_APPLIED',
  );
  await store.materialPosts.verify(receipt);
  await deliverPostNotices(store, f.request.context.profileId);
  if (outcome === 'PUBLISHED') {
    const submit = await dispatchedPost(store, f.request, 'SUBMIT');
    await store.materialPosts.verify(await postReceipt(store, f.request, submit));
    await deliverPostNotices(store, f.request.context.profileId);
  }
  const control = await stop(store, f, wrongLease);
  if (outcome === 'NOT_PUBLISHED') {
    const {
      purpose: _purpose,
      outcome: _outcome,
      postId: _post,
      basis: _basis,
      media: _media,
      ...fields
    } = receipt.evidence;
    await store.materialPosts.resolveNotPublished(
      NegativeAttemptEvidence.parse({
        ...fields,
        outcome: 'NOT_PUBLISHED',
        basis: 'independently-verified-not-published',
      }),
    );
  }
  if (closePage) await close(store, f);
  return control;
}
const cleaner = (store: WorkspaceStore, f: Fixture) =>
  new MaterialCacheCleanup(
    store.cacheCleanup,
    new FilesystemMaterialCacheCleaner(store.cacheCleanup, f.disk.cacheRoot),
  );

test('a retained main page permits only the original stopped upload cache cleanup, preserving page, sources and results', async () => {
  await postFixture(async (store, file, catalog) => {
    const f = await setup(store, file, catalog.directory);
    const manager = new MaterialCacheManagement(store.cacheCleanup, cleaner(store, f));
    assert.equal(
      (await manager.snapshot()).entries.find((entry) => entry.stageId === f.owner.stageId)
        ?.eligible,
      false,
    );
    const control = await settle(store, f, 'PUBLISHED', false);
    const tab = await store.taskTabs.get(f.request.proof.ownershipId, f.request.jobId);
    const { jobId: _job, mode: _mode, ...context } = control;
    await store.taskTabs.confirmReleased(
      tab.proof.ownershipId,
      tab.revision,
      KernelPersistentState.parse({
        version: 1,
        profileId: tab.proof.profileId,
        browserSessionEpoch: tab.proof.browserSessionEpoch,
        operations: [],
        tabs: [
          {
            ownershipId: tab.proof.ownershipId,
            proof: tab.proof,
            state: 'READY',
            url: 'https://www.facebook.com/',
            reason: '',
          },
        ],
      }),
      SessionStopReceipt.parse({ ...context, state: 'stopped' }),
      f.request.jobId,
    );
    const sourceBefore = await readFile(path.join(catalog.directory, 'image.png'));
    assert.equal(
      (await manager.snapshot()).entries.find((entry) => entry.stageId === f.owner.stageId)
        ?.eligible,
      true,
    );
    await assert.rejects(manager.clean({ stageIds: [f.owner.stageId, f.owner.stageId] }));
    const cleaning = manager.clean({ stageIds: [f.owner.stageId, randomUUID()] });
    await assert.rejects(manager.clean({ stageIds: [f.owner.stageId] }), /缓存清理正在执行/);
    const result = await cleaning;
    assert.deepEqual(
      result.results.map((entry) => entry.cleaned),
      [true, false],
    );
    assert.equal((await manager.snapshot()).entries.length, 0);
    const completed = await store.cacheCleanup.get(f.owner.stageId);
    assert.equal(completed.state, 'CLEANED');
    assert.equal(completed.plan.closedTab.state, 'RELEASED');
    assert.equal(
      (await store.taskTabs.get(tab.proof.ownershipId, f.request.jobId)).state,
      'RELEASED',
    );
    assert.deepEqual(await readFile(path.join(catalog.directory, 'image.png')), sourceBefore);
    assert.equal((await store.materialPosts.result(f.request.attemptId))?.outcome, 'PUBLISHED');
    await assert.rejects(lstat(path.join(f.disk.cacheRoot, f.owner.stageId)), { code: 'ENOENT' });
  });
});

test('actual generated cache cleanup preserves source and publication/archival facts for all three media formats', async () => {
  for (const source of ['image.png', 'album', 'video.mp4'])
    await postFixture(async (store, file, catalog) => {
      const f = await setup(store, file, catalog.directory, source),
        control = await settle(store, f);
      assert.ok(f.manifest);
      const sourceBytes = await Promise.all(
        f.intent.snapshot.files.map((row) =>
          readFile(path.join(f.intent.directory, row.relativePath)),
        ),
      );
      const result = await cleaner(store, f).run(f.owner.stageId, control.requestId);
      assert.equal(result.state, 'CLEANED');
      assert.equal(result.files.length, f.manifest.files.length + 1);
      assert.ok(result.files.every((row) => row.state === 'DELETED'));
      await assert.rejects(lstat(path.join(f.disk.cacheRoot, f.owner.stageId)), { code: 'ENOENT' });
      assert.deepEqual(
        await Promise.all(
          f.intent.snapshot.files.map((row) =>
            readFile(path.join(f.intent.directory, row.relativePath)),
          ),
        ),
        sourceBytes,
      );
      assert.equal((await store.materialPosts.result(f.request.attemptId))?.outcome, 'PUBLISHED');
      assert.equal((await store.materialPosts.archives()).length, 1);
      assert.equal((await store.tasks.steps(f.request.jobId))[0]?.progress.published, 1);
      assert.deepEqual(await cleaner(store, f).run(f.owner.stageId, control.requestId), result);
      const reopened = await WorkspaceStore.open(file);
      try {
        assert.deepEqual(reopened.cacheCleanup.get(f.owner.stageId), result);
        assert.equal(reopened.cacheCleanup.recoverOnStartup(), 0);
      } finally {
        reopened.close();
      }
      const manifest = f.manifest;
      await assert.rejects(async () => await store.uploadStages.assertReady(manifest), /NOT_READY/);
    });
});

test('independently settled NOT_PUBLISHED permits cache cleanup without consuming or archiving content', async () => {
  await postFixture(async (store, file, catalog) => {
    const f = await setup(store, file, catalog.directory),
      control = await settle(store, f, 'NOT_PUBLISHED');
    await cleaner(store, f).run(f.owner.stageId, control.requestId);
    assert.equal((await store.materialPosts.result(f.request.attemptId))?.outcome, 'NOT_PUBLISHED');
    assert.equal((await store.materialPosts.archives()).length, 0);
    assert.equal((await store.tasks.steps(f.request.jobId))[0]?.progress.published, 0);
  });
});

test('ACK, unknown business and auxiliary APPLIED never authorize cache deletion', async () => {
  for (const state of ['ACK', 'UNKNOWN', 'AUX'])
    await postFixture(async (store, file, catalog) => {
      const f = await setup(store, file, catalog.directory);
      if (state === 'ACK')
        await store.tasks.acknowledgeBound({
          binding: f.operation.binding,
          evidence: { transport: true },
        });
      if (state === 'UNKNOWN')
        await store.tasks.markBoundUnknown(f.operation.binding, 'simulated uncertain');
      if (state === 'AUX')
        await store.materialPosts.verify(await postReceipt(store, f.request, f.operation));
      await assert.rejects(
        async () => await store.cacheCleanup.prepare(f.owner.stageId, randomUUID()),
        /BUSINESS_UNRESOLVED/,
      );
      assert.ok(await readFile(path.join(f.disk.cacheRoot, f.owner.stageId, 'ready.json')));
      assert.equal((await store.uploadStages.get(f.owner.stageId)).state, 'READY');
    });
});

test('unknown/missing native close or a different original lease cannot authorize cleanup despite a settled publication', async () => {
  await postFixture(async (store, file, catalog) => {
    const f = await setup(store, file, catalog.directory),
      control = await settle(store, f, 'PUBLISHED', false);
    await assert.rejects(
      async () => await store.cacheCleanup.prepare(f.owner.stageId, control.requestId),
      /NATIVE_CLOSE_REQUIRED/,
    );
    const tab = await store.taskTabs.get(f.intent.proof.ownershipId);
    await store.taskTabs.markLost(tab.proof.ownershipId, tab.revision, 'simulated lost');
    await assert.rejects(
      async () => await store.cacheCleanup.prepare(f.owner.stageId, control.requestId),
      /NATIVE_CLOSE_REQUIRED/,
    );
  });
  await postFixture(async (store, file, catalog) => {
    const f = await setup(store, file, catalog.directory),
      control = await settle(store, f, 'PUBLISHED', true, true);
    await assert.rejects(
      async () => await store.cacheCleanup.prepare(f.owner.stageId, control.requestId),
      /STOP_MISMATCH/,
    );
  });
  await postFixture(async (store, file, catalog) => {
    const f = await setup(store, file, catalog.directory);
    await settle(store, f);
    await assert.rejects(
      async () => await store.cacheCleanup.prepare(f.owner.stageId, randomUUID()),
      /NATIVE_STOP_REQUIRED/,
    );
  });
});

test('missing durable manifest preserves partial ownership instead of pretending it is a complete reclaimable stage', async () => {
  await postFixture(async (store, file, catalog) => {
    const f = await setup(store, file, catalog.directory, 'image.png', false),
      control = await settle(store, f, 'NOT_PUBLISHED');
    await assert.rejects(
      async () => await store.cacheCleanup.prepare(f.owner.stageId, control.requestId),
      /MANIFEST_REQUIRED/,
    );
    assert.equal((await store.uploadStages.get(f.owner.stageId)).state, 'WRITING');
  });
});

test('unexpected members, modified contents or missing files without deletion intent retain all capacity', async () => {
  for (const changed of ['extra', 'tamper', 'missing'])
    await postFixture(async (store, file, catalog) => {
      const f = await setup(store, file, catalog.directory),
        control = await settle(store, f);
      assert.ok(f.manifest);
      const folder = path.join(f.disk.cacheRoot, f.owner.stageId),
        media = f.manifest.files[0];
      assert.ok(media);
      if (changed === 'extra') await writeFile(path.join(folder, 'unowned.txt'), 'keep');
      if (changed === 'tamper') {
        await chmod(path.join(folder, media.name), 0o600);
        await writeFile(path.join(folder, media.name), Buffer.concat([png, Buffer.from([1])]));
      }
      if (changed === 'missing') await unlink(path.join(folder, media.name));
      await assert.rejects(cleaner(store, f).run(f.owner.stageId, control.requestId));
      const result = await store.cacheCleanup.get(f.owner.stageId);
      assert.equal(result.state, 'REVIEW');
      assert.equal(result.files.length, 0);
      assert.ok(await readFile(path.join(folder, 'ready.json')));
      if (changed === 'extra')
        assert.equal(await readFile(path.join(folder, 'unowned.txt'), 'utf8'), 'keep');
    });
});

test('directory junctions and a wrong cache root never delete another directory', async () => {
  await postFixture(async (store, file, catalog) => {
    const f = await setup(store, file, catalog.directory),
      control = await settle(store, f);
    const folder = path.join(f.disk.cacheRoot, f.owner.stageId),
      retained = folder + '-retained',
      outside = path.join(path.dirname(file), 'outside-cache');
    assert.equal(path.dirname(retained), f.disk.cacheRoot);
    assert.equal(path.dirname(outside), path.dirname(file));
    await mkdir(outside);
    await writeFile(path.join(outside, 'sentinel.txt'), 'keep');
    await rename(folder, retained);
    await symlink(outside, folder, 'junction');
    await assert.rejects(
      cleaner(store, f).run(f.owner.stageId, control.requestId),
      /DIRECTORY_CHANGED/,
    );
    assert.equal(await readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'keep');
    assert.ok(await readFile(path.join(retained, 'ready.json')));
    const wrong = new MaterialCacheCleanup(
      store.cacheCleanup,
      new FilesystemMaterialCacheCleaner(store.cacheCleanup, outside),
    );
    await assert.rejects(wrong.run(f.owner.stageId, control.requestId), /PATH_SCOPE/);
  });
});

class LostFileReceipt extends SqliteMaterialCacheCleanupRepository {
  override deletedFile(_claim: CleanupClaim, _name: string): void {
    throw Error('SIMULATED_FILE_RECEIPT_LOST');
  }
}
class LostDirectoryReceipt extends SqliteMaterialCacheCleanupRepository {
  override complete(_claim: CleanupClaim, _completion: CleanupCompletion): void {
    throw Error('SIMULATED_DIRECTORY_RECEIPT_LOST');
  }
}
test('crash after unlink recovers only the original persisted delete intent; stale claims and overlapping workers are rejected', async () => {
  await postFixture(async (store, file, catalog) => {
    const f = await setup(store, file, catalog.directory, 'album'),
      control = await settle(store, f);
    const prepared = await store.cacheCleanup.prepare(f.owner.stageId, control.requestId),
      claim = await store.cacheCleanup.claim(f.owner.stageId, prepared.revision);
    await assert.rejects(
      async () => await store.cacheCleanup.claim(f.owner.stageId, prepared.revision),
      /CLAIM_REJECTED/,
    );
    const db = new DatabaseSync(file),
      fault = new LostFileReceipt(db, store.uploadStages, store.taskTabs);
    try {
      await assert.rejects(
        new FilesystemMaterialCacheCleaner(fault, f.disk.cacheRoot).clean(claim),
        /SIMULATED_FILE_RECEIPT_LOST/,
      );
    } finally {
      db.close();
    }
    const interrupted = await store.cacheCleanup.get(f.owner.stageId);
    assert.equal(interrupted.state, 'DELETING');
    assert.equal(interrupted.files.length, 1);
    assert.equal(interrupted.files[0]?.state, 'DELETING');
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(reopened.cacheCleanup.get(f.owner.stageId), interrupted);
      assert.equal(reopened.cacheCleanup.recoverOnStartup(), 1);
      await assert.rejects(
        async () => await store.cacheCleanup.assertCurrent(claim),
        /CLAIM_REVOKED/,
      );
      const result = await new MaterialCacheCleanup(
        reopened.cacheCleanup,
        new FilesystemMaterialCacheCleaner(reopened.cacheCleanup, f.disk.cacheRoot),
      ).run(f.owner.stageId, control.requestId);
      assert.equal(result.state, 'CLEANED');
      assert.equal(result.files.length, 3);
    } finally {
      reopened.close();
    }
  });
});

test('crash after nonrecursive directory removal resumes from its durable intent and never replays publication', async () => {
  await postFixture(async (store, file, catalog) => {
    const f = await setup(store, file, catalog.directory),
      control = await settle(store, f),
      prepared = await store.cacheCleanup.prepare(f.owner.stageId, control.requestId),
      claim = await store.cacheCleanup.claim(f.owner.stageId, prepared.revision);
    const db = new DatabaseSync(file),
      fault = new LostDirectoryReceipt(db, store.uploadStages, store.taskTabs);
    try {
      await assert.rejects(
        new FilesystemMaterialCacheCleaner(fault, f.disk.cacheRoot).clean(claim),
        /SIMULATED_DIRECTORY_RECEIPT_LOST/,
      );
    } finally {
      db.close();
    }
    const interrupted = await store.cacheCleanup.get(f.owner.stageId);
    assert.equal(interrupted.directoryRemovalStarted, true);
    assert.ok(interrupted.files.every((row) => row.state === 'DELETED'));
    await store.cacheCleanup.recoverOnStartup();
    assert.equal(
      (await cleaner(store, f).run(f.owner.stageId, control.requestId)).state,
      'CLEANED',
    );
    assert.equal((await store.tasks.steps(f.request.jobId))[0]?.progress.published, 1);
    assert.equal((await store.materialPosts.archives()).length, 1);
  });
});

test('cleanup completion and capacity release are atomic; failed commit leaves a retryable directory intent', async () => {
  await postFixture(async (store, file, catalog) => {
    const f = await setup(store, file, catalog.directory),
      control = await settle(store, f),
      db = new DatabaseSync(file);
    try {
      db.exec(
        "CREATE TRIGGER fail_cleanup_commit BEFORE UPDATE ON material_cache_cleanup_state WHEN NEW.state='CLEANED' BEGIN SELECT RAISE(ABORT,'SIMULATED_COMPLETION_COMMIT_FAILED'); END",
      );
      await assert.rejects(
        cleaner(store, f).run(f.owner.stageId, control.requestId),
        /SIMULATED_COMPLETION_COMMIT_FAILED/,
      );
      assert.equal((await store.cacheCleanup.get(f.owner.stageId)).state, 'REVIEW');
      assert.equal(
        db.prepare('SELECT count(*) AS n FROM material_cache_cleanup_completions').get()?.n,
        0,
      );
      db.exec('DROP TRIGGER fail_cleanup_commit');
      await cleaner(store, f).run(f.owner.stageId, control.requestId);
      assert.equal(
        db.prepare('SELECT count(*) AS n FROM material_cache_cleanup_completions').get()?.n,
        1,
      );
      assert.throws(
        () => db.exec('DELETE FROM material_cache_cleanup_completions'),
        /RETAIN_CACHE_CLEANUP_RECORD/,
      );
      assert.throws(
        () => db.exec("UPDATE material_cache_cleanup_requests SET body='{}'"),
        /IMMUTABLE_CACHE_CLEANUP_RECORD/,
      );
      assert.throws(
        () => db.exec("UPDATE material_cache_cleanup_files SET body='{}'"),
        /CACHE_CLEANUP_FILE_TRANSITION/,
      );
    } finally {
      db.close();
    }
  });
});

test('cleaned payload capacity becomes reusable for new operations, while the original binding can never restage', async () => {
  await postFixture(async (store, file, catalog) => {
    const f = await setup(store, file, catalog.directory),
      control = await settle(store, f),
      other = await postRequest(store, f.catalog, { source: 'different.png' });
    await store.materials.reserve(other);
    const second = await dispatchedPost(store, other, 'UPLOAD_MEDIA'),
      intent = (await store.materials.reservation(other.attemptId)).intent;
    await assert.rejects(
      async () =>
        await store.uploadStages.reserve(intent, second.binding, f.disk.cacheRoot, png.length + 1),
      /RETAINED_BUDGET/,
    );
    await cleaner(store, f).run(f.owner.stageId, control.requestId);
    assert.ok(
      await store.uploadStages.reserve(intent, second.binding, f.disk.cacheRoot, png.length + 1),
    );
    assert.equal((await store.uploadStages.list()).length, 2);
    assert.ok(f.manifest);
    const manifest = f.manifest;
    await assert.rejects(async () => await store.uploadStages.assertReady(manifest), /NOT_READY/);
  });
});

test('schema10 upgrade retains READY cache and original binding without auto-cleaning or recovering it', async () => {
  await postFixture(async (store, file, catalog) => {
    const f = await setup(store, file, catalog.directory),
      before = await store.uploadStages.get(f.owner.stageId),
      db = new DatabaseSync(file);
    db.exec(dropMaterialCacheCleanupSchema + 'PRAGMA user_version=10');
    db.close();
    const upgraded = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(upgraded.uploadStages.get(f.owner.stageId), before);
      assert.equal(upgraded.tasks.operations(f.request.jobId)[0]?.status, 'DISPATCHING');
      const saved = (await readdir(path.dirname(file))).find((name) =>
        name.includes(latestMigrationBackupMarker),
      );
      assert.ok(saved);
      const backup = new DatabaseSync(path.join(path.dirname(file), saved), { readOnly: true });
      try {
        assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 10);
        assert.equal(
          backup.prepare('SELECT count(*) AS n FROM material_upload_stage_manifests').get()?.n,
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

test('undelivered settlement notification prevents cleanup until the original notice is reconciled', async () => {
  await postFixture(async (store, file, catalog) => {
    const f = await setup(store, file, catalog.directory);
    await store.materialPosts.verify(await postReceipt(store, f.request, f.operation));
    await deliverPostNotices(store, f.request.context.profileId);
    const submit = await dispatchedPost(store, f.request, 'SUBMIT');
    await store.materialPosts.verify(await postReceipt(store, f.request, submit));
    const control = await stop(store, f);
    await close(store, f);
    await assert.rejects(
      async () => await store.cacheCleanup.prepare(f.owner.stageId, control.requestId),
      /NOTICE_PENDING/,
    );
    assert.ok(await readFile(path.join(f.disk.cacheRoot, f.owner.stageId, 'ready.json')));
    await deliverPostNotices(store, f.request.context.profileId);
    assert.equal(
      (await cleaner(store, f).run(f.owner.stageId, control.requestId)).state,
      'CLEANED',
    );
  });
});

test('failed preparation rolls back READY revocation and persists no partial cleanup request', async () => {
  await postFixture(async (store, file, catalog) => {
    const f = await setup(store, file, catalog.directory),
      control = await settle(store, f);
    const original = await store.uploadStages.get(f.owner.stageId),
      db = new DatabaseSync(file);
    try {
      db.exec(
        "CREATE TRIGGER fail_cleanup_prepare BEFORE INSERT ON material_cache_cleanup_state BEGIN SELECT RAISE(ABORT,'SIMULATED_PREPARATION_FAILED'); END",
      );
      await assert.rejects(
        async () => await store.cacheCleanup.prepare(f.owner.stageId, control.requestId),
        /SIMULATED_PREPARATION_FAILED/,
      );
      assert.deepEqual(await store.uploadStages.get(f.owner.stageId), original);
      assert.equal(
        db.prepare('SELECT count(*) AS n FROM material_cache_cleanup_requests').get()?.n,
        0,
      );
      db.exec('DROP TRIGGER fail_cleanup_prepare');
      assert.equal(
        (await cleaner(store, f).run(f.owner.stageId, control.requestId)).state,
        'CLEANED',
      );
    } finally {
      db.close();
    }
  });
});
