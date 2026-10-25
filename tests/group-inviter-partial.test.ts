import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import {
  collectInvitationConfirmations,
  invitationResultStatus,
  mountedInvitationSelectionMatches,
} from '../src/infrastructure/group-inviter-runner.js';
import type { GroupInvitationState } from '../src/infrastructure/group-inviter-effects.js';

test('30 selected IDs need not all be mounted; changed visible selection still rejects submit', () => {
  const ids = Array.from({ length: 30 }, (_, i) => String(987654000 + i));
  const state = {
    items: ids.slice(20).map((id) => ({ id, checked: true, invited: false, member: false })),
  } as GroupInvitationState;
  assert.equal(mountedInvitationSelectionMatches(state, ids), true);
  assert.equal(
    mountedInvitationSelectionMatches(
      { ...state, items: [{ id: ids[20] ?? null, checked: false, invited: false, member: false }] },
      ids,
    ),
    false,
  );
  assert.equal(
    mountedInvitationSelectionMatches(
      { ...state, items: [{ id: '111111111', checked: true, invited: false, member: false }] },
      ids,
    ),
    false,
  );
});

test('30 reserved recipients: 28 Relay confirmations persist immediately, two remain pending', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'inviter-partial-'));
  const store = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
  const profileId = randomUUID(),
    accountId = '123456789',
    groupId = '1234567890',
    operationId = randomUUID();
  const entries = Array.from({ length: 30 }, (_, i) => ({
    profileId,
    accountId,
    groupId,
    friendId: String(987654000 + i),
    friendName: 'Fixture ' + i,
  }));
  let credited = 0,
    persistCalls = 0,
    clock = 0;
  const state: GroupInvitationState = {
    url: `https://www.facebook.com/groups/${groupId}/`,
    accountId,
    visible: true,
    ready: true,
    dialog: true,
    dialogIndex: 0,
    dialogCount: 1,
    menu: false,
    joined: true,
    timeOrigin: 1,
    items: [],
    recipients: entries
      .slice(0, 28)
      .map((e) => ({ id: e.friendId, invited: true, member: false, checked: false })),
  };
  try {
    store.groupInviter.reserveInvites(operationId, entries);
    const confirmed = await collectInvitationConfirmations({
      selectedIds: entries.map((e) => e.friendId),
      accountId,
      groupId,
      guard: () => {},
      read: async () => state,
      scroll: async () => false,
      now: () => clock,
      wait: async () => {
        clock += 500;
      },
      persist: async (ids) => {
        persistCalls++;
        credited += store.groupInviter.recordInvites(
          entries.filter((e) => ids.includes(e.friendId)),
          operationId,
        );
        const inspection = new DatabaseSync(path.join(directory, 'workspace.sqlite'), {
          readOnly: true,
        });
        const rows = inspection
          .prepare('SELECT confirmation FROM group_inviter_logs WHERE profile_id=?')
          .all(profileId);
        inspection.close();
        assert.equal(
          rows.filter((r) => r.confirmation === 'CONFIRMED').length,
          28,
          'commit occurs before collection completes',
        );
        assert.equal(rows.filter((r) => r.confirmation === 'PENDING').length, 2);
      },
    });
    assert.equal(persistCalls, 1);
    assert.equal(confirmed.size, 28);
    assert.equal(credited, 28);
    assert.equal(
      invitationResultStatus(confirmed.size, 30 - confirmed.size),
      '已确认 28 人 · 2 人待核对',
    );
    assert.equal(invitationResultStatus(0, 30), '邀请已提交 · 30 人待核对');
    assert.equal(invitationResultStatus(30, 0), '已确认 30 人');
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('confirmed IDs outside the selection are ignored; membership is accepted and duplicate evidence credited once', async () => {
  const credited: string[] = [];
  let clock = 0;
  const state: GroupInvitationState = {
    url: 'https://www.facebook.com/groups/1234567890/',
    accountId: '123456789',
    visible: true,
    ready: true,
    dialog: true,
    dialogCount: 1,
    menu: false,
    joined: true,
    timeOrigin: 1,
    items: [{ id: '987654321', invited: false, member: true, checked: false }],
    recipients: [
      { id: '987654321', invited: false, member: true, checked: false },
      { id: '111111111', invited: true, member: false, checked: false },
    ],
  };
  const result = await collectInvitationConfirmations({
    selectedIds: ['987654321'],
    accountId: '123456789',
    groupId: '1234567890',
    guard: () => {},
    read: async () => state,
    scroll: async () => false,
    persist: async (ids) => {
      credited.push(...ids);
    },
    now: () => clock,
    wait: async () => {
      clock += 500;
    },
  });
  assert.deepEqual(credited, ['987654321']);
  assert.deepEqual([...result], ['987654321']);
});
