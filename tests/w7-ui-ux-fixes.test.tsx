// @vitest-environment happy-dom
import { DatabaseSync } from 'node:sqlite';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountsSidebarShell } from '../src/renderer/accounts-sidebar-shell.js';
import { api } from '../src/renderer/api.js';
import { AppMenu } from '../src/renderer/app-menu.js';
import { AutoSchedulerEditorModal } from '../src/renderer/auto-scheduler-editor-modal.js';
import { AutoSchedulerPage } from '../src/renderer/auto-scheduler-page.js';
import { ConfirmDialog } from '../src/renderer/confirm-dialog.js';
import { Editor } from '../src/renderer/editor.js';
import { FinderTargetList } from '../src/renderer/finder-target-list.js';
import { BumperAdvancedPopover } from '../src/renderer/group-bumper-controls.js';
import { BluestacksSidebar } from '../src/renderer/modules/bluestacks-sidebar.js';
import {
  ConfigurableDataTable,
  type TableColumnDef,
} from '../src/renderer/modules/configurable-data-table.js';
import { PosterTaskDispatchModal } from '../src/renderer/modules/poster-task-dispatch-modal.js';
import { buildInviteColumns, buildStatsColumns } from '../src/renderer/modules/records-columns.js';
import {
  DEFAULT_RECORDS_FILTER,
  RecordsFilterPopover,
} from '../src/renderer/modules/records-filter-popover.js';
import { RecordsStatsTab } from '../src/renderer/modules/records-stats-tab.js';
import { DropdownPopover } from '../src/renderer/modules/shared/module-ui.js';
import { GoogleSheetsTopbar } from '../src/renderer/modules/sheets/google-sheets-topbar.js';
import { WindowLayoutPage } from '../src/renderer/modules/window-layout-page.js';
import { WorkbenchTopbar } from '../src/renderer/workbench-topbar.js';
import { WorkbenchViewRouter, type ShellCtx } from '../src/renderer/workbench-view-router.js';
import { SqliteActivityStatsRepository } from '../src/infrastructure/activity-stats-store.js';
import { AccountActivityRowSchema, type AccountActivityRow } from '../src/shared/activity-stats.js';
import type { BluestacksState } from '../src/shared/bluestacks.js';
import type { Combination, SavedCombination } from '../src/shared/contracts.js';
import { newCombination } from '../src/renderer/modules/module-contracts.js';
import { BumperSettings } from '../src/shared/group-bumper.js';
import { defaultWindowLayout } from '../src/shared/window-layout.js';

vi.mock('../src/renderer/api.js', () => ({
  api: {
    activityStats: vi.fn(),
    backupStatus: vi.fn(),
    bluestacksAction: vi.fn(),
    bluestacksState: vi.fn(),
    browserRiskLimits: vi.fn(),
    bumperState: vi.fn(),
    cleanupSettings: vi.fn(),
    create: vi.fn(),
    googleSheetsAuthStatus: vi.fn(),
    maintenance: vi.fn(),
    materialCache: vi.fn(),
    materialUsage: vi.fn(),
    resetStatus: vi.fn(),
    restoreStatus: vi.fn(),
    saveCombination: vi.fn(),
    softwareUpdateStatus: vi.fn(),
    targetFolders: vi.fn(),
    windowLayout: vi.fn(),
  },
}));

let host: HTMLDivElement;
let root: Root;

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function makeBsState(): BluestacksState {
  return {
    config: {
      installDir: 'C:\\BS',
      confPath: 'C:\\BS\\bluestacks.conf',
      apkPath: 'C:\\fb-lite.apk',
      detectedApkPath: 'C:\\fb-lite.apk',
    },
    instances: [
      {
        id: 'bs-1',
        instanceKey: 'Pie64',
        displayName: '蓝蝶-01',
        alias: '',
        folderId: null,
        adbPort: 5555,
        online: true,
        fbLiteInstalled: true,
        fbWidth: 720,
        fbHeight: 1280,
        accountState: 'logged-in',
        accountName: 'Alice',
        accountId: '1001',
        lastCheckedAt: null,
      },
    ],
    folders: [{ id: 'f1', name: '分组A' }],
    launchingIds: [],
    closingIds: [],
    inspectingIds: [],
    installingIds: [],
    loggingInIds: [],
    switchingIds: [],
    activeProfileCounts: {},
    posterProfileCounts: {},
    inviterProfileCounts: {},
    pageBumperProfileCounts: {},
    profileCounts: {},
    bumperSettings: BumperSettings.parse({}),
    dailyUsage: { date: '2026-11-28', perInstance: {} },
    riskLimitSettings: {
      enabled: true,
      dailyMaxTotalActions: 50,
      dailyMaxBumps: 20,
      dailyMaxPosts: 10,
      dailyMaxInvites: 20,
      dailyMaxActiveLikes: 30,
      perInstanceOverrides: {},
    },
  } as unknown as BluestacksState;
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);

  if (typeof HTMLDialogElement !== 'undefined') {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
    };
  }

  vi.mocked(api.targetFolders).mockResolvedValue([]);
  vi.mocked(api.bumperState).mockResolvedValue({ pages: [] } as never);
  vi.mocked(api.activityStats).mockResolvedValue({
    totals: {
      posts: 0,
      pendingPosts: 0,
      groupBumps: 0,
      pageBumps: 0,
      bumps: 0,
      invites: 0,
      activeDurationMs: 0,
      activeLikes: 0,
      activeFriends: 0,
      failures: 0,
      totalActions: 0,
    },
    rows: [],
  });
  vi.mocked(api.windowLayout).mockResolvedValue({
    displays: [
      {
        id: 'disp-1',
        label: '主屏幕',
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 0, width: 1440, height: 860 },
        primary: true,
      },
    ],
    settings: defaultWindowLayout,
    presets: [],
    onlineCount: 0,
    totalCount: 0,
    windows: [],
  } as never);
  vi.mocked(api.backupStatus).mockResolvedValue({
    available: true,
    defaultDirectory: 'C:\\backups',
    lastBackupAt: null,
  } as never);
  vi.mocked(api.restoreStatus).mockResolvedValue({
    available: true,
    state: 'IDLE',
    defaultDirectory: 'C:\\backups',
  } as never);
  vi.mocked(api.maintenance).mockResolvedValue({
    locations: { cacheDirectory: 'C:\\cache', logDirectory: 'C:\\logs' },
    logStatus: 'active',
    settings: { logRetentionDays: 14 },
  } as never);
  vi.mocked(api.materialCache).mockResolvedValue({ entries: [] } as never);
  vi.mocked(api.materialUsage).mockResolvedValue({
    contents: 0,
    published: 0,
    generation: 1,
    activePublishing: false,
    lastClearedAt: null,
  } as never);
  vi.mocked(api.cleanupSettings).mockResolvedValue({
    retentionDays: 30,
    autoCleanup: false,
  } as never);
  vi.mocked(api.resetStatus).mockResolvedValue({ active: false } as never);
  vi.mocked(api.softwareUpdateStatus).mockResolvedValue({
    softwareVersion: '0.1.274',
    extensionVersion: '0.1.274',
    extensionDirectory: 'C:\\ext',
    aiWorkspaceDirectory: 'C:\\ai',
    availableUpdate: null,
  } as never);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

describe('w7 ui & ux overhaul (UX-01 ~ UX-09 + BUG-P1-02 UI)', () => {
  it('UX-01: DropdownPopover portals to document.body (or dialog) with fixed viewport clamping and role="dialog"', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 300, configurable: true });

    await act(async () => {
      root.render(
        <DropdownPopover label="批量操作" ariaLabel="批量操作菜单">
          <div>菜单项 A</div>
        </DropdownPopover>,
      );
    });

    const triggerWrap = host.querySelector('div.relative') as HTMLElement;
    vi.spyOn(triggerWrap, 'getBoundingClientRect').mockReturnValue({
      top: 260,
      bottom: 288,
      left: 340,
      right: 396,
      width: 56,
      height: 28,
      x: 340,
      y: 260,
      toJSON: () => ({}),
    });

    const btn = host.querySelector('button[aria-label="批量操作菜单"]');
    await click(btn);

    const menu = document.body.querySelector(
      '.gs-dropdown-menu[role="dialog"]',
    ) as HTMLElement | null;
    expect(menu).toBeTruthy();
    expect(host.contains(menu)).toBe(false);
    expect(menu?.className).toContain('fixed');
    expect(Number.parseFloat(menu?.style.left ?? '999')).toBeLessThanOrEqual(400 - 8);
    expect(Number.parseFloat(menu?.style.top ?? '999')).toBeLessThan(260);
  });

  it('UX-02: RecordsFilterPopover portals filter form with role="dialog", aria-label, and normalized title', async () => {
    await act(async () => {
      root.render(
        <RecordsFilterPopover kind="posts" value={DEFAULT_RECORDS_FILTER} onChange={vi.fn()} />,
      );
    });

    const btn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('筛选'));
    await click(btn);

    const form = document.body.querySelector('form[role="dialog"][aria-label="多条件组合筛选"]');
    expect(form).toBeTruthy();
    expect(host.contains(form)).toBe(false);
    expect(form?.className).toContain('fixed');
    expect(form?.textContent).toContain('多条件组合筛选 (同时满足 AND)');
  });

  it('UX-03: BlueStacks BatchLogin & DailyRiskLimit modals unmount on 1st click of 关闭; ConfirmDialog/column picker have ARIA dialog roles', async () => {
    const bsState = makeBsState();
    await act(async () => {
      root.render(
        <BluestacksSidebar
          state={bsState}
          onChange={vi.fn()}
          selected={new Set(['bs-1'])}
          onSelect={vi.fn()}
          onError={vi.fn()}
        />,
      );
    });

    // Open and 1-click close BluestacksBatchLoginModal (NativeModalShell)
    const batchLoginBtn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('批量登录'),
    );
    await click(batchLoginBtn);
    expect(host.querySelector('dialog[open]')).toBeTruthy();
    const bsTextarea = host.querySelector('textarea');
    expect(bsTextarea?.className).toContain('min-h-[168px]');
    const closeBatchBtn = host.querySelector('dialog button[aria-label="关闭弹窗"]');
    await click(closeBatchBtn);
    expect(host.querySelector('dialog')).toBeNull();
    expect(host.querySelector('div.modal.flex')).toBeNull();

    // Open and 1-click close DailyRiskLimitModal (BackdropModal)
    const riskBtn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('日限额'),
    );
    await click(riskBtn);
    expect(host.querySelector('div.modal-backdrop')).toBeTruthy();
    expect(host.querySelector('div.modal.flex')).toBeTruthy();
    const closeRiskBtn = host.querySelector('.modal-backdrop button[aria-label="关闭弹窗"]');
    await click(closeRiskBtn);
    expect(host.querySelector('div.modal-backdrop')).toBeNull();
    expect(host.querySelector('div.modal.flex')).toBeNull();

    // ConfirmDialog alertdialog + ConfigurableDataTable column picker dialog role
    const cols: TableColumnDef<{ id: string; name: string }>[] = [
      { key: 'name', label: '名称', defaultWidth: 120, renderCell: (r) => r.name },
    ];
    await act(async () => {
      root.render(
        <>
          <ConfirmDialog
            title="删除确认"
            description="确定删除吗"
            label="删除"
            onClose={vi.fn()}
            onConfirm={vi.fn()}
          />
          <ConfigurableDataTable
            storageKey="w7-test-tbl"
            columns={cols}
            rows={[{ id: '1', name: 'Row1' }]}
            getRowKey={(r) => r.id}
            emptyText="无"
          />
        </>,
      );
    });
    expect(host.querySelector('dialog[role="alertdialog"]')).toBeTruthy();
    const colBtn = [...host.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label')?.includes('列设置') || b.textContent?.includes('列设置'),
    );
    await click(colBtn);
    expect(host.querySelector('[role="dialog"][aria-label="列设置"]')).toBeTruthy();
  });

  it('UX-04: PosterTaskDispatchModal leaves selected browsers empty when init is empty and disables confirm at 0 selected', async () => {
    await act(async () => {
      root.render(
        <PosterTaskDispatchModal
          materials={[
            {
              id: 'm1',
              caption: 'hello',
              mediaSource: '',
              mediaKind: 'none',
              updatedAt: Date.now(),
              createdAt: Date.now(),
            } as never,
          ]}
          state={
            {
              groups: [{ id: 'g1', name: '小组1', url: 'https://fb.com/groups/1' }],
            } as never
          }
          folders={[]}
          profiles={[
            { id: 'p1', name: 'Win1', online: true, account: { id: 'a1', name: 'A1' } } as never,
            { id: 'p2', name: 'Win2', online: false, account: { id: 'a2', name: 'A2' } } as never,
          ]}
          initialSelectedProfileIds={[]}
          bluestacksInstances={[
            { id: 'bs-1', displayName: 'BS1', online: true, accountName: 'BS' } as never,
          ]}
          initialSelectedBluestacksIds={[]}
          busy={false}
          onClose={vi.fn()}
          onSubmitTask={vi.fn(async () => true)}
          onSubmitBluestacks={vi.fn(async () => true)}
        />,
      );
    });

    const selectedModeTab = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('指定账号'),
    );
    await click(selectedModeTab);
    expect(host.textContent).toContain(
      '当前未勾选指定浏览器 (0)，请先在左侧勾选浏览器，或切换为「全部在线账号」',
    );
    const submitBrowserBtn = [...host.querySelectorAll('footer button')].find((b) =>
      b.textContent?.includes('立即开始'),
    ) as HTMLButtonElement;
    expect(submitBrowserBtn.disabled).toBe(true);

    const bsCarrierTab = [...host.querySelectorAll('button[role="tab"]')].find((b) =>
      b.textContent?.includes('蓝蝶模拟器'),
    );
    await click(bsCarrierTab);
    expect(host.textContent).toContain('当前未勾选蓝蝶实例 (0)');
    const submitBsBtn = [...host.querySelectorAll('footer button')].find((b) =>
      b.textContent?.includes('立即开始'),
    ) as HTMLButtonElement;
    expect(submitBsBtn.disabled).toBe(true);
  });

  it('UX-05: WindowLayoutPage syncs carrier changes via onCarrierChange', async () => {
    const onCarrierChange = vi.fn();
    await act(async () => {
      root.render(
        <WindowLayoutPage
          profiles={[]}
          bluestacks={makeBsState()}
          initialCarrier="browser"
          onCarrierChange={onCarrierChange}
        />,
      );
    });
    await flush();

    const bsTab = [...host.querySelectorAll('button[role="tab"]')].find((b) =>
      b.textContent?.includes('蓝蝶窗口'),
    );
    await click(bsTab);
    expect(onCarrierChange).toHaveBeenCalledWith('bluestacks');
  });

  it('UX-06: AutoSchedulerPage avoids nested button in summary; AutoSchedulerEditorModal avoids duplicate 收起 & nested scroll', async () => {
    const now = Date.now();
    await act(async () => {
      root.render(
        <AutoSchedulerPage
          state={{
            enabled: true,
            settings: { preventSystemSleep: true } as never,
            schedules: [],
            recentRuns: [
              {
                id: 'r1',
                scheduleId: 's1',
                scheduleName: '早班',
                status: 'completed',
                startedAt: now - 5000,
                finishedAt: now,
                items: [],
              } as never,
            ],
            activeRuns: [],
          }}
          combinations={[]}
          profiles={[]}
          profileGroups={[]}
          bluestacks={makeBsState()}
          onStateChange={vi.fn()}
          onRefresh={vi.fn(async () => {})}
          onNotify={vi.fn()}
          onOpenLiveRuns={vi.fn()}
        />,
      );
    });

    expect(host.querySelector('details > summary button')).toBeNull();
    const clearBtn = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '清空',
    );
    expect(clearBtn).toBeTruthy();
    expect(clearBtn?.closest('summary')).toBeNull();

    await act(async () => {
      root.render(
        <AutoSchedulerEditorModal
          initial={null}
          combinations={[]}
          profiles={[
            {
              id: 'p1',
              name: 'Win1',
              online: true,
              groupId: 'g1',
              account: { name: 'A1' },
            } as never,
          ]}
          profileGroups={[{ id: 'g1', name: '组1', color: 'blue' }]}
          selectedProfileIds={new Set()}
          sharedGroups={[]}
          sharedPages={[]}
          posterMaterials={[]}
          bluestacksState={makeBsState()}
          browserConcurrency={3}
          bluestacksConcurrency={2}
          onClose={vi.fn()}
          onSave={vi.fn(async () => {})}
        />,
      );
    });

    const groupBadge = host.querySelector('button em');
    expect(groupBadge?.className).toContain('shrink-0');
    expect(groupBadge?.className).toContain('whitespace-nowrap');

    const manualTab = [...host.querySelectorAll('button[role="tab"]')].find((b) =>
      b.textContent?.includes('手动选'),
    );
    await click(manualTab);
    const toggleBtn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('勾选'),
    );
    await click(toggleBtn);
    const collapseBtns = [...host.querySelectorAll('button')].filter((b) =>
      b.textContent?.includes('收起'),
    );
    expect(collapseBtns).toHaveLength(1);
    const flattenedWrapper = host.querySelector('[class*="[&_.overflow-y-auto]:overflow-visible"]');
    expect(flattenedWrapper).toBeTruthy();
  });

  it('UX-07 & UX-08: ActivityStatsStore populates windowCount/mergedWindowNames and records-columns fits viewport + renders pill', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE profiles(id TEXT PRIMARY KEY, name TEXT, group_id TEXT, account_id TEXT, account_name TEXT, avatar_url TEXT, position INTEGER DEFAULT 0);
      CREATE TABLE profile_metadata(profile_id TEXT PRIMARY KEY, alias TEXT);
      CREATE TABLE groups(id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE post_bump_records(id TEXT PRIMARY KEY, carrier TEXT, profile_id TEXT, account_id TEXT, account_name TEXT, record_type TEXT, status TEXT, post_id TEXT, created_at INTEGER);
      INSERT INTO profiles(id, name, account_id, account_name, position) VALUES
        ('p1', '浏览器A', 'fb-99', '主账号', 0),
        ('p2', '浏览器B', 'fb-99', '主账号', 1);
      INSERT INTO profile_metadata(profile_id, alias) VALUES
        ('p1', '浏览器A'),
        ('p2', '浏览器B');
      INSERT INTO post_bump_records VALUES
        ('r1', 'browser', 'p1', 'fb-99', '主账号', 'post', 'success', '111', ${Date.now()}),
        ('r2', 'browser', 'p2', 'fb-99', '主账号', 'group_bump', 'success', '222', ${Date.now()});
    `);
    const store = new SqliteActivityStatsRepository(db);
    const stats = store.queryStats({
      from: 0,
      to: Date.now() + 1000,
      carrier: 'all',
      groupBy: 'account',
      onlyActive: false,
      search: '',
    });
    expect(stats.rows).toHaveLength(1);
    const row = AccountActivityRowSchema.parse(stats.rows[0]);
    expect(row.windowCount).toBe(2);
    expect(row.mergedWindowNames).toEqual(['浏览器A', '浏览器B']);
    expect(row.windowName).toBe('浏览器A / 浏览器B');
    db.close();

    const statsCols = buildStatsColumns();
    const visibleDefaultWidth = statsCols
      .filter((c) => c.defaultVisible !== false)
      .reduce((sum, c) => sum + c.defaultWidth, 0);
    expect(visibleDefaultWidth).toBeLessThanOrEqual(1120);

    const winCol = statsCols.find((c) => c.key === 'windowName');
    const renderedCell = winCol?.renderCell(row as AccountActivityRow);
    await act(async () => {
      root.render(<div>{renderedCell}</div>);
    });
    expect(host.textContent).toContain('已合并 2 窗口');
    expect(host.querySelector('[title*="浏览器A"]')).toBeTruthy();

    const inviteCols = buildInviteColumns({ onViewGroupAvatar: vi.fn(), onCopy: vi.fn() });
    const groupAvatarCol = inviteCols.find((c) => c.key === 'groupAvatar');
    expect(groupAvatarCol?.defaultWidth).toBeGreaterThanOrEqual(74);
  });

  it('UX-08 & UX-09 & BUG-P1-02 UI: layout tokens, Escape/eager Editor, legacy directory banner, date labels, and AppMenu cross-links', async () => {
    await act(async () => {
      root.render(
        <>
          <FinderTargetList
            listKind="shared_groups"
            title="小组列表"
            countLabel="1 个"
            items={[
              {
                id: 't1',
                name: '测试组',
                url: 'https://fb.com/groups/1',
                folderId: null,
                folderName: '',
                createdAt: 0,
              },
            ]}
            selected={new Set()}
            onSelect={vi.fn()}
            onDelete={vi.fn(async () => {})}
            onChanged={vi.fn(async () => {})}
          />
          <BumperAdvancedPopover
            settings={BumperSettings.parse({})}
            bsMode={false}
            pageMode={false}
            onUpdate={vi.fn()}
          />
          <GoogleSheetsTopbar
            kind="post_records"
            title="发帖记录表"
            addLabel="绑定"
            activeLink={
              {
                id: 'l1',
                title: '记录表',
                spreadsheetId: 'sp1',
                spreadsheetTitle: '记录表',
                spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sp1',
                sheetName: 'Sheet1',
                kind: 'post_records',
                runtime: { lastError: '', activeJobText: '' },
              } as never
            }
            allRecordLinks={[]}
            profileGroups={[]}
            profiles={[]}
            isAuthorized
            isRunning={false}
            isAutoEnabled={false}
            busyAction={null}
            stoppingLink={false}
            patchingConfig={false}
            machineNameDraft=""
            onOpenConnect={vi.fn()}
            onOpenConnectRecordForSchedule={vi.fn()}
            onOpenImportModal={vi.fn()}
            onOpenBumpModal={vi.fn()}
            onOpenFreqModal={vi.fn()}
            onConfirmDisconnect={vi.fn()}
            onRunAction={vi.fn()}
            onStopActiveLink={vi.fn()}
            onPatchScheduleConfig={vi.fn()}
            onPatchRecordsConfig={vi.fn()}
            onMachineNameChange={vi.fn()}
            onMachineNameBlur={vi.fn()}
          />
          <AccountsSidebarShell
            title="浏览器窗口"
            countTitle="在线/全部"
            onlineCount={1}
            totalCount={1}
            searchPlaceholder="搜索"
            list={{
              query: '',
              setQuery: vi.fn(),
              filter: 'all',
              setFilter: vi.fn(),
              closed: new Set(),
              toggleClosed: vi.fn(),
              openFolders: vi.fn(),
            }}
            selectAllLabel="全选"
            matchedIds={['p1']}
            filterLabels={['全部', '在线', '已选']}
            creatingBusy={false}
            onCreateGroup={vi.fn()}
            groups={[]}
            selected={new Set(['p1'])}
            onSelect={vi.fn()}
            busy={false}
            onNudgeGroup={vi.fn()}
            onRenameGroupSubmit={vi.fn()}
            onDeleteGroupConfirm={vi.fn()}
            deleteGroupDescription="desc"
            renderRow={() => <div />}
            emptyGroupText={() => '空'}
            selectionBarAriaLabel="操作"
            selectionActions={[]}
            dialogs={null}
          />
          <WorkbenchTopbar
            version="0.1.274"
            breadcrumbText="活跃账号 / 超长模块面包屑标题测试"
            onlineCount={1}
            totalProfilesCount={2}
            busy={false}
            error={null}
            updateStatus={null}
            updateError=""
            schedulerSettings={null}
            onSaveGlobalConcurrency={vi.fn(async () => true)}
            onOpenMenu={vi.fn()}
            onOpenUpdateMenu={vi.fn()}
            onApplyUpdate={vi.fn(async () => {})}
          />
          <RecordsStatsTab refreshToken={0} onNotify={vi.fn()} />
        </>,
      );
    });

    expect(host.innerHTML).toContain('grid-cols-[24px_minmax(110px,1fr)_116px_80px_28px]');
    const advBtn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('高级参数'),
    );
    await click(advBtn);
    const likeLabel = [...document.body.querySelectorAll('label')].find((l) =>
      l.textContent?.includes('点赞概率'),
    );
    const likeInput = likeLabel?.querySelector('input') as HTMLInputElement;
    expect(likeInput.className).toContain('w-16');
    const hiddenSep = host.querySelector('span[aria-hidden="true"].w-px');
    expect(hiddenSep?.className).toContain('min-[1440px]:inline-block');
    const selectedLabel = [...host.querySelectorAll('span')].find((s) =>
      s.textContent?.includes('已选'),
    );
    expect(selectedLabel?.className).toContain('whitespace-nowrap');
    const breadcrumb = host.querySelector('[aria-label="当前模块"]');
    expect(breadcrumb?.className).toContain('max-w-[360px]');

    // UX-09: RecordsStatsTab custom date labels
    const customTab = [...host.querySelectorAll('button[role="tab"]')].find((b) =>
      b.textContent?.includes('自定义'),
    );
    await click(customTab);
    expect(host.querySelector('label input[aria-label="开始日期"]')).toBeTruthy();
    expect(host.querySelector('label input[aria-label="结束日期"]')).toBeTruthy();

    // UX-09 + BUG-P1-02 UI: Editor eager render, Escape back, legacy directory migration banner
    const stepUuid = '00000000-0000-4000-8000-000000000001';
    const comboUuid = '00000000-0000-4000-8000-000000000002';
    const legacyCombo: Combination = {
      ...newCombination(),
      name: '旧目录组合',
      steps: [
        {
          id: stepUuid,
          type: 'post',
          resourceMode: 'directory',
          resourceDirectory: 'C:\\legacy-posts',
          allowRepeat: false,
          forbidSameAccountRepeat: true,
          archivePublished: false,
          count: 1,
        },
      ],
    };
    const savedRow: SavedCombination = {
      id: comboUuid,
      revision: 1,
      saved: legacyCombo,
      createdAt: 0,
      updatedAt: 0,
    };
    vi.mocked(api.saveCombination).mockResolvedValue({
      ...savedRow,
      revision: 2,
      saved: {
        ...legacyCombo,
        steps: [
          {
            id: stepUuid,
            type: 'post',
            resourceMode: 'table',
            resourceDirectory: '',
            allowRepeat: false,
            forbidSameAccountRepeat: true,
            archivePublished: false,
            count: 1,
          },
        ],
      },
    });
    const onCloseEditor = vi.fn();
    await act(async () => {
      root.render(
        <Editor
          initial={savedRow}
          onSaved={vi.fn(async () => {})}
          onClose={onCloseEditor}
          notify={vi.fn()}
          selectedProfiles={[]}
          onResources={vi.fn()}
          resourceUsage={null}
          resourceUsageLoaded
        />,
      );
    });
    expect(host.textContent).toContain('旧版「本地目录」发帖资源模式已下线');
    expect(host.querySelector('[aria-label="资源模式"]')).toBeNull();
    const saveBtn = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '保存组合',
    );
    await click(saveBtn);
    expect(api.saveCombination).toHaveBeenCalledWith(
      comboUuid,
      1,
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            type: 'post',
            resourceMode: 'table',
            resourceDirectory: '',
          }),
        ],
      }),
    );
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCloseEditor).toHaveBeenCalled();

    // Eager Editor in WorkbenchViewRouter (no "正在加载页面…" flash)
    const fakeShell = {
      workspace: { profiles: [], groups: [], combinations: [savedRow], active: {} },
      mods: {
        bluestacks: null,
        setBluestacks: vi.fn(),
        setGroupBumper: vi.fn(),
        setGroupPoster: vi.fn(),
        setGroupInviter: vi.fn(),
        autoScheduler: null,
        setAutoScheduler: vi.fn(),
        groupBumper: null,
        groupPoster: null,
        groupInviter: null,
      },
      selected: new Set<string>(),
      setSelected: vi.fn(),
      selectedBluestacks: new Set<string>(),
      setSelectedBluestacks: vi.fn(),
      setMessage: vi.fn(),
      forceRefreshWorkspace: vi.fn(async () => {}),
    } as unknown as ShellCtx;
    await act(async () => {
      root.render(
        <WorkbenchViewRouter
          shell={fakeShell}
          router={{
            view: { kind: 'edit', row: savedRow, editorKey: 'k1' },
            setView: vi.fn(),
            carrier: 'browser',
            cardColors: {} as never,
            resourceSummaries: [],
            setResourceSummaries: vi.fn(),
            onOpenResources: vi.fn(),
            refreshResources: vi.fn(async () => {}),
            openQuickSchedule: vi.fn(),
            onOpenLiveRuns: vi.fn(),
            openLedgerRecords: vi.fn(),
            ledger: { tab: 'stats', status: 'all', nonce: 0 },
            onOpenMenuSection: vi.fn(),
            navigate: vi.fn(async () => {}),
          }}
        />,
      );
    });
    expect(host.textContent).not.toContain('正在加载页面…');
    expect(host.textContent).toContain('编辑组合');

    // AppMenu cross-link between 数据备份与恢复 (backup) and 数据清理与重置 (logs)
    await act(async () => {
      root.render(
        <AppMenu
          busy={false}
          onClose={vi.fn()}
          profiles={[]}
          restartDisabled={false}
          onRestart={vi.fn()}
        />,
      );
    });
    await flush();
    const backupEntry = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('数据备份与恢复'),
    );
    await click(backupEntry);
    await flush();
    const toLogsBtn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('前往数据清理与重置'),
    );
    await click(toLogsBtn);
    await flush();
    const toBackupBtn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('前往数据备份与恢复'),
    );
    expect(toBackupBtn).toBeTruthy();
    await click(toBackupBtn);
    await flush();
    expect(
      [...host.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('前往数据清理与重置'),
      ),
    ).toBeTruthy();
  });
});
