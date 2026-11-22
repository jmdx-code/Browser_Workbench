import type { CompatibleRepository } from '../domain/persistence.js';
import { ProductError } from '../domain/workspace.js';
import type { ProfileLifecyclePort } from '../shared/profile-lifecycle.js';
import type { BumperTarget } from '../shared/group-bumper.js';
import { isLocalAvatar, isTargetIncomplete } from '../shared/group-bumper.js';
import type { PosterLog, PosterMaterial } from '../shared/group-poster.js';
import {
  computeLibrarySyncDiff,
  CreateSheetLinkInput,
  evaluateMetricsEligibility,
  extractFacebookPostIdFromUrl,
  extractFacebookTargetId,
  extractImageUrlFromCell,
  formatDateTimeForSheet,
  generatePostCode,
  generateResourceCode,
  isDirectFacebookPostUrl,
  isScientificNotationCell,
  isTemplateHintRow,
  LibraryImportMode,
  maskGyazoToken,
  nextTieredPollingState,
  PAGE_TIMELINE_SYNTHETIC_GROUP_ID,
  parseAiLabelCell,
  parseBooleanCell,
  parseGoogleSpreadsheetUrl,
  parseGroupsSpec,
  parseGyazoTokenList,
  parseScheduleDateTimeMs,
  randomCodeSegment,
  resolveEffectiveGyazoTokens,
  resolveGroupLibraryColumns,
  resolvePageLibraryColumns,
  resolveRecordColumns,
  resolveScheduleColumns,
  SaveSheetImageHostInput,
  toSheetsImageFormula,
  UpdateSheetLinkInput,
  type GoogleAuthStatus,
  type GoogleSheetKind,
  type GoogleSheetLink,
  type GoogleSheetsOverview,
  type LibrarySyncSummary,
  type SheetGridRow,
  type SheetGridSnapshot,
  type SheetImageHostConfig,
  type SheetImageHostStatus,
  type SpreadsheetMeta,
} from '../shared/google-sheets.js';
import type { FeatureExecutionRegistry } from './feature-execution-registry.js';
import type { BluestacksService } from './bluestacks-service.js';
import type { GroupBumperService } from './group-bumper-service.js';
import type { WorkspaceService } from './workspace-service.js';
import {
  bluestacksDisplayTitle,
  isBluestacksPortraitResolution,
  type BluestacksInstance,
} from '../shared/bluestacks.js';
import type {
  DirectPostBumpItem,
  GoogleOAuthPort,
  GoogleSheetsApiPort,
  GoogleSheetsRepositoryPort,
  ScrapedPostMetrics,
  SheetAutomationBridgePort,
  SheetImageHostPort,
  SheetImageHostTestResult,
  SheetRecordPostPortRecord,
} from './google-sheets-ports.js';

export interface GoogleSheetsServiceDeps {
  workspace: WorkspaceService;
  groupBumper: GroupBumperService;
  bluestacks?: BluestacksService | undefined;
  oauth: GoogleOAuthPort;
  sheetsApi: GoogleSheetsApiPort;
  imageHost: SheetImageHostPort;
  automation?: SheetAutomationBridgePort | undefined;
  featureExecution?: FeatureExecutionRegistry | undefined;
  profileLifecycle?: ProfileLifecyclePort | undefined;
  assertSystemIdle?: ((action: string) => void | Promise<void>) | undefined;
  claimVerifyDelayMs?: number | undefined;
  now?: (() => number) | undefined;
}

function buildImageHostStatus(
  config: SheetImageHostConfig,
  cachedImageCount: number,
): SheetImageHostStatus {
  const tokens = resolveEffectiveGyazoTokens(config);
  const previews = tokens
    .map((token) => maskGyazoToken(token))
    .filter((item): item is string => Boolean(item));
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

function shuffleCopy<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = copy[i];
    const b = copy[j];
    if (a !== undefined && b !== undefined) {
      copy[i] = b;
      copy[j] = a;
    }
  }
  return copy;
}

export class GoogleSheetsService {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private static readonly GRID_CACHE_TTL_MS = 45_000;
  private readonly runningScheduleLinks = new Set<string>();
  private readonly runningRecordLinks = new Set<string>();
  private readonly runningMetricsLinks = new Set<string>();
  private readonly gridCache = new Map<string, { snapshot: SheetGridSnapshot; cachedAt: number }>();
  private readonly gridInFlight = new Map<string, Promise<SheetGridSnapshot>>();
  private globalGridEpoch = 0;
  private readonly linkGridEpochs = new Map<string, number>();
  private readonly activeBumpFlushers = new Map<string, () => Promise<void>>();
  private readonly activeProfiles = new Map<
    string,
    {
      linkId: string;
      kind: 'post_schedule' | 'post_records' | 'metrics';
      title: string;
      status: string;
    }
  >();
  private readonly cancelledLinks = new Set<string>();
  private readonly cancelledProfiles = new Set<string>();
  private readonly metricsAbortByLink = new Map<string, AbortController>();
  private readonly activeBluestacksAborts = new Map<string, AbortController>();
  private readonly recordWriteLocks = new Map<string, Promise<void>>();
  private readonly nowFn: () => number;
  private globalMaxConcurrentProfiles: number | null = null;
  private globalMaxConcurrentBluestacks: number | null = null;

  private async isProfileBusyElsewhere(profileId: string): Promise<boolean> {
    if (this.activeProfiles.has(profileId)) return true;
    if (!this.deps.featureExecution) return false;
    return this.deps.featureExecution.isProfileBusy(profileId, 'google-sheets');
  }

  private async tryClaimProfile(
    profileId: string,
    meta: {
      linkId: string;
      kind: 'post_schedule' | 'post_records' | 'metrics';
      title: string;
      status: string;
    },
  ): Promise<boolean> {
    const busyElsewhere = this.deps.featureExecution
      ? await this.deps.featureExecution.isProfileBusy(profileId, 'google-sheets')
      : false;
    if (busyElsewhere || this.activeProfiles.has(profileId)) return false;
    this.activeProfiles.set(profileId, { ...meta });
    this.cancelledProfiles.delete(profileId);
    return true;
  }

  private updateActiveProfileStatus(profileId: string, linkId: string, status: string): void {
    const current = this.activeProfiles.get(profileId);
    if (current && current.linkId === linkId) {
      current.status = status;
    }
  }

  private releaseProfile(profileId: string, linkId: string): void {
    if (this.activeProfiles.get(profileId)?.linkId === linkId) {
      this.activeProfiles.delete(profileId);
    }
    this.cancelledProfiles.delete(profileId);
  }

  syncMaxConcurrency(limit: number, bluestacksLimit?: number): void {
    this.globalMaxConcurrentProfiles = Math.max(1, Math.min(50, Math.round(limit)));
    if (typeof bluestacksLimit === 'number' && Number.isFinite(bluestacksLimit)) {
      this.globalMaxConcurrentBluestacks = Math.max(1, Math.min(30, Math.round(bluestacksLimit)));
    }
  }

  isProfileRunning(profileId: string): boolean {
    return this.activeProfiles.has(profileId);
  }

  hasActiveExecution(): boolean {
    return this.isRunningAny() || this.activeProfiles.size > 0;
  }

  async countEnabledMonitors(): Promise<{ scheduleEnabled: number; recordsEnabled: number }> {
    const links = await this.repo.listLinks();
    let scheduleEnabled = 0;
    let recordsEnabled = 0;
    for (const l of links) {
      if (!l.enabled) continue;
      if (l.kind === 'post_schedule' && l.scheduleConfig?.enabled) scheduleEnabled++;
      if (l.kind === 'post_records' && l.recordsConfig?.enabled) recordsEnabled++;
    }
    return { scheduleEnabled, recordsEnabled };
  }

  async stopProfiles(profileIds?: readonly string[]): Promise<void> {
    if (!profileIds || profileIds.length === 0) {
      await this.stopAll();
      return;
    }
    const idSet = new Set(profileIds);
    for (const [pid, entry] of this.activeProfiles.entries()) {
      if (idSet.has(pid)) {
        this.cancelledProfiles.add(pid);
        this.metricsAbortByLink.get(entry.linkId)?.abort();
        this.activeBluestacksAborts.get(pid)?.abort();
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const ctrl of this.metricsAbortByLink.values()) {
      ctrl.abort();
    }
    for (const ctrl of this.activeBluestacksAborts.values()) {
      ctrl.abort();
    }
    for (const id of [
      ...this.runningScheduleLinks,
      ...this.runningRecordLinks,
      ...this.runningMetricsLinks,
    ]) {
      this.cancelledLinks.add(id);
    }
    for (const pid of this.activeProfiles.keys()) {
      this.cancelledProfiles.add(pid);
    }
  }

  private runSerializedRecordWrite(key: string, work: () => Promise<void>): Promise<void> {
    const prev = this.recordWriteLocks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(work);
    const tracked = next.finally(() => {
      if (this.recordWriteLocks.get(key) === tracked) {
        this.recordWriteLocks.delete(key);
      }
    });
    this.recordWriteLocks.set(key, tracked);
    return next;
  }

  constructor(
    private readonly repo: CompatibleRepository<GoogleSheetsRepositoryPort>,
    private readonly deps: GoogleSheetsServiceDeps,
  ) {
    this.nowFn = deps.now ?? Date.now;
  }

  start(): void {
    if (this.pollTimer) return;
    const timer = setInterval(() => {
      void this.tickAll();
    }, 15_000);
    timer.unref?.();
    this.pollTimer = timer;
  }

  async shutdown(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const ctrl of this.metricsAbortByLink.values()) {
      ctrl.abort();
    }
    this.metricsAbortByLink.clear();
    for (const ctrl of this.activeBluestacksAborts.values()) {
      ctrl.abort();
    }
    this.activeBluestacksAborts.clear();
    for (const id of [...this.runningScheduleLinks, ...this.runningRecordLinks]) {
      this.cancelledLinks.add(id);
    }
    const flushPromises = [
      ...[...this.activeBumpFlushers.values()].map((fn) => fn().catch(() => {})),
      ...[...this.recordWriteLocks.values()].map((p) => p.catch(() => {})),
    ];
    if (flushPromises.length > 0) {
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(flushPromises),
        new Promise<void>((resolve) => {
          flushTimer = setTimeout(resolve, 5_000);
        }),
      ]).finally(() => {
        if (flushTimer) clearTimeout(flushTimer);
      });
    }
    await this.deps.oauth.shutdown();
  }

  isRunningAny(): boolean {
    return (
      this.runningScheduleLinks.size > 0 ||
      this.runningRecordLinks.size > 0 ||
      this.runningMetricsLinks.size > 0
    );
  }

  async overview(): Promise<GoogleSheetsOverview> {
    const [auth, imageHostConfig, cachedImageCount, links, logs] = await Promise.all([
      this.deps.oauth.status(),
      this.repo.getImageHostConfig(),
      this.repo.countImageCache(),
      this.repo.listLinks(),
      this.repo.listLogs(60),
    ]);
    const imageHost = buildImageHostStatus(imageHostConfig, cachedImageCount);
    const enrichedLinks = links.map((link) => ({
      ...link,
      runtime: {
        ...link.runtime,
        activeRunningCount:
          (this.runningScheduleLinks.has(link.id) ? 1 : 0) +
          (this.runningRecordLinks.has(link.id) ? 1 : 0) +
          (this.runningMetricsLinks.has(link.id) ? 1 : 0),
      },
    }));
    return {
      auth,
      imageHost,
      links: enrichedLinks,
      logs,
      runningScheduleCount: this.runningScheduleLinks.size,
      runningRecordsCount: this.runningRecordLinks.size + this.runningMetricsLinks.size,
      activeProfiles: [...this.activeProfiles.entries()].map(([profileId, entry]) => ({
        profileId,
        linkId: entry.linkId,
        kind: entry.kind,
        title: entry.title,
        status: entry.status,
      })),
    };
  }

  // ---- OAuth & Image Host ----

  async importCredentials(rawJson: string): Promise<GoogleAuthStatus> {
    const status = await this.deps.oauth.importCredentialsJson(rawJson);
    this.invalidateGridCache();
    return status;
  }

  async startAuth(): Promise<{ authUrl: string; status: GoogleAuthStatus }> {
    return this.deps.oauth.startAuthSession();
  }

  async completeManualAuth(codeOrUrl: string): Promise<GoogleAuthStatus> {
    return this.deps.oauth.completeManualAuth(codeOrUrl);
  }

  async revokeAuth(): Promise<GoogleAuthStatus> {
    const status = await this.deps.oauth.revokeAuth();
    this.invalidateGridCache();
    await Promise.resolve(this.repo.saveImageHostConfig({ driveFolderId: null })).catch(() => {});
    return status;
  }

  async getEditableGyazoTokens(): Promise<{ tokens: string[] }> {
    const config = await this.repo.getImageHostConfig();
    return { tokens: resolveEffectiveGyazoTokens(config) };
  }

  async saveImageHostConfig(input: unknown): Promise<SheetImageHostStatus> {
    const parsed = SaveSheetImageHostInput.parse(input);
    const current = await this.repo.getImageHostConfig();
    const nextTokens = parsed.clearGyazoToken
      ? []
      : parsed.gyazoAccessTokens !== undefined
        ? parseGyazoTokenList(parsed.gyazoAccessTokens)
        : parsed.gyazoAccessToken !== undefined
          ? parseGyazoTokenList(parsed.gyazoAccessToken)
          : resolveEffectiveGyazoTokens(current);
    const saved = await this.repo.saveImageHostConfig({
      preferredHost: parsed.preferredHost ?? current.preferredHost,
      gyazoAccessTokens: nextTokens,
      gyazoAccessToken: nextTokens[0] ?? '',
      defaultMachineName: parsed.defaultMachineName ?? current.defaultMachineName,
    });
    const cachedImageCount = await this.repo.countImageCache();
    return buildImageHostStatus(saved, cachedImageCount);
  }

  async testImageHost(): Promise<SheetImageHostTestResult> {
    const result = await this.deps.imageHost.testUpload();
    const hostDesc =
      result.host === 'gyazo'
        ? result.tokenIndex !== undefined && (result.tokenCount ?? 0) > 1
          ? `Gyazo · Token #${result.tokenIndex + 1}/${result.tokenCount}`
          : 'Gyazo'
        : result.fallbackFromGyazo
          ? 'Gyazo 失败，已自动切换 Google 网盘兜底'
          : 'Google 网盘兜底';
    await this.repo.appendLog({
      level: 'info',
      action: 'image_host_test',
      summary: `图床测试上传成功（${hostDesc}）：${result.remoteUrl}`,
    });
    return result;
  }

  // ---- Spreadsheet discovery & Link CRUD ----

  async inspectSpreadsheet(
    urlOrId: string,
  ): Promise<SpreadsheetMeta & { suggestedGid: number | null }> {
    const parsed = parseGoogleSpreadsheetUrl(urlOrId);
    if (!parsed) {
      throw new ProductError(
        'GOOGLE_SPREADSHEET_URL_INVALID',
        '请粘贴有效的 Google 表格链接或表格 ID',
        400,
      );
    }
    const meta = await this.deps.sheetsApi.getSpreadsheetMeta(parsed.spreadsheetId);
    return { ...meta, suggestedGid: parsed.gid };
  }

  async createLink(input: unknown): Promise<GoogleSheetLink> {
    const parsed = CreateSheetLinkInput.parse(input);
    const urlParts = parseGoogleSpreadsheetUrl(parsed.spreadsheetUrlOrId);
    if (!urlParts) {
      throw new ProductError(
        'GOOGLE_SPREADSHEET_URL_INVALID',
        '请粘贴有效的 Google 表格链接或 ID',
        400,
      );
    }
    const meta = await this.deps.sheetsApi.getSpreadsheetMeta(urlParts.spreadsheetId);
    const selectedTab =
      (parsed.sheetName ? meta.tabs.find((t) => t.title === parsed.sheetName) : undefined) ??
      (parsed.sheetId !== undefined
        ? meta.tabs.find((t) => t.sheetId === parsed.sheetId)
        : undefined) ??
      (urlParts.gid !== null ? meta.tabs.find((t) => t.sheetId === urlParts.gid) : undefined) ??
      this.pickDefaultTabByKind(meta.tabs, parsed.kind) ??
      meta.tabs[0];

    if (!selectedTab) {
      throw new ProductError('GOOGLE_SHEET_TAB_NOT_FOUND', '该表格中没有可用的工作表标签', 404);
    }

    if (parsed.kind === 'post_schedule' || parsed.kind === 'post_records') {
      const existingOfKind = await this.repo.listLinks(parsed.kind);
      const duplicate = existingOfKind.find(
        (item) => item.spreadsheetId === meta.spreadsheetId && item.sheetId === selectedTab.sheetId,
      );
      if (duplicate) {
        throw new ProductError(
          'GOOGLE_SHEET_DUPLICATE_LINK',
          `工作表「${selectedTab.title}」已连接（当前标签名：${duplicate.title}），请换选其他工作表或粘贴新表格链接`,
          409,
        );
      }
    }

    const link = await this.repo.createLink({
      kind: parsed.kind,
      title: parsed.title?.trim() || selectedTab.title,
      spreadsheetId: meta.spreadsheetId,
      spreadsheetTitle: meta.title,
      sheetId: selectedTab.sheetId,
      sheetName: selectedTab.title,
      spreadsheetUrl: `${meta.url}#gid=${selectedTab.sheetId}`,
      scheduleConfig: parsed.scheduleConfig,
      recordsConfig: parsed.recordsConfig,
    });
    this.invalidateGridCache(link.id);
    await this.repo.appendLog({
      linkId: link.id,
      level: 'info',
      action: 'link_create',
      summary: `已连接「${link.title}」（${meta.title} / ${selectedTab.title}）`,
    });
    return link;
  }

  private pickDefaultTabByKind(
    tabs: SpreadsheetMeta['tabs'],
    kind: GoogleSheetKind,
  ): SpreadsheetMeta['tabs'][number] | undefined {
    const patterns: Record<GoogleSheetKind, RegExp> = {
      group_library: /小组表|小組表|group/i,
      page_library: /专页表|專頁表|page/i,
      post_schedule: /排贴|排貼|schedule/i,
      post_records: /发帖记录|發帖記錄|顶贴|頂貼|record/i,
    };
    return tabs.find((t) => patterns[kind].test(t.title));
  }

  async updateLink(input: unknown): Promise<GoogleSheetLink> {
    const parsed = UpdateSheetLinkInput.parse(input);
    const updated = await this.repo.updateLink({
      id: parsed.id,
      title: parsed.title,
      sheetId: parsed.sheetId,
      sheetName: parsed.sheetName,
      enabled: parsed.enabled,
      scheduleConfig: parsed.scheduleConfig,
      recordsConfig: parsed.recordsConfig,
    });
    if (parsed.sheetId !== undefined || parsed.sheetName !== undefined) {
      this.invalidateGridCache(parsed.id);
    }
    // If enabling a records sheet, start in active listening mode immediately
    if (updated.kind === 'post_records' && updated.recordsConfig?.enabled) {
      if (updated.runtime.pollingMode === 'idle') {
        await this.repo.updateLinkRuntime(updated.id, {
          pollingMode: 'active',
          consecutiveIdlePolls: 0,
          nextPollAt: this.nowFn(),
        });
      }
    }
    return (await this.repo.getLink(updated.id)) ?? updated;
  }

  async deleteLink(id: string): Promise<{ deleted: boolean }> {
    this.cancelledLinks.add(id);
    this.metricsAbortByLink.get(id)?.abort();
    this.invalidateGridCache(id);
    const existing = await this.repo.getLink(id);
    const deleted = await this.repo.deleteLink(id);
    if (deleted && existing) {
      if (existing.kind === 'post_records') {
        const schedules = await this.repo.listLinks('post_schedule');
        for (const sched of schedules) {
          if (sched.scheduleConfig?.targetRecordLinkId === id) {
            await this.repo.updateLink({
              id: sched.id,
              scheduleConfig: { targetRecordLinkId: null },
            });
          }
        }
      }
      await this.repo.appendLog({
        linkId: null,
        level: 'info',
        action: 'link_delete',
        summary: `已断开表格连接「${existing.title}」`,
      });
    }
    return { deleted };
  }

  private currentGridEpoch(linkId: string): string {
    return `${this.globalGridEpoch}:${this.linkGridEpochs.get(linkId) ?? 0}`;
  }

  invalidateGridCache(linkId?: string): void {
    if (linkId) {
      this.linkGridEpochs.set(linkId, (this.linkGridEpochs.get(linkId) ?? 0) + 1);
      this.gridCache.delete(linkId);
      this.gridInFlight.delete(linkId);
    } else {
      this.globalGridEpoch++;
      this.gridCache.clear();
      this.gridInFlight.clear();
    }
  }

  async readGrid(
    linkId: string,
    options?: { force?: boolean | undefined; maxAgeMs?: number | undefined },
  ): Promise<SheetGridSnapshot> {
    const force = Boolean(options?.force);
    const maxAgeMs = options?.maxAgeMs ?? GoogleSheetsService.GRID_CACHE_TTL_MS;
    if (force) {
      this.invalidateGridCache(linkId);
    } else {
      const cached = this.gridCache.get(linkId);
      if (cached && this.nowFn() - cached.cachedAt <= maxAgeMs) {
        return cached.snapshot;
      }
      const existingInFlight = this.gridInFlight.get(linkId);
      if (existingInFlight) {
        return existingInFlight;
      }
    }

    const capturedEpoch = this.currentGridEpoch(linkId);
    const work = (async (): Promise<SheetGridSnapshot> => {
      const link = await this.requireLink(linkId);
      const dual = await this.deps.sheetsApi.readSheetValues(link.spreadsheetId, link.sheetName);
      const maxCols = Math.max(
        dual.formulaRows[0]?.length ?? 0,
        dual.formattedRows[0]?.length ?? 0,
        ...dual.formulaRows.map((r) => r.length),
        ...dual.formattedRows.map((r) => r.length),
      );
      const padRow = (row: string[] | undefined): string[] => {
        const out = new Array<string>(maxCols).fill('');
        if (row) {
          for (let i = 0; i < Math.min(row.length, maxCols); i++) {
            out[i] = row[i] ?? '';
          }
        }
        return out;
      };
      const headers = padRow(dual.formattedRows[0] ?? dual.formulaRows[0]);
      const rowCount = Math.max(dual.formulaRows.length, dual.formattedRows.length);
      const rows: SheetGridRow[] = [];
      for (let r = 1; r < rowCount; r++) {
        const values = padRow(dual.formulaRows[r]);
        const displayValues = padRow(dual.formattedRows[r]);
        const hasAny =
          values.some((v) => v.trim() !== '') || displayValues.some((v) => v.trim() !== '');
        if (!hasAny) continue;
        rows.push({
          rowNumber: r + 1,
          isHintRow: isTemplateHintRow(displayValues),
          values,
          displayValues,
        });
      }
      const fetchedAt = this.nowFn();
      await this.repo.updateLinkRuntime(link.id, {
        totalRowCount: rows.filter((row) => !row.isHintRow).length,
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
      if (this.currentGridEpoch(link.id) === capturedEpoch) {
        this.gridCache.set(link.id, { snapshot, cachedAt: fetchedAt });
      }
      return snapshot;
    })();

    this.gridInFlight.set(linkId, work);
    try {
      return await work;
    } finally {
      if (this.gridInFlight.get(linkId) === work) {
        this.gridInFlight.delete(linkId);
      }
    }
  }

  // ---- 小组表 / 专页表 Bidirectional Sync ----

  async importLibraryFromSheet(linkId: string, rawMode: unknown): Promise<LibrarySyncSummary> {
    const mode = LibraryImportMode.parse(rawMode ?? 'incremental');
    const link = await this.requireLink(linkId);
    if (link.kind !== 'group_library' && link.kind !== 'page_library') {
      throw new ProductError('SHEET_KIND_MISMATCH', '只有小组表或专页表支持导入目标库', 400);
    }
    const isGroup = link.kind === 'group_library';
    const targetKind: 'group' | 'page' = isGroup ? 'group' : 'page';
    const folderListKind = isGroup ? 'shared_groups' : 'bumper_pages';

    const grid = await this.readGrid(link.id, { force: true });
    const cols = isGroup
      ? resolveGroupLibraryColumns(grid.headers)
      : resolvePageLibraryColumns(grid.headers);
    if (cols.id < 0) {
      throw new ProductError(
        'SHEET_HEADER_MISSING',
        `第一行表头未找到「${isGroup ? '小组id' : '专页id'}」列，请检查模板表头`,
        400,
      );
    }

    const parsedItems: Array<{ id: string; name: string; category: string }> = [];
    const seenIds = new Set<string>();
    let skipped = 0;

    for (const row of grid.rows) {
      if (row.isHintRow) continue;
      const dispId = (row.displayValues[cols.id] ?? '').trim();
      const formulaId = (row.values[cols.id] ?? '').trim();
      // Guard against Google Sheets scientific-notation corruption (e.g. `1.99955E+15`)
      const rawId = isScientificNotationCell(dispId)
        ? isScientificNotationCell(formulaId)
          ? ''
          : formulaId
        : dispId || formulaId;
      const id = extractFacebookTargetId(rawId, targetKind);
      if (!id) {
        skipped++;
        continue;
      }
      const key = id.toLowerCase();
      if (seenIds.has(key)) {
        skipped++;
        continue;
      }
      seenIds.add(key);
      const name = cols.name >= 0 ? (row.displayValues[cols.name] ?? '').trim() : '';
      const category = cols.category >= 0 ? (row.displayValues[cols.category] ?? '').trim() : '';
      parsedItems.push({ id, name, category });
    }

    // Ensure target folders exist for all non-empty categories
    const existingFolders =
      (await this.deps.workspace.repository.targetFolders?.(folderListKind)) ?? [];
    const folderIdByName = new Map<string, string>();
    for (const f of existingFolders) {
      folderIdByName.set(f.name.trim().toLowerCase(), f.id);
    }
    let foldersCreated = 0;
    const neededCategories = [
      ...new Set(parsedItems.map((i) => i.category).filter((c) => c.length > 0)),
    ];
    for (const cat of neededCategories) {
      if (!folderIdByName.has(cat.toLowerCase())) {
        await this.deps.workspace.repository.targetListCommand?.({
          action: 'create',
          listKind: folderListKind,
          name: cat,
        });
        foldersCreated++;
      }
    }
    if (foldersCreated > 0) {
      const refreshedFolders =
        (await this.deps.workspace.repository.targetFolders?.(folderListKind)) ?? [];
      folderIdByName.clear();
      for (const f of refreshedFolders) {
        folderIdByName.set(f.name.trim().toLowerCase(), f.id);
      }
    }

    // Read current local items before mutation to compute accurate stats
    const bumperState = await this.deps.groupBumper.state();
    const localBefore = isGroup ? bumperState.groups : bumperState.pages;
    const localByKey = new Map(localBefore.map((item) => [item.id.toLowerCase(), item]));

    let added = 0;
    let updated = 0;
    let deleted = 0;

    // Batch upsert in chunks of 500 (schema limit per call)
    const upsertAction = isGroup ? 'groups/add' : 'pages/add';
    const itemsToUpsert = parsedItems.map((item) => {
      const key = item.id.toLowerCase();
      const existing = localByKey.get(key);
      if (existing) updated++;
      else added++;
      const folderId = item.category
        ? (folderIdByName.get(item.category.toLowerCase()) ?? null)
        : null;
      return {
        id: item.id,
        name: item.name || existing?.name || '',
        folderId,
      };
    });

    for (let i = 0; i < itemsToUpsert.length; i += 500) {
      const chunk = itemsToUpsert.slice(i, i + 500);
      if (chunk.length > 0) {
        await this.deps.groupBumper.manage(upsertAction, { items: chunk });
      }
    }

    // Move updated existing items into their folder cleanly if category changed
    const itemsByFolder = new Map<string | null, string[]>();
    for (const item of itemsToUpsert) {
      const list = itemsByFolder.get(item.folderId) ?? [];
      list.push(item.id);
      itemsByFolder.set(item.folderId, list);
    }
    for (const [folderId, ids] of itemsByFolder.entries()) {
      if (ids.length > 0) {
        await this.deps.workspace.repository.targetListCommand?.({
          action: 'reorder-items',
          listKind: folderListKind,
          folderId,
          orderedItemIds: ids,
        });
      }
    }

    if (mode === 'overwrite') {
      const sheetKeys = new Set(parsedItems.map((item) => item.id.toLowerCase()));
      const extraIds = localBefore
        .filter((item) => !sheetKeys.has(item.id.toLowerCase()))
        .map((item) => item.id);
      if (extraIds.length > 0) {
        await this.deps.groupBumper.manage(isGroup ? 'groups/delete' : 'pages/delete', {
          ids: extraIds,
        });
        deleted = extraIds.length;
      }
    }

    const afterState = await this.deps.groupBumper.state();
    const afterList = isGroup ? afterState.groups : afterState.pages;
    const metadataRefreshTriggered = afterList.some((item) => isTargetIncomplete(item));
    const modeLabel = mode === 'overwrite' ? '覆盖导入' : '增量导入';
    const summary = `${modeLabel}完成：新增 ${added}，更新 ${updated}${deleted > 0 ? `，移除多余 ${deleted}` : ''}${foldersCreated > 0 ? `，新建分组 ${foldersCreated}` : ''}${metadataRefreshTriggered ? '（缺失名称/头像已触发后台自动补齐）' : ''}`;

    await this.repo.updateLinkRuntime(link.id, {
      lastSyncedAt: this.nowFn(),
      lastSyncSummary: summary,
      lastError: null,
    });
    await this.repo.appendLog({
      linkId: link.id,
      level: 'info',
      action: 'library_import',
      summary,
    });

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

  async syncLibraryToSheet(linkId: string): Promise<LibrarySyncSummary> {
    const link = await this.requireLink(linkId);
    if (link.kind !== 'group_library' && link.kind !== 'page_library') {
      throw new ProductError('SHEET_KIND_MISMATCH', '只有小组表或专页表支持同步至表格', 400);
    }
    const isGroup = link.kind === 'group_library';
    const targetKind: 'group' | 'page' = isGroup ? 'group' : 'page';
    const folderListKind = isGroup ? 'shared_groups' : 'bumper_pages';

    const [grid, bumperState, folders] = await Promise.all([
      this.readGrid(link.id, { force: true }),
      this.deps.groupBumper.state(),
      this.deps.workspace.repository.targetFolders?.(folderListKind) ?? Promise.resolve([]),
    ]);

    const cols = isGroup
      ? resolveGroupLibraryColumns(grid.headers)
      : resolvePageLibraryColumns(grid.headers);
    if (cols.id < 0) {
      throw new ProductError(
        'SHEET_HEADER_MISSING',
        `第一行表头未找到「${isGroup ? '小组id' : '专页id'}」列，请检查模板表头`,
        400,
      );
    }

    const folderNameById = new Map(folders.map((f) => [f.id, f.name]));
    const localTargets = isGroup ? bumperState.groups : bumperState.pages;

    // Pre-map existing permanent image formulas from sheet to avoid redundant uploads if sheet already holds one
    const existingAvatarFormulaByKey = new Map<string, string>();
    for (const row of grid.rows) {
      if (row.isHintRow) continue;
      const key = extractFacebookTargetId(
        row.displayValues[cols.id] ?? '',
        targetKind,
      ).toLowerCase();
      if (!key) continue;
      const rawFormula = cols.avatar >= 0 ? (row.values[cols.avatar] ?? '').trim() : '';
      const existingUrl = extractImageUrlFromCell(rawFormula);
      if (
        existingUrl &&
        /^https:\/\/(?:i\.gyazo\.com|lh3\.googleusercontent\.com)\//i.test(existingUrl)
      ) {
        existingAvatarFormulaByKey.set(key, toSheetsImageFormula(existingUrl));
      }
    }

    let avatarsUploaded = 0;
    const localItems = new Array<{
      id: string;
      category: string;
      name: string;
      avatarCellValue: string;
    }>(localTargets.length);

    let nextIdx = 0;
    const uploadConcurrency = Math.min(4, Math.max(1, localTargets.length));
    const uploadWorker = async () => {
      for (;;) {
        const idx = nextIdx++;
        if (idx >= localTargets.length) return;
        const item = localTargets[idx];
        if (!item) return;
        const category = item.folderId ? (folderNameById.get(item.folderId) ?? '') : '';
        let avatarCellValue = '';
        if (cols.avatar >= 0) {
          if (
            item.avatarUrl &&
            (isLocalAvatar(item.avatarUrl) || item.avatarUrl.startsWith('http'))
          ) {
            try {
              const uploaded = await this.deps.imageHost.uploadDataUrlOrUrl({
                source: item.avatarUrl,
                filenameHint: `${targetKind}-${item.id}`,
              });
              if (uploaded) {
                avatarCellValue = toSheetsImageFormula(uploaded.remoteUrl);
                if (!uploaded.cached) avatarsUploaded++;
              }
            } catch {
              avatarCellValue = existingAvatarFormulaByKey.get(item.id.toLowerCase()) ?? '';
            }
          } else {
            avatarCellValue = existingAvatarFormulaByKey.get(item.id.toLowerCase()) ?? '';
          }
        }
        localItems[idx] = {
          id: item.id,
          category,
          name: item.name,
          avatarCellValue,
        };
      }
    };
    await Promise.all(Array.from({ length: uploadConcurrency }, () => uploadWorker()));

    const diff = computeLibrarySyncDiff({
      sheetRows: grid.rows.map((r) => ({
        rowNumber: r.rowNumber,
        values: r.values,
        displayValues: r.displayValues,
        isHintRow: r.isHintRow,
      })),
      localItems,
      columns: cols,
      kind: targetKind,
    });

    // Execute in strict safe order:
    // 1. Update existing rows in place (using original row numbers BEFORE any row deletions shift indices!)
    try {
      if (diff.cellUpdates.length > 0) {
        await this.deps.sheetsApi.batchUpdateCells(
          link.spreadsheetId,
          link.sheetName,
          diff.cellUpdates,
        );
      }
      // 2. Delete extra rows bottom-to-top
      if (diff.deleteRowNumbersDesc.length > 0) {
        await this.deps.sheetsApi.deleteRowsDescending(
          link.spreadsheetId,
          link.sheetId,
          diff.deleteRowNumbersDesc,
        );
      }
      // 3. Append newly added rows
      if (diff.appends.length > 0) {
        await this.deps.sheetsApi.appendRows(link.spreadsheetId, link.sheetName, diff.appends);
      }
    } finally {
      this.invalidateGridCache(link.id);
    }

    const summary = `同步至表格完成：更新 ${diff.stats.updated}，新增 ${diff.stats.added}，删除多余 ${diff.stats.deleted}${avatarsUploaded > 0 ? `，新上传头像 ${avatarsUploaded}` : ''}`;
    await this.repo.updateLinkRuntime(link.id, {
      lastSyncedAt: this.nowFn(),
      lastSyncSummary: summary,
      lastError: null,
      totalRowCount: localItems.length,
    });
    await this.repo.appendLog({
      linkId: link.id,
      level: 'info',
      action: 'library_sync_to_sheet',
      summary,
    });

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

  // ---- Background Tick Orchestrator (Schedule + Tiered Records + 24h/72h Metrics) ----

  async tickAll(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.deps.assertSystemIdle) {
        try {
          await this.deps.assertSystemIdle('google-sheets-tick');
        } catch {
          return;
        }
      }
      const auth = await this.deps.oauth.status();
      if (!auth.authorized) return;

      const links = await this.repo.listLinks();
      const now = this.nowFn();

      for (const link of links) {
        if (!link.enabled) continue;
        if (link.kind === 'post_schedule' && link.scheduleConfig?.enabled) {
          const intervalMs = Math.max(1, link.scheduleConfig.pollIntervalMinutes) * 60_000;
          const nextDue = link.runtime.nextPollAt ?? 0;
          if (!this.runningScheduleLinks.has(link.id) && now >= nextDue) {
            await this.repo.updateLinkRuntime(link.id, { nextPollAt: now + intervalMs });
            void this.runSchedulePoll(link.id).catch(() => {});
          }
        }
        if (link.kind === 'post_records' && link.recordsConfig?.enabled) {
          const nextDue = link.runtime.nextPollAt ?? 0;
          if (!this.runningRecordLinks.has(link.id) && now >= nextDue) {
            void this.runRecordsPoll(link.id).catch(() => {});
          }
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  async triggerSchedulePoll(linkId: string): Promise<{ summary: string }> {
    if (this.runningScheduleLinks.has(linkId)) {
      throw new ProductError('SHEET_SCHEDULE_BUSY', '该排贴表正在执行检查或发帖中，请稍候', 409);
    }
    return this.runSchedulePoll(linkId, true);
  }

  async triggerRecordsPoll(linkId: string): Promise<{ summary: string }> {
    if (this.runningRecordLinks.has(linkId)) {
      throw new ProductError('SHEET_RECORDS_BUSY', '该发帖记录表正在执行顶贴检查中，请稍候', 409);
    }
    return this.runRecordsPoll(linkId);
  }

  async wakeRecordsLinkToActive(linkId: string, reason: string): Promise<void> {
    const link = await this.repo.getLink(linkId);
    if (!link || link.kind !== 'post_records') return;
    const now = this.nowFn();
    await this.repo.updateLinkRuntime(link.id, {
      pollingMode: 'active',
      consecutiveIdlePolls: 0,
      nextPollAt: now,
      lastSyncSummary: reason,
    });
    await this.repo.appendLog({
      linkId: link.id,
      level: 'info',
      action: 'records_wakeup',
      summary: `${reason} → 已切入积极监听模式（每 ${link.recordsConfig?.activePollMinutes ?? 2} 分钟）`,
    });
    if (link.recordsConfig?.enabled && !this.runningRecordLinks.has(link.id)) {
      void this.runRecordsPoll(link.id).catch(() => {});
    }
  }

  async stopLinkWork(linkId: string): Promise<void> {
    this.cancelledLinks.add(linkId);
    this.metricsAbortByLink.get(linkId)?.abort();
    for (const [pid, entry] of this.activeProfiles.entries()) {
      if (entry.linkId === linkId) {
        this.activeBluestacksAborts.get(pid)?.abort();
      }
    }
    await this.repo.updateLinkRuntime(linkId, { activeJobText: '正在停止…' });
  }

  // ---- M2: 排贴表 Execution ----

  private async runSchedulePoll(
    linkId: string,
    manualTrigger = false,
  ): Promise<{ summary: string }> {
    if (this.runningScheduleLinks.has(linkId)) {
      return { summary: '正在执行中' };
    }
    this.runningScheduleLinks.add(linkId);
    this.cancelledLinks.delete(linkId);
    let link: GoogleSheetLink | null = null;
    let intervalMs = 120_000;

    try {
      link = await this.requireLink(linkId);
      const activeLink = link;
      intervalMs = Math.max(1, activeLink.scheduleConfig?.pollIntervalMinutes ?? 2) * 60_000;
      await this.repo.updateLinkRuntime(activeLink.id, {
        activeJobText: '正在读取排贴表…',
        lastError: null,
      });

      const grid = await this.readGrid(activeLink.id, { force: true });
      const cols = resolveScheduleColumns(grid.headers);
      if (cols.pageId < 0 || cols.date < 0) {
        throw new ProductError(
          'SHEET_HEADER_MISSING',
          '排贴表缺少必填表头「发帖专页」或「发帖日期」',
          400,
        );
      }

      const now = this.nowFn();
      const AUTO_EXPIRE_MS = 60 * 60_000;
      const dueRows: Array<{
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
      }> = [];

      for (const row of grid.rows) {
        if (row.isHintRow) continue;
        const statusText = cols.status >= 0 ? (row.displayValues[cols.status] ?? '').trim() : '';
        const isExplicitRetry = /^(?:重试|重試|retry)$/i.test(statusText);
        const isEmptyOrPending =
          statusText === '' || /^(?:待发布|待發佈|待执行|待執行|等待|pending)$/i.test(statusText);
        // Terminal statuses (已完成 / 部分完成 / 失败 / 已过期 / 发布中 / 进行中) MUST NEVER auto-retry infinitely!
        if (!isEmptyOrPending && !isExplicitRetry) {
          continue;
        }
        const rawPage = (row.displayValues[cols.pageId] ?? '').trim();
        const pageId = extractFacebookTargetId(rawPage, 'page');
        if (!pageId) continue;

        const dateCell = (row.displayValues[cols.date] ?? '').trim();
        const timeCell = cols.time >= 0 ? (row.displayValues[cols.time] ?? '').trim() : '';
        const scheduledAt = parseScheduleDateTimeMs(dateCell, timeCell);
        if (!scheduledAt || scheduledAt > now) continue;

        const caption = cols.caption >= 0 ? (row.displayValues[cols.caption] ?? '').trim() : '';
        const mediaSource = cols.media >= 0 ? (row.displayValues[cols.media] ?? '').trim() : '';
        if (!caption && !mediaSource) continue;

        const postTimeline =
          cols.postTimeline >= 0 ? parseBooleanCell(row.displayValues[cols.postTimeline]) : false;
        const groupsSpecRaw =
          cols.groupsSpec >= 0 ? (row.displayValues[cols.groupsSpec] ?? '').trim() : '';
        const extraCategory =
          cols.groupCategory >= 0
            ? (row.displayValues[cols.groupCategory] ?? '').trim() || null
            : null;
        const parsedGroups = parseGroupsSpec(groupsSpecRaw, extraCategory);
        if (!postTimeline && parsedGroups.mode === 'none') continue;

        const existingResourceCode =
          cols.resourceCode >= 0 ? (row.displayValues[cols.resourceCode] ?? '').trim() : '';
        const prev = existingResourceCode
          ? await this.repo.getScheduleItem(link.id, existingResourceCode)
          : null;
        if (prev && (prev.status === 'completed' || prev.status === 'running')) {
          continue;
        }
        if (
          prev &&
          (prev.status === 'failed' || prev.status === 'partial') &&
          !isExplicitRetry &&
          !(manualTrigger && statusText === '')
        ) {
          continue;
        }

        // On automatic polling, do not unexpectedly fire rows that are already >60min past due
        if (!manualTrigger && !isExplicitRetry && !prev && now - scheduledAt > AUTO_EXPIRE_MS) {
          const expiredCode = existingResourceCode || generateResourceCode(scheduledAt);
          await this.updateScheduleRowByKey(
            link,
            row.rowNumber,
            expiredCode,
            {
              resourceCode: expiredCode,
              status: '已过期跳过',
            },
            cols,
            !existingResourceCode,
          ).catch(() => {});
          await this.repo.appendLog({
            linkId: link.id,
            level: 'warn',
            action: 'schedule_expired_skip',
            summary: `[${expiredCode}] 排贴时间已超过 60 分钟，已自动标记「已过期跳过」（如需补发可在状态列填「重试」，或清空状态后点「立即发一次」）`,
          });
          continue;
        }

        const existingThumbFormula =
          cols.thumbnail >= 0 ? (row.values[cols.thumbnail] ?? '').trim() : '';
        dueRows.push({
          row,
          pageId,
          scheduledAt,
          caption,
          mediaSource,
          aiLabel:
            cols.aiLabel >= 0 ? parseAiLabelCell(row.displayValues[cols.aiLabel]) : 'default',
          postTimeline,
          groupsSpecRaw,
          extraCategory,
          existingResourceCode,
          existingThumbnailUrl: extractImageUrlFromCell(existingThumbFormula),
          prevTimelinePosted: Boolean(prev?.timelinePosted),
          prevPostedGroupIds: [...(prev?.postedGroupIds ?? [])],
        });
      }

      if (dueRows.length === 0) {
        const summary = `检查完成，暂无到期可发的排贴任务（共 ${grid.rows.filter((r) => !r.isHintRow).length} 行）`;
        await this.repo.updateLinkRuntime(link.id, {
          lastSyncedAt: this.nowFn(),
          lastSyncSummary: summary,
          activeJobText: '',
          nextPollAt: this.nowFn() + intervalMs,
        });
        return { summary };
      }

      const carrier = activeLink.scheduleConfig?.executionCarrier ?? 'browser';
      if (carrier === 'browser' && !this.deps.automation) {
        throw new ProductError('SHEET_AUTOMATION_UNAVAILABLE', '发帖执行桥接未就绪', 503);
      }
      if (carrier === 'bluestacks' && !this.deps.bluestacks) {
        throw new ProductError('SHEET_BLUESTACKS_UNAVAILABLE', '蓝蝶模拟器发帖服务未就绪', 503);
      }
      if (carrier === 'auto' && !this.deps.automation && !this.deps.bluestacks) {
        throw new ProductError('SHEET_AUTOMATION_UNAVAILABLE', '发帖执行桥接未就绪', 503);
      }

      let executedCount = 0;
      let totalPublishedPosts = 0;
      const recordSheetHeadersCache = new Map<string, string[]>();

      for (const task of dueRows) {
        if (this.cancelledLinks.has(link.id)) break;
        const resourceCode = task.existingResourceCode || generateResourceCode(task.scheduledAt);
        const resolvedPageName = await this.resolvePageDisplayName(task.pageId, null);

        let matchedCarrier: 'browser' | 'bluestacks' | null = null;
        let executorId = '';
        let executorAccountName = resolvedPageName;
        let wokeChromeFromOffline = false;
        let busyExecutorLabel: string | null = null;

        if (carrier === 'browser' || carrier === 'auto') {
          if (this.deps.automation) {
            const profRes = await this.findOrWakeProfileForPage(task.pageId, link.id, link.title);
            if (profRes.status === 'found') {
              matchedCarrier = 'browser';
              executorId = profRes.profile.id;
              executorAccountName = profRes.profile.account.name || resolvedPageName;
              wokeChromeFromOffline = profRes.wokeFromOffline;
            } else if (profRes.status === 'busy') {
              busyExecutorLabel = profRes.label;
            }
          }
        }
        if (!matchedCarrier && (carrier === 'bluestacks' || carrier === 'auto')) {
          const bsRes = await this.findBluestacksInstanceForPage(
            task.pageId,
            resolvedPageName,
            activeLink,
          );
          if (bsRes.status === 'found') {
            matchedCarrier = 'bluestacks';
            executorId = bsRes.instance.id;
            executorAccountName = bsRes.instance.accountName || resolvedPageName;
          } else if (bsRes.status === 'busy' && !busyExecutorLabel) {
            busyExecutorLabel = bsRes.label;
          }
        }

        if (!matchedCarrier || !executorId) {
          // If a matching executor exists but is temporarily busy in another task, defer to next poll instead of permanently failing!
          if (busyExecutorLabel) {
            await this.repo.appendLog({
              linkId: link.id,
              level: 'info',
              action: 'schedule_executor_busy_defer',
              summary: `[${resourceCode}] 专页 ${task.pageId} 对应执行端（${busyExecutorLabel}）正忙，顺延下一轮自动尝试`,
            });
            continue;
          }
          const errMsg =
            carrier === 'bluestacks'
              ? `未找到匹配专页 ${task.pageId} 的可用蓝蝶模拟器`
              : carrier === 'auto'
                ? `未找到专页 ${task.pageId} 对应的浏览器或蓝蝶模拟器`
                : `未找到当前专页为 ${task.pageId} 的在线/可唤醒浏览器`;
          await this.updateScheduleRowByKey(
            link,
            task.row.rowNumber,
            resourceCode,
            {
              resourceCode,
              status: `失败：${errMsg}`,
            },
            cols,
          );
          await this.repo.appendLog({
            linkId: link.id,
            level: 'warn',
            action: 'schedule_no_browser',
            summary: `[${resourceCode}] ${errMsg}`,
          });
          continue;
        }

        let downloadedTempMediaPath: string | null = null;
        try {
          // Resolve remaining target groups + optional timeline target (skip already posted on manual retry)
          const targetList = await this.buildScheduleTargets(
            task.pageId,
            executorAccountName || task.pageId,
            task.postTimeline && !task.prevTimelinePosted,
            task.groupsSpecRaw,
            task.extraCategory,
            task.prevPostedGroupIds,
          );
          if (targetList.length === 0) {
            if (task.prevTimelinePosted || task.prevPostedGroupIds.length > 0) {
              await this.updateScheduleRowByKey(
                link,
                task.row.rowNumber,
                resourceCode,
                {
                  resourceCode,
                  status: '已完成',
                  postedGroupsCount: `${task.prevPostedGroupIds.length}/${task.prevPostedGroupIds.length}`,
                },
                cols,
              );
              continue;
            }
            const errMsg = '未匹配到可发布的目标小组（请检查小组表/类别或开启时间线）';
            await this.updateScheduleRowByKey(
              link,
              task.row.rowNumber,
              resourceCode,
              {
                resourceCode,
                status: `失败：${errMsg}`,
              },
              cols,
              !task.existingResourceCode,
            );
            continue;
          }

          // Multi-PC optimistic claim verification before downloading media & posting
          const imgHostCfg = await this.repo.getImageHostConfig();
          const thisPcTag = (imgHostCfg.defaultMachineName || '本机').trim().slice(0, 16);
          const claimNonce = randomCodeSegment(4);
          const runningClaimText =
            matchedCarrier === 'bluestacks'
              ? `蓝蝶发布中(${thisPcTag}#${claimNonce})…`
              : `发布中(${thisPcTag}#${claimNonce})…`;

          if (this.deps.sheetsApi.readColumnValues && cols.status >= 0 && cols.resourceCode >= 0) {
            await this.updateScheduleRowByKey(
              link,
              task.row.rowNumber,
              resourceCode,
              {
                resourceCode,
                status: runningClaimText,
              },
              cols,
              !task.existingResourceCode,
            );
            const verifyDelay = this.deps.claimVerifyDelayMs ?? 1200;
            if (verifyDelay > 0) {
              await new Promise((r) => setTimeout(r, verifyDelay));
            }
            const statusCol = await this.deps.sheetsApi
              .readColumnValues(link.spreadsheetId, link.sheetName, cols.status)
              .catch(() => null);
            const codeCol = await this.deps.sheetsApi
              .readColumnValues(link.spreadsheetId, link.sheetName, cols.resourceCode)
              .catch(() => null);
            // Fail-closed: both reads must succeed, our exact resourceCode must still exist,
            // and its status cell must exactly match our unique claim nonce.
            const idx =
              statusCol && codeCol
                ? codeCol.findIndex((c, i) => i >= 1 && c.trim() === resourceCode.trim())
                : -1;
            const observedStatus = idx >= 1 && statusCol ? (statusCol[idx] ?? '').trim() : '';
            if (!statusCol || !codeCol || idx < 1 || observedStatus !== runningClaimText) {
              await this.repo.appendLog({
                linkId: link.id,
                level: 'info',
                action: 'schedule_claim_lost',
                summary:
                  !statusCol || !codeCol
                    ? `[${resourceCode}] 抢占校验读取失败，为防多机重发本轮自动跳过`
                    : `[${resourceCode}] 检测到另一台电脑已抢占该排贴（状态：${observedStatus || '编号已被覆盖'}），本机自动跳过防重发`,
              });
              continue;
            }
          }

          // Prepare media & upload thumbnail ONCE (reused for all posts of this material!)
          let localFilePath: string | null = null;
          let mediaKind: 'none' | 'image' | 'video' = 'none';
          let permanentThumbnailUrl = task.existingThumbnailUrl;

          await this.repo.updateLinkRuntime(link.id, {
            activeJobText: `准备素材 · ${resourceCode}`,
          });

          try {
            if (task.mediaSource && this.deps.automation) {
              const prepared = await this.deps.automation.prepareMaterialMedia(task.mediaSource);
              localFilePath = prepared.localFilePath;
              mediaKind = prepared.mediaKind;
              if (prepared.isTemporaryCache && prepared.localFilePath) {
                downloadedTempMediaPath = prepared.localFilePath;
              }
              if (!permanentThumbnailUrl && prepared.thumbnailDataUrl) {
                const uploaded = await this.deps.imageHost
                  .uploadDataUrlOrUrl({
                    source: prepared.thumbnailDataUrl,
                    filenameHint: `thumb-${resourceCode}`,
                  })
                  .catch(() => null);
                if (uploaded) permanentThumbnailUrl = uploaded.remoteUrl;
              }
            }
          } catch (prepErr) {
            const errMsg = prepErr instanceof Error ? prepErr.message : String(prepErr);
            await this.updateScheduleRowByKey(
              link,
              task.row.rowNumber,
              resourceCode,
              {
                resourceCode,
                status: `素材准备失败：${errMsg.slice(0, 60)}`,
              },
              cols,
            );
            await this.repo.appendLog({
              linkId: link.id,
              level: 'error',
              action: 'schedule_media_error',
              summary: `[${resourceCode}] 素材准备失败：${errMsg}`,
            });
            continue;
          }

          const newGroupTargetCount = targetList.filter(
            (t) => t.id !== PAGE_TIMELINE_SYNTHETIC_GROUP_ID,
          ).length;
          const groupTargetCount = task.prevPostedGroupIds.length + newGroupTargetCount;

          // Write Resource Code + Thumbnail + Running status immediately before publishing
          await this.updateScheduleRowByKey(
            link,
            task.row.rowNumber,
            resourceCode,
            {
              resourceCode,
              thumbnailFormula: permanentThumbnailUrl
                ? toSheetsImageFormula(permanentThumbnailUrl)
                : undefined,
              status: runningClaimText,
              postedGroupsCount: `${task.prevPostedGroupIds.length}/${groupTargetCount}`,
            },
            cols,
          );

          await this.repo.upsertScheduleItem({
            linkId: link.id,
            resourceCode,
            pageId: task.pageId,
            scheduledAt: task.scheduledAt,
            caption: task.caption,
            mediaSource: task.mediaSource,
            aiLabel: task.aiLabel,
            postTimeline: task.postTimeline,
            groupsSpec: task.groupsSpecRaw,
            thumbnailUrl: permanentThumbnailUrl,
            status: 'running',
            timelinePosted: task.prevTimelinePosted,
            postedGroupIds: [...task.prevPostedGroupIds],
            targetGroupCount: groupTargetCount,
            postedGroupCount: task.prevPostedGroupIds.length,
            errorMessage: null,
            updatedAt: this.nowFn(),
          });

          const material: PosterMaterial = {
            id: resourceCode,
            caption: task.caption,
            mediaSource: task.mediaSource,
            mediaKind,
            background: 'plain',
            aiLabel: task.aiLabel,
            localFilePath,
            hasThumbnail: Boolean(permanentThumbnailUrl),
            cacheStatus: 'ready',
            cacheError: null,
            selected: true,
            sortOrder: 0,
            usedCount: 0,
            createdAt: this.nowFn(),
            updatedAt: this.nowFn(),
          };

          const postedGroupIds: string[] = [...task.prevPostedGroupIds];
          let timelinePosted = task.prevTimelinePosted;
          const pageName = await this.resolvePageDisplayName(task.pageId, executorAccountName);
          let wokeRecordsThisTask = false;

          const handleStatus = (text: string) => {
            this.updateActiveProfileStatus(executorId, activeLink.id, text);
            void Promise.resolve(
              this.repo.updateLinkRuntime(activeLink.id, {
                activeJobText: `[${resourceCode}] ${text}`,
              }),
            ).catch(() => {});
          };

          const handlePosted = async (log: PosterLog, isTimeline: boolean) => {
            totalPublishedPosts++;
            if (isTimeline) {
              timelinePosted = true;
            } else {
              postedGroupIds.push(log.groupId);
            }
            const postCode = generatePostCode(resourceCode);
            await this.repo.upsertScheduleItem({
              linkId: activeLink.id,
              resourceCode,
              pageId: task.pageId,
              scheduledAt: task.scheduledAt,
              caption: task.caption,
              mediaSource: task.mediaSource,
              aiLabel: task.aiLabel,
              postTimeline: task.postTimeline,
              groupsSpec: task.groupsSpecRaw,
              thumbnailUrl: permanentThumbnailUrl,
              status: 'running',
              timelinePosted,
              postedGroupIds,
              targetGroupCount: groupTargetCount,
              postedGroupCount: postedGroupIds.length,
              errorMessage: null,
              updatedAt: this.nowFn(),
            });

            // Write back into bound 发帖记录 sheet immediately!
            const targetRecordLinkId = activeLink.scheduleConfig?.targetRecordLinkId ?? null;
            if (targetRecordLinkId) {
              const safePostUrl = isDirectFacebookPostUrl(log.postUrl) ? log.postUrl.trim() : '';
              const safePostId = safePostUrl
                ? log.postId || extractFacebookPostIdFromUrl(safePostUrl)
                : null;
              await this.appendPostToRecordsSheet(
                targetRecordLinkId,
                {
                  postedAtMs: log.postedAt,
                  groupId: isTimeline ? '-' : log.groupId,
                  groupName: isTimeline ? '专页时间线' : log.groupName,
                  pageId: task.pageId,
                  pageName,
                  postUrl: safePostUrl,
                  postId: safePostId,
                  postCode,
                  resourceCode,
                  thumbnailUrl: permanentThumbnailUrl,
                },
                recordSheetHeadersCache,
              ).catch((err) => {
                void Promise.resolve(
                  this.repo.appendLog({
                    linkId: activeLink.id,
                    level: 'error',
                    action: 'record_writeback_error',
                    summary: `回写发帖记录失败 (${postCode})：${err instanceof Error ? err.message : String(err)}`,
                  }),
                ).catch(() => {});
              });
              // Wake bound bumping sheet into active 2m mode once per scheduled material!
              if (activeLink.scheduleConfig?.autoWakeBumper !== false && !wokeRecordsThisTask) {
                wokeRecordsThisTask = true;
                void this.wakeRecordsLinkToActive(
                  targetRecordLinkId,
                  `排贴表「${activeLink.title}」刚发布新贴 ${postCode}`,
                ).catch(() => {});
              }
            }

            // Incrementally update posted group count in 排贴表 (reusing cached row & cols!)
            await this.updateScheduleRowByKey(
              activeLink,
              task.row.rowNumber,
              resourceCode,
              {
                postedGroupsCount: `${postedGroupIds.length}/${groupTargetCount}`,
              },
              cols,
            ).catch(() => {});
          };

          let result: { postedCount: number; timelinePosted: boolean; error?: string | undefined };
          if (matchedCarrier === 'bluestacks' && this.deps.bluestacks) {
            const bsAbort = new AbortController();
            this.activeBluestacksAborts.set(executorId, bsAbort);
            try {
              result = await this.deps.bluestacks.runDirectPosterForSheet({
                instanceId: executorId,
                targetPageId: task.pageId,
                targetPageName: pageName,
                material,
                targets: targetList,
                closeOnFinish: activeLink.scheduleConfig?.closeBluestacksOnFinish !== false,
                signal: bsAbort.signal,
                onStatus: handleStatus,
                onPosted: handlePosted,
              });
            } finally {
              this.activeBluestacksAborts.delete(executorId);
            }
          } else if (this.deps.automation) {
            result = await this.deps.automation.publishScheduledMaterial({
              profileId: executorId,
              material,
              targets: targetList,
              cancelled: () =>
                this.cancelledLinks.has(activeLink.id) || this.cancelledProfiles.has(executorId),
              onStatus: handleStatus,
              onPosted: handlePosted,
            });
          } else {
            result = { postedCount: 0, timelinePosted: false, error: '发帖执行器未就绪' };
          }

          executedCount++;
          const allTimelineOk = !task.postTimeline || timelinePosted;
          const allGroupsOk = postedGroupIds.length >= groupTargetCount;
          const finalStatus =
            allTimelineOk && allGroupsOk && !result.error
              ? 'completed'
              : timelinePosted || postedGroupIds.length > 0
                ? 'partial'
                : 'failed';
          const carrierPrefix = matchedCarrier === 'bluestacks' ? '[蓝蝶] ' : '';
          const finalStatusLabel =
            finalStatus === 'completed'
              ? '已完成'
              : finalStatus === 'partial'
                ? `部分完成(${task.postTimeline ? (timelinePosted ? '时间线已发·' : '时间线未发·') : ''}小组${postedGroupIds.length}/${groupTargetCount}${result.error ? `·${result.error.slice(0, 26)}` : ''})`
                : `失败：${(result.error ?? '未发布成功').slice(0, 48)}`;

          await this.repo.upsertScheduleItem({
            linkId: link.id,
            resourceCode,
            pageId: task.pageId,
            scheduledAt: task.scheduledAt,
            caption: task.caption,
            mediaSource: task.mediaSource,
            aiLabel: task.aiLabel,
            postTimeline: task.postTimeline,
            groupsSpec: task.groupsSpecRaw,
            thumbnailUrl: permanentThumbnailUrl,
            status: finalStatus,
            timelinePosted,
            postedGroupIds,
            targetGroupCount: groupTargetCount,
            postedGroupCount: postedGroupIds.length,
            errorMessage: result.error ?? null,
            updatedAt: this.nowFn(),
          });

          await this.updateScheduleRowByKey(
            link,
            task.row.rowNumber,
            resourceCode,
            {
              resourceCode,
              status: finalStatusLabel,
              postedGroupsCount: `${postedGroupIds.length}/${groupTargetCount}`,
            },
            cols,
          );
          await this.repo.appendLog({
            linkId: link.id,
            level: finalStatus === 'failed' ? 'error' : 'info',
            action: 'schedule_publish_done',
            summary: `${carrierPrefix}[${resourceCode}] ${finalStatusLabel}（时间线：${timelinePosted ? '已发' : '未发'}，小组：${postedGroupIds.length}/${groupTargetCount}）`,
          });
        } finally {
          if (downloadedTempMediaPath && this.deps.automation?.cleanupPreparedMedia) {
            await this.deps.automation
              .cleanupPreparedMedia(downloadedTempMediaPath)
              .catch(() => {});
          }
          this.releaseProfile(executorId, link.id);
          if (wokeChromeFromOffline && matchedCarrier === 'browser' && this.deps.profileLifecycle) {
            await this.deps.profileLifecycle.closeProfile(executorId).catch(() => {});
          }
        }
      }

      const summary = `本轮处理 ${executedCount} 条排贴任务，成功发布 ${totalPublishedPosts} 篇贴文`;
      await this.repo.updateLinkRuntime(link.id, {
        lastSyncedAt: this.nowFn(),
        lastSyncSummary: summary,
        activeJobText: '',
        lastError: null,
        nextPollAt: this.nowFn() + intervalMs,
      });
      return { summary };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const failedLink = link;
      if (failedLink) {
        await Promise.resolve(
          this.repo.updateLinkRuntime(failedLink.id, {
            activeJobText: '',
            lastError: msg,
            nextPollAt: this.nowFn() + intervalMs,
          }),
        ).catch(() => {});
        await Promise.resolve(
          this.repo.appendLog({
            linkId: failedLink.id,
            level: 'error',
            action: 'schedule_poll_error',
            summary: `排贴表轮询异常：${msg}`,
          }),
        ).catch(() => {});
      }
      throw err;
    } finally {
      this.runningScheduleLinks.delete(linkId);
      this.cancelledLinks.delete(linkId);
    }
  }

  private async findOrWakeProfileForPage(
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
    const normalized = pageId.trim().toLowerCase();
    const snapshot = await this.deps.workspace.snapshot();
    const candidates = snapshot.profiles.filter(
      (p) =>
        (p.account.id ?? '').trim().toLowerCase() === normalized &&
        !['restricted', 'verification', 'logged-out'].includes(p.account.state),
    );
    if (candidates.length === 0) return { status: 'not_found' };

    const claimMeta = {
      linkId,
      kind: 'post_schedule' as const,
      title: linkTitle,
      status: '准备排贴发布…',
    };

    let sawBusyLabel: string | null = null;
    // Prefer an online, idle browser (await async isProfileBusy + atomically claim!)
    for (const p of candidates) {
      if (!p.online) continue;
      if (await this.tryClaimProfile(p.id, claimMeta)) {
        return { status: 'found', profile: p, wokeFromOffline: false };
      }
      sawBusyLabel = p.browserName || p.alias || p.id;
    }

    // Wake offline bound browser if lifecycle port is available
    const offline = candidates.find((p) => !p.online);
    if (offline && this.deps.profileLifecycle) {
      await this.deps.profileLifecycle.ensureProfilesOnline([offline.id]).catch(() => {});
      const deadline = this.nowFn() + 25_000;
      while (this.nowFn() < deadline) {
        if (this.cancelledLinks.has(linkId)) return { status: 'not_found' };
        await new Promise((r) => setTimeout(r, 1000));
        const nextSnap = await this.deps.workspace.snapshot();
        const ready = nextSnap.profiles.find((p) => p.id === offline.id && p.online);
        if (ready && (await this.tryClaimProfile(ready.id, claimMeta))) {
          return { status: 'found', profile: ready, wokeFromOffline: true };
        }
      }
    }
    if (sawBusyLabel) return { status: 'busy', label: sawBusyLabel };
    return { status: 'not_found' };
  }

  private async findBluestacksInstanceForPage(
    pageId: string,
    pageName: string,
    link: GoogleSheetLink,
  ): Promise<
    | { status: 'found'; instance: BluestacksInstance }
    | { status: 'busy'; label: string }
    | { status: 'not_found' }
  > {
    if (!this.deps.bluestacks) return { status: 'not_found' };
    const bs = await this.deps.bluestacks.state(false);
    const folderIds = new Set(link.scheduleConfig?.bluestacksFolderIds ?? []);
    const explicitIds = new Set(link.scheduleConfig?.bluestacksInstanceIds ?? []);
    const hasExplicitPool = folderIds.size > 0 || explicitIds.size > 0;

    const eligible = bs.instances.filter((inst) => {
      if (!isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight)) return false;
      if (
        inst.accountState === 'restricted' ||
        inst.accountState === 'verification' ||
        inst.accountState === 'logged-out' ||
        inst.accountState === 'missing-app'
      ) {
        return false;
      }
      if (hasExplicitPool) {
        const inFolder = inst.folderId !== null && folderIds.has(inst.folderId);
        if (!inFolder && !explicitIds.has(inst.id)) return false;
      }
      return true;
    });
    if (eligible.length === 0) return { status: 'not_found' };

    const normId = pageId.trim().toLowerCase();
    const normName = pageName.trim().toLowerCase();

    const exactIdMatches = eligible.filter(
      (i) =>
        (i.numericAccountId ?? '').trim().toLowerCase() === normId ||
        i.accountId.trim().toLowerCase() === normId,
    );
    const nameMatches = eligible.filter((i) => {
      if (!normName || normName === normId) return false;
      if (i.accountName.trim().toLowerCase() === normName) return true;
      return (i.managedIdentities ?? []).some((m) => m.name.trim().toLowerCase() === normName);
    });
    // Strict identity matching: NEVER fall back to an unrelated BlueStacks account/page!
    const ordered: BluestacksInstance[] = [];
    const seen = new Set<string>();
    for (const bucket of [exactIdMatches, nameMatches]) {
      // Prefer already-online instances within each match tier
      const sorted = [...bucket].sort((a, b) => Number(b.online) - Number(a.online));
      for (const inst of sorted) {
        if (!seen.has(inst.id)) {
          seen.add(inst.id);
          ordered.push(inst);
        }
      }
    }
    if (ordered.length === 0) return { status: 'not_found' };

    const claimMeta = {
      linkId: link.id,
      kind: 'post_schedule' as const,
      title: link.title,
      status: '准备蓝蝶排贴发布…',
    };

    for (const inst of ordered) {
      if (await this.tryClaimProfile(inst.id, claimMeta)) {
        return { status: 'found', instance: inst };
      }
    }
    const firstBusy = ordered[0];
    return {
      status: 'busy',
      label: firstBusy ? bluestacksDisplayTitle(firstBusy) : pageId,
    };
  }

  private async resolvePageDisplayName(pageId: string, fallback: string | null): Promise<string> {
    const bumperState = await this.deps.groupBumper.state();
    const found = bumperState.pages.find((p) => p.id.toLowerCase() === pageId.toLowerCase());
    return found?.name || fallback || pageId;
  }

  private async buildScheduleTargets(
    pageId: string,
    pageName: string,
    postTimeline: boolean,
    groupsSpecRaw: string,
    extraCategory: string | null,
    excludeGroupIds: readonly string[] = [],
  ): Promise<BumperTarget[]> {
    const targets: BumperTarget[] = [];
    if (postTimeline) {
      targets.push({
        id: PAGE_TIMELINE_SYNTHETIC_GROUP_ID,
        name: `${pageName}（专页时间线）`,
        avatarUrl: null,
        folderId: null,
        sortOrder: 0,
        totalBumpedCount: 0,
        createdAt: 0,
        updatedAt: 0,
      });
    }

    const spec = parseGroupsSpec(groupsSpecRaw, extraCategory);
    if (spec.mode === 'none') return targets;

    const excludedSet = new Set(excludeGroupIds.map((id) => id.trim().toLowerCase()));
    const [bumperState, folders] = await Promise.all([
      this.deps.groupBumper.state(),
      this.deps.workspace.repository.targetFolders?.('shared_groups') ?? Promise.resolve([]),
    ]);
    const allGroups = bumperState.groups;

    if (spec.mode === 'explicit') {
      const byId = new Map(allGroups.map((g) => [g.id.toLowerCase(), g]));
      const seen = new Set<string>();
      for (const gid of spec.groupIds) {
        const key = gid.toLowerCase();
        if (seen.has(key) || excludedSet.has(key)) continue;
        seen.add(key);
        const existing = byId.get(key);
        targets.push(
          existing ?? {
            id: gid,
            name: gid,
            avatarUrl: null,
            folderId: null,
            sortOrder: 0,
            totalBumpedCount: 0,
            createdAt: 0,
            updatedAt: 0,
          },
        );
      }
      return targets;
    }

    // Random draw (optionally filtered by category / folder name), strictly deduplicated within this material!
    const remainingCount = Math.max(0, spec.count - excludedSet.size);
    if (remainingCount === 0) return targets;
    let pool = allGroups.filter((g) => !excludedSet.has(g.id.toLowerCase()));
    if (spec.category) {
      const catLower = spec.category.toLowerCase();
      const matchingFolderIds = new Set(
        folders.filter((f) => f.name.trim().toLowerCase() === catLower).map((f) => f.id),
      );
      pool = pool.filter((g) => g.folderId !== null && matchingFolderIds.has(g.folderId));
    }
    const chosen = shuffleCopy(pool).slice(0, remainingCount);
    targets.push(...chosen);
    void pageId;
    return targets;
  }

  private async updateScheduleRowByKey(
    link: GoogleSheetLink,
    hintRowNumber: number,
    resourceCode: string,
    patch: {
      resourceCode?: string | undefined;
      thumbnailFormula?: string | undefined;
      status?: string | undefined;
      postedGroupsCount?: string | undefined;
    },
    cachedCols?: ReturnType<typeof resolveScheduleColumns>,
    allowInitialRowHint = false,
  ): Promise<void> {
    let cols = cachedCols;
    let rowNumber: number | null = allowInitialRowHint && hintRowNumber >= 2 ? hintRowNumber : null;
    if (!cols || hintRowNumber < 2) {
      const grid = await this.readGrid(link.id, { force: true });
      const resolvedCols = resolveScheduleColumns(grid.headers);
      cols = resolvedCols;
      const matchedByCode =
        resolvedCols.resourceCode >= 0 && resourceCode.trim()
          ? grid.rows.find(
              (r) =>
                !r.isHintRow &&
                (r.displayValues[resolvedCols.resourceCode] ?? '').trim() === resourceCode.trim(),
            )
          : undefined;
      rowNumber =
        matchedByCode?.rowNumber ??
        (allowInitialRowHint && hintRowNumber >= 2 ? hintRowNumber : null);
    } else if (
      this.deps.sheetsApi.readColumnValues &&
      cols.resourceCode >= 0 &&
      resourceCode.trim()
    ) {
      // Fast 1-column lookup to protect against mid-publish row inserts/deletes/sorts!
      const codeCol = await this.deps.sheetsApi.readColumnValues(
        link.spreadsheetId,
        link.sheetName,
        cols.resourceCode,
      );
      const matchedIdx = codeCol.findIndex(
        (val, idx) => idx >= 1 && val.trim() === resourceCode.trim(),
      );
      if (matchedIdx >= 1) {
        rowNumber = matchedIdx + 1;
      } else if (!allowInitialRowHint) {
        return;
      }
    } else if (hintRowNumber >= 2) {
      rowNumber = hintRowNumber;
    }

    if (rowNumber === null || rowNumber < 2) return;

    const updates: Array<{ rowNumber: number; colIndex: number; value: string }> = [];
    if (patch.resourceCode !== undefined && cols.resourceCode >= 0) {
      updates.push({ rowNumber, colIndex: cols.resourceCode, value: patch.resourceCode });
    }
    if (patch.thumbnailFormula !== undefined && cols.thumbnail >= 0) {
      updates.push({ rowNumber, colIndex: cols.thumbnail, value: patch.thumbnailFormula });
    }
    if (patch.status !== undefined && cols.status >= 0) {
      updates.push({ rowNumber, colIndex: cols.status, value: patch.status });
    }
    if (patch.postedGroupsCount !== undefined && cols.postedGroupsCount >= 0) {
      updates.push({
        rowNumber,
        colIndex: cols.postedGroupsCount,
        value: patch.postedGroupsCount,
      });
    }
    if (updates.length > 0) {
      await this.deps.sheetsApi.batchUpdateCells(link.spreadsheetId, link.sheetName, updates);
      this.invalidateGridCache(link.id);
    }
  }

  private async appendPostToRecordsSheet(
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
    headersCache?: Map<string, string[]>,
  ): Promise<void> {
    const recordLink = await this.repo.getLink(recordLinkId);
    if (!recordLink || recordLink.kind !== 'post_records') return;

    let headers = headersCache?.get(recordLink.id);
    if (!headers) {
      if (this.deps.sheetsApi.readHeaderRow) {
        headers = await this.deps.sheetsApi.readHeaderRow(
          recordLink.spreadsheetId,
          recordLink.sheetName,
        );
      } else {
        const grid = await this.readGrid(recordLink.id);
        headers = grid.headers;
      }
      headersCache?.set(recordLink.id, headers);
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
    if (cols.postedAt >= 0) row[cols.postedAt] = postedAtText;
    if (cols.groupId >= 0) row[cols.groupId] = entry.groupId;
    if (cols.groupName >= 0) row[cols.groupName] = entry.groupName;
    if (cols.pageId >= 0) row[cols.pageId] = entry.pageId;
    if (cols.pageName >= 0) row[cols.pageName] = entry.pageName;
    if (cols.postUrl >= 0) row[cols.postUrl] = entry.postUrl;
    // Leave cols.groupAvatar and cols.pageAvatar as null so Sheets API skips writing them,
    // preserving BOTH ARRAYFORMULA and pre-filled row-level VLOOKUP/XLOOKUP formulas!
    if (cols.postCode >= 0) row[cols.postCode] = entry.postCode;
    if (cols.thumbnail >= 0 && entry.thumbnailUrl) {
      row[cols.thumbnail] = toSheetsImageFormula(entry.thumbnailUrl);
    }

    await this.deps.sheetsApi.appendRows(recordLink.spreadsheetId, recordLink.sheetName, [row]);
    this.invalidateGridCache(recordLink.id);
    await this.repo.upsertRecordPost({
      linkId: recordLink.id,
      postCode: entry.postCode,
      resourceCode: entry.resourceCode,
      postedAtText,
      postedAtMs: entry.postedAtMs,
      groupId: entry.groupId,
      groupName: entry.groupName,
      pageId: entry.pageId,
      pageName: entry.pageName,
      postUrl: entry.postUrl,
      postId: entry.postId,
      thumbnailUrl: entry.thumbnailUrl,
      likesCount: null,
      commentsCount: null,
      metricsStage: 0,
      metricsUpdatedAt: null,
      localBumpedCount: 0,
      bumpedProfileIds: [],
      createdAt: this.nowFn(),
      updatedAt: this.nowFn(),
    });
  }

  // ---- M3 + M4: 发帖记录 Tiered Listener + Direct-URL Bumping + 24h/72h Metrics ----

  private async runRecordsPoll(linkId: string): Promise<{ summary: string }> {
    if (this.runningRecordLinks.has(linkId)) {
      return { summary: '正在检查中' };
    }
    this.runningRecordLinks.add(linkId);
    this.cancelledLinks.delete(linkId);
    let link: GoogleSheetLink | null = null;
    let semiActiveFallbackMin = 10;

    try {
      link = await this.requireLink(linkId);
      const activeLink = link;
      const cfg = activeLink.recordsConfig;
      if (!cfg) {
        throw new ProductError('SHEET_CONFIG_MISSING', '发帖记录表缺少配置', 400);
      }
      semiActiveFallbackMin = Math.max(2, cfg.semiActivePollMinutes);

      await this.repo.updateLinkRuntime(activeLink.id, {
        activeJobText: '正在扫描发帖记录表…',
        lastError: null,
      });

      const grid = await this.readGrid(activeLink.id, { force: true });
      const cols = resolveRecordColumns(grid.headers, cfg.machineName);
      if (cols.postUrl < 0) {
        throw new ProductError('SHEET_HEADER_MISSING', '发帖记录表第一行未找到「贴文链接」列', 400);
      }

      const existingKnown = await this.repo.listRecordPosts(activeLink.id);
      const knownByCode = new Map(existingKnown.map((r) => [r.postCode, r]));

      let newlyDiscoveredCount = 0;
      const pendingBumpPosts: Array<{
        item: DirectPostBumpItem;
        rowNumber: number;
        record: SheetRecordPostPortRecord;
      }> = [];
      const reconcileBumpCells: Array<{
        postCode: string;
        postUrl: string;
        value: string;
      }> = [];

      for (const row of grid.rows) {
        if (row.isHintRow) continue;
        const postUrl = (row.displayValues[cols.postUrl] ?? '').trim();
        if (!postUrl.startsWith('http')) continue;

        const rawPostCode =
          cols.postCode >= 0 ? (row.displayValues[cols.postCode] ?? '').trim() : '';
        const postId = extractFacebookPostIdFromUrl(postUrl);
        const postCode = rawPostCode || `URL-${postId ?? row.rowNumber}`;

        const existing = knownByCode.get(postCode) ?? null;
        const sheetMachineCountRaw =
          cols.machineColumn >= 0 ? (row.displayValues[cols.machineColumn] ?? '').trim() : '';
        const sheetMachineCount = /^\d+$/.test(sheetMachineCountRaw)
          ? Number(sheetMachineCountRaw)
          : 0;
        const record = this.buildRecordFromRow(
          activeLink.id,
          row,
          cols,
          postCode,
          postUrl,
          postId,
          existing,
        );
        if (!existing) {
          newlyDiscoveredCount++;
        }
        await this.repo.upsertRecordPost(record);
        knownByCode.set(postCode, record);

        // Self-heal any previously buffered local bump count that never reached Google Sheets
        if (record.localBumpedCount > sheetMachineCount) {
          reconcileBumpCells.push({
            postCode,
            postUrl,
            value: String(record.localBumpedCount),
          });
        }

        // Eligible for bumping ONLY if postUrl is a verified direct single-post permalink
        // (never bump group/page homepages!), post age is within maxPostAgeHours,
        // and this machine hasn't reached maxLikesPerPost.
        if (!isDirectFacebookPostUrl(postUrl)) continue;
        const ageHours = record.postedAtMs ? (this.nowFn() - record.postedAtMs) / 3_600_000 : 0;
        const maxAgeHours = Math.max(1, cfg.bumperSettings.maxPostAgeHours);
        if (
          ageHours <= maxAgeHours &&
          record.localBumpedCount < cfg.bumperSettings.maxLikesPerPost
        ) {
          pendingBumpPosts.push({
            rowNumber: row.rowNumber,
            record,
            item: {
              postCode,
              postUrl,
              postId,
              groupId: record.groupId,
              groupName: record.groupName,
              pageId: record.pageId,
              pageName: record.pageName,
            },
          });
        }
      }

      // Resolve bound bumping browser profiles (including wakeable offline profiles!) AND bound BlueStacks emulator instances
      const [bumperProfiles, bumperBluestacks] = await Promise.all([
        this.resolveBoundBumperProfiles(
          cfg.bumperProfileGroupIds,
          cfg.bumperProfileIds,
          Boolean(this.deps.profileLifecycle),
        ),
        this.resolveBoundBluestacksInstances(
          cfg.bumperBluestacksFolderIds,
          cfg.bumperBluestacksIds,
        ),
      ]);

      let totalBumpsThisRound = 0;

      const hasChromeWorkers = bumperProfiles.length > 0 && Boolean(this.deps.automation);
      const hasBsWorkers = bumperBluestacks.length > 0 && Boolean(this.deps.bluestacks);

      if (pendingBumpPosts.length > 0 && !hasChromeWorkers && !hasBsWorkers) {
        const hasAnyBound =
          cfg.bumperProfileGroupIds.length > 0 ||
          cfg.bumperProfileIds.length > 0 ||
          cfg.bumperBluestacksFolderIds.length > 0 ||
          cfg.bumperBluestacksIds.length > 0;
        await this.repo.appendLog({
          linkId: activeLink.id,
          level: 'warn',
          action: 'records_no_workers',
          summary: hasAnyBound
            ? `发现 ${pendingBumpPosts.length} 条待顶贴，但所选顶贴账号组暂无在线或可唤醒的浏览器/蓝蝶`
            : `发现 ${pendingBumpPosts.length} 条待顶贴，但尚未在顶栏「选择顶贴账号组」中绑定任何浏览器或蓝蝶分组`,
        });
      }

      if (
        reconcileBumpCells.length > 0 &&
        !(pendingBumpPosts.length > 0 && (hasChromeWorkers || hasBsWorkers))
      ) {
        try {
          const machineColIndex = await this.deps.sheetsApi.ensureHeaderColumn(
            activeLink.spreadsheetId,
            activeLink.sheetName,
            grid.headers,
            cfg.machineName,
          );
          if (machineColIndex >= grid.headers.length) {
            this.invalidateGridCache(activeLink.id);
          }
          await this.writeBatchRecordCellsByKey(
            activeLink,
            machineColIndex,
            reconcileBumpCells,
            cols,
          );
        } catch {
          /* Non-fatal reconciliation retry on next poll */
        }
      }

      if (pendingBumpPosts.length > 0 && (hasChromeWorkers || hasBsWorkers)) {
        // Ensure machine name column header exists once before writing counts
        const machineColIndex = await this.deps.sheetsApi.ensureHeaderColumn(
          activeLink.spreadsheetId,
          activeLink.sheetName,
          grid.headers,
          cfg.machineName,
        );
        if (machineColIndex >= grid.headers.length) {
          this.invalidateGridCache(activeLink.id);
        }

        // Track reserved in-flight bump slots per postCode so parallel browsers & BlueStacks never oversubscribe maxLikesPerPost!
        const reservedByPostCode = new Map<string, number>();
        let liveCommentPool = [...cfg.commentPool];

        const consumeCommentFromPool = async (usedComment: string): Promise<void> => {
          if (!cfg.bumperSettings.consumeCommentOnUse || !usedComment) return;
          await this.runSerializedRecordWrite(`${activeLink.id}:comment-pool`, async () => {
            const idx = liveCommentPool.indexOf(usedComment);
            if (idx >= 0) {
              liveCommentPool = [
                ...liveCommentPool.slice(0, idx),
                ...liveCommentPool.slice(idx + 1),
              ];
              await this.repo.updateLink({
                id: activeLink.id,
                recordsConfig: { commentPool: liveCommentPool },
              });
            }
          });
        };

        // Debounced batcher merges per-bump Sheets count writebacks (1 column read + 1 batchUpdate
        // per burst instead of 2 API calls per bump, preventing Google 60 writes/min 429 storms).
        const pendingBumpCells = new Map<
          string,
          { postCode: string; postUrl: string; value: string; hintRowNumber?: number | undefined }
        >();
        for (const recCell of reconcileBumpCells) {
          pendingBumpCells.set(recCell.postCode, recCell);
        }
        let bumpFlushTimer: ReturnType<typeof setTimeout> | null = null;
        let bumpFlushTail: Promise<void> = Promise.resolve();

        const flushBumpWritebacksNow = async (): Promise<void> => {
          if (bumpFlushTimer) {
            clearTimeout(bumpFlushTimer);
            bumpFlushTimer = null;
          }
          const runFlush = async () => {
            if (pendingBumpCells.size === 0) return;
            const batchSnapshot = [...pendingBumpCells.values()];
            pendingBumpCells.clear();
            try {
              await this.writeBatchRecordCellsByKey(
                activeLink,
                machineColIndex,
                batchSnapshot,
                cols,
              );
            } catch (err) {
              for (const item of batchSnapshot) {
                if (!pendingBumpCells.has(item.postCode)) {
                  pendingBumpCells.set(item.postCode, item);
                }
              }
              await Promise.resolve(
                this.repo.appendLog({
                  linkId: activeLink.id,
                  level: 'warn',
                  action: 'records_bump_writeback_retry',
                  summary: `批量回写顶贴计数暂时失败（${batchSnapshot.length} 条），将在本轮结束时重试：${err instanceof Error ? err.message : String(err)}`,
                }),
              ).catch(() => {});
            }
          };
          const next = bumpFlushTail.then(runFlush, runFlush);
          bumpFlushTail = next;
          await next;
        };

        const scheduleBumpWriteback = (entry: {
          postCode: string;
          postUrl: string;
          value: string;
          hintRowNumber?: number | undefined;
        }) => {
          pendingBumpCells.set(entry.postCode, entry);
          if (pendingBumpCells.size >= 25) {
            void flushBumpWritebacksNow();
            return;
          }
          if (!bumpFlushTimer) {
            bumpFlushTimer = setTimeout(() => {
              bumpFlushTimer = null;
              void flushBumpWritebacksNow();
            }, 2500);
          }
        };

        const recordPostBumpOutcome = async (
          workerId: string,
          postCode: string,
          postUrl: string,
        ): Promise<void> => {
          await this.runSerializedRecordWrite(`${activeLink.id}:${postCode}`, async () => {
            totalBumpsThisRound++;
            const memEntry = pendingBumpPosts.find((t) => t.item.postCode === postCode);
            const currentRec =
              (await this.repo.getRecordPost(activeLink.id, postCode)) ?? memEntry?.record;
            if (!currentRec) return;
            const nextBumpedProfiles = [...new Set([...currentRec.bumpedProfileIds, workerId])];
            const nextCount = Math.max(currentRec.localBumpedCount + 1, nextBumpedProfiles.length);
            const updatedRec = {
              ...currentRec,
              localBumpedCount: nextCount,
              bumpedProfileIds: nextBumpedProfiles,
              updatedAt: this.nowFn(),
            };
            await this.repo.upsertRecordPost(updatedRec);
            if (memEntry) memEntry.record = updatedRec;
            const curRes = reservedByPostCode.get(postCode) ?? 0;
            if (curRes > 0) reservedByPostCode.set(postCode, curRes - 1);

            scheduleBumpWriteback({
              postCode,
              postUrl,
              value: String(nextCount),
              hintRowNumber: memEntry?.rowNumber,
            });
          });
        };

        const poolPromises: Promise<void>[] = [];

        if (hasChromeWorkers) {
          const effectiveConcurrency =
            this.globalMaxConcurrentProfiles ?? cfg.bumperSettings.maxConcurrentProfiles;
          const maxParallel = Math.min(Math.max(1, effectiveConcurrency), bumperProfiles.length);
          const profileQueue = [...bumperProfiles];

          const chromeWorkerRun = async () => {
            for (;;) {
              if (this.cancelledLinks.has(activeLink.id)) return;
              const profile = profileQueue.shift();
              if (!profile) return;

              if (
                !(await this.tryClaimProfile(profile.id, {
                  linkId: activeLink.id,
                  kind: 'post_records',
                  title: activeLink.title,
                  status: '准备顶贴…',
                }))
              ) {
                continue;
              }

              const todoForProfile: typeof pendingBumpPosts = [];
              for (const entry of pendingBumpPosts) {
                if (entry.record.bumpedProfileIds.includes(profile.id)) continue;
                const reserved = reservedByPostCode.get(entry.item.postCode) ?? 0;
                if (
                  entry.record.localBumpedCount + reserved >=
                  cfg.bumperSettings.maxLikesPerPost
                ) {
                  continue;
                }
                reservedByPostCode.set(entry.item.postCode, reserved + 1);
                todoForProfile.push(entry);
              }
              if (todoForProfile.length === 0) {
                this.releaseProfile(profile.id, activeLink.id);
                continue;
              }

              const wasAlreadyOnline = profile.online;
              const bumpedInWorker = new Set<string>();
              try {
                if (!wasAlreadyOnline && this.deps.profileLifecycle) {
                  this.updateActiveProfileStatus(profile.id, activeLink.id, '正在唤醒浏览器…');
                  await this.deps.profileLifecycle
                    .ensureProfilesOnline([profile.id])
                    .catch(() => {});
                  const wakeDeadline = this.nowFn() + 25_000;
                  let wokeOnline = false;
                  while (this.nowFn() < wakeDeadline) {
                    if (
                      this.cancelledLinks.has(activeLink.id) ||
                      this.cancelledProfiles.has(profile.id)
                    ) {
                      break;
                    }
                    const nextSnap = await this.deps.workspace.snapshot();
                    if (nextSnap.profiles.some((p) => p.id === profile.id && p.online)) {
                      wokeOnline = true;
                      break;
                    }
                    await new Promise((r) => setTimeout(r, 1000));
                  }
                  if (!wokeOnline) {
                    throw new Error('离线浏览器未能按时唤醒上线（请检查启动路径绑定）');
                  }
                }
                await this.deps.automation?.bumpDirectPosts({
                  profileId: profile.id,
                  posts: todoForProfile.map((t) => t.item),
                  settings: cfg.bumperSettings,
                  commentPool: [...liveCommentPool],
                  cancelled: () =>
                    this.cancelledLinks.has(activeLink.id) ||
                    this.cancelledProfiles.has(profile.id),
                  onStatus: (text) => {
                    this.updateActiveProfileStatus(profile.id, activeLink.id, text);
                    void Promise.resolve(
                      this.repo.updateLinkRuntime(activeLink.id, {
                        activeJobText: `${profile.browserName || profile.alias} · ${text}`,
                      }),
                    ).catch(() => {});
                  },
                  onCommentConsumed: cfg.bumperSettings.consumeCommentOnUse
                    ? consumeCommentFromPool
                    : undefined,
                  onPostBumped: async (res) => {
                    bumpedInWorker.add(res.postCode);
                    await recordPostBumpOutcome(profile.id, res.postCode, res.postUrl);
                  },
                });
              } catch (workerErr) {
                await this.repo.appendLog({
                  linkId: activeLink.id,
                  level: 'warn',
                  action: 'records_bump_worker_error',
                  summary: `顶贴浏览器 ${profile.browserName || profile.alias} 中止：${workerErr instanceof Error ? workerErr.message : String(workerErr)}`,
                });
              } finally {
                for (const entry of todoForProfile) {
                  if (!bumpedInWorker.has(entry.item.postCode)) {
                    const curRes = reservedByPostCode.get(entry.item.postCode) ?? 0;
                    if (curRes > 0) reservedByPostCode.set(entry.item.postCode, curRes - 1);
                  }
                }
                this.releaseProfile(profile.id, activeLink.id);
                if (!wasAlreadyOnline && this.deps.profileLifecycle) {
                  await this.deps.profileLifecycle.closeProfile(profile.id).catch(() => {});
                }
              }
            }
          };

          poolPromises.push(...Array.from({ length: maxParallel }, () => chromeWorkerRun()));
        }

        if (hasBsWorkers && this.deps.bluestacks) {
          const bluestacksSvc = this.deps.bluestacks;
          const bsConcurrency =
            this.globalMaxConcurrentBluestacks ??
            Math.min(5, Math.max(1, cfg.bumperSettings.maxConcurrentProfiles));
          const maxBsParallel = Math.min(Math.max(1, bsConcurrency), bumperBluestacks.length);
          const bsQueue = [...bumperBluestacks];

          const bsWorkerRun = async () => {
            for (;;) {
              if (this.cancelledLinks.has(activeLink.id)) return;
              const inst = bsQueue.shift();
              if (!inst) return;

              const instLabel = bluestacksDisplayTitle(inst);
              if (
                !(await this.tryClaimProfile(inst.id, {
                  linkId: activeLink.id,
                  kind: 'post_records',
                  title: activeLink.title,
                  status: '准备蓝蝶顶贴…',
                }))
              ) {
                continue;
              }

              const todoForInst: typeof pendingBumpPosts = [];
              for (const entry of pendingBumpPosts) {
                if (entry.record.bumpedProfileIds.includes(inst.id)) continue;
                const reserved = reservedByPostCode.get(entry.item.postCode) ?? 0;
                if (
                  entry.record.localBumpedCount + reserved >=
                  cfg.bumperSettings.maxLikesPerPost
                ) {
                  continue;
                }
                reservedByPostCode.set(entry.item.postCode, reserved + 1);
                todoForInst.push(entry);
              }
              if (todoForInst.length === 0) {
                this.releaseProfile(inst.id, activeLink.id);
                continue;
              }

              const wasAlreadyOnline = inst.online;
              const ctrl = new AbortController();
              this.activeBluestacksAborts.set(inst.id, ctrl);
              const postCodeById = new Map<string, { postCode: string; postUrl: string }>();
              const postsInput = todoForInst.map((t) => {
                const pid = t.item.postId ?? t.item.postCode;
                postCodeById.set(pid, {
                  postCode: t.item.postCode,
                  postUrl: t.item.postUrl,
                });
                return {
                  postId: pid,
                  postUrl: t.item.postUrl,
                  groupId: t.item.groupId,
                  groupName: t.item.groupName,
                  pageId: t.item.pageId,
                  pageName: t.item.pageName,
                };
              });

              const bumpedInWorker = new Set<string>();
              try {
                await bluestacksSvc.runDirectPostsForSheet({
                  instanceId: inst.id,
                  posts: postsInput,
                  settings: cfg.bumperSettings,
                  commentPool: [...liveCommentPool],
                  signal: ctrl.signal,
                  onProgress: (text) => {
                    this.updateActiveProfileStatus(inst.id, activeLink.id, text);
                    void Promise.resolve(
                      this.repo.updateLinkRuntime(activeLink.id, {
                        activeJobText: `[蓝蝶] ${instLabel} · ${text}`,
                      }),
                    ).catch(() => {});
                  },
                  onPostDone: async (res) => {
                    const meta = postCodeById.get(res.postId);
                    if (!meta) return;
                    bumpedInWorker.add(meta.postCode);
                    if (res.commentText) {
                      await consumeCommentFromPool(res.commentText);
                    }
                    await recordPostBumpOutcome(inst.id, meta.postCode, meta.postUrl);
                  },
                });
              } catch (workerErr) {
                if (!ctrl.signal.aborted) {
                  await this.repo.appendLog({
                    linkId: activeLink.id,
                    level: 'warn',
                    action: 'records_bump_bluestacks_error',
                    summary: `蓝蝶实例 ${instLabel} 顶贴中止：${workerErr instanceof Error ? workerErr.message : String(workerErr)}`,
                  });
                }
              } finally {
                this.activeBluestacksAborts.delete(inst.id);
                for (const entry of todoForInst) {
                  if (!bumpedInWorker.has(entry.item.postCode)) {
                    const curRes = reservedByPostCode.get(entry.item.postCode) ?? 0;
                    if (curRes > 0) reservedByPostCode.set(entry.item.postCode, curRes - 1);
                  }
                }
                this.releaseProfile(inst.id, activeLink.id);
                if (!wasAlreadyOnline) {
                  await bluestacksSvc.closeInstanceForce(inst.id).catch(() => {});
                }
              }
            }
          };

          poolPromises.push(...Array.from({ length: maxBsParallel }, () => bsWorkerRun()));
        }

        this.activeBumpFlushers.set(activeLink.id, flushBumpWritebacksNow);
        try {
          await Promise.all(poolPromises);
        } finally {
          await flushBumpWritebacksNow();
          if (this.activeBumpFlushers.get(activeLink.id) === flushBumpWritebacksNow) {
            this.activeBumpFlushers.delete(activeLink.id);
          }
        }
      }

      // Trigger 24h + 72h engagement metrics scraping if enabled for this PC
      let metricsSummary = '';
      if (cfg.collectMetricsOnThisPc && !this.cancelledLinks.has(activeLink.id)) {
        try {
          const mRes = await this.collectDueMetricsForLink(activeLink.id, false);
          if (mRes.updated > 0) {
            metricsSummary = `；刷新赞/评 ${mRes.updated} 条`;
          }
        } catch (mErr) {
          await this.repo.appendLog({
            linkId: activeLink.id,
            level: 'warn',
            action: 'metrics_scrape_error',
            summary: `赞/评采集异常：${mErr instanceof Error ? mErr.message : String(mErr)}`,
          });
        }
      }

      // Compute next tiered polling interval (2m Active vs 10m Semi-Active after 5 idle polls)
      const hasNewActivity = newlyDiscoveredCount > 0 || totalBumpsThisRound > 0;
      const nextTier = nextTieredPollingState({
        currentMode: activeLink.runtime.pollingMode,
        consecutiveIdlePolls: activeLink.runtime.consecutiveIdlePolls,
        hasNewActivity,
        activePollMinutes: cfg.activePollMinutes,
        semiActivePollMinutes: cfg.semiActivePollMinutes,
        semiActiveAfterIdlePolls: cfg.semiActiveAfterIdlePolls,
        nowMs: this.nowFn(),
      });

      const modeText =
        nextTier.pollingMode === 'active'
          ? `积极监听(${cfg.activePollMinutes}m)`
          : `半积极(${cfg.semiActivePollMinutes}m)`;
      const summary = `新贴 ${newlyDiscoveredCount}，本轮顶贴 ${totalBumpsThisRound}${metricsSummary} · ${modeText}`;
      await this.repo.updateLinkRuntime(activeLink.id, {
        lastSyncedAt: this.nowFn(),
        lastSyncSummary: summary,
        pollingMode: nextTier.pollingMode,
        consecutiveIdlePolls: nextTier.consecutiveIdlePolls,
        nextPollAt: nextTier.nextPollAt,
        activeJobText: '',
        lastError: null,
      });
      if (hasNewActivity || metricsSummary) {
        await this.repo.appendLog({
          linkId: activeLink.id,
          level: 'info',
          action: 'records_poll',
          summary,
        });
      }
      return { summary };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const failedLink = link;
      if (failedLink) {
        await Promise.resolve(
          this.repo.updateLinkRuntime(failedLink.id, {
            activeJobText: '',
            lastError: msg,
            nextPollAt: this.nowFn() + semiActiveFallbackMin * 60_000,
          }),
        ).catch(() => {});
        await Promise.resolve(
          this.repo.appendLog({
            linkId: failedLink.id,
            level: 'error',
            action: 'records_poll_error',
            summary: `发帖记录监听异常：${msg}`,
          }),
        ).catch(() => {});
      }
      throw err;
    } finally {
      this.runningRecordLinks.delete(linkId);
      this.cancelledLinks.delete(linkId);
    }
  }

  private buildRecordFromRow(
    linkId: string,
    row: SheetGridRow,
    cols: ReturnType<typeof resolveRecordColumns>,
    postCode: string,
    postUrl: string,
    postId: string | null,
    existing: Awaited<ReturnType<GoogleSheetsRepositoryPort['getRecordPost']>>,
  ) {
    const postedAtText = cols.postedAt >= 0 ? (row.displayValues[cols.postedAt] ?? '').trim() : '';
    const postedAtMs = postedAtText ? parseScheduleDateTimeMs(postedAtText, '') : null;
    const sheetMachineCountRaw =
      cols.machineColumn >= 0 ? (row.displayValues[cols.machineColumn] ?? '').trim() : '';
    const sheetMachineCount = /^\d+$/.test(sheetMachineCountRaw) ? Number(sheetMachineCountRaw) : 0;
    const likesRaw = cols.likes >= 0 ? (row.displayValues[cols.likes] ?? '').trim() : '';
    const commentsRaw = cols.comments >= 0 ? (row.displayValues[cols.comments] ?? '').trim() : '';

    return {
      linkId,
      postCode,
      resourceCode: postCode.split('-').slice(0, 2).join('-'),
      postedAtText: postedAtText || existing?.postedAtText || '',
      postedAtMs: postedAtMs ?? existing?.postedAtMs ?? null,
      groupId:
        (cols.groupId >= 0 ? (row.displayValues[cols.groupId] ?? '').trim() : '') ||
        existing?.groupId ||
        '',
      groupName:
        (cols.groupName >= 0 ? (row.displayValues[cols.groupName] ?? '').trim() : '') ||
        existing?.groupName ||
        '',
      pageId:
        (cols.pageId >= 0 ? (row.displayValues[cols.pageId] ?? '').trim() : '') ||
        existing?.pageId ||
        '',
      pageName:
        (cols.pageName >= 0 ? (row.displayValues[cols.pageName] ?? '').trim() : '') ||
        existing?.pageName ||
        '',
      postUrl,
      postId: postId ?? existing?.postId ?? null,
      thumbnailUrl:
        (cols.thumbnail >= 0 ? extractImageUrlFromCell(row.values[cols.thumbnail]) : null) ??
        existing?.thumbnailUrl ??
        null,
      likesCount: /^\d+$/.test(likesRaw) ? Number(likesRaw) : (existing?.likesCount ?? null),
      commentsCount: /^\d+$/.test(commentsRaw)
        ? Number(commentsRaw)
        : (existing?.commentsCount ?? null),
      metricsStage: existing?.metricsStage ?? 0,
      metricsUpdatedAt: existing?.metricsUpdatedAt ?? null,
      localBumpedCount: Math.max(existing?.localBumpedCount ?? 0, sheetMachineCount),
      bumpedProfileIds: existing?.bumpedProfileIds ?? [],
      createdAt: existing?.createdAt ?? this.nowFn(),
      updatedAt: this.nowFn(),
    };
  }

  private async resolveBoundBumperProfiles(
    groupIds: readonly string[],
    profileIds: readonly string[],
    includeOfflineWakeable = false,
  ) {
    const snap = await this.deps.workspace.snapshot();
    const groupSet = new Set(groupIds);
    const idSet = new Set(profileIds);
    const eligible: typeof snap.profiles = [];
    for (const p of snap.profiles) {
      if (!p.online && !includeOfflineWakeable) continue;
      if (['restricted', 'verification', 'logged-out'].includes(p.account.state)) continue;
      if (!((p.groupId !== null && groupSet.has(p.groupId)) || idSet.has(p.id))) continue;
      if (await this.isProfileBusyElsewhere(p.id)) continue;
      eligible.push(p);
    }
    // Prefer already-online browsers before waking offline ones
    eligible.sort((a, b) => Number(b.online) - Number(a.online));
    return eligible;
  }

  private async resolveBoundBluestacksInstances(
    folderIds: readonly string[],
    instanceIds: readonly string[],
  ) {
    if (!this.deps.bluestacks || (folderIds.length === 0 && instanceIds.length === 0)) {
      return [];
    }
    const bs = await this.deps.bluestacks.state(false);
    const folderSet = new Set(folderIds);
    const idSet = new Set(instanceIds);
    const eligible: typeof bs.instances = [];
    for (const inst of bs.instances) {
      if (['restricted', 'verification', 'logged-out', 'missing-app'].includes(inst.accountState)) {
        continue;
      }
      if (!((inst.folderId !== null && folderSet.has(inst.folderId)) || idSet.has(inst.id))) {
        continue;
      }
      if (await this.isProfileBusyElsewhere(inst.id)) continue;
      eligible.push(inst);
    }
    return eligible;
  }

  private async writeBatchRecordCellsByKey(
    link: GoogleSheetLink,
    colIndex: number,
    entries: ReadonlyArray<{
      postCode: string;
      postUrl: string;
      value: string;
      hintRowNumber?: number | undefined;
    }>,
    cachedCols?: ReturnType<typeof resolveRecordColumns>,
  ): Promise<void> {
    if (entries.length === 0) return;

    const rowByCode = new Map<string, number>();
    const rowByUrl = new Map<string, number>();
    let usedKeyColumnRead = false;

    if (this.deps.sheetsApi.readColumnValues && cachedCols) {
      if (cachedCols.postCode >= 0 && entries.some((e) => e.postCode.trim())) {
        usedKeyColumnRead = true;
        const col = await this.deps.sheetsApi.readColumnValues(
          link.spreadsheetId,
          link.sheetName,
          cachedCols.postCode,
        );
        for (let i = 1; i < col.length; i++) {
          const key = (col[i] ?? '').trim();
          if (key && !rowByCode.has(key)) rowByCode.set(key, i + 1);
        }
      }
      const needsUrlFallback = entries.some(
        (e) => !rowByCode.has(e.postCode.trim()) && e.postUrl.trim(),
      );
      if (needsUrlFallback && cachedCols.postUrl >= 0) {
        usedKeyColumnRead = true;
        const col = await this.deps.sheetsApi.readColumnValues(
          link.spreadsheetId,
          link.sheetName,
          cachedCols.postUrl,
        );
        for (let i = 1; i < col.length; i++) {
          const key = (col[i] ?? '').trim();
          if (key && !rowByUrl.has(key)) rowByUrl.set(key, i + 1);
        }
      }
    }

    const updates: Array<{ rowNumber: number; colIndex: number; value: string }> = [];
    const unresolved: typeof entries extends ReadonlyArray<infer T> ? T[] : never = [];
    for (const entry of entries) {
      const resolvedRow =
        rowByCode.get(entry.postCode.trim()) ?? rowByUrl.get(entry.postUrl.trim());
      if (resolvedRow && resolvedRow >= 2) {
        updates.push({ rowNumber: resolvedRow, colIndex, value: entry.value });
      } else if (!usedKeyColumnRead) {
        unresolved.push(entry);
      }
    }

    if (unresolved.length > 0) {
      const grid = await this.readGrid(link.id, { force: true });
      const cols = resolveRecordColumns(grid.headers);
      for (const entry of unresolved) {
        const matched = grid.rows.find((r) => {
          if (r.isHintRow) return false;
          const code = cols.postCode >= 0 ? (r.displayValues[cols.postCode] ?? '').trim() : '';
          const url = cols.postUrl >= 0 ? (r.displayValues[cols.postUrl] ?? '').trim() : '';
          return (code && code === entry.postCode.trim()) || (url && url === entry.postUrl.trim());
        });
        if (matched) {
          updates.push({ rowNumber: matched.rowNumber, colIndex, value: entry.value });
        }
      }
    }

    if (updates.length > 0) {
      await this.deps.sheetsApi.batchUpdateCells(link.spreadsheetId, link.sheetName, updates);
      this.invalidateGridCache(link.id);
    }
  }

  // ---- M4: 24h + 72h Post Engagement Metrics Scraper ----

  async refreshRecordMetrics(
    linkId: string,
  ): Promise<{ updated: number; failed: number; summary: string }> {
    return this.collectDueMetricsForLink(linkId, true);
  }

  private async collectDueMetricsForLink(
    linkId: string,
    forceAllEligible: boolean,
  ): Promise<{ updated: number; failed: number; summary: string }> {
    if (this.runningMetricsLinks.has(linkId)) {
      return { updated: 0, failed: 0, summary: '赞/评采集正在运行中' };
    }
    this.runningMetricsLinks.add(linkId);
    const abortCtrl = new AbortController();
    this.metricsAbortByLink.set(linkId, abortCtrl);
    let claimedScraperProfileId: string | null = null;

    try {
      const link = await this.requireLink(linkId);
      if (link.kind !== 'post_records') {
        throw new ProductError('SHEET_KIND_MISMATCH', '只有发帖记录表支持采集点赞和留言数', 400);
      }
      if (!this.deps.automation) {
        throw new ProductError('SHEET_AUTOMATION_UNAVAILABLE', '采集桥接未就绪', 503);
      }

      const grid = await this.readGrid(link.id, { force: forceAllEligible });
      const cols = resolveRecordColumns(grid.headers, link.recordsConfig?.machineName);
      if (cols.postUrl < 0 || (cols.likes < 0 && cols.comments < 0)) {
        return { updated: 0, failed: 0, summary: '表格未包含「贴文链接」或「点赞/留言」表头' };
      }

      const existingKnown = await this.repo.listRecordPosts(link.id);
      const knownByCode = new Map(existingKnown.map((r) => [r.postCode, r]));
      const now = this.nowFn();

      const dueTargets: Array<{
        postCode: string;
        postUrl: string;
        rowNumber: number;
        stageTarget: '24h' | '72h';
      }> = [];

      for (const row of grid.rows) {
        if (row.isHintRow) continue;
        const postUrl = (row.displayValues[cols.postUrl] ?? '').trim();
        if (!isDirectFacebookPostUrl(postUrl)) continue;
        const rawCode = cols.postCode >= 0 ? (row.displayValues[cols.postCode] ?? '').trim() : '';
        const postId = extractFacebookPostIdFromUrl(postUrl);
        const postCode = rawCode || `URL-${postId ?? row.rowNumber}`;
        const existing = knownByCode.get(postCode);
        const postedAtText =
          cols.postedAt >= 0 ? (row.displayValues[cols.postedAt] ?? '').trim() : '';
        const postedAtMs =
          (postedAtText ? parseScheduleDateTimeMs(postedAtText, '') : null) ??
          existing?.postedAtMs ??
          null;
        const stage = existing?.metricsStage ?? 0;

        if (forceAllEligible) {
          const ageHours = postedAtMs ? (now - postedAtMs) / 3_600_000 : 25;
          if (ageHours >= 24) {
            dueTargets.push({
              postCode,
              postUrl,
              rowNumber: row.rowNumber,
              stageTarget: ageHours >= 72 ? '72h' : '24h',
            });
          }
        } else {
          const eligibility = evaluateMetricsEligibility(postedAtMs, stage, now);
          if (eligibility) {
            dueTargets.push({
              postCode,
              postUrl,
              rowNumber: row.rowNumber,
              stageTarget: eligibility,
            });
          }
        }
      }

      if (dueTargets.length === 0) {
        return { updated: 0, failed: 0, summary: '暂无满 24h/72h 待采集赞/评的贴文' };
      }

      const batch = dueTargets.slice(0, 30);
      await this.repo.updateLinkRuntime(link.id, {
        activeJobText: `正在无账号直采 ${batch.length} 条贴文赞/评数…`,
      });

      // Tier 1 (Primary, 0 account risk, works even without any Chrome browser open!):
      // Direct account-free anonymous HTTP scrape for public Page posts, Reels & public Groups.
      const scrapedByCode = new Map<
        string,
        {
          postCode: string;
          postUrl: string;
          likes: number | null;
          comments: number | null;
          needsAuthFallback?: boolean | undefined;
          error?: string | undefined;
        }
      >();
      let usedAnonymousCount = 0;
      let fallbackNeeded: typeof batch = [];

      if (this.deps.automation.scrapePublicPostMetrics) {
        const publicResults = await this.deps.automation.scrapePublicPostMetrics({
          posts: batch.map((b) => ({ postCode: b.postCode, postUrl: b.postUrl })),
          signal: abortCtrl.signal,
        });
        for (const item of publicResults) {
          scrapedByCode.set(item.postCode, item);
          if (item.likes !== null || item.comments !== null) {
            usedAnonymousCount++;
          } else if (item.needsAuthFallback) {
            const meta = batch.find((b) => b.postCode === item.postCode);
            if (meta) fallbackNeeded.push(meta);
          }
        }
      } else {
        fallbackNeeded = [...batch];
      }

      // Tier 2 (Optional fallback ONLY for private-group posts that returned login wall):
      let privateSkippedNoBrowser = 0;
      if (fallbackNeeded.length > 0 && !abortCtrl.signal.aborted) {
        const cfg = link.recordsConfig;
        const boundProfiles = cfg
          ? await this.resolveBoundBumperProfiles(cfg.bumperProfileGroupIds, cfg.bumperProfileIds)
          : [];
        const metricsClaimMeta = {
          linkId: link.id,
          kind: 'metrics' as const,
          title: link.title,
          status: '补采私密贴赞/评数…',
        };
        for (const candidate of boundProfiles) {
          if (await this.tryClaimProfile(candidate.id, metricsClaimMeta)) {
            claimedScraperProfileId = candidate.id;
            break;
          }
        }
        if (!claimedScraperProfileId) {
          const snap = await this.deps.workspace.snapshot();
          for (const p of snap.profiles) {
            if (!p.online || p.account.state !== 'logged-in') continue;
            if (await this.tryClaimProfile(p.id, metricsClaimMeta)) {
              claimedScraperProfileId = p.id;
              break;
            }
          }
        }
        if (claimedScraperProfileId) {
          await this.repo.updateLinkRuntime(link.id, {
            activeJobText: `正在用浏览器补采 ${fallbackNeeded.length} 条私密贴赞/评数…`,
          });
          const browserResults = await this.deps.automation.scrapePostMetrics({
            profileId: claimedScraperProfileId,
            posts: fallbackNeeded.map((b) => ({ postCode: b.postCode, postUrl: b.postUrl })),
            signal: abortCtrl.signal,
          });
          for (const item of browserResults) {
            scrapedByCode.set(item.postCode, item);
          }
        } else {
          privateSkippedNoBrowser = fallbackNeeded.length;
        }
      }

      // Re-resolve current row numbers via BOTH postCode and postUrl before writing back
      const latestRowByCode = new Map<string, number>();
      const latestRowByUrl = new Map<string, number>();
      const hasKeyLookup = Boolean(
        this.deps.sheetsApi.readColumnValues && (cols.postCode >= 0 || cols.postUrl >= 0),
      );
      if (this.deps.sheetsApi.readColumnValues) {
        if (cols.postCode >= 0) {
          const col = await this.deps.sheetsApi.readColumnValues(
            link.spreadsheetId,
            link.sheetName,
            cols.postCode,
          );
          for (let i = 1; i < col.length; i++) {
            const v = (col[i] ?? '').trim();
            if (v && !latestRowByCode.has(v)) latestRowByCode.set(v, i + 1);
          }
        }
        if (cols.postUrl >= 0) {
          const col = await this.deps.sheetsApi.readColumnValues(
            link.spreadsheetId,
            link.sheetName,
            cols.postUrl,
          );
          for (let i = 1; i < col.length; i++) {
            const v = (col[i] ?? '').trim();
            if (v && !latestRowByUrl.has(v)) latestRowByUrl.set(v, i + 1);
          }
        }
      }

      const cellUpdates: Array<{ rowNumber: number; colIndex: number; value: string }> = [];
      const pendingDbCommits: Array<{
        targetMeta: (typeof batch)[number];
        item: ScrapedPostMetrics;
      }> = [];
      let updated = 0;
      let failed = 0;

      for (const targetMeta of batch) {
        const item = scrapedByCode.get(targetMeta.postCode);
        if (!item || (item.likes === null && item.comments === null)) {
          failed++;
          continue;
        }
        const writeRowNumber =
          latestRowByCode.get(targetMeta.postCode.trim()) ??
          latestRowByUrl.get(targetMeta.postUrl.trim()) ??
          (hasKeyLookup ? undefined : targetMeta.rowNumber);
        if (!writeRowNumber || writeRowNumber < 2) {
          failed++;
          continue;
        }
        if (item.likes !== null && cols.likes >= 0) {
          cellUpdates.push({
            rowNumber: writeRowNumber,
            colIndex: cols.likes,
            value: String(item.likes),
          });
        }
        if (item.comments !== null && cols.comments >= 0) {
          cellUpdates.push({
            rowNumber: writeRowNumber,
            colIndex: cols.comments,
            value: String(item.comments),
          });
        }
        pendingDbCommits.push({ targetMeta, item });
      }

      // Commit to Google Sheets FIRST; only finalize SQLite metricsStage after writeback succeeds!
      if (cellUpdates.length > 0) {
        await this.deps.sheetsApi.batchUpdateCells(link.spreadsheetId, link.sheetName, cellUpdates);
        this.invalidateGridCache(link.id);
      }

      for (const { targetMeta, item } of pendingDbCommits) {
        await this.runSerializedRecordWrite(`${link.id}:${item.postCode}`, async () => {
          const prev =
            (await this.repo.getRecordPost(link.id, item.postCode)) ??
            knownByCode.get(item.postCode);
          const nextStage =
            targetMeta.stageTarget === '72h' ? 2 : Math.max(prev?.metricsStage ?? 0, 1);
          await this.repo.upsertRecordPost({
            linkId: link.id,
            postCode: item.postCode,
            resourceCode: prev?.resourceCode ?? '',
            postedAtText: prev?.postedAtText ?? '',
            postedAtMs: prev?.postedAtMs ?? null,
            groupId: prev?.groupId ?? '',
            groupName: prev?.groupName ?? '',
            pageId: prev?.pageId ?? '',
            pageName: prev?.pageName ?? '',
            postUrl: item.postUrl,
            postId: prev?.postId ?? extractFacebookPostIdFromUrl(item.postUrl),
            thumbnailUrl: prev?.thumbnailUrl ?? null,
            likesCount: item.likes ?? prev?.likesCount ?? null,
            commentsCount: item.comments ?? prev?.commentsCount ?? null,
            metricsStage: nextStage,
            metricsUpdatedAt: this.nowFn(),
            localBumpedCount: prev?.localBumpedCount ?? 0,
            bumpedProfileIds: prev?.bumpedProfileIds ?? [],
            createdAt: prev?.createdAt ?? this.nowFn(),
            updatedAt: this.nowFn(),
          });
        });
        updated++;
      }

      const detailParts: string[] = [];
      if (usedAnonymousCount > 0) detailParts.push(`无账号直采 ${usedAnonymousCount} 条`);
      if (privateSkippedNoBrowser > 0) {
        detailParts.push(`${privateSkippedNoBrowser} 条私密贴需在线浏览器补采`);
      } else if (failed > 0) {
        detailParts.push(`未读到 ${failed} 条`);
      }
      const summary = `采集赞/评完成：成功更新 ${updated} 条${detailParts.length > 0 ? `（${detailParts.join('，')}）` : ''}`;
      await this.repo.updateLinkRuntime(link.id, {
        lastMetricsRunAt: this.nowFn(),
        activeJobText: '',
        ...(forceAllEligible ? { lastSyncSummary: summary } : {}),
      });
      await this.repo.appendLog({
        linkId: link.id,
        level: updated === 0 && privateSkippedNoBrowser > 0 ? 'warn' : 'info',
        action: 'metrics_scrape',
        summary,
      });
      return { updated, failed, summary };
    } finally {
      if (claimedScraperProfileId) {
        this.releaseProfile(claimedScraperProfileId, linkId);
      }
      this.runningMetricsLinks.delete(linkId);
      this.metricsAbortByLink.delete(linkId);
    }
  }

  private async requireLink(id: string): Promise<GoogleSheetLink> {
    const link = await this.repo.getLink(id);
    if (!link) throw new ProductError('SHEET_LINK_NOT_FOUND', '表格连接不存在', 404);
    return link;
  }
}
