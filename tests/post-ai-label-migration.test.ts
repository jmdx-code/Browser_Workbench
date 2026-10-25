import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import { settlementFixture, prepareBound } from './fixtures/settlement.js';
import { dropAILabelSchema } from './fixtures/workspace-schema.js';

test('schema32 adds AI operation contracts and unique purposes without rewriting schema31 task history', async () => {
  await settlementFixture(async (store, file) => {
    const original = await prepareBound(store);
    await store.tasks.markBoundUnknown(original.binding, 'GENERATED_OLD_UNKNOWN');
    const before = {
      plan: await store.tasks.get(original.plan.id),
      steps: await store.tasks.steps(original.plan.id),
      operations: await store.tasks.operations(original.plan.id),
    };
    const old = new DatabaseSync(file);
    old.exec(dropAILabelSchema + 'PRAGMA user_version=31');
    old.close();
    const upgraded = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(
        {
          plan: upgraded.tasks.get(original.plan.id),
          steps: upgraded.tasks.steps(original.plan.id),
          operations: upgraded.tasks.operations(original.plan.id),
        },
        before,
      );
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, workspaceSchemaVersion);
        assert.equal(
          db
            .prepare("SELECT version FROM workspace_execution_contracts WHERE name='post-ai-label'")
            .get()?.version,
          1,
        );
        assert.equal(
          db
            .prepare(
              "SELECT count(*) AS count FROM sqlite_master WHERE type='index' AND name IN ('one_original_post_ai_open','one_original_post_ai_set','one_original_post_ai_confirm')",
            )
            .get()?.count,
          3,
        );
      } finally {
        db.close();
      }
    } finally {
      upgraded.close();
    }
  });
});
