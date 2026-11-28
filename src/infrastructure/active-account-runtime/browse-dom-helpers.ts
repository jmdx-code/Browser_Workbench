import { sleepAbortable } from '../../application/workboard.js';
import type { Step } from '../../shared/contracts.js';
import {
  facebookSearchPagesURL,
  FACEBOOK_FRIENDS_REQUESTS_URL,
  FACEBOOK_FRIENDS_SUGGESTIONS_URL,
  MARKETPLACE_HOME,
} from '../../shared/facebook-browse-route.js';
import type { BrowserSessionLease } from '../browser-session-lease.js';
import { readFacebookBrowsePage, type BrowsePage } from '../facebook-browse-reader.js';
export async function revealBrowseControl(
  page: BrowserSessionLease['page'],
  selector: string,
  extraNudgePx = 0,
): Promise<boolean> {
  return page
    .locator(selector)
    .first()
    .evaluate((el, nudge) => {
      if (!(el instanceof HTMLElement)) return false;
      const banner = document.querySelector<HTMLElement>('[role="banner"]');
      const bannerBottom = banner
        ? Math.max(56, Math.min(120, Math.round(banner.getBoundingClientRect().bottom)))
        : 60;
      const minTop = bannerBottom + 8;
      const maxBottom = window.innerHeight - 16;
      const rect = el.getBoundingClientRect();
      const cx = Math.round(rect.left + rect.width / 2);
      const cy = Math.round(rect.top + rect.height / 2);
      const hit =
        cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight
          ? document.elementFromPoint(cx, cy)
          : null;
      const occluded = Boolean(hit && hit !== el && !el.contains(hit) && !hit.contains(el));
      if (rect.top >= minTop && rect.bottom <= maxBottom && !occluded && nudge === 0) return false;
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r2 = el.getBoundingClientRect();
      let dy = 0;
      if (r2.top < minTop) dy = r2.top - minTop - 16;
      else if (r2.bottom > maxBottom) dy = r2.bottom - maxBottom + 16;
      else if (nudge !== 0)
        dy = r2.top < window.innerHeight * 0.45 ? -Math.abs(nudge) : Math.abs(nudge);
      if (dy !== 0) window.scrollBy(0, dy);
      return true;
    }, extraNudgePx)
    .catch(() => false);
}
export async function clickSelector(
  lease: BrowserSessionLease,
  label: string,
  selector: string,
  options?: { skipScrollIntoView?: boolean },
): Promise<void> {
  await lease.execOp(label, async () => {
    const loc = lease.page.locator(selector).first();
    if (options?.skipScrollIntoView) {
      const hitPoint = await loc
        .evaluate((el) => {
          if (!(el instanceof HTMLElement)) return null;
          const r = el.getBoundingClientRect();
          if (
            r.width <= 0 ||
            r.height <= 0 ||
            r.top < 0 ||
            r.bottom > window.innerHeight ||
            r.left < 0 ||
            r.right > window.innerWidth
          )
            return null;
          const cx = Math.round(r.left + r.width / 2);
          const cy = Math.round(r.top + r.height / 2);
          if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) return null;
          const hit = document.elementFromPoint(cx, cy);
          if (!hit || (hit !== el && !el.contains(hit) && !hit.contains(el))) return null;
          return { cx, cy };
        })
        .catch(() => null);
      if (!hitPoint) throw Error('FACEBOOK_BROWSE_LIKE_TARGET_CHANGED');
      await lease.page.mouse.move(hitPoint.cx, hitPoint.cy);
      await lease.page.mouse.click(hitPoint.cx, hitPoint.cy);
      return;
    }
    await revealBrowseControl(lease.page, selector, 0);
    try {
      await loc.click({ timeout: 5_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err ?? '');
      if (!/timeout|intercept|outside.*viewport|obscures|not visible/i.test(msg)) throw err;
      await revealBrowseControl(lease.page, selector, 140);
      await sleepAbortable(150, lease.signal);
      await loc.click({ timeout: 5_000 });
    }
  });
}
export function defaultBrowseUrl(spec: Step): string {
  if (spec.type === 'marketplace') return MARKETPLACE_HOME;
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
export async function navigateBrowseUrl(
  lease: BrowserSessionLease,
  targetUrl: string,
): Promise<void> {
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
export async function readBrowsePageSafely(lease: BrowserSessionLease): Promise<BrowsePage | null> {
  try {
    return await readFacebookBrowsePage(lease.page, lease.guard);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    if (/Execution context was destroyed|Cannot find context|Target.*closed/i.test(msg))
      return null;
    throw err;
  }
}
