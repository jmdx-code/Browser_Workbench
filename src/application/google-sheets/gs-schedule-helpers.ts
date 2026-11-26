import {
  bluestacksDisplayTitle,
  isBluestacksPortraitResolution,
  type BluestacksInstance,
} from '../../shared/bluestacks.js';
import {
  extractFacebookTargetId,
  extractImageUrlFromCell,
  formatDateTimeForSheet,
  generateResourceCode,
  PAGE_TIMELINE_SYNTHETIC_GROUP_ID,
  parseAiLabelCell,
  parseBooleanCell,
  parseGroupsSpec,
  parseScheduleDateTimeMs,
  resolveRecordColumns,
  resolveScheduleColumns,
  toSheetsImageFormula,
  type GoogleSheetLink,
  type SheetGridRow,
  type SheetGridSnapshot,
} from '../../shared/google-sheets.js';
import type { BumperTarget } from '../../shared/group-bumper.js';
import { shuffleArray } from '../module-worker-pool.js';
import type { WorkspaceService } from '../workspace-service.js';
import {
  loadSheetColumnIndexMap,
  makeSheetRecordPost,
  safeAppendSheetLog,
  tryClaimProfile,
  wakeBrowserProfile,
  type GoogleSheetsContext,
} from './gs-context-and-library.js';

export interface DueScheduleRow {
  row: SheetGridRow;
  pageId: string;
  scheduledAt: number;
  caption: string;
  mediaSource: string;
  aiLabel: 'default' | 'on' | 'off';
  postTimeline: boolean;
  groupsSpecRaw: string;
  extraCategory: string | null;
  existingResourceCode: string;
  existingThumbnailUrl: string | null;
  prevTimelinePosted: boolean;
  prevPostedGroupIds: string[];
}

const makeStubTarget = (id: string, name: string): BumperTarget => ({
  id,
  name,
  avatarUrl: null,
  folderId: null,
  sortOrder: 0,
  totalBumpedCount: 0,
  createdAt: 0,
  updatedAt: 0,
});

export const resolvePageDisplayName = async (
  ctx: GoogleSheetsContext,
  pageId: string,
  fallback: string | null,
) =>
  (await ctx.deps.groupBumper.state()).pages.find(
    (p) => p.id.toLowerCase() === pageId.toLowerCase(),
  )?.name ||
  fallback ||
  pageId;

export async function updateScheduleRowByKey(
  ctx: GoogleSheetsContext,
  link: GoogleSheetLink,
  hintRowNumber: number,
  resourceCode: string,
  patch: {
    resourceCode?: string;
    thumbnailFormula?: string;
    status?: string;
    postedGroupsCount?: string;
  },
  cachedCols?: ReturnType<typeof resolveScheduleColumns>,
  allowInitialRowHint = false,
): Promise<void> {
  let cols = cachedCols;
  let rowNumber: number | null = allowInitialRowHint && hintRowNumber >= 2 ? hintRowNumber : null;
  if (!cols || hintRowNumber < 2) {
    const grid = await ctx.readGrid(link.id, { force: true });
    cols = resolveScheduleColumns(grid.headers);
    const matched =
      cols.resourceCode >= 0 && resourceCode.trim()
        ? grid.rows.find(
            (r) =>
              !r.isHintRow &&
              (r.displayValues[cols?.resourceCode ?? -1] ?? '').trim() === resourceCode.trim(),
          )
        : undefined;
    rowNumber = matched?.rowNumber ?? rowNumber;
  } else if (ctx.deps.sheetsApi.readColumnValues && cols.resourceCode >= 0 && resourceCode.trim()) {
    const found = (await loadSheetColumnIndexMap(ctx, link, cols.resourceCode))?.get(
      resourceCode.trim(),
    );
    if (found) rowNumber = found;
    else if (!allowInitialRowHint) return;
  } else if (hintRowNumber >= 2) rowNumber = hintRowNumber;
  if (rowNumber === null || rowNumber < 2) return;

  const updates = (
    [
      [patch.resourceCode, cols.resourceCode],
      [patch.thumbnailFormula, cols.thumbnail],
      [patch.status, cols.status],
      [patch.postedGroupsCount, cols.postedGroupsCount],
    ] as const
  ).flatMap(([value, colIndex]) =>
    value !== undefined && colIndex >= 0 ? [{ rowNumber, colIndex, value }] : [],
  );
  if (updates.length) {
    await ctx.deps.sheetsApi.batchUpdateCells(link.spreadsheetId, link.sheetName, updates);
    ctx.invalidateGridCache(link.id);
  }
}

export async function collectDueScheduleRows(
  ctx: GoogleSheetsContext,
  link: GoogleSheetLink,
  grid: SheetGridSnapshot,
  cols: ReturnType<typeof resolveScheduleColumns>,
  manualTrigger: boolean,
): Promise<DueScheduleRow[]> {
  const now = ctx.nowFn();
  const dueRows: DueScheduleRow[] = [];
  const cell = (row: SheetGridRow, idx: number) =>
    idx >= 0 ? (row.displayValues[idx] ?? '').trim() : '';

  for (const row of grid.rows) {
    if (row.isHintRow) continue;
    const statusText = cell(row, cols.status);
    const isExplicitRetry = /^(?:重试|重試|retry)$/i.test(statusText);
    if (
      statusText !== '' &&
      !/^(?:待发布|待發佈|待执行|待執行|等待|pending)$/i.test(statusText) &&
      !isExplicitRetry
    )
      continue;
    const pageId = extractFacebookTargetId(cell(row, cols.pageId), 'page');
    const scheduledAt = pageId
      ? parseScheduleDateTimeMs(cell(row, cols.date), cell(row, cols.time))
      : null;
    if (!pageId || !scheduledAt || scheduledAt > now) continue;
    const caption = cell(row, cols.caption);
    const mediaSource = cell(row, cols.media);
    if (!caption && !mediaSource) continue;
    const postTimeline =
      cols.postTimeline >= 0 ? parseBooleanCell(row.displayValues[cols.postTimeline]) : false;
    const groupsSpecRaw = cell(row, cols.groupsSpec);
    const extraCategory = cell(row, cols.groupCategory) || null;
    if (!postTimeline && parseGroupsSpec(groupsSpecRaw, extraCategory).mode === 'none') continue;

    const existingResourceCode = cell(row, cols.resourceCode);
    const prev = existingResourceCode
      ? await ctx.repo.getScheduleItem(link.id, existingResourceCode)
      : null;
    if (prev && (prev.status === 'completed' || prev.status === 'running')) continue;
    if (
      prev &&
      (prev.status === 'failed' || prev.status === 'partial') &&
      !isExplicitRetry &&
      !(manualTrigger && statusText === '')
    )
      continue;

    if (!manualTrigger && !isExplicitRetry && !prev && now - scheduledAt > 60 * 60_000) {
      const expiredCode = existingResourceCode || generateResourceCode(scheduledAt);
      await updateScheduleRowByKey(
        ctx,
        link,
        row.rowNumber,
        expiredCode,
        { resourceCode: expiredCode, status: '已过期跳过' },
        cols,
        !existingResourceCode,
      ).catch(() => {});
      await safeAppendSheetLog(
        ctx,
        link.id,
        'warn',
        'schedule_expired_skip',
        `[${expiredCode}] 排贴时间已超过 60 分钟，已自动标记「已过期跳过」（如需补发可在状态列填「重试」，或清空状态后点「立即发一次」）`,
      );
      continue;
    }

    dueRows.push({
      row,
      pageId,
      scheduledAt,
      caption,
      mediaSource,
      aiLabel: cols.aiLabel >= 0 ? parseAiLabelCell(row.displayValues[cols.aiLabel]) : 'default',
      postTimeline,
      groupsSpecRaw,
      extraCategory,
      existingResourceCode,
      existingThumbnailUrl: extractImageUrlFromCell(
        cols.thumbnail >= 0 ? (row.values[cols.thumbnail] ?? '').trim() : '',
      ),
      prevTimelinePosted: Boolean(prev?.timelinePosted),
      prevPostedGroupIds: [...(prev?.postedGroupIds ?? [])],
    });
  }
  return dueRows;
}

export async function findOrWakeProfileForPage(
  ctx: GoogleSheetsContext,
  pageId: string,
  linkId: string,
  linkTitle: string,
): Promise<
  | {
      status: 'found';
      profile: Awaited<ReturnType<WorkspaceService['snapshot']>>['profiles'][number];
      wokeFromOffline: boolean;
    }
  | { status: 'busy'; label: string }
  | { status: 'not_found' }
> {
  const norm = pageId.trim().toLowerCase();
  const candidates = (await ctx.deps.workspace.snapshot()).profiles.filter(
    (p) =>
      (p.account.id ?? '').trim().toLowerCase() === norm &&
      !['restricted', 'verification', 'logged-out'].includes(p.account.state),
  );
  if (!candidates.length) return { status: 'not_found' };
  const claimMeta = {
    linkId,
    kind: 'post_schedule' as const,
    title: linkTitle,
    status: '准备排贴发布…',
  };
  let sawBusyLabel: string | null = null;
  for (const p of candidates) {
    if (!p.online) continue;
    if (await tryClaimProfile(ctx, p.id, claimMeta))
      return { status: 'found', profile: p, wokeFromOffline: false };
    sawBusyLabel = p.browserName || p.alias || p.id;
  }
  const offline = candidates.find((p) => !p.online);
  if (
    offline &&
    (await wakeBrowserProfile(ctx, offline.id, () => ctx.cancelledLinks.has(linkId)))
  ) {
    const ready = (await ctx.deps.workspace.snapshot()).profiles.find(
      (p) => p.id === offline.id && p.online,
    );
    if (ready && (await tryClaimProfile(ctx, ready.id, claimMeta)))
      return { status: 'found', profile: ready, wokeFromOffline: true };
  }
  return sawBusyLabel ? { status: 'busy', label: sawBusyLabel } : { status: 'not_found' };
}

export async function findBluestacksInstanceForPage(
  ctx: GoogleSheetsContext,
  pageId: string,
  pageName: string,
  link: GoogleSheetLink,
): Promise<
  | { status: 'found'; instance: BluestacksInstance }
  | { status: 'busy'; label: string }
  | { status: 'not_found' }
> {
  if (!ctx.deps.bluestacks) return { status: 'not_found' };
  const bs = await ctx.deps.bluestacks.state(false);
  const folderIds = new Set(link.scheduleConfig?.bluestacksFolderIds ?? []);
  const explicitIds = new Set(link.scheduleConfig?.bluestacksInstanceIds ?? []);
  const hasPool = folderIds.size > 0 || explicitIds.size > 0;
  const eligible = bs.instances.filter(
    (inst) =>
      isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight) &&
      !['restricted', 'verification', 'logged-out', 'missing-app'].includes(inst.accountState) &&
      (!hasPool ||
        (inst.folderId !== null && folderIds.has(inst.folderId)) ||
        explicitIds.has(inst.id)),
  );
  if (!eligible.length) return { status: 'not_found' };
  const normId = pageId.trim().toLowerCase();
  const normName = pageName.trim().toLowerCase();
  const seen = new Set<string>();
  const ordered: BluestacksInstance[] = [];
  for (const bucket of [
    eligible.filter(
      (i) =>
        (i.numericAccountId ?? '').trim().toLowerCase() === normId ||
        i.accountId.trim().toLowerCase() === normId,
    ),
    eligible.filter(
      (i) =>
        Boolean(normName) &&
        normName !== normId &&
        (i.accountName.trim().toLowerCase() === normName ||
          (i.managedIdentities ?? []).some((m) => m.name.trim().toLowerCase() === normName)),
    ),
  ]) {
    for (const inst of [...bucket].sort((a, b) => Number(b.online) - Number(a.online))) {
      if (!seen.has(inst.id)) {
        seen.add(inst.id);
        ordered.push(inst);
      }
    }
  }
  if (!ordered.length) return { status: 'not_found' };
  const claimMeta = {
    linkId: link.id,
    kind: 'post_schedule' as const,
    title: link.title,
    status: '准备蓝蝶排贴发布…',
  };
  for (const inst of ordered)
    if (await tryClaimProfile(ctx, inst.id, claimMeta)) return { status: 'found', instance: inst };
  return { status: 'busy', label: ordered[0] ? bluestacksDisplayTitle(ordered[0]) : pageId };
}

export async function buildScheduleTargets(
  ctx: GoogleSheetsContext,
  pageName: string,
  postTimeline: boolean,
  groupsSpecRaw: string,
  extraCategory: string | null,
  excludeGroupIds: readonly string[] = [],
): Promise<BumperTarget[]> {
  const targets: BumperTarget[] = postTimeline
    ? [makeStubTarget(PAGE_TIMELINE_SYNTHETIC_GROUP_ID, `${pageName}（专页时间线）`)]
    : [];
  const spec = parseGroupsSpec(groupsSpecRaw, extraCategory);
  if (spec.mode === 'none') return targets;
  const excludedSet = new Set(excludeGroupIds.map((id) => id.trim().toLowerCase()));
  const [bumperState, folders] = await Promise.all([
    ctx.deps.groupBumper.state(),
    ctx.deps.workspace.repository.targetFolders?.('shared_groups') ?? Promise.resolve([]),
  ]);
  const allGroups = bumperState.groups;
  if (spec.mode === 'explicit') {
    const byId = new Map(allGroups.map((g) => [g.id.toLowerCase(), g]));
    const seen = new Set<string>();
    for (const gid of spec.groupIds) {
      const key = gid.toLowerCase();
      if (seen.has(key) || excludedSet.has(key)) continue;
      seen.add(key);
      targets.push(byId.get(key) ?? makeStubTarget(gid, gid));
    }
    return targets;
  }
  const remainingCount = Math.max(0, spec.count - excludedSet.size);
  if (!remainingCount) return targets;
  let pool = allGroups.filter((g) => !excludedSet.has(g.id.toLowerCase()));
  if (spec.category) {
    const catLower = spec.category.toLowerCase();
    const matchFolders = new Set(
      folders.filter((f) => f.name.trim().toLowerCase() === catLower).map((f) => f.id),
    );
    pool = pool.filter((g) => g.folderId !== null && matchFolders.has(g.folderId));
  }
  targets.push(...shuffleArray(pool).slice(0, remainingCount));
  return targets;
}

export async function appendPostToRecordsSheet(
  ctx: GoogleSheetsContext,
  recordLinkId: string,
  entry: {
    postedAtMs: number;
    groupId: string;
    groupName: string;
    pageId: string;
    pageName: string;
    postUrl: string;
    postId: string | null;
    postCode: string;
    resourceCode: string;
    thumbnailUrl: string | null;
  },
  headersCache: Map<string, string[]>,
): Promise<void> {
  const recLink = await ctx.repo.getLink(recordLinkId);
  if (!recLink || recLink.kind !== 'post_records') return;
  let headers = headersCache.get(recLink.id);
  if (!headers) {
    headers = ctx.deps.sheetsApi.readHeaderRow
      ? await ctx.deps.sheetsApi.readHeaderRow(recLink.spreadsheetId, recLink.sheetName)
      : (await ctx.readGrid(recLink.id)).headers;
    headersCache.set(recLink.id, headers);
  }
  const cols = resolveRecordColumns(headers);
  const maxCol = Math.max(
    cols.postedAt,
    cols.groupId,
    cols.groupName,
    cols.pageId,
    cols.pageName,
    cols.postUrl,
    cols.postCode,
    cols.thumbnail,
    0,
  );
  const row: Array<string | null> = new Array<string | null>(maxCol + 1).fill(null);
  const postedAtText = formatDateTimeForSheet(entry.postedAtMs);
  for (const [col, val] of [
    [cols.postedAt, postedAtText],
    [cols.groupId, entry.groupId],
    [cols.groupName, entry.groupName],
    [cols.pageId, entry.pageId],
    [cols.pageName, entry.pageName],
    [cols.postUrl, entry.postUrl],
    [cols.postCode, entry.postCode],
    [cols.thumbnail, entry.thumbnailUrl ? toSheetsImageFormula(entry.thumbnailUrl) : null],
  ] as const) {
    if (col >= 0 && val !== null) row[col] = val;
  }
  await ctx.deps.sheetsApi.appendRows(recLink.spreadsheetId, recLink.sheetName, [row]);
  ctx.invalidateGridCache(recLink.id);
  await ctx.repo.upsertRecordPost(
    makeSheetRecordPost(ctx.nowFn(), recLink.id, entry.postCode, entry.postUrl, null, {
      resourceCode: entry.resourceCode,
      postedAtText,
      postedAtMs: entry.postedAtMs,
      groupId: entry.groupId,
      groupName: entry.groupName,
      pageId: entry.pageId,
      pageName: entry.pageName,
      postId: entry.postId,
      thumbnailUrl: entry.thumbnailUrl,
    }),
  );
}
