import type { AutoSchedule, AutoSchedulePhase } from '../shared/auto-scheduler.js';
import { CombinationSchema, type Profile, type SavedCombination } from '../shared/contracts.js';
import { needsResourceTable } from '../domain/resource-material-rules.js';
import { devDiag } from '../shared/dev-diagnostics.js';
import type { ProfileLifecyclePort } from '../shared/profile-lifecycle.js';
import { TEST_COMBINATION_NOTE } from '../shared/task-tests.js';
import type { BluestacksService } from './bluestacks-service.js';
import type { FeatureExecutionRegistry } from './feature-execution-registry.js';
import type { GroupBumperService } from './group-bumper-service.js';
import type { GroupInviterService } from './group-inviter-service.js';
import type { GroupPosterService } from './group-poster-service.js';
import { errMsg } from './module-worker-pool.js';
import {
  runBluestacksTargetPipeline,
  runBrowserTargetPipeline,
} from './scheduler/pipeline-runners.js';
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
  status: 'completed' | 'soft_warning' | 'hard_blocked' | 'watchdog_timeout' | 'stopped';
  summary: string;
  bumpedCount: number;
  postedCount: number;
  softIssues: number;
  hardBlockReason: string | null;
  handedOffToMain: boolean;
}

export interface AutoSchedulerExecutorDeps {
  workspace: WorkspaceService;
  tasks?: TaskService;
  groupBumper?: GroupBumperService;
  groupPoster?: GroupPosterService;
  groupInviter?: GroupInviterService;
  bluestacks?: BluestacksService;
  profileLifecycle?: ProfileLifecyclePort;
  featureExecution: FeatureExecutionRegistry;
  getIdleWatchdogMs: () => number;
  getBrowserConcurrency: () => number;
  getBluestacksConcurrency: () => number;
  releaseOwnershipBeforeClose: (targetId: string) => void;
  pollIntervalMs?: number;
}

export type TargetProgressPatch = {
  currentStep: string;
  summary: string;
  bumpedCount: number;
  postedCount: number;
  softIssues: number;
};

export interface PipelineStepResult {
  status: string;
  hardBlocked?: boolean;
  softIssue?: boolean;
}

export function finishTargetContext(ctx: ActiveTargetExecutionContext): void {
  ctx.finished = true;
  for (const listener of ctx.onHandoffReady.splice(0)) listener();
}

export function sleepAbortable(ms: number, isAborted: () => boolean): Promise<void> {
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
    timer.unref?.();
  });
}

export function classifyBrowserHardAccountIssue(
  profile: Profile | undefined,
  reasonText: string,
): string | null {
  const st = profile?.account.state;
  if (st === 'logged-out') return '账号已退出登录';
  if (st === 'verification') return '账号需身份/手机验证 (Checkpoint)';
  if (st === 'restricted') return '账号已被封禁或全局受限';
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

export async function ensureQuickBrowseCombination(
  workspace: WorkspaceService,
  quickComboLock: Map<string, Promise<SavedCombination>>,
  target: 'feed' | 'video',
  durationMinutes: number,
): Promise<SavedCombination> {
  const key = `${target}:${durationMinutes}`;
  const inflight = quickComboLock.get(key);
  if (inflight) return inflight;
  const work = (async () => {
    const note = `${TEST_COMBINATION_NOTE}定时排班快捷浏览:${key}`;
    const existing = (await workspace.repository.combinations()).find(
      (row) => row.saved?.note === note,
    );
    if (existing) return existing;
    return workspace.repository.createCombination(
      CombinationSchema.parse({
        name: `排班 · ${target === 'video' ? '刷视频' : '刷首页'} ${durationMinutes}分钟`,
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
  quickComboLock.set(key, work);
  try {
    return await work;
  } finally {
    quickComboLock.delete(key);
  }
}

export const stopAllBrowserSubmodules = (deps: AutoSchedulerExecutorDeps, profileId: string) =>
  Promise.allSettled([
    deps.tasks?.stopActiveProfile(profileId),
    deps.groupBumper?.stop([profileId]),
    deps.groupPoster?.stopProfiles([profileId]),
    deps.groupInviter?.stopProfiles({ profileIds: [profileId] }),
  ]);

export async function runActiveCombinationStep(
  deps: AutoSchedulerExecutorDeps,
  profileId: string,
  combinationId: string,
  stepLabel: string,
  isStepAborted: () => boolean,
  onProgress: (stepText: string, detail: string) => void,
): Promise<{ hardBlockReason: string | null; softIssue: string | null }> {
  const { tasks, workspace, featureExecution } = deps;
  if (!tasks) return { hardBlockReason: null, softIssue: '活跃任务执行器未就绪' };
  const combo = (await workspace.repository.combinations()).find((c) => c.id === combinationId);
  if (!combo || !combo.saved || combo.version <= 0)
    return { hardBlockReason: null, softIssue: '所选活跃任务组合不存在或尚未保存' };
  if (combo.saved.loop.mode === 'until-stopped')
    return {
      hardBlockReason: null,
      softIssue: '活跃组合设置为无限循环，无法在无人值守排班中自动收尾',
    };

  let expectedResourceRevision: number | undefined;
  if (needsResourceTable(combo.saved)) {
    const rev = await tasks.currentResourceRevision?.(combo.id);
    if (!rev)
      return {
        hardBlockReason: null,
        softIssue: `活跃组合「${combo.saved.name}」的发帖资源表为空，已自动跳过`,
      };
    expectedResourceRevision = rev;
  }
  const curSettings = await tasks.settings();
  const neededCap = Math.max(curSettings.maxConcurrentProfiles, deps.getBrowserConcurrency());
  if (neededCap > curSettings.maxConcurrentProfiles)
    await tasks.setSettings({ maxConcurrentProfiles: neededCap }).catch(() => {});
  if ((await tasks.livePlans()).some((p) => p.profileId === profileId))
    await tasks.stopActiveProfile(profileId).catch(() => {});

  const requestId = globalThis.crypto.randomUUID();
  featureExecution.setDelegatedSubmodule(profileId, 'active-accounts');
  try {
    const started = await tasks.start({
      requestId,
      combinationId: combo.id,
      version: combo.version,
      profileIds: [profileId],
      ...(expectedResourceRevision !== undefined ? { expectedResourceRevision } : {}),
    });
    const plan = started.plans[0];
    if (!plan) return { hardBlockReason: null, softIssue: '活跃组合未能创建执行计划' };
    let lastFp = '';
    let heartbeatAt = Date.now();
    const pollMs = Math.max(20, deps.pollIntervalMs ?? 1500);

    while (!isStepAborted()) {
      await sleepAbortable(pollMs, isStepAborted);
      if (isStepAborted()) break;
      const curPlan = (await tasks.plansForBatch(requestId)).find((p) => p.id === plan.id);
      if (!curPlan) break;
      if (['COMPLETED', 'FAILED', 'STOPPED'].includes(curPlan.state)) {
        await tasks.waitUntilProfileIdle?.(profileId, 8_000).catch(() => {});
        if (curPlan.state === 'COMPLETED') {
          onProgress(stepLabel, `${combo.saved.name} 已完成`);
          return { hardBlockReason: null, softIssue: null };
        }
        const prof = (await workspace.snapshot()).profiles.find((p) => p.id === profileId);
        const hard = classifyBrowserHardAccountIssue(prof, curPlan.reason);
        return hard
          ? { hardBlockReason: hard, softIssue: null }
          : { hardBlockReason: null, softIssue: curPlan.reason || '活跃步骤局部未完成' };
      }
      let curStep:
        | {
            status: string;
            progress: {
              revision?: number;
              effectiveMilliseconds: number;
              likes: number;
              published: number;
              accepted?: number;
            };
          }
        | null
        | undefined = null;
      try {
        curStep =
          typeof tasks.currentStepForPlan === 'function'
            ? await tasks.currentStepForPlan(curPlan.id, curPlan.round, curPlan.position)
            : ((await tasks.runtimeOverview({ limit: 1 })).currentSteps.find(
                (s) => s.jobId === curPlan.id,
              ) ?? null);
      } catch (err) {
        devDiag.record({
          level: 'WARN',
          category: 'TASK_RUNNER',
          event: 'AUTO_SCHEDULER_STEP_PROGRESS_READ_FAILED',
          profileId,
          planId: curPlan.id,
          reason: errMsg(err, 'PROGRESS_READ_FAILED').slice(0, 200),
        });
      }
      const isLongOp =
        curPlan.state === 'QUEUED' || combo.saved.steps[curPlan.position]?.type === 'post';
      const baseFp = `${curPlan.state}:${curPlan.reason}:${curPlan.round}:${curPlan.position}`;
      const fp = curStep
        ? `${baseFp}:${curStep.status}:${curStep.progress.revision ?? 0}:${curStep.progress.effectiveMilliseconds}:${curStep.progress.likes}:${curStep.progress.published}:${curStep.progress.accepted ?? 0}`
        : `${baseFp}:${curPlan.updatedAt}`;
      if (fp !== lastFp) {
        lastFp = fp;
        heartbeatAt = Date.now();
        onProgress(
          stepLabel,
          curStep
            ? `${combo.saved.name} · 第 ${curPlan.position + 1} 步 (${Math.floor(curStep.progress.effectiveMilliseconds / 1000)}s)`
            : `${combo.saved.name} · ${curPlan.state}`,
        );
      } else if (isLongOp && Date.now() - heartbeatAt >= 45_000) {
        heartbeatAt = Date.now();
        onProgress(
          stepLabel,
          curPlan.state === 'QUEUED'
            ? `${combo.saved.name} · 等待进入执行槽位…`
            : `${combo.saved.name} · 媒体上传/提交处理中…`,
        );
      }
    }
    if (isStepAborted()) await tasks.stopActiveProfile(profileId).catch(() => {});
    return { hardBlockReason: null, softIssue: null };
  } finally {
    featureExecution.setDelegatedSubmodule(profileId, null);
  }
}

export const makePipelineOutcome = (
  status: TargetPipelineOutcome['status'],
  summary: string,
  counts: {
    bumpedCount?: number;
    postedCount?: number;
    softIssues?: number;
    hardBlockReason?: string | null;
    handedOffToMain?: boolean;
  } = {},
): TargetPipelineOutcome => ({
  status,
  summary,
  bumpedCount: counts.bumpedCount ?? 0,
  postedCount: counts.postedCount ?? 0,
  softIssues: counts.softIssues ?? 0,
  hardBlockReason: counts.hardBlockReason ?? null,
  handedOffToMain: counts.handedOffToMain ?? false,
});

export function startPipelineWatchdog(
  deps: AutoSchedulerExecutorDeps,
  safetyCeilingMinutes: number | null,
  shouldSkipTick: () => boolean,
  onSafetyTimeout: () => void,
  onIdleTimeout: () => void,
) {
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  const safetyCeilingMs =
    safetyCeilingMinutes && safetyCeilingMinutes > 0 ? safetyCeilingMinutes * 60_000 : null;
  const tickMs = Math.min(2000, Math.max(30, Math.floor((deps.pollIntervalMs ?? 1500) * 1.3)));
  const timer = setInterval(() => {
    if (shouldSkipTick()) return;
    const now = Date.now();
    if (safetyCeilingMs !== null && now - startedAt > safetyCeilingMs) return onSafetyTimeout();
    if (now - lastProgressAt > Math.max(50, deps.getIdleWatchdogMs())) {
      lastProgressAt = now;
      onIdleTimeout();
    }
  }, tickMs);
  timer.unref?.();
  return { touch: () => void (lastProgressAt = Date.now()), stop: () => clearInterval(timer) };
}

export function buildPipelineFinalOutcome(input: {
  carrier: 'browser' | 'bluestacks';
  cancelled: boolean;
  handoffToMain: boolean;
  hardBlockReason: string | null;
  safetyCeilingHit: boolean;
  anyWatchdogTimedOut: boolean;
  bumpedCount: number;
  postedCount: number;
  invitedCount: number;
  softIssues: number;
  softNotes: string[];
}): TargetPipelineOutcome {
  const {
    carrier,
    cancelled,
    handoffToMain,
    hardBlockReason,
    safetyCeilingHit,
    anyWatchdogTimedOut,
    bumpedCount,
    postedCount,
    invitedCount,
    softIssues,
    softNotes,
  } = input;
  const isBs = carrier === 'bluestacks';
  const counts = { bumpedCount, postedCount, softIssues };
  if (cancelled) return makePipelineOutcome('stopped', '已手动停止', counts);
  if (handoffToMain)
    return makePipelineOutcome('completed', '正点时间已到，已无缝衔接切入正点顶贴场', {
      ...counts,
      handedOffToMain: true,
    });
  if (hardBlockReason)
    return makePipelineOutcome(
      'hard_blocked',
      `${isBs ? '模拟器账号异常已自动关闭' : '账号异常已自动收尾关闭'}：${hardBlockReason}`,
      { ...counts, hardBlockReason },
    );
  const idleAbort =
    anyWatchdogTimedOut &&
    !bumpedCount &&
    !postedCount &&
    !invitedCount &&
    (isBs || softIssues > 0);
  if (safetyCeilingHit || idleAbort) {
    const summary = safetyCeilingHit
      ? isBs
        ? '达到模拟器单号安全总上限，已自动关闭窗口'
        : '达到单号安全总时长上限，已自动收尾关闭窗口'
      : isBs
        ? `无进展看门狗触发关闭 (${softNotes[0] ?? '模拟器无响应'})`
        : `步骤无进展看门狗触发收尾 (${softNotes[0] ?? '页面长时间无响应'})`;
    return makePipelineOutcome('watchdog_timeout', summary, counts);
  }
  const statParts = [
    bumpedCount > 0 ? `顶贴 ${bumpedCount} ${isBs ? '条' : '次'}` : '',
    postedCount > 0 ? `发帖 ${postedCount} 组` : '',
    invitedCount > 0 ? `邀人 ${invitedCount} 人` : '',
  ].filter(Boolean);
  if (softIssues > 0) {
    return makePipelineOutcome(
      'soft_warning',
      isBs
        ? `已完成${statParts.length ? ' · ' + statParts.join(' · ') : ''} · 局部跳过 (${softNotes[0] ?? '受限'})`
        : `已完成收尾 · ${[...statParts, `软跳过 ${softIssues} 项 (${softNotes[0] ?? '局部受限'})`].join(' · ')}`,
      counts,
    );
  }
  return makePipelineOutcome(
    'completed',
    statParts.length
      ? `已完成 · ${statParts.join(' · ')}`
      : isBs
        ? '已完成全部模拟器步骤'
        : '已完成全部流水线步骤',
    { bumpedCount, postedCount, softIssues: 0 },
  );
}

export class AutoSchedulerTargetExecutor {
  private readonly quickComboLock = new Map<string, Promise<SavedCombination>>();
  constructor(private readonly deps: AutoSchedulerExecutorDeps) {}

  executeBrowserTarget = (input: {
    schedule: Extract<AutoSchedule, { carrier: 'browser' }>;
    phase: AutoSchedulePhase;
    profileId: string;
    seamlessEntered: boolean;
    safetyCeilingMinutes: number | null;
    ctx: ActiveTargetExecutionContext;
    onUpdate: (patch: TargetProgressPatch) => void;
  }) => runBrowserTargetPipeline(this.deps, this.quickComboLock, input);

  executeBluestacksTarget = (input: {
    schedule: Extract<AutoSchedule, { carrier: 'bluestacks' }>;
    instanceId: string;
    safetyCeilingMinutes: number | null;
    ctx: ActiveTargetExecutionContext;
    onUpdate: (patch: TargetProgressPatch) => void;
  }) => runBluestacksTargetPipeline(this.deps, input);
}
