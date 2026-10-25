import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import { z } from 'zod';

// Finite current empty-window structure for software adapter research. No feed, HTML,
// input values, remote URLs, page stores, credentials or execution authority is returned.
export function projectFacebookEmptySurface() {
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      !element.closest('[aria-hidden="true"]') &&
      getComputedStyle(element).visibility !== 'hidden'
    );
  };
  const roots = Array.from(
    document.querySelectorAll('[role="dialog"]:has([role="textbox"][contenteditable="true"])'),
  ).filter(visible);
  const root = roots.length === 1 ? roots[0] : undefined;
  const actions = root
    ? Array.from(root.querySelectorAll('[role="button"],button')).filter(visible)
    : [];
  return {
    url: location.href,
    timeOrigin: performance.timeOrigin,
    roots: roots.length,
    headings: root
      ? Array.from(root.querySelectorAll('h1,h2,[role="heading"]'))
          .filter(visible)
          .slice(0, 8)
          .map((element) => (element.textContent ?? '').slice(0, 200))
      : [],
    actions: actions.slice(0, 64).map((element) => ({
      label: element.getAttribute('aria-label')?.slice(0, 200) ?? null,
      text: (element.textContent ?? '').slice(0, 200),
      disabled:
        element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('disabled'),
    })),
    truncated: actions.length > 64,
  };
}
const reading = z
  .object({
    url: z.string().max(4096),
    timeOrigin: z.number().finite().nonnegative(),
    roots: z.number().int().nonnegative(),
    headings: z.array(z.string().max(200)).max(8),
    actions: z
      .array(
        z
          .object({
            label: z.string().max(200).nullable(),
            text: z.string().max(200),
            disabled: z.boolean(),
          })
          .strict(),
      )
      .max(64),
    truncated: z.boolean(),
  })
  .strict();
export async function readFacebookEmptySurface(page: Page, guard: () => Awaitable<void>) {
  await guard();
  const result = reading.parse(await page.evaluate(projectFacebookEmptySurface));
  await guard();
  const url = new URL(result.url);
  if (
    url.origin !== 'https://www.facebook.com' ||
    !(
      ['/', '/post/create'].includes(url.pathname) ||
      (url.pathname === '/profile.php' && /^\d{1,30}$/.test(url.searchParams.get('id') ?? ''))
    )
  )
    throw Error('FACEBOOK_EMPTY_SURFACE_ROUTE_UNVERIFIED');
  return result;
}
