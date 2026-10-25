import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';

export function facebookBrowseNavigationSelector(url: string): string | null {
  const href =
    url === 'https://www.facebook.com/'
      ? '/'
      : /^https:\/\/www\.facebook\.com\/(?:reels|watch)\/?$/.test(url)
        ? '/reel/?s=tab'
        : null;
  return href ? `[aria-label="Facebook"] a[role="link"][href="${href}"]` : null;
}

// This link is only selected by the original PREPARE_STORY purpose on the homepage.
export function facebookStoryNavigationSelector(url: string, previousUrl: string): string | null {
  return previousUrl === 'https://www.facebook.com/' &&
    [
      'https://www.facebook.com/stories/create/',
      'https://www.facebook.com/stories/create',
    ].includes(url)
    ? '[role="main"] a[role="link"][href="/stories/create/"]'
    : null;
}

export function projectFacebookBrowseNavigation(selector: string) {
  const links = Array.from(document.querySelectorAll(selector));
  const link = links.length === 1 ? links[0] : null;
  const box = link?.getBoundingClientRect();
  const style = link ? getComputedStyle(link) : null;
  const blocked = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]')).some(
    (element) => {
      const rect = element.getBoundingClientRect();
      const css = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < innerHeight &&
        rect.right > 0 &&
        rect.left < innerWidth &&
        css.visibility === 'visible' &&
        css.display !== 'none'
      );
    },
  );
  if (
    location.origin !== 'https://www.facebook.com' ||
    document.readyState === 'loading' ||
    document.visibilityState !== 'visible' ||
    !link ||
    link.closest('[aria-hidden="true"]') !== null ||
    !box ||
    box.width <= 0 ||
    box.height <= 0 ||
    style?.visibility !== 'visible' ||
    style.display === 'none' ||
    link.getAttribute('aria-disabled') === 'true' ||
    link.hasAttribute('disabled') ||
    blocked
  )
    return null;
  return {
    url: location.href,
    timeOrigin: performance.timeOrigin,
    href: link.getAttribute('href'),
  };
}

export async function readFacebookBrowseNavigation(
  page: Pick<Page, 'evaluate'>,
  selector: string,
  guard: () => Awaitable<void>,
) {
  await guard();
  const target = await page.evaluate(projectFacebookBrowseNavigation, selector);
  await guard();
  return target;
}
