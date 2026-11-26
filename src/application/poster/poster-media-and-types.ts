import type { CompatibleRepository } from '../../domain/persistence.js';
import { mediaReference } from '../../domain/resource-table.js';
import { ProductError } from '../../domain/workspace.js';
import type {
  BumperDailyStat,
  BumperRefreshResult,
  BumperTarget,
} from '../../shared/group-bumper.js';
import type {
  PosterCacheStatus,
  PosterLog,
  PosterMaterial,
  PosterMediaKind,
  PosterPendingOperation,
  PosterProfileStat,
  PosterSettings,
  PosterTask,
} from '../../shared/group-poster.js';
import type { PostBumpRecordsPort } from '../../shared/post-bump-records.js';
import type { ProfileLifecyclePort } from '../../shared/profile-lifecycle.js';
import type { ProfileTaskResultValue } from '../../shared/task-contracts.js';
import type { FeatureExecutionRegistry } from '../feature-execution-registry.js';
import { errMsg, sleepMs } from '../module-worker-pool.js';
import { Workboard } from '../workboard.js';

export class PosterAccountRestrictedError extends Error {
  readonly scope: 'global_route' | 'feature_action';
  readonly abnormalState: 'logged-out' | 'verification' | 'restricted';

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
  thumbnailDataUrl?: string | null;
}

export interface PosterMediaStreamChunk {
  status: 200 | 206 | 416;
  headers: Record<string, string | number>;
  bytes?: Uint8Array;
}

export interface PosterMediaPreparerPort {
  prepare(
    mediaSource: string,
    assertCurrent?: (bytesRead?: number) => void | Promise<void>,
  ): Promise<PreparedPosterMedia>;
  verifyExists?(localFilePath: string): Promise<boolean>;
  generateThumbnail?(localFilePath: string, mediaKind: PosterMediaKind): Promise<string | null>;
  removeCachedDriveFile?(localFilePath: string): Promise<boolean>;
  pruneOldCachedFiles?(maxAgeMs?: number, protectedPaths?: ReadonlySet<string>): Promise<number>;
  readMediaRange?(
    localFilePath: string,
    mediaKind: PosterMediaKind,
    rangeHeader?: string,
  ): Promise<PosterMediaStreamChunk | null>;
}

export interface GroupPosterTaskItem {
  group: BumperTarget;
  material: PosterMaterial;
  taskIds?: Set<string>;
  allowedProfileIds?: Set<string> | null;
}

export interface GroupPosterBrowserCallbacks {
  runId: string;
  cancelled(): boolean;
  status(text: string): void;
  claimNextTask(): Promise<GroupPosterTaskItem | null>;
  returnTaskOnRestriction(task: GroupPosterTaskItem): void;
  onTaskPosted(log: PosterLog): Promise<void>;
  canContinueAccount(profileId: string): Promise<boolean>;
  onGroupIdResolved?(
    rawGroupId: string,
    canonicalGroupId: string,
  ): Promise<{ alreadyPosted?: boolean } | void> | { alreadyPosted?: boolean } | void;
  onTargetError?(groupId: string, reason: string): void;
}

export interface GroupPosterBrowserPort {
  ready(profileId: string): boolean;
  busy(profileId: string): Promise<boolean>;
  hasPendingReconnectStop?(profileId: string): boolean;
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
  applyResolvedTargetMetadata?(
    rawId: string,
    metadata: { canonicalId?: string | null; name?: string | null; avatarUrl?: string | null },
  ): unknown;
  materials(): PosterMaterial[];
  saveMaterials(input: unknown): PosterMaterial[];
  deleteMaterials(input: unknown): number;
  updateMaterialCache(
    id: string,
    cache: {
      localFilePath: string | null;
      mediaKind: PosterMediaKind;
      cacheStatus: PosterCacheStatus;
      cacheError: string | null;
      thumbnailDataUrl?: string | null;
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
    materialId?: string;
    postId?: string;
    postUrl?: string;
    status: string;
    kernelSettled: boolean;
    reviewReason?: string;
    createdAt: number;
    updatedAt: number;
  }>;
  hasGroupPostedMaterial(groupId: string, materialId: string): boolean;
  hasGroupVerifiedPost?(groupId: string, materialId: string): boolean;
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

export function createPosterRuntime(opts: {
  repo: CompatibleRepository<PosterRepository>;
  runner: GroupPosterBrowserPort;
  mediaPreparer: PosterMediaPreparerPort;
  registry?: FeatureExecutionRegistry;
  assertAllowed: () => void;
  refreshAvatars?: (
    kind: 'groups' | 'pages',
    items: BumperTarget[],
    options?: { signal?: AbortSignal; onUpdated?: () => void },
  ) => Promise<BumperRefreshResult | void>;
  stopAvatarRefresh?: (kind?: 'groups' | 'pages') => void;
  ensureScheduleTimer(): void;
  stopRefreshGroups(): Promise<unknown>;
}) {
  const rt = {
    ...opts,
    workers: new Map<string, Promise<void>>(),
    profiles: new Map<string, PosterProfileStat>(),
    active: new Set<string>(),
    starting: new Set<string>(),
    cancelled: new Set<string>(),
    profileRunIds: new Map<string, string>(),
    preparingMaterials: new Set<string>(),
    taskQueue: [] as GroupPosterTaskItem[],
    inFlightByWorker: new Map<string, GroupPosterTaskItem>(),
    runningTasks: new Map<string, PosterTask>(),
    sharedFiles: new Set<string>(),
    activeGroupIds: new Set<string>(),
    queuedKeys: new Set<string>(),
    sessionParticipants: new Set<string>(),
    allOnlineExcluded: new Set<string>(),
    statusText: '请选择贴文卡片上的「发帖」创建立即或定时发帖任务',
    slotsInUse: 0,
    liveMaxConcurrentCap: null as number | null,
    groupAvatarRefreshing: false,
    refreshAbort: null as AbortController | null,
    tickingSchedule: false,
    profileLifecycle: undefined as ProfileLifecyclePort | undefined,
    workboard: new Workboard(),
    postBumpRecords: undefined as PostBumpRecordsPort | undefined,
    isProfileRunning: (id: string) =>
      rt.active.has(id) || rt.starting.has(id) || rt.workers.has(id),
    hasActiveExecution: () => rt.active.size > 0 || rt.starting.size > 0 || rt.workers.size > 0,
  };
  return rt;
}

export type PosterRuntimeContext = ReturnType<typeof createPosterRuntime>;

function isLocalMediaSource(src: string): boolean {
  try {
    return mediaReference(src).kind === 'local';
  } catch {
    return false;
  }
}

export async function preparePosterMaterialById(
  ctx: PosterRuntimeContext,
  id: string,
): Promise<PosterMaterial | null> {
  const item = (await ctx.repo.materials()).find((m) => m.id === id);
  if (!item) return null;
  await ensurePosterMaterialPrepared(ctx, item);
  return (await ctx.repo.materials()).find((m) => m.id === id) ?? null;
}

export async function prepareAdHocPosterMaterial(
  ctx: PosterRuntimeContext,
  item: PosterMaterial,
): Promise<PosterMaterial> {
  const src = item.mediaSource.trim();
  if (
    !src ||
    (item.localFilePath && ((await ctx.mediaPreparer.verifyExists?.(item.localFilePath)) ?? true))
  )
    return item;
  const prepared = await ctx.mediaPreparer.prepare(src);
  return {
    ...item,
    localFilePath: prepared.localFilePath,
    mediaKind: prepared.mediaKind,
    cacheStatus: 'ready',
    cacheError: null,
  };
}

export async function preparePendingPosterMaterials(
  ctx: PosterRuntimeContext,
  materials: readonly PosterMaterial[],
): Promise<void> {
  for (const item of materials) {
    const src = item.mediaSource.trim();
    if (!src) continue;
    if (
      item.cacheStatus !== 'ready' ||
      !item.localFilePath ||
      (isLocalMediaSource(src) && !item.hasThumbnail)
    )
      await ensurePosterMaterialPrepared(ctx, item).catch(() => {});
  }
}

export async function ensurePosterMaterialPrepared(
  ctx: PosterRuntimeContext,
  item: PosterMaterial,
): Promise<PosterMaterial> {
  const src = item.mediaSource.trim();
  const commitReady = async (
    localFilePath: string | null,
    mediaKind: PosterMediaKind,
    thumbnailDataUrl?: string | null,
  ): Promise<PosterMaterial> => {
    await ctx.repo.updateMaterialCache(item.id, {
      localFilePath,
      mediaKind,
      cacheStatus: 'ready',
      cacheError: null,
      ...(thumbnailDataUrl !== undefined ? { thumbnailDataUrl } : {}),
    });
    return {
      ...item,
      localFilePath,
      mediaKind,
      cacheStatus: 'ready',
      cacheError: null,
      hasThumbnail:
        thumbnailDataUrl === null ? false : Boolean(thumbnailDataUrl || item.hasThumbnail),
    };
  };
  if (!src) return commitReady(null, 'none', null);

  const isLocal = isLocalMediaSource(src);
  if (item.cacheStatus === 'ready' && item.localFilePath) {
    const exists = (await ctx.mediaPreparer.verifyExists?.(item.localFilePath)) ?? true;
    if (!exists && isLocal) {
      await ctx.repo.updateMaterialCache(item.id, {
        localFilePath: null,
        mediaKind: item.mediaKind,
        cacheStatus: 'error',
        cacheError: '本地文件不存在',
      });
      throw new ProductError('POSTER_MEDIA_NOT_FOUND', '本地文件不存在', 404);
    }
    if (exists && (!isLocal || item.hasThumbnail)) {
      if (!item.hasThumbnail && ctx.mediaPreparer.generateThumbnail) {
        const thumb = await ctx.mediaPreparer
          .generateThumbnail(item.localFilePath, item.mediaKind)
          .catch(() => null);
        if (thumb) {
          await ctx.repo.saveMaterialThumbnail?.(item.id, thumb);
          return { ...item, hasThumbnail: true };
        }
      }
      return item;
    }
  }
  if (ctx.preparingMaterials.has(item.id)) {
    while (ctx.preparingMaterials.has(item.id)) await sleepMs(150);
    const after = (await ctx.repo.materials()).find((m) => m.id === item.id);
    if (after?.cacheStatus === 'ready' && after.localFilePath) return after;
  }
  ctx.preparingMaterials.add(item.id);
  try {
    if (!isLocal)
      await ctx.repo.updateMaterialCache(item.id, {
        localFilePath: null,
        mediaKind: item.mediaKind === 'none' ? 'video' : item.mediaKind,
        cacheStatus: 'downloading',
        cacheError: null,
      });
    const prepared = await ctx.mediaPreparer.prepare(src);
    const thumb =
      prepared.thumbnailDataUrl ??
      (await ctx.mediaPreparer
        .generateThumbnail?.(prepared.localFilePath, prepared.mediaKind)
        .catch(() => null)) ??
      null;
    return await commitReady(prepared.localFilePath, prepared.mediaKind, thumb ?? undefined);
  } catch (err) {
    const msg = errMsg(err);
    const friendlyError = isLocal && /ENOENT|no such file/i.test(msg) ? '本地文件不存在' : msg;
    await ctx.repo.updateMaterialCache(item.id, {
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
    ctx.preparingMaterials.delete(item.id);
  }
}

export async function getPosterMaterialThumbnail(
  ctx: PosterRuntimeContext,
  id: string,
): Promise<{ thumbnailDataUrl: string | null; updatedAt: number } | null> {
  if (!ctx.repo.getMaterialThumbnail) return null;
  const current = await ctx.repo.getMaterialThumbnail(id);
  if (current?.thumbnailDataUrl) return current;
  if (ctx.repo.getMaterialMediaPath && ctx.mediaPreparer.generateThumbnail) {
    const media = await ctx.repo.getMaterialMediaPath(id);
    if (media?.localFilePath && media.mediaKind !== 'none') {
      const generated = await ctx.mediaPreparer
        .generateThumbnail(media.localFilePath, media.mediaKind)
        .catch(() => null);
      if (generated) {
        await ctx.repo.saveMaterialThumbnail?.(id, generated);
        return (
          (await ctx.repo.getMaterialThumbnail(id)) ?? {
            thumbnailDataUrl: generated,
            updatedAt: Date.now(),
          }
        );
      }
    }
  }
  return current;
}

export async function streamPosterMaterialMedia(
  ctx: PosterRuntimeContext,
  id: string,
  rangeHeader?: string,
): Promise<PosterMediaStreamChunk | null> {
  if (!ctx.repo.getMaterialMediaPath || !ctx.mediaPreparer.readMediaRange) return null;
  const media = await ctx.repo.getMaterialMediaPath(id);
  return media?.localFilePath && media.mediaKind !== 'none'
    ? ctx.mediaPreparer.readMediaRange(media.localFilePath, media.mediaKind, rangeHeader)
    : null;
}

export async function cleanupExpiredPosterDriveCache(
  ctx: PosterRuntimeContext,
  nowMs = Date.now(),
): Promise<{ expired: number; skipped: number }> {
  if (!ctx.repo.listExpiredDriveMaterials || !ctx.repo.markMaterialCacheExpired)
    return { expired: 0, skipped: 0 };
  const candidates = await ctx.repo.listExpiredDriveMaterials(nowMs - 3 * 24 * 3600_000);
  const activeMaterialIds = new Set(ctx.taskQueue.map((t) => t.material.id));
  let expired = 0;
  let skipped = 0;
  for (const c of candidates) {
    if (
      ctx.hasActiveExecution() ||
      ctx.preparingMaterials.has(c.id) ||
      activeMaterialIds.has(c.id)
    ) {
      skipped++;
      continue;
    }
    if (
      ctx.mediaPreparer.removeCachedDriveFile &&
      (await ctx.mediaPreparer.removeCachedDriveFile(c.localFilePath))
    ) {
      await ctx.repo.markMaterialCacheExpired(c.id);
      expired++;
    } else skipped++;
  }
  if (!ctx.hasActiveExecution() && ctx.mediaPreparer.pruneOldCachedFiles) {
    const all = await Promise.resolve(ctx.repo.materials()).catch(() => []);
    await ctx.mediaPreparer
      .pruneOldCachedFiles(
        3 * 24 * 3600_000,
        new Set(all.flatMap((m) => (m.localFilePath ? [m.localFilePath] : []))),
      )
      .catch(() => 0);
  }
  return { expired, skipped };
}
