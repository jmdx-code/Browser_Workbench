import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { FacebookPostEffects } from '../shared/facebook-post-observation.js';

// Bounded DOM-only projection of the actual Chinese profile Reels stages. The editor does
// not display the original caption. Return null there rather than inventing it from a cache.
export function projectFacebookReelContent() {
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
    document.querySelectorAll(
      '[role="dialog"]:has([role="form"][aria-label]):not(:has([role="dialog"] [role="form"][aria-label]))',
    ),
  ).filter(visible);
  const root = roots.length === 1 ? roots[0] : undefined;
  let phase: 'reel-edit-before-review' | 'reel-review-before-submit' | null = null;
  let composer = null;
  if (root) {
    const headings = Array.from(root.querySelectorAll('h2')).filter(visible);
    const forms = Array.from(root.querySelectorAll('[role="form"][aria-label]')).filter(visible);
    const form = forms.length === 1 ? forms[0] : undefined;
    const main = form?.closest('[role="main"]');
    if (
      headings.length === 1 &&
      forms.length === 1 &&
      form &&
      main &&
      visible(main) &&
      root.contains(main)
    ) {
      const heading = headings[0]?.textContent;
      const nexts = Array.from(
        main.querySelectorAll(
          '[role="button"]:is([aria-label="下一页"],[aria-label="下一步"],[aria-label="下一頁"],[aria-label="Next"])',
        ),
      ).filter(visible);
      const submits = Array.from(
        main.querySelectorAll(
          '[role="button"]:is([aria-label="发帖"],[aria-label="发布"],[aria-label="發佈"],[aria-label="發文"],[aria-label="Post"])',
        ),
      ).filter(visible);
      if (
        ['编辑 Reels', '編輯 Reels', 'Edit reel', 'Edit Reels'].includes(heading ?? '') &&
        nexts.length === 1 &&
        submits.length === 0
      )
        phase = 'reel-edit-before-review';
      if (
        ['Reels 设置', 'Reels 設定', 'Reel settings', 'Reels settings'].includes(heading ?? '') &&
        submits.length === 1 &&
        nexts.length === 0
      ) {
        phase = 'reel-review-before-submit';
        const edits = Array.from(
          form.querySelectorAll('[role="textbox"][contenteditable="true"]'),
        ).filter(visible);
        const edit = edits.length === 1 ? edits[0] : undefined;
        if (edit instanceof HTMLElement) {
          const text =
            edit.textContent === '' && !edit.querySelector('img,video,a') ? '' : edit.innerText;
          if (text.length <= 100000)
            composer = {
              text,
              files: [],
              media: [],
              uploaded: false,
              busy: Array.from(
                main.querySelectorAll('[role="progressbar"],[aria-busy="true"]'),
              ).some(visible),
              submitEnabled:
                submits[0]?.getAttribute('aria-disabled') !== 'true' &&
                !submits[0]?.hasAttribute('disabled'),
            };
        }
      }
    }
  }
  return {
    url: location.href,
    timeOrigin: performance.timeOrigin,
    found: roots.length > 0,
    phase,
    composer,
  };
}
const reading = z
  .object({
    url: z.string().max(4096),
    timeOrigin: z.number().finite().nonnegative(),
    found: z.boolean(),
    phase: z.enum(['reel-edit-before-review', 'reel-review-before-submit']).nullable(),
    composer: FacebookPostEffects.shape.composer,
  })
  .strict();
export async function readFacebookReelContent(page: Page, guard: () => Awaitable<void>) {
  await guard();
  const value = reading.parse(await page.evaluate(projectFacebookReelContent));
  await guard();
  const url = new URL(value.url);
  if (
    url.origin !== 'https://www.facebook.com' ||
    (value.found &&
      (url.pathname !== '/profile.php' || !/^\d{1,30}$/.test(url.searchParams.get('id') ?? '')))
  )
    throw Error('FACEBOOK_REEL_ROUTE_UNVERIFIED');
  return value;
}
