import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import type { z } from 'zod';
import type { Spec } from '../shared/browser-actions.js';

type Target = z.infer<typeof Spec>;

// Read-only DOM probe. It never scrolls, changes focus, synthesizes DOM events or mutates visibility.
export function projectNativeClickTarget(input: { target: Target; url: string }) {
  if (
    location.origin !== 'https://www.facebook.com' ||
    location.href !== input.url ||
    document.readyState === 'loading' ||
    document.visibilityState !== 'visible'
  )
    return null;
  const roots = input.target.scope
    ? Array.from(document.querySelectorAll(input.target.scope))
    : [document];
  let nodes = [
    ...new Set(roots.flatMap((root) => Array.from(root.querySelectorAll(input.target.css)))),
  ];
  if (input.target.text !== undefined) {
    const text = input.target.text.replace(/\s+/g, ' ').trim();
    nodes = nodes.filter((element) => element.textContent?.replace(/\s+/g, ' ').trim() === text);
  }
  if (nodes.length !== 1) return null;
  const element = nodes[0];
  if (
    !element ||
    element.closest('[aria-hidden="true"],[inert]') ||
    element.matches(':disabled,[aria-disabled="true"]')
  )
    return null;
  for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0)
      return null;
  }
  const bounds = element.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const left = Math.max(0, bounds.left),
    right = Math.min(innerWidth, bounds.right);
  const top = Math.max(0, bounds.top),
    bottom = Math.min(innerHeight, bounds.bottom);
  const needsScroll = right <= left || bottom <= top;
  const x = (left + right) / 2,
    y = (top + bottom) / 2;
  const hit = needsScroll ? element : document.elementFromPoint(x, y);
  if (!hit || (hit !== element && !element.contains(hit))) return null;
  return {
    x,
    y,
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
    url: location.href,
    timeOrigin: performance.timeOrigin,
    needsScroll,
  };
}

// Two timed layout observations replace SDK rAF waits, while the original native
// per-command identity/operation guards and independent business observers remain in force.
export async function clickFacebookNativeTarget(
  page: Pick<Page, 'evaluate' | 'mouse'>,
  target: Target,
  url: string,
  guard: () => Awaitable<void>,
  options: {
    wait?: () => Promise<void>;
    attempts?: number;
    scrollFallback?: () => Promise<void>;
  } = {},
) {
  const wait = options.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
  const attempts = Math.min(300, Math.max(2, options.attempts ?? 200));
  let previous: Awaited<ReturnType<typeof projectNativeClickTarget>> = null;
  for (let index = 0; index < attempts; index++) {
    await guard();
    const point = await page.evaluate(projectNativeClickTarget, { target, url });
    await guard();
    if (!point) throw Error('FACEBOOK_NATIVE_CLICK_TARGET_UNAVAILABLE');
    if (point.needsScroll) {
      // Retain existing native SDK scrolling for offscreen controls. This fallback is
      // selected before any click, never after a timeout/uncertain native acknowledgement.
      if (!options.scrollFallback) throw Error('FACEBOOK_NATIVE_CLICK_REQUIRES_SCROLL');
      await guard();
      await options.scrollFallback();
      await guard();
      return;
    }
    const last = previous;
    if (
      last &&
      point.url === last.url &&
      point.timeOrigin === last.timeOrigin &&
      (['x', 'y', 'left', 'top', 'width', 'height'] as const).every(
        (key) => Math.abs(point[key] - last[key]) <= 0.5,
      )
    ) {
      // Exactly one native click; failure or an uncertain acknowledgement is never retried here.
      await page.mouse.click(point.x, point.y);
      await guard();
      return;
    }
    previous = point;
    await wait();
    await guard();
  }
  throw Error('FACEBOOK_NATIVE_CLICK_TARGET_UNSTABLE');
}
