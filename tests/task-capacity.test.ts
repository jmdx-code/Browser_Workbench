import { dropDataCleanupSchema } from './fixtures/workspace-schema.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import { SchedulerSettings } from '../src/shared/task-contracts.js';
import type { RuntimeProfile } from '../src/domain/tasks.js';
import { MAX_CONCURRENT_UPLOAD_PREPARATIONS } from '../src/shared/task-capacity.js';
import { AsyncWorkBudget } from '../src/application/async-work-budget.js';

test('new databases default to 100, retain a subsequently edited limit on reopen, and admit 100 upload preparations', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-default-capacity-'));
  const file = path.join(directory, 'workspace.sqlite');
  let store = await WorkspaceStore.open(file);
  try {
    assert.equal(store.tasks.settings().maxConcurrentProfiles, 100);
    store.tasks.setSettings({ maxConcurrentProfiles: 37 });
    store.close();
    store = await WorkspaceStore.open(file);
    assert.equal(store.tasks.settings().maxConcurrentProfiles, 37);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const budget = new AsyncWorkBudget(MAX_CONCURRENT_UPLOAD_PREPARATIONS, 100);
    let entered = 0;
    const work = Array.from({ length: 100 }, () =>
      budget.run(
        () => {},
        async () => {
          entered++;
          await held;
        },
      ),
    );
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(entered, 100);
    assert.equal(budget.status().waiting, 0);
    release();
    await Promise.all(work);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('schema34 capacity upgrade preserves its selected setting and creates an original backup', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-capacity-'));
  const file = path.join(directory, 'workspace.sqlite');
  try {
    const original = await WorkspaceStore.open(file);
    original.tasks.setSettings({ maxConcurrentProfiles: 43 });
    const combination = original.createCombination({
      name: 'Preserved version',
      note: '',
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    original.close();
    const legacy = new DatabaseSync(file);
    legacy.exec(dropDataCleanupSchema);
    legacy.exec(
      "BEGIN IMMEDIATE; ALTER TABLE scheduler_settings RENAME TO capacity_new; CREATE TABLE scheduler_settings(id INTEGER PRIMARY KEY CHECK(id=1),max_concurrent_profiles INTEGER NOT NULL CHECK(max_concurrent_profiles BETWEEN 1 AND 50)); INSERT INTO scheduler_settings SELECT * FROM capacity_new; DROP TABLE capacity_new; DELETE FROM workspace_execution_contracts WHERE name='task-capacity'; PRAGMA user_version=34; COMMIT;",
    );
    assert.throws(
      () => legacy.prepare('UPDATE scheduler_settings SET max_concurrent_profiles=100').run(),
      /CHECK/,
    );
    legacy.close();
    const upgraded = await WorkspaceStore.open(file);
    try {
      assert.equal(upgraded.tasks.settings().maxConcurrentProfiles, 43);
      assert.equal(upgraded.combinations()[0]?.id, combination.id);
      upgraded.tasks.setSettings({ maxConcurrentProfiles: 100 });
      assert.equal(upgraded.tasks.settings().maxConcurrentProfiles, 100);
      assert.throws(() => upgraded.tasks.setSettings({ maxConcurrentProfiles: 101 }));
    } finally {
      upgraded.close();
    }
    const check = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(
        check.prepare('PRAGMA user_version').get()?.user_version,
        workspaceSchemaVersion,
      );
      assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      check.close();
    }
    assert.ok(
      (await readdir(directory)).some((name) =>
        name.includes('.before-v' + workspaceSchemaVersion + '-'),
      ),
    );
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('workbench-capacity-'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('one hundred actual SQL claims respect account ownership and leave the 101st queued', async () => {
  assert.equal(SchedulerSettings.safeParse({ maxConcurrentProfiles: 100 }).success, true);
  assert.equal(SchedulerSettings.safeParse({ maxConcurrentProfiles: 101 }).success, false);
  const store = await WorkspaceStore.open(':memory:');
  try {
    store.tasks.setSettings({ maxConcurrentProfiles: 100 });
    const profiles: RuntimeProfile[] = Array.from({ length: 101 }, (_, i) => ({
      id: randomUUID(),
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in', id: 'generated-' + i, name: null, avatar: null },
    }));
    const saved = store.createCombination({
      name: 'Generated hundred claims',
      note: '',
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: saved.id,
        version: 1,
        profileIds: profiles.map((p) => p.id),
      },
      profiles,
    );
    const claimed = Array.from({ length: 100 }, () =>
      store.tasks.claimNext(profiles, new Set(['feed'])),
    );
    assert.ok(claimed.every((p) => p?.state === 'RUNNING'));
    assert.equal(new Set(claimed.map((p) => p?.accountId)).size, 100);
    assert.equal(store.tasks.claimNext(profiles, new Set(['feed'])), null);
    assert.equal(store.tasks.livePlans().filter((p) => p.state === 'QUEUED').length, 1);
    store.tasks.setSettings({ maxConcurrentProfiles: 50 });
    assert.equal(store.tasks.livePlans().filter((p) => p.state === 'RUNNING').length, 100);
    assert.equal(store.tasks.claimNext(profiles, new Set(['feed'])), null);
  } finally {
    store.close();
  }
});
