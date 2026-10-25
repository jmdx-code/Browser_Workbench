import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import { z } from 'zod';

// The exact Chinese privacy label and SELF text were captured in the authorized Reels DOM;
// the standard editor uses that same privacy control (public variant observed on Maw Htwe).
// Standard SELF composition remains to be live-validated. This never changes privacy.
export function projectFacebookSubmissionAudience() {
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
    document.querySelectorAll(
      '[role="dialog"][aria-label="创建帖子"]:has([role="form"][aria-label="创建 Reels"])',
    ),
  ).filter(visible);
  const root = roots.length === 1 ? roots[0] : undefined;
  let audience: 'SELF' | null = null;
  const editors = Array.from(
    document.querySelectorAll('[role="dialog"]:has(form [role="textbox"][contenteditable="true"])'),
  ).filter(visible);
  const editor = editors.length === 1 ? editors[0] : undefined;
  if (editor) {
    const boxes = Array.from(
      editor.querySelectorAll('form [role="textbox"][contenteditable="true"]'),
    ).filter(visible);
    const controls = Array.from(
      editor.querySelectorAll(
        '[role="button"][aria-label^="编辑隐私设置。分享对象："],[role="button"][aria-label^="Edit privacy. Sharing with "]',
      ),
    ).filter(visible);
    const control = controls.length === 1 ? controls[0] : undefined;
    if (
      boxes.length === 1 &&
      ((control?.getAttribute('aria-label')?.trim() === '编辑隐私设置。分享对象：仅限自己。' &&
        control.textContent?.trim() === '仅限自己') ||
        (control?.getAttribute('aria-label')?.trim() === 'Edit privacy. Sharing with Only me.' &&
          control.textContent?.trim() === 'Only me')) &&
      control.getAttribute('aria-disabled') !== 'true' &&
      !control.hasAttribute('disabled')
    )
      audience = 'SELF';
  }
  if (root) {
    const forms = Array.from(
      root.querySelectorAll('[role="form"][aria-label="创建 Reels"]'),
    ).filter(visible);
    const main = forms.length === 1 ? forms[0]?.closest('[role="main"]') : undefined;
    const headings = Array.from(root.querySelectorAll('h2')).filter(visible);
    if (
      main &&
      root.contains(main) &&
      visible(main) &&
      headings.length === 1 &&
      headings[0]?.textContent === 'Reels 设置'
    ) {
      const controls = Array.from(main.querySelectorAll('[role="button"]')).filter(
        (element) => visible(element) && element.textContent?.startsWith('帖子分享对象'),
      );
      const control = controls.length === 1 ? controls[0] : undefined;
      if (
        control?.textContent === '帖子分享对象仅限自己' &&
        control.getAttribute('aria-disabled') !== 'true' &&
        !control.hasAttribute('disabled')
      )
        audience = 'SELF';
    }
  }
  return {
    url: location.href,
    timeOrigin: performance.timeOrigin,
    ready: document.readyState,
    audience,
  };
}
const reading = z
  .object({
    url: z.string().max(4096),
    timeOrigin: z.number().finite().nonnegative(),
    ready: z.enum(['loading', 'interactive', 'complete']),
    audience: z.literal('SELF').nullable(),
  })
  .strict();
export async function readFacebookSubmissionAudience(page: Page, guard: () => Awaitable<void>) {
  await guard();
  const result = reading.parse(await page.evaluate(projectFacebookSubmissionAudience));
  await guard();
  if (new URL(result.url).origin !== 'https://www.facebook.com')
    throw Error('SUBMISSION_AUDIENCE_ORIGIN');
  return result;
}
