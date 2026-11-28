import {
  formatStepShortLabel,
  type AutoSchedule,
  type BrowserPipelineStep,
} from '../../shared/auto-scheduler.js';
import {
  buildPipelineFinalOutcome,
  classifyBrowserHardAccountIssue,
  makePipelineOutcome,
  runActiveCombinationStep,
  startPipelineWatchdog,
  stopAllBrowserSubmodules,
  type ActiveTargetExecutionContext,
  type AutoSchedulerExecutorDeps,
  type PipelineStepResult,
  type TargetPipelineOutcome,
  type TargetProgressPatch,
} from '../auto-scheduler-executor.js';
import { closeIdleProfileAfterFinish, errMsg } from '../module-worker-pool.js';
import { isWorkAbortError } from '../workboard.js';
function createPipelineSession(
  deps: AutoSchedulerExecutorDeps,
  targetId: string,
  safetyCeilingMinutes: number | null,
  onUpdate: (patch: TargetProgressPatch) => void,
  shouldSkipTick: () => boolean,
  onAbortCarrier: () => void,
) {
  const s = {
    bumpedCount: 0,
    postedCount: 0,
    invitedCount: 0,
    softIssues: 0,
    hardBlockReason: null as string | null,
    watchdogTimedOut: false,
    anyWatchdogTimedOut: false,
    safetyCeilingHit: false,
    softNotes: [] as string[],
  };
  const emit = (currentStep: string, summary: string, extraBumps = 0, extraPosts = 0) =>
    onUpdate({
      currentStep,
      summary,
      bumpedCount: s.bumpedCount + extraBumps,
      postedCount: s.postedCount + extraPosts,
      softIssues: s.softIssues,
    });
  const watchdog = startPipelineWatchdog(
    deps,
    safetyCeilingMinutes,
    shouldSkipTick,
    () => {
      s.safetyCeilingHit = true;
      onAbortCarrier();
    },
    () => {
      s.watchdogTimedOut = s.anyWatchdogTimedOut = true;
      onAbortCarrier();
    },
  );
  const touch = (stepLabel: string, summaryText: string, extraBumps = 0, extraPosts = 0) => {
    watchdog.touch();
    emit(stepLabel, summaryText, extraBumps, extraPosts);
  };
  const missSvc = (msg: string) => {
    s.softIssues++;
    s.softNotes.push(msg);
    return true;
  };
  const runDelegated = async <R extends PipelineStepResult>(
    moduleId: string,
    watchdogNote: string,
    ignoreSoftIssue: () => boolean,
    run: () => Promise<R>,
    onResult?: (res: R) => void,
  ) => {
    deps.featureExecution.setDelegatedSubmodule(targetId, moduleId);
    try {
      const res = await run();
      onResult?.(res);
      if (res.hardBlocked) {
        s.hardBlockReason = res.status;
        return false;
      }
      if (s.watchdogTimedOut) missSvc(watchdogNote);
      else if (res.softIssue && !ignoreSoftIssue()) missSvc(res.status);
      return true;
    } finally {
      deps.featureExecution.setDelegatedSubmodule(targetId, null);
    }
  };
  return { s, emit, watchdog, touch, missSvc, runDelegated };
}
export async function runBrowserTargetPipeline(
  deps: AutoSchedulerExecutorDeps,
  input: {
    schedule: Extract<AutoSchedule, { carrier: 'browser' }>;
    profileId: string;
    safetyCeilingMinutes: number | null;
    ctx: ActiveTargetExecutionContext;
    onUpdate: (patch: TargetProgressPatch) => void;
  },
): Promise<TargetPipelineOutcome> {
  const { schedule, profileId, ctx, onUpdate } = input;
  const steps: BrowserPipelineStep[] = schedule.steps;
  let currentStepAbort = false;
  const launchAbort = new AbortController();
  const abortSubmodules = () => {
    currentStepAbort = true;
    if (!launchAbort.signal.aborted) launchAbort.abort('USER_STOP');
    void stopAllBrowserSubmodules(deps, profileId);
  };
  ctx.abortStep = abortSubmodules;
  const { s, emit, watchdog, touch, missSvc, runDelegated } = createPipelineSession(
    deps,
    profileId,
    input.safetyCeilingMinutes,
    onUpdate,
    () => ctx.cancelled,
    abortSubmodules,
  );
  let executedTarget = false;
  try {
    if (ctx.cancelled) return makePipelineOutcome('stopped', '已取消启动');
    const lifecycle = deps.profileLifecycle;
    if (lifecycle) {
      executedTarget = true;
      const preSnap = await deps.workspace.snapshot();
      if (ctx.cancelled) return makePipelineOutcome('stopped', '已停止');
      const alreadyOnline = preSnap.profiles.some((p) => p.id === profileId && p.online);
      touch('启动浏览器', alreadyOnline ? '复用已开窗口…' : '正在打开浏览器并连接插件…');
      let launchRes: Awaited<ReturnType<typeof lifecycle.ensureProfilesOnline>>;
      try {
        launchRes =
          !alreadyOnline && deps.workboard
            ? await deps.workboard.runStaggeredLaunch(launchAbort.signal, () =>
                lifecycle.ensureProfilesOnline([profileId]),
              )
            : await lifecycle.ensureProfilesOnline([profileId]);
      } catch (err) {
        if (ctx.cancelled || isWorkAbortError(err)) return makePipelineOutcome('stopped', '已停止');
        throw err;
      }
      if (ctx.cancelled) return makePipelineOutcome('stopped', '已停止');
      const failedLaunch = launchRes.failed.find((f) => f.profileId === profileId);
      if (failedLaunch) {
        s.softIssues++;
        s.softNotes.push(`启动浏览器失败 (${failedLaunch.reason})`);
        return makePipelineOutcome('soft_warning', `启动浏览器失败：${failedLaunch.reason}`, {
          softIssues: s.softIssues,
        });
      }
      if (
        !launchRes.readyIds.includes(profileId) &&
        !(await deps.workspace.snapshot()).profiles.some((p) => p.id === profileId && p.online)
      )
        return makePipelineOutcome('soft_warning', '浏览器启动超时未上线', {
          softIssues: ++s.softIssues,
        });
    }
    watchdog.touch();
    const launchedProfile = (await deps.workspace.snapshot()).profiles.find(
      (p) => p.id === profileId,
    );
    if (
      launchedProfile &&
      ['logged-out', 'verification', 'restricted'].includes(launchedProfile.account.state)
    )
      s.hardBlockReason = classifyBrowserHardAccountIssue(launchedProfile, '') ?? '账号状态异常';
    for (let idx = 0; idx < steps.length && !s.hardBlockReason; idx++) {
      if (ctx.cancelled || s.safetyCeilingHit) break;
      const step = steps[idx];
      if (!step) continue;
      currentStepAbort = false;
      s.watchdogTimedOut = false;
      const shortLabel = formatStepShortLabel(step);
      const stepLabel = `步骤 ${idx + 1}/${steps.length} · ${shortLabel}`;
      touch(stepLabel, `开始执行 ${shortLabel}`);
      const isAborted = () => ctx.cancelled || currentStepAbort || s.safetyCeilingHit;
      const ignoreSoft = () => ctx.cancelled;
      try {
        let keepGoing = true;
        if (step.type === 'active-combination') {
          const res = await runActiveCombinationStep(
            deps,
            profileId,
            step.combinationId,
            stepLabel,
            isAborted,
            touch,
            emit,
          );
          if (res.hardBlockReason) {
            s.hardBlockReason = res.hardBlockReason;
            break;
          }
          if (s.watchdogTimedOut) missSvc('活跃组合无进展超时已跳过');
          else if (res.softIssue) missSvc(res.softIssue);
        } else if (step.type === 'group-bumper' || step.type === 'page-bumper') {
          const bumper = deps.groupBumper;
          keepGoing = bumper
            ? await runDelegated(
                step.type,
                `${step.type === 'page-bumper' ? '专页顶贴' : '小组顶贴'}无进展看门狗跳过`,
                ignoreSoft,
                () =>
                  bumper.runScheduledProfileStep({
                    profileId,
                    mode: step.type,
                    groupIds:
                      step.type === 'group-bumper' && Array.isArray(step.groupIds)
                        ? step.groupIds
                        : [],
                    pageIds: step.pageIds,
                    minConcurrency: deps.getBrowserConcurrency(),
                    onProgress: (txt, b) => touch(stepLabel, txt, b, 0),
                  }),
                (res) => void (s.bumpedCount += res.bumpedCount),
              )
            : missSvc('顶贴服务未就绪');
        } else if (step.type === 'group-poster') {
          const poster = deps.groupPoster;
          keepGoing = poster
            ? await runDelegated(
                'group-poster',
                '小组发帖无进展看门狗跳过',
                ignoreSoft,
                () =>
                  poster.runScheduledProfileStep({
                    profileId,
                    materialIds: step.materialIds,
                    groupIds: step.groupIds,
                    maxGroupsPerProfile: step.maxGroupsPerProfile,
                    materialsPerGroup: step.materialsPerGroup,
                    onProgress: (txt, p) => touch(stepLabel, txt, 0, p),
                  }),
                (res) => void (s.postedCount += res.postedCount),
              )
            : missSvc('小组发帖服务未就绪');
        } else if (step.type === 'group-inviter') {
          const inviter = deps.groupInviter;
          keepGoing = inviter
            ? await runDelegated(
                'group-inviter',
                '小组邀人无进展看门狗跳过',
                ignoreSoft,
                () =>
                  inviter.runScheduledProfileStep({
                    profileId,
                    groupIds: step.groupIds,
                    invitesPerGroup: step.invitesPerGroup,
                    onProgress: (txt) => touch(stepLabel, txt),
                  }),
                (res) => void (s.invitedCount += res.invitedCount),
              )
            : missSvc('小组邀请服务未就绪');
        }
        if (!keepGoing) break;
      } catch (stepErr) {
        if (ctx.cancelled) break;
        const msg = errMsg(stepErr);
        const snapOnErr = await deps.workspace.snapshot().catch(() => null);
        const hardErr = classifyBrowserHardAccountIssue(
          snapOnErr?.profiles.find((p) => p.id === profileId),
          msg,
        );
        if (hardErr) {
          s.hardBlockReason = hardErr;
          break;
        }
        missSvc(`${shortLabel}异常跳过 (${msg.slice(0, 80)})`);
      }
      const postStepHard = classifyBrowserHardAccountIssue(
        (await deps.workspace.snapshot()).profiles.find((p) => p.id === profileId),
        '',
      );
      if (postStepHard) {
        s.hardBlockReason = postStepHard;
        break;
      }
    }
    return buildPipelineFinalOutcome({ carrier: 'browser', cancelled: ctx.cancelled, ...s });
  } finally {
    watchdog.stop();
    deps.featureExecution.setDelegatedSubmodule(profileId, null);
    await stopAllBrowserSubmodules(deps, profileId);
    const keepOpenOnCancel = ctx.cancelled && ctx.keepWindowOpenOnCancel;
    const closeOnStop = ctx.cancelled && !ctx.keepWindowOpenOnCancel;
    if (
      executedTarget &&
      (schedule.closeWindowOnFinish || closeOnStop) &&
      !keepOpenOnCancel &&
      deps.profileLifecycle
    ) {
      emit('关闭浏览器', '正在安全关闭浏览器释放内存…');
      await closeIdleProfileAfterFinish(deps.profileLifecycle, profileId);
    }
    deps.releaseOwnershipBeforeClose(profileId);
  }
}
export async function runBluestacksTargetPipeline(
  deps: AutoSchedulerExecutorDeps,
  input: {
    schedule: Extract<AutoSchedule, { carrier: 'bluestacks' }>;
    instanceId: string;
    safetyCeilingMinutes: number | null;
    ctx: ActiveTargetExecutionContext;
    onUpdate: (patch: TargetProgressPatch) => void;
  },
): Promise<TargetPipelineOutcome> {
  const { schedule, instanceId, ctx, onUpdate } = input;
  const bluestacks = deps.bluestacks;
  if (!bluestacks)
    return makePipelineOutcome('soft_warning', '蓝蝶模拟器服务未初始化', { softIssues: 1 });
  let stepAbortCtrl = new AbortController();
  ctx.abortStep = () => {
    stepAbortCtrl.abort(new Error('TASK_STOPPED'));
    void (
      typeof bluestacks.stopAllForInstances === 'function'
        ? bluestacks.stopAllForInstances([instanceId])
        : bluestacks.stopBumper([instanceId])
    ).catch(() => {});
  };
  const { s, emit, watchdog, touch, runDelegated } = createPipelineSession(
    deps,
    instanceId,
    input.safetyCeilingMinutes,
    onUpdate,
    () => ctx.cancelled,
    () => {
      stepAbortCtrl.abort(
        new Error(s.safetyCeilingHit ? 'SAFETY_CEILING_TIMEOUT' : 'IDLE_WATCHDOG_TIMEOUT'),
      );
      void bluestacks.stopAllForInstances([instanceId]).catch(() => {});
    },
  );
  let executedVm = false;
  try {
    if (ctx.cancelled) return makePipelineOutcome('stopped', '已取消启动模拟器');
    emit('启动模拟器', '正在启动蓝蝶窗口并等待 ADB 就绪…');
    executedVm = true;
    await bluestacks.ensureInstanceOnlineForSchedule(instanceId, stepAbortCtrl.signal);
    if (ctx.cancelled) return makePipelineOutcome('stopped', '已停止');
    watchdog.touch();
    for (let idx = 0; idx < schedule.steps.length && !s.hardBlockReason; idx++) {
      if (ctx.cancelled || s.safetyCeilingHit) break;
      const step = schedule.steps[idx];
      if (!step) continue;
      s.watchdogTimedOut = false;
      stepAbortCtrl = new AbortController();
      const shortLabel = formatStepShortLabel(step);
      const stepLabel = `步骤 ${idx + 1}/${schedule.steps.length} · ${shortLabel}`;
      const progress = (txt: string, b = 0, p = 0) => touch(stepLabel, txt, b, p);
      progress(`开始执行 ${shortLabel}`);
      const runBs = <R extends PipelineStepResult>(
        mod: string,
        note: string,
        fn: () => Promise<R>,
        onRes?: (r: R) => void,
      ) => runDelegated<R>(mod, note, () => ctx.cancelled, fn, onRes);
      let keepGoing = true;
      if (step.type === 'bluestacks-health-check')
        keepGoing = await runBs('bluestacks-health-check', '蓝蝶健康体检无进展看门狗跳过', () =>
          bluestacks.runScheduledHealthCheckStep({
            instanceId,
            autoInstallApk: step.autoInstallApk,
            signal: stepAbortCtrl.signal,
            onProgress: (t) => progress(t),
          }),
        );
      else if (step.type === 'bluestacks-active-combination')
        keepGoing = await runBs(step.type, '蓝蝶活跃任务无进展看门狗跳过', () =>
          bluestacks.runScheduledActiveStep({
            instanceId,
            combinationId: step.combinationId,
            signal: stepAbortCtrl.signal,
            onProgress: (t) => progress(t),
          }),
        );
      else if (step.type === 'bluestacks-group-poster')
        keepGoing = await runBs(
          'bluestacks-group-poster',
          '蓝蝶小组发帖无进展看门狗跳过',
          () =>
            bluestacks.runScheduledPosterStep({
              instanceId,
              materialIds: step.materialIds,
              groupIds: step.groupIds,
              maxGroupsPerProfile: step.maxGroupsPerProfile,
              materialsPerGroup: step.materialsPerGroup,
              postToTimeline: step.postToTimeline,
              signal: stepAbortCtrl.signal,
              onProgress: (txt, p) => progress(txt, 0, p),
            }),
          (res) => void (s.postedCount += res.postedCount),
        );
      else if (step.type === 'bluestacks-group-inviter')
        keepGoing = await runBs(
          'bluestacks-group-inviter',
          '蓝蝶小组邀人无进展看门狗跳过',
          () =>
            bluestacks.runScheduledInviterStep({
              instanceId,
              groupIds: step.groupIds,
              invitesPerGroup: step.invitesPerGroup,
              signal: stepAbortCtrl.signal,
              onProgress: (t) => progress(t),
            }),
          (res) => void (s.invitedCount += res.invitedCount ?? 0),
        );
      else {
        const mode = step.type === 'bluestacks-page-bumper' ? 'page' : 'group';
        const enableSound = typeof step.enableSound === 'boolean' ? step.enableSound : undefined;
        keepGoing = await runBs(
          step.type,
          `${shortLabel}无进展看门狗跳过`,
          () =>
            bluestacks.runScheduledInstanceStep({
              instanceId,
              mode,
              groupIds:
                step.type === 'bluestacks-group-bumper' && Array.isArray(step.groupIds)
                  ? step.groupIds
                  : [],
              pageIds: step.pageIds,
              enableSound,
              minConcurrency: deps.getBluestacksConcurrency(),
              signal: stepAbortCtrl.signal,
              onProgress: (txt, b) => progress(txt, b, 0),
            }),
          (res) => void (s.bumpedCount += res.bumpedCount),
        );
      }
      if (!keepGoing) break;
    }
    return buildPipelineFinalOutcome({ carrier: 'bluestacks', cancelled: ctx.cancelled, ...s });
  } catch (err) {
    if (ctx.cancelled)
      return makePipelineOutcome('stopped', '已手动停止', {
        bumpedCount: s.bumpedCount,
        postedCount: s.postedCount,
        softIssues: s.softIssues,
      });
    return makePipelineOutcome(
      s.watchdogTimedOut || s.safetyCeilingHit ? 'watchdog_timeout' : 'soft_warning',
      `模拟器执行中止：${errMsg(err).slice(0, 100)}`,
      { bumpedCount: s.bumpedCount, postedCount: s.postedCount, softIssues: s.softIssues + 1 },
    );
  } finally {
    watchdog.stop();
    deps.featureExecution.setDelegatedSubmodule(instanceId, null);
    const keepOpenOnCancel = ctx.cancelled && ctx.keepWindowOpenOnCancel;
    const closeOnStop = ctx.cancelled && !ctx.keepWindowOpenOnCancel;
    if (executedVm && (schedule.closeWindowOnFinish || closeOnStop) && !keepOpenOnCancel) {
      emit('关闭模拟器', '正在关闭蓝蝶模拟器释放内存…');
      await bluestacks.closeInstanceForce(instanceId).catch(() => {});
    }
    deps.releaseOwnershipBeforeClose(instanceId);
  }
}
