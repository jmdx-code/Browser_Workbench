import { ProductError } from '../../domain/workspace.js';
import {
  evaluateMetricsEligibility,
  extractFacebookPostIdFromUrl,
  extractImageUrlFromCell,
  isDirectFacebookPostUrl,
  parseScheduleDateTimeMs,
  resolveRecordColumns,
  type GoogleSheetLink,
  type SheetGridRow,
} from '../../shared/google-sheets.js';
import type { ScrapedPostMetrics, SheetRecordPostPortRecord } from '../google-sheets-ports.js';
import {
  loadSheetColumnIndexMap,
  makeSheetRecordPost,
  METRICS_AUTO_MAX_AGE_HOURS,
  METRICS_BACKOFF_STEPS_MS,
  releaseProfile,
  requireLink,
  resolveBoundBumperProfiles,
  runSerializedRecordWrite,
  tryClaimProfile,
  type GoogleSheetsContext,
} from './gs-context-and-library.js';

export function resolveRecordRowIdentity(
  row: SheetGridRow,
  cols: ReturnType<typeof resolveRecordColumns>,
) {
  const postUrl = (row.displayValues[cols.postUrl] ?? '').trim();
  const rawCode = cols.postCode >= 0 ? (row.displayValues[cols.postCode] ?? '').trim() : '';
  const postId = extractFacebookPostIdFromUrl(postUrl);
  return { postUrl, postId, postCode: rawCode || `URL-${postId ?? row.rowNumber}` };
}

export function buildRecordFromRow(
  ctx: GoogleSheetsContext,
  linkId: string,
  row: SheetGridRow,
  cols: ReturnType<typeof resolveRecordColumns>,
  postCode: string,
  postUrl: string,
  postId: string | null,
  existing: SheetRecordPostPortRecord | null,
): SheetRecordPostPortRecord {
  const cell = (idx: number) => (idx >= 0 ? (row.displayValues[idx] ?? '').trim() : '');
  const postedAtText = cell(cols.postedAt);
  const numOr = (idx: number, fb: number | null) =>
    /^\d+$/.test(cell(idx)) ? Number(cell(idx)) : fb;
  return makeSheetRecordPost(ctx.nowFn(), linkId, postCode, postUrl, existing, {
    resourceCode: postCode.split('-').slice(0, 2).join('-'),
    postedAtText: postedAtText || existing?.postedAtText || '',
    postedAtMs:
      (postedAtText ? parseScheduleDateTimeMs(postedAtText, '') : null) ??
      existing?.postedAtMs ??
      null,
    groupId: cell(cols.groupId) || existing?.groupId || '',
    groupName: cell(cols.groupName) || existing?.groupName || '',
    pageId: cell(cols.pageId) || existing?.pageId || '',
    pageName: cell(cols.pageName) || existing?.pageName || '',
    postId: postId ?? existing?.postId ?? null,
    thumbnailUrl:
      (cols.thumbnail >= 0 ? extractImageUrlFromCell(row.values[cols.thumbnail]) : null) ??
      existing?.thumbnailUrl ??
      null,
    likesCount: numOr(cols.likes, existing?.likesCount ?? null),
    commentsCount: numOr(cols.comments, existing?.commentsCount ?? null),
    localBumpedCount: Math.max(existing?.localBumpedCount ?? 0, numOr(cols.machineColumn, 0) ?? 0),
  });
}

export async function resolveSheetRowIndexMaps(
  ctx: GoogleSheetsContext,
  link: GoogleSheetLink,
  cols: { postCode: number; postUrl: number },
  entries?: ReadonlyArray<{ postCode: string }>,
) {
  const rowByCode =
    (await loadSheetColumnIndexMap(ctx, link, cols.postCode)) ?? new Map<string, number>();
  const usedCode = Boolean(ctx.deps.sheetsApi.readColumnValues && cols.postCode >= 0);
  const needUrl =
    cols.postCode < 0 ||
    Boolean(entries?.some((e) => !e.postCode.trim() || !rowByCode.has(e.postCode.trim())));
  const rowByUrl =
    (needUrl ? await loadSheetColumnIndexMap(ctx, link, cols.postUrl) : null) ??
    new Map<string, number>();
  const usedUrl = Boolean(ctx.deps.sheetsApi.readColumnValues && needUrl && cols.postUrl >= 0);
  return { rowByCode, rowByUrl, usedKeyLookup: usedCode || usedUrl };
}

export async function writeBatchRecordCellsByKey(
  ctx: GoogleSheetsContext,
  link: GoogleSheetLink,
  colIndex: number,
  entries: ReadonlyArray<{
    postCode: string;
    postUrl: string;
    value: string;
    hintRowNumber?: number;
  }>,
  cachedCols?: ReturnType<typeof resolveRecordColumns>,
): Promise<void> {
  if (!entries.length) return;
  const { rowByCode, rowByUrl, usedKeyLookup } = cachedCols
    ? await resolveSheetRowIndexMaps(ctx, link, cachedCols, entries)
    : {
        rowByCode: new Map<string, number>(),
        rowByUrl: new Map<string, number>(),
        usedKeyLookup: false,
      };
  const updates: Array<{ rowNumber: number; colIndex: number; value: string }> = [];
  const unresolved: Array<(typeof entries)[number]> = [];
  for (const e of entries) {
    const rowNum = rowByCode.get(e.postCode.trim()) ?? rowByUrl.get(e.postUrl.trim());
    if (rowNum && rowNum >= 2) updates.push({ rowNumber: rowNum, colIndex, value: e.value });
    else if (!usedKeyLookup) unresolved.push(e);
  }
  if (unresolved.length) {
    const grid = await ctx.readGrid(link.id, { force: true });
    const cols = resolveRecordColumns(grid.headers);
    for (const e of unresolved) {
      const matched = grid.rows.find((r) => {
        if (r.isHintRow) return false;
        const code = cols.postCode >= 0 ? (r.displayValues[cols.postCode] ?? '').trim() : '';
        const url = cols.postUrl >= 0 ? (r.displayValues[cols.postUrl] ?? '').trim() : '';
        return (code && code === e.postCode.trim()) || (url && url === e.postUrl.trim());
      });
      if (matched) updates.push({ rowNumber: matched.rowNumber, colIndex, value: e.value });
    }
  }
  if (updates.length) {
    await ctx.deps.sheetsApi.batchUpdateCells(link.spreadsheetId, link.sheetName, updates);
    ctx.invalidateGridCache(link.id);
  }
}

export async function ensureMachineColumnAndWriteCells(
  ctx: GoogleSheetsContext,
  link: GoogleSheetLink,
  headers: readonly string[],
  machineName: string,
  cols: ReturnType<typeof resolveRecordColumns>,
  entries: ReadonlyArray<{
    postCode: string;
    postUrl: string;
    value: string;
    hintRowNumber?: number;
  }>,
): Promise<number> {
  const machineColIndex = await ctx.deps.sheetsApi.ensureHeaderColumn(
    link.spreadsheetId,
    link.sheetName,
    headers,
    machineName,
  );
  if (machineColIndex >= headers.length) ctx.invalidateGridCache(link.id);
  if (entries.length) await writeBatchRecordCellsByKey(ctx, link, machineColIndex, entries, cols);
  return machineColIndex;
}

async function claimMetricsFallbackProfile(
  ctx: GoogleSheetsContext,
  link: GoogleSheetLink,
): Promise<string | null> {
  const cfg = link.recordsConfig;
  const bound = cfg
    ? await resolveBoundBumperProfiles(ctx, cfg.bumperProfileGroupIds, cfg.bumperProfileIds)
    : [];
  const onlineLoggedIn = (await ctx.deps.workspace.snapshot()).profiles.filter(
    (p) => p.online && p.account.state === 'logged-in',
  );
  const claimMeta = {
    linkId: link.id,
    kind: 'metrics' as const,
    title: link.title,
    status: '补采私密贴赞/评数…',
  };
  for (const c of [...bound, ...onlineLoggedIn]) {
    if (await tryClaimProfile(ctx, c.id, claimMeta)) return c.id;
  }
  return null;
}

export async function collectDueMetricsForLink(
  ctx: GoogleSheetsContext,
  linkId: string,
  forceAllEligible: boolean,
): Promise<{ updated: number; failed: number; summary: string }> {
  if (ctx.runningMetricsLinks.has(linkId))
    return { updated: 0, failed: 0, summary: '赞/评采集正在运行中' };
  ctx.runningMetricsLinks.add(linkId);
  const abortCtrl = new AbortController();
  ctx.metricsAbortByLink.set(linkId, abortCtrl);
  let claimedScraperProfileId: string | null = null;

  try {
    const link = await requireLink(ctx, linkId);
    if (link.kind !== 'post_records')
      throw new ProductError('SHEET_KIND_MISMATCH', '只有发帖记录表支持采集点赞和留言数', 400);
    if (!ctx.deps.automation)
      throw new ProductError('SHEET_AUTOMATION_UNAVAILABLE', '采集桥接未就绪', 503);

    const grid = await ctx.readGrid(link.id, { force: forceAllEligible });
    const cols = resolveRecordColumns(grid.headers, link.recordsConfig?.machineName);
    if (cols.postUrl < 0 || (cols.likes < 0 && cols.comments < 0))
      return { updated: 0, failed: 0, summary: '表格未包含「贴文链接」或「点赞/留言」表头' };

    const knownByCode = new Map(
      (await ctx.repo.listRecordPosts(link.id)).map((r) => [r.postCode, r]),
    );
    const now = ctx.nowFn();
    const dueTargets: Array<{
      postCode: string;
      postUrl: string;
      rowNumber: number;
      stageTarget: '24h' | '72h';
      postedAtMs: number;
    }> = [];

    for (const row of grid.rows) {
      if (row.isHintRow) continue;
      const { postUrl, postCode } = resolveRecordRowIdentity(row, cols);
      if (!isDirectFacebookPostUrl(postUrl)) continue;
      const existing = knownByCode.get(postCode);
      const postedAtText =
        cols.postedAt >= 0 ? (row.displayValues[cols.postedAt] ?? '').trim() : '';
      const postedAtMs =
        (postedAtText ? parseScheduleDateTimeMs(postedAtText, '') : null) ??
        existing?.postedAtMs ??
        null;
      let stageTarget: '24h' | '72h' | null = null;
      if (forceAllEligible) {
        const ageHours = postedAtMs ? (now - postedAtMs) / 3_600_000 : 25;
        if (ageHours >= 24) stageTarget = ageHours >= 72 ? '72h' : '24h';
      } else {
        const backoff = ctx.metricsFailureBackoff.get(`${link.id}:${postCode}`);
        if (!backoff || backoff.retryAfter <= now) {
          stageTarget = evaluateMetricsEligibility(
            postedAtMs,
            existing?.metricsStage ?? 0,
            now,
            METRICS_AUTO_MAX_AGE_HOURS,
          );
        }
      }
      if (stageTarget)
        dueTargets.push({
          postCode,
          postUrl,
          rowNumber: row.rowNumber,
          stageTarget,
          postedAtMs: postedAtMs ?? 0,
        });
    }

    if (!dueTargets.length)
      return { updated: 0, failed: 0, summary: '暂无满 24h/72h 待采集赞/评的贴文' };
    dueTargets.sort((a, b) => b.postedAtMs - a.postedAtMs || b.rowNumber - a.rowNumber);
    const batch = dueTargets.slice(0, 30);
    await ctx.repo.updateLinkRuntime(link.id, {
      activeJobText: `正在无账号直采 ${batch.length} 条贴文赞/评数…`,
    });

    const scrapedByCode = new Map<string, ScrapedPostMetrics>();
    let usedAnonymousCount = 0;
    let fallbackNeeded: typeof batch = [];
    if (ctx.deps.automation.scrapePublicPostMetrics) {
      for (const item of await ctx.deps.automation.scrapePublicPostMetrics({
        posts: batch.map((b) => ({ postCode: b.postCode, postUrl: b.postUrl })),
        signal: abortCtrl.signal,
      })) {
        scrapedByCode.set(item.postCode, item);
        if (item.likes !== null || item.comments !== null) usedAnonymousCount++;
        else if (item.needsAuthFallback) {
          const meta = batch.find((b) => b.postCode === item.postCode);
          if (meta) fallbackNeeded.push(meta);
        }
      }
    } else fallbackNeeded = [...batch];

    let privateSkippedNoBrowser = 0;
    if (fallbackNeeded.length && !abortCtrl.signal.aborted) {
      claimedScraperProfileId = await claimMetricsFallbackProfile(ctx, link);
      if (claimedScraperProfileId) {
        await ctx.repo.updateLinkRuntime(link.id, {
          activeJobText: `正在用浏览器补采 ${fallbackNeeded.length} 条私密贴赞/评数…`,
        });
        for (const item of await ctx.deps.automation.scrapePostMetrics({
          profileId: claimedScraperProfileId,
          posts: fallbackNeeded.map((b) => ({ postCode: b.postCode, postUrl: b.postUrl })),
          signal: abortCtrl.signal,
        })) {
          scrapedByCode.set(item.postCode, item);
        }
      } else privateSkippedNoBrowser = fallbackNeeded.length;
    }

    const { rowByCode, rowByUrl, usedKeyLookup } = await resolveSheetRowIndexMaps(
      ctx,
      link,
      cols,
      batch,
    );
    const cellUpdates: Array<{ rowNumber: number; colIndex: number; value: string }> = [];
    const pendingDbCommits: Array<{
      targetMeta: (typeof batch)[number];
      item: ScrapedPostMetrics;
    }> = [];
    let updated = 0;
    let failed = 0;

    for (const targetMeta of batch) {
      const item = scrapedByCode.get(targetMeta.postCode);
      const writeRow =
        item && (item.likes !== null || item.comments !== null)
          ? (rowByCode.get(targetMeta.postCode.trim()) ??
            rowByUrl.get(targetMeta.postUrl.trim()) ??
            (usedKeyLookup ? undefined : targetMeta.rowNumber))
          : undefined;
      if (!item || !writeRow || writeRow < 2) {
        failed++;
        const key = `${link.id}:${targetMeta.postCode}`;
        const attempts = (ctx.metricsFailureBackoff.get(key)?.attempts ?? 0) + 1;
        const delayMs =
          METRICS_BACKOFF_STEPS_MS[Math.min(attempts - 1, METRICS_BACKOFF_STEPS_MS.length - 1)] ??
          86400_000;
        ctx.metricsFailureBackoff.delete(key);
        ctx.metricsFailureBackoff.set(key, { attempts, retryAfter: ctx.nowFn() + delayMs });
        while (ctx.metricsFailureBackoff.size > 5_000) {
          const oldest = ctx.metricsFailureBackoff.keys().next().value;
          if (oldest === undefined) break;
          ctx.metricsFailureBackoff.delete(oldest);
        }
        continue;
      }
      ctx.metricsFailureBackoff.delete(`${link.id}:${targetMeta.postCode}`);
      if (item.likes !== null && cols.likes >= 0)
        cellUpdates.push({ rowNumber: writeRow, colIndex: cols.likes, value: String(item.likes) });
      if (item.comments !== null && cols.comments >= 0)
        cellUpdates.push({
          rowNumber: writeRow,
          colIndex: cols.comments,
          value: String(item.comments),
        });
      pendingDbCommits.push({ targetMeta, item });
    }

    if (cellUpdates.length) {
      await ctx.deps.sheetsApi.batchUpdateCells(link.spreadsheetId, link.sheetName, cellUpdates);
      ctx.invalidateGridCache(link.id);
    }
    for (const { targetMeta, item } of pendingDbCommits) {
      await runSerializedRecordWrite(ctx, `${link.id}:${item.postCode}`, async () => {
        const prev =
          (await ctx.repo.getRecordPost(link.id, item.postCode)) ?? knownByCode.get(item.postCode);
        const ts = ctx.nowFn();
        await ctx.repo.upsertRecordPost(
          makeSheetRecordPost(ts, link.id, item.postCode, item.postUrl, prev, {
            postId: prev?.postId ?? extractFacebookPostIdFromUrl(item.postUrl),
            likesCount: item.likes ?? prev?.likesCount ?? null,
            commentsCount: item.comments ?? prev?.commentsCount ?? null,
            metricsStage:
              targetMeta.stageTarget === '72h' ? 2 : Math.max(prev?.metricsStage ?? 0, 1),
            metricsUpdatedAt: ts,
          }),
        );
      });
      updated++;
    }

    const detail = [
      usedAnonymousCount > 0 ? `无账号直采 ${usedAnonymousCount} 条` : '',
      privateSkippedNoBrowser > 0
        ? `${privateSkippedNoBrowser} 条私密贴需在线浏览器补采`
        : failed > 0
          ? `未读到 ${failed} 条`
          : '',
    ]
      .filter(Boolean)
      .join('，');
    const summary = `采集赞/评完成：成功更新 ${updated} 条${detail ? `（${detail}）` : ''}`;
    await ctx.repo.updateLinkRuntime(link.id, {
      lastMetricsRunAt: ctx.nowFn(),
      activeJobText: '',
      ...(forceAllEligible ? { lastSyncSummary: summary } : {}),
    });
    await ctx.repo.appendLog({
      linkId: link.id,
      level: !updated && privateSkippedNoBrowser > 0 ? 'warn' : 'info',
      action: 'metrics_scrape',
      summary,
    });
    return { updated, failed, summary };
  } finally {
    if (claimedScraperProfileId) releaseProfile(ctx, claimedScraperProfileId, linkId);
    ctx.runningMetricsLinks.delete(linkId);
    ctx.metricsAbortByLink.delete(linkId);
  }
}
