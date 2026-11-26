import type { CompatibleRepository } from '../domain/persistence.js';
import { ProductError } from '../domain/workspace.js';
import {
  isTargetIncomplete,
  type BumperRefreshResult,
  type BumperTarget,
} from '../shared/group-bumper.js';
import type {
  PosterLog,
  PosterMaterial,
  PosterProfileStat,
  PosterState,
} from '../shared/group-poster.js';
import type { PostBumpRecordsPort } from '../shared/post-bump-records.js';
import type { ProfileLifecyclePort } from '../shared/profile-lifecycle.js';
import type { FeatureExecutionRegistry } from './feature-execution-registry.js';
import {
  buildProfileCountMap,
  formatAvatarRefreshSummary,
  runTargetAvatarRefresh,
} from './module-worker-pool.js';
import {
  cleanupExpiredPosterDriveCache,
  createPosterRuntime,
  getPosterMaterialThumbnail,
  prepareAdHocPosterMaterial,
  preparePendingPosterMaterials,
  preparePosterMaterialById,
  streamPosterMaterialMedia,
  type GroupPosterBrowserPort,
  type PosterMediaPreparerPort,
  type PosterRepository,
  type PosterRuntimeContext,
} from './poster/poster-media-and-types.js';
import {
  buildActiveGroupsByMaterial,
  cancelPosterTask,
  createPosterTask,
  deletePosterTask,
  stopAllPoster,
  stopPosterProfiles,
  tickScheduledPosterTasks,
} from './poster/poster-queue-and-dispatch.js';
import { runScheduledPosterProfileStep } from './poster/poster-worker-runner.js';
import type { Workboard } from './workboard.js';

export {
  PosterAccountRestrictedError,
  type GroupPosterBrowserCallbacks,
  type GroupPosterBrowserPort,
  type GroupPosterTaskItem,
  type PosterMediaPreparerPort,
  type PosterMediaStreamChunk,
  type PosterRepository,
  type PreparedPosterMedia,
} from './poster/poster-media-and-types.js';

export class GroupPosterService {
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;
  private readonly runtime: PosterRuntimeContext;

  get activeGroupIds(): Set<string> {
    return this.runtime.activeGroupIds;
  }

  constructor(
    private readonly repo: CompatibleRepository<PosterRepository>,
    runner: GroupPosterBrowserPort,
    mediaPreparer: PosterMediaPreparerPort,
    private readonly registry?: FeatureExecutionRegistry,
    private readonly assertAllowed: () => void = () => {},
    refreshAvatars?: (
      kind: 'groups' | 'pages',
      items: BumperTarget[],
      options?: { signal?: AbortSignal; onUpdated?: () => void },
    ) => Promise<BumperRefreshResult | void>,
    stopAvatarRefresh?: (kind?: 'groups' | 'pages') => void,
  ) {
    this.runtime = createPosterRuntime({
      repo,
      runner,
      mediaPreparer,
      registry,
      assertAllowed,
      refreshAvatars,
      stopAvatarRefresh,
      ensureScheduleTimer: () => this.ensureScheduleTimer(),
      stopRefreshGroups: () => this.stopRefreshGroups(),
    });
    this.registry?.register({
      id: 'group-poster',
      label: '小组发帖',
      isProfileRunning: (id) => this.isProfileRunning(id),
      hasActiveExecution: () => this.hasActiveExecution(),
      stopProfiles: (ids) => this.stopProfiles(ids),
    });
    this.ensureScheduleTimer();
  }

  setProfileLifecycle = (lifecycle: ProfileLifecyclePort) =>
    void (this.runtime.profileLifecycle = lifecycle);
  setPostBumpRecords = (port: PostBumpRecordsPort) => void (this.runtime.postBumpRecords = port);
  setWorkboard = (workboard: Workboard) => void (this.runtime.workboard = workboard);

  private ensureScheduleTimer(): void {
    if (this.scheduleTimer) return;
    this.scheduleTimer = setInterval(() => void this.tickScheduledTasks().catch(() => {}), 2000);
    this.scheduleTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    this.runtime.refreshAbort?.abort();
    this.runtime.refreshAbort = null;
    if (this.hasActiveExecution()) await this.stop().catch(() => {});
  }

  isProfileRunning = (id: string) => this.runtime.isProfileRunning(id);
  hasActiveExecution = () => this.runtime.hasActiveExecution();

  async state(): Promise<PosterState> {
    const [
      groups,
      materials,
      settings,
      total,
      counts,
      dailyStats,
      pendingReviewOperations,
      postedGroupIdsByMaterial,
      persistedTasks,
    ] = await Promise.all([
      this.repo.targets(),
      this.repo.materials(),
      this.repo.settings(),
      this.repo.total(),
      this.repo.todayCounts(),
      this.repo.weeklyDailyCounts?.() ?? [],
      this.repo.pendingReviewOperations?.() ?? [],
      this.repo.postedGroupIdsByMaterial?.() ?? {},
      this.repo.listTasks?.(100) ?? [],
    ]);
    return {
      groups,
      materials,
      settings,
      total,
      running: this.hasActiveExecution(),
      groupAvatarRefreshing: this.runtime.groupAvatarRefreshing,
      statusText: this.runtime.statusText,
      profileCounts: buildProfileCountMap<PosterProfileStat>(
        counts,
        this.runtime.profiles,
        (today) => ({ today, session: 0, status: '未运行', running: false }),
      ),
      dailyStats,
      pendingReviewOperations,
      postedGroupIdsByMaterial,
      activeGroupsByMaterial: buildActiveGroupsByMaterial(this.runtime),
      tasks: persistedTasks.map((t) => this.runtime.runningTasks.get(t.id) ?? t),
    };
  }

  private async mutateAndState(
    fn: () => Promise<unknown>,
    requireAllowed = true,
  ): Promise<PosterState> {
    if (requireAllowed) this.assertAllowed();
    await fn();
    return this.state();
  }

  saveSettings = (input: unknown) =>
    this.mutateAndState(async () => {
      const saved = await this.repo.saveSettings(input);
      this.runtime.liveMaxConcurrentCap = Math.max(
        1,
        (saved ?? (await this.repo.settings())).maxConcurrentProfiles,
      );
    });

  async syncMaxConcurrency(maxConcurrentProfiles: number): Promise<void> {
    const capped = Math.max(1, Math.min(50, Math.round(maxConcurrentProfiles)));
    const current = await this.repo.settings();
    if (current.maxConcurrentProfiles !== capped)
      await this.repo.saveSettings({ ...current, maxConcurrentProfiles: capped });
    this.runtime.liveMaxConcurrentCap = capped;
  }

  private async runAvatarRefresh(candidates: BumperTarget[], interactive: boolean): Promise<void> {
    const refreshFn = this.runtime.refreshAvatars;
    if (!refreshFn || !candidates.length) return;
    await runTargetAvatarRefresh({
      targets: candidates,
      abortPreviousReason: interactive ? 'FACEBOOK_METADATA_BATCH_ABORTED' : undefined,
      refresh: (signal) => refreshFn('groups', candidates, { signal }),
      getAbort: () => this.runtime.refreshAbort,
      setAbort: (ctrl) => void (this.runtime.refreshAbort = ctrl),
      setRefreshing: (active) => void (this.runtime.groupAvatarRefreshing = active),
      waitMs: interactive ? 20 : undefined,
      onResult: (res, aborted) => {
        if (interactive)
          this.runtime.statusText = aborted
            ? '已停止刷新小组头像'
            : formatAvatarRefreshSummary(res, '个', '刷新头像完成');
      },
      onError: (_err, aborted) => {
        if (interactive && aborted) this.runtime.statusText = '已停止刷新小组头像';
      },
    });
  }

  addGroups = (input: unknown, options?: { skipAutoRefresh?: boolean }) =>
    this.mutateAndState(async () => {
      const groups = await this.repo.upsertTargets(input);
      if (!options?.skipAutoRefresh && !this.hasActiveExecution())
        void this.runAvatarRefresh(groups.filter(isTargetIncomplete), false);
    });

  deleteGroups = (input: unknown) =>
    this.mutateAndState(() => Promise.resolve(this.repo.deleteTargets(input)));

  refreshGroups = (input: unknown = {}) =>
    this.mutateAndState(async () => {
      if (this.hasActiveExecution())
        throw new ProductError('POSTER_BUSY', '发帖任务运行中，请先停止后再刷新头像', 409);
      const allGroups = await this.repo.targets();
      const idsObj =
        typeof input === 'object' && input !== null && 'ids' in input
          ? (input as { ids?: unknown }).ids
          : undefined;
      const requestedIds = Array.isArray(idsObj) ? new Set(idsObj.map(String)) : null;
      const candidates = requestedIds
        ? allGroups.filter((g) => requestedIds.has(g.id))
        : allGroups.filter(isTargetIncomplete);
      if (!candidates.length) this.runtime.statusText = '当前列表资料已完整，如需重读请先勾选目标';
      else {
        this.runtime.statusText = `正在刷新 ${candidates.length} 个小组头像与资料…`;
        await this.runAvatarRefresh(candidates, true);
      }
    });

  stopRefreshGroups = () =>
    this.mutateAndState(async () => {
      this.runtime.refreshAbort?.abort(new Error('FACEBOOK_METADATA_BATCH_ABORTED'));
      this.runtime.refreshAbort = null;
      this.runtime.stopAvatarRefresh?.('groups');
      this.runtime.groupAvatarRefreshing = false;
      this.runtime.statusText = '已停止刷新小组头像';
    });

  saveMaterials = (input: unknown) =>
    this.mutateAndState(async () => {
      const saved = await this.repo.saveMaterials(input);
      void preparePendingPosterMaterials(this.runtime, saved).catch(() => {});
    });

  deleteMaterials = (input: unknown) =>
    this.mutateAndState(() => Promise.resolve(this.repo.deleteMaterials(input)));
  prepareMaterialById = (id: string) => preparePosterMaterialById(this.runtime, id);
  prepareAdHocMaterial = (item: PosterMaterial) => prepareAdHocPosterMaterial(this.runtime, item);
  getMaterialThumbnail = (id: string) => getPosterMaterialThumbnail(this.runtime, id);
  async saveMaterialThumbnail(id: string, thumbnailDataUrl: string): Promise<boolean> {
    this.assertAllowed();
    return this.repo.saveMaterialThumbnail
      ? await this.repo.saveMaterialThumbnail(id, thumbnailDataUrl)
      : false;
  }
  streamMaterialMedia = (id: string, rangeHeader?: string) =>
    streamPosterMaterialMedia(this.runtime, id, rangeHeader);
  cleanupExpiredDriveCache = (nowMs = Date.now()) =>
    cleanupExpiredPosterDriveCache(this.runtime, nowMs);
  logs = (
    search = '',
    before?: number,
    beforeId?: string,
    materialId?: string,
  ): Promise<PosterLog[]> =>
    Promise.resolve(this.repo.logs(search, 200, before, beforeId, materialId));
  deleteLogs = (input: unknown) =>
    this.mutateAndState(() => Promise.resolve(this.repo.deleteLogs(input)));
  createTask = (input: unknown) =>
    this.mutateAndState(() => createPosterTask(this.runtime, input), false);
  tickScheduledTasks = (now = Date.now()) => tickScheduledPosterTasks(this.runtime, now);
  cancelTask = (input: unknown) =>
    this.mutateAndState(() => cancelPosterTask(this.runtime, input), false);
  deleteTask = (input: unknown) =>
    this.mutateAndState(() => deletePosterTask(this.runtime, input), false);
  stop = () => this.mutateAndState(() => stopAllPoster(this.runtime), false);
  stopProfiles = (profileIds: readonly string[]) => stopPosterProfiles(this.runtime, profileIds);
  runScheduledProfileStep = (input: Parameters<typeof runScheduledPosterProfileStep>[1]) =>
    runScheduledPosterProfileStep(this.runtime, input);
}
