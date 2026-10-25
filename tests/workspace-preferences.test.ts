import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import {
  WorkspacePreferences,
  UpdateWorkspacePreferences,
  DesktopTaskNotification,
  type NotificationEvent,
  type Preferences,
} from '../src/shared/workspace-preferences.js';
import { TaskNotificationMonitor } from '../src/application/task-notification-monitor.js';
import {
  latestMigrationBackupMarker,
  dropStoryPrivacySchema,
} from './fixtures/workspace-schema.js';

test('preferences persist with revision conflicts and reject invalid values before mutation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-preferences-'));
  const file = path.join(directory, 'workspace.sqlite');
  let store = await WorkspaceStore.open(file);
  try {
    const initial = store.preferences();
    assert.deepEqual(initial, {
      version: 1,
      revision: 0,
      defaultTimeZone: null,
      desktopNotifications: 'off',
      combinationColors: {},
    });
    const comboId = '11111111-1111-4111-8111-111111111111';
    const values = {
      defaultTimeZone: 'Asia/Taipei',
      desktopNotifications: 'failures' as const,
      combinationColors: { [comboId]: 'blue' as const },
    };
    const saved = store.updatePreferences({ expectedRevision: 0, values });
    assert.equal(saved.revision, 1);
    assert.deepEqual(saved.combinationColors, { [comboId]: 'blue' });
    assert.throws(() => store.updatePreferences({ expectedRevision: 0, values }), {
      code: 'PREFERENCES_REVISION_CONFLICT',
    });
    assert.equal(
      UpdateWorkspacePreferences.safeParse({
        expectedRevision: 1,
        values: { ...values, defaultTimeZone: 'invalid/zone' },
      }).success,
      false,
    );
    assert.equal(
      UpdateWorkspacePreferences.safeParse({
        expectedRevision: 1,
        values: { ...values, combinationColors: { [comboId]: 'pink' } },
      }).success,
      false,
    );
    assert.equal(WorkspacePreferences.safeParse({ ...saved, token: 'not-allowed' }).success, false);
    store.close();
    store = await WorkspaceStore.open(file);
    assert.deepEqual(store.preferences(), saved);
    // Omitting combinationColors (e.g. from WorkspacePreferencesPanel) preserves existing colors.
    const defaults = store.updatePreferences({
      expectedRevision: 1,
      values: { defaultTimeZone: null, desktopNotifications: 'off' },
    });
    assert.equal(defaults.revision, 2);
    assert.deepEqual(defaults.combinationColors, { [comboId]: 'blue' });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('schema27 adds default-off preferences with backup while preserving task event history', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-preference-upgrade-'));
  const file = path.join(directory, 'workspace.sqlite');
  try {
    const initial = await WorkspaceStore.open(file);
    initial.close();
    const previous = new DatabaseSync(file);
    previous.exec(
      dropStoryPrivacySchema +
        "DROP INDEX one_original_post_background; DELETE FROM workspace_execution_contracts WHERE name='post-native-background'; DROP TABLE workspace_preferences; PRAGMA user_version=27",
    );
    previous.close();
    const migrated = await WorkspaceStore.open(file);
    try {
      assert.equal(migrated.preferences().desktopNotifications, 'off');
      assert.equal(migrated.taskNotificationCursor(), 0);
    } finally {
      migrated.close();
    }
    assert.ok(
      (await readdir(directory)).some((name) => name.includes(latestMigrationBackupMarker)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('notifications consume suppressed events and aggregate only new terminal events without replay', async () => {
  let events: NotificationEvent[] = [],
    cursor = 100;
  let preferences: Preferences = {
    version: 1,
    revision: 0,
    defaultTimeZone: null,
    desktopNotifications: 'off',
  };
  const emitted: unknown[] = [];
  const source = {
    taskNotificationCursor: () => cursor,
    taskNotificationEvents: (after: number) => events.filter((row) => row.sequence > after),
  };
  const monitor = new TaskNotificationMonitor(
    source,
    () => preferences,
    (value) => emitted.push(value),
  );
  events = [{ sequence: 101, type: 'FAILED' }];
  await monitor.tick();
  preferences = { ...preferences, desktopNotifications: 'all' };
  await monitor.tick();
  assert.equal(emitted.length, 0);
  events.push({ sequence: 102, type: 'COMPLETED' }, { sequence: 103, type: 'FAILED' });
  await monitor.tick();
  await monitor.tick();
  assert.deepEqual(emitted, [{ type: 'TASK_NOTIFICATION', failed: 1, completed: 1 }]);
  cursor = 103;
  await new TaskNotificationMonitor(
    source,
    () => preferences,
    (value) => emitted.push(value),
  ).tick();
  assert.equal(emitted.length, 1);
  preferences = { ...preferences, desktopNotifications: 'failures' };
  events.push({ sequence: 104, type: 'COMPLETED' });
  await monitor.tick();
  assert.equal(emitted.length, 1);
});

test('notification transport errors never replay popups; malformed sequences and payloads are rejected', async () => {
  const events: NotificationEvent[] = [{ sequence: 1, type: 'FAILED' }];
  let calls = 0;
  const monitor = new TaskNotificationMonitor(
    {
      taskNotificationCursor: () => 0,
      taskNotificationEvents: (after) => events.filter((row) => row.sequence > after),
    },
    () => ({ version: 1, revision: 0, defaultTimeZone: null, desktopNotifications: 'all' }),
    () => {
      calls++;
      throw Error('NATIVE_NOTIFICATION_UNAVAILABLE');
    },
  );
  await assert.rejects(async () => await monitor.tick(), /UNAVAILABLE/);
  await monitor.tick();
  assert.equal(calls, 1);
  for (const value of [
    { type: 'TASK_NOTIFICATION', failed: 0, completed: 0 },
    { type: 'TASK_NOTIFICATION', failed: 1, completed: 0, body: 'foreign text' },
    { type: 'TASK_NOTIFICATION', failed: 101, completed: 0 },
  ])
    assert.equal(DesktopTaskNotification.safeParse(value).success, false);
});
