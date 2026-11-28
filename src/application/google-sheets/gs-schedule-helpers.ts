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
import { ProductError } from '../../domain/workspace.js';
import type { BumperTarget } from '../../shared/group-bumper.js';
import { shuffleArray } from '../module-worker-pool.js';
import type { Workboard } from '../workboard.js';
import type { WorkspaceService } from '../workspace-service.js';
import {
  loadSheetColumnIndexMap,
  makeSheetRecordPost,
  releaseProfile,
  safeAppendSheetLog,
  tryClaimProfile,
  wakeBrowserProfile,
  type GoogleSheetsContext,
} from './gs-context-and-library.js';
const STUCK_STATUS_RE = /^(?:蓝蝶)?发布中(?:\(([^)#]+)#[^)]*\))?…?\s*$/i;
export async function resetStuckRowsForLink(
  ctx: GoogleSheetsContext,
  linkId: string,
  options?: { onlyThisMachine?: boolean; allowDuringPollSetup?: boolean },
): Promise<{ linkId: string; resetCount: number; rowNumbers: number[]; summary: string }> {
  const link = await ctx.repo.getLink(linkId);
  if (!link) throw new ProductError('SHEET_LINK_NOT_FOUND', '表格连接不存在', 404);
  if (link.kind !== 'post_schedule')
    throw new ProductError('SHEET_KIND_MISMATCH', '只有排贴表支持重置卡死行', 400);
  const grid = await ctx.readGrid(link.id, { force: true });
  const cols = resolveScheduleColumns(grid.headers);
  if (cols.status < 0)
    throw new ProductError('SHEET_HEADER_MISSING', '排贴表缺少「发布状态」列', 400);
  const pcTag = ((await ctx.repo.getImageHostConfig()).defaultMachineName || '本机')
    .trim()
    .slice(0, 16)
    .toLowerCase();
  const rowNumbers: number[] = [];
  const updates: Array<{ rowNumber: number; colIndex: number; value: string }> = [];
  const codesToReset = new Set<string>();
  for (const row of grid.rows) {
    if (row.isHintRow) continue;
    const statusText = (row.displayValues[cols.status] ?? '').trim();
    const m = STUCK_STATUS_RE.exec(statusText);
    if (!m) continue;
    if (options?.onlyThisMachine) {
      const rowMachine = (m[1] ?? '').trim().toLowerCase();
      if (
        !rowMachine ||
        rowMachine !== pcTag ||
        (!options.allowDuringPollSetup && ctx.runningScheduleLinks.has(link.id))
      )
        continue;
    }
    rowNumbers.push(row.rowNumber);
    updates.push({ rowNumber: row.rowNumber, colIndex: cols.status, value: '待发布' });
    const code = cols.resourceCode >= 0 ? (row.displayValues[cols.resourceCode] ?? '').trim() : '';
    if (code) codesToReset.add(code);
  }
  if (updates.length) {
    await ctx.deps.sheetsApi.batchUpdateCells(link.spreadsheetId, link.sheetName, updates);
    ctx.invalidateGridCache(link.id);
    for (const code of codesToReset) {
      const prev = await ctx.repo.getScheduleItem(link.id, code);
      if (prev) {
        await ctx.repo.upsertScheduleItem({
          ...prev,
          status: prev.timelinePosted || prev.postedGroupCount > 0 ? 'partial' : 'pending',
          attemptCount: 0,
          nextRetryAt: null,
          lastError: null,
          errorMessage: options?.onlyThisMachine
            ? '启动检测到上次遗留发布中状态，已自动重置待续跑'
            : '已手动重置卡死状态，等待重新调度',
          updatedAt: ctx.nowFn(),
        });
      }
    }
  }
  const summary = updates.length
    ? `${options?.onlyThisMachine ? '自动恢复' : '已重置'} ${updates.length} 条卡死排贴行`
    : '未发现处于卡死发布中的排贴行';
  if (updates.length) {
    await safeAppendSheetLog(ctx, link.id, 'warn', 'schedule_reset_stuck', summary);
    await ctx.repo.updateLinkRuntime(link.id, { lastSyncSummary: summary });
  }
  return { linkId: link.id, resetCount: updates.length, rowNumbers, summary };
}
export const SCHEDULE_RETRY_BACKOFF_MS = [2 * 60_000, 6 * 60_000, 18 * 60_000] as const;
export const SCHEDULE_MAX_ATTEMPTS = 3;
export const isTerminalScheduleError = (message: string): boolean =>
  /受限|restricted|verification|logged-out|checkpoint|RISK_LIMIT|日限额|未匹配到可发布的目标小组|未找到当前专页|未找到匹配专页|可用蓝蝶模拟器|对应的浏览器/i.test(
    message,
  );
export function computeScheduleRetryState(
  prevAttempts: number,
  errorMsg: string,
  nowMs: number,
  hasPartialProgress: boolean,
): {
  terminal: boolean;
  status: 'pending' | 'partial' | 'failed';
  attemptCount: number;
  nextRetryAt: number | null;
  delayMs: number;
  sheetStatus: string;
} {
  const attemptCount = Math.max(0, prevAttempts) + 1;
  const terminal = isTerminalScheduleError(errorMsg) || attemptCount >= SCHEDULE_MAX_ATTEMPTS;
  if (terminal) {
    const suffix =
      !isTerminalScheduleError(errorMsg) && attemptCount >= SCHEDULE_MAX_ATTEMPTS
        ? `已重试${SCHEDULE_MAX_ATTEMPTS}次仍失败·${errorMsg.slice(0, 32)}`
        : errorMsg.slice(0, 48);
    return {
      terminal: true,
      status: hasPartialProgress ? 'partial' : 'failed',
      attemptCount,
      nextRetryAt: null,
      delayMs: 0,
      sheetStatus: `失败：${suffix}`,
    };
  }
  const delayMs =
    SCHEDULE_RETRY_BACKOFF_MS[Math.min(attemptCount - 1, SCHEDULE_RETRY_BACKOFF_MS.length - 1)] ??
    18 * 60_000;
  const mins = Math.max(1, Math.round(delayMs / 60_000));
  return {
    terminal: false,
    status: hasPartialProgress ? 'partial' : 'pending',
    attemptCount,
    nextRetryAt: nowMs + delayMs,
    delayMs,
    sheetStatus: `待重试(${attemptCount}/${SCHEDULE_MAX_ATTEMPTS}·${mins}m后)：${errorMsg.slice(0, 28)}`,
  };
}
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
  prevAttemptCount: number;
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
    else if (!allowInitialRowHint)
      throw new Error(`排贴表回写定位失败：未找到资源编号 [${resourceCode}]`);
  } else if (hintRowNumber >= 2) rowNumber = hintRowNumber;
  if (rowNumber === null || rowNumber < 2)
    throw new Error(`排贴表回写失败：行号无效 [${resourceCode}]`);
  if (patch.status !== undefined && cols.status < 0)
    throw new Error('排贴表缺少「发布状态」列，无法回写状态');
  if (patch.resourceCode !== undefined && cols.resourceCode < 0)
    throw new Error('排贴表缺少「资源编号」列，无法回写编号');
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
  if (!updates.length) throw new Error(`排贴表无可回写字段 [${resourceCode}]`);
  await ctx.deps.sheetsApi.batchUpdateCells(link.spreadsheetId, link.sheetName, updates);
  ctx.invalidateGridCache(link.id);
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
      !/^(?:待发布|待發佈|待执行|待執行|等待|pending|待重试)/i.test(statusText) &&
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
      prev.status === 'failed' &&
      !isExplicitRetry &&
      !(manualTrigger && statusText === '')
    )
      continue;
    if (
      prev &&
      prev.status === 'partial' &&
      !isExplicitRetry &&
      !(manualTrigger && statusText === '') &&
      (prev.nextRetryAt == null || (prev.attemptCount ?? 0) >= SCHEDULE_MAX_ATTEMPTS)
    )
      continue;
    if (prev && !isExplicitRetry && prev.nextRetryAt != null) {
      if ((prev.attemptCount ?? 0) >= SCHEDULE_MAX_ATTEMPTS) continue;
      if (now < prev.nextRetryAt) continue;
    }
    if (
      prev &&
      prev.status === 'pending' &&
      !isExplicitRetry &&
      (prev.attemptCount ?? 0) >= SCHEDULE_MAX_ATTEMPTS
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
      prevAttemptCount: isExplicitRetry ? 0 : (prev?.attemptCount ?? 0),
    });
  }
  return dueRows;
}
interface ManagedIdentityLike {
  id?: string | null;
  name?: string | null;
  identityType?: 'personal' | 'page' | string;
}
type ProfileWithOptionalManaged = Awaited<
  ReturnType<WorkspaceService['snapshot']>
>['profiles'][number] & {
  managedIdentities?: readonly ManagedIdentityLike[];
  account: Awaited<ReturnType<WorkspaceService['snapshot']>>['profiles'][number]['account'] & {
    managedIdentities?: readonly ManagedIdentityLike[];
  };
};
export async function findOrWakeProfileForPage(
  ctx: GoogleSheetsContext,
  pageId: string,
  linkId: string,
  linkTitle: string,
  pageName?: string | null,
  workboard?: Workboard,
): Promise<
  | {
      status: 'found';
      profile: Awaited<ReturnType<WorkspaceService['snapshot']>>['profiles'][number];
      wokeFromOffline: boolean;
      needsPageSwitch: boolean;
    }
  | { status: 'busy'; label: string }
  | { status: 'risk_limited'; reason: string }
  | { status: 'not_found' }
> {
  const norm = pageId.trim().toLowerCase();
  const normName = (pageName ?? '').trim().toLowerCase();
  const allProfiles = (await ctx.deps.workspace.snapshot())
    .profiles as ProfileWithOptionalManaged[];
  const eligible = allProfiles.filter(
    (p) => !['restricted', 'verification', 'logged-out'].includes(p.account.state),
  );
  const directMatches = eligible
    .filter((p) => (p.account.id ?? '').trim().toLowerCase() === norm)
    .map((p) => ({ profile: p, needsPageSwitch: false }));
  const directSet = new Set(directMatches.map((m) => m.profile.id));
  const managedMatches = eligible
    .filter((p) => {
      if (directSet.has(p.id)) return false;
      const list = p.managedIdentities ?? p.account.managedIdentities ?? [];
      return list.some(
        (m) =>
          m.identityType !== 'personal' &&
          (((m.id ?? '').trim().toLowerCase() === norm && Boolean(norm)) ||
            (Boolean(normName) &&
              normName !== norm &&
              (m.name ?? '').trim().toLowerCase() === normName)),
      );
    })
    .map((p) => ({ profile: p, needsPageSwitch: true }));
  const candidates = [...directMatches, ...managedMatches];
  if (!candidates.length) return { status: 'not_found' };
  const claimMeta = {
    linkId,
    kind: 'post_schedule' as const,
    title: linkTitle,
    status: '准备排贴发布…',
  };
  let sawBusyLabel: string | null = null;
  let riskLimitedReason: string | null = null;
  const checkRiskOk = async (pid: string): Promise<boolean> => {
    if (!ctx.deps.checkDailyRiskLimit) return true;
    const res = await Promise.resolve(ctx.deps.checkDailyRiskLimit(pid, 'post'));
    if (!res.allowed) {
      riskLimitedReason = res.reason ?? '今日已达浏览器发帖日限额，自动休眠保护';
      return false;
    }
    return true;
  };
  for (const { profile: p, needsPageSwitch } of candidates) {
    if (!p.online) continue;
    if (!(await checkRiskOk(p.id))) continue;
    if (await tryClaimProfile(ctx, p.id, claimMeta))
      return { status: 'found', profile: p, wokeFromOffline: false, needsPageSwitch };
    sawBusyLabel = p.browserName || p.alias || p.id;
  }
  for (const { profile: offline, needsPageSwitch } of candidates) {
    if (offline.online) continue;
    if (!(await checkRiskOk(offline.id))) continue;
    // Atomic synchronous claim BEFORE launching offline Chrome to eliminate TOCTOU / leaked windows
    if (!(await tryClaimProfile(ctx, offline.id, claimMeta))) {
      sawBusyLabel = sawBusyLabel ?? (offline.browserName || offline.alias || offline.id);
      continue;
    }
    try {
      const wakeFn = () =>
        wakeBrowserProfile(ctx, offline.id, () => ctx.cancelledLinks.has(linkId));
      const woke = workboard
        ? await workboard.runStaggeredLaunch(new AbortController().signal, wakeFn)
        : await wakeFn();
      if (woke) {
        const ready = (await ctx.deps.workspace.snapshot()).profiles.find(
          (p) => p.id === offline.id && p.online,
        );
        if (ready)
          return { status: 'found', profile: ready, wokeFromOffline: true, needsPageSwitch };
      }
      releaseProfile(ctx, offline.id, linkId);
    } catch (err) {
      releaseProfile(ctx, offline.id, linkId);
      throw err;
    }
  }
  if (sawBusyLabel) return { status: 'busy', label: sawBusyLabel };
  if (riskLimitedReason) return { status: 'risk_limited', reason: riskLimitedReason };
  return { status: 'not_found' };
}
export async function switchChromeProfilePageIfNeeded(
  ctx: GoogleSheetsContext,
  opts: {
    profileId: string;
    needsPageSwitch: boolean;
    targetPageId: string;
    targetPageName?: string;
  },
): Promise<void> {
  if (!opts.needsPageSwitch) return;
  const switcher = ctx.deps.automation?.switchProfilePageIdentity;
  if (!switcher) return;
  const ok = await switcher({
    profileId: opts.profileId,
    targetPageId: opts.targetPageId,
    ...(opts.targetPageName ? { targetPageName: opts.targetPageName } : {}),
  });
  if (!ok) throw new Error(`未能切换至目标专页（${opts.targetPageName || opts.targetPageId}）`);
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
