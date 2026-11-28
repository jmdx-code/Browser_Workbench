import { ProductError, failError } from '../../domain/workspace.js';
import {
  StartBluestacksActiveInput,
  StartBluestacksInviterInput,
  StartBluestacksPosterInput,
  type BluestacksModuleProfileStat,
} from '../../shared/bluestacks.js';
import { devDiag } from '../../shared/dev-diagnostics.js';
import type { BumperTarget } from '../../shared/group-bumper.js';
import { formatPosterCaptionPreview, type PosterMaterial } from '../../shared/group-poster.js';
import { buildStaggeredBumperQueues } from '../group-bumper-service.js';
import {
  errMsg,
  ignoreError,
  shuffleArray,
  sortTargetsOnlineFirst,
} from '../module-worker-pool.js';
import { stopBumper } from './bs-bumper.js';
import { ensureInstanceOnlineForManualAction, stopInstanceOps } from './bs-instance-ops.js';
import { stopBatchLogin } from './bs-batch-login.js';
import { stopHealthCheck } from './bs-patrols.js';
import {
  type BluestacksActiveRunnerPort,
  type BluestacksActiveStepParam,
  type BluestacksServiceContext,
  classifyBsWorkerError,
  closeInstanceIfIdleAfterFinish,
  deleteAllBsStats,
  getDiscoverySnapshot,
  guardInstanceRiskQuota,
  hasExtraExecution,
  invalidateDiscoveryCache,
  isInstanceConflictingWorker,
  isProfileRunning,
  prepareIdlePortraitInstances,
  recordBsFailure,
  runWithBsSoldier,
  saveLastStatusSafe,
  setBsStat,
  stopExtraWorkers,
  triggerRiskQuotaAbort,
  withBsCarrierPermit,
  withTrackedDeviceOp,
} from './bs-types.js';
export const recordBsPosterTargetFailure = (
  ctx: BluestacksServiceContext,
  instanceId: string,
  info: {
    groupId: string;
    groupName: string;
    isTimeline: boolean;
    material: PosterMaterial;
    reason: string;
  },
  extra?: { accountId?: string; accountName?: string; pageId?: string; pageName?: string },
): void =>
  recordBsFailure(ctx, {
    recordType: 'post',
    carrier: 'bluestacks',
    status: 'failed',
    profileId: instanceId,
    ...(extra?.accountId !== undefined ? { accountId: extra.accountId } : {}),
    ...(extra?.accountName !== undefined ? { accountName: extra.accountName } : {}),
    groupId: info.isTimeline ? '' : info.groupId,
    groupName: info.isTimeline ? '专页时间线' : info.groupName,
    ...(extra?.pageId !== undefined ? { pageId: extra.pageId } : {}),
    ...(extra?.pageName !== undefined ? { pageName: extra.pageName } : {}),
    captionPreview: formatPosterCaptionPreview(info.material.caption),
    errorReason: info.reason.slice(0, 120),
  });
export async function prepareBsPosterMaterials(
  ctx: BluestacksServiceContext,
  materials: readonly PosterMaterial[],
  opts?: {
    signal?: AbortSignal;
    onProgress?: (i: number, total: number) => void;
    throwProductError?: boolean;
  },
): Promise<PosterMaterial[] | { error: string }> {
  const prepared: PosterMaterial[] = [];
  for (let i = 0; i < materials.length; i++) {
    if (opts?.signal?.aborted) return { error: '已停止' };
    const mat = materials[i];
    if (!mat) continue;
    opts?.onProgress?.(i + 1, materials.length);
    if (ctx.extra?.ensurePosterMaterialLocal && mat.mediaSource.trim()) {
      try {
        prepared.push(await ctx.extra.ensurePosterMaterialLocal(mat));
      } catch (err) {
        const msg = errMsg(err);
        if (opts?.throwProductError)
          failError('POSTER_MEDIA_PREPARE_FAILED', `发帖素材媒体准备失败：${msg}`, 409);
        return { error: `发帖素材准备失败：${msg}` };
      }
    } else prepared.push(mat);
  }
  return prepared;
}
export const makeActiveActionRecorder =
  (
    ctx: BluestacksServiceContext,
    instanceId: string,
    ctrl: AbortController,
    onLikeOrAction?: (kind: 'like' | 'post' | 'action') => void,
    hasPostRecords?: boolean,
  ) =>
  (kind: 'like' | 'post' | 'action' = 'like') => {
    onLikeOrAction?.(kind);
    void ignoreError(
      Promise.resolve(
        kind === 'post' && hasPostRecords
          ? undefined
          : ctx.repo.recordDailyActiveAction?.(instanceId, kind === 'like' ? 'like' : 'action', 1),
      ).then(() => {
        triggerRiskQuotaAbort(
          ctx,
          instanceId,
          kind === 'like' ? 'active-like' : kind === 'post' ? 'post' : undefined,
          ctrl,
        );
      }),
    );
  };
export function createBsActiveCallbacks(
  ctx: BluestacksServiceContext,
  id: string,
  steps: readonly BluestacksActiveStepParam[],
  ctrl: AbortController,
  opts?: {
    combinationId?: string | null | undefined;
    closeOnFinish?: boolean | undefined;
    onProgress?: (status: string) => void;
    onStatusUpdate?: (text: string) => void;
  },
): Parameters<BluestacksActiveRunnerPort['run']>[3] {
  const buildSteps = (activeIdx: number) =>
    steps.map((s, idx) => ({
      label: describeBsActiveStep(s),
      state: (idx < activeIdx ? 'done' : idx === activeIdx ? 'running' : 'pending') as
        'done' | 'running' | 'pending',
    }));
  setBsStat(ctx.activeProfileStats, id, {
    running: true,
    status: steps[0] ? `准备执行 ${describeBsActiveStep(steps[0])}` : '启动中…',
    ...(opts?.combinationId !== undefined ? { combinationId: opts.combinationId } : {}),
    ...(opts?.closeOnFinish !== undefined ? { closeOnFinish: opts.closeOnFinish } : {}),
    steps: buildSteps(0),
  });
  return {
    onStepChange: (stepIdx) =>
      setBsStat(ctx.activeProfileStats, id, {
        running: true,
        status: ctx.activeProfileStats.get(id)?.status ?? '执行中…',
        steps: buildSteps(stepIdx),
      }),
    status: (text) => {
      setBsStat(ctx.activeProfileStats, id, { running: true, status: text });
      opts?.onStatusUpdate?.(text);
      opts?.onProgress?.(text);
    },
    action: makeActiveActionRecorder(
      ctx,
      id,
      ctrl,
      (kind) => {
        const cur = ctx.activeProfileStats.get(id);
        if (cur) {
          cur.session += 1;
          if (kind === 'like' || kind === 'post') cur.today += 1;
        }
      },
      Boolean(ctx.postBumpRecords),
    ),
    checkRiskLimit: async (kind) => {
      const blocked = await guardInstanceRiskQuota(
        ctx,
        id,
        kind === 'like' ? 'active-like' : kind === 'post' ? 'post' : undefined,
        false,
      );
      return { allowed: !blocked, reason: blocked };
    },
    recordPostResult: async (entry) => {
      await ignoreError(
        ctx.postBumpRecords?.insert({
          recordType: 'post',
          carrier: 'bluestacks',
          status: entry.status,
          profileId: id,
          accountId: entry.accountId ?? '',
          accountName: entry.accountName ?? '',
          groupId: entry.isStory ? '__story__' : '__page_timeline__',
          groupName: entry.isStory ? '个人/专页快拍' : '个人/专页时间线',
          captionPreview: entry.captionPreview,
          errorReason: entry.errorReason ?? '',
        }),
      );
    },
    onProgressDelta: (d) =>
      void ignoreError(ctx.extra?.recordActiveProgress?.({ profileId: id, ...d, at: Date.now() })),
  };
}
function setExtraStatusText(
  ctx: BluestacksServiceContext,
  kind: 'active' | 'poster' | 'inviter',
  text: string,
): void {
  if (kind === 'active') ctx.activeStatusText = text;
  else if (kind === 'poster') ctx.posterStatusText = text;
  else ctx.inviterStatusText = text;
}
async function runExtraConcurrentBatch(
  ctx: BluestacksServiceContext,
  kind: 'active' | 'poster' | 'inviter',
  instanceIds: readonly string[],
  statsMap: Map<string, BluestacksModuleProfileStat>,
  workFn: (instanceId: string, signal: AbortSignal, ctrl: AbortController) => Promise<string>,
  closeWindowOnFinish?: boolean,
): Promise<void> {
  const cap = Math.max(1, ctx.workboard.bluestacksPermits.max);
  const { instances } = await getDiscoverySnapshot(ctx, false);
  const instMap = new Map(instances.map((i) => [i.id, i]));
  const orderedIds = await sortTargetsOnlineFirst(instanceIds, (id) =>
    Boolean(instMap.get(id)?.online),
  );
  const queue: string[] = [];
  const controllers = new Map<string, AbortController>();
  const markConflictSkip = (id: string) =>
    setBsStat(statsMap, id, { running: false, status: '跳过：窗口正忙于其他任务' });
  for (const id of orderedIds) {
    if (isInstanceConflictingWorker(ctx, id)) {
      markConflictSkip(id);
      continue;
    }
    const ctrl = new AbortController();
    controllers.set(id, ctrl);
    queue.push(id);
    ctx.queuedExtraTasks.set(id, { kind, controller: ctrl, statsMap });
    statsMap.set(id, {
      running: true,
      status: '排队等待并发槽位…',
      session: 0,
      today: statsMap.get(id)?.today ?? 0,
    });
  }
  const launchOne = async (id: string) => {
    const ctrl = controllers.get(id);
    if (!ctrl || ctrl.signal.aborted)
      return void statsMap.set(id, { running: false, status: '已停止', session: 0, today: 0 });
    let finalSummary: string | null = null;
    try {
      await runWithBsSoldier(ctx, id, `bluestacks-${kind}`, ctrl, () =>
        withBsCarrierPermit(ctx, id, ctrl.signal, async () => {
          await ensureInstanceOnlineForManualAction(ctx, id, ctrl.signal, (msg) => {
            setBsStat(statsMap, id, { running: true, status: msg });
            setExtraStatusText(ctx, kind, msg);
          });
          if (ctrl.signal.aborted) throw new Error('TASK_STOPPED');
          const summary = await workFn(id, ctrl.signal, ctrl);
          if (closeWindowOnFinish) {
            finalSummary = summary;
            setBsStat(statsMap, id, { running: true, status: `${summary} · 正在关窗…` });
          } else {
            setBsStat(statsMap, id, { running: false, status: summary });
            await saveLastStatusSafe(ctx, id, summary);
          }
        }),
      );
    } catch (err) {
      finalSummary = null;
      const { riskReason, rawMsg, stopped } = classifyBsWorkerError(ctrl, err);
      setBsStat(statsMap, id, {
        running: false,
        status: riskReason ?? (stopped ? '已停止' : rawMsg),
      });
      if (!riskReason && !stopped && kind === 'poster')
        recordBsFailure(ctx, {
          recordType: 'post',
          carrier: 'bluestacks',
          status: 'failed',
          profileId: id,
          errorReason: rawMsg.slice(0, 120),
        });
      await saveLastStatusSafe(
        ctx,
        id,
        riskReason ?? (stopped ? '上次已停止' : `上次异常 · ${rawMsg.slice(0, 80)}`),
      );
    } finally {
      if (ctx.extraWorkers.get(id)?.controller === ctrl) ctx.extraWorkers.delete(id);
      if (closeWindowOnFinish) {
        const closed = await closeInstanceIfIdleAfterFinish(ctx, id, true, (closeErr) =>
          devDiag.emit('WARN', 'TASK_RUNNER', 'BLUESTACKS_FINISH_CLOSE_FAILED', {
            reason: errMsg(closeErr),
            data: { instanceId: id, kind },
          }),
        );
        invalidateDiscoveryCache(ctx);
        if (finalSummary !== null) {
          const doneStatus = closed ? `${finalSummary} · 已关闭窗口` : finalSummary;
          setBsStat(statsMap, id, { running: false, status: doneStatus });
          await saveLastStatusSafe(ctx, id, doneStatus);
        }
      }
    }
  };
  const pump = async () => {
    while (queue.length) {
      const nextId = queue.shift();
      if (!nextId) break;
      const queuedEntry = ctx.queuedExtraTasks.get(nextId);
      const ctrl = controllers.get(nextId);
      if (queuedEntry?.controller === ctrl) ctx.queuedExtraTasks.delete(nextId);
      if (!ctrl || ctrl.signal.aborted) {
        setBsStat(statsMap, nextId, { running: false, status: '已停止' });
        continue;
      }
      if (isInstanceConflictingWorker(ctx, nextId)) {
        markConflictSkip(nextId);
        continue;
      }
      const entry = { kind, controller: ctrl, promise: Promise.resolve() };
      ctx.extraWorkers.set(nextId, entry);
      const p = launchOne(nextId);
      entry.promise = p;
      await p;
    }
  };
  const endText =
    kind === 'active'
      ? '蓝蝶活跃账号运行结束'
      : kind === 'poster'
        ? '蓝蝶小组发帖运行结束'
        : '蓝蝶小组邀请人运行结束';
  void Promise.allSettled(
    Array.from({ length: Math.min(cap, Math.max(1, queue.length)) }, pump),
  ).then(() => {
    if (!hasExtraExecution(ctx, kind)) setExtraStatusText(ctx, kind, endText);
  });
}
const describeBsActiveStep = (s: BluestacksActiveStepParam): string =>
  s.type === 'feed'
    ? `浏览首页 (${s.durationMinutes ?? 3}分)`
    : s.type === 'video'
      ? `浏览 Reels (${s.durationMinutes ?? 3}分)`
      : s.type === 'marketplace'
        ? `浏览商城 (${s.durationMinutes ?? 3}分)`
        : s.type === 'friends'
          ? `接受好友 (${s.maxAccepts ?? 5}个)`
          : s.type === 'story'
            ? '发布快拍'
            : '发时间线贴';
export function materializeActiveSteps(plan: {
  baseSteps: readonly BluestacksActiveStepParam[];
  rounds: number;
  randomOrder: boolean;
}): BluestacksActiveStepParam[] {
  const steps: BluestacksActiveStepParam[] = [];
  for (let r = 0; r < plan.rounds; r++) {
    steps.push(
      ...(plan.randomOrder && plan.baseSteps.length > 1
        ? shuffleArray(plan.baseSteps)
        : plan.baseSteps),
    );
  }
  return steps;
}
export async function resolveActivePlan(
  ctx: BluestacksServiceContext,
  input: { combinationId?: string; quickStep?: BluestacksActiveStepParam },
): Promise<{ baseSteps: BluestacksActiveStepParam[]; rounds: number; randomOrder: boolean }> {
  if (input.quickStep) return { baseSteps: [input.quickStep], rounds: 1, randomOrder: false };
  if (!input.combinationId)
    throw new ProductError('ACTIVE_STEPS_EMPTY', '请指定活跃任务组合或快捷单步动作', 400);
  const combos = ctx.extra?.listCombinations ? await ctx.extra.listCombinations() : [];
  const saved = combos.find((c) => c.id === input.combinationId)?.saved;
  if (!saved || !saved.steps.length)
    throw new ProductError('COMBINATION_NOT_FOUND', '未找到有效的已保存任务组合', 404);
  if (saved.loop.mode === 'until-stopped')
    failError(
      'BLUESTACKS_UNTIL_STOPPED_UNSUPPORTED',
      '蓝蝶活跃暂不支持“直到手动停止”循环组合，请改用指定轮数或快捷单步动作',
      400,
    );
  const baseSteps: BluestacksActiveStepParam[] = [];
  let skippedPost = 0;
  let skippedFriend = 0;
  for (const s of saved.steps) {
    if (s.type === 'feed')
      baseSteps.push({
        type: 'feed',
        ...(s.feedMode ? { feedMode: s.feedMode } : {}),
        durationMinutes: s.durationMinutes,
        maxLikes: s.maxLikes,
        ...(s.likeProbability !== undefined ? { likeProbability: s.likeProbability } : {}),
      });
    else if (s.type === 'video' || s.type === 'marketplace')
      baseSteps.push({
        type: s.type,
        durationMinutes: s.durationMinutes,
        ...(s.type === 'video' ? { maxLikes: s.maxLikes } : {}),
        ...(s.type === 'video' && s.likeProbability !== undefined
          ? { likeProbability: s.likeProbability }
          : {}),
      });
    else if (s.type === 'friends') {
      if (s.friendAction === 'add_suggested') skippedFriend++;
      else
        baseSteps.push({
          type: 'friends',
          friendAction: 'accept',
          durationMinutes: s.durationMinutes,
          maxAccepts:
            s.acceptMode === 'all' ? Math.max(50, s.maxAccepts ?? 50) : (s.maxAccepts ?? 5),
        });
    } else if (s.type === 'post') skippedPost++;
  }
  if (!baseSteps.length) {
    const friendOnly = skippedFriend > 0 && !skippedPost;
    failError(
      friendOnly ? 'BLUESTACKS_UNSUPPORTED_STEP' : 'COMBINATION_EMPTY',
      friendOnly
        ? '蓝蝶端暂不支持「加推荐好友」，请改在浏览器端「活跃账号」执行'
        : skippedPost > 0
          ? '该组合仅包含需资源表的发帖/快拍或蓝蝶暂不支持的步骤，请改用「蓝蝶小组发帖」或上方「快捷单步」'
          : '该组合中没有可在蓝蝶执行的步骤',
      400,
    );
  }
  return {
    baseSteps,
    rounds: Math.max(1, Math.min(5, saved.loop.rounds)),
    randomOrder: saved.randomOrder,
  };
}
export async function resolveActiveSteps(
  ctx: BluestacksServiceContext,
  input: { combinationId?: string; quickStep?: BluestacksActiveStepParam },
): Promise<BluestacksActiveStepParam[]> {
  return materializeActiveSteps(await resolveActivePlan(ctx, input));
}
export async function collectUnpostedPosterJobs(
  ctx: BluestacksServiceContext,
  grps: readonly BumperTarget[],
  mats: readonly PosterMaterial[],
  perGroupLimit = mats.length,
): Promise<Array<{ group: BumperTarget; material: PosterMaterial }>> {
  const pendingJobs: Array<{ group: BumperTarget; material: PosterMaterial }> = [];
  for (const grp of grps) {
    let queued = 0;
    for (const mat of mats) {
      if (queued >= perGroupLimit) break;
      const already = ctx.extra?.hasGroupPostedMaterial
        ? await Promise.resolve(ctx.extra.hasGroupPostedMaterial(grp.id, mat.id))
        : false;
      if (!already) {
        pendingJobs.push({ group: grp, material: mat });
        queued++;
      }
    }
  }
  return pendingJobs;
}
export function activeStepRiskChecks(
  steps: readonly BluestacksActiveStepParam[],
): Array<Parameters<typeof guardInstanceRiskQuota>[2]> {
  const checks: Array<Parameters<typeof guardInstanceRiskQuota>[2]> = [];
  if (steps.some((s) => s.type === 'feed' || s.type === 'video')) checks.push('active-like');
  if (steps.some((s) => s.type === 'post' || s.type === 'story')) checks.push('post');
  if (!checks.length || steps.some((s) => s.type === 'friends')) checks.push(undefined);
  return checks;
}
export const bumpBsStat = (
  statsMap: Map<string, BluestacksModuleProfileStat>,
  id: string,
  delta: number,
) => {
  const cur = statsMap.get(id);
  if (cur) {
    cur.session += delta;
    cur.today += delta;
  }
};
const activeRunnerCount = (ctx: BluestacksServiceContext, kind: 'active' | 'poster' | 'inviter') =>
  [...ctx.extraWorkers.values()].filter((w) => w.kind === kind).length;
export async function startActive(ctx: BluestacksServiceContext, input: unknown): Promise<void> {
  const parsed = StartBluestacksActiveInput.parse(input);
  const activeRunner = ctx.extra?.activeRunner;
  if (!activeRunner)
    throw new ProductError('BLUESTACKS_ACTIVE_UNAVAILABLE', '蓝蝶活跃执行器未就绪', 500);
  const activePlan = await resolveActivePlan(ctx, parsed);
  const { instances } = await getDiscoverySnapshot(ctx, true);
  let ready = parsed.instanceIds;
  for (const kind of activeStepRiskChecks(activePlan.baseSteps))
    if (ready.length)
      ready = await prepareIdlePortraitInstances(
        ctx,
        ready,
        instances,
        kind,
        ctx.activeProfileStats,
      );
  ctx.activeStatusText = `正在运行 ${ready.length} 个蓝蝶活跃任务…`;
  await runExtraConcurrentBatch(
    ctx,
    'active',
    ready,
    ctx.activeProfileStats,
    async (id, signal, ctrl) => {
      const steps = materializeActiveSteps(activePlan);
      const outcome = await activeRunner.run(
        id,
        steps,
        signal,
        createBsActiveCallbacks(ctx, id, steps, ctrl, {
          combinationId: parsed.combinationId ?? null,
          closeOnFinish: parsed.closeWindowOnFinish,
          onStatusUpdate: (text) => {
            const n = activeRunnerCount(ctx, 'active');
            ctx.activeStatusText = n > 1 ? `正在并发运行 ${n} 台蓝蝶活跃任务…` : text;
          },
        }),
      );
      const parts = [
        `完成 ${outcome.completedSteps} 步`,
        ...(outcome.likes > 0 ? [`点赞 ${outcome.likes}`] : []),
        ...(outcome.acceptedFriends > 0 ? [`加好友 ${outcome.acceptedFriends}`] : []),
        ...(outcome.published > 0 ? [`发布 ${outcome.published}`] : []),
        ...(outcome.skippedSteps > 0 ? [`跳过 ${outcome.skippedSteps} 步`] : []),
      ];
      return `活跃完成 · ${parts.join(' · ')}`;
    },
    parsed.closeWindowOnFinish,
  );
}
export async function startPoster(ctx: BluestacksServiceContext, input: unknown): Promise<void> {
  const parsed = StartBluestacksPosterInput.parse(input);
  const posterRunner = ctx.extra?.posterRunner;
  if (!posterRunner)
    throw new ProductError('BLUESTACKS_POSTER_UNAVAILABLE', '蓝蝶发帖执行器未就绪', 500);
  const [{ instances }, allGroups, allMaterials] = await Promise.all([
    getDiscoverySnapshot(ctx, true),
    ctx.repo.targets('groups'),
    ctx.extra?.listPosterMaterials ? ctx.extra.listPosterMaterials() : [],
  ]);
  const selectedMaterials = allMaterials.filter((m) => parsed.materialIds.includes(m.id));
  if (!selectedMaterials.length)
    throw new ProductError('POSTER_MATERIALS_EMPTY', '请至少选择一张有效的发帖素材卡', 400);
  const selectedGroups = allGroups.filter((g) => parsed.groupIds.includes(g.id));
  if (!selectedGroups.length && !parsed.postToTimeline)
    throw new ProductError('POSTER_GROUPS_EMPTY', '请至少选择一个有效小组或开启发时间线', 400);
  const preparedMaterials = (await prepareBsPosterMaterials(ctx, selectedMaterials, {
    throwProductError: true,
  })) as PosterMaterial[];
  const pendingJobs = await collectUnpostedPosterJobs(ctx, selectedGroups, preparedMaterials);
  if (!pendingJobs.length && !parsed.postToTimeline)
    failError(
      'POSTER_ALL_GROUPS_ALREADY_POSTED',
      '所选小组均已发布过所选素材，已自动防重复拦截',
      409,
    );
  const ready = await prepareIdlePortraitInstances(
    ctx,
    parsed.instanceIds,
    instances,
    'post',
    ctx.posterProfileStats,
  );
  const activeGroupIds = new Set<string>();
  const claimedPairKeys = new Set<string>();
  const claimNextGroupJob = () => {
    for (let i = 0; i < pendingJobs.length; i++) {
      const c = pendingJobs[i];
      if (!c) continue;
      const key = `${c.group.id}::${c.material.id}`;
      if (activeGroupIds.has(c.group.id) || claimedPairKeys.has(key)) continue;
      pendingJobs.splice(i, 1);
      activeGroupIds.add(c.group.id);
      claimedPairKeys.add(key);
      return c;
    }
    return null;
  };
  const filteredUniqueGroups = [...new Map(pendingJobs.map((j) => [j.group.id, j.group])).values()];
  ctx.posterStatusText = `正在运行 ${ready.length} 个蓝蝶发帖任务…`;
  await runExtraConcurrentBatch(
    ctx,
    'poster',
    ready,
    ctx.posterProfileStats,
    async (id, signal, ctrl) => {
      const outcome = await posterRunner.run(
        id,
        preparedMaterials,
        filteredUniqueGroups,
        {
          maxGroupsPerInstance: parsed.maxGroupsPerInstance,
          postToTimeline: parsed.postToTimeline,
          claimNextGroupJob,
          releaseGroupJob: (gid) => activeGroupIds.delete(gid),
          hasGroupPostedMaterial: ctx.extra?.hasGroupPostedMaterial,
        },
        signal,
        {
          status: (text) => {
            setBsStat(ctx.posterProfileStats, id, { running: true, status: text });
            const n = activeRunnerCount(ctx, 'poster');
            ctx.posterStatusText =
              n > 1 ? `正在并发运行 ${n} 台蓝蝶发帖（剩余 ${pendingJobs.length} 条）…` : text;
          },
          posted: () => {
            bumpBsStat(ctx.posterProfileStats, id, 1);
            triggerRiskQuotaAbort(ctx, id, 'post', ctrl);
          },
          onTargetFailed: (info) => recordBsPosterTargetFailure(ctx, id, info),
        },
      );
      const firstNote =
        outcome.posted === 0 && outcome.skipped > 0 && outcome.notes[0]
          ? `（${outcome.notes[0]}）`
          : '';
      return `发帖完成 · 成功 ${outcome.posted} 条${outcome.skipped > 0 ? `，跳过 ${outcome.skipped}` : ''}${firstNote}`;
    },
    parsed.closeWindowOnFinish,
  );
}
export async function startInviter(ctx: BluestacksServiceContext, input: unknown): Promise<void> {
  const parsed = StartBluestacksInviterInput.parse(input);
  const inviterRunner = ctx.extra?.inviterRunner;
  if (!inviterRunner)
    throw new ProductError('BLUESTACKS_INVITER_UNAVAILABLE', '蓝蝶邀请执行器未就绪', 500);
  const [{ instances }, allGroups] = await Promise.all([
    getDiscoverySnapshot(ctx, true),
    ctx.repo.targets('groups'),
  ]);
  const selectedGroups = allGroups.filter((g) => parsed.groupIds.includes(g.id));
  if (!selectedGroups.length)
    throw new ProductError('INVITER_GROUPS_EMPTY', '请至少选择一个有效的目标小组', 400);
  const ready = await prepareIdlePortraitInstances(
    ctx,
    parsed.instanceIds,
    instances,
    'invite',
    ctx.inviterProfileStats,
  );
  const staggered = buildStaggeredBumperQueues(ready, selectedGroups);
  ctx.inviterStatusText = `正在运行 ${ready.length} 个蓝蝶小组邀请任务…`;
  await runExtraConcurrentBatch(
    ctx,
    'inviter',
    ready,
    ctx.inviterProfileStats,
    async (id, signal, ctrl) => {
      const outcome = await inviterRunner.run(
        id,
        staggered.get(id) ?? selectedGroups,
        parsed.invitesPerGroup,
        signal,
        {
          status: (text) => {
            setBsStat(ctx.inviterProfileStats, id, { running: true, status: text });
            ctx.inviterStatusText = text;
          },
          invited: (delta) => {
            bumpBsStat(ctx.inviterProfileStats, id, delta);
            triggerRiskQuotaAbort(ctx, id, 'invite', ctrl);
          },
        },
        { getInvitedFriendIds: (gid) => ctx.repo.invitedFriendIdsForGroup?.(gid) ?? [] },
      );
      return `邀请完成 · 已邀请 ${outcome.invited} 人${outcome.skippedGroups > 0 ? `，跳过 ${outcome.skippedGroups} 群` : ''}`;
    },
    parsed.closeWindowOnFinish,
  );
}
export async function stopAllForInstances(
  ctx: BluestacksServiceContext,
  ids?: readonly string[],
): Promise<void> {
  const tasks: Promise<unknown>[] = [
    stopBumper(ctx, ids),
    stopExtraWorkers(ctx, undefined, ids),
    stopInstanceOps(ctx, ids),
  ];
  if (!ids?.length) tasks.push(stopBatchLogin(ctx), stopHealthCheck(ctx));
  await Promise.allSettled(tasks);
}
export async function closeInstanceForce(
  ctx: BluestacksServiceContext,
  instanceId: string,
): Promise<void> {
  if (isProfileRunning(ctx, instanceId))
    await stopAllForInstances(ctx, [instanceId]).catch(() => {});
  await withTrackedDeviceOp(ctx, ctx.closingIds, instanceId, async () => {
    await ctx.devices.closeInstance(instanceId);
    await saveLastStatusSafe(ctx, instanceId, '排班结束已自动关闭');
    deleteAllBsStats(ctx, instanceId);
  });
}
