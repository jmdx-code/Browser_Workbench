import type { CompatibleRepository } from '../../domain/persistence.js';
import { ProductError, failError } from '../../domain/workspace.js';
import {
  computeLibrarySyncDiff,
  extractFacebookTargetId,
  extractImageUrlFromCell,
  includesUngroupedBucket,
  isScientificNotationCell,
  isTemplateHintRow,
  LibraryImportMode,
  maskGyazoToken,
  resolveEffectiveGyazoTokens,
  resolveGroupLibraryColumns,
  resolvePageLibraryColumns,
  toSheetsImageFormula,
  type GoogleSheetLink,
  type LibrarySyncSummary,
  type SheetGridRow,
  type SheetGridSnapshot,
  type SheetImageHostConfig,
  type SheetImageHostStatus,
} from '../../shared/google-sheets.js';
import type { CheckDailyRiskLimitFn } from '../../shared/daily-risk-limits.js';
import { isLocalAvatar, isTargetIncomplete } from '../../shared/group-bumper.js';
import type { PostBumpRecordsPort } from '../../shared/post-bump-records.js';
import type { ProfileLifecyclePort } from '../../shared/profile-lifecycle.js';
import type { BluestacksService } from '../bluestacks-service.js';
import type { FeatureExecutionRegistry } from '../feature-execution-registry.js';
import type {
  GoogleOAuthPort,
  GoogleSheetsApiPort,
  GoogleSheetsRepositoryPort,
  SheetAutomationBridgePort,
  SheetImageHostPort,
  SheetRecordPostPortRecord,
} from '../google-sheets-ports.js';
import type { GroupBumperService } from '../group-bumper-service.js';
import { errMsg, ignoreError, runConcurrentQueue, sleepMs } from '../module-worker-pool.js';
import type { Workboard } from '../workboard.js';
import type { WorkspaceService } from '../workspace-service.js';
export interface GoogleSheetsServiceDeps {
  workspace: WorkspaceService;
  groupBumper: GroupBumperService;
  bluestacks?: BluestacksService;
  oauth: GoogleOAuthPort;
  sheetsApi: GoogleSheetsApiPort;
  imageHost: SheetImageHostPort;
  automation?: SheetAutomationBridgePort;
  prepareMaterialMedia?: SheetAutomationBridgePort['prepareMaterialMedia'];
  cleanupPreparedMedia?: SheetAutomationBridgePort['cleanupPreparedMedia'];
  workboard?: Workboard;
  checkDailyRiskLimit?: CheckDailyRiskLimitFn;
  featureExecution?: FeatureExecutionRegistry;
  profileLifecycle?: ProfileLifecyclePort;
  assertSystemIdle?: (action: string) => void | Promise<void>;
  postBumpRecords?: PostBumpRecordsPort;
  claimVerifyDelayMs?: number;
  now?: () => number;
}
export const METRICS_AUTO_MAX_AGE_HOURS = 14 * 24;
export const METRICS_BACKOFF_STEPS_MS = [1800_000, 7200_000, 21600_000, 86400_000] as const;
export interface ActiveProfileEntry {
  linkId: string;
  kind: 'post_schedule' | 'post_records' | 'metrics';
  title: string;
  status: string;
}
export function createGoogleSheetsContext(
  repo: CompatibleRepository<GoogleSheetsRepositoryPort>,
  deps: GoogleSheetsServiceDeps,
  wakeRecordsLinkToActive: (linkId: string, reason: string) => Promise<void>,
) {
  const ctx = {
    repo,
    deps,
    nowFn: deps.now ?? Date.now,
    runningScheduleLinks: new Set<string>(),
    runningRecordLinks: new Set<string>(),
    runningMetricsLinks: new Set<string>(),
    metricsFailureBackoff: new Map<string, { attempts: number; retryAfter: number }>(),
    gridCache: new Map<string, { snapshot: SheetGridSnapshot; cachedAt: number }>(),
    gridInFlight: new Map<string, Promise<SheetGridSnapshot>>(),
    gridEpoch: { global: 0, byLink: new Map<string, number>() },
    activeBumpFlushers: new Map<string, () => Promise<void>>(),
    activeProfiles: new Map<string, ActiveProfileEntry>(),
    claimingProfiles: new Set<string>(),
    recoveredStuckLinks: new Set<string>(),
    cancelledLinks: new Set<string>(),
    cancelledProfiles: new Set<string>(),
    metricsAbortByLink: new Map<string, AbortController>(),
    activeBluestacksAborts: new Map<string, AbortController>(),
    recordWriteLocks: new Map<string, Promise<void>>(),
    concurrency: { maxProfiles: null as number | null, maxBluestacks: null as number | null },
    wakeRecordsLinkToActive,
    readGrid: (linkId: string, options?: { force?: boolean; maxAgeMs?: number }) =>
      readGrid(ctx, linkId, options),
    invalidateGridCache: (linkId?: string) => invalidateGridCache(ctx, linkId),
  };
  return ctx;
}
export type GoogleSheetsContext = ReturnType<typeof createGoogleSheetsContext>;
export const safeAppendSheetLog = (
  ctx: GoogleSheetsContext,
  linkId: string | null,
  level: 'info' | 'warn' | 'error',
  action: string,
  summary: string,
) => ignoreError(ctx.repo.appendLog({ linkId, level, action, summary }));
export async function recordLinkPollFailure(
  ctx: GoogleSheetsContext,
  link: GoogleSheetLink | null,
  nextPollAt: number,
  action: string,
  prefix: string,
  err: unknown,
): Promise<void> {
  if (!link) return;
  const msg = errMsg(err);
  await ignoreError(
    ctx.repo.updateLinkRuntime(link.id, { activeJobText: '', lastError: msg, nextPollAt }),
  );
  await safeAppendSheetLog(ctx, link.id, 'error', action, `${prefix}：${msg}`);
}
export async function wakeBrowserProfile(
  ctx: GoogleSheetsContext,
  profileId: string,
  isCancelled: () => boolean,
): Promise<boolean> {
  if (!ctx.deps.profileLifecycle) return false;
  await ctx.deps.profileLifecycle.ensureProfilesOnline([profileId]).catch(() => {});
  const deadline = ctx.nowFn() + 25_000;
  const wallDeadline = Date.now() + 25_000;
  while (ctx.nowFn() < deadline && Date.now() < wallDeadline) {
    if (isCancelled()) return false;
    if ((await ctx.deps.workspace.snapshot()).profiles.some((p) => p.id === profileId && p.online))
      return true;
    await sleepMs(1000);
  }
  return false;
}
export function buildImageHostStatus(
  config: SheetImageHostConfig,
  cachedImageCount: number,
): SheetImageHostStatus {
  const tokens = resolveEffectiveGyazoTokens(config);
  const previews = tokens.map((t) => maskGyazoToken(t)).filter((x): x is string => Boolean(x));
  return {
    preferredHost: config.preferredHost,
    hasGyazoToken: tokens.length > 0,
    gyazoTokenPreview: previews[0] ?? null,
    gyazoTokenCount: tokens.length,
    gyazoTokenPreviews: previews,
    driveFolderId: config.driveFolderId,
    defaultMachineName: config.defaultMachineName,
    cachedImageCount,
  };
}
export async function requireLink(ctx: GoogleSheetsContext, id: string): Promise<GoogleSheetLink> {
  const link = await ctx.repo.getLink(id);
  if (!link) throw new ProductError('SHEET_LINK_NOT_FOUND', '表格连接不存在', 404);
  return link;
}
export async function isProfileBusyElsewhere(ctx: GoogleSheetsContext, profileId: string) {
  return (
    ctx.activeProfiles.has(profileId) ||
    ctx.claimingProfiles.has(profileId) ||
    Boolean(await ctx.deps.featureExecution?.isProfileBusy(profileId, 'google-sheets'))
  );
}
export async function tryClaimProfile(
  ctx: GoogleSheetsContext,
  profileId: string,
  meta: ActiveProfileEntry,
): Promise<boolean> {
  if (ctx.activeProfiles.has(profileId) || ctx.claimingProfiles.has(profileId)) return false;
  ctx.claimingProfiles.add(profileId);
  try {
    if (await ctx.deps.featureExecution?.isProfileBusy(profileId, 'google-sheets')) return false;
    if (ctx.activeProfiles.has(profileId)) return false;
    ctx.activeProfiles.set(profileId, { ...meta });
    ctx.cancelledProfiles.delete(profileId);
    return true;
  } finally {
    ctx.claimingProfiles.delete(profileId);
  }
}
export function updateActiveProfileStatus(
  ctx: GoogleSheetsContext,
  profileId: string,
  linkId: string,
  status: string,
): void {
  const current = ctx.activeProfiles.get(profileId);
  if (current?.linkId === linkId) current.status = status;
}
export function releaseProfile(ctx: GoogleSheetsContext, profileId: string, linkId: string): void {
  if (ctx.activeProfiles.get(profileId)?.linkId === linkId) ctx.activeProfiles.delete(profileId);
  ctx.cancelledProfiles.delete(profileId);
}
export function runSerializedRecordWrite(
  ctx: GoogleSheetsContext,
  key: string,
  work: () => Promise<void>,
): Promise<void> {
  const prev = ctx.recordWriteLocks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(work);
  const tracked = next.finally(() => {
    if (ctx.recordWriteLocks.get(key) === tracked) ctx.recordWriteLocks.delete(key);
  });
  ctx.recordWriteLocks.set(key, tracked);
  return next;
}
export async function loadSheetColumnIndexMap(
  ctx: GoogleSheetsContext,
  link: GoogleSheetLink,
  colIndex: number,
): Promise<Map<string, number> | null> {
  const readCol = ctx.deps.sheetsApi.readColumnValues;
  if (!readCol || colIndex < 0) return null;
  const col = await readCol(link.spreadsheetId, link.sheetName, colIndex);
  const map = new Map<string, number>();
  for (let i = 1; i < col.length; i++) {
    const v = (col[i] ?? '').trim();
    if (v && !map.has(v)) map.set(v, i + 1);
  }
  return map;
}
export const makeSheetRecordPost = (
  now: number,
  linkId: string,
  postCode: string,
  postUrl: string,
  existing: SheetRecordPostPortRecord | null | undefined,
  patch: Partial<SheetRecordPostPortRecord>,
): SheetRecordPostPortRecord => ({
  linkId,
  postCode,
  resourceCode: existing?.resourceCode ?? '',
  postedAtText: existing?.postedAtText ?? '',
  postedAtMs: existing?.postedAtMs ?? null,
  groupId: existing?.groupId ?? '',
  groupName: existing?.groupName ?? '',
  pageId: existing?.pageId ?? '',
  pageName: existing?.pageName ?? '',
  postUrl,
  postId: existing?.postId ?? null,
  thumbnailUrl: existing?.thumbnailUrl ?? null,
  likesCount: existing?.likesCount ?? null,
  commentsCount: existing?.commentsCount ?? null,
  metricsStage: existing?.metricsStage ?? 0,
  metricsUpdatedAt: existing?.metricsUpdatedAt ?? null,
  localBumpedCount: existing?.localBumpedCount ?? 0,
  bumpedProfileIds: existing?.bumpedProfileIds ?? [],
  createdAt: existing?.createdAt ?? now,
  ...patch,
  updatedAt: now,
});
async function resolveBoundCarriers<T extends { id: string }>(
  ctx: GoogleSheetsContext,
  items: readonly T[],
  folderIds: readonly string[],
  itemIds: readonly string[],
  getFolderId: (item: T) => string | null,
  isEligible: (item: T) => boolean,
  includeUngrouped = false,
): Promise<T[]> {
  const fSet = new Set(folderIds);
  const iSet = new Set(itemIds);
  const allowUngrouped = includesUngroupedBucket(folderIds, includeUngrouped);
  const out: T[] = [];
  for (const item of items) {
    if (!isEligible(item)) continue;
    const fId = getFolderId(item);
    if (
      ((fId === null && allowUngrouped) || (fId !== null && fSet.has(fId)) || iSet.has(item.id)) &&
      !(await isProfileBusyElsewhere(ctx, item.id))
    )
      out.push(item);
  }
  return out;
}
export async function resolveBoundBumperProfiles(
  ctx: GoogleSheetsContext,
  groupIds: readonly string[],
  profileIds: readonly string[],
  includeOffline = false,
  includeUngrouped = false,
) {
  const snap = await ctx.deps.workspace.snapshot();
  const eligible = await resolveBoundCarriers(
    ctx,
    snap.profiles,
    groupIds,
    profileIds,
    (p) => p.groupId,
    (p) =>
      (p.online || includeOffline) &&
      !['restricted', 'verification', 'logged-out'].includes(p.account.state),
    includeUngrouped,
  );
  return eligible.sort((a, b) => Number(b.online) - Number(a.online));
}
export async function resolveBoundBluestacksInstances(
  ctx: GoogleSheetsContext,
  folderIds: readonly string[],
  instanceIds: readonly string[],
) {
  if (!ctx.deps.bluestacks || (!folderIds.length && !instanceIds.length)) return [];
  const bs = await ctx.deps.bluestacks.state(false);
  return resolveBoundCarriers(
    ctx,
    bs.instances,
    folderIds,
    instanceIds,
    (i) => i.folderId,
    (i) => !['restricted', 'verification', 'logged-out', 'missing-app'].includes(i.accountState),
  );
}
const currentGridEpoch = (ctx: GoogleSheetsContext, linkId: string) =>
  `${ctx.gridEpoch.global}:${ctx.gridEpoch.byLink.get(linkId) ?? 0}`;
export function invalidateGridCache(ctx: GoogleSheetsContext, linkId?: string): void {
  if (linkId) {
    ctx.gridEpoch.byLink.set(linkId, (ctx.gridEpoch.byLink.get(linkId) ?? 0) + 1);
    ctx.gridCache.delete(linkId);
    ctx.gridInFlight.delete(linkId);
  } else {
    ctx.gridEpoch.global++;
    ctx.gridCache.clear();
    ctx.gridInFlight.clear();
  }
}
export async function readGrid(
  ctx: GoogleSheetsContext,
  linkId: string,
  options?: { force?: boolean; maxAgeMs?: number },
): Promise<SheetGridSnapshot> {
  const maxAgeMs = options?.maxAgeMs ?? 45_000;
  if (options?.force) invalidateGridCache(ctx, linkId);
  else {
    const cached = ctx.gridCache.get(linkId);
    if (cached && ctx.nowFn() - cached.cachedAt <= maxAgeMs) return cached.snapshot;
    const inFlight = ctx.gridInFlight.get(linkId);
    if (inFlight) return inFlight;
  }
  const capturedEpoch = currentGridEpoch(ctx, linkId);
  const work = (async (): Promise<SheetGridSnapshot> => {
    const link = await requireLink(ctx, linkId);
    const dual = await ctx.deps.sheetsApi.readSheetValues(link.spreadsheetId, link.sheetName);
    const maxCols = Math.max(
      0,
      ...dual.formulaRows.map((r) => r.length),
      ...dual.formattedRows.map((r) => r.length),
    );
    const padRow = (row: string[] | undefined) =>
      Array.from({ length: maxCols }, (_, i) => row?.[i] ?? '');
    const headers = padRow(dual.formattedRows[0] ?? dual.formulaRows[0]);
    const rowCount = Math.max(dual.formulaRows.length, dual.formattedRows.length);
    const rows: SheetGridRow[] = [];
    for (let r = 1; r < rowCount; r++) {
      const values = padRow(dual.formulaRows[r]);
      const displayValues = padRow(dual.formattedRows[r]);
      if (!values.some((v) => v.trim() !== '') && !displayValues.some((v) => v.trim() !== ''))
        continue;
      rows.push({
        rowNumber: r + 1,
        isHintRow: isTemplateHintRow(displayValues),
        values,
        displayValues,
      });
    }
    const fetchedAt = ctx.nowFn();
    await ctx.repo.updateLinkRuntime(link.id, {
      totalRowCount: rows.filter((r) => !r.isHintRow).length,
      lastError: null,
    });
    const snapshot: SheetGridSnapshot = {
      linkId: link.id,
      spreadsheetId: link.spreadsheetId,
      spreadsheetTitle: link.spreadsheetTitle || link.title,
      sheetName: link.sheetName,
      headers,
      rows,
      fetchedAt,
      totalRows: rows.length,
    };
    if (currentGridEpoch(ctx, link.id) === capturedEpoch)
      ctx.gridCache.set(link.id, { snapshot, cachedAt: fetchedAt });
    return snapshot;
  })();
  ctx.gridInFlight.set(linkId, work);
  try {
    return await work;
  } finally {
    if (ctx.gridInFlight.get(linkId) === work) ctx.gridInFlight.delete(linkId);
  }
}
async function resolveLibrarySyncBase(ctx: GoogleSheetsContext, linkId: string, kindError: string) {
  const link = await requireLink(ctx, linkId);
  if (link.kind !== 'group_library' && link.kind !== 'page_library')
    throw new ProductError('SHEET_KIND_MISMATCH', kindError, 400);
  const isGroup = link.kind === 'group_library';
  const grid = await readGrid(ctx, link.id, { force: true });
  const cols = isGroup
    ? resolveGroupLibraryColumns(grid.headers)
    : resolvePageLibraryColumns(grid.headers);
  if (cols.id < 0)
    failError(
      'SHEET_HEADER_MISSING',
      `第一行表头未找到「${isGroup ? '小组id' : '专页id'}」列，请检查模板表头`,
      400,
    );
  return {
    link,
    isGroup,
    targetKind: (isGroup ? 'group' : 'page') as 'group' | 'page',
    folderListKind: (isGroup ? 'shared_groups' : 'bumper_pages') as
      'shared_groups' | 'bumper_pages',
    grid,
    cols,
  };
}
export async function importLibraryFromSheet(
  ctx: GoogleSheetsContext,
  linkId: string,
  rawMode: unknown,
): Promise<LibrarySyncSummary> {
  const mode = LibraryImportMode.parse(rawMode ?? 'incremental');
  const { link, isGroup, targetKind, folderListKind, grid, cols } = await resolveLibrarySyncBase(
    ctx,
    linkId,
    '只有小组表或专页表支持导入目标库',
  );
  const parsedItems: Array<{ id: string; name: string; category: string }> = [];
  const seenIds = new Set<string>();
  let skipped = 0;
  for (const row of grid.rows) {
    if (row.isHintRow) continue;
    const dispId = (row.displayValues[cols.id] ?? '').trim();
    const formulaId = (row.values[cols.id] ?? '').trim();
    const rawId = isScientificNotationCell(dispId)
      ? isScientificNotationCell(formulaId)
        ? ''
        : formulaId
      : dispId || formulaId;
    const id = extractFacebookTargetId(rawId, targetKind);
    if (!id || seenIds.has(id.toLowerCase())) {
      skipped++;
      continue;
    }
    seenIds.add(id.toLowerCase());
    parsedItems.push({
      id,
      name: cols.name >= 0 ? (row.displayValues[cols.name] ?? '').trim() : '',
      category: cols.category >= 0 ? (row.displayValues[cols.category] ?? '').trim() : '',
    });
  }
  const targetRepo = ctx.deps.workspace.repository;
  const loadFolderMap = async () =>
    new Map(
      ((await targetRepo.targetFolders?.(folderListKind)) ?? []).map((f) => [
        f.name.trim().toLowerCase(),
        f.id,
      ]),
    );
  let folderIdByName = await loadFolderMap();
  let foldersCreated = 0;
  for (const cat of new Set(parsedItems.map((i) => i.category).filter(Boolean))) {
    if (folderIdByName.has(cat.toLowerCase())) continue;
    await targetRepo.targetListCommand?.({ action: 'create', listKind: folderListKind, name: cat });
    foldersCreated++;
  }
  if (foldersCreated > 0) folderIdByName = await loadFolderMap();
  const bumperState = await ctx.deps.groupBumper.state();
  const localBefore = isGroup ? bumperState.groups : bumperState.pages;
  const localByKey = new Map(localBefore.map((item) => [item.id.toLowerCase(), item]));
  let added = 0;
  let updated = 0;
  let deleted = 0;
  const itemsToUpsert = parsedItems.map((item) => {
    const existing = localByKey.get(item.id.toLowerCase());
    if (existing) updated++;
    else added++;
    return {
      id: item.id,
      name: item.name || existing?.name || '',
      folderId: item.category
        ? (folderIdByName.get(item.category.toLowerCase()) ?? existing?.folderId ?? null)
        : (existing?.folderId ?? null),
    };
  });
  for (let i = 0; i < itemsToUpsert.length; i += 500) {
    const chunk = itemsToUpsert.slice(i, i + 500);
    if (chunk.length)
      await ctx.deps.groupBumper.manage(isGroup ? 'groups/add' : 'pages/add', { items: chunk });
  }
  const itemsByFolder = new Map<string | null, string[]>();
  for (const item of itemsToUpsert) {
    const list = itemsByFolder.get(item.folderId) ?? [];
    list.push(item.id);
    itemsByFolder.set(item.folderId, list);
  }
  for (const [folderId, ids] of itemsByFolder.entries()) {
    if (ids.length)
      await targetRepo.targetListCommand?.({
        action: 'reorder-items',
        listKind: folderListKind,
        folderId,
        orderedItemIds: ids,
      });
  }
  if (mode === 'overwrite') {
    const extraIds = localBefore.filter((i) => !seenIds.has(i.id.toLowerCase())).map((i) => i.id);
    if (extraIds.length) {
      await ctx.deps.groupBumper.manage(isGroup ? 'groups/delete' : 'pages/delete', {
        ids: extraIds,
      });
      deleted = extraIds.length;
    }
  }
  const afterState = await ctx.deps.groupBumper.state();
  const metadataRefreshTriggered = (isGroup ? afterState.groups : afterState.pages).some(
    isTargetIncomplete,
  );
  const summary = `${mode === 'overwrite' ? '覆盖导入' : '增量导入'}完成：新增 ${added}，更新 ${updated}${deleted > 0 ? `，移除多余 ${deleted}` : ''}${foldersCreated > 0 ? `，新建分组 ${foldersCreated}` : ''}${metadataRefreshTriggered ? '（缺失名称/头像已触发后台自动补齐）' : ''}`;
  await ctx.repo.updateLinkRuntime(link.id, {
    lastSyncedAt: ctx.nowFn(),
    lastSyncSummary: summary,
    lastError: null,
  });
  await safeAppendSheetLog(ctx, link.id, 'info', 'library_import', summary);
  return {
    direction: 'sheet_to_local',
    mode,
    added,
    updated,
    deleted,
    skipped,
    foldersCreated,
    avatarsUploaded: 0,
    metadataRefreshTriggered,
    summary,
  };
}
export async function syncLibraryToSheet(
  ctx: GoogleSheetsContext,
  linkId: string,
): Promise<LibrarySyncSummary> {
  const { link, isGroup, targetKind, folderListKind, grid, cols } = await resolveLibrarySyncBase(
    ctx,
    linkId,
    '只有小组表或专页表支持同步至表格',
  );
  const [bumperState, folders] = await Promise.all([
    ctx.deps.groupBumper.state(),
    ctx.deps.workspace.repository.targetFolders?.(folderListKind) ?? Promise.resolve([]),
  ]);
  const folderNameById = new Map(folders.map((f) => [f.id, f.name]));
  const localTargets = isGroup ? bumperState.groups : bumperState.pages;
  const existingAvatarByKey = new Map<string, string>();
  for (const row of grid.rows) {
    if (row.isHintRow) continue;
    const key = extractFacebookTargetId(row.displayValues[cols.id] ?? '', targetKind).toLowerCase();
    const url =
      key && cols.avatar >= 0
        ? extractImageUrlFromCell((row.values[cols.avatar] ?? '').trim())
        : null;
    if (url && /^https:\/\/(?:i\.gyazo\.com|lh3\.googleusercontent\.com)\//i.test(url))
      existingAvatarByKey.set(key, toSheetsImageFormula(url));
  }
  let avatarsUploaded = 0;
  const localItems = new Array<{
    id: string;
    category: string;
    name: string;
    avatarCellValue: string;
  }>(localTargets.length);
  await runConcurrentQueue(localTargets, 4, async (item, idx) => {
    const category = item.folderId ? (folderNameById.get(item.folderId) ?? '') : '';
    const existingAvatarFormula = existingAvatarByKey.get(item.id.toLowerCase());
    let avatarCellValue = existingAvatarFormula ?? '';
    if (
      !existingAvatarFormula &&
      cols.avatar >= 0 &&
      item.avatarUrl &&
      (isLocalAvatar(item.avatarUrl) || item.avatarUrl.startsWith('http'))
    ) {
      try {
        const up = await ctx.deps.imageHost.uploadDataUrlOrUrl({
          source: item.avatarUrl,
          filenameHint: `${targetKind}-${item.id}`,
        });
        if (up) {
          avatarCellValue = toSheetsImageFormula(up.remoteUrl);
          if (!up.cached) avatarsUploaded++;
        }
      } catch {
        /* keep existingAvatarByKey */
      }
    }
    localItems[idx] = { id: item.id, category, name: item.name, avatarCellValue };
  });
  const diff = computeLibrarySyncDiff({
    sheetRows: grid.rows,
    localItems,
    columns: cols,
    kind: targetKind,
  });
  try {
    if (diff.cellUpdates.length)
      await ctx.deps.sheetsApi.batchUpdateCells(
        link.spreadsheetId,
        link.sheetName,
        diff.cellUpdates,
      );
    if (diff.deleteRowNumbersDesc.length)
      await ctx.deps.sheetsApi.deleteRowsDescending(
        link.spreadsheetId,
        link.sheetId,
        diff.deleteRowNumbersDesc,
      );
    if (diff.appends.length)
      await ctx.deps.sheetsApi.appendRows(link.spreadsheetId, link.sheetName, diff.appends);
  } finally {
    invalidateGridCache(ctx, link.id);
  }
  const summary = `同步至表格完成：更新 ${diff.stats.updated}，新增 ${diff.stats.added}，删除多余 ${diff.stats.deleted}${avatarsUploaded > 0 ? `，新上传头像 ${avatarsUploaded}` : ''}`;
  await ctx.repo.updateLinkRuntime(link.id, {
    lastSyncedAt: ctx.nowFn(),
    lastSyncSummary: summary,
    lastError: null,
    totalRowCount: localItems.length,
  });
  await safeAppendSheetLog(ctx, link.id, 'info', 'library_sync_to_sheet', summary);
  return {
    direction: 'local_to_sheet',
    mode: 'diff',
    added: diff.stats.added,
    updated: diff.stats.updated,
    deleted: diff.stats.deleted,
    skipped: diff.stats.unchanged,
    foldersCreated: 0,
    avatarsUploaded,
    metadataRefreshTriggered: false,
    summary,
  };
}
