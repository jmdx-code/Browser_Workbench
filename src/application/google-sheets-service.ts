import type { CompatibleRepository } from '../domain/persistence.js';
import { ProductError, failError } from '../domain/workspace.js';
import {
  CreateSheetLinkInput,
  parseGoogleSpreadsheetUrl,
  parseGyazoTokenList,
  resolveEffectiveGyazoTokens,
  SaveSheetImageHostInput,
  UpdateSheetLinkInput,
  type GoogleAuthStatus,
  type GoogleSheetKind,
  type GoogleSheetLink,
  type GoogleSheetsOverview,
  type LibrarySyncSummary,
  type SheetGridSnapshot,
  type SheetImageHostStatus,
  type SpreadsheetMeta,
} from '../shared/google-sheets.js';
import { BumperSettings } from '../shared/group-bumper.js';
import type { CheckDailyRiskLimitFn } from '../shared/daily-risk-limits.js';
import type {
  GoogleSheetsRepositoryPort,
  SheetImageHostTestResult,
} from './google-sheets-ports.js';
import {
  buildImageHostStatus,
  createGoogleSheetsContext,
  importLibraryFromSheet as runImportLibraryFromSheet,
  invalidateGridCache as runInvalidateGridCache,
  readGrid as runReadGrid,
  syncLibraryToSheet as runSyncLibraryToSheet,
  type GoogleSheetsContext,
  type GoogleSheetsServiceDeps,
} from './google-sheets/gs-context-and-library.js';
import { collectDueMetricsForLink as runCollectDueMetricsForLink } from './google-sheets/gs-metrics-collector.js';
import { runRecordsPoll } from './google-sheets/gs-records-poller.js';
import { resetStuckRowsForLink } from './google-sheets/gs-schedule-helpers.js';
import { runSchedulePoll } from './google-sheets/gs-schedule-poller.js';
import { ignoreError, sleepMs } from './module-worker-pool.js';
import { Workboard } from './workboard.js';
export type { GoogleSheetsServiceDeps };
const DEFAULT_TAB_PATTERNS: Record<GoogleSheetKind, RegExp> = {
  group_library: /小组表|小組表|group/i,
  page_library: /专页表|專頁表|page/i,
  post_schedule: /排贴|排貼|schedule/i,
  post_records: /发帖记录|發帖記錄|顶贴|頂貼|record/i,
};
export class GoogleSheetsService {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly ctx: GoogleSheetsContext;
  private explicitWorkboard: Workboard | null = null;
  private readonly fallbackWorkboard = new Workboard({
    browserConcurrency: 100,
    bluestacksConcurrency: 50,
  });
  constructor(
    private readonly repo: CompatibleRepository<GoogleSheetsRepositoryPort>,
    private readonly deps: GoogleSheetsServiceDeps,
  ) {
    if (deps.workboard) this.explicitWorkboard = deps.workboard;
    this.ctx = createGoogleSheetsContext(repo, deps, (id, r) =>
      this.wakeRecordsLinkToActive(id, r),
    );
  }
  setWorkboard = (workboard: Workboard) => void (this.explicitWorkboard = workboard);
  setCheckDailyRiskLimit = (fn: CheckDailyRiskLimitFn) =>
    void (this.ctx.deps.checkDailyRiskLimit = fn);
  getWorkboard = (): Workboard =>
    this.explicitWorkboard ?? this.deps.bluestacks?.getWorkboard?.() ?? this.fallbackWorkboard;
  async syncMaxConcurrency(limit: number, bluestacksLimit?: number): Promise<void> {
    const wb = this.getWorkboard();
    const browserCap = Math.max(1, Math.min(50, Math.round(limit)));
    this.ctx.concurrency.maxProfiles = browserCap;
    wb.browserPermits.setLimit(browserCap);
    let bsCap = this.ctx.concurrency.maxBluestacks;
    if (typeof bluestacksLimit === 'number' && Number.isFinite(bluestacksLimit)) {
      bsCap = Math.max(1, Math.min(30, Math.round(bluestacksLimit)));
      this.ctx.concurrency.maxBluestacks = bsCap;
      wb.bluestacksPermits.setLimit(bsCap);
    }
    const links = await Promise.resolve(this.repo.listLinks('post_records')).catch(() => []);
    for (const link of links) {
      const rc = link.recordsConfig;
      const isBsOnly = Boolean(
        rc &&
        (rc.bumperBluestacksIds.length > 0 || rc.bumperBluestacksFolderIds.length > 0) &&
        rc.bumperProfileIds.length === 0 &&
        rc.bumperProfileGroupIds.length === 0,
      );
      const targetCap = isBsOnly ? bsCap : browserCap;
      if (rc?.bumperSettings.maxConcurrentProfiles !== targetCap) {
        await ignoreError(
          this.repo.updateLink({
            id: link.id,
            recordsConfig: {
              bumperSettings: BumperSettings.parse({
                ...(rc?.bumperSettings ?? {}),
                maxConcurrentProfiles: targetCap,
              }),
            },
          }),
        );
      }
    }
  }
  isProfileRunning = (profileId: string) =>
    this.ctx.activeProfiles.has(profileId) || this.ctx.claimingProfiles.has(profileId);
  hasActiveExecution = () => this.isRunningAny() || this.ctx.activeProfiles.size > 0;
  isRunningAny = () =>
    this.ctx.runningScheduleLinks.size > 0 ||
    this.ctx.runningRecordLinks.size > 0 ||
    this.ctx.runningMetricsLinks.size > 0;
  async countEnabledMonitors(): Promise<{ scheduleEnabled: number; recordsEnabled: number }> {
    let scheduleEnabled = 0;
    let recordsEnabled = 0;
    for (const l of await this.repo.listLinks()) {
      if (!l.enabled) continue;
      if (l.kind === 'post_schedule' && l.scheduleConfig?.enabled) scheduleEnabled++;
      if (l.kind === 'post_records' && l.recordsConfig?.enabled) recordsEnabled++;
    }
    return { scheduleEnabled, recordsEnabled };
  }
  async stopProfiles(profileIds?: readonly string[]): Promise<void> {
    if (!profileIds?.length) return this.stopAll();
    const idSet = new Set(profileIds);
    for (const [pid, entry] of this.ctx.activeProfiles.entries()) {
      if (!idSet.has(pid)) continue;
      this.ctx.cancelledProfiles.add(pid);
      this.ctx.metricsAbortByLink.get(entry.linkId)?.abort();
      this.ctx.activeBluestacksAborts.get(pid)?.abort();
    }
  }
  async stopAll(): Promise<void> {
    for (const ctrl of this.ctx.metricsAbortByLink.values()) ctrl.abort();
    for (const ctrl of this.ctx.activeBluestacksAborts.values()) ctrl.abort();
    for (const id of [
      ...this.ctx.runningScheduleLinks,
      ...this.ctx.runningRecordLinks,
      ...this.ctx.runningMetricsLinks,
    ])
      this.ctx.cancelledLinks.add(id);
    for (const pid of this.ctx.activeProfiles.keys()) this.ctx.cancelledProfiles.add(pid);
  }
  start(): void {
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => void this.tickAll(), 15_000);
      this.pollTimer.unref?.();
    }
    void this.recoverStuckRowsOnStartup().catch(() => {});
  }
  async recoverStuckRowsOnStartup(): Promise<number> {
    if (!(await this.deps.oauth.status()).authorized) return 0;
    let totalReset = 0;
    for (const link of await this.repo.listLinks('post_schedule')) {
      if (this.ctx.recoveredStuckLinks.has(link.id)) continue;
      this.ctx.recoveredStuckLinks.add(link.id);
      const res = await resetStuckRowsForLink(this.ctx, link.id, { onlyThisMachine: true }).catch(
        () => null,
      );
      if (res) totalReset += res.resetCount;
    }
    return totalReset;
  }
  resetStuckRows = (linkId: string) =>
    resetStuckRowsForLink(this.ctx, linkId, { onlyThisMachine: false });
  async shutdown(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const ctrl of this.ctx.metricsAbortByLink.values()) ctrl.abort();
    this.ctx.metricsAbortByLink.clear();
    for (const ctrl of this.ctx.activeBluestacksAborts.values()) ctrl.abort();
    this.ctx.activeBluestacksAborts.clear();
    for (const id of [...this.ctx.runningScheduleLinks, ...this.ctx.runningRecordLinks])
      this.ctx.cancelledLinks.add(id);
    const flushPromises = [
      ...[...this.ctx.activeBumpFlushers.values()].map((fn) => fn().catch(() => {})),
      ...[...this.ctx.recordWriteLocks.values()].map((p) => p.catch(() => {})),
    ];
    if (flushPromises.length)
      await Promise.race([Promise.allSettled(flushPromises), sleepMs(5_000)]);
    await this.deps.oauth.shutdown();
  }
  async overview(): Promise<GoogleSheetsOverview> {
    const [auth, imgCfg, imgCount, links, logs] = await Promise.all([
      this.deps.oauth.status(),
      this.repo.getImageHostConfig(),
      this.repo.countImageCache(),
      this.repo.listLinks(),
      this.repo.listLogs(60),
    ]);
    return {
      auth,
      imageHost: buildImageHostStatus(imgCfg, imgCount),
      links: links.map((link) => ({
        ...link,
        runtime: {
          ...link.runtime,
          activeRunningCount:
            (this.ctx.runningScheduleLinks.has(link.id) ? 1 : 0) +
            (this.ctx.runningRecordLinks.has(link.id) ? 1 : 0) +
            (this.ctx.runningMetricsLinks.has(link.id) ? 1 : 0),
        },
      })),
      logs,
      runningScheduleCount: this.ctx.runningScheduleLinks.size,
      runningRecordsCount: this.ctx.runningRecordLinks.size + this.ctx.runningMetricsLinks.size,
      activeProfiles: [...this.ctx.activeProfiles.entries()].map(([profileId, entry]) => ({
        profileId,
        ...entry,
      })),
    };
  }
  async importCredentials(rawJson: string): Promise<GoogleAuthStatus> {
    const status = await this.deps.oauth.importCredentialsJson(rawJson);
    this.invalidateGridCache();
    return status;
  }
  startAuth = () => this.deps.oauth.startAuthSession();
  completeManualAuth = (codeOrUrl: string) => this.deps.oauth.completeManualAuth(codeOrUrl);
  async revokeAuth(): Promise<GoogleAuthStatus> {
    const status = await this.deps.oauth.revokeAuth();
    this.invalidateGridCache();
    await ignoreError(this.repo.saveImageHostConfig({ driveFolderId: null }));
    return status;
  }
  getEditableGyazoTokens = async (): Promise<{ tokens: string[] }> => ({
    tokens: resolveEffectiveGyazoTokens(await this.repo.getImageHostConfig()),
  });
  async saveImageHostConfig(input: unknown): Promise<SheetImageHostStatus> {
    const parsed = SaveSheetImageHostInput.parse(input);
    const current = await this.repo.getImageHostConfig();
    const rawTok = parsed.gyazoAccessTokens ?? parsed.gyazoAccessToken;
    const nextTokens = parsed.clearGyazoToken
      ? []
      : rawTok !== undefined
        ? parseGyazoTokenList(rawTok)
        : resolveEffectiveGyazoTokens(current);
    const saved = await this.repo.saveImageHostConfig({
      preferredHost: parsed.preferredHost ?? current.preferredHost,
      gyazoAccessTokens: nextTokens,
      gyazoAccessToken: nextTokens[0] ?? '',
      defaultMachineName: parsed.defaultMachineName ?? current.defaultMachineName,
    });
    return buildImageHostStatus(saved, await this.repo.countImageCache());
  }
  async testImageHost(): Promise<SheetImageHostTestResult> {
    const res = await this.deps.imageHost.testUpload();
    const hostDesc =
      res.host === 'gyazo'
        ? res.tokenIndex !== undefined && (res.tokenCount ?? 0) > 1
          ? `Gyazo · Token #${res.tokenIndex + 1}/${res.tokenCount}`
          : 'Gyazo'
        : res.fallbackFromGyazo
          ? 'Gyazo 失败，已自动切换 Google 网盘兜底'
          : 'Google 网盘兜底';
    await this.repo.appendLog({
      level: 'info',
      action: 'image_host_test',
      summary: `图床测试上传成功（${hostDesc}）：${res.remoteUrl}`,
    });
    return res;
  }
  async inspectSpreadsheet(
    urlOrId: string,
  ): Promise<SpreadsheetMeta & { suggestedGid: number | null }> {
    const parsed = parseGoogleSpreadsheetUrl(urlOrId);
    if (!parsed)
      failError('GOOGLE_SPREADSHEET_URL_INVALID', '请粘贴有效的 Google 表格链接或表格 ID', 400);
    return {
      ...(await this.deps.sheetsApi.getSpreadsheetMeta(parsed.spreadsheetId)),
      suggestedGid: parsed.gid,
    };
  }
  async createLink(input: unknown): Promise<GoogleSheetLink> {
    const parsed = CreateSheetLinkInput.parse(input);
    const urlParts = parseGoogleSpreadsheetUrl(parsed.spreadsheetUrlOrId);
    if (!urlParts)
      failError('GOOGLE_SPREADSHEET_URL_INVALID', '请粘贴有效的 Google 表格链接或 ID', 400);
    const meta = await this.deps.sheetsApi.getSpreadsheetMeta(urlParts.spreadsheetId);
    const selectedTab =
      (parsed.sheetName ? meta.tabs.find((t) => t.title === parsed.sheetName) : undefined) ??
      (parsed.sheetId !== undefined
        ? meta.tabs.find((t) => t.sheetId === parsed.sheetId)
        : undefined) ??
      (urlParts.gid !== null ? meta.tabs.find((t) => t.sheetId === urlParts.gid) : undefined) ??
      meta.tabs.find((t) => DEFAULT_TAB_PATTERNS[parsed.kind].test(t.title)) ??
      meta.tabs[0];
    if (!selectedTab)
      throw new ProductError('GOOGLE_SHEET_TAB_NOT_FOUND', '该表格中没有可用的工作表标签', 404);
    if (parsed.kind === 'post_schedule' || parsed.kind === 'post_records') {
      const dup = (await this.repo.listLinks(parsed.kind)).find(
        (i) => i.spreadsheetId === meta.spreadsheetId && i.sheetId === selectedTab.sheetId,
      );
      if (dup)
        failError(
          'GOOGLE_SHEET_DUPLICATE_LINK',
          `工作表「${selectedTab.title}」已连接（当前标签名：${dup.title}），请换选其他工作表或粘贴新表格链接`,
          409,
        );
    }
    const recordsConfig =
      parsed.kind === 'post_records' && this.ctx.concurrency.maxProfiles !== null
        ? {
            ...(parsed.recordsConfig ?? {}),
            bumperSettings: BumperSettings.parse({
              ...(parsed.recordsConfig?.bumperSettings ?? {}),
              maxConcurrentProfiles:
                parsed.recordsConfig?.bumperSettings?.maxConcurrentProfiles ??
                this.ctx.concurrency.maxProfiles,
            }),
          }
        : parsed.recordsConfig;
    const link = await this.repo.createLink({
      kind: parsed.kind,
      title: parsed.title?.trim() || selectedTab.title,
      spreadsheetId: meta.spreadsheetId,
      spreadsheetTitle: meta.title,
      sheetId: selectedTab.sheetId,
      sheetName: selectedTab.title,
      spreadsheetUrl: `${meta.url}#gid=${selectedTab.sheetId}`,
      scheduleConfig: parsed.scheduleConfig,
      recordsConfig,
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
  async updateLink(input: unknown): Promise<GoogleSheetLink> {
    const p = UpdateSheetLinkInput.parse(input);
    const updated = await this.repo.updateLink(p);
    if (p.sheetId !== undefined || p.sheetName !== undefined) this.invalidateGridCache(p.id);
    if (
      updated.kind === 'post_records' &&
      updated.recordsConfig?.enabled &&
      updated.runtime.pollingMode === 'idle'
    )
      await this.repo.updateLinkRuntime(updated.id, {
        pollingMode: 'active',
        consecutiveIdlePolls: 0,
        nextPollAt: this.ctx.nowFn(),
      });
    return (await this.repo.getLink(updated.id)) ?? updated;
  }
  async deleteLink(id: string): Promise<{ deleted: boolean }> {
    this.ctx.cancelledLinks.add(id);
    this.ctx.metricsAbortByLink.get(id)?.abort();
    this.invalidateGridCache(id);
    const existing = await this.repo.getLink(id);
    const deleted = await this.repo.deleteLink(id);
    if (deleted && existing) {
      if (existing.kind === 'post_records') {
        for (const s of await this.repo.listLinks('post_schedule')) {
          if (s.scheduleConfig?.targetRecordLinkId === id)
            await this.repo.updateLink({ id: s.id, scheduleConfig: { targetRecordLinkId: null } });
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
  invalidateGridCache = (linkId?: string) => runInvalidateGridCache(this.ctx, linkId);
  readGrid = (
    linkId: string,
    options?: { force?: boolean; maxAgeMs?: number },
  ): Promise<SheetGridSnapshot> => runReadGrid(this.ctx, linkId, options);
  importLibraryFromSheet = (linkId: string, rawMode: unknown): Promise<LibrarySyncSummary> =>
    runImportLibraryFromSheet(this.ctx, linkId, rawMode);
  syncLibraryToSheet = (linkId: string): Promise<LibrarySyncSummary> =>
    runSyncLibraryToSheet(this.ctx, linkId);
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
      if (!(await this.deps.oauth.status()).authorized) return;
      const now = this.ctx.nowFn();
      for (const link of await this.repo.listLinks()) {
        if (!link.enabled || now < (link.runtime.nextPollAt ?? 0)) continue;
        if (
          link.kind === 'post_schedule' &&
          link.scheduleConfig?.enabled &&
          !this.ctx.runningScheduleLinks.has(link.id)
        ) {
          await this.repo.updateLinkRuntime(link.id, {
            nextPollAt: now + Math.max(1, link.scheduleConfig.pollIntervalMinutes) * 60_000,
          });
          void runSchedulePoll(this.ctx, link.id, false, this.getWorkboard()).catch(() => {});
        } else if (
          link.kind === 'post_records' &&
          link.recordsConfig?.enabled &&
          !this.ctx.runningRecordLinks.has(link.id)
        ) {
          void runRecordsPoll(this.ctx, link.id, this.getWorkboard()).catch(() => {});
        }
      }
    } finally {
      this.ticking = false;
    }
  }
  triggerSchedulePoll(linkId: string): Promise<{ summary: string }> {
    if (this.ctx.runningScheduleLinks.has(linkId))
      throw new ProductError('SHEET_SCHEDULE_BUSY', '该排贴表正在执行检查或发帖中，请稍候', 409);
    return runSchedulePoll(this.ctx, linkId, true, this.getWorkboard());
  }
  triggerRecordsPoll(linkId: string): Promise<{ summary: string }> {
    if (this.ctx.runningRecordLinks.has(linkId))
      throw new ProductError('SHEET_RECORDS_BUSY', '该发帖记录表正在执行顶贴检查中，请稍候', 409);
    return runRecordsPoll(this.ctx, linkId, this.getWorkboard());
  }
  async wakeRecordsLinkToActive(linkId: string, reason: string): Promise<void> {
    const link = await this.repo.getLink(linkId);
    if (!link || link.kind !== 'post_records') return;
    await this.repo.updateLinkRuntime(link.id, {
      pollingMode: 'active',
      consecutiveIdlePolls: 0,
      nextPollAt: this.ctx.nowFn(),
      lastSyncSummary: reason,
    });
    await this.repo.appendLog({
      linkId: link.id,
      level: 'info',
      action: 'records_wakeup',
      summary: `${reason} → 已切入积极监听模式（每 ${link.recordsConfig?.activePollMinutes ?? 2} 分钟）`,
    });
    if (link.recordsConfig?.enabled && !this.ctx.runningRecordLinks.has(link.id))
      void runRecordsPoll(this.ctx, link.id, this.getWorkboard()).catch(() => {});
  }
  async stopLinkWork(linkId: string): Promise<void> {
    this.ctx.cancelledLinks.add(linkId);
    this.ctx.metricsAbortByLink.get(linkId)?.abort();
    for (const [pid, entry] of this.ctx.activeProfiles.entries())
      if (entry.linkId === linkId) this.ctx.activeBluestacksAborts.get(pid)?.abort();
    await this.repo.updateLinkRuntime(linkId, { activeJobText: '正在停止…' });
  }
  refreshRecordMetrics = (linkId: string) => runCollectDueMetricsForLink(this.ctx, linkId, true);
  collectDueMetricsForLink = (linkId: string, forceAllEligible: boolean) =>
    runCollectDueMetricsForLink(this.ctx, linkId, forceAllEligible);
}
