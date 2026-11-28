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
  facebookPageDirectURL,
  facebookPostStoryLandingURL,
  facebookSearchPagesURL,
  FACEBOOK_BROWSE_DIALOG_DISMISS_CSS,
  FACEBOOK_BROWSE_LIKE_CSS,
  FACEBOOK_FRIEND_ADD_CSS,
  FACEBOOK_FRIEND_CONFIRM_CSS,
  FACEBOOK_REEL_NEXT_CSS,
} from '../../shared/facebook-browse-route.js';
import type { Plan, Progress, StepInstance } from '../../shared/task-contracts.js';
import type { BrowserSessionLease } from '../browser-session-lease.js';
import {
  clickSelector,
  defaultBrowseUrl,
  navigateBrowseUrl,
  readBrowsePageSafely,
} from './browse-dom-helpers.js';
import type { BrowsePage } from '../facebook-browse-reader.js';
import type { WorkspaceStorePort } from '../persistence-port.js';
interface FeedDetourState {
  phase: 'home' | 'search' | 'detour';
  detourUrl?: string;
  detourStartedAt?: number;
  detourDurationMs?: number;
  nextDetourCooldownMs: number;
  lastDetourEndedAt: number;
  searchTargetIndex: number;
  searchEnteredAt?: number;
  searchExhausted: boolean;
  failedSearchIndices: Set<number>;
  visitedUrls: Set<string>;
  evaluatedHomeContentIds: Set<string>;
}
const isTransientContextError = (err: unknown): boolean =>
  /Execution context was destroyed|Cannot find context|frame was detached/i.test(
    err instanceof Error ? err.message : String(err ?? ''),
  );
const hashKey = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const jitterDetourMs = (baseSeconds?: number) => {
  const baseMs = (baseSeconds ?? 25) * 1000;
  return Math.max(8_000, Math.round(baseMs * (0.75 + Math.random() * 0.5)));
};
const jitterCooldownMs = (mode: string) =>
  mode === 'home'
    ? 16_000 + Math.floor(Math.random() * 18_000)
    : 6_000 + Math.floor(Math.random() * 8_000);
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
  const detourDurationMs = detour.detourDurationMs ?? jitterDetourMs(spec.detourDwellSeconds);
  if (spec.feedMode === 'search_pages' && !detour.searchExhausted && spec.targetPages?.length) {
    const targets = spec.targetPages;
    const curIdx = detour.searchTargetIndex % targets.length;
    const activeTarget = targets[curIdx];
    const nextSearchTarget = async (skipCurrent: boolean) => {
      for (let i = 1; i <= targets.length; i++) {
        const nextIdx = (curIdx + i) % targets.length;
        const t = targets[nextIdx];
        if (!detour.failedSearchIndices.has(nextIdx) && t && (!skipCurrent || nextIdx !== curIdx)) {
          detour.searchTargetIndex = nextIdx;
          detour.phase = 'search';
          detour.detourStartedAt = undefined;
          detour.detourDurationMs = undefined;
          await navigateBrowseUrl(lease, facebookSearchPagesURL(t.name));
          return true;
        }
      }
      return false;
    };
    const enterDetour = async (url: string) => {
      detour.phase = 'detour';
      detour.detourUrl = url;
      detour.detourStartedAt = now;
      detour.detourDurationMs = jitterDetourMs(spec.detourDwellSeconds);
      await navigateBrowseUrl(lease, url);
      return true;
    };
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
      if (matched && searchElapsed >= 1500 + Math.floor(Math.random() * 900)) {
        detour.searchEnteredAt = undefined;
        return enterDetour(matched.url);
      }
      if (!matched && searchElapsed >= 4500 + Math.floor(Math.random() * 1400)) {
        detour.searchEnteredAt = undefined;
        const direct = activeTarget.id?.trim() ? facebookPageDirectURL(activeTarget.id) : '';
        if (direct && facebookFeedDetourURL(direct)) return enterDetour(direct);
        detour.failedSearchIndices.add(curIdx);
        if (await nextSearchTarget(false)) return true;
        detour.searchExhausted = true;
        detour.phase = 'home';
        await navigateBrowseUrl(lease, 'https://www.facebook.com/');
        return true;
      }
      return false;
    }
    if (isDetourTimeline) {
      detour.detourStartedAt ??= now;
      if (now - detour.detourStartedAt >= detourDurationMs && targets.length > 1)
        return nextSearchTarget(true);
      return false;
    }
  }
  if (isDetourTimeline) {
    detour.detourStartedAt ??= now;
    if (now - detour.detourStartedAt >= detourDurationMs) {
      detour.phase = 'home';
      detour.detourUrl = undefined;
      detour.detourStartedAt = undefined;
      detour.detourDurationMs = undefined;
      detour.lastDetourEndedAt = now;
      detour.nextDetourCooldownMs = jitterCooldownMs(spec.feedMode ?? 'home');
      await navigateBrowseUrl(lease, 'https://www.facebook.com/');
      return true;
    }
    return false;
  }
  if (
    parsedPath === '/' &&
    dwell >= Math.min(dwellTargetMs, 1800 + Math.floor(Math.random() * 1400)) &&
    page.feedDetourTargets?.length &&
    !detour.evaluatedHomeContentIds.has(contentId)
  ) {
    if (detour.evaluatedHomeContentIds.size >= 128) detour.evaluatedHomeContentIds.clear();
    detour.evaluatedHomeContentIds.add(contentId);
    const mode = spec.feedMode ?? 'home';
    if (now - detour.lastDetourEndedAt < detour.nextDetourCooldownMs) return false;
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
      detour.detourDurationMs = jitterDetourMs(spec.detourDwellSeconds);
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
  const checkRisk = async (kind: 'active-like' | 'active-friend') =>
    store.activityStats
      ? await Promise.resolve(
          store.activityStats.checkBrowserRiskLimit(lease.profileId, kind),
        ).catch(() => ({ allowed: true, reason: null }))
      : { allowed: true, reason: null };
  const safeNav = async (url: string) => {
    try {
      await navigateBrowseUrl(lease, url);
    } catch (err) {
      if (!isTransientContextError(err)) throw err;
      diag('BROWSE_CONTEXT_RETRY', { level: 'INFO', reason: 'TRANSIENT_NAV_CONTEXT_LOST' });
    }
  };
  const navAndSleep = async (url: string, ms = 1000) => {
    await safeNav(url);
    await sleepAbortable(ms, lease.signal);
  };
  await navAndSleep(baseUrl);
  let contextRetryCount = 0;
  let lastLoopAt = Date.now();
  let lastCheckpointAt = lastLoopAt;
  let lastProgressWrite = effectiveMs;
  let lastActivityFlushedMs = effectiveMs;
  let lastActivityFlushedLikes = likes;
  let lastActivityFlushedFriends = accepted;
  let browserLikeLimited = false;
  let stuckStartedAt = lastLoopAt;
  let totalStuckStartedAt = lastLoopAt;
  let recoverNavCount = 0;
  let dwellContentId = '';
  let dwellSince = lastLoopAt;
  let dwellTargetMs = 5_000;
  let dwellObservations = 0;
  let lastLikeAt = -Infinity;
  let nextLikeGapMs = 6_500 + Math.floor(Math.random() * 5_500);
  let likeCooldownUntil = 0;
  let likeSkipCandidatesRemaining = 0;
  let consecutiveFailedLikes = 0;
  let consecutiveFailedFriends = 0;
  let gateLogsEmitted = 0;
  let lastReelScrollCheckKey = '';
  let lastReelScrollY = -1;
  const evaluatedLikeIds = new Set<string>();
  const viewedMarketplaceItems = new Set<string>();
  const feedDetour: FeedDetourState | null =
    spec.type === 'feed' && facebookFeedDetourEnabled(spec)
      ? {
          phase: spec.feedMode === 'search_pages' ? 'search' : 'home',
          lastDetourEndedAt: -Infinity,
          nextDetourCooldownMs: jitterCooldownMs(spec.feedMode ?? 'home'),
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
    const durDelta = Math.max(0, effectiveMs - lastActivityFlushedMs);
    const likesDelta = Math.max(0, likes - lastActivityFlushedLikes);
    const friendsDelta = Math.max(0, accepted - lastActivityFlushedFriends);
    if (durDelta > 0 || likesDelta > 0 || friendsDelta > 0) {
      try {
        await store.activityStats?.recordDailyActivity({
          carrier: 'browser',
          profileId: lease.profileId,
          accountId: lease.accountId,
          durationMsDelta: durDelta,
          likesDelta,
          friendsDelta,
          at: now,
        });
        lastActivityFlushedMs = effectiveMs;
        lastActivityFlushedLikes = likes;
        lastActivityFlushedFriends = accepted;
      } catch {}
    }
    try {
      await store.tasks.updateStepProgress(plan.id, step.id, buildProgress());
    } catch {}
  };
  try {
    while (!lease.signal.aborted && effectiveMs < targetDurationMs) {
      lease.guard();
      const now = Date.now();
      const rawDelta = Math.max(0, Math.min(3_000, now - lastLoopAt));
      lastLoopAt = now;
      const page = await readBrowsePageSafely(lease);
      if (!page) {
        if (now - totalStuckStartedAt > 90_000) throw Error('FACEBOOK_BROWSE_CONTEXT_STUCK');
        if (contextRetryCount++ === 0 || contextRetryCount % 5 === 0)
          diag('BROWSE_CONTEXT_RETRY', {
            level: 'INFO',
            reason: 'TRANSIENT_CONTEXT_LOST',
            data: { contextRetryCount },
          });
        await sleepAbortable(900, lease.signal);
        continue;
      }
      contextRetryCount = 0;
      const abnormal = classifyFacebookAbnormalUrl(page.url);
      if (abnormal) throw Error(abnormal);
      if (
        spec.type === 'marketplace' &&
        (facebookMarketplaceUnavailableURL(page.url) || page.marketplaceUnavailable === true)
      ) {
        diag('BROWSE_STEP_SKIPPED', { reason: 'MARKETPLACE_UNAVAILABLE' });
        return { kind: 'SKIPPED', reason: 'MARKETPLACE_UNAVAILABLE' };
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
        if (now - totalStuckStartedAt > 75_000) throw Error('FACEBOOK_BROWSE_ROUTE_TIMEOUT');
        const backoffMs = Math.min(30_000, 5_000 * Math.pow(2, recoverNavCount));
        if (now - stuckStartedAt >= backoffMs) {
          await safeNav(baseUrl);
          stuckStartedAt = Date.now();
          recoverNavCount = Math.min(4, recoverNavCount + 1);
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
        if (now - totalStuckStartedAt > 90_000) throw Error('FACEBOOK_BROWSE_BLOCKED_TIMEOUT');
        const blockedBackoffMs = Math.min(30_000, 15_000 + recoverNavCount * 10_000);
        if (now - stuckStartedAt >= blockedBackoffMs) {
          await safeNav(baseUrl);
          stuckStartedAt = Date.now();
          recoverNavCount = Math.min(4, recoverNavCount + 1);
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
      totalStuckStartedAt = now;
      recoverNavCount = 0;
      const surfaceHealthy =
        spec.type === 'video'
          ? Boolean(page.video && !page.video.failed && !page.video.buffering && !page.video.paused)
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
      } else dwellObservations = Math.min(10, dwellObservations + 1);
      const dwell = now - dwellSince;
      if (spec.type === 'friends') {
        const isAdd = spec.friendAction === 'add_suggested';
        const btnCss = isAdd ? page.friendAddCSS : page.friendConfirmCSS;
        const expectedCss = isAdd ? FACEBOOK_FRIEND_ADD_CSS : FACEBOOK_FRIEND_CONFIRM_CSS;
        const beforeCount = isAdd
          ? (page.friendSuggestedCount ?? 0)
          : (page.friendPendingCount ?? 0);
        if (
          btnCss === expectedCss &&
          dwell >= Math.min(dwellTargetMs, 2500) &&
          consecutiveFailedFriends < 3
        ) {
          const risk = await checkRisk('active-friend');
          if (!risk.allowed) {
            diag('BROWSE_FRIEND_DAILY_LIMIT_SKIP', {
              level: 'INFO',
              reason: risk.reason ?? 'DAILY_RISK_LIMIT',
              data: { friendAction: spec.friendAction },
            });
            await flushProgress(true);
            return { kind: 'COMPLETED', progress: buildProgress() };
          }
          let friendClickOk = true;
          await clickSelector(lease, isAdd ? 'friend-add' : 'friend-confirm', expectedCss).catch(
            () => {
              friendClickOk = false;
            },
          );
          let friendVerified = false;
          if (friendClickOk) {
            for (const waitMs of [900, 900]) {
              await sleepAbortable(waitMs, lease.signal);
              const afterFriend = await readBrowsePageSafely(lease);
              if (!afterFriend) continue;
              const afterBtnCss = isAdd ? afterFriend.friendAddCSS : afterFriend.friendConfirmCSS;
              const afterCount = isAdd
                ? (afterFriend.friendSuggestedCount ?? 0)
                : (afterFriend.friendPendingCount ?? 0);
              if (
                afterFriend.contentKey !== page.contentKey ||
                afterBtnCss !== expectedCss ||
                afterCount < beforeCount
              ) {
                friendVerified = true;
                break;
              }
            }
          }
          if (friendVerified) {
            consecutiveFailedFriends = 0;
            accepted =
              spec.acceptMode === 'count' ? Math.min(spec.maxAccepts, accepted + 1) : accepted + 1;
            await flushProgress(true);
            if (spec.acceptMode === 'count' && accepted >= spec.maxAccepts)
              return { kind: 'COMPLETED', progress: buildProgress() };
          } else {
            consecutiveFailedFriends += 1;
            diag('BROWSE_FRIEND_ACTION_UNVERIFIED', {
              level: 'WARN',
              reason: friendClickOk ? 'POST_CLICK_STATE_UNCHANGED' : 'CLICK_FAILED',
              data: { friendAction: spec.friendAction, beforeCount, consecutiveFailedFriends },
            });
            if (consecutiveFailedFriends >= 3) {
              diag('BROWSE_FRIENDS_ENDED_EARLY', {
                level: 'WARN',
                reason: 'CONSECUTIVE_FRIEND_FAILURES',
                data: { accepted, consecutiveFailedFriends },
              });
              await flushProgress(true);
              return { kind: 'COMPLETED', progress: buildProgress() };
            }
            await lease.execOp('friend-scroll-recover', async () => {
              await lease.page.mouse
                .wheel(0, 260 + Math.floor(Math.random() * 140))
                .catch(() => {});
            });
          }
          dwellContentId = '';
          await sleepAbortable(900, lease.signal);
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
          const itemDwellTarget =
            page.recommendedDwellMs ?? 4_500 + Math.floor(Math.random() * 5_500);
          if (dwell >= itemDwellTarget) {
            await navAndSleep(baseUrl, 850 + Math.floor(Math.random() * 700));
            continue;
          }
        } else {
          const candidates = (page.marketplaceItems ?? []).filter(
            (item) =>
              facebookMarketplaceItemURL(item) === item && !viewedMarketplaceItems.has(item),
          );
          const listDwellTarget =
            page.recommendedDwellMs ?? 3_500 + Math.floor(Math.random() * 4_000);
          if (candidates.length > 0 && dwell >= listDwellTarget) {
            const nextItem = candidates[Math.floor(Math.random() * candidates.length)];
            if (nextItem) {
              await navAndSleep(nextItem, 900 + Math.floor(Math.random() * 700));
              continue;
            }
          }
        }
      }
      if (
        !browserLikeLimited &&
        (spec.type === 'feed' || spec.type === 'video') &&
        spec.maxLikes > 0 &&
        likes < spec.maxLikes &&
        dwell >=
          Math.min(Math.round(dwellTargetMs * 0.5), 1400 + Math.floor(Math.random() * 600)) &&
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
          if (likeSkipCandidatesRemaining > 0) likeSkipCandidatesRemaining -= 1;
          else if (now >= likeCooldownUntil && now - lastLikeAt >= nextLikeGapMs) {
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
              const cap = await checkRisk('active-like');
              if (!cap.allowed) {
                browserLikeLimited = true;
                diag('BROWSE_LIKE_DAILY_LIMIT_SKIP', { reason: cap.reason ?? undefined });
              } else {
                lastLikeAt = now;
                nextLikeGapMs = 6_500 + Math.floor(Math.random() * 5_500);
                let clickErr: string | null = null;
                await clickSelector(lease, 'browse-like', FACEBOOK_BROWSE_LIKE_CSS, {
                  skipScrollIntoView: spec.type === 'video',
                }).catch((err) => {
                  clickErr = err instanceof Error ? err.message : String(err ?? '');
                });
                let after: BrowsePage | null = null;
                let verified = false;
                if (!clickErr) {
                  for (const pollMs of [900, 850, 850]) {
                    await sleepAbortable(pollMs, lease.signal);
                    after = await readBrowsePageSafely(lease);
                    verified =
                      after?.likeTarget?.liked === true ||
                      Boolean(after?.likeTarget && after.likeTarget.likeCount > target.likeCount);
                    if (verified) break;
                  }
                } else {
                  await sleepAbortable(600, lease.signal);
                  after = await readBrowsePageSafely(lease);
                  verified =
                    after?.likeTarget?.liked === true ||
                    Boolean(after?.likeTarget && after.likeTarget.likeCount > target.likeCount);
                }
                if (verified) {
                  await store.tasks.recordAccountLike(lease.accountId, contentId);
                  likes += 1;
                  consecutiveFailedLikes = 0;
                  diag('BROWSE_LIKE_CONFIRMED', {
                    data: { likes, maxLikes: spec.maxLikes, observedLikeCount: target.likeCount },
                  });
                  await flushProgress(true);
                } else {
                  consecutiveFailedLikes += 1;
                  diag('BROWSE_LIKE_UNVERIFIED', {
                    level: 'WARN',
                    reason: clickErr ?? 'POST_CLICK_STATE_UNCHANGED',
                    data: {
                      beforeLiked: target.liked,
                      beforeLikeCount: target.likeCount,
                      afterLiked: after?.likeTarget?.liked ?? null,
                      afterLikeCount: after?.likeTarget?.likeCount ?? null,
                      afterHasLikeTarget: Boolean(after?.likeTarget),
                      afterHasVideo: Boolean(after?.video),
                      afterVisibleVideos: after?.structure?.visibleVideos ?? null,
                      afterBlocked: after?.blocked ?? null,
                      afterUrl: after?.url ?? null,
                      afterContentKeySame: after ? after.contentKey === page.contentKey : null,
                      consecutiveFailedLikes,
                    },
                  });
                  if (consecutiveFailedLikes >= 3) {
                    likeCooldownUntil = Date.now() + 60_000;
                    likeSkipCandidatesRemaining = 2;
                    consecutiveFailedLikes = 0;
                    diag('BROWSE_LIKE_COOLDOWN', {
                      level: 'WARN',
                      reason: 'CONSECUTIVE_LIKE_FAILURES',
                      data: { cooldownMs: 60_000, skipCandidates: 2 },
                    });
                  }
                }
                continue;
              }
            }
          }
        }
      }
      if (spec.type === 'video' && page.video && (page.video.ended || dwell >= dwellTargetMs)) {
        if (page.scrollY >= 28_000) {
          await safeNav('https://www.facebook.com/reels/');
        } else if (page.nextReelCSS === FACEBOOK_REEL_NEXT_CSS) {
          await clickSelector(lease, 'next-reel', FACEBOOK_REEL_NEXT_CSS).catch(() => {});
        } else {
          const stuckAtSameReel =
            lastReelScrollCheckKey === contentId && Math.abs(lastReelScrollY - page.scrollY) < 20;
          lastReelScrollCheckKey = contentId;
          lastReelScrollY = page.scrollY;
          const reelDelta =
            (page.nextScrollDeltaY ?? 600) + Math.round((Math.random() - 0.5) * 140);
          await lease.execOp('reel-scroll', async () => {
            const vp = lease.page.viewportSize();
            await lease.page.mouse
              .move(
                Math.round((vp?.width ?? 1280) / 2),
                Math.round((vp?.height ?? page.viewportHeight) / 2),
              )
              .catch(() => {});
            await lease.page.mouse.wheel(0, reelDelta).catch((err) => {
              if (!isTransientContextError(err)) throw err;
            });
            if (stuckAtSameReel) await lease.page.keyboard.press('ArrowDown').catch(() => {});
          });
        }
        dwellContentId = '';
        await sleepAbortable(900 + Math.floor(Math.random() * 600), lease.signal);
        continue;
      }
      if (spec.type !== 'video' && dwell >= dwellTargetMs) {
        const baseDelta =
          page.nextScrollDeltaY ??
          Math.max(180, Math.min(1080, Math.floor(page.viewportHeight * 0.78)));
        const delta = Math.max(140, Math.round(baseDelta * (0.82 + Math.random() * 0.36)));
        await lease.execOp('browse-scroll', async () => {
          const beforeY = await lease.page.evaluate(() => window.scrollY).catch(() => 0);
          await lease.page.mouse.wheel(0, delta).catch((err) => {
            if (!isTransientContextError(err)) throw err;
          });
          const afterY = await lease.page.evaluate(() => window.scrollY).catch(() => 0);
          if (Math.abs(afterY - beforeY) < 40) {
            await lease.page
              .evaluate((dy) => {
                const beforeWin = window.scrollY;
                window.scrollBy(0, dy);
                if (Math.abs(window.scrollY - beforeWin) >= 40) return;
                const main = document.querySelector<HTMLElement>('main, [role="main"]');
                const candidates = main
                  ? [main, ...Array.from(main.querySelectorAll<HTMLElement>('div')).slice(0, 120)]
                  : [];
                const scroller = candidates.find(
                  (el) =>
                    el.scrollHeight > el.clientHeight + 20 &&
                    /auto|scroll/.test(getComputedStyle(el).overflowY),
                );
                if (scroller) scroller.scrollTop += dy;
              }, delta)
              .catch(() => {});
          }
        });
        dwellContentId = '';
        await sleepAbortable(800 + Math.floor(Math.random() * 600), lease.signal);
        continue;
      }
      if (spec.type === 'video' && !page.video && page.videoEntry && page.videoEntry !== page.url)
        await safeNav(page.videoEntry);
      await sleepAbortable(900 + Math.floor(Math.random() * 650), lease.signal);
    }
    return { kind: 'COMPLETED', progress: buildProgress() };
  } finally {
    await flushProgress(true);
  }
}
