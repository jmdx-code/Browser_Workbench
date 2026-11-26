import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import {
  BrowseScrollRoot,
  BrowseCenterHit,
  BrowseVisiblePlayer,
  BrowseContentPosition,
} from '../shared/browse-execution.js';
import {
  FACEBOOK_REEL_NEXT_CSS,
  FACEBOOK_FRIEND_CONFIRM_CSS,
  FACEBOOK_FRIEND_ADD_CSS,
  FACEBOOK_BROWSE_LIKE_CSS,
  FACEBOOK_BROWSE_DIALOG_DISMISS_CSS,
} from '../shared/facebook-browse-route.js';
import { serializeDomEval } from './shared-dom-eval-runtime.js';
import {
  createBrowseRuntime,
  projectFacebookFeedInputFence,
  readBrowseDetoursAndSearch,
  readBrowseFriendsAndMarket,
} from './facebook-browse-reader/browse-surfaces.js';
import {
  readBrowseFeedPosts,
  readBrowseLikeTarget,
} from './facebook-browse-reader/browse-feed-and-like.js';
export {
  FACEBOOK_REEL_NEXT_CSS,
  FACEBOOK_FRIEND_CONFIRM_CSS,
  FACEBOOK_FRIEND_ADD_CSS,
  FACEBOOK_BROWSE_LIKE_CSS,
  FACEBOOK_BROWSE_DIALOG_DISMISS_CSS,
} from '../shared/facebook-browse-route.js';
export { projectFacebookFeedInputFence };
function projectBrowsePageEntry(
  createDomRt: Parameters<typeof createBrowseRuntime>[0],
  initRuntime: typeof createBrowseRuntime,
  readFeed: typeof readBrowseFeedPosts,
  readFriendsMarket: typeof readBrowseFriendsAndMarket,
  readLike: typeof readBrowseLikeTarget,
  readDetours: typeof readBrowseDetoursAndSearch,
) {
  const rt = initRuntime(createDomRt),
    feed = readFeed(rt),
    fm = readFriendsMarket(rt);
  const { searchPagesRoute, timelineDetourSurface, feedLikeSurface, main, video } = rt;
  const { article, structuralPost, source } = feed;
  const { friendsRoute, friendRequestsRoute, friendSuggestionsRoute, marketplace, itemRoute } = fm;
  const anchor = source && video ? video : (structuralPost?.element ?? article?.el);
  const rect = feedLikeSurface ? anchor?.getBoundingClientRect() : undefined;
  const contentPosition =
    rect && rect.right > rect.left && rect.bottom > rect.top
      ? {
          left: rect.left,
          top: rect.top,
          width: rect.right - rect.left,
          height: rect.bottom - rect.top,
          viewportHeight: innerHeight,
        }
      : null;
  const currentScrollY = Math.max(0, scrollY, ...feed.scrolling.map((el) => el.scrollTop));
  const currentScrollMaxY = Math.max(
    0,
    (document.scrollingElement?.scrollHeight ?? 0) -
      (document.scrollingElement?.clientHeight ?? innerHeight),
    ...feed.scrolling.map((el) => el.scrollHeight - el.clientHeight),
  );
  const videoDurationSeconds =
    video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
  const rand = (base: number, span: number) => Math.round(base + Math.random() * span);
  const clamp = (min: number, max: number, v: number) => Math.max(min, Math.min(max, v));
  let recommendedDwellMs: number | undefined, nextScrollDeltaY: number | undefined;
  if (friendRequestsRoute || friendSuggestionsRoute) {
    recommendedDwellMs = rand(1600, 1900);
  } else if (searchPagesRoute) {
    recommendedDwellMs = rand(1800, 1400);
    nextScrollDeltaY = rand(360, 240);
  } else if (marketplace || itemRoute) {
    recommendedDwellMs = itemRoute ? rand(2400, 1800) : rand(2200, 1600);
    nextScrollDeltaY = rand(380, 280);
  } else if (rt.reelSurface && video) {
    const roll = Math.random();
    if (videoDurationSeconds) {
      if (roll < 0.48) {
        const ratio =
          videoDurationSeconds <= 18 ? 0.92 + Math.random() * 0.33 : 0.78 + Math.random() * 0.27;
        recommendedDwellMs = clamp(
          5500,
          26500,
          Math.round(videoDurationSeconds * 1000 * ratio + (Math.random() - 0.3) * 1400),
        );
      } else if (roll < 0.82) {
        const ratio = 0.48 + Math.random() * 0.34;
        recommendedDwellMs = clamp(
          4500,
          19500,
          Math.round(videoDurationSeconds * 1000 * ratio + (Math.random() - 0.5) * 1200),
        );
      } else {
        recommendedDwellMs = rand(3200, 2600);
      }
    } else {
      recommendedDwellMs = roll < 0.75 ? rand(7500, 9500) : rand(3800, 2400);
    }
  } else if (feedLikeSurface) {
    if (structuralPost) {
      if (structuralPost.hasInlineVideo || (source && video)) {
        const dur = structuralPost.videoDuration ?? videoDurationSeconds;
        recommendedDwellMs = dur
          ? dur <= 22
            ? clamp(3000, 7500, Math.round(dur * 1000 * (0.4 + Math.random() * 0.25)))
            : rand(3500, 3800)
          : rand(3200, 3500);
      } else if (structuralPost.imageCount > 0) {
        recommendedDwellMs = clamp(
          2200,
          5200,
          Math.round(
            2100 +
              Math.min(3, structuralPost.imageCount) * 550 +
              Math.min(1200, Math.floor(structuralPost.textLength / 100) * 240) +
              Math.random() * 1300,
          ),
        );
      } else {
        recommendedDwellMs = clamp(
          1900,
          4200,
          Math.round(
            1800 +
              Math.min(1300, Math.floor(structuralPost.textLength / 90) * 240) +
              Math.random() * 1100,
          ),
        );
      }
    } else {
      recommendedDwellMs = article ? rand(2200, 1800) : 2000;
    }
    const targetCenterY = 56 + (innerHeight - 56) * 0.5,
      anchorRect = anchor?.getBoundingClientRect(),
      anchorCenterY = anchorRect ? anchorRect.top + anchorRect.height * 0.5 : 0;
    let computedDelta: number | null = null;
    if (
      anchorRect &&
      anchorRect.bottom > innerHeight * 0.82 &&
      anchorCenterY > targetCenterY + 115
    ) {
      computedDelta = Math.round(anchorCenterY - targetCenterY + (Math.random() - 0.5) * 36);
    } else {
      const currentTop = structuralPost?.root.getBoundingClientRect().top ?? anchorRect?.top ?? 56;
      const nextPost = feed.orderedPosts.find((c) => {
        const r = c.root.getBoundingClientRect(),
          focal = c.element.getBoundingClientRect(),
          center = focal.height > 0 ? focal.top + focal.height * 0.5 : r.top + r.height * 0.45;
        return r.top > currentTop + 72 && center > targetCenterY + 90;
      });
      if (nextPost) {
        const focalRect = nextPost.element.getBoundingClientRect(),
          rootRect = nextPost.root.getBoundingClientRect(),
          focalCenterY =
            focalRect.height > 60 && focalRect.height <= (innerHeight - 56) * 0.92
              ? focalRect.top + focalRect.height * 0.5
              : rootRect.top + Math.min(rootRect.height * 0.45, (innerHeight - 56) * 0.44);
        computedDelta = Math.round(focalCenterY - targetCenterY + (Math.random() - 0.5) * 44);
      }
    }
    if (computedDelta === null || currentScrollMaxY - currentScrollY <= innerHeight * 1.15) {
      computedDelta = Math.max(
        computedDelta ?? 0,
        Math.round(
          Math.max(
            currentScrollMaxY - currentScrollY + 220,
            innerHeight * (0.68 + Math.random() * 0.2),
          ),
        ),
      );
    }
    nextScrollDeltaY = clamp(140, 1080, computedDelta);
  }
  const likeTarget = readLike(rt, feed),
    { feedDetourTargets, searchPageMatches } = readDetours(rt, feed),
    searchPagesKey =
      searchPagesRoute && main
        ? `search-pages:${(new URLSearchParams(location.search).get('q') ?? '').slice(0, 120)}|n:${searchPageMatches.length}`
        : null,
    timelineFallbackKey =
      timelineDetourSurface &&
      main &&
      (main.textContent?.replace(/\s+/g, ' ').trim().length ?? 0) >= 12
        ? `timeline:${location.pathname}${location.search.slice(0, 80)}|y:${Math.floor(currentScrollY / 300)}`
        : null;
  return {
    url: location.href,
    timeOrigin: performance.timeOrigin,
    ready: document.readyState !== 'loading' && (friendsRoute ? !!main || !!fm.friendNav : !!main),
    visible: document.visibilityState === 'visible',
    blocked: rt.dialogs,
    scrollY: currentScrollY,
    scrollMaxY: currentScrollMaxY,
    viewportHeight: innerHeight,
    contentPosition,
    ...(recommendedDwellMs !== undefined ? { recommendedDwellMs } : {}),
    ...(nextScrollDeltaY !== undefined ? { nextScrollDeltaY } : {}),
    ...(likeTarget !== null ? { likeTarget } : {}),
    ...(rt.dialogDismissCSS !== null ? { dialogDismissCSS: rt.dialogDismissCSS } : {}),
    ...(feedDetourTargets.length > 0 ? { feedDetourTargets } : {}),
    ...(searchPagesRoute ? { searchPageMatches } : {}),
    contentKey:
      friendRequestsRoute || friendSuggestionsRoute
        ? fm.friendKey
        : searchPagesRoute
          ? searchPagesKey
          : marketplace
            ? fm.marketplaceKey
            : itemRoute
              ? fm.detailLoaded
                ? 'item:' + location.pathname.replace(/\/$/, '')
                : null
              : source
                ? source.slice(0, 2000)
                : (structuralPost?.key ?? article?.key ?? timelineFallbackKey),
    videoEntry: feed.videoEntry,
    nextReelCSS: feed.nextReelCSS,
    ...(friendRequestsRoute
      ? { friendConfirmCSS: fm.friendConfirmCSS, friendPendingCount: fm.friendPendingCount }
      : {}),
    ...(friendSuggestionsRoute
      ? { friendAddCSS: fm.friendAddCSS, friendSuggestedCount: fm.friendSuggestedCount }
      : {}),
    marketplaceCategories: fm.marketplaceCategories,
    marketplaceUnavailable: fm.marketplaceUnavailable,
    marketplaceItems: [...new Set(fm.items)]
      .slice(0, 8)
      .map((item) => 'https://www.facebook.com' + item.replace(/\/?$/, '/')),
    structure: {
      scrollRoots: feed.scrolling.slice(0, 4).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.slice(0, 12),
          role: el.getAttribute('role')?.slice(0, 40) ?? null,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          top: Math.max(0, el.scrollTop),
          max: Math.max(0, el.scrollHeight - el.clientHeight),
        };
      }),
      centerHit: feed.centerHit
        ? {
            tag: feed.centerHit.tagName.slice(0, 12),
            role: feed.centerHit.getAttribute('role')?.slice(0, 40) ?? null,
            withinMain: !!main?.contains(feed.centerHit),
          }
        : null,
      mainCount: rt.mains.length,
      allVideos: document.querySelectorAll('video').length,
      mainVideos: main?.querySelectorAll('video').length ?? 0,
      visibleVideos: rt.videos.length,
      structuralPosts: feed.structuralPosts.length,
      players: Array.from(main?.querySelectorAll('video') ?? [])
        .slice(0, 8)
        .map((el) => ({
          area: rt.visibleArea(el),
          sourceLength: (el.currentSrc || el.getAttribute('src') || '').length,
          srcObject: el.srcObject !== null,
          readyState: el.readyState,
          paused: el.paused,
          ended: el.ended,
          timeSeconds: Number.isFinite(el.currentTime) ? Math.max(0, el.currentTime) : 0,
          errorCode: el.error?.code ?? null,
          videoWidth: el.videoWidth,
          videoHeight: el.videoHeight,
        })),
    },
    video:
      video && source && source.length <= 4096 && Number.isFinite(video.currentTime)
        ? {
            css: rt.cssPath(video),
            source,
            paused: video.paused,
            buffering: video.readyState < 3 || video.error !== null,
            failed: video.error !== null,
            readyState: video.readyState,
            ended: video.ended,
            timeSeconds: Math.max(0, video.currentTime),
            ...(videoDurationSeconds !== null ? { durationSeconds: videoDurationSeconds } : {}),
            playbackRate:
              Number.isFinite(video.playbackRate) &&
              video.playbackRate >= 0 &&
              video.playbackRate <= 4
                ? video.playbackRate
                : 1,
          }
        : null,
  };
}
export const FacebookBrowsePage = z
  .object({
    url: z.string().max(4096),
    timeOrigin: z.number().finite().nonnegative(),
    ready: z.boolean(),
    visible: z.boolean(),
    blocked: z.boolean(),
    scrollY: z.number().finite().nonnegative(),
    scrollMaxY: z.number().finite().nonnegative().optional(),
    viewportHeight: z.number().finite().nonnegative(),
    contentKey: z.string().max(2000).nullable(),
    contentPosition: BrowseContentPosition.nullable().optional(),
    recommendedDwellMs: z.number().int().min(1400).max(30000).optional(),
    nextScrollDeltaY: z.number().int().min(100).max(1200).optional(),
    videoEntry: z.string().max(2048).nullable().optional(),
    nextReelCSS: z.literal(FACEBOOK_REEL_NEXT_CSS).nullable().optional(),
    friendConfirmCSS: z.literal(FACEBOOK_FRIEND_CONFIRM_CSS).nullable().optional(),
    friendPendingCount: z.number().int().nonnegative().optional(),
    friendAddCSS: z.literal(FACEBOOK_FRIEND_ADD_CSS).nullable().optional(),
    friendSuggestedCount: z.number().int().nonnegative().optional(),
    feedDetourTargets: z
      .array(
        z
          .object({
            url: z.string().max(2048),
            kind: z.enum(['profile', 'page']),
            name: z.string().max(200).optional(),
          })
          .strict(),
      )
      .max(12)
      .optional(),
    searchPageMatches: z
      .array(
        z
          .object({
            url: z.string().max(2048),
            id: z.string().max(120).nullable(),
            name: z.string().max(200),
          })
          .strict(),
      )
      .max(12)
      .optional(),
    dialogDismissCSS: z.literal(FACEBOOK_BROWSE_DIALOG_DISMISS_CSS).nullable().optional(),
    likeTarget: z
      .object({
        css: z.literal(FACEBOOK_BROWSE_LIKE_CSS).nullable(),
        liked: z.boolean(),
        likeCount: z.number().int().nonnegative(),
        sponsored: z.boolean(),
        text: z.string().max(1000),
      })
      .strict()
      .nullable()
      .optional(),
    marketplaceItems: z.array(z.string().max(2048)).max(8).optional(),
    marketplaceUnavailable: z.boolean().optional(),
    marketplaceCategories: z.array(z.string().max(2048)).max(32).optional(),
    structure: z
      .object({
        mainCount: z.number().int().nonnegative(),
        allVideos: z.number().int().nonnegative(),
        mainVideos: z.number().int().nonnegative(),
        visibleVideos: z.number().int().nonnegative(),
        structuralPosts: z.number().int().nonnegative().optional(),
        scrollRoots: z.array(BrowseScrollRoot).max(4).optional(),
        centerHit: BrowseCenterHit.nullable().optional(),
        players: z.array(BrowseVisiblePlayer).max(8).optional(),
      })
      .strict()
      .optional(),
    video: z
      .object({
        css: z.string().max(300).nullable(),
        source: z.string().max(4096),
        paused: z.boolean(),
        buffering: z.boolean(),
        failed: z.boolean().optional(),
        readyState: z.number().int().min(0).max(4).optional(),
        ended: z.boolean(),
        timeSeconds: z.number().finite().nonnegative(),
        durationSeconds: z.number().finite().positive().nullable().optional(),
        playbackRate: z.number().min(0).max(4),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type BrowsePage = z.infer<typeof FacebookBrowsePage>;
export const projectFacebookBrowsePage = serializeDomEval<() => z.input<typeof FacebookBrowsePage>>(
  'projectFacebookBrowsePage',
  projectBrowsePageEntry,
  {
    createBrowseRuntime,
    readBrowseFeedPosts,
    readBrowseFriendsAndMarket,
    readBrowseLikeTarget,
    readBrowseDetoursAndSearch,
  },
);
export async function readFacebookBrowsePage(
  page: Page,
  guard: () => Awaitable<void>,
): Promise<BrowsePage> {
  await guard();
  const result = FacebookBrowsePage.parse(await page.evaluate(projectFacebookBrowsePage));
  await guard();
  return result;
}
