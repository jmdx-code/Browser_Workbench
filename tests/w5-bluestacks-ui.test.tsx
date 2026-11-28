// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { api } from '../src/renderer/api.js';
import { GroupBumperPage } from '../src/renderer/group-bumper-page.js';
import { GroupPosterPage } from '../src/renderer/group-poster-page.js';
import { InviterWorkspacePage } from '../src/renderer/inviter-workspace-page.js';
import { BluestacksBatchLoginModal } from '../src/renderer/modules/bluestacks-batch-login-modal.js';
import { BluestacksHealthCheckModal } from '../src/renderer/modules/bluestacks-health-check-modal.js';
import { BluestacksSidebar } from '../src/renderer/modules/bluestacks-sidebar.js';
import type { BluestacksInstance, BluestacksState } from '../src/shared/bluestacks.js';
import { BumperSettings, type BumperState } from '../src/shared/group-bumper.js';
import type { GroupInviterState } from '../src/shared/group-inviter.js';
import { PosterSettings, type PosterState } from '../src/shared/group-poster.js';

vi.mock('../src/renderer/api.js', () => ({
  api: {
    targetFolders: vi.fn(),
    bluestacksAction: vi.fn(),
    bluestacksState: vi.fn(),
    posterAction: vi.fn(),
    posterState: vi.fn(),
    posterLogs: vi.fn(),
    bumperAction: vi.fn(),
    bumperState: vi.fn(),
    saveGroupInviterSettings: vi.fn(),
    groupInviterState: vi.fn(),
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
  vi.mocked(api.posterLogs).mockResolvedValue([]);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function makeBsInstance(
  idx: number,
  overrides: Partial<BluestacksInstance> = {},
): BluestacksInstance {
  return {
    id: `bs-${idx}`,
    instanceKey: `Pie64_${idx}`,
    displayName: `蓝蝶-${idx}`,
    alias: null,
    folderId: null,
    sortOrder: idx,
    adbPort: 5555 + idx * 2,
    serial: `127.0.0.1:${5555 + idx * 2}`,
    fbWidth: 720,
    fbHeight: 1280,
    online: false,
    fbLiteInstalled: true,
    accountState: 'logged-in',
    accountId: `uid-${idx}`,
    accountName: `User ${idx}`,
    avatarUrl: null,
    lastStatus: null,
    updatedAt: 1000 + idx,
    identityType: 'personal',
    fbLiteVersion: '430.0.0',
    androidSdk: 30,
    ...overrides,
  };
}

function makeBsState(overrides: Partial<BluestacksState> = {}): BluestacksState {
  return {
    instances: [],
    folders: [],
    config: {
      installDir: 'C:\\Program Files\\BlueStacks_nxt',
      confPath: 'D:\\BlueStacks\\bluestacks.conf',
      detectedInstallDir: null,
      detectedConfPath: null,
      adbReady: true,
      playerReady: true,
      apkPath: 'D:\\fb-lite.apk',
      detectedApkPath: null,
    },
    bumperSettings: BumperSettings.parse({}),
    pageBumperSettings: BumperSettings.parse({}),
    running: false,
    pageBumperRunning: false,
    activeRunning: false,
    posterRunning: false,
    inviterRunning: false,
    launchingIds: [],
    closingIds: [],
    inspectingIds: [],
    statusText: '',
    pageBumperStatusText: '',
    activeStatusText: '',
    posterStatusText: '',
    inviterStatusText: '',
    profileCounts: {},
    pageBumperProfileCounts: {},
    activeProfileCounts: {},
    posterProfileCounts: {},
    inviterProfileCounts: {},
    total: 0,
    pageTotal: 0,
    ...overrides,
  };
}

describe('W5 BlueStacks Renderer UI Suite', () => {
  it('BluestacksSidebar renders status filter chips for 20+ instances, FB Lite version badge, status/error summary, and batch cancel strip', async () => {
    const instances: BluestacksInstance[] = [
      makeBsInstance(1, {
        online: true,
        accountState: 'logged-in',
        accountName: 'Alice',
        fbLiteVersion: '431.2.0',
      }),
      makeBsInstance(2, {
        online: false,
        accountState: 'missing-app',
        fbLiteInstalled: false,
        fbLiteVersion: null,
        accountName: '',
        lastStatus: '未检测到安装包',
      }),
      makeBsInstance(3, {
        online: false,
        accountState: 'unknown',
        fbLiteVersion: '429.0.1',
        accountName: '',
      }),
      makeBsInstance(4, {
        online: true,
        accountState: 'verification',
        accountName: 'VerifyUser',
        fbLiteVersion: '430.5.0',
        lastStatus: 'Checkpoint 验证中',
      }),
      ...Array.from({ length: 18 }, (_, i) =>
        makeBsInstance(i + 5, {
          online: i % 2 === 0,
          accountState: 'logged-in',
          accountName: `Acct${i + 5}`,
          fbLiteVersion: '430.0.0',
        }),
      ),
    ];

    const bsState = makeBsState({
      instances,
      batchLogin: {
        runId: 'bl-run-1',
        running: true,
        startedAt: 100,
        finishedAt: null,
        total: 5,
        completed: 2,
        statusText: '正在批量登录 2/5',
        succeeded: 2,
        skipped: 0,
        verification: 0,
        restricted: 0,
        failed: 0,
        stopped: 0,
        items: [],
      },
      healthCheck: {
        runId: 'hc-run-1',
        running: true,
        startedAt: 100,
        finishedAt: null,
        total: 4,
        completed: 1,
        statusText: '正在体检 1/4',
        healthy: 1,
        loggedOut: 0,
        verification: 0,
        restricted: 0,
        missingApp: 0,
        landscape: 0,
        launchFailed: 0,
        skipped: 0,
        stopped: 0,
        autoRepaired: 0,
        items: [],
      },
    });
    vi.mocked(api.bluestacksAction).mockResolvedValue(bsState);

    await act(async () =>
      root.render(
        <BluestacksSidebar
          state={bsState}
          onChange={() => {}}
          selected={new Set()}
          onSelect={() => {}}
          onError={() => {}}
        />,
      ),
    );

    const chipGroup = host.querySelector('[aria-label="蓝蝶状态筛选"]');
    expect(chipGroup).toBeTruthy();
    const chips = [...(chipGroup?.querySelectorAll('button') ?? [])];
    expect(chips.map((c) => c.textContent)).toEqual([
      '全部22',
      '已登录19',
      '在线11',
      '缺APK1',
      '未检测1',
    ]);

    // FB Lite version badge and status/error summary line & tooltip
    expect(host.textContent).toContain('FB v431.2.0');
    expect(host.textContent).toContain('缺 FB Lite APK · 未检测到安装包');
    expect(host.textContent).toContain('需安全验证 · Checkpoint 验证中');
    const row1Btn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('蓝蝶-1'),
    );
    expect(row1Btn?.getAttribute('title')).toContain('FB Lite：v431.2.0');
    expect(row1Btn?.getAttribute('title')).toContain('状态摘要：在线就绪');

    // Click 缺APK chip -> filters to 1 instance
    await click(chips.find((c) => c.textContent?.startsWith('缺APK')));
    expect(host.querySelectorAll('.profile-row').length).toBe(1);
    expect(host.textContent).toContain('蓝蝶-2');

    // Click 未检测 chip -> filters to 1 instance
    await click(chips.find((c) => c.textContent?.startsWith('未检测')));
    expect(host.querySelectorAll('.profile-row').length).toBe(1);
    expect(host.textContent).toContain('蓝蝶-3');

    // Click 在线 chip -> filters to 11 online instances
    await click(chips.find((c) => c.textContent?.startsWith('在线')));
    expect(host.querySelectorAll('.profile-row').length).toBe(11);

    // Click 已登录 chip -> filters to 19 logged-in instances
    await click(chips.find((c) => c.textContent?.startsWith('已登录')));
    expect(host.querySelectorAll('.profile-row').length).toBe(19);

    // Click 全部 chip -> restores all 22 instances
    await click(chips.find((c) => c.textContent?.startsWith('全部')));
    expect(host.querySelectorAll('.profile-row').length).toBe(22);

    // Sidebar inline batch cancel controls call batch-login/stop and health-check/stop
    const cancelBtns = [...host.querySelectorAll('button')].filter(
      (b) => b.textContent?.trim() === '中止执行',
    );
    expect(cancelBtns.length).toBe(2);
    await click(cancelBtns[0]);
    expect(api.bluestacksAction).toHaveBeenCalledWith('batch-login/stop', {});
    await click(cancelBtns[1]);
    expect(api.bluestacksAction).toHaveBeenCalledWith('health-check/stop', {});
  });

  it('BatchLoginModal and HealthCheckModal wire 中止执行 inside BluestacksBatchResultList to stop endpoints', async () => {
    const runningState = makeBsState({
      instances: [makeBsInstance(1)],
      batchLogin: {
        runId: 'bl-1',
        running: true,
        startedAt: 100,
        finishedAt: null,
        total: 3,
        completed: 1,
        statusText: '正在登录 1/3',
        succeeded: 1,
        skipped: 0,
        verification: 0,
        restricted: 0,
        failed: 0,
        stopped: 0,
        items: [
          {
            instanceId: 'bs-1',
            instanceName: '蓝蝶-1',
            maskedAccount: 'al***@example.com',
            hasTotp: true,
            status: 'running',
            stepText: '正在输入验证码…',
          },
        ],
      },
      healthCheck: {
        runId: 'hc-1',
        running: true,
        startedAt: 100,
        finishedAt: null,
        total: 2,
        completed: 1,
        statusText: '正在体检 1/2',
        healthy: 1,
        loggedOut: 0,
        verification: 0,
        restricted: 0,
        missingApp: 0,
        landscape: 0,
        launchFailed: 0,
        skipped: 0,
        stopped: 0,
        autoRepaired: 0,
        items: [
          {
            instanceId: 'bs-1',
            instanceName: '蓝蝶-1',
            resolution: '720×1280',
            status: 'running',
            category: null,
            stepText: '检查 FB Lite 版本…',
            fbLiteVersion: '430.0.0',
          },
        ],
      },
    });
    const onChange = vi.fn();
    vi.mocked(api.bluestacksAction).mockResolvedValue({
      ...runningState,
      batchLogin: runningState.batchLogin ? { ...runningState.batchLogin, running: false } : null,
      healthCheck: runningState.healthCheck
        ? { ...runningState.healthCheck, running: false }
        : null,
    });

    await act(async () =>
      root.render(
        <BluestacksBatchLoginModal
          state={runningState}
          selected={new Set(['bs-1'])}
          onSelect={() => {}}
          onChange={onChange}
          onClose={() => {}}
        />,
      ),
    );
    const loginCancelBtn = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '中止执行',
    );
    expect(loginCancelBtn).toBeTruthy();
    await click(loginCancelBtn);
    expect(api.bluestacksAction).toHaveBeenCalledWith('batch-login/stop', {});
    expect(onChange).toHaveBeenCalledTimes(1);

    await act(async () =>
      root.render(
        <BluestacksHealthCheckModal
          state={runningState}
          selected={new Set(['bs-1'])}
          onSelect={() => {}}
          onChange={onChange}
          onOpenBatchLogin={() => {}}
          onClose={() => {}}
        />,
      ),
    );
    expect(document.body.textContent).toContain('50%');
    const hcCancelBtn = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '中止执行',
    );
    expect(hcCancelBtn).toBeTruthy();
    await click(hcCancelBtn);
    expect(api.bluestacksAction).toHaveBeenCalledWith('health-check/stop', {});
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('BlueStacks GroupPoster, GroupBumper, PageBumper, and Inviter expose standalone 完后关窗 and forward closeWindowOnFinish (Chrome untouched)', async () => {
    const bsState = makeBsState({ instances: [makeBsInstance(1, { online: true })] });
    vi.mocked(api.bluestacksAction).mockResolvedValue(bsState);

    // 1. GroupPosterPage (carrier="bluestacks")
    const posterState: PosterState = {
      groups: [
        {
          id: '88001',
          name: 'Poster Group',
          avatarUrl: null,
          folderId: null,
          sortOrder: 0,
          totalBumpedCount: 0,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      materials: [
        {
          id: 'mat-1',
          caption: 'Hello BS Poster',
          mediaSource: '',
          background: 'plain',
          aiLabel: 'default',
          localFilePath: null,
          mediaKind: 'none',
          cacheStatus: 'ready',
          cacheError: null,
          selected: true,
          usedCount: 0,
          sortOrder: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      settings: PosterSettings.parse({}),
      total: 0,
      running: false,
      statusText: '',
      profileCounts: {},
    };
    await act(async () =>
      root.render(
        <GroupPosterPage
          carrier="bluestacks"
          state={posterState}
          selected={new Set()}
          selectedBluestacks={new Set(['bs-1'])}
          bluestacksState={bsState}
          onBluestacksState={() => {}}
          onState={() => {}}
          onMessage={() => {}}
        />,
      ),
    );
    const posterSwitch = host.querySelector<HTMLButtonElement>(
      'button[aria-label="蓝蝶发帖完毕关窗"]',
    );
    expect(posterSwitch).toBeTruthy();
    expect(posterSwitch?.getAttribute('aria-checked')).toBe('false');
    await click(posterSwitch);
    expect(posterSwitch?.getAttribute('aria-checked')).toBe('true');
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('开始蓝蝶发帖')),
    );
    expect(api.bluestacksAction).toHaveBeenCalledWith(
      'poster/start',
      expect.objectContaining({
        instanceIds: ['bs-1'],
        materialIds: ['mat-1'],
        closeWindowOnFinish: true,
      }),
    );

    // 2. GroupBumperPage (bluestacks-group-bumper & bluestacks-page-bumper)
    const bumperState: BumperState = {
      groups: [
        {
          id: '88001',
          name: 'Bump Group',
          avatarUrl: null,
          folderId: null,
          sortOrder: 0,
          totalBumpedCount: 0,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      pages: [
        {
          id: '61501',
          name: 'Bump Page',
          avatarUrl: null,
          folderId: null,
          sortOrder: 0,
          totalBumpedCount: 0,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      settings: BumperSettings.parse({}),
      pageSettings: BumperSettings.parse({}),
      comments: [],
      pageComments: [],
      total: 0,
      pageTotal: 0,
      running: false,
      statusText: '',
      profileCounts: {},
    };
    vi.mocked(api.bumperState).mockResolvedValue(bumperState);

    await act(async () =>
      root.render(
        <GroupBumperPage
          mode="bluestacks-group-bumper"
          state={bumperState}
          selected={new Set(['bs-1'])}
          bluestacksState={bsState}
          onBluestacksState={() => {}}
          onState={() => {}}
          onMessage={() => {}}
        />,
      ),
    );
    const grpBumpSwitch = host.querySelector<HTMLButtonElement>(
      'button[aria-label="蓝蝶顶贴完毕关窗"]',
    );
    expect(grpBumpSwitch).toBeTruthy();
    await click(grpBumpSwitch);
    await click(host.querySelector('[data-finder-id="88001"]'));
    await click(host.querySelector('[data-finder-id="61501"]'));
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('运行 (')),
    );
    expect(api.bluestacksAction).toHaveBeenCalledWith(
      'bumper/start',
      expect.objectContaining({
        profileIds: ['bs-1'],
        groupIds: ['88001'],
        pageIds: ['61501'],
        closeWindowOnFinish: true,
      }),
    );

    await act(async () =>
      root.render(
        <GroupBumperPage
          mode="bluestacks-page-bumper"
          state={bumperState}
          selected={new Set(['bs-1'])}
          bluestacksState={bsState}
          onBluestacksState={() => {}}
          onState={() => {}}
          onMessage={() => {}}
        />,
      ),
    );
    const pageBumpSwitch = host.querySelector<HTMLButtonElement>(
      'button[aria-label="蓝蝶顶贴完毕关窗"]',
    );
    expect(pageBumpSwitch).toBeTruthy();
    await click(pageBumpSwitch);
    await click(host.querySelector('[data-finder-id="61501"]'));
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('运行 (')),
    );
    expect(api.bluestacksAction).toHaveBeenCalledWith(
      'bumper/start-page',
      expect.objectContaining({
        profileIds: ['bs-1'],
        pageIds: ['61501'],
        closeWindowOnFinish: true,
      }),
    );

    // Chrome mode GroupBumperPage must NOT show 蓝蝶顶贴完毕关窗
    await act(async () =>
      root.render(
        <GroupBumperPage
          mode="group-bumper"
          state={bumperState}
          selected={new Set()}
          onState={() => {}}
          onMessage={() => {}}
        />,
      ),
    );
    expect(host.querySelector('button[aria-label="蓝蝶顶贴完毕关窗"]')).toBeNull();
    expect(host.querySelector('button[aria-label="顶贴完毕关闭浏览器"]')).toBeTruthy();

    // 3. InviterWorkspacePage (carrier="bluestacks")
    const inviterState: GroupInviterState = {
      groups: [
        {
          groupId: '99001',
          groupName: 'Inviter Group',
          avatarUrl: null,
          folderId: null,
          sortOrder: 0,
          totalInvitedCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      invitesPerGroup: 5,
      maxConcurrentProfiles: 3,
      playSoundOnComplete: true,
      closeBrowserOnFinish: false,
      running: false,
      runId: null,
      startedAt: null,
      finishedAt: null,
      statusText: '',
      profileCounts: {},
    };
    await act(async () =>
      root.render(
        <InviterWorkspacePage
          carrier="bluestacks"
          state={inviterState}
          loaded={true}
          selectedTargetIds={new Set(['bs-1'])}
          bluestacksState={bsState}
          onBluestacksState={() => {}}
          onRefresh={async () => {}}
          onMessage={() => {}}
        />,
      ),
    );
    const invSwitch = host.querySelector<HTMLButtonElement>(
      'button[aria-label="蓝蝶邀人完毕关窗"]',
    );
    expect(invSwitch).toBeTruthy();
    await click(invSwitch);
    await click(host.querySelector('[data-finder-id="99001"]'));
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('开始蓝蝶邀人')),
    );
    expect(api.bluestacksAction).toHaveBeenCalledWith(
      'inviter/start',
      expect.objectContaining({
        instanceIds: ['bs-1'],
        groupIds: ['99001'],
        invitesPerGroup: 5,
        closeWindowOnFinish: true,
      }),
    );
  });
});
