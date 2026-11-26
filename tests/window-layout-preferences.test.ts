import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';

test('v61->v62 upgrade keeps preferences and reloads windowLayout durably', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-layout-'));
  const file = path.join(directory, 'workspace.sqlite');
  let store: WorkspaceStore | undefined;
  try {
    store = await WorkspaceStore.open(file);
    store.updatePreferences({
      expectedRevision: 0,
      values: { defaultTimeZone: 'Asia/Taipei', desktopNotifications: 'all' },
    });
    store.close();
    store = undefined;
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version=61');
    db.close();
    store = await WorkspaceStore.open(file);
    assert.equal(store.preferences().defaultTimeZone, 'Asia/Taipei');
    assert.equal(store.preferences().desktopNotifications, 'all');
    assert.equal(store.preferences().windowLayout, undefined);
    const current = store.preferences();
    const value = {
      version: 1 as const,
      enabled: true,
      displayId: 'primary',
      step: 8,
      reservedArea: { x: -1900, y: 100, width: 1600, height: 1000 },
    };
    store.updatePreferences({
      expectedRevision: current.revision,
      values: {
        defaultTimeZone: current.defaultTimeZone,
        desktopNotifications: current.desktopNotifications,
        windowLayout: value,
      },
    });
    const next = store.preferences();
    store.updatePreferences({
      expectedRevision: next.revision,
      values: { defaultTimeZone: 'UTC', desktopNotifications: 'off' },
    });
    assert.deepEqual(store.preferences().windowLayout, value);
    store.close();
    store = await WorkspaceStore.open(file);
    assert.deepEqual(store.preferences().windowLayout, value);
    assert.equal(store.preferences().defaultTimeZone, 'UTC');
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
