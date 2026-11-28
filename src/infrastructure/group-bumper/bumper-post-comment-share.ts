import { randomUUID } from 'node:crypto';
import { devDiag } from '../../shared/dev-diagnostics.js';
import {
  type BumperPost,
  readBumperShareDialog,
  readGroupBumper,
} from '../group-bumper-effects.js';
import {
  BumperFatalError,
  digest,
  normalizeBumperComment,
  observeBumperGraphql,
  observeBumperStoryShareGraphql,
  pollWithGuard,
  trackBumperSubmissionOp,
  wait,
} from './bumper-core.js';
import {
  type BumperPostCtx,
  dismissFeatureOrJoinCSS,
  readBumperComposerText,
  revealBumperControlIfNeeded,
  typeBumperComment,
} from './bumper-post-flow.js';
import type { BumperSessionRuntime } from './bumper-session.js';
export async function closeBumperShareDialogIfOpen(
  session: BumperSessionRuntime,
  verifyCloseWithTimeoutMs?: number,
): Promise<void> {
  if (!(await readBumperShareDialog(session.getPage()).catch(() => null))?.open) return;
  await session
    .op(
      '关闭分享弹窗',
      async () => {
        const activePage = session.getPage();
        const latestDlg = await readBumperShareDialog(activePage).catch(() => null);
        if (!latestDlg?.open) return false;
        if (latestDlg.closeButtonCSS)
          await activePage
            .locator(latestDlg.closeButtonCSS)
            .first()
            .click({ timeout: 3000 })
            .catch(() => {});
        else await activePage.keyboard.press('Escape').catch(() => {});
        return true;
      },
      verifyCloseWithTimeoutMs
        ? async () => {
            for (const end = Date.now() + verifyCloseWithTimeoutMs; Date.now() < end;) {
              session.guard();
              if (!(await readBumperShareDialog(session.getPage()).catch(() => null))?.open)
                return true;
              await wait(120);
            }
            await session
              .getPage()
              .keyboard.press('Escape')
              .catch(() => {});
            return true;
          }
        : async () => true,
    )
    .catch(() => {});
}
const diagBumperInfo = (profileId: string, event: string, data: Record<string, unknown>) =>
  devDiag.record({ level: 'INFO', category: 'GROUP_BUMPER', event, profileId, data });
const SHARE_RESTRICTED_MSG = '受限 · 账号分享功能被 Facebook 限制';
export async function runBumperPostComment(
  ctx: BumperPostCtx,
  hydratedPost: BumperPost,
  doLike: boolean,
): Promise<void> {
  const {
      profileId,
      paceScale,
      effectiveGroupId,
      post,
      settings,
      session,
      groupHelpers,
      activePostState,
      stats,
      checkPost,
      persist,
    } = ctx,
    chosen = activePostState.chosen;
  if (doLike && chosen && activePostState.commentProgress === 'NOT_SENT')
    await session.paceWait(3500 + Math.floor(Math.random() * 4001));
  if (!chosen || activePostState.commentProgress !== 'NOT_SENT') return;
  const allowFallback = settings.likeProbability > 0 || (settings.shareToStoryProbability ?? 0) > 0;
  try {
    const current = await checkPost();
    if (!current.commentCSS && current.commentButtonCSS) {
      await session.op(
        '展开评论',
        async () => {
          const clickBtn = async (css: string) => {
            const btn = session.getPage().locator(css).first();
            await revealBumperControlIfNeeded(btn, paceScale);
            await btn.click({ timeout: 4000 });
          };
          try {
            await clickBtn(current.commentButtonCSS ?? '[data-wb-missing-control]');
          } catch {
            session.guard();
            const retried = await checkPost();
            if (retried.commentCSS) return true;
            if (!retried.commentButtonCSS) throw Error('评论入口未找到');
            await clickBtn(retried.commentButtonCSS);
          }
          const waitEnd = Date.now() + Math.max(200, Math.round(5000 * (paceScale || 1)));
          let retriedClick = false;
          while (Date.now() < waitEnd) {
            session.guard();
            const polled = await checkPost().catch(() => null);
            if (polled?.commentCSS) return true;
            if (
              !retriedClick &&
              Date.now() + Math.round(2500 * (paceScale || 1)) >= waitEnd &&
              polled?.commentButtonCSS
            ) {
              retriedClick = true;
              await clickBtn(polled.commentButtonCSS).catch(() => {});
            }
            await session.paceWait(250);
          }
          return true;
        },
        async () => true,
      );
    }
    const editor = (await checkPost()).commentCSS;
    if (!editor) throw Error('评论输入框未找到');
    await session.op(
      '填写评论',
      async () => {
        const activePage = session.getPage();
        try {
          await typeBumperComment(
            activePage,
            activePage.locator(editor).first(),
            chosen.text,
            paceScale,
            session.guard,
          );
        } catch (err) {
          session.guard();
          const retriedEditor = (await checkPost()).commentCSS;
          if (!retriedEditor) throw err;
          await typeBumperComment(
            activePage,
            activePage.locator(retriedEditor).first(),
            chosen.text,
            paceScale,
            session.guard,
          );
        }
        return true;
      },
      async () => true,
    );
    const native = observeBumperGraphql(session.getPage(), {
      actorId: session.accountId,
      feedbackId: hydratedPost.feedbackId ?? post.feedbackId ?? '',
      kind: 'comment',
      comment: chosen.text,
      profileId,
      postId: post.postId,
    });
    let commentRejectedByRestriction = false;
    await trackBumperSubmissionOp({
      session,
      callKind: 'enter',
      native,
      onErrorProgress: (progress) => {
        activePostState.commentProgress = progress;
      },
      run: async (onBind) => {
        await session.op(
          '发送评论',
          async () => {
            const activePage = session.getPage();
            const activeEditor = (await checkPost().catch(() => null))?.commentCSS ?? editor;
            const box = activePage.locator(activeEditor).first();
            await revealBumperControlIfNeeded(box, paceScale).catch(() => {});
            await box
              .evaluate((el) => (el instanceof HTMLElement ? el.focus() : undefined))
              .catch(() => {});
            await box.press('Enter', { timeout: 4000 });
            if (paceScale > 0) await wait(Math.min(500, Math.round(500 * paceScale)));
            if (
              !native.confirmed() &&
              !native.failed() &&
              !native.restricted() &&
              normalizeBumperComment(await readBumperComposerText(box)).includes(
                normalizeBumperComment(chosen.text),
              )
            ) {
              const clickedSubmit = await box
                .evaluate((el) => {
                  const excludeRx =
                    /sticker|gif|emoji|photo|video|camera|attach|avatar|贴图|貼圖|动图|動圖|表情|图片|圖片|照片|相机|相機/i;
                  const submitRx =
                    /^(?:Comment|评论|留言|发送|發送|发布|發佈|Submit|Send|Bình luận|Gửi|แสดงความคิดเห็น|ส่ง|မှတ်ချက်ပေးရန်|ပို့ရန်)$/iu;
                  let host: HTMLElement | null = el.parentElement;
                  for (let depth = 0; host && depth < 6; depth++, host = host.parentElement) {
                    const btns = Array.from(
                      host.querySelectorAll<HTMLElement>(
                        '[role="button"],button,[data-testid*="submit" i]',
                      ),
                    ).filter((b) => {
                      if (b.getAttribute('aria-disabled') === 'true' || b.hasAttribute('disabled'))
                        return false;
                      const r = b.getBoundingClientRect();
                      const s = getComputedStyle(b);
                      if (
                        r.width <= 0 ||
                        r.height <= 0 ||
                        s.display === 'none' ||
                        s.visibility === 'hidden'
                      )
                        return false;
                      const lbl =
                        `${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`.trim();
                      if (excludeRx.test(lbl)) return false;
                      const testid = b.getAttribute('data-testid') ?? '';
                      return /submit/i.test(testid) || submitRx.test(lbl);
                    });
                    if (btns.length === 1 && btns[0]) {
                      btns[0].click();
                      return true;
                    }
                  }
                  return false;
                })
                .catch(() => false);
              if (clickedSubmit)
                diagBumperInfo(profileId, 'BUMPER_COMMENT_SUBMIT_FALLBACK_CLICK', {
                  postId: post.postId,
                });
            }
            return true;
          },
          async () => {
            const markRestricted = async (dismissCss: string | null) => {
              await dismissFeatureOrJoinCSS(session.getPage(), dismissCss, session.guard);
              commentRejectedByRestriction = true;
              stats.commentRestrictedInSession = true;
              return true;
            };
            const checkRestriction = async (checkDom: boolean) => {
              if (native.confirmed()) return false;
              if (native.restricted()) {
                if (!allowFallback)
                  throw new BumperFatalError('受限 · 账号点赞或评论被 Facebook 限制');
                return markRestricted(null);
              }
              if (!checkDom) return false;
              const s = await readGroupBumper(session.getPage(), { groupId: effectiveGroupId });
              if (s.checkpointRestricted || s.restrictionReason)
                throw new BumperFatalError(
                  '受限 · ' + (s.restrictionReason ?? '需要手机验证或操作受限'),
                );
              if (
                allowFallback &&
                (s.restricted || (s.blockingDialog && Boolean(s.joinRestrictionDismissCSS)))
              )
                return markRestricted(s.joinRestrictionDismissCSS ?? null);
              return false;
            };
            const confirmComment = () => (
              (activePostState.record.commentText = chosen.text),
              (stats.consecutiveUnconfirmed = 0),
              true
            );
            const pollHit = await pollWithGuard(10000, session.guard, async (tick) => {
              if (native.confirmed()) return confirmComment();
              if (await checkRestriction(tick % 2 === 1)) return true;
              if (native.failed()) throw Error(native.failureReason());
              return null;
            });
            if (pollHit) return true;
            await native.waitForEvidence(2000, session.guard);
            if (native.confirmed()) return confirmComment();
            if (await checkRestriction(true)) return true;
            if (native.failed()) throw Error(native.failureReason());
            const readBackPost = await checkPost().catch(() => null);
            const expectedNorm = normalizeBumperComment(chosen.text);
            const domMatched = Boolean(
              readBackPost?.comments.some(
                (c) =>
                  Boolean(c.id) &&
                  !/^client:/i.test(c.id) &&
                  (!c.authorId || c.authorId === session.accountId) &&
                  normalizeBumperComment(c.text) === expectedNorm,
              ),
            );
            if (domMatched) {
              diagBumperInfo(profileId, 'BUMPER_COMMENT_DOM_READBACK', {
                groupId: effectiveGroupId,
                postId: post.postId,
              });
              return confirmComment();
            }
            stats.consecutiveUnconfirmed++;
            return false;
          },
          async (value, binding, resolution) =>
            commentRejectedByRestriction && !activePostState.record.commentText
              ? {
                  id: randomUUID(),
                  outcome: 'NOT_APPLIED',
                  evidenceDigest: digest({
                    binding,
                    label: '发送评论',
                    rejectedByRestriction: true,
                  }),
                }
              : persist(value, binding, resolution),
          (binding) => onBind(binding.operationId),
        );
        if (commentRejectedByRestriction) {
          activePostState.chosen = null;
          diagBumperInfo(profileId, 'BUMPER_COMMENT_RESTRICTED_FALLBACK_LIKE_ONLY', {
            groupId: effectiveGroupId,
            postId: post.postId,
          });
        }
        activePostState.commentProgress = 'VERIFIED';
      },
    });
  } finally {
    const postCommentSurface = await readGroupBumper(session.getPage(), {
      groupId: effectiveGroupId,
    }).catch(() => null);
    if (
      postCommentSurface &&
      allowFallback &&
      !postCommentSurface.checkpointRestricted &&
      !postCommentSurface.restrictionReason &&
      (postCommentSurface.restricted || Boolean(postCommentSurface.joinRestrictionDismissCSS))
    ) {
      stats.commentRestrictedInSession = true;
      await groupHelpers.dismissPostJoinObstructionIfNeeded(postCommentSurface);
      diagBumperInfo(profileId, 'BUMPER_COMMENT_RESTRICTED_FALLBACK_LIKE_ONLY', {
        groupId: effectiveGroupId,
        postId: post.postId,
      });
    }
    await groupHelpers.dismissWelcomeDialogIfNeeded();
  }
}
export async function runBumperPostStoryShare(
  ctx: BumperPostCtx,
  hydratedPost: BumperPost,
  doLike: boolean,
): Promise<void> {
  const {
    profileId,
    paceScale,
    effectiveGroupId,
    group,
    target,
    post,
    todayCount,
    callbacks,
    session,
    activePostState,
    stats,
    checkPost,
    persist,
  } = ctx;
  if (!activePostState.wantShareToStory || activePostState.storyShareProgress !== 'NOT_SENT')
    return;
  if (doLike || activePostState.chosen)
    await session.paceWait(2500 + Math.floor(Math.random() * 2501));
  let sharePost = await checkPost();
  if (!sharePost.shareCSS) {
    const anchor =
      sharePost.likeCSS ?? sharePost.commentButtonCSS ?? sharePost.postCSS ?? post.postCSS;
    if (anchor) {
      await revealBumperControlIfNeeded(session.getPage().locator(anchor).first(), paceScale).catch(
        () => {},
      );
      await session.paceWait(400);
      sharePost = await checkPost().catch(() => sharePost);
    }
  }
  if (!sharePost.shareCSS) {
    activePostState.storyShareProgress = 'SKIPPED';
    diagBumperInfo(profileId, 'BUMPER_STORY_SHARE_UNAVAILABLE', {
      groupId: effectiveGroupId,
      postId: post.postId,
      reason: 'no_share_button',
      likeFound: Boolean(sharePost.likeCSS),
      commentBtnFound: Boolean(sharePost.commentButtonCSS),
    });
    return;
  }
  let shareDialogReady = false;
  try {
    callbacks.status(`正在分享快拍 · ${group.name} · ${target.name}`, todayCount);
    await session.op(
      '打开分享弹窗',
      async () => {
        const activePage = session.getPage();
        const clickShareBtn = async (css: string) => {
          const btn = activePage.locator(css).first();
          await revealBumperControlIfNeeded(btn, paceScale);
          await btn.click({ timeout: 4000 });
        };
        try {
          await clickShareBtn(sharePost.shareCSS ?? '[data-wb-missing-control]');
        } catch {
          session.guard();
          const retried = await checkPost();
          if (!retried.shareCSS) return false;
          await clickShareBtn(retried.shareCSS);
        }
        for (
          const openEnd = Date.now() + Math.max(400, Math.round(4500 * (paceScale || 1)));
          Date.now() < openEnd;
        ) {
          session.guard();
          const dlg = await readBumperShareDialog(activePage).catch(() => null);
          if (dlg?.restricted) throw new BumperFatalError('受限 · 账号分享功能被 Facebook 限制');
          if (dlg?.open) {
            shareDialogReady = Boolean(dlg.storyButtonCSS);
            if (shareDialogReady) return true;
          }
          await session.paceWait(200);
        }
        const finalDlg = await readBumperShareDialog(activePage).catch(() => null);
        shareDialogReady = Boolean(finalDlg?.open && finalDlg.storyButtonCSS);
        return true;
      },
      async () => true,
    );
    if (!shareDialogReady) {
      activePostState.storyShareProgress = 'SKIPPED';
      diagBumperInfo(profileId, 'BUMPER_STORY_SHARE_UNAVAILABLE', {
        groupId: effectiveGroupId,
        postId: post.postId,
        reason: 'no_story_option',
      });
      return;
    }
    await session.paceWait(400 + Math.floor(Math.random() * 501));
    const sharePressBefore = session.getConn().submissionCalls?.mousePress,
      native = observeBumperStoryShareGraphql(session.getPage(), {
        actorId: session.accountId,
        postId: post.postId,
        feedbackId: hydratedPost.feedbackId ?? post.feedbackId ?? undefined,
        profileId,
      });
    await trackBumperSubmissionOp({
      session,
      callKind: 'mousePress',
      native,
      onErrorProgress: (progress) => {
        activePostState.storyShareProgress = progress;
      },
      run: async (onBind) => {
        await session.op(
          '分享到快拍',
          async () => {
            const activePage = session.getPage();
            const activeConn = session.getConn();
            const dlg = await readBumperShareDialog(activePage);
            if (dlg.restricted) throw new BumperFatalError(SHARE_RESTRICTED_MSG);
            if (!dlg.open || !dlg.storyButtonCSS) return false;
            await activePage.locator(dlg.storyButtonCSS).first().click({ timeout: 4000 });
            return (
              sharePressBefore === undefined ||
              activeConn.submissionCalls.mousePress > sharePressBefore
            );
          },
          async (clicked) => {
            if (!clicked) return true;
            const checkShareDone = async () => {
              if (native.restricted()) throw new BumperFatalError(SHARE_RESTRICTED_MSG);
              if (native.failed()) throw Error(native.failureReason());
              const dlg = await readBumperShareDialog(session.getPage()).catch(() => null);
              if (dlg?.restricted) throw new BumperFatalError(SHARE_RESTRICTED_MSG);
              if (
                native.confirmed() ||
                (dlg && !dlg.open && (native.anyMutationConfirmed() || dlg.toastConfirmed))
              )
                return (
                  (activePostState.record.storyShared = true),
                  (stats.consecutiveUnconfirmed = 0),
                  true
                );
              return false;
            };
            if (
              await pollWithGuard(10_000, session.guard, async () =>
                (await checkShareDone()) ? true : null,
              )
            )
              return true;
            await native.waitForEvidence(2000, session.guard);
            if (await checkShareDone()) return true;
            stats.consecutiveUnconfirmed++;
            return false;
          },
          async (value, binding, resolution) =>
            activePostState.record.storyShared
              ? persist(value, binding, resolution)
              : {
                  id: randomUUID(),
                  outcome: 'NOT_APPLIED',
                  evidenceDigest: digest({
                    binding,
                    label: '分享到快拍',
                    clicked: Boolean(value),
                    storyShared: false,
                  }),
                },
          (binding) => onBind(binding.operationId),
        );
        activePostState.storyShareProgress = activePostState.record.storyShared
          ? 'VERIFIED'
          : 'SKIPPED';
      },
    });
  } finally {
    const peer = session.getPeer();
    if (!callbacks.cancelled() && peer.online && peer.epoch === session.getEpoch())
      await closeBumperShareDialogIfOpen(
        session,
        Math.max(300, Math.round(2000 * (paceScale || 1))),
      );
  }
}
