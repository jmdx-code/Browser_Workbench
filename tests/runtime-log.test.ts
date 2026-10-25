import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FilesystemRuntimeLog } from '../src/infrastructure/runtime-log.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { RuntimeLogRecord } from '../src/shared/runtime-log.js';
import { dropStoryPrivacySchema } from './fixtures/workspace-schema.js';
const header = '{"format":"browser-workbench-runtime-log","version":1}\n';
const record = {
  version: 1 as const,
  observedAt: '2026-10-14T00:00:00.000Z',
  event: 'SOFTWARE_STARTED' as const,
};

test('retention removes only expired managed logs and leaves arbitrary files and source media intact', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-logs-'));
  try {
    const log = new FilesystemRuntimeLog(directory, () => Date.parse(record.observedAt));
    await writeFile(
      path.join(directory, 'runtime-2026-09-01.ndjson'),
      header + JSON.stringify(record) + '\n',
    );
    await writeFile(path.join(directory, 'runtime-2026-09-02.ndjson'), 'unowned');
    await writeFile(path.join(directory, 'source.mp4'), 'source');
    await log.append([record], 14);
    assert.equal((await readdir(directory)).includes('runtime-2026-09-01.ndjson'), false);
    assert.equal(
      await readFile(path.join(directory, 'runtime-2026-09-02.ndjson'), 'utf8'),
      'unowned',
    );
    assert.equal(await readFile(path.join(directory, 'source.mp4'), 'utf8'), 'source');
    await rm(path.join(directory, 'runtime-2026-09-02.ndjson'));
    assert.deepEqual((await log.export()).records, [record]);
    assert.equal(RuntimeLogRecord.safeParse({ ...record, cookie: 'secret' }).success, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('log export is bounded to the latest 1000 metadata records', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-log-budget-'));
  try {
    const log = new FilesystemRuntimeLog(directory, () => Date.parse(record.observedAt));
    for (let batch = 0; batch < 11; batch++)
      await log.append(
        Array.from({ length: 100 }, (_, i) => ({
          ...record,
          event: 'TASK_COMPLETED',
          sequence: batch * 100 + i + 1,
        })),
        14,
      );
    const exported = await log.export();
    assert.equal(exported.truncated, true);
    assert.equal(exported.records.length, 1000);
    assert.equal(exported.records[0]?.sequence, 101);
    assert.equal(exported.records.at(-1)?.sequence, 1100);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('schema28 upgrade keeps preferences and shares CAS revision with log maintenance', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-log-upgrade-'));
  const file = path.join(directory, 'workspace.sqlite');
  try {
    let store = await WorkspaceStore.open(file);
    store.updatePreferences({
      expectedRevision: 0,
      values: { defaultTimeZone: 'Asia/Taipei', desktopNotifications: 'failures' },
    });
    store.close();
    const old = new DatabaseSync(file);
    old.exec(
      dropStoryPrivacySchema +
        "DROP INDEX one_original_post_background; DELETE FROM workspace_execution_contracts WHERE name='post-native-background'; ALTER TABLE workspace_preferences DROP COLUMN log_retention_days; PRAGMA user_version=28",
    );
    old.close();
    store = await WorkspaceStore.open(file);
    try {
      assert.equal(store.maintenanceSettings().logRetentionDays, 14);
      const updated = store.updateMaintenanceSettings({ expectedRevision: 1, logRetentionDays: 7 });
      assert.equal(updated.revision, 2);
      assert.equal(store.preferences().defaultTimeZone, 'Asia/Taipei');
      assert.throws(
        () => store.updateMaintenanceSettings({ expectedRevision: 1, logRetentionDays: 8 }),
        { code: 'PREFERENCES_REVISION_CONFLICT' },
      );
      store.updatePreferences({
        expectedRevision: 2,
        values: { defaultTimeZone: null, desktopNotifications: 'off' },
      });
      assert.equal(store.maintenanceSettings().logRetentionDays, 7);
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
