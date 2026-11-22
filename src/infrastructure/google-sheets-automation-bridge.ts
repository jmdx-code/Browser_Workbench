import { createHash, randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
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

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export function normalizeFacebookUrlForWwwFetch(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'facebook.com' ||
      host === 'm.facebook.com' ||
      host === 'mbasic.facebook.com' ||
      host === 'web.facebook.com' ||
      host === 'touch.facebook.com'
    ) {
      parsed.protocol = 'https:';
      parsed.hostname = 'www.facebook.com';
      return parsed.toString();
    }
    return parsed.toString();
  } catch {
    return rawUrl.trim();
  }
}

function parseFormattedCountToken(raw: string): number | null {
  const cleaned = raw.trim().replace(/,/g, '');
  const m = /^(\d+(?:\.\d+)?)\s*([KkMm万萬])?$/.exec(cleaned);
  if (!m?.[1]) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base) || base < 0) return null;
  const suffix = (m[2] ?? '').toLowerCase();
  const mult =
    suffix === 'k'
      ? 1_000
      : suffix === 'm'
        ? 1_000_000
        : suffix === '万' || suffix === '萬'
          ? 10_000
          : 1;
  return Math.floor(base * mult);
}

export function parseFacebookMetricsFromHtml(html: string): {
  likes: number | null;
  comments: number | null;
  loginOrRestricted: boolean;
} {
  const hasLoginWall =
    /\/login\.php|name="email"[^>]*name="pass"|id="checkpointSubmitButton"|checkpoint_title|You must log in to continue|Log into Facebook/i.test(
      html,
    );
  const extractFirstNumber = (patterns: readonly RegExp[]): number | null => {
    for (const rx of patterns) {
      const m = rx.exec(html);
      if (m?.[1] !== undefined) {
        const n = parseFormattedCountToken(m[1]);
        if (n !== null) return n;
      }
    }
    return null;
  };
  const likes = extractFirstNumber([
    /"reaction_count"\s*:\s*\{\s*"count"\s*:\s*(\d+)/,
    /"unified_reactors"\s*:\s*\{\s*"count"\s*:\s*(\d+)/,
    /"i18n_reaction_count"\s*:\s*"([\d.,]+\s*[KkMm万萬]?)"/,
    /"reactors"\s*:\s*\{\s*"count"\s*:\s*(\d+)/,
  ]);
  const comments = extractFirstNumber([
    /"comment_rendering_instance"[\s\S]{0,160}?"total_count"\s*:\s*(\d+)/,
    /"total_comment_count"\s*:\s*(\d+)/,
    /"comments_count_summary_renderer"[\s\S]{0,300}?"total_count"\s*:\s*(\d+)/,
    /"comments"\s*:\s*\{\s*"total_count"\s*:\s*(\d+)/,
    /"comment_count"\s*:\s*\{\s*"total_count"\s*:\s*(\d+)/,
  ]);
  // If a login/checkpoint wall is present and only stub zeros (0/0) were matched, treat as login-walled
  // so Tier 2 authenticated scraping runs instead of overwriting real counts with false zeros.
  const hasRealCount =
    (likes !== null && (!hasLoginWall || likes > 0)) ||
    (comments !== null && (!hasLoginWall || comments > 0));
  if (hasRealCount) {
    return { likes, comments, loginOrRestricted: false };
  }
  return { likes: null, comments: null, loginOrRestricted: hasLoginWall };
}

const ANON_BROWSER_NAV_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
};

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
    const output: ScrapedPostMetrics[] = [];
    for (let i = 0; i < input.posts.length; i++) {
      if (input.signal?.aborted) break;
      const post = input.posts[i];
      if (!post) continue;
      if (!post.postUrl.trim().startsWith('http')) {
        output.push({
          postCode: post.postCode,
          postUrl: post.postUrl,
          likes: null,
          comments: null,
          error: '贴文链接无效',
        });
        continue;
      }
      const fetchUrl = normalizeFacebookUrlForWwwFetch(post.postUrl);
      const ctrl = new AbortController();
      const onParentAbort = () => ctrl.abort();
      input.signal?.addEventListener('abort', onParentAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      try {
        const res = await this.fetchImpl(fetchUrl, {
          headers: ANON_BROWSER_NAV_HEADERS,
          redirect: 'follow',
          signal: ctrl.signal,
        });
        const redirectedToLogin = /\/(?:login|checkpoint)(?:\/|\.php|$)/i.test(res.url);
        if (!res.ok || redirectedToLogin) {
          await res.body?.cancel().catch(() => {});
          output.push({
            postCode: post.postCode,
            postUrl: post.postUrl,
            likes: null,
            comments: null,
            needsAuthFallback: true,
            error: redirectedToLogin
              ? '私密小组或需登录查看'
              : `公开页请求返回非成功状态 (HTTP ${res.status})`,
          });
          continue;
        }
        const html = await res.text();
        const parsed = parseFacebookMetricsFromHtml(html);
        if (parsed.likes !== null || parsed.comments !== null) {
          output.push({
            postCode: post.postCode,
            postUrl: post.postUrl,
            likes: parsed.likes,
            comments: parsed.comments,
          });
        } else {
          output.push({
            postCode: post.postCode,
            postUrl: post.postUrl,
            likes: null,
            comments: null,
            needsAuthFallback: true,
            error:
              redirectedToLogin || parsed.loginOrRestricted
                ? '私密小组或需登录查看'
                : `公开页未返回赞/评计数 (HTTP ${res.status})`,
          });
        }
      } catch (err) {
        if (input.signal?.aborted) break;
        const msg = err instanceof Error ? err.message : String(err);
        output.push({
          postCode: post.postCode,
          postUrl: post.postUrl,
          likes: null,
          comments: null,
          needsAuthFallback: true,
          error: `无账号抓取失败：${msg.slice(0, 80)}`,
        });
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', onParentAbort);
      }
      if (i + 1 < input.posts.length && !input.signal?.aborted) {
        await wait(800 + Math.floor(Math.random() * 500));
      }
    }
    return output;
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
    const runId = randomUUID();
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
          runId,
          cancelled: input.cancelled,
          status: input.onStatus,
          claimNextTask: async () => {
            const next = queue.shift();
            if (!next) return null;
            currentIsTimeline = next.id === PAGE_TIMELINE_SYNTHETIC_GROUP_ID;
            return { group: next, material: input.material };
          },
          returnTaskOnRestriction: () => {
            // Do not re-queue on restriction; let scheduler record error and stop
          },
          onTargetError: (_groupId, reason) => {
            if (reason.trim()) targetErrors.push(reason.trim());
          },
          onTaskPosted: async (log) => {
            if (currentIsTimeline) {
              timelinePosted = true;
            } else {
              postedCount++;
            }
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
      const message = err instanceof Error ? err.message : String(err);
      return { postedCount, timelinePosted, error: message };
    }
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
    const kernel = this.getKernel();
    const peer = this.core.peers.get(input.profileId);
    if (!kernel || !peer || !peer.online || !peer.synced) {
      throw new Error('顶贴浏览器离线或内核未就绪');
    }

    const guard = () => {
      if (input.cancelled()) throw new Error('顶贴任务已停止');
      if (this.core.peers.get(input.profileId) !== peer || !peer.online || !peer.synced) {
        throw new Error('浏览器连接已断开');
      }
    };

    const runId = randomUUID();
    const jobId = randomUUID();
    const stepId = randomUUID();
    const results: DirectPostBumpResult[] = [];
    let conn: Awaited<ReturnType<KernelBridge['connectFacebook']>> | null = null;
    const closeConn = async (target: Awaited<ReturnType<KernelBridge['connectFacebook']>>) => {
      const stopId = target.stopRequestId ?? randomUUID();
      try {
        await target.close(stopId);
      } catch {
        await target.stopOnCloseFailure().catch(() => {});
        await target.retryClose(stopId).catch(() => {});
      }
    };

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
        guard();
        let st = await readGroupInvitationState(page, guard);
        const deadline = Date.now() + 12_000;
        while (!st.ready || st.accountId === null) {
          if (st.verificationRequired) {
            await dismissFeatureInterventionDialogIfPresent(page, guard);
            st = await readGroupInvitationState(page, guard);
          }
          if (st.verificationRequired) throw new Error('受限 · 需要手机验证或操作受限');
          if (st.accountId !== null && st.accountId !== accountId) {
            throw new Error('登录账号已变化，已停止顶贴');
          }
          if (Date.now() >= deadline) throw new Error('页面未就绪');
          guard();
          await wait(250);
          st = await readGroupInvitationState(page, guard);
        }
        if (st.verificationRequired) throw new Error('受限 · 需要手机验证或操作受限');
        if (st.accountId !== accountId) throw new Error('登录账号已变化，已停止顶贴');
      };

      const execSetup = async <T>(
        label: string,
        actionKind: 'setup_navigate' | 'setup_expand_comment' | 'setup_fill_comment',
        work: () => Promise<T>,
      ): Promise<T> => {
        await assertIdentity();
        const ctx = await activeConn.context(accountId);
        if (!ctx) throw new Error('账号控制上下文已失效');
        const opId = randomUUID();
        const binding: Binding = {
          ...ctx,
          operationId: opId,
          jobId,
          stepId,
          actionDigest: digest({ purpose: 'group-bumper', label, accountId }),
        };
        await this.bumperRepo.prepareOperation({
          binding,
          runId,
          actionKind,
          groupId: '',
          groupName: '',
        });
        let succeeded = false;
        try {
          const res = await activeConn.execute<T>(binding, work, assertIdentity, async () => {
            await closeConn(activeConn);
          });
          succeeded = true;
          return res.value;
        } finally {
          const settledOutcome: 'VERIFIED' | 'NOT_APPLIED' | 'ENDED_UNKNOWN' = succeeded
            ? 'VERIFIED'
            : (activeConn.nativeMutationCalls[opId] ?? 0) === 0
              ? 'NOT_APPLIED'
              : 'ENDED_UNKNOWN';
          const resolution = await Promise.resolve(
            this.bumperRepo.setOperationResolution(opId, {
              id: randomUUID(),
              outcome: settledOutcome,
              evidenceDigest: digest({ binding, label, settledOutcome }),
            }),
          ).catch(() => null);
          if (resolution && resolution.outcome !== 'ENDED_UNKNOWN') {
            await activeConn
              .reconcile(binding, { ...resolution, outcome: resolution.outcome })
              .then(() => this.bumperRepo.markOperationSettled(opId))
              .catch(() => {});
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
          results.push({
            postCode: item.postCode,
            postUrl: item.postUrl,
            bumped: false,
            liked: false,
            commented: false,
            skippedReason: `今日已达单号顶贴上限 (${dailyLimit})`,
          });
          break;
        }
        if (!isDirectFacebookPostUrl(item.postUrl)) {
          results.push({
            postCode: item.postCode,
            postUrl: item.postUrl,
            bumped: false,
            liked: false,
            commented: false,
            skippedReason: '非单帖直达链接（已跳过防误顶）',
          });
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
          if (/\/(?:login|checkpoint)(?:\/|\.php|$)/i.test(new URL(currentUrl).pathname)) {
            throw new Error('受限 · 账号被重定向至登录或验证页');
          }

          const effectiveGroupId =
            item.groupId.trim() || extractGroupIdFromPostUrl(item.postUrl) || '-';
          const expectedPostId =
            item.postId ||
            extractFacebookPostIdFromUrl(item.postUrl) ||
            extractFacebookPostIdFromUrl(currentUrl) ||
            undefined;
          let surface = await readGroupBumper(page, {
            groupId: effectiveGroupId,
            ...(item.pageId ? { pageId: item.pageId } : {}),
            ...(expectedPostId ? { targetPostId: expectedPostId } : {}),
          });
          if (surface.restricted && !surface.restrictionReason) {
            await dismissFeatureInterventionDialogIfPresent(page, guard);
            surface = await readGroupBumper(page, {
              groupId: effectiveGroupId,
              ...(item.pageId ? { pageId: item.pageId } : {}),
              ...(expectedPostId ? { targetPostId: expectedPostId } : {}),
            });
          }
          if (surface.restricted) {
            throw new Error(`受限 · ${surface.restrictionReason ?? '账号操作受限'}`);
          }

          // Strict target verification: NEVER fall back to surface.posts[0] on a group/page feed
          // when a post was deleted or redirected!
          const currentUrlIsDirectPost = isDirectFacebookPostUrl(currentUrl);
          const resolvedPostId =
            expectedPostId ?? extractFacebookPostIdFromUrl(currentUrl) ?? undefined;
          let post = resolvedPostId
            ? surface.posts.find((p) => p.postId === resolvedPostId)
            : undefined;
          if (!post && currentUrlIsDirectPost && surface.posts.length === 1) {
            const onlyPost = surface.posts[0];
            const numericMismatch =
              Boolean(resolvedPostId && /^\d+$/.test(resolvedPostId)) &&
              Boolean(onlyPost?.postId && /^\d+$/.test(onlyPost.postId)) &&
              onlyPost?.postId !== resolvedPostId;
            if (onlyPost && !numericMismatch) {
              post = onlyPost;
            }
          }
          if (!post) {
            results.push({
              postCode: item.postCode,
              postUrl: item.postUrl,
              bumped: false,
              liked: false,
              commented: false,
              skippedReason: currentUrlIsDirectPost
                ? '目标贴文未匹配或无权限访问（已跳过防误顶）'
                : '贴文已失效或跳转至主页流（已跳过防误顶）',
            });
            continue;
          }

          // Human-like dwell
          await wait(2200 + Math.floor(Math.random() * 1800));
          guard();

          const wantLike = !post.liked && Math.random() * 100 < input.settings.likeProbability;
          let pickedCommentIndex = -1;
          let pickedComment: string | null = null;
          if (
            availableComments.length > 0 &&
            Math.random() * 100 < input.settings.commentProbability
          ) {
            pickedCommentIndex = input.settings.consumeCommentOnUse
              ? 0
              : Math.floor(Math.random() * availableComments.length);
            pickedComment = availableComments[pickedCommentIndex] ?? null;
          }

          let liked = false;
          let commented = false;

          if (wantLike && post.likeCSS) {
            const likeSelector = post.likeCSS;
            const native = observeBumperGraphql(page, {
              actorId: accountId,
              feedbackId: post.feedbackId ?? '',
              kind: 'like',
              profileId: input.profileId,
              postId: post.postId,
            });
            let likeBinding: Binding | null = null;
            try {
              const ctx = await activeConn.context(accountId);
              if (!ctx) throw new Error('账号控制上下文已失效');
              const likeOpId = randomUUID();
              likeBinding = {
                ...ctx,
                operationId: likeOpId,
                jobId,
                stepId,
                actionDigest: digest({
                  purpose: 'sheet-direct-bumper',
                  kind: 'like',
                  postId: post.postId,
                  accountId,
                }),
              };
              await this.bumperRepo.prepareOperation({
                binding: likeBinding,
                runId,
                actionKind: 'submit_like',
                groupId: effectiveGroupId,
                groupName: item.groupName || effectiveGroupId,
                pageId: item.pageId || null,
                pageName: item.pageName || null,
                postId: post.postId,
                postUrl: item.postUrl,
              });
              native.bindOperation(likeOpId);
              await activeConn.execute(
                likeBinding,
                async () => {
                  await page
                    .locator(likeSelector)
                    .first()
                    .scrollIntoViewIfNeeded({ timeout: 3000 })
                    .catch(() => {});
                  await page.locator(likeSelector).first().click({ timeout: 4000 });
                  const until = Date.now() + 8000;
                  while (Date.now() < until) {
                    guard();
                    if (native.restricted()) throw new Error('受限 · 账号点赞被限制');
                    if (native.confirmed()) {
                      liked = true;
                      break;
                    }
                    await wait(250);
                  }
                  if (!liked && post.feedbackId) {
                    const fresh = await readBumperReactionFromServer(page, {
                      actorId: accountId,
                      postId: post.postId,
                      feedbackId: post.feedbackId,
                    }).catch(() => ({ state: 'unknown' as const }));
                    if (fresh.state === 'active') liked = true;
                  }
                  return liked;
                },
                assertIdentity,
                async () => {
                  await closeConn(activeConn);
                },
              );
            } finally {
              await native.close();
              if (likeBinding) {
                const resolvedLike = likeBinding;
                const outcome: 'VERIFIED' | 'NOT_APPLIED' | 'ENDED_UNKNOWN' = liked
                  ? 'VERIFIED'
                  : (activeConn.nativeMutationCalls[resolvedLike.operationId] ?? 0) === 0
                    ? 'NOT_APPLIED'
                    : 'ENDED_UNKNOWN';
                const resolution = await Promise.resolve(
                  this.bumperRepo.setOperationResolution(resolvedLike.operationId, {
                    id: randomUUID(),
                    outcome,
                    evidenceDigest: digest({ binding: resolvedLike, liked, outcome }),
                  }),
                ).catch(() => null);
                if (resolution && resolution.outcome !== 'ENDED_UNKNOWN') {
                  await activeConn
                    .reconcile(resolvedLike, { ...resolution, outcome: resolution.outcome })
                    .then(() => this.bumperRepo.markOperationSettled(resolvedLike.operationId))
                    .catch(() => {});
                }
              }
            }
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
              const native = observeBumperGraphql(page, {
                actorId: accountId,
                feedbackId: refreshedPost?.feedbackId ?? post.feedbackId ?? '',
                kind: 'comment',
                comment: pickedComment,
                profileId: input.profileId,
                postId: post.postId,
              });
              let commentBinding: Binding | null = null;
              try {
                await execSetup('填写评论', 'setup_fill_comment', async () => {
                  const loc = page.locator(editorCss).first();
                  await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                  await loc.click({ timeout: 4000 });
                  await page.keyboard.insertText(pickedComment);
                  await wait(450);
                  return true;
                });
                const ctx = await activeConn.context(accountId);
                if (!ctx) throw new Error('账号控制上下文已失效');
                const commentOpId = randomUUID();
                commentBinding = {
                  ...ctx,
                  operationId: commentOpId,
                  jobId,
                  stepId,
                  actionDigest: digest({
                    purpose: 'sheet-direct-bumper',
                    kind: 'comment',
                    postId: post.postId,
                    accountId,
                  }),
                };
                await this.bumperRepo.prepareOperation({
                  binding: commentBinding,
                  runId,
                  actionKind: 'submit_comment',
                  groupId: effectiveGroupId,
                  groupName: item.groupName || effectiveGroupId,
                  pageId: item.pageId || null,
                  pageName: item.pageName || null,
                  postId: post.postId,
                  postUrl: item.postUrl,
                  commentText: pickedComment,
                });
                native.bindOperation(commentOpId);
                await activeConn.execute(
                  commentBinding,
                  async () => {
                    await page.locator(editorCss).first().press('Enter', { timeout: 4000 });
                    const until = Date.now() + 10_000;
                    while (Date.now() < until) {
                      guard();
                      if (native.restricted()) throw new Error('受限 · 账号评论被限制');
                      if (native.confirmed()) {
                        commented = true;
                        break;
                      }
                      await wait(250);
                    }
                    return commented;
                  },
                  assertIdentity,
                  async () => {
                    await closeConn(activeConn);
                  },
                );
              } finally {
                await native.close();
                if (commentBinding) {
                  const resolvedComment = commentBinding;
                  const outcome: 'VERIFIED' | 'NOT_APPLIED' | 'ENDED_UNKNOWN' = commented
                    ? 'VERIFIED'
                    : (activeConn.nativeMutationCalls[resolvedComment.operationId] ?? 0) === 0
                      ? 'NOT_APPLIED'
                      : 'ENDED_UNKNOWN';
                  const resolution = await Promise.resolve(
                    this.bumperRepo.setOperationResolution(resolvedComment.operationId, {
                      id: randomUUID(),
                      outcome,
                      evidenceDigest: digest({ binding: resolvedComment, commented, outcome }),
                    }),
                  ).catch(() => null);
                  if (resolution && resolution.outcome !== 'ENDED_UNKNOWN') {
                    await activeConn
                      .reconcile(resolvedComment, {
                        ...resolution,
                        outcome: resolution.outcome,
                      })
                      .then(() => this.bumperRepo.markOperationSettled(resolvedComment.operationId))
                      .catch(() => {});
                  }
                }
              }
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
          if (/受限|登录账号已变化|已停止|断开|checkpoint|login/i.test(msg)) {
            throw err;
          }
          results.push({
            postCode: item.postCode,
            postUrl: item.postUrl,
            bumped: false,
            liked: false,
            commented: false,
            skippedReason: msg.slice(0, 80),
          });
        }
      }
      void runId;
      return results;
    } finally {
      if (conn) {
        await closeConn(conn);
      }
      if (peer.online && peer.synced && peer.phase === 'PAUSED') {
        await recoverBumperOperations(kernel, peer, this.bumperRepo, () => {}).catch(() => {});
      }
    }
  }

  async scrapePostMetrics(input: {
    profileId: string;
    posts: Array<{ postCode: string; postUrl: string }>;
    signal?: AbortSignal | undefined;
  }): Promise<ScrapedPostMetrics[]> {
    const kernel = this.getKernel();
    const peer = this.core.peers.get(input.profileId);
    if (!kernel || !peer || !peer.online || !peer.synced) {
      throw new Error('采集赞/评数的浏览器离线或未就绪');
    }
    const guard = () => {
      if (input.signal?.aborted) throw new Error('采集已中止');
      if (this.core.peers.get(input.profileId) !== peer || !peer.online || !peer.synced) {
        throw new Error('采集浏览器连接已断开');
      }
    };

    const output: ScrapedPostMetrics[] = [];
    await kernel.readFacebookMetadataPage(
      peer,
      guard,
      async (page: Page) => {
        for (const post of input.posts) {
          guard();
          if (!post.postUrl.trim().startsWith('http')) {
            output.push({
              postCode: post.postCode,
              postUrl: post.postUrl,
              likes: null,
              comments: null,
              error: '贴文链接无效',
            });
            continue;
          }
          try {
            // Fast, zero-disruption same-origin authenticated SSR fetch inside Facebook context (per-item 15s timeout)
            const fetchUrl = normalizeFacebookUrlForWwwFetch(post.postUrl);
            let outerTimer: ReturnType<typeof setTimeout> | null = null;
            const fetched = await Promise.race([
              page.evaluate(async (targetUrl: string) => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 14_000);
                try {
                  const res = await fetch(targetUrl, {
                    credentials: 'include',
                    redirect: 'follow',
                    signal: controller.signal,
                  });
                  const text = await res.text();
                  return { ok: res.ok, status: res.status, finalUrl: res.url, html: text };
                } finally {
                  clearTimeout(timer);
                }
              }, fetchUrl),
              new Promise<never>((_, reject) => {
                outerTimer = setTimeout(() => reject(new Error('单条抓取超时 (15s)')), 15_000);
              }),
            ]).finally(() => {
              if (outerTimer) clearTimeout(outerTimer);
            });

            if (/\/(?:login|checkpoint)(?:\/|\.php|$)/i.test(fetched.finalUrl)) {
              throw new Error('ACCOUNT_RESTRICTED: 采集浏览器被重定向至登录/验证页，已熔断停止');
            }
            if (!fetched.ok) {
              output.push({
                postCode: post.postCode,
                postUrl: post.postUrl,
                likes: null,
                comments: null,
                error: `贴文页返回非成功状态 (HTTP ${fetched.status})`,
              });
              continue;
            }
            const parsed = parseFacebookMetricsFromHtml(fetched.html);
            if (parsed.loginOrRestricted) {
              throw new Error('ACCOUNT_RESTRICTED: 采集浏览器账号需登录或受限，已熔断停止');
            }
            output.push({
              postCode: post.postCode,
              postUrl: post.postUrl,
              likes: parsed.likes,
              comments: parsed.comments,
              ...(parsed.likes === null && parsed.comments === null
                ? { error: `未能解析赞/评计数 (HTTP ${fetched.status})` }
                : {}),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.startsWith('ACCOUNT_RESTRICTED') || /断开|中止/.test(msg)) {
              throw err;
            }
            output.push({
              postCode: post.postCode,
              postUrl: post.postUrl,
              likes: null,
              comments: null,
              error: msg.slice(0, 100),
            });
          }
          await wait(500);
        }
      },
      undefined,
      15_000,
      {
        initialUrl: 'https://www.facebook.com/',
        forceNewTemporaryTab: true,
        backgroundMetadataRead: true,
        disableOuterTimeout: true,
      },
    );
    return output;
  }
}
