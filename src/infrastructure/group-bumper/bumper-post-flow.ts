import { randomUUID } from 'node:crypto';
import type { Locator, Page } from 'playwright-core';
import type { CompatibleRepository } from '../../domain/persistence.js';
import type { BumperResolutionValue } from '../../shared/bumper-operation.js';
import { devDiag } from '../../shared/dev-diagnostics.js';
import type { BumperSettings, BumperTarget } from '../../shared/group-bumper.js';
import type { Binding } from '../../shared/task-execution.js';
import type { InFlightBumperCoordinator } from '../facebook-group-session.js';
import { bumperAuthorMatch, type BumperPost, readGroupBumper } from '../group-bumper-effects.js';
import type { SqliteGroupBumperRepository } from '../group-bumper-store.js';
import {
  BUMPER_DEBUGGER_CANCELED_MESSAGE,
  type BumperConnection,
  BumperFatalError,
  type BumperGroupFeedContext,
  BumperPostReadIncomplete,
  type BumperRunCallbacks,
  type BumperRunStats,
  BumperSetupUnconfirmed,
  type BumperSurface,
  digest,
  isBumperFatal,
  isBumperRecoverableDisconnectError,
  normalizeBumperComment,
  pollWithGuard,
  type ResumablePostState,
  sameBumperFeedbackId,
  wait,
  claimBumperComment,
} from './bumper-core.js';
import { dismissFeatureInterventionDialogIfPresent } from '../group-inviter-effects.js';
import type { BumperGroupSurfaceHelpers } from './bumper-group-setup.js';
import {
  checkBumperPost,
  runBumperPostBrowse,
  runBumperPostLike,
} from './bumper-post-browse-like.js';
import { runBumperPostComment, runBumperPostStoryShare } from './bumper-post-comment-share.js';
import type { BumperSessionRuntime } from './bumper-session.js';
export interface BumperPostCtx {
  profileId: string;
  paceScale: number;
  effectiveGroupId: string;
  group: BumperTarget;
  target: BumperTarget;
  post: BumperPost;
  todayCount: number;
  settings: BumperSettings;
  callbacks: BumperRunCallbacks;
  session: BumperSessionRuntime;
  groupHelpers: BumperGroupSurfaceHelpers;
  activePostState: ResumablePostState;
  stats: BumperRunStats;
  checkPost: () => Promise<BumperPost>;
  persist: (
    value: unknown,
    binding: Binding,
    resolution: BumperResolutionValue,
  ) => Promise<BumperResolutionValue | void>;
}
export async function dismissFeatureOrJoinCSS(
  page: Page,
  dismissCSS: string | null | undefined,
  guard: () => void,
): Promise<void> {
  if (await dismissFeatureInterventionDialogIfPresent(page, guard)) return;
  if (!dismissCSS) return;
  await page
    .evaluate((sel) => document.querySelector<HTMLElement>(sel)?.click(), dismissCSS)
    .catch(() => {});
  await wait(350);
}
export async function navigateViaSearchEntry(input: {
  session: BumperSessionRuntime;
  paceScale: number;
  query: string;
  searchUrl: string;
  fallbackUrl: string;
  readSurface: () => Promise<BumperSurface>;
  missingMsg: string;
  urlOk: (u: URL) => boolean;
}): Promise<{ usedFallback: boolean; surface?: BumperSurface }> {
  const { session, paceScale, query, searchUrl, fallbackUrl, readSurface, missingMsg, urlOk } =
      input,
    page = session.getPage();
  await session.searchViaInputOrUrl(query, searchUrl);
  const found = await pollWithGuard(
    6000,
    session.guard,
    async () => ((await readSurface()).groupEntryCSS ? await readSurface() : null),
    400,
  );
  if (found) {
    session.clearNavigationChain();
    let latest: BumperSurface = found;
    try {
      await session.op(
        '打开搜索到的小组',
        async () => {
          const refreshed = await readSurface();
          if (!refreshed.groupEntryCSS) throw Error(missingMsg);
          latest = refreshed;
          const entry = page.locator(refreshed.groupEntryCSS).first();
          await centerBumperControl(entry, paceScale);
          const prePause = Math.round((300 + Math.floor(Math.random() * 301)) * paceScale);
          if (prePause > 0) await wait(prePause);
          await entry.click({ timeout: 4000 });
          await page.waitForURL(urlOk, { timeout: 15000 });
          return page.url();
        },
        async () => new URL(page.url()).origin === 'https://www.facebook.com',
      );
      return { usedFallback: false, surface: latest };
    } catch (err) {
      if (isBumperFatal(err)) throw err;
    }
  }
  await session.navigate(fallbackUrl);
  return { usedFallback: true };
}
export interface RequireBumperPostOptions {
  pageBumper?: boolean;
  accountId?: string;
  pageOwnerAuthorId?: string | null;
}
export function requireBumperPost(
  post: BumperPost | undefined,
  target: BumperTarget,
  expectedFeedback: string | null,
  options?: RequireBumperPostOptions,
): BumperPost {
  const hasAuthorIdentity = options?.pageBumper
    ? Boolean(
        post?.authorId ||
        post?.authorAliases?.length ||
        post?.authorName?.trim() ||
        post?.feedbackId,
      )
    : Boolean(post?.authorId || post?.authorAliases?.length);
  if (!post || !hasAuthorIdentity || (expectedFeedback && !post.feedbackId))
    throw new BumperPostReadIncomplete();
  const authorMatched = options?.pageBumper
    ? !(
        options.accountId &&
        post.authorId &&
        post.authorId === options.accountId &&
        options.accountId !== target.id &&
        options.accountId !== options.pageOwnerAuthorId
      ) && !isForeignPagePost(post, target, options.pageOwnerAuthorId ?? null)
    : bumperAuthorMatch(post, target);
  if (
    !authorMatched ||
    (expectedFeedback && !sameBumperFeedbackId(post.feedbackId, expectedFeedback))
  )
    throw Error('目标帖子或作者已变化');
  return post;
}
export async function closeBumperPostDialog(input: {
  page: Page;
  postId: string;
  guard(): void;
  read(): Promise<Awaited<ReturnType<typeof readGroupBumper>>>;
  run(
    work: () => Promise<boolean>,
    verify: (clicked: boolean) => Promise<boolean>,
  ): Promise<unknown>;
}) {
  if (!input.read || !input.run) return;
  input.guard();
  const hasDialog = async () =>
    !!(await input.read()).postDialogs?.some((d) => d.postId === input.postId);
  if (!(await hasDialog())) return;
  await input.run(
    async () => {
      input.guard();
      if (!(await hasDialog())) return false;
      await input.page.keyboard.press('Escape');
      return true;
    },
    async () => {
      if (
        await pollWithGuard(2000, input.guard, async () => ((await hasDialog()) ? null : true), 100)
      )
        return true;
      throw new BumperFatalError('上一帖评论窗口未能关闭，本轮已停止');
    },
  );
}
export async function centerBumperControl(locator: Locator, paceScale = 1, timeout = 4000) {
  await locator.evaluate(
    (el) => el.scrollIntoView({ block: 'center', inline: 'center' }),
    undefined,
    {
      timeout,
    },
  );
  if (paceScale > 0) await wait(Math.max(1, Math.round(150 * paceScale)));
}
export async function prepareBumperPost(input: {
  page: Pick<Page, 'locator'>;
  readCurrent(): Promise<BumperPost>;
  guard(): void;
  candidateCardCSS?: string | null;
  paceScale?: number;
  timeoutMs?: number;
}): Promise<BumperPost> {
  const deadline = Date.now() + (input.timeoutMs ?? 12_000);
  let hydrationScrollUsed = false;
  const center = (sel: string, remaining: number) =>
    centerBumperControl(
      input.page.locator(sel).first(),
      input.paceScale ?? 1,
      Math.min(750, remaining),
    );
  const isDetachErr = (error: unknown) =>
    error instanceof Error &&
    /locator\.evaluate: Timeout|Element is not attached|Element was detached/i.test(error.message);
  while (Date.now() < deadline) {
    input.guard();
    try {
      const current = await input.readCurrent();
      input.guard();
      const anchor =
        current.videoCSS ??
        current.postCSS ??
        current.likeCSS ??
        current.commentButtonCSS ??
        current.commentCSS;
      if (!anchor) throw new BumperPostReadIncomplete();
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await center(anchor, remaining);
      input.guard();
      const after = await input.readCurrent();
      input.guard();
      if (!(after.likeCSS || after.commentButtonCSS || after.commentCSS || after.hasVideo))
        throw new BumperPostReadIncomplete();
      return after;
    } catch (error) {
      input.guard();
      if (!(error instanceof BumperPostReadIncomplete) && !isDetachErr(error)) throw error;
      if (
        error instanceof BumperPostReadIncomplete &&
        !hydrationScrollUsed &&
        input.candidateCardCSS
      ) {
        hydrationScrollUsed = true;
        const remaining = deadline - Date.now();
        if (remaining > 0) {
          try {
            await center(input.candidateCardCSS, remaining);
          } catch (scrollError) {
            if (!isDetachErr(scrollError)) throw scrollError;
          }
          input.guard();
        }
      }
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await wait(Math.min(200, remaining));
  }
  input.guard();
  throw new Error('目标帖子仍在加载或控件未就绪，本帖准备超时，未执行互动');
}
export async function revealBumperControlIfNeeded(
  locator: Locator,
  paceScale = 1,
): Promise<boolean> {
  const didScroll = await locator.evaluate(
    (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const vh = window.innerHeight || document.documentElement.clientHeight || 800;
      const banner = document.querySelector(
        '[role="banner"], [role="navigation"][aria-label="Facebook"]',
      );
      const bannerBottom = banner ? Math.max(0, banner.getBoundingClientRect().bottom) : 56;
      const topSafe = Math.min(Math.max(68, Math.ceil(bannerBottom + 12)), Math.floor(vh * 0.35));
      const bottomSafe = vh - 20;
      let scroller: HTMLElement | null = el.parentElement;
      while (scroller && scroller !== document.body && scroller !== document.documentElement) {
        const style = getComputedStyle(scroller);
        if (
          /(?:auto|scroll|overlay)/i.test(style.overflowY) &&
          scroller.scrollHeight > scroller.clientHeight + 4
        )
          break;
        scroller = scroller.parentElement;
      }
      let moved = false;
      const isOccluded = (r: DOMRect) => {
        const hit = document.elementFromPoint?.((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        return !!hit && hit !== el && !el.contains(hit);
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const rect = el.getBoundingClientRect();
        const occluded = isOccluded(rect);
        if (rect.top >= topSafe && rect.bottom <= bottomSafe && !occluded) break;
        const delta = occluded
          ? Math.round((rect.top + rect.bottom) / 2 - (topSafe + 32))
          : rect.bottom > bottomSafe
            ? Math.ceil(rect.bottom - (vh - 28))
            : Math.floor(rect.top - (topSafe + 16));
        if (Math.abs(delta) < 2) break;
        if (scroller && scroller !== document.body && scroller !== document.documentElement)
          scroller.scrollBy({ top: delta, behavior: 'instant' });
        else window.scrollBy({ top: delta, behavior: 'instant' });
        moved = true;
        if (!isOccluded(el.getBoundingClientRect())) break;
      }
      return moved;
    },
    undefined,
    { timeout: 4000 },
  );
  if (didScroll !== false && paceScale > 0) await wait(Math.max(1, Math.round(150 * paceScale)));
  return didScroll === true;
}
async function waitWithGuard(ms: number, guard: () => void) {
  for (let left = ms; left > 0; left -= 100) {
    guard();
    await wait(Math.min(100, left));
  }
}
export async function typeBumperComment(
  page: Page,
  box: Locator,
  text: string,
  paceScale = 1,
  guard: () => void = () => {},
) {
  await revealBumperControlIfNeeded(box, paceScale);
  await box.click({ timeout: 4000 });
  if (normalizeBumperComment(await box.innerText())) {
    await box.press('ControlOrMeta+A');
    await box.press('Backspace');
  }
  const typeChar =
    typeof page.keyboard.type === 'function'
      ? (ch: string) => page.keyboard.type(ch)
      : (ch: string) => page.keyboard.insertText(ch);
  for (const ch of Array.from(text)) {
    guard();
    await typeChar(ch);
    const delay =
      55 +
      Math.floor(Math.random() * 56) +
      (/[，。！？、；：,.!?;:\s]/.test(ch) ? 60 + Math.floor(Math.random() * 81) : 0);
    await waitWithGuard(Math.round(delay * paceScale), guard);
  }
  if (!normalizeBumperComment(await box.innerText()))
    await box.pressSequentially(text, {
      delay: Math.max(10, Math.round((95 + Math.floor(Math.random() * 90)) * paceScale)),
      timeout: 60000,
    });
  if (!normalizeBumperComment(await box.innerText()).includes(normalizeBumperComment(text)))
    throw Error('评论文字尚未进入编辑器，已跳过当前帖');
  await waitWithGuard(Math.round((1200 + Math.floor(Math.random() * 1401)) * paceScale), guard);
}
export async function executeBumperOperation<T>(input: {
  connection: Pick<BumperConnection, 'execute' | 'reconcile' | 'nativeMutationCalls'> &
    Partial<Pick<BumperConnection, 'submissionCalls'>>;
  binding: Binding;
  label: string;
  work: () => Promise<T>;
  verify: (value: T) => Promise<boolean>;
  persist?: (value: T, resolution: BumperResolutionValue) => Promise<BumperResolutionValue | void>;
  assertCurrent: () => Promise<void>;
  stop: () => Promise<void>;
  settlement?: {
    auxiliary: boolean;
    save(resolution: BumperResolutionValue): Promise<BumperResolutionValue>;
    settled(): Promise<void>;
    review(reason: string): Promise<void>;
  };
}) {
  const conn = input.connection;
  const mutations = () =>
    !input.settlement?.auxiliary && conn.submissionCalls
      ? input.label === '发送评论'
        ? conn.submissionCalls.enter
        : conn.submissionCalls.mousePress
      : Object.values(conn.nativeMutationCalls).reduce((n, c) => n + c, 0);
  const before = mutations();
  const makeResolution = (
    outcome: BumperResolutionValue['outcome'],
    evidence: unknown,
  ): BumperResolutionValue => ({
    id: randomUUID(),
    outcome,
    evidenceDigest: digest({ binding: input.binding, label: input.label, evidence }),
  });
  let value: T;
  try {
    type Attempt = { ok: true; value: T } | { ok: false; error: unknown };
    const result = await conn.execute<Attempt>(
      input.binding,
      async () => {
        try {
          return { ok: true, value: await input.work() };
        } catch (error) {
          if (isBumperFatal(error)) throw error;
          return { ok: false, error };
        }
      },
      input.assertCurrent,
      async (reason) => {
        if (isBumperFatal(new Error(reason))) await input.stop();
      },
    );
    if (!result.value.ok) throw result.value.error;
    value = result.value.value;
    if (!(await input.verify(value))) throw Error(input.label + '结果待核对，未重发');
  } catch (error) {
    const rawReason = error instanceof Error ? error.message : String(error);
    const reason =
      rawReason
        .replace(/\u001b\[[0-9;]*m/g, '')
        .split(/\r?\nCall log:/)[0]
        ?.trim() || rawReason;
    if (mutations() === before) {
      const resolution = input.settlement
        ? await input.settlement.save(makeResolution('NOT_APPLIED', reason))
        : makeResolution('NOT_APPLIED', reason);
      if (resolution.outcome !== 'ENDED_UNKNOWN') {
        try {
          await conn.reconcile(input.binding, { ...resolution, outcome: resolution.outcome });
          await input.settlement?.settled();
        } catch {}
      }
    } else if (input.settlement?.auxiliary) {
      await input.settlement.save(makeResolution('ENDED_UNKNOWN', reason));
      if (isBumperFatal(error)) throw error;
      throw new BumperSetupUnconfirmed(reason);
    } else await input.settlement?.review(reason);
    throw error;
  }
  let resolution = makeResolution('VERIFIED', value);
  try {
    resolution = (await input.persist?.(value, resolution)) ?? resolution;
    if (input.settlement) resolution = await input.settlement.save(resolution);
  } catch (error) {
    throw new BumperFatalError(
      '顶贴结果保存失败：' + (error instanceof Error ? error.message : String(error)),
    );
  }
  await input.assertCurrent();
  if (resolution.outcome === 'ENDED_UNKNOWN') throw Error('BUMPER_RESOLUTION_CONFLICT');
  await conn.reconcile(input.binding, { ...resolution, outcome: resolution.outcome });
  await input.settlement?.settled();
  return value;
}
export function isForeignPagePost(
  post: Pick<BumperPost, 'authorId' | 'authorName' | 'authorAliases'>,
  page: Pick<BumperTarget, 'id' | 'name'>,
  pageOwnerAuthorId: string | null,
): boolean {
  if (!pageOwnerAuthorId || !post.authorId || !/^\d+$/.test(post.authorId)) return false;
  if (post.authorId === pageOwnerAuthorId || post.authorId === page.id) return false;
  if (bumperAuthorMatch(post as BumperPost, page as BumperTarget)) return false;
  const name = page.name.trim().toLowerCase();
  return !(name && name !== page.id.toLowerCase() && post.authorName.trim().toLowerCase() === name);
}
export async function executeBumperPostActions(input: {
  profileId: string;
  paceScale: number;
  repo: CompatibleRepository<SqliteGroupBumperRepository>;
  inFlightCoordinator: InFlightBumperCoordinator;
  commentClaims: Set<string>;
  settings: BumperSettings;
  callbacks: BumperRunCallbacks;
  session: BumperSessionRuntime;
  groupCtx: BumperGroupFeedContext;
  groupHelpers: BumperGroupSurfaceHelpers;
  stats: BumperRunStats;
  feed: BumperTarget | null;
  resolvedPageId: string | undefined;
  pageOwnerAuthorId: string | null;
  target: BumperTarget;
  post: BumperPost;
  isResumingCurrentPost: boolean;
  resumableRef: { current: ResumablePostState | null };
}): Promise<'continue' | 'quota_reached'> {
  const {
      profileId,
      paceScale,
      repo,
      inFlightCoordinator,
      commentClaims,
      settings,
      callbacks,
      session,
      groupCtx,
      groupHelpers,
      stats,
      feed,
      resolvedPageId,
      pageOwnerAuthorId,
      target,
      post,
      isResumingCurrentPost,
      resumableRef,
    } = input,
    { group, isPageBumperMode, sourceMode } = groupCtx,
    accountId = session.accountId;
  session.guard();
  let chosen: Awaited<ReturnType<SqliteGroupBumperRepository['pickComment']>> = null,
    postClaimed = false,
    quotaReserved = false;
  const issueCountBeforePost = session.getIssueCount();
  try {
    if (!session.scanOnly && !inFlightCoordinator.tryAcquirePost(accountId, post.postId)) {
      stats.skippedByQuotaPosts++;
      return 'continue';
    }
    postClaimed = !session.scanOnly;
    const q = await repo.eligibility(accountId, profileId, post.postId, Date.now(), sourceMode);
    session.guard();
    const resumed = isResumingCurrentPost ? resumableRef.current : null,
      resumingAlreadyCredited =
        resumed !== null &&
        (resumed.credited ||
          (resumed.wantLike && resumed.likeProgress === 'VERIFIED') ||
          (resumed.chosen !== null && resumed.commentProgress === 'VERIFIED') ||
          (resumed.wantShareToStory && resumed.storyShareProgress === 'VERIFIED')),
      reportQuota = () => {
        stats.quotaReached = true;
        callbacks.status(`今日已达上限 (${q.today}/${settings.dailyMaxLikesPerAccount})`, q.today);
        return 'quota_reached' as const;
      };
    if (!resumingAlreadyCredited && q.today >= settings.dailyMaxLikesPerAccount)
      return reportQuota();
    if (!resumingAlreadyCredited && !q.allowed) {
      stats.skippedByQuotaPosts++;
      return 'continue';
    }
    const wantLike = resumed
        ? resumed.wantLike
        : !post.liked && Math.random() * 100 < settings.likeProbability,
      shareProb = settings.shareToStoryProbability ?? 0,
      wantShareToStory = resumed
        ? resumed.wantShareToStory
        : shareProb > 0 && Math.random() * 100 < shareProb;
    if (resumed) {
      chosen = resumed.chosen;
      if (chosen) commentClaims.add(chosen.id);
    } else if (
      !groupCtx.joinRestrictedFallback &&
      !stats.commentRestrictedInSession &&
      Math.random() * 100 < settings.commentProbability
    ) {
      chosen = await claimBumperComment(
        commentClaims,
        (excludeIds) => repo.pickComment(post.postId, Math.random(), excludeIds, sourceMode),
        session.guard,
      );
    }
    if (!session.scanOnly && !wantLike && !chosen && !wantShareToStory) {
      if (isResumingCurrentPost) resumableRef.current = null;
      return 'continue';
    }
    if (
      !session.scanOnly &&
      !resumingAlreadyCredited &&
      !inFlightCoordinator.tryReserveDailyQuota(
        accountId,
        sourceMode,
        q.today,
        settings.dailyMaxLikesPerAccount,
      )
    )
      return reportQuota();
    quotaReserved = !session.scanOnly && !resumingAlreadyCredited;
    const activePostState: ResumablePostState = resumed ?? {
        postId: post.postId,
        wantLike,
        wantShareToStory,
        chosen,
        record: {
          id: randomUUID(),
          profileId,
          accountId,
          groupId: group.id,
          groupName: group.name,
          pageId: target.id,
          pageName: target.name,
          postId: post.postId,
          postUrl: post.postUrl,
          liked: false,
          commentText: null,
          storyShared: false,
          bumpedAt: Date.now(),
          sourceMode,
        },
        credited: false,
        browseDone: false,
        likeProgress: wantLike ? 'NOT_SENT' : 'SKIPPED',
        commentProgress: chosen ? 'NOT_SENT' : 'SKIPPED',
        storyShareProgress: wantShareToStory ? 'NOT_SENT' : 'SKIPPED',
      },
      record = activePostState.record;
    let credited = activePostState.credited;
    resumableRef.current = activePostState;
    session.setOperationContext({
      groupId: group.id,
      groupName: group.name,
      pageId: target.id,
      pageName: target.name,
      postId: post.postId,
      postUrl: post.postUrl,
      logId: record.id,
      commentId: chosen?.id,
      commentText: chosen?.text,
    });
    const persist = async (
        _value: unknown,
        binding: Binding,
        resolution: BumperResolutionValue,
      ) => {
        const saved = await repo.confirmSubmission(
          binding.operationId,
          record,
          chosen?.id,
          resolution,
        );
        session.resetNoProgressRecoveries();
        if (!credited) {
          credited = activePostState.credited = true;
          if (quotaReserved) {
            quotaReserved = false;
            inFlightCoordinator.releaseDailyQuota(accountId, sourceMode);
          }
          stats.sessionBumped++;
          callbacks.added(
            (await repo.eligibility(accountId, profileId, post.postId, Date.now(), sourceMode))
              .today,
          );
        }
        return saved;
      },
      expectedFeedbackRef: { current: null | string } = { current: null },
      checkPost = () =>
        checkBumperPost({
          session,
          effectiveGroupId: groupCtx.effectiveGroupId,
          isPageBumperMode,
          feed,
          resolvedPageId,
          target,
          postId: post.postId,
          expectedFeedbackId: expectedFeedbackRef.current,
          pageOwnerAuthorId,
        });
    await groupHelpers.dismissWelcomeDialogIfNeeded();
    if (session.scanOnly) {
      callbacks.status('只读扫描 · ' + post.postId);
      resumableRef.current = null;
      return 'continue';
    }
    const postCtx: BumperPostCtx = {
      profileId,
      paceScale,
      effectiveGroupId: groupCtx.effectiveGroupId,
      group,
      target,
      post,
      todayCount: q.today,
      settings,
      callbacks,
      session,
      groupHelpers,
      activePostState,
      stats,
      checkPost,
      persist,
    };
    if (!(await runBumperPostBrowse(postCtx, resumableRef, expectedFeedbackRef))) return 'continue';
    const { doLike, hydratedPost } = await runBumperPostLike(postCtx);
    await runBumperPostComment(postCtx, hydratedPost, doLike);
    await runBumperPostStoryShare(postCtx, hydratedPost, doLike);
    resumableRef.current = null;
    if (record.liked || record.commentText || record.storyShared)
      await session.paceWait(4000 + Math.floor(Math.random() * 5001));
  } catch (error) {
    if (session.isCanceledByUserDetach(error))
      throw new BumperFatalError(BUMPER_DEBUGGER_CANCELED_MESSAGE);
    if (isBumperRecoverableDisconnectError(error)) throw error;
    const wasCredited = resumableRef.current?.credited === true;
    resumableRef.current = null;
    session.guard();
    if (isBumperFatal(error)) throw error;
    const errText = error instanceof Error ? error.message : String(error);
    if (session.getIssueCount() === issueCountBeforePost) {
      const skipOnly =
        !wasCredited &&
        /目标帖子仍在加载或控件未就绪|视频播放器未加载|视频未实际播放|视频播放长时间未推进|视频节点已变化/.test(
          errText,
        );
      session.reportIssue({ kind: skipOnly ? 'skipped' : 'failed', reason: errText });
    }
    if (stats.consecutiveUnconfirmed >= 3)
      throw new BumperFatalError('连续 3 次互动结果未确认，本轮已结束，原操作保留待核对');
    devDiag.record({
      level: 'WARN',
      category: 'GROUP_BUMPER',
      event: 'BUMPER_POST_SKIPPED',
      profileId,
      reason: errText,
      data: { groupId: group.id, postId: post.postId },
    });
  } finally {
    try {
      const peer = session.getPeer();
      if (!callbacks.cancelled() && peer.online && peer.epoch === session.getEpoch()) {
        const activePage = session.getPage();
        await closeBumperPostDialog({
          page: activePage,
          postId: post.postId,
          guard: session.guard,
          read: () =>
            readGroupBumper(activePage, {
              groupId: groupCtx.effectiveGroupId,
              targetPostId: post.postId,
            }),
          run: (work, verify) => session.op('关闭帖子弹窗', work, verify),
        });
        await groupHelpers.dismissWelcomeDialogIfNeeded();
      }
    } finally {
      if (quotaReserved) inFlightCoordinator.releaseDailyQuota(accountId, sourceMode);
      if (postClaimed) inFlightCoordinator.releasePost(accountId, post.postId);
      if (chosen) commentClaims.delete(chosen.id);
    }
  }
  return 'continue';
}
