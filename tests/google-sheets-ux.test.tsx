// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { api } from '../src/renderer/api.js';
import { copyTextToClipboard } from '../src/renderer/clipboard.js';
import { GoogleSheetsAuthPanel } from '../src/renderer/modules/sheets/google-sheets-auth-panel.js';
import {
  clearGoogleSheetsGridCache,
  GoogleSheetsPage,
} from '../src/renderer/modules/sheets/google-sheets-page.js';
import { SheetConnectModal } from '../src/renderer/modules/sheets/sheet-connect-modal.js';
import { SheetBottomTabs } from '../src/renderer/modules/sheets/sheet-bottom-tabs.js';
import type { GoogleSheetLink, GoogleSheetsOverview } from '../src/shared/google-sheets.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/renderer/api.js', () => ({
  api: {
    googleSheetsOverview: vi.fn(),
    googleSheetsImageHostTokens: vi.fn(),
    googleSheetsImportCredentials: vi.fn(),
    googleSheetsStartAuth: vi.fn(),
    googleSheetsSaveImageHost: vi.fn(),
    googleSheetsTestImageHost: vi.fn(),
    googleSheetsInspect: vi.fn(),
    googleSheetsCreateLink: vi.fn(),
    googleSheetsUpdateLink: vi.fn(),
    googleSheetsDeleteLink: vi.fn(),
    googleSheetsReadGrid: vi.fn(),
    googleSheetsPollSchedule: vi.fn(),
    googleSheetsPollRecords: vi.fn(),
    googleSheetsResetStuckRows: vi.fn(),
    googleSheetsStopLink: vi.fn(),
  },
}));

vi.mock('../src/renderer/clipboard.js', () => ({
  copyTextToClipboard: vi.fn(),
}));

function makeLink(overrides: Partial<GoogleSheetLink>): GoogleSheetLink {
  return {
    id: 'link-1',
    kind: 'post_schedule',
    title: '排贴-专页1',
    spreadsheetId: '1CpXEEOO9X4S8TJhIlImzVQFnVCXLgv7Nk1eU6D0SI3U',
    spreadsheetTitle: '模板文档',
    sheetId: 101,
    sheetName: '排贴-专页1',
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

describe('Google Sheets streamlined UX (auth one-step, multi-token auto-save, empty connect, tab close)', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    clearGoogleSheetsGridCache();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    vi.mocked(copyTextToClipboard).mockResolvedValue(undefined);
    vi.mocked(api.googleSheetsOverview).mockResolvedValue({
      auth: {
        hasCredentials: false,
        clientIdHint: null,
        authorized: false,
        authorizedEmail: null,
        scopes: [],
        pendingAuthUrl: null,
        pendingAuthStartedAt: null,
        lastError: null,
      },
      imageHost: {
        preferredHost: 'auto',
        hasGyazoToken: true,
        gyazoTokenPreview: 'tok1••••1111',
        gyazoTokenCount: 1,
        gyazoTokenPreviews: ['tok1••••1111'],
        driveFolderId: null,
        defaultMachineName: '姜姜',
        cachedImageCount: 3,
      },
      links: [],
      logs: [],
      runningScheduleCount: 0,
      runningRecordsCount: 0,
      activeProfiles: [],
    });
    vi.mocked(api.googleSheetsImageHostTokens).mockResolvedValue({
      tokens: ['tok1_initial_1111'],
    });
    vi.mocked(api.googleSheetsSaveImageHost).mockImplementation(async (body) => {
      const rec = body as {
        preferredHost?: 'auto' | 'gyazo' | 'drive';
        defaultMachineName?: string;
        gyazoAccessTokens?: string[];
      };
      const toks = rec.gyazoAccessTokens ?? [];
      return {
        preferredHost: rec.preferredHost ?? 'auto',
        hasGyazoToken: toks.length > 0,
        gyazoTokenPreview: toks[0] ? `${toks[0].slice(0, 4)}••••${toks[0].slice(-4)}` : null,
        gyazoTokenCount: toks.length,
        gyazoTokenPreviews: toks.map((t) => `${t.slice(0, 4)}••••${t.slice(-4)}`),
        driveFolderId: null,
        defaultMachineName: rec.defaultMachineName ?? '姜姜',
        cachedImageCount: 3,
      };
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.clearAllMocks();
  });

  it('auto-generates and copies OAuth link immediately after importing JSON, and auto-saves multi-token edits without a save button', async () => {
    vi.mocked(api.googleSheetsImportCredentials).mockResolvedValue({
      hasCredentials: true,
      clientIdHint: 'cid-999',
      authorized: false,
      authorizedEmail: null,
      scopes: [],
      pendingAuthUrl: null,
      pendingAuthStartedAt: null,
      lastError: null,
    });
    vi.mocked(api.googleSheetsStartAuth).mockResolvedValue({
      authUrl: 'https://accounts.google.com/o/oauth2/auth?client_id=cid-999',
      status: {
        hasCredentials: true,
        clientIdHint: 'cid-999',
        authorized: false,
        authorizedEmail: null,
        scopes: [],
        pendingAuthUrl: 'https://accounts.google.com/o/oauth2/auth?client_id=cid-999',
        pendingAuthStartedAt: Date.now(),
        lastError: null,
      },
    });

    await act(async () => {
      root.render(<GoogleSheetsAuthPanel />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // No manual "保存图床与本机设置" button exists anymore
    expect(host.textContent).not.toContain('保存图床与本机设置');

    // Step 1: Select credentials.json file -> immediately imports, generates authUrl, and copies to clipboard!
    const fileInput = host.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    const fakeFile = {
      name: 'credentials.json',
      text: async () => '{"installed":{"client_id":"cid-999","client_secret":"sec"}}',
    } as unknown as File;
    Object.defineProperty(fileInput, 'files', { value: [fakeFile], configurable: true });
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.googleSheetsImportCredentials).toHaveBeenCalledTimes(1);
    expect(api.googleSheetsStartAuth).toHaveBeenCalledTimes(1);
    expect(copyTextToClipboard).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/auth?client_id=cid-999',
    );
    expect(host.textContent).toContain('已自动生成并复制授权链接');

    // Step 2: Edit Gyazo multiline token textarea with 2 tokens and blur -> auto-saves immediately!
    const textarea = host.querySelector('textarea.gs-token-textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.value).toBe('tok1_initial_1111');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    await act(async () => {
      textarea.focus();
      setter?.call(textarea, 'tok1_initial_1111\ntok2_second_2222');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.googleSheetsSaveImageHost).toHaveBeenCalledWith({
      preferredHost: 'auto',
      defaultMachineName: '姜姜',
      gyazoAccessTokens: ['tok1_initial_1111', 'tok2_second_2222'],
    });
    expect(host.textContent).toContain('已配置 2 个');
  });

  it('SheetConnectModal starts blank without pre-filling previous URL and prevents duplicate tab connection', async () => {
    const existing = makeLink({ sheetId: 101, sheetName: '排贴-专页1' });
    vi.mocked(api.googleSheetsInspect).mockResolvedValue({
      spreadsheetId: existing.spreadsheetId,
      title: '模板文档',
      url: `https://docs.google.com/spreadsheets/d/${existing.spreadsheetId}/edit`,
      suggestedGid: 101,
      tabs: [
        { sheetId: 101, title: '排贴-专页1', rowCount: 100, columnCount: 15 },
        { sheetId: 202, title: '排贴-专页2', rowCount: 100, columnCount: 15 },
      ],
    });

    await act(async () => {
      root.render(
        <SheetConnectModal
          kind="post_schedule"
          sameDocSuggestionUrl={existing.spreadsheetUrl}
          existingLinks={[existing]}
          onClose={() => {}}
          onConnected={() => {}}
        />,
      );
    });

    const urlInput = host.querySelector('input[type="text"]') as HTMLInputElement;
    expect(urlInput.value).toBe('');

    // Clicking same-doc helper fills and inspects, automatically skipping already-connected tab 101 to pick 202!
    const shortcutBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('填入当前文档并读取'),
    );
    expect(shortcutBtn).toBeTruthy();
    await act(async () => {
      shortcutBtn?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const select = host.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('排贴-专页2');
    expect(select.textContent).toContain('排贴-专页1（已连接）');
  });

  it('SheetBottomTabs renders direct × remove button on each tab', async () => {
    const onDelete = vi.fn();
    const onSelect = vi.fn();
    const l1 = makeLink({ id: 'a', title: '排贴1' });
    const l2 = makeLink({ id: 'b', title: '排贴2', sheetId: 102 });

    await act(async () => {
      root.render(
        <SheetBottomTabs
          links={[l1, l2]}
          activeLinkId="a"
          addLabel="连接排贴表"
          onSelect={onSelect}
          onAdd={() => {}}
          onRename={async () => {}}
          onDelete={onDelete}
        />,
      );
    });

    const closeBtn = host.querySelector('button[aria-label="移除 排贴2"]') as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();
    await act(async () => {
      closeBtn.click();
    });
    expect(onDelete).toHaveBeenCalledWith(l2);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('GoogleSheetsPage post_schedule renders streamlined topbar controls with grid search, status filter chips, and reset-stuck trigger', async () => {
    const recLink = makeLink({
      id: 'rec-1',
      kind: 'post_records',
      title: '发帖记录',
      sheetId: 102,
      sheetName: '发帖记录',
    });
    const schedLink = makeLink({
      id: 'sched-1',
      kind: 'post_schedule',
      title: '排贴-专页1',
      scheduleConfig: {
        enabled: false,
        pollIntervalMinutes: 2,
        targetRecordLinkId: null,
        autoWakeBumper: true,
        executionCarrier: 'browser',
        bluestacksFolderIds: [],
        bluestacksInstanceIds: [],
        closeBluestacksOnFinish: true,
      },
    });
    const overview: GoogleSheetsOverview = {
      auth: {
        hasCredentials: true,
        clientIdHint: 'cid',
        authorized: true,
        authorizedEmail: 'ops@example.com',
        scopes: [],
        pendingAuthUrl: null,
        pendingAuthStartedAt: null,
        lastError: null,
      },
      imageHost: {
        preferredHost: 'auto',
        hasGyazoToken: true,
        gyazoTokenPreview: 'tok1••••1111',
        gyazoTokenCount: 1,
        gyazoTokenPreviews: ['tok1••••1111'],
        driveFolderId: null,
        defaultMachineName: '姜姜',
        cachedImageCount: 0,
      },
      links: [schedLink, recLink],
      logs: [],
      runningScheduleCount: 0,
      runningRecordsCount: 0,
      activeProfiles: [],
    };
    vi.mocked(api.googleSheetsOverview).mockResolvedValue(overview);
    vi.mocked(api.googleSheetsUpdateLink).mockResolvedValue(schedLink);
    vi.mocked(api.googleSheetsReadGrid).mockResolvedValue({
      linkId: 'sched-1',
      spreadsheetTitle: '模板文档',
      sheetName: '排贴-专页1',
      headers: ['发帖专页', '发布状态'],
      rows: [],
      fetchedAt: Date.now(),
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
          onNotify={() => {}}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Toolbar search, status filter chips, reset-stuck button, and policy popover exist; no legacy total config modal
    expect(host.querySelector('input[type="search"]')).toBeTruthy();
    const filterGroup = host.querySelector(
      '[role="group"][aria-label="按状态筛选"]',
    ) as HTMLElement;
    expect(filterGroup).toBeTruthy();
    for (const label of ['全部', '待发', '发布中', '失败', '已完成']) {
      expect(filterGroup.textContent).toContain(label);
    }
    expect(
      Array.from(host.querySelectorAll('button')).some(
        (b) => b.textContent?.trim() === '重置卡死行',
      ),
    ).toBe(true);
    expect(host.querySelector('button[aria-label="排贴轮询与唤醒设置"]')).toBeTruthy();
    expect(host.textContent).not.toContain('排贴配置');
    expect(host.textContent).not.toContain('高级配置');
    // Corner refresh icon exists hugging table
    expect(host.querySelector('button[aria-label="刷新表格"]')).toBeTruthy();

    // Selecting target record sheet saves immediately
    const recSelect = host.querySelector(
      'select[aria-label="选择要登记的发帖记录表"]',
    ) as HTMLSelectElement;
    expect(recSelect).toBeTruthy();
    await act(async () => {
      recSelect.value = 'rec-1';
      recSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(api.googleSheetsUpdateLink).toHaveBeenCalledWith({
      id: 'sched-1',
      scheduleConfig: { targetRecordLinkId: 'rec-1' },
    });

    // Selecting execution carrier saves immediately
    const carrierSelect = host.querySelector(
      'select[aria-label="选择发帖执行方式"]',
    ) as HTMLSelectElement;
    expect(carrierSelect).toBeTruthy();
    await act(async () => {
      carrierSelect.value = 'auto';
      carrierSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(api.googleSheetsUpdateLink).toHaveBeenCalledWith({
      id: 'sched-1',
      scheduleConfig: { executionCarrier: 'auto' },
    });

    // Auto-post switch saves immediately
    const autoBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('开启自动发帖'),
    );
    expect(autoBtn).toBeTruthy();
    await act(async () => {
      autoBtn?.click();
    });
    expect(api.googleSheetsUpdateLink).toHaveBeenCalledWith({
      id: 'sched-1',
      scheduleConfig: { enabled: true },
    });
  });

  it('GoogleSheetsPage post_records splits controls cleanly with toolbar/status chips, full bump switches/pills, and separate frequency modal', async () => {
    const recLink = makeLink({
      id: 'rec-1',
      kind: 'post_records',
      title: '发帖记录',
      sheetId: 102,
      sheetName: '发帖记录',
      recordsConfig: {
        enabled: false,
        machineName: '姜姜',
        bumperProfileGroupIds: [],
        bumperBluestacksFolderIds: [],
        bumperBluestacksIds: [],
        activePollMinutes: 2,
        semiActiveAfterIdlePolls: 5,
        semiActivePollMinutes: 10,
        collectMetricsOnThisPc: false,
        bumperSettings: {
          likeProbability: 100,
          commentProbability: 30,
          maxLikesPerPost: 50,
          dailyMaxLikesPerAccount: 20,
          maxPostAgeHours: 24,
          minIntervalSec: 3,
          maxIntervalSec: 8,
          scrollPauseSec: 2,
        },
        commentPool: ['Amen!'],
      },
    });
    const overview: GoogleSheetsOverview = {
      auth: {
        hasCredentials: true,
        clientIdHint: 'cid',
        authorized: true,
        authorizedEmail: 'ops@example.com',
        scopes: [],
        pendingAuthUrl: null,
        pendingAuthStartedAt: null,
        lastError: null,
      },
      imageHost: {
        preferredHost: 'auto',
        hasGyazoToken: true,
        gyazoTokenPreview: 'tok1••••1111',
        gyazoTokenCount: 1,
        gyazoTokenPreviews: ['tok1••••1111'],
        driveFolderId: null,
        defaultMachineName: '姜姜',
        cachedImageCount: 0,
      },
      links: [recLink],
      logs: [],
      runningScheduleCount: 0,
      runningRecordsCount: 0,
      activeProfiles: [],
    };
    vi.mocked(api.googleSheetsOverview).mockResolvedValue(overview);
    vi.mocked(api.googleSheetsUpdateLink).mockResolvedValue(recLink);
    vi.mocked(api.googleSheetsReadGrid).mockResolvedValue({
      linkId: 'rec-1',
      spreadsheetTitle: '模板文档',
      sheetName: '发帖记录',
      headers: ['发帖日期', '小组id'],
      rows: [],
      fetchedAt: Date.now(),
    });

    await act(async () => {
      root.render(
        <GoogleSheetsPage
          kind="post_records"
          overview={overview}
          onOverview={() => {}}
          profileGroups={[{ id: 'grp-1', name: '顶贴一组', color: 'blue', sortOrder: 0 }]}
          profiles={[
            {
              id: 'p1',
              alias: '号1',
              browserName: '号1',
              groupId: 'grp-1',
              order: 0,
              online: true,
              phase: 'READY',
              synced: true,
              unresolved: 0,
              extensionVersion: '0.3.84',
              capabilities: [],
              presentation: null,
              account: { state: 'logged-in', id: '10001', name: 'A', avatar: null },
            },
          ]}
          onOpenAuthMenu={() => {}}
          onAfterLibrarySync={() => {}}
          onNotify={() => {}}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Toolbar search bar, status filter chips, and corner refresh icon present
    expect(host.querySelector('input[type="search"]')).toBeTruthy();
    const recFilterGroup = host.querySelector(
      '[role="group"][aria-label="按状态筛选"]',
    ) as HTMLElement;
    expect(recFilterGroup).toBeTruthy();
    for (const label of ['全部', '待发', '发布中', '失败', '已完成']) {
      expect(recFilterGroup.textContent).toContain(label);
    }
    expect(host.querySelector('button[aria-label="刷新表格"]')).toBeTruthy();

    // 1. Account group dropdown auto-saves immediately
    const groupTrigger = host.querySelector(
      'button[aria-label="下拉选择顶贴账号组"]',
    ) as HTMLButtonElement;
    expect(groupTrigger).toBeTruthy();
    await act(async () => {
      groupTrigger.click();
    });
    const grpCheckbox = document.body.querySelector(
      '.gs-dropdown-menu input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(grpCheckbox).toBeTruthy();
    await act(async () => {
      grpCheckbox.click();
    });
    expect(api.googleSheetsUpdateLink).toHaveBeenCalledWith({
      id: 'rec-1',
      recordsConfig: {
        bumperProfileGroupIds: ['grp-1'],
        bumperBluestacksFolderIds: [],
        bumperBluestacksIds: [],
      },
    });

    // 2. Inline machine name auto-saves on blur
    const machineInput = host.querySelector('input[aria-label="本机名字"]') as HTMLInputElement;
    expect(machineInput.value).toBe('姜姜');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      machineInput.focus();
      setter?.call(machineInput, '二号机');
      machineInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      machineInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(api.googleSheetsUpdateLink).toHaveBeenCalledWith({
      id: 'rec-1',
      recordsConfig: { machineName: '二号机' },
    });

    // 3. Inline 本机采赞评 checkbox auto-saves immediately
    const metricsCheckbox = host.querySelector(
      '.gs-bar-check input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(metricsCheckbox).toBeTruthy();
    await act(async () => {
      metricsCheckbox.click();
    });
    expect(api.googleSheetsUpdateLink).toHaveBeenCalledWith({
      id: 'rec-1',
      recordsConfig: { collectMetricsOnThisPc: true },
    });

    // 4. 顶贴配置 modal contains 3 text/number inputs plus full bumper switches & reaction pills
    const bumpBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '顶贴配置',
    );
    expect(bumpBtn).toBeTruthy();
    await act(async () => {
      bumpBtn?.click();
    });
    const bumpDialog = host.querySelector('[role="dialog"][aria-label="顶贴配置"]') as HTMLElement;
    expect(bumpDialog).toBeTruthy();
    expect(bumpDialog.querySelectorAll('input, textarea, select').length).toBe(3);
    for (const swLabel of ['留言后移除', '开启声音', '长按选表情']) {
      expect(bumpDialog.querySelector(`[role="switch"][aria-label="${swLabel}"]`)).toBeTruthy();
    }
    const longPressSwitch = bumpDialog.querySelector(
      '[role="switch"][aria-label="长按选表情"]',
    ) as HTMLButtonElement;
    await act(async () => {
      longPressSwitch.click();
    });
    expect(bumpDialog.querySelector('[role="group"][aria-label="表情类型选择"]')).toBeTruthy();
    expect(bumpDialog.textContent).not.toContain('本机');
    expect(bumpDialog.textContent).not.toContain('积极监听');
    const closeBump = Array.from(bumpDialog.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '关闭',
    );
    await act(async () => {
      closeBump?.click();
    });

    // 5. 频率限制 modal opens as a dedicated separate modal with 6 limit inputs + inherited concurrency
    const freqBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '频率限制',
    );
    expect(freqBtn).toBeTruthy();
    await act(async () => {
      freqBtn?.click();
    });
    const freqDialog = host.querySelector('[role="dialog"][aria-label="频率限制"]') as HTMLElement;
    expect(freqDialog).toBeTruthy();
    expect(freqDialog.querySelectorAll('input, textarea, select').length).toBe(6);
    expect(freqDialog.textContent).toContain('全局并发上限');
    expect(freqDialog.textContent).not.toContain('评论词库');
  });

  it('reuses client grid cache on page switch (0 extra reads) and passes force=true on manual refresh', async () => {
    const recLink = makeLink({
      id: 'rec-cache-1',
      kind: 'post_records',
      title: '缓存测试表',
      recordsConfig: {
        enabled: false,
        machineName: '本机1号',
        collectMetricsOnThisPc: false,
        bumperProfileGroupIds: [],
        bumperProfileIds: [],
        bumperBluestacksFolderIds: [],
        bumperBluestacksIds: [],
        activePollMinutes: 2,
        semiActivePollMinutes: 10,
        semiActiveAfterIdlePolls: 5,
        commentPool: [],
        bumperSettings: {
          maxLikesPerPost: 3,
          dailyMaxLikesPerAccount: 30,
          dailyMaxCommentsPerAccount: 10,
          likeProbability: 100,
          commentProbability: 0,
          maxPostAgeHours: 72,
          minIntervalSeconds: 20,
          maxIntervalSeconds: 45,
          maxConcurrentProfiles: 2,
          reactionType: 'like',
          enableSound: false,
          consumeCommentOnUse: false,
        },
      },
    });
    const overview: GoogleSheetsOverview = {
      auth: {
        hasCredentials: true,
        clientIdHint: 'abc',
        authorized: true,
        authorizedEmail: 'ops@example.com',
        scopes: [],
        pendingAuthUrl: null,
        pendingAuthStartedAt: null,
        lastError: null,
      },
      imageHost: {
        preferredHost: 'auto',
        hasGyazoToken: false,
        gyazoTokenPreview: null,
        gyazoTokenCount: 0,
        gyazoTokenPreviews: [],
        driveFolderId: null,
        defaultMachineName: '本机1号',
        cachedImageCount: 0,
      },
      links: [recLink],
      logs: [],
      runningScheduleCount: 0,
      runningRecordsCount: 0,
      activeProfiles: [],
    };
    vi.mocked(api.googleSheetsReadGrid).mockResolvedValue({
      linkId: 'rec-cache-1',
      spreadsheetId: recLink.spreadsheetId,
      spreadsheetTitle: '模板',
      sheetName: '缓存测试表',
      headers: ['贴文编码'],
      rows: [
        { rowNumber: 2, isHintRow: false, values: ['P-CACHE-1'], displayValues: ['P-CACHE-1'] },
      ],
      fetchedAt: Date.now(),
      totalRows: 1,
    });

    // 1. Initial mount fetches once (force=false)
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
          onNotify={() => {}}
        />,
      );
    });
    expect(api.googleSheetsReadGrid).toHaveBeenCalledTimes(1);
    expect(api.googleSheetsReadGrid).toHaveBeenLastCalledWith('rec-cache-1', false);
    expect(host.textContent).toContain('贴文编码');

    // 2. Unmount and remount (simulating switching left-nav tabs) -> 0ms cached render, 0 extra reads!
    await act(async () => {
      root.render(<div />);
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
          onNotify={() => {}}
        />,
      );
    });
    expect(api.googleSheetsReadGrid).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('贴文编码');

    // 3. Clicking manual refresh icon forces fresh fetch (force=true)
    const refreshBtn = host.querySelector('button[aria-label="刷新表格"]') as HTMLButtonElement;
    expect(refreshBtn).toBeTruthy();
    await act(async () => {
      refreshBtn.click();
    });
    expect(api.googleSheetsReadGrid).toHaveBeenCalledTimes(2);
    expect(api.googleSheetsReadGrid).toHaveBeenLastCalledWith('rec-cache-1', true);
  });
});
