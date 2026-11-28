// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { api } from '../src/renderer/api.js';
import {
  clearGoogleSheetsGridCache,
  GoogleSheetsPage,
} from '../src/renderer/modules/sheets/google-sheets-page.js';
import type { BluestacksInstance, BluestacksState } from '../src/shared/bluestacks.js';
import type { Group, Profile } from '../src/shared/contracts.js';
import {
  UNGROUPED_BUCKET_ID,
  type GoogleSheetLink,
  type GoogleSheetsOverview,
  type SheetGridSnapshot,
} from '../src/shared/google-sheets.js';
import { BumperSettings } from '../src/shared/group-bumper.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/renderer/api.js', () => ({
  api: {
    googleSheetsOverview: vi.fn(),
    googleSheetsUpdateLink: vi.fn(),
    googleSheetsReadGrid: vi.fn(),
    googleSheetsResetStuckRows: vi.fn(),
    googleSheetsPollSchedule: vi.fn(),
    googleSheetsPollRecords: vi.fn(),
    googleSheetsRefreshMetrics: vi.fn(),
    googleSheetsStopLink: vi.fn(),
  },
}));

function makeLink(overrides: Partial<GoogleSheetLink>): GoogleSheetLink {
  return {
    id: 'link-1',
    kind: 'post_schedule',
    title: '排贴表1',
    spreadsheetId: '1CpXEEOO9X4S8TJhIlImzVQFnVCXLgv7Nk1eU6D0SI3U',
    spreadsheetTitle: '运营云表',
    sheetId: 101,
    sheetName: '排贴表1',
    spreadsheetUrl:
      'https://docs.google.com/spreadsheets/d/1CpXEEOO9X4S8TJhIlImzVQFnVCXLgv7Nk1eU6D0SI3U/edit#gid=101',
    sortOrder: 0,
    enabled: true,
    runtime: {
      lastSyncedAt: null,
      lastSyncSummary: '',
      lastError: null,
      pollingMode: 'idle',
      consecutiveIdlePolls: 0,
      nextPollAt: null,
      activeJobText: '',
      activeRunningCount: 0,
      totalRowCount: 0,
      lastMetricsRunAt: null,
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeOverview(
  links: GoogleSheetLink[],
  authorized = true,
  extra?: Partial<GoogleSheetsOverview> & { globalMaxConcurrency?: number },
): GoogleSheetsOverview {
  return {
    auth: {
      hasCredentials: true,
      clientIdHint: 'cid-123',
      authorized,
      authorizedEmail: authorized ? 'ops@example.com' : null,
      scopes: [],
      pendingAuthUrl: null,
      pendingAuthStartedAt: null,
      lastError: authorized ? null : 'Token revoked',
    },
    imageHost: {
      preferredHost: 'auto',
      hasGyazoToken: true,
      gyazoTokenPreview: 'tok1••••1111',
      gyazoTokenCount: 1,
      gyazoTokenPreviews: ['tok1••••1111'],
      driveFolderId: null,
      defaultMachineName: '电脑1号',
      cachedImageCount: 0,
    },
    links,
    logs: [],
    runningScheduleCount: 0,
    runningRecordsCount: 0,
    activeProfiles: [],
    ...extra,
  };
}

function makeBsInstance(index: number): BluestacksInstance {
  return {
    id: `bs-${index}`,
    instanceKey: `Pie64_${index}`,
    displayName: `BlueStacks App Player ${index}`,
    alias: `蓝蝶实例-${index}`,
    folderId: null,
    sortOrder: index,
    adbPort: 5555 + index,
    serial: `127.0.0.1:${5555 + index}`,
    fbWidth: 720,
    fbHeight: 1280,
    online: true,
    fbLiteInstalled: true,
    accountState: 'logged-in',
    accountId: `acc-${index}`,
    accountName: `专页号-${index}`,
    avatarUrl: null,
    lastStatus: null,
    updatedAt: 1,
  };
}

function makeBsState(instanceCount: number): BluestacksState {
  const defaultBumper = BumperSettings.parse({});
  return {
    instances: Array.from({ length: instanceCount }, (_, i) => makeBsInstance(i + 1)),
    folders: [],
    config: {
      installDir: null,
      confPath: null,
      detectedInstallDir: null,
      detectedConfPath: null,
      adbReady: true,
      playerReady: true,
    },
    bumperSettings: defaultBumper,
    pageBumperSettings: defaultBumper,
    running: false,
    pageBumperRunning: false,
    launchingIds: [],
    closingIds: [],
    inspectingIds: [],
    statusText: '',
    pageBumperStatusText: '',
    profileCounts: {},
    pageBumperProfileCounts: {},
    total: 0,
    pageTotal: 0,
  };
}

function makeProfile(index: number, groupId: string | null): Profile {
  return {
    id: `prof-${index}`,
    alias: `浏览器-${index}`,
    browserName: `浏览器-${index}`,
    groupId,
    order: index,
    online: true,
    phase: 'READY',
    synced: true,
    unresolved: 0,
    extensionVersion: '0.3.92',
    capabilities: [],
    presentation: null,
    account: { state: 'logged-in', id: `1000${index}`, name: `账号-${index}`, avatar: null },
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('W6 Google Sheets UI full config parity, toolbar, reset-stuck, and re-auth recovery', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    clearGoogleSheetsGridCache();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    vi.mocked(api.googleSheetsReadGrid).mockResolvedValue({
      linkId: 'sched-1',
      spreadsheetId: '1CpXEEOO9X4S8TJhIlImzVQFnVCXLgv7Nk1eU6D0SI3U',
      spreadsheetTitle: '运营云表',
      sheetName: '排贴表1',
      headers: ['发帖专页', '发布状态'],
      rows: [],
      fetchedAt: Date.now(),
      totalRows: 0,
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.clearAllMocks();
  });

  it('exposes pollIntervalMinutes, autoWakeBumper, and individual BlueStacks instances without bsFolders or 60-item cap on post_schedule', async () => {
    const schedLink = makeLink({
      id: 'sched-1',
      kind: 'post_schedule',
      scheduleConfig: {
        enabled: false,
        pollIntervalMinutes: 2,
        targetRecordLinkId: null,
        autoWakeBumper: true,
        executionCarrier: 'auto',
        bluestacksFolderIds: [],
        bluestacksInstanceIds: [],
        closeBluestacksOnFinish: true,
      },
    });
    const overview = makeOverview([schedLink]);
    vi.mocked(api.googleSheetsOverview).mockResolvedValue(overview);
    vi.mocked(api.googleSheetsUpdateLink).mockResolvedValue(schedLink);

    await act(async () => {
      root.render(
        <GoogleSheetsPage
          kind="post_schedule"
          overview={overview}
          onOverview={() => {}}
          profileGroups={[]}
          profiles={[]}
          bluestacksState={makeBsState(65)}
          onOpenAuthMenu={() => {}}
          onAfterLibrarySync={() => {}}
          onNotify={() => {}}
        />,
      );
    });
    await flush();

    // 1. SchedulePolicyDropdown exposes pollIntervalMinutes & autoWakeBumper
    const policyBtn = host.querySelector(
      'button[aria-label="排贴轮询与唤醒设置"]',
    ) as HTMLButtonElement;
    expect(policyBtn).toBeTruthy();
    await act(async () => {
      policyBtn.click();
    });
    const pollInput = document.body.querySelector(
      'input[aria-label="排贴轮询间隔"]',
    ) as HTMLInputElement;
    expect(pollInput).toBeTruthy();
    expect(pollInput.value).toBe('2');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(pollInput, '15');
      pollInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    expect(api.googleSheetsUpdateLink).toHaveBeenCalledWith({
      id: 'sched-1',
      scheduleConfig: { pollIntervalMinutes: 15 },
    });

    const wakeSwitch = document.body.querySelector(
      'button[aria-label="发帖后自动唤醒顶贴"]',
    ) as HTMLButtonElement;
    expect(wakeSwitch).toBeTruthy();
    await act(async () => {
      wakeSwitch.click();
    });
    await flush();
    expect(api.googleSheetsUpdateLink).toHaveBeenCalledWith({
      id: 'sched-1',
      scheduleConfig: { autoWakeBumper: false },
    });

    // 2. ScheduleBluestacksDropdown renders all 65 individual BS instances even when folders is empty
    const bsBtn = host.querySelector('button[aria-label="蓝蝶执行范围"]') as HTMLButtonElement;
    expect(bsBtn).toBeTruthy();
    await act(async () => {
      bsBtn.click();
    });
    expect(document.body.textContent).toContain('蓝蝶实例-65');
    const bs65Label = Array.from(document.body.querySelectorAll('.gs-dropdown-menu label')).find(
      (el) => el.textContent?.includes('蓝蝶实例-65'),
    );
    const bs65Chk = bs65Label?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(bs65Chk).toBeTruthy();
    await act(async () => {
      bs65Chk.click();
    });
    await flush();
    expect(api.googleSheetsUpdateLink).toHaveBeenCalledWith({
      id: 'sched-1',
      scheduleConfig: {
        bluestacksFolderIds: [],
        bluestacksInstanceIds: ['bs-65'],
        selectedInstanceIds: ['bs-65'],
        closeBluestacksOnFinish: true,
      },
    });
  });

  it('exposes virtual 未分组 Chrome bucket, full per-account/BS pickers (>60), bumper switches/reactions, and inherited globalMaxConcurrency', async () => {
    const recLink = makeLink({
      id: 'rec-1',
      kind: 'post_records',
      title: '发帖记录1',
      sheetId: 102,
      sheetName: '发帖记录1',
      recordsConfig: {
        enabled: false,
        machineName: '电脑1号',
        bumperProfileGroupIds: [],
        bumperProfileIds: [],
        bumperBluestacksFolderIds: [],
        bumperBluestacksIds: [],
        bumperSettings: BumperSettings.parse({ maxConcurrentProfiles: 12 }),
        commentPool: ['Nice post!'],
        collectMetricsOnThisPc: false,
        activePollMinutes: 2,
        semiActivePollMinutes: 10,
        semiActiveAfterIdlePolls: 5,
      },
    });
    const groups: Group[] = [{ id: 'grp-1', name: '常用组', color: 'blue', order: 0 }];
    const profiles: Profile[] = Array.from({ length: 65 }, (_, i) =>
      makeProfile(i + 1, i < 5 ? 'grp-1' : null),
    );
    const overview = makeOverview([recLink], true, { globalMaxConcurrency: 12 });
    vi.mocked(api.googleSheetsOverview).mockResolvedValue(overview);
    vi.mocked(api.googleSheetsUpdateLink).mockResolvedValue(recLink);

    await act(async () => {
      root.render(
        <GoogleSheetsPage
          kind="post_records"
          overview={overview}
          onOverview={() => {}}
          profileGroups={groups}
          profiles={profiles}
          bluestacksState={makeBsState(65)}
          onOpenAuthMenu={() => {}}
          onAfterLibrarySync={() => {}}
          onNotify={() => {}}
        />,
      );
    });
    await flush();

    // 1. Account group dropdown: virtual 未分组 bucket + 65 Chrome profiles + 65 BS instances
    const acctTrigger = host.querySelector(
      'button[aria-label="下拉选择顶贴账号组"]',
    ) as HTMLButtonElement;
    await act(async () => {
      acctTrigger.click();
    });
    const ungroupedLabel = Array.from(
      document.body.querySelectorAll('.gs-dropdown-menu label'),
    ).find((l) => l.textContent?.includes('未分组'));
    expect(ungroupedLabel?.textContent).toContain('60');
    const ungroupedChk = ungroupedLabel?.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    await act(async () => {
      ungroupedChk.click();
    });
    await flush();
    expect(api.googleSheetsUpdateLink).toHaveBeenCalledWith({
      id: 'rec-1',
      recordsConfig: {
        bumperProfileGroupIds: [UNGROUPED_BUCKET_ID],
        includeUngrouped: true,
        bumperBluestacksFolderIds: [],
        bumperBluestacksIds: [],
      },
    });

    const singleChromeBtn = Array.from(
      document.body.querySelectorAll('.gs-dropdown-menu button'),
    ).find((b) => b.textContent?.includes('按单号')) as HTMLButtonElement;
    expect(singleChromeBtn).toBeTruthy();
    await act(async () => {
      singleChromeBtn.click();
    });
    expect(document.body.textContent).toContain('浏览器-65');
    const p65Label = Array.from(document.body.querySelectorAll('.gs-dropdown-menu label')).find(
      (l) => l.textContent?.includes('浏览器-65'),
    );
    await act(async () => {
      (p65Label?.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    });
    await flush();
    expect(api.googleSheetsUpdateLink).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'rec-1',
        recordsConfig: expect.objectContaining({
          bumperProfileIds: ['prof-65'],
        }),
      }),
    );

    expect(document.body.textContent).toContain('蓝蝶实例-65');
    const bs65Label = Array.from(document.body.querySelectorAll('.gs-dropdown-menu label')).find(
      (l) => l.textContent?.includes('蓝蝶实例-65'),
    );
    await act(async () => {
      (bs65Label?.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    });
    await flush();
    expect(api.googleSheetsUpdateLink).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'rec-1',
        recordsConfig: expect.objectContaining({
          bumperBluestacksIds: ['bs-65'],
          selectedInstanceIds: ['bs-65'],
        }),
      }),
    );

    // 2. 顶贴配置 modal exposes consumeCommentOnUse, enableSound, useLongPressReaction, reactionTypes
    const bumpBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '顶贴配置',
    ) as HTMLButtonElement;
    await act(async () => {
      bumpBtn.click();
    });
    const bumpDlg = host.querySelector('[role="dialog"][aria-label="顶贴配置"]') as HTMLElement;
    expect(bumpDlg).toBeTruthy();
    await act(async () => {
      (bumpDlg.querySelector('button[aria-label="留言后移除"]') as HTMLButtonElement).click();
      (bumpDlg.querySelector('button[aria-label="开启声音"]') as HTMLButtonElement).click();
      (bumpDlg.querySelector('button[aria-label="长按选表情"]') as HTMLButtonElement).click();
    });
    const hahaBtn = Array.from(bumpDlg.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('哈'),
    ) as HTMLButtonElement;
    expect(hahaBtn).toBeTruthy();
    await act(async () => {
      hahaBtn.click();
    });
    const saveBumpBtn = Array.from(bumpDlg.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '保存',
    ) as HTMLButtonElement;
    await act(async () => {
      saveBumpBtn.click();
    });
    await flush();
    expect(api.googleSheetsUpdateLink).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'rec-1',
        recordsConfig: expect.objectContaining({
          bumperSettings: expect.objectContaining({
            consumeCommentOnUse: true,
            enableSound: true,
            useLongPressReaction: true,
            reactionTypes: ['care', 'love', 'like', 'haha'],
          }),
        }),
      }),
    );

    // 3. 频率限制 modal displays inherited globalMaxConcurrency cleanly
    const freqBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '频率限制',
    ) as HTMLButtonElement;
    await act(async () => {
      freqBtn.click();
    });
    const freqDlg = host.querySelector('[role="dialog"][aria-label="频率限制"]') as HTMLElement;
    expect(freqDlg.textContent).toContain('全局并发上限');
    expect(freqDlg.textContent).toContain('12 并发');
  });

  it('re-enables toolbar on post_schedule & post_records with status filter chips and 重置卡死行 trigger', async () => {
    const schedLink = makeLink({ id: 'sched-1', kind: 'post_schedule' });
    const recLink = makeLink({ id: 'rec-1', kind: 'post_records', title: '发帖记录1' });
    const overview = makeOverview([schedLink, recLink]);
    const schedSnapshot: SheetGridSnapshot = {
      linkId: 'sched-1',
      spreadsheetId: schedLink.spreadsheetId,
      spreadsheetTitle: '运营云表',
      sheetName: '排贴表1',
      headers: ['发帖专页', '发布状态'],
      rows: [
        {
          rowNumber: 2,
          isHintRow: false,
          values: ['专页A', '待发布'],
          displayValues: ['专页A', '待发布'],
        },
        {
          rowNumber: 3,
          isHintRow: false,
          values: ['专页B', '发布中(电脑1号#ABCD)…'],
          displayValues: ['专页B', '发布中(电脑1号#ABCD)…'],
        },
        {
          rowNumber: 4,
          isHintRow: false,
          values: ['专页C', '失败：网络超时'],
          displayValues: ['专页C', '失败：网络超时'],
        },
        {
          rowNumber: 5,
          isHintRow: false,
          values: ['专页D', '已完成'],
          displayValues: ['专页D', '已完成'],
        },
      ],
      fetchedAt: Date.now(),
      totalRows: 4,
    };
    const onNotify = vi.fn();
    vi.mocked(api.googleSheetsOverview).mockResolvedValue(overview);
    vi.mocked(api.googleSheetsReadGrid).mockResolvedValue(schedSnapshot);
    vi.mocked(api.googleSheetsResetStuckRows).mockResolvedValue({
      linkId: 'sched-1',
      resetCount: 1,
      rowNumbers: [3],
      summary: '已重置 1 条卡死排贴行',
    });

    await act(async () => {
      root.render(
        <GoogleSheetsPage
          kind="post_schedule"
          overview={overview}
          onOverview={() => {}}
          profileGroups={[]}
          profiles={[]}
          onOpenAuthMenu={() => {}}
          onAfterLibrarySync={() => {}}
          onNotify={onNotify}
        />,
      );
    });
    await flush();

    expect(host.querySelector('input[type="search"]')).toBeTruthy();
    const filterGroup = host.querySelector(
      '[role="group"][aria-label="按状态筛选"]',
    ) as HTMLElement;
    expect(filterGroup).toBeTruthy();
    for (const label of ['全部', '待发', '发布中', '失败', '已完成']) {
      expect(filterGroup.textContent).toContain(label);
    }

    const clickChip = async (prefix: string) => {
      const btn = Array.from(filterGroup.querySelectorAll('button')).find((b) =>
        b.textContent?.startsWith(prefix),
      ) as HTMLButtonElement;
      expect(btn).toBeTruthy();
      await act(async () => {
        btn.click();
      });
    };

    await clickChip('发布中');
    expect(host.textContent).toContain('专页B');
    expect(host.textContent).not.toContain('专页A');
    expect(host.textContent).not.toContain('专页C');
    expect(host.textContent).not.toContain('专页D');

    await clickChip('失败');
    expect(host.textContent).toContain('专页C');
    expect(host.textContent).not.toContain('专页B');

    await clickChip('待发');
    expect(host.textContent).toContain('专页A');
    expect(host.textContent).not.toContain('专页C');

    await clickChip('已完成');
    expect(host.textContent).toContain('专页D');
    expect(host.textContent).not.toContain('专页A');

    await clickChip('全部');
    expect(host.textContent).toContain('专页A');
    expect(host.textContent).toContain('专页B');
    expect(host.textContent).toContain('专页C');
    expect(host.textContent).toContain('专页D');

    const resetBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '重置卡死行',
    ) as HTMLButtonElement;
    expect(resetBtn).toBeTruthy();
    await act(async () => {
      resetBtn.click();
    });
    await flush();
    expect(api.googleSheetsResetStuckRows).toHaveBeenCalledWith('sched-1');
    expect(api.googleSheetsReadGrid).toHaveBeenLastCalledWith('sched-1', true);
    expect(onNotify).toHaveBeenCalledWith('已重置 1 条卡死排贴行');

    // post_records also has toolbar & status filter chips enabled
    vi.mocked(api.googleSheetsReadGrid).mockResolvedValue({
      ...schedSnapshot,
      linkId: 'rec-1',
      sheetName: '发帖记录1',
    });
    await act(async () => {
      root.render(
        <GoogleSheetsPage
          kind="post_records"
          overview={overview}
          onOverview={() => {}}
          profileGroups={[]}
          profiles={[]}
          onOpenAuthMenu={() => {}}
          onAfterLibrarySync={() => {}}
          onNotify={onNotify}
        />,
      );
    });
    await flush();
    expect(host.querySelector('input[type="search"]')).toBeTruthy();
    expect(host.querySelector('[role="group"][aria-label="按状态筛选"]')).toBeTruthy();
  });

  it('clears failedGridLinksRef and reloads grid automatically when auth.authorized flips false -> true', async () => {
    const schedLink = makeLink({ id: 'sched-auth-1', kind: 'post_schedule' });
    const authedOverview = makeOverview([schedLink], true);
    const unauthedOverview = makeOverview([schedLink], false);
    const recoveredSnap: SheetGridSnapshot = {
      linkId: 'sched-auth-1',
      spreadsheetId: schedLink.spreadsheetId,
      spreadsheetTitle: '运营云表',
      sheetName: '排贴表1',
      headers: ['发帖专页', '发布状态'],
      rows: [
        {
          rowNumber: 2,
          isHintRow: false,
          values: ['恢复专页', '待发布'],
          displayValues: ['恢复专页', '待发布'],
        },
      ],
      fetchedAt: Date.now(),
      totalRows: 1,
    };

    vi.mocked(api.googleSheetsReadGrid).mockRejectedValueOnce(new Error('401 Unauthorized'));

    await act(async () => {
      root.render(
        <GoogleSheetsPage
          kind="post_schedule"
          overview={authedOverview}
          onOverview={() => {}}
          profileGroups={[]}
          profiles={[]}
          onOpenAuthMenu={() => {}}
          onAfterLibrarySync={() => {}}
          onNotify={() => {}}
        />,
      );
    });
    await flush();
    expect(api.googleSheetsReadGrid).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain('恢复专页');

    // Auth flips to false (expired/revoked)
    await act(async () => {
      root.render(
        <GoogleSheetsPage
          kind="post_schedule"
          overview={unauthedOverview}
          onOverview={() => {}}
          profileGroups={[]}
          profiles={[]}
          onOpenAuthMenu={() => {}}
          onAfterLibrarySync={() => {}}
          onNotify={() => {}}
        />,
      );
    });
    await flush();

    // User re-authorizes (auth.authorized flips false -> true): failedGridLinksRef clears & reloads automatically
    vi.mocked(api.googleSheetsReadGrid).mockResolvedValueOnce(recoveredSnap);
    await act(async () => {
      root.render(
        <GoogleSheetsPage
          kind="post_schedule"
          overview={authedOverview}
          onOverview={() => {}}
          profileGroups={[]}
          profiles={[]}
          onOpenAuthMenu={() => {}}
          onAfterLibrarySync={() => {}}
          onNotify={() => {}}
        />,
      );
    });
    await flush();

    expect(api.googleSheetsReadGrid).toHaveBeenCalledTimes(2);
    expect(api.googleSheetsReadGrid).toHaveBeenLastCalledWith('sched-auth-1', false);
    expect(host.textContent).toContain('恢复专页');
  });
});
