import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import { WorkspaceService } from '../src/application/workspace-service.js';
import {
  CombinationSchema,
  CombinationDraftSchema,
  StopResultsSchema,
  type Combination,
  type Profile,
} from '../src/shared/contracts.js';
import { toggleSet, selectionState } from '../src/renderer/selection.js';
import { dropMaterialUsageSchema, dropStoryPrivacySchema } from './fixtures/workspace-schema.js';

test('schema25 upgrades the preparation contract with backup while retaining original saved versions and paused work', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-preparation-upgrade-'));
  const file = path.join(directory, 'workspace.sqlite');
  try {
    const initial = await WorkspaceStore.open(file);
    const saved = initial.createCombination(combination());
    initial.close();
    const previous = new DatabaseSync(file);
    previous.exec(
      dropStoryPrivacySchema +
        "DROP INDEX one_original_post_background; DROP TABLE workspace_preferences; DELETE FROM workspace_execution_contracts WHERE name IN ('post-native-background','post-home-preparation','browse-wheel-visual-anchor'); PRAGMA user_version=25",
    );
    previous.close();
    const migrated = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(migrated.combinations()[0], saved);
    } finally {
      migrated.close();
    }
    const check = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(
        check.prepare('PRAGMA user_version').get()?.user_version,
        workspaceSchemaVersion,
      );
      assert.equal(
        check
          .prepare(
            "SELECT version FROM workspace_execution_contracts WHERE name='post-home-preparation'",
          )
          .get()?.version,
        1,
      );
    } finally {
      check.close();
    }
    assert.ok(
      (await readdir(directory)).some((name) =>
        name.includes('.before-v' + workspaceSchemaVersion + '-'),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function combination(): Combination {
  return {
    name: '活跃1',
    note: '完整四步验收配置',
    steps: [
      { id: randomUUID(), type: 'video', durationMinutes: 15, maxLikes: 2, minLikeCount: 500 },
      { id: randomUUID(), type: 'feed', durationMinutes: 4, maxLikes: 1, minLikeCount: 200 },
      {
        id: randomUUID(),
        type: 'post',
        resourceDirectory: 'D:\\素材',
        count: 1,
        allowRepeat: false,
        forbidSameAccountRepeat: true,
        archivePublished: true,
      },
      { id: randomUUID(), type: 'feed', durationMinutes: 8, maxLikes: 0, minLikeCount: 200 },
    ],
    randomOrder: true,
    loop: { mode: 'finite', rounds: 3 },
  };
}
async function withStore(run: (store: WorkspaceStore, file: string) => Promise<void> | void) {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-store-'));
  const file = path.join(dir, 'workspace.sqlite');
  const store = await WorkspaceStore.open(file);
  try {
    await run(store, file);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('Marketplace task compatibility gate upgrades18 with backup, retaining original combinations and scheduler settings', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-marketplace-migration-'));
  const file = path.join(dir, 'workspace.sqlite');
  try {
    const original = await WorkspaceStore.open(file);
    const row = original.createCombination(combination());
    original.tasks.setSettings({ maxConcurrentProfiles: 4 });
    original.close();
    const old = new DatabaseSync(file);
    old.exec(
      dropMaterialUsageSchema +
        "DELETE FROM workspace_execution_contracts WHERE name IN ('marketplace-task','task-page-lifecycle'); PRAGMA user_version=18",
    );
    old.close();
    const migrated = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(migrated.combinations()[0], row);
      assert.equal(migrated.tasks.settings().maxConcurrentProfiles, 4);
      const market = {
        ...combination(),
        name: '商城组合',
        steps: [
          {
            id: randomUUID(),
            type: 'marketplace' as const,
            durationMinutes: 4,
            keyword: '手机',
            maxLikes: 0 as const,
            minLikeCount: 0 as const,
          },
        ],
      };
      assert.equal(migrated.createCombination(market).saved?.steps[0]?.type, 'marketplace');
      assert.equal(
        CombinationSchema.safeParse({ ...market, steps: [{ ...market.steps[0], maxLikes: 1 }] })
          .success,
        false,
      );
      const db = new DatabaseSync(file);
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, workspaceSchemaVersion);
      assert.equal(
        db
          .prepare(
            "SELECT version FROM workspace_execution_contracts WHERE name='marketplace-task'",
          )
          .get()?.version,
        1,
      );
      db.close();
      assert.equal(
        (await readdir(dir)).filter((name) =>
          name.includes('.before-v' + workspaceSchemaVersion + '-'),
        ).length,
        1,
      );
    } finally {
      migrated.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('four-step contract preserves repeated feed steps and rejects duplicate step identity', () => {
  const value = combination();
  assert.equal(CombinationSchema.parse(value).steps.length, 4);
  const first = value.steps[0];
  const last = value.steps[3];
  assert.ok(first && last);
  last.id = first.id;
  assert.equal(CombinationSchema.safeParse(value).success, false);
  assert.equal(CombinationDraftSchema.safeParse(value).success, false);
});
test('finite round validation and account repeat protection cannot silently weaken', () => {
  const value = combination();
  assert.equal(
    CombinationSchema.safeParse({ ...value, loop: { mode: 'finite', rounds: 0 } }).success,
    false,
  );
  assert.equal(
    CombinationSchema.safeParse({
      ...value,
      steps: [{ ...value.steps[2], forbidSameAccountRepeat: false }],
    }).success,
    false,
  );
});
test('saved versions stay immutable while a draft is edited, published, and discarded', async () => {
  await withStore(async (store, file) => {
    const original = await store.createCombination(combination());
    const edited = { ...combination(), name: '活跃2' };
    const draft = await store.writeDraft(original.id, 0, edited);
    assert.equal(draft.saved?.name, '活跃1');
    assert.equal(draft.draft?.name, '活跃2');
    await assert.rejects(async () => await store.writeDraft(original.id, 0, edited), /其他窗口/);
    const published = await store.publish(original.id, draft.revision);
    assert.equal(published.version, 2);
    assert.equal(published.saved?.name, '活跃2');
    assert.equal(published.draft, null);
    const db = new DatabaseSync(file);
    try {
      const row = db.prepare('SELECT body FROM combination_versions WHERE version=1').get();
      assert.equal(JSON.parse(String(row?.body)).name, '活跃1');
      assert.throws(
        () => db.prepare('UPDATE combination_versions SET body=? WHERE version=1').run('{}'),
        /IMMUTABLE/,
      );
    } finally {
      db.close();
    }
    const next = await store.writeDraft(original.id, published.revision, {
      ...edited,
      name: '草稿3',
    });
    const discarded = await store.discardDraft(original.id, next.revision);
    assert.equal(discarded.saved?.name, '活跃2');
    assert.equal(discarded.draft, null);
  });
});
test('groups, bulk transfers, aliases and unsaved drafts persist after database reopen', async () => {
  await withStore(async (store, file) => {
    const group = await store.createGroup('主力', 'green');
    await assert.rejects(async () => await store.createGroup('主力', 'blue'), /已存在/);
    const ids = Array.from({ length: 29 }, () => randomUUID());
    await store.moveProfiles(ids, group.id);
    await store.renameProfile(ids[0] ?? '', 'Chrome 004');
    const saved = await store.createCombination(combination());
    await store.writeDraft(saved.id, saved.revision, { ...combination(), name: '待保存草稿' });
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.equal(reopened.groups()[0]?.name, '主力');
      assert.equal(reopened.profileMetadata().size, 29);
      assert.equal(reopened.profileMetadata().get(ids[0] ?? '')?.alias, 'Chrome 004');
      assert.equal(reopened.combinations()[0]?.draft?.name, '待保存草稿');
      assert.equal(reopened.combinations()[0]?.saved?.steps.length, 4);
      assert.equal(reopened.combinations()[0]?.saved?.steps[3]?.type, 'feed');
    } finally {
      reopened.close();
    }
  });
});
test('failed bulk transfer is atomic and cannot partially change groups', async () => {
  await withStore(async (store) => {
    const group = await store.createGroup('A', 'blue');
    const ids = [randomUUID(), randomUUID()];
    await store.moveProfiles(ids, group.id);
    await assert.rejects(async () => await store.moveProfiles(ids, randomUUID()), /不存在/);
    assert.deepEqual(
      [...(await store.profileMetadata()).values()].map((row) => row.groupId),
      [group.id, group.id],
    );
  });
});

test('deleting a group preserves profiles and aliases, and moves only its own members to ungrouped', async () => {
  await withStore(async (store, file) => {
    const first = await store.createGroup('删除组', 'gray'),
      second = await store.createGroup('保留组', 'blue');
    const profiles = [randomUUID(), randomUUID(), randomUUID()];
    await store.moveProfiles(profiles.slice(0, 2), first.id);
    await store.moveProfiles([profiles[2]!], second.id);
    await store.renameProfile(profiles[0]!, '仍保留别名');
    const combo = await store.createCombination(combination());
    assert.equal(await store.deleteGroup(first.id), 2);
    await assert.rejects(async () => await store.deleteGroup(first.id), /分组不存在/);
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.equal(reopened.groups().length, 1);
      assert.equal(reopened.groups()[0]?.id, second.id);
      assert.equal(reopened.profileMetadata().size, 3);
      assert.equal(reopened.profileMetadata().get(profiles[0]!)?.alias, '仍保留别名');
      assert.equal(reopened.profileMetadata().get(profiles[0]!)?.groupId, null);
      assert.equal(reopened.profileMetadata().get(profiles[2]!)?.groupId, second.id);
      assert.deepEqual(reopened.combinations()[0], combo);
    } finally {
      reopened.close();
    }
  });
});
test('future schema is rejected without changing its version or data', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-future-'));
  const file = path.join(dir, 'workspace.sqlite');
  const db = new DatabaseSync(file);
  db.exec(
    "PRAGMA user_version=99; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('keep')",
  );
  db.close();
  try {
    await assert.rejects(() => WorkspaceStore.open(file), /不兼容/);
    const check = new DatabaseSync(file);
    try {
      assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 99);
      assert.equal(check.prepare('SELECT value FROM sentinel').get()?.value, 'keep');
    } finally {
      check.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('service rejects unknown profiles before moving and isolates partial stop failures', async () => {
  await withStore(async (store) => {
    const ids = [randomUUID(), randomUUID()];
    const profiles: Profile[] = ids.map((id) => ({
      id,
      alias: id,
      groupId: null,
      online: true,
      phase: 'PAUSED',
      synced: true,
      unresolved: 0,
      extensionVersion: '0.2.2',
      capabilities: [],
      account: { state: 'unknown', id: null, name: null, avatar: null },
    }));
    const stopped: string[] = [];
    const service = new WorkspaceService(store, {
      profiles: () => profiles,
      records: () => [],
      stop: (id) => {
        if (id === ids[1]) throw Error('OFFLINE');
        stopped.push(id);
      },
    });
    await assert.rejects(
      async () => await service.moveProfiles([ids[0] ?? '', randomUUID()], null),
      /不存在/,
    );
    assert.equal((await store.profileMetadata()).size, 0);
    const results = await service.stopProfiles(ids);
    assert.equal(StopResultsSchema.parse({ results }).results.length, 2);
    assert.deepEqual(
      results.map((row) => row.requested),
      [true, false],
    );
    assert.equal(stopped.length, 1);
    assert.throws(() => service.startCombination(), /尚未实现/);
    assert.equal((await service.snapshot()).support.comboExecution, false);
  });
});
test('cross-group selection is preserved when filtering and toggling a partial group', () => {
  const selected = new Set(['A', 'C']);
  const state = selectionState(selected, ['A', 'B']);
  assert.deepEqual(state, { checked: false, mixed: true });
  const next = toggleSet(selected, ['A', 'B'], true);
  assert.deepEqual([...next], ['A', 'C', 'B']);
  assert.deepEqual([...toggleSet(next, ['A', 'B'], false)], ['C']);
  assert.deepEqual([...selected], ['A', 'C']);
});
test('incomplete new drafts persist, but publishing validates and keeps the draft on failure', async () => {
  await withStore(async (store) => {
    const value = combination();
    const post = value.steps[2];
    assert.ok(post && post.type === 'post');
    post.resourceDirectory = '';
    const draft = await store.createDraft(value);
    assert.equal(draft.version, 0);
    assert.equal(draft.saved, null);
    await assert.rejects(
      async () => await store.discardDraft(draft.id, draft.revision),
      /草稿已保留/,
    );
    await assert.rejects(async () => await store.publish(draft.id, draft.revision));
    assert.equal((await store.combinations())[0]?.draft?.steps.length, 4);
    assert.equal((await store.combinations())[0]?.version, 0);
    post.resourceDirectory = 'D:\\素材';
    const ready = await store.writeDraft(draft.id, draft.revision, value);
    assert.equal((await store.publish(draft.id, ready.revision)).version, 1);
  });
});
