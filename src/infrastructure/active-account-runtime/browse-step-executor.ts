import { createHash } from 'node:crypto';
import { sleepAbortable } from '../../application/workboard.js';
import { FRIENDS_EXHAUSTED_CURSOR } from '../../domain/tasks.js';
import type { Step } from '../../shared/contracts.js';
import { devDiag } from '../../shared/dev-diagnostics.js';
import {
  classifyFacebookAbnormalUrl,
  facebookBrowseSurfaceForStep,
  facebookFeedDetourEnabled,
  facebookFeedDetourURL,
  facebookFriendsRouteMatches,
  facebookMarketplaceItemURL,
  facebookMarketplaceUnavailableURL,
  facebookMarketplaceURL,
  facebookPageDirectURL,
  facebookPostStoryLandingURL,
  facebookSearchPagesURL,
  FACEBOOK_BROWSE_DIALOG_DISMISS_CSS,
  FACEBOOK_BROWSE_LIKE_CSS,
  FACEBOOK_FRIEND_ADD_CSS,
  FACEBOOK_FRIEND_CONFIRM_CSS,
  FACEBOOK_FRIENDS_REQUESTS_URL,
  FACEBOOK_FRIENDS_SUGGESTIONS_URL,
  FACEBOOK_REEL_NEXT_CSS,
  MARKETPLACE_HOME,
  matchesMarketplaceSearch,
} from '../../shared/facebook-browse-route.js';
import type { Plan, Progress, StepInstance } from '../../shared/task-contracts.js';
import type { BrowserSessionLease } from '../browser-session-lease.js';
import { readFacebookBrowsePage, type BrowsePage } from '../facebook-browse-reader.js';
import type { WorkspaceStorePort } from '../persistence-port.js';
interface FeedDetourState {
  phase: 'home' | 'search' | 'detour';
  detourUrl?: string;
  detourStartedAt?: number;
  detourDurationMs?: number;
  lastDetourEndedAt: number;
  searchTargetIndex: number;
  searchEnteredAt?: number;
  searchExhausted: boolean;
  failedSearchIndices: Set<number>;
  visitedUrls: Set<string>;
  evaluatedHomeContentIds: Set<string>;
}
const hashKey = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
async function clickSelector(
  lease: BrowserSessionLease,
  label: string,
  selector: string,
): Promise<void> {
  await lease.execOp(label, async () => {
    const loc = lease.page.locator(selector).first();
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.click({ timeout: 5_000 });
  });
}
function defaultBrowseUrl(spec: Step): string {
  if (spec.type === 'marketplace') return facebookMarketplaceURL(spec);
  if (spec.type === 'friends')
    return spec.friendAction === 'add_suggested'
      ? FACEBOOK_FRIENDS_SUGGESTIONS_URL
      : FACEBOOK_FRIENDS_REQUESTS_URL;
  if (spec.type === 'feed') {
    if (spec.feedMode === 'search_pages' && spec.targetPages?.[0])
      return facebookSearchPagesURL(spec.targetPages[0].name);
    return 'https://www.facebook.com/';
  }
  return 'https://www.facebook.com/reels/';
}
async function navigateBrowseUrl(lease: BrowserSessionLease, targetUrl: string): Promise<void> {
  lease.guard();
  await lease.execOp('browse-navigate', async () => {
    try {
      await lease.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err ?? '');
      if (!/Execution context was destroyed|frame was detached/i.test(msg)) throw err;
    }
  });
}
async function readBrowsePageSafely(lease: BrowserSessionLease): Promise<BrowsePage | null> {
  try {
    return await readFacebookBrowsePage(lease.page, lease.guard);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    if (/Execution context was destroyed|Cannot find context|Target.*closed/i.test(msg))
      return null;
    throw err;
  }
}
async function handleFeedDetour(
  plan: Plan,
  spec: Extract<Step, { type: 'feed' }>,
  lease: BrowserSessionLease,
  page: BrowsePage,
  detour: FeedDetourState,
  contentId: string,
  dwell: number,
  dwellTargetMs: number,
  now: number,
): Promise<boolean> {
  let parsedPath = '';
  try {
    parsedPath = new URL(page.url).pathname;
  } catch {
    return false;
  }
  const isSearchPages = /^\/search\/pages\/?$/i.test(parsedPath);
  const isDetourTimeline = !isSearchPages && facebookFeedDetourURL(page.url);
  const detourDurationMs = (spec.detourDwellSeconds ?? 25) * 1000;
  if (spec.feedMode === 'search_pages' && !detour.searchExhausted && spec.targetPages?.length) {
    const targets = spec.targetPages;
    const curIdx = detour.searchTargetIndex % targets.length;
    const activeTarget = targets[curIdx];
    if (isSearchPages && activeTarget) {
      detour.searchEnteredAt ??= now;
      const searchElapsed = now - detour.searchEnteredAt;
      const matches = page.searchPageMatches ?? [];
      const tName = activeTarget.name.trim().toLowerCase();
      const tId = activeTarget.id?.trim().toLowerCase() ?? '';
      const matched =
        (tId ? matches.find((m) => m.id?.toLowerCase() === tId) : undefined) ??
        matches.find((m) => m.name.trim().toLowerCase() === tName) ??
        matches[0];
      if (matched && searchElapsed >= 1800) {
        detour.phase = 'detour';
        detour.detourUrl = matched.url;
        detour.detourStartedAt = now;
        detour.detourDurationMs = detourDurationMs;
        detour.searchEnteredAt = undefined;
        await navigateBrowseUrl(lease, matched.url);
        return true;
      }
      if (!matched && searchElapsed >= 5000) {
        detour.searchEnteredAt = undefined;
        const direct = activeTarget.id?.trim() ? facebookPageDirectURL(activeTarget.id) : '';
        if (direct && facebookFeedDetourURL(direct)) {
          detour.phase = 'detour';
          detour.detourUrl = direct;
          detour.detourStartedAt = now;
          detour.detourDurationMs = detourDurationMs;
          await navigateBrowseUrl(lease, direct);
          return true;
        }
        detour.failedSearchIndices.add(curIdx);
        for (let stepIdx = 1; stepIdx <= targets.length; stepIdx++) {
          const nextIdx = (curIdx + stepIdx) % targets.length;
          const nextTarget = targets[nextIdx];
          if (!detour.failedSearchIndices.has(nextIdx) && nextTarget) {
            detour.searchTargetIndex = nextIdx;
            await navigateBrowseUrl(lease, facebookSearchPagesURL(nextTarget.name));
            return true;
          }
        }
        detour.searchExhausted = true;
        detour.phase = 'home';
        await navigateBrowseUrl(lease, 'https://www.facebook.com/');
        return true;
      }
      return false;
    }
    if (isDetourTimeline) {
      detour.detourStartedAt ??= now;
      if (now - detour.detourStartedAt >= detourDurationMs && targets.length > 1) {
        for (let stepIdx = 1; stepIdx <= targets.length; stepIdx++) {
          const nextIdx = (curIdx + stepIdx) % targets.length;
          const nextTarget = targets[nextIdx];
          if (!detour.failedSearchIndices.has(nextIdx) && nextTarget && nextIdx !== curIdx) {
            detour.searchTargetIndex = nextIdx;
            detour.phase = 'search';
            detour.detourStartedAt = undefined;
            await navigateBrowseUrl(lease, facebookSearchPagesURL(nextTarget.name));
            return true;
          }
        }
      }
      return false;
    }
  }
  if (isDetourTimeline) {
    detour.detourStartedAt ??= now;
    if (now - detour.detourStartedAt >= detourDurationMs) {
      detour.phase = 'home';
      detour.detourUrl = undefined;
      detour.detourStartedAt = undefined;
      detour.lastDetourEndedAt = now;
      await navigateBrowseUrl(lease, 'https://www.facebook.com/');
      return true;
    }
    return false;
  }
  if (
    parsedPath === '/' &&
    dwell >= Math.min(dwellTargetMs, 2400) &&
    page.feedDetourTargets?.length &&
    !detour.evaluatedHomeContentIds.has(contentId)
  ) {
    if (detour.evaluatedHomeContentIds.size >= 128) detour.evaluatedHomeContentIds.clear();
    detour.evaluatedHomeContentIds.add(contentId);
    const mode = spec.feedMode ?? 'home';
    if (now - detour.lastDetourEndedAt < (mode === 'home' ? 20_000 : 8_000)) return false;
    const ownId = plan.accountId?.trim() ?? '';
    const unvisited = page.feedDetourTargets.filter(
      (t) =>
        !detour.visitedUrls.has(t.url) &&
        (!ownId || (!t.url.includes('id=' + ownId) && !t.url.endsWith('/' + ownId + '/'))),
    );
    const pick = <T>(arr: T[]) =>
      arr.length ? arr[Math.floor(Math.random() * arr.length)] : undefined;
    let picked: (typeof unvisited)[number] | undefined;
    if (mode === 'random_profile') picked = pick(unvisited.filter((t) => t.kind === 'profile'));
    else if (mode === 'random_page') picked = pick(unvisited.filter((t) => t.kind === 'page'));
    else {
      const profiles = unvisited.filter((t) => t.kind === 'profile');
      const pagesList = unvisited.filter((t) => t.kind === 'page');
      const pChance = (spec.randomProfileVisitChance ?? 0) / 100;
      const gChance = (spec.randomPageVisitChance ?? 0) / 100;
      if (profiles.length && pChance > 0 && Math.random() < pChance) picked = pick(profiles);
      else if (pagesList.length && gChance > 0 && Math.random() < gChance) picked = pick(pagesList);
    }
    if (picked) {
      detour.phase = 'detour';
      detour.detourUrl = picked.url;
      detour.detourStartedAt = now;
      detour.detourDurationMs = detourDurationMs;
      if (detour.visitedUrls.size >= 64) detour.visitedUrls.clear();
      detour.visitedUrls.add(picked.url);
      await navigateBrowseUrl(lease, picked.url);
      return true;
    }
  }
  return false;
}
export async function executeBrowseStep(
  store: WorkspaceStorePort,
  plan: Plan,
  step: StepInstance,
  lease: BrowserSessionLease,
): Promise<
  { kind: 'COMPLETED'; progress: Progress } | { kind: 'SKIPPED'; reason: 'MARKETPLACE_UNAVAILABLE' }
> {
  const spec = step.spec;
  if (spec.type === 'post') throw Error('BROWSE_STEP_REQUIRED');
  const targetDurationMs = spec.durationMinutes * 60_000;
  let effectiveMs = step.progress.effectiveMilliseconds;
  let likes = step.progress.likes;
  let accepted = step.progress.accepted ?? 0;
  let cursor = step.progress.cursor;
  let baseUrl = defaultBrowseUrl(spec);
  const buildProgress = (): Progress => ({
    revision: step.progress.revision,
    effectiveMilliseconds: effectiveMs,
    likes,
    published: 0,
    ...(spec.type === 'friends' ? { accepted } : {}),
    cursor,
  });
  const navAndSleep = async (url: string, ms = 1000) => {
    await navigateBrowseUrl(lease, url);
    await sleepAbortable(ms, lease.signal);
  };
  const diag = (
    event: string,
    extra?: { level?: 'INFO' | 'WARN'; reason?: string; data?: Record<string, unknown> },
  ) =>
    devDiag.record({
      level: extra?.level ?? 'INFO',
      category: 'TASK_RUNNER',
      event,
      profileId: lease.profileId,
      planId: plan.id,
      stepId: step.id,
      stepType: spec.type,
      ...(extra?.reason ? { reason: extra.reason } : {}),
      ...(extra?.data ? { data: extra.data } : {}),
    });
  await navAndSleep(baseUrl);
  let lastLoopAt = Date.now();
  let lastCheckpointAt = lastLoopAt;
  let lastProgressWrite = effectiveMs;
  let stuckStartedAt = lastLoopAt;
  let dwellContentId = '';
  let dwellSince = lastLoopAt;
  let dwellTargetMs = 5_000;
  let dwellObservations = 0;
  let lastLikeAt = -Infinity;
  let likeFailedAttempts = 0;
  let consecutiveFailedLikes = 0;
  let gateLogsEmitted = 0;
  let lastReelScrollCheckKey = '';
  let lastReelScrollY = -1;
  const evaluatedLikeIds = new Set<string>();
  const viewedMarketplaceItems = new Set<string>();
  let resolvedMarketplaceCategory = false;
  const feedDetour: FeedDetourState | null =
    spec.type === 'feed' && facebookFeedDetourEnabled(spec)
      ? {
          phase: spec.feedMode === 'search_pages' ? 'search' : 'home',
          lastDetourEndedAt: -Infinity,
          searchTargetIndex: 0,
          searchExhausted: false,
          failedSearchIndices: new Set<number>(),
          visitedUrls: new Set<string>(),
          evaluatedHomeContentIds: new Set<string>(),
        }
      : null;
  const flushProgress = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastCheckpointAt < 5_000 && effectiveMs === lastProgressWrite) return;
    lastCheckpointAt = now;
    lastProgressWrite = effectiveMs;
    try {
      await store.tasks.updateStepProgress(plan.id, step.id, buildProgress());
    } catch {}
  };
  while (!lease.signal.aborted && effectiveMs < targetDurationMs) {
    lease.guard();
    const now = Date.now();
    const rawDelta = Math.max(0, Math.min(3_000, now - lastLoopAt));
    lastLoopAt = now;
    const page = await readBrowsePageSafely(lease);
    if (!page) {
      if (now - stuckStartedAt > 90_000) throw Error('FACEBOOK_BROWSE_CONTEXT_STUCK');
      await sleepAbortable(900, lease.signal);
      continue;
    }
    const abnormal = classifyFacebookAbnormalUrl(page.url);
    if (abnormal) throw Error(abnormal);
    if (
      spec.type === 'marketplace' &&
      (facebookMarketplaceUnavailableURL(page.url) || page.marketplaceUnavailable === true)
    ) {
      diag('BROWSE_STEP_SKIPPED', { reason: 'MARKETPLACE_UNAVAILABLE' });
      return { kind: 'SKIPPED', reason: 'MARKETPLACE_UNAVAILABLE' };
    }
    if (spec.type === 'marketplace' && spec.categoryId && !resolvedMarketplaceCategory) {
      const nativeCat = (page.marketplaceCategories ?? []).find((val) =>
        matchesMarketplaceSearch(val, { keyword: '', categoryId: spec.categoryId }),
      );
      if (nativeCat) {
        baseUrl = facebookMarketplaceURL(spec, nativeCat);
        resolvedMarketplaceCategory = true;
        await navAndSleep(baseUrl);
        continue;
      }
      if (
        page.url === MARKETPLACE_HOME &&
        page.ready &&
        !page.blocked &&
        now - stuckStartedAt > 15_000
      )
        throw Error('FACEBOOK_MARKETPLACE_CATEGORY_UNAVAILABLE');
    }
    if (facebookPostStoryLandingURL(page.url) && !page.blocked) {
      await navAndSleep(baseUrl);
      continue;
    }
    const onSurface = facebookBrowseSurfaceForStep(page.url, spec) === spec.type;
    const friendsMismatch =
      spec.type === 'friends' &&
      onSurface &&
      !facebookFriendsRouteMatches(page.url, spec.friendAction);
    if (!onSurface || friendsMismatch) {
      if (now - stuckStartedAt > 5_000) {
        await navigateBrowseUrl(lease, baseUrl);
        if (now - stuckStartedAt > 75_000) throw Error('FACEBOOK_BROWSE_ROUTE_TIMEOUT');
      }
      await sleepAbortable(1000, lease.signal);
      continue;
    }
    if (page.blocked || !page.ready) {
      if (
        page.ready &&
        page.blocked &&
        page.dialogDismissCSS === FACEBOOK_BROWSE_DIALOG_DISMISS_CSS
      ) {
        await clickSelector(lease, 'dismiss-dialog', FACEBOOK_BROWSE_DIALOG_DISMISS_CSS).catch(
          () => {},
        );
        await sleepAbortable(800, lease.signal);
        continue;
      }
      if (now - stuckStartedAt > 60_000) {
        await navigateBrowseUrl(lease, baseUrl);
        if (now - stuckStartedAt > 90_000) throw Error('FACEBOOK_BROWSE_BLOCKED_TIMEOUT');
      }
      await sleepAbortable(1000, lease.signal);
      continue;
    }
    if (!page.visible) {
      await lease.execOp('bring-to-front', async () => {
        await lease.page.bringToFront().catch(() => {});
      });
    }
    if (spec.type === 'video' && page.video?.paused && !page.video.ended && page.video.css) {
      const videoCss = page.video.css;
      await lease.execOp('video-play', async () => {
        await lease.page
          .locator(videoCss)
          .first()
          .evaluate((el) => {
            if (el instanceof HTMLVideoElement) void el.play().catch(() => {});
          })
          .catch(() => {});
      });
    }
    stuckStartedAt = now;
    const surfaceHealthy =
      spec.type === 'video'
        ? Boolean(page.video && !page.video.failed)
        : Boolean(page.contentKey || spec.type === 'feed' || spec.type === 'friends');
    if (surfaceHealthy) {
      effectiveMs = Math.min(targetDurationMs, effectiveMs + rawDelta);
      await flushProgress(false);
      if (effectiveMs >= targetDurationMs) break;
    }
    const contentId = hashKey(
      spec.type === 'video'
        ? page.contentKey || page.video?.source || page.url
        : page.contentKey || page.url + '|' + page.scrollY,
    );
    if (contentId !== dwellContentId) {
      dwellContentId = contentId;
      dwellSince = now;
      dwellObservations = 1;
      dwellTargetMs =
        page.recommendedDwellMs ??
        (spec.type === 'video'
          ? 6_000 + Math.floor(Math.random() * 6_000)
          : 4_500 + Math.floor(Math.random() * 4_500));
    } else {
      dwellObservations = Math.min(10, dwellObservations + 1);
    }
    const dwell = now - dwellSince;
    if (spec.type === 'friends') {
      const isAdd = spec.friendAction === 'add_suggested';
      const btnCss = isAdd ? page.friendAddCSS : page.friendConfirmCSS;
      const expectedCss = isAdd ? FACEBOOK_FRIEND_ADD_CSS : FACEBOOK_FRIEND_CONFIRM_CSS;
      if (btnCss === expectedCss && dwell >= Math.min(dwellTargetMs, 2500)) {
        await clickSelector(lease, isAdd ? 'friend-add' : 'friend-confirm', expectedCss).catch(
          () => {},
        );
        accepted =
          spec.acceptMode === 'count' ? Math.min(spec.maxAccepts, accepted + 1) : accepted + 1;
        await flushProgress(true);
        if (spec.acceptMode === 'count' && accepted >= spec.maxAccepts)
          return { kind: 'COMPLETED', progress: buildProgress() };
        await sleepAbortable(1200, lease.signal);
        continue;
      }
      if (
        (page.contentKey === 'FRIENDS_REQUESTS_EXHAUSTED' ||
          page.contentKey === 'FRIENDS_SUGGESTIONS_EXHAUSTED') &&
        dwell >= 6000 &&
        dwellObservations >= 2
      ) {
        cursor = FRIENDS_EXHAUSTED_CURSOR;
        await flushProgress(true);
        return { kind: 'COMPLETED', progress: buildProgress() };
      }
      await sleepAbortable(1200, lease.signal);
      continue;
    }
    if (spec.type === 'feed' && feedDetour) {
      if (
        await handleFeedDetour(
          plan,
          spec,
          lease,
          page,
          feedDetour,
          contentId,
          dwell,
          dwellTargetMs,
          now,
        )
      ) {
        await sleepAbortable(1200, lease.signal);
        continue;
      }
    }
    if (spec.type === 'marketplace') {
      const detail = facebookMarketplaceItemURL(page.url);
      if (detail) {
        viewedMarketplaceItems.add(detail);
        if (dwell >= (page.recommendedDwellMs ?? 8000)) {
          await navAndSleep(baseUrl);
          continue;
        }
      } else {
        const nextItem = (page.marketplaceItems ?? []).find(
          (item) => facebookMarketplaceItemURL(item) === item && !viewedMarketplaceItems.has(item),
        );
        if (nextItem && dwell >= (page.recommendedDwellMs ?? 5000)) {
          await navAndSleep(nextItem);
          continue;
        }
      }
    }
    if (
      (spec.type === 'feed' || spec.type === 'video') &&
      spec.maxLikes > 0 &&
      likes < spec.maxLikes &&
      dwell >= Math.min(Math.round(dwellTargetMs * 0.5), 1600) &&
      (!page.contentKey || !evaluatedLikeIds.has(contentId))
    ) {
      if (evaluatedLikeIds.size >= 256) evaluatedLikeIds.clear();
      if (page.contentKey) evaluatedLikeIds.add(contentId);
      if (!page.contentKey || page.likeTarget?.css !== FACEBOOK_BROWSE_LIKE_CSS) {
        if (gateLogsEmitted < 8) {
          gateLogsEmitted += 1;
          diag('BROWSE_LIKE_GATE', {
            data: {
              url: page.url,
              hasContentKey: Boolean(page.contentKey),
              hasLikeTargetCss: page.likeTarget?.css === FACEBOOK_BROWSE_LIKE_CSS,
              liked: page.likeTarget?.liked ?? null,
              likeCount: page.likeTarget?.likeCount ?? null,
              sponsored: page.likeTarget?.sponsored ?? null,
            },
          });
        }
      } else {
        const maxFailedAttempts = Math.max(4, spec.maxLikes * 2);
        const circuitOpen = consecutiveFailedLikes >= 3 || likeFailedAttempts >= maxFailedAttempts;
        if (!circuitOpen && now - lastLikeAt >= 8000) {
          const target = page.likeTarget;
          const sponsoredOk = !((spec.skipSponsored ?? true) && target.sponsored);
          const countOk = target.likeCount >= spec.minLikeCount;
          const textLower = target.text.toLowerCase();
          const parseKw = (raw?: string) =>
            (raw ?? '')
              .split(/[,，\n]/)
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean);
          const includeList = parseKw(spec.includeKeywords);
          const excludeList = parseKw(spec.excludeKeywords);
          const includeOk =
            includeList.length === 0 || includeList.some((kw) => textLower.includes(kw));
          const excludeOk =
            excludeList.length === 0 || !excludeList.some((kw) => textLower.includes(kw));
          const notLiked =
            !target.liked && !(await store.tasks.hasAccountLiked(lease.accountId, contentId));
          const rolled = Math.random() < (spec.likeProbability ?? 35) / 100;
          if (gateLogsEmitted < 8) {
            gateLogsEmitted += 1;
            diag('BROWSE_LIKE_GATE', {
              data: {
                likes,
                maxLikes: spec.maxLikes,
                likeCount: target.likeCount,
                minLikeCount: spec.minLikeCount,
                liked: target.liked,
                sponsored: target.sponsored,
                sponsoredOk,
                countOk,
                includeOk,
                excludeOk,
                notLiked,
                rolled,
              },
            });
          }
          if (sponsoredOk && countOk && includeOk && excludeOk && notLiked && rolled) {
            lastLikeAt = now;
            let clickErr: string | null = null;
            await clickSelector(lease, 'browse-like', FACEBOOK_BROWSE_LIKE_CSS).catch((err) => {
              clickErr = err instanceof Error ? err.message : String(err ?? '');
            });
            await sleepAbortable(1200, lease.signal);
            const after = await readBrowsePageSafely(lease);
            const verified =
              after?.likeTarget?.liked === true ||
              Boolean(after?.likeTarget && after.likeTarget.likeCount > target.likeCount);
            if (verified) {
              await store.tasks.recordAccountLike(lease.accountId, contentId);
              likes += 1;
              consecutiveFailedLikes = 0;
              diag('BROWSE_LIKE_CONFIRMED', {
                data: { likes, maxLikes: spec.maxLikes, observedLikeCount: target.likeCount },
              });
              await flushProgress(true);
            } else {
              likeFailedAttempts += 1;
              consecutiveFailedLikes += 1;
              diag('BROWSE_LIKE_UNVERIFIED', {
                level: 'WARN',
                reason: clickErr ?? 'POST_CLICK_STATE_UNCHANGED',
                data: {
                  beforeLiked: target.liked,
                  beforeLikeCount: target.likeCount,
                  afterLiked: after?.likeTarget?.liked ?? null,
                  afterLikeCount: after?.likeTarget?.likeCount ?? null,
                  consecutiveFailedLikes,
                  likeFailedAttempts,
                },
              });
            }
            continue;
          }
        }
      }
    }
    if (spec.type === 'video' && page.video && (page.video.ended || dwell >= dwellTargetMs)) {
      if (page.scrollY >= 28_000) {
        await navigateBrowseUrl(lease, 'https://www.facebook.com/reels/');
      } else if (page.nextReelCSS === FACEBOOK_REEL_NEXT_CSS) {
        await clickSelector(lease, 'next-reel', FACEBOOK_REEL_NEXT_CSS).catch(() => {});
      } else {
        const stuckAtSameReel =
          lastReelScrollCheckKey === contentId && Math.abs(lastReelScrollY - page.scrollY) < 20;
        lastReelScrollCheckKey = contentId;
        lastReelScrollY = page.scrollY;
        await lease.execOp('reel-scroll', async () => {
          const vp = lease.page.viewportSize();
          await lease.page.mouse
            .move(
              Math.round((vp?.width ?? 1280) / 2),
              Math.round((vp?.height ?? page.viewportHeight) / 2),
            )
            .catch(() => {});
          await lease.page.mouse.wheel(0, page.nextScrollDeltaY ?? 600);
          if (stuckAtSameReel) await lease.page.keyboard.press('ArrowDown').catch(() => {});
        });
      }
      dwellContentId = '';
      await sleepAbortable(1200, lease.signal);
      continue;
    }
    if (spec.type !== 'video' && dwell >= dwellTargetMs) {
      const delta =
        page.nextScrollDeltaY ??
        Math.max(180, Math.min(1080, Math.floor(page.viewportHeight * 0.78)));
      await lease.execOp('browse-scroll', async () => {
        await lease.page.mouse.wheel(0, delta);
      });
      dwellContentId = '';
      await sleepAbortable(1000, lease.signal);
      continue;
    }
    if (spec.type === 'video' && !page.video && page.videoEntry && page.videoEntry !== page.url)
      await navigateBrowseUrl(lease, page.videoEntry);
    await sleepAbortable(1200, lease.signal);
  }
  await flushProgress(true);
  return { kind: 'COMPLETED', progress: buildProgress() };
}
