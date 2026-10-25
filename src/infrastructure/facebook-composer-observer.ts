import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import { facebookComposerProjection } from './facebook-read-adapter.js';
import { projectPage } from '../shared/page-projection.js';
import { validateProjection } from '../shared/page-read.js';
import { observeFacebookComposerSurface } from '../domain/facebook-composer-analysis.js';
import {
  FACEBOOK_UI_COPY,
  normalizeFacebookUILocale,
  type FacebookUILocale,
} from '../shared/facebook-ui.js';
import type { Action } from '../shared/browser-actions.js';
import type { PostIntent } from '../shared/material-index.js';
import type { PostLink } from '../shared/material-post.js';
import { readFacebookReviewContent } from './facebook-review-reader.js';
import { readFacebookReelContent } from './facebook-reel-reader.js';
import { readFacebookComposerAudience } from './facebook-composer-audience.js';
import { audienceTarget } from '../domain/facebook-audience.js';
import { requiresNativePostBackground, validatePostAction } from '../domain/material-post.js';
import { readFacebookBackground } from './facebook-background-reader.js';
import { facebookBackgroundScope } from '../shared/facebook-background.js';

export interface FacebookPostComposerObserver {
  assertRelease?(
    page: Page,
    action: Action,
    post: { intent: PostIntent; link: PostLink },
    assertCurrent: () => Awaitable<void>,
  ): Promise<void>;
  assert(
    page: Page,
    action: Action,
    post: { intent: PostIntent; link: PostLink },
    assertCurrent: () => Awaitable<void>,
    knownLocale?: FacebookUILocale,
  ): Promise<void>;
}

// Additional input-target check on the original owned SDK page. This does not grant identity,
// permission, upload readiness or a publication verdict; those remain independent checks.
export class FacebookComposerObserver implements FacebookPostComposerObserver {
  constructor(
    private readonly currentLocale?: () => FacebookUILocale | undefined,
    private readonly isStory: (post: {
      intent: PostIntent;
      link: PostLink;
    }) => Awaitable<boolean> = () => false,
    private readonly story?: FacebookPostComposerObserver,
  ) {}
  async assertRelease(
    _page: Page,
    action: Action,
    post: { intent: PostIntent; link: PostLink },
    guard: () => Awaitable<void>,
  ) {
    await guard();
    validateReleasePurpose(post.link.purpose);
    validatePostAction(post.intent, post.link.purpose, action);
    if (action.kind !== 'click') throw Error('POST_SETTINGS_RELEASE_ACTION_REQUIRED');
    await guard();
  }
  async assert(
    page: Page,
    action: Action,
    post: { intent: PostIntent; link: PostLink },
    assertCurrent: () => Awaitable<void>,
    knownLocale?: FacebookUILocale,
  ) {
    if (await this.isStory(post)) {
      if (!this.story) throw Error('STORY_COMPOSER_OBSERVER_REQUIRED');
      await this.story.assert(page, action, post, assertCurrent);
      await assertCurrent();
      return;
    }
    const purpose = post.link.purpose;
    if (purpose === 'PREPARE_HOME' || purpose === 'OPEN_COMPOSER' || purpose === 'PREPARE_MEDIA')
      return;
    await assertCurrent();
    if (purpose === 'OPEN_BACKGROUND' || purpose === 'SET_BACKGROUND') {
      const background = await readFacebookBackground(page, assertCurrent);
      await assertCurrent();
      const css =
        purpose === 'OPEN_BACKGROUND'
          ? [background.openCSS]
          : requiresNativePostBackground(post.intent)
            ? background.options.map((option) => option.css)
            : [background.clearCSS];
      if (
        !background.ready ||
        !background.visible ||
        !background.draftEmpty ||
        action.kind !== 'click' ||
        action.target.scope !== facebookBackgroundScope ||
        !css.includes(action.target.css) ||
        action.target.text !== undefined
      )
        throw Error('POST_BACKGROUND_ACTION_UNCONFIRMED');
      return;
    }
    if (
      purpose === 'OPEN_AUDIENCE' ||
      purpose === 'SELECT_SELF' ||
      purpose === 'CONFIRM_AUDIENCE'
    ) {
      const reading = await readFacebookComposerAudience(page, assertCurrent);
      await assertCurrent();
      const target = audienceTarget(reading, purpose);
      if (
        !target ||
        action.kind !== 'click' ||
        action.target.scope !== target.scope ||
        action.target.css !== target.css ||
        action.target.text !== target.text
      )
        throw Error('POST_AUDIENCE_ACTION_UNCONFIRMED');
      return;
    }
    const projection = validateProjection(
      facebookComposerProjection,
      await page.evaluate(projectPage, facebookComposerProjection),
    );
    await assertCurrent();
    const dialogLabel = projection.rows.find((row) => row.key === 'composerDialogs')?.nodes[0]
      ?.attributes['aria-label'];
    const observedLocale = FACEBOOK_UI_COPY.find((copy) => copy.region === dialogLabel)?.locale;
    const currentLocale = knownLocale ?? this.currentLocale?.();
    if (
      dialogLabel &&
      (!observedLocale ||
        (currentLocale && normalizeFacebookUILocale(currentLocale) !== observedLocale))
    )
      throw Error('FACEBOOK_COMPOSER_LOCALE_CONFLICT');
    const locale = observedLocale ?? currentLocale;
    const surface = observeFacebookComposerSurface(projection, locale);
    if (!surface || surface.phase === 'ambiguous')
      throw Error('FACEBOOK_COMPOSER_TARGET_UNVERIFIED');
    if (requiresNativePostBackground(post.intent)) {
      const background = await readFacebookBackground(page, assertCurrent);
      await assertCurrent();
      if (
        !background.ready ||
        !background.visible ||
        background.phase !== 'solid' ||
        background.url !== projection.url ||
        background.timeOrigin !== projection.timeOrigin
      )
        throw Error('POST_BACKGROUND_UNCONFIRMED');
    }
    if (
      surface.phase === 'reel-edit-before-review' ||
      surface.phase === 'reel-review-before-submit'
    ) {
      const expected = surface.phase === 'reel-edit-before-review' ? 'ADVANCE_COMPOSER' : 'SUBMIT';
      if (purpose !== expected || post.intent.snapshot.format !== 'video')
        throw Error('FACEBOOK_COMPOSER_ACTION_OR_PHASE_MISMATCH');
    }
    if (surface.phase === 'review-before-submit' && purpose !== 'SUBMIT')
      throw Error('FACEBOOK_COMPOSER_ACTION_OR_PHASE_MISMATCH');
    const target =
      purpose === 'SET_TEXT'
        ? { scope: surface.scope, css: surface.textCSS }
        : purpose === 'UPLOAD_MEDIA'
          ? { scope: surface.scope, css: surface.mediaCSS }
          : purpose === 'ADVANCE_COMPOSER'
            ? surface.advance
            : surface.submit;
    if (
      !target ||
      ('enabled' in target && !target.enabled) ||
      !('target' in action) ||
      action.target.scope !== target.scope ||
      action.target.css !== target.css ||
      action.target.text !== undefined
    )
      throw Error('FACEBOOK_COMPOSER_ACTION_OR_PHASE_MISMATCH');
    // Full original text, including newlines and Unicode, never the projection's 500-char preview.
    const text =
      surface.phase === 'reel-edit-before-review' || surface.phase === 'reel-review-before-submit'
        ? await (async () => {
            const reel = await readFacebookReelContent(page, assertCurrent);
            if (
              reel.phase !== surface.phase ||
              reel.url !== projection.url ||
              reel.timeOrigin !== projection.timeOrigin
            )
              throw Error('FACEBOOK_REEL_CONTENT_OR_DOCUMENT_UNVERIFIED');
            if (surface.phase === 'reel-review-before-submit' && !reel.composer)
              throw Error('FACEBOOK_REEL_CONTENT_OR_DOCUMENT_UNVERIFIED');
            return reel.composer?.text ?? null;
          })()
        : surface.phase === 'review-before-submit'
          ? await (async () => {
              const review = await readFacebookReviewContent(page, assertCurrent);
              if (
                !review.composer ||
                review.url !== projection.url ||
                review.timeOrigin !== projection.timeOrigin
              )
                throw Error('FACEBOOK_REVIEW_CONTENT_OR_DOCUMENT_UNVERIFIED');
              return review.composer.text;
            })()
          : await page
              .locator(surface.scope)
              .locator(surface.textCSS)
              .evaluate(
                (element) => {
                  // A blank Lexical editable renders a layout newline. Do not trim actual original text.
                  const body = (element as HTMLElement).innerText;
                  return (element.textContent ?? '') === '' && !element.querySelector('img,video,a')
                    ? ''
                    : body;
                },
                undefined,
                { timeout: 5000 },
              );
    await assertCurrent();
    if (
      surface.phase === 'reel-edit-before-review'
        ? false
        : purpose === 'SET_TEXT'
          ? text !== '' && text !== post.intent.snapshot.text
          : text !== post.intent.snapshot.text
    )
      throw Error('FACEBOOK_COMPOSER_ORIGINAL_TEXT_MISMATCH');
  }
}

function validateReleasePurpose(purpose: PostLink['purpose']) {
  if (
    ![
      'OPEN_COMPOSER',
      'OPEN_AUDIENCE',
      'CONFIRM_AUDIENCE',
      'OPEN_BACKGROUND',
      'SET_BACKGROUND',
    ].includes(purpose)
  )
    throw Error('POST_SETTINGS_RELEASE_PURPOSE_REQUIRED');
}
