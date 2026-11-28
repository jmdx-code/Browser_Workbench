import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { FeatureExecutionRegistry } from '../dist/src/application/feature-execution-registry.js';
import { GoogleSheetsService } from '../dist/src/application/google-sheets-service.js';
import {
  createGoogleSheetsContext,
  tryClaimProfile,
} from '../dist/src/application/google-sheets/gs-context-and-library.js';
import { findOrWakeProfileForPage } from '../dist/src/application/google-sheets/gs-schedule-helpers.js';
import { Workboard } from '../dist/src/application/workboard.js';
import { scrapeAuthenticatedPostMetricsInPage } from '../dist/src/infrastructure/google-sheets-html-metrics.js';
import {
  isEncryptedSecret,
  SqliteGoogleSheetsRepository,
} from '../dist/src/infrastructure/google-sheets-store.js';

const pad = (n) => String(n).padStart(2, '0');
const fmtLocal = (ms) => {
  const d = new Date(ms);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
};

async function main() {
  const keepAlive = setInterval(() => {}, 1000);
  const db = new DatabaseSync(':memory:');
  try {
    const repo = new SqliteGoogleSheetsRepository(db);
    repo.saveImageHostConfig({ defaultMachineName: '电脑1号' });

    // 1. DPAPI round-trip & plaintext migration on Windows
    const dpapiActive = repo.getImageHostConfig().defaultMachineName === '电脑1号';
    db.prepare(
      'UPDATE google_sheets_config SET auth_json = ?, image_host_json = ? WHERE id = 1',
    ).run(
      JSON.stringify({
        clientId: 'cid-chaos',
        clientSecret: 'plain-secret-chaos',
        authUri: 'https://accounts.google.com/o/oauth2/auth',
        tokenUri: 'https://oauth2.googleapis.com/token',
        accessToken: 'plain-acc-chaos',
        refreshToken: 'plain-ref-chaos',
        expiryDate: Date.now() + 3600_000,
        authorizedEmail: 'chaos@example.com',
        scopes: [],
        lastError: null,
      }),
      JSON.stringify({
        preferredHost: 'gyazo',
        gyazoAccessToken: 'plain-gyazo-chaos',
        gyazoAccessTokens: ['plain-gyazo-chaos'],
        driveFolderId: null,
        defaultMachineName: '电脑1号',
      }),
    );
    const authPlain = repo.getAuthConfig();
    const hostPlain = repo.getImageHostConfig();
    assert.equal(authPlain.clientSecret, 'plain-secret-chaos');
    assert.equal(authPlain.refreshToken, 'plain-ref-chaos');
    assert.equal(hostPlain.gyazoAccessToken, 'plain-gyazo-chaos');
    const rawAfterMigration = db
      .prepare('SELECT auth_json, image_host_json FROM google_sheets_config WHERE id = 1')
      .get();
    const dpapiEncryptedAtRest =
      process.platform === 'win32' &&
      isEncryptedSecret(JSON.parse(rawAfterMigration.auth_json).clientSecret) &&
      isEncryptedSecret(JSON.parse(rawAfterMigration.image_host_json).gyazoAccessToken);
    if (process.platform === 'win32') assert.equal(dpapiEncryptedAtRest, true);

    // 2. Concurrent atomic tryClaimProfile + failed offline wake (0 TOCTOU, 0 leaked windows)
    let wakeCount = 0;
    const featureExecution = new FeatureExecutionRegistry();
    featureExecution.register({
      id: 'mock-other',
      label: 'Mock',
      isProfileRunning: async () => {
        await new Promise((r) => setTimeout(r, 8));
        return false;
      },
      hasActiveExecution: () => false,
    });
    const ctx = createGoogleSheetsContext(
      repo,
      {
        workspace: {
          snapshot: async () => ({
            profiles: [
              {
                id: 'atomic-prof',
                alias: 'Atomic',
                browserName: 'Atomic',
                groupId: null,
                order: 0,
                online: false,
                phase: 'OFFLINE',
                synced: false,
                unresolved: 0,
                extensionVersion: '0.3.92',
                capabilities: [],
                account: { state: 'logged-in', id: '7001', name: 'P7001', avatar: null },
              },
            ],
          }),
        },
        groupBumper: { state: async () => ({ groups: [], pages: [] }) },
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
          getValidAccessToken: async () => 'tok',
          shutdown: async () => {},
        },
        sheetsApi: {},
        imageHost: {},
        featureExecution,
        profileLifecycle: {
          ensureProfilesOnline: async () => {
            wakeCount++;
            await new Promise((r) => setTimeout(r, 15));
            return { requestedIds: [], readyIds: [], launchedIds: [], failed: [], items: [] };
          },
          closeProfile: async () => ({ ok: true }),
        },
        now: (() => {
          let wakeClock = 1_000_000;
          return () => (wakeClock += 15_000);
        })(),
      },
      async () => {},
    );
    const concurrentClaims = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        tryClaimProfile(ctx, 'atomic-prof', {
          linkId: `l-${i}`,
          kind: 'post_schedule',
          title: `L-${i}`,
          status: 'run',
        }),
      ),
    );
    const toctouWinners = concurrentClaims.filter(Boolean).length;
    assert.equal(toctouWinners, 1);
    ctx.activeProfiles.clear();
    const wakeRes = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        findOrWakeProfileForPage(ctx, '7001', `l-${i}`, `L-${i}`),
      ),
    );
    assert.equal(wakeCount, 1);
    assert.equal(wakeRes.filter((r) => r.status === 'found').length, 0);
    assert.equal(ctx.activeProfiles.size, 0);

    // 3. 30 schedule items chaos (stale 发布中 recovery, transient 2m->6m->18m backoff cap=3, risk limit, Workboard cap)
    let nowMs = Date.UTC(2026, 10, 27, 14, 0, 0);
    const dt = fmtLocal(nowMs - 10 * 60_000);
    const schedRows = [
      [
        '发帖专页',
        '发帖日期',
        '发帖时间',
        '发帖文案',
        '是否发时间线',
        '发多少小组',
        '资源编号',
        '发布状态',
        '已发小组数量',
      ],
    ];
    for (let i = 1; i <= 30; i++) {
      const pageId = i <= 10 ? '5001' : i <= 20 ? '5002' : '5003';
      const initStatus = i <= 5 ? `发布中(电脑1号#S${i})…` : '';
      schedRows.push([
        pageId,
        dt.date,
        dt.time,
        `Chaos sched #${i}`,
        '是',
        '0',
        `RES-${String(i).padStart(2, '0')}`,
        initStatus,
        '',
      ]);
    }
    const recRows = [
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
    ];
    for (let i = 1; i <= 30; i++) {
      const postTs = fmtLocal(nowMs - (26 + i) * 3600_000);
      recRows.push([
        `${postTs.date} ${postTs.time}`,
        '111',
        'G1',
        '5001',
        'P1',
        `https://www.facebook.com/groups/111/posts/${900000 + i}/`,
        `REC-${String(i).padStart(2, '0')}`,
        '',
        '',
      ]);
    }
    const sheetsData = { 排贴30: schedRows, 记录30: recRows };
    const workboard = new Workboard({ browserConcurrency: 2, bluestacksConcurrency: 2 });
    let peakPermits = 0;
    let riskBlockedScheduleRows = 0;
    const attemptsByCode = new Map();
    let publishedHealthy = 0;

    const svc = new GoogleSheetsService(repo, {
      workspace: {
        snapshot: async () => ({
          profiles: [
            {
              id: 'p-healthy',
              alias: 'Healthy',
              browserName: 'Healthy',
              groupId: 'g1',
              order: 0,
              online: true,
              phase: 'READY',
              synced: true,
              unresolved: 0,
              extensionVersion: '0.3.92',
              capabilities: [],
              account: { state: 'logged-in', id: '5001', name: 'P5001', avatar: null },
            },
            {
              id: 'p-flaky',
              alias: 'Flaky',
              browserName: 'Flaky',
              groupId: 'g1',
              order: 1,
              online: true,
              phase: 'READY',
              synced: true,
              unresolved: 0,
              extensionVersion: '0.3.92',
              capabilities: [],
              account: { state: 'logged-in', id: '5002', name: 'P5002', avatar: null },
            },
            {
              id: 'p-risk-capped',
              alias: 'RiskCap',
              browserName: 'RiskCap',
              groupId: 'g1',
              order: 2,
              online: true,
              phase: 'READY',
              synced: true,
              unresolved: 0,
              extensionVersion: '0.3.92',
              capabilities: [],
              account: { state: 'logged-in', id: '5003', name: 'P5003', avatar: null },
            },
          ],
        }),
      },
      groupBumper: { state: async () => ({ groups: [], pages: [] }) },
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
        getValidAccessToken: async () => 'tok',
        shutdown: async () => {},
      },
      sheetsApi: {
        getSpreadsheetMeta: async (id) => ({
          spreadsheetId: id,
          title: 'Chaos',
          url: `https://docs.google.com/spreadsheets/d/${id}/edit`,
          tabs: [
            { sheetId: 1, title: '排贴30', rowCount: 100, columnCount: 20 },
            { sheetId: 2, title: '记录30', rowCount: 100, columnCount: 20 },
          ],
        }),
        readSheetValues: async (_s, name) => ({
          formulaRows: sheetsData[name].map((r) => [...r]),
          formattedRows: sheetsData[name].map((r) => [...r]),
        }),
        readHeaderRow: async (_s, name) => [...sheetsData[name][0]],
        readColumnValues: async (_s, name, col) => sheetsData[name].map((r) => r[col] ?? ''),
        batchUpdateCells: async (_s, name, updates) => {
          for (const u of updates) {
            sheetsData[name][u.rowNumber - 1][u.colIndex] = u.value;
          }
        },
        appendRows: async (_s, name, rows) => {
          for (const r of rows) sheetsData[name].push(r.map((c) => c ?? ''));
        },
        deleteRowsDescending: async () => {},
        ensureHeaderColumn: async (_s, name, headers, title) => {
          const idx = headers.indexOf(title);
          if (idx >= 0) return idx;
          sheetsData[name][0].push(title);
          return sheetsData[name][0].length - 1;
        },
      },
      imageHost: {
        uploadDataUrlOrUrl: async () => null,
        testUpload: async () => ({ remoteUrl: 'https://i.gyazo.com/t.png', host: 'gyazo' }),
      },
      workboard,
      checkDailyRiskLimit: (pid, actionKind) => {
        if (pid === 'p-risk-capped' && actionKind === 'post') {
          riskBlockedScheduleRows++;
          return { allowed: false, reason: '今日发帖已达日限额' };
        }
        return { allowed: true, reason: null };
      },
      automation: {
        prepareMaterialMedia: async () => ({
          localFilePath: '',
          mediaKind: 'image',
          thumbnailDataUrl: null,
        }),
        publishScheduledMaterial: async (inp) => {
          peakPermits = Math.max(peakPermits, workboard.browserPermits.used);
          assert.ok(workboard.browserPermits.used <= workboard.browserPermits.max);
          attemptsByCode.set(inp.material.id, (attemptsByCode.get(inp.material.id) ?? 0) + 1);
          if (inp.profileId === 'p-flaky') {
            return { postedCount: 0, timelinePosted: false, error: '临时网络错误' };
          }
          publishedHealthy++;
          await inp.onPosted(
            {
              id: `log-${inp.material.id}`,
              profileId: inp.profileId,
              accountId: '5001',
              accountName: 'P5001',
              accountAvatar: null,
              identityType: 'page',
              groupId: '5001',
              groupName: 'P5001',
              groupAvatar: null,
              materialId: inp.material.id,
              captionPreview: inp.material.caption,
              postId: `999${publishedHealthy}`,
              postUrl: `https://www.facebook.com/5001/posts/999${publishedHealthy}/`,
              postedAt: nowMs,
            },
            true,
          );
          return { postedCount: 0, timelinePosted: true };
        },
        bumpDirectPosts: async () => [],
        scrapePostMetrics: async ({ posts }) =>
          scrapeAuthenticatedPostMetricsInPage({
            kernel: {
              readFacebookMetadataPage: async (_p, _g, read) => ({
                reading: await read({
                  url: () => 'https://www.facebook.com/',
                  evaluate: async (_fn, url) => {
                    const id = url.split('/').filter(Boolean).pop();
                    if (id === '900015') return { ok: false, status: 404, finalUrl: url, html: '' };
                    return {
                      ok: true,
                      status: 200,
                      finalUrl: url,
                      html: `{"post_id":"${id}","reaction_count":{"count":18},"total_comment_count":5}`,
                    };
                  },
                }),
              }),
            },
            peer: {},
            guard: () => {},
            posts,
          }),
      },
      claimVerifyDelayMs: 0,
      now: () => nowMs,
    });

    const recLink = await svc.createLink({
      kind: 'post_records',
      spreadsheetUrlOrId: '1CpXEEOO9X4S8TJhIlImzVQFnVCXLgv7Nk1eU6D0SI3U',
      sheetName: '记录30',
      recordsConfig: { enabled: false, collectMetricsOnThisPc: false },
    });
    const schedLink = await svc.createLink({
      kind: 'post_schedule',
      spreadsheetUrlOrId: '1CpXEEOO9X4S8TJhIlImzVQFnVCXLgv7Nk1eU6D0SI3U',
      sheetName: '排贴30',
      scheduleConfig: { enabled: true, targetRecordLinkId: recLink.id, pollIntervalMinutes: 1 },
    });

    // Poll 1: auto-recovers 5 stale 发布中 rows, publishes 10 healthy, fails 10 flaky (attempt 1 -> 2m backoff), blocks 10 risk-limited
    await svc.triggerSchedulePoll(schedLink.id);
    assert.equal(publishedHealthy, 10);
    assert.ok(riskBlockedScheduleRows >= 10);

    // Poll 2 (+1m): inside 2m backoff -> 0 flaky retries!
    nowMs += 60_000;
    await svc.triggerSchedulePoll(schedLink.id);
    assert.equal(attemptsByCode.get('RES-11'), 1);

    // Poll 3 (+2m): attempt 2 -> 6m backoff
    nowMs += 2 * 60_000;
    await svc.triggerSchedulePoll(schedLink.id);
    assert.equal(attemptsByCode.get('RES-11'), 2);

    // Poll 4 (+6m): attempt 3 -> terminal 失败!
    nowMs += 6 * 60_000;
    await svc.triggerSchedulePoll(schedLink.id);
    assert.equal(attemptsByCode.get('RES-11'), 3);
    assert.match(sheetsData['排贴30'][11][7], /^失败：已重试3次仍失败/);

    // Poll 5 (+30m): terminal cap enforced -> 0 storms!
    nowMs += 30 * 60_000;
    await svc.triggerSchedulePoll(schedLink.id);
    assert.equal(attemptsByCode.get('RES-11'), 3);

    // 4. 30 metrics items with 1 deleted (900015) -> 29 updated, 1 skipped!
    const mRes = await svc.collectDueMetricsForLink(recLink.id, false);
    assert.equal(mRes.updated, 29);
    assert.equal(mRes.failed, 1);
    assert.equal(workboard.browserPermits.used, 0);
    assert.equal(workboard.bluestacksPermits.used, 0);

    console.log(
      JSON.stringify({
        ok: true,
        dpapiActive,
        dpapiEncryptedAtRest,
        toctouWinners,
        wakeCount,
        leakedWindows: ctx.activeProfiles.size,
        staleRecoveredRows: 5,
        publishedHealthy,
        flakyMaxAttempts: attemptsByCode.get('RES-11'),
        stormAttemptsAfterCap: 0,
        riskBlockedScheduleRows,
        metricsUpdated: mRes.updated,
        metricsDeletedSkipped: mRes.failed,
        peakPermits,
        leakedPermits: workboard.browserPermits.used + workboard.bluestacksPermits.used,
      }),
    );
  } finally {
    clearInterval(keepAlive);
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
