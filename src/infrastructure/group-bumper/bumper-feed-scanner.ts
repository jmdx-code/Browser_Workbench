import {
  isCompleteNumericId,
  isPlaceholderTargetName,
  type BumperTarget,
} from '../../shared/group-bumper.js';
import { bumperAuthorMatch, type BumperPost, readGroupBumper } from '../group-bumper-effects.js';
import {
  BUMPER_DEBUGGER_CANCELED_MESSAGE,
  BumperFatalError,
  type BumperFeedStepContext,
  type BumperSurface,
  buildBumperTargetUrl,
  canonicalBumperPageIdFromURL,
  isBumperRecoverableDisconnectError,
  type ResumablePostState,
  verifyBumperPageAlias,
  wait,
} from './bumper-core.js';
import { closeBumperShareDialogIfOpen } from './bumper-post-comment-share.js';
import {
  executeBumperPostActions,
  isForeignPagePost,
  navigateViaSearchEntry,
} from './bumper-post-flow.js';
const matchPageOwnerId = (posts: readonly BumperPost[], feed: BumperTarget, accountId: string) =>
  posts.find(
    (p) =>
      /^\d+$/.test(p.authorId ?? '') &&
      p.authorId !== accountId &&
      (bumperAuthorMatch(p, feed) ||
        (!isPlaceholderTargetName(feed.name, feed.id) &&
          p.authorName.trim().toLowerCase() === feed.name.trim().toLowerCase())),
  )?.authorId;
export async function runBumperFeedsForGroup(
  input: BumperFeedStepContext & {
    initialFeed: BumperSurface | undefined;
    initialSurface: BumperSurface | undefined;
  },
): Promise<'continue' | 'quota_reached'> {
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
  } = input;
  const { group, isPageBumperMode, sourceMode, pages } = groupCtx;
  const accountId = session.accountId;
  let initialFeed = input.initialFeed;
  let surface = input.initialSurface;
  const feeds: (BumperTarget | null)[] =
    isPageBumperMode || groupCtx.effectiveSearchMode === 'page_group_feed' ? [...pages] : [null];
  let anyUserFeedPosts = false,
    fallbackRandomAppended = false;
  for (let feedIndex = 0; feedIndex < feeds.length; feedIndex++) {
    const feed = feeds[feedIndex] ?? null;
    let resolvedPageId = feed?.id,
      pageOwnerAuthorId: string | null = null,
      enteredViaDirectOrId = false;
    if (isPageBumperMode && feed) {
      session.setOperationContext({
        groupId: '-',
        groupName: '专页主页',
        pageId: feed.id,
        pageName: feed.name,
      });
      const pageQuota = await repo.eligibility(accountId, profileId, '', Date.now(), sourceMode);
      if (pageQuota.today >= settings.dailyMaxLikesPerAccount) {
        stats.quotaReached = true;
        callbacks.status(
          `今日已达上限 (${pageQuota.today}/${settings.dailyMaxLikesPerAccount})`,
          pageQuota.today,
        );
        break;
      }
      callbacks.status(`正在查找专页 · ${feed.name}`, pageQuota.today);
      const fallbackPageUrl = buildBumperTargetUrl('pages', feed.id);
      if (!isPlaceholderTargetName(feed.name, feed.id)) {
        const nav = await navigateViaSearchEntry({
          session,
          paceScale,
          query: feed.name,
          searchUrl: 'https://www.facebook.com/search/pages/?q=' + encodeURIComponent(feed.name),
          fallbackUrl: fallbackPageUrl,
          readSurface: () =>
            readGroupBumper(session.getPage(), {
              groupId: '-',
              pageId: feed.id,
              pageName: feed.name,
            }),
          missingMsg: '专页搜索入口未找到',
          urlOk: (url) =>
            url.origin === 'https://www.facebook.com' && !/^\/search(?:\/|$)/i.test(url.pathname),
        });
        if (nav.usedFallback || nav.surface?.groupEntryMatchedBy === 'id')
          enteredViaDirectOrId = true;
      } else {
        await session.navigate(fallbackPageUrl);
        enteredViaDirectOrId = true;
      }
      const onWrongPageSurface = () =>
        /^\/(?:search|groups)(?:\/|$)/i.test(new URL(session.getPage().url()).pathname);
      if (onWrongPageSurface()) {
        await session.navigate(fallbackPageUrl);
        enteredViaDirectOrId = true;
      }
      if (onWrongPageSurface()) {
        stats.skippedGroups++;
        stats.lastGroupError = '未能进入专页主页';
        callbacks.status('跳过专页 · 未能进入专页主页 · ' + feed.name);
        continue;
      }
      const readAndConfirmPage = async () => {
        const res = await groupHelpers.waitForFeed(feed.id),
          ok =
            (res.pageIds ?? []).includes(feed.id.toLowerCase()) ||
            res.posts.some((p) => p.authorId === feed.id);
        return { res, ok };
      };
      let { res: pageFeed, ok: pageIdConfirmed } = await readAndConfirmPage();
      if (!enteredViaDirectOrId && !pageIdConfirmed) {
        await session.navigate(fallbackPageUrl);
        enteredViaDirectOrId = true;
        ({ res: pageFeed, ok: pageIdConfirmed } = await readAndConfirmPage());
      }
      const pageAvatar = pageFeed.pageAvatarUrl ?? pageFeed.avatarUrl,
        canonicalPageId = canonicalBumperPageIdFromURL(session.getPage().url());
      if (
        canonicalPageId &&
        (enteredViaDirectOrId || pageIdConfirmed) &&
        (!isCompleteNumericId(feed.id) || canonicalPageId === feed.id)
      ) {
        const resolvedName =
          pageFeed.groupTitle && isPlaceholderTargetName(feed.name, feed.id)
            ? pageFeed.groupTitle
            : feed.name;
        await session.updateMetadata('pages', feed.id, {
          canonicalId: canonicalPageId,
          name: resolvedName,
          avatarUrl: pageAvatar,
        });
        feed.id = canonicalPageId;
        feed.name = resolvedName;
        resolvedPageId = canonicalPageId;
        session.setOperationContext({
          ...session.getOperationContext(),
          pageId: canonicalPageId,
          pageName: resolvedName,
        });
      } else {
        if (pageAvatar) await session.updateAvatar('pages', feed.id, pageAvatar);
        if (pageFeed.groupTitle && isPlaceholderTargetName(feed.name, feed.id)) {
          await session.updateMetadata('pages', feed.id, {
            name: pageFeed.groupTitle,
            avatarUrl: pageAvatar,
          });
          feed.name = pageFeed.groupTitle;
        }
      }
      pageOwnerAuthorId =
        pageFeed.posts.find((p) => p.authorId === feed.id)?.authorId ??
        matchPageOwnerId(pageFeed.posts, feed, accountId) ??
        (/^\d+$/.test(feed.id) ? feed.id : null);
      if (!pageFeed.posts.length) {
        stats.skippedGroups++;
        stats.lastGroupError = pageFeed.loading ? '专页内容加载超时' : '专页暂无可访问帖子';
        callbacks.status('跳过专页 · ' + feed.name);
        continue;
      }
      initialFeed = pageFeed;
      stats.groupsEntered++;
      callbacks.status('正在扫描专页 · ' + feed.name);
    } else if (feed && !/^\d+$/.test(feed.id)) {
      const currentPath = new URL(session.getPage().url()).pathname,
        onGroupMainFeed =
          !/\/user\/|\/search\/?/.test(currentPath) &&
          currentPath.toLowerCase().startsWith('/groups/');
      let match = onGroupMainFeed
        ? (
            await readGroupBumper(session.getPage(), { groupId: groupCtx.effectiveGroupId })
          ).posts.find((p) => bumperAuthorMatch(p, feed) && /^\d+$/.test(p.authorId ?? ''))
        : undefined;
      if (!match) {
        await session.navigate(
          `https://www.facebook.com/groups/${encodeURIComponent(groupCtx.effectiveGroupId)}/search/?q=${encodeURIComponent(feed.name)}`,
        );
        match = (await groupHelpers.waitForFeed()).posts.find(
          (p) => bumperAuthorMatch(p, feed) && /^\d+$/.test(p.authorId ?? ''),
        );
      }
      if (!match?.authorId) {
        callbacks.status('跳过主页 · 未找到数字身份 · ' + feed.name);
        continue;
      }
      resolvedPageId = match.authorId;
    }
    if (!isPageBumperMode && feed) {
      await session.navigate(
        `https://www.facebook.com/groups/${encodeURIComponent(groupCtx.effectiveGroupId)}/user/${encodeURIComponent(resolvedPageId ?? feed.id)}/`,
      );
      const userFeed = await groupHelpers.waitForFeed(resolvedPageId);
      if (userFeed.posts.length > 0) anyUserFeedPosts = true;
      if (userFeed.pageAvatarUrl)
        await session.updateAvatar('pages', feed.id, userFeed.pageAvatarUrl);
      if (
        userFeed.posts.length === 0 &&
        /^\d+$/.test(feed.id) &&
        feed.name.trim() &&
        feed.name.trim() !== feed.id
      ) {
        await session.navigate(
          `https://www.facebook.com/groups/${encodeURIComponent(groupCtx.effectiveGroupId)}/search/?q=${encodeURIComponent(feed.name)}`,
        );
        const searchPosts = (await groupHelpers.waitForFeed()).posts,
          altMatch = searchPosts.find(
            (p) =>
              p.authorName.trim() === feed.name.trim() &&
              p.authorId &&
              /^\d+$/.test(p.authorId) &&
              p.authorId !== resolvedPageId,
          );
        if (altMatch?.authorId) {
          const nativeAlias = await verifyBumperPageAlias(feed.id, altMatch.authorId);
          session.guard();
          if (!nativeAlias) {
            callbacks.status('跳过主页 · 数字身份未能核对 · ' + feed.name);
            continue;
          }
          await session.updateMetadata('pages', feed.id, {
            name: altMatch.authorName || feed.name,
            avatarUrl: altMatch.authorAvatarUrl,
          });
          resolvedPageId = altMatch.authorId;
          await session.navigate(
            `https://www.facebook.com/groups/${encodeURIComponent(groupCtx.effectiveGroupId)}/user/${encodeURIComponent(resolvedPageId)}/`,
          );
          const aliasFeed = await groupHelpers.waitForFeed(resolvedPageId);
          if (aliasFeed.posts.length > 0) anyUserFeedPosts = true;
          if (aliasFeed.pageAvatarUrl)
            await session.updateAvatar('pages', feed.id, aliasFeed.pageAvatarUrl);
        }
      }
    } else if (!isPageBumperMode && !feed && fallbackRandomAppended) {
      if (!/^\/groups\/[^/]+\/?$/i.test(new URL(session.getPage().url()).pathname)) {
        await session.navigate(
          `https://www.facebook.com/groups/${encodeURIComponent(groupCtx.effectiveGroupId)}/`,
        );
        initialFeed = await groupHelpers.waitForFeed();
      }
    }
    await session.paceWait(2500 + Math.floor(Math.random() * 2501));
    session.resetNoProgressRecoveries();
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    let empty = 0;
    let oldPosts = 0;
    let hasRecoveredInFeed = false;
    const resumableRef: { current: ResumablePostState | null } = { current: null };
    const maxScanForTarget = isPageBumperMode
      ? (settings.maxPostsPerPage ?? 3)
      : settings.maxPostsPerGroupPage;
    for (
      let scroll = 0;
      scroll < (feed ? Math.max(3, maxScanForTarget * 2) : Math.max(12, maxScanForTarget * 2)) &&
      empty < 5;
      scroll++
    ) {
      try {
        session.guard();
        await session.assertIdentity();
        const activePage = session.getPage();
        if (scroll === 0 && isPageBumperMode && !hasRecoveredInFeed) {
          const refreshedSurface = await readGroupBumper(activePage, {
            groupId: groupCtx.effectiveGroupId,
            ...(feed ? { pageId: resolvedPageId } : {}),
          }).catch(() => null);
          surface =
            refreshedSurface && refreshedSurface.posts.length > 0 ? refreshedSurface : initialFeed;
        } else {
          surface =
            scroll === 0 && !feed && !hasRecoveredInFeed
              ? initialFeed
              : await readGroupBumper(activePage, {
                  groupId: groupCtx.effectiveGroupId,
                  ...(feed ? { pageId: resolvedPageId } : {}),
                });
        }
        if (!surface) throw Error('页面未就绪');
        if (feed && surface.pageAvatarUrl)
          await session.updateAvatar('pages', feed.id, surface.pageAvatarUrl);
        if (
          isPageBumperMode &&
          feed &&
          (!pageOwnerAuthorId ||
            (pageOwnerAuthorId === feed.id && !surface.posts.some((p) => p.authorId === feed.id)))
        ) {
          const matchedOwner = matchPageOwnerId(surface.posts, feed, accountId);
          if (matchedOwner) pageOwnerAuthorId = matchedOwner;
        }
        if (surface.restricted)
          throw new BumperFatalError(
            '受限 · ' + (surface.restrictionReason ?? '需要手机验证或操作受限'),
          );
        if (
          isPageBumperMode &&
          /^\/(?:search|groups)(?:\/|$)/i.test(new URL(activePage.url()).pathname)
        )
          throw Error('当前页面不是专页主页，未执行顶贴');
        if (
          !isPageBumperMode &&
          !surface.groupIds.includes(groupCtx.effectiveGroupId.toLowerCase())
        )
          throw Error('当前小组已变化');
        let fresh = 0;
        for (const post of surface.posts) {
          const isResumingCurrentPost = resumableRef.current?.postId === post.postId;
          if (!isResumingCurrentPost && seen.has(post.postId)) continue;
          if (!isPageBumperMode && !post.authorId && !post.authorName.trim()) continue;
          const isSelfAccountPost =
            post.authorId &&
            post.authorId === accountId &&
            accountId !== feed?.id &&
            accountId !== resolvedPageId;
          const target =
            isPageBumperMode && feed
              ? isSelfAccountPost || isForeignPagePost(post, feed, pageOwnerAuthorId)
                ? undefined
                : feed
              : (feed ? [feed] : pages).find((p) =>
                  bumperAuthorMatch(
                    post,
                    feed && resolvedPageId ? { ...p, id: resolvedPageId } : p,
                  ),
                );
          const isPostHydrated = Boolean(
            post.likeCSS ||
            post.commentButtonCSS ||
            post.commentCSS ||
            post.authorAliases.length > 0,
          );
          const noteAge = (post: BumperPost) => {
            if (
              groupCtx.effectiveSearchMode === 'time_sort' &&
              !post.pinned &&
              post.ageHours !== null &&
              post.ageHours > settings.maxPostAgeHours
            )
              oldPosts++;
            else if (!post.pinned) oldPosts = 0;
          };
          if (!target) {
            if (!isPostHydrated) continue;
            seen.add(post.postId);
            fresh++;
            noteAge(post);
            continue;
          }
          if (
            isPageBumperMode &&
            scroll === 0 &&
            surface.posts.indexOf(post) > 0 &&
            !post.likeCSS &&
            !post.commentButtonCSS &&
            !post.commentCSS &&
            !post.videoCSS
          )
            continue;
          if (
            !isPageBumperMode &&
            groupCtx.effectiveSearchMode !== 'random_browse' &&
            post.ageHours === null
          )
            continue;
          if (!isResumingCurrentPost) {
            seen.add(post.postId);
            fresh++;
            noteAge(post);
            stats.matchedAuthorPosts++;
            if (post.authorAvatarUrl)
              await session.updateAvatar('pages', target.id, post.authorAvatarUrl);
            if (post.authorName.trim() && (!target.name.trim() || target.name === target.id)) {
              await session.updateMetadata('pages', target.id, {
                name: post.authorName.trim(),
                avatarUrl: post.authorAvatarUrl,
              });
              target.name = post.authorName.trim();
            }
            const scanned = counts.get(target.id) ?? 0;
            if (scanned >= maxScanForTarget) continue;
            counts.set(target.id, scanned + 1);
            if (
              !isPageBumperMode &&
              groupCtx.effectiveSearchMode !== 'random_browse' &&
              (post.ageHours === null || post.ageHours > settings.maxPostAgeHours)
            ) {
              stats.filteredByAgePosts++;
              continue;
            }
          }
          const postOutcome = await executeBumperPostActions({
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
          });
          if (postOutcome === 'quota_reached') return 'quota_reached';
          if (callbacks.shouldStopAfterCurrentPost?.()) {
            stats.quotaReached = true;
            return 'quota_reached';
          }
        }
        if (callbacks.shouldStopAfterCurrentPost?.()) {
          stats.quotaReached = true;
          return 'quota_reached';
        }
        if (!isPageBumperMode && oldPosts >= 3) break;
        if ((feed ? [feed] : pages).every((p) => (counts.get(p.id) ?? 0) >= maxScanForTarget))
          break;
        empty = fresh ? 0 : empty + 1;
        await session.op(
          '浏览小组帖子',
          async () => {
            const scrollPage = session.getPage();
            const vp = scrollPage.viewportSize?.() ?? { width: 1024, height: 768 };
            await scrollPage.mouse?.move?.(
              Math.max(440, Math.round(vp.width * 0.58)),
              Math.round(vp.height * 0.55),
              { steps: 2 },
            );
            const beforeY = await scrollPage.evaluate(() => window.scrollY).catch(() => 0);
            const segments = paceScale > 0 ? 2 + Math.floor(Math.random() * 2) : 1;
            for (let s = 0; s < segments; s++) {
              await scrollPage.mouse.wheel(0, 280 + Math.floor(Math.random() * 181));
              if (s + 1 < segments) {
                const segPause = Math.round((250 + Math.floor(Math.random() * 351)) * paceScale);
                if (segPause > 0) await wait(segPause);
              }
            }
            if (paceScale > 0 && Math.random() < 0.25) {
              const microPause = Math.round((300 + Math.floor(Math.random() * 301)) * paceScale);
              if (microPause > 0) await wait(microPause);
              if (Math.random() < 0.5)
                await scrollPage.mouse.wheel(0, -(60 + Math.floor(Math.random() * 71)));
              else
                await scrollPage.mouse?.move?.(
                  300 + Math.floor(Math.random() * 300),
                  240 + Math.floor(Math.random() * 240),
                  { steps: 3 },
                );
            }
            const afterY = await scrollPage.evaluate(() => window.scrollY).catch(() => 0);
            if (typeof beforeY === 'number' && typeof afterY === 'number' && afterY - beforeY < 220)
              await scrollPage.evaluate((dy) => window.scrollBy(0, dy), 650).catch(() => {});
            return true;
          },
          async () => true,
        );
        await session.paceWait(1800 + Math.floor(Math.random() * 2201));
      } catch (scrollError) {
        if (session.isCanceledByUserDetach(scrollError))
          throw new BumperFatalError(BUMPER_DEBUGGER_CANCELED_MESSAGE);
        if (callbacks.cancelled() || !isBumperRecoverableDisconnectError(scrollError))
          throw scrollError;
        await session.recoverBumperSession(
          scrollError instanceof Error ? scrollError.message : String(scrollError),
        );
        hasRecoveredInFeed = true;
        await closeBumperShareDialogIfOpen(session);
        if (resumableRef.current) {
          const r = resumableRef.current;
          if (
            (!r.wantLike || r.likeProgress !== 'NOT_SENT') &&
            (!r.chosen || r.commentProgress !== 'NOT_SENT') &&
            (!r.wantShareToStory || r.storyShareProgress !== 'NOT_SENT')
          )
            resumableRef.current = null;
        }
        const activePage = session.getPage();
        const expectedFeedUrl = isPageBumperMode
          ? buildBumperTargetUrl('pages', resolvedPageId ?? feed?.id ?? '')
          : feed
            ? `https://www.facebook.com/groups/${encodeURIComponent(groupCtx.effectiveGroupId)}/user/${encodeURIComponent(resolvedPageId ?? feed.id)}/`
            : groupCtx.effectiveSearchMode === 'time_sort'
              ? `https://www.facebook.com/groups/${encodeURIComponent(groupCtx.effectiveGroupId)}/?sorting_setting=CHRONOLOGICAL`
              : `https://www.facebook.com/groups/${encodeURIComponent(groupCtx.effectiveGroupId)}/`;
        const currentCheck = await readGroupBumper(activePage, {
          groupId: groupCtx.effectiveGroupId,
          ...(feed ? { pageId: resolvedPageId } : {}),
        }).catch(() => null);
        const stillOnTargetSurface = isPageBumperMode
          ? Boolean(
              currentCheck &&
              currentCheck.posts.length > 0 &&
              !/^\/(?:search|groups)(?:\/|$)/i.test(new URL(activePage.url()).pathname),
            )
          : Boolean(
              currentCheck &&
              currentCheck.groupIds.includes(groupCtx.effectiveGroupId.toLowerCase()),
            );
        if (!stillOnTargetSurface) {
          await session.navigate(expectedFeedUrl);
          await groupHelpers.waitForFeed(resolvedPageId);
        }
        scroll = Math.max(-1, scroll - 1);
        continue;
      }
    }
    if (
      !isPageBumperMode &&
      groupCtx.joinRestrictedFallback &&
      groupCtx.effectiveSearchMode === 'page_group_feed' &&
      !fallbackRandomAppended &&
      feedIndex === feeds.length - 1 &&
      !anyUserFeedPosts &&
      initialFeed &&
      initialFeed.posts.length > 0
    ) {
      fallbackRandomAppended = true;
      groupCtx.effectiveSearchMode = 'random_browse';
      callbacks.status(`专页小组贴未开放，已自动切换随机浏览 · ${group.name}`);
      feeds.push(null);
    }
  }
  return 'continue';
}
