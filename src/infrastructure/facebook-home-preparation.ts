import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { readFacebookBrowsePage } from './facebook-browse-reader.js';
import { facebookBrowseSurface } from '../shared/facebook-browse-route.js';

const DraftState = z
  .object({
    url: z.string(),
    timeOrigin: z.number().finite().nonnegative(),
    draftPresent: z.boolean(),
    emptyComposerOnlyDialog: z.boolean(),
  })
  .strict();

// Page preparation must not discard an inline comment, editor or selected attachment.
export async function readFacebookHomePreparation(page: Page, guard: () => Awaitable<void>) {
  await guard();
  const current = await readFacebookBrowsePage(page, guard);
  await guard();
  const draft = DraftState.parse(
    await page.evaluate(() => {
      const visible = (element: Element) => {
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          bounds.width > 0 &&
          bounds.height > 0 &&
          bounds.right > 0 &&
          bounds.bottom > 0 &&
          bounds.left < innerWidth &&
          bounds.top < innerHeight &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) !== 0
        );
      };
      const fields = Array.from(
        document.querySelectorAll('textarea,[contenteditable="true"],input[type="file"]'),
      );
      const draftPresent =
        fields.length > 100 ||
        fields.slice(0, 100).some((field) => {
          if (field instanceof HTMLInputElement) return (field.files?.length ?? 0) > 0;
          const bounds = field.getBoundingClientRect();
          const style = getComputedStyle(field);
          if (
            !bounds.width ||
            !bounds.height ||
            style.display === 'none' ||
            style.visibility === 'hidden'
          )
            return false;
          return (
            (field instanceof HTMLTextAreaElement
              ? field.value
              : (field.textContent ?? '')
            ).trim() !== ''
          );
        });
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible);
      const composerDialogs = Array.from(
        document.querySelectorAll(
          '[role="dialog"]:has(form [role="textbox"][contenteditable="true"])',
        ),
      ).filter(visible);
      const hasComposerMedia =
        composerDialogs.length === 1 &&
        composerDialogs[0] !== undefined &&
        Array.from(composerDialogs[0].querySelectorAll('img,video')).some(
          (media) =>
            (media instanceof HTMLImageElement && media.currentSrc.startsWith('blob:')) ||
            (media instanceof HTMLVideoElement && media.currentSrc !== ''),
        );
      return {
        url: location.href,
        timeOrigin: performance.timeOrigin,
        draftPresent,
        emptyComposerOnlyDialog:
          location.href === 'https://www.facebook.com/' &&
          dialogs.length === 1 &&
          composerDialogs.length === 1 &&
          dialogs[0] === composerDialogs[0] &&
          !hasComposerMedia &&
          !draftPresent,
      };
    }),
  );
  await guard();
  if (draft.url !== current.url || draft.timeOrigin !== current.timeOrigin)
    throw Error('POST_HOME_PREPARATION_DOCUMENT_CHANGED');
  return {
    page: current,
    reason: !current.visible
      ? ('FACEBOOK_BROWSE_FOREGROUND_REQUIRED' as const)
      : ('POST_HOME_PREPARATION_BLOCKED' as const),
    safe:
      facebookBrowseSurface(current.url) !== null &&
      current.ready &&
      current.visible &&
      (!current.blocked || draft.emptyComposerOnlyDialog) &&
      !draft.draftPresent,
  };
}
