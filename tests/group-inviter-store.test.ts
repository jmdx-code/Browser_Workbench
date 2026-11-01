import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { syncLocalAvatarsFromBumper } from '../src/infrastructure/group-inviter-store.js';

test('WO57: InviterGroupRow accepts >8KB (10KB+) local data:image/ avatars, protects local avatars against https:// downgrade in updateGroupMetadata/updateGroupAvatar, and syncs local avatars from group_bumper_groups', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-inviter-store-wo57-'));
  const file = path.join(dir, 'workspace.sqlite');
  const store = await WorkspaceStore.open(file);
  try {
    const repo = store.groupInviter;
    repo.upsertGroups({
      items: [
        { groupId: '3017439278594998', groupName: 'Group One' },
        { groupId: '1834045181273689', groupName: '1834045181273689' },
      ],
    });

    // Build a 10.5KB (> 8192 and <= 16384) valid data:image/webp;base64,... avatar URL
    const tenKbLocalAvatar = 'data:image/webp;base64,' + 'A'.repeat(10_500);
    assert.ok(tenKbLocalAvatar.length > 8192 && tenKbLocalAvatar.length <= 16384);

    repo.updateGroupAvatar('3017439278594998', tenKbLocalAvatar);
    const groupsAfterLocal = repo.listGroups();
    const g1 = groupsAfterLocal.find((g) => g.groupId === '3017439278594998');
    assert.equal(g1?.avatarUrl, tenKbLocalAvatar);

    // Passing https:// external URL to updateGroupAvatar or updateGroupMetadata must NOT overwrite local avatar
    repo.updateGroupAvatar(
      '3017439278594998',
      'https://scontent.xx.fbcdn.net/v/t39.30808-6/expired.jpg',
    );
    repo.updateGroupMetadata('3017439278594998', {
      groupName: 'Upgraded Name',
      avatarUrl: 'https://scontent.xx.fbcdn.net/v/t39.30808-6/expired2.jpg',
    });
    const g1AfterExternal = repo.listGroups().find((g) => g.groupId === '3017439278594998');
    assert.equal(g1AfterExternal?.avatarUrl, tenKbLocalAvatar);

    // Syncing from group_bumper_groups restores local avatar into group_inviter_groups when inviter has https:// or null
    const localBumperAvatar = 'data:image/webp;base64,' + 'B'.repeat(12_000);
    store.groupBumper.upsertTargets('groups', {
      items: [{ id: '1834045181273689', name: 'Bumper Group Two' }],
    });
    store.groupBumper.updateAvatar('groups', '1834045181273689', localBumperAvatar);

    const rawDb = new DatabaseSync(file);
    try {
      syncLocalAvatarsFromBumper(rawDb);
    } finally {
      rawDb.close();
    }

    const g2AfterSync = repo.listGroups().find((g) => g.groupId === '1834045181273689');
    assert.equal(g2AfterSync?.avatarUrl, localBumperAvatar);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
