import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import { WorkspaceService } from '../src/application/workspace-service.js';
import { workspaceApi } from '../src/http/workspace-api.js';
import { Core } from '../src/bridge/core.js';
import { Store } from '../src/bridge/store.js';
import { BridgeBrowserWindow } from '../src/infrastructure/bridge-browser-window.js';
import { ExtensionUpdates } from '../src/infrastructure/extension-updates.js';
import { ProductError } from '../src/domain/workspace.js';
import { ProfileSchema } from '../src/shared/contracts.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
async function fixture(work: (s: WorkspaceStore, file: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'finder-list-'));
  const file = path.join(dir, 'workspace.sqlite');
  const s = await WorkspaceStore.open(file);
  try {
    await work(s, file);
  } finally {
    s.close();
    await rm(dir, { recursive: true, force: true });
  }
}
test('migration44 preserves old43 profiles, target rows and logs while initializing order', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'finder-migration-'));
  const file = path.join(dir, 'workspace.sqlite');
  let store = await WorkspaceStore.open(file);
  const group = store.createGroup('保留组', 'blue');
  const id = randomUUID();
  store.moveProfiles([id], group.id);
  store.groupInviter.upsertGroups({ items: [{ groupId: '101', groupName: '邀请' }] });
  store.groupBumper.upsertTargets('groups', { items: [{ id: '102', name: '顶贴' }] });
  store.groupBumper.upsertTargets('pages', { items: [{ id: '103', name: '主页' }] });
  store.close();
  const db = new DatabaseSync(file);
  db.exec('ALTER TABLE profile_metadata DROP COLUMN sort_order;DROP TABLE target_list_folders;');
  for (const t of ['group_inviter_groups', 'group_bumper_groups', 'group_bumper_pages'])
    db.exec(`ALTER TABLE ${t} DROP COLUMN folder_id;ALTER TABLE ${t} DROP COLUMN sort_order;`);
  db.exec('PRAGMA user_version=43');
  db.close();
  store = await WorkspaceStore.open(file);
  try {
    assert.ok(workspaceSchemaVersion >= 44);
    assert.equal(store.profileMetadata().get(id)?.groupId, group.id);
    assert.equal(store.profileMetadata().get(id)?.order, 0);
    assert.equal(store.groupInviter.listGroups()[0]?.folderId, null);
    assert.equal(store.groupBumper.targets('groups')[0]?.id, '102');
    assert.equal(store.groupBumper.targets('pages')[0]?.id, '103');
    const check = new DatabaseSync(file, { readOnly: true });
    assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(), []);
    check.close();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
for (const kind of ['inviter_groups', 'bumper_groups', 'bumper_pages'] as const)
  test(
    kind + ' folder CRUD/multi-move/order survives read and deletion retains targets',
    async () =>
      fixture(async (s) => {
        if (kind === 'inviter_groups')
          s.groupInviter.upsertGroups({
            items: [
              { groupId: '1', groupName: '一' },
              { groupId: '2', groupName: '二' },
              { groupId: '3', groupName: '三' },
            ],
          });
        else
          s.groupBumper.upsertTargets(kind === 'bumper_groups' ? 'groups' : 'pages', {
            items: [
              { id: '1', name: '一' },
              { id: '2', name: '二' },
              { id: '3', name: '三' },
            ],
          });
        s.targetListCommand({ action: 'create', listKind: kind, name: 'A' });
        s.targetListCommand({ action: 'create', listKind: kind, name: 'B' });
        const [a, b] = s.targetFolders(kind);
        assert.ok(a && b);
        s.targetListCommand({ action: 'rename', id: a.id, name: '改名' });
        s.targetListCommand({
          action: 'reorder-folders',
          listKind: kind,
          orderedFolderIds: [b.id, a.id],
        });
        assert.equal(s.targetFolders(kind)[0]?.id, b.id);
        s.targetListCommand({
          action: 'reorder-items',
          listKind: kind,
          folderId: a.id,
          orderedItemIds: ['3', '1', '2'],
        });
        s.targetListCommand({
          action: 'reorder-items',
          listKind: kind,
          folderId: b.id,
          orderedItemIds: ['2', '1'],
        });
        const rows = () =>
          kind === 'inviter_groups'
            ? s.groupInviter
                .listGroups()
                .map((i) => ({ id: i.groupId, folderId: i.folderId, sortOrder: i.sortOrder }))
            : s.groupBumper.targets(kind === 'bumper_groups' ? 'groups' : 'pages');
        assert.deepEqual(
          rows()
            .filter((i) => i.folderId === b.id)
            .map((i) => i.id),
          ['2', '1'],
        );
        s.targetListCommand({ action: 'delete', id: b.id });
        assert.equal(rows().length, 3);
        assert.equal(rows().filter((i) => i.folderId === null).length, 2);
        assert.throws(
          () =>
            s.targetListCommand({
              action: 'reorder-items',
              listKind: kind,
              folderId: b.id,
              orderedItemIds: ['1'],
            }),
          /不存在/,
        );
      }),
  );
test('profile and group reorder HTTP APIs persist exact cross-group order', async () =>
  fixture(async (s) => {
    const a = s.createGroup('A', 'blue'),
      b = s.createGroup('B', 'green'),
      ids = [randomUUID(), randomUUID(), randomUUID()];
    const profiles = ids.map((id) =>
      ProfileSchema.parse({
        id,
        alias: id,
        groupId: null,
        online: false,
        phase: 'OFFLINE',
        synced: false,
        unresolved: 0,
        extensionVersion: null,
        capabilities: [],
        account: { state: 'unknown', id: null, name: null, avatar: null },
      }),
    );
    const service = new WorkspaceService(s, {
      profiles: () => profiles,
      records: () => [],
      stop: async () => {},
    });
    const api = workspaceApi(service);
    let status = 0;
    let data: unknown;
    const res = {
      writeHead: (n: number) => {
        status = n;
      },
      end: (raw: string) => {
        data = JSON.parse(raw);
      },
    } as unknown as ServerResponse;
    await api({ method: 'POST' } as IncomingMessage, res, '/api/workspace/profiles/reorder', {
      groupId: a.id,
      orderedProfileIds: [ids[1], ids[0]],
    });
    assert.equal(status, 200);
    await api({ method: 'POST' } as IncomingMessage, res, '/api/workspace/profiles/reorder', {
      groupId: b.id,
      orderedProfileIds: [ids[0], ids[2]],
    });
    assert.equal(status, 200);
    assert.equal(s.profileMetadata().get(ids[0] ?? '')?.groupId, b.id);
    assert.equal(s.profileMetadata().get(ids[2] ?? '')?.order, 1);
    await api({ method: 'POST' } as IncomingMessage, res, '/api/workspace/groups/reorder', {
      orderedGroupIds: [b.id, a.id],
    });
    assert.equal(status, 200);
    assert.equal(s.groups()[0]?.id, b.id);
    assert.ok(data);
  }));
test('missing reveal capability auto reloads same version once and show returns explicit409', async () => {
  const store = new Store(':memory:'),
    core = new Core(store),
    messages: unknown[] = [];
  let peer = core.connect(
    randomUUID(),
    (m) => messages.push(m),
    () => {},
  );
  peer.phase = 'PAUSED';
  peer.synced = true;
  peer.extensionVersion = '0.3.58';
  peer.capabilities = [];
  const updates = new ExtensionUpdates(core, '0.3.58', 'fixed', () => false);
  try {
    await updates.automatic(peer);
    assert.equal(messages.length, 1);
    const id = peer.profileId;
    await core.disconnect(peer);
    peer = core.connect(
      id,
      (m) => messages.push(m),
      () => {},
    );
    peer.phase = 'PAUSED';
    peer.synced = true;
    peer.extensionVersion = '0.3.58';
    peer.capabilities = [];
    await updates.automatic(peer);
    assert.equal(messages.length, 1);
    const windows = new BridgeBrowserWindow(core, { list: () => [] });
    await assert.rejects(
      windows.show(id, ''),
      (e) =>
        e instanceof ProductError &&
        e.status === 409 &&
        e.code === 'WORKSPACE_REVEAL_EXTENSION_RELOADING',
    );
    assert.equal(messages.length, 2);
  } finally {
    await core.shutdown();
    store.close();
  }
});

test('new profile orders append to existing rows; legacy moves and deleted groups append without collisions', async () =>
  fixture(async (s) => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    s.ensureProfileOrders([ids[0] ?? '']);
    s.ensureProfileOrders(ids);
    assert.deepEqual(
      ids.map((id) => s.profileMetadata().get(id)?.order),
      [0, 1, 2],
    );
    const a = s.createGroup('来源', 'blue'),
      b = s.createGroup('目标', 'green');
    s.moveProfiles([ids[0] ?? ''], a.id);
    s.moveProfiles([ids[1] ?? ''], b.id);
    s.moveProfiles([ids[2] ?? ''], b.id);
    assert.equal(s.profileMetadata().get(ids[2] ?? '')?.order, 1);
    s.deleteGroup(b.id);
    assert.equal(s.profileMetadata().get(ids[1] ?? '')?.order, 0);
    assert.equal(s.profileMetadata().get(ids[2] ?? '')?.order, 1);
    s.moveProfiles([ids[0] ?? ''], null);
    assert.equal(s.profileMetadata().get(ids[0] ?? '')?.order, 2);
  }));
for (const kind of ['inviter_groups', 'bumper_groups', 'bumper_pages'] as const)
  test(kind + ' add directly to folder and deleted folder appends to unfiled', async () =>
    fixture(async (s) => {
      s.targetListCommand({ action: 'create', listKind: kind, name: '文件夹' });
      const folder = s.targetFolders(kind)[0];
      assert.ok(folder);
      if (kind === 'inviter_groups')
        s.groupInviter.upsertGroups({
          items: [
            { groupId: '1', groupName: '现有' },
            { groupId: '2', groupName: '分组内', folderId: folder.id },
          ],
        });
      else
        s.groupBumper.upsertTargets(kind === 'bumper_groups' ? 'groups' : 'pages', {
          items: [
            { id: '1', name: '现有' },
            { id: '2', name: '分组内', folderId: folder.id },
          ],
        });
      const read = () =>
        kind === 'inviter_groups'
          ? s.groupInviter
              .listGroups()
              .map((i) => ({ id: i.groupId, folderId: i.folderId, sortOrder: i.sortOrder }))
          : s.groupBumper.targets(kind === 'bumper_groups' ? 'groups' : 'pages');
      assert.equal(read().find((i) => i.id === '2')?.folderId, folder.id);
      s.targetListCommand({ action: 'delete', id: folder.id });
      assert.deepEqual(
        read().map((i) => i.id),
        ['1', '2'],
      );
      assert.equal(read()[1]?.folderId, null);
    }),
  );
