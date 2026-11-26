import { randomUUID } from 'node:crypto';
import type { Page, Response } from 'playwright-core';
import {
  PosterAccountRestrictedError,
  type GroupPosterBrowserCallbacks,
} from '../../application/group-poster-service.js';
import type { Core, Peer } from '../../bridge/core.js';
import type { CompatibleRepository } from '../../domain/persistence.js';
import { isLocalAvatar } from '../../shared/group-bumper.js';
import {
  formatPosterCaptionPreview,
  type PosterLog,
  type PosterMaterial,
  type PosterOperationResolution,
} from '../../shared/group-poster.js';
import type { Binding } from '../../shared/task-execution.js';
import { readGroupBumper } from '../group-bumper-effects.js';
import type { SqliteGroupPosterRepository } from '../group-poster-store.js';
import type { KernelBridge } from '../kernel-bridge.js';
import {
  extractCreatedGroupPostIdFromGraphQL,
  posterDigest,
  recoverPosterOperations,
  resolvePosterPendingApprovalState,
  type PosterConnection,
  type PosterExecOp,
  type PosterIdentityMeta,
} from './poster-support.js';
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const readApprovalNotices = (page: Page): Promise<string[]> =>
  page
    .evaluate(() => {
      const rx =
        /待管理员审核|等待管理员审核|管理員審核|Pending approval|post is pending|submitted for approval|admin approval|管理员批准|管理員批准|等待審核/i;
      const alertTexts = Array.from(
        document.querySelectorAll<HTMLElement>('[role="alert"], [role="status"], [aria-live]'),
      )
        .map((el) => (el.innerText || el.textContent || '').trim())
        .filter((t) => t.length > 0 && rx.test(t));
      const bodyLines = (document.body?.innerText?.slice(0, 4000) ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && rx.test(s));
      return [...new Set([...alertTexts, ...bodyLines])];
    })
    .catch(() => [] as string[]);
export async function waitMediaAndSubmitPost(input: {
  profileId: string;
  page: Page;
  conn: PosterConnection;
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
    page,
    conn,
    peer,
    kernel,
    core,
    accountId,
    accountName,
    jobId,
    stepId,
    effectiveGroupId,
    effectiveGroupName,
    isPageTimeline,
    groupAvatarUrl,
    resolvedGroupAvatar,
    surface,
    material,
    identityMeta,
    paceScale,
    posterRepo,
    callbacks,
    markedPendingReviewRef,
    guard,
    assertIdentity,
    execOp,
    stopProfile,
    reconnectAfterUncertainOp,
  } = input;
  callbacks.status(`等待视频/媒体就绪并发布 · ${effectiveGroupName}`);
  let createdPostId: string | null = null;
  let graphqlRestricted = false;
  let graphqlPendingApproval = false;
  let pendingApproval = false;
  let composerClosed = false;
  const pendingGraphql: Promise<void>[] = [];
  const onResponse = (res: Response) => {
    if (!res.url().includes('/api/graphql')) return;
    pendingGraphql.push(
      res
        .text()
        .then((body) => {
          if (
            !body.includes('story_create') &&
            !body.includes('ComposerStoryCreate') &&
            !body.includes('legacy_story_hideable_id')
          )
            return;
          const parsed = extractCreatedGroupPostIdFromGraphQL(body);
          if (parsed.restricted) graphqlRestricted = true;
          if (parsed.postId) createdPostId = parsed.postId;
          else if (parsed.pendingApproval) graphqlPendingApproval = true;
        })
        .catch(() => {}),
    );
  };
  page.on('response', onResponse);
  try {
    await execOp('等待媒体上传就绪', async () => {
      const readyDeadline = Date.now() + Math.max(500, Math.round(180_000 * paceScale));
      let submitReady = false;
      while (Date.now() < readyDeadline) {
        guard();
        if (graphqlRestricted)
          throw new PosterAccountRestrictedError('受限 · 需要手机验证或操作受限');
        submitReady = await page.evaluate(() => {
          document
            .querySelectorAll('[data-wb-poster-submit]')
            .forEach((e) => e.removeAttribute('data-wb-poster-submit'));
          const topDialog =
            document.querySelector<HTMLElement>('[data-wb-poster-dialog="1"]') ??
            Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find((d) =>
              Boolean(d.querySelector('[data-wb-poster-editor="1"]')),
            ) ??
            Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
              .filter((d) => d.getBoundingClientRect().width > 200)
              .at(-1);
          if (!topDialog) return false;
          const postRx =
            /^(?:Post|Submit|发布|发帖|發佈|發表|貼文|发贴|發貼|提交|ပို့စ်\s*တင်မည်|ပို့စ်\s*တင်ရန်|တင်မည်|တင်ပါ|Đăng)$/i;
          const hit = Array.from(topDialog.querySelectorAll<HTMLElement>('[role="button"], button'))
            .filter((b) => {
              const r = b.getBoundingClientRect();
              if (r.width < 40 || r.height < 24) return false;
              const s = getComputedStyle(b);
              return s.display !== 'none' && s.visibility !== 'hidden';
            })
            .find((b) => {
              const aria = (b.getAttribute('aria-label') ?? '').trim();
              const txt = (b.textContent ?? '').trim();
              return postRx.test(aria) || postRx.test(txt);
            });
          if (
            hit &&
            hit.getAttribute('aria-disabled') !== 'true' &&
            !hit.hasAttribute('disabled')
          ) {
            hit.setAttribute('data-wb-poster-submit', '1');
            return true;
          }
          return false;
        });
        if (submitReady) break;
        await wait(Math.max(50, Math.round(500 * paceScale)));
      }
      if (!submitReady) throw Error('发帖发布按钮长时间处于禁用状态（可能上传超时）');
      return true;
    });
    await assertIdentity();
    const submitCtx = await conn.context(accountId);
    if (!submitCtx) throw Error('账号控制上下文已失效');
    const submitOpId = randomUUID();
    const submitBinding: Binding = {
      ...submitCtx,
      operationId: submitOpId,
      jobId,
      stepId,
      actionDigest: posterDigest({
        purpose: 'group-poster',
        actionKind: 'submit_post',
        label: '点击发布按钮',
        groupId: effectiveGroupId,
        materialId: material.id,
        accountId,
      }),
    };
    if (posterRepo) {
      await posterRepo.prepareOperation({
        binding: submitBinding,
        runId: callbacks.runId,
        actionKind: 'submit_post',
        groupId: effectiveGroupId,
        groupName: effectiveGroupName,
        materialId: material.id,
      });
    }
    const preSubmitSurface = await readGroupBumper(page, {
      groupId: isPageTimeline ? '-' : effectiveGroupId,
      pageId: accountId,
    }).catch(() => null);
    const preSubmitPostIds = new Set(
      (preSubmitSurface?.posts ?? [])
        .map((p) => p.postId)
        .filter((id): id is string => Boolean(id)),
    );
    const preSubmitNotices = await readApprovalNotices(page);
    type SubmitAttempt = { ok: true } | { ok: false; error: unknown };
    let submitExec: Awaited<ReturnType<typeof conn.execute<SubmitAttempt>>> | null = null;
    let submitExecuteError: unknown = null;
    try {
      submitExec = await conn.execute<SubmitAttempt>(
        submitBinding,
        async () => {
          try {
            await page.locator('[data-wb-poster-submit="1"]').first().click({ timeout: 5000 });
            const publishDeadline = Date.now() + Math.max(500, Math.round(45_000 * paceScale));
            while (Date.now() < publishDeadline) {
              guard();
              if (graphqlRestricted)
                throw new PosterAccountRestrictedError('受限 · 需要手机验证或操作受限');
              if (createdPostId) break;
              const stateNow = await page.evaluate(() => {
                const dialogs = Array.from(
                  document.querySelectorAll<HTMLElement>('[role="dialog"]'),
                ).filter((d) => d.getBoundingClientRect().width > 200);
                return {
                  hasComposer: dialogs.some((d) =>
                    Boolean(d.querySelector('[data-wb-poster-editor="1"]')),
                  ),
                  restrictedDialog: dialogs.some((d) =>
                    /Temporarily Blocked|暂时被禁止|限制了某些活动|restrict certain activity|Try Again Later/i.test(
                      d.textContent ?? '',
                    ),
                  ),
                };
              });
              if (stateNow.restrictedDialog)
                throw new PosterAccountRestrictedError('受限 · 需要手机验证或操作受限');
              if (!stateNow.hasComposer) {
                composerClosed = true;
                const checkApproval = async () =>
                  resolvePosterPendingApprovalState({
                    hasComposer: false,
                    graphqlPendingApproval,
                    preSubmitNotices,
                    currentNotices: await readApprovalNotices(page),
                  });
                if (await checkApproval()) {
                  pendingApproval = true;
                  break;
                }
                await wait(Math.max(50, Math.round(700 * paceScale)));
                await Promise.allSettled(pendingGraphql);
                if (graphqlPendingApproval || (!createdPostId && (await checkApproval()))) {
                  pendingApproval = true;
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
        assertIdentity,
        stopProfile,
      );
    } catch (execErr) {
      submitExecuteError = execErr;
    }
    await Promise.allSettled(pendingGraphql);
    if (!createdPostId && !pendingApproval && composerClosed) {
      if (graphqlPendingApproval) {
        pendingApproval = true;
      } else {
        const afterSurface = await readGroupBumper(page, {
          groupId: isPageTimeline ? '-' : effectiveGroupId,
          pageId: accountId,
        }).catch(() => null);
        const ownPost = afterSurface?.posts.find(
          (p) =>
            Boolean(p.postId && /^\d+$/.test(p.postId) && !preSubmitPostIds.has(p.postId)) &&
            (p.authorId === accountId || p.authorAliases.includes(accountId)) &&
            p.ageHours !== null &&
            p.ageHours <= 5 / 60,
        );
        if (ownPost?.postId && /^\d+$/.test(ownPost.postId)) createdPostId = ownPost.postId;
      }
    }
    const stopAndRecover = async (requireCurrentPeer: boolean) => {
      await stopProfile();
      if (
        posterRepo &&
        (!requireCurrentPeer || core?.peers.get(profileId) === peer) &&
        peer.online &&
        peer.synced
      ) {
        await recoverPosterOperations(kernel, peer, posterRepo, () => {}).catch(() => {});
      }
    };
    if (graphqlRestricted) {
      markedPendingReviewRef.value = true;
      if (posterRepo) await posterRepo.markOperationReview(submitOpId, '发布受限，结果待核对');
      await stopAndRecover(false);
      throw new PosterAccountRestrictedError('受限 · 需要手机验证或操作受限');
    }
    if (
      submitExecuteError !== null ||
      !submitExec ||
      !submitExec.value.ok ||
      (!createdPostId && !pendingApproval)
    ) {
      const rawErr =
        submitExecuteError ?? (submitExec && !submitExec.value.ok ? submitExec.value.error : null);
      const errMsg = rawErr instanceof Error ? rawErr.message : rawErr ? String(rawErr) : '';
      markedPendingReviewRef.value = true;
      if (posterRepo) {
        await posterRepo.markOperationReview(
          submitOpId,
          errMsg ? `发布中断待核对: ${errMsg.slice(0, 48)}` : '发布结果未确认',
        );
      }
      const isFatalOrStopped =
        rawErr instanceof PosterAccountRestrictedError ||
        /受限|验证|checkpoint|logged_out|登录身份已变化|已手动停止|浏览器连接已断开/i.test(
          errMsg,
        ) ||
        callbacks.cancelled() ||
        !peer.online ||
        !peer.synced;
      if (isFatalOrStopped) {
        await stopAndRecover(true);
        throw rawErr ?? Error('贴文发布结果未确认，已记入待核对');
      }
      await reconnectAfterUncertainOp();
      if (rawErr) throw rawErr;
      throw Error('贴文发布结果未确认，已记入待核对');
    }
    const finalPostId = createdPostId ?? 'pending_approval';
    const postUrl = createdPostId
      ? isPageTimeline
        ? `https://www.facebook.com/${encodeURIComponent(accountId)}/posts/${encodeURIComponent(createdPostId)}/`
        : `https://www.facebook.com/groups/${encodeURIComponent(effectiveGroupId)}/posts/${encodeURIComponent(createdPostId)}/`
      : '';
    const logEntry: PosterLog = {
      id: randomUUID(),
      profileId,
      accountId,
      accountName,
      accountAvatar: identityMeta.accountAvatar,
      identityType: identityMeta.identityType,
      groupId: effectiveGroupId,
      groupName: effectiveGroupName,
      groupAvatar:
        resolvedGroupAvatar ??
        (isLocalAvatar(groupAvatarUrl) ? groupAvatarUrl : (surface.avatarUrl ?? groupAvatarUrl)),
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
    const verifiedResolution: PosterOperationResolution = {
      id: randomUUID(),
      outcome: 'VERIFIED',
      evidenceDigest: posterDigest({
        binding: submitBinding,
        postId: finalPostId,
        groupId: effectiveGroupId,
      }),
    };
    if (posterRepo)
      await posterRepo.confirmPostSubmission(submitOpId, logEntry, verifiedResolution);
    await conn.reconcile(submitBinding, {
      id: verifiedResolution.id,
      outcome: 'VERIFIED',
      evidenceDigest: verifiedResolution.evidenceDigest,
    });
    if (posterRepo) await posterRepo.markOperationKernelSettled(submitOpId);
    await callbacks.onTaskPosted(logEntry);
  } finally {
    page.off('response', onResponse);
  }
}
