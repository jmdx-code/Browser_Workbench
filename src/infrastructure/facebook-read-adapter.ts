import { PageReadRequest } from '../shared/page-read.js';
import { FACEBOOK_PROFILE_CONTROL_LABELS } from '../shared/account-display.js';
import {
  FACEBOOK_UI_COPY,
  FACEBOOK_COMPOSER_SCOPE,
  FACEBOOK_COMPOSER_TEXT,
  FACEBOOK_COMPOSER_FILES,
  FACEBOOK_COMPOSER_REVIEW_SCOPE,
  FACEBOOK_REEL_SCOPE,
  FACEBOOK_COMPOSER_ADVANCE_COPY,
  facebookUILabelSelector,
  facebookComposerPostLabels,
} from '../shared/facebook-ui.js';

const loginForm = 'form:has(input[name="email"]):has(input[type="password"])';

// Page selectors are software-owned. Projection primitives remain generic in the extension.
export const facebookIdentityProjection = PageReadRequest.parse({
  queries: [
    {
      key: 'accountLinks',
      selector:
        '[role="banner"] a[href*="profile.php"], [role="navigation"] a[href*="profile.php"], [role="banner"] a[href="/me/"]',
      limit: 8,
      text: true,
      attributes: ['href', 'aria-label'],
    },
    {
      key: 'accountControls',
      selector: '[role="banner"] [role="button"][aria-label]',
      limit: 8,
      text: false,
      attributes: ['aria-label', 'role', 'data-testid'],
    },
    {
      key: 'accountAvatars',
      selector: '[role="banner"] img, [role="navigation"] a[href*="profile.php"] img',
      limit: 8,
      text: false,
      attributes: ['src', 'alt'],
    },
    {
      key: 'loginForm',
      selector: loginForm,
      limit: 2,
      text: false,
      attributes: [],
    },
    {
      key: 'loginEmail',
      selector: loginForm + ' input[name="email"]',
      limit: 1,
      text: false,
      attributes: [],
    },
    {
      key: 'loginPassword',
      selector: loginForm + ' input[type="password"]',
      limit: 1,
      text: false,
      attributes: [],
    },
  ],
});

// Exact supported labels; no broad banner images, menu clicks, globals or profile adoption.
const ownProfileControl =
  '[role="banner"] [role="button"]' + facebookUILabelSelector(FACEBOOK_PROFILE_CONTROL_LABELS);
const homeComposer =
  '[role="region"]' + facebookUILabelSelector(FACEBOOK_UI_COPY.map((copy) => copy.region));
export const facebookDisplayInspectionProjection = PageReadRequest.parse({
  queries: [
    ...facebookIdentityProjection.queries,
    {
      key: 'homeComposers',
      selector: homeComposer,
      limit: 2,
      text: false,
      attributes: ['aria-label'],
    },
    {
      key: 'composerProfileLinks',
      selector: homeComposer + ' a[role="link"][aria-label]',
      limit: 2,
      text: false,
      attributes: ['href', 'aria-label'],
    },
    {
      key: 'composerPrompts',
      selector: homeComposer + ' [role="button"]:not([aria-label])',
      limit: 2,
      text: true,
      attributes: [],
    },
    {
      key: 'ownProfileControls',
      selector: ownProfileControl,
      limit: 2,
      text: false,
      attributes: ['aria-label'],
    },
    {
      key: 'ownProfileImages',
      selector: ownProfileControl + ' :is(image, img)',
      limit: 2,
      text: false,
      attributes: ['href', 'xlink:href', 'src'],
    },
  ],
});

// Same declarative protocol as 0.3.7. Semantic structure has no locale, coordinates or classes.
// These are diagnostic observations; a composer-shaped dialog alone is not a post authority.
export const facebookComposerProjection = PageReadRequest.parse({
  queries: [
    ...facebookIdentityProjection.queries.filter((query) => query.key === 'loginForm'),
    {
      key: 'composerDialogs',
      selector: FACEBOOK_COMPOSER_SCOPE,
      limit: 2,
      text: false,
      attributes: ['aria-label'],
    },
    {
      key: 'composerForms',
      selector: FACEBOOK_COMPOSER_SCOPE + ' form',
      limit: 2,
      text: false,
      attributes: [],
    },
    {
      key: 'composerTextboxes',
      selector: FACEBOOK_COMPOSER_SCOPE + ' ' + FACEBOOK_COMPOSER_TEXT,
      limit: 2,
      text: false,
      attributes: ['aria-label'],
    },
    {
      key: 'composerAllFiles',
      selector: FACEBOOK_COMPOSER_SCOPE + ' input[type="file"]',
      limit: 2,
      text: false,
      attributes: [],
    },
    {
      key: 'composerMediaFiles',
      selector: FACEBOOK_COMPOSER_SCOPE + ' ' + FACEBOOK_COMPOSER_FILES,
      limit: 2,
      text: false,
      attributes: [],
    },
    {
      key: 'composerSubmits',
      selector:
        FACEBOOK_COMPOSER_SCOPE +
        ' [role="button"]' +
        facebookUILabelSelector(facebookComposerPostLabels()),
      limit: 2,
      text: false,
      attributes: ['aria-label'],
    },
    {
      key: 'composerAdvances',
      selector:
        FACEBOOK_COMPOSER_SCOPE +
        ' [role="button"]' +
        facebookUILabelSelector(FACEBOOK_COMPOSER_ADVANCE_COPY.map((copy) => copy.label)),
      limit: 2,
      text: false,
      attributes: ['aria-label'],
    },
    {
      key: 'composerDisabledActions',
      selector:
        FACEBOOK_COMPOSER_SCOPE +
        ' [role="button"]' +
        facebookUILabelSelector([
          ...facebookComposerPostLabels(),
          ...FACEBOOK_COMPOSER_ADVANCE_COPY.map((copy) => copy.label),
        ]) +
        ':is([aria-disabled="true"], [disabled])',
      limit: 2,
      text: false,
      attributes: ['aria-label'],
    },
    ...(
      [
        [
          'composerReviewDialogs',
          ':is(' + FACEBOOK_COMPOSER_REVIEW_SCOPE + ', ' + FACEBOOK_REEL_SCOPE + ')',
        ],
        [
          'composerReviewHeadings',
          ':is(' + FACEBOOK_COMPOSER_REVIEW_SCOPE + ', ' + FACEBOOK_REEL_SCOPE + ') h2',
        ],
        [
          'composerReviewSubmits',
          '[role="dialog"] [role="button"]' +
            facebookUILabelSelector([
              ...facebookComposerPostLabels(),
              ...FACEBOOK_COMPOSER_ADVANCE_COPY.map((copy) => copy.label),
            ]),
        ],
        [
          'composerReviewDisabled',
          '[role="dialog"] [role="button"]' +
            facebookUILabelSelector([
              ...facebookComposerPostLabels(),
              ...FACEBOOK_COMPOSER_ADVANCE_COPY.map((copy) => copy.label),
            ]) +
            ':is([aria-disabled="true"],[disabled])',
        ],
      ] as const
    ).map(([key, selector]) => ({
      key,
      selector: selector + ':not([aria-hidden="true"], [aria-hidden="true"] *)',
      limit: 2,
      text: key === 'composerReviewHeadings',
      attributes: ['aria-label'] as const,
    })),
  ],
});

export const facebookSelfProfileProjection = PageReadRequest.parse({
  queries: [
    ...facebookIdentityProjection.queries,
    {
      key: 'profileHeading',
      selector: 'h1',
      limit: 3,
      text: true,
      attributes: [],
    },
    {
      key: 'accountControlImages',
      selector:
        '[role="banner"] [role="button"][aria-label] image, [role="banner"] [role="button"][aria-label] img',
      limit: 8,
      text: false,
      attributes: ['href', 'src', 'alt'],
    },
  ],
});
