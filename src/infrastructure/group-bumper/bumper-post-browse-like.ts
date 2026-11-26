import { devDiag } from '../../shared/dev-diagnostics.js';
import type { BumperTarget } from '../../shared/group-bumper.js';
import { readBumperReactionFromServer } from '../bumper-reaction-read.js';
import { BUMPER_REACTION_IDS, projectBumperReactionTarget } from '../bumper-reaction-target.js';
import { watchBumperVideo } from '../bumper-video.js';
import { type BumperPost, readGroupBumper } from '../group-bumper-effects.js';
import {
  BumperFatalError,
  BumperPostReadIncomplete,
  observeBumperGraphql,
  pollWithGuard,
  type ResumablePostState,
  trackBumperSubmissionOp,
  wait,
} from './bumper-core.js';
import {
  type BumperPostCtx,
  prepareBumperPost,
  requireBumperPost,
  revealBumperControlIfNeeded,
} from './bumper-post-flow.js';
import type { BumperSessionRuntime } from './bumper-session.js';
export function isDeterministicPostSkipError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /目标帖子仍在加载或控件未就绪|视频播放器未加载|视频未实际播放|视频播放长时间未推进|视频节点已变化/.test(
    msg,
  );
}
export async function checkBumperPost(input: {
  session: BumperSessionRuntime;
  effectiveGroupId: string;
  isPageBumperMode: boolean;
  feed: BumperTarget | null;
  resolvedPageId: string | undefined;
  target: BumperTarget;
  postId: string;
  expectedFeedbackId: string | null;
  pageOwnerAuthorId: string | null;
}): Promise<BumperPost> {
  const {
      session,
      effectiveGroupId,
      isPageBumperMode,
      feed,
      resolvedPageId,
      target,
      postId,
      expectedFeedbackId,
      pageOwnerAuthorId,
    } = input,
    page = session.getPage();
  for (let attempt = 0; ; attempt++) {
    await session.assertIdentity();
    const s = await readGroupBumper(page, {
      groupId: effectiveGroupId,
      ...(feed ? { pageId: resolvedPageId ?? feed.id } : {}),
      targetPostId: postId,
    });
    if (s.restricted)
      throw new BumperFatalError('受限 · ' + (s.restrictionReason ?? '需要手机验证或操作受限'));
    if ((!s.visible && !session.isBackgroundAllowed()) || !s.ready)
      throw new BumperPostReadIncomplete('目标帖子页面尚未可见就绪');
    const p = s.posts.find((item) => item.postId === postId);
    if (!isPageBumperMode && !s.groupIds.includes(effectiveGroupId.toLowerCase()))
      throw Error('目标帖子或作者已变化');
    try {
      return requireBumperPost(
        p,
        feed && resolvedPageId ? { ...target, id: resolvedPageId } : target,
        expectedFeedbackId,
        isPageBumperMode && feed
          ? { pageBumper: true, accountId: session.accountId, pageOwnerAuthorId }
          : undefined,
      );
    } catch (error) {
      if (!(error instanceof BumperPostReadIncomplete) || attempt > 0) throw error;
      await wait(200);
    }
  }
}
export async function runBumperPostBrowse(
  ctx: BumperPostCtx,
  resumableRef: { current: ResumablePostState | null },
  expectedFeedbackRef: { current: string | null },
): Promise<boolean> {
  const {
      profileId,
      paceScale,
      group,
      target,
      post,
      todayCount,
      settings,
      callbacks,
      session,
      activePostState,
      checkPost,
    } = ctx,
    page = session.getPage(),
    conn = session.getConn();
  if (!activePostState.browseDone) {
    const browseOutcome = await session.op(
      post.hasVideo ? '观看目标视频' : '浏览目标帖子',
      async (): Promise<{ ok: true } | { ok: false; skippedReason: string }> => {
        try {
          const refreshedPost = await prepareBumperPost({
            page,
            readCurrent: checkPost,
            guard: session.guard,
            candidateCardCSS: post.postCSS,
            paceScale,
          });
          expectedFeedbackRef.current = refreshedPost.feedbackId;
          if (refreshedPost.hasVideo) {
            callbacks.status(`正在观看视频 · ${group.name} · ${target.name}`, todayCount);
            let lastVideoReportAt = 0;
            const fmt = (sec: number) => {
              const s = Math.max(0, Math.floor(sec));
              return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
            };
            await watchBumperVideo({
              page,
              initial: refreshedPost,
              readCurrent: checkPost,
              guard: session.guard,
              sleep: (ms) => session.paceWait(ms / (paceScale || 1)),
              sound: Boolean(settings.enableSound),
              budgetMs: Math.round(180_000 * paceScale),
              tickMs: Math.max(10, Math.round(1000 * paceScale)),
              stallMs: Math.max(120, Math.round(25000 * paceScale)),
              onProgress: (currentSec, durationSec) => {
                if (Date.now() - lastVideoReportAt < 4000) return;
                lastVideoReportAt = Date.now();
                const tag =
                  durationSec && durationSec >= 1
                    ? `${fmt(currentSec)}/${fmt(durationSec)}`
                    : fmt(currentSec);
                callbacks.status(
                  `正在观看视频 (${tag}) · ${group.name} · ${target.name}`,
                  todayCount,
                );
              },
              onSummary: (summary) => {
                devDiag.record({
                  level: 'INFO',
                  category: 'GROUP_BUMPER',
                  event: 'BUMPER_VIDEO_WATCH',
                  profileId,
                  data: {
                    groupId: group.id,
                    postId: refreshedPost.postId,
                    sound: Boolean(settings.enableSound),
                    ...summary,
                  },
                });
              },
            });
          } else {
            callbacks.status(`正在浏览目标帖子 · ${group.name} · ${target.name}`, todayCount);
            await session.paceWait(
              Math.round((3000 + Math.floor(Math.random() * 2001)) * paceScale) / (paceScale || 1),
            );
            session.guard();
            const latest = await checkPost(),
              anchor =
                latest.likeCSS ??
                latest.commentButtonCSS ??
                latest.commentCSS ??
                latest.videoCSS ??
                latest.postCSS;
            if (anchor)
              await revealBumperControlIfNeeded(page.locator(anchor).first(), paceScale).catch(
                () => {},
              );
          }
          return { ok: true };
        } catch (watchErr) {
          if (
            !callbacks.cancelled() &&
            !conn.hasPendingCommands &&
            !conn.failureReason &&
            !session.isCanceledByUserDetach(watchErr) &&
            isDeterministicPostSkipError(watchErr)
          )
            return {
              ok: false,
              skippedReason: watchErr instanceof Error ? watchErr.message : String(watchErr),
            };
          throw watchErr;
        }
      },
      async () => true,
      async (val, _binding, resolution) =>
        val.ok ? resolution : { ...resolution, outcome: 'NOT_APPLIED' },
    );
    if (!browseOutcome.ok) {
      resumableRef.current = null;
      session.reportIssue({ kind: 'skipped', reason: browseOutcome.skippedReason });
      callbacks.status(`跳过慢速帖子 · ${browseOutcome.skippedReason}`, todayCount);
      devDiag.record({
        level: 'WARN',
        category: 'GROUP_BUMPER',
        event: 'BUMPER_POST_SKIPPED',
        profileId,
        reason: browseOutcome.skippedReason,
        data: { groupId: group.id, postId: post.postId },
      });
      return false;
    }
    activePostState.browseDone = true;
    session.resetNoProgressRecoveries();
  } else {
    const refreshedPost = await prepareBumperPost({
      page,
      readCurrent: checkPost,
      guard: session.guard,
      candidateCardCSS: post.postCSS,
      paceScale,
    });
    expectedFeedbackRef.current = refreshedPost.feedbackId;
  }
  return true;
}
export async function runBumperPostLike(
  ctx: BumperPostCtx,
): Promise<{ doLike: boolean; hydratedPost: BumperPost }> {
  const {
      profileId,
      paceScale,
      group,
      target,
      post,
      todayCount,
      settings,
      callbacks,
      session,
      groupHelpers,
      activePostState,
      stats,
      checkPost,
      persist,
    } = ctx,
    page = session.getPage(),
    conn = session.getConn();
  callbacks.status(`正在顶贴 · ${group.name} · ${target.name}`, todayCount);
  let hydratedPost = await checkPost();
  if (
    activePostState.wantLike &&
    activePostState.likeProgress === 'NOT_SENT' &&
    !hydratedPost.liked &&
    !hydratedPost.likeCSS
  ) {
    const bottomAnchor =
      hydratedPost.commentButtonCSS ??
      hydratedPost.commentCSS ??
      hydratedPost.postCSS ??
      post.postCSS;
    if (bottomAnchor) {
      await page
        .locator(bottomAnchor)
        .first()
        .evaluate((el) => el.scrollIntoView({ block: 'end', inline: 'nearest' }))
        .catch(() => {});
      await session.paceWait(500);
      hydratedPost = await checkPost().catch(() => hydratedPost);
    }
  }
  const readReactionPost = async () => {
    const current = await checkPost();
    if (current.reactionState !== 'unknown') return current;
    const fresh = await readBumperReactionFromServer(page, {
      actorId: session.accountId,
      postId: post.postId,
      feedbackId: current.feedbackId ?? '',
    });
    session.guard();
    if (fresh.state === 'unknown') throw Error('点赞状态暂未读清，未点击当前帖');
    return { ...current, reactionState: fresh.state, liked: fresh.state === 'active' };
  };
  if (
    activePostState.wantLike &&
    activePostState.likeProgress === 'NOT_SENT' &&
    hydratedPost.reactionState === 'unknown'
  )
    hydratedPost = await readReactionPost();
  const doLike =
    activePostState.wantLike &&
    activePostState.likeProgress === 'NOT_SENT' &&
    !hydratedPost.liked &&
    !!hydratedPost.likeCSS;
  if (doLike) {
    const reactionPool = settings.reactionTypes?.length
        ? settings.reactionTypes
        : (['care'] as const),
      selectedReaction = settings.useLongPressReaction
        ? (reactionPool[Math.floor(Math.random() * reactionPool.length)] ?? 'care')
        : 'like',
      expectedReactionId = BUMPER_REACTION_IDS[selectedReaction],
      likePressBefore = conn.submissionCalls?.mousePress,
      native = observeBumperGraphql(page, {
        actorId: session.accountId,
        feedbackId: hydratedPost.feedbackId ?? post.feedbackId ?? '',
        kind: 'like',
        profileId,
        postId: post.postId,
        expectedReactionId,
      });
    await trackBumperSubmissionOp({
      session,
      callKind: 'mousePress',
      native,
      onErrorProgress: (progress) => {
        activePostState.likeProgress = progress;
      },
      run: async (onBind) => {
        await session.op(
          '点赞',
          async () => {
            const current = await readReactionPost();
            if (current.liked) return false;
            if (current.reactionState === 'unknown') throw Error('点赞状态暂未读清，未点击当前帖');
            if (!current.likeCSS) throw Error('点赞入口未找到');
            const performLikeOrReaction = async (likeSelector: string) => {
              let activeLikeSelector = likeSelector;
              const scrolled = await revealBumperControlIfNeeded(
                page.locator(activeLikeSelector).first(),
                paceScale,
              );
              if (scrolled) {
                if (paceScale > 0) await wait(Math.max(1, Math.round(180 * paceScale)));
                const afterScroll = await checkPost().catch(() => null);
                if (afterScroll?.liked) return;
                if (afterScroll?.likeCSS) activeLikeSelector = afterScroll.likeCSS;
              }
              let clickSelector = activeLikeSelector;
              if (selectedReaction !== 'like') {
                const hover = async () => {
                  session.guard();
                  await page.locator(activeLikeSelector).first().hover({ timeout: 3000 });
                };
                await hover();
                const deadline = Date.now() + Math.max(80, Math.round(1800 * (paceScale || 1)));
                let targetBtn: string | null = null,
                  rehovered = false;
                do {
                  session.guard();
                  targetBtn = await page.evaluate(projectBumperReactionTarget, {
                    postId: post.postId,
                    feedbackId: current.feedbackId ?? '',
                    reactionId: expectedReactionId,
                  });
                  if (targetBtn || paceScale === 0) break;
                  if (!rehovered && Date.now() > deadline - 800) {
                    rehovered = true;
                    await hover();
                  }
                  await wait(180);
                } while (Date.now() < deadline);
                if (!targetBtn) throw Error('所选反应按钮未就绪，未改用其他反应');
                clickSelector = targetBtn;
              }
              const beforePress = await readReactionPost();
              if (beforePress.liked) return;
              if (beforePress.reactionState === 'unknown')
                throw Error('点赞状态暂未读清，未点击当前帖');
              await page.locator(clickSelector).first().click({ timeout: 4000 });
            };
            try {
              await performLikeOrReaction(current.likeCSS);
            } catch (error) {
              if (conn.submissionCalls?.mousePress !== likePressBefore) throw error;
              session.guard();
              const retried = await checkPost();
              if (retried.liked) return false;
              if (!retried.likeCSS) throw Error('点赞入口未找到');
              await performLikeOrReaction(retried.likeCSS);
            }
            return (
              likePressBefore === undefined || conn.submissionCalls.mousePress > likePressBefore
            );
          },
          async (clicked) => {
            if (!clicked) return true;
            const checkNative = () => {
              if (native.restricted())
                throw new BumperFatalError('受限 · 账号点赞或评论被 Facebook 限制');
              if (native.failed()) throw Error(native.failureReason());
            };
            const confirmLiked = () => (
              (activePostState.record.liked = true),
              (stats.consecutiveUnconfirmed = 0),
              true
            );
            if (
              await pollWithGuard(
                8000,
                session.guard,
                async () => (checkNative(), native.confirmed() ? confirmLiked() : null),
              )
            )
              return true;
            await native.waitForEvidence(2000, session.guard);
            checkNative();
            if (native.confirmed()) return confirmLiked();
            const fresh = await readBumperReactionFromServer(page, {
              actorId: session.accountId,
              postId: post.postId,
              feedbackId: hydratedPost.feedbackId ?? post.feedbackId ?? '',
            });
            session.guard();
            checkNative();
            if (
              native.confirmed() ||
              (fresh.state === 'active' && fresh.reactionId === expectedReactionId)
            ) {
              devDiag.record({
                category: 'GROUP_BUMPER',
                event: 'BUMPER_LIKE_READBACK',
                profileId,
                data: {
                  postId: post.postId,
                  feedbackId: fresh.feedbackId,
                  reactionId: fresh.reactionId,
                  state: fresh.state,
                },
              });
              return confirmLiked();
            }
            stats.consecutiveUnconfirmed++;
            return false;
          },
          async (value, binding, resolution) => {
            if (activePostState.record.liked) return persist(value, binding, resolution);
          },
          (binding) => onBind(binding.operationId),
        );
        activePostState.likeProgress = 'VERIFIED';
      },
    });
    await groupHelpers.dismissWelcomeDialogIfNeeded();
  }
  return { doLike, hydratedPost };
}
