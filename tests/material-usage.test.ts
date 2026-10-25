import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import {
  postFixture,
  postRequest,
  dispatchedPost,
  postReceipt,
  deliverPostNotices,
} from './fixtures/material-post.js';
import type { ReservationRequest } from '../src/shared/material-index.js';
import { dropMaterialUsageSchema } from './fixtures/workspace-schema.js';

async function publish(store: WorkspaceStore, request: ReservationRequest) {
  await store.materials.reserve(request);
  const op = await dispatchedPost(store, request),
    receipt = await postReceipt(store, request, op, 'PUBLISHED');
  await store.materialPosts.verify(receipt);
  await deliverPostNotices(store, request.context.profileId);
  return receipt;
}
const next = async (store: WorkspaceStore, request: ReservationRequest) => ({
  ...request,
  attemptId: randomUUID(),
  expectedProgressRevision: (await store.tasks.steps(request.jobId))[0]?.progress.revision ?? -1,
});

test('production publishes mark the source used without archiving; same bytes in another source are allowed and do not trigger content deduplication', async () => {
  await postFixture(async (store, file, catalog) => {
    const request = await postRequest(store, catalog, { count: 2 });
    const source = path.join(catalog.directory, 'text.txt'),
      before = await readFile(source);
    await publish(store, request);
    await assert.rejects(
      async () => await store.materials.reserve(await next(store, request)),
      /ALREADY_CONSUMED/,
    );
    const copy = catalog.sources.find((item) => item.snapshot.source === 'copy.txt');
    assert.ok(copy);
    const other = { ...(await next(store, request)), sourceId: copy.id };
    await publish(store, other);
    assert.equal((await store.materialUsage.snapshot()).published, 2);
    assert.equal((await store.materialUsage.snapshot()).contents, 2);
    assert.deepEqual(await readFile(source), before);
    assert.deepEqual((await readdir(catalog.directory)).sort(), [
      'copy.txt',
      'other.txt',
      'text.txt',
    ]);
    assert.equal((await store.materialPosts.archives()).length, 0);
    const db = new DatabaseSync(file);
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM material_archive_requests').get()?.n, 0);
    } finally {
      db.close();
    }
  }, false);
});

test('explicit allowRepeat permits same source and same account to publish twice under separate attempts without changing old receipts', async () => {
  await postFixture(async (store, _file, catalog) => {
    const request = await postRequest(store, catalog, { count: 2, allowRepeat: true });
    const first = await publish(store, request),
      prior = await store.materialPosts.result(request.attemptId);
    const repeated = await next(store, request),
      second = await publish(store, repeated);
    assert.equal(first.evidence.observedAccountId, second.evidence.observedAccountId);
    assert.notEqual(first.evidence.postId, second.evidence.postId);
    assert.deepEqual(await store.materialPosts.result(request.attemptId), prior);
    assert.equal((await store.materialUsage.snapshot()).published, 2);
    assert.equal((await store.materialUsage.snapshot()).contents, 1);
    assert.equal((await store.materialPosts.archives()).length, 0);
  }, false);
});

test('manual clear resets only usage, survives reopen and is idempotent after later publications; original task/receipt evidence stays unchanged', async () => {
  await postFixture(async (store, file, catalog) => {
    const request = await postRequest(store, catalog);
    await publish(store, request);
    await store.tasks.completeStep(request.jobId, request.stepId);
    const original = await store.materialPosts.result(request.attemptId),
      plan = await store.tasks.get(request.jobId);
    const usage = await store.materialUsage.snapshot();
    const clear = {
      requestId: randomUUID(),
      expectedGeneration: usage.generation,
      expectedPublished: usage.published,
    };
    const result = await store.materialUsage.clear(clear);
    assert.equal(result.clearedPublications, 1);
    assert.equal((await store.materialUsage.snapshot()).published, 0);
    assert.deepEqual(await store.tasks.get(request.jobId), plan);
    assert.deepEqual(await store.materialPosts.result(request.attemptId), original);
    const repeated = await postRequest(store, catalog, { accountId: request.context.accountId });
    await publish(store, repeated);
    await store.tasks.completeStep(repeated.jobId, repeated.stepId);
    assert.equal((await store.materialUsage.snapshot()).published, 1);
    assert.deepEqual(await store.materialUsage.clear(clear), result);
    assert.equal((await store.materialUsage.snapshot()).published, 1);
    await assert.rejects(
      async () => await store.materialUsage.clear({ ...clear, requestId: randomUUID() }),
      /已变化/,
    );
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.equal(reopened.materialUsage.snapshot().generation, 1);
      assert.equal(reopened.materialUsage.snapshot().published, 1);
      assert.deepEqual(reopened.materialPosts.result(request.attemptId), original);
    } finally {
      reopened.close();
    }
    const db = new DatabaseSync(file);
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM material_publications').get()?.n, 2);
    } finally {
      db.close();
    }
  }, false);
});

test('clear rejects an active publishing plan and never releases an original reservation', async () => {
  await postFixture(async (store, _file, catalog) => {
    const request = await postRequest(store, catalog);
    await store.materials.reserve(request);
    const before = await store.materials.reservation(request.attemptId);
    await assert.rejects(
      async () =>
        await store.materialUsage.clear({
          requestId: randomUUID(),
          expectedGeneration: 0,
          expectedPublished: 0,
        }),
      /先停止/,
    );
    assert.deepEqual(await store.materials.reservation(request.attemptId), before);
    assert.equal((await store.materialUsage.snapshot()).generation, 0);
  }, false);
});

test('schema19 upgrade preserves a published receipt, archive history and their foreign keys while defaulting new product behavior to retain files', async () => {
  await postFixture(async (store, file, catalog) => {
    const request = await postRequest(store, catalog);
    await publish(store, request);
    const original = await store.materialPosts.result(request.attemptId),
      archived = await store.materialPosts.archives();
    const legacy = new DatabaseSync(file);
    try {
      legacy.exec(dropMaterialUsageSchema + 'PRAGMA user_version=19');
    } finally {
      legacy.close();
    }
    const upgraded = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(upgraded.materialPosts.result(request.attemptId), original);
      assert.deepEqual(upgraded.materialPosts.archives(), archived);
      assert.equal(upgraded.materialUsage.snapshot().published, 1);
      const db = new DatabaseSync(file);
      try {
        assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, workspaceSchemaVersion);
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        assert.equal(
          db.prepare('SELECT file_policy FROM material_usage_policy').get()?.file_policy,
          'retain',
        );
      } finally {
        db.close();
      }
      const backups = await readdir(path.dirname(file));
      assert.ok(backups.some((name) => name.includes('.before-v' + workspaceSchemaVersion + '-')));
    } finally {
      upgraded.close();
    }
  });
});
