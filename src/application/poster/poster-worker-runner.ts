import {
  formatPosterCaptionPreview,
  type PosterMaterial,
  type PosterProfileStat,
  type PosterSettings,
} from '../../shared/group-poster.js';
import {
  acquireConcurrencySlot,
  ensureBrowserProfileOnline,
  errMsg,
  launchOfflineProfileInSlot,
  persistProfileTaskResult,
  recordPostBumpFailure,
  runTrackedScheduledWorker,
  sleepMs,
} from '../module-worker-pool.js';
import { isWorkAbortError } from '../workboard.js';
import {
  PosterAccountRestrictedError,
  ensurePosterMaterialPrepared,
  type GroupPosterTaskItem,
  type PosterRuntimeContext,
} from './poster-media-and-types.js';
import {
  claimNextTaskForWorker,
  handleClaimedItemSkipped,
  handlePosterGroupIdResolved,
  handlePosterTaskPosted,
  hasEligibleInFlightItem,
  hasEligibleQueueItem,
  returnPosterTaskOnRestriction,
  settleRunningPosterTasks,
} from './poster-queue-and-dispatch.js';

function recordPosterFailure(
  ctx: PosterRuntimeContext,
  profileId: string,
  reason: string,
  group?: { id?: string; name?: string; caption?: string },
): void {
  recordPostBumpFailure(ctx.postBumpRecords, {
    recordType: 'post',
    carrier: 'browser',
    status: 'failed',
    profileId,
    groupId: group?.id === '__page_timeline__' ? '' : (group?.id ?? ''),
    groupName: group?.name ?? '',
    captionPreview: group?.caption ? formatPosterCaptionPreview(group.caption) : '',
    errorReason: reason.slice(0, 120),
  });
}

function finalizePosterOutcome(
  ctx: PosterRuntimeContext,
  pid: string,
  runId: string,
  state: 'COMPLETED' | 'STOPPED' | 'FAILED',
  reason: string,
  restricted = false,
): Promise<void> {
  const cur = ctx.profiles.get(pid);
  ctx.profiles.set(pid, {
    today: cur?.today ?? 0,
    session: cur?.session ?? 0,
    status: reason,
    running: false,
    restricted,
  });
  return persistProfileTaskResult(ctx.repo.saveProfileResult?.bind(ctx.repo), {
    profileId: pid,
    source: 'group-poster',
    runId,
    name: '小组发帖',
    state,
    reason,
    finishedAt: Date.now(),
    failedSteps: state === 'FAILED' ? 1 : 0,
    skippedSteps: 0,
  });
}

export function spawnPosterWorkers(
  ctx: PosterRuntimeContext,
  profileIds: readonly string[],
  settings: PosterSettings,
  todayCounts: Record<string, number>,
  pendingLaunchSet: ReadonlySet<string> = new Set(),
): void {
  ctx.liveMaxConcurrentCap = Math.max(1, settings.maxConcurrentProfiles);
  const batchRunId = globalThis.crypto.randomUUID();
  for (const pid of profileIds) {
    if (ctx.isProfileRunning(pid) || ctx.workboard.isCarrierBusy(pid)) continue;
    ctx.cancelled.delete(pid);
    ctx.allOnlineExcluded.delete(pid);
    ctx.starting.add(pid);
    ctx.sessionParticipants.add(pid);
    ctx.profileRunIds.set(pid, batchRunId);
    const needsLaunch = pendingLaunchSet.has(pid) && ctx.profileLifecycle !== undefined;
    ctx.profiles.set(pid, {
      today: todayCounts[pid] ?? ctx.profiles.get(pid)?.today ?? 0,
      session: 0,
      status: needsLaunch ? '正在启动浏览器…' : '排队等待并发槽位…',
      running: true,
      restricted: false,
    });

    let workerPromise: Promise<void> | undefined;
    workerPromise = ctx.workboard.runSoldier(
      { carrierId: pid, carrierKind: 'browser', moduleId: 'group-poster' },
      async (soldier) => {
        if (!needsLaunch) await Promise.resolve();
        const runId = ctx.profileRunIds.get(pid) ?? batchRunId;
        let slotAcquired = false;
        const currentClaimed = new Set<string>();
        const releaseClaimed = (extraId?: string) => {
          for (const gid of currentClaimed) ctx.activeGroupIds.delete(gid);
          currentClaimed.clear();
          if (extraId) ctx.activeGroupIds.delete(extraId);
        };
        const isAborted = () => ctx.cancelled.has(pid) || soldier.signal.aborted;
        const hasPendingWork = () =>
          hasEligibleQueueItem(ctx, pid) || hasEligibleInFlightItem(ctx, pid);
        try {
          if (needsLaunch) {
            const launched = await launchOfflineProfileInSlot(
              pid,
              ctx.profileLifecycle,
              ctx.workboard,
              soldier.signal,
              (id) => ctx.runner.ready(id),
            );
            if (!launched.ok) {
              ctx.starting.delete(pid);
              recordPosterFailure(ctx, pid, launched.reason);
              return void (await finalizePosterOutcome(ctx, pid, runId, 'FAILED', launched.reason));
            }
          }
          slotAcquired = await acquireConcurrencySlot({
            isFull: () =>
              ctx.slotsInUse >= (ctx.liveMaxConcurrentCap ?? settings.maxConcurrentProfiles),
            isAborted: () => isAborted() || !hasPendingWork(),
            waitStep: () => sleepMs(100),
            acquire: () => void ctx.slotsInUse++,
          });
          ctx.starting.delete(pid);
          if (!slotAcquired || isAborted() || !hasPendingWork()) {
            const cur = ctx.profiles.get(pid);
            ctx.profiles.set(pid, {
              today: cur?.today ?? 0,
              session: cur?.session ?? 0,
              status: isAborted() ? '已停止' : '队列已完成',
              running: false,
            });
            return;
          }
          ctx.active.add(pid);
          while (
            !isAborted() &&
            (ctx.profiles.get(pid)?.session ?? 0) < settings.maxPostsPerAccount &&
            hasPendingWork()
          ) {
            await ctx.runner.runProfileWorker(pid, [...ctx.sharedFiles], settings, {
              runId,
              cancelled: isAborted,
              status: (text) => {
                const cur = ctx.profiles.get(pid);
                ctx.profiles.set(pid, {
                  today: cur?.today ?? 0,
                  session: cur?.session ?? 0,
                  status: text,
                  running: true,
                  restricted: cur?.restricted,
                });
                ctx.statusText = text;
              },
              claimNextTask: async () => {
                releaseClaimed();
                const next = await claimNextTaskForWorker(ctx, pid);
                if (next) currentClaimed.add(next.group.id);
                return next;
              },
              onGroupIdResolved: (rawId, canonId) =>
                handlePosterGroupIdResolved(ctx, pid, currentClaimed, rawId, canonId),
              returnTaskOnRestriction: (task) =>
                returnPosterTaskOnRestriction(ctx, pid, releaseClaimed, task),
              onTargetError: (groupId, reason) => {
                const c = ctx.inFlightByWorker.get(pid);
                recordPosterFailure(ctx, pid, reason, {
                  id: groupId,
                  name: c?.group.name ?? '',
                  caption: c?.material.caption,
                });
              },
              onTaskPosted: (log) => handlePosterTaskPosted(ctx, pid, releaseClaimed, log),
              canContinueAccount: async (workerPid) =>
                (ctx.profiles.get(workerPid)?.session ?? 0) < settings.maxPostsPerAccount,
            });
          }
          const finalStat = ctx.profiles.get(pid);
          const wasCancelled = isAborted();
          const reachedQuota = (finalStat?.session ?? 0) >= settings.maxPostsPerAccount;
          if (wasCancelled || reachedQuota) ctx.allOnlineExcluded.add(pid);
          const finalStatus = wasCancelled
            ? '已手动停止'
            : reachedQuota
              ? `已达本轮上限 (${finalStat?.session ?? 0}/${settings.maxPostsPerAccount})`
              : `已完成 · 本轮发帖 ${finalStat?.session ?? 0} 条`;
          await finalizePosterOutcome(
            ctx,
            pid,
            runId,
            wasCancelled ? 'STOPPED' : 'COMPLETED',
            finalStatus,
          );
        } catch (err) {
          const msg = errMsg(err);
          const claimed = ctx.inFlightByWorker.get(pid);
          const failInfo = claimed
            ? { name: claimed.group.name, caption: claimed.material.caption }
            : undefined;
          if (isAborted() || isWorkAbortError(err)) {
            ctx.allOnlineExcluded.add(pid);
            await finalizePosterOutcome(ctx, pid, runId, 'STOPPED', '已停止');
          } else if (err instanceof PosterAccountRestrictedError) {
            ctx.allOnlineExcluded.add(pid);
            const restrictReason = err.message || '受限 · 需要手机验证或操作受限';
            recordPosterFailure(ctx, pid, restrictReason, failInfo);
            await finalizePosterOutcome(ctx, pid, runId, 'FAILED', restrictReason, true);
          } else {
            const failReason = `发帖中断 · ${msg.slice(0, 80)}`;
            recordPosterFailure(ctx, pid, failReason, failInfo);
            await finalizePosterOutcome(ctx, pid, runId, 'FAILED', failReason);
          }
        } finally {
          if (ctx.inFlightByWorker.has(pid)) await handleClaimedItemSkipped(ctx, pid, isAborted());
          ctx.starting.delete(pid);
          releaseClaimed();
          ctx.active.delete(pid);
          if (slotAcquired) ctx.slotsInUse = Math.max(0, ctx.slotsInUse - 1);
          if (workerPromise && ctx.workers.get(pid) === workerPromise) ctx.workers.delete(pid);
          await settleRunningPosterTasks(ctx);
          if (!ctx.hasActiveExecution()) {
            ctx.queuedKeys.clear();
            ctx.sharedFiles.clear();
            const participants = [...ctx.sessionParticipants];
            ctx.sessionParticipants.clear();
            const allRestricted =
              participants.length > 0 &&
              participants.every((id) => ctx.profiles.get(id)?.restricted === true);
            ctx.statusText = allRestricted
              ? '全部所选浏览器均受限，已停止小组发帖'
              : !ctx.taskQueue.length
                ? '小组发帖队列已全部完成'
                : '本轮小组发帖已结束';
          }
        }
      },
    );
    ctx.workers.set(pid, workerPromise);
  }
}

export async function runScheduledPosterProfileStep(
  ctx: PosterRuntimeContext,
  input: {
    profileId: string;
    materialIds: string[];
    groupIds: string[];
    maxGroupsPerProfile: number;
    materialsPerGroup?: number;
    onProgress: (status: string, sessionPosted: number) => void;
  },
): Promise<{ postedCount: number; status: string; hardBlocked: boolean; softIssue: boolean }> {
  ctx.assertAllowed();
  const { profileId, onProgress } = input;
  const fail = (status: string, softIssue = true) => ({
    postedCount: 0,
    status,
    hardBlocked: false,
    softIssue,
  });
  const [allGroups, allMaterials, rawSettings, todayCounts] = await Promise.all([
    ctx.repo.targets(),
    ctx.repo.materials(),
    ctx.repo.settings(),
    ctx.repo.todayCounts(),
  ]);
  const selectedGroups = allGroups.filter((g) => input.groupIds.includes(g.id));
  const rawMaterials = allMaterials.filter((m) => input.materialIds.includes(m.id));
  if (!selectedGroups.length || !rawMaterials.length)
    return fail('跳过：未找到有效的发帖素材卡或目标小组');

  onProgress('正在校验发帖素材文件…', 0);
  const preparedMaterials: PosterMaterial[] = [];
  const localFiles: string[] = [];
  for (let i = 0; i < rawMaterials.length; i++) {
    const mat = rawMaterials[i];
    if (!mat) continue;
    onProgress(`正在准备发帖素材 (${i + 1}/${rawMaterials.length})…`, 0);
    try {
      const readyMat = await ensurePosterMaterialPrepared(ctx, mat);
      preparedMaterials.push(readyMat);
      if (readyMat.localFilePath) localFiles.push(readyMat.localFilePath);
    } catch {
      /* Skip broken card */
    }
  }
  if (!preparedMaterials.length) return fail('跳过：所选发帖素材文件不可用');
  if (
    !(await ensureBrowserProfileOnline(
      profileId,
      () => ctx.runner.ready(profileId),
      ctx.profileLifecycle,
      () => onProgress('正在唤醒浏览器连接…', 0),
    ))
  )
    return fail('浏览器未就绪或连接断开');

  const perGroupLimit = Math.max(1, input.materialsPerGroup ?? rawSettings.materialsPerGroup ?? 1);
  const privateQueue: GroupPosterTaskItem[] = [];
  for (const group of selectedGroups) {
    let queued = 0;
    for (const material of preparedMaterials) {
      if (queued >= perGroupLimit) break;
      if (!(await ctx.repo.hasGroupPostedMaterial(group.id, material.id))) {
        privateQueue.push({ group, material, allowedProfileIds: new Set([profileId]) });
        queued++;
      }
    }
  }
  if (!privateQueue.length) return fail('所选小组已发过所选素材，自动跳过', false);
  if (ctx.isProfileRunning(profileId)) return fail('跳过：该浏览器正在执行其他发帖任务');

  const maxPosts = Math.max(1, input.maxGroupsPerProfile) * perGroupLimit;
  const scopedSettings: PosterSettings = {
    ...rawSettings,
    maxPostsPerAccount: maxPosts,
    materialsPerGroup: perGroupLimit,
  };
  const runId = globalThis.crypto.randomUUID();
  ctx.cancelled.delete(profileId);
  ctx.active.add(profileId);
  ctx.profileRunIds.set(profileId, runId);
  const stat: PosterProfileStat = {
    today: todayCounts[profileId] ?? 0,
    session: 0,
    status: '准备发帖…',
    running: true,
    restricted: false,
  };
  ctx.profiles.set(profileId, stat);

  let hardBlocked = false;
  let softIssue = false;
  await runTrackedScheduledWorker(
    ctx.workers,
    profileId,
    (async () => {
      try {
        while (!ctx.cancelled.has(profileId) && stat.session < maxPosts && privateQueue.length) {
          await ctx.runner.runProfileWorker(profileId, localFiles, scopedSettings, {
            runId,
            cancelled: () => ctx.cancelled.has(profileId),
            status: (text) => {
              stat.status = text;
              onProgress(text, stat.session);
            },
            claimNextTask: async () => {
              while (privateQueue.length && !ctx.cancelled.has(profileId)) {
                const [item] = privateQueue.splice(
                  Math.floor(Math.random() * privateQueue.length),
                  1,
                );
                if (
                  item &&
                  !(await ctx.repo.hasGroupPostedMaterial(item.group.id, item.material.id))
                )
                  return item;
              }
              return null;
            },
            returnTaskOnRestriction: () => {},
            onTargetError: (groupId, reason) =>
              recordPosterFailure(ctx, profileId, reason, {
                id: groupId,
                name:
                  groupId === '__page_timeline__'
                    ? ''
                    : (selectedGroups.find((g) => g.id === groupId)?.name ?? ''),
              }),
            onTaskPosted: async (log) => {
              await ctx.repo.recordPost(log);
              stat.today += 1;
              stat.session += 1;
              stat.status = `已发帖 (${stat.session}/${maxPosts}) · ${log.groupName}`;
              onProgress(stat.status, stat.session);
            },
            canContinueAccount: async () =>
              stat.session < maxPosts && !ctx.cancelled.has(profileId),
          });
        }
        stat.running = false;
        stat.status = ctx.cancelled.has(profileId)
          ? '已停止'
          : `已完成 · 本轮发帖 ${stat.session} 条`;
        await finalizePosterOutcome(
          ctx,
          profileId,
          runId,
          ctx.cancelled.has(profileId) ? 'STOPPED' : 'COMPLETED',
          stat.status,
        );
      } catch (err) {
        const msg = errMsg(err);
        stat.running = false;
        if (ctx.cancelled.has(profileId)) stat.status = '已停止';
        else if (err instanceof PosterAccountRestrictedError) {
          stat.restricted = true;
          stat.status = err.message || '受限 · 操作受限';
          if (err.scope === 'global_route' || err.abnormalState !== 'restricted')
            hardBlocked = true;
          else softIssue = true;
        } else if (/未登录|登录失效|验证页面|checkpoint|login/i.test(msg)) {
          hardBlocked = true;
          stat.status = msg.slice(0, 100);
        } else {
          softIssue = true;
          stat.status = `发帖局部跳过 · ${msg.slice(0, 80)}`;
        }
        if (!ctx.cancelled.has(profileId)) recordPosterFailure(ctx, profileId, stat.status);
        await finalizePosterOutcome(
          ctx,
          profileId,
          runId,
          ctx.cancelled.has(profileId) ? 'STOPPED' : 'FAILED',
          stat.status,
          stat.restricted,
        );
      } finally {
        ctx.active.delete(profileId);
      }
    })(),
  );
  return { postedCount: stat.session, status: stat.status, hardBlocked, softIssue };
}
