import type { CompatibleRepository } from '../../domain/persistence.js';
import { ProductError, failError } from '../../domain/workspace.js';
import {
  BumperSettings,
  StartBumper,
  StartPageBumper,
  type BumperProfileStat,
  type BumperRefreshResult,
  type BumperState,
  type BumperTarget,
} from '../../shared/group-bumper.js';
import type { CheckDailyRiskLimitFn } from '../../shared/daily-risk-limits.js';
import type { PostBumpRecordsPort } from '../../shared/post-bump-records.js';
import type { ProfileLifecyclePort } from '../../shared/profile-lifecycle.js';
import type { FeatureExecutionRegistry } from '../feature-execution-registry.js';
import {
  PAGE_BUMPER_SYNTHETIC_GROUP,
  type BumperMode,
  type BumperRepository,
  type BumperRunner,
} from '../group-bumper-service.js';
import {
  acquireCarrierSlotAndLaunch,
  admitAndPlanBrowserLaunch,
  buildStaggeredQueues,
  checkRiskLimitSafe,
  closeIdleProfileAfterFinish,
  createEnsureOnlineLaunch,
  errMsg,
  persistProfileTaskResult,
  recordPostBumpFailure,
  sortTargetsOnlineFirst,
} from '../module-worker-pool.js';
import { Workboard, isWorkAbortError, sleepAbortable } from '../workboard.js';
export function createBumperRuntime(opts: {
  repo: CompatibleRepository<BumperRepository>;
  runner: BumperRunner;
  summary: () => Promise<Pick<BumperState, 'comments' | 'total'>>;
  assertAllowed: () => void;
  refreshAvatars?: (
    kind: 'groups' | 'pages',
    items: BumperTarget[],
    options?: { signal?: AbortSignal; onUpdated?: () => void },
  ) => Promise<BumperRefreshResult | void>;
  staggerScale: number;
  stopAvatarRefresh?: (kind?: 'groups' | 'pages') => void;
}) {
  const rt = {
    ...opts,
    profileRunIds: new Map<string, string>(),
    profileModes: new Map<string, BumperMode>(),
    fallbackPageSettings: undefined as BumperSettings | undefined,
    liveGroupSettings: new Set<BumperSettings>(),
    livePageSettings: new Set<BumperSettings>(),
    workers: new Map<string, Promise<void>>(),
    profiles: new Map<string, BumperProfileStat>(),
    pageProfiles: new Map<string, BumperProfileStat>(),
    active: new Set<string>(),
    cancelled: new Set<string>(),
    starting: new Set<string>(),
    admitting: new Set<string>(),
    admittingModes: new Map<string, BumperMode>(),
    refreshing: false,
    refreshingKind: null as 'groups' | 'pages' | null,
    refreshAbort: null as AbortController | null,
    statusText: '请选择账号、小组和目标主页',
    pageStatusText: '请选择账号和目标专页',
    featureExecution: undefined as FeatureExecutionRegistry | undefined,
    profileLifecycle: undefined as ProfileLifecyclePort | undefined,
    workboard: new Workboard({ browserConcurrency: 100, bluestacksConcurrency: 50 }),
    postBumpRecords: undefined as PostBumpRecordsPort | undefined,
    checkDailyRiskLimit: undefined as CheckDailyRiskLimitFn | undefined,
    profilesForMode: (mode: BumperMode) => (mode === 'page-bumper' ? rt.pageProfiles : rt.profiles),
    modeOf: (id: string): BumperMode =>
      (rt.admitting.has(id) ? rt.admittingModes.get(id) : undefined) ??
      rt.profileModes.get(id) ??
      rt.admittingModes.get(id) ??
      'group-bumper',
    setStatus: (mode: BumperMode, text: string, alsoMain = false) => {
      if (mode === 'page-bumper') rt.pageStatusText = text;
      if (mode !== 'page-bumper' || alsoMain) rt.statusText = text;
    },
    isProfileRunning: (id: string) =>
      rt.admitting.has(id) ||
      rt.active.has(id) ||
      rt.starting.has(id) ||
      rt.workers.has(id) ||
      rt.runner.isReadingProfile?.(id) === true,
    hasActiveExecution: () =>
      rt.admitting.size > 0 ||
      rt.active.size > 0 ||
      rt.starting.size > 0 ||
      rt.workers.size > 0 ||
      rt.refreshing ||
      rt.runner.hasMetadataReads?.() === true,
    isProfileRunningInMode: (id: string, mode: BumperMode, includeAdmitting = true) =>
      rt.modeOf(id) === mode &&
      ((includeAdmitting && rt.admitting.has(id)) ||
        rt.active.has(id) ||
        rt.starting.has(id) ||
        rt.workers.has(id)),
    hasActiveExecutionInMode: (mode: BumperMode) => {
      for (const id of new Set([
        ...rt.admitting,
        ...rt.active,
        ...rt.starting,
        ...rt.workers.keys(),
      ]))
        if (rt.modeOf(id) === mode) return true;
      return false;
    },
  };
  return rt;
}
export type BumperRuntimeContext = ReturnType<typeof createBumperRuntime>;
const persistBumperResult = (
  ctx: BumperRuntimeContext,
  profileId: string,
  mode: BumperMode,
  runId: string,
  aborted: boolean,
  failed: boolean,
  pendingPlusFailed: number,
  skippedPosts: number,
  reason: string,
) =>
  persistProfileTaskResult(ctx.repo.saveProfileResult?.bind(ctx.repo), {
    profileId,
    source: mode,
    runId,
    name: mode === 'page-bumper' ? '专页顶贴' : '小组顶贴',
    state: aborted ? 'STOPPED' : failed || pendingPlusFailed > 0 ? 'FAILED' : 'COMPLETED',
    reason,
    finishedAt: Date.now(),
    failedSteps: pendingPlusFailed + (failed ? 1 : 0),
    skippedSteps: skippedPosts,
  });
export async function resolveBumperTargetsAndSettings(
  ctx: BumperRuntimeContext,
  mode: BumperMode,
  groupIds: readonly string[],
  pageIds: readonly string[],
) {
  const [allGroups, allPages] = await Promise.all([
    ctx.repo.targets('groups'),
    ctx.repo.targets('pages'),
  ]);
  const groups =
    mode === 'page-bumper'
      ? [PAGE_BUMPER_SYNTHETIC_GROUP]
      : groupIds.flatMap((id) => allGroups.filter((g) => g.id === id));
  const pages = pageIds.flatMap((id) => allPages.filter((p) => p.id === id));
  const rawSettings =
    mode === 'page-bumper'
      ? ctx.repo.pageSettings
        ? await ctx.repo.pageSettings()
        : (ctx.fallbackPageSettings ?? (await ctx.repo.settings()))
      : await ctx.repo.settings();
  return { groups, pages, rawSettings };
}
type IssueCounts = {
  pending: number;
  failedActions: number;
  skippedPosts: number;
  issueReason: string;
  skipReason: string;
};
export const checkBumperQuota = (ctx: BumperRuntimeContext, id: string) =>
  checkRiskLimitSafe(ctx.checkDailyRiskLimit, id, 'bump');
export async function runBumperSession(
  ctx: BumperRuntimeContext,
  profileId: string,
  mode: BumperMode,
  runId: string,
  groups: BumperTarget[],
  pages: BumperTarget[],
  settings: BumperSettings,
  stat: BumperProfileStat,
  isAborted: () => boolean,
  isCurrent: () => boolean,
  hooks: {
    onStatUpdated?: () => void;
    formatStatus: (c: IssueCounts) => string | null;
    onFailureError?: (rawMsg: string) => void;
    pendingConfirmPrefix?: string;
  },
): Promise<{ failed: boolean }> {
  let failed = false;
  let stopAfterPostReason: string | null = null;
  const counts: IssueCounts = {
    pending: 0,
    failedActions: 0,
    skippedPosts: 0,
    issueReason: '',
    skipReason: '',
  };
  const recordType = mode === 'page-bumper' ? ('page_bump' as const) : ('group_bump' as const);
  try {
    await ctx.runner.run(profileId, groups, pages, settings, {
      runId,
      cancelled: () => !isCurrent() || isAborted(),
      shouldStopAfterCurrentPost: () => stopAfterPostReason !== null,
      status: (text, today) => {
        if (!isCurrent()) return;
        stat.status = text;
        if (today !== undefined) stat.today = today;
        hooks.onStatUpdated?.();
      },
      issue: (issue) => {
        if (!isCurrent()) return;
        if (issue.kind === 'pending') {
          counts.pending++;
          counts.issueReason = issue.reason;
        } else if (issue.kind === 'skipped') {
          counts.skippedPosts++;
          counts.skipReason = issue.reason;
        } else {
          counts.failedActions++;
          counts.issueReason = issue.reason;
          recordPostBumpFailure(ctx.postBumpRecords, {
            recordType,
            carrier: 'browser',
            status: 'failed',
            profileId,
            groupId: issue.target?.groupId ?? '',
            groupName: issue.target?.groupName ?? '',
            pageId: issue.target?.pageId ?? '',
            pageName: issue.target?.pageName ?? '',
            errorReason: issue.reason.slice(0, 120),
          });
        }
        hooks.onStatUpdated?.();
      },
      added: (today) => {
        if (!isCurrent()) return;
        stat.session++;
        stat.today = today;
        if (today >= settings.dailyMaxLikesPerAccount) {
          stopAfterPostReason ??= `今日已达上限 (${today}/${settings.dailyMaxLikesPerAccount})`;
        }
        hooks.onStatUpdated?.();
        if (ctx.checkDailyRiskLimit)
          void checkBumperQuota(ctx, profileId).then((cap) => {
            if (cap.allowed || !isCurrent() || isAborted()) return;
            stopAfterPostReason ??= cap.reason ?? '今日已达浏览器安全日限额，自动跳过保护';
          });
      },
    });
    if (stopAfterPostReason && !isAborted() && isCurrent()) {
      stat.status = stopAfterPostReason;
      hooks.onStatUpdated?.();
    }
    const nextStatus = hooks.formatStatus(counts);
    if (nextStatus !== null) stat.status = nextStatus;
  } catch (e) {
    const stopped = isAborted() || isWorkAbortError(e);
    failed = !stopped;
    const rawMsg = errMsg(e, '顶贴执行失败');
    stat.status = stopped ? '已停止' : rawMsg;
    if (failed) {
      recordPostBumpFailure(ctx.postBumpRecords, {
        recordType,
        carrier: 'browser',
        status: 'failed',
        profileId,
        errorReason: stat.status.slice(0, 120),
      });
      hooks.onFailureError?.(rawMsg);
    }
  } finally {
    stat.running = ctx.runner.hasControl?.(profileId) === true;
    if (!stat.running) {
      ctx.active.delete(profileId);
      await persistBumperResult(
        ctx,
        profileId,
        mode,
        runId,
        isAborted(),
        failed,
        counts.pending + counts.failedActions,
        counts.skippedPosts,
        stat.status,
      );
    } else if (hooks.pendingConfirmPrefix) stat.status = hooks.pendingConfirmPrefix + stat.status;
  }
  return { failed };
}
export async function startBumperRunWithMeta(
  ctx: BumperRuntimeContext,
  input: unknown,
  mode: BumperMode = 'group-bumper',
): Promise<{
  runId: string;
  admittedIds: string[];
  admittedCount: number;
  workerPromises: Promise<void>[];
}> {
  ctx.assertAllowed();
  if (ctx.refreshing || ctx.runner.hasMetadataReads?.() === true)
    throw new ProductError('BUMPER_READING', '正在读取资料，请稍候', 409);
  const req =
    mode === 'page-bumper'
      ? { ...StartPageBumper.parse(input), groupIds: [] as string[] }
      : StartBumper.parse(input);
  const requested = [...new Set(req.profileIds)];
  const otherMode: BumperMode = mode === 'page-bumper' ? 'group-bumper' : 'page-bumper';
  const otherLabel = otherMode === 'page-bumper' ? '专页顶贴' : '小组顶贴';
  const targetProfiles = ctx.profilesForMode(mode);
  const otherProfiles = ctx.profilesForMode(otherMode);
  const { groups, pages, rawSettings } = await resolveBumperTargetsAndSettings(
    ctx,
    mode,
    req.groupIds,
    req.pageIds,
  );
  if (!groups.length || !pages.length)
    failError(
      'BUMPER_TARGETS_EMPTY',
      mode === 'page-bumper' ? '请选择已保存的目标专页' : '请选择已保存的小组和目标主页',
      400,
    );
  const settings: BumperSettings = { ...rawSettings };
  const closeBrowserOnFinish = Boolean(
    req.closeBrowserOnFinish ||
    (rawSettings as { closeBrowserOnFinish?: boolean }).closeBrowserOnFinish,
  );
  const shareProb = settings.shareToStoryProbability ?? 0;
  if (!settings.likeProbability && !settings.commentProbability && !shareProb)
    throw new ProductError('BUMPER_PROBABILITY_ZERO', '点赞、留言和分享快拍概率不能同时为 0%', 400);
  if (settings.commentProbability > 0 && !settings.likeProbability && !shareProb) {
    const commentItems = ctx.repo.comments
      ? await ctx.repo.comments(mode === 'page-bumper' ? 'page' : 'group')
      : (await ctx.summary()).comments;
    if (!commentItems.length)
      failError(
        'BUMPER_COMMENTS_EMPTY',
        '当前仅开启了留言（点赞概率 0%），但留言列表为空，请先添加留言话术',
        400,
      );
  }
  const candidateAdmitting = requested.filter(
    (id) => !ctx.isProfileRunningInMode(id, mode) && !ctx.admitting.has(id),
  );
  const reservedIds = ctx.featureExecution
    ? (await ctx.featureExecution.tryReserve(mode, candidateAdmitting)).reservedIds
    : candidateAdmitting;
  const newlyAdmitting = reservedIds.filter(
    (id) => !ctx.isProfileRunningInMode(id, mode) && !ctx.admitting.has(id),
  );
  for (const id of newlyAdmitting) {
    ctx.cancelled.delete(id);
    ctx.admitting.add(id);
    ctx.admittingModes.set(id, mode);
  }
  let admittedIds: string[] = [];
  let runId = '';
  const launchedWorkerIds = new Set<string>();
  try {
    const { admission, launchFailureReasons, pendingLaunchSet } = await admitAndPlanBrowserLaunch({
      launchCandidates: newlyAdmitting,
      admitIds: () => {
        const activeReq = requested.filter(
          (id) => !newlyAdmitting.includes(id) || !ctx.cancelled.has(id),
        );
        if (!activeReq.length) {
          for (const id of newlyAdmitting)
            if (ctx.cancelled.has(id))
              targetProfiles.set(id, { today: 0, session: 0, status: '已停止', running: false });
          ctx.setStatus(mode, '已停止');
        }
        return activeReq;
      },
      moduleId: mode,
      profileLifecycle: ctx.profileLifecycle,
      featureExecution: ctx.featureExecution,
      isProfileReady: (id) => ctx.runner.ready(id),
      isAlreadyRunningInCurrentModule: (id) =>
        ctx.isProfileRunningInMode(id, mode, !newlyAdmitting.includes(id)),
      isProfileBusyInRunner: async (id) =>
        ctx.isProfileRunningInMode(id, otherMode) || (await ctx.runner.busy(id)),
      extraBusyLabels: (id) => (ctx.isProfileRunningInMode(id, otherMode) ? [otherLabel] : []),
      onLaunchingOffline: (count) =>
        ctx.setStatus(mode, `正在自动启动 ${count} 个离线浏览器并同步插件…`),
    });
    if (
      !admission.admittedProfileIds.length &&
      !admission.alreadyRunningIds.length &&
      !admission.skippedBusy.length &&
      !admission.skippedOffline.length
    )
      return { runId: '', admittedIds: [], admittedCount: 0, workerPromises: [] };
    for (const skipped of [...admission.skippedBusy, ...admission.skippedOffline]) {
      targetProfiles.set(skipped.profileId, {
        today: 0,
        session: 0,
        status: launchFailureReasons.get(skipped.profileId) ?? skipped.reason,
        running: false,
      });
    }
    if (!admission.admittedProfileIds.length) {
      if (
        admission.alreadyRunningIds.length > 0 &&
        !admission.skippedBusy.length &&
        !admission.skippedOffline.length
      )
        throw new ProductError('BUMPER_RUNNING', '所选浏览器正在运行顶贴任务', 409);
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
    runId = globalThis.crypto.randomUUID();
    for (const id of admittedIds) {
      ctx.cancelled.delete(id);
      targetProfiles.delete(id);
      if (!ctx.isProfileRunningInMode(id, otherMode)) otherProfiles.delete(id);
      ctx.profileModes.set(id, mode);
      ctx.profileRunIds.set(id, runId);
      ctx.starting.add(id);
    }
    const eligibleIds = await sortTargetsOnlineFirst(
      admittedIds.filter((id) => !ctx.cancelled.has(id)),
      (id) => ctx.runner.ready(id),
    );
    const groupQueues = buildStaggeredQueues(eligibleIds, groups);
    const pageQueues = buildStaggeredQueues(eligibleIds, pages);
    let stagger = 0;
    let launched = 0;
    const workerPromises: Promise<void>[] = [];
    for (const id of eligibleIds) {
      ctx.assertAllowed();
      if (ctx.cancelled.has(id) || ctx.workboard.isCarrierBusy(id)) continue;
      ctx.active.add(id);
      launched++;
      targetProfiles.set(id, { today: 0, session: 0, status: '排队等待并发槽位…', running: true });
      const delay = stagger;
      stagger += Math.round((1800 + Math.floor(Math.random() * 2001)) * ctx.staggerScale);
      const work = runBumperWorker(
        ctx,
        id,
        groupQueues.get(id) ?? groups,
        pageQueues.get(id) ?? pages,
        settings,
        delay,
        runId,
        mode,
        closeBrowserOnFinish,
      );
      ctx.workers.set(id, work);
      launchedWorkerIds.add(id);
      workerPromises.push(work);
      void work.finally(() => {
        if (ctx.workers.get(id) === work) ctx.workers.delete(id);
        if (!ctx.hasActiveExecutionInMode(mode)) ctx.setStatus(mode, '本轮已结束');
      });
    }
    if (pendingLaunchSet.size > 0) {
      await Promise.resolve();
      await Promise.resolve();
    }
    if (launched > 0) {
      const liveSet = mode === 'page-bumper' ? ctx.livePageSettings : ctx.liveGroupSettings;
      liveSet.add(settings);
      void Promise.allSettled(workerPromises).finally(() => liveSet.delete(settings));
    }
    const runningCount = [...ctx.active].filter((id) => ctx.modeOf(id) === mode).length;
    ctx.setStatus(
      mode,
      launched
        ? `运行中 · ${runningCount} 个账号`
        : runningCount
          ? `运行中 · ${runningCount} 个账号（本次追加无可运行的空闲账号）`
          : '没有可运行的空闲账号',
    );
    return { runId, admittedIds: eligibleIds, admittedCount: launched, workerPromises };
  } finally {
    for (const id of newlyAdmitting) {
      ctx.admitting.delete(id);
      ctx.admittingModes.delete(id);
    }
    for (const id of admittedIds) {
      ctx.starting.delete(id);
      if (runId && !launchedWorkerIds.has(id) && ctx.profileRunIds.get(id) === runId) {
        ctx.profileModes.delete(id);
      }
    }
    ctx.featureExecution?.releaseReservation(mode, reservedIds);
  }
}
async function runBumperWorker(
  ctx: BumperRuntimeContext,
  id: string,
  groups: BumperTarget[],
  pages: BumperTarget[],
  settings: BumperSettings,
  delay: number,
  runId: string,
  mode: BumperMode,
  closeBrowserOnFinish: boolean,
): Promise<void> {
  try {
    const targetProfiles = ctx.profilesForMode(mode);
    const stat = targetProfiles.get(id);
    if (!stat) throw Error('BUMPER_PROFILE_STATE_MISSING');
    await ctx.workboard.runSoldier(
      { carrierId: id, carrierKind: 'browser', moduleId: mode },
      async (soldier) => {
        let releasePermit: (() => void) | undefined;
        let touchedBrowser = false;
        const isAborted = () => ctx.cancelled.has(id) || soldier.signal.aborted;
        const current = () => ctx.profileRunIds.get(id) === runId;
        const finishEarly = async (status: string, cancelled: boolean, failed: boolean) => {
          Object.assign(stat, { status, running: false });
          ctx.active.delete(id);
          await persistBumperResult(ctx, id, mode, runId, cancelled, failed, 0, 0, status);
        };
        const finishIdle = () =>
          finishEarly(isAborted() ? '已停止' : '已完成 · 本轮 0 次', isAborted(), false);
        try {
          if (isAborted() || !current()) return void (await finishIdle());
          if (await ctx.runner.busy(id))
            return void (await finishEarly('跳过：该浏览器正在执行其他任务', false, false));
          const cap = await checkBumperQuota(ctx, id);
          if (!cap.allowed)
            return void (await finishEarly(
              cap.reason ?? '今日已达浏览器安全日限额，自动跳过保护',
              false,
              false,
            ));
          if (delay > 0 && !isAborted()) await sleepAbortable(delay, soldier.signal);
          if (isAborted() || !current()) return void (await finishIdle());
          const acquired = await acquireCarrierSlotAndLaunch({
            carrierKind: 'browser',
            carrierId: id,
            moduleId: mode,
            workboard: ctx.workboard,
            signal: soldier.signal,
            featureExecution: ctx.featureExecution,
            checkDailyLimit: async () => {
              if (!current()) return { allowed: false, reason: '已停止' };
              if (await ctx.runner.busy(id))
                return { allowed: false, reason: '跳过：该浏览器正在执行其他任务' };
              return checkBumperQuota(ctx, id);
            },
            isReady: (pid) => ctx.runner.ready(pid),
            launch: createEnsureOnlineLaunch(
              ctx.profileLifecycle,
              (pid) => ctx.runner.ready(pid),
              () => void (touchedBrowser = true),
            ),
            onQueued: () => !isAborted() && (stat.status = '排队等待并发槽位…'),
            onLaunching: () => !isAborted() && (stat.status = '正在启动浏览器…'),
          });
          if (!acquired.ok) {
            const stopped = isAborted();
            return void (await finishEarly(
              stopped ? '已停止' : acquired.reason,
              stopped,
              !stopped && !acquired.skipped,
            ));
          }
          releasePermit = acquired.releasePermit;
          touchedBrowser = true;
          if (!isAborted() && current()) {
            stat.status = '准备中';
            await runBumperSession(
              ctx,
              id,
              mode,
              runId,
              groups,
              pages,
              settings,
              stat,
              isAborted,
              () => current() && targetProfiles.get(id) === stat,
              {
                pendingConfirmPrefix: '停止待确认 · ',
                formatStatus: (c) => {
                  if (c.pending + c.failedActions > 0 && !isAborted()) {
                    const detail = [
                      c.pending ? `${c.pending} 项待核对` : '',
                      c.failedActions ? `${c.failedActions} 项未完成` : '',
                      c.skippedPosts ? `跳过 ${c.skippedPosts} 帖` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ');
                    return `本轮 ${stat.session} 次已确认 · ${detail} · ${c.issueReason}`;
                  }
                  if (
                    stat.status.startsWith('今日已达上限') ||
                    stat.status.startsWith('今日已达浏览器')
                  )
                    return null;
                  if (isAborted()) return '已停止';
                  if (c.skippedPosts > 0)
                    return `已完成 · 本轮 ${stat.session} 次 · 跳过 ${c.skippedPosts} 帖（${/视频/.test(c.skipReason) ? '视频加载超时' : '帖子加载超时'}）`;
                  return stat.session > 0 || !stat.status.startsWith('已完成 · 0 次')
                    ? `已完成 · 本轮 ${stat.session} 次`
                    : null;
                },
              },
            );
          } else await finishIdle();
        } catch (err) {
          if (!isWorkAbortError(err)) throw err;
          await finishEarly('已停止', true, false);
        } finally {
          releasePermit?.();
          const shouldClose = Boolean(
            closeBrowserOnFinish ||
            (settings as { closeBrowserOnFinish?: boolean }).closeBrowserOnFinish,
          );
          if (
            shouldClose &&
            touchedBrowser &&
            ctx.profileLifecycle &&
            !ctx.admitting.has(id) &&
            !ctx.starting.has(id) &&
            !ctx.active.has(id) &&
            ctx.profileRunIds.get(id) === runId &&
            !ctx.workboard.hasCarrierPermit('browser', id) &&
            !(await ctx.featureExecution?.isProfileBusy(id, mode))
          ) {
            await closeIdleProfileAfterFinish(ctx.profileLifecycle, id, (ms) =>
              sleepAbortable(ms, undefined),
            );
          }
          if (!ctx.hasActiveExecutionInMode(mode)) ctx.setStatus(mode, '本轮已结束');
        }
      },
    );
  } finally {
    if (ctx.profileRunIds.get(id) === runId) ctx.profileModes.delete(id);
  }
}
export async function stopBumperProfiles(
  ctx: BumperRuntimeContext,
  profileIds?: string[],
  mode?: BumperMode,
): Promise<void> {
  ctx.refreshAbort?.abort();
  const ids = (
    profileIds ?? [...new Set([...ctx.active, ...ctx.starting, ...ctx.admitting])]
  ).filter((id) => !mode || ctx.modeOf(id) === mode || ctx.admittingModes.get(id) === mode);
  const workers = ids
    .map((id) => ctx.workers.get(id))
    .filter((w): w is Promise<void> => w !== undefined);
  for (const id of ids) {
    ctx.cancelled.add(id);
    ctx.workboard.abortCarrier(id, 'USER_STOP');
  }
  const stopResults = await Promise.allSettled(
    ids.map(async (id) => {
      if (!ctx.active.has(id)) return;
      await ctx.runner.stop(id);
      if (ctx.runner.hasControl?.(id) === false && !ctx.workers.has(id)) {
        ctx.active.delete(id);
        const stat = ctx.profilesForMode(ctx.modeOf(id)).get(id);
        if (stat) Object.assign(stat, { running: false, status: '已停止' });
      }
    }),
  );
  await Promise.allSettled(workers);
  const firstRejected = stopResults.find(
    (r): r is PromiseRejectedResult => r.status === 'rejected',
  );
  if (firstRejected) throw firstRejected.reason;
}
