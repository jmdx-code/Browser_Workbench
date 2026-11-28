// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { api } from '../src/renderer/api.js';
import {
  ConfigurableDataTable,
  type TableColumnDef,
} from '../src/renderer/modules/configurable-data-table.js';
import { DailyRiskLimitModal } from '../src/renderer/modules/daily-risk-limit-modal.js';
import { PostBumpRecordsPage } from '../src/renderer/modules/post-bump-records-page.js';
import { DEFAULT_DAILY_RISK_LIMIT_SETTINGS } from '../src/shared/daily-risk-limits.js';
import { formatDynamicTableAsTsv } from '../src/shared/log-table-copy.js';
import { buildBumpColumns } from '../src/renderer/modules/records-columns.js';

vi.mock('../src/renderer/api.js', () => ({
  api: {
    activityStats: vi.fn(),
    postBumpRecords: vi.fn(),
    deletePostBumpRecords: vi.fn(),
    inviterRecords: vi.fn(),
    deleteInviterRecords: vi.fn(),
    browserRiskLimits: vi.fn(),
    saveBrowserRiskLimits: vi.fn(),
    bluestacksAction: vi.fn(),
  },
}));

let host: HTMLDivElement;
let root: Root;

async function click(el: Element | null) {
  expect(el).toBeTruthy();
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function setInput(el: HTMLInputElement | null, val: string) {
  expect(el).toBeTruthy();
  await act(async () => {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    desc?.set?.call(el, val);
    el?.dispatchEvent(new Event('input', { bubbles: true }));
    el?.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

describe('Records & Statistics Center UI', () => {
  it('ConfigurableDataTable persists column visibility, order, width resize, reset, and dynamic TSV matches visible order', async () => {
    interface Row {
      id: string;
      a: string;
      b: string;
      c: string;
    }
    const cols: TableColumnDef<Row>[] = [
      {
        key: 'a',
        label: '列A',
        defaultWidth: 100,
        renderCell: (r) => r.a,
        exportValue: (r) => r.a,
      },
      {
        key: 'b',
        label: '列B',
        defaultWidth: 120,
        renderCell: (r) => r.b,
        exportValue: (r) => r.b,
      },
      {
        key: 'c',
        label: '列C',
        defaultWidth: 90,
        defaultVisible: false,
        renderCell: (r) => r.c,
        exportValue: (r) => r.c,
      },
    ];
    let latestVisible: ReadonlyArray<TableColumnDef<Row>> = [];
    const rows: Row[] = [{ id: '1', a: 'valA', b: 'valB', c: 'valC' }];

    await act(async () => {
      root.render(
        <ConfigurableDataTable
          testId="cfg-tbl"
          storageKey="test-cfg"
          columns={cols}
          rows={rows}
          getRowKey={(r) => r.id}
          onVisibleColumnsChange={(next) => {
            latestVisible = next;
          }}
        />,
      );
    });

    expect(latestVisible.map((c) => c.key)).toEqual(['a', 'b']);

    // Open 列设置, toggle 列C on, move 列C up before 列B
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('列设置')) ?? null,
    );
    const colCCheckbox = [...host.querySelectorAll('label')]
      .find((l) => l.textContent?.includes('列C'))
      ?.querySelector('input[type="checkbox"]');
    await click(colCCheckbox ?? null);
    await click(host.querySelector('button[aria-label="上移 列C"]'));
    expect(latestVisible.map((c) => c.key)).toEqual(['a', 'c', 'b']);

    const { tsv } = formatDynamicTableAsTsv(
      latestVisible.map((c) => ({ header: c.label, value: c.exportValue })),
      rows,
    );
    expect(tsv).toBe('列A\t列C\t列B\nvalA\tvalC\tvalB');

    // Resize 列A header and double-click to reset
    const resizer = host.querySelector('[aria-label="调整 列A 列宽"]');
    expect(resizer).toBeTruthy();
    await act(async () => {
      resizer?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 180 }));
      window.dispatchEvent(new MouseEvent('mouseup'));
    });
    expect(host.querySelector('col')?.getAttribute('style')).toContain('180px');

    // Verify localStorage persistence across unmount/remount
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => {
      root.render(
        <ConfigurableDataTable
          testId="cfg-tbl"
          storageKey="test-cfg"
          columns={cols}
          rows={rows}
          getRowKey={(r) => r.id}
          onVisibleColumnsChange={(next) => {
            latestVisible = next;
          }}
        />,
      );
    });
    expect(latestVisible.map((c) => c.key)).toEqual(['a', 'c', 'b']);
    expect(host.querySelector('col')?.getAttribute('style')).toContain('180px');

    // Double-click resizer resets width, and 恢复默认 resets order & visibility
    await act(async () => {
      host
        .querySelector('[aria-label="调整 列A 列宽"]')
        ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(host.querySelector('col')?.getAttribute('style')).toContain('100px');
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('列设置')) ?? null,
    );
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === '恢复默认') ??
        null,
    );
    expect(latestVisible.map((c) => c.key)).toEqual(['a', 'b']);
  });

  it('DailyRiskLimitModal supports browser 5-cap config (no duration cap) and saves per-target overrides', async () => {
    const profileId = '00000000-0000-4000-8000-000000000001';
    const baseState = {
      settings: { ...DEFAULT_DAILY_RISK_LIMIT_SETTINGS },
      dailyUsage: {
        dateYmd: '2026-11-27',
        totalGroupBumps: 0,
        totalPageBumps: 0,
        totalPosts: 0,
        totalInvites: 0,
        totalActiveLikes: 0,
        totalActions: 0,
        reachedLimitTargets: 0,
        perTarget: {},
      },
    };
    vi.mocked(api.browserRiskLimits).mockResolvedValue(baseState);
    vi.mocked(api.saveBrowserRiskLimits).mockResolvedValue(baseState);

    await act(async () => {
      root.render(
        <DailyRiskLimitModal
          carrier="browser"
          targets={[{ id: profileId, title: 'Chrome 1', subtitle: 'User One' }]}
          onClose={() => {}}
        />,
      );
    });

    expect(host.textContent).toContain('每日安全限额设置（Chrome 浏览器）');
    expect(host.textContent).toContain('每日活跃点赞上限');
    expect(host.textContent).toContain('今日动作 (总/顶/帖/邀/赞)');
    expect(host.textContent).toContain('生效上限 (总/顶/帖/邀/赞)');
    expect(host.textContent).not.toContain('活跃时长上限');

    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === '保存全局限额') ??
        null,
    );
    expect(api.saveBrowserRiskLimits).toHaveBeenCalledTimes(1);
  });

  it('PostBumpRecordsPage renders 4 tabs, groupBy toggle, AND filter popover, clickable real post URL, and single-ledger delete dialog', async () => {
    const p1 = '00000000-0000-4000-8000-000000000011';
    vi.mocked(api.activityStats).mockResolvedValue({
      totals: {
        posts: 2,
        pendingPosts: 0,
        groupBumps: 3,
        pageBumps: 1,
        bumps: 4,
        invites: 5,
        activeDurationMs: 125_000,
        activeLikes: 6,
        activeFriends: 2,
        failures: 0,
        totalActions: 19,
      },
      rows: [
        {
          rowKey: `browser:${p1}`,
          carrier: 'browser',
          profileId: p1,
          windowName: '窗口一号',
          accountId: '1000888',
          accountName: 'Alice FB',
          accountAvatarUrl: '',
          posts: 2,
          pendingPosts: 0,
          groupBumps: 3,
          pageBumps: 1,
          bumps: 4,
          invites: 5,
          activeDurationMs: 125_000,
          activeLikes: 6,
          activeFriends: 2,
          failures: 0,
          totalActions: 19,
          lastActiveAt: 1700000000000,
          dailyLimitReached: false,
          dailyLimitReason: null,
        },
      ],
    });
    vi.mocked(api.postBumpRecords).mockResolvedValue({
      records: [
        {
          id: 'rec-post-1',
          recordType: 'post',
          carrier: 'browser',
          status: 'success',
          profileId: p1,
          windowName: '窗口一号',
          accountId: '1000888',
          accountName: 'Alice FB',
          accountAvatarUrl: '',
          groupId: '999001',
          groupName: 'Group One',
          groupAvatarUrl: '',
          pageId: '',
          pageName: '',
          pageAvatarUrl: '',
          postId: 'post-777',
          postUrl: 'https://www.facebook.com/groups/999001/posts/post-777/',
          liked: false,
          commentText: null,
          storyShared: false,
          captionPreview: 'Hello',
          errorReason: '',
          sourceLogId: null,
          createdAt: 1700000000000,
        },
      ],
      total: 1,
      hasMore: false,
      statusCounts: { total: 1, confirmed: 1, pending: 0, failed: 0 },
    });
    vi.mocked(api.inviterRecords).mockResolvedValue({
      records: [
        {
          id: 'inv-1',
          carrier: 'browser',
          profileId: p1,
          windowName: '窗口一号',
          accountId: '1000888',
          accountName: 'Alice FB',
          accountAvatarUrl: '',
          groupId: '999001',
          groupName: 'Group One',
          groupAvatarUrl: '',
          friendId: '50001',
          friendName: 'Bob',
          confirmation: 'CONFIRMED',
          invitedAt: 1700000000000,
        },
      ],
      total: 1,
      hasMore: false,
    });

    await act(async () => {
      root.render(<PostBumpRecordsPage onNotify={() => {}} />);
    });

    expect(host.textContent).toContain('统计面板');
    expect(host.textContent).toContain('发帖记录');
    expect(host.textContent).toContain('顶贴记录');
    expect(host.textContent).toContain('邀人记录');
    expect(host.textContent).toContain('窗口一号');

    await click(
      [...host.querySelectorAll('button[role="tab"]')].find((b) =>
        b.textContent?.includes('按 FB 账号'),
      ) ?? null,
    );
    expect(api.activityStats).toHaveBeenLastCalledWith(
      expect.objectContaining({ groupBy: 'account' }),
      expect.any(AbortSignal),
    );

    // Switch to 发帖记录, check clickable real URL + open filter popover + apply AND filter
    await click(
      [...host.querySelectorAll('button[role="tab"]')].find((b) =>
        b.textContent?.includes('发帖记录'),
      ) ?? null,
    );
    const link = host.querySelector(
      'a[href="https://www.facebook.com/groups/999001/posts/post-777/"]',
    );
    expect(link).toBeTruthy();

    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('筛选')) ?? null,
    );
    const groupInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="输入小组名或 ID…"]',
    );
    await setInput(groupInput, 'Group One');
    const urlInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="输入帖子 URL 片段或 Post ID…"]',
    );
    await setInput(urlInput, 'post-777');
    await click(
      [...document.body.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === '应用筛选',
      ) ?? null,
    );
    expect(api.postBumpRecords).toHaveBeenLastCalledWith(
      expect.objectContaining({ groupQuery: 'Group One', postUrlQuery: 'post-777' }),
      expect.any(AbortSignal),
    );

    // Check single-ledger clear confirmation modal copy
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === '清空全部') ??
        null,
    );
    expect(host.textContent).toContain('防重去重账本');
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === '取消') ?? null,
    );

    // Switch to 邀人记录 and check default confirmation pill + page size selector
    await click(
      [...host.querySelectorAll('button[role="tab"]')].find((b) =>
        b.textContent?.includes('邀人记录'),
      ) ?? null,
    );
    expect(api.inviterRecords).toHaveBeenCalled();
    expect(host.textContent).toContain('Bob');
    expect(host.textContent).toContain('默认：仅已确认');

    const sizeSelect = host.querySelector<HTMLSelectElement>('select[aria-label="每页显示条数"]');
    expect(sizeSelect?.value).toBe('50');
    await act(async () => {
      if (sizeSelect) {
        sizeSelect.value = '100';
        sizeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    expect(api.inviterRecords).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 100 }),
      expect.any(AbortSignal),
    );

    // Drill-down from 统计面板 count button into filtered detail tab
    await click(
      [...host.querySelectorAll('button[role="tab"]')].find((b) =>
        b.textContent?.includes('统计面板'),
      ) ?? null,
    );
    await click(
      [...host.querySelectorAll('button')].find(
        (b) => b.getAttribute('title') === '点击查看明细记录' && b.textContent?.trim() === '5',
      ) ?? null,
    );
    expect(api.inviterRecords).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountQuery: '1000888' }),
      expect.any(AbortSignal),
    );
  });

  it('Records columns render dash instead of ? on empty page-bump group avatar and recover gracefully on image error', async () => {
    const cols = buildBumpColumns(() => {});
    const groupAvatarCol = cols.find((c) => c.key === 'groupAvatar');
    const pageAvatarCol = cols.find((c) => c.key === 'pageAvatar');
    expect(groupAvatarCol).toBeTruthy();
    expect(pageAvatarCol).toBeTruthy();
    await act(async () => {
      root.render(
        <div>
          {groupAvatarCol?.renderCell({
            id: '1',
            recordType: 'page_bump',
            carrier: 'browser',
            status: 'success',
            profileId: 'p1',
            windowName: 'w1',
            accountId: '1',
            accountName: 'A1',
            accountAvatarUrl: '',
            groupId: '',
            groupName: '',
            groupAvatarUrl: '',
            pageId: '2',
            pageName: 'MyPage',
            pageAvatarUrl: 'https://example.invalid/broken.jpg',
            postId: '3',
            postUrl: 'https://facebook.com/3',
            liked: false,
            commentText: null,
            storyShared: false,
            captionPreview: '',
            errorReason: '',
            sourceLogId: null,
            createdAt: 1700000000000,
          })}
          {pageAvatarCol?.renderCell({
            id: '2',
            recordType: 'page_bump',
            carrier: 'browser',
            status: 'success',
            profileId: 'p1',
            windowName: 'w1',
            accountId: '1',
            accountName: 'A1',
            accountAvatarUrl: '',
            groupId: '',
            groupName: '',
            groupAvatarUrl: '',
            pageId: '2',
            pageName: 'MyPage',
            pageAvatarUrl: 'https://example.invalid/broken.jpg',
            postId: '3',
            postUrl: 'https://facebook.com/3',
            liked: false,
            commentText: null,
            storyShared: false,
            captionPreview: '',
            errorReason: '',
            sourceLogId: null,
            createdAt: 1700000000000,
          })}
        </div>,
      );
    });
    expect(host.textContent).toBe('-');
    expect(host.textContent).not.toContain('?');
    const img = host.querySelector('img');
    expect(img).toBeTruthy();
    await act(async () => {
      img?.dispatchEvent(new Event('error'));
    });
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('-M');
  });
});
