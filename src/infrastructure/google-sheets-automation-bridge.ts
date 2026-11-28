import { createHash, randomUUID } from 'node:crypto';
import type { Core } from '../bridge/core.js';
import type { CompatibleRepository } from '../domain/persistence.js';
import type {
  DirectPostBumpItem,
  DirectPostBumpResult,
  GoogleOAuthPort,
  ScrapedPostMetrics,
  SheetAutomationBridgePort,
} from '../application/google-sheets-ports.js';
import type { BumperSettings, BumperTarget } from '../shared/group-bumper.js';
import type { PosterLog, PosterMaterial } from '../shared/group-poster.js';
import type { Binding } from '../shared/task-execution.js';
import {
  extractFacebookPostIdFromUrl,
  extractGroupIdFromPostUrl,
  isDirectFacebookPostUrl,
  PAGE_TIMELINE_SYNTHETIC_GROUP_ID,
} from '../shared/google-sheets.js';
import { prepareFacebookWorkspace } from './facebook-workspace-preparation.js';
import type { KernelBridge } from './kernel-bridge.js';
import type { SqliteGroupBumperRepository } from './group-bumper-store.js';
import type {
  FilesystemPosterMediaPreparer,
  GroupPosterBrowserAdapter,
} from './group-poster-runner.js';
import { readGroupBumper } from './group-bumper-effects.js';
import {
  dismissFeatureInterventionDialogIfPresent,
  readGroupInvitationState,
} from './group-inviter-effects.js';
import { recoverBumperOperations } from './group-bumper-recovery.js';
import { observeBumperGraphql } from './group-bumper-runner.js';
import { readBumperReactionFromServer } from './bumper-reaction-read.js';
import {
  normalizeFacebookUrlForWwwFetch,
  parseFacebookMetricsFromHtml,
  scrapeAuthenticatedPostMetricsInPage,
  scrapePublicPostMetricsAnon,
} from './google-sheets-html-metrics.js';
export { normalizeFacebookUrlForWwwFetch, parseFacebookMetricsFromHtml };
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
type BumperConn = Awaited<ReturnType<KernelBridge['connectFacebook']>>;
const skippedBumpResult = (
  item: DirectPostBumpItem,
  skippedReason: string,
): DirectPostBumpResult => ({
  postCode: item.postCode,
  postUrl: item.postUrl,
  bumped: false,
  liked: false,
  commented: false,
  skippedReason,
});
async function closeBumperConnection(target: BumperConn): Promise<void> {
  const stopId = target.stopRequestId ?? randomUUID();
  try {
    await target.close(stopId);
  } catch {
    await target.stopOnCloseFailure().catch(() => {});
    const retryId = target.stopRequestId ?? stopId;
    await target.retryClose(retryId).catch(() => {});
  }
}
export class GoogleSheetsAutomationBridge implements SheetAutomationBridgePort {
  constructor(
    private readonly core: Core,
    private readonly getKernel: () => KernelBridge | null,
    private readonly posterBrowser: GroupPosterBrowserAdapter,
    private readonly mediaPreparer: FilesystemPosterMediaPreparer,
    private readonly bumperRepo: CompatibleRepository<SqliteGroupBumperRepository>,
    private readonly oauth?: GoogleOAuthPort | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async prepareMaterialMedia(mediaSource: string): Promise<{
    localFilePath: string;
    mediaKind: 'image' | 'video';
    thumbnailDataUrl: string | null;
    isTemporaryCache?: boolean | undefined;
  }> {
    const oauth = this.oauth;
    const prepared = await this.mediaPreparer.prepareWithOAuthFallback(
      mediaSource,
      oauth ? () => oauth.getValidAccessToken() : undefined,
    );
    return {
      localFilePath: prepared.localFilePath,
      mediaKind: prepared.mediaKind === 'video' ? 'video' : 'image',
      thumbnailDataUrl: prepared.thumbnailDataUrl ?? null,
      isTemporaryCache: prepared.isTemporaryCache,
    };
  }
  async cleanupPreparedMedia(localFilePath: string): Promise<void> {
    await this.mediaPreparer.removeCachedDriveFile(localFilePath).catch(() => {});
  }
  async scrapePublicPostMetrics(input: {
    posts: Array<{ postCode: string; postUrl: string }>;
    signal?: AbortSignal | undefined;
  }): Promise<ScrapedPostMetrics[]> {
    return scrapePublicPostMetricsAnon({
      posts: input.posts,
      fetchImpl: this.fetchImpl,
      signal: input.signal,
    });
  }
  async switchProfilePageIdentity(input: {
    profileId: string;
    targetPageId: string;
    targetPageName?: string;
  }): Promise<boolean> {
    const { kernel, peer } = this.requireOnlinePeer(input.profileId, '切换专页浏览器离线或未就绪');
    const guard = () => {
      if (this.core.peers.get(input.profileId) !== peer || !peer.online || !peer.synced)
        throw new Error('浏览器连接已断开');
    };
    const normId = input.targetPageId.trim().toLowerCase();
    const normName = (input.targetPageName ?? '').trim().toLowerCase();
    const idle = await kernel.inspectIdleFacebookPage(peer, guard, false, true).catch(() => null);
    if (idle?.actor.accountId.trim().toLowerCase() === normId) return true;
    const { reading: switched } = await kernel.readFacebookMetadataPage(
      peer,
      guard,
      async (page) => {
        await page
          .goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 25_000 })
          .catch(() => null);
        await wait(1200);
        guard();
        const menuOpened = await page
          .evaluate(() => {
            const btn = Array.from(
              document.querySelectorAll<HTMLElement>('[role="banner"] [role="button"][aria-label]'),
            ).find((el) =>
              /个人主页|你的主页|帳號|账号|account|your profile/i.test(
                el.getAttribute('aria-label') ?? '',
              ),
            );
            if (!btn) return false;
            btn.click();
            return true;
          })
          .catch(() => false);
        if (!menuOpened) return false;
        await wait(1000);
        const clicked = await page
          .evaluate(
            ({ idLower, nameLower }: { idLower: string; nameLower: string }) => {
              const items = Array.from(
                document.querySelectorAll<HTMLElement>(
                  '[role="dialog"] [role="button"], [role="menu"] [role="menuitem"], [role="dialog"] a[href]',
                ),
              );
              const hit = items.find((el) => {
                const href = (el.getAttribute('href') ?? '').toLowerCase();
                const txt = `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`
                  .replace(/\s+/g, ' ')
                  .trim()
                  .toLowerCase();
                return (
                  (idLower && href.includes(idLower)) || (nameLower && txt.includes(nameLower))
                );
              });
              if (!hit) return false;
              hit.click();
              return true;
            },
            { idLower: normId, nameLower: normName },
          )
          .catch(() => false);
        if (clicked) {
          await wait(2500);
          await kernel.observeExternalPageAccount?.(input.profileId, page, null)?.catch(() => {});
        }
        return clicked;
      },
      undefined,
      30_000,
      { initialUrl: 'https://www.facebook.com/', forceNewTemporaryTab: true },
    );
    return Boolean(switched);
  }
  async publishScheduledMaterial(input: {
    profileId: string;
    material: PosterMaterial;
    targets: BumperTarget[];
    onPosted: (log: PosterLog, isTimeline: boolean) => Promise<void>;
    onStatus: (text: string) => void;
    cancelled: () => boolean;
  }): Promise<{ postedCount: number; timelinePosted: boolean; error?: string | undefined }> {
    const queue = [...input.targets];
    let postedCount = 0;
    let timelinePosted = false;
    let currentIsTimeline = false;
    const targetErrors: string[] = [];
    const files = input.material.localFilePath ? [input.material.localFilePath] : [];
    try {
      await this.posterBrowser.runProfileWorker(
        input.profileId,
        files,
        {
          maxConcurrentProfiles: 1,
          maxPostsPerAccount: Math.max(queue.length + 2, 20),
          materialsPerGroup: 1,
        },
        {
          runId: randomUUID(),
          cancelled: input.cancelled,
          status: input.onStatus,
          claimNextTask: async () => {
            const next = queue.shift();
            if (!next) return null;
            currentIsTimeline = next.id === PAGE_TIMELINE_SYNTHETIC_GROUP_ID;
            return { group: next, material: input.material };
          },
          returnTaskOnRestriction: () => {},
          onTargetError: (_groupId, reason) => {
            if (reason.trim()) targetErrors.push(reason.trim());
          },
          onTaskPosted: async (log) => {
            if (currentIsTimeline) timelinePosted = true;
            else postedCount++;
            await input.onPosted(log, currentIsTimeline);
          },
          canContinueAccount: async () => queue.length > 0 && !input.cancelled(),
        },
      );
      return {
        postedCount,
        timelinePosted,
        ...(targetErrors.length > 0 ? { error: targetErrors[0] } : {}),
      };
    } catch (err) {
      return {
        postedCount,
        timelinePosted,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  private async settleBumperOperation(
    activeConn: BumperConn,
    binding: Binding,
    applied: boolean,
    makeEvidence: (outcome: 'VERIFIED' | 'NOT_APPLIED' | 'ENDED_UNKNOWN') => unknown,
  ): Promise<void> {
    const outcome: 'VERIFIED' | 'NOT_APPLIED' | 'ENDED_UNKNOWN' = applied
      ? 'VERIFIED'
      : (activeConn.nativeMutationCalls[binding.operationId] ?? 0) === 0
        ? 'NOT_APPLIED'
        : 'ENDED_UNKNOWN';
    const resolution = await Promise.resolve(
      this.bumperRepo.setOperationResolution(binding.operationId, {
        id: randomUUID(),
        outcome,
        evidenceDigest: digest(makeEvidence(outcome)),
      }),
    ).catch(() => null);
    if (resolution && resolution.outcome !== 'ENDED_UNKNOWN') {
      await activeConn
        .reconcile(binding, { ...resolution, outcome: resolution.outcome })
        .then(() => this.bumperRepo.markOperationSettled(binding.operationId))
        .catch(() => {});
    }
  }
  private requireOnlinePeer(profileId: string, offlineMsg: string) {
    const kernel = this.getKernel();
    const peer = this.core.peers.get(profileId);
    if (!kernel || !peer || !peer.online || !peer.synced) throw new Error(offlineMsg);
    return { kernel, peer };
  }
  async bumpDirectPosts(input: {
    profileId: string;
    posts: DirectPostBumpItem[];
    settings: BumperSettings;
    commentPool: string[];
    onPostBumped: (result: DirectPostBumpResult) => Promise<void>;
    onCommentConsumed?: ((comment: string) => Promise<void>) | undefined;
    onStatus: (text: string) => void;
    cancelled: () => boolean;
  }): Promise<DirectPostBumpResult[]> {
    const { kernel, peer } = this.requireOnlinePeer(input.profileId, '顶贴浏览器离线或内核未就绪');
    const guard = () => {
      if (input.cancelled()) throw new Error('顶贴任务已停止');
      if (this.core.peers.get(input.profileId) !== peer || !peer.online || !peer.synced)
        throw new Error('浏览器连接已断开');
    };
    const runId = randomUUID();
    const jobId = randomUUID();
    const stepId = randomUUID();
    const results: DirectPostBumpResult[] = [];
    let conn: BumperConn | null = null;
    try {
      await recoverBumperOperations(kernel, peer, this.bumperRepo, guard);
      const prepared = await prepareFacebookWorkspace(
        kernel,
        peer,
        undefined,
        guard,
        undefined,
        true,
      );
      const identity =
        (await kernel.inspectIdleFacebookPage(peer, guard, false, true)) ??
        (await kernel.inspectFacebookIdentity(
          peer,
          guard,
          true,
          prepared.proof,
          true,
          false,
          false,
        ));
      const accountId = identity.actor.accountId;
      conn = await kernel.connectFacebook(peer, accountId, guard, identity.proof, false);
      const activeConn = conn;
      const page = activeConn.browser.contexts()[0]?.pages()[0];
      if (!page) throw new Error('任务页面不存在');
      const assertIdentity = async () => {
        const deadline = Date.now() + 12_000;
        for (;;) {
          guard();
          let st = await readGroupInvitationState(page, guard);
          if (st.verificationRequired) {
            await dismissFeatureInterventionDialogIfPresent(page, guard);
            st = await readGroupInvitationState(page, guard);
          }
          if (st.verificationRequired) throw new Error('受限 · 需要手机验证或操作受限');
          if (st.accountId !== null && st.accountId !== accountId)
            throw new Error('登录账号已变化，已停止顶贴');
          if (st.ready && st.accountId === accountId) return;
          if (Date.now() >= deadline) throw new Error('页面未就绪');
          await wait(250);
        }
      };
      const makeBinding = async (
        purpose: string,
        actionDigestData: Record<string, unknown>,
      ): Promise<Binding> => {
        const ctx = await activeConn.context(accountId);
        if (!ctx) throw new Error('账号控制上下文已失效');
        return {
          ...ctx,
          operationId: randomUUID(),
          jobId,
          stepId,
          actionDigest: digest({ purpose, accountId, ...actionDigestData }),
        };
      };
      const execSetup = async <T>(
        label: string,
        actionKind: 'setup_navigate' | 'setup_expand_comment' | 'setup_fill_comment',
        work: () => Promise<T>,
      ): Promise<T> => {
        await assertIdentity();
        const binding = await makeBinding('group-bumper', { label });
        await this.bumperRepo.prepareOperation({
          binding,
          runId,
          actionKind,
          groupId: '',
          groupName: '',
        });
        let succeeded = false;
        try {
          const res = await activeConn.execute<T>(binding, work, assertIdentity, () =>
            closeBumperConnection(activeConn),
          );
          succeeded = true;
          return res.value;
        } finally {
          await this.settleBumperOperation(activeConn, binding, succeeded, (settledOutcome) => ({
            binding,
            label,
            settledOutcome,
          }));
        }
      };
      const executeInteraction = async (opts: {
        kind: 'like' | 'comment';
        actionKind: 'submit_like' | 'submit_comment';
        feedbackId: string;
        effectiveGroupId: string;
        item: DirectPostBumpItem;
        postId: string;
        commentText?: string;
        preAct?: () => Promise<void>;
        run: (native: ReturnType<typeof observeBumperGraphql>) => Promise<boolean>;
      }): Promise<boolean> => {
        if (opts.preAct) await opts.preAct();
        const native = observeBumperGraphql(page, {
          actorId: accountId,
          feedbackId: opts.feedbackId,
          kind: opts.kind,
          ...(opts.commentText !== undefined ? { comment: opts.commentText } : {}),
          profileId: input.profileId,
          postId: opts.postId,
        });
        let opBinding: Binding | null = null;
        let applied = false;
        try {
          opBinding = await makeBinding('sheet-direct-bumper', {
            kind: opts.kind,
            postId: opts.postId,
          });
          await this.bumperRepo.prepareOperation({
            binding: opBinding,
            runId,
            actionKind: opts.actionKind,
            groupId: opts.effectiveGroupId,
            groupName: opts.item.groupName || opts.effectiveGroupId,
            pageId: opts.item.pageId || null,
            pageName: opts.item.pageName || null,
            postId: opts.postId,
            postUrl: opts.item.postUrl,
            ...(opts.commentText !== undefined ? { commentText: opts.commentText } : {}),
          });
          native.bindOperation(opBinding.operationId);
          await activeConn.execute(
            opBinding,
            async () => {
              applied = await opts.run(native);
              return applied;
            },
            assertIdentity,
            () => closeBumperConnection(activeConn),
          );
          return applied;
        } finally {
          await native.close();
          if (opBinding) {
            const resolved = opBinding;
            await this.settleBumperOperation(activeConn, resolved, applied, (outcome) =>
              opts.kind === 'like'
                ? { binding: resolved, liked: applied, outcome }
                : { binding: resolved, commented: applied, outcome },
            );
          }
        }
      };
      const dailyLimit = Math.max(1, input.settings.dailyMaxLikesPerAccount);
      const todayMap = await Promise.resolve(this.bumperRepo.todayCounts('all')).catch(
        () => ({}) as Record<string, number>,
      );
      let todayUsed = todayMap[input.profileId] ?? 0;
      const availableComments = [...input.commentPool];
      for (const item of input.posts) {
        guard();
        if (todayUsed >= dailyLimit) {
          results.push(skippedBumpResult(item, `今日已达单号顶贴上限 (${dailyLimit})`));
          break;
        }
        if (!isDirectFacebookPostUrl(item.postUrl)) {
          results.push(skippedBumpResult(item, '非单帖直达链接（已跳过防误顶）'));
          continue;
        }
        try {
          input.onStatus(`正在打开贴文 · ${item.postCode}`);
          await execSetup('打开目标贴文', 'setup_navigate', async () => {
            await page.goto(item.postUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            return page.url();
          });
          await wait(2200);
          guard();
          const currentUrl = page.url();
          if (/\/(?:login|checkpoint)(?:\/|\.php|$)/i.test(new URL(currentUrl).pathname))
            throw new Error('受限 · 账号被重定向至登录或验证页');
          const effectiveGroupId =
            item.groupId.trim() || extractGroupIdFromPostUrl(item.postUrl) || '-';
          const expectedPostId =
            item.postId ||
            extractFacebookPostIdFromUrl(item.postUrl) ||
            extractFacebookPostIdFromUrl(currentUrl) ||
            undefined;
          const numericTargetPostId =
            expectedPostId && /^\d+$/.test(expectedPostId) ? expectedPostId : undefined;
          const readOpts = {
            groupId: effectiveGroupId,
            ...(item.pageId ? { pageId: item.pageId } : {}),
            ...(numericTargetPostId ? { targetPostId: numericTargetPostId } : {}),
          };
          let surface = await readGroupBumper(page, readOpts);
          if (surface.restricted && !surface.restrictionReason) {
            await dismissFeatureInterventionDialogIfPresent(page, guard);
            surface = await readGroupBumper(page, readOpts);
          }
          if (surface.restricted)
            throw new Error(`受限 · ${surface.restrictionReason ?? '账号操作受限'}`);
          const currentUrlIsDirectPost = isDirectFacebookPostUrl(currentUrl);
          const resolvedPostId =
            expectedPostId ?? extractFacebookPostIdFromUrl(currentUrl) ?? undefined;
          let post = resolvedPostId
            ? surface.posts.find(
                (p) => p.postId === resolvedPostId || p.postUrl.includes(resolvedPostId),
              )
            : undefined;
          if (!post && currentUrlIsDirectPost && surface.posts.length === 1) {
            const onlyPost = surface.posts[0];
            const numericMismatch =
              Boolean(resolvedPostId && /^\d+$/.test(resolvedPostId)) &&
              Boolean(onlyPost?.postId && /^\d+$/.test(onlyPost.postId)) &&
              onlyPost?.postId !== resolvedPostId;
            if (onlyPost && !numericMismatch) post = onlyPost;
          }
          if (!post) {
            results.push(
              skippedBumpResult(
                item,
                currentUrlIsDirectPost
                  ? '目标贴文未匹配或无权限访问（已跳过防误顶）'
                  : '贴文已失效或跳转至主页流（已跳过防误顶）',
              ),
            );
            continue;
          }
          await wait(2200 + Math.floor(Math.random() * 1800));
          guard();
          const wantLike = !post.liked && Math.random() * 100 < input.settings.likeProbability;
          let pickedCommentIndex = -1;
          let pickedComment: string | null = null;
          if (
            availableComments.length > 0 &&
            Math.random() * 100 < input.settings.commentProbability
          ) {
            pickedCommentIndex = Math.floor(Math.random() * availableComments.length);
            pickedComment = availableComments[pickedCommentIndex] ?? null;
          }
          let liked = false,
            commented = false;
          const waitNativeConfirm = async (
            native: ReturnType<typeof observeBumperGraphql>,
            timeoutMs: number,
            restrictErr: string,
          ) => {
            const until = Date.now() + timeoutMs;
            while (Date.now() < until) {
              guard();
              if (native.restricted()) throw new Error(restrictErr);
              if (native.confirmed()) return true;
              await wait(250);
            }
            return false;
          };
          if (wantLike && post.likeCSS) {
            const likeSelector = post.likeCSS,
              targetPost = post;
            liked = await executeInteraction({
              kind: 'like',
              actionKind: 'submit_like',
              feedbackId: targetPost.feedbackId ?? '',
              effectiveGroupId,
              item,
              postId: targetPost.postId,
              run: async (native) => {
                const loc = page.locator(likeSelector).first();
                await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                await loc.click({ timeout: 4000 });
                let ok = await waitNativeConfirm(native, 8000, '受限 · 账号点赞被限制');
                if (!ok && targetPost.feedbackId) {
                  const fresh = await readBumperReactionFromServer(page, {
                    actorId: accountId,
                    postId: targetPost.postId,
                    feedbackId: targetPost.feedbackId,
                  }).catch(() => ({ state: 'unknown' as const }));
                  if (fresh.state === 'active') ok = true;
                }
                return ok;
              },
            });
          }
          if (pickedComment && (post.commentCSS || post.commentButtonCSS)) {
            if (!post.commentCSS && post.commentButtonCSS) {
              const btnSel = post.commentButtonCSS;
              await execSetup('展开评论', 'setup_expand_comment', async () => {
                await page.locator(btnSel).first().click({ timeout: 4000 });
                await wait(800);
                return true;
              });
            }
            const refreshed = await readGroupBumper(page, {
              groupId: effectiveGroupId,
              ...(item.pageId ? { pageId: item.pageId } : {}),
              targetPostId: post.postId,
            });
            const refreshedPost = refreshed.posts.find((p) => p.postId === post.postId);
            const editorCss = refreshedPost?.commentCSS ?? (refreshedPost ? post.commentCSS : null);
            if (editorCss) {
              const commentValue = pickedComment;
              commented = await executeInteraction({
                kind: 'comment',
                actionKind: 'submit_comment',
                feedbackId: refreshedPost?.feedbackId ?? post.feedbackId ?? '',
                effectiveGroupId,
                item,
                postId: post.postId,
                commentText: commentValue,
                preAct: async () => {
                  await execSetup('填写评论', 'setup_fill_comment', async () => {
                    const loc = page.locator(editorCss).first();
                    await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                    await loc.click({ timeout: 4000 });
                    await page.keyboard.insertText(commentValue);
                    await wait(450);
                    return true;
                  });
                },
                run: async (native) => {
                  await page.locator(editorCss).first().press('Enter', { timeout: 4000 });
                  return waitNativeConfirm(native, 10_000, '受限 · 账号评论被限制');
                },
              });
            }
          }
          if (commented && pickedComment && input.settings.consumeCommentOnUse) {
            if (pickedCommentIndex >= 0) availableComments.splice(pickedCommentIndex, 1);
            await input.onCommentConsumed?.(pickedComment).catch(() => {});
          }
          const bumped = liked || commented;
          const postRes: DirectPostBumpResult = {
            postCode: item.postCode,
            postUrl: item.postUrl,
            bumped,
            liked,
            commented,
            ...(bumped ? {} : { skippedReason: post.liked ? '该号已赞过' : '未确认互动生效' }),
          };
          results.push(postRes);
          if (bumped) {
            todayUsed++;
            await this.bumperRepo.record({
              id: randomUUID(),
              profileId: input.profileId,
              accountId,
              groupId: effectiveGroupId,
              groupName: item.groupName || effectiveGroupId,
              pageId: item.pageId || '-',
              pageName: item.pageName || item.pageId || '-',
              postId: post.postId,
              postUrl: item.postUrl,
              liked,
              commentText: commented ? pickedComment : null,
              bumpedAt: Date.now(),
              sourceMode: effectiveGroupId === '-' ? 'page' : 'group',
            });
            await input.onPostBumped(postRes);
          }
          await wait(2500 + Math.floor(Math.random() * 2000));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/受限|登录账号已变化|已停止|断开|checkpoint|login/i.test(msg)) throw err;
          results.push(skippedBumpResult(item, msg.slice(0, 80)));
        }
      }
      void runId;
      return results;
    } finally {
      if (conn) await closeBumperConnection(conn);
      if (peer.online && peer.synced && peer.phase === 'PAUSED')
        await recoverBumperOperations(kernel, peer, this.bumperRepo, () => {}).catch(() => {});
    }
  }
  async scrapePostMetrics(input: {
    profileId: string;
    posts: Array<{ postCode: string; postUrl: string }>;
    signal?: AbortSignal | undefined;
  }): Promise<ScrapedPostMetrics[]> {
    const { kernel, peer } = this.requireOnlinePeer(
      input.profileId,
      '采集赞/评数的浏览器离线或未就绪',
    );
    const guard = () => {
      if (input.signal?.aborted) throw new Error('采集已中止');
      if (this.core.peers.get(input.profileId) !== peer || !peer.online || !peer.synced)
        throw new Error('采集浏览器连接已断开');
    };
    return scrapeAuthenticatedPostMetricsInPage({ kernel, peer, guard, posts: input.posts });
  }
}
