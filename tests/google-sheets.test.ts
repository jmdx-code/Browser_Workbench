import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { PosterLog } from '../src/shared/group-poster.js';
import {
  columnIndexToA1,
  computeLibrarySyncDiff,
  evaluateMetricsEligibility,
  extractFacebookPostIdFromUrl,
  extractImageUrlFromCell,
  generatePostCode,
  generateResourceCode,
  inferBumperSourceMode,
  isDirectFacebookPostUrl,
  isTemplateHintRow,
  maskGyazoToken,
  nextTieredPollingState,
  PAGE_TIMELINE_SYNTHETIC_GROUP_ID,
  parseGoogleSpreadsheetUrl,
  parseGroupsSpec,
  parseGyazoTokenList,
  parseScheduleDateTimeMs,
  resolveEffectiveGyazoTokens,
  resolveGroupLibraryColumns,
  resolvePageLibraryColumns,
  resolveRecordColumns,
  resolveScheduleColumns,
  sanitizeSheetCellValue,
  toSheetsImageFormula,
  type GoogleAuthStatus,
} from '../src/shared/google-sheets.js';
import { bluestacksDisplayTitle } from '../src/shared/bluestacks.js';
import { pruneStaleRuntimeBackups } from '../src/infrastructure/software-update-backend.js';
import { FilesystemWorkspaceBackupWriter } from '../src/infrastructure/workspace-backup-writer.js';
import { mkdtemp, mkdir, rm, access, readdir, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FilesystemPosterMediaPreparer } from '../src/infrastructure/group-poster-runner.js';
import { GoogleSheetsRestClient } from '../src/infrastructure/google-sheets-client.js';
import { parseFacebookMetricsFromHtml } from '../src/infrastructure/google-sheets-automation-bridge.js';
import { SqliteGoogleSheetsRepository } from '../src/infrastructure/google-sheets-store.js';
import {
  GoogleOAuthManager,
  parseGoogleCredentialsJson,
} from '../src/infrastructure/google-oauth.js';
import { SheetImageHostClient } from '../src/infrastructure/sheet-image-host.js';
import { GoogleSheetsService } from '../src/application/google-sheets-service.js';
import { FeatureExecutionRegistry } from '../src/application/feature-execution-registry.js';
import type {
  GoogleOAuthPort,
  GoogleSheetsApiPort,
  SheetAutomationBridgePort,
  SheetImageHostPort,
} from '../src/application/google-sheets-ports.js';
import type { GroupBumperService } from '../src/application/group-bumper-service.js';
import type { WorkspaceService } from '../src/application/workspace-service.js';

describe('Google Sheets shared pure rules', () => {
  it('parses Google Spreadsheet URLs, gid fragments, and bare IDs', () => {
    const parsed = parseGoogleSpreadsheetUrl(
      'https://docs.google.com/spreadsheets/d/1CpXEEOO9X4S8TJhIlImzVQFnVCXLgv7Nk1eU6D0SI3U/edit?gid=1855367699#gid=1855367699',
    );
    expect(parsed).toEqual({
      spreadsheetId: '1CpXEEOO9X4S8TJhIlImzVQFnVCXLgv7Nk1eU6D0SI3U',
      gid: 1855367699,
    });
    expect(parseGoogleSpreadsheetUrl('1CpXEEOO9X4S8TJhIlImzVQFnVCXLgv7Nk1eU6D0SI3U')).toEqual({
      spreadsheetId: '1CpXEEOO9X4S8TJhIlImzVQFnVCXLgv7Nk1eU6D0SI3U',
      gid: null,
    });
    expect(parseGoogleSpreadsheetUrl('not-a-valid-url')).toBeNull();
  });

  it('converts 0-based column indices to A1 notation cleanly', () => {
    expect(columnIndexToA1(0)).toBe('A');
    expect(columnIndexToA1(13)).toBe('N');
    expect(columnIndexToA1(25)).toBe('Z');
    expect(columnIndexToA1(26)).toBe('AA');
    expect(columnIndexToA1(51)).toBe('AZ');
  });

  it('resolves exact user template headers dynamically regardless of column order', () => {
    const groupCols = resolveGroupLibraryColumns([
      '小组头像',
      '小组id',
      '备注',
      '类别',
      '小组名字',
    ]);
    expect(groupCols).toEqual({ avatar: 0, id: 1, category: 3, name: 4 });

    const pageCols = resolvePageLibraryColumns(['类别', '专页id', '专页名字', '专页头像']);
    expect(pageCols).toEqual({ category: 0, id: 1, name: 2, avatar: 3 });

    const schedCols = resolveScheduleColumns([
      '发帖专页',
      '发帖日期',
      '发帖时间',
      '发帖文案',
      '发帖素材',
      '开启AI声明',
      '是否发时间线',
      '发多少小组',
      '缩略图',
      '资源编号',
      '发布状态',
      '已发小组数量',
    ]);
    expect(schedCols.pageId).toBe(0);
    expect(schedCols.postTimeline).toBe(6);
    expect(schedCols.groupsSpec).toBe(7);
    expect(schedCols.resourceCode).toBe(9);
    expect(schedCols.postedGroupsCount).toBe(11);

    const recCols = resolveRecordColumns(
      [
        '发帖日期',
        '小组id',
        '小组名字',
        '专页id',
        '专页名字',
        '贴文链接',
        '小组头像',
        '专页头像',
        '贴文编号',
        '缩略图',
        '点赞',
        '留言',
        '',
        '电脑1号',
      ],
      '电脑1号',
    );
    expect(recCols.postUrl).toBe(5);
    expect(recCols.postCode).toBe(8);
    expect(recCols.likes).toBe(10);
    expect(recCols.comments).toBe(11);
    expect(recCols.machineColumn).toBe(13);
  });

  it('detects template hint rows while leaving real data rows untouched', () => {
    expect(
      isTemplateHintRow([
        '(填id)',
        '',
        '',
        '',
        '(填网盘链接)',
        '(是/否）',
        '(是/否）',
        '(填数字随机发，填小组id指定发，留空不发)',
        '(软件生成)',
        '(日期-素材随机码)',
        '(软件负责填)',
      ]),
    ).toBe(true);
    expect(
      isTemplateHintRow(['', '', '', '', '', '', '', '', '(日期-素材随机码-发帖随机码)']),
    ).toBe(true);
    expect(
      isTemplateHintRow(['100088899900011', '2026-11-20', '14:30', 'Amen!', '', '是', '是', '5']),
    ).toBe(false);
  });

  it('parses 发多少小组 specs including integer random, 经文群:5 shorthand, and explicit IDs', () => {
    expect(parseGroupsSpec('')).toEqual({ mode: 'none' });
    expect(parseGroupsSpec('0')).toEqual({ mode: 'none' });
    expect(parseGroupsSpec('5')).toEqual({ mode: 'random', count: 5, category: null });
    expect(parseGroupsSpec('5', '祷告群')).toEqual({
      mode: 'random',
      count: 5,
      category: '祷告群',
    });
    expect(parseGroupsSpec('经文群:5')).toEqual({
      mode: 'random',
      count: 5,
      category: '经文群',
    });
    expect(parseGroupsSpec('经文群：8')).toEqual({
      mode: 'random',
      count: 8,
      category: '经文群',
    });
    expect(
      parseGroupsSpec(
        '123456789012, https://www.facebook.com/groups/987654321098/ \n 123456789012',
      ),
    ).toEqual({
      mode: 'explicit',
      groupIds: ['123456789012', '987654321098'],
    });
  });

  it('computes smart library diff sync preserving hint rows & custom right-hand columns', () => {
    const diff = computeLibrarySyncDiff({
      kind: 'group',
      columns: { category: 0, id: 1, name: 2, avatar: 3 },
      sheetRows: [
        { rowNumber: 2, isHintRow: true, values: ['(类别)', '(填id)', '', ''] },
        {
          rowNumber: 3,
          isHintRow: false,
          values: ['旧分组', '1111111111', '旧群名', '', '用户自定义备注'],
        },
        {
          rowNumber: 4,
          isHintRow: false,
          values: ['已删分组', '2222222222', '应删除群', ''],
        },
        {
          rowNumber: 5,
          isHintRow: false,
          values: ['不变分组', '3333333333', '不变群名', '=IMAGE("https://i.gyazo.com/a.png")'],
        },
      ],
      localItems: [
        {
          id: '1111111111',
          category: '新分组',
          name: '新群名',
          avatarCellValue: '=IMAGE("https://i.gyazo.com/1.png")',
        },
        {
          id: '3333333333',
          category: '不变分组',
          name: '不变群名',
          avatarCellValue: '=IMAGE("https://i.gyazo.com/a.png")',
        },
        {
          id: '4444444444',
          category: '新增分组',
          name: '新增群',
          avatarCellValue: '=IMAGE("https://i.gyazo.com/4.png")',
        },
      ],
    });

    expect(diff.stats).toEqual({ updated: 1, added: 1, deleted: 1, unchanged: 1 });
    expect(diff.deleteRowNumbersDesc).toEqual([4]);
    expect(diff.cellUpdates).toEqual([
      { rowNumber: 3, colIndex: 0, value: '新分组' },
      { rowNumber: 3, colIndex: 2, value: '新群名' },
      { rowNumber: 3, colIndex: 3, value: '=IMAGE("https://i.gyazo.com/1.png")' },
    ]);
    expect(diff.appends).toEqual([
      ['新增分组', '4444444444', '新增群', '=IMAGE("https://i.gyazo.com/4.png")'],
    ]);
  });

  it('evaluates 24h + 72h engagement scraping eligibility accurately', () => {
    const now = Date.UTC(2026, 10, 20, 12, 0, 0);
    expect(evaluateMetricsEligibility(now - 10 * 3600_000, 0, now)).toBeNull();
    expect(evaluateMetricsEligibility(now - 25 * 3600_000, 0, now)).toBe('24h');
    expect(evaluateMetricsEligibility(now - 48 * 3600_000, 1, now)).toBeNull();
    expect(evaluateMetricsEligibility(now - 73 * 3600_000, 1, now)).toBe('72h');
    expect(evaluateMetricsEligibility(now - 96 * 3600_000, 2, now)).toBeNull();
  });

  it('transitions tiered polling between 2m active and 10m semi-active after 5 idle polls', () => {
    const now = 1_000_000;
    let mode: 'idle' | 'active' | 'semi_active' = 'active';
    let idle = 0;
    for (let i = 1; i <= 4; i++) {
      const next = nextTieredPollingState({
        currentMode: mode,
        consecutiveIdlePolls: idle,
        hasNewActivity: false,
        activePollMinutes: 2,
        semiActivePollMinutes: 10,
        semiActiveAfterIdlePolls: 5,
        nowMs: now,
      });
      expect(next.pollingMode).toBe('active');
      expect(next.nextPollAt).toBe(now + 2 * 60_000);
      mode = next.pollingMode;
      idle = next.consecutiveIdlePolls;
    }
    const fifth = nextTieredPollingState({
      currentMode: mode,
      consecutiveIdlePolls: idle,
      hasNewActivity: false,
      activePollMinutes: 2,
      semiActivePollMinutes: 10,
      semiActiveAfterIdlePolls: 5,
      nowMs: now,
    });
    expect(fifth.pollingMode).toBe('semi_active');
    expect(fifth.nextPollAt).toBe(now + 10 * 60_000);

    const woken = nextTieredPollingState({
      currentMode: 'semi_active',
      consecutiveIdlePolls: 9,
      hasNewActivity: true,
      activePollMinutes: 2,
      semiActivePollMinutes: 10,
      semiActiveAfterIdlePolls: 5,
      nowMs: now,
    });
    expect(woken.pollingMode).toBe('active');
    expect(woken.consecutiveIdlePolls).toBe(0);
    expect(woken.nextPollAt).toBe(now + 2 * 60_000);
  });

  it('parses image formulas, schedule timestamps, post IDs, and Facebook SSR metrics', () => {
    expect(extractImageUrlFromCell('=IMAGE("https://i.gyazo.com/abc.png")')).toBe(
      'https://i.gyazo.com/abc.png',
    );
    expect(toSheetsImageFormula('https://i.gyazo.com/abc.png')).toBe(
      '=IMAGE("https://i.gyazo.com/abc.png")',
    );
    expect(
      extractFacebookPostIdFromUrl('https://www.facebook.com/groups/12345/posts/9988776655/'),
    ).toBe('9988776655');
    expect(parseScheduleDateTimeMs('2026-11-20', '14:35')).toBe(
      new Date(2026, 10, 20, 14, 35, 0, 0).getTime(),
    );
    expect(parseScheduleDateTimeMs('2026年11月20日', '下午 2:35')).toBe(
      new Date(2026, 10, 20, 14, 35, 0, 0).getTime(),
    );
    expect(parseScheduleDateTimeMs('2026/11/20', '上午 9:05:30')).toBe(
      new Date(2026, 10, 20, 9, 5, 30, 0).getTime(),
    );
    expect(parseScheduleDateTimeMs('46346', '0.5')).toBe(
      new Date(2026, 10, 20, 12, 0, 0, 0).getTime(),
    );
    const resCode = generateResourceCode(new Date(2026, 10, 20).getTime(), 'AB12CD');
    expect(resCode).toBe('20261120-AB12CD');
    expect(generatePostCode(resCode, 'XY99')).toBe('20261120-AB12CD-XY99');

    const metrics = parseFacebookMetricsFromHtml(
      '{"reaction_count":{"count":128},"comment_rendering_instance":{"comments":{"total_count":34}}}',
    );
    expect(metrics).toEqual({ likes: 128, comments: 34, loginOrRestricted: false });

    const blocked = parseFacebookMetricsFromHtml(
      '<form action="/login.php"><input name="email"><input name="pass"></form>',
    );
    expect(blocked.loginOrRestricted).toBe(true);
  });
});

describe('Google OAuth & SheetImageHostClient (Gyazo + Google Drive auto-fallback)', () => {
  it('imports desktop credentials.json, completes manual auth, and refreshes expired tokens', async () => {
    const db = new DatabaseSync(':memory:');
    const repo = new SqliteGoogleSheetsRepository(db);
    let tokenCall = 0;
    const mockFetch: typeof fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/token')) {
        tokenCall++;
        if (tokenCall === 1) {
          return new Response(
            JSON.stringify({
              access_token: 'access-1',
              refresh_token: 'refresh-1',
              expires_in: 1,
              scope: 'https://www.googleapis.com/auth/spreadsheets',
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ access_token: 'access-2', expires_in: 3600 }), {
          status: 200,
        });
      }
      if (u.includes('userinfo')) {
        return new Response(JSON.stringify({ email: 'ops@example.com' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const parsed = parseGoogleCredentialsJson(
      JSON.stringify({
        installed: {
          client_id: 'cid-1234567890.apps.googleusercontent.com',
          client_secret: 'sec-1',
        },
      }),
    );
    expect(parsed.clientId).toContain('cid-1234567890');

    const oauth = new GoogleOAuthManager(repo, mockFetch);
    await oauth.importCredentialsJson(
      JSON.stringify({
        installed: {
          client_id: 'cid-1234567890.apps.googleusercontent.com',
          client_secret: 'sec-1',
        },
      }),
    );
    const started = await oauth.startAuthSession();
    expect(started.authUrl).toContain('access_type=offline');
    expect(started.authUrl).toContain('drive.file');

    const completed = await oauth.completeManualAuth(
      'http://127.0.0.1:43210/oauth2/callback?code=manual-code-123',
    );
    expect(completed.authorized).toBe(true);
    expect(completed.authorizedEmail).toBe('ops@example.com');

    // Access token has short expiry -> must auto-refresh to access-2
    const freshToken = await oauth.getValidAccessToken();
    expect(freshToken).toBe('access-2');
    await oauth.shutdown();
    db.close();
  });

  it('uses Gyazo when token is configured, falls back to Drive when empty, and deduplicates via SHA-256 cache', async () => {
    const db = new DatabaseSync(':memory:');
    const repo = new SqliteGoogleSheetsRepository(db);
    const oauthStub = {
      getValidAccessToken: vi.fn(async () => 'drive-access-token'),
    } as unknown as GoogleOAuthPort;

    const tinyPngDataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    let gyazoUploads = 0;
    let driveUploads = 0;
    const mockFetch: typeof fetch = vi.fn(async (url, init) => {
      const u = String(url);
      if (u.includes('upload.gyazo.com')) {
        gyazoUploads++;
        return new Response(JSON.stringify({ url: 'https://i.gyazo.com/hash1.png' }), {
          status: 200,
        });
      }
      if (u.includes('drive/v3/files?q=')) {
        return new Response(JSON.stringify({ files: [{ id: 'folder-abc' }] }), { status: 200 });
      }
      if (u.includes('upload/drive/v3/files')) {
        driveUploads++;
        return new Response(JSON.stringify({ id: 'file-xyz' }), { status: 200 });
      }
      if (u.includes('/permissions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'anyoneWithLink' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const host = new SheetImageHostClient(repo, oauthStub, mockFetch);

    // 1. Default auto with NO Gyazo token -> Google Drive fallback
    const d1 = await host.uploadDataUrlOrUrl({ source: tinyPngDataUrl, filenameHint: 'g1' });
    expect(d1).toEqual({
      remoteUrl: 'https://lh3.googleusercontent.com/d/file-xyz=w400',
      host: 'drive',
      cached: false,
    });
    // Second upload of identical bytes -> instant cache hit, 0 network calls!
    const d2 = await host.uploadDataUrlOrUrl({ source: tinyPngDataUrl, filenameHint: 'g1' });
    expect(d2?.cached).toBe(true);
    expect(driveUploads).toBe(1);

    // 2. Configure Gyazo token -> auto routes to Gyazo
    repo.saveImageHostConfig({ gyazoAccessToken: 'gyazo-secret-token' });
    const g1 = await host.uploadDataUrlOrUrl({ source: tinyPngDataUrl, filenameHint: 'g2' });
    expect(g1).toEqual({
      remoteUrl: 'https://i.gyazo.com/hash1.png',
      host: 'gyazo',
      cached: false,
    });
    const g2 = await host.uploadDataUrlOrUrl({ source: tinyPngDataUrl, filenameHint: 'g2' });
    expect(g2?.cached).toBe(true);
    expect(gyazoUploads).toBe(1);
    db.close();
  });
});

describe('GoogleSheetsService end-to-end orchestration (M1–M4)', () => {
  it('runs schedule publish (timeline + category groups), writes back to records, bumps with machine column, and scrapes 24h metrics', async () => {
    const db = new DatabaseSync(':memory:');
    const repo = new SqliteGoogleSheetsRepository(db);

    // Virtual spreadsheet store for testing real multi-tab reads & writes
    const sheetsData: Record<string, string[][]> = {
      '排贴-专页1': [
        [
          '发帖专页',
          '发帖日期',
          '发帖时间',
          '发帖文案',
          '发帖素材',
          '开启AI声明',
          '是否发时间线',
          '发多少小组',
          '缩略图',
          '资源编号',
          '发布状态',
          '已发小组数量',
        ],
        [
          '(填id)',
          '',
          '',
          '',
          '(填网盘链接)',
          '(是/否）',
          '(是/否）',
          '(填数字随机发)',
          '(软件生成)',
          '(日期-素材随机码)',
          '(软件负责填)',
          '',
        ],
        [
          '999000111222',
          '2026-11-18',
          '08:00',
          'Peace be with you',
          'https://drive.google.com/file/d/abc/view',
          '是',
          '是',
          '经文群:2',
          '',
          '',
          '',
          '',
        ],
      ],
      发帖记录: [
        [
          '发帖日期',
          '小组id',
          '小组名字',
          '专页id',
          '专页名字',
          '贴文链接',
          '小组头像',
          '专页头像',
          '贴文编号',
          '缩略图',
          '点赞',
          '留言',
        ],
      ],
    };

    const sheetsApi: GoogleSheetsApiPort = {
      getSpreadsheetMeta: async (spreadsheetId) => ({
        spreadsheetId,
        title: '工作台测试表',
        url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
        tabs: [
          { sheetId: 101, title: '排贴-专页1', rowCount: 100, columnCount: 20 },
          { sheetId: 102, title: '发帖记录', rowCount: 100, columnCount: 20 },
        ],
      }),
      readSheetValues: async (_sid, sheetName) => {
        const rows = (sheetsData[sheetName] ?? []).map((r) => [...r]);
        return { formulaRows: rows, formattedRows: rows };
      },
      batchUpdateCells: async (_sid, sheetName, updates) => {
        const rows = sheetsData[sheetName] ?? [];
        for (const u of updates) {
          while (rows.length < u.rowNumber) rows.push([]);
          const targetRow = rows[u.rowNumber - 1];
          if (!targetRow) continue;
          while (targetRow.length <= u.colIndex) targetRow.push('');
          targetRow[u.colIndex] = u.value;
        }
      },
      appendRows: async (_sid, sheetName, newRows) => {
        const rows = sheetsData[sheetName] ?? [];
        for (const r of newRows)
          rows.push(r.map((c) => (c === null ? '__PRESERVED_FORMULA__' : c)));
        sheetsData[sheetName] = rows;
      },
      deleteRowsDescending: async () => {},
      ensureHeaderColumn: async (_sid, sheetName, headers, title) => {
        const idx = headers.findIndex((h) => h.trim() === title.trim());
        if (idx >= 0) return idx;
        const rows = sheetsData[sheetName] ?? [[]];
        const headerRow = rows[0] ?? [];
        const targetIdx = headerRow.length;
        headerRow[targetIdx] = title;
        rows[0] = headerRow;
        return targetIdx;
      },
    };

    const oauth: GoogleOAuthPort = {
      status: async (): Promise<GoogleAuthStatus> => ({
        hasCredentials: true,
        clientIdHint: 'cid',
        authorized: true,
        authorizedEmail: 'ops@example.com',
        scopes: [],
        pendingAuthUrl: null,
        pendingAuthStartedAt: null,
        lastError: null,
      }),
      importCredentialsJson: async () => {
        throw new Error('unused');
      },
      startAuthSession: async () => {
        throw new Error('unused');
      },
      completeManualAuth: async () => {
        throw new Error('unused');
      },
      revokeAuth: async () => {
        throw new Error('unused');
      },
      getValidAccessToken: async () => 'tok',
      shutdown: async () => {},
    };

    const imageHost: SheetImageHostPort = {
      uploadDataUrlOrUrl: vi.fn(async () => ({
        remoteUrl: 'https://i.gyazo.com/shared-thumb.png',
        host: 'gyazo' as const,
        cached: false,
      })),
      testUpload: async () => ({
        remoteUrl: 'https://i.gyazo.com/test.png',
        host: 'gyazo' as const,
      }),
    };

    const workspace = {
      repository: {
        targetFolders: async () => [
          {
            id: 'f-scripture',
            listKind: 'shared_groups',
            name: '经文群',
            sortOrder: 0,
            createdAt: 0,
          },
        ],
        targetListCommand: async () => {},
      },
      snapshot: async () => ({
        schemaVersion: 1,
        groups: [{ id: 'grp-bumper', name: '顶贴1组', color: 'blue', sortOrder: 0 }],
        combinations: [],
        records: [],
        support: { comboExecution: false, accountIdentity: false, reason: '' },
        profiles: [
          {
            id: 'prof-page-1',
            alias: '专页发帖号1',
            browserName: '专页发帖号1',
            groupId: null,
            order: 0,
            online: true,
            phase: 'READY',
            synced: true,
            unresolved: 0,
            extensionVersion: '0.3.84',
            capabilities: [],
            presentation: null,
            account: { state: 'logged-in', id: '999000111222', name: 'Grace Page', avatar: null },
          },
          {
            id: 'prof-bump-1',
            alias: '顶贴号1',
            browserName: '顶贴号1',
            groupId: 'grp-bumper',
            order: 1,
            online: true,
            phase: 'READY',
            synced: true,
            unresolved: 0,
            extensionVersion: '0.3.84',
            capabilities: [],
            presentation: null,
            account: { state: 'logged-in', id: '100011112222', name: 'Bumper One', avatar: null },
          },
        ],
      }),
    } as unknown as WorkspaceService;

    const groupBumper = {
      state: async () => ({
        groups: [
          {
            id: '11111111',
            name: '经文A群',
            avatarUrl: null,
            folderId: 'f-scripture',
            sortOrder: 0,
            totalBumpedCount: 0,
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: '22222222',
            name: '经文B群',
            avatarUrl: null,
            folderId: 'f-scripture',
            sortOrder: 1,
            totalBumpedCount: 0,
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: '33333333',
            name: '非经文群',
            avatarUrl: null,
            folderId: null,
            sortOrder: 2,
            totalBumpedCount: 0,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        pages: [
          {
            id: '999000111222',
            name: 'Grace Page',
            avatarUrl: null,
            folderId: null,
            sortOrder: 0,
            totalBumpedCount: 0,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      }),
      manage: vi.fn(async () => ({})),
    } as unknown as GroupBumperService;

    const publishedTargetIds: string[] = [];
    const automation: SheetAutomationBridgePort = {
      prepareMaterialMedia: async () => ({
        localFilePath: 'C:/tmp/video.mp4',
        mediaKind: 'video',
        thumbnailDataUrl: 'data:image/png;base64,AAAA',
      }),
      publishScheduledMaterial: async (inp) => {
        let count = 0;
        let timeline = false;
        for (const t of inp.targets) {
          publishedTargetIds.push(t.id);
          const isTimeline = t.id === PAGE_TIMELINE_SYNTHETIC_GROUP_ID;
          if (isTimeline) timeline = true;
          else count++;
          await inp.onPosted(
            {
              id: `log-${t.id}`,
              profileId: inp.profileId,
              accountId: '999000111222',
              accountName: 'Grace Page',
              accountAvatar: null,
              identityType: 'page',
              groupId: isTimeline ? '999000111222' : t.id,
              groupName: t.name,
              groupAvatar: null,
              materialId: inp.material.id,
              captionPreview: inp.material.caption,
              postId: `888000${count}`,
              postUrl: isTimeline
                ? `https://www.facebook.com/999000111222/posts/888000${count}/`
                : `https://www.facebook.com/groups/${t.id}/posts/888000${count}/`,
              postedAt: Date.UTC(2026, 10, 18, 8, 5, 0),
            },
            isTimeline,
          );
        }
        return { postedCount: count, timelinePosted: timeline };
      },
      bumpDirectPosts: async (inp) => {
        const res = [];
        for (const p of inp.posts) {
          const item = {
            postCode: p.postCode,
            postUrl: p.postUrl,
            bumped: true,
            liked: true,
            commented: false,
          };
          res.push(item);
          await inp.onPostBumped(item);
        }
        return res;
      },
      scrapePostMetrics: async (inp) =>
        inp.posts.map((p) => ({
          postCode: p.postCode,
          postUrl: p.postUrl,
          likes: 42,
          comments: 9,
        })),
    };

    const nowMs = Date.UTC(2026, 10, 20, 10, 0, 0);
    const service = new GoogleSheetsService(repo, {
      workspace,
      groupBumper,
      oauth,
      sheetsApi,
      imageHost,
      automation,
      now: () => nowMs,
    });

    const recLink = await service.createLink({
      kind: 'post_records',
      spreadsheetUrlOrId: '1CpXEEOO9X4S8TJhIlImzVQFnVCXLgv7Nk1eU6D0SI3U',
      sheetName: '发帖记录',
      recordsConfig: {
        enabled: true,
        machineName: '电脑1号',
        bumperProfileGroupIds: ['grp-bumper'],
        collectMetricsOnThisPc: true,
        bumperSettings: { maxPostAgeHours: 120 },
      },
    });
    const schedLink = await service.createLink({
      kind: 'post_schedule',
      spreadsheetUrlOrId: '1CpXEEOO9X4S8TJhIlImzVQFnVCXLgv7Nk1eU6D0SI3U',
      sheetName: '排贴-专页1',
      scheduleConfig: {
        enabled: true,
        targetRecordLinkId: recLink.id,
        autoWakeBumper: false,
      },
    });

    // 1. Execute schedule poll -> should post timeline + 2 groups ONLY from '经文群' (never 33333333!)
    await service.triggerSchedulePoll(schedLink.id);
    expect(publishedTargetIds[0]).toBe(PAGE_TIMELINE_SYNTHETIC_GROUP_ID);
    expect(publishedTargetIds.slice(1).sort()).toEqual(['11111111', '22222222']);
    expect(imageHost.uploadDataUrlOrUrl).toHaveBeenCalledTimes(1); // Thumbnail uploaded ONCE and reused!

    const schedRow = sheetsData['排贴-专页1']?.[2] ?? [];
    expect(schedRow[8]).toBe('=IMAGE("https://i.gyazo.com/shared-thumb.png")');
    expect(schedRow[9]).toMatch(/^20261118-[A-Z0-9]{6}$/);
    expect(schedRow[10]).toBe('已完成');
    expect(schedRow[11]).toBe('2/2');

    // 3 rows appended to 发帖记录 (1 timeline + 2 groups); avatar formula cols 6 & 7 passed as null so formulas remain untouched!
    expect(sheetsData['发帖记录']?.length).toBe(4);
    expect(sheetsData['发帖记录']?.[1]?.[6]).toBe('__PRESERVED_FORMULA__');
    expect(sheetsData['发帖记录']?.[1]?.[7]).toBe('__PRESERVED_FORMULA__');
    expect(sheetsData['发帖记录']?.[1]?.[9]).toBe('=IMAGE("https://i.gyazo.com/shared-thumb.png")');

    // 2. Execute records poll -> auto-creates 电脑1号 column, bumps posts, writes '1' to 电脑1号, AND scrapes 24h metrics!
    await service.triggerRecordsPoll(recLink.id);
    expect(sheetsData['发帖记录']?.[0]?.[12]).toBe('电脑1号');
    expect(sheetsData['发帖记录']?.[1]?.[12]).toBe('1');
    expect(sheetsData['发帖记录']?.[1]?.[10]).toBe('42');
    expect(sheetsData['发帖记录']?.[1]?.[11]).toBe('9');

    db.close();
  });

  it('awaits async isProfileBusy, emits reorder-items on import, recovers stale running state, and caps concurrent maxLikesPerPost', async () => {
    const db = new DatabaseSync(':memory:');
    const repo = new SqliteGoogleSheetsRepository(db);

    // 1) Startup recovery of stale 'running' schedule items & activeJobText + bumpedProfileIds union
    const staleLink = repo.createLink({
      kind: 'post_schedule',
      title: '排贴恢复测试',
      spreadsheetId: 'sheet-rec-1',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-rec-1/edit',
      spreadsheetTitle: 'Book',
      sheetId: 1,
      sheetName: 'Schedule',
    });
    repo.updateLinkRuntime(staleLink.id, { activeJobText: '崩溃前未完成' });
    repo.upsertScheduleItem({
      linkId: staleLink.id,
      resourceCode: '20261120-STALE1',
      pageId: '999',
      scheduledAt: 1000,
      caption: 'hi',
      mediaSource: '',
      aiLabel: 'default',
      postTimeline: false,
      groupsSpec: '1',
      thumbnailUrl: null,
      status: 'running',
      timelinePosted: false,
      postedGroupIds: [],
      targetGroupCount: 1,
      postedGroupCount: 0,
      errorMessage: null,
      updatedAt: 1000,
    });
    const recDbLink = repo.createLink({
      kind: 'post_records',
      title: '顶贴并发测试',
      spreadsheetId: 'sheet-rec-1',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-rec-1/edit',
      spreadsheetTitle: 'Book',
      sheetId: 2,
      sheetName: 'Records',
      recordsConfig: {
        enabled: true,
        machineName: '电脑1号',
        bumperProfileGroupIds: ['grp-bumper'],
        bumperSettings: { maxLikesPerPost: 1, maxPostAgeHours: 120 },
      },
    });
    repo.upsertRecordPost({
      linkId: recDbLink.id,
      postCode: 'POST-UNION',
      resourceCode: 'RES-1',
      postedAtText: '2026-11-20 08:00',
      postedAtMs: Date.UTC(2026, 10, 20, 8, 0, 0),
      groupId: 'g1',
      groupName: 'G1',
      pageId: 'p1',
      pageName: 'P1',
      postUrl: 'https://www.facebook.com/groups/g1/posts/100/',
      postId: '100',
      thumbnailUrl: null,
      likesCount: null,
      commentsCount: null,
      metricsStage: 0,
      metricsUpdatedAt: null,
      localBumpedCount: 1,
      bumpedProfileIds: ['prof-a'],
      createdAt: 1000,
      updatedAt: 1000,
    });
    // Concurrent overwrite passing empty bumpedProfileIds must union instead of wiping 'prof-a'
    const merged = repo.upsertRecordPost({
      linkId: recDbLink.id,
      postCode: 'POST-UNION',
      resourceCode: 'RES-1',
      postedAtText: '2026-11-20 08:00',
      postedAtMs: Date.UTC(2026, 10, 20, 8, 0, 0),
      groupId: 'g1',
      groupName: 'G1',
      pageId: 'p1',
      pageName: 'P1',
      postUrl: 'https://www.facebook.com/groups/g1/posts/100/',
      postId: '100',
      thumbnailUrl: null,
      likesCount: 5,
      commentsCount: 2,
      metricsStage: 1,
      metricsUpdatedAt: 2000,
      localBumpedCount: 0,
      bumpedProfileIds: ['prof-b'],
      createdAt: 1000,
      updatedAt: 2000,
    });
    expect(merged.bumpedProfileIds.sort()).toEqual(['prof-a', 'prof-b']);

    // Re-open store on same DB -> stale 'running' item with 0 posted recovers to 'pending' & activeJobText cleared
    const recoveredRepo = new SqliteGoogleSheetsRepository(db);
    const recoveredLink = recoveredRepo.getLink(staleLink.id);
    expect(recoveredLink?.runtime.activeJobText).toBe('');
    const recoveredItem = recoveredRepo.getScheduleItem(staleLink.id, '20261120-STALE1');
    expect(recoveredItem?.status).toBe('pending');

    // 2) Verify P0-1 (awaited async isProfileBusy), P0-2 ('reorder-items'), and maxLikesPerPost=1 concurrent slot cap
    const targetListCommands: unknown[] = [];
    const bumpedByProfile: Record<string, string[]> = {};
    const groupLibLink = recoveredRepo.createLink({
      kind: 'group_library',
      title: '小组库',
      spreadsheetId: 'sheet-rec-1',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-rec-1/edit',
      spreadsheetTitle: 'Book',
      sheetId: 3,
      sheetName: 'Groups',
    });

    const sheetsApi: GoogleSheetsApiPort = {
      getSpreadsheetMetadata: async () => ({
        spreadsheetId: 'sheet-rec-1',
        title: 'Book',
        sheets: [
          { sheetId: 2, title: 'Records', rowCount: 100, colCount: 20 },
          { sheetId: 3, title: 'Groups', rowCount: 100, colCount: 10 },
        ],
      }),
      readSheetValues: async (_sid, sheetName) => {
        if (sheetName === 'Groups') {
          const rows = [
            ['类别', '小组ID', '小组名字', '头像'],
            ['经文群', '555666777', '经文测试群', ''],
          ];
          return { formattedRows: rows, formulaRows: rows };
        }
        const rows = [
          [
            '发帖日期',
            '小组ID',
            '小组名字',
            '专页ID',
            '专页名字',
            '贴文链接',
            '小组头像',
            '专页头像',
            '贴文编号',
            '贴文缩略图',
            '点赞数',
            '留言数',
            '电脑1号',
          ],
          [
            '2026-11-20 09:00',
            'g1',
            'G1',
            'p1',
            'P1',
            'https://www.facebook.com/groups/g1/posts/999/',
            '',
            '',
            'POST-CAP-1',
            '',
            '',
            '',
            '',
          ],
        ];
        return { formattedRows: rows, formulaRows: rows };
      },
      readHeaderRow: async () => [],
      ensureHeaderColumn: async () => 12,
      writeCells: async () => {},
      deleteRows: async () => {},
      writeRangeValues: async () => {},
      batchUpdateCells: async () => {},
      appendRows: async () => 2,
      clearAndWriteSheet: async () => {},
    };

    const workspace = {
      repository: {
        targetFolders: async () => [
          { id: 'f-1', listKind: 'shared_groups', name: '经文群', sortOrder: 0, createdAt: 0 },
        ],
        targetListCommand: async (cmd: unknown) => {
          targetListCommands.push(cmd);
        },
      },
      snapshot: async () => ({
        schemaVersion: 1,
        groups: [{ id: 'grp-bumper', name: '顶贴1组', color: 'blue', sortOrder: 0 }],
        combinations: [],
        records: [],
        support: { comboExecution: false, accountIdentity: false, reason: '' },
        profiles: [
          {
            id: 'prof-busy',
            alias: '忙碌号',
            browserName: '忙碌号',
            groupId: 'grp-bumper',
            order: 0,
            online: true,
            phase: 'READY',
            synced: true,
            unresolved: 0,
            extensionVersion: '0.3.84',
            capabilities: [],
            presentation: null,
            account: { state: 'logged-in', id: '10001', name: 'Busy', avatar: null },
          },
          {
            id: 'prof-free-1',
            alias: '空闲号1',
            browserName: '空闲号1',
            groupId: 'grp-bumper',
            order: 1,
            online: true,
            phase: 'READY',
            synced: true,
            unresolved: 0,
            extensionVersion: '0.3.84',
            capabilities: [],
            presentation: null,
            account: { state: 'logged-in', id: '10002', name: 'Free1', avatar: null },
          },
          {
            id: 'prof-free-2',
            alias: '空闲号2',
            browserName: '空闲号2',
            groupId: 'grp-bumper',
            order: 2,
            online: true,
            phase: 'READY',
            synced: true,
            unresolved: 0,
            extensionVersion: '0.3.84',
            capabilities: [],
            presentation: null,
            account: { state: 'logged-in', id: '10003', name: 'Free2', avatar: null },
          },
        ],
      }),
    } as unknown as WorkspaceService;

    const groupBumper = {
      state: async () => ({ groups: [], pages: [] }),
      manage: vi.fn(async () => ({})),
    } as unknown as GroupBumperService;

    const automation: SheetAutomationBridgePort = {
      prepareMaterialMedia: async () => ({
        localFilePath: null,
        mediaKind: 'none',
        thumbnailDataUrl: null,
      }),
      publishScheduledMaterial: async () => ({ postedCount: 0, timelinePosted: false }),
      bumpDirectPosts: async (inp) => {
        bumpedByProfile[inp.profileId] = inp.posts.map((p) => p.postCode);
        const results = [];
        for (const p of inp.posts) {
          const r = {
            postCode: p.postCode,
            postUrl: p.postUrl,
            bumped: true,
            liked: true,
            commented: false,
          };
          results.push(r);
          await inp.onPostBumped(r);
        }
        return results;
      },
      scrapePostMetrics: async () => [],
    };

    const featureExecution = new FeatureExecutionRegistry();
    featureExecution.register({
      id: 'group-bumper',
      label: '小组顶贴',
      isProfileRunning: async (pid) => pid === 'prof-busy',
      hasActiveExecution: () => true,
      stopProfiles: async () => {},
    });

    const service = new GoogleSheetsService(recoveredRepo, {
      workspace,
      groupBumper,
      featureExecution,
      oauth: {
        getAccessToken: async () => 'tok',
        getStatus: async () => ({
          configured: true,
          authorized: true,
          authorizedEmail: 't@example.com',
          clientIdHint: 'x',
          pendingAuthUrl: null,
          pendingAuthExpiresAt: null,
          lastError: null,
        }),
        saveCredentialsJson: async () => ({
          configured: true,
          authorized: true,
          authorizedEmail: 't@example.com',
          clientIdHint: 'x',
          pendingAuthUrl: null,
          pendingAuthExpiresAt: null,
          lastError: null,
        }),
        beginAuthorization: async () => ({ authUrl: 'https://x', expiresAt: 0 }),
        completeAuthorizationByCode: async () => ({
          configured: true,
          authorized: true,
          authorizedEmail: 't@example.com',
          clientIdHint: 'x',
          pendingAuthUrl: null,
          pendingAuthExpiresAt: null,
          lastError: null,
        }),
        revokeAuthorization: async () => {},
      },
      sheetsApi,
      imageHost: {
        getConfig: () => ({ mode: 'drive_only', gyazoConfigured: false, driveFolderId: null }),
        saveConfig: () => ({ mode: 'drive_only', gyazoConfigured: false, driveFolderId: null }),
        uploadDataUrlOrUrl: async () => ({ remoteUrl: 'https://img/a.png', host: 'drive' }),
      },
      automation,
      now: () => Date.UTC(2026, 10, 20, 10, 0, 0),
    });

    // P0-2 check: import group library must use 'reorder-items' (never 'move-items')
    await service.importLibraryFromSheet(groupLibLink.id, 'incremental');
    expect(targetListCommands).toEqual([
      expect.objectContaining({
        action: 'reorder-items',
        listKind: 'shared_groups',
        folderId: 'f-1',
        orderedItemIds: ['555666777'],
      }),
    ]);

    // P0-1 & concurrent slot cap check:
    // - prof-busy returns Promise<{busy:true}> -> must be skipped!
    // - prof-free-1 and prof-free-2 are both free, but maxLikesPerPost = 1 -> only ONE gets POST-CAP-1!
    await service.triggerRecordsPoll(recDbLink.id);
    expect(bumpedByProfile['prof-busy']).toBeUndefined();
    const totalCap1Assigned = Object.values(bumpedByProfile)
      .flat()
      .filter((code) => code === 'POST-CAP-1').length;
    expect(totalCap1Assigned).toBe(1);

    db.close();
  });

  it('exposes live activeProfiles with real-time status in overview() and cancels via stopProfiles()', async () => {
    const db = new DatabaseSync(':memory:');
    const repo = new SqliteGoogleSheetsRepository(db);
    const recLink = repo.createLink({
      kind: 'post_records',
      title: '实况顶贴表',
      spreadsheetId: 'sheet-live-1',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-live-1/edit',
      spreadsheetTitle: 'Book',
      sheetId: 2,
      sheetName: 'Records',
      recordsConfig: {
        enabled: true,
        machineName: '电脑1号',
        bumperProfileGroupIds: ['grp-live'],
        bumperSettings: { maxLikesPerPost: 2, maxPostAgeHours: 120 },
      },
    });

    const recordRows = [
      ['发帖日期', '小组id', '小组名字', '专页id', '专页名字', '贴文链接', '贴文编号', '电脑1号'],
      [
        '2026-11-20 09:00',
        '111',
        'G1',
        '222',
        'P1',
        'https://www.facebook.com/groups/111/posts/999/',
        'POST-LIVE-1',
        '',
      ],
    ];

    let releaseBump: (() => void) | null = null;
    const bumpEntered = new Promise<void>((resolve) => {
      releaseBump = resolve;
    });
    let allowFinish: (() => void) | null = null;
    const finishGate = new Promise<void>((resolve) => {
      allowFinish = resolve;
    });
    let observedCancelledAfterStop = false;

    const service = new GoogleSheetsService(repo, {
      workspace: {
        snapshot: async () => ({
          groups: [{ id: 'grp-live', name: '顶贴组', order: 0 }],
          profiles: [
            {
              id: 'prof-live-1',
              alias: '顶贴1号',
              browserName: 'Chrome 1',
              groupId: 'grp-live',
              order: 0,
              online: true,
              phase: 'READY',
              synced: true,
              unresolved: 0,
              extensionVersion: '0.3.84',
              capabilities: [],
              presentation: null,
              account: { state: 'logged-in', id: 'u-live', name: 'Live User', avatar: null },
            },
          ],
          combinations: [],
        }),
      } as unknown as WorkspaceService,
      groupBumper: {
        state: async () => ({ groups: [], pages: [], settings: {} }),
      } as unknown as GroupBumperService,
      oauth: {
        status: async () => ({
          hasCredentials: true,
          clientIdHint: 'client',
          authorized: true,
          authorizedEmail: 'ops@example.com',
          scopes: [],
          pendingAuthUrl: null,
          pendingAuthStartedAt: null,
          lastError: null,
        }),
        importCredentialsJson: async () => {
          throw new Error('unused');
        },
        startAuthSession: async () => {
          throw new Error('unused');
        },
        completeManualAuth: async () => {
          throw new Error('unused');
        },
        revokeAuth: async () => {
          throw new Error('unused');
        },
        getValidAccessToken: async () => 'tok',
        shutdown: async () => {},
      },
      sheetsApi: {
        getSpreadsheetMeta: async () => {
          throw new Error('unused');
        },
        readSheetValues: async () => ({
          formulaRows: recordRows,
          formattedRows: recordRows,
        }),
        batchUpdateCells: async () => {},
        appendRows: async () => {},
        deleteRowsDescending: async () => {},
        ensureHeaderColumn: async () => 7,
      },
      imageHost: {
        uploadDataUrlOrUrl: async () => ({
          remoteUrl: 'https://img/x.png',
          host: 'drive',
          cached: false,
        }),
        testUpload: async () => ({ remoteUrl: 'https://img/x.png', host: 'drive' }),
      },
      automation: {
        prepareMaterialMedia: async () => ({
          localFilePath: 'tmp.png',
          mediaKind: 'image',
          thumbnailDataUrl: null,
        }),
        publishScheduledMaterial: async () => ({
          postedCount: 0,
          timelinePosted: false,
          error: undefined,
        }),
        bumpDirectPosts: async (inp) => {
          inp.onStatus('正在打开贴文 (1/1)');
          releaseBump?.();
          await finishGate;
          observedCancelledAfterStop = inp.cancelled();
          return [];
        },
        scrapePostMetrics: async () => [],
      },
      now: () => Date.UTC(2026, 10, 20, 10, 0, 0),
    });

    const pollPromise = service.triggerRecordsPoll(recLink.id);
    await bumpEntered;

    const midOverview = await service.overview();
    expect(midOverview.activeProfiles).toEqual([
      {
        profileId: 'prof-live-1',
        linkId: recLink.id,
        kind: 'post_records',
        title: '实况顶贴表',
        status: '正在打开贴文 (1/1)',
      },
    ]);

    await service.stopProfiles(['prof-live-1']);
    allowFinish?.();
    await pollPromise;

    expect(observedCancelledAfterStop).toBe(true);
    const endOverview = await service.overview();
    expect(endOverview.activeProfiles).toEqual([]);
    db.close();
  });

  it('routes post_schedule rows to BlueStacks (bluestacks & auto fallback), writes back 发帖记录, and wakes bumper sheet', async () => {
    const db = new DatabaseSync(':memory:');
    const repo = new SqliteGoogleSheetsRepository(db);

    const bsId = '11111111-1111-4111-8111-111111111111';
    const schedRows: string[][] = [
      [
        '发帖专页',
        '发帖日期',
        '发帖时间',
        '发帖文案',
        '发帖素材',
        '是否发时间线',
        '发多少小组',
        '缩略图',
        '资源编号',
        '发布状态',
        '已发小组数量',
      ],
      [
        '61580000111222',
        '2026-11-20',
        '08:00',
        'BlueStacks Cloud Sheet Post',
        'https://drive.google.com/file/d/abc/view',
        '是',
        '99887766',
        '',
        '',
        '',
        '',
      ],
    ];
    const recordRows: string[][] = [
      ['发帖日期', '小组ID', '小组名字', '专页ID', '专页名字', '贴文链接', '贴文编号'],
    ];

    const sheetStore: Record<string, string[][]> = {
      蓝蝶排贴: schedRows,
      蓝蝶记录: recordRows,
    };

    const bsCalls: Array<{
      instanceId: string;
      targetPageId?: string;
      targetPageName?: string;
      closeOnFinish?: boolean;
      targetIds: string[];
    }> = [];

    const service = new GoogleSheetsService(repo, {
      workspace: {
        snapshot: async () => ({ profiles: [], groups: [] }),
        repository: { targetFolders: async () => [] },
      } as unknown as WorkspaceService,
      groupBumper: {
        state: async () => ({
          groups: [
            {
              id: '99887766',
              name: 'Grace Group',
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
              id: '61580000111222',
              name: 'Thu',
              avatarUrl: null,
              folderId: null,
              sortOrder: 0,
              totalBumpedCount: 0,
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        }),
      } as unknown as GroupBumperService,
      bluestacks: {
        state: async () => ({
          instances: [
            {
              id: bsId,
              instanceKey: 'Pie64_1',
              displayName: 'p023',
              alias: null,
              folderId: null,
              sortOrder: 0,
              adbPort: 5565,
              serial: '127.0.0.1:5565',
              fbWidth: 900,
              fbHeight: 1600,
              online: false,
              fbLiteInstalled: true,
              accountState: 'logged-in',
              accountId: 'p023',
              accountName: 'Mawi Lee',
              numericAccountId: '61591261366732',
              identityType: 'personal',
              managedIdentities: [
                { name: 'Mawi Lee', identityType: 'personal', active: true },
                { name: 'Thu', identityType: 'page', active: false },
              ],
              avatarUrl: null,
              lastStatus: null,
              updatedAt: Date.now(),
            },
          ],
        }),
        runDirectPosterForSheet: async (inp: {
          instanceId: string;
          targetPageId?: string;
          targetPageName?: string;
          targets: Array<{ id: string; name: string }>;
          closeOnFinish?: boolean;
          onStatus?: (t: string) => void;
          onPosted?: (log: PosterLog, isTimeline: boolean) => Promise<void>;
        }) => {
          bsCalls.push({
            instanceId: inp.instanceId,
            targetPageId: inp.targetPageId,
            targetPageName: inp.targetPageName,
            closeOnFinish: inp.closeOnFinish,
            targetIds: inp.targets.map((t) => t.id),
          });
          inp.onStatus?.('正在发布时间线与小组…');
          for (const t of inp.targets) {
            const isTl = t.id === PAGE_TIMELINE_SYNTHETIC_GROUP_ID;
            await inp.onPosted?.(
              {
                id: randomUUID(),
                profileId: inp.instanceId,
                accountId: '61580000111222',
                accountName: 'Thu',
                accountAvatar: null,
                identityType: 'page',
                groupId: t.id,
                groupName: t.name,
                groupAvatar: null,
                materialId: 'mat',
                captionPreview: 'BlueStacks Cloud Sheet Post',
                postId: isTl ? '70001' : '70002',
                postUrl: isTl
                  ? 'https://www.facebook.com/61580000111222'
                  : 'https://www.facebook.com/groups/99887766/',
                postedAt: Date.UTC(2026, 10, 20, 8, 5, 0),
              },
              isTl,
            );
          }
          return { postedCount: 1, timelinePosted: true };
        },
      } as unknown as import('../src/application/bluestacks-service.js').BluestacksService,
      oauth: {
        status: async () => ({
          hasCredentials: true,
          clientIdHint: 'cid',
          authorized: true,
          authorizedEmail: 'ops@example.com',
          scopes: [],
          pendingAuthUrl: null,
          pendingAuthStartedAt: null,
          lastError: null,
        }),
        importCredentialsJson: async () => {
          throw new Error('unused');
        },
        startAuthSession: async () => {
          throw new Error('unused');
        },
        completeManualAuth: async () => {
          throw new Error('unused');
        },
        revokeAuth: async () => {
          throw new Error('unused');
        },
        getValidAccessToken: async () => 'tok',
        shutdown: async () => {},
      },
      sheetsApi: {
        getSpreadsheetMeta: async (id) => ({
          spreadsheetId: id,
          title: 'BS Book',
          url: `https://docs.google.com/spreadsheets/d/${id}/edit`,
          tabs: [
            { sheetId: 1, title: '蓝蝶排贴', rowCount: 100, columnCount: 20 },
            { sheetId: 2, title: '蓝蝶记录', rowCount: 100, columnCount: 20 },
          ],
        }),
        readSheetValues: async (_id, name) => ({
          formulaRows: (sheetStore[name] ?? []).map((r) => [...r]),
          formattedRows: (sheetStore[name] ?? []).map((r) => [...r]),
        }),
        batchUpdateCells: async (_id, name, updates) => {
          const rows = sheetStore[name] ?? [];
          for (const u of updates) {
            while (rows.length < u.rowNumber) rows.push([]);
            const row = rows[u.rowNumber - 1];
            if (!row) continue;
            while (row.length <= u.colIndex) row.push('');
            row[u.colIndex] = u.value;
          }
        },
        appendRows: async (_id, name, rows) => {
          const dest = sheetStore[name] ?? [];
          for (const r of rows) dest.push(r.map((c) => c ?? ''));
          sheetStore[name] = dest;
        },
        deleteRowsDescending: async () => {},
        ensureHeaderColumn: async () => 7,
      },
      imageHost: {
        uploadDataUrlOrUrl: async () => ({
          remoteUrl: 'https://i.gyazo.com/bs-thumb.png',
          host: 'gyazo',
          cached: false,
        }),
        testUpload: async () => ({ remoteUrl: 'https://i.gyazo.com/bs-thumb.png', host: 'gyazo' }),
      },
      automation: {
        prepareMaterialMedia: async () => ({
          localFilePath: 'D:/cache/media.jpg',
          mediaKind: 'image',
          thumbnailDataUrl: 'data:image/png;base64,AA==',
        }),
        publishScheduledMaterial: async () => {
          throw new Error('browser path must NOT be called when no browser matches!');
        },
        bumpDirectPosts: async () => [],
        scrapePostMetrics: async () => [],
      },
      now: () => Date.UTC(2026, 10, 20, 9, 0, 0),
    });

    const recLink = await service.createLink({
      kind: 'post_records',
      spreadsheetUrlOrId: '1CpXEEOO9X4S8TJhIlImzVQFnVCXLgv7Nk1eU6D0SI3U',
      sheetName: '蓝蝶记录',
      recordsConfig: { enabled: false, machineName: '电脑1号' },
    });
    const schedLink = await service.createLink({
      kind: 'post_schedule',
      spreadsheetUrlOrId: '1CpXEEOO9X4S8TJhIlImzVQFnVCXLgv7Nk1eU6D0SI3U',
      sheetName: '蓝蝶排贴',
      scheduleConfig: {
        enabled: true,
        targetRecordLinkId: recLink.id,
        autoWakeBumper: true,
        executionCarrier: 'auto', // No Chrome profile -> auto-fallback to BlueStacks matching managed Page 'Thu'!
        closeBluestacksOnFinish: true,
      },
    });

    await service.triggerSchedulePoll(schedLink.id);

    expect(bsCalls.length).toBe(1);
    expect(bsCalls[0]?.instanceId).toBe(bsId);
    expect(bsCalls[0]?.targetPageId).toBe('61580000111222');
    expect(bsCalls[0]?.targetPageName).toBe('Thu');
    expect(bsCalls[0]?.closeOnFinish).toBe(true);
    expect(bsCalls[0]?.targetIds).toEqual([PAGE_TIMELINE_SYNTHETIC_GROUP_ID, '99887766']);

    // Verify 排贴表 status & count updated cleanly
    const updatedSchedRow = sheetStore['蓝蝶排贴']?.[1] ?? [];
    expect(updatedSchedRow[9]).toBe('已完成');
    expect(updatedSchedRow[10]).toBe('1/1');

    // Verify 发帖记录 received BOTH timeline + group post rows!
    expect(sheetStore['蓝蝶记录']?.length).toBe(3);
    expect(sheetStore['蓝蝶记录']?.[1]?.[4]).toBe('Thu');
    expect(sheetStore['蓝蝶记录']?.[2]?.[1]).toBe('99887766');

    // Verify bound bumper sheet was woken into 'active' mode!
    const refreshedRec = repo.getLink(recLink.id);
    expect(refreshedRec?.runtime.pollingMode).toBe('active');
    db.close();
  });

  it('parses multi-Gyazo tokens, round-robins across healthy tokens, fails over on 401/429, and falls back to Drive in auto mode', async () => {
    expect(parseGyazoTokenList(' tok_aaa \n tok_bbb , tok_aaa ; tok_ccc ')).toEqual([
      'tok_aaa',
      'tok_bbb',
      'tok_ccc',
    ]);
    expect(
      resolveEffectiveGyazoTokens({
        gyazoAccessToken: 'legacy_single_token_1234',
        gyazoAccessTokens: [],
      }),
    ).toEqual(['legacy_single_token_1234']);
    expect(maskGyazoToken('abcd123456wxyz')).toBe('abcd••••wxyz');

    const db = new DatabaseSync(':memory:');
    const repo = new SqliteGoogleSheetsRepository(db);
    const oauthStub = {
      status: vi.fn(async () => ({
        hasCredentials: true,
        clientIdHint: 'cid',
        authorized: true,
        authorizedEmail: 'ops@example.com',
        scopes: [],
        pendingAuthUrl: null,
        pendingAuthStartedAt: null,
        lastError: null,
      })),
      getValidAccessToken: vi.fn(async () => 'drive-access-token'),
    } as unknown as GoogleOAuthPort;

    const usedTokens: string[] = [];
    let failTokens = new Set<string>();
    const mockFetch: typeof fetch = vi.fn(async (url, init) => {
      const u = String(url);
      if (u.includes('upload.gyazo.com')) {
        const form = init?.body as FormData;
        const tok = String(form.get('access_token') ?? '');
        usedTokens.push(tok);
        if (failTokens.has(tok)) {
          return new Response(JSON.stringify({ message: 'Invalid access token' }), { status: 401 });
        }
        return new Response(JSON.stringify({ url: `https://i.gyazo.com/${tok}.png` }), {
          status: 200,
        });
      }
      if (u.includes('drive/v3/files?q=')) {
        return new Response(JSON.stringify({ files: [{ id: 'folder-fallback' }] }), {
          status: 200,
        });
      }
      if (u.includes('upload/drive/v3/files')) {
        return new Response(JSON.stringify({ id: 'drive-file-fallback' }), { status: 200 });
      }
      if (u.includes('/permissions')) {
        return new Response(JSON.stringify({ id: 'anyone' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    repo.saveImageHostConfig({
      preferredHost: 'auto',
      gyazoAccessTokens: ['tok-1-aaaaaaaaaa', 'tok-2-bbbbbbbbbb', 'tok-3-cccccccccc'],
    });
    const host = new SheetImageHostClient(repo, oauthStub, mockFetch);

    // 1. Round-robin across all 3 tokens on consecutive test uploads
    const r1 = await host.testUpload();
    const r2 = await host.testUpload();
    const r3 = await host.testUpload();
    const r4 = await host.testUpload();
    expect([r1.tokenIndex, r2.tokenIndex, r3.tokenIndex, r4.tokenIndex]).toEqual([0, 1, 2, 0]);
    expect(usedTokens).toEqual([
      'tok-1-aaaaaaaaaa',
      'tok-2-bbbbbbbbbb',
      'tok-3-cccccccccc',
      'tok-1-aaaaaaaaaa',
    ]);

    // 2. Token #2 fails with 401 -> same upload automatically fails over to Token #3
    usedTokens.length = 0;
    failTokens = new Set(['tok-2-bbbbbbbbbb']);
    const rFailover = await host.testUpload();
    expect(rFailover.host).toBe('gyazo');
    expect(rFailover.tokenIndex).toBe(2);
    expect(rFailover.remoteUrl).toBe('https://i.gyazo.com/tok-3-cccccccccc.png');
    expect(usedTokens).toEqual(['tok-2-bbbbbbbbbb', 'tok-3-cccccccccc']);

    // 3. All Gyazo tokens fail -> in 'auto' mode with authorized OAuth, falls back to Google Drive
    usedTokens.length = 0;
    failTokens = new Set(['tok-1-aaaaaaaaaa', 'tok-2-bbbbbbbbbb', 'tok-3-cccccccccc']);
    const rDriveFallback = await host.testUpload();
    expect(rDriveFallback.host).toBe('drive');
    expect(rDriveFallback.fallbackFromGyazo).toBe(true);
    expect(rDriveFallback.remoteUrl).toBe(
      'https://lh3.googleusercontent.com/d/drive-file-fallback=w400',
    );

    // 4. In strict 'gyazo' mode when all tokens fail -> throws clear GYAZO_UPLOAD_FAILED error
    repo.saveImageHostConfig({ preferredHost: 'gyazo' });
    await expect(host.testUpload()).rejects.toThrow(/全部 3 个 Gyazo Token 均上传失败/);
    db.close();
  });

  it('prevents duplicate schedule/record sheet links, masks tokens in overview, and clears dangling record references on delete', async () => {
    const db = new DatabaseSync(':memory:');
    const repo = new SqliteGoogleSheetsRepository(db);
    const sheetsApi: GoogleSheetsApiPort = {
      getSpreadsheetMeta: async (spreadsheetId) => ({
        spreadsheetId,
        title: '模板文档',
        url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
        tabs: [
          { sheetId: 101, title: '排贴-专页1', rowCount: 100, columnCount: 20 },
          { sheetId: 102, title: '发帖记录', rowCount: 100, columnCount: 20 },
        ],
      }),
      readSheetValues: async () => ({ formulaRows: [], formattedRows: [] }),
      batchUpdateCells: async () => {},
      appendRows: async () => {},
      deleteRowsDescending: async () => {},
      ensureHeaderColumn: async () => 0,
    };
    const oauth: GoogleOAuthPort = {
      status: async () => ({
        hasCredentials: true,
        clientIdHint: 'cid',
        authorized: true,
        authorizedEmail: 'ops@example.com',
        scopes: [],
        pendingAuthUrl: null,
        pendingAuthStartedAt: null,
        lastError: null,
      }),
      importCredentialsJson: async () => {
        throw new Error('unused');
      },
      startAuthSession: async () => {
        throw new Error('unused');
      },
      completeManualAuth: async () => {
        throw new Error('unused');
      },
      revokeAuth: async () => {
        throw new Error('unused');
      },
      getValidAccessToken: async () => 'tok',
      shutdown: async () => {},
    };
    const service = new GoogleSheetsService(repo, {
      workspace: {} as unknown as WorkspaceService,
      groupBumper: {} as unknown as GroupBumperService,
      oauth,
      sheetsApi,
      imageHost: {
        uploadDataUrlOrUrl: async () => null,
        testUpload: async () => ({ remoteUrl: 'https://i.gyazo.com/x.png', host: 'gyazo' }),
      },
    });

    // Multi-token save keeps overview masked while desktop editor API returns editable tokens
    const savedStatus = await service.saveImageHostConfig({
      preferredHost: 'auto',
      defaultMachineName: '姜姜',
      gyazoAccessTokens: ['secret_token_alpha_1111', 'secret_token_beta_2222'],
    });
    expect(savedStatus.gyazoTokenCount).toBe(2);
    expect(savedStatus.gyazoTokenPreviews).toEqual(['secr••••1111', 'secr••••2222']);
    const ov = await service.overview();
    expect(JSON.stringify(ov)).not.toContain('secret_token_alpha_1111');
    expect(await service.getEditableGyazoTokens()).toEqual({
      tokens: ['secret_token_alpha_1111', 'secret_token_beta_2222'],
    });

    // Duplicate schedule sheet link rejected cleanly
    const rec = await service.createLink({
      kind: 'post_records',
      spreadsheetUrlOrId: '1CpXEEOO9X4S8TJhIlImzVQFnVCXLgv7Nk1eU6D0SI3U',
      sheetName: '发帖记录',
    });
    const sched = await service.createLink({
      kind: 'post_schedule',
      spreadsheetUrlOrId: '1CpXEEOO9X4S8TJhIlImzVQFnVCXLgv7Nk1eU6D0SI3U',
      sheetName: '排贴-专页1',
      scheduleConfig: { targetRecordLinkId: rec.id },
    });
    await expect(
      service.createLink({
        kind: 'post_schedule',
        spreadsheetUrlOrId: '1CpXEEOO9X4S8TJhIlImzVQFnVCXLgv7Nk1eU6D0SI3U',
        sheetName: '排贴-专页1',
      }),
    ).rejects.toThrow(/已连接/);

    // Deleting the bound record sheet clears dangling targetRecordLinkId on schedule sheet
    await service.deleteLink(rec.id);
    const afterSched = repo.getLink(sched.id);
    expect(afterSched?.scheduleConfig?.targetRecordLinkId).toBeNull();
    db.close();
  });

  it('never infinitely retries failed/partial rows, auto-expires >60min overdue rows on auto-poll, and resumes partial rows without double-posting timeline', async () => {
    const db = new DatabaseSync(':memory:');
    const repo = new SqliteGoogleSheetsRepository(db);

    const nowMs = Date.UTC(2026, 10, 22, 10, 0, 0);
    // Format local dates relative to nowMs using local calendar strings matching parseScheduleDateTimeMs
    const fmtLocal = (ms: number) => {
      const d = new Date(ms);
      const pad = (n: number) => String(n).padStart(2, '0');
      return {
        date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
      };
    };
    const t15mAgo = fmtLocal(nowMs - 15 * 60_000);
    const t10mAgo = fmtLocal(nowMs - 10 * 60_000);
    const t90mAgo = fmtLocal(nowMs - 90 * 60_000);

    const sheetsData: Record<string, string[][]> = {
      '排贴-专页1': [
        [
          '发帖专页',
          '发帖日期',
          '发帖时间',
          '发帖文案',
          '发帖素材',
          '开启AI声明',
          '是否发时间线',
          '发多少小组',
          '缩略图',
          '资源编号',
          '发布状态',
          '已发小组数量',
        ],
        // Row 2: partial (timeline succeeds, groups restricted)
        [
          '999000111222',
          t15mAgo.date,
          t15mAgo.time,
          'Row A caption',
          '',
          '否',
          '是',
          '经文群:2',
          '',
          '',
          '',
          '',
        ],
        // Row 3: total failure (groups only, restricted)
        [
          '999000111222',
          t10mAgo.date,
          t10mAgo.time,
          'Row B caption',
          '',
          '否',
          '否',
          '经文群:1',
          '',
          '',
          '',
          '',
        ],
        // Row 4: >60min overdue unattempted -> auto-expired on automatic poll
        [
          '999000111222',
          t90mAgo.date,
          t90mAgo.time,
          'Row C expired caption',
          '',
          '否',
          '是',
          '0',
          '',
          '',
          '',
          '',
        ],
      ],
    };

    const sheetsApi: GoogleSheetsApiPort = {
      getSpreadsheetMeta: async (spreadsheetId) => ({
        spreadsheetId,
        title: '排贴防死循环测试',
        url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
        tabs: [{ sheetId: 101, title: '排贴-专页1', rowCount: 100, columnCount: 20 }],
      }),
      readSheetValues: async (_sid, sheetName) => {
        const rows = (sheetsData[sheetName] ?? []).map((r) => [...r]);
        return { formulaRows: rows, formattedRows: rows };
      },
      batchUpdateCells: async (_sid, sheetName, updates) => {
        const rows = sheetsData[sheetName] ?? [];
        for (const u of updates) {
          while (rows.length < u.rowNumber) rows.push([]);
          const targetRow = rows[u.rowNumber - 1];
          if (!targetRow) continue;
          while (targetRow.length <= u.colIndex) targetRow.push('');
          targetRow[u.colIndex] = u.value;
        }
      },
      appendRows: async () => {},
      deleteRowsDescending: async () => {},
      ensureHeaderColumn: async () => 0,
    };

    const oauth: GoogleOAuthPort = {
      status: async () => ({
        hasCredentials: true,
        clientIdHint: 'cid',
        authorized: true,
        authorizedEmail: 'ops@example.com',
        scopes: [],
        pendingAuthUrl: null,
        pendingAuthStartedAt: null,
        lastError: null,
      }),
      importCredentialsJson: async () => {
        throw new Error('unused');
      },
      startAuthSession: async () => {
        throw new Error('unused');
      },
      completeManualAuth: async () => {
        throw new Error('unused');
      },
      revokeAuth: async () => {
        throw new Error('unused');
      },
      getValidAccessToken: async () => 'tok',
      shutdown: async () => {},
    };

    const workspace = {
      repository: {
        targetFolders: async () => [
          {
            id: 'f-scripture',
            listKind: 'shared_groups',
            name: '经文群',
            sortOrder: 0,
            createdAt: 0,
          },
        ],
      },
      snapshot: async () => ({
        schemaVersion: 1,
        groups: [],
        combinations: [],
        records: [],
        support: { comboExecution: false, accountIdentity: false, reason: '' },
        profiles: [
          {
            id: 'prof-page-1',
            alias: '专页号1',
            browserName: '专页号1',
            groupId: null,
            order: 0,
            online: true,
            phase: 'READY',
            synced: true,
            unresolved: 0,
            extensionVersion: '0.3.84',
            capabilities: [],
            presentation: null,
            account: { state: 'logged-in', id: '999000111222', name: 'Grace Page', avatar: null },
          },
        ],
      }),
    } as unknown as WorkspaceService;

    const groupBumper = {
      state: async () => ({
        groups: [
          {
            id: '11111111',
            name: '经文A群',
            avatarUrl: null,
            folderId: 'f-scripture',
            sortOrder: 0,
            totalBumpedCount: 0,
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: '22222222',
            name: '经文B群',
            avatarUrl: null,
            folderId: 'f-scripture',
            sortOrder: 1,
            totalBumpedCount: 0,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        pages: [],
      }),
    } as unknown as GroupBumperService;

    let allowGroups = false;
    const publishCalls: Array<{ caption: string; targetIds: string[] }> = [];
    const automation: SheetAutomationBridgePort = {
      prepareMaterialMedia: async () => ({
        localFilePath: null,
        mediaKind: 'none',
        thumbnailDataUrl: null,
      }),
      publishScheduledMaterial: async (inp) => {
        publishCalls.push({
          caption: inp.material.caption,
          targetIds: inp.targets.map((t) => t.id),
        });
        let timelinePosted = false;
        let postedCount = 0;
        for (const t of inp.targets) {
          const isTimeline = t.id === PAGE_TIMELINE_SYNTHETIC_GROUP_ID;
          if (isTimeline) {
            timelinePosted = true;
            await inp.onPosted(
              {
                id: 'log-tl',
                profileId: inp.profileId,
                accountId: '999000111222',
                accountName: 'Grace Page',
                accountAvatar: null,
                identityType: 'page',
                groupId: '999000111222',
                groupName: 'Grace Page 时间线',
                groupAvatar: null,
                materialId: inp.material.id,
                captionPreview: inp.material.caption,
                postId: 'tl-1',
                postUrl: 'https://www.facebook.com/999000111222/posts/tl-1/',
                postedAt: nowMs,
              },
              true,
            );
          } else if (allowGroups) {
            postedCount++;
            await inp.onPosted(
              {
                id: `log-${t.id}`,
                profileId: inp.profileId,
                accountId: '999000111222',
                accountName: 'Grace Page',
                accountAvatar: null,
                identityType: 'page',
                groupId: t.id,
                groupName: t.name,
                groupAvatar: null,
                materialId: inp.material.id,
                captionPreview: inp.material.caption,
                postId: `g-${t.id}`,
                postUrl: `https://www.facebook.com/groups/${t.id}/posts/g-${t.id}/`,
                postedAt: nowMs,
              },
              false,
            );
          } else {
            return {
              postedCount,
              timelinePosted,
              error: '发小组受限 · 该账号当前无法在小组发帖',
            };
          }
        }
        return { postedCount, timelinePosted };
      },
      bumpDirectPosts: async () => [],
      scrapePostMetrics: async () => [],
    };

    let currentNow = nowMs;
    const service = new GoogleSheetsService(repo, {
      workspace,
      groupBumper,
      oauth,
      sheetsApi,
      imageHost: {
        uploadDataUrlOrUrl: async () => null,
        testUpload: async () => ({ remoteUrl: 'https://i.gyazo.com/x.png', host: 'gyazo' }),
      },
      automation,
      now: () => currentNow,
    });

    const sched = await service.createLink({
      kind: 'post_schedule',
      spreadsheetUrlOrId: '1CpXEEOO9X4S8TJhIlImzVQFnVCXLgv7Nk1eU6D0SI3U',
      sheetName: '排贴-专页1',
      scheduleConfig: { enabled: true, pollIntervalMinutes: 1 },
    });

    // 1. Automatic poll via tickAll: Row A partial, Row B failed, Row C auto-expired (>60m overdue)
    await service.tickAll();
    // Wait for fire-and-forget runSchedulePoll launched by tickAll to settle
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if ((sheetsData['排贴-专页1']?.[2]?.[10] ?? '') !== '') break;
    }
    await new Promise((r) => setTimeout(r, 30));

    expect(publishCalls.map((c) => c.caption)).toEqual(['Row A caption', 'Row B caption']);
    expect(sheetsData['排贴-专页1']?.[1]?.[10]).toContain('部分完成(时间线已发·小组0/2');
    expect(sheetsData['排贴-专页1']?.[1]?.[10]).toContain('发小组受限');
    expect(sheetsData['排贴-专页1']?.[2]?.[10]).toContain('失败：发小组受限');
    expect(sheetsData['排贴-专页1']?.[3]?.[10]).toBe('已过期跳过');

    // 2. Subsequent automatic poll after pollInterval MUST NOT retry Row A, Row B, or Row C!
    // Even if Row B's sheet status cell had been left blank due to a transient writeback failure!
    const rowB = sheetsData['排贴-专页1']?.[2];
    if (rowB) rowB[10] = '';
    currentNow += 5 * 60_000;
    await service.tickAll();
    await new Promise((r) => setTimeout(r, 40));
    expect(publishCalls.length).toBe(2);

    // 3. Explicit user retry on Row A resumes ONLY remaining groups (never double-posts timeline!)
    allowGroups = true;
    const rowA = sheetsData['排贴-专页1']?.[1];
    if (rowA) rowA[10] = '重试';
    if (rowB) rowB[10] = '失败：发小组受限';
    await service.triggerSchedulePoll(sched.id);
    expect(publishCalls.length).toBe(3);
    expect(publishCalls[2]?.caption).toBe('Row A caption');
    expect(publishCalls[2]?.targetIds).not.toContain(PAGE_TIMELINE_SYNTHETIC_GROUP_ID);
    expect(publishCalls[2]?.targetIds.sort()).toEqual(['11111111', '22222222']);
    expect(sheetsData['排贴-专页1']?.[1]?.[10]).toBe('已完成');
    expect(sheetsData['排贴-专页1']?.[1]?.[11]).toBe('2/2');

    db.close();
  });

  it('protects 11+ digit IDs from scientific notation, heals 1.99955E+15 cells, scrapes Reels/public metrics account-free, defers busy browsers, blocks wrong BlueStacks fallback, and cleans temp Drive cache', async () => {
    // 1. Cell text protection + scientific notation healing
    expect(sanitizeSheetCellValue('1999554954049870')).toBe("'1999554954049870");
    expect(sanitizeSheetCellValue('61587568170454')).toBe("'61587568170454");
    expect(sanitizeSheetCellValue('42')).toBe('42');
    expect(sanitizeSheetCellValue('=IMAGE("https://i.gyazo.com/a.png")')).toBe(
      '=IMAGE("https://i.gyazo.com/a.png")',
    );
    const healDiff = computeLibrarySyncDiff({
      sheetRows: [
        {
          rowNumber: 11,
          values: ['', '1999554954049870', '测试群', ''],
          displayValues: ['', '1.99955E+15', '测试群', ''],
          isHintRow: false,
        },
      ],
      localItems: [{ id: '1999554954049870', category: '', name: '测试群', avatarCellValue: '' }],
      columns: { category: 0, id: 1, name: 2, avatar: 3 },
      kind: 'group',
    });
    expect(healDiff.cellUpdates).toEqual([
      { rowNumber: 11, colIndex: 1, value: '1999554954049870' },
    ]);

    // 2. Reels HTML parser supports unified_reactors even with login footer
    const reelParsed = parseFacebookMetricsFromHtml(
      '<html><input name="email"><input name="pass">{"unified_reactors":{"count":171},"total_comment_count":39}</html>',
    );
    expect(reelParsed).toEqual({ likes: 171, comments: 39, loginOrRestricted: false });

    // 3. BlueStacks title compaction preserves custom alias
    expect(
      bluestacksDisplayTitle({
        alias: '',
        displayName: 'BlueStacks App Player 12',
        instanceKey: 'Pie64_12',
      }),
    ).toBe('蓝蝶 #12');
    expect(
      bluestacksDisplayTitle({
        alias: 'p023',
        displayName: 'BlueStacks App Player 23',
        instanceKey: 'Pie64_23',
      }),
    ).toBe('p023');

    // 4. Account-free metrics scraping works with ZERO online Chrome browsers + busy deferral + BlueStacks no wrong-account fallback + temp Drive cleanup
    const db = new DatabaseSync(':memory:');
    const repo = new SqliteGoogleSheetsRepository(db);
    const nowMs = Date.UTC(2026, 10, 22, 10, 0, 0);
    const fmtLocal = (ms: number) => {
      const d = new Date(ms);
      const pad = (n: number) => String(n).padStart(2, '0');
      return {
        date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
      };
    };
    const t5m = fmtLocal(nowMs - 5 * 60_000);
    const t30h = fmtLocal(nowMs - 30 * 3_600_000);

    const sheetsData: Record<string, string[][]> = {
      排贴表: [
        [
          '发帖专页',
          '发帖日期',
          '发帖时间',
          '发帖文案',
          '发帖素材',
          '开启AI声明',
          '是否发时间线',
          '发多少小组',
          '缩略图',
          '资源编号',
          '发布状态',
          '已发小组数量',
        ],
        [
          '999000111222',
          t5m.date,
          t5m.time,
          'Busy test',
          'https://drive.google.com/file/d/xyz/view',
          '否',
          '是',
          '0',
          '',
          '',
          '',
          '',
        ],
      ],
      发帖记录: [
        [
          '发帖日期',
          '小组id',
          '小组名字',
          '专页id',
          '专页名字',
          '贴文链接',
          '贴文编号',
          '点赞',
          '留言',
        ],
        [
          `${t30h.date} ${t30h.time}`,
          '1072811415396195',
          '公开群',
          '999000111222',
          'P1',
          'https://www.facebook.com/groups/1072811415396195/posts/1132166082794061/',
          'POST-PUB-1',
          '',
          '',
        ],
        [
          `${t30h.date} ${t30h.time}`,
          '999888777666',
          '私密群',
          '999000111222',
          'P1',
          'https://www.facebook.com/groups/999888777666/posts/555555/',
          'POST-PRIV-2',
          '',
          '',
        ],
      ],
    };

    const sheetsApi: GoogleSheetsApiPort = {
      getSpreadsheetMeta: async (spreadsheetId) => ({
        spreadsheetId,
        title: '综合验收测试表',
        url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
        tabs: [
          { sheetId: 1, title: '排贴表', rowCount: 50, columnCount: 20 },
          { sheetId: 2, title: '发帖记录', rowCount: 50, columnCount: 20 },
        ],
      }),
      readSheetValues: async (_sid, sheetName) => {
        const rows = (sheetsData[sheetName] ?? []).map((r) => [...r]);
        return { formulaRows: rows, formattedRows: rows };
      },
      readColumnValues: async (_sid, sheetName, colIndex) =>
        (sheetsData[sheetName] ?? []).map((r) => (r[colIndex] ?? '').trim()),
      batchUpdateCells: async (_sid, sheetName, updates) => {
        const rows = sheetsData[sheetName] ?? [];
        for (const u of updates) {
          while (rows.length < u.rowNumber) rows.push([]);
          const targetRow = rows[u.rowNumber - 1];
          if (!targetRow) continue;
          while (targetRow.length <= u.colIndex) targetRow.push('');
          targetRow[u.colIndex] = u.value;
        }
      },
      appendRows: async () => {},
      deleteRowsDescending: async () => {},
      ensureHeaderColumn: async () => 9,
    };

    const oauth: GoogleOAuthPort = {
      status: async () => ({
        hasCredentials: true,
        clientIdHint: 'cid',
        authorized: true,
        authorizedEmail: 'ops@example.com',
        scopes: [],
        pendingAuthUrl: null,
        pendingAuthStartedAt: null,
        lastError: null,
      }),
      importCredentialsJson: async () => {
        throw new Error('unused');
      },
      startAuthSession: async () => {
        throw new Error('unused');
      },
      completeManualAuth: async () => {
        throw new Error('unused');
      },
      revokeAuth: async () => {
        throw new Error('unused');
      },
      getValidAccessToken: async () => 'tok',
      shutdown: async () => {},
    };

    let profBusy = true;
    const featureExecution = new FeatureExecutionRegistry();
    featureExecution.register({
      id: 'active-accounts',
      label: '活跃账号',
      isProfileRunning: (pid) => profBusy && pid === 'prof-page-1',
      hasActiveExecution: () => profBusy,
    });

    const cleanedFiles: string[] = [];
    let onlineProfiles = true;
    const workspace = {
      repository: { targetFolders: async () => [] },
      snapshot: async () => ({
        schemaVersion: 1,
        groups: [],
        combinations: [],
        records: [],
        support: { comboExecution: false, accountIdentity: false, reason: '' },
        profiles: onlineProfiles
          ? [
              {
                id: 'prof-page-1',
                alias: '专页号1',
                browserName: '专页号1',
                groupId: null,
                order: 0,
                online: true,
                phase: 'READY',
                synced: true,
                unresolved: 0,
                extensionVersion: '0.3.84',
                capabilities: [],
                presentation: null,
                account: { state: 'logged-in', id: '999000111222', name: 'Grace', avatar: null },
              },
            ]
          : [],
      }),
    } as unknown as WorkspaceService;

    const groupBumper = {
      state: async () => ({ groups: [], pages: [] }),
    } as unknown as GroupBumperService;

    const automation: SheetAutomationBridgePort = {
      prepareMaterialMedia: async () => ({
        localFilePath: 'C:/cache/temp-video.mp4',
        mediaKind: 'video',
        thumbnailDataUrl: null,
        isTemporaryCache: true,
      }),
      cleanupPreparedMedia: async (p) => {
        cleanedFiles.push(p);
      },
      publishScheduledMaterial: async (inp) => {
        // Simulate operator inserting a new row ABOVE while publish is in flight!
        sheetsData['排贴表']?.splice(1, 0, [
          '888',
          t5m.date,
          t5m.time,
          'Inserted above',
          '',
          '否',
          '是',
          '0',
          '',
          '20261122-NEW001',
          '',
          '',
        ]);
        await inp.onPosted(
          {
            id: 'log-tl',
            profileId: inp.profileId,
            accountId: '999000111222',
            accountName: 'Grace',
            accountAvatar: null,
            identityType: 'page',
            groupId: '999000111222',
            groupName: 'Grace 时间线',
            groupAvatar: null,
            materialId: inp.material.id,
            captionPreview: inp.material.caption,
            postId: 'tl-99',
            postUrl: 'https://www.facebook.com/999000111222/posts/tl-99/',
            postedAt: nowMs,
          },
          true,
        );
        return { postedCount: 0, timelinePosted: true };
      },
      bumpDirectPosts: async () => [],
      scrapePublicPostMetrics: async (inp) =>
        inp.posts.map((p) =>
          p.postCode === 'POST-PUB-1'
            ? { postCode: p.postCode, postUrl: p.postUrl, likes: 13, comments: 3 }
            : {
                postCode: p.postCode,
                postUrl: p.postUrl,
                likes: null,
                comments: null,
                needsAuthFallback: true,
                error: '私密小组或需登录查看',
              },
        ),
      scrapePostMetrics: async () => [],
    };

    const service = new GoogleSheetsService(repo, {
      workspace,
      groupBumper,
      oauth,
      sheetsApi,
      imageHost: {
        uploadDataUrlOrUrl: async () => null,
        testUpload: async () => ({ remoteUrl: 'https://i.gyazo.com/x.png', host: 'gyazo' }),
      },
      automation,
      featureExecution,
      claimVerifyDelayMs: 0,
      now: () => nowMs,
    });

    const sched = await service.createLink({
      kind: 'post_schedule',
      spreadsheetUrlOrId: '1CpXEEOO9X4S8TJhIlImzVQFnVCXLgv7Nk1eU6D0SI3U',
      sheetName: '排贴表',
      scheduleConfig: { enabled: true },
    });

    // A) Busy browser defers cleanly without marking sheet row as permanent 失败!
    await service.triggerSchedulePoll(sched.id);
    expect(sheetsData['排贴表']?.[1]?.[10]).toBe('');

    // B) Once browser frees up, publish runs, survives row insertion above (writes to shifted row 3, NOT row 2!), AND cleans up Drive temp file!
    profBusy = false;
    await service.triggerSchedulePoll(sched.id);
    expect(sheetsData['排贴表']?.[1]?.[10]).toBe(''); // Inserted row untouched!
    expect(sheetsData['排贴表']?.[2]?.[10]).toBe('已完成'); // Original row shifted to index 2 updated accurately!
    expect(cleanedFiles).toEqual(['C:/cache/temp-video.mp4']);

    // C) Account-free metrics scraping succeeds for public post even with 0 online Chrome browsers!
    onlineProfiles = false;
    const rec = await service.createLink({
      kind: 'post_records',
      spreadsheetUrlOrId: '1CpXEEOO9X4S8TJhIlImzVQFnVCXLgv7Nk1eU6D0SI3U',
      sheetName: '发帖记录',
      recordsConfig: { enabled: true, collectMetricsOnThisPc: true },
    });
    const mRes = await service.refreshRecordMetrics(rec.id);
    expect(mRes.updated).toBe(1);
    expect(mRes.summary).toContain('无账号直采 1 条');
    expect(mRes.summary).toContain('1 条私密贴需在线浏览器补采');
    expect(sheetsData['发帖记录']?.[1]?.[7]).toBe('13');
    expect(sheetsData['发帖记录']?.[1]?.[8]).toBe('3');

    // D) pruneStaleRuntimeBackups removes only stale runtime-before-* / installation-before-* dirs
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'wb-prune-'));
    try {
      await mkdir(path.join(tmpRoot, 'runtime'));
      await mkdir(path.join(tmpRoot, 'runtime-previous'));
      await mkdir(path.join(tmpRoot, 'data'));
      await mkdir(path.join(tmpRoot, 'runtime-before-local-150'));
      await mkdir(path.join(tmpRoot, 'installation-before-local-150'));
      const pruned = await pruneStaleRuntimeBackups(tmpRoot);
      expect(pruned.removedDirs).toBe(2);
      await expect(access(path.join(tmpRoot, 'runtime'))).resolves.toBeUndefined();
      await expect(access(path.join(tmpRoot, 'runtime-previous'))).resolves.toBeUndefined();
      await expect(access(path.join(tmpRoot, 'data'))).resolves.toBeUndefined();
      await expect(access(path.join(tmpRoot, 'runtime-before-local-150'))).rejects.toThrow();

      // E) Backup secret redaction wipes OAuth/Gyazo secrets ONLY in exported copy
      const liveDbPath = path.join(tmpRoot, 'live.sqlite');
      const liveJPath = path.join(tmpRoot, 'journal.sqlite');
      const liveDb = new DatabaseSync(liveDbPath);
      const liveRepo = new SqliteGoogleSheetsRepository(liveDb);
      liveRepo.saveAuthConfig({ clientSecret: 'TOP_SECRET', refreshToken: 'LIVE_REFRESH' });
      liveRepo.saveImageHostConfig({ gyazoAccessTokens: ['GYAZO_SECRET_1'] });
      liveDb.close();
      const jDb = new DatabaseSync(liveJPath);
      jDb.exec('CREATE TABLE t(x INT)');
      jDb.close();

      const outDir = path.join(tmpRoot, 'backups');
      await mkdir(outDir);
      const writer = new FilesystemWorkspaceBackupWriter(
        async (dest) => {
          const src = new DatabaseSync(liveDbPath);
          const { backup } = await import('node:sqlite');
          await backup(src, dest);
          src.close();
        },
        async (dest) => {
          const src = new DatabaseSync(liveJPath);
          const { backup } = await import('node:sqlite');
          await backup(src, dest);
          src.close();
        },
        '0.1.239',
      );
      const bak = await writer.write(outDir, () => {}, { redactSecrets: true });
      const exportedDb = new DatabaseSync(path.join(bak.directory, 'workspace.sqlite'));
      const expRepo = new SqliteGoogleSheetsRepository(exportedDb);
      expect(expRepo.getAuthConfig().clientSecret).toBe('');
      expect(expRepo.getAuthConfig().refreshToken).toBeNull();
      expect(expRepo.getImageHostConfig().gyazoAccessTokens).toEqual([]);
      exportedDb.close();

      // Live DB remains 100% untouched!
      const checkLive = new DatabaseSync(liveDbPath);
      const checkRepo = new SqliteGoogleSheetsRepository(checkLive);
      expect(checkRepo.getAuthConfig().refreshToken).toBe('LIVE_REFRESH');
      expect(checkRepo.getImageHostConfig().gyazoAccessTokens).toEqual(['GYAZO_SECRET_1']);
      checkLive.close();
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }

    db.close();
  });

  it('v0.1.240 hardening: direct post URL guard, grid cache/dedup, batched bump writeback, OAuth invalid_grant vs 503, A:ZZ & SHA-256 media dedup', async () => {
    // 1. Direct single-post URL validation & sourceMode inference
    expect(
      isDirectFacebookPostUrl('https://www.facebook.com/groups/1234567/posts/987654321/'),
    ).toBe(true);
    expect(isDirectFacebookPostUrl('https://www.facebook.com/MyPage/posts/pfbid02AbCdEf123')).toBe(
      true,
    );
    expect(
      isDirectFacebookPostUrl('https://www.facebook.com/permalink.php?story_fbid=12345678&id=999'),
    ).toBe(true);
    expect(isDirectFacebookPostUrl('https://www.facebook.com/reel/1234567890/')).toBe(true);
    expect(isDirectFacebookPostUrl('https://www.facebook.com/watch/?v=1234567890')).toBe(true);
    expect(isDirectFacebookPostUrl('https://www.facebook.com/share/p/1AbCdEfG/')).toBe(true);
    expect(isDirectFacebookPostUrl('https://fb.watch/abCD1234/')).toBe(true);

    // Reject all homepage / non-post URLs (prevents wrong-post bumping!)
    expect(isDirectFacebookPostUrl('https://www.facebook.com/groups/1234567/')).toBe(false);
    expect(isDirectFacebookPostUrl('https://www.facebook.com/100089123456789')).toBe(false);
    expect(isDirectFacebookPostUrl('https://www.facebook.com/profile.php?id=100089123456789')).toBe(
      false,
    );
    expect(isDirectFacebookPostUrl('https://www.facebook.com/me')).toBe(false);
    expect(isDirectFacebookPostUrl('https://www.facebook.com/MyPageName/')).toBe(false);
    expect(isDirectFacebookPostUrl('')).toBe(false);

    expect(
      inferBumperSourceMode({
        groupId: '__page_timeline__',
        postUrl: 'https://www.facebook.com/10001/posts/999888777/',
      }),
    ).toBe('page');
    expect(
      inferBumperSourceMode({
        groupId: '-',
        postUrl: 'https://www.facebook.com/groups/555/posts/999888777/',
      }),
    ).toBe('group');

    // 2. OAuth: transient 503 preserves refreshToken; permanent invalid_grant clears refreshToken -> authorized=false
    const oauthDb = new DatabaseSync(':memory:');
    const oauthRepo = new SqliteGoogleSheetsRepository(oauthDb);
    oauthRepo.saveAuthConfig({
      clientId: 'cid.apps.googleusercontent.com',
      clientSecret: 'csec',
      refreshToken: 'valid-refresh-tok',
      accessToken: null,
      expiryDate: null,
      authorizedEmail: 'ops@example.com',
    });
    const transientOAuth = new GoogleOAuthManager(
      oauthRepo,
      async () =>
        new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(transientOAuth.getValidAccessToken()).rejects.toMatchObject({
      code: 'GOOGLE_TOKEN_REFRESH_TEMPORARY',
    });
    expect((await transientOAuth.status()).authorized).toBe(true);
    expect(oauthRepo.getAuthConfig().refreshToken).toBe('valid-refresh-tok');

    const revokedOAuth = new GoogleOAuthManager(
      oauthRepo,
      async () =>
        new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'Token expired' }),
          {
            status: 400,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    await expect(revokedOAuth.getValidAccessToken()).rejects.toMatchObject({
      code: 'GOOGLE_TOKEN_REFRESH_FAILED',
    });
    const revokedStatus = await revokedOAuth.status();
    expect(revokedStatus.authorized).toBe(false);
    expect(revokedStatus.lastError).toContain('7 天');
    expect(oauthRepo.getAuthConfig().refreshToken).toBeNull();
    oauthDb.close();

    // 3. GoogleSheetsRestClient uses A:ZZ range (supports >52 columns)
    const requestedUrls: string[] = [];
    const restClient = new GoogleSheetsRestClient(
      {
        status: async () => ({
          hasCredentials: true,
          clientIdHint: 'c',
          authorized: true,
          authorizedEmail: 'a@b.com',
          scopes: [],
          pendingAuthUrl: null,
          pendingAuthStartedAt: null,
          lastError: null,
        }),
        importCredentialsJson: async () => {
          throw new Error('unused');
        },
        startAuthSession: async () => {
          throw new Error('unused');
        },
        completeManualAuth: async () => {
          throw new Error('unused');
        },
        revokeAuth: async () => {
          throw new Error('unused');
        },
        getValidAccessToken: async () => 'tok-123',
        shutdown: async () => {},
      },
      async (inputUrl) => {
        requestedUrls.push(String(inputUrl));
        return new Response(JSON.stringify({ values: [['col1']] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );
    await restClient.readSheetValues('sp-1', '发帖记录');
    expect(requestedUrls.every((u) => u.includes('A%3AZZ'))).toBe(true);

    // 4. Backend Grid Cache + Single-Flight Dedup + Debounced Batched Bump Writeback + Homepage URL Skip
    const db = new DatabaseSync(':memory:');
    const repo = new SqliteGoogleSheetsRepository(db);
    let nowMs = Date.UTC(2026, 10, 22, 8, 0, 0);
    let readCalls = 0;
    const batchCalls: Array<Array<{ rowNumber: number; colIndex: number; value: string }>> = [];
    const colReadCalls: number[] = [];
    const rowsData: string[][] = [
      ['发帖时间', '小组id', '小组名字', '专页id', '专页名称', '贴文链接', '贴文编号', '电脑1号'],
      [
        '2026/11/22 07:30:00',
        '111',
        '群A',
        '222',
        '专页A',
        'https://www.facebook.com/groups/111/posts/10000001/',
        'POST-1',
        '0',
      ],
      [
        '2026/11/22 07:31:00',
        '111',
        '群A',
        '222',
        '专页A',
        'https://www.facebook.com/groups/111/posts/10000002/',
        'POST-2',
        '0',
      ],
      [
        '2026/11/22 07:32:00',
        '111',
        '群A',
        '222',
        '专页A',
        'https://www.facebook.com/groups/111/',
        'POST-HOMEPAGE-BAD',
        '0',
      ],
    ];
    const sheetsApi: GoogleSheetsApiPort = {
      getSpreadsheetMeta: async () => ({
        spreadsheetId: 'sp-v240-123456',
        title: 'Test',
        url: 'https://docs.google.com/spreadsheets/d/sp-v240-123456/edit',
        tabs: [{ sheetId: 1, title: '发帖记录', rowCount: 100, columnCount: 20 }],
      }),
      readSheetValues: async () => {
        readCalls++;
        await new Promise((r) => setTimeout(r, 15));
        return {
          formulaRows: rowsData.map((r) => [...r]),
          formattedRows: rowsData.map((r) => [...r]),
        };
      },
      readColumnValues: async (_sp, _sn, colIndex) => {
        colReadCalls.push(colIndex);
        return rowsData.map((r) => r[colIndex] ?? '');
      },
      batchUpdateCells: async (_sp, _sn, updates) => {
        batchCalls.push([...updates]);
      },
      appendRows: async () => {},
      deleteRowsDescending: async () => {},
      ensureHeaderColumn: async () => 7,
    };
    const bumpedCodes: string[] = [];
    const service = new GoogleSheetsService(repo, {
      workspace: {
        snapshot: async () => ({
          profiles: [
            {
              id: 'p-1',
              alias: 'B1',
              browserName: 'B1',
              groupId: 'grp-1',
              order: 0,
              online: true,
              phase: 'READY',
              synced: true,
              unresolved: 0,
              extensionVersion: '0.3.84',
              capabilities: [],
              presentation: null,
              account: { state: 'logged-in', id: '10001', name: 'B1', avatar: null },
            },
          ],
        }),
      } as unknown as WorkspaceService,
      groupBumper: {
        state: async () => ({ groups: [], pages: [] }),
      } as unknown as GroupBumperService,
      oauth: {
        status: async () => ({
          hasCredentials: true,
          clientIdHint: 'c',
          authorized: true,
          authorizedEmail: 'a@b.com',
          scopes: [],
          pendingAuthUrl: null,
          pendingAuthStartedAt: null,
          lastError: null,
        }),
        importCredentialsJson: async () => {
          throw new Error('unused');
        },
        startAuthSession: async () => {
          throw new Error('unused');
        },
        completeManualAuth: async () => {
          throw new Error('unused');
        },
        revokeAuth: async () => {
          throw new Error('unused');
        },
        getValidAccessToken: async () => 'tok',
        shutdown: async () => {},
      },
      sheetsApi,
      imageHost: {
        status: async () => ({
          preferredHost: 'auto',
          hasGyazoToken: false,
          gyazoTokenPreview: null,
          gyazoTokenCount: 0,
          gyazoTokenPreviews: [],
          driveFolderId: null,
          defaultMachineName: '电脑1号',
          cachedImageCount: 0,
        }),
        saveConfig: async () => {
          throw new Error('unused');
        },
        testConnection: async () => ({ ok: true, host: 'drive', summary: 'ok' }),
        uploadDataUrlOrUrl: async () => null,
      },
      automation: {
        prepareMaterialMedia: async () => ({
          localFilePath: null,
          mediaKind: 'none',
          thumbnailDataUrl: null,
        }),
        publishScheduledMaterial: async () => ({ postedCount: 0, timelinePosted: false }),
        bumpDirectPosts: async (inp) => {
          const out = [];
          for (const p of inp.posts) {
            bumpedCodes.push(p.postCode);
            const r = {
              postCode: p.postCode,
              postUrl: p.postUrl,
              bumped: true,
              liked: true,
              commented: false,
            };
            out.push(r);
            await inp.onPostBumped(r);
          }
          return out;
        },
        scrapePostMetrics: async () => [],
      },
      now: () => nowMs,
    });

    const recLink = repo.createLink({
      kind: 'post_records',
      title: '发帖记录',
      spreadsheetId: 'sp-v240-123456',
      spreadsheetTitle: 'Test',
      sheetId: 1,
      sheetName: '发帖记录',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sp-v240-123456/edit#gid=1',
      recordsConfig: {
        enabled: true,
        machineName: '电脑1号',
        bumperProfileGroupIds: ['grp-1'],
        collectMetricsOnThisPc: false,
      },
    });

    // Single-flight dedup: 2 concurrent reads -> 1 API call!
    await Promise.all([service.readGrid(recLink.id), service.readGrid(recLink.id)]);
    expect(readCalls).toBe(1);
    // Warm cache within 45s -> 0 extra API calls!
    await service.readGrid(recLink.id);
    expect(readCalls).toBe(1);
    // Explicit force=true bypasses cache -> 2 API calls!
    await service.readGrid(recLink.id, { force: true });
    expect(readCalls).toBe(2);

    // Poll records: skips POST-HOMEPAGE-BAD, bumps POST-1 & POST-2, merges BOTH writebacks into 1 batchUpdateCells call!
    await service.triggerRecordsPoll(recLink.id);
    expect(bumpedCodes).toEqual(['POST-1', 'POST-2']);
    expect(batchCalls.length).toBe(1);
    expect(batchCalls[0]).toEqual([
      { rowNumber: 2, colIndex: 7, value: '1' },
      { rowNumber: 3, colIndex: 7, value: '1' },
    ]);
    expect(colReadCalls.length).toBe(1);
    nowMs += 60_000;
    db.close();

    // 5. FilesystemPosterMediaPreparer SHA-256 deduplication + legacy UUID folder pruning
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'wb-media-dedup-'));
    try {
      const tinyPng = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);
      let fetchHits = 0;
      const preparer = new FilesystemPosterMediaPreparer(cacheRoot, async () => {
        fetchHits++;
        return new Response(tinyPng, {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(tinyPng.byteLength) },
        });
      });
      const driveUrl = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWx/view';
      const first = await preparer.prepare(driveUrl);
      const second = await preparer.prepare(driveUrl);
      expect(first.localFilePath).toBe(second.localFilePath);
      expect(first.localFilePath).toContain('by-hash');
      expect(fetchHits).toBe(1);
      // Zero stray UUID directories left behind!
      const topEntries = await readdir(cacheRoot);
      expect(topEntries).toEqual(['by-hash']);
      // Legacy stale UUID folder gets reaped by pruneOldCachedFiles
      const legacyUuid = path.join(cacheRoot, '08027de4-ae0c-4584-8858-3cf598cbbb67');
      await mkdir(legacyUuid);
      const oldDate = new Date(Date.now() - 48 * 3600_000);
      await utimes(legacyUuid, oldDate, oldDate);
      const prunedCount = await preparer.pruneOldCachedFiles(24 * 3600_000);
      expect(prunedCount).toBe(1);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });
});
