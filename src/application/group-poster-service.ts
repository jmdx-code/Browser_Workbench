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
  StartPosterInput,
  type PosterCacheStatus,
  type PosterLog,
  type PosterMaterial,
  type PosterMediaKind,
  type PosterPendingOperation,
  type PosterProfileStat,
  type PosterSettings,
  type PosterState,
} from '../shared/group-poster.js';
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
  recordPost(input: PosterLog): boolean;
  logs(search?: string, limit?: number, before?: number, beforeId?: string): PosterLog[];
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
  private readonly activeGroupIds = new Set<string>();
  private readonly queuedKeys = new Set<string>();
  private readonly sessionParticipants = new Set<string>();
  private statusText = '请选择账号、目标小组和发帖素材';
  private slotsInUse = 0;
  private groupAvatarRefreshing = false;
  private refreshAbort: AbortController | null = null;

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
  }

  isProfileRunning(id: string): boolean {
    return this.active.has(id) || this.starting.has(id) || this.workers.has(id);
  }

  hasActiveExecution(): boolean {
    return this.active.size > 0 || this.starting.size > 0 || this.workers.size > 0;
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
    };
  }

  async saveSettings(input: unknown): Promise<PosterState> {
    this.assertAllowed();
    await this.repo.saveSettings(input);
    return this.state();
  }

  async addGroups(input: unknown): Promise<PosterState> {
    this.assertAllowed();
    const groups = await this.repo.upsertTargets(input);
    if (!this.hasActiveExecution() && this.refreshAvatars) {
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

  async logs(search = '', before?: number, beforeId?: string): Promise<PosterLog[]> {
    return this.repo.logs(search, 200, before, beforeId);
  }

  async deleteLogs(input: unknown): Promise<PosterState> {
    this.assertAllowed();
    await this.repo.deleteLogs(input);
    return this.state();
  }

  async start(input: unknown): Promise<PosterState> {
    this.assertAllowed();
    const parsed = StartPosterInput.parse(input);
    const todayCounts = await this.repo.todayCounts();
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
        status: item.reason,
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
    }
    for (const pid of onlineProfiles) {
      this.sessionParticipants.add(pid);
    }

    // Build deduplicated (group × material) queue on instance-level shared queue
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

    const files = [
      ...new Set(
        [...readyMaterials, ...this.taskQueue.map((t) => t.material)]
          .map((m) => m.localFilePath)
          .filter((p): p is string => typeof p === 'string' && p.length > 0),
      ),
    ];

    const claimNextTask = async (profileId: string): Promise<GroupPosterTaskItem | null> => {
      while (
        this.taskQueue.length === 0 &&
        this.activeGroupIds.size > 0 &&
        !this.cancelled.has(profileId)
      ) {
        await new Promise<void>((r) => setTimeout(r, 40));
      }
      if (this.taskQueue.length === 0 || this.cancelled.has(profileId)) return null;
      // Prefer a group not currently being posted to by another worker
      const nonBusyIndices: number[] = [];
      for (let i = 0; i < this.taskQueue.length; i++) {
        const item = this.taskQueue[i];
        if (item && !this.activeGroupIds.has(item.group.id)) {
          nonBusyIndices.push(i);
        }
      }
      const poolIndices =
        nonBusyIndices.length > 0 ? nonBusyIndices : this.taskQueue.map((_, idx) => idx);
      const chosenPoolIdx = poolIndices[Math.floor(Math.random() * poolIndices.length)] ?? 0;
      const [claimed] = this.taskQueue.splice(chosenPoolIdx, 1);
      if (!claimed) return null;
      this.activeGroupIds.add(claimed.group.id);
      const postedNow = await this.repo.hasGroupPostedMaterial(
        claimed.group.id,
        claimed.material.id,
      );
      if (postedNow) {
        this.activeGroupIds.delete(claimed.group.id);
        return claimNextTask(profileId);
      }
      return claimed;
    };

    const batchRunId = globalThis.crypto.randomUUID();
    for (const pid of onlineProfiles) {
      this.cancelled.delete(pid);
      this.starting.add(pid);
      this.profileRunIds.set(pid, batchRunId);
      const prevToday = todayCounts[pid] ?? 0;
      this.profiles.set(pid, {
        today: prevToday,
        session: 0,
        status: '排队等待并发槽位…',
        running: true,
        restricted: false,
      });
    }

    this.statusText = `正在发帖 · 待发队列 ${this.taskQueue.length} 条`;

    for (const profileId of onlineProfiles) {
      const workerPromise = (async () => {
        await Promise.resolve();
        const runId = this.profileRunIds.get(profileId) ?? batchRunId;
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
            !this.cancelled.has(profileId) &&
            (this.taskQueue.length > 0 || this.activeGroupIds.size > 0)
          ) {
            await new Promise<void>((r) => setTimeout(r, 100));
          }
          this.starting.delete(profileId);
          if (
            this.cancelled.has(profileId) ||
            (this.taskQueue.length === 0 && this.activeGroupIds.size === 0)
          ) {
            const cur = this.profiles.get(profileId);
            this.profiles.set(profileId, {
              today: cur?.today ?? 0,
              session: cur?.session ?? 0,
              status: this.cancelled.has(profileId) ? '已停止' : '队列已完成',
              running: false,
            });
            return;
          }
          this.slotsInUse++;
          slotAcquired = true;
          this.active.add(profileId);
          await this.runner.runProfileWorker(profileId, files, settings, {
            runId,
            cancelled: () => this.cancelled.has(profileId),
            status: (text) => {
              const cur = this.profiles.get(profileId);
              this.profiles.set(profileId, {
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
              const next = await claimNextTask(profileId);
              if (next) {
                currentClaimedGroups.add(next.group.id);
              }
              return next;
            },
            onGroupIdResolved: async (rawGroupId, canonicalGroupId) => {
              if (!rawGroupId || !canonicalGroupId || rawGroupId === canonicalGroupId) return;
              currentClaimedGroups.add(canonicalGroupId);
              this.activeGroupIds.add(canonicalGroupId);
              const nextQueue: GroupPosterTaskItem[] = [];
              for (const item of this.taskQueue) {
                if (item.group.id !== rawGroupId) {
                  nextQueue.push(item);
                  continue;
                }
                const pairKey = `${canonicalGroupId}::${item.material.id}`;
                if (this.queuedKeys.has(pairKey)) continue;
                const alreadyPosted = await this.repo.hasGroupPostedMaterial(
                  canonicalGroupId,
                  item.material.id,
                );
                if (!alreadyPosted) {
                  this.queuedKeys.add(pairKey);
                  nextQueue.push({
                    group: { ...item.group, id: canonicalGroupId },
                    material: item.material,
                  });
                }
              }
              this.taskQueue = nextQueue;
            },
            returnTaskOnRestriction: (task) => {
              releaseClaimedGroups(task.group.id);
              this.taskQueue.push(task);
            },
            onTaskPosted: async (log) => {
              releaseClaimedGroups(log.groupId);
              await this.repo.recordPost(log);
              const cur = this.profiles.get(profileId);
              const nextToday = (cur?.today ?? 0) + 1;
              const nextSession = (cur?.session ?? 0) + 1;
              this.profiles.set(profileId, {
                today: nextToday,
                session: nextSession,
                status: `已发帖 · ${log.groupName}`,
                running: true,
                restricted: false,
              });
            },
            canContinueAccount: async (pid) => {
              const cur = this.profiles.get(pid);
              return (cur?.session ?? 0) < settings.maxPostsPerAccount;
            },
          });

          const finalStat = this.profiles.get(profileId);
          const wasCancelled = this.cancelled.has(profileId);
          const finalStatus = wasCancelled
            ? '已手动停止'
            : (finalStat?.session ?? 0) >= settings.maxPostsPerAccount
              ? `已达本轮上限 (${finalStat?.session ?? 0}/${settings.maxPostsPerAccount})`
              : `已完成 · 本轮发帖 ${finalStat?.session ?? 0} 条`;
          this.profiles.set(profileId, {
            today: finalStat?.today ?? 0,
            session: finalStat?.session ?? 0,
            status: finalStatus,
            running: false,
            restricted: false,
          });
          await this.repo.saveProfileResult?.({
            profileId,
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
          const cur = this.profiles.get(profileId);
          if (isRestricted) {
            const restrictReason = err.message || '受限 · 需要手机验证或操作受限';
            this.profiles.set(profileId, {
              today: cur?.today ?? 0,
              session: cur?.session ?? 0,
              status: restrictReason,
              running: false,
              restricted: true,
            });
            await this.repo.saveProfileResult?.({
              profileId,
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
            this.profiles.set(profileId, {
              today: cur?.today ?? 0,
              session: cur?.session ?? 0,
              status: failReason,
              running: false,
              restricted: false,
            });
            await this.repo.saveProfileResult?.({
              profileId,
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
          this.starting.delete(profileId);
          releaseClaimedGroups();
          this.active.delete(profileId);
          if (slotAcquired) {
            this.slotsInUse = Math.max(0, this.slotsInUse - 1);
          }
          this.workers.delete(profileId);
          if (!this.hasActiveExecution()) {
            this.queuedKeys.clear();
            const participants = [...this.sessionParticipants];
            this.sessionParticipants.clear();
            const allRestricted =
              participants.length > 0 &&
              participants.every((pid) => this.profiles.get(pid)?.restricted === true);
            this.statusText = allRestricted
              ? '全部所选浏览器均受限，已停止小组发帖'
              : this.taskQueue.length === 0
                ? '小组发帖队列已全部完成'
                : '本轮小组发帖已结束';
          }
        }
      })();
      this.workers.set(profileId, workerPromise);
    }

    return this.state();
  }

  async stop(): Promise<PosterState> {
    this.taskQueue = [];
    this.activeGroupIds.clear();
    this.queuedKeys.clear();
    this.sessionParticipants.clear();
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
