import type { CompatibleRepository } from '../domain/persistence.js';
import type { FeatureExecutionRegistry } from './feature-execution-registry.js';
import { admitProfilesForStart } from './profile-start-admission.js';
import { mediaReference } from '../domain/resource-table.js';
import { ProductError } from '../domain/workspace.js';
import {
  isTargetIncomplete,
  type BumperDailyStat,
  type BumperRefreshResult,
  type BumperTarget,
} from '../shared/group-bumper.js';
import {
  CreatePosterTaskInput,
  PosterTaskIdInput,
  StartPosterInput,
  type PosterActiveGroupItem,
  type PosterCacheStatus,
  type PosterLog,
  type PosterMaterial,
  type PosterMediaKind,
  type PosterPendingOperation,
  type PosterProfileStat,
  type PosterSettings,
  type PosterState,
  type PosterTask,
} from '../shared/group-poster.js';
import type { ProfileLifecyclePort } from '../shared/profile-lifecycle.js';
import type { ProfileTaskResultValue } from '../shared/task-contracts.js';

export class PosterAccountRestrictedError extends Error {
  public readonly scope: 'global_route' | 'feature_action';
  public readonly abnormalState: 'logged-out' | 'verification' | 'restricted';

  constructor(
    message = '受限 · 需要手机验证或操作受限',
    options?: {
      scope?: 'global_route' | 'feature_action';
      abnormalState?: 'logged-out' | 'verification' | 'restricted';
    },
  ) {
    super(message);
    this.name = 'PosterAccountRestrictedError';
    this.scope = options?.scope ?? 'feature_action';
    this.abnormalState = options?.abnormalState ?? 'restricted';
  }
}

export interface PreparedPosterMedia {
  localFilePath: string;
  mediaKind: PosterMediaKind;
  thumbnailDataUrl?: string | null | undefined;
}

export interface PosterMediaStreamChunk {
  status: 200 | 206 | 416;
  headers: Record<string, string | number>;
  bytes?: Uint8Array | undefined;
}

export interface PosterMediaPreparerPort {
  prepare(
    mediaSource: string,
    assertCurrent?: (bytesRead?: number) => void | Promise<void>,
  ): Promise<PreparedPosterMedia>;
  verifyExists?(localFilePath: string): Promise<boolean>;
  generateThumbnail?(localFilePath: string, mediaKind: PosterMediaKind): Promise<string | null>;
  removeCachedDriveFile?(localFilePath: string): Promise<boolean>;
  readMediaRange?(
    localFilePath: string,
    mediaKind: PosterMediaKind,
    rangeHeader?: string | undefined,
  ): Promise<PosterMediaStreamChunk | null>;
}

export interface GroupPosterTaskItem {
  group: BumperTarget;
  material: PosterMaterial;
  taskIds?: Set<string> | undefined;
  allowedProfileIds?: Set<string> | null | undefined;
}

export interface GroupPosterBrowserCallbacks {
  runId: string;
  cancelled(): boolean;
  status(text: string): void;
  claimNextTask(): Promise<GroupPosterTaskItem | null>;
  returnTaskOnRestriction(task: GroupPosterTaskItem): void;
  onTaskPosted(log: PosterLog): Promise<void>;
  canContinueAccount(profileId: string): Promise<boolean>;
  onGroupIdResolved?(rawGroupId: string, canonicalGroupId: string): Promise<void> | void;
}

export interface GroupPosterBrowserPort {
  ready(profileId: string): boolean;
  busy(profileId: string): Promise<boolean>;
  onlineProfileIds?(): string[] | Promise<string[]>;
  runProfileWorker(
    profileId: string,
    files: readonly string[],
    settings: PosterSettings,
    callbacks: GroupPosterBrowserCallbacks,
  ): Promise<void>;
  stop(profileId: string): Promise<void>;
}

export interface PosterRepository {
  settings(): PosterSettings;
  saveSettings(input: unknown): PosterSettings;
  targets(): BumperTarget[];
  upsertTargets(input: unknown): BumperTarget[];
  deleteTargets(input: unknown): number;
  updateAvatar(id: string, avatarUrl: string): void;
  applyResolvedTargetMetadata?(
    rawId: string,
    metadata: { canonicalId?: string | null; name?: string | null; avatarUrl?: string | null },
  ): unknown;
  materials(): PosterMaterial[];
  saveMaterials(input: unknown): PosterMaterial[];
  deleteMaterials(input: unknown): number;
  toggleMaterials(input: unknown): PosterMaterial[];
  updateMaterialCache(
    id: string,
    cache: {
      localFilePath: string | null;
      mediaKind: PosterMediaKind;
      cacheStatus: PosterCacheStatus;
      cacheError: string | null;
      thumbnailDataUrl?: string | null | undefined;
    },
  ): void;
  getMaterialThumbnail?(id: string): { thumbnailDataUrl: string | null; updatedAt: number } | null;
  saveMaterialThumbnail?(id: string, thumbnailDataUrl: string): boolean;
  getMaterialMediaPath?(
    id: string,
  ): { localFilePath: string | null; mediaKind: PosterMediaKind } | null;
  listExpiredDriveMaterials?(
    cutoffMs: number,
  ): Array<{ id: string; mediaSource: string; localFilePath: string }>;
  markMaterialCacheExpired?(id: string): void;
  listOperationsByProfile?(
    profileId: string,
    includeSettled?: boolean,
  ): Array<{
    binding: { operationId: string; profileId: string; accountId: string };
    runId: string;
    actionKind: string;
    groupId: string;
    groupName: string;
    materialId?: string | undefined;
    postId?: string | undefined;
    postUrl?: string | undefined;
    status: string;
    kernelSettled: boolean;
    reviewReason?: string | undefined;
    createdAt: number;
    updatedAt: number;
  }>;
  hasGroupPostedMaterial(groupId: string, materialId: string): boolean;
  postedGroupIdsByMaterial?(): Record<string, string[]>;
  listTasks?(limit?: number): PosterTask[];
  saveTask?(task: PosterTask): PosterTask;
  deleteTask?(id: string): boolean;
  recordPost(input: PosterLog): boolean;
  logs(
    search?: string,
    limit?: number,
    before?: number,
    beforeId?: string,
    materialId?: string,
  ): PosterLog[];
  deleteLogs(input: unknown): number;
  total(): number;
  todayCounts(): Record<string, number>;
  weeklyDailyCounts?(): BumperDailyStat[];
  pendingReviewOperations?(limit?: number): PosterPendingOperation[];
  saveProfileResult?(result: ProfileTaskResultValue): void;
}

export class GroupPosterService {
  private readonly workers = new Map<string, Promise<void>>();
  private readonly profiles = new Map<string, PosterProfileStat>();
  private readonly active = new Set<string>();
  private readonly starting = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly profileRunIds = new Map<string, string>();
  private readonly preparingMaterials = new Set<string>();
  private taskQueue: GroupPosterTaskItem[] = [];
  private readonly inFlightByWorker = new Map<string, GroupPosterTaskItem>();
  private readonly runningTasks = new Map<string, PosterTask>();
  private readonly sharedFiles = new Set<string>();
  private readonly activeGroupIds = new Set<string>();
  private readonly queuedKeys = new Set<string>();
  private readonly sessionParticipants = new Set<string>();
  private statusText = '请选择贴文卡片上的「发帖」创建立即或定时发帖任务';
  private slotsInUse = 0;
  private groupAvatarRefreshing = false;
  private refreshAbort: AbortController | null = null;
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;
  private tickingSchedule = false;
  private profileLifecycle?: ProfileLifecyclePort;

  setProfileLifecycle(lifecycle: ProfileLifecyclePort): void {
    this.profileLifecycle = lifecycle;
  }

  constructor(
    private readonly repo: CompatibleRepository<PosterRepository>,
    private readonly runner: GroupPosterBrowserPort,
    private readonly mediaPreparer: PosterMediaPreparerPort,
    private readonly registry?: FeatureExecutionRegistry,
    private readonly assertAllowed: () => void = () => {},
    private readonly refreshAvatars?: (
      kind: 'groups' | 'pages',
      items: BumperTarget[],
      options?: { signal?: AbortSignal; onUpdated?: () => void },
    ) => Promise<BumperRefreshResult | void>,
    private readonly stopAvatarRefresh?: (kind?: 'groups' | 'pages') => void,
  ) {
    this.registry?.register({
      id: 'group-poster',
      label: '小组发帖',
      isProfileRunning: (profileId) => this.isProfileRunning(profileId),
      hasActiveExecution: () => this.hasActiveExecution(),
      stopProfiles: (profileIds) => this.stopProfiles(profileIds),
    });
    this.ensureScheduleTimer();
  }

  private ensureScheduleTimer(): void {
    if (this.scheduleTimer) return;
    this.scheduleTimer = setInterval(() => {
      void this.tickScheduledTasks().catch(() => {});
    }, 2000);
    this.scheduleTimer.unref?.();
  }

  isProfileRunning(id: string): boolean {
    return this.active.has(id) || this.starting.has(id) || this.workers.has(id);
  }

  hasActiveExecution(): boolean {
    return this.active.size > 0 || this.starting.size > 0 || this.workers.size > 0;
  }

  private buildActiveGroupsByMaterial(): Record<string, PosterActiveGroupItem[]> {
    const result: Record<string, PosterActiveGroupItem[]> = {};
    const seenPerMaterial = new Map<string, Set<string>>();
    const ensureList = (materialId: string) => {
      let list = result[materialId];
      if (!list) {
        list = [];
        result[materialId] = list;
      }
      let seen = seenPerMaterial.get(materialId);
      if (!seen) {
        seen = new Set();
        seenPerMaterial.set(materialId, seen);
      }
      return { list, seen };
    };
    for (const [profileId, item] of this.inFlightByWorker.entries()) {
      const { list, seen } = ensureList(item.material.id);
      if (seen.has(item.group.id)) continue;
      seen.add(item.group.id);
      list.push({
        groupId: item.group.id,
        groupName: item.group.name,
        state: 'posting',
        profileId,
        statusText: this.profiles.get(profileId)?.status ?? '正在发帖…',
      });
    }
    for (const item of this.taskQueue) {
      const { list, seen } = ensureList(item.material.id);
      if (seen.has(item.group.id)) continue;
      seen.add(item.group.id);
      list.push({
        groupId: item.group.id,
        groupName: item.group.name,
        state: 'queued',
      });
    }
    return result;
  }

  async state(): Promise<PosterState> {
    const [groups, materials, settings, total, counts] = await Promise.all([
      this.repo.targets(),
      this.repo.materials(),
      this.repo.settings(),
      this.repo.total(),
      this.repo.todayCounts(),
    ]);
    const dailyStats = (await this.repo.weeklyDailyCounts?.()) ?? [];
    const pendingReviewOperations = (await this.repo.pendingReviewOperations?.()) ?? [];
    const postedGroupIdsByMaterial = (await this.repo.postedGroupIdsByMaterial?.()) ?? {};
    const persistedTasks = (await this.repo.listTasks?.(100)) ?? [];
    const tasks = persistedTasks.map((t) => this.runningTasks.get(t.id) ?? t);
    const activeGroupsByMaterial = this.buildActiveGroupsByMaterial();
    const profileCounts: Record<string, PosterProfileStat> = Object.fromEntries(
      Object.entries(counts).map(([id, today]) => [
        id,
        { today, session: 0, status: '未运行', running: false },
      ]),
    );
    for (const [id, stat] of this.profiles) {
      profileCounts[id] = {
        ...stat,
        today: counts[id] ?? stat.today,
      };
    }
    return {
      groups,
      materials,
      settings,
      total,
      running: this.hasActiveExecution(),
      groupAvatarRefreshing: this.groupAvatarRefreshing,
      statusText: this.statusText,
      profileCounts,
      dailyStats,
      pendingReviewOperations,
      postedGroupIdsByMaterial,
      activeGroupsByMaterial,
      tasks,
    };
  }

  async saveSettings(input: unknown): Promise<PosterState> {
    this.assertAllowed();
    await this.repo.saveSettings(input);
    return this.state();
  }

  async addGroups(
    input: unknown,
    options?: { skipAutoRefresh?: boolean | undefined },
  ): Promise<PosterState> {
    this.assertAllowed();
    const groups = await this.repo.upsertTargets(input);
    if (!options?.skipAutoRefresh && !this.hasActiveExecution() && this.refreshAvatars) {
      const incomplete = groups.filter(isTargetIncomplete);
      if (incomplete.length > 0) {
        const abortController = new AbortController();
        this.refreshAbort = abortController;
        this.groupAvatarRefreshing = true;
        void this.refreshAvatars('groups', incomplete, {
          signal: abortController.signal,
        })
          .catch(() => {})
          .finally(() => {
            if (this.refreshAbort === abortController) {
              this.refreshAbort = null;
              this.groupAvatarRefreshing = false;
            }
          });
      }
    }
    return this.state();
  }

  async deleteGroups(input: unknown): Promise<PosterState> {
    this.assertAllowed();
    await this.repo.deleteTargets(input);
    return this.state();
  }

  async refreshGroups(input: unknown = {}): Promise<PosterState> {
    this.assertAllowed();
    if (this.hasActiveExecution()) {
      throw new ProductError('POSTER_BUSY', '发帖任务运行中，请先停止后再刷新头像', 409);
    }
    const allGroups = await this.repo.targets();
    const idsObj =
      typeof input === 'object' && input !== null && 'ids' in input
        ? (input as { ids?: unknown }).ids
        : undefined;
    const requestedIds = Array.isArray(idsObj) ? new Set(idsObj.map((x) => String(x))) : null;
    const candidates = requestedIds
      ? allGroups.filter((g) => requestedIds.has(g.id))
      : allGroups.filter(isTargetIncomplete);
    if (candidates.length === 0) {
      this.statusText = '当前列表资料已完整，如需重读请先勾选目标';
    } else if (this.refreshAvatars) {
      this.refreshAbort?.abort(new Error('FACEBOOK_METADATA_BATCH_ABORTED'));
      const abortController = new AbortController();
      this.refreshAbort = abortController;
      this.groupAvatarRefreshing = true;
      this.statusText = `正在刷新 ${candidates.length} 个小组头像与资料…`;
      const work = this.refreshAvatars('groups', candidates, {
        signal: abortController.signal,
      })
        .then((res) => {
          if (abortController.signal.aborted) {
            this.statusText = '已停止刷新小组头像';
          } else if (res) {
            this.statusText =
              `刷新头像完成（更新 ${res.updated} 个` +
              (res.needsBrowser ? `，${res.needsBrowser} 个需闲置浏览器` : '') +
              (res.failed ? `，${res.failed} 个未完成` : '') +
              '）';
          } else {
            this.statusText = '刷新头像完成';
          }
        })
        .catch(() => {
          if (abortController.signal.aborted) {
            this.statusText = '已停止刷新小组头像';
          }
        })
        .finally(() => {
          if (this.refreshAbort === abortController) {
            this.refreshAbort = null;
            this.groupAvatarRefreshing = false;
          }
        });
      await Promise.race([work, new Promise<void>((r) => setTimeout(r, 20))]);
    }
    return this.state();
  }

  async stopRefreshGroups(): Promise<PosterState> {
    this.assertAllowed();
    this.refreshAbort?.abort(new Error('FACEBOOK_METADATA_BATCH_ABORTED'));
    this.refreshAbort = null;
    this.stopAvatarRefresh?.('groups');
    this.groupAvatarRefreshing = false;
    this.statusText = '已停止刷新小组头像';
    return this.state();
  }

  async saveMaterials(input: unknown): Promise<PosterState> {
    this.assertAllowed();
    const saved = await this.repo.saveMaterials(input);
    void this.preparePendingMaterials(saved).catch(() => {});
    return this.state();
  }

  async deleteMaterials(input: unknown): Promise<PosterState> {
    this.assertAllowed();
    await this.repo.deleteMaterials(input);
    return this.state();
  }

  async toggleMaterials(input: unknown): Promise<PosterState> {
    this.assertAllowed();
    await this.repo.toggleMaterials(input);
    return this.state();
  }

  async prepareMaterialById(id: string): Promise<PosterMaterial | null> {
    const list = await this.repo.materials();
    const item = list.find((m) => m.id === id);
    if (!item) return null;
    await this.ensureMaterialPrepared(item);
    const updated = (await this.repo.materials()).find((m) => m.id === id);
    return updated ?? null;
  }

  private async preparePendingMaterials(materials: readonly PosterMaterial[]): Promise<void> {
    for (const item of materials) {
      const src = item.mediaSource.trim();
      if (!src) continue;
      let isLocal = false;
      try {
        isLocal = mediaReference(src).kind === 'local';
      } catch {
        isLocal = false;
      }
      if (item.cacheStatus !== 'ready' || !item.localFilePath || (isLocal && !item.hasThumbnail)) {
        try {
          await this.ensureMaterialPrepared(item);
        } catch {
          // Isolate per-material preparation failure so remaining materials still prepare
        }
      }
    }
  }

  private async ensureMaterialPrepared(item: PosterMaterial): Promise<PosterMaterial> {
    const src = item.mediaSource.trim();
    if (!src) {
      await this.repo.updateMaterialCache(item.id, {
        localFilePath: null,
        mediaKind: 'none',
        cacheStatus: 'ready',
        cacheError: null,
        thumbnailDataUrl: null,
      });
      return {
        ...item,
        localFilePath: null,
        mediaKind: 'none',
        cacheStatus: 'ready',
        cacheError: null,
        hasThumbnail: false,
      };
    }
    let isLocal = false;
    try {
      isLocal = mediaReference(src).kind === 'local';
    } catch {
      isLocal = false;
    }
    if (item.cacheStatus === 'ready' && item.localFilePath) {
      const exists = this.mediaPreparer.verifyExists
        ? await this.mediaPreparer.verifyExists(item.localFilePath)
        : true;
      if (!exists) {
        if (isLocal) {
          const msg = '本地文件不存在';
          await this.repo.updateMaterialCache(item.id, {
            localFilePath: null,
            mediaKind: item.mediaKind,
            cacheStatus: 'error',
            cacheError: msg,
          });
          throw new ProductError('POSTER_MEDIA_NOT_FOUND', msg, 404);
        }
      } else if (!isLocal || item.hasThumbnail) {
        if (!item.hasThumbnail && this.mediaPreparer.generateThumbnail) {
          const thumb = await this.mediaPreparer
            .generateThumbnail(item.localFilePath, item.mediaKind)
            .catch(() => null);
          if (thumb) {
            await this.repo.saveMaterialThumbnail?.(item.id, thumb);
            return { ...item, hasThumbnail: true };
          }
        }
        return item;
      }
    }
    if (this.preparingMaterials.has(item.id)) {
      while (this.preparingMaterials.has(item.id)) {
        await new Promise<void>((r) => setTimeout(r, 150));
      }
      const after = (await this.repo.materials()).find((m) => m.id === item.id);
      if (after && after.cacheStatus === 'ready' && after.localFilePath) return after;
    }
    this.preparingMaterials.add(item.id);
    try {
      if (!isLocal) {
        await this.repo.updateMaterialCache(item.id, {
          localFilePath: null,
          mediaKind: item.mediaKind === 'none' ? 'video' : item.mediaKind,
          cacheStatus: 'downloading',
          cacheError: null,
        });
      }
      const prepared = await this.mediaPreparer.prepare(src);
      let thumb = prepared.thumbnailDataUrl ?? null;
      if (!thumb && this.mediaPreparer.generateThumbnail) {
        thumb = await this.mediaPreparer
          .generateThumbnail(prepared.localFilePath, prepared.mediaKind)
          .catch(() => null);
      }
      await this.repo.updateMaterialCache(item.id, {
        localFilePath: prepared.localFilePath,
        mediaKind: prepared.mediaKind,
        cacheStatus: 'ready',
        cacheError: null,
        ...(thumb ? { thumbnailDataUrl: thumb } : {}),
      });
      return {
        ...item,
        localFilePath: prepared.localFilePath,
        mediaKind: prepared.mediaKind,
        cacheStatus: 'ready',
        cacheError: null,
        hasThumbnail: Boolean(thumb || item.hasThumbnail),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const friendlyError = isLocal && /ENOENT|no such file/i.test(msg) ? '本地文件不存在' : msg;
      await this.repo.updateMaterialCache(item.id, {
        localFilePath: null,
        mediaKind: item.mediaKind,
        cacheStatus: 'error',
        cacheError: friendlyError,
      });
      throw new ProductError(
        'POSTER_MEDIA_PREPARE_FAILED',
        `素材媒体准备失败: ${friendlyError}`,
        409,
      );
    } finally {
      this.preparingMaterials.delete(item.id);
    }
  }

  async getMaterialThumbnail(
    id: string,
  ): Promise<{ thumbnailDataUrl: string | null; updatedAt: number } | null> {
    if (!this.repo.getMaterialThumbnail) return null;
    const current = await this.repo.getMaterialThumbnail(id);
    if (current?.thumbnailDataUrl) return current;
    if (this.repo.getMaterialMediaPath && this.mediaPreparer.generateThumbnail) {
      const media = await this.repo.getMaterialMediaPath(id);
      if (media?.localFilePath && media.mediaKind !== 'none') {
        const generated = await this.mediaPreparer
          .generateThumbnail(media.localFilePath, media.mediaKind)
          .catch(() => null);
        if (generated) {
          await this.repo.saveMaterialThumbnail?.(id, generated);
          return (
            (await this.repo.getMaterialThumbnail(id)) ?? {
              thumbnailDataUrl: generated,
              updatedAt: Date.now(),
            }
          );
        }
      }
    }
    return current;
  }

  async saveMaterialThumbnail(id: string, thumbnailDataUrl: string): Promise<boolean> {
    this.assertAllowed();
    if (!this.repo.saveMaterialThumbnail) return false;
    return await this.repo.saveMaterialThumbnail(id, thumbnailDataUrl);
  }

  async streamMaterialMedia(
    id: string,
    rangeHeader?: string | undefined,
  ): Promise<PosterMediaStreamChunk | null> {
    if (!this.repo.getMaterialMediaPath || !this.mediaPreparer.readMediaRange) return null;
    const media = await this.repo.getMaterialMediaPath(id);
    if (!media?.localFilePath || media.mediaKind === 'none') return null;
    return await this.mediaPreparer.readMediaRange(
      media.localFilePath,
      media.mediaKind,
      rangeHeader,
    );
  }

  async cleanupExpiredDriveCache(
    nowMs = Date.now(),
  ): Promise<{ expired: number; skipped: number }> {
    if (!this.repo.listExpiredDriveMaterials || !this.repo.markMaterialCacheExpired) {
      return { expired: 0, skipped: 0 };
    }
    const cutoff = nowMs - 3 * 24 * 3600_000;
    const candidates = await this.repo.listExpiredDriveMaterials(cutoff);
    const activeMaterialIds = new Set(this.taskQueue.map((t) => t.material.id));
    let expired = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      if (
        this.hasActiveExecution() ||
        this.preparingMaterials.has(candidate.id) ||
        activeMaterialIds.has(candidate.id)
      ) {
        skipped++;
        continue;
      }
      const removed = this.mediaPreparer.removeCachedDriveFile
        ? await this.mediaPreparer.removeCachedDriveFile(candidate.localFilePath)
        : false;
      if (removed) {
        await this.repo.markMaterialCacheExpired(candidate.id);
        expired++;
      } else {
        skipped++;
      }
    }
    return { expired, skipped };
  }

  async logs(
    search = '',
    before?: number,
    beforeId?: string,
    materialId?: string,
  ): Promise<PosterLog[]> {
    return this.repo.logs(search, 200, before, beforeId, materialId);
  }

  async deleteLogs(input: unknown): Promise<PosterState> {
    this.assertAllowed();
    await this.repo.deleteLogs(input);
    return this.state();
  }

  private isItemEligibleForProfile(item: GroupPosterTaskItem, profileId: string): boolean {
    if (!item.allowedProfileIds) return true;
    return item.allowedProfileIds.has(profileId);
  }

  private hasEligibleQueueItem(profileId: string): boolean {
    return this.taskQueue.some((item) => this.isItemEligibleForProfile(item, profileId));
  }

  private hasEligibleInFlightItem(profileId: string): boolean {
    for (const [ownerId, item] of this.inFlightByWorker.entries()) {
      if (ownerId !== profileId && this.isItemEligibleForProfile(item, profileId)) {
        return true;
      }
    }
    return false;
  }

  private async handleClaimedItemSkipped(profileId: string, wasCancelled = false): Promise<void> {
    const claimed = this.inFlightByWorker.get(profileId);
    if (!claimed) return;
    this.inFlightByWorker.delete(profileId);
    this.activeGroupIds.delete(claimed.group.id);
    this.queuedKeys.delete(`${claimed.group.id}::${claimed.material.id}`);
    if (!wasCancelled && claimed.taskIds) {
      for (const tid of claimed.taskIds) {
        const task = this.runningTasks.get(tid);
        if (task && task.status === 'running') {
          task.skippedCount += 1;
          await this.repo.saveTask?.(task);
        }
      }
    }
  }

  private async settleRunningTasks(): Promise<void> {
    const activeWorkerIds = [
      ...new Set([...this.active, ...this.starting, ...this.workers.keys()]),
    ].filter((pid) => !this.cancelled.has(pid));

    for (const task of [...this.runningTasks.values()]) {
      const queuedForTask = this.taskQueue.filter((item) => item.taskIds?.has(task.id)).length;
      const inFlightForTask = [...this.inFlightByWorker.values()].filter((item) =>
        item.taskIds?.has(task.id),
      ).length;
      const hasEligibleWorker = activeWorkerIds.some(
        (pid) => task.accountMode === 'all_online' || task.profileIds.includes(pid),
      );

      if (
        (queuedForTask === 0 && inFlightForTask === 0) ||
        (inFlightForTask === 0 && !hasEligibleWorker)
      ) {
        if (queuedForTask > 0) {
          const nextQueue: GroupPosterTaskItem[] = [];
          for (const item of this.taskQueue) {
            if (item.taskIds?.has(task.id)) {
              item.taskIds.delete(task.id);
              if (item.taskIds.size === 0) {
                this.queuedKeys.delete(`${item.group.id}::${item.material.id}`);
                continue;
              }
            }
            nextQueue.push(item);
          }
          this.taskQueue = nextQueue;
        }

        if (task.status !== 'cancelled') {
          if (task.postedCount >= task.totalGroups && task.totalGroups > 0) {
            task.status = 'completed';
            task.statusReason = `已完成 · 成功发送 ${task.postedCount} 个小组`;
          } else if (task.postedCount > 0) {
            task.status = 'partial';
            task.statusReason =
              !hasEligibleWorker && queuedForTask > 0
                ? `部分成功 · 已发 ${task.postedCount}/${task.totalGroups} 组（可用账号均受限或已达上限）`
                : `部分成功 · 已发 ${task.postedCount}/${task.totalGroups} 组`;
          } else {
            task.status = 'failed';
            task.statusReason = !hasEligibleWorker
              ? `失败 · 已发 0/${task.totalGroups} 组（账号受限或无可用在线浏览器）`
              : `失败 · 所选小组均未能发布`;
          }
        }
        task.finishedAt = Date.now();
        this.runningTasks.delete(task.id);
        await this.repo.saveTask?.(task);
      }
    }
  }

  private async claimNextTaskForWorker(profileId: string): Promise<GroupPosterTaskItem | null> {
    if (this.inFlightByWorker.has(profileId)) {
      await this.handleClaimedItemSkipped(profileId, this.cancelled.has(profileId));
      await this.settleRunningTasks();
    }
    while (
      !this.hasEligibleQueueItem(profileId) &&
      this.hasEligibleInFlightItem(profileId) &&
      !this.cancelled.has(profileId)
    ) {
      await new Promise<void>((r) => setTimeout(r, 40));
    }
    if (!this.hasEligibleQueueItem(profileId) || this.cancelled.has(profileId)) return null;

    const eligibleIndices: number[] = [];
    const nonBusyEligibleIndices: number[] = [];
    for (let i = 0; i < this.taskQueue.length; i++) {
      const item = this.taskQueue[i];
      if (!item || !this.isItemEligibleForProfile(item, profileId)) continue;
      eligibleIndices.push(i);
      if (!this.activeGroupIds.has(item.group.id)) {
        nonBusyEligibleIndices.push(i);
      }
    }
    const poolIndices =
      nonBusyEligibleIndices.length > 0 ? nonBusyEligibleIndices : eligibleIndices;
    if (poolIndices.length === 0) return null;
    const chosenPoolIdx = poolIndices[Math.floor(Math.random() * poolIndices.length)] ?? 0;
    const [claimed] = this.taskQueue.splice(chosenPoolIdx, 1);
    if (!claimed) return null;

    // Register inFlight synchronously in the same tick as splice so no concurrent worker sees an empty gap
    this.activeGroupIds.add(claimed.group.id);
    this.inFlightByWorker.set(profileId, claimed);

    const postedNow = await this.repo.hasGroupPostedMaterial(claimed.group.id, claimed.material.id);
    if (postedNow) {
      this.inFlightByWorker.delete(profileId);
      this.activeGroupIds.delete(claimed.group.id);
      this.queuedKeys.delete(`${claimed.group.id}::${claimed.material.id}`);
      if (claimed.taskIds) {
        for (const tid of claimed.taskIds) {
          const task = this.runningTasks.get(tid);
          if (task && task.status === 'running') {
            task.postedCount = Math.min(task.totalGroups, task.postedCount + 1);
            await this.repo.saveTask?.(task);
          }
        }
      }
      await this.settleRunningTasks();
      return this.claimNextTaskForWorker(profileId);
    }

    return claimed;
  }

  private spawnWorkers(
    profileIds: readonly string[],
    settings: PosterSettings,
    todayCounts: Record<string, number>,
  ): void {
    const batchRunId = globalThis.crypto.randomUUID();
    for (const pid of profileIds) {
      if (this.isProfileRunning(pid)) continue;
      this.cancelled.delete(pid);
      this.starting.add(pid);
      this.sessionParticipants.add(pid);
      this.profileRunIds.set(pid, batchRunId);
      const prevToday = todayCounts[pid] ?? this.profiles.get(pid)?.today ?? 0;
      this.profiles.set(pid, {
        today: prevToday,
        session: 0,
        status: '排队等待并发槽位…',
        running: true,
        restricted: false,
      });

      const workerPromise = (async () => {
        await Promise.resolve();
        const runId = this.profileRunIds.get(pid) ?? batchRunId;
        let slotAcquired = false;
        const currentClaimedGroups = new Set<string>();
        const releaseClaimedGroups = (extraId?: string) => {
          for (const gid of currentClaimedGroups) {
            this.activeGroupIds.delete(gid);
          }
          currentClaimedGroups.clear();
          if (extraId) {
            this.activeGroupIds.delete(extraId);
          }
        };
        try {
          while (
            this.slotsInUse >= settings.maxConcurrentProfiles &&
            !this.cancelled.has(pid) &&
            (this.hasEligibleQueueItem(pid) || this.hasEligibleInFlightItem(pid))
          ) {
            await new Promise<void>((r) => setTimeout(r, 100));
          }
          this.starting.delete(pid);
          if (
            this.cancelled.has(pid) ||
            (!this.hasEligibleQueueItem(pid) && !this.hasEligibleInFlightItem(pid))
          ) {
            const cur = this.profiles.get(pid);
            this.profiles.set(pid, {
              today: cur?.today ?? 0,
              session: cur?.session ?? 0,
              status: this.cancelled.has(pid) ? '已停止' : '队列已完成',
              running: false,
            });
            return;
          }
          this.slotsInUse++;
          slotAcquired = true;
          this.active.add(pid);
          while (
            !this.cancelled.has(pid) &&
            (this.profiles.get(pid)?.session ?? 0) < settings.maxPostsPerAccount &&
            (this.hasEligibleQueueItem(pid) || this.hasEligibleInFlightItem(pid))
          ) {
            const files = [...this.sharedFiles];
            await this.runner.runProfileWorker(pid, files, settings, {
              runId,
              cancelled: () => this.cancelled.has(pid),
              status: (text) => {
                const cur = this.profiles.get(pid);
                this.profiles.set(pid, {
                  today: cur?.today ?? 0,
                  session: cur?.session ?? 0,
                  status: text,
                  running: true,
                  restricted: cur?.restricted,
                });
                this.statusText = text;
              },
              claimNextTask: async () => {
                releaseClaimedGroups();
                const next = await this.claimNextTaskForWorker(pid);
                if (next) {
                  currentClaimedGroups.add(next.group.id);
                }
                return next;
              },
              onGroupIdResolved: async (rawGroupId, canonicalGroupId) => {
                if (!rawGroupId || !canonicalGroupId || rawGroupId === canonicalGroupId) return;
                currentClaimedGroups.add(canonicalGroupId);
                this.activeGroupIds.add(canonicalGroupId);
                const inFlight = this.inFlightByWorker.get(pid);
                if (inFlight && inFlight.group.id === rawGroupId) {
                  this.queuedKeys.delete(`${rawGroupId}::${inFlight.material.id}`);
                  this.queuedKeys.add(`${canonicalGroupId}::${inFlight.material.id}`);
                  inFlight.group = { ...inFlight.group, id: canonicalGroupId };
                }
                const nextQueue: GroupPosterTaskItem[] = [];
                for (const item of this.taskQueue) {
                  if (item.group.id !== rawGroupId) {
                    nextQueue.push(item);
                    continue;
                  }
                  this.queuedKeys.delete(`${rawGroupId}::${item.material.id}`);
                  const pairKey = `${canonicalGroupId}::${item.material.id}`;
                  if (this.queuedKeys.has(pairKey)) {
                    const existing =
                      nextQueue.find(
                        (q) =>
                          q.group.id === canonicalGroupId && q.material.id === item.material.id,
                      ) ??
                      this.taskQueue.find(
                        (q) =>
                          q.group.id === canonicalGroupId && q.material.id === item.material.id,
                      ) ??
                      [...this.inFlightByWorker.values()].find(
                        (q) =>
                          q.group.id === canonicalGroupId && q.material.id === item.material.id,
                      );
                    if (existing && item.taskIds) {
                      if (!existing.taskIds) existing.taskIds = new Set();
                      for (const tid of item.taskIds) {
                        if (existing.taskIds.has(tid)) {
                          const t = this.runningTasks.get(tid);
                          if (t && t.totalGroups > 0) {
                            t.totalGroups = Math.max(1, t.totalGroups - 1);
                            t.skippedCount += 1;
                            await this.repo.saveTask?.(t);
                          }
                        } else {
                          existing.taskIds.add(tid);
                        }
                      }
                    }
                    continue;
                  }
                  const alreadyPosted = await this.repo.hasGroupPostedMaterial(
                    canonicalGroupId,
                    item.material.id,
                  );
                  if (!alreadyPosted) {
                    this.queuedKeys.add(pairKey);
                    nextQueue.push({
                      ...item,
                      group: { ...item.group, id: canonicalGroupId },
                    });
                  } else if (item.taskIds) {
                    for (const tid of item.taskIds) {
                      const t = this.runningTasks.get(tid);
                      if (t && t.status === 'running') {
                        t.totalGroups = Math.max(0, t.totalGroups - 1);
                        t.skippedCount += 1;
                        await this.repo.saveTask?.(t);
                      }
                    }
                  }
                }
                this.taskQueue = nextQueue;
              },
              returnTaskOnRestriction: (task) => {
                this.inFlightByWorker.delete(pid);
                releaseClaimedGroups(task.group.id);
                this.taskQueue.push(task);
              },
              onTaskPosted: async (log) => {
                const claimed = this.inFlightByWorker.get(pid);
                this.inFlightByWorker.delete(pid);
                releaseClaimedGroups(log.groupId);
                this.queuedKeys.delete(`${log.groupId}::${log.materialId}`);
                if (claimed && claimed.group.id !== log.groupId) {
                  this.queuedKeys.delete(`${claimed.group.id}::${log.materialId}`);
                }
                await this.repo.recordPost(log);
                if (claimed?.taskIds) {
                  for (const tid of claimed.taskIds) {
                    const t = this.runningTasks.get(tid);
                    if (t && t.status === 'running') {
                      t.postedCount += 1;
                      t.statusReason = `正在发送 (${t.postedCount}/${t.totalGroups})`;
                      await this.repo.saveTask?.(t);
                    }
                  }
                }
                const cur = this.profiles.get(pid);
                const nextToday = (cur?.today ?? 0) + 1;
                const nextSession = (cur?.session ?? 0) + 1;
                this.profiles.set(pid, {
                  today: nextToday,
                  session: nextSession,
                  status: `已发帖 · ${log.groupName}`,
                  running: true,
                  restricted: false,
                });
                await this.settleRunningTasks();
              },
              canContinueAccount: async (workerPid) => {
                const cur = this.profiles.get(workerPid);
                return (cur?.session ?? 0) < settings.maxPostsPerAccount;
              },
            });
          }

          const finalStat = this.profiles.get(pid);
          const wasCancelled = this.cancelled.has(pid);
          const finalStatus = wasCancelled
            ? '已手动停止'
            : (finalStat?.session ?? 0) >= settings.maxPostsPerAccount
              ? `已达本轮上限 (${finalStat?.session ?? 0}/${settings.maxPostsPerAccount})`
              : `已完成 · 本轮发帖 ${finalStat?.session ?? 0} 条`;
          this.profiles.set(pid, {
            today: finalStat?.today ?? 0,
            session: finalStat?.session ?? 0,
            status: finalStatus,
            running: false,
            restricted: false,
          });
          await this.repo.saveProfileResult?.({
            profileId: pid,
            source: 'group-poster',
            runId,
            name: '小组发帖',
            state: wasCancelled ? 'STOPPED' : 'COMPLETED',
            reason: finalStatus,
            finishedAt: Date.now(),
            failedSteps: 0,
            skippedSteps: 0,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isRestricted = err instanceof PosterAccountRestrictedError;
          const cur = this.profiles.get(pid);
          if (isRestricted) {
            const restrictReason = err.message || '受限 · 需要手机验证或操作受限';
            this.profiles.set(pid, {
              today: cur?.today ?? 0,
              session: cur?.session ?? 0,
              status: restrictReason,
              running: false,
              restricted: true,
            });
            await this.repo.saveProfileResult?.({
              profileId: pid,
              source: 'group-poster',
              runId,
              name: '小组发帖',
              state: 'FAILED',
              reason: restrictReason,
              finishedAt: Date.now(),
              failedSteps: 1,
              skippedSteps: 0,
            });
          } else {
            const failReason = `发帖中断 · ${msg.slice(0, 80)}`;
            this.profiles.set(pid, {
              today: cur?.today ?? 0,
              session: cur?.session ?? 0,
              status: failReason,
              running: false,
              restricted: false,
            });
            await this.repo.saveProfileResult?.({
              profileId: pid,
              source: 'group-poster',
              runId,
              name: '小组发帖',
              state: 'FAILED',
              reason: failReason,
              finishedAt: Date.now(),
              failedSteps: 1,
              skippedSteps: 0,
            });
          }
        } finally {
          if (this.inFlightByWorker.has(pid)) {
            await this.handleClaimedItemSkipped(pid, this.cancelled.has(pid));
          }
          this.starting.delete(pid);
          releaseClaimedGroups();
          this.active.delete(pid);
          if (slotAcquired) {
            this.slotsInUse = Math.max(0, this.slotsInUse - 1);
          }
          this.workers.delete(pid);
          await this.settleRunningTasks();
          if (!this.hasActiveExecution()) {
            this.queuedKeys.clear();
            this.sharedFiles.clear();
            const participants = [...this.sessionParticipants];
            this.sessionParticipants.clear();
            const allRestricted =
              participants.length > 0 &&
              participants.every((id) => this.profiles.get(id)?.restricted === true);
            this.statusText = allRestricted
              ? '全部所选浏览器均受限，已停止小组发帖'
              : this.taskQueue.length === 0
                ? '小组发帖队列已全部完成'
                : '本轮小组发帖已结束';
          }
        }
      })();
      this.workers.set(pid, workerPromise);
    }
  }

  async createTask(input: unknown): Promise<PosterState> {
    this.assertAllowed();
    const parsed = CreatePosterTaskInput.parse(input);
    const [allGroups, allMaterials] = await Promise.all([
      this.repo.targets(),
      this.repo.materials(),
    ]);
    const groupById = new Map(allGroups.map((g) => [g.id, g]));
    const material = allMaterials.find((m) => m.id === parsed.materialId);
    if (!material) {
      throw new ProductError('POSTER_MATERIAL_NOT_FOUND', '未找到所选贴文素材', 404);
    }
    const validGroups = [...new Set(parsed.groupIds)]
      .map((id) => groupById.get(id))
      .filter((g): g is BumperTarget => g !== undefined);
    if (validGroups.length === 0) {
      throw new ProductError('POSTER_GROUPS_EMPTY', '请至少选择 1 个有效目标小组', 400);
    }

    const unpostedGroups: BumperTarget[] = [];
    for (const g of validGroups) {
      const posted = await this.repo.hasGroupPostedMaterial(g.id, material.id);
      if (!posted) {
        unpostedGroups.push(g);
      }
    }
    if (unpostedGroups.length === 0) {
      this.statusText = '所选小组已全部发过该贴文，已自动跳过重复小组';
      return this.state();
    }

    const now = Date.now();
    const scheduledAtMs = parsed.scheduledAt;
    const isFutureSchedule = scheduledAtMs !== null && scheduledAtMs > now;
    const task: PosterTask = {
      id: globalThis.crypto.randomUUID(),
      materialId: material.id,
      captionPreview: (material.caption.trim() || material.mediaSource.trim()).slice(0, 120),
      groupIds: unpostedGroups.map((g) => g.id),
      accountMode: parsed.accountMode,
      profileIds: [...new Set(parsed.profileIds)],
      scheduledAt: scheduledAtMs,
      status: isFutureSchedule ? 'scheduled' : 'running',
      totalGroups: unpostedGroups.length,
      postedCount: 0,
      skippedCount: Math.max(0, validGroups.length - unpostedGroups.length),
      statusReason: isFutureSchedule
        ? `定时待启动 · ${new Date(scheduledAtMs).toLocaleString()}`
        : `正在准备发送 (0/${unpostedGroups.length})`,
      createdAt: now,
      startedAt: isFutureSchedule ? null : now,
      finishedAt: null,
    };

    if (isFutureSchedule) {
      await this.repo.saveTask?.(task);
      this.ensureScheduleTimer();
      this.statusText = `已创建定时发帖任务 · 定于 ${new Date(scheduledAtMs).toLocaleString()} 启动`;
      return this.state();
    }

    await this.dispatchTask(task, false);
    return this.state();
  }

  private async dispatchTask(task: PosterTask, isScheduledTrigger: boolean): Promise<void> {
    const [allGroups, allMaterials, settings, todayCounts] = await Promise.all([
      this.repo.targets(),
      this.repo.materials(),
      this.repo.settings(),
      this.repo.todayCounts(),
    ]);
    const material = allMaterials.find((m) => m.id === task.materialId);
    if (!material) {
      task.status = 'failed';
      task.statusReason = '失败 · 贴文素材已被删除';
      task.finishedAt = Date.now();
      await this.repo.saveTask?.(task);
      if (!isScheduledTrigger) {
        throw new ProductError('POSTER_MATERIAL_NOT_FOUND', task.statusReason, 404);
      }
      this.statusText = task.statusReason;
      return;
    }

    let preparedMaterial: PosterMaterial;
    try {
      this.statusText = '正在检查并缓存发帖视频/图片素材…';
      preparedMaterial = await this.ensureMaterialPrepared(material);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      task.status = 'failed';
      task.statusReason = `失败 · ${msg}`;
      task.finishedAt = Date.now();
      await this.repo.saveTask?.(task);
      if (!isScheduledTrigger) throw err;
      this.statusText = task.statusReason;
      return;
    }

    const groupById = new Map(allGroups.map((g) => [g.id, g]));
    if (this.groupAvatarRefreshing) {
      await this.stopRefreshGroups().catch(() => {});
      const waitDeadline = Date.now() + 2500;
      while (Date.now() < waitDeadline) {
        const probeIds =
          task.accountMode === 'all_online'
            ? [...new Set((await this.runner.onlineProfileIds?.()) ?? task.profileIds)]
            : [...new Set(task.profileIds)];
        if (probeIds.length === 0) break;
        const readyFlags = await Promise.all(probeIds.map((id) => this.runner.ready(id)));
        if (readyFlags.some(Boolean)) break;
        await new Promise<void>((r) => setTimeout(r, 150));
      }
    }
    const requestedProfileIds =
      task.accountMode === 'all_online'
        ? [...new Set((await this.runner.onlineProfileIds?.()) ?? task.profileIds)]
        : [...new Set(task.profileIds)];

    const launchFailureReasons = new Map<string, string>();
    if (
      task.accountMode === 'selected' &&
      requestedProfileIds.length > 0 &&
      this.profileLifecycle
    ) {
      const offlineCandidates: string[] = [];
      for (const id of requestedProfileIds) {
        if (this.isProfileRunning(id)) continue;
        if (await this.runner.ready(id)) continue;
        const busyElsewhere =
          (this.registry ? await this.registry.isProfileBusy(id, 'group-poster') : false) ||
          (await this.runner.busy(id));
        if (!busyElsewhere) offlineCandidates.push(id);
      }
      if (offlineCandidates.length > 0) {
        this.statusText = `正在自动启动 ${offlineCandidates.length} 个离线浏览器并等待插件连接…`;
        task.statusReason = `正在唤醒 ${offlineCandidates.length} 个离线浏览器…`;
        await this.repo.saveTask?.(task);
        const launchRes = await this.profileLifecycle.ensureProfilesOnline(offlineCandidates);
        for (const f of launchRes.failed) {
          launchFailureReasons.set(f.profileId, `跳过：${f.reason}`);
        }
      }
    }

    const admitted =
      requestedProfileIds.length > 0
        ? await admitProfilesForStart({
            requestedProfileIds,
            currentModuleId: 'group-poster',
            isAlreadyRunningInCurrentModule: (id) => this.isProfileRunning(id),
            busyModuleLabelsForProfile: async (id) =>
              this.registry ? await this.registry.busyModuleLabels([id], 'group-poster') : [],
            isProfileBusyInOtherModule: (id) => this.runner.busy(id),
            isProfileReady: (id) => this.runner.ready(id),
          })
        : {
            admittedProfileIds: [],
            alreadyRunningIds: [],
            skippedBusy: [],
            skippedOffline: [],
          };

    for (const item of admitted.skippedBusy) {
      const prev = this.profiles.get(item.profileId);
      this.profiles.set(item.profileId, {
        today: todayCounts[item.profileId] ?? prev?.today ?? 0,
        session: prev?.session ?? 0,
        status: item.reason,
        running: false,
      });
    }
    for (const item of admitted.skippedOffline) {
      const prev = this.profiles.get(item.profileId);
      this.profiles.set(item.profileId, {
        today: todayCounts[item.profileId] ?? prev?.today ?? 0,
        session: prev?.session ?? 0,
        status: launchFailureReasons.get(item.profileId) ?? item.reason,
        running: false,
      });
    }

    const usableWorkerIds = [
      ...new Set([...admitted.admittedProfileIds, ...admitted.alreadyRunningIds]),
    ];
    if (usableWorkerIds.length === 0) {
      const firstLaunchFail = [...launchFailureReasons.values()][0];
      const failReason =
        admitted.skippedBusy.length > 0 && admitted.skippedOffline.length === 0
          ? (admitted.skippedBusy[0]?.reason ?? '所选浏览器正忙')
          : firstLaunchFail
            ? `失败 · ${firstLaunchFail.replace(/^跳过：\s*/, '')}`
            : '失败 · 当前没有在线或可用的浏览器';
      task.status = 'failed';
      task.statusReason = failReason;
      task.startedAt = task.startedAt ?? Date.now();
      task.finishedAt = Date.now();
      await this.repo.saveTask?.(task);
      this.statusText = failReason;
      if (!isScheduledTrigger) {
        if (admitted.skippedBusy.length > 0 && admitted.skippedOffline.length === 0) {
          throw new ProductError('POSTER_PROFILES_BUSY', failReason, 409);
        }
        throw new ProductError('POSTER_NO_READY_PROFILE', '所选浏览器不在线或正忙', 409);
      }
      return;
    }

    const wasRunning = this.hasActiveExecution();
    if (!wasRunning) {
      this.taskQueue = [];
      this.activeGroupIds.clear();
      this.queuedKeys.clear();
      this.sessionParticipants.clear();
      this.sharedFiles.clear();
    }
    if (preparedMaterial.localFilePath) {
      this.sharedFiles.add(preparedMaterial.localFilePath);
    }

    // Reset session counter for already-running workers that are joining this new task so they aren't blocked by previous task's session count
    for (const pid of admitted.alreadyRunningIds) {
      const cur = this.profiles.get(pid);
      if (cur) {
        this.profiles.set(pid, { ...cur, session: 0 });
      }
    }

    let effectiveTotalGroups = 0;
    const allowedSet = task.accountMode === 'all_online' ? null : new Set(usableWorkerIds);
    for (const gid of [...new Set(task.groupIds)]) {
      const group = groupById.get(gid);
      if (!group) continue;
      const alreadyPosted = await this.repo.hasGroupPostedMaterial(group.id, preparedMaterial.id);
      if (alreadyPosted) {
        task.skippedCount += 1;
        continue;
      }

      const pairKey = `${group.id}::${preparedMaterial.id}`;
      if (this.queuedKeys.has(pairKey)) {
        const existingInQueue = this.taskQueue.find(
          (item) => item.group.id === group.id && item.material.id === preparedMaterial.id,
        );
        const existingInFlight = [...this.inFlightByWorker.values()].find(
          (item) => item.group.id === group.id && item.material.id === preparedMaterial.id,
        );
        const existing = existingInQueue ?? existingInFlight;
        if (existing) {
          if (!existing.taskIds) existing.taskIds = new Set();
          existing.taskIds.add(task.id);
          if (allowedSet === null || existing.allowedProfileIds === null) {
            existing.allowedProfileIds = null;
          } else if (existing.allowedProfileIds) {
            for (const pid of allowedSet) existing.allowedProfileIds.add(pid);
          }
          effectiveTotalGroups++;
        }
        continue;
      }

      this.queuedKeys.add(pairKey);
      this.taskQueue.push({
        group,
        material: preparedMaterial,
        taskIds: new Set([task.id]),
        allowedProfileIds: allowedSet ? new Set(allowedSet) : null,
      });
      effectiveTotalGroups++;
    }

    if (effectiveTotalGroups === 0) {
      task.status = 'completed';
      task.totalGroups = 0;
      task.statusReason = '已完成 · 所选小组均已发过该贴文，已自动跳过';
      task.startedAt = Date.now();
      task.finishedAt = Date.now();
      await this.repo.saveTask?.(task);
      this.statusText = task.statusReason;
      return;
    }

    task.status = 'running';
    task.totalGroups = effectiveTotalGroups;
    task.startedAt = Date.now();
    task.statusReason = `正在发送 (0/${effectiveTotalGroups})`;
    this.runningTasks.set(task.id, task);
    await this.repo.saveTask?.(task);

    this.statusText = `正在发帖 · 待发队列 ${this.taskQueue.length} 条`;
    this.spawnWorkers(admitted.admittedProfileIds, settings, todayCounts);
  }

  async tickScheduledTasks(now = Date.now()): Promise<void> {
    if (this.tickingSchedule) return;
    this.tickingSchedule = true;
    try {
      const allTasks = (await this.repo.listTasks?.(100)) ?? [];
      const dueTasks = allTasks
        .filter((t) => t.status === 'scheduled' && t.scheduledAt !== null && t.scheduledAt <= now)
        .sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0) || a.createdAt - b.createdAt);

      for (const due of dueTasks) {
        await this.dispatchTask(due, true);
      }

      // If any running task uses 'all_online' and there are unclaimed items, admit newly-online browsers dynamically
      const hasAllOnlineRunning = [...this.runningTasks.values()].some(
        (t) => t.status === 'running' && t.accountMode === 'all_online',
      );
      if (
        hasAllOnlineRunning &&
        this.taskQueue.some((item) => !item.allowedProfileIds) &&
        this.runner.onlineProfileIds
      ) {
        const onlineIds = await this.runner.onlineProfileIds();
        const newCandidates = onlineIds.filter((id) => !this.isProfileRunning(id));
        if (newCandidates.length > 0) {
          const admitted = await admitProfilesForStart({
            requestedProfileIds: newCandidates,
            currentModuleId: 'group-poster',
            isAlreadyRunningInCurrentModule: (id) => this.isProfileRunning(id),
            busyModuleLabelsForProfile: async (id) =>
              this.registry ? await this.registry.busyModuleLabels([id], 'group-poster') : [],
            isProfileBusyInOtherModule: (id) => this.runner.busy(id),
            isProfileReady: (id) => this.runner.ready(id),
          });
          if (admitted.admittedProfileIds.length > 0) {
            const [settings, todayCounts] = await Promise.all([
              this.repo.settings(),
              this.repo.todayCounts(),
            ]);
            this.spawnWorkers(admitted.admittedProfileIds, settings, todayCounts);
          }
        }
      }
    } finally {
      this.tickingSchedule = false;
    }
  }

  async cancelTask(input: unknown): Promise<PosterState> {
    this.assertAllowed();
    const { id } = PosterTaskIdInput.parse(input);
    const running = this.runningTasks.get(id);
    if (running) {
      running.status = 'cancelled';
      running.statusReason =
        running.postedCount > 0
          ? `已手动停止 · 已发 ${running.postedCount}/${running.totalGroups} 组`
          : '已手动停止';
      running.finishedAt = Date.now();
      this.runningTasks.delete(id);
      await this.repo.saveTask?.(running);

      const nextQueue: GroupPosterTaskItem[] = [];
      for (const item of this.taskQueue) {
        if (item.taskIds?.has(id)) {
          item.taskIds.delete(id);
          if (item.taskIds.size === 0) {
            this.queuedKeys.delete(`${item.group.id}::${item.material.id}`);
            continue;
          }
        }
        nextQueue.push(item);
      }
      this.taskQueue = nextQueue;

      const orphanedWorkersToStop: string[] = [];
      for (const [pid, item] of this.inFlightByWorker.entries()) {
        if (item.taskIds?.has(id)) {
          item.taskIds.delete(id);
          if (item.taskIds.size === 0) {
            this.inFlightByWorker.delete(pid);
            this.activeGroupIds.delete(item.group.id);
            this.queuedKeys.delete(`${item.group.id}::${item.material.id}`);
            if (!this.hasEligibleQueueItem(pid)) {
              orphanedWorkersToStop.push(pid);
            }
          }
        }
      }

      if (this.runningTasks.size === 0 && this.taskQueue.length === 0) {
        const ids = [...new Set([...this.active, ...this.starting, ...this.workers.keys()])];
        await this.stopProfiles(ids);
      } else if (orphanedWorkersToStop.length > 0) {
        await this.stopProfiles(orphanedWorkersToStop);
      }
      this.statusText = running.statusReason;
      return this.state();
    }

    const persisted = ((await this.repo.listTasks?.(200)) ?? []).find((t) => t.id === id);
    if (persisted && persisted.status === 'scheduled') {
      persisted.status = 'cancelled';
      persisted.statusReason = '已取消定时发帖';
      persisted.finishedAt = Date.now();
      await this.repo.saveTask?.(persisted);
      this.statusText = '已取消定时发帖任务';
    }
    return this.state();
  }

  async deleteTask(input: unknown): Promise<PosterState> {
    this.assertAllowed();
    const { id } = PosterTaskIdInput.parse(input);
    if (this.runningTasks.has(id)) {
      await this.cancelTask({ id });
    }
    await this.repo.deleteTask?.(id);
    return this.state();
  }

  async start(input: unknown): Promise<PosterState> {
    this.assertAllowed();
    const parsed = StartPosterInput.parse(input);
    const todayCounts = await this.repo.todayCounts();
    const launchFailureReasons = new Map<string, string>();
    if (this.profileLifecycle && parsed.profileIds.length > 0) {
      const offlineCandidates: string[] = [];
      for (const id of [...new Set(parsed.profileIds)]) {
        if (this.isProfileRunning(id)) continue;
        if (await this.runner.ready(id)) continue;
        const busyElsewhere =
          (this.registry ? await this.registry.isProfileBusy(id, 'group-poster') : false) ||
          (await this.runner.busy(id));
        if (!busyElsewhere) offlineCandidates.push(id);
      }
      if (offlineCandidates.length > 0) {
        this.statusText = `正在自动启动 ${offlineCandidates.length} 个离线浏览器并等待插件连接…`;
        const launchRes = await this.profileLifecycle.ensureProfilesOnline(offlineCandidates);
        for (const f of launchRes.failed) {
          launchFailureReasons.set(f.profileId, `跳过：${f.reason}`);
        }
      }
    }
    const admitted = await admitProfilesForStart({
      requestedProfileIds: parsed.profileIds,
      currentModuleId: 'group-poster',
      isAlreadyRunningInCurrentModule: (id) => this.isProfileRunning(id),
      busyModuleLabelsForProfile: async (id) =>
        this.registry ? await this.registry.busyModuleLabels([id], 'group-poster') : [],
      isProfileBusyInOtherModule: (id) => this.runner.busy(id),
      isProfileReady: (id) => this.runner.ready(id),
    });

    for (const item of admitted.skippedBusy) {
      const prev = this.profiles.get(item.profileId);
      this.profiles.set(item.profileId, {
        today: todayCounts[item.profileId] ?? prev?.today ?? 0,
        session: prev?.session ?? 0,
        status: item.reason,
        running: false,
      });
    }
    for (const item of admitted.skippedOffline) {
      const prev = this.profiles.get(item.profileId);
      this.profiles.set(item.profileId, {
        today: todayCounts[item.profileId] ?? prev?.today ?? 0,
        session: prev?.session ?? 0,
        status: launchFailureReasons.get(item.profileId) ?? item.reason,
        running: false,
      });
    }

    const onlineProfiles = admitted.admittedProfileIds;
    if (onlineProfiles.length === 0) {
      if (
        admitted.alreadyRunningIds.length > 0 &&
        admitted.skippedBusy.length === 0 &&
        admitted.skippedOffline.length === 0
      ) {
        throw new ProductError('POSTER_PROFILES_EMPTY', '所选浏览器已在发帖运行中', 409);
      }
      if (admitted.skippedBusy.length > 0 && admitted.skippedOffline.length === 0) {
        throw new ProductError(
          'POSTER_PROFILES_BUSY',
          admitted.skippedBusy[0]?.reason ?? '所选浏览器正忙',
          409,
        );
      }
      throw new ProductError('POSTER_NO_READY_PROFILE', '所选浏览器不在线或正忙', 409);
    }

    const [allGroups, allMaterials, settings] = await Promise.all([
      this.repo.targets(),
      this.repo.materials(),
      this.repo.settings(),
    ]);
    const groupById = new Map(allGroups.map((g) => [g.id, g]));
    const materialById = new Map(allMaterials.map((m) => [m.id, m]));
    const selectedGroups = [...new Set(parsed.groupIds)]
      .map((id) => groupById.get(id))
      .filter((g): g is BumperTarget => g !== undefined);
    const rawMaterials = [...new Set(parsed.materialIds)]
      .map((id) => materialById.get(id))
      .filter((m): m is PosterMaterial => m !== undefined);
    if (selectedGroups.length === 0) {
      throw new ProductError('POSTER_GROUPS_EMPTY', '请至少勾选 1 个目标小组', 400);
    }
    if (rawMaterials.length === 0) {
      throw new ProductError('POSTER_MATERIALS_EMPTY', '请至少勾选 1 条发帖素材', 400);
    }

    this.statusText = '正在检查并缓存发帖视频/图片素材…';
    const readyMaterials: PosterMaterial[] = [];
    for (const mat of rawMaterials) {
      const prepared = await this.ensureMaterialPrepared(mat);
      readyMaterials.push(prepared);
    }

    const wasRunning = this.hasActiveExecution();
    if (!wasRunning) {
      this.taskQueue = [];
      this.activeGroupIds.clear();
      this.queuedKeys.clear();
      this.sessionParticipants.clear();
      this.sharedFiles.clear();
    }
    for (const mat of readyMaterials) {
      if (mat.localFilePath) this.sharedFiles.add(mat.localFilePath);
    }

    for (const group of selectedGroups) {
      let addedForGroup = 0;
      for (const material of readyMaterials) {
        if (addedForGroup >= settings.materialsPerGroup) break;
        const pairKey = `${group.id}::${material.id}`;
        if (this.queuedKeys.has(pairKey)) {
          addedForGroup++;
          continue;
        }
        const alreadyPosted = await this.repo.hasGroupPostedMaterial(group.id, material.id);
        if (!alreadyPosted) {
          this.queuedKeys.add(pairKey);
          this.taskQueue.push({ group, material });
          addedForGroup++;
        }
      }
    }

    if (this.taskQueue.length === 0 && !wasRunning) {
      this.sessionParticipants.clear();
      this.statusText = '所选小组已全部发过所选素材，无需重复发送';
      return this.state();
    }

    this.statusText = `正在发帖 · 待发队列 ${this.taskQueue.length} 条`;
    this.spawnWorkers(onlineProfiles, settings, todayCounts);
    return this.state();
  }

  async stop(): Promise<PosterState> {
    this.taskQueue = [];
    this.inFlightByWorker.clear();
    this.activeGroupIds.clear();
    this.queuedKeys.clear();
    this.sessionParticipants.clear();
    this.sharedFiles.clear();
    for (const [id, task] of this.runningTasks.entries()) {
      task.status = 'cancelled';
      task.statusReason =
        task.postedCount > 0
          ? `已手动停止 · 已发 ${task.postedCount}/${task.totalGroups} 组`
          : '已手动停止';
      task.finishedAt = Date.now();
      this.runningTasks.delete(id);
      await this.repo.saveTask?.(task);
    }
    const ids = [...new Set([...this.active, ...this.starting, ...this.workers.keys()])];
    await this.stopProfiles(ids);
    this.statusText = '已停止全部发帖任务';
    return this.state();
  }

  async stopProfiles(profileIds: readonly string[]): Promise<void> {
    for (const id of profileIds) {
      this.cancelled.add(id);
      this.starting.delete(id);
    }
    await Promise.allSettled(profileIds.map((id) => this.runner.stop(id)));
    const waitList = profileIds
      .map((id) => this.workers.get(id))
      .filter((p): p is Promise<void> => p !== undefined);
    if (waitList.length > 0) {
      await Promise.race([
        Promise.allSettled(waitList),
        new Promise<void>((r) => setTimeout(r, 3000)),
      ]);
    }
  }
}
