// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { api } from '../src/renderer/api.js';
import { AppMenu } from '../src/renderer/app-menu.js';
import { DataCleanupPanel } from '../src/renderer/data-cleanup-panel.js';
import { FinderTargetList } from '../src/renderer/finder-target-list.js';
import { InviterWorkspacePage } from '../src/renderer/inviter-workspace-page.js';
import { WindowLayoutPage } from '../src/renderer/modules/window-layout-page.js';
import { getTargetProfileIds } from '../src/renderer/modules/window-layout-preview-canvas.js';
import { Sidebar } from '../src/renderer/sidebar.js';
import { SoftwareUpdatePanel } from '../src/renderer/software-update-panel.js';
import { WorkbenchViewRouter, type ShellCtx } from '../src/renderer/workbench-view-router.js';
import { WorkspaceMaintenancePanel } from '../src/renderer/workspace-maintenance-panel.js';
import type { BluestacksState } from '../src/shared/bluestacks.js';
import type { Group, Profile, Workspace } from '../src/shared/contracts.js';
import { BumperSettings } from '../src/shared/group-bumper.js';
import type { GroupInviterState } from '../src/shared/group-inviter.js';
import type { UpdateStatus } from '../src/shared/software-update.js';
import { defaultWindowLayout } from '../src/shared/window-layout.js';

vi.mock('../src/renderer/api.js', () => ({
  api: {
    targetFolders: vi.fn(),
    targetListCommand: vi.fn(),
    reorderProfiles: vi.fn(),
    reorderGroups: vi.fn(),
    windowLayout: vi.fn(),
    bluestacksAction: vi.fn(),
    saveGroupInviterSettings: vi.fn(),
    groupInviterState: vi.fn(),
    startGroupInviter: vi.fn(),
    stopGroupInviter: vi.fn(),
    cleanupSettings: vi.fn(),
    saveCleanupSettings: vi.fn(),
    resetStatus: vi.fn(),
    maintenance: vi.fn(),
    materialCache: vi.fn(),
    materialUsage: vi.fn(),
    softwareUpdateStatus: vi.fn(),
    configureSoftwareUpdate: vi.fn(),
    checkSoftwareUpdate: vi.fn(),
    openExtensionDirectory: vi.fn(),
    openAiWorkspaceDirectory: vi.fn(),
    reloadExtensions: vi.fn(),
  },
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(api.targetFolders).mockResolvedValue([]);
  vi.mocked(api.targetListCommand).mockResolvedValue({ saved: true });
  vi.mocked(api.reorderGroups).mockResolvedValue({ saved: true });
  vi.mocked(api.cleanupSettings).mockResolvedValue({
    revision: 1,
    historyRetentionDays: 30,
    historyMaxCount: 1000,
    logRetentionDays: 14,
    automaticLogs: false,
    bumperMaxCount: 300000,
    posterMaxCount: 100000,
    detailMaxCount: 1000,
  });
  vi.mocked(api.resetStatus).mockResolvedValue({
    available: false,
    reason: 'test',
    dataDirectory: '',
  });
  vi.mocked(api.maintenance).mockResolvedValue({
    settings: { revision: 1, logRetentionDays: 14 },
    locations: { cacheDirectory: 'C:\\cache', logDirectory: 'C:\\logs' },
    logStatus: 'ready',
  });
  vi.mocked(api.materialCache).mockResolvedValue({ entries: [], truncated: false });
  vi.mocked(api.materialUsage).mockResolvedValue({
    contents: 0,
    published: 0,
    generation: 1,
    activePublishing: false,
    lastClearedAt: null,
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  host.remove();
});

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  const name = overrides.browserName ?? overrides.alias ?? 'P1';
  return {
    id: overrides.id ?? '00000000-0000-4000-8000-000000000001',
    alias: name,
    browserName: name,
    groupId: null,
    order: 0,
    online: true,
    phase: 'PAUSED',
    synced: true,
    unresolved: 0,
    extensionVersion: '0.3.92',
    capabilities: [],
    presentation: null,
    account: { state: 'logged-in', id: '10001', name: 'Alice', avatar: 'https://img/a.jpg' },
    ...overrides,
  };
}

describe('W4 UI Regression Suite', () => {
  it('Pointer drag supports wheel scroll forwarding, edge auto-scroll, 400ms collapsed folder expand, and button click protection', async () => {
    const folderId = 'f0000000-0000-4000-8000-000000000010';
    vi.mocked(api.targetFolders).mockResolvedValue([
      { id: folderId, listKind: 'inviter_groups', name: '折叠组', sortOrder: 0, createdAt: 1 },
    ]);
    const items = [
      { id: '1', name: '组1', folderId: null, sortOrder: 0, avatarUrl: null, count: 1 },
      { id: '2', name: '组2', folderId: null, sortOrder: 1, avatarUrl: null, count: 2 },
      { id: '3', name: '组内项', folderId, sortOrder: 0, avatarUrl: null, count: 3 },
    ];
    const onDelete = vi.fn().mockResolvedValue(undefined);
    await act(async () =>
      root.render(
        <FinderTargetList
          listKind="inviter_groups"
          items={items}
          selected={new Set()}
          onSelect={() => {}}
          onDelete={onDelete}
          onChanged={async () => {}}
          title="测试目标"
          countLabel="累计"
        />,
      ),
    );

    // 1. Button click protection: pointerdown + pointermove on delete button must NOT start drag
    const delBtn = host.querySelector('button[aria-label="删除 组1"]')!;
    await act(async () => {
      delBtn.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 10, clientY: 60 }),
      );
    });
    expect(document.querySelector('[data-drag-ghost]')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await click(delBtn);
    expect(host.querySelector('dialog')).toBeTruthy();
    await click([...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === '取消'));

    // 2. Collapse folder first
    const folderBtn = [...host.querySelectorAll('.finder-folder-title')].find((b) =>
      b.textContent?.includes('折叠组'),
    );
    await click(folderBtn);
    expect(host.querySelector('[data-finder-id="3"]')).toBeNull();

    // 3. Start pointer drag on row 1, test wheel forwarding, edge auto-scroll, and 400ms folder hover-expand
    vi.useFakeTimers();
    const scrollBox = host.querySelector<HTMLElement>('.finder-columns')?.parentElement;
    expect(scrollBox).toBeTruthy();
    if (scrollBox) {
      Object.defineProperty(scrollBox, 'scrollTop', {
        value: 0,
        writable: true,
        configurable: true,
      });
      vi.spyOn(scrollBox, 'getBoundingClientRect').mockReturnValue({
        top: 100,
        bottom: 400,
        left: 0,
        right: 400,
        width: 400,
        height: 300,
      } as DOMRect);
    }
    const folderHead = host.querySelector('.finder-folder')!;
    vi.spyOn(folderHead, 'getBoundingClientRect').mockReturnValue({
      top: 360,
      bottom: 390,
      left: 0,
      right: 400,
      width: 400,
      height: 30,
    } as DOMRect);

    const row1 = host.querySelector('[data-finder-id="1"]')!;
    await act(async () => {
      row1.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 50, clientY: 150 }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 50, clientY: 375 }),
      );
    });
    expect(document.querySelector('[data-drag-ghost]')).toBeTruthy();

    // Wheel scroll forwarding
    await act(async () => {
      window.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }),
      );
    });
    expect(scrollBox?.scrollTop).toBeGreaterThanOrEqual(120);

    // Edge auto-scroll + 400ms collapsed folder hover expand
    const beforeRaf = scrollBox?.scrollTop ?? 0;
    await act(async () => {
      vi.advanceTimersByTime(450);
    });
    expect((scrollBox?.scrollTop ?? 0) >= beforeRaf).toBe(true);
    expect(host.querySelector('[data-finder-id="3"]')).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 50, clientY: 375 }),
      );
    });
  });

  it('Sidebar attention filter chip, nudgeGroup sorted order, and IconWindow 整理已选 (N)', async () => {
    const g1: Group = { id: 'g-1', name: '分组A', color: 'blue', order: 0 };
    const g2: Group = { id: 'g-2', name: '分组B', color: 'green', order: 1 };
    const pOk = makeProfile({
      id: '00000000-0000-4000-8000-000000000001',
      alias: '正常号',
      groupId: g1.id,
      order: 0,
    });
    const pRestricted = makeProfile({
      id: '00000000-0000-4000-8000-000000000002',
      alias: '受限号',
      groupId: g2.id,
      order: 0,
      account: { state: 'restricted', id: '10002', name: 'Bad', avatar: null },
    });
    const ws: Workspace = {
      groups: [g2, g1], // intentionally unsorted input to verify nudgeGroup sorts first
      profiles: [pOk, pRestricted],
      combinations: [],
      records: [],
    };
    vi.mocked(api.windowLayout).mockResolvedValue({
      settings: defaultWindowLayout,
      displays: [],
      managed: [],
      error: '',
      movedCount: 1,
      failedProfiles: [],
    });

    await act(async () =>
      root.render(
        <Sidebar
          workspace={ws}
          selected={new Set([pOk.id])}
          onSelect={() => {}}
          onInspect={() => {}}
          mutate={async (w) => {
            await w();
          }}
          inspections={[]}
          inspectionAvailable={true}
          inspectionError=""
          busy={false}
          onCheck={() => {}}
        />,
      ),
    );

    // Attention filter chip shows count 1 and filters rows to pRestricted
    const chip = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('异常 / 需验证 / 未识别'),
    );
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toContain('1');
    await click(chip);
    expect(chip?.getAttribute('aria-pressed')).toBe('true');
    expect(host.textContent).toContain('受限号');
    expect(host.textContent).not.toContain('正常号');
    await click(chip);

    // IconWindow button uses 整理已选 (1) when checked
    const arrangeBtn = host.querySelector('button[aria-label="整理已选 (1)"]');
    expect(arrangeBtn).toBeTruthy();
    await click(arrangeBtn);
    expect(api.windowLayout).toHaveBeenCalledWith({ action: 'apply', profileIds: [pOk.id] });

    // nudgeGroup moves g1 down past g2 based on sorted order
    await click(host.querySelector('button[aria-label="分组操作 · 分组A"]'));
    await click(
      [...document.querySelectorAll('[role="menuitem"]')].find((m) =>
        m.textContent?.includes('↓ 下移分组'),
      ),
    );
    expect(api.reorderGroups).toHaveBeenCalledWith(['g-2', 'g-1']);
  });

  it('WindowLayoutPage enforces strict selected scope empty callout, TargetScopeBar, applySort=list order, <520x460 warning, and BlueStacks gap=48 localStorage persistence', async () => {
    const g1: Group = { id: 'g-1', name: '前组', color: 'blue', order: 0 };
    const g2: Group = { id: 'g-2', name: '后组', color: 'green', order: 1 };
    const pA = makeProfile({
      id: '00000000-0000-4000-8000-00000000000a',
      alias: 'Zeta',
      groupId: g2.id,
      order: 0,
    });
    const pB = makeProfile({
      id: '00000000-0000-4000-8000-00000000000b',
      alias: 'Alpha',
      groupId: g1.id,
      order: 0,
    });
    // applySort='list' orders by group.order first (g1 -> pB, then g2 -> pA)
    expect(
      getTargetProfileIds([pA, pB], new Set([pA.id, pB.id]), 'selected', 'list', [g2, g1]),
    ).toEqual([pB.id, pA.id]);

    const display = {
      id: 'disp-1',
      primary: true,
      scaleFactor: 1,
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    };
    vi.mocked(api.windowLayout).mockResolvedValue({
      settings: {
        ...defaultWindowLayout,
        mode: 'tile',
        applyScope: 'selected',
        tileDisplays: [{ displayId: 'disp-1', enabled: true, rows: 4, cols: 4, startSlot: 1 }],
      },
      displays: [display],
      managed: [],
      error: '',
      failedProfiles: [pA.id],
    });
    const bsState: BluestacksState = {
      configured: true,
      exePath: '',
      confPath: '',
      adbPath: '',
      instances: [
        {
          id: 'bs-1',
          instanceKey: 'Pie64',
          displayName: 'BS-1',
          alias: 'BS-1',
          folderId: null,
          sortOrder: 0,
          adbPort: 5555,
          online: true,
          fbWidth: 900,
          fbHeight: 1600,
          fbLiteInstalled: true,
          accountState: 'logged_in',
          accountId: '100',
          accountName: 'B1',
          identityType: 'personal',
          lastStatus: '',
          running: false,
          bumperRunning: false,
          pageBumperRunning: false,
          activeRunning: false,
          posterRunning: false,
          inviterRunning: false,
          totalBumpedCount: 0,
          pageTotalBumpedCount: 0,
          createdAt: 1,
          updatedAt: 1,
        } as unknown as BluestacksState['instances'][number],
      ],
      folders: [],
      bumperSettings: BumperSettings.parse({}),
      pageBumperSettings: BumperSettings.parse({}),
      riskLimits: { enabled: false, maxDailyActions: 50, actionCounts: {} },
      running: false,
      pageBumperRunning: false,
      activeRunning: false,
      posterRunning: false,
      inviterRunning: false,
      batchLoginRunning: false,
      healthCheckRunning: false,
      statusText: '',
      pageBumperStatusText: '',
      activeStatusText: '',
      posterStatusText: '',
      inviterStatusText: '',
      batchLoginStatusText: '',
      healthCheckStatusText: '',
      total: 0,
      pageTotal: 0,
      profileCounts: {},
      pageBumperProfileCounts: {},
      activeProfileCounts: {},
      posterProfileCounts: {},
      inviterProfileCounts: {},
    };
    vi.mocked(api.bluestacksAction).mockResolvedValue(bsState);

    const layoutMsgs: string[] = [];
    const onBsState = vi.fn();
    await act(async () =>
      root.render(
        <WindowLayoutPage
          profiles={[pA, pB]}
          profileGroups={[g1, g2]}
          selectedProfileIds={new Set()}
          onSelectProfiles={() => {}}
          bluestacksState={bsState}
          selectedBluestacksIds={new Set(['bs-1'])}
          onSelectBluestacks={() => {}}
          onBluestacksState={onBsState}
          onMessage={(m) => layoutMsgs.push(m)}
        />,
      ),
    );

    // TargetScopeBar present, strict empty selection callout, < 520x460 warning, failedProfiles alert
    expect(host.textContent).toContain('当前作用范围为「仅已勾选浏览器」，但尚未勾选任何浏览器。');
    expect(host.textContent).toContain('单窗尺寸偏小');
    expect(host.textContent).toContain('< 520×460');
    expect(host.textContent).toContain('部分窗口排版失败');
    const applyBtn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('立即排版 (0)'),
    ) as HTMLButtonElement | undefined;
    expect(applyBtn?.disabled).toBe(true);

    // One-click switch to all_online enables apply button
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === '切为全部在线'),
    );
    expect(
      (
        [...host.querySelectorAll('button')].find((b) =>
          b.textContent?.includes('立即排版 (2)'),
        ) as HTMLButtonElement | undefined
      )?.disabled,
    ).toBe(false);

    // Switch to BlueStacks tab, set gap=48, check localStorage persistence & payload
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('蓝蝶窗口')),
    );
    const gapInput = [...host.querySelectorAll('label')]
      .find((l) => l.textContent?.includes('窗口间距'))
      ?.querySelector<HTMLInputElement>('input');
    expect(gapInput).toBeTruthy();
    expect(gapInput?.max).toBe('48');
    await act(async () => {
      if (gapInput) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(gapInput, '48');
        gapInput.dispatchEvent(new Event('input', { bubbles: true }));
        gapInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    const stored = JSON.parse(window.localStorage.getItem('wb.windowLayout.bluestacks.v1') ?? '{}');
    expect(stored.gap).toBe(48);
    const bsArrangeBtn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('立即平铺蓝蝶'),
    ) as HTMLButtonElement | undefined;
    expect(bsArrangeBtn).toBeTruthy();
    expect(bsArrangeBtn?.textContent).toContain('(1)');
    expect(bsArrangeBtn?.disabled).toBe(false);
    await act(async () => {
      bsArrangeBtn?.click();
    });
    expect(layoutMsgs).toEqual(['已整齐平铺 1 个蓝蝶模拟器窗口']);
    expect(onBsState).toHaveBeenCalledWith(bsState);
    expect(api.bluestacksAction).toHaveBeenCalledWith(
      'instances/arrange',
      expect.objectContaining({
        instanceIds: ['bs-1'],
        gap: 48,
        monitorBounds: { left: 0, top: 0, width: 1920, height: 1040 },
      }),
    );
  });

  it('InviterWorkspacePage renders 完后关窗, 本轮各组执行明细 drawer & 重试失败组, and folded route rendering works', async () => {
    const p1 = makeProfile();
    const state: GroupInviterState = {
      groups: [
        {
          groupId: '88001',
          groupName: 'Ok Group',
          avatarUrl: null,
          folderId: null,
          sortOrder: 0,
          totalInvitedCount: 2,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          groupId: '88002',
          groupName: 'Fail Group',
          avatarUrl: null,
          folderId: null,
          sortOrder: 1,
          totalInvitedCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      invitesPerGroup: 30,
      maxConcurrentProfiles: 4,
      playSoundOnComplete: true,
      closeBrowserOnFinish: false,
      running: false,
      runId: 'run-1',
      startedAt: 100,
      finishedAt: 200,
      statusText: '运行完成',
      profileCounts: {},
      lastRunSummary: {
        runId: 'run-1',
        invitedTotal: 2,
        pendingTotal: 0,
        failedProfiles: [],
        finishedAt: 200,
        groupResults: [
          {
            profileId: p1.id,
            profileName: 'P1',
            groupId: '88001',
            groupName: 'Ok Group',
            status: 'invited',
            invitedCount: 2,
            skippedCount: 0,
            reason: '已确认 2 人',
          },
          {
            profileId: p1.id,
            profileName: 'P1',
            groupId: '88002',
            groupName: 'Fail Group',
            status: 'failed',
            invitedCount: 0,
            skippedCount: 0,
            reason: '跳过：邀请发送按钮不可用，未发送',
          },
        ],
      },
    };
    vi.mocked(api.saveGroupInviterSettings).mockResolvedValue({
      ...state,
      closeBrowserOnFinish: true,
    });
    const onStartBrowser = vi.fn().mockResolvedValue(undefined);

    await act(async () =>
      root.render(
        <InviterWorkspacePage
          carrier="browser"
          state={state}
          loaded={true}
          selectedTargetIds={new Set([p1.id])}
          externalBusy={false}
          onAddGroups={async () => {}}
          onDeleteGroups={async () => {}}
          onRefresh={async () => {}}
          onSaveInvitesPerGroup={async () => {}}
          onStartBrowser={onStartBrowser}
          onStopBrowser={async () => {}}
        />,
      ),
    );

    const closeSwitch = host.querySelector<HTMLButtonElement>('button[aria-label="完后关窗"]');
    expect(closeSwitch).toBeTruthy();
    await click(closeSwitch);
    expect(api.saveGroupInviterSettings).toHaveBeenCalledWith({ closeBrowserOnFinish: true });

    await click(
      [...host.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('本轮执行明细 (2) · 1 失败'),
      ),
    );
    expect(document.body.textContent).toContain('本轮各组执行明细');
    expect(document.body.textContent).toContain('跳过：邀请发送按钮不可用，未发送');
    await click(
      [...document.body.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('重试失败组 (1)'),
      ),
    );
    expect(onStartBrowser).toHaveBeenCalledWith(['88002'], 30);

    // Folded route rendering via WorkbenchViewRouter
    const shell = {
      workspace: { groups: [], profiles: [p1], combinations: [], records: [] },
      mergedProfiles: [p1],
      inspections: { rows: [], available: true, error: '', refresh: async () => {} },
      tasks: { runtime: null, start: async () => ({ plans: [] }) } as never,
      mods: {
        groupInviter: state,
        groupInviterLoaded: true,
        setGroupInviter: () => {},
        bluestacks: null,
        setBluestacks: () => {},
        groupBumper: null,
        setGroupBumper: () => {},
        groupPoster: null,
        setGroupPoster: () => {},
        autoScheduler: null,
        setAutoScheduler: () => {},
        googleSheets: null,
        setGoogleSheets: () => {},
        refreshGroupInviter: async () => {},
        refreshBumper: () => {},
        refreshPoster: () => {},
      } as never,
      busy: false,
      selected: new Set([p1.id]),
      setSelected: () => {},
      selectedBluestacks: new Set<string>(),
      setSelectedBluestacks: () => {},
      projection: {} as never,
      actions: {} as never,
      mutate: async (w: () => Promise<unknown>) => {
        await w();
      },
      forceRefreshWorkspace: async () => {},
      setMessage: () => {},
    } as unknown as ShellCtx;
    await act(async () =>
      root.render(
        <WorkbenchViewRouter
          shell={shell}
          router={{
            view: { kind: 'group-inviter' },
            setView: () => {},
            carrier: 'browser',
            cardColors: {} as never,
            resourceSummaries: null,
            setResourceSummaries: () => {},
            onOpenResources: () => {},
            refreshResources: async () => {},
            openQuickSchedule: () => {},
            onOpenLiveRuns: () => {},
            openLedgerRecords: () => {},
            ledger: { tab: 'posts', status: 'all', nonce: 0 },
            onOpenMenuSection: () => {},
            navigate: async () => {},
          }}
        />,
      ),
    );
    await vi.waitFor(() => {
      expect(host.querySelector('.group-inviter-page')).toBeTruthy();
    });
  });

  it('SoftwareUpdatePanel renders error alert, AppMenu confirms restart, and retention labels are clarified', async () => {
    const status: UpdateStatus = {
      currentSoftwareVersion: '0.1.272',
      currentExtensionVersion: '0.3.92',
      extensionDirectory: 'C:\\ext',
      githubRepo: 'org/wb',
      autoCheck: true,
      checking: false,
      applying: false,
      lastCheckedAt: null,
      availableUpdate: null,
      error: '检查更新失败：API 403',
    };
    await act(async () =>
      root.render(
        <SoftwareUpdatePanel
          status={status}
          onStatus={() => {}}
          onApply={async () => {}}
          error=""
        />,
      ),
    );
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('检查更新失败：API 403');
    expect(host.textContent).not.toContain('顶栏「复制插件路径」');

    const onRestart = vi.fn();
    await act(async () =>
      root.render(
        <AppMenu
          profiles={[]}
          busy={false}
          restartDisabled={false}
          onRestart={onRestart}
          onClose={() => {}}
          updateStatus={status}
        />,
      ),
    );
    await click(
      [...document.body.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('重启软件'),
      ),
    );
    expect(onRestart).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('确认重启软件');
    await click(
      [...document.body.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === '确认重启',
      ),
    );
    expect(onRestart).toHaveBeenCalledTimes(1);

    await act(async () =>
      root.render(
        <>
          <WorkspaceMaintenancePanel />
          <DataCleanupPanel logRetentionDays={14} />
        </>,
      ),
    );
    expect(host.textContent).toContain('运行与诊断日志保留天数');
    expect(host.textContent).toContain('自动按天数清理活动任务记录');
    expect(host.textContent).toContain('活动记录保留天数');
    expect(host.textContent).toContain('按「运行与诊断日志保留天数」14 天');
    expect(host.textContent).not.toContain('使用上方日志保留天数');
  });
});
