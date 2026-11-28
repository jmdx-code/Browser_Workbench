import { z } from 'zod';
import type { CompatibleRepository } from '../domain/persistence.js';
import { ProductError, failError } from '../domain/workspace.js';
import { strictObj, trimReq } from '../shared/contracts.js';
import {
  isTargetIncomplete,
  type BumperRefreshResult,
  type BumperTarget,
} from '../shared/group-bumper.js';
import {
  CreatePosterTaskInput,
  ResolvePendingOperationInput,
  posterTaskTargetFields,
  stripAnsi,
  validatePosterTaskAccountSelection,
  type PosterLog,
  type PosterMaterial,
  type PosterProfileStat,
  type PosterState,
} from '../shared/group-poster.js';
import type { CheckDailyRiskLimitFn } from '../shared/daily-risk-limits.js';
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
  hasEligibleInFlightItem,
  hasEligibleQueueItem,
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
const CreatePosterBatchTasksInput = strictObj({
  materialIds: z.array(trimReq(120)).min(1).max(500),
  ...posterTaskTargetFields,
}).superRefine(validatePosterTaskAccountSelection);
type PosterRepositoryWithPending = PosterRepository & {
  resolvePendingOperation?: (input: ResolvePendingOperationInput) => unknown;
};
export class GroupPosterService {
  private readonly runtime: PosterRuntimeContext;
  private readonly closeOnFinishProfiles = new Set<string>();
  private readonly pendingCloseProfiles = new Set<string>();
  private flushingClosePromise: Promise<void> | null = null;
  private recheckPendingClose = false;
  private closeOnFinishAllOnline = false;
  private pendingBatchDispatchCount = 0;
  private pendingCreateTaskCount = 0;
  private readonly scheduledStepProfiles = new Set<string>();
  private readonly recentFailedRecords = new Map<
    string,
    { at: number; record: ReturnType<PostBumpRecordsPort['insert']> }
  >();
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
      runner: {
        ready: (id) => runner.ready(id),
        busy: (id) => runner.busy(id),
        ...(runner.hasPendingReconnectStop
          ? {
              hasPendingReconnectStop: (id: string) =>
                runner.hasPendingReconnectStop?.(id) ?? false,
            }
          : {}),
        ...(runner.onlineProfileIds
          ? { onlineProfileIds: () => runner.onlineProfileIds?.() ?? [] }
          : {}),
        stop: (id) => runner.stop(id),
        runProfileWorker: async (profileId, files, settings, callbacks) => {
          try {
            await runner.runProfileWorker(profileId, files, settings, callbacks);
          } finally {
            if (
              !this.scheduledStepProfiles.has(profileId) &&
              (settings.closeBrowserOnFinish === true ||
                this.closeOnFinishAllOnline ||
                this.closeOnFinishProfiles.has(profileId))
            )
              this.pendingCloseProfiles.add(profileId);
          }
        },
      },
      mediaPreparer,
      registry,
      assertAllowed,
      refreshAvatars,
      stopAvatarRefresh,
      ensureScheduleTimer: () => {},
      stopRefreshGroups: () => this.stopRefreshGroups(),
    });
    this.runtime.onWorkerSettled = () => this.flushPendingCloseProfiles();
    this.registry?.register({
      id: 'group-poster',
      label: '小组发帖',
      isProfileRunning: (id) => this.isProfileRunning(id),
      hasActiveExecution: () => this.hasActiveExecution(),
      stopProfiles: (ids) => this.stopProfiles(ids),
    });
  }
  private flushPendingCloseProfiles(): Promise<void> {
    if (this.flushingClosePromise) {
      this.recheckPendingClose = true;
      return this.flushingClosePromise;
    }
    this.flushingClosePromise = (async () => {
      await Promise.resolve();
      try {
        do {
          this.recheckPendingClose = false;
          const lifecycle = this.runtime.profileLifecycle;
          if (!lifecycle || this.pendingBatchDispatchCount > 0 || this.pendingCreateTaskCount > 0)
            continue;
          for (const pid of [...this.pendingCloseProfiles]) {
            if (this.scheduledStepProfiles.has(pid)) {
              this.pendingCloseProfiles.delete(pid);
              continue;
            }
            if (
              this.runtime.isProfileRunning(pid) ||
              this.runtime.inFlightByWorker.has(pid) ||
              hasEligibleQueueItem(this.runtime, pid) ||
              hasEligibleInFlightItem(this.runtime, pid)
            )
              continue;
            this.pendingCloseProfiles.delete(pid);
            this.closeOnFinishProfiles.delete(pid);
            if (await this.runtime.registry?.isProfileBusy(pid, 'group-poster').catch(() => true))
              continue;
            await lifecycle.closeProfile(pid, { stopTasksFirst: false }).catch(() => {});
          }
          this.cleanupIdleCloseFlags();
        } while (this.recheckPendingClose);
      } finally {
        this.flushingClosePromise = null;
      }
    })();
    return this.flushingClosePromise;
  }
  private trackCloseOnFinish(input: {
    closeBrowserOnFinish?: boolean;
    accountMode: 'selected' | 'all_online';
    profileIds: readonly string[];
  }): void {
    if (!input.closeBrowserOnFinish) return;
    if (input.accountMode === 'all_online') this.closeOnFinishAllOnline = true;
    else input.profileIds.forEach((pid) => this.closeOnFinishProfiles.add(pid));
  }
  private cleanupIdleCloseFlags(): void {
    if (
      !this.hasActiveExecution() &&
      !this.pendingBatchDispatchCount &&
      !this.pendingCreateTaskCount &&
      !this.runtime.taskQueue.length
    ) {
      this.closeOnFinishProfiles.clear();
      this.closeOnFinishAllOnline = false;
    }
  }
  setProfileLifecycle = (lifecycle: ProfileLifecyclePort) =>
    void (this.runtime.profileLifecycle = lifecycle);
  setWorkboard = (workboard: Workboard) => void (this.runtime.workboard = workboard);
  getWorkboard = () => this.runtime.workboard;
  setCheckDailyRiskLimit = (fn: CheckDailyRiskLimitFn) =>
    void (this.runtime.checkDailyRiskLimit = fn);
  setPostBumpRecords = (port: PostBumpRecordsPort) => {
    this.runtime.postBumpRecords = {
      ...port,
      insert: (entry) => {
        const sanitizedError = entry.errorReason ? stripAnsi(entry.errorReason).trim() : '';
        if (entry.status !== 'failed')
          return port.insert({ ...entry, errorReason: sanitizedError });
        const now = Date.now();
        for (const [k, v] of this.recentFailedRecords)
          if (now - v.at > 5_000) this.recentFailedRecords.delete(k);
        const dedupeKey = `${entry.recordType}|${entry.profileId}|${entry.groupId ?? ''}|${sanitizedError}`;
        const prev = this.recentFailedRecords.get(dedupeKey);
        if (prev && now - prev.at <= 5_000) return prev.record;
        const record = port.insert({ ...entry, errorReason: sanitizedError });
        this.recentFailedRecords.set(dedupeKey, { at: now, record });
        return record;
      },
    };
  };
  async shutdown(): Promise<void> {
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
      pendingReviewOperations,
      postedGroupIdsByMaterial,
      persistedTasks,
    ] = await Promise.all([
      this.repo.targets(),
      this.repo.materials(),
      this.repo.settings(),
      this.repo.total(),
      this.repo.todayCounts(),
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
    this.mutateAndState(async () => void (await this.repo.saveSettings(input)));
  syncMaxConcurrency = async (maxConcurrentProfiles: number): Promise<void> => {
    const capped = Math.max(1, Math.min(50, Math.round(maxConcurrentProfiles)));
    this.runtime.workboard.browserPermits.setLimit(capped);
    const current = await this.repo.settings();
    if (current.maxConcurrentProfiles !== capped) {
      await this.repo.saveSettings({ ...current, maxConcurrentProfiles: capped });
    }
  };
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
      const rawIds =
        typeof input === 'object' && input !== null && 'ids' in input ? input.ids : undefined;
      const reqIds = Array.isArray(rawIds) ? new Set(rawIds.map(String)) : null;
      const candidates = reqIds
        ? allGroups.filter((g) => reqIds.has(g.id))
        : allGroups.filter(isTargetIncomplete);
      if (!candidates.length) {
        this.runtime.statusText = '当前列表资料已完整，如需重读请先勾选目标';
        return;
      }
      this.runtime.statusText = `正在刷新 ${candidates.length} 个小组头像与资料…`;
      await this.runAvatarRefresh(candidates, true);
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
  saveMaterialThumbnail = async (id: string, thumbnailDataUrl: string): Promise<boolean> => {
    this.assertAllowed();
    return (await this.repo.saveMaterialThumbnail?.(id, thumbnailDataUrl)) ?? false;
  };
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
  resolvePendingOperation = (input: unknown) =>
    this.mutateAndState(async () => {
      const parsed = ResolvePendingOperationInput.parse(input);
      const repoWithPending = this.repo as CompatibleRepository<PosterRepositoryWithPending>;
      if (typeof repoWithPending.resolvePendingOperation !== 'function')
        failError('POSTER_RESOLVE_UNSUPPORTED', '当前存储后端不支持待核对发帖处理', 501);
      await repoWithPending.resolvePendingOperation(parsed);
      this.runtime.statusText =
        parsed.resolution === 'confirmed'
          ? '已将待核对发帖记录确认为已发布'
          : '已将待核对发帖记录标记为未发布';
    });
  private async dispatchSingleTask(parsed: CreatePosterTaskInput): Promise<void> {
    await createPosterTask(this.runtime, parsed);
    if (parsed.closeBrowserOnFinish)
      for (const task of this.runtime.runningTasks.values())
        if (task.materialId === parsed.materialId) task.closeBrowserOnFinish = true;
  }
  createTask = async (input: unknown) => {
    this.assertAllowed();
    const parsed = CreatePosterTaskInput.parse(input);
    this.pendingCreateTaskCount += 1;
    this.trackCloseOnFinish(parsed);
    try {
      return await this.mutateAndState(() => this.dispatchSingleTask(parsed), false);
    } finally {
      this.pendingCreateTaskCount = Math.max(0, this.pendingCreateTaskCount - 1);
      await this.flushPendingCloseProfiles();
    }
  };
  createBatchTasks = async (input: unknown) => {
    this.assertAllowed();
    const { materialIds, ...taskBase } = CreatePosterBatchTasksInput.parse(input);
    const uniqueMaterialIds = [...new Set(materialIds)];
    this.pendingBatchDispatchCount += 1;
    this.trackCloseOnFinish(taskBase);
    try {
      return await this.mutateAndState(async () => {
        for (const mid of uniqueMaterialIds) {
          const mat = await preparePosterMaterialById(this.runtime, mid).catch(() => null);
          if (mat?.localFilePath) this.runtime.sharedFiles.add(mat.localFilePath);
        }
        let createdCount = 0;
        let skippedAlreadyPosted = 0;
        for (const materialId of uniqueMaterialIds) {
          try {
            await this.dispatchSingleTask({ ...taskBase, materialId });
            createdCount += 1;
          } catch (err) {
            if (err instanceof ProductError && err.code === 'POSTER_ALL_GROUPS_ALREADY_POSTED') {
              skippedAlreadyPosted += 1;
              continue;
            }
            throw err;
          }
        }
        if (createdCount === 0 && skippedAlreadyPosted > 0) {
          this.runtime.statusText = '所选素材在目标小组均已发过，已自动跳过重复派发';
          failError(
            'POSTER_ALL_GROUPS_ALREADY_POSTED',
            '所选素材在目标小组均已发过，已自动防重复拦截',
            409,
          );
        }
      }, false);
    } finally {
      this.pendingBatchDispatchCount = Math.max(0, this.pendingBatchDispatchCount - 1);
      await this.flushPendingCloseProfiles();
    }
  };
  tickScheduledTasks = async (now = Date.now()) => {
    for (const task of (await this.repo.listTasks?.(100)) ?? [])
      if (task.status === 'scheduled' && task.scheduledAt !== null && task.scheduledAt <= now)
        this.trackCloseOnFinish(task);
    try {
      await tickScheduledPosterTasks(this.runtime, now);
    } finally {
      await this.flushPendingCloseProfiles();
    }
  };
  private runMutateCleanup = (fn: () => Promise<unknown>) =>
    this.mutateAndState(async () => {
      await fn();
      await this.flushPendingCloseProfiles();
    }, false);
  cancelTask = (input: unknown) =>
    this.runMutateCleanup(() => cancelPosterTask(this.runtime, input));
  deleteTask = (input: unknown) =>
    this.runMutateCleanup(() => deletePosterTask(this.runtime, input));
  stop = () => this.runMutateCleanup(() => stopAllPoster(this.runtime));
  stopProfiles = (profileIds: readonly string[]) => stopPosterProfiles(this.runtime, profileIds);
  runScheduledProfileStep = async (input: Parameters<typeof runScheduledPosterProfileStep>[1]) => {
    this.scheduledStepProfiles.add(input.profileId);
    try {
      return await runScheduledPosterProfileStep(this.runtime, input);
    } finally {
      this.scheduledStepProfiles.delete(input.profileId);
    }
  };
}
