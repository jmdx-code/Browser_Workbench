import { ProductError } from '../../domain/workspace.js';
import type { BumperTarget } from '../../shared/group-bumper.js';
import {
  CreatePosterTaskInput,
  formatPosterCaptionPreview,
  PosterTaskIdInput,
  type PosterActiveGroupItem,
  type PosterLog,
  type PosterMaterial,
  type PosterTask,
} from '../../shared/group-poster.js';
import {
  admitAndPlanBrowserLaunch,
  awaitWorkersSettled,
  errMsg,
  sleepMs,
} from '../module-worker-pool.js';
import {
  ensurePosterMaterialPrepared,
  type GroupPosterTaskItem,
  type PosterRuntimeContext,
} from './poster-media-and-types.js';
import { spawnPosterWorkers } from './poster-worker-runner.js';

export function buildActiveGroupsByMaterial(
  ctx: PosterRuntimeContext,
): Record<string, PosterActiveGroupItem[]> {
  const result: Record<string, PosterActiveGroupItem[]> = {};
  const seen = new Map<string, Set<string>>();
  const push = (materialId: string, groupId: string, item: PosterActiveGroupItem) => {
    let s = seen.get(materialId);
    if (!s) seen.set(materialId, (s = new Set()));
    if (s.has(groupId)) return;
    s.add(groupId);
    (result[materialId] ??= []).push(item);
  };
  for (const [profileId, item] of ctx.inFlightByWorker.entries())
    push(item.material.id, item.group.id, {
      groupId: item.group.id,
      groupName: item.group.name,
      state: 'posting',
      profileId,
      statusText: ctx.profiles.get(profileId)?.status ?? '正在发帖…',
    });
  for (const item of ctx.taskQueue)
    push(item.material.id, item.group.id, {
      groupId: item.group.id,
      groupName: item.group.name,
      state: 'queued',
    });
  return result;
}

export const isItemEligibleForProfile = (item: GroupPosterTaskItem, profileId: string) =>
  !item.allowedProfileIds || item.allowedProfileIds.has(profileId);
export const hasEligibleQueueItem = (ctx: PosterRuntimeContext, profileId: string) =>
  ctx.taskQueue.some((item) => isItemEligibleForProfile(item, profileId));
export const hasEligibleInFlightItem = (ctx: PosterRuntimeContext, profileId: string) =>
  [...ctx.inFlightByWorker.entries()].some(
    ([ownerId, item]) => ownerId !== profileId && isItemEligibleForProfile(item, profileId),
  );

const allRunningWorkerIds = (ctx: PosterRuntimeContext) => [
  ...new Set([...ctx.active, ...ctx.starting, ...ctx.workers.keys()]),
];

function clearQueueAndPools(ctx: PosterRuntimeContext, keepInFlight = false): void {
  ctx.taskQueue = [];
  ctx.activeGroupIds.clear();
  ctx.queuedKeys.clear();
  ctx.sessionParticipants.clear();
  ctx.allOnlineExcluded.clear();
  if (!keepInFlight) ctx.inFlightByWorker.clear();
  ctx.sharedFiles.clear();
}

async function mutateRunningTasks(
  ctx: PosterRuntimeContext,
  taskIds: ReadonlySet<string> | undefined,
  mutate: (task: PosterTask) => void,
): Promise<void> {
  if (!taskIds) return;
  for (const tid of taskIds) {
    const task = ctx.runningTasks.get(tid);
    if (!task || task.status !== 'running') continue;
    mutate(task);
    await ctx.repo.saveTask?.(task);
  }
}

const dropInFlight = (ctx: PosterRuntimeContext, pid: string, extraGroupId?: string) => {
  const claimed = ctx.inFlightByWorker.get(pid);
  if (!claimed) return undefined;
  ctx.inFlightByWorker.delete(pid);
  ctx.activeGroupIds.delete(claimed.group.id);
  if (extraGroupId) ctx.activeGroupIds.delete(extraGroupId);
  return claimed;
};

export function pruneTaskFromQueue(ctx: PosterRuntimeContext, taskId: string): void {
  ctx.taskQueue = ctx.taskQueue.filter((item) => {
    if (!item.taskIds?.has(taskId)) return true;
    item.taskIds.delete(taskId);
    if (!item.taskIds.size) {
      ctx.queuedKeys.delete(`${item.group.id}::${item.material.id}`);
      return false;
    }
    return true;
  });
}

export async function handleClaimedItemSkipped(
  ctx: PosterRuntimeContext,
  profileId: string,
  wasCancelled = false,
): Promise<void> {
  const claimed = dropInFlight(ctx, profileId);
  if (!claimed) return;
  ctx.queuedKeys.delete(`${claimed.group.id}::${claimed.material.id}`);
  if (!wasCancelled)
    await mutateRunningTasks(ctx, claimed.taskIds, (t) => void (t.skippedCount += 1));
}

export async function settleRunningPosterTasks(ctx: PosterRuntimeContext): Promise<void> {
  const activeWorkerIds = allRunningWorkerIds(ctx).filter((pid) => !ctx.cancelled.has(pid));
  for (const task of [...ctx.runningTasks.values()]) {
    const queuedForTask = ctx.taskQueue.filter((item) => item.taskIds?.has(task.id)).length;
    const inFlightForTask = [...ctx.inFlightByWorker.values()].filter((item) =>
      item.taskIds?.has(task.id),
    ).length;
    const hasWorker = activeWorkerIds.some(
      (pid) => task.accountMode === 'all_online' || task.profileIds.includes(pid),
    );
    if ((queuedForTask || inFlightForTask) && (inFlightForTask || hasWorker)) continue;
    if (queuedForTask > 0) pruneTaskFromQueue(ctx, task.id);
    if (task.status !== 'cancelled') {
      if (task.postedCount >= task.totalGroups && task.totalGroups > 0) {
        task.status = 'completed';
        task.statusReason = `已完成 · 成功发送 ${task.postedCount} 个小组`;
      } else if (task.postedCount > 0) {
        task.status = 'partial';
        task.statusReason =
          !hasWorker && queuedForTask > 0
            ? `部分成功 · 已发 ${task.postedCount}/${task.totalGroups} 组（可用账号均受限或已达上限）`
            : `部分成功 · 已发 ${task.postedCount}/${task.totalGroups} 组`;
      } else {
        task.status = 'failed';
        task.statusReason = !hasWorker
          ? `失败 · 已发 0/${task.totalGroups} 组（账号受限或无可用在线浏览器）`
          : '失败 · 所选小组均未能发布';
      }
    }
    task.finishedAt = Date.now();
    ctx.runningTasks.delete(task.id);
    await ctx.repo.saveTask?.(task);
  }
}

export async function claimNextTaskForWorker(
  ctx: PosterRuntimeContext,
  profileId: string,
): Promise<GroupPosterTaskItem | null> {
  if (ctx.inFlightByWorker.has(profileId)) {
    await handleClaimedItemSkipped(ctx, profileId, ctx.cancelled.has(profileId));
    await settleRunningPosterTasks(ctx);
  }
  while (
    !hasEligibleQueueItem(ctx, profileId) &&
    hasEligibleInFlightItem(ctx, profileId) &&
    !ctx.cancelled.has(profileId)
  )
    await sleepMs(40);
  if (!hasEligibleQueueItem(ctx, profileId) || ctx.cancelled.has(profileId)) return null;

  const eligible: number[] = [];
  const nonBusy: number[] = [];
  for (let i = 0; i < ctx.taskQueue.length; i++) {
    const item = ctx.taskQueue[i];
    if (!item || !isItemEligibleForProfile(item, profileId)) continue;
    eligible.push(i);
    if (!ctx.activeGroupIds.has(item.group.id)) nonBusy.push(i);
  }
  const pool = nonBusy.length ? nonBusy : eligible;
  if (!pool.length) return null;
  const [claimed] = ctx.taskQueue.splice(pool[Math.floor(Math.random() * pool.length)] ?? 0, 1);
  if (!claimed) return null;

  ctx.activeGroupIds.add(claimed.group.id);
  ctx.inFlightByWorker.set(profileId, claimed);
  let postedNow: boolean;
  let verifiedNow = true;
  try {
    postedNow = await ctx.repo.hasGroupPostedMaterial(claimed.group.id, claimed.material.id);
    if (postedNow && ctx.repo.hasGroupVerifiedPost)
      verifiedNow = await ctx.repo.hasGroupVerifiedPost(claimed.group.id, claimed.material.id);
  } catch (error) {
    if (ctx.inFlightByWorker.get(profileId) === claimed) ctx.inFlightByWorker.delete(profileId);
    ctx.activeGroupIds.delete(claimed.group.id);
    throw error;
  }
  if (postedNow) {
    dropInFlight(ctx, profileId);
    ctx.queuedKeys.delete(`${claimed.group.id}::${claimed.material.id}`);
    await mutateRunningTasks(ctx, claimed.taskIds, (task) => {
      if (verifiedNow) task.postedCount = Math.min(task.totalGroups, task.postedCount + 1);
      else task.skippedCount += 1;
    });
    await settleRunningPosterTasks(ctx);
    return claimNextTaskForWorker(ctx, profileId);
  }
  return claimed;
}

export async function handlePosterGroupIdResolved(
  ctx: PosterRuntimeContext,
  pid: string,
  currentClaimedGroups: Set<string>,
  rawGroupId: string,
  canonicalGroupId: string,
): Promise<{ alreadyPosted: boolean }> {
  if (!rawGroupId || !canonicalGroupId || rawGroupId === canonicalGroupId)
    return { alreadyPosted: false };
  currentClaimedGroups.add(canonicalGroupId);
  ctx.activeGroupIds.add(canonicalGroupId);
  const inFlight = ctx.inFlightByWorker.get(pid);
  let inFlightAlreadyPosted = false;
  if (inFlight && inFlight.group.id === rawGroupId) {
    ctx.queuedKeys.delete(`${rawGroupId}::${inFlight.material.id}`);
    inFlightAlreadyPosted = await ctx.repo.hasGroupPostedMaterial(
      canonicalGroupId,
      inFlight.material.id,
    );
    if (!inFlightAlreadyPosted) ctx.queuedKeys.add(`${canonicalGroupId}::${inFlight.material.id}`);
    inFlight.group = { ...inFlight.group, id: canonicalGroupId };
  }
  const postedByMaterial = new Map<string, boolean>();
  for (const mid of new Set(
    ctx.taskQueue.filter((it) => it.group.id === rawGroupId).map((it) => it.material.id),
  ))
    postedByMaterial.set(mid, await ctx.repo.hasGroupPostedMaterial(canonicalGroupId, mid));
  const tasksToSave = new Set<PosterTask>();
  const bumpSkip = (taskIds: Set<string> | undefined, minTotal = 0) => {
    if (!taskIds) return;
    for (const tid of taskIds) {
      const t = ctx.runningTasks.get(tid);
      if (t && t.status === 'running') {
        t.totalGroups = Math.max(minTotal, t.totalGroups - 1);
        t.skippedCount += 1;
        tasksToSave.add(t);
      }
    }
  };
  if (inFlightAlreadyPosted) bumpSkip(inFlight?.taskIds);

  const nextQueue: GroupPosterTaskItem[] = [];
  for (const item of ctx.taskQueue) {
    if (item.group.id !== rawGroupId) {
      nextQueue.push(item);
      continue;
    }
    ctx.queuedKeys.delete(`${rawGroupId}::${item.material.id}`);
    const pairKey = `${canonicalGroupId}::${item.material.id}`;
    if (ctx.queuedKeys.has(pairKey)) {
      const match = (q: GroupPosterTaskItem) =>
        q.group.id === canonicalGroupId && q.material.id === item.material.id;
      const existing =
        nextQueue.find(match) ??
        ctx.taskQueue.find(match) ??
        [...ctx.inFlightByWorker.values()].find(match);
      if (existing && item.taskIds) {
        existing.taskIds ??= new Set();
        for (const tid of item.taskIds) {
          if (existing.taskIds.has(tid)) bumpSkip(new Set([tid]), 1);
          else existing.taskIds.add(tid);
        }
      }
      continue;
    }
    if (!(postedByMaterial.get(item.material.id) ?? false)) {
      ctx.queuedKeys.add(pairKey);
      nextQueue.push({ ...item, group: { ...item.group, id: canonicalGroupId } });
    } else bumpSkip(item.taskIds);
  }
  ctx.taskQueue = nextQueue;
  for (const t of tasksToSave) await ctx.repo.saveTask?.(t);
  return { alreadyPosted: inFlightAlreadyPosted };
}

export function returnPosterTaskOnRestriction(
  ctx: PosterRuntimeContext,
  pid: string,
  releaseClaimedGroups: (extraId?: string) => void,
  task: GroupPosterTaskItem,
): void {
  ctx.inFlightByWorker.delete(pid);
  releaseClaimedGroups(task.group.id);
  if (ctx.cancelled.has(pid))
    return void ctx.queuedKeys.delete(`${task.group.id}::${task.material.id}`);
  if (task.taskIds) {
    for (const tid of [...task.taskIds]) {
      const rt = ctx.runningTasks.get(tid);
      if (!rt || rt.status !== 'running') task.taskIds.delete(tid);
    }
    if (!task.taskIds.size)
      return void ctx.queuedKeys.delete(`${task.group.id}::${task.material.id}`);
  }
  ctx.taskQueue.push(task);
}

export async function handlePosterTaskPosted(
  ctx: PosterRuntimeContext,
  pid: string,
  releaseClaimedGroups: (extraId?: string) => void,
  log: PosterLog,
): Promise<void> {
  const claimed = ctx.inFlightByWorker.get(pid);
  ctx.inFlightByWorker.delete(pid);
  releaseClaimedGroups(log.groupId);
  ctx.queuedKeys.delete(`${log.groupId}::${log.materialId}`);
  if (claimed && claimed.group.id !== log.groupId)
    ctx.queuedKeys.delete(`${claimed.group.id}::${log.materialId}`);
  await ctx.repo.recordPost(log);
  await mutateRunningTasks(ctx, claimed?.taskIds, (t) => {
    t.postedCount += 1;
    t.statusReason = `正在发送 (${t.postedCount}/${t.totalGroups})`;
  });
  const cur = ctx.profiles.get(pid);
  ctx.profiles.set(pid, {
    today: (cur?.today ?? 0) + 1,
    session: (cur?.session ?? 0) + 1,
    status: `已发帖 · ${log.groupName}`,
    running: true,
    restricted: false,
  });
  await settleRunningPosterTasks(ctx);
}

async function markTaskCancelled(ctx: PosterRuntimeContext, task: PosterTask): Promise<void> {
  task.status = 'cancelled';
  task.statusReason =
    task.postedCount > 0
      ? `已手动停止 · 已发 ${task.postedCount}/${task.totalGroups} 组`
      : '已手动停止';
  task.finishedAt = Date.now();
  ctx.runningTasks.delete(task.id);
  await ctx.repo.saveTask?.(task);
}

export async function createPosterTask(ctx: PosterRuntimeContext, input: unknown): Promise<void> {
  ctx.assertAllowed();
  const parsed = CreatePosterTaskInput.parse(input);
  const [allGroups, allMaterials] = await Promise.all([ctx.repo.targets(), ctx.repo.materials()]);
  const groupById = new Map(allGroups.map((g) => [g.id, g]));
  const material = allMaterials.find((m) => m.id === parsed.materialId);
  if (!material) throw new ProductError('POSTER_MATERIAL_NOT_FOUND', '未找到所选贴文素材', 404);
  const validGroups = [...new Set(parsed.groupIds)]
    .map((id) => groupById.get(id))
    .filter((g): g is BumperTarget => g !== undefined);
  if (!validGroups.length)
    throw new ProductError('POSTER_GROUPS_EMPTY', '请至少选择 1 个有效目标小组', 400);
  const unpostedGroups: BumperTarget[] = [];
  for (const g of validGroups)
    if (!(await ctx.repo.hasGroupPostedMaterial(g.id, material.id))) unpostedGroups.push(g);
  if (!unpostedGroups.length) {
    ctx.statusText = '所选小组已全部发过该贴文，已自动跳过重复小组';
    throw new ProductError(
      'POSTER_ALL_GROUPS_ALREADY_POSTED',
      '所选小组已全部发过该贴文，已自动防重复拦截',
      409,
    );
  }

  const now = Date.now();
  const scheduledAtMs = parsed.scheduledAt;
  const isFuture = scheduledAtMs !== null && scheduledAtMs > now;
  const task: PosterTask = {
    id: globalThis.crypto.randomUUID(),
    materialId: material.id,
    captionPreview: formatPosterCaptionPreview(
      material.caption,
      material.mediaSource,
      material.mediaKind,
    ),
    groupIds: unpostedGroups.map((g) => g.id),
    accountMode: parsed.accountMode,
    profileIds: [...new Set(parsed.profileIds)],
    scheduledAt: scheduledAtMs,
    status: isFuture ? 'scheduled' : 'running',
    totalGroups: unpostedGroups.length,
    postedCount: 0,
    skippedCount: Math.max(0, validGroups.length - unpostedGroups.length),
    statusReason: isFuture
      ? `定时待启动 · ${new Date(scheduledAtMs).toLocaleString()}`
      : `正在准备发送 (0/${unpostedGroups.length})`,
    createdAt: now,
    startedAt: isFuture ? null : now,
    finishedAt: null,
  };
  if (isFuture) {
    await ctx.repo.saveTask?.(task);
    ctx.ensureScheduleTimer();
    ctx.statusText = `已创建定时发帖任务 · 定于 ${new Date(scheduledAtMs).toLocaleString()} 启动`;
    return;
  }
  await dispatchPosterTask(ctx, task, false);
}

export async function dispatchPosterTask(
  ctx: PosterRuntimeContext,
  task: PosterTask,
  isScheduledTrigger: boolean,
): Promise<void> {
  const [allGroups, allMaterials, settings, todayCounts] = await Promise.all([
    ctx.repo.targets(),
    ctx.repo.materials(),
    ctx.repo.settings(),
    ctx.repo.todayCounts(),
  ]);
  const failTask = async (reason: string, errToThrow?: unknown) => {
    Object.assign(task, {
      status: 'failed' as const,
      statusReason: reason,
      startedAt: task.startedAt ?? Date.now(),
      finishedAt: Date.now(),
    });
    await ctx.repo.saveTask?.(task);
    ctx.statusText = reason;
    if (!isScheduledTrigger && errToThrow) throw errToThrow;
  };
  const material = allMaterials.find((m) => m.id === task.materialId);
  if (!material)
    return failTask(
      '失败 · 贴文素材已被删除',
      new ProductError('POSTER_MATERIAL_NOT_FOUND', '失败 · 贴文素材已被删除', 404),
    );

  let preparedMaterial: PosterMaterial;
  try {
    ctx.statusText = '正在检查并缓存发帖视频/图片素材…';
    preparedMaterial = await ensurePosterMaterialPrepared(ctx, material);
  } catch (err) {
    return failTask(`失败 · ${errMsg(err)}`, err);
  }

  const groupById = new Map(allGroups.map((g) => [g.id, g]));
  const resolveRequested = async () =>
    task.accountMode === 'all_online'
      ? [...new Set((await ctx.runner.onlineProfileIds?.()) ?? task.profileIds)]
      : [...new Set(task.profileIds)];

  if (ctx.groupAvatarRefreshing) {
    await ctx.stopRefreshGroups().catch(() => {});
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const probeIds = await resolveRequested();
      if (
        !probeIds.length ||
        (await Promise.all(probeIds.map((id) => ctx.runner.ready(id)))).some(Boolean)
      )
        break;
      await sleepMs(150);
    }
  }
  const requestedProfileIds = await resolveRequested();
  const {
    pendingLaunchSet,
    launchFailureReasons,
    admission: admitted,
  } = await admitAndPlanBrowserLaunch({
    launchCandidates:
      task.accountMode === 'selected' && requestedProfileIds.length && ctx.profileLifecycle
        ? requestedProfileIds.filter((id) => !ctx.isProfileRunning(id))
        : [],
    admitIds: () => requestedProfileIds,
    moduleId: 'group-poster',
    profileLifecycle: task.accountMode === 'selected' ? ctx.profileLifecycle : undefined,
    featureExecution: ctx.registry,
    isProfileReady: (id) => ctx.runner.ready(id),
    isAlreadyRunningInCurrentModule: (id) => ctx.isProfileRunning(id),
    isProfileBusyInRunner: async (id, pendingSet) =>
      ctx.runner.hasPendingReconnectStop?.(id) === true &&
      (pendingSet.has(id) || !(await ctx.runner.ready(id)))
        ? false
        : ctx.runner.busy(id),
    onLaunchingOffline: async (count) => {
      ctx.statusText = `正在自动启动 ${count} 个离线浏览器并等待插件连接…`;
      task.statusReason = `正在唤醒 ${count} 个离线浏览器…`;
      await ctx.repo.saveTask?.(task);
    },
  });

  for (const item of [...admitted.skippedBusy, ...admitted.skippedOffline]) {
    const prev = ctx.profiles.get(item.profileId);
    ctx.profiles.set(item.profileId, {
      today: todayCounts[item.profileId] ?? prev?.today ?? 0,
      session: prev?.session ?? 0,
      status: launchFailureReasons.get(item.profileId) ?? item.reason,
      running: false,
    });
  }

  const usableWorkerIds = [
    ...new Set([...admitted.admittedProfileIds, ...admitted.alreadyRunningIds]),
  ];
  if (!usableWorkerIds.length) {
    const firstLaunchFail = [...launchFailureReasons.values()][0];
    const busyOnly = admitted.skippedBusy.length > 0 && !admitted.skippedOffline.length;
    const failReason = busyOnly
      ? (admitted.skippedBusy[0]?.reason ?? '所选浏览器正忙')
      : firstLaunchFail
        ? `失败 · ${firstLaunchFail.replace(/^跳过：\s*/, '')}`
        : '失败 · 当前没有在线或可用的浏览器';
    const nowMs = Date.now();
    if (isScheduledTrigger && busyOnly && nowMs - task.createdAt < 30 * 60_000) {
      Object.assign(task, {
        status: 'scheduled' as const,
        scheduledAt: nowMs + 60_000,
        statusReason: `等待其他任务结束后自动重试（${failReason}）`,
      });
      await ctx.repo.saveTask?.(task);
      ctx.ensureScheduleTimer();
      ctx.statusText = task.statusReason;
      return;
    }
    return failTask(
      failReason,
      busyOnly
        ? new ProductError('POSTER_PROFILES_BUSY', failReason, 409)
        : new ProductError('POSTER_NO_READY_PROFILE', '所选浏览器不在线或正忙', 409),
    );
  }

  if (!ctx.hasActiveExecution()) clearQueueAndPools(ctx, true);
  else if (task.accountMode === 'all_online') ctx.allOnlineExcluded.clear();
  if (preparedMaterial.localFilePath) ctx.sharedFiles.add(preparedMaterial.localFilePath);

  for (const pid of admitted.alreadyRunningIds) {
    const cur = ctx.profiles.get(pid);
    if (cur) ctx.profiles.set(pid, { ...cur, session: 0 });
  }

  let effectiveTotalGroups = 0;
  const allowedSet = task.accountMode === 'all_online' ? null : new Set(usableWorkerIds);
  for (const gid of [...new Set(task.groupIds)]) {
    const group = groupById.get(gid);
    if (!group) continue;
    if (await ctx.repo.hasGroupPostedMaterial(group.id, preparedMaterial.id)) {
      task.skippedCount += 1;
      continue;
    }
    const pairKey = `${group.id}::${preparedMaterial.id}`;
    if (ctx.queuedKeys.has(pairKey)) {
      const match = (item: { group: BumperTarget; material: PosterMaterial }) =>
        item.group.id === group.id && item.material.id === preparedMaterial.id;
      const existing = ctx.taskQueue.find(match) ?? [...ctx.inFlightByWorker.values()].find(match);
      if (existing) {
        (existing.taskIds ??= new Set()).add(task.id);
        if (allowedSet === null || existing.allowedProfileIds === null)
          existing.allowedProfileIds = null;
        else if (existing.allowedProfileIds)
          for (const pid of allowedSet) existing.allowedProfileIds.add(pid);
        effectiveTotalGroups++;
      }
      continue;
    }
    ctx.queuedKeys.add(pairKey);
    ctx.taskQueue.push({
      group,
      material: preparedMaterial,
      taskIds: new Set([task.id]),
      allowedProfileIds: allowedSet ? new Set(allowedSet) : null,
    });
    effectiveTotalGroups++;
  }

  if (!effectiveTotalGroups) {
    Object.assign(task, {
      status: 'completed',
      totalGroups: 0,
      statusReason: '已完成 · 所选小组均已发过该贴文，已自动跳过',
      startedAt: Date.now(),
      finishedAt: Date.now(),
    });
    await ctx.repo.saveTask?.(task);
    ctx.statusText = task.statusReason;
    return;
  }

  Object.assign(task, {
    status: 'running',
    totalGroups: effectiveTotalGroups,
    startedAt: Date.now(),
    statusReason: `正在发送 (0/${effectiveTotalGroups})`,
  });
  ctx.runningTasks.set(task.id, task);
  await ctx.repo.saveTask?.(task);
  ctx.statusText = `正在发帖 · 待发队列 ${ctx.taskQueue.length} 条`;
  spawnPosterWorkers(ctx, admitted.admittedProfileIds, settings, todayCounts, pendingLaunchSet);
  if (pendingLaunchSet.size > 0) {
    await Promise.resolve();
    await Promise.resolve();
  }
}

export async function tickScheduledPosterTasks(
  ctx: PosterRuntimeContext,
  now = Date.now(),
): Promise<void> {
  if (ctx.tickingSchedule) return;
  ctx.tickingSchedule = true;
  try {
    const dueTasks = ((await ctx.repo.listTasks?.(100)) ?? [])
      .filter((t) => t.status === 'scheduled' && t.scheduledAt !== null && t.scheduledAt <= now)
      .sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0) || a.createdAt - b.createdAt);
    for (const due of dueTasks) await dispatchPosterTask(ctx, due, true);

    if (
      [...ctx.runningTasks.values()].some(
        (t) => t.status === 'running' && t.accountMode === 'all_online',
      ) &&
      ctx.taskQueue.some((item) => !item.allowedProfileIds) &&
      ctx.runner.onlineProfileIds
    ) {
      const newCandidates = (await ctx.runner.onlineProfileIds()).filter(
        (id) => !ctx.isProfileRunning(id) && !ctx.allOnlineExcluded.has(id),
      );
      if (newCandidates.length) {
        const { admission } = await admitAndPlanBrowserLaunch({
          launchCandidates: [],
          admitIds: () => newCandidates,
          moduleId: 'group-poster',
          featureExecution: ctx.registry,
          isProfileReady: (id) => ctx.runner.ready(id),
          isAlreadyRunningInCurrentModule: (id) => ctx.isProfileRunning(id),
          isProfileBusyInRunner: (id) => ctx.runner.busy(id),
        });
        if (admission.admittedProfileIds.length) {
          const [settings, todayCounts] = await Promise.all([
            ctx.repo.settings(),
            ctx.repo.todayCounts(),
          ]);
          spawnPosterWorkers(ctx, admission.admittedProfileIds, settings, todayCounts);
        }
      }
    }
  } finally {
    ctx.tickingSchedule = false;
  }
}

export async function cancelPosterTask(ctx: PosterRuntimeContext, input: unknown): Promise<void> {
  ctx.assertAllowed();
  const { id } = PosterTaskIdInput.parse(input);
  const running = ctx.runningTasks.get(id);
  if (running) {
    await markTaskCancelled(ctx, running);
    pruneTaskFromQueue(ctx, id);
    const workersToStop: string[] = [];
    const workersToRespawn: string[] = [];
    for (const [pid, item] of ctx.inFlightByWorker.entries()) {
      if (!item.taskIds?.has(id)) continue;
      item.taskIds.delete(id);
      if (!item.taskIds.size) {
        dropInFlight(ctx, pid);
        ctx.queuedKeys.delete(`${item.group.id}::${item.material.id}`);
        workersToStop.push(pid);
        if (hasEligibleQueueItem(ctx, pid)) workersToRespawn.push(pid);
      }
    }
    if (!ctx.runningTasks.size && !ctx.taskQueue.length)
      await stopPosterProfiles(ctx, allRunningWorkerIds(ctx));
    else if (workersToStop.length) {
      await stopPosterProfiles(ctx, workersToStop);
      if (workersToRespawn.length && ctx.taskQueue.length) {
        const [settings, todayCounts] = await Promise.all([
          ctx.repo.settings(),
          ctx.repo.todayCounts(),
        ]);
        spawnPosterWorkers(ctx, workersToRespawn, settings, todayCounts);
      }
    }
    ctx.statusText = running.statusReason;
    return;
  }
  const persisted = ((await ctx.repo.listTasks?.(200)) ?? []).find((t) => t.id === id);
  if (persisted?.status === 'scheduled') {
    Object.assign(persisted, {
      status: 'cancelled',
      statusReason: '已取消定时发帖',
      finishedAt: Date.now(),
    });
    await ctx.repo.saveTask?.(persisted);
    ctx.statusText = '已取消定时发帖任务';
  }
}

export async function deletePosterTask(ctx: PosterRuntimeContext, input: unknown): Promise<void> {
  ctx.assertAllowed();
  const { id } = PosterTaskIdInput.parse(input);
  if (ctx.runningTasks.has(id)) await cancelPosterTask(ctx, { id });
  await ctx.repo.deleteTask?.(id);
}

export async function stopAllPoster(ctx: PosterRuntimeContext): Promise<void> {
  clearQueueAndPools(ctx);
  for (const task of [...ctx.runningTasks.values()]) await markTaskCancelled(ctx, task);
  await stopPosterProfiles(ctx, allRunningWorkerIds(ctx));
  ctx.statusText = '已停止全部发帖任务';
}

export async function stopPosterProfiles(
  ctx: PosterRuntimeContext,
  profileIds: readonly string[],
): Promise<void> {
  for (const id of profileIds) {
    ctx.cancelled.add(id);
    ctx.allOnlineExcluded.add(id);
    ctx.starting.delete(id);
    ctx.workboard.abortCarrier(id, 'USER_STOP');
  }
  await Promise.allSettled(profileIds.map((id) => ctx.runner.stop(id)));
  await awaitWorkersSettled(
    profileIds.map((id) => ctx.workers.get(id)),
    3000,
  );
}
