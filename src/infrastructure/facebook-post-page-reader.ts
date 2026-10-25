import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import {
  facebookComposerProjection,
  facebookDisplayInspectionProjection,
} from './facebook-read-adapter.js';
import { PageReadRequest, validateProjection } from '../shared/page-read.js';
import { projectPage } from '../shared/page-projection.js';
import { observeFacebookHomeName } from '../domain/facebook-name-analysis.js';
import { observeFacebookComposerSurface } from '../domain/facebook-composer-analysis.js';
import {
  FACEBOOK_UI_COPY,
  normalizeFacebookUILocale,
  facebookUILabelSelector,
  type FacebookUILocale,
} from '../shared/facebook-ui.js';
import { z } from 'zod';
import { readFacebookReviewContent } from './facebook-review-reader.js';
import { readFacebookReelContent } from './facebook-reel-reader.js';
import { readFacebookBackground } from './facebook-background-reader.js';

const request = PageReadRequest.parse({
  queries: [
    ...facebookDisplayInspectionProjection.queries,
    ...facebookComposerProjection.queries.filter((query) => query.key !== 'loginForm'),
  ],
});
const textResult = z
  .object({ url: z.string(), timeOrigin: z.number().finite(), text: z.string().max(100_000) })
  .strict();

// Reads the existing owned SDK page only. No navigation, menu click, page adoption or input.
export async function readFacebookPostPage(
  page: Page,
  previousLocale: FacebookUILocale | undefined,
  assertCurrent: () => Awaitable<void>,
) {
  await assertCurrent();
  const projection = validateProjection(request, await page.evaluate(projectPage, request));
  await assertCurrent();
  const name = observeFacebookHomeName(projection);
  const regionLabel = projection.rows.find((row) => row.key === 'homeComposers')?.nodes[0]
    ?.attributes['aria-label'];
  const homeCopy = name ? FACEBOOK_UI_COPY.find((copy) => copy.region === regionLabel) : undefined;
  const dialogLabel = projection.rows.find((row) => row.key === 'composerDialogs')?.nodes[0]
    ?.attributes['aria-label'];
  const dialogCopy = FACEBOOK_UI_COPY.find((copy) => copy.region === dialogLabel);
  if (
    dialogLabel &&
    (!dialogCopy ||
      (previousLocale && normalizeFacebookUILocale(previousLocale) !== dialogCopy.locale))
  )
    throw Error('FACEBOOK_COMPOSER_LOCALE_CONFLICT');
  const locale = homeCopy?.locale ?? dialogCopy?.locale ?? previousLocale;
  const surface = observeFacebookComposerSurface(projection, locale);
  let text: string | null = null;
  if (surface) {
    if (
      surface.phase === 'reel-edit-before-review' ||
      surface.phase === 'reel-review-before-submit'
    ) {
      const reel = await readFacebookReelContent(page, assertCurrent);
      if (
        reel.phase !== surface.phase ||
        reel.url !== projection.url ||
        reel.timeOrigin !== projection.timeOrigin ||
        (surface.phase === 'reel-review-before-submit' && !reel.composer)
      )
        throw Error('FACEBOOK_REEL_CONTENT_OR_DOCUMENT_UNVERIFIED');
      text = reel.composer?.text ?? null;
    } else if (surface.phase === 'review-before-submit') {
      const review = await readFacebookReviewContent(page, assertCurrent);
      if (
        !review.composer ||
        review.url !== projection.url ||
        review.timeOrigin !== projection.timeOrigin
      )
        throw Error('FACEBOOK_REVIEW_CONTENT_OR_DOCUMENT_UNVERIFIED');
      text = review.composer.text;
    } else {
      const body = textResult.parse(
        await page.evaluate(
          ({ scope, css }) => {
            const elements = document.querySelectorAll(scope + ' ' + css);
            if (elements.length !== 1 || !(elements[0] instanceof HTMLElement))
              throw Error('FACEBOOK_COMPOSER_TEXT_AMBIGUOUS');
            const element = elements[0];
            return {
              url: location.href,
              timeOrigin: performance.timeOrigin,
              text:
                (element.textContent ?? '') === '' && !element.querySelector('img,video,a')
                  ? ''
                  : element.innerText,
            };
          },
          { scope: surface.scope, css: surface.textCSS },
        ),
      );
      await assertCurrent();
      if (body.url !== projection.url || body.timeOrigin !== projection.timeOrigin)
        throw Error('FACEBOOK_POST_DOCUMENT_CHANGED');
      text = body.text;
    }
  }
  const background =
    surface && ['direct-submit', 'edit-before-review'].includes(surface.phase)
      ? await readFacebookBackground(page, assertCurrent)
      : undefined;
  await assertCurrent();
  if (
    background &&
    (background.url !== projection.url || background.timeOrigin !== projection.timeOrigin)
  )
    throw Error('POST_BACKGROUND_DOCUMENT_CHANGED');
  return {
    projection,
    locale,
    surface,
    text,
    ...(background ? { background } : {}),
    opener: homeCopy
      ? {
          scope: '[role="region"]' + facebookUILabelSelector([homeCopy.region]),
          css: '[role="button"]:not([aria-label])',
          text: projection.rows.find((row) => row.key === 'composerPrompts')?.nodes[0]?.text,
        }
      : null,
  };
}
