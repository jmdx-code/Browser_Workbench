import {
  formatPosterCaptionPreview,
  type PosterMaterial,
  type PosterProfileStat,
  type PosterSettings,
} from '../../shared/group-poster.js';
import {
  acquireCarrierSlotAndLaunch,
  acquireOnlineBrowserPermit,
  checkRiskLimitSafe,
  createEnsureOnlineLaunch,
  ensureBrowserProfileOnline,
  errMsg,
  persistProfileTaskResult,
  pickRandomFreeJob,
  recordPostBumpFailure,
  runTrackedScheduledWorker,
} from '../module-worker-pool.js';
import { isWorkAbortError, sleepAbortable } from '../workboard.js';
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
const checkPosterDailyRisk = (ctx: PosterRuntimeContext, pid: string) =>
  checkRiskLimitSafe(ctx.checkDailyRiskLimit, pid, 'post');
const setPosterStat = (
  ctx: PosterRuntimeContext,
  pid: string,
  running: boolean,
  status: string,
  extra?: Partial<PosterProfileStat>,
) => {
  const cur = ctx.profiles.get(pid);
  ctx.profiles.set(pid, {
    today: cur?.today ?? 0,
    session: cur?.session ?? 0,
    status,
    running,
    ...extra,
  });
};
const createClaimedTracker = (activeGroupIds: Set<string>) => {
  const claimed = new Set<string>();
  return {
    claimed,
    claim: (id: string) => {
      claimed.add(id);
      activeGroupIds.add(id);
    },
    release: (extraId?: string) => {
      for (const gid of claimed) activeGroupIds.delete(gid);
      claimed.clear();
      if (extraId) activeGroupIds.delete(extraId);
    },
  };
};
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
  setPosterStat(ctx, pid, false, reason, { restricted });
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
      status: '排队等待并发槽位…',
      running: true,
      restricted: false,
    });
    let workerPromise: Promise<void> | undefined;
    workerPromise = ctx.workboard.runSoldier(
      { carrierId: pid, carrierKind: 'browser', moduleId: 'group-poster' },
      async (soldier) => {
        if (!needsLaunch) await Promise.resolve();
        const runId = ctx.profileRunIds.get(pid) ?? batchRunId;
        let releaseBrowserPermit: (() => void) | undefined;
        const { claimed: currentClaimed, release: releaseClaimed } = createClaimedTracker(
          ctx.activeGroupIds,
        );
        const isAborted = () => ctx.cancelled.has(pid) || soldier.signal.aborted;
        const hasPendingWork = () =>
          hasEligibleQueueItem(ctx, pid) || hasEligibleInFlightItem(ctx, pid);
        const checkLimit = async () =>
          !hasPendingWork()
            ? { allowed: false, reason: '队列已完成' }
            : checkPosterDailyRisk(ctx, pid);
        const finish = (
          state: 'COMPLETED' | 'STOPPED' | 'FAILED',
          reason: string,
          restricted = false,
        ) => finalizePosterOutcome(ctx, pid, runId, state, reason, restricted);
        try {
          if (isAborted() || !hasPendingWork()) {
            ctx.starting.delete(pid);
            setPosterStat(ctx, pid, false, isAborted() ? '已停止' : '队列已完成');
            return;
          }
          const preCap = await checkLimit();
          if (!preCap.allowed) {
            ctx.starting.delete(pid);
            ctx.allOnlineExcluded.add(pid);
            return void (await finish(
              'COMPLETED',
              preCap.reason ?? '今日已达浏览器发帖日限额，自动跳过保护',
            ));
          }
          const setRunStat = (status: string, extra?: Partial<PosterProfileStat>) => {
            const cur = ctx.profiles.get(pid);
            setPosterStat(ctx, pid, true, status, { restricted: cur?.restricted, ...extra });
          };
          const acquired = await acquireCarrierSlotAndLaunch({
            carrierKind: 'browser',
            carrierId: pid,
            moduleId: 'group-poster',
            workboard: ctx.workboard,
            signal: soldier.signal,
            featureExecution: ctx.registry,
            checkDailyLimit: checkLimit,
            isReady: (id) => ctx.runner.ready(id),
            launch: createEnsureOnlineLaunch(ctx.profileLifecycle, (id) => ctx.runner.ready(id)),
            onQueued: () => !isAborted() && setRunStat('排队等待并发槽位…'),
            onLaunching: () => !isAborted() && setRunStat('正在启动浏览器…', { restricted: false }),
          });
          if (!acquired.ok) {
            ctx.starting.delete(pid);
            if (isAborted() || !hasPendingWork()) {
              setPosterStat(ctx, pid, false, isAborted() ? '已停止' : '队列已完成');
              return;
            }
            if (acquired.skipped) {
              ctx.allOnlineExcluded.add(pid);
              return void (await finish('COMPLETED', acquired.reason));
            }
            recordPosterFailure(ctx, pid, acquired.reason);
            return void (await finish('FAILED', acquired.reason));
          }
          releaseBrowserPermit = acquired.releasePermit;
          ctx.starting.delete(pid);
          ctx.active.add(pid);
          let riskLimitReason: string | null = null;
          while (
            !isAborted() &&
            !riskLimitReason &&
            (ctx.profiles.get(pid)?.session ?? 0) < settings.maxPostsPerAccount &&
            hasPendingWork()
          ) {
            const cap = await checkPosterDailyRisk(ctx, pid);
            if (!cap.allowed) {
              riskLimitReason = cap.reason ?? '今日已达浏览器发帖日限额，自动跳过保护';
              break;
            }
            await ctx.runner.runProfileWorker(pid, [...ctx.sharedFiles], settings, {
              runId,
              cancelled: isAborted,
              status: (text) => {
                setRunStat(text);
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
              canContinueAccount: async (workerPid) => {
                if ((ctx.profiles.get(workerPid)?.session ?? 0) >= settings.maxPostsPerAccount)
                  return false;
                const cap = await checkPosterDailyRisk(ctx, workerPid);
                if (!cap.allowed) {
                  riskLimitReason = cap.reason ?? '今日已达浏览器发帖日限额，自动跳过保护';
                  return false;
                }
                return true;
              },
            });
          }
          const finalStat = ctx.profiles.get(pid);
          const wasCancelled = isAborted();
          const reachedQuota = (finalStat?.session ?? 0) >= settings.maxPostsPerAccount;
          if (wasCancelled || reachedQuota || riskLimitReason) ctx.allOnlineExcluded.add(pid);
          const finalStatus = wasCancelled
            ? '已手动停止'
            : (riskLimitReason ??
              (reachedQuota
                ? `已达本轮上限 (${finalStat?.session ?? 0}/${settings.maxPostsPerAccount})`
                : `已完成 · 本轮发帖 ${finalStat?.session ?? 0} 条`));
          await finish(wasCancelled ? 'STOPPED' : 'COMPLETED', finalStatus);
        } catch (err) {
          const msg = errMsg(err);
          const claimed = ctx.inFlightByWorker.get(pid);
          const failInfo = claimed
            ? { name: claimed.group.name, caption: claimed.material.caption }
            : undefined;
          if (isAborted() || isWorkAbortError(err)) {
            ctx.allOnlineExcluded.add(pid);
            await finish('STOPPED', '已停止');
          } else if (err instanceof PosterAccountRestrictedError) {
            ctx.allOnlineExcluded.add(pid);
            const restrictReason = err.message || '受限 · 需要手机验证或操作受限';
            recordPosterFailure(ctx, pid, restrictReason, failInfo);
            await finish('FAILED', restrictReason, true);
          } else {
            const failReason = `发帖中断 · ${msg.slice(0, 80)}`;
            recordPosterFailure(ctx, pid, failReason, failInfo);
            await finish('FAILED', failReason);
          }
        } finally {
          if (ctx.inFlightByWorker.has(pid)) await handleClaimedItemSkipped(ctx, pid, isAborted());
          ctx.starting.delete(pid);
          releaseClaimed();
          ctx.active.delete(pid);
          releaseBrowserPermit?.();
          ctx.closingCount += 1;
          try {
            if (workerPromise && ctx.workers.get(pid) === workerPromise) ctx.workers.delete(pid);
            await settleRunningPosterTasks(ctx);
            await ctx.onWorkerSettled?.();
          } finally {
            ctx.closingCount = Math.max(0, ctx.closingCount - 1);
          }
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
  const preCap = await checkPosterDailyRisk(ctx, profileId);
  if (!preCap.allowed)
    return fail(preCap.reason ?? '今日已达浏览器发帖日限额，自动跳过保护', false);
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
  let earlyFail: {
    postedCount: number;
    status: string;
    hardBlocked: boolean;
    softIssue: boolean;
  } | null = null;
  await runTrackedScheduledWorker(
    ctx.workers,
    profileId,
    ctx.workboard.runSoldier(
      { carrierId: profileId, carrierKind: 'browser', moduleId: 'group-poster' },
      async (soldier) => {
        let releasePermit: (() => void) | undefined;
        const { claim: claimGroup, release: releaseClaimed } = createClaimedTracker(
          ctx.activeGroupIds,
        );
        const isAborted = () => ctx.cancelled.has(profileId) || soldier.signal.aborted;
        const finishStep = (
          state: 'COMPLETED' | 'STOPPED' | 'FAILED',
          reason: string,
          restricted = false,
        ) => finalizePosterOutcome(ctx, profileId, runId, state, reason, restricted);
        try {
          const { releasePermit: rel, online } = await acquireOnlineBrowserPermit(
            ctx.workboard,
            profileId,
            soldier.signal,
            () => ctx.runner.ready(profileId),
            ctx.profileLifecycle,
            () => onProgress('正在唤醒浏览器连接…', 0),
          );
          releasePermit = rel;
          if (!online) {
            stat.running = false;
            earlyFail = fail('浏览器未就绪或连接断开');
            return;
          }
          let riskLimitReason: string | null = null;
          while (
            !isAborted() &&
            !riskLimitReason &&
            stat.session < maxPosts &&
            privateQueue.length
          ) {
            const cap = await checkPosterDailyRisk(ctx, profileId);
            if (!cap.allowed) {
              riskLimitReason = cap.reason ?? '今日已达浏览器发帖日限额，自动跳过保护';
              break;
            }
            await ctx.runner.runProfileWorker(profileId, localFiles, scopedSettings, {
              runId,
              cancelled: isAborted,
              status: (text) => {
                stat.status = text;
                onProgress(text, stat.session);
              },
              claimNextTask: async () => {
                releaseClaimed();
                const item = await pickRandomFreeJob(
                  privateQueue,
                  ctx.activeGroupIds,
                  isAborted,
                  () => sleepAbortable(100, soldier.signal),
                  (c) => ctx.repo.hasGroupPostedMaterial(c.group.id, c.material.id),
                );
                if (item) claimGroup(item.group.id);
                return item;
              },
              onGroupIdResolved: (rawId, canonId) => {
                if (canonId && canonId !== rawId) claimGroup(canonId);
              },
              returnTaskOnRestriction: (task) => {
                releaseClaimed(task.group.id);
                if (!isAborted()) privateQueue.push(task);
              },
              onTargetError: (groupId, reason) =>
                recordPosterFailure(ctx, profileId, reason, {
                  id: groupId,
                  name:
                    groupId === '__page_timeline__'
                      ? ''
                      : (selectedGroups.find((g) => g.id === groupId)?.name ?? ''),
                }),
              onTaskPosted: async (log) => {
                releaseClaimed(log.groupId);
                await ctx.repo.recordPost(log);
                stat.today += 1;
                stat.session += 1;
                stat.status = `已发帖 (${stat.session}/${maxPosts}) · ${log.groupName}`;
                onProgress(stat.status, stat.session);
              },
              canContinueAccount: async () => {
                if (stat.session >= maxPosts || isAborted()) return false;
                const cap = await checkPosterDailyRisk(ctx, profileId);
                if (!cap.allowed) {
                  riskLimitReason = cap.reason ?? '今日已达浏览器发帖日限额，自动跳过保护';
                  return false;
                }
                return true;
              },
            });
          }
          stat.running = false;
          stat.status = isAborted()
            ? '已停止'
            : (riskLimitReason ?? `已完成 · 本轮发帖 ${stat.session} 条`);
          await finishStep(isAborted() ? 'STOPPED' : 'COMPLETED', stat.status);
        } catch (err) {
          const msg = errMsg(err);
          stat.running = false;
          if (isAborted() || isWorkAbortError(err)) stat.status = '已停止';
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
          if (!isAborted() && !isWorkAbortError(err))
            recordPosterFailure(ctx, profileId, stat.status);
          await finishStep(
            isAborted() || isWorkAbortError(err) ? 'STOPPED' : 'FAILED',
            stat.status,
            stat.restricted,
          );
        } finally {
          releaseClaimed();
          releasePermit?.();
          ctx.active.delete(profileId);
        }
      },
    ),
  );
  return earlyFail ?? { postedCount: stat.session, status: stat.status, hardBlocked, softIssue };
}
