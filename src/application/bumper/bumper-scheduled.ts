import { BumperSettings, type BumperProfileStat } from '../../shared/group-bumper.js';
import type { BumperMode } from '../group-bumper-service.js';
import {
  HARD_BLOCK_MSG_RE,
  acquireOnlineBrowserPermit,
  buildStaggeredQueues,
  runTrackedScheduledWorker,
} from '../module-worker-pool.js';
import {
  type BumperRuntimeContext,
  checkBumperQuota,
  resolveBumperTargetsAndSettings,
  runBumperSession,
} from './bumper-workers.js';
export async function runScheduledBumperProfileStep(
  ctx: BumperRuntimeContext,
  input: {
    profileId: string;
    mode: BumperMode;
    groupIds: string[];
    pageIds: string[];
    minConcurrency: number;
    settingsOverride?: Partial<BumperSettings>;
    onProgress: (status: string, sessionBumps: number) => void;
  },
): Promise<{ bumpedCount: number; status: string; hardBlocked: boolean; softIssue: boolean }> {
  ctx.assertAllowed();
  const { profileId, mode, onProgress } = input;
  const { groups, pages, rawSettings } = await resolveBumperTargetsAndSettings(
    ctx,
    mode,
    input.groupIds,
    input.pageIds,
  );
  const skip = (status: string, softIssue = true) => ({
    bumpedCount: 0,
    status,
    hardBlocked: false,
    softIssue,
  });
  if (!groups.length || !pages.length)
    return skip(
      mode === 'page-bumper' ? '跳过：未找到已保存的目标专页' : '跳过：未找到有效的小组或专页',
    );
  const settings: BumperSettings = BumperSettings.parse({
    ...rawSettings,
    ...(input.settingsOverride ?? {}),
  });
  if (
    !settings.likeProbability &&
    !settings.commentProbability &&
    !(settings.shareToStoryProbability ?? 0)
  )
    settings.likeProbability = 100;
  if (ctx.isProfileRunning(profileId)) return skip('跳过：该浏览器正在执行其他顶贴任务');
  const cap = await checkBumperQuota(ctx, profileId);
  if (!cap.allowed) return skip(cap.reason ?? '今日已达浏览器安全日限额，自动跳过保护', false);
  let releasePermit: (() => void) | undefined;
  let workerOut = { bumpedCount: 0, status: '准备顶贴…', hardBlocked: false, softIssue: false };
  await ctx.workboard.runSoldier(
    { carrierId: profileId, carrierKind: 'browser', moduleId: mode },
    async (soldier) => {
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
          workerOut = skip('浏览器未就绪或连接断开');
          return;
        }
        const runId = globalThis.crypto.randomUUID();
        ctx.cancelled.delete(profileId);
        ctx.active.add(profileId);
        ctx.profileRunIds.set(profileId, runId);
        ctx.profileModes.set(profileId, mode);
        const stat: BumperProfileStat = {
          today: 0,
          session: 0,
          status: '准备顶贴…',
          running: true,
        };
        ctx.profilesForMode(mode).set(profileId, stat);
        const shuffledGroups =
          mode === 'page-bumper'
            ? groups
            : (buildStaggeredQueues([profileId], groups).get(profileId) ?? groups);
        const shuffledPages = buildStaggeredQueues([profileId], pages).get(profileId) ?? pages;
        let hardBlocked = false;
        let softIssue = false;
        const isAborted = () => ctx.cancelled.has(profileId) || soldier.signal.aborted;
        await runTrackedScheduledWorker(
          ctx.workers,
          profileId,
          runBumperSession(
            ctx,
            profileId,
            mode,
            runId,
            shuffledGroups,
            shuffledPages,
            settings,
            stat,
            isAborted,
            () => ctx.profileRunIds.get(profileId) === runId,
            {
              onStatUpdated: () => onProgress(stat.status, stat.session),
              onFailureError: (rawMsg) => {
                if (
                  HARD_BLOCK_MSG_RE.test(rawMsg) &&
                  !/点赞或评论被 Facebook 限制|暂时限制/.test(rawMsg)
                )
                  hardBlocked = true;
                else softIssue = true;
              },
              formatStatus: (c) => {
                if (c.pending + c.failedActions > 0 && !isAborted()) {
                  softIssue = true;
                  return `本轮 ${stat.session} 次 · 局部跳过 (${c.issueReason || '部分操作未完成'})`;
                }
                if (
                  stat.status.startsWith('今日已达上限') ||
                  stat.status.startsWith('今日已达浏览器')
                )
                  return null;
                if (isAborted()) return '已停止';
                return c.skippedPosts > 0
                  ? `已完成 · 本轮 ${stat.session} 次 · 跳过 ${c.skippedPosts} 帖`
                  : `已完成 · 本轮 ${stat.session} 次`;
              },
            },
          ),
        );
        workerOut = { bumpedCount: stat.session, status: stat.status, hardBlocked, softIssue };
      } finally {
        releasePermit?.();
      }
    },
  );
  return workerOut;
}
