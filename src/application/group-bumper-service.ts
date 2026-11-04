import type { CompatibleRepository } from '../domain/persistence.js';
import {
  BumperGroupTargetsInput,
  BumperPageTargetsInput,
  BumperSettings,
  StartBumper,
  StartPageBumper,
  isTargetIncomplete,
  type BumperScope,
  type BumperState,
  type BumperTarget,
  type BumperProfileStat,
  type BumperComment,
  type BumperLog,
  type BumperDailyStat,
  type BumperPendingOperation,
  type BumperRefreshResult,
} from '../shared/group-bumper.js';
import type { ProfileTaskResultValue } from '../shared/task-contracts.js';
import { z } from 'zod';
import { ProductError } from '../domain/workspace.js';
import { admitProfilesForStart } from './profile-start-admission.js';
import type { FeatureExecutionRegistry } from './feature-execution-registry.js';

function shuffleArray<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const itemI = copy[i];
    const itemJ = copy[j];
    if (itemI !== undefined && itemJ !== undefined) {
      copy[i] = itemJ;
      copy[j] = itemI;
    }
  }
  return copy;
}

export function buildStaggeredBumperQueues(
  profileIds: readonly string[],
  targets: readonly BumperTarget[],
): Map<string, BumperTarget[]> {
  const base = shuffleArray(targets);
  const result = new Map<string, BumperTarget[]>();
  const m = Math.max(1, profileIds.length);
  const k = base.length;
  profileIds.forEach((profileId, idx) => {
    if (k <= 1) {
      result.set(profileId, [...base]);
      return;
    }
    const offset = Math.floor((idx * k) / m) % k;
    const rotated = [...base.slice(offset), ...base.slice(0, offset)];
    const first = rotated[0];
    const rest = shuffleArray(rotated.slice(1));
    result.set(profileId, first !== undefined ? [first, ...rest] : rest);
  });
  return result;
}

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
  ): BumperLog[];
  deleteLogs(input: unknown): number;
  total?(sourceMode?: BumperScope): number;
  todayCounts(sourceMode?: BumperScope): Record<string, number>;
  weeklyDailyCounts?(now?: number, sourceMode?: BumperScope): BumperDailyStat[];
  pendingReviewOperations?(limit?: number): BumperPendingOperation[];
  saveProfileResult?(result: ProfileTaskResultValue): void;
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
export class GroupBumperService {
  /** 每个浏览器独立的运行批次号：追加运行不会改写已在运行浏览器的批次。 */
  private profileRunIds = new Map<string, string>();
  private profileModes = new Map<string, BumperMode>();
  private groupSlotsInUse = 0;
  private pageSlotsInUse = 0;
  private fallbackPageSettings?: BumperSettings;
  private workers = new Map<string, Promise<void>>();
  private profiles = new Map<string, BumperProfileStat>();
  private pageProfiles = new Map<string, BumperProfileStat>();
  private active = new Set<string>();
  private cancelled = new Set<string>();
  private starting = new Set<string>();
  private admitting = new Set<string>();
  private admittingModes = new Map<string, BumperMode>();
  private refreshing = false;
  private refreshingKind: 'groups' | 'pages' | null = null;
  private refreshAbort: AbortController | null = null;
  private statusText = '请选择账号、小组和目标主页';
  private pageStatusText = '请选择账号和目标专页';
  private featureExecution?: FeatureExecutionRegistry;
  constructor(
    private readonly repo: CompatibleRepository<BumperRepository>,
    private readonly runner: BumperRunner,
    private readonly summary: () => Promise<Pick<BumperState, 'comments' | 'total'>>,
    private readonly assertAllowed: () => void = () => {},
    private readonly refreshAvatars?: (
      kind: 'groups' | 'pages',
      items: BumperTarget[],
      options?: { signal?: AbortSignal; onUpdated?: () => void },
    ) => Promise<BumperRefreshResult | void>,
    private readonly staggerScale = 1,
    private readonly stopAvatarRefresh?: (kind?: 'groups' | 'pages') => void,
  ) {}
  setFeatureExecutionRegistry(registry: FeatureExecutionRegistry): void {
    this.featureExecution = registry;
  }
  private profilesForMode(mode: BumperMode): Map<string, BumperProfileStat> {
    return mode === 'page-bumper' ? this.pageProfiles : this.profiles;
  }
  isMetadataRefreshing(): boolean {
    return this.refreshing || this.runner.hasMetadataReads?.() === true;
  }
  isReadingMetadataProfile(id: string): boolean {
    return this.runner.isReadingProfile?.(id) === true;
  }
  isProfileRunning(id: string) {
    return (
      this.active.has(id) ||
      this.starting.has(id) ||
      this.workers.has(id) ||
      this.runner.isReadingProfile?.(id) === true
    );
  }
  hasActiveExecution() {
    return (
      this.active.size > 0 ||
      this.starting.size > 0 ||
      this.workers.size > 0 ||
      this.refreshing ||
      this.runner.hasMetadataReads?.() === true
    );
  }
  private modeOf(id: string): BumperMode {
    return this.profileModes.get(id) ?? 'group-bumper';
  }
  isProfileRunningInMode(id: string, mode: BumperMode) {
    return (
      this.modeOf(id) === mode &&
      (this.active.has(id) || this.starting.has(id) || this.workers.has(id))
    );
  }
  hasActiveExecutionInMode(mode: BumperMode) {
    for (const id of new Set([...this.active, ...this.starting, ...this.workers.keys()]))
      if (this.modeOf(id) === mode) return true;
    return false;
  }
  stopRefresh(kind?: 'groups' | 'pages'): void {
    if (kind && this.refreshingKind && this.refreshingKind !== kind) {
      this.stopAvatarRefresh?.(kind);
      return;
    }
    this.refreshAbort?.abort(new Error('FACEBOOK_METADATA_BATCH_ABORTED'));
    this.refreshAbort = null;
    this.stopAvatarRefresh?.(kind);
    const wasKind = kind ?? this.refreshingKind;
    this.refreshing = false;
    this.refreshingKind = null;
    if (wasKind === 'pages') {
      this.statusText = '已停止读取专页资料';
      this.pageStatusText = '已停止读取专页资料';
    } else {
      this.statusText = '已停止读取小组资料';
    }
  }
  async state(): Promise<BumperState> {
    const [groups, pages, settings, extra] = await Promise.all([
      this.repo.targets('groups'),
      this.repo.targets('pages'),
      this.repo.settings(),
      this.summary(),
    ]);
    const pageSettings = this.repo.pageSettings
      ? await this.repo.pageSettings()
      : (this.fallbackPageSettings ?? settings);
    const pageComments = this.repo.comments ? await this.repo.comments('page') : [];
    const groupTotal = this.repo.total ? await this.repo.total('group') : extra.total;
    const pageTotal = this.repo.total ? await this.repo.total('page') : 0;
    const groupCounts = await this.repo.todayCounts('group');
    const pageCounts = await this.repo.todayCounts('page');
    const dailyStats = (await this.repo.weeklyDailyCounts?.(undefined, 'group')) ?? [];
    const pageDailyStats = (await this.repo.weeklyDailyCounts?.(undefined, 'page')) ?? [];
    const pendingReviewOperations = (await this.repo.pendingReviewOperations?.()) ?? [];
    const profiles: Record<string, BumperProfileStat> = Object.fromEntries(
      Object.entries(groupCounts).map(([id, today]) => [
        id,
        { today, session: 0, status: '未运行', running: false },
      ]),
    );
    const pageProfiles: Record<string, BumperProfileStat> = Object.fromEntries(
      Object.entries(pageCounts).map(([id, today]) => [
        id,
        { today, session: 0, status: '未运行', running: false },
      ]),
    );
    for (const [id, stat] of this.profiles) {
      profiles[id] = { ...stat, today: Math.max(groupCounts[id] ?? 0, stat.today) };
    }
    for (const [id, stat] of this.pageProfiles) {
      pageProfiles[id] = { ...stat, today: Math.max(pageCounts[id] ?? 0, stat.today) };
    }
    const groupRunning = this.hasActiveExecutionInMode('group-bumper');
    const metadataRefreshing = this.refreshing || this.runner.hasMetadataReads?.() === true;
    return {
      groups,
      pages,
      settings,
      pageSettings,
      comments: extra.comments,
      pageComments,
      total: groupTotal,
      pageTotal,
      running: groupRunning,
      statusText: this.statusText,
      profileCounts: profiles,
      dailyStats,
      pageDailyStats,
      pageBumperRunning: this.hasActiveExecutionInMode('page-bumper'),
      pageBumperStatusText: this.pageStatusText,
      pageBumperProfileCounts: pageProfiles,
      metadataRefreshing,
      groupAvatarRefreshing: this.refreshingKind === 'groups',
      pageAvatarRefreshing: this.refreshingKind === 'pages',
      pendingReviewOperations,
    };
  }
  async manage(action: string, input: unknown) {
    this.assertAllowed();
    if (action === 'groups/refresh-stop') {
      this.stopRefresh('groups');
      return this.state();
    }
    if (action === 'pages/refresh-stop') {
      this.stopRefresh('pages');
      return this.state();
    }
    const statusBefore = this.statusText;
    const syncPageStatus = () => {
      // 「专页顶贴」页面读取 pageStatusText：主页相关操作的提示同步过去
      if (action.startsWith('pages/') && this.statusText !== statusBefore)
        this.pageStatusText = this.statusText;
    };
    try {
      await this.manageAction(action, input);
    } finally {
      syncPageStatus();
    }
    return this.state();
  }
  private async manageAction(action: string, input: unknown): Promise<void> {
    switch (action) {
      case 'groups/refresh':
      case 'pages/refresh': {
        if (this.refreshing) throw new ProductError('BUMPER_READING', '正在读取资料，请稍候', 409);
        if (
          this.hasActiveExecutionInMode('group-bumper') ||
          this.hasActiveExecutionInMode('page-bumper')
        )
          throw new ProductError('BUMPER_RUNNING', '请先停止顶贴任务再读取资料', 409);
        const { ids } = z
          .object({ ids: z.array(z.string().min(1)).max(500).optional() })
          .strict()
          .parse(input);
        const kind = action === 'groups/refresh' ? 'groups' : 'pages';
        const all = await this.repo.targets(kind);
        const targets = ids?.length
          ? all.filter((row) => ids.includes(row.id))
          : all.filter(isTargetIncomplete);
        if (!targets.length) {
          this.statusText = '当前列表资料已完整，如需重读请先勾选目标';
          break;
        }
        this.refreshing = true;
        this.refreshingKind = kind;
        this.statusText = `正在读取资料（共 ${targets.length} 项）…`;
        if (kind === 'pages') this.pageStatusText = this.statusText;
        const abortController = new AbortController();
        this.refreshAbort = abortController;
        const work = (async () => {
          try {
            const result = await this.refreshAvatars?.(kind, targets, {
              signal: abortController.signal,
            });
            if (abortController.signal.aborted) {
              this.statusText = kind === 'pages' ? '已停止读取专页资料' : '已停止读取小组资料';
            } else {
              this.statusText = result
                ? '读取资料：已更新 ' +
                  result.updated +
                  ' 项' +
                  (result.needsBrowser
                    ? '，' +
                      result.needsBrowser +
                      ' 项需闲置已登录浏览器才能补齐（当前无可用闲置浏览器）'
                    : '') +
                  (result.failed ? '，' + result.failed + ' 项未能完整读取' : '') +
                  (result.error ? '（' + result.error + '）' : '')
                : '读取资料完成';
            }
          } catch (error) {
            this.statusText =
              '读取资料异常：' + (error instanceof Error ? error.message : String(error));
          } finally {
            if (kind === 'pages') this.pageStatusText = this.statusText;
            if (this.refreshAbort === abortController) {
              this.refreshAbort = null;
              this.refreshing = false;
              this.refreshingKind = null;
            }
          }
        })();
        await Promise.race([work, new Promise<void>((resolve) => setTimeout(resolve, 20))]);
        break;
      }
      case 'groups/add': {
        const parsed = BumperGroupTargetsInput.parse(input);
        const items = await this.repo.upsertTargets('groups', parsed);
        const pending = items.filter((item) => isTargetIncomplete(item));
        if (pending.length && this.refreshAvatars && this.hasActiveExecution()) {
          this.statusText = RUNNING_ADD_STATUS;
          return;
        }
        if (pending.length && this.refreshAvatars) {
          const abortController = new AbortController();
          this.refreshAbort = abortController;
          this.refreshingKind = 'groups';
          void this.refreshAvatars('groups', pending, {
            signal: abortController.signal,
          })
            .then((result) => {
              if (result?.needsBrowser) {
                this.statusText = '部分资料需闲置已登录浏览器才能补齐（当前无可用闲置浏览器）';
              }
            })
            .catch(() => {})
            .finally(() => {
              if (this.refreshAbort === abortController) {
                this.refreshAbort = null;
                if (this.refreshingKind === 'groups') this.refreshingKind = null;
              }
            });
        }
        break;
      }
      case 'pages/add': {
        const parsed = BumperPageTargetsInput.parse(input);
        const items = await this.repo.upsertTargets('pages', parsed);
        const pending = items.filter((item) => isTargetIncomplete(item));
        if (pending.length && this.refreshAvatars && this.hasActiveExecution()) {
          this.statusText = RUNNING_ADD_STATUS;
          this.pageStatusText = RUNNING_ADD_STATUS;
          return;
        }
        if (pending.length && this.refreshAvatars) {
          const abortController = new AbortController();
          this.refreshAbort = abortController;
          this.refreshingKind = 'pages';
          void this.refreshAvatars('pages', pending, {
            signal: abortController.signal,
          })
            .then((result) => {
              if (result?.needsBrowser) {
                this.statusText = '部分资料需闲置已登录浏览器才能补齐（当前无可用闲置浏览器）';
                this.pageStatusText = this.statusText;
              }
            })
            .catch(() => {})
            .finally(() => {
              if (this.refreshAbort === abortController) {
                this.refreshAbort = null;
                if (this.refreshingKind === 'pages') this.refreshingKind = null;
              }
            });
        }
        break;
      }
      case 'groups/delete':
        await this.repo.deleteTargets('groups', input);
        break;
      case 'pages/delete':
        await this.repo.deleteTargets('pages', input);
        break;
      case 'settings':
        await this.repo.saveSettings(input);
        break;
      case 'page-settings':
        if (this.repo.savePageSettings) {
          await this.repo.savePageSettings(input);
        } else {
          this.fallbackPageSettings = BumperSettings.parse(input);
        }
        break;
      case 'comments':
        await this.repo.saveComments(input, 'group');
        break;
      case 'page-comments':
        await this.repo.saveComments(input, 'page');
        break;
      case 'logs/delete':
        await this.repo.deleteLogs(input);
        break;
      default:
        throw new ProductError('BUMPER_ACTION_UNKNOWN', '未知的小组顶贴操作', 404);
    }
  }
  async logs(
    search: string,
    before?: number,
    beforeId?: string,
    limit = 200,
    sourceMode?: BumperScope,
  ) {
    return this.repo.logs(search.slice(0, 300), limit, before, beforeId, sourceMode);
  }
  async start(input: unknown) {
    return this.startRun(input, 'live');
  }
  async startScanOnly(input: unknown) {
    return this.startRun(input, 'scan_only');
  }
  /** 专页顶贴：直接进入专页主页按时间线顶贴，复用顶贴执行器、账本与配额。 */
  async startPageBumper(input: unknown) {
    const req = StartPageBumper.parse(input);
    return this.startRun(req, 'live', 'page-bumper');
  }
  private async startRun(
    input: unknown,
    executionMode: 'live' | 'scan_only',
    mode: BumperMode = 'group-bumper',
  ) {
    this.assertAllowed();
    if (this.refreshing || this.runner.hasMetadataReads?.() === true)
      throw new ProductError('BUMPER_READING', '正在读取资料，请稍候', 409);
    const req =
      mode === 'page-bumper'
        ? { ...StartPageBumper.parse(input), groupIds: [] as string[] }
        : StartBumper.parse(input);
    const requested = [...new Set(req.profileIds)];
    const otherMode: BumperMode = mode === 'page-bumper' ? 'group-bumper' : 'page-bumper';
    const otherLabel = otherMode === 'page-bumper' ? '专页顶贴' : '小组顶贴';
    const targetProfiles = this.profilesForMode(mode);
    const otherProfiles = this.profilesForMode(otherMode);

    const newlyAdmitting = requested.filter(
      (id) => !this.isProfileRunningInMode(id, mode) && !this.admitting.has(id),
    );
    for (const id of newlyAdmitting) {
      this.admitting.add(id);
      this.admittingModes.set(id, mode);
    }

    let admittedIds: string[] = [];
    try {
      const admission = await admitProfilesForStart({
        requestedProfileIds: requested,
        currentModuleId: mode,
        isAlreadyRunningInCurrentModule: (id) =>
          this.isProfileRunningInMode(id, mode) ||
          (this.admitting.has(id) &&
            !newlyAdmitting.includes(id) &&
            this.admittingModes.get(id) === mode),
        busyModuleLabelsForProfile: async (id) => {
          const labels = this.featureExecution
            ? await this.featureExecution.busyModuleLabels([id], mode)
            : [];
          if (this.isProfileRunningInMode(id, otherMode) && !labels.includes(otherLabel)) {
            labels.push(otherLabel);
          }
          return labels;
        },
        isProfileBusyInOtherModule: async (id) => {
          if (this.isProfileRunningInMode(id, otherMode)) return true;
          if (this.featureExecution && (await this.featureExecution.isProfileBusy(id, mode))) {
            return true;
          }
          return this.runner.busy(id);
        },
        isProfileReady: (id) => this.runner.ready(id),
      });

      for (const skipped of admission.skippedBusy) {
        targetProfiles.set(skipped.profileId, {
          today: 0,
          session: 0,
          status: skipped.reason,
          running: false,
        });
      }
      for (const skipped of admission.skippedOffline) {
        targetProfiles.set(skipped.profileId, {
          today: 0,
          session: 0,
          status: skipped.reason,
          running: false,
        });
      }

      const allGroups = await this.repo.targets('groups');
      const groups =
        mode === 'page-bumper'
          ? [PAGE_BUMPER_SYNTHETIC_GROUP]
          : req.groupIds.flatMap((id) => allGroups.filter((g) => g.id === id));
      const allPages = await this.repo.targets('pages');
      const pages = req.pageIds.flatMap((id) => allPages.filter((p) => p.id === id));
      if (!groups.length || !pages.length)
        throw new ProductError(
          'BUMPER_TARGETS_EMPTY',
          mode === 'page-bumper' ? '请选择已保存的目标专页' : '请选择已保存的小组和目标主页',
          400,
        );
      const settings =
        mode === 'page-bumper'
          ? this.repo.pageSettings
            ? await this.repo.pageSettings()
            : (this.fallbackPageSettings ?? (await this.repo.settings()))
          : await this.repo.settings();
      if (
        executionMode === 'live' &&
        settings.likeProbability === 0 &&
        settings.commentProbability === 0
      )
        throw new ProductError('BUMPER_PROBABILITY_ZERO', '点赞概率和留言概率不能同时为 0%', 400);
      if (
        executionMode === 'live' &&
        settings.commentProbability > 0 &&
        settings.likeProbability === 0
      ) {
        const commentScope: BumperScope = mode === 'page-bumper' ? 'page' : 'group';
        const commentItems = this.repo.comments
          ? await this.repo.comments(commentScope)
          : (await this.summary()).comments;
        if (commentItems.length === 0)
          throw new ProductError(
            'BUMPER_COMMENTS_EMPTY',
            '当前仅开启了留言（点赞概率 0%），但留言列表为空，请先添加留言话术',
            400,
          );
      }

      if (admission.admittedProfileIds.length === 0) {
        if (
          admission.alreadyRunningIds.length > 0 &&
          admission.skippedBusy.length === 0 &&
          admission.skippedOffline.length === 0
        ) {
          throw new ProductError('BUMPER_RUNNING', '所选浏览器正在运行顶贴任务', 409);
        }
        const firstReason =
          admission.skippedBusy[0]?.reason ??
          admission.skippedOffline[0]?.reason ??
          '所选浏览器正在运行顶贴任务';
        throw new ProductError('BUMPER_NO_ELIGIBLE_PROFILES', firstReason, 409);
      }

      admittedIds = admission.admittedProfileIds;
      const runId = globalThis.crypto.randomUUID();
      const setStatus = (text: string) => {
        if (mode === 'page-bumper') this.pageStatusText = text;
        else this.statusText = text;
      };
      for (const id of admittedIds) {
        this.cancelled.delete(id);
        targetProfiles.delete(id);
        if (!this.isProfileRunningInMode(id, otherMode)) {
          otherProfiles.delete(id);
        }
        this.profileModes.set(id, mode);
        this.profileRunIds.set(id, runId);
        this.starting.add(id);
      }

      const eligibleIds = admittedIds.filter((id) => !this.cancelled.has(id));
      const groupQueues = buildStaggeredBumperQueues(eligibleIds, groups);
      const pageQueues = buildStaggeredBumperQueues(eligibleIds, pages);
      let stagger = 0;
      let launched = 0;
      for (const id of eligibleIds) {
        this.assertAllowed();
        if (this.cancelled.has(id)) continue;
        this.active.add(id);
        launched++;
        targetProfiles.set(id, { today: 0, session: 0, status: '准备中', running: true });
        const delay = stagger;
        stagger += Math.round((1800 + Math.floor(Math.random() * 2001)) * this.staggerScale);
        // Each browser has an independent worker with staggered group & page rotation queues.
        const work = this.worker(
          id,
          groupQueues.get(id) ?? groups,
          pageQueues.get(id) ?? pages,
          settings,
          delay,
          runId,
          executionMode,
          mode,
        );
        this.workers.set(id, work);
        void work.finally(() => {
          if (this.workers.get(id) === work) this.workers.delete(id);
          if (!this.hasActiveExecutionInMode(mode)) setStatus('本轮已结束');
        });
      }
      const runningCount = [...this.active].filter((id) => this.modeOf(id) === mode).length;
      setStatus(
        launched
          ? `运行中 · ${runningCount} 个账号`
          : runningCount
            ? `运行中 · ${runningCount} 个账号（本次追加无可运行的空闲账号）`
            : '没有可运行的空闲账号',
      );
    } finally {
      for (const id of newlyAdmitting) {
        this.admitting.delete(id);
        this.admittingModes.delete(id);
      }
      for (const id of admittedIds) this.starting.delete(id);
    }
    return this.state();
  }
  private async acquireSlot(
    id: string,
    max: number,
    stat: BumperProfileStat,
    runId: string,
    mode: BumperMode,
  ) {
    let queued = false;
    const getSlots = () => (mode === 'page-bumper' ? this.pageSlotsInUse : this.groupSlotsInUse);
    while (getSlots() >= Math.max(1, max)) {
      if (this.cancelled.has(id) || this.profileRunIds.get(id) !== runId) return false;
      if (!queued) {
        queued = true;
        stat.status = '排队等待并发槽位…';
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.cancelled.has(id) || this.profileRunIds.get(id) !== runId) return false;
    if (mode === 'page-bumper') this.pageSlotsInUse++;
    else this.groupSlotsInUse++;
    return true;
  }
  private async worker(
    id: string,
    groups: BumperTarget[],
    pages: BumperTarget[],
    settings: BumperSettings,
    delay: number,
    runId: string,
    executionMode: 'live' | 'scan_only',
    mode: BumperMode = 'group-bumper',
  ) {
    const targetProfiles = this.profilesForMode(mode);
    const stat = targetProfiles.get(id);
    if (!stat) throw Error('BUMPER_PROFILE_STATE_MISSING');
    let failed = false;
    let slot = false;
    const current = () => this.profileRunIds.get(id) === runId;
    try {
      for (let left = delay; left > 0 && !this.cancelled.has(id); left -= 100)
        await new Promise((r) => setTimeout(r, Math.min(100, left)));
      if (!this.cancelled.has(id))
        slot = await this.acquireSlot(id, settings.maxConcurrentProfiles ?? 8, stat, runId, mode);
      if (slot && !this.cancelled.has(id)) {
        if (stat.status === '排队等待并发槽位…') stat.status = '准备中';
        await this.runner.run(id, groups, pages, settings, {
          runId,
          executionMode,
          cancelled: () => !current() || this.cancelled.has(id),
          status: (text, today) => {
            if (!current() || targetProfiles.get(id) !== stat) return;
            stat.status = text;
            if (today !== undefined) stat.today = today;
          },
          added: (today) => {
            if (!current() || targetProfiles.get(id) !== stat) return;
            stat.session++;
            stat.today = today;
          },
        });
      }
      if (!stat.status.startsWith('今日已达上限')) {
        if (this.cancelled.has(id)) stat.status = '已停止';
        else if (stat.session > 0 || !stat.status.startsWith('已完成 · 0 次'))
          stat.status = `已完成 · 本轮 ${stat.session} 次`;
      }
    } catch (e) {
      failed = true;
      stat.status = e instanceof Error ? e.message : '顶贴执行失败';
    } finally {
      if (slot) {
        if (mode === 'page-bumper') {
          this.pageSlotsInUse = Math.max(0, this.pageSlotsInUse - 1);
        } else {
          this.groupSlotsInUse = Math.max(0, this.groupSlotsInUse - 1);
        }
      }
      stat.running = this.runner.hasControl?.(id) === true;
      if (!stat.running) {
        this.active.delete(id);
        try {
          await this.repo.saveProfileResult?.({
            profileId: id,
            source: mode === 'page-bumper' ? 'page-bumper' : 'group-bumper',
            runId,
            name: mode === 'page-bumper' ? '专页顶贴' : '小组顶贴',
            state: this.cancelled.has(id) ? 'STOPPED' : failed ? 'FAILED' : 'COMPLETED',
            reason: stat.status,
            finishedAt: Date.now(),
            failedSteps: failed ? 1 : 0,
            skippedSteps: 0,
          });
        } catch {}
      } else {
        stat.status = '停止待确认 · ' + stat.status;
      }
      if (!this.hasActiveExecutionInMode(mode)) {
        if (mode === 'page-bumper') this.pageStatusText = '本轮已结束';
        else this.statusText = '本轮已结束';
      }
    }
  }
  async stop(profileIds?: string[], mode?: BumperMode) {
    this.refreshAbort?.abort();
    const ids = (
      profileIds ?? [...new Set([...this.active, ...this.starting, ...this.admitting])]
    ).filter((id) => !mode || this.modeOf(id) === mode || this.admittingModes.get(id) === mode);
    for (const id of ids) this.cancelled.add(id);
    await Promise.all(
      ids.map(async (id) => {
        if (!this.active.has(id)) return;
        await this.runner.stop(id);
        if (this.runner.hasControl?.(id) === false && !this.workers.has(id)) {
          this.active.delete(id);
          const stat = this.profilesForMode(this.modeOf(id)).get(id);
          if (stat) {
            stat.running = false;
            stat.status = '已停止';
          }
        }
      }),
    );
    return this.state();
  }
}
