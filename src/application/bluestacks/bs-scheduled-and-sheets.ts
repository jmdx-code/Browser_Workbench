import { bluestacksDisplayTitle } from '../../shared/bluestacks.js';
import { PAGE_TIMELINE_SYNTHETIC_GROUP_ID } from '../../shared/google-sheets.js';
import type { BumperSettings, BumperTarget } from '../../shared/group-bumper.js';
import {
  formatPosterCaptionPreview,
  type PosterLog,
  type PosterMaterial,
} from '../../shared/group-poster.js';
import { HARD_BLOCK_MSG_RE, errMsg } from '../module-worker-pool.js';
import { ensureInstanceOnlineForSchedule } from './bs-bumper.js';
import {
  makeActiveActionRecorder,
  prepareBsPosterMaterials,
  recordBsPosterTargetFailure,
  resolveActiveSteps,
} from './bs-extra-modules.js';
import {
  type BluestacksActiveStepParam,
  type BluestacksServiceContext,
  type ExtraExecutionKind,
  classifyBsWorkerError,
  getDiscoverySnapshot,
  guardInstanceRiskQuota,
  isProfileRunning,
  recordBsFailure,
  runLinkedExtraWorker,
  saveLastStatusSafe,
  setBsStat,
  triggerRiskQuotaAbort,
  withTrackedDeviceOp,
} from './bs-types.js';

function runTrackedExtraStep(options: {
  ctx: BluestacksServiceContext;
  instanceId: string;
  kind: ExtraExecutionKind;
  externalSignal?: AbortSignal;
  defaultStatus: string;
  errorLabel: string;
  run: (
    controller: AbortController,
  ) => Promise<{ finalStatus: string; softIssue?: boolean; hardBlocked?: boolean }>;
  onCleanup?: (res: { finalStatus: string; hardBlocked: boolean; softIssue: boolean }) => void;
  onFailureRecord?: (msg: string) => void;
}): Promise<{ status: string; hardBlocked: boolean; softIssue: boolean }> {
  const { ctx, instanceId, kind } = options;
  let hardBlocked = false;
  let softIssue = false;
  let finalStatus = options.defaultStatus;
  return runLinkedExtraWorker(
    ctx,
    instanceId,
    kind,
    options.externalSignal,
    () => ({ status: '已停止', hardBlocked: false, softIssue: false }),
    async (controller) => {
      try {
        const out = await options.run(controller);
        finalStatus = out.finalStatus;
        if (out.softIssue) softIssue = true;
        if (out.hardBlocked) hardBlocked = true;
      } catch (err) {
        const { riskReason, rawMsg, stopped } = classifyBsWorkerError(
          controller,
          err,
          options.errorLabel,
        );
        if (riskReason) {
          finalStatus = riskReason;
          softIssue = true;
          await saveLastStatusSafe(ctx, instanceId, riskReason);
        } else {
          finalStatus = rawMsg;
          if (HARD_BLOCK_MSG_RE.test(rawMsg)) hardBlocked = true;
          else if (!stopped) softIssue = true;
          if (!stopped) options.onFailureRecord?.(rawMsg);
        }
      }
      return { status: finalStatus, hardBlocked, softIssue };
    },
    () => options.onCleanup?.({ finalStatus, hardBlocked, softIssue }),
  );
}

export async function runScheduledActiveStep(
  ctx: BluestacksServiceContext,
  input: {
    instanceId: string;
    combinationId?: string;
    quickStep?: BluestacksActiveStepParam;
    signal?: AbortSignal;
    onProgress: (status: string) => void;
  },
): Promise<{ status: string; hardBlocked: boolean; softIssue: boolean }> {
  const runner = ctx.extra?.activeRunner;
  if (!runner) return { status: '跳过：蓝蝶活跃执行器未就绪', hardBlocked: false, softIssue: true };
  const steps = await resolveActiveSteps(ctx, {
    combinationId: input.combinationId,
    quickStep: input.quickStep,
  });
  for (const [needed, kind] of [
    [
      steps.some((s) => (s.type === 'feed' || s.type === 'video') && (s.maxLikes ?? 2) > 0),
      'active-like',
    ],
    [steps.some((s) => s.type === 'post' || s.type === 'story'), 'post'],
  ] as const) {
    if (!needed) continue;
    const blockedMsg = await guardInstanceRiskQuota(ctx, input.instanceId, kind);
    if (blockedMsg) return { status: blockedMsg, hardBlocked: false, softIssue: true };
  }
  return runTrackedExtraStep({
    ctx,
    instanceId: input.instanceId,
    kind: 'active',
    externalSignal: input.signal,
    defaultStatus: '活跃步骤完成',
    errorLabel: '活跃异常',
    run: async (controller) => {
      const res = await runner.run(input.instanceId, steps, controller.signal, {
        status: (text) => {
          setBsStat(ctx.activeProfileStats, input.instanceId, { running: true, status: text });
          input.onProgress(text);
        },
        action: makeActiveActionRecorder(ctx, input.instanceId, controller),
      });
      return {
        finalStatus: res ? `完成 ${res.completedSteps} 步 · 点赞 ${res.likes}` : '活跃步骤完成',
      };
    },
    onCleanup: ({ finalStatus }) =>
      setBsStat(ctx.activeProfileStats, input.instanceId, { running: false, status: finalStatus }),
  });
}

export async function runScheduledPosterStep(
  ctx: BluestacksServiceContext,
  input: {
    instanceId: string;
    materialIds: string[];
    groupIds: string[];
    maxGroupsPerProfile: number;
    materialsPerGroup?: number;
    postToTimeline?: boolean;
    signal?: AbortSignal;
    onProgress: (status: string, sessionPosted: number) => void;
  },
): Promise<{ postedCount: number; status: string; hardBlocked: boolean; softIssue: boolean }> {
  const skip = (status: string, softIssue = true) => ({
    postedCount: 0,
    status,
    hardBlocked: false,
    softIssue,
  });
  const runner = ctx.extra?.posterRunner;
  if (!runner) return skip('跳过：蓝蝶发帖执行器未就绪');
  const blockedMsg = await guardInstanceRiskQuota(ctx, input.instanceId, 'post');
  if (blockedMsg) return skip(blockedMsg);
  if (isProfileRunning(ctx, input.instanceId)) return skip('跳过：该蓝蝶窗口正在执行其他任务');
  const [allGroups, allMaterials] = await Promise.all([
    ctx.repo.targets('groups'),
    ctx.extra?.listPosterMaterials ? ctx.extra.listPosterMaterials() : [],
  ]);
  const mats = allMaterials.filter((m) => input.materialIds.includes(m.id));
  const grps = allGroups.filter((g) => input.groupIds.includes(g.id));
  if (!mats.length || (!grps.length && !input.postToTimeline))
    return skip('跳过：发帖素材或目标小组为空');
  const prepRes = await prepareBsPosterMaterials(ctx, mats, {
    signal: input.signal,
    onProgress: (i, total) => input.onProgress(`正在准备发帖素材 (${i}/${total})…`, 0),
  });
  if (!Array.isArray(prepRes)) return skip(prepRes.error, prepRes.error !== '已停止');
  let postedCount = 0;
  const out = await runTrackedExtraStep({
    ctx,
    instanceId: input.instanceId,
    kind: 'poster',
    externalSignal: input.signal,
    defaultStatus: '发帖完成',
    errorLabel: '发帖异常',
    run: async (controller) => {
      const res = await runner.run(
        input.instanceId,
        prepRes,
        grps,
        {
          maxGroupsPerInstance: input.maxGroupsPerProfile,
          materialsPerGroup: input.materialsPerGroup,
          postToTimeline: Boolean(input.postToTimeline),
          hasGroupPostedMaterial: ctx.extra?.hasGroupPostedMaterial,
        },
        controller.signal,
        {
          status: (text) => {
            setBsStat(ctx.posterProfileStats, input.instanceId, {
              running: true,
              status: text,
              session: postedCount,
            });
            input.onProgress(text, postedCount);
          },
          posted: () => {
            postedCount++;
            const cur = ctx.posterProfileStats.get(input.instanceId);
            setBsStat(ctx.posterProfileStats, input.instanceId, {
              running: true,
              status: `已发帖 ${postedCount} 组`,
              session: postedCount,
              today: (cur?.today ?? 0) + 1,
            });
            input.onProgress(`已发帖 ${postedCount} 组`, postedCount);
            triggerRiskQuotaAbort(ctx, input.instanceId, 'post', controller);
          },
          onTargetFailed: (info) => recordBsPosterTargetFailure(ctx, input.instanceId, info),
        },
      );
      const totalPosted = res?.posted ?? postedCount;
      return totalPosted === 0 && (res?.skipped ?? 0) > 0
        ? { finalStatus: res?.notes[0] ?? `发帖跳过 ${res?.skipped ?? 0} 条`, softIssue: true }
        : { finalStatus: `已发帖 ${totalPosted} 条` };
    },
    onFailureRecord: (msg) =>
      recordBsFailure(ctx, {
        recordType: 'post',
        carrier: 'bluestacks',
        status: 'failed',
        profileId: input.instanceId,
        errorReason: msg.slice(0, 120),
      }),
    onCleanup: ({ finalStatus }) =>
      setBsStat(ctx.posterProfileStats, input.instanceId, {
        running: false,
        status: finalStatus,
        session: postedCount,
      }),
  });
  return { postedCount, ...out };
}

export async function runScheduledInviterStep(
  ctx: BluestacksServiceContext,
  input: {
    instanceId: string;
    groupIds: string[];
    invitesPerGroup: number;
    signal?: AbortSignal;
    onProgress: (status: string, sessionInvited: number) => void;
  },
): Promise<{ invitedCount: number; status: string; hardBlocked: boolean; softIssue: boolean }> {
  const skip = (status: string) => ({
    invitedCount: 0,
    status,
    hardBlocked: false,
    softIssue: true,
  });
  const runner = ctx.extra?.inviterRunner;
  if (!runner) return skip('跳过：蓝蝶邀请执行器未就绪');
  const blockedMsg = await guardInstanceRiskQuota(ctx, input.instanceId, 'invite');
  if (blockedMsg) return skip(blockedMsg);
  const grps = (await ctx.repo.targets('groups')).filter((g) => input.groupIds.includes(g.id));
  if (!grps.length) return skip('跳过：未找到有效目标小组');

  let invitedCount = 0;
  const out = await runTrackedExtraStep({
    ctx,
    instanceId: input.instanceId,
    kind: 'inviter',
    externalSignal: input.signal,
    defaultStatus: '邀请完成',
    errorLabel: '邀请异常',
    run: async (controller) => {
      const res = await runner.run(
        input.instanceId,
        grps,
        input.invitesPerGroup,
        controller.signal,
        {
          status: (text) => input.onProgress(text, invitedCount),
          invited: (delta) => {
            invitedCount += delta;
            input.onProgress(`已邀请 ${invitedCount} 人`, invitedCount);
            triggerRiskQuotaAbort(ctx, input.instanceId, 'invite', controller);
          },
        },
      );
      return { finalStatus: `已邀请 ${res?.invited ?? invitedCount} 人` };
    },
    onCleanup: ({ finalStatus }) =>
      setBsStat(ctx.inviterProfileStats, input.instanceId, {
        running: false,
        status: finalStatus,
        session: invitedCount,
      }),
  });
  return { invitedCount, ...out };
}

export async function runDirectPostsForSheet(
  ctx: BluestacksServiceContext,
  input: {
    instanceId: string;
    posts: ReadonlyArray<{
      postId: string;
      postUrl: string;
      groupId: string;
      groupName: string;
      pageId: string;
      pageName: string;
    }>;
    settings: BumperSettings;
    commentPool: readonly string[];
    signal?: AbortSignal;
    onProgress?: (status: string) => void;
    onPostDone?: (res: {
      postId: string;
      liked: boolean;
      commented: boolean;
      commentText?: string | null;
    }) => void | Promise<void>;
  },
): Promise<{ bumped: number; attempted: number }> {
  if (!ctx.runner.runDirectPosts) return { bumped: 0, attempted: 0 };
  const blockedMsg = await guardInstanceRiskQuota(ctx, input.instanceId, 'bump');
  if (blockedMsg) {
    input.onProgress?.(blockedMsg);
    return { bumped: 0, attempted: 0 };
  }
  return runLinkedExtraWorker(
    ctx,
    input.instanceId,
    'sheets-bumper',
    input.signal,
    () => ({ bumped: 0, attempted: 0 }),
    async (controller) => {
      try {
        await ensureInstanceOnlineForSchedule(ctx, input.instanceId, controller.signal);
        return (
          (await ctx.runner.runDirectPosts?.(
            input.instanceId,
            input.posts,
            input.settings,
            input.commentPool,
            controller.signal,
            {
              status: (text) => input.onProgress?.(text),
              onPostDone: input.onPostDone,
            },
          )) ?? { bumped: 0, attempted: 0 }
        );
      } catch (err) {
        const msg = errMsg(err);
        if (!controller.signal.aborted && msg !== 'TASK_STOPPED') {
          const isPage = input.posts.every((p) => !p.groupId || p.groupId === '-');
          const first = input.posts[0];
          recordBsFailure(ctx, {
            recordType: isPage ? 'page_bump' : 'group_bump',
            carrier: 'bluestacks',
            status: 'failed',
            profileId: input.instanceId,
            groupId: isPage ? '' : (first?.groupId ?? ''),
            groupName: isPage ? '' : (first?.groupName ?? ''),
            pageId: first?.pageId ?? '',
            pageName: first?.pageName ?? '',
            errorReason: msg.slice(0, 120),
          });
        }
        throw err;
      }
    },
  );
}

export async function runDirectPosterForSheet(
  ctx: BluestacksServiceContext,
  input: {
    instanceId: string;
    targetPageId?: string;
    targetPageName?: string;
    material: PosterMaterial;
    targets: readonly BumperTarget[];
    closeOnFinish?: boolean;
    signal?: AbortSignal;
    onStatus?: (text: string) => void;
    onPosted?: (log: PosterLog, isTimeline: boolean) => Promise<void> | void;
  },
): Promise<{ postedCount: number; timelinePosted: boolean; error?: string }> {
  const posterRunner = ctx.extra?.posterRunner;
  if (!posterRunner)
    return { postedCount: 0, timelinePosted: false, error: '蓝蝶发帖执行器未就绪' };
  if (isProfileRunning(ctx, input.instanceId)) {
    const msg = '跳过：该蓝蝶窗口正在执行其他任务';
    input.onStatus?.(msg);
    return { postedCount: 0, timelinePosted: false, error: msg };
  }
  const blockedMsg = await guardInstanceRiskQuota(ctx, input.instanceId, 'post');
  if (blockedMsg) {
    input.onStatus?.(blockedMsg);
    return { postedCount: 0, timelinePosted: false, error: blockedMsg };
  }
  let postedCount = 0;
  let timelinePosted = false;
  let errorMsg: string | undefined;
  let shouldCloseOnExit = false;

  await runLinkedExtraWorker(
    ctx,
    input.instanceId,
    'sheets-poster',
    input.signal,
    () => undefined,
    async (controller) => {
      try {
        const wasOnline = Boolean(
          (await getDiscoverySnapshot(ctx, false)).instances.find((i) => i.id === input.instanceId)
            ?.online,
        );
        input.onStatus?.(wasOnline ? '正在校验蓝蝶在线状态…' : '正在自动启动蓝蝶窗口…');
        let inst = await ensureInstanceOnlineForSchedule(ctx, input.instanceId, controller.signal);
        shouldCloseOnExit = !wasOnline && input.closeOnFinish !== false;

        const normId = (input.targetPageId ?? '').trim().toLowerCase();
        const normName = (input.targetPageName ?? '').trim().toLowerCase();
        const matchesCurrent =
          (Boolean(normId) &&
            ((inst.numericAccountId ?? '').trim().toLowerCase() === normId ||
              inst.accountId.trim().toLowerCase() === normId)) ||
          (Boolean(normName) && inst.accountName.trim().toLowerCase() === normName);

        const switchFn = ctx.devices.switchIdentity;
        if (!matchesCurrent && switchFn) {
          const managedPage = (inst.managedIdentities ?? []).find(
            (m) =>
              m.identityType === 'page' &&
              !m.active &&
              Boolean(normName) &&
              (m.name.trim().toLowerCase() === normName ||
                m.name.trim().toLowerCase().includes(normName) ||
                normName.includes(m.name.trim().toLowerCase())),
          );
          if (managedPage) {
            input.onStatus?.(`正在自动切换专页身份：${managedPage.name}…`);
            inst = await withTrackedDeviceOp(ctx, ctx.switchingIds, input.instanceId, () =>
              switchFn(
                input.instanceId,
                { targetName: managedPage.name, targetType: 'page' },
                controller.signal,
              ),
            );
          }
        }

        const preparedMaterial =
          input.material.mediaSource.trim() && ctx.extra?.ensurePosterMaterialLocal
            ? await ctx.extra.ensurePosterMaterialLocal(input.material)
            : input.material;
        const postToTimeline = input.targets.some((t) => t.id === PAGE_TIMELINE_SYNTHETIC_GROUP_ID);
        const groupTargets = input.targets.filter((t) => t.id !== PAGE_TIMELINE_SYNTHETIC_GROUP_ID);

        const outcome = await posterRunner.run(
          input.instanceId,
          [preparedMaterial],
          groupTargets,
          { maxGroupsPerInstance: Math.max(groupTargets.length, 0), postToTimeline },
          controller.signal,
          {
            status: (text) => input.onStatus?.(text),
            posted: () => {},
            onPostLog: async (log, isTimeline) => {
              if (isTimeline) timelinePosted = true;
              else postedCount++;
              await input.onPosted?.(log, isTimeline);
              const quotaMsg = await guardInstanceRiskQuota(ctx, input.instanceId, 'post');
              if (quotaMsg && !controller.signal.aborted)
                controller.abort(new Error(`RISK_LIMIT_REACHED:${quotaMsg}`));
            },
            onTargetFailed: (info) =>
              recordBsPosterTargetFailure(ctx, input.instanceId, info, {
                accountId: inst.numericAccountId || inst.accountId || '',
                accountName: inst.accountName || bluestacksDisplayTitle(inst),
                pageId: input.targetPageId ?? '',
                pageName: input.targetPageName ?? '',
              }),
          },
        );
        if (postedCount === 0 && !timelinePosted && outcome.notes.length)
          errorMsg = outcome.notes[0];
      } catch (err) {
        const { riskReason, rawMsg, stopped } = classifyBsWorkerError(controller, err);
        errorMsg = riskReason ?? (stopped ? '任务已手动停止' : rawMsg);
        if (!riskReason && !stopped) {
          recordBsFailure(ctx, {
            recordType: 'post',
            carrier: 'bluestacks',
            status: 'failed',
            profileId: input.instanceId,
            pageId: input.targetPageId ?? '',
            pageName: input.targetPageName ?? '',
            captionPreview: formatPosterCaptionPreview(input.material.caption),
            errorReason: errorMsg.slice(0, 120),
          });
        }
      }
    },
    async () => {
      if (shouldCloseOnExit) {
        input.onStatus?.('发布结束，正在自动关闭蓝蝶窗口释放内存…');
        await withTrackedDeviceOp(ctx, ctx.closingIds, input.instanceId, () =>
          ctx.devices.closeInstance(input.instanceId).catch(() => {}),
        );
      }
    },
  );
  return { postedCount, timelinePosted, ...(errorMsg ? { error: errorMsg } : {}) };
}
