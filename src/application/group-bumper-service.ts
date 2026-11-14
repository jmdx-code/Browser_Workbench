import type { CompatibleRepository } from '../domain/persistence.js';
import {
  BumperGroupTargetsInput,
  BumperPageTargetsInput,
  BumperSettings,
  CreateBumperTaskInput,
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
  type BumperScheduledTask,
} from '../shared/group-bumper.js';
import type { ProfileLifecyclePort } from '../shared/profile-lifecycle.js';
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
  scheduledTasks?(limit?: number): BumperScheduledTask[];
  createScheduledTask?(input: unknown): BumperScheduledTask;
  updateScheduledTask?(
    id: string,
    patch: {
      status?: BumperScheduledTask['status'] | undefined;
      statusReason?: string | undefined;
      runId?: string | null | undefined;
      startedAt?: number | null | undefined;
      finishedAt?: number | null | undefined;
    },
  ): BumperScheduledTask | null;
  deleteScheduledTask?(id: string): boolean;
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
      issue?(issue: { kind: 'pending' | 'failed'; reason: string }): void;
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
  private liveGroupSettings = new Set<BumperSettings>();
  private livePageSettings = new Set<BumperSettings>();
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
  private profileLifecycle?: ProfileLifecyclePort;
  private fallbackScheduledTasks = new Map<string, BumperScheduledTask>();
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;
  private scheduleTicking = false;
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
  setProfileLifecycle(lifecycle: ProfileLifecyclePort): void {
    this.profileLifecycle = lifecycle;
  }
  startScheduler(intervalMs = 2000): void {
    if (this.scheduleTimer) return;
    const timer = setInterval(() => {
      void this.tickScheduledTasks();
    }, intervalMs);
    timer.unref?.();
    this.scheduleTimer = timer;
  }
  shutdown(): void {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    this.refreshAbort?.abort();
  }
  private async readScheduledTasks(limit = 100): Promise<BumperScheduledTask[]> {
    if (this.repo.scheduledTasks) {
      return await this.repo.scheduledTasks(limit);
    }
    return [...this.fallbackScheduledTasks.values()]
      .sort((a, b) => a.scheduledAt - b.scheduledAt || b.createdAt - a.createdAt)
      .slice(0, limit);
  }
  private async writeScheduledTaskPatch(
    id: string,
    patch: {
      status?: BumperScheduledTask['status'] | undefined;
      statusReason?: string | undefined;
      runId?: string | null | undefined;
      startedAt?: number | null | undefined;
      finishedAt?: number | null | undefined;
    },
  ): Promise<BumperScheduledTask | null> {
    if (this.repo.updateScheduledTask) {
      return await this.repo.updateScheduledTask(id, patch);
    }
    const existing = this.fallbackScheduledTasks.get(id);
    if (!existing) return null;
    const updated: BumperScheduledTask = {
      ...existing,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.statusReason !== undefined ? { statusReason: patch.statusReason } : {}),
      ...(patch.runId !== undefined ? { runId: patch.runId } : {}),
      ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
      ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
    };
    this.fallbackScheduledTasks.set(id, updated);
    return updated;
  }
  async tickScheduledTasks(now = Date.now()): Promise<void> {
    if (this.scheduleTicking) return;
    this.scheduleTicking = true;
    try {
      const tasks = await this.readScheduledTasks(200);
      const due = tasks
        .filter((t) => t.status === 'scheduled' && t.scheduledAt <= now)
        .sort((a, b) => a.scheduledAt - b.scheduledAt);
      for (const task of due) {
        const claimed = await this.writeScheduledTaskPatch(task.id, {
          status: 'running',
          startedAt: Date.now(),
          statusReason: '已到达定时时间，正在启动浏览器并分配顶贴任务…',
        });
        if (!claimed) continue;
        try {
          const meta = await this.startRunWithMeta(
            task.mode === 'page-bumper'
              ? { profileIds: task.profileIds, pageIds: task.pageIds }
              : { profileIds: task.profileIds, groupIds: task.groupIds, pageIds: task.pageIds },
            'live',
            task.mode,
          );
          await this.writeScheduledTaskPatch(task.id, {
            status: 'running',
            runId: meta.runId,
            statusReason: `运行中（已分配 ${meta.admittedCount} 个账号）`,
          });
          void Promise.allSettled(meta.workerPromises).then(async () => {
            const latest = (await this.readScheduledTasks(200)).find((r) => r.id === task.id);
            if (!latest || latest.status !== 'running') return;
            const anyCancelled = meta.admittedIds.every((pid) => this.cancelled.has(pid));
            await this.writeScheduledTaskPatch(task.id, {
              status: anyCancelled ? 'cancelled' : 'completed',
              statusReason: anyCancelled
                ? '用户手动停止'
                : `已完成（共执行 ${meta.admittedCount} 个账号）`,
              finishedAt: Date.now(),
            });
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          await this.writeScheduledTaskPatch(task.id, {
            status: 'failed',
            statusReason: reason,
            finishedAt: Date.now(),
          });
        }
      }
    } finally {
      this.scheduleTicking = false;
    }
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
    const scheduledTasks = await this.readScheduledTasks(100);
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
      scheduledTasks,
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
      case 'settings': {
        const saved = (await this.repo.saveSettings(input)) ?? BumperSettings.parse(input);
        for (const live of this.liveGroupSettings) Object.assign(live, saved);
        break;
      }
      case 'page-settings': {
        let saved: BumperSettings;
        if (this.repo.savePageSettings) {
          saved = (await this.repo.savePageSettings(input)) ?? BumperSettings.parse(input);
        } else {
          saved = BumperSettings.parse(input);
          this.fallbackPageSettings = saved;
        }
        for (const live of this.livePageSettings) Object.assign(live, saved);
        break;
      }
      case 'comments':
        await this.repo.saveComments(input, 'group');
        break;
      case 'page-comments':
        await this.repo.saveComments(input, 'page');
        break;
      case 'logs/delete':
        await this.repo.deleteLogs(input);
        break;
      case 'tasks/create': {
        const parsed = CreateBumperTaskInput.parse(input);
        if (parsed.scheduledAt <= Date.now() + 2000) {
          throw new ProductError('BUMPER_SCHEDULE_IN_PAST', '定时启动时间必须晚于当前时间', 400);
        }
        const allPages = await this.repo.targets('pages');
        const pages = parsed.pageIds.flatMap((id) => allPages.filter((p) => p.id === id));
        if (!pages.length) {
          throw new ProductError('BUMPER_TARGETS_EMPTY', '请至少选择一个有效的目标主页/专页', 400);
        }
        let validGroupIds: string[] = [];
        if (parsed.mode === 'group-bumper') {
          const allGroups = await this.repo.targets('groups');
          const groups = parsed.groupIds.flatMap((id) => allGroups.filter((g) => g.id === id));
          if (!groups.length) {
            throw new ProductError('BUMPER_TARGETS_EMPTY', '请至少选择一个有效的小组', 400);
          }
          validGroupIds = groups.map((g) => g.id);
        }
        const checkSettings =
          parsed.mode === 'page-bumper'
            ? this.repo.pageSettings
              ? await this.repo.pageSettings()
              : (this.fallbackPageSettings ?? (await this.repo.settings()))
            : await this.repo.settings();
        if (checkSettings.likeProbability === 0 && checkSettings.commentProbability === 0) {
          throw new ProductError('BUMPER_PROBABILITY_ZERO', '点赞概率和留言概率不能同时为 0%', 400);
        }
        if (checkSettings.commentProbability > 0 && checkSettings.likeProbability === 0) {
          const commentScope: BumperScope = parsed.mode === 'page-bumper' ? 'page' : 'group';
          const commentItems = this.repo.comments
            ? await this.repo.comments(commentScope)
            : (await this.summary()).comments;
          if (commentItems.length === 0) {
            throw new ProductError(
              'BUMPER_COMMENTS_EMPTY',
              '当前仅开启了留言（点赞概率 0%），但留言列表为空，请先添加留言话术',
              400,
            );
          }
        }
        const cleanInput = {
          mode: parsed.mode,
          profileIds: [...new Set(parsed.profileIds)],
          groupIds: validGroupIds,
          pageIds: pages.map((p) => p.id),
          scheduledAt: parsed.scheduledAt,
        };
        let created: BumperScheduledTask;
        if (this.repo.createScheduledTask) {
          created = await this.repo.createScheduledTask(cleanInput);
        } else {
          created = {
            id: globalThis.crypto.randomUUID(),
            ...cleanInput,
            status: 'scheduled',
            statusReason: '',
            runId: null,
            createdAt: Date.now(),
            startedAt: null,
            finishedAt: null,
          };
          this.fallbackScheduledTasks.set(created.id, created);
        }
        this.startScheduler();
        const notice = `已创建定时顶贴任务（${new Date(created.scheduledAt).toLocaleString()} 自动启动）`;
        if (created.mode === 'page-bumper') this.pageStatusText = notice;
        else this.statusText = notice;
        break;
      }
      case 'tasks/cancel': {
        const { id } = z.object({ id: z.uuid() }).strict().parse(input);
        const existing = (await this.readScheduledTasks(200)).find((t) => t.id === id);
        if (!existing) {
          throw new ProductError('BUMPER_TASK_NOT_FOUND', '定时任务不存在', 404);
        }
        if (existing.status === 'scheduled') {
          await this.writeScheduledTaskPatch(id, {
            status: 'cancelled',
            statusReason: '用户手动取消',
            finishedAt: Date.now(),
          });
          const rest = (await this.readScheduledTasks(200)).filter(
            (t) => t.mode === existing.mode && t.status === 'scheduled',
          );
          if (rest.length === 0 && !this.hasActiveExecutionInMode(existing.mode)) {
            if (existing.mode === 'page-bumper') this.pageStatusText = '请选择账号和目标专页';
            else this.statusText = '请选择账号、小组和目标主页';
          }
        } else if (existing.status === 'running') {
          await this.writeScheduledTaskPatch(id, {
            status: 'cancelled',
            statusReason: '用户手动停止',
            finishedAt: Date.now(),
          });
          const runningIds = existing.profileIds.filter((pid) =>
            existing.runId
              ? this.profileRunIds.get(pid) === existing.runId
              : this.isProfileRunningInMode(pid, existing.mode),
          );
          if (runningIds.length > 0) {
            await this.stop(runningIds, existing.mode);
          }
        }
        break;
      }
      case 'tasks/delete': {
        const { id } = z.object({ id: z.uuid() }).strict().parse(input);
        const existing = (await this.readScheduledTasks(200)).find((t) => t.id === id);
        if (!existing) {
          throw new ProductError('BUMPER_TASK_NOT_FOUND', '定时任务不存在', 404);
        }
        if (existing.status === 'running') {
          throw new ProductError('BUMPER_TASK_RUNNING', '请先取消正在运行的定时任务再删除', 409);
        }
        if (this.repo.deleteScheduledTask) {
          await this.repo.deleteScheduledTask(id);
        } else {
          this.fallbackScheduledTasks.delete(id);
        }
        const rest = (await this.readScheduledTasks(200)).filter(
          (t) => t.mode === existing.mode && t.status === 'scheduled',
        );
        if (rest.length === 0 && !this.hasActiveExecutionInMode(existing.mode)) {
          if (existing.mode === 'page-bumper') this.pageStatusText = '请选择账号和目标专页';
          else this.statusText = '请选择账号、小组和目标主页';
        }
        break;
      }
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
  ): Promise<BumperState> {
    await this.startRunWithMeta(input, executionMode, mode);
    return this.state();
  }

  private async startRunWithMeta(
    input: unknown,
    executionMode: 'live' | 'scan_only',
    mode: BumperMode = 'group-bumper',
  ): Promise<{
    runId: string;
    admittedIds: string[];
    admittedCount: number;
    workerPromises: Promise<void>[];
  }> {
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
    const setStatus = (text: string) => {
      if (mode === 'page-bumper') this.pageStatusText = text;
      else this.statusText = text;
    };

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
    const rawSettings =
      mode === 'page-bumper'
        ? this.repo.pageSettings
          ? await this.repo.pageSettings()
          : (this.fallbackPageSettings ?? (await this.repo.settings()))
        : await this.repo.settings();
    const settings: BumperSettings = { ...rawSettings };
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

    const newlyAdmitting = requested.filter(
      (id) => !this.isProfileRunningInMode(id, mode) && !this.admitting.has(id),
    );
    for (const id of newlyAdmitting) {
      this.cancelled.delete(id);
      this.admitting.add(id);
      this.admittingModes.set(id, mode);
    }

    let admittedIds: string[] = [];
    const launchFailureReasons = new Map<string, string>();
    try {
      if (this.profileLifecycle && newlyAdmitting.length > 0) {
        const offlineCandidates: string[] = [];
        for (const id of newlyAdmitting) {
          if (this.runner.ready(id)) continue;
          const busyElsewhere =
            this.isProfileRunningInMode(id, otherMode) ||
            (this.featureExecution ? await this.featureExecution.isProfileBusy(id, mode) : false) ||
            (await this.runner.busy(id));
          if (!busyElsewhere) offlineCandidates.push(id);
        }
        if (offlineCandidates.length > 0) {
          setStatus(`正在自动启动 ${offlineCandidates.length} 个离线浏览器并同步插件…`);
          for (const id of offlineCandidates) {
            targetProfiles.set(id, {
              today: 0,
              session: 0,
              status: '正在启动浏览器…',
              running: true,
            });
          }
          const launchRes = await this.profileLifecycle.ensureProfilesOnline(offlineCandidates);
          for (const f of launchRes.failed) {
            launchFailureReasons.set(f.profileId, `跳过：${f.reason}`);
          }
        }
      }

      const activeRequested = requested.filter(
        (id) => !newlyAdmitting.includes(id) || !this.cancelled.has(id),
      );
      if (activeRequested.length === 0) {
        for (const id of newlyAdmitting) {
          if (this.cancelled.has(id)) {
            targetProfiles.set(id, { today: 0, session: 0, status: '已停止', running: false });
          }
        }
        setStatus('已停止');
        return { runId: '', admittedIds: [], admittedCount: 0, workerPromises: [] };
      }

      const admission = await admitProfilesForStart({
        requestedProfileIds: activeRequested,
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
          status: launchFailureReasons.get(skipped.profileId) ?? skipped.reason,
          running: false,
        });
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
          (admission.skippedOffline[0]
            ? (launchFailureReasons.get(admission.skippedOffline[0].profileId) ??
              admission.skippedOffline[0].reason)
            : undefined) ??
          '所选浏览器正在运行顶贴任务';
        throw new ProductError('BUMPER_NO_ELIGIBLE_PROFILES', firstReason, 409);
      }

      admittedIds = admission.admittedProfileIds;
      const runId = globalThis.crypto.randomUUID();
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
      const workerPromises: Promise<void>[] = [];
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
        workerPromises.push(work);
        void work.finally(() => {
          if (this.workers.get(id) === work) this.workers.delete(id);
          if (!this.hasActiveExecutionInMode(mode)) setStatus('本轮已结束');
        });
      }
      if (launched > 0) {
        const liveSet = mode === 'page-bumper' ? this.livePageSettings : this.liveGroupSettings;
        liveSet.add(settings);
        void Promise.allSettled(workerPromises).finally(() => {
          liveSet.delete(settings);
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
      return {
        runId,
        admittedIds: eligibleIds,
        admittedCount: launched,
        workerPromises,
      };
    } finally {
      for (const id of newlyAdmitting) {
        this.admitting.delete(id);
        this.admittingModes.delete(id);
      }
      for (const id of admittedIds) this.starting.delete(id);
    }
  }
  private async acquireSlot(
    id: string,
    getMax: () => number,
    stat: BumperProfileStat,
    runId: string,
    mode: BumperMode,
  ) {
    let queued = false;
    const getSlots = () => (mode === 'page-bumper' ? this.pageSlotsInUse : this.groupSlotsInUse);
    while (getSlots() >= Math.max(1, getMax())) {
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
    let pending = 0;
    let failedActions = 0;
    let issueReason = '';
    let slot = false;
    const current = () => this.profileRunIds.get(id) === runId;
    try {
      for (let left = delay; left > 0 && !this.cancelled.has(id); left -= 100)
        await new Promise((r) => setTimeout(r, Math.min(100, left)));
      if (!this.cancelled.has(id))
        slot = await this.acquireSlot(
          id,
          () => settings.maxConcurrentProfiles ?? 8,
          stat,
          runId,
          mode,
        );
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
          issue: (issue) => {
            if (!current() || targetProfiles.get(id) !== stat) return;
            if (issue.kind === 'pending') pending++;
            else failedActions++;
            issueReason = issue.reason;
          },
          added: (today) => {
            if (!current() || targetProfiles.get(id) !== stat) return;
            stat.session++;
            stat.today = today;
          },
        });
      }
      if (pending + failedActions > 0 && !this.cancelled.has(id)) {
        const detail = [
          pending ? `${pending} 项待核对` : '',
          failedActions ? `${failedActions} 项未完成` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        stat.status = `本轮 ${stat.session} 次已确认 · ${detail} · ${issueReason}`;
      } else if (!stat.status.startsWith('今日已达上限')) {
        if (this.cancelled.has(id)) stat.status = '已停止';
        else if (stat.session > 0 || !stat.status.startsWith('已完成 · 0 次'))
          stat.status = `已完成 · 本轮 ${stat.session} 次`;
      }
    } catch (e) {
      failed = !this.cancelled.has(id);
      stat.status = this.cancelled.has(id)
        ? '已停止'
        : e instanceof Error
          ? e.message
          : '顶贴执行失败';
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
            state: this.cancelled.has(id)
              ? 'STOPPED'
              : failed || pending + failedActions > 0
                ? 'FAILED'
                : 'COMPLETED',
            reason: stat.status,
            finishedAt: Date.now(),
            failedSteps: pending + failedActions + (failed ? 1 : 0),
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
    const workers = ids
      .map((id) => this.workers.get(id))
      .filter((work): work is Promise<void> => work !== undefined);
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
    await Promise.allSettled(workers);
    return this.state();
  }
}
