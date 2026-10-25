import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import { prepareBound } from './fixtures/settlement.js';
import {
  dropStoryPrivacySchema,
  latestMigrationBackupMarker,
} from './fixtures/workspace-schema.js';
import { postFixture, postRequest, postAction } from './fixtures/material-post.js';
import { storyPrivacyTargets } from '../src/shared/facebook-story-privacy.js';

test('schema30 story privacy gate backs up and preserves original UNKNOWN, controls and preferences', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-story-privacy-upgrade-'));
  const file = path.join(directory, 'workspace.sqlite');
  let store = await WorkspaceStore.open(file);
  try {
    const original = await prepareBound(store);
    store.tasks.markBoundUnknown(original.binding, 'GENERATED_UNKNOWN');
    const operations = store.tasks.operations(original.plan.id),
      plan = store.tasks.get(original.plan.id);
    const preferences = store.preferences();
    store.close();
    const old = new DatabaseSync(file);
    old.exec(dropStoryPrivacySchema + 'PRAGMA user_version=30');
    old.close();
    store = await WorkspaceStore.open(file);
    assert.deepEqual(store.tasks.operations(original.plan.id), operations);
    assert.deepEqual(store.tasks.get(original.plan.id), plan);
    assert.deepEqual(store.preferences(), preferences);
    const check = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(
        check.prepare('PRAGMA user_version').get()?.user_version,
        workspaceSchemaVersion,
      );
      assert.equal(
        check
          .prepare(
            "SELECT version FROM workspace_execution_contracts WHERE name='story-friends-privacy'",
          )
          .get()?.version,
        1,
      );
      for (const name of [
        'one_original_story_friends',
        'one_original_story_audience_check',
        'one_original_story_audience_close',
      ])
        assert.ok(check.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name));
    } finally {
      check.close();
    }
    assert.ok(
      (await readdir(directory)).some((name) => name.includes(latestMigrationBackupMarker)),
    );
  } finally {
    store.close();
    assert.equal(path.dirname(directory), tmpdir());
    await rm(directory, { recursive: true, force: true });
  }
});

test('story privacy purposes reject ordinary post steps and off-scope targets before creating an outbox', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const target = storyPrivacyTargets.selectFriends;
    const operation = {
      ...(await postAction(store, r, 'SELECT_FRIENDS')),
      action: {
        kind: 'click' as const,
        tabId: r.proof.tabId,
        documentEpoch: 0,
        routeEpoch: 0,
        target,
      },
    };
    await assert.rejects(
      async () => await store.materialPosts.prepare(operation),
      /STORY_PRIVACY_STEP_REQUIRED/,
    );
    assert.equal((await store.tasks.operations(r.jobId)).length, 0);
  }, false);
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog, { destination: 'story', audience: 'friends' });
    await store.materials.reserve(r);
    const operation = {
      ...(await postAction(store, r, 'SELECT_FRIENDS')),
      action: {
        kind: 'click' as const,
        tabId: r.proof.tabId,
        documentEpoch: 0,
        routeEpoch: 0,
        target: storyPrivacyTargets.selectFriends,
      },
    };
    await assert.rejects(
      async () =>
        await store.materialPosts.prepare({
          ...operation,
          operationId: randomUUID(),
          action: { ...operation.action, target: { ...operation.action.target, text: 'Public' } },
        }),
      /STORY_PRIVACY_TARGET_MISMATCH/,
    );
    const prepared = await store.materialPosts.prepare(operation);
    assert.equal(prepared.status, 'PREPARED');
    assert.equal((await store.materialPosts.link(prepared.id)).purpose, 'SELECT_FRIENDS');
    assert.equal((await store.tasks.steps(r.jobId))[0]?.progress.published, 0);
    assert.equal(await store.materialPosts.result(r.attemptId), null);
  }, false);
});
