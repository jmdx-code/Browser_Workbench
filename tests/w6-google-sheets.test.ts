import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { FeatureExecutionRegistry } from '../src/application/feature-execution-registry.js';
import type {
  GoogleOAuthPort,
  GoogleSheetsApiPort,
  SheetImageHostPort,
} from '../src/application/google-sheets-ports.js';
import { GoogleSheetsService } from '../src/application/google-sheets-service.js';
import {
  createGoogleSheetsContext,
  tryClaimProfile,
} from '../src/application/google-sheets/gs-context-and-library.js';
import {
  computeScheduleRetryState,
  findOrWakeProfileForPage,
  SCHEDULE_MAX_ATTEMPTS,
  updateScheduleRowByKey,
} from '../src/application/google-sheets/gs-schedule-helpers.js';
import type { GroupBumperService } from '../src/application/group-bumper-service.js';
import { Workboard } from '../src/application/workboard.js';
import type { WorkspaceService } from '../src/application/workspace-service.js';
import { handleFeatureModuleRoutes } from '../src/http/routes/feature-module-routes.js';
import { GoogleOAuthManager } from '../src/infrastructure/google-oauth.js';
import {
  parseFacebookMetricsFromHtml,
  scrapeAuthenticatedPostMetricsInPage,
} from '../src/infrastructure/google-sheets-html-metrics.js';
import {
  isEncryptedSecret,
  SqliteGoogleSheetsRepository,
  type SheetSecretProtector,
} from '../src/infrastructure/google-sheets-store.js';
import {
  PAGE_TIMELINE_SYNTHETIC_GROUP_ID,
  resolveScheduleColumns,
} from '../src/shared/google-sheets.js';

type Seed = {
  id: string;
  accountId: string;
  online: boolean;
  groupId?: string | null;
  managedIdentities?: Array<{ id: string; name: string; identityType: 'page' }>;
};
type AutoPort = NonNullable<GoogleSheetsService['deps']['automation']>;
type BsPort = NonNullable<GoogleSheetsService['deps']['bluestacks']>;
type LibGroup = { id: string; name: string; folderId: string | null; avatarUrl?: string };

const SID = '1CpXEEOO9X4S8TJhIlImzVQFnVCXLgv7Nk1eU6D0SI3U';
const SCHED_HDR =
  '发帖专页,发帖日期,发帖时间,发帖文案,发帖素材,是否发时间线,发多少小组,资源编号,发布状态,已发小组数量'.split(
    ',',
  );
const REC_HDR = '发帖日期,小组id,小组名字,专页id,专页名字,贴文链接,贴文编号'.split(',');
const fmtDue = (ms: number): [string, string] => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return [
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    `${p(d.getHours())}:${p(d.getMinutes())}`,
  ];
};
function makeDeps(
  sheets: Record<string, string[][]>,
  profiles: () => Seed[] = () => [],
  groups: LibGroup[] = [],
  over: Partial<GoogleSheetsService['deps']> = {},
  onUpload?: () => void,
): GoogleSheetsService['deps'] {
  const oauth = {
    status: async () => ({
      hasCredentials: true,
      clientIdHint: 'c',
      authorized: true,
      authorizedEmail: 'a@b.c',
    }),
    getValidAccessToken: async () => 'tok',
    shutdown: async () => {},
  } as unknown as GoogleOAuthPort;
  const imageHost: SheetImageHostPort = {
    uploadDataUrlOrUrl: async () => (
      onUpload?.(),
      { remoteUrl: 'https://i.gyazo.com/s.png', host: 'gyazo', cached: false }
    ),
    testUpload: async () => ({ remoteUrl: 'https://i.gyazo.com/t.png', host: 'gyazo' }),
  };
  const sheetsApi = {
    getSpreadsheetMeta: async (id: string) => ({
      spreadsheetId: id,
      title: 'Book',
      tabs: Object.keys(sheets).map((title, i) => ({
        sheetId: 100 + i,
        title,
        rowCount: 200,
        columnCount: 20,
      })),
    }),
    readSheetValues: async (_s: string, t: string) => {
      const r = (sheets[t] ?? []).map((x) => [...x]);
      return { formulaRows: r, formattedRows: r };
    },
    readHeaderRow: async (_s: string, t: string) => [...(sheets[t]?.[0] ?? [])],
    readColumnValues: async (_s: string, t: string, c: number) =>
      (sheets[t] ?? []).map((x) => x[c] ?? ''),
    batchUpdateCells: async (
      _s: string,
      t: string,
      updates: Array<{ rowNumber: number; colIndex: number; value: string }>,
    ) => {
      const rows = sheets[t] ?? [];
      for (const u of updates) {
        while (rows.length < u.rowNumber) rows.push([]);
        const row = rows[u.rowNumber - 1];
        if (row) {
          while (row.length <= u.colIndex) row.push('');
          row[u.colIndex] = u.value;
        }
      }
    },
    appendRows: async (_s: string, t: string, nr: string[][]) => {
      const rows = (sheets[t] ??= []);
      for (const r of nr) rows.push(r.map((c) => c ?? ''));
    },
    deleteRowsDescending: async () => {},
    ensureHeaderColumn: async (_s: string, t: string, hdr: string[], title: string) => {
      const idx = hdr.findIndex((h) => h.trim() === title.trim());
      if (idx >= 0) return idx;
      const rows = (sheets[t] ??= [[]]);
      const h = (rows[0] ??= []);
      h[h.length] = title;
      return h.length - 1;
    },
  } as unknown as GoogleSheetsApiPort;
  const workspace = {
    repository: { targetFolders: async () => [], targetListCommand: async () => {} },
    snapshot: async () => ({
      profiles: profiles().map((p) => ({
        id: p.id,
        alias: p.id,
        browserName: p.id,
        groupId: p.groupId ?? null,
        online: p.online,
        phase: 'READY',
        synced: true,
        managedIdentities: p.managedIdentities ?? [],
        account: { state: 'logged-in', id: p.accountId, name: p.id, avatar: null },
      })),
    }),
  } as unknown as WorkspaceService;
  const groupBumper = {
    state: async () => ({ groups, pages: [] }),
    manage: async (_a: string, b: unknown) => {
      const items = (b as { items?: Array<{ id: string; folderId: string | null }> })?.items;
      if (items?.[0] && groups[0]) groups[0] = { ...groups[0], folderId: items[0].folderId };
      return {};
    },
  } as unknown as GroupBumperService;
  return { workspace, groupBumper, oauth, sheetsApi, imageHost, ...over };
}

const makeAuto = (over: Partial<AutoPort> = {}): AutoPort => ({
  prepareMaterialMedia: async () => ({
    localFilePath: '',
    mediaKind: 'image',
    thumbnailDataUrl: null,
  }),
  publishScheduledMaterial: async () => ({ postedCount: 0, timelinePosted: false }),
  bumpDirectPosts: async () => [],
  scrapePostMetrics: async () => [],
  ...over,
});

const makeLifecycle = (
  onWake?: () => void,
  closed?: string[],
): NonNullable<GoogleSheetsService['deps']['profileLifecycle']> =>
  ({
    ensureProfilesOnline: async () => (
      onWake?.(),
      await new Promise((r) => setTimeout(r, 15)),
      { requestedIds: [], readyIds: [], launchedIds: [], failed: [], items: [] }
    ),
    closeProfile: async (id: string) => (
      closed?.push(id),
      {
        profileId: id,
        browserName: null,
        action: 'close',
        ok: true,
        online: false,
        phase: 'OFFLINE',
        synced: false,
        launchable: true,
        elapsedMs: 1,
      }
    ),
  }) as unknown as NonNullable<GoogleSheetsService['deps']['profileLifecycle']>;

async function withRepo(
  fn: (repo: SqliteGoogleSheetsRepository, db: DatabaseSync) => Promise<void>,
  protector?: SheetSecretProtector,
) {
  const db = new DatabaseSync(':memory:');
  try {
    await fn(new SqliteGoogleSheetsRepository(db, protector), db);
  } finally {
    db.close();
  }
}

describe('W6 Google Sheets Core, Security, Routes & Reliability', () => {
  it('validates status & resourceCode columns before dispatch and throws on failed write-back', async () => {
    await withRepo(async (repo) => {
      const svc = new GoogleSheetsService(
        repo,
        makeDeps(
          { 排贴缺少状态: [['发帖专页', '发帖日期', '发帖时间', '发帖文案']] },
          () => [],
          [],
          { automation: makeAuto() },
        ),
      );
      const link = await svc.createLink({
        kind: 'post_schedule',
        spreadsheetUrlOrId: SID,
        sheetName: '排贴缺少状态',
      });
      await assert.rejects(() => svc.triggerSchedulePoll(link.id), {
        code: 'SHEET_HEADER_MISSING',
      });

      const ctx = createGoogleSheetsContext(
        repo,
        makeDeps({ 排贴表: [['发帖专页', '发帖日期', '资源编号', '发布状态']] }),
        async () => {},
      );
      const cols = resolveScheduleColumns(['发帖专页', '发帖日期', '资源编号', '发布状态']);
      await assert.rejects(
        () =>
          updateScheduleRowByKey(
            ctx,
            link,
            2,
            '20261127-MISSING',
            { status: '已完成' },
            cols,
            false,
          ),
        /回写定位失败/,
      );
    });
  });

  it('persists attemptCount/nextRetryAt/lastError via ensureColumns, enforces 2m->6m->18m backoff and 3-attempt terminal cap', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      `CREATE TABLE sheet_schedule_items (link_id TEXT NOT NULL, resource_code TEXT NOT NULL, page_id TEXT NOT NULL DEFAULT '', scheduled_at INTEGER NOT NULL DEFAULT 0, caption TEXT NOT NULL DEFAULT '', media_source TEXT NOT NULL DEFAULT '', ai_label TEXT NOT NULL DEFAULT 'default', post_timeline INTEGER NOT NULL DEFAULT 0, groups_spec TEXT NOT NULL DEFAULT '', thumbnail_url TEXT, status TEXT NOT NULL DEFAULT 'pending', timeline_posted INTEGER NOT NULL DEFAULT 0, posted_group_ids_json TEXT NOT NULL DEFAULT '[]', target_group_count INTEGER NOT NULL DEFAULT 0, posted_group_count INTEGER NOT NULL DEFAULT 0, error_message TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(link_id, resource_code));`,
    );
    const repo = new SqliteGoogleSheetsRepository(db);
    const cols = db
      .prepare('PRAGMA table_info(sheet_schedule_items)')
      .all()
      .map((c) => String(c.name));
    assert.ok(
      cols.includes('attempt_count') &&
        cols.includes('next_retry_at') &&
        cols.includes('last_error'),
    );

    const r1 = computeScheduleRetryState(0, '临时网络超时', 10_000, false);
    const r2 = computeScheduleRetryState(1, '临时网络超时', 20_000, false);
    const r3 = computeScheduleRetryState(2, '临时网络超时', 30_000, false);
    assert.equal(r1.attemptCount, 1);
    assert.equal(r1.delayMs, 120_000);
    assert.equal(r2.delayMs, 360_000);
    assert.equal(r3.terminal, true);
    assert.equal(r3.attemptCount, SCHEDULE_MAX_ATTEMPTS);
    assert.equal(r3.status, 'failed');
    assert.equal(r3.nextRetryAt, null);

    let nowMs = Date.UTC(2026, 10, 27, 10, 0, 0);
    const sheets = {
      排贴: [
        SCHED_HDR,
        [
          '999000111',
          ...fmtDue(nowMs - 300_000),
          'Retry post',
          '',
          '是',
          '0',
          '20261127-RETRY1',
          '',
          '',
        ],
      ],
    };
    let attempts = 0;
    const svc = new GoogleSheetsService(
      repo,
      makeDeps(sheets, () => [{ id: 'prof-1', accountId: '999000111', online: true }], [], {
        automation: makeAuto({
          publishScheduledMaterial: async () => (
            attempts++,
            { postedCount: 0, timelinePosted: false, error: '临时网络抖动超时' }
          ),
        }),
        now: () => nowMs,
      }),
    );
    const link = await svc.createLink({
      kind: 'post_schedule',
      spreadsheetUrlOrId: SID,
      sheetName: '排贴',
      scheduleConfig: { enabled: true, pollIntervalMinutes: 1 },
    });

    await svc.triggerSchedulePoll(link.id);
    assert.equal(attempts, 1);
    assert.match(sheets['排贴']?.[1]?.[8] ?? '', /^待重试\(1\/3·2m后\)/);

    nowMs += 60_000;
    await svc.triggerSchedulePoll(link.id);
    assert.equal(attempts, 1);

    nowMs += 120_000;
    await svc.triggerSchedulePoll(link.id);
    assert.equal(attempts, 2);
    assert.match(sheets['排贴']?.[1]?.[8] ?? '', /^待重试\(2\/3·6m后\)/);

    nowMs += 360_000;
    await svc.triggerSchedulePoll(link.id);
    assert.equal(attempts, 3);
    assert.match(sheets['排贴']?.[1]?.[8] ?? '', /^失败：已重试3次仍失败/);

    nowMs += 1_800_000;
    await svc.triggerSchedulePoll(link.id);
    assert.equal(attempts, 3);
    const stored = repo.getScheduleItem(link.id, '20261127-RETRY1');
    assert.equal(stored?.attemptCount, 3);
    assert.equal(stored?.status, 'failed');
    assert.equal(stored?.nextRetryAt, null);
    assert.equal(stored?.lastError, '临时网络抖动超时');
    db.close();
  });

  it('auto-recovers stale 发布中 rows on startup and exposes resetStuckRows + bumper/stop group default via HTTP routes', async () => {
    await withRepo(async (repo) => {
      repo.saveImageHostConfig({ defaultMachineName: '电脑1号' });
      const sheets = {
        排贴: [
          ['发帖专页', '发帖日期', '资源编号', '发布状态'],
          ['999', '2026-11-27', 'CODE-THIS', '发布中(电脑1号#ABCD)…'],
          ['999', '2026-11-27', 'CODE-OTHER', '发布中(电脑2号#WXYZ)…'],
        ],
      };
      const svc = new GoogleSheetsService(repo, makeDeps(sheets));
      const link = await svc.createLink({
        kind: 'post_schedule',
        spreadsheetUrlOrId: SID,
        sheetName: '排贴',
      });
      assert.equal(await svc.recoverStuckRowsOnStartup(), 1);
      assert.equal(sheets['排贴']?.[1]?.[3], '待发布');
      assert.equal(sheets['排贴']?.[2]?.[3], '发布中(电脑2号#WXYZ)…');

      const bsStopCalls: Array<{ ids: readonly string[] | undefined; mode: string | undefined }> =
        [];
      const invokeRoute = async (route: string, input: unknown) => {
        let status = 0;
        let payload: unknown = null;
        const handled = await handleFeatureModuleRoutes({
          req: { method: 'POST', url: route, headers: {} } as http.IncomingMessage,
          res: {} as http.ServerResponse,
          route,
          input,
          json: (_r, s, data) => {
            status = s;
            payload = data;
          },
          service: {} as WorkspaceService,
          googleSheets: svc,
          bluestacks: {
            parseStopInput: (inp: unknown) =>
              (inp as { profileIds?: string[] })?.profileIds ?? undefined,
            stopBumper: async (ids?: readonly string[], mode?: string) => (
              bsStopCalls.push({ ids, mode }),
              { stopped: true }
            ),
          } as unknown as NonNullable<
            Parameters<typeof handleFeatureModuleRoutes>[0]['bluestacks']
          >,
        });
        return { handled, status, payload };
      };

      const resetResp = await invokeRoute('/api/workspace/google-sheets/links/reset-stuck', {
        id: link.id,
      });
      assert.equal(resetResp.handled, true);
      assert.equal(resetResp.status, 200);
      assert.equal((resetResp.payload as { resetCount: number }).resetCount, 1);
      assert.equal(sheets['排贴']?.[2]?.[3], '待发布');
      const stopResp = await invokeRoute('/api/workspace/bluestacks/bumper/stop', {
        profileIds: ['bs-1'],
      });
      assert.equal(stopResp.handled, true);
      assert.deepEqual(bsStopCalls, [{ ids: ['bs-1'], mode: 'group' }]);
    });
  });

  it('enforces atomic synchronous profile claim before offline launch, live user-opened window protection, Workboard & risk limit DI', async () => {
    await withRepo(async (repo) => {
      let wakeCalls = 0;
      let nowClock = 1_000_000;
      const featureExec = new FeatureExecutionRegistry();
      featureExec.register({
        id: 'other',
        label: 'Other',
        hasActiveExecution: () => false,
        isProfileRunning: async () => (await new Promise((r) => setTimeout(r, 10)), false),
      });
      const ctx = createGoogleSheetsContext(
        repo,
        makeDeps(
          {},
          () => [{ id: 'prof-atomic', accountId: '888001', online: false, groupId: 'grp-1' }],
          [],
          {
            featureExecution: featureExec,
            profileLifecycle: makeLifecycle(() => {
              wakeCalls++;
            }),
            now: () => (nowClock += 15_000),
          },
        ),
        async () => {},
      );
      const claims = await Promise.all([
        tryClaimProfile(ctx, 'prof-atomic', {
          linkId: 'l1',
          kind: 'post_schedule',
          title: 'L1',
          status: 'run',
        }),
        tryClaimProfile(ctx, 'prof-atomic', {
          linkId: 'l2',
          kind: 'post_schedule',
          title: 'L2',
          status: 'run',
        }),
      ]);
      assert.equal(claims.filter(Boolean).length, 1);
      ctx.activeProfiles.clear();

      const wakeAttempt = await findOrWakeProfileForPage(ctx, '888001', 'l1', 'L1');
      assert.equal(wakeAttempt.status, 'not_found');
      assert.equal(wakeCalls, 1);
      assert.equal(ctx.activeProfiles.size, 0);

      let snapshotCount = 0;
      const userOpenedCloseCalls: string[] = [];
      let riskBlockedCount = 0;
      const recSheets = {
        发帖记录: [
          REC_HDR,
          [
            fmtDue(Date.now() - 3_600_000).join(' '),
            '111',
            'G1',
            '222',
            'P2',
            'https://www.facebook.com/groups/111/posts/9990001/',
            'CODE-1',
          ],
        ],
      };
      const svc = new GoogleSheetsService(
        repo,
        makeDeps(
          recSheets,
          () => (
            ++snapshotCount,
            [
              { id: 'prof-user', accountId: '1001', online: snapshotCount >= 2, groupId: 'grp-1' },
              { id: 'prof-risk', accountId: '1002', online: true, groupId: 'grp-1' },
            ]
          ),
          [],
          {
            workboard: new Workboard({ browserConcurrency: 1, bluestacksConcurrency: 1 }),
            checkDailyRiskLimit: (pid) =>
              pid === 'prof-risk'
                ? (riskBlockedCount++, { allowed: false, reason: '日限额已满' })
                : { allowed: true, reason: null },
            profileLifecycle: makeLifecycle(undefined, userOpenedCloseCalls),
            automation: makeAuto({
              bumpDirectPosts: async (inp) => (assert.notEqual(inp.profileId, 'prof-risk'), []),
            }),
          },
        ),
      );
      const recLink = await svc.createLink({
        kind: 'post_records',
        spreadsheetUrlOrId: SID,
        sheetName: '发帖记录',
        recordsConfig: {
          enabled: true,
          bumperProfileGroupIds: ['grp-1'],
          collectMetricsOnThisPc: false,
        },
      });
      await svc.syncMaxConcurrency(3, 2);
      const wb = svc.getWorkboard();
      assert.deepEqual([wb.browserPermits.max, wb.bluestacksPermits.max], [3, 2]);
      assert.equal(
        repo.getLink(recLink.id)?.recordsConfig?.bumperSettings.maxConcurrentProfiles,
        3,
      );
      await svc.triggerRecordsPoll(recLink.id);
      assert.deepEqual(userOpenedCloseCalls, []);
      assert.ok(riskBlockedCount >= 1);
    });
  });

  it('supports BlueStacks postUrl + media prep, Chrome managedIdentities, library folderId/avatar & log partitioning', async () => {
    await withRepo(async (repo) => {
      const bsId = '11111111-1111-4111-8111-111111111111';
      const nowMs = Date.UTC(2026, 10, 27, 12, 0, 0);
      const tail = 'BS media,https://drive.google.com/file/d/media123/view,是,0,,,'.split(',');
      const sheets = {
        蓝蝶排贴: [SCHED_HDR, ['777000111', ...fmtDue(nowMs - 300_000), ...tail]],
        发帖记录: [REC_HDR],
        小组表: [
          ['类别', '小组id', '小组名字', '小组头像'],
          ['', '555666', 'Old Group', '=IMAGE("https://i.gyazo.com/keep.png")'],
        ],
      };
      let preparedMediaSource = '';
      let uploadHits = 0;
      let switchCalled = false;
      const managedCalls = [
        {
          id: '555666',
          name: 'Old Group',
          folderId: 'existing-folder-id',
          avatarUrl: 'https://fbcdn.net/temp-avatar.jpg',
        },
      ];
      type BsPostArg = Parameters<NonNullable<BsPort['runDirectPosterForSheet']>>[0];
      type BsPostedItem = Parameters<NonNullable<BsPostArg['onPosted']>>[0];
      const managedProfile: Seed = {
        id: 'chrome-managed-1',
        accountId: '100001',
        online: true,
        managedIdentities: [{ id: '666000', name: 'Managed Page', identityType: 'page' }],
      };
      const svc = new GoogleSheetsService(
        repo,
        makeDeps(
          sheets,
          () => [managedProfile],
          managedCalls,
          {
            prepareMaterialMedia: async (src) => (
              (preparedMediaSource = src),
              { localFilePath: 'C:/cache/bs-media.jpg', mediaKind: 'image', thumbnailDataUrl: null }
            ),
            bluestacks: {
              state: async () => ({
                instances: [
                  {
                    id: bsId,
                    displayName: 'BS-1',
                    online: true,
                    fbWidth: 900,
                    fbHeight: 1600,
                    accountState: 'logged-in',
                    accountId: '777000111',
                    numericAccountId: '777000111',
                    accountName: 'BS Page',
                    identityType: 'page',
                    managedIdentities: [],
                  },
                ],
              }),
              runDirectPosterForSheet: async (inp: BsPostArg) => {
                assert.equal(inp.material.localFilePath, 'C:/cache/bs-media.jpg');
                await inp.onPosted?.(
                  {
                    id: 'bs-log-1',
                    profileId: bsId,
                    accountId: '777000111',
                    accountName: 'BS Page',
                    identityType: 'page',
                    groupId: PAGE_TIMELINE_SYNTHETIC_GROUP_ID,
                    groupName: '专页时间线',
                    materialId: inp.material.id,
                    captionPreview: inp.material.caption,
                    postId: '9988776655',
                    postUrl: 'https://www.facebook.com/777000111/posts/9988776655/',
                    postedAt: nowMs,
                  } as BsPostedItem,
                  true,
                );
                return { postedCount: 0, timelinePosted: true };
              },
            } as unknown as BsPort,
            now: () => nowMs,
          },
          () => {
            uploadHits++;
          },
        ),
      );

      const rec = await svc.createLink({
        kind: 'post_records',
        spreadsheetUrlOrId: SID,
        sheetName: '发帖记录',
      });
      const sched = await svc.createLink({
        kind: 'post_schedule',
        spreadsheetUrlOrId: SID,
        sheetName: '蓝蝶排贴',
        scheduleConfig: {
          executionCarrier: 'bluestacks',
          targetRecordLinkId: rec.id,
          autoWakeBumper: false,
        },
      });
      await svc.triggerSchedulePoll(sched.id);
      assert.equal(preparedMediaSource, 'https://drive.google.com/file/d/media123/view');
      assert.equal(
        repo.listRecordPosts(rec.id)[0]?.postUrl,
        'https://www.facebook.com/777000111/posts/9988776655/',
      );

      const lib = await svc.createLink({
        kind: 'group_library',
        spreadsheetUrlOrId: SID,
        sheetName: '小组表',
      });
      await svc.importLibraryFromSheet(lib.id, 'incremental');
      assert.equal(managedCalls[0]?.folderId, 'existing-folder-id');
      await svc.syncLibraryToSheet(lib.id);
      assert.equal(uploadHits, 0);

      const ctx = createGoogleSheetsContext(
        repo,
        makeDeps(sheets, () => [managedProfile], [], {
          automation: makeAuto({
            switchProfilePageIdentity: async (inp) => (
              (switchCalled = inp.targetPageId === '666000'),
              true
            ),
          }),
        }),
        async () => {},
      );
      const match = await findOrWakeProfileForPage(
        ctx,
        '666000',
        sched.id,
        'Sched',
        'Managed Page',
      );
      assert.equal(match.status, 'found');
      if (match.status === 'found') {
        assert.equal(match.needsPageSwitch, true);
        await ctx.deps.automation?.switchProfilePageIdentity?.({
          profileId: match.profile.id,
          targetPageId: '666000',
          targetPageName: 'Managed Page',
        });
        assert.equal(switchCalled, true);
      }

      for (let i = 0; i < 80; i++)
        repo.appendLog({
          linkId: 'high-freq-link',
          level: 'info',
          action: 'poll',
          summary: `HF-${i}`,
        });
      repo.appendLog({ linkId: 'quiet-link', level: 'warn', action: 'poll', summary: 'QUIET-1' });
      assert.ok(repo.listLogs(20).some((l) => l.linkId === 'quiet-link'));
    });
  });

  it('scopes HTML metrics to target post, skips deleted single posts, preserves OAuth callback URL, and encrypts/migrates secrets at rest', async () => {
    const html =
      '{"post_id":"111","reaction_count":{"count":999},"total_comment_count":88}{"post_id":"222","reaction_count":{"count":12},"total_comment_count":3}';
    const scoped = parseFacebookMetricsFromHtml(html, '222');
    assert.deepEqual([scoped.likes, scoped.comments], [12, 3]);
    const deleted = parseFacebookMetricsFromHtml(
      "<div>This content isn't available right now</div>",
      '333',
    );
    assert.deepEqual([deleted.unavailable, deleted.loginOrRestricted], [true, false]);

    const pageFake = {
      url: () => 'https://www.facebook.com/',
      evaluate: async (_fn: unknown, targetUrl: string) =>
        targetUrl.includes('/posts/404')
          ? { ok: false, status: 404, finalUrl: targetUrl, html: '' }
          : {
              ok: true,
              status: 200,
              finalUrl: targetUrl,
              html: `{"post_id":"${targetUrl.split('/').filter(Boolean).pop()}","reaction_count":{"count":21},"total_comment_count":4}`,
            },
    };
    type ScrapeArg = Parameters<typeof scrapeAuthenticatedPostMetricsInPage>[0];
    const scraped = await scrapeAuthenticatedPostMetricsInPage({
      kernel: {
        readFacebookMetadataPage: async <T>(
          _p: unknown,
          _g: unknown,
          read: (page: typeof pageFake) => Promise<T>,
        ) => ({ reading: await read(pageFake) }),
      } as unknown as ScrapeArg['kernel'],
      peer: {} as unknown as ScrapeArg['peer'],
      guard: () => {},
      posts: ['1001', '404', '1003'].map((id, i) => ({
        postCode: `P${i + 1}`,
        postUrl: `https://www.facebook.com/groups/1/posts/${id}/`,
      })),
    });
    assert.deepEqual(
      [scraped[0]?.likes, scraped[1]?.unavailable, scraped[2]?.likes],
      [21, true, 21],
    );

    const pfx = 'enc:custom:v1:';
    const protector: SheetSecretProtector = {
      isAvailable: () => true,
      encryptBatch: (vals) =>
        vals.map((v) =>
          v && !isEncryptedSecret(v) ? `${pfx}${Buffer.from(v, 'utf8').toString('base64')}` : v,
        ),
      decryptBatch: (vals) =>
        vals.map((v) =>
          typeof v === 'string' && v.startsWith(pfx)
            ? Buffer.from(v.slice(pfx.length), 'base64').toString('utf8')
            : v,
        ),
    };
    await withRepo(async (repo, db) => {
      let capturedRedirect = '';
      const oauth = new GoogleOAuthManager(repo, async (_u, init) => {
        const body = String(init?.body ?? '');
        if (!body.includes('grant_type=authorization_code'))
          return new Response(JSON.stringify({ email: 'u@example.com' }), { status: 200 });
        capturedRedirect = new URLSearchParams(body).get('redirect_uri') ?? '';
        return new Response(
          JSON.stringify({ access_token: 'acc-1', refresh_token: 'ref-1', expires_in: 3600 }),
          { status: 200 },
        );
      });
      await oauth.importCredentialsJson(
        JSON.stringify({ installed: { client_id: 'cid-1234567890', client_secret: 'sec-plain' } }),
      );
      const expectedRedirect =
        new URL((await oauth.startAuthSession()).authUrl).searchParams.get('redirect_uri') ?? '';
      await oauth.shutdown();
      await oauth.completeManualAuth('raw-manual-code');
      assert.equal(capturedRedirect, expectedRedirect);
      assert.match(capturedRedirect, /^http:\/\/127\.0\.0\.1:\d+\/oauth2\/callback$/);

      const rawCfg = () =>
        db
          .prepare('SELECT auth_json, image_host_json FROM google_sheets_config WHERE id = 1')
          .get() as { auth_json: string; image_host_json: string };
      assert.ok(rawCfg().auth_json.includes(pfx) && !rawCfg().auth_json.includes('sec-plain'));
      assert.equal(repo.getAuthConfig().clientSecret, 'sec-plain');

      const tok = 'legacy-plain-gyazo';
      db.prepare('UPDATE google_sheets_config SET image_host_json = ? WHERE id = 1').run(
        JSON.stringify({ preferredHost: 'gyazo', gyazoAccessToken: tok, gyazoAccessTokens: [tok] }),
      );
      assert.equal(repo.getImageHostConfig().gyazoAccessToken, tok);
      const imgRaw = rawCfg().image_host_json;
      assert.ok(imgRaw.includes(pfx) && !imgRaw.includes(tok));
    }, protector);

    await withRepo(
      async (plainRepo) => {
        plainRepo.saveImageHostConfig({ gyazoAccessToken: 'headless-tok' });
        assert.equal(plainRepo.getImageHostConfig().gyazoAccessToken, 'headless-tok');
      },
      { isAvailable: () => false, encryptBatch: (v) => [...v], decryptBatch: (v) => [...v] },
    );
  });
});
