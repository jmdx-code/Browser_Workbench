import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUMPER_LOG_TSV_HEADERS,
  POSTER_LOG_TSV_HEADERS,
  UNIFIED_POST_BUMP_TSV_HEADERS,
  collectAllPaginatedLogs,
  formatBumperLogsAsTsv,
  formatPosterLogsAsTsv,
  formatUnifiedPostAndBumpLogsAsTsv,
  sanitizeTsvCell,
} from '../src/shared/log-table-copy.js';
import type { BumperLog } from '../src/shared/group-bumper.js';
import type { PosterLog } from '../src/shared/group-poster.js';

test('sanitizeTsvCell collapses newlines/tabs and neutralizes leading spreadsheet formula prefixes', () => {
  assert.equal(
    sanitizeTsvCell('ဒီစာကို\n"အာမင်"\tလို့ ရေးပါ\r\nကျေးဇူးတင်ပါတယ်'),
    'ဒီစာကို "အာမင်" လို့ ရေးပါ ကျေးဇူးတင်ပါတယ်',
  );
  assert.equal(sanitizeTsvCell('=SUM(A1:A5)'), ' =SUM(A1:A5)');
  assert.equal(sanitizeTsvCell('+855123456'), ' +855123456');
  assert.equal(sanitizeTsvCell('-pending'), ' -pending');
  assert.equal(sanitizeTsvCell('@admin'), ' @admin');
  assert.equal(sanitizeTsvCell(null), '');
  assert.equal(sanitizeTsvCell('   \n\t  '), '');
});

test('formatPosterLogsAsTsv produces aligned TSV rows with multi-line Burmese captions and pending status', () => {
  const profiles = [
    {
      id: 'p-8',
      browserName: '用户8',
      alias: '浏览器8',
      account: { id: '1000888', name: 'Aung Min' },
    },
  ];
  const logs: PosterLog[] = [
    {
      id: 'log-1',
      profileId: 'p-8',
      accountId: '6155000111',
      accountName: 'Grace Myanmar Page',
      accountAvatar: null,
      identityType: 'page',
      groupId: '99887766',
      groupName: 'Myanmar Christian Fellowship',
      groupAvatar: null,
      materialId: 'mat-1',
      captionPreview: 'ဒီစာကို ဖတ်ပြီး\n"အာမင်" လို့ ရေးပေးပါ',
      postId: 'pending-1793675169496',
      postUrl: 'https://www.facebook.com/groups/99887766/my_pending_content',
      postedAt: new Date(2026, 10, 3, 12, 30, 5).getTime(),
    },
    {
      id: 'log-2',
      profileId: 'p-8',
      accountId: '1000888',
      accountName: '',
      accountAvatar: null,
      identityType: 'personal',
      groupId: '55443322',
      groupName: 'Yangon Market',
      groupAvatar: null,
      materialId: 'mat-1',
      captionPreview: '=Hot Deal Today!',
      postId: '12233445566',
      postUrl: 'https://www.facebook.com/groups/55443322/posts/12233445566/',
      postedAt: new Date(2026, 10, 3, 13, 0, 0).getTime(),
    },
  ];

  const tsv = formatPosterLogsAsTsv(logs, profiles);
  const lines = tsv.split('\n');
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.equal(line.split('\t').length, POSTER_LOG_TSV_HEADERS.length);
  }
  const row1 = lines[1]?.split('\t') ?? [];
  assert.equal(row1[0], '2026-11-03 12:30:05');
  assert.equal(row1[1], '用户8');
  assert.equal(row1[2], '专页');
  assert.equal(row1[3], 'Grace Myanmar Page');
  assert.equal(row1[7], '已提交待群管审核');
  assert.equal(row1[8], 'ဒီစာကို ဖတ်ပြီး "အာမင်" လို့ ရေးပေးပါ');

  const row2 = lines[2]?.split('\t') ?? [];
  assert.equal(row2[2], '个人号');
  assert.equal(row2[3], 'Aung Min');
  assert.equal(row2[7], '已发布');
  assert.equal(row2[8], ' =Hot Deal Today!');
});

test('formatBumperLogsAsTsv and formatUnifiedPostAndBumpLogsAsTsv handle group & page bumper modes cleanly', () => {
  const profiles = [
    {
      id: 'p-9',
      browserName: '用户9',
      account: { id: '1000999', name: 'Thazin' },
    },
  ];
  const bumperLogs: BumperLog[] = [
    {
      id: 'b-1',
      profileId: 'p-9',
      accountId: '1000999',
      groupId: '112233',
      groupName: 'Mandalay Group',
      pageId: '6155999',
      pageName: 'Hope Page',
      postId: '777888999',
      postUrl: 'https://www.facebook.com/groups/112233/posts/777888999/',
      liked: true,
      commentText: 'Amen!\nGod bless',
      bumpedAt: new Date(2026, 10, 10, 9, 15, 0).getTime(),
      sourceMode: 'group',
    },
    {
      id: 'b-2',
      profileId: 'p-9',
      accountId: '1000999',
      groupId: '-',
      groupName: '专页主页',
      pageId: '6155999',
      pageName: 'Hope Page',
      postId: '888999000',
      postUrl: 'https://www.facebook.com/6155999/posts/888999000',
      liked: true,
      commentText: null,
      bumpedAt: new Date(2026, 10, 10, 10, 0, 0).getTime(),
      sourceMode: 'page',
    },
  ];

  const bumperTsv = formatBumperLogsAsTsv(bumperLogs, profiles);
  const bLines = bumperTsv.split('\n');
  assert.equal(bLines.length, 3);
  for (const line of bLines) {
    assert.equal(line.split('\t').length, BUMPER_LOG_TSV_HEADERS.length);
  }
  assert.equal(bLines[1]?.split('\t')[1], '小组顶贴');
  assert.equal(bLines[1]?.split('\t')[10], 'Amen! God bless');
  assert.equal(bLines[2]?.split('\t')[1], '专页顶贴');
  assert.equal(bLines[2]?.split('\t')[5], '专页主页');
  assert.equal(bLines[2]?.split('\t')[6], '');

  const unified = formatUnifiedPostAndBumpLogsAsTsv({
    posterLogs: [
      {
        id: 'p-log-1',
        profileId: 'p-9',
        accountId: '1000999',
        accountName: 'Thazin',
        accountAvatar: null,
        identityType: 'personal',
        groupId: '112233',
        groupName: 'Mandalay Group',
        groupAvatar: null,
        materialId: 'm1',
        captionPreview: 'Hello\tWorld',
        postId: '333444',
        postUrl: 'https://www.facebook.com/groups/112233/posts/333444/',
        postedAt: new Date(2026, 10, 10, 11, 0, 0).getTime(),
      },
    ],
    bumperLogs,
    profiles,
  });
  assert.equal(unified.count, 3);
  const uLines = unified.tsv.split('\n');
  assert.equal(uLines.length, 4);
  for (const line of uLines) {
    assert.equal(line.split('\t').length, UNIFIED_POST_BUMP_TSV_HEADERS.length);
  }
  assert.equal(uLines[1]?.split('\t')[1], '小组发帖');
  assert.equal(uLines[2]?.split('\t')[1], '专页顶贴');
  assert.equal(uLines[3]?.split('\t')[1], '小组顶贴');
});

test('collectAllPaginatedLogs walks cursor pages until short page and deduplicates ids', async () => {
  const page1 = [
    { id: 'r-5', ts: 500 },
    { id: 'r-4', ts: 400 },
  ];
  const calls: Array<[number, string]> = [];
  const all = await collectAllPaginatedLogs({
    initialRows: page1,
    pageSize: 2,
    getTimestamp: (r) => r.ts,
    fetchPage: async (before, beforeId) => {
      calls.push([before, beforeId]);
      if (beforeId === 'r-4') {
        return [
          { id: 'r-4', ts: 400 },
          { id: 'r-3', ts: 300 },
        ];
      }
      if (beforeId === 'r-3') {
        return [{ id: 'r-2', ts: 200 }];
      }
      return [];
    },
  });
  assert.deepEqual(
    all.map((r) => r.id),
    ['r-5', 'r-4', 'r-3', 'r-2'],
  );
  assert.deepEqual(calls, [
    [400, 'r-4'],
    [300, 'r-3'],
  ]);
});
