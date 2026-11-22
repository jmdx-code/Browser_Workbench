import {
  formatStepShortLabel,
  type AutoRunItemStatus,
  type AutoSchedule,
  type AutoSchedulePhase,
  type BluestacksPipelineStep,
  type BrowserPipelineStep,
} from '../shared/auto-scheduler.js';
import { CombinationSchema, type Profile, type SavedCombination } from '../shared/contracts.js';
import type { ProfileLifecyclePort } from '../shared/profile-lifecycle.js';
import { TEST_COMBINATION_NOTE } from '../shared/task-tests.js';
import type { BluestacksService } from './bluestacks-service.js';
import type { FeatureExecutionRegistry } from './feature-execution-registry.js';
import type { GroupBumperService } from './group-bumper-service.js';
import type { GroupInviterService } from './group-inviter-service.js';
import type { GroupPosterService } from './group-poster-service.js';
import type { TaskService } from './task-service.js';
import type { WorkspaceService } from './workspace-service.js';

export interface ActiveTargetExecutionContext {
  readonly runId: string;
  readonly scheduleId: string;
  readonly phase: AutoSchedulePhase;
  readonly targetId: string;
  cancelled: boolean;
  keepWindowOpenOnCancel: boolean;
  handoffToMain: boolean;
  finished: boolean;
  onHandoffReady: Array<() => void>;
  abortStep: () => void;
}

export interface TargetPipelineOutcome {
  status: AutoRunItemStatus;
  summary: string;
  bumpedCount: number;
  postedCount: number;
  softIssues: number;
  hardBlockReason: string | null;
  handedOffToMain: boolean;
}

export interface AutoSchedulerExecutorDeps {
  workspace: WorkspaceService;
  tasks?: TaskService | undefined;
  groupBumper?: GroupBumperService | undefined;
  groupPoster?: GroupPosterService | undefined;
  groupInviter?: GroupInviterService | undefined;
  bluestacks?: BluestacksService | undefined;
  profileLifecycle?: ProfileLifecyclePort | undefined;
  featureExecution: FeatureExecutionRegistry;
  getIdleWatchdogMs: () => number;
  getBrowserConcurrency: () => number;
  getBluestacksConcurrency: () => number;
  releaseOwnershipBeforeClose: (targetId: string) => void;
  pollIntervalMs?: number | undefined;
}

function sleepAbortable(ms: number, isAborted: () => boolean): Promise<void> {
  if (ms <= 0 || isAborted()) return Promise.resolve();
  return new Promise((resolve) => {
    const step = Math.min(250, ms);
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += step;
      if (elapsed >= ms || isAborted()) {
        clearInterval(timer);
        resolve();
      }
    }, step);
  });
}

function classifyBrowserHardAccountIssue(
  profile: Profile | undefined,
  reasonText: string,
): string | null {
  const acctState = profile?.account.state;
  if (acctState === 'logged-out') return '账号已退出登录';
  if (acctState === 'verification') return '账号需身份/手机验证 (Checkpoint)';
  if (acctState === 'restricted') return '账号已被封禁或全局受限';
  if (
    /账号已退出|未登录|登录失效|手机验证|身份验证|验证页面|封号|封禁|账号已停用|checkpoint|logged-out/i.test(
      reasonText,
    ) &&
    !/点赞或评论被 Facebook 限制|暂时限制|小组发帖受限/.test(reasonText)
  ) {
    return reasonText.slice(0, 120);
  }
  return null;
}

export class AutoSchedulerTargetExecutor {
  private readonly quickComboLock = new Map<string, Promise<SavedCombination>>();

  constructor(private readonly deps: AutoSchedulerExecutorDeps) {}

  private async ensureQuickBrowseCombination(
    target: 'feed' | 'video',
    durationMinutes: number,
  ): Promise<SavedCombination> {
    const key = `${target}:${durationMinutes}`;
    const inflight = this.quickComboLock.get(key);
    if (inflight) return inflight;

    const work = (async () => {
      const note = `${TEST_COMBINATION_NOTE}定时排班快捷浏览:${key}`;
      const all = await this.deps.workspace.repository.combinations();
      const existing = all.find((row) => row.saved?.note === note);
      if (existing) return existing;
      const label = target === 'video' ? '刷视频' : '刷首页';
      return await this.deps.workspace.repository.createCombination(
        CombinationSchema.parse({
          name: `排班 · ${label} ${durationMinutes}分钟`,
          note,
          steps: [
            {
              id: globalThis.crypto.randomUUID(),
              type: target,
              durationMinutes,
              maxLikes: 0,
              minLikeCount: 0,
            },
          ],
          randomOrder: false,
          loop: { mode: 'finite', rounds: 1 },
        }),
      );
    })();

    this.quickComboLock.set(key, work);
    try {
      return await work;
    } finally {
      this.quickComboLock.delete(key);
    }
  }

  private async stopAllBrowserSubmodules(profileId: string): Promise<void> {
    await Promise.allSettled([
      this.deps.tasks?.stopActiveProfile(profileId),
      this.deps.groupBumper?.stop([profileId]),
      this.deps.groupPoster?.stopProfiles([profileId]),
      this.deps.groupInviter?.stopProfiles({ profileIds: [profileId] }),
    ]);
  }

  private async runActiveCombinationStep(input: {
    profileId: string;
    combinationId: string;
    stepLabel: string;
    ctx: ActiveTargetExecutionContext;
    isStepAborted: () => boolean;
    onProgress: (stepText: string, detail: string) => void;
  }): Promise<{ hardBlockReason: string | null; softIssue: string | null }> {
    const { tasks, workspace, featureExecution } = this.deps;
    if (!tasks) {
      return { hardBlockReason: null, softIssue: '活跃任务执行器未就绪' };
    }
    const combos = await workspace.repository.combinations();
    const combo = combos.find((c) => c.id === input.combinationId);
    if (!combo || !combo.saved || combo.version <= 0) {
      return { hardBlockReason: null, softIssue: '所选活跃任务组合不存在或尚未保存' };
    }

    const curSettings = await tasks.settings();
    const neededCap = Math.max(
      curSettings.maxConcurrentProfiles,
      this.deps.getBrowserConcurrency(),
    );
    if (neededCap > curSettings.maxConcurrentProfiles) {
      await tasks.setSettings({ maxConcurrentProfiles: neededCap }).catch(() => {});
    }

    await tasks.releaseErroredPausedPlans([input.profileId]).catch(() => {});
    const liveBefore = await tasks.livePlans();
    if (liveBefore.some((p) => p.profileId === input.profileId)) {
      await tasks.stopActiveProfile(input.profileId).catch(() => {});
    }

    const requestId = globalThis.crypto.randomUUID();
    featureExecution.setDelegatedSubmodule(input.profileId, 'active-accounts');
    try {
      const started = await tasks.start({
        requestId,
        combinationId: combo.id,
        version: combo.version,
        profileIds: [input.profileId],
      });
      const plan = started.plans[0];
      if (!plan) {
        return { hardBlockReason: null, softIssue: '活跃组合未能创建执行计划' };
      }

      let lastProgressFingerprint = '';
      let pausedSince: number | null = null;
      const pollMs = Math.max(20, this.deps.pollIntervalMs ?? 1500);

      while (!input.isStepAborted()) {
        await sleepAbortable(pollMs, input.isStepAborted);
        if (input.isStepAborted()) break;

        const batchPlans = await tasks.plansForBatch(requestId);
        const curPlan = batchPlans.find((p) => p.id === plan.id);
        if (!curPlan) break;

        if (['COMPLETED', 'FAILED', 'STOPPED'].includes(curPlan.state)) {
          if (curPlan.state === 'COMPLETED') {
            input.onProgress(input.stepLabel, `${combo.saved.name} 已完成`);
            return { hardBlockReason: null, softIssue: null };
          }
          const snap = await workspace.snapshot();
          const prof = snap.profiles.find((p) => p.id === input.profileId);
          const hard = classifyBrowserHardAccountIssue(prof, curPlan.reason);
          if (hard) return { hardBlockReason: hard, softIssue: null };
          return {
            hardBlockReason: null,
            softIssue: curPlan.reason || '活跃步骤局部未完成',
          };
        }

        // Unattended protection: never allow REVIEW or prolonged PAUSED to block the slot forever
        if (curPlan.state === 'REVIEW') {
          await tasks.stopActiveProfile(input.profileId).catch(() => {});
          const snap = await workspace.snapshot();
          const prof = snap.profiles.find((p) => p.id === input.profileId);
          const hard = classifyBrowserHardAccountIssue(prof, curPlan.reason);
          if (hard) return { hardBlockReason: hard, softIssue: null };
          return {
            hardBlockReason: null,
            softIssue: `遇到待确认状态已自动跳过 (${curPlan.reason || 'REVIEW'})`,
          };
        }

        if (curPlan.state === 'PAUSED') {
          pausedSince ??= Date.now();
          if (Date.now() - pausedSince > 25_000) {
            await tasks.stopActiveProfile(input.profileId).catch(() => {});
            const snap = await workspace.snapshot();
            const prof = snap.profiles.find((p) => p.id === input.profileId);
            const hard = classifyBrowserHardAccountIssue(prof, curPlan.reason);
            if (hard) return { hardBlockReason: hard, softIssue: null };
            return {
              hardBlockReason: null,
              softIssue: `任务暂停超时已自动跳过 (${curPlan.reason || 'PAUSED'})`,
            };
          }
        } else {
          pausedSince = null;
        }

        const runtime = await tasks
          .runtimeOverview({ profileIds: [input.profileId] })
          .catch(() => null);
        const curStep = runtime?.currentSteps.find((s) => s.jobId === curPlan.id);
        const fp = curStep
          ? `${curPlan.round}:${curPlan.position}:${curStep.status}:${curStep.progress.effectiveMilliseconds}:${curStep.progress.likes}:${curStep.progress.published}:${curStep.progress.accepted ?? 0}`
          : `${curPlan.state}:${curPlan.round}:${curPlan.position}:${curPlan.updatedAt}`;

        if (fp !== lastProgressFingerprint) {
          lastProgressFingerprint = fp;
          const sec = curStep ? Math.floor(curStep.progress.effectiveMilliseconds / 1000) : 0;
          const detail = curStep
            ? `${combo.saved.name} · 第 ${curPlan.position + 1} 步 (${sec}s)`
            : `${combo.saved.name} · ${curPlan.state}`;
          input.onProgress(input.stepLabel, detail);
        }
      }

      if (input.isStepAborted()) {
        await tasks.stopActiveProfile(input.profileId).catch(() => {});
      }
      return { hardBlockReason: null, softIssue: null };
    } finally {
      featureExecution.setDelegatedSubmodule(input.profileId, null);
    }
  }

  async executeBrowserTarget(input: {
    schedule: Extract<AutoSchedule, { carrier: 'browser' }>;
    phase: AutoSchedulePhase;
    profileId: string;
    seamlessEntered: boolean;
    safetyCeilingMinutes: number | null;
    ctx: ActiveTargetExecutionContext;
    onUpdate: (patch: {
      currentStep: string;
      summary: string;
      bumpedCount: number;
      postedCount: number;
      softIssues: number;
    }) => void;
  }): Promise<TargetPipelineOutcome> {
    const { schedule, phase, profileId, ctx, onUpdate } = input;
    const steps: BrowserPipelineStep[] =
      phase === 'prewarm' ? schedule.prewarm.steps : schedule.steps;

    let bumpedCount = 0;
    let postedCount = 0;
    let softIssues = 0;
    let hardBlockReason: string | null = null;
    let watchdogTimedOut = false;
    let safetyCeilingHit = false;
    const softNotes: string[] = [];

    const startedAt = Date.now();
    let lastProgressAt = Date.now();
    let currentStepAbort = false;
    ctx.abortStep = () => {
      currentStepAbort = true;
      void this.stopAllBrowserSubmodules(profileId);
    };

    const safetyCeilingMs =
      input.safetyCeilingMinutes && input.safetyCeilingMinutes > 0
        ? input.safetyCeilingMinutes * 60_000
        : null;

    const touchProgress = (stepLabel: string, summaryText: string) => {
      lastProgressAt = Date.now();
      onUpdate({
        currentStep: stepLabel,
        summary: summaryText,
        bumpedCount,
        postedCount,
        softIssues,
      });
    };

    const watchdogTickMs = Math.min(
      2000,
      Math.max(30, Math.floor((this.deps.pollIntervalMs ?? 1500) * 1.3)),
    );
    const watchdogTimer = setInterval(() => {
      if (ctx.cancelled || ctx.handoffToMain) return;
      const now = Date.now();
      if (safetyCeilingMs !== null && now - startedAt > safetyCeilingMs) {
        safetyCeilingHit = true;
        currentStepAbort = true;
        void this.stopAllBrowserSubmodules(profileId);
        return;
      }
      const idleLimitMs = Math.max(50, this.deps.getIdleWatchdogMs());
      if (now - lastProgressAt > idleLimitMs) {
        lastProgressAt = now;
        watchdogTimedOut = true;
        currentStepAbort = true;
        void this.stopAllBrowserSubmodules(profileId);
      }
    }, watchdogTickMs);

    let launchedBrowser = false;
    try {
      if (ctx.cancelled || ctx.handoffToMain) {
        return {
          status: ctx.handoffToMain ? 'completed' : 'stopped',
          summary: ctx.handoffToMain ? '无缝切换至正点场' : '已取消启动',
          bumpedCount: 0,
          postedCount: 0,
          softIssues: 0,
          hardBlockReason: null,
          handedOffToMain: ctx.handoffToMain,
        };
      }
      // Step 0: Launch or verify browser window online
      touchProgress(
        '启动浏览器',
        input.seamlessEntered ? '复用预热已开窗口' : '正在打开浏览器并连接插件…',
      );
      if (this.deps.profileLifecycle) {
        launchedBrowser = true;
        const launchRes = await this.deps.profileLifecycle.ensureProfilesOnline([profileId]);
        if (ctx.cancelled || ctx.handoffToMain) {
          return {
            status: ctx.handoffToMain ? 'completed' : 'stopped',
            summary: ctx.handoffToMain ? '无缝切换至正点场' : '已停止',
            bumpedCount: 0,
            postedCount: 0,
            softIssues: 0,
            hardBlockReason: null,
            handedOffToMain: ctx.handoffToMain,
          };
        }
        if (launchRes.failed.length > 0 && launchRes.readyIds.length === 0) {
          const failMsg = launchRes.failed[0]?.reason ?? '浏览器启动失败';
          return {
            status: 'soft_warning',
            summary: `启动跳过：${failMsg}`,
            bumpedCount: 0,
            postedCount: 0,
            softIssues: 1,
            hardBlockReason: null,
            handedOffToMain: false,
          };
        }
      }

      // Check cached/live account state right after launch
      const postLaunchSnap = await this.deps.workspace.snapshot();
      const launchedProfile = postLaunchSnap.profiles.find((p) => p.id === profileId);
      if (
        schedule.targetSelector.skipAbnormalAccounts &&
        launchedProfile &&
        (launchedProfile.account.state === 'logged-out' ||
          launchedProfile.account.state === 'verification' ||
          launchedProfile.account.state === 'restricted')
      ) {
        hardBlockReason = classifyBrowserHardAccountIssue(launchedProfile, '') ?? '账号状态异常';
      }

      for (let idx = 0; idx < steps.length && !hardBlockReason; idx++) {
        if (ctx.cancelled || ctx.handoffToMain || safetyCeilingHit || watchdogTimedOut) break;
        const step = steps[idx];
        if (!step) continue;

        currentStepAbort = false;
        watchdogTimedOut = false;
        const stepLabel = `步骤 ${idx + 1}/${steps.length} · ${formatStepShortLabel(step)}`;
        touchProgress(stepLabel, `开始执行 ${formatStepShortLabel(step)}`);

        const isAborted = () =>
          ctx.cancelled || ctx.handoffToMain || currentStepAbort || safetyCeilingHit;

        if (step.type === 'quick-browse') {
          const quickCombo = await this.ensureQuickBrowseCombination(
            step.target,
            step.durationMinutes,
          );
          const res = await this.runActiveCombinationStep({
            profileId,
            combinationId: quickCombo.id,
            stepLabel,
            ctx,
            isStepAborted: isAborted,
            onProgress: (lbl, detail) => touchProgress(lbl, detail),
          });
          if (res.hardBlockReason) {
            hardBlockReason = res.hardBlockReason;
            break;
          }
          if (watchdogTimedOut) {
            softIssues++;
            softNotes.push(`${formatStepShortLabel(step)}无进展超时已跳过`);
          } else if (res.softIssue) {
            softIssues++;
            softNotes.push(res.softIssue);
          }
        } else if (step.type === 'active-combination') {
          const res = await this.runActiveCombinationStep({
            profileId,
            combinationId: step.combinationId,
            stepLabel,
            ctx,
            isStepAborted: isAborted,
            onProgress: (lbl, detail) => touchProgress(lbl, detail),
          });
          if (res.hardBlockReason) {
            hardBlockReason = res.hardBlockReason;
            break;
          }
          if (watchdogTimedOut) {
            softIssues++;
            softNotes.push('活跃组合无进展超时已跳过');
          } else if (res.softIssue) {
            softIssues++;
            softNotes.push(res.softIssue);
          }
        } else if (step.type === 'group-bumper' || step.type === 'page-bumper') {
          if (!this.deps.groupBumper) {
            softIssues++;
            softNotes.push('顶贴服务未就绪');
            continue;
          }
          const mode = step.type;
          this.deps.featureExecution.setDelegatedSubmodule(profileId, mode);
          try {
            const res = await this.deps.groupBumper.runScheduledProfileStep({
              profileId,
              mode,
              groupIds: step.type === 'group-bumper' ? step.groupIds : [],
              pageIds: step.pageIds,
              minConcurrency: this.deps.getBrowserConcurrency(),
              onProgress: (statusText, sessionBumps) => {
                lastProgressAt = Date.now();
                onUpdate({
                  currentStep: stepLabel,
                  summary: statusText,
                  bumpedCount: bumpedCount + sessionBumps,
                  postedCount,
                  softIssues,
                });
              },
            });
            bumpedCount += res.bumpedCount;
            if (res.hardBlocked) {
              hardBlockReason = res.status;
              break;
            }
            if (watchdogTimedOut) {
              softIssues++;
              softNotes.push(`${mode === 'page-bumper' ? '专页顶贴' : '小组顶贴'}无进展看门狗跳过`);
            } else if (res.softIssue && !ctx.cancelled && !ctx.handoffToMain) {
              softIssues++;
              softNotes.push(res.status);
            }
          } finally {
            this.deps.featureExecution.setDelegatedSubmodule(profileId, null);
          }
        } else if (step.type === 'group-poster') {
          if (!this.deps.groupPoster) {
            softIssues++;
            softNotes.push('小组发帖服务未就绪');
            continue;
          }
          this.deps.featureExecution.setDelegatedSubmodule(profileId, 'group-poster');
          try {
            const res = await this.deps.groupPoster.runScheduledProfileStep({
              profileId,
              materialIds: step.materialIds,
              groupIds: step.groupIds,
              maxGroupsPerProfile: step.maxGroupsPerProfile,
              onProgress: (statusText, sessionPosted) => {
                lastProgressAt = Date.now();
                onUpdate({
                  currentStep: stepLabel,
                  summary: statusText,
                  bumpedCount,
                  postedCount: postedCount + sessionPosted,
                  softIssues,
                });
              },
            });
            postedCount += res.postedCount;
            if (res.hardBlocked) {
              hardBlockReason = res.status;
              break;
            }
            if (watchdogTimedOut) {
              softIssues++;
              softNotes.push('小组发帖无进展看门狗跳过');
            } else if (res.softIssue && !ctx.cancelled && !ctx.handoffToMain) {
              softIssues++;
              softNotes.push(res.status);
            }
          } finally {
            this.deps.featureExecution.setDelegatedSubmodule(profileId, null);
          }
        }

        const snapAfterStep = await this.deps.workspace.snapshot();
        const profAfterStep = snapAfterStep.profiles.find((p) => p.id === profileId);
        const postStepHard = classifyBrowserHardAccountIssue(profAfterStep, '');
        if (postStepHard) {
          hardBlockReason = postStepHard;
          break;
        }
      }

      if (ctx.cancelled) {
        return {
          status: 'stopped',
          summary: '已手动停止',
          bumpedCount,
          postedCount,
          softIssues,
          hardBlockReason: null,
          handedOffToMain: false,
        };
      }
      if (ctx.handoffToMain) {
        return {
          status: 'completed',
          summary: '正点时间已到，已无缝衔接切入正点顶贴场',
          bumpedCount,
          postedCount,
          softIssues,
          hardBlockReason: null,
          handedOffToMain: true,
        };
      }
      if (hardBlockReason) {
        return {
          status: 'hard_blocked',
          summary: `账号异常已自动收尾关闭：${hardBlockReason}`,
          bumpedCount,
          postedCount,
          softIssues,
          hardBlockReason,
          handedOffToMain: false,
        };
      }
      if (
        safetyCeilingHit ||
        (watchdogTimedOut && softIssues > 0 && bumpedCount === 0 && postedCount === 0)
      ) {
        return {
          status: 'watchdog_timeout',
          summary: safetyCeilingHit
            ? '达到单号安全总时长上限，已自动收尾关闭窗口'
            : `步骤无进展看门狗触发收尾 (${softNotes[0] ?? '页面长时间无响应'})`,
          bumpedCount,
          postedCount,
          softIssues,
          hardBlockReason: null,
          handedOffToMain: false,
        };
      }

      const statParts: string[] = [];
      if (bumpedCount > 0) statParts.push(`顶贴 ${bumpedCount} 次`);
      if (postedCount > 0) statParts.push(`发帖 ${postedCount} 组`);
      if (softIssues > 0) {
        statParts.push(`软跳过 ${softIssues} 项 (${softNotes[0] ?? '局部受限'})`);
        return {
          status: 'soft_warning',
          summary: `已完成收尾 · ${statParts.join(' · ')}`,
          bumpedCount,
          postedCount,
          softIssues,
          hardBlockReason: null,
          handedOffToMain: false,
        };
      }
      return {
        status: 'completed',
        summary:
          statParts.length > 0 ? `已完成 · ${statParts.join(' · ')}` : '已完成全部流水线步骤',
        bumpedCount,
        postedCount,
        softIssues: 0,
        hardBlockReason: null,
        handedOffToMain: false,
      };
    } finally {
      clearInterval(watchdogTimer);
      this.deps.featureExecution.setDelegatedSubmodule(profileId, null);
      await this.stopAllBrowserSubmodules(profileId);
      const shouldKeepOpenForHandoff = ctx.handoffToMain && !hardBlockReason && !ctx.cancelled;
      const shouldKeepOpenOnManualCancel = ctx.cancelled && ctx.keepWindowOpenOnCancel;
      if (
        launchedBrowser &&
        schedule.closeWindowOnFinish &&
        !shouldKeepOpenForHandoff &&
        !shouldKeepOpenOnManualCancel &&
        this.deps.profileLifecycle
      ) {
        onUpdate({
          currentStep: '关闭浏览器',
          summary: '正在安全关闭浏览器释放内存…',
          bumpedCount,
          postedCount,
          softIssues,
        });
        const firstClose = await this.deps.profileLifecycle
          .closeProfile(profileId, { timeoutMs: 12_000, stopTasksFirst: false })
          .catch(() => null);
        if (!firstClose || !firstClose.ok) {
          await new Promise<void>((r) => setTimeout(r, 800));
          await this.deps.profileLifecycle
            .closeProfile(profileId, { timeoutMs: 10_000, stopTasksFirst: false })
            .catch(() => null);
        }
      }
      this.deps.releaseOwnershipBeforeClose(profileId);
      ctx.finished = true;
      for (const listener of ctx.onHandoffReady.splice(0)) listener();
    }
  }

  async executeBluestacksTarget(input: {
    schedule: Extract<AutoSchedule, { carrier: 'bluestacks' }>;
    instanceId: string;
    safetyCeilingMinutes: number | null;
    ctx: ActiveTargetExecutionContext;
    onUpdate: (patch: {
      currentStep: string;
      summary: string;
      bumpedCount: number;
      postedCount: number;
      softIssues: number;
    }) => void;
  }): Promise<TargetPipelineOutcome> {
    const { schedule, instanceId, ctx, onUpdate } = input;
    const bluestacks = this.deps.bluestacks;
    if (!bluestacks) {
      return {
        status: 'soft_warning',
        summary: '蓝蝶模拟器服务未初始化',
        bumpedCount: 0,
        postedCount: 0,
        softIssues: 1,
        hardBlockReason: null,
        handedOffToMain: false,
      };
    }

    let bumpedCount = 0;
    let postedCount = 0;
    let softIssues = 0;
    let hardBlockReason: string | null = null;
    let watchdogTimedOut = false;
    let safetyCeilingHit = false;
    const softNotes: string[] = [];

    const startedAt = Date.now();
    let lastProgressAt = Date.now();
    let stepAbortCtrl = new AbortController();
    ctx.abortStep = () => {
      stepAbortCtrl.abort(new Error('TASK_STOPPED'));
      const stopFn =
        typeof bluestacks.stopAllForInstances === 'function'
          ? bluestacks.stopAllForInstances([instanceId])
          : bluestacks.stopBumper([instanceId]);
      void stopFn.catch(() => {});
    };

    const safetyCeilingMs =
      input.safetyCeilingMinutes && input.safetyCeilingMinutes > 0
        ? input.safetyCeilingMinutes * 60_000
        : null;

    const watchdogTickMs = Math.min(
      2000,
      Math.max(30, Math.floor((this.deps.pollIntervalMs ?? 1500) * 1.3)),
    );
    const watchdogTimer = setInterval(() => {
      if (ctx.cancelled) return;
      const now = Date.now();
      if (safetyCeilingMs !== null && now - startedAt > safetyCeilingMs) {
        safetyCeilingHit = true;
        stepAbortCtrl.abort(new Error('SAFETY_CEILING_TIMEOUT'));
        void bluestacks.stopAllForInstances([instanceId]).catch(() => {});
        return;
      }
      const idleLimitMs = Math.max(50, this.deps.getIdleWatchdogMs());
      if (now - lastProgressAt > idleLimitMs) {
        lastProgressAt = now;
        watchdogTimedOut = true;
        stepAbortCtrl.abort(new Error('IDLE_WATCHDOG_TIMEOUT'));
        void bluestacks.stopAllForInstances([instanceId]).catch(() => {});
      }
    }, watchdogTickMs);

    let launchedVm = false;
    try {
      if (ctx.cancelled) {
        return {
          status: 'stopped',
          summary: '已取消启动模拟器',
          bumpedCount: 0,
          postedCount: 0,
          softIssues: 0,
          hardBlockReason: null,
          handedOffToMain: false,
        };
      }
      onUpdate({
        currentStep: '启动模拟器',
        summary: '正在启动蓝蝶窗口并等待 ADB 就绪…',
        bumpedCount: 0,
        postedCount: 0,
        softIssues: 0,
      });
      launchedVm = true;
      await bluestacks.ensureInstanceOnlineForSchedule(instanceId, stepAbortCtrl.signal);
      if (ctx.cancelled) {
        return {
          status: 'stopped',
          summary: '已停止',
          bumpedCount: 0,
          postedCount: 0,
          softIssues: 0,
          hardBlockReason: null,
          handedOffToMain: false,
        };
      }
      lastProgressAt = Date.now();

      const steps: BluestacksPipelineStep[] = schedule.steps;
      for (let idx = 0; idx < steps.length && !hardBlockReason; idx++) {
        if (ctx.cancelled || safetyCeilingHit) break;
        const step = steps[idx];
        if (!step) continue;

        watchdogTimedOut = false;
        stepAbortCtrl = new AbortController();
        const stepLabel = `步骤 ${idx + 1}/${steps.length} · ${formatStepShortLabel(step)}`;

        if (step.type === 'bluestacks-health-check') {
          this.deps.featureExecution.setDelegatedSubmodule(instanceId, 'bluestacks-health-check');
          try {
            const res = await bluestacks.runScheduledHealthCheckStep({
              instanceId,
              autoInstallApk: step.autoInstallApk,
              signal: stepAbortCtrl.signal,
              onProgress: (statusText) => {
                lastProgressAt = Date.now();
                onUpdate({
                  currentStep: stepLabel,
                  summary: statusText,
                  bumpedCount,
                  postedCount,
                  softIssues,
                });
              },
            });
            if (res.hardBlocked) {
              hardBlockReason = res.status;
              break;
            }
            if (watchdogTimedOut) {
              softIssues++;
              softNotes.push('蓝蝶健康体检无进展看门狗跳过');
            } else if (res.softIssue && !ctx.cancelled) {
              softIssues++;
              softNotes.push(res.status);
            }
          } finally {
            this.deps.featureExecution.setDelegatedSubmodule(instanceId, null);
          }
        } else if (
          step.type === 'bluestacks-quick-browse' ||
          step.type === 'bluestacks-active-combination'
        ) {
          this.deps.featureExecution.setDelegatedSubmodule(instanceId, 'bluestacks-active');
          try {
            const res = await bluestacks.runScheduledActiveStep({
              instanceId,
              ...(step.type === 'bluestacks-active-combination'
                ? { combinationId: step.combinationId }
                : {
                    quickStep: {
                      type: step.target,
                      durationMinutes: step.durationMinutes,
                      maxLikes: 1,
                    },
                  }),
              signal: stepAbortCtrl.signal,
              onProgress: (statusText) => {
                lastProgressAt = Date.now();
                onUpdate({
                  currentStep: stepLabel,
                  summary: statusText,
                  bumpedCount,
                  postedCount,
                  softIssues,
                });
              },
            });
            if (res.hardBlocked) {
              hardBlockReason = res.status;
              break;
            }
            if (watchdogTimedOut) {
              softIssues++;
              softNotes.push(`${formatStepShortLabel(step)}无进展看门狗跳过`);
            } else if (res.softIssue && !ctx.cancelled) {
              softIssues++;
              softNotes.push(res.status);
            }
          } finally {
            this.deps.featureExecution.setDelegatedSubmodule(instanceId, null);
          }
        } else if (step.type === 'bluestacks-group-poster') {
          this.deps.featureExecution.setDelegatedSubmodule(instanceId, 'bluestacks-group-poster');
          try {
            const res = await bluestacks.runScheduledPosterStep({
              instanceId,
              materialIds: step.materialIds,
              groupIds: step.groupIds,
              maxGroupsPerProfile: step.maxGroupsPerProfile,
              postToTimeline: step.postToTimeline,
              signal: stepAbortCtrl.signal,
              onProgress: (statusText, sessionPosted) => {
                lastProgressAt = Date.now();
                onUpdate({
                  currentStep: stepLabel,
                  summary: statusText,
                  bumpedCount,
                  postedCount: postedCount + sessionPosted,
                  softIssues,
                });
              },
            });
            postedCount += res.postedCount;
            if (res.hardBlocked) {
              hardBlockReason = res.status;
              break;
            }
            if (watchdogTimedOut) {
              softIssues++;
              softNotes.push('蓝蝶小组发帖无进展看门狗跳过');
            } else if (res.softIssue && !ctx.cancelled) {
              softIssues++;
              softNotes.push(res.status);
            }
          } finally {
            this.deps.featureExecution.setDelegatedSubmodule(instanceId, null);
          }
        } else if (step.type === 'bluestacks-group-inviter') {
          this.deps.featureExecution.setDelegatedSubmodule(instanceId, 'bluestacks-group-inviter');
          try {
            const res = await bluestacks.runScheduledInviterStep({
              instanceId,
              groupIds: step.groupIds,
              invitesPerGroup: step.invitesPerGroup,
              signal: stepAbortCtrl.signal,
              onProgress: (statusText) => {
                lastProgressAt = Date.now();
                onUpdate({
                  currentStep: stepLabel,
                  summary: statusText,
                  bumpedCount,
                  postedCount,
                  softIssues,
                });
              },
            });
            if (res.hardBlocked) {
              hardBlockReason = res.status;
              break;
            }
            if (watchdogTimedOut) {
              softIssues++;
              softNotes.push('蓝蝶小组邀人无进展看门狗跳过');
            } else if (res.softIssue && !ctx.cancelled) {
              softIssues++;
              softNotes.push(res.status);
            }
          } finally {
            this.deps.featureExecution.setDelegatedSubmodule(instanceId, null);
          }
        } else {
          const mode = step.type === 'bluestacks-page-bumper' ? 'page' : 'group';
          const moduleId = mode === 'page' ? 'bluestacks-page-bumper' : 'bluestacks-group-bumper';
          this.deps.featureExecution.setDelegatedSubmodule(instanceId, moduleId);
          try {
            const res = await bluestacks.runScheduledInstanceStep({
              instanceId,
              mode,
              groupIds: step.type === 'bluestacks-group-bumper' ? step.groupIds : [],
              pageIds: step.pageIds,
              enableSound: step.enableSound,
              minConcurrency: this.deps.getBluestacksConcurrency(),
              signal: stepAbortCtrl.signal,
              onProgress: (statusText, sessionBumps) => {
                lastProgressAt = Date.now();
                onUpdate({
                  currentStep: stepLabel,
                  summary: statusText,
                  bumpedCount: bumpedCount + sessionBumps,
                  postedCount,
                  softIssues,
                });
              },
            });
            bumpedCount += res.bumpedCount;
            if (res.hardBlocked) {
              hardBlockReason = res.status;
              break;
            }
            if (watchdogTimedOut) {
              softIssues++;
              softNotes.push(`${formatStepShortLabel(step)}无进展看门狗跳过`);
            } else if (res.softIssue && !ctx.cancelled) {
              softIssues++;
              softNotes.push(res.status);
            }
          } finally {
            this.deps.featureExecution.setDelegatedSubmodule(instanceId, null);
          }
        }
      }

      if (ctx.cancelled) {
        return {
          status: 'stopped',
          summary: '已手动停止',
          bumpedCount,
          postedCount,
          softIssues,
          hardBlockReason: null,
          handedOffToMain: false,
        };
      }
      if (hardBlockReason) {
        return {
          status: 'hard_blocked',
          summary: `模拟器账号异常已自动关闭：${hardBlockReason}`,
          bumpedCount,
          postedCount,
          softIssues,
          hardBlockReason,
          handedOffToMain: false,
        };
      }
      if (safetyCeilingHit || (watchdogTimedOut && bumpedCount === 0 && postedCount === 0)) {
        return {
          status: 'watchdog_timeout',
          summary: safetyCeilingHit
            ? '达到模拟器单号安全总上限，已自动关闭窗口'
            : `无进展看门狗触发关闭 (${softNotes[0] ?? '模拟器无响应'})`,
          bumpedCount,
          postedCount,
          softIssues,
          hardBlockReason: null,
          handedOffToMain: false,
        };
      }
      const statParts: string[] = [];
      if (bumpedCount > 0) statParts.push(`顶贴 ${bumpedCount} 条`);
      if (postedCount > 0) statParts.push(`发帖 ${postedCount} 组`);
      if (softIssues > 0) {
        return {
          status: 'soft_warning',
          summary: `已完成${statParts.length ? ' · ' + statParts.join(' · ') : ''} · 局部跳过 (${softNotes[0] ?? '受限'})`,
          bumpedCount,
          postedCount,
          softIssues,
          hardBlockReason: null,
          handedOffToMain: false,
        };
      }
      return {
        status: 'completed',
        summary: statParts.length ? `已完成 · ${statParts.join(' · ')}` : '已完成全部模拟器步骤',
        bumpedCount,
        postedCount,
        softIssues: 0,
        hardBlockReason: null,
        handedOffToMain: false,
      };
    } catch (err) {
      if (ctx.cancelled) {
        return {
          status: 'stopped',
          summary: '已手动停止',
          bumpedCount,
          postedCount,
          softIssues,
          hardBlockReason: null,
          handedOffToMain: false,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: watchdogTimedOut || safetyCeilingHit ? 'watchdog_timeout' : 'soft_warning',
        summary: `模拟器执行中止：${msg.slice(0, 100)}`,
        bumpedCount,
        postedCount,
        softIssues: softIssues + 1,
        hardBlockReason: null,
        handedOffToMain: false,
      };
    } finally {
      clearInterval(watchdogTimer);
      this.deps.featureExecution.setDelegatedSubmodule(instanceId, null);
      const shouldKeepOpenOnManualCancel = ctx.cancelled && ctx.keepWindowOpenOnCancel;
      if (launchedVm && schedule.closeWindowOnFinish && !shouldKeepOpenOnManualCancel) {
        onUpdate({
          currentStep: '关闭模拟器',
          summary: '正在关闭蓝蝶模拟器释放内存…',
          bumpedCount,
          postedCount,
          softIssues,
        });
        await bluestacks.closeInstanceForce(instanceId).catch(() => {});
      }
      this.deps.releaseOwnershipBeforeClose(instanceId);
      ctx.finished = true;
      for (const listener of ctx.onHandoffReady.splice(0)) listener();
    }
  }
}
