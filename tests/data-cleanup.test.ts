import { deliverPostNotices } from './fixtures/material-post.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import {
  prepareWorkspaceReset,
  applyPendingWorkspaceReset,
} from '../src/infrastructure/workspace-reset.js';
import { LogCleanup } from '../src/infrastructure/log-cleanup.js';
import { FilesystemRuntimeLog } from '../src/infrastructure/runtime-log.js';
import { DataCleanupService } from '../src/application/data-cleanup.js';
import { TaskService } from '../src/application/task-service.js';
import { settlementFixture, prepareBound } from './fixtures/settlement.js';

test('record cleanup removes only ended display rows and preserves original UNKNOWN, receipts and paging semantics', async () => {
  await settlementFixture(async (store) => {
    const f = prepareBound(store);
    store.tasks.markBoundUnknown(f.binding, 'TEST_UNKNOWN');
    const original = store.tasks.operations(f.plan.id);
    const end = store.tasks.requestEnd(f.plan.id);
    const stop = {
      profileId: f.profile.id,
      connectionEpoch: f.binding.connectionEpoch,
      requestId: end,
      state: 'stopped' as const,
    };
    store.tasks.prepareEnd(f.plan.id, stop);
    deliverPostNotices(store, f.profile.id);
    store.tasks.finishEnd(f.plan.id, stop);
    const second = prepareBound(store);
    const service = new TaskService(store.tasks);
    const before = await service.records({ limit: 1 });
    const scope = { stepIds: [f.step.id, second.step.id] };
    assert.deepEqual(store.dataCleanup.preview(scope), { eligible: 1, protected: 1, bytes: 0 });
    assert.equal(store.dataCleanup.removeBatch(scope), 1);
    assert.equal(store.dataCleanup.removeBatch(scope), 0);
    const after = await service.records({ limit: 100 });
    assert.equal(after.total, 1);
    assert.ok(after.records.every((row) => row.stepId === second.step.id));
    assert.deepEqual(after.records, (await service.recordsLegacy({ limit: 100 })).records);
    assert.deepEqual(
      store.tasks.operations(f.plan.id).map((o) => [o.id, o.status, o.receipt]),
      original.map((o) => [o.id, o.status, o.receipt]),
    );
    assert.equal(store.tasks.get(f.plan.id).state, 'FAILED');
    if (before.nextCursor)
      await assert.rejects(service.records({ limit: 1, cursor: before.nextCursor }), /记录已变化/);
    assert.equal(store.dataCleanup.settings().historyRetentionDays, null);
    store.dataCleanup.saveSettings({ expectedRevision: 0, historyRetentionDays: 7 });
    assert.throws(
      () => store.dataCleanup.saveSettings({ expectedRevision: 0, historyRetentionDays: 9 }),
      /清理设置已变化/,
    );
    assert.throws(() => store.dataCleanup.assertResettable(), /先停止/);
  });
});

test('log cleanup uses a preview, write lock and fixed file names; append remains usable after clear', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-clean-logs-'));
  try {
    const runtime = new FilesystemRuntimeLog(root);
    const event = {
      version: 1 as const,
      observedAt: new Date().toISOString(),
      event: 'SOFTWARE_STARTED' as const,
    };
    await runtime.append([event], 14);
    await writeFile(path.join(root, 'notes.txt'), 'preserve');
    await writeFile(path.join(root, 'dev-diagnostics.jsonl'), '{"event":"old"}\n');
    let locked = 0;
    const cleanup = new LogCleanup(root, (work) =>
      runtime.exclusive(async () => {
        locked++;
        return work();
      }),
    );
    const preview = await cleanup.preview();
    await writeFile(path.join(root, 'dev-diagnostics.jsonl'), '{"event":"new"}\n', { flag: 'a' });
    const removed = await cleanup.remove(preview, true);
    assert.equal(removed.deleted, 2);
    assert.equal(locked, 1);
    assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'preserve');
    await runtime.append([event], 14);
    assert.equal((await runtime.export()).records.length, 1);
    await assert.rejects(
      cleanup.remove([{ name: '../outside', modified: 0, bytes: 0, identity: '' }]),
      /LOG_FILE_REJECTED/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('full reset runs before SQLite opens, removes only owned data and does not follow linked original media', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-reset-'));
  const data = path.join(root, 'data'),
    originals = path.join(root, 'originals');
  try {
    await mkdir(data);
    await mkdir(originals);
    await writeFile(path.join(originals, 'video.mp4'), 'original');
    const store = await WorkspaceStore.open(path.join(data, 'workspace.sqlite'));
    store.createGroup('will reset', 'gray');
    store.close();
    await writeFile(path.join(root, 'outside-backup.sqlite'), 'backup');
    await symlink(originals, path.join(data, 'linked-media'), 'junction');
    await prepareWorkspaceReset(data);
    assert.equal(await applyPendingWorkspaceReset(data), true);
    assert.deepEqual(await readdir(data), []);
    assert.equal(await readFile(path.join(originals, 'video.mp4'), 'utf8'), 'original');
    assert.equal(await readFile(path.join(root, 'outside-backup.sqlite'), 'utf8'), 'backup');
    assert.equal(await applyPendingWorkspaceReset(data), false);
    const fresh = await WorkspaceStore.open(path.join(data, 'workspace.sqlite'));
    try {
      assert.equal(fresh.groups().length, 0);
      assert.equal(fresh.dataCleanup.settings().historyRetentionDays, null);
    } finally {
      fresh.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reset rejects a linked root and malformed requests without touching source data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-reset-reject-'));
  try {
    const original = path.join(root, 'original');
    await mkdir(original);
    await writeFile(path.join(original, 'keep'), 'keep');
    const link = path.join(root, 'link');
    await symlink(original, link, 'junction');
    await assert.rejects(prepareWorkspaceReset(link), /DIRECTORY_CHANGED/);
    await writeFile(
      original + '.reset-request.json',
      JSON.stringify({ version: 1, id: '../outside', requestedAt: 1 }),
    );
    await assert.rejects(applyPendingWorkspaceReset(original));
    assert.equal(await readFile(path.join(original, 'keep'), 'utf8'), 'keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cleanup consumes confirmation tickets once, blocks races during reset, and respects disabled auto retention', async () => {
  const store = await WorkspaceStore.open(':memory:');
  let prepared = 0,
    restarted = 0,
    batches = 0;
  const cleanup = new DataCleanupService(
    {
      ...{
        settings: () => store.dataCleanup.settings(),
        saveSettings: (input) => store.dataCleanup.saveSettings(input),
        preview: () => ({ eligible: 0, protected: 1, bytes: 0 }),
        removeBatch: () => {
          batches++;
          return 0;
        },
        assertResettable: () => store.dataCleanup.assertResettable(),
        compact: () => ({ completed: true }),
      },
    },
    { preview: async () => [], remove: async () => ({ deleted: 0, bytes: 0, protected: 0 }) },
    {
      prepare: async () => {
        prepared++;
      },
      restart: () => {
        restarted++;
      },
    },
    async () => {},
    () => {},
  );
  try {
    await cleanup.automatic();
    assert.equal(batches, 0);
    const preview = await cleanup.preview({ kind: 'records', scope: { stepIds: [randomUUID()] } });
    await cleanup.execute({ token: preview.token, confirm: true });
    await assert.rejects(cleanup.execute({ token: preview.token, confirm: true }), /预览已过期/);
    await assert.rejects(
      cleanup.resetAll({ confirmation: '确认重置', acknowledgeUnknownResults: false }),
    );
    assert.equal(prepared, 0);
    await cleanup.resetAll({ confirmation: '确认重置', acknowledgeUnknownResults: true });
    assert.throws(() => cleanup.assertNotResetting(), /正在重置/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(prepared, 1);
    assert.equal(restarted, 1);
  } finally {
    store.close();
  }
});
