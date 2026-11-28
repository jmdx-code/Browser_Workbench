import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import {
  PosterAccountRestrictedError,
  type GroupPosterBrowserCallbacks,
} from '../../application/group-poster-service.js';
import type { Core, Peer } from '../../bridge/core.js';
import type { CompatibleRepository } from '../../domain/persistence.js';
import { devDiag } from '../../shared/dev-diagnostics.js';
import { isLocalAvatar } from '../../shared/group-bumper.js';
import {
  formatPosterCaptionPreview,
  stripAnsi,
  type PosterLog,
  type PosterMaterial,
} from '../../shared/group-poster.js';
import { relativePostAge } from '../../shared/relative-post-age.js';
import type { Binding } from '../../shared/task-execution.js';
import { readGroupBumper } from '../group-bumper-effects.js';
import type { SqliteGroupPosterRepository } from '../group-poster-store.js';
import type { KernelBridge } from '../kernel-bridge.js';
import {
  createPosterNetworkObserver,
  resolvePosterPendingApprovalState,
  type PosterNetworkObserver,
} from './poster-network.js';
import {
  posterDigest,
  readDomCreatedPostFallback,
  readPosterApprovalNotices,
  recoverPosterOperations,
  type PosterConnection,
  type PosterExecOp,
  type PosterIdentityMeta,
} from './poster-support.js';
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const scaledMs = (ms: number, paceScale: number) =>
  paceScale <= 0 ? 0 : Math.max(15, Math.round(ms * paceScale));
const VALID_POST_ID_RE = /^(?:\d{6,25}|pfbid[A-Za-z0-9]{8,})$/i;
type ReadyScanResult = boolean | { kind: 'post' | 'next' | 'disabled' | 'none'; label?: string };
async function scanComposerActionButton(livePage: Page): Promise<ReadyScanResult> {
  return (await livePage.evaluate(() => {
    document.querySelectorAll('[data-wb-poster-submit], [data-wb-poster-next]').forEach((e) => {
      e.removeAttribute('data-wb-poster-submit');
      e.removeAttribute('data-wb-poster-next');
    });
    const topDialog =
      document.querySelector<HTMLElement>('[data-wb-poster-dialog="1"]') ??
      Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find((d) =>
        Boolean(d.querySelector('[data-wb-poster-editor="1"]')),
      ) ??
      Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
        .filter((d) => d.getBoundingClientRect().width > 200)
        .at(-1);
    if (!topDialog) return { kind: 'none' as const };
    const postRx =
      /^(?:Post|Publish|Submit|发布|发帖|發佈|發表|貼文|发贴|發貼|提交|ပို့စ်\s*တင်မည်|ပို့စ်\s*တင်ရန်|ပို့စ်\s*တင်ပါ|တင်မည်|တင်ပါ|တင်ရန်|Đăng\s*bài|Đăng|โพสต์)$/i;
    const nextRx = /^(?:Next|Continue|下一步|继续|繼續|ရှေ့သို့|ဆက်လက်|Tiếp(?:\s*theo)?|ถัดไป)$/i;
    const buttons = Array.from(
      topDialog.querySelectorAll<HTMLElement>('[role="button"], button'),
    ).filter((b) => {
      const r = b.getBoundingClientRect();
      const s = getComputedStyle(b);
      return r.width >= 40 && r.height >= 24 && s.display !== 'none' && s.visibility !== 'hidden';
    });
    const labelOf = (b: HTMLElement) =>
      (b.getAttribute('aria-label') ?? '').trim() || (b.textContent ?? '').trim();
    const isEnabled = (b: HTMLElement) =>
      b.getAttribute('aria-disabled') !== 'true' && !b.hasAttribute('disabled');
    const findMatch = (rx: RegExp, needEnabled: boolean) =>
      buttons.find(
        (b) =>
          (rx.test(labelOf(b)) || rx.test((b.textContent ?? '').trim())) &&
          (!needEnabled || isEnabled(b)),
      );
    const postMatch = findMatch(postRx, false);
    if (postMatch) {
      postMatch.setAttribute('data-wb-poster-submit', isEnabled(postMatch) ? '1' : '');
      return {
        kind: isEnabled(postMatch) ? ('post' as const) : ('disabled' as const),
        label: labelOf(postMatch).slice(0, 40),
      };
    }
    const nextMatch = findMatch(nextRx, true);
    if (nextMatch) {
      nextMatch.setAttribute('data-wb-poster-next', '1');
      return { kind: 'next' as const, label: labelOf(nextMatch).slice(0, 40) };
    }
    const dr = topDialog.getBoundingClientRect();
    const footerBtns = buttons.filter(
      (b) =>
        isEnabled(b) &&
        b.getBoundingClientRect().width >= Math.max(120, dr.width * 0.4) &&
        b.getBoundingClientRect().top >= dr.top + dr.height * 0.55,
    );
    const hit = footerBtns.length === 1 ? footerBtns[0] : undefined;
    if (!hit) return { kind: 'none' as const };
    const lbl = labelOf(hit);
    const isNext = nextRx.test(lbl);
    hit.setAttribute(isNext ? 'data-wb-poster-next' : 'data-wb-poster-submit', '1');
    return { kind: isNext ? ('next' as const) : ('post' as const), label: lbl.slice(0, 40) };
  })) as ReadyScanResult;
}
async function probeComposerState(
  page: Page,
): Promise<{ hasComposer: boolean; restrictedDialog: boolean }> {
  return page.evaluate(() => {
    const vis = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(
      (d) =>
        d.getBoundingClientRect().width > 200 &&
        d.getBoundingClientRect().height > 120 &&
        vis(d) &&
        !d.hasAttribute('data-wb-bumper-post-dialog') &&
        !d.querySelector('[data-ad-rendering-role="like_button"]'),
    );
    const editorSel =
      '[data-wb-poster-editor="1"], [role="textbox"][contenteditable="true"], div[contenteditable="true"][data-lexical-editor="true"], [contenteditable="true"][role="textbox"], textarea';
    const hasComposer = dialogs.some(
      (d) =>
        Array.from(d.querySelectorAll<HTMLElement>(editorSel)).some(
          (ed) =>
            ed.getBoundingClientRect().width > 50 &&
            ed.getBoundingClientRect().height > 14 &&
            vis(ed) &&
            !ed.closest('[aria-label*="comment" i], [aria-label*="评论"], [aria-label*="留言"]'),
        ) ||
        (d.getAttribute('data-wb-poster-dialog') === '1' &&
          Boolean(
            d.querySelector(
              '[data-wb-poster-submit="1"], input[type="file"], [role="progressbar"]',
            ),
          )),
    );
    const restrictedDialog = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="dialog"], [role="alertdialog"], [aria-modal="true"]',
      ),
    ).some((d) =>
      /Temporarily Blocked|You can['’]?t post|temporarily blocked|restricted from posting|暂时被禁止|暂时无法在小组|无法在小组发帖|限制了某些活动|restrict certain activity|Try Again Later|Account restricted|账号受限|操作受限|Community Standards|违反社区|spam/i.test(
        d.textContent ?? '',
      ),
    );
    return { hasComposer, restrictedDialog };
  });
}
async function pollDomReadbackForPost(
  input: {
    profileId: string;
    accountId: string;
    effectiveGroupId: string;
    isPageTimeline: boolean;
    paceScale: number;
    material: PosterMaterial;
    guard: () => void;
  },
  preSubmitPostIds: ReadonlySet<string>,
  preSubmitNotices: readonly string[],
  network: PosterNetworkObserver,
  ensureResponseListener: () => Page,
): Promise<{ createdPostId: string | null; pendingApproval: boolean }> {
  const steps =
    input.paceScale <= 0
      ? [0]
      : input.material.mediaKind === 'video'
        ? [0, 700, 1100, 1500, 2000, 2400, 2500]
        : [0, 600, 900, 1300, 1700, 2200];
  let extended = false;
  for (const delayMs of steps) {
    if (delayMs > 0) {
      input.guard();
      await wait(scaledMs(delayMs, input.paceScale));
    }
    await network.flush();
    const netNow = network.getState();
    if (netNow.restricted) break;
    if (netNow.createdPostId)
      return { createdPostId: netNow.createdPostId, pendingApproval: false };
    if (netNow.pendingApproval) return { createdPostId: null, pendingApproval: true };
    const page = ensureResponseListener();
    if (
      resolvePosterPendingApprovalState({
        hasComposer: false,
        graphqlPendingApproval: false,
        preSubmitNotices,
        currentNotices: await readPosterApprovalNotices(page),
      })
    )
      return { createdPostId: null, pendingApproval: true };
    const afterSurface = await readGroupBumper(page, {
      groupId: input.isPageTimeline ? '-' : input.effectiveGroupId,
      pageId: input.accountId,
    }).catch(() => null);
    const ownPost = afterSurface?.posts.find(
      (p) =>
        Boolean(p.postId) &&
        VALID_POST_ID_RE.test(p.postId ?? '') &&
        !preSubmitPostIds.has(p.postId ?? '') &&
        (p.authorId === input.accountId || p.authorAliases.includes(input.accountId)) &&
        ((age) => age !== null && age <= 5 / 60)(p.ageHours ?? relativePostAge(p.timeText)),
    );
    if (ownPost?.postId && VALID_POST_ID_RE.test(ownPost.postId))
      return { createdPostId: ownPost.postId, pendingApproval: false };
    const domFallback = await readDomCreatedPostFallback(page, {
      accountId: input.accountId,
      effectiveGroupId: input.effectiveGroupId,
      isPageTimeline: input.isPageTimeline,
      preSubmitPostIds,
    });
    if (domFallback.postId) return { createdPostId: domFallback.postId, pendingApproval: false };
    if (domFallback.transcoding && !extended && input.paceScale > 0) {
      extended = true;
      steps.push(2500, 2500);
      devDiag.emit('INFO', 'post-step', 'POSTER_VIDEO_TRANSCODING_WAIT', {
        profileId: input.profileId,
        data: { groupId: input.effectiveGroupId },
      });
    }
  }
  return { createdPostId: null, pendingApproval: false };
}
export async function waitMediaAndSubmitPost(input: {
  profileId: string;
  getPage: () => Page;
  getConn: () => PosterConnection;
  peer: Peer;
  kernel: KernelBridge;
  core: Core | undefined;
  accountId: string;
  accountName: string;
  jobId: string;
  stepId: string;
  effectiveGroupId: string;
  effectiveGroupName: string;
  isPageTimeline: boolean;
  groupAvatarUrl: string | null;
  resolvedGroupAvatar: string | null;
  surface: Awaited<ReturnType<typeof readGroupBumper>>;
  material: PosterMaterial;
  identityMeta: PosterIdentityMeta;
  paceScale: number;
  posterRepo: CompatibleRepository<SqliteGroupPosterRepository> | undefined;
  callbacks: GroupPosterBrowserCallbacks;
  markedPendingReviewRef: { value: boolean };
  guard: () => void;
  assertIdentity: () => Promise<void>;
  execOp: PosterExecOp;
  stopProfile: () => Promise<void>;
  reconnectAfterUncertainOp: () => Promise<void>;
}): Promise<void> {
  const {
    profileId,
    accountId,
    effectiveGroupId,
    effectiveGroupName,
    isPageTimeline,
    material,
    paceScale,
    posterRepo,
    callbacks,
    guard,
  } = input;
  callbacks.status(`等待视频/媒体就绪并发布 · ${effectiveGroupName}`);
  let createdPostId: string | null = null;
  let pendingApproval = false;
  let composerClosed = false;
  const network = createPosterNetworkObserver({
    profileId,
    groupId: effectiveGroupId,
    initialPage: input.getPage(),
  });
  const ensureResponseListener = () => network.ensurePage(input.getPage());
  const waitKey = `poster-media-${profileId}-${effectiveGroupId}`;
  const throwIfNetRestricted = (s = network.getState()) => {
    if (s.restricted)
      throw new PosterAccountRestrictedError(
        stripAnsi(s.primaryError?.message ?? '受限 · 需要手机验证或操作受限'),
      );
  };
  const diag = (
    level: 'INFO' | 'WARN',
    event: string,
    extra: { operationId?: string; reason?: string; data?: Record<string, unknown> },
  ) => devDiag.record({ level, category: 'post-step', event, profileId, ...extra });
  try {
    await input.execOp('等待媒体上传就绪', async () => {
      const readyDeadline = Date.now() + Math.max(500, Math.round(180_000 * paceScale));
      let nextClicks = 0;
      let lastNextClickAt = 0;
      while (Date.now() < readyDeadline) {
        guard();
        throwIfNetRestricted();
        const livePage = ensureResponseListener();
        const scan = await scanComposerActionButton(livePage);
        if (scan === true || (typeof scan === 'object' && scan !== null && scan.kind === 'post'))
          return true;
        if (
          typeof scan === 'object' &&
          scan !== null &&
          scan.kind === 'next' &&
          nextClicks < 3 &&
          Date.now() - lastNextClickAt >= scaledMs(600, paceScale)
        ) {
          nextClicks += 1;
          lastNextClickAt = Date.now();
          diag('INFO', 'POSTER_COMPOSER_NEXT_STEP', {
            data: { groupId: effectiveGroupId, step: nextClicks, label: scan.label ?? 'Next' },
          });
          await livePage
            .locator('[data-wb-poster-next="1"]')
            .first()
            .click({ timeout: 4000 })
            .catch(() => {});
          await wait(scaledMs(450 + nextClicks * 200, paceScale));
          continue;
        }
        devDiag.recordWait(waitKey, {
          level: 'INFO',
          category: 'post-step',
          event: 'POSTER_WAIT_MEDIA_OR_SUBMIT',
          profileId,
          reason:
            typeof scan === 'object' && scan !== null
              ? `composer button state=${scan.kind}`
              : 'waiting for submit button',
          data: { groupId: effectiveGroupId, mediaKind: material.mediaKind },
        });
        await wait(Math.max(50, Math.round(500 * paceScale)));
      }
      throw Error('发帖发布按钮长时间处于禁用状态（可能上传超时）');
    });
    devDiag.clearWait(waitKey);
    const activePageBeforeSubmit = ensureResponseListener();
    const activeConn = input.getConn();
    await input.assertIdentity();
    const submitCtx = await activeConn.context(accountId);
    if (!submitCtx) throw Error('账号控制上下文已失效');
    const submitOpId = randomUUID();
    const submitBinding: Binding = {
      ...submitCtx,
      operationId: submitOpId,
      jobId: input.jobId,
      stepId: input.stepId,
      actionDigest: posterDigest({
        purpose: 'group-poster',
        actionKind: 'submit_post',
        label: '点击发布按钮',
        groupId: effectiveGroupId,
        materialId: material.id,
        accountId,
      }),
    };
    await posterRepo?.prepareOperation({
      binding: submitBinding,
      runId: callbacks.runId,
      actionKind: 'submit_post',
      groupId: effectiveGroupId,
      groupName: effectiveGroupName,
      materialId: material.id,
    });
    const preSubmitSurface = await readGroupBumper(activePageBeforeSubmit, {
      groupId: isPageTimeline ? '-' : effectiveGroupId,
      pageId: accountId,
    }).catch(() => null);
    const preSubmitPostIds = new Set(
      (preSubmitSurface?.posts ?? [])
        .map((p) => p.postId)
        .filter((id): id is string => Boolean(id)),
    );
    const preSubmitNotices = await readPosterApprovalNotices(activePageBeforeSubmit);
    type SubmitAttempt = { ok: true } | { ok: false; error: unknown };
    let submitExec: Awaited<ReturnType<typeof activeConn.execute<SubmitAttempt>>> | null = null;
    let submitExecuteError: unknown = null;
    try {
      submitExec = await activeConn.execute<SubmitAttempt>(
        submitBinding,
        async () => {
          try {
            network.markSubmitTriggered();
            const submitLoc = ensureResponseListener()
              .locator('[data-wb-poster-submit="1"]')
              .first();
            const pressBefore = activeConn.submissionCalls?.mousePress;
            for (let attempt = 0; attempt < 2; attempt++) {
              await submitLoc
                .evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }))
                .catch(() => {});
              if (attempt > 0) await wait(150);
              try {
                await submitLoc.click({ timeout: 5000 });
                break;
              } catch (clickErr) {
                const msg = clickErr instanceof Error ? clickErr.message : String(clickErr ?? '');
                if (
                  attempt > 0 ||
                  pressBefore !== activeConn.submissionCalls?.mousePress ||
                  !/timeout|intercept|outside.*viewport|obscures|not visible/i.test(msg)
                )
                  throw clickErr;
              }
            }
            const publishDeadline = Date.now() + Math.max(500, Math.round(45_000 * paceScale));
            while (Date.now() < publishDeadline) {
              guard();
              await network.flush();
              const netState = network.getState();
              throwIfNetRestricted(netState);
              if (netState.createdPostId) {
                createdPostId = netState.createdPostId;
                break;
              }
              const checkPage = ensureResponseListener();
              const stateNow = await probeComposerState(checkPage);
              if (stateNow.restrictedDialog)
                throw new PosterAccountRestrictedError('受限 · 需要手机验证或操作受限');
              if (!stateNow.hasComposer) {
                composerClosed = true;
                const checkApproval = async () =>
                  resolvePosterPendingApprovalState({
                    hasComposer: false,
                    graphqlPendingApproval: network.getState().pendingApproval,
                    preSubmitNotices,
                    currentNotices: await readPosterApprovalNotices(checkPage),
                  });
                if (await checkApproval()) pendingApproval = true;
                else {
                  const waits =
                    material.mediaKind === 'video'
                      ? [400, 700, 1000, 1400, 2000, 2500]
                      : [400, 700, 1000, 1400];
                  for (const stepWait of waits) {
                    guard();
                    await wait(scaledMs(stepWait, paceScale));
                    await network.flush();
                    const net = network.getState();
                    throwIfNetRestricted(net);
                    if (net.createdPostId) createdPostId = net.createdPostId;
                    else if (net.pendingApproval || (await checkApproval())) pendingApproval = true;
                    else if (net.primaryError?.kind !== 'hard_error') continue;
                    break;
                  }
                }
                break;
              }
              await wait(Math.max(50, Math.round(400 * paceScale)));
            }
            return { ok: true };
          } catch (error) {
            return { ok: false, error };
          }
        },
        input.assertIdentity,
        input.stopProfile,
      );
    } catch (execErr) {
      submitExecuteError = execErr;
    }
    await network.flush();
    const settledNet = network.getState();
    if (!createdPostId && settledNet.createdPostId) createdPostId = settledNet.createdPostId;
    if (!createdPostId && !pendingApproval && !settledNet.restricted && composerClosed) {
      if (settledNet.pendingApproval) pendingApproval = true;
      else
        ({ createdPostId, pendingApproval } = await pollDomReadbackForPost(
          input,
          preSubmitPostIds,
          preSubmitNotices,
          network,
          ensureResponseListener,
        ));
    }
    const finalNet = network.getState();
    const markReview = async (reason: string) => {
      input.markedPendingReviewRef.value = true;
      await posterRepo?.markOperationReview(submitOpId, reason);
    };
    const stopAndRecover = async (requireCurrentPeer: boolean) => {
      await input.stopProfile();
      if (
        posterRepo &&
        (!requireCurrentPeer || input.core?.peers.get(profileId) === input.peer) &&
        input.peer.online &&
        input.peer.synced
      )
        await recoverPosterOperations(input.kernel, input.peer, posterRepo, () => {}).catch(
          () => {},
        );
    };
    if (finalNet.restricted) {
      const reason = stripAnsi(finalNet.primaryError?.message ?? '发布受限，结果待核对');
      await markReview(reason);
      diag('WARN', 'POSTER_PUBLISH_RESTRICTED', {
        operationId: submitOpId,
        reason,
        data: { groupId: effectiveGroupId, code: finalNet.primaryError?.code ?? 0 },
      });
      await stopAndRecover(false);
      throw new PosterAccountRestrictedError(
        finalNet.primaryError?.message
          ? `受限 · ${reason.slice(0, 64)}`
          : '受限 · 需要手机验证或操作受限',
      );
    }
    if (
      submitExecuteError !== null ||
      !submitExec ||
      !submitExec.value.ok ||
      (!createdPostId && !pendingApproval)
    ) {
      const rawErr =
        submitExecuteError ?? (submitExec && !submitExec.value.ok ? submitExec.value.error : null);
      const cleanErrMsg = stripAnsi(
        rawErr instanceof Error ? rawErr.message : rawErr ? String(rawErr) : '',
      );
      const gqlErrSummary = finalNet.primaryError
        ? `${finalNet.primaryError.code ? `[${finalNet.primaryError.code}] ` : ''}${finalNet.primaryError.message}`
        : '';
      const diagReason = cleanErrMsg || gqlErrSummary || '发布结果未确认';
      await markReview(
        diagReason ? `发布中断待核对: ${diagReason.slice(0, 64)}` : '发布结果未确认',
      );
      diag('WARN', 'POSTER_PUBLISH_UNCONFIRMED', {
        operationId: submitOpId,
        reason: diagReason,
        data: {
          groupId: effectiveGroupId,
          composerClosed,
          graphqlErrorCode: finalNet.primaryError?.code ?? 0,
          graphqlErrorCount: finalNet.errors.length,
        },
      });
      if (
        rawErr instanceof PosterAccountRestrictedError ||
        /受限|验证|checkpoint|logged_out|登录身份已变化|已手动停止|浏览器连接已断开/i.test(
          cleanErrMsg,
        ) ||
        callbacks.cancelled() ||
        !input.peer.online ||
        !input.peer.synced
      ) {
        await stopAndRecover(true);
        throw rawErr ?? Error('贴文发布结果未确认，已记入待核对');
      }
      await input.reconnectAfterUncertainOp();
      throw Error(
        rawErr
          ? cleanErrMsg || '贴文发布结果未确认，已记入待核对'
          : gqlErrSummary
            ? `贴文发布未确认 (${gqlErrSummary.slice(0, 64)})`
            : '贴文发布结果未确认，已记入待核对',
      );
    }
    const finalPostId = createdPostId ?? 'pending_approval';
    const postUrl = createdPostId
      ? `https://www.facebook.com/${isPageTimeline ? encodeURIComponent(accountId) : `groups/${encodeURIComponent(effectiveGroupId)}`}/posts/${encodeURIComponent(createdPostId)}/`
      : '';
    const source = pendingApproval
      ? finalNet.pendingApproval
        ? 'graphql'
        : 'dom_notice'
      : finalNet.createdPostId
        ? 'graphql'
        : 'dom_readback';
    diag('INFO', pendingApproval ? 'POSTER_PUBLISH_PENDING_APPROVAL' : 'POSTER_PUBLISH_CONFIRMED', {
      operationId: submitOpId,
      data: { groupId: effectiveGroupId, postId: finalPostId, source },
    });
    const logEntry: PosterLog = {
      id: randomUUID(),
      profileId,
      accountId,
      accountName: input.accountName,
      accountAvatar: input.identityMeta.accountAvatar,
      identityType: input.identityMeta.identityType,
      groupId: effectiveGroupId,
      groupName: effectiveGroupName,
      groupAvatar:
        input.resolvedGroupAvatar ??
        (isLocalAvatar(input.groupAvatarUrl)
          ? input.groupAvatarUrl
          : (input.surface.avatarUrl ?? input.groupAvatarUrl)),
      materialId: material.id,
      captionPreview: formatPosterCaptionPreview(
        material.caption,
        material.mediaSource,
        material.mediaKind,
      ),
      postId: finalPostId,
      postUrl,
      postedAt: Date.now(),
    };
    const verifiedResolution = {
      id: randomUUID(),
      outcome: 'VERIFIED' as const,
      evidenceDigest: posterDigest({
        binding: submitBinding,
        postId: finalPostId,
        groupId: effectiveGroupId,
      }),
    };
    await posterRepo?.confirmPostSubmission(submitOpId, logEntry, verifiedResolution);
    await activeConn.reconcile(submitBinding, verifiedResolution);
    await posterRepo?.markOperationKernelSettled(submitOpId);
    await callbacks.onTaskPosted(logEntry);
  } finally {
    devDiag.clearWait(waitKey);
    network.dispose();
  }
}
