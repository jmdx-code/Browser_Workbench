import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { buildStaggeredGroupQueues } from '../src/application/group-inviter-service.js';
import type { InviterGroupRow } from '../src/shared/group-inviter.js';

async function withStore(run: (store: WorkspaceStore) => Promise<void> | void) {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-group-inviter-'));
  const file = path.join(dir, 'workspace.sqlite');
  const store = await WorkspaceStore.open(file);
  try {
    await run(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('group inviter repository persists groups, default 30 invitesPerGroup, and enforces global per-group friend deduplication', async () => {
  await withStore(async (store) => {
    const repo = store.groupInviter;
    assert.equal(await repo.getInvitesPerGroup(), 30);

    await repo.setInvitesPerGroup({ invitesPerGroup: 45 });
    assert.equal(await repo.getInvitesPerGroup(), 45);

    const groups = await repo.upsertGroups({
      items: [
        { groupId: '3017439278594998', groupName: 'ယေရှုခရစ်တော်သည် သခင်ဖြစ်တော်မူ၏။' },
        { groupId: '123456789012345', groupName: '测试小组二' },
      ],
    });
    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.totalInvitedCount, 0);

    await repo.updateGroupAvatar('3017439278594998', 'https://scontent.xx.fbcdn.net/v/group1.jpg');
    const updatedGroup = (await repo.listGroups()).find((g) => g.groupId === '3017439278594998');
    assert.equal(updatedGroup?.avatarUrl, 'https://scontent.xx.fbcdn.net/v/group1.jpg');

    const profileA = randomUUID();
    const profileB = randomUUID();

    // Account A invites Friend 1001 to Group 1 -> recorded (1 inserted)
    const first = await repo.recordInvites([
      {
        profileId: profileA,
        accountId: '10000000000003',
        friendId: '100090964538825',
        friendName: 'Alice',
        groupId: '3017439278594998',
        invitedAt: 2000,
      },
    ]);
    assert.equal(first, 1);

    // Account B tries to invite the SAME Friend 1001 to the SAME Group 1 -> deduplicated globally (0 inserted)
    const duplicateSameGroup = await repo.recordInvites([
      {
        profileId: profileB,
        accountId: '10000000000005',
        friendId: '100090964538825',
        friendName: 'Alice',
        groupId: '3017439278594998',
        invitedAt: 2100,
      },
    ]);
    assert.equal(duplicateSameGroup, 0);

    // Account B invites the SAME Friend 1001 to a DIFFERENT Group 2 -> allowed and recorded (1 inserted)
    const sameFriendDifferentGroup = await repo.recordInvites([
      {
        profileId: profileB,
        accountId: '10000000000005',
        friendId: '100090964538825',
        friendName: 'Alice',
        groupId: '123456789012345',
        invitedAt: 2200,
      },
    ]);
    assert.equal(sameFriendDifferentGroup, 1);

    assert.deepEqual(
      [...(await repo.getInvitedFriendIdsForGroup('3017439278594998'))],
      ['100090964538825'],
    );
    const refreshedGroups = await repo.listGroups();
    assert.equal(
      refreshedGroups.find((g) => g.groupId === '3017439278594998')?.totalInvitedCount,
      1,
    );
    assert.equal(
      refreshedGroups.find((g) => g.groupId === '123456789012345')?.totalInvitedCount,
      1,
    );

    const byProfile = await repo.getTotalInvitedByProfile();
    assert.equal(byProfile.get(profileA), 1);
    assert.equal(byProfile.get(profileB), 1);

    const logs = await repo.listLogs();
    assert.equal(logs.length, 2);

    // Deleting Group 2 removes it from group library
    const deletedCount = await repo.deleteGroups({ groupIds: ['123456789012345'] });
    assert.equal(deletedCount, 1);
    const remainingGroups = await repo.listGroups();
    assert.equal(remainingGroups.length, 1);
    assert.equal(remainingGroups[0]?.groupId, '3017439278594998');
  });
});

test('buildStaggeredGroupQueues assigns every group to each account while staggering initial target groups', () => {
  const profiles = ['profile-1', 'profile-2', 'profile-3'];
  const groups: InviterGroupRow[] = [
    {
      groupId: 'group-a',
      groupName: 'Group A',
      avatarUrl: null,
      totalInvitedCount: 0,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      groupId: 'group-b',
      groupName: 'Group B',
      avatarUrl: null,
      totalInvitedCount: 0,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      groupId: 'group-c',
      groupName: 'Group C',
      avatarUrl: null,
      totalInvitedCount: 0,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      groupId: 'group-d',
      groupName: 'Group D',
      avatarUrl: null,
      totalInvitedCount: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  const queues = buildStaggeredGroupQueues(profiles, groups);

  for (const profileId of profiles) {
    const queue = queues.get(profileId) ?? [];
    assert.equal(queue.length, groups.length);
    assert.deepEqual(queue.map((g) => g.groupId).sort(), groups.map((g) => g.groupId).sort());
  }

  // With 3 profiles and 4 groups, their first assigned groups should be distinct
  const firstGroups = new Set(profiles.map((id) => queues.get(id)?.[0]?.groupId));
  assert.equal(firstGroups.size, profiles.length);
});

test('invitation reservation lookup distinguishes exact operations including unconfirmed recipients', async () =>
  withStore(async (store) => {
    const operationId = randomUUID();
    assert.equal(store.groupInviter.hasInvitesForOperation(operationId), false);
    store.groupInviter.reserveInvites(operationId, [
      {
        profileId: randomUUID(),
        accountId: '123456789',
        friendId: '987654321',
        friendName: 'Fixture',
        groupId: '1234567890',
      },
    ]);
    assert.equal(store.groupInviter.hasInvitesForOperation(operationId), true);
    assert.equal(store.groupInviter.hasInvitesForOperation(randomUUID()), false);
    assert.equal(
      store.groupInviter.hasInvitesForOperation(operationId, randomUUID(), '123456789'),
      false,
    );
  }));
