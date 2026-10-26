import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { buildStaggeredGroupQueues } from '../src/application/group-inviter-service.js';
import type { InviterGroupRow } from '../src/shared/group-inviter.js';
import {
  extractGroupId,
  applyGroupGridPaste,
  parseGroupClipboard,
  clearGroupGridRange,
  deleteGroupGridRows,
  formatGroupGridRangeForClipboard,
} from '../src/renderer/group-inviter-grid.js';

const multilineGroupNames = [
  'ဘုရားသခင်ဟာ ကျွန်ုပ်တို့ရဲ့ ခွန်အား ဖြစ်ပါတယ်။',
  'နာကျင်မှု ကင်းမဲ့သော ဘဝ',
  'သခင်ယေရှု၏မေတ္တာစကားဝိုင်း',
  'ဘုရားသခင်၏ ကောင်းချီးမင်္ဂလာများ',
  'ယေရှုခရစ်တော်၌ ငြိမ်းချမ်းခြင်း',
];
const multilineGroupIds = [
  '536757636094932',
  '1214231079609464',
  '899194495400720',
  '1486049828718193',
  '535334879184323',
];
const excelQuotedMultilineSample = multilineGroupIds
  .map((id, i) => id + '\t"' + multilineGroupNames[i] + '\n"')
  .join('\r\n');

test('real Burmese quoted multiline TSV stays five aligned rows from A, B or separately pasted columns', () => {
  let id = 0;
  const create = (groupId = '', groupName = '') => ({ key: String(++id), groupId, groupName });
  const expected = multilineGroupIds.map((groupId, i) => [groupId, multilineGroupNames[i]]);
  assert.deepEqual(parseGroupClipboard(excelQuotedMultilineSample), expected);
  for (const col of [0, 1] as const) {
    const rows = applyGroupGridPaste([create()], 0, col, excelQuotedMultilineSample, create);
    assert.equal(rows.length, 5);
    assert.deepEqual(
      rows.map((r) => [r.groupId, r.groupName]),
      expected,
    );
  }
  const ids = applyGroupGridPaste([create()], 0, 0, multilineGroupIds.join('\r\n'), create);
  const split = applyGroupGridPaste(
    ids,
    0,
    1,
    multilineGroupNames.map((name) => '"' + name + '\n"').join('\r\n'),
    create,
  );
  assert.equal(split.length, 5);
  assert.deepEqual(
    split.map((r) => [r.groupId, r.groupName]),
    expected,
  );
  for (const row of split)
    assert.ok(
      !row.groupName.startsWith('"') &&
        !row.groupName.endsWith('"') &&
        !/[\r\n]/.test(row.groupName),
    );
});

test('group clipboard unescapes quotes, folds internal CRLF, trims empty borders and tolerates unclosed plain text', () => {
  assert.deepEqual(parseGroupClipboard('\r\n\t\r\n123\t"hello ""friend""\r\n there"\r\n'), [
    ['123', 'hello "friend" there'],
  ]);
  assert.deepEqual(parseGroupClipboard('"unfinished\ntext'), [['unfinished text']]);
});

test('group range clearing, deletion, TSV copy and single-value multirow fill are immutable', () => {
  let id = 0;
  const create = (groupId = '', groupName = '') => ({ key: String(++id), groupId, groupName });
  const rows = [create('123', 'first'), create('456', 'second'), create('789', 'third')];
  assert.deepEqual(
    clearGroupGridRange(rows, 1, 2, 1, 1).map((r) => [r.groupId, r.groupName]),
    [
      ['123', 'first'],
      ['456', ''],
      ['789', ''],
    ],
  );
  assert.deepEqual(
    clearGroupGridRange(rows, 0, 1, 0, 0).map((r) => r.groupId),
    ['', '', '789'],
  );
  assert.deepEqual(
    clearGroupGridRange(rows, 0, 1, 0, 1).map((r) => [r.groupId, r.groupName]),
    [
      ['', ''],
      ['', ''],
      ['789', 'third'],
    ],
  );
  assert.equal(deleteGroupGridRows(rows, 0, 1, create)[0]?.groupId, '789');
  assert.deepEqual(
    deleteGroupGridRows(rows, 0, 2, create).map((r) => [r.groupId, r.groupName]),
    [['', '']],
  );
  assert.equal(formatGroupGridRangeForClipboard(rows, 0, 1, 0, 1), '123\tfirst\n456\tsecond');
  assert.deepEqual(
    applyGroupGridPaste(rows, 0, 1, 'same', create, 2, 1).map((r) => r.groupName),
    ['same', 'same', 'same'],
  );
  assert.deepEqual(
    rows.map((r) => r.groupName),
    ['first', 'second', 'third'],
  );
});

test('group grid extracts numeric IDs and slugs from Facebook URLs without altering plain IDs', () => {
  assert.equal(
    extractGroupId(' https://www.facebook.com/groups/3017439278594998/ '),
    '3017439278594998',
  );
  assert.equal(extractGroupId('facebook.com/groups/my_group_slug?ref=share'), 'my_group_slug');
  assert.equal(extractGroupId(' 123456 '), '123456');
  assert.equal(extractGroupId('https://example.com/groups/123'), 'https://example.com/groups/123');
});

test('single-row two-column paste works from either column and keeps a complete multilingual name', () => {
  let id = 0;
  const create = (groupId = '', groupName = '') => ({ key: String(++id), groupId, groupName });
  const name = 'ယေရှုခရစ်တော်သည် သခင်ဖြစ်တော်မူ၏။';
  for (const column of [0, 1] as const)
    for (const separator of ['\t', ',', '，', '|', '    ']) {
      const result = applyGroupGridPaste(
        [create()],
        0,
        column,
        '3017439278594998' + separator + name,
        create,
      );
      assert.equal(result[0]?.groupId, '3017439278594998');
      assert.equal(result[0]?.groupName, name);
    }
});

test('multiline grid paste appends rows; separate single columns preserve each other and names containing spaces', () => {
  let id = 0;
  const create = (groupId = '', groupName = '') => ({ key: String(++id), groupId, groupName });
  const original = [create('old', 'Old name')];
  const names = applyGroupGridPaste(original, 0, 1, '\nFirst group name\n第二个小组\n', create);
  assert.equal(names[0]?.groupId, 'old');
  assert.equal(names[0]?.groupName, 'First group name');
  assert.equal(names.length, 2);
  const ids = applyGroupGridPaste(
    names,
    0,
    0,
    'https://www.facebook.com/groups/12345/\n67890',
    create,
  );
  assert.deepEqual(
    ids.map((r) => [r.groupId, r.groupName]),
    [
      ['12345', 'First group name'],
      ['67890', '第二个小组'],
    ],
  );
  const pairs = applyGroupGridPaste(
    ids,
    1,
    1,
    '\nfacebook.com/groups/my_group_slug?ref=share\tNew name\n45678\tAnother name\n',
    create,
  );
  assert.deepEqual(
    pairs.slice(1).map((r) => [r.groupId, r.groupName]),
    [
      ['my_group_slug', 'New name'],
      ['45678', 'Another name'],
    ],
  );
  assert.deepEqual(
    original.map((r) => [r.groupId, r.groupName]),
    [['old', 'Old name']],
  );
});

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
