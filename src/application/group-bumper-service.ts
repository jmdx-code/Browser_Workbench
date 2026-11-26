import { z } from 'zod';
import type { CompatibleRepository } from '../domain/persistence.js';
import { ProductError } from '../domain/workspace.js';
import {
  BumperGroupTargetsInput,
  BumperPageTargetsInput,
  BumperSettings,
  StartPageBumper,
  isTargetIncomplete,
  type BumperComment,
  type BumperDailyStat,
  type BumperLog,
  type BumperPendingOperation,
  type BumperProfileStat,
  type BumperRefreshResult,
  type BumperScope,
  type BumperState,
  type BumperTarget,
} from '../shared/group-bumper.js';
import type { PostBumpRecordsPort } from '../shared/post-bump-records.js';
import type { ProfileLifecyclePort } from '../shared/profile-lifecycle.js';
import {
  createBumperRuntime,
  runScheduledBumperProfileStep,
  startBumperRunWithMeta,
  stopBumperProfiles,
  type BumperRuntimeContext,
} from './bumper/bumper-workers.js';
import type { FeatureExecutionRegistry } from './feature-execution-registry.js';
import {
  buildProfileCountMap,
  buildStaggeredQueues,
  errMsg,
  formatAvatarRefreshSummary,
  runTargetAvatarRefresh,
} from './module-worker-pool.js';
import type { Workboard } from './workboard.js';

export interface BumperRepository {
  settings(): BumperSettings;
  saveSettings(input: unknown): BumperSettings;
  pageSettings?(): BumperSettings;
  savePageSettings?(input: unknown): BumperSettings;
  targets(kind: 'groups' | 'pages'): BumperTarget[];
  upsertTargets(kind: 'groups' | 'pages', input: unknown): BumperTarget[];
  deleteTargets(kind: 'groups' | 'pages', input: unknown): number;
  comments?(scope?: BumperScope): BumperComment[];
  saveComments(input: unknown, scope?: BumperScope): BumperComment[];
  logs(
    search?: string,
    limit?: number,
    before?: number,
    beforeId?: string,
    sourceMode?: BumperScope,
    carrier?: 'chrome' | 'bluestacks' | 'all',
  ): BumperLog[];
  deleteLogs(input: unknown): number;
  total?(sourceMode?: BumperScope): number;
  todayCounts(sourceMode?: BumperScope): Record<string, number>;
  weeklyDailyCounts?(now?: number, sourceMode?: BumperScope): BumperDailyStat[];
  pendingReviewOperations?(limit?: number): BumperPendingOperation[];
  saveProfileResult?(result: import('../shared/task-contracts.js').ProfileTaskResultValue): void;
  applyResolvedTargetMetadata?(
    kind: 'groups' | 'pages',
    rawId: string,
    metadata: { canonicalId?: string | null; name?: string | null; avatarUrl?: string | null },
  ): unknown;
}

export interface BumperRunner {
  ready(id: string): boolean;
  busy(id: string): Promise<boolean>;
  run(
    id: string,
    groups: BumperTarget[],
    pages: BumperTarget[],
    settings: BumperSettings,
    callbacks: {
      runId?: string;
      executionMode?: 'live' | 'scan_only';
      cancelled(): boolean;
      status(text: string, today?: number): void;
      added(today: number): void;
      issue?(issue: {
        kind: 'pending' | 'failed' | 'skipped';
        reason: string;
        target?: { groupId?: string; groupName?: string; pageId?: string; pageName?: string };
      }): void;
    },
  ): Promise<void>;
  stop(id: string): Promise<void>;
  hasControl?(id: string): boolean;
  isReadingProfile?(id: string): boolean;
  hasMetadataReads?(): boolean;
}

export type BumperMode = 'group-bumper' | 'page-bumper';
const RUNNING_ADD_STATUS = '已保存新增目标（运行中暂不抓取头像，停止后可点「读取资料」补齐）';

/** 专页顶贴复用顶贴执行器时使用的合成小组：runner 以 id === '-' 识别专页主页模式。 */
export const PAGE_BUMPER_SYNTHETIC_GROUP: BumperTarget = {
  id: '-',
  name: '专页主页',
  avatarUrl: null,
  folderId: null,
  sortOrder: 0,
  totalBumpedCount: 0,
  createdAt: 0,
  updatedAt: 0,
};

export const buildStaggeredBumperQueues = (
  profileIds: readonly string[],
  targets: readonly BumperTarget[],
) => buildStaggeredQueues(profileIds, targets);

export class GroupBumperService {
  private readonly runtime: BumperRuntimeContext;

  constructor(
    private readonly repo: CompatibleRepository<BumperRepository>,
    private readonly runner: BumperRunner,
    summary: () => Promise<Pick<BumperState, 'comments' | 'total'>>,
    private readonly assertAllowed: () => void = () => {},
    refreshAvatars?: (
      kind: 'groups' | 'pages',
      items: BumperTarget[],
      options?: { signal?: AbortSignal; onUpdated?: () => void },
    ) => Promise<BumperRefreshResult | void>,
    staggerScale = 1,
    stopAvatarRefresh?: (kind?: 'groups' | 'pages') => void,
  ) {
    this.runtime = createBumperRuntime({
      repo,
      runner,
      summary,
      assertAllowed,
      refreshAvatars,
      staggerScale,
      stopAvatarRefresh,
    });
  }

  setFeatureExecutionRegistry = (registry: FeatureExecutionRegistry) =>
    void (this.runtime.featureExecution = registry);
  setProfileLifecycle = (lifecycle: ProfileLifecyclePort) =>
    void (this.runtime.profileLifecycle = lifecycle);
  setWorkboard = (workboard: Workboard) => void (this.runtime.workboard = workboard);
  setPostBumpRecords = (port: PostBumpRecordsPort) => void (this.runtime.postBumpRecords = port);

  async shutdown(): Promise<void> {
    this.runtime.refreshAbort?.abort();
    if (this.hasActiveExecution()) await this.stop().catch(() => {});
  }

  isProfileRunning = (id: string) => this.runtime.isProfileRunning(id);
  hasActiveExecution = () => this.runtime.hasActiveExecution();
  isProfileRunningInMode = (id: string, mode: BumperMode, includeAdmitting = true) =>
    this.runtime.isProfileRunningInMode(id, mode, includeAdmitting);
  hasActiveExecutionInMode = (mode: BumperMode) => this.runtime.hasActiveExecutionInMode(mode);

  stopRefresh(kind?: 'groups' | 'pages'): void {
    const rt = this.runtime;
    if (kind && rt.refreshingKind && rt.refreshingKind !== kind)
      return void rt.stopAvatarRefresh?.(kind);
    rt.refreshAbort?.abort(new Error('FACEBOOK_METADATA_BATCH_ABORTED'));
    rt.refreshAbort = null;
    rt.stopAvatarRefresh?.(kind);
    const wasKind = kind ?? rt.refreshingKind;
    rt.refreshing = false;
    rt.refreshingKind = null;
    rt.statusText = wasKind === 'pages' ? '已停止读取专页资料' : '已停止读取小组资料';
    if (wasKind === 'pages') rt.pageStatusText = rt.statusText;
  }

  async state(): Promise<BumperState> {
    const [
      groups,
      pages,
      settings,
      extra,
      groupCounts,
      pageCounts,
      pageSettings,
      pageComments,
      groupTotal,
      pageTotal,
      dailyStats,
      pageDailyStats,
      pendingReviewOperations,
    ] = await Promise.all([
      this.repo.targets('groups'),
      this.repo.targets('pages'),
      this.repo.settings(),
      this.runtime.summary(),
      this.repo.todayCounts('group'),
      this.repo.todayCounts('page'),
      this.repo.pageSettings ? this.repo.pageSettings() : undefined,
      this.repo.comments ? this.repo.comments('page') : [],
      this.repo.total ? this.repo.total('group') : undefined,
      this.repo.total ? this.repo.total('page') : 0,
      this.repo.weeklyDailyCounts?.(undefined, 'group') ?? [],
      this.repo.weeklyDailyCounts?.(undefined, 'page') ?? [],
      this.repo.pendingReviewOperations?.() ?? [],
    ]);
    const makeIdle = (today: number): BumperProfileStat => ({
      today,
      session: 0,
      status: '未运行',
      running: false,
    });
    const mergeToday = (persisted: number | undefined, live: number) =>
      Math.max(persisted ?? 0, live);
    return {
      groups,
      pages,
      settings,
      pageSettings: pageSettings ?? this.runtime.fallbackPageSettings ?? settings,
      comments: extra.comments,
      pageComments,
      total: groupTotal ?? extra.total,
      pageTotal,
      running: this.hasActiveExecutionInMode('group-bumper'),
      statusText: this.runtime.statusText,
      profileCounts: buildProfileCountMap(groupCounts, this.runtime.profiles, makeIdle, mergeToday),
      dailyStats,
      pageDailyStats,
      pageBumperRunning: this.hasActiveExecutionInMode('page-bumper'),
      pageBumperStatusText: this.runtime.pageStatusText,
      pageBumperProfileCounts: buildProfileCountMap(
        pageCounts,
        this.runtime.pageProfiles,
        makeIdle,
        mergeToday,
      ),
      metadataRefreshing: this.runtime.refreshing || this.runner.hasMetadataReads?.() === true,
      groupAvatarRefreshing: this.runtime.refreshingKind === 'groups',
      pageAvatarRefreshing: this.runtime.refreshingKind === 'pages',
      pendingReviewOperations,
    };
  }

  private async runRefreshTargets(
    kind: 'groups' | 'pages',
    targets: BumperTarget[],
    interactive: boolean,
  ): Promise<void> {
    const rt = this.runtime;
    const refreshFn = rt.refreshAvatars;
    if (!refreshFn || !targets.length) return;
    rt.refreshingKind = kind;
    if (interactive)
      rt.setStatus(
        kind === 'pages' ? 'page-bumper' : 'group-bumper',
        `正在读取资料（共 ${targets.length} 项）…`,
        kind === 'pages',
      );
    await runTargetAvatarRefresh({
      targets,
      abortPreviousReason: interactive ? undefined : 'FACEBOOK_METADATA_BATCH_SUPERSEDED',
      refresh: (signal) => refreshFn(kind, targets, { signal }),
      getAbort: () => rt.refreshAbort,
      setAbort: (ctrl) => void (rt.refreshAbort = ctrl),
      setRefreshing: (active) => {
        rt.refreshing = active;
        if (!active && rt.refreshingKind === kind) rt.refreshingKind = null;
      },
      waitMs: interactive ? 20 : undefined,
      onResult: (result, aborted) => {
        if (!interactive) {
          if (result?.needsBrowser) {
            rt.statusText = '部分资料需闲置已登录浏览器才能补齐（当前无可用闲置浏览器）';
            if (kind === 'pages') rt.pageStatusText = rt.statusText;
          }
          return;
        }
        rt.statusText = aborted
          ? kind === 'pages'
            ? '已停止读取专页资料'
            : '已停止读取小组资料'
          : formatAvatarRefreshSummary(result);
      },
      onError: (err) => {
        if (interactive) rt.statusText = '读取资料异常：' + errMsg(err);
      },
      onFinally: () => {
        if (interactive && kind === 'pages') rt.pageStatusText = rt.statusText;
      },
    });
  }

  async manage(action: string, input: unknown): Promise<BumperState> {
    this.assertAllowed();
    const rt = this.runtime;
    const isPagePrefix = action.startsWith('pages/');
    const kind: 'groups' | 'pages' = isPagePrefix ? 'pages' : 'groups';
    if (action === 'groups/refresh-stop' || action === 'pages/refresh-stop') {
      this.stopRefresh(kind);
      return this.state();
    }
    const statusBefore = rt.statusText;
    const anyRunning = () =>
      this.hasActiveExecutionInMode('group-bumper') || this.hasActiveExecutionInMode('page-bumper');
    try {
      if (action === 'groups/refresh' || action === 'pages/refresh') {
        if (rt.refreshing) throw new ProductError('BUMPER_READING', '正在读取资料，请稍候', 409);
        if (anyRunning())
          throw new ProductError('BUMPER_RUNNING', '请先停止顶贴任务再读取资料', 409);
        const { ids } = z
          .object({ ids: z.array(z.string().min(1)).max(500).optional() })
          .strict()
          .parse(input);
        const all = await this.repo.targets(kind);
        const targets = ids?.length
          ? all.filter((r) => ids.includes(r.id))
          : all.filter(isTargetIncomplete);
        if (!targets.length) rt.statusText = '当前列表资料已完整，如需重读请先勾选目标';
        else await this.runRefreshTargets(kind, targets, true);
      } else if (action === 'groups/add' || action === 'pages/add') {
        const parsed =
          kind === 'groups'
            ? BumperGroupTargetsInput.parse(input)
            : BumperPageTargetsInput.parse(input);
        const pending = (await this.repo.upsertTargets(kind, parsed)).filter(isTargetIncomplete);
        if (pending.length) {
          if (anyRunning()) {
            rt.statusText = RUNNING_ADD_STATUS;
            if (isPagePrefix) rt.pageStatusText = RUNNING_ADD_STATUS;
          } else void this.runRefreshTargets(kind, pending, false);
        }
      } else if (action === 'groups/delete' || action === 'pages/delete') {
        await this.repo.deleteTargets(kind, input);
      } else if (action === 'settings') {
        const saved = (await this.repo.saveSettings(input)) ?? BumperSettings.parse(input);
        for (const live of rt.liveGroupSettings) Object.assign(live, saved);
      } else if (action === 'page-settings') {
        const saved = this.repo.savePageSettings
          ? ((await this.repo.savePageSettings(input)) ?? BumperSettings.parse(input))
          : (rt.fallbackPageSettings = BumperSettings.parse(input));
        for (const live of rt.livePageSettings) Object.assign(live, saved);
      } else if (action === 'comments' || action === 'page-comments') {
        await this.repo.saveComments(input, action === 'comments' ? 'group' : 'page');
      } else if (action === 'logs/delete') {
        await this.repo.deleteLogs(input);
        const raw =
          typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
        if (raw.carrier !== 'bluestacks') {
          const scope = raw.sourceMode;
          const [freshGroup, freshPage] = await Promise.all([
            this.repo.todayCounts('group'),
            this.repo.todayCounts('page'),
          ]);
          if (!scope || scope === 'all' || scope === 'group')
            for (const [id, stat] of rt.profiles)
              rt.profiles.set(id, { ...stat, today: freshGroup[id] ?? 0 });
          if (!scope || scope === 'all' || scope === 'page')
            for (const [id, stat] of rt.pageProfiles)
              rt.pageProfiles.set(id, { ...stat, today: freshPage[id] ?? 0 });
        }
      } else throw new ProductError('BUMPER_ACTION_UNKNOWN', '未知的小组顶贴操作', 404);
    } finally {
      if (isPagePrefix && rt.statusText !== statusBefore) rt.pageStatusText = rt.statusText;
    }
    return this.state();
  }

  logs = (
    search = '',
    before?: number,
    beforeId?: string,
    limit = 200,
    sourceMode?: BumperScope,
    carrier?: 'chrome' | 'bluestacks',
  ) => this.repo.logs(search.slice(0, 300), limit, before, beforeId, sourceMode, carrier);

  private async runAndState(fn: () => Promise<unknown>): Promise<BumperState> {
    await fn();
    return this.state();
  }

  start = (input: unknown) =>
    this.runAndState(() => startBumperRunWithMeta(this.runtime, input, 'live', 'group-bumper'));
  startScanOnly = (input: unknown) =>
    this.runAndState(() =>
      startBumperRunWithMeta(this.runtime, input, 'scan_only', 'group-bumper'),
    );
  startPageBumper = (input: unknown) =>
    this.runAndState(() =>
      startBumperRunWithMeta(this.runtime, StartPageBumper.parse(input), 'live', 'page-bumper'),
    );
  stop = (profileIds?: string[], mode?: BumperMode) =>
    this.runAndState(() => stopBumperProfiles(this.runtime, profileIds, mode));
  runScheduledProfileStep = (input: Parameters<typeof runScheduledBumperProfileStep>[1]) =>
    runScheduledBumperProfileStep(this.runtime, input);

  async syncMaxConcurrency(maxConcurrentProfiles: number): Promise<void> {
    const capped = Math.max(1, Math.min(50, Math.round(maxConcurrentProfiles)));
    const syncScope = async (
      cur: BumperSettings,
      liveSet: Set<BumperSettings>,
      save?: (v: unknown) => Promise<BumperSettings | undefined>,
      onFb?: (v: BumperSettings) => void,
    ) => {
      if (cur.maxConcurrentProfiles === capped) {
        for (const live of liveSet) live.maxConcurrentProfiles = capped;
        return;
      }
      const next = { ...cur, maxConcurrentProfiles: capped };
      if (save) {
        const saved = (await save(next)) ?? BumperSettings.parse(next);
        for (const live of liveSet) Object.assign(live, saved);
      } else {
        onFb?.(BumperSettings.parse(next));
        for (const live of liveSet) live.maxConcurrentProfiles = capped;
      }
    };
    const groupCur = await this.repo.settings();
    await syncScope(groupCur, this.runtime.liveGroupSettings, (v) =>
      Promise.resolve(this.repo.saveSettings(v)),
    );
    const pageCur = this.repo.pageSettings
      ? await this.repo.pageSettings()
      : (this.runtime.fallbackPageSettings ?? groupCur);
    await syncScope(
      pageCur,
      this.runtime.livePageSettings,
      this.repo.savePageSettings
        ? (v) => Promise.resolve(this.repo.savePageSettings?.(v))
        : undefined,
      (v) => void (this.runtime.fallbackPageSettings = v),
    );
  }
}
