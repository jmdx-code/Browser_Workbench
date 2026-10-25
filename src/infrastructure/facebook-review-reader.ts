import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { FacebookPostEffects } from '../shared/facebook-post-observation.js';

// Actual Chinese personal-profile Next stage. Only reads the original hidden editable and
// the visible preview belonging to the same outer form; no input, navigation or page stores.
export function projectFacebookReviewContent() {
  const visible = (e: Element) => {
    const r = e.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      !e.closest('[aria-hidden="true"]') &&
      getComputedStyle(e).visibility !== 'hidden'
    );
  };
  const roots = Array.from(
    document.querySelectorAll('[role="dialog"]:has(form [role="textbox"][contenteditable="true"])'),
  ).filter(visible);
  const reviews = Array.from(
    document.querySelectorAll(
      '[role="dialog"]:is([aria-label="帖子设置"],[aria-label="貼文設定"],[aria-label="Post settings"])',
    ),
  ).filter(visible);
  let composer = null;
  const root = roots.length === 1 ? roots[0] : undefined,
    review = reviews.length === 1 ? reviews[0] : undefined;
  if (root && review && root.contains(review)) {
    const forms = root.querySelectorAll('form'),
      edits = root.querySelectorAll('form [role="textbox"][contenteditable="true"]'),
      files = root.querySelectorAll('form input[type="file"]'),
      media = root.querySelectorAll(
        'form input[type="file"][multiple][accept*="image/"][accept*="video/"]',
      ),
      submits = Array.from(
        root.querySelectorAll(
          '[role="button"]:is([aria-label="发帖"],[aria-label="发布"],[aria-label="發佈"],[aria-label="發文"],[aria-label="Post"])',
        ),
      ).filter(visible),
      headings = Array.from(review.querySelectorAll('h2')).filter(visible),
      labels = Array.from(root.querySelectorAll('span[dir="auto"]')).filter(
        (e) => visible(e) && ['帖子预览', '貼文預覽', 'Post preview'].includes(e.textContent ?? ''),
      );
    const edit = edits[0],
      input = media[0],
      label = labels.length === 1 ? labels[0] : undefined;
    const previewChildren = label?.parentElement
      ? Array.from(label.parentElement.children).filter((e) => e !== label && e.tagName !== 'HR')
      : [];
    const preview = previewChildren.length === 1 ? previewChildren[0] : undefined;
    if (
      forms.length === 1 &&
      edits.length === 1 &&
      files.length === 1 &&
      media.length === 1 &&
      edit instanceof HTMLElement &&
      input instanceof HTMLInputElement &&
      headings.length === 1 &&
      ['帖子设置', '貼文設定', 'Post settings'].includes(headings[0]?.textContent ?? '') &&
      submits.length === 1 &&
      preview &&
      visible(preview) &&
      root.contains(preview)
    ) {
      const text =
        edit.textContent === '' && !edit.querySelector('img,video,a') ? '' : edit.innerText;
      const rendered = (s: string) => s.replace(/\s+/gu, ' ').trim();
      // The preview itself must contain the complete original caption; hidden draft text alone
      // cannot authorize the final button. Images' alt attributes do not invent extra caption.
      if (text.length <= 100000 && rendered(preview.textContent ?? '') === rendered(text))
        composer = {
          text,
          files: Array.from(input.files ?? [])
            .slice(0, 21)
            .map((f) => ({ name: f.name, size: f.size })),
          media: [],
          uploaded: false,
          busy: Array.from(
            root.querySelectorAll('[role="progressbar"],[role="alert"],[aria-busy="true"]'),
          ).some(visible),
          submitEnabled:
            submits[0]?.getAttribute('aria-disabled') !== 'true' &&
            !submits[0]?.hasAttribute('disabled'),
        };
    }
  }
  return {
    url: location.href,
    timeOrigin: performance.timeOrigin,
    found: reviews.length > 0,
    composer,
  };
}
const reading = z
  .object({
    url: z.string().max(4096),
    timeOrigin: z.number().finite().nonnegative(),
    found: z.boolean(),
    composer: FacebookPostEffects.shape.composer,
  })
  .strict();
export async function readFacebookReviewContent(page: Page, guard: () => Awaitable<void>) {
  await guard();
  const value = reading.parse(await page.evaluate(projectFacebookReviewContent));
  await guard();
  const url = new URL(value.url);
  if (
    url.origin !== 'https://www.facebook.com' ||
    (value.found &&
      (url.pathname !== '/profile.php' || !/^\d{1,30}$/.test(url.searchParams.get('id') ?? '')))
  )
    throw Error('FACEBOOK_REVIEW_ROUTE_UNVERIFIED');
  return value;
}
