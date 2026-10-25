import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { prepareBound } from './fixtures/settlement.js';
import {
  latestMigrationBackupMarker,
  dropStoryPrivacySchema,
} from './fixtures/workspace-schema.js';

test('schema29 background gate adds no fabricated verdict, preserves UNKNOWN and preferences, and backs up before new purposes can persist', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-background-upgrade-')),
    file = path.join(directory, 'workspace.sqlite');
  let store = await WorkspaceStore.open(file);
  try {
    const bound = await prepareBound(store);
    store.tasks.markBoundUnknown(bound.binding, 'GENERATED_UNCONFIRMED');
    const original = store.tasks.operations(bound.plan.id),
      plan = store.tasks.get(bound.plan.id);
    store.updateMaintenanceSettings({ expectedRevision: 0, logRetentionDays: 7 });
    const preferences = store.preferences();
    store.close();
    const old = new DatabaseSync(file);
    old.exec(
      dropStoryPrivacySchema +
        "DROP INDEX one_original_post_background; DELETE FROM workspace_execution_contracts WHERE name='post-native-background'; PRAGMA user_version=29",
    );
    old.close();
    store = await WorkspaceStore.open(file);
    assert.deepEqual(store.tasks.operations(bound.plan.id), original);
    assert.deepEqual(store.tasks.get(bound.plan.id), plan);
    assert.deepEqual(store.preferences(), preferences);
    assert.equal(store.maintenanceSettings().logRetentionDays, 7);
    assert.equal(store.materialPosts.result(bound.binding.operationId), null);
    const migrated = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(
        migrated
          .prepare(
            "SELECT version FROM workspace_execution_contracts WHERE name='post-native-background'",
          )
          .get()?.version,
        1,
      );
      assert.ok(
        migrated
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='index' AND name='one_original_post_background'",
          )
          .get(),
      );
    } finally {
      migrated.close();
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
