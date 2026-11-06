import type { PageProjection } from '../shared/page-read.js';
import { kernelFacebookReadURL } from '../shared/kernel-policy.js';
import {
  FACEBOOK_COMPOSER_SCOPE,
  FACEBOOK_COMPOSER_TEXT,
  FACEBOOK_COMPOSER_FILES,
  FACEBOOK_COMPOSER_REVIEW_SUBMIT,
  FACEBOOK_REEL_MAIN,
  FACEBOOK_REEL_TEXT,
  facebookUILabelSelector,
  facebookComposerPostLabels,
  FACEBOOK_POST_SETTINGS_LABELS,
  FACEBOOK_REEL_EDIT_LABELS,
  FACEBOOK_REEL_SETTINGS_LABELS,
  facebookComposerAdvanceLabels,
  type FacebookUILocale,
} from '../shared/facebook-ui.js';

// Read-only candidate. Callers must independently prove purpose, current actor and original content.
// Hidden native file inputs are normal; their owner form/textbox must be unique and visible.
export function observeFacebookComposerSurface(page: PageProjection, _locale?: FacebookUILocale) {
  const url = kernelFacebookReadURL(page.url) ? new URL(page.url) : null;
  const profileRoute =
    url?.pathname === '/profile.php' && /^\d{1,30}$/.test(url.searchParams.get('id') ?? '');
  if (
    !url ||
    !(['/', '/post/create'].includes(url.pathname) || profileRoute) ||
    page.ready === 'loading'
  )
    return null;
  const nodes = (key: string) => page.rows.find((row) => row.key === key)?.nodes ?? [];
  if (nodes('loginForm').length) return null;
  const reviews = nodes('composerReviewDialogs');
  const heading = nodes('composerReviewHeadings');
  if (
    reviews.length &&
    heading.length === 1 &&
    [...FACEBOOK_REEL_EDIT_LABELS, ...FACEBOOK_REEL_SETTINGS_LABELS].some(
      (label) => label === (heading[0]?.text ?? ''),
    )
  ) {
    const unique = (key: string) => nodes(key).length === 1 && nodes(key)[0]?.visible;
    const editing = FACEBOOK_REEL_EDIT_LABELS.some((label) => label === heading[0]?.text);
    if (
      !unique('composerDialogs') ||
      !unique('composerForms') ||
      !unique('composerReviewDialogs') ||
      !unique('composerReviewHeadings') ||
      !unique('composerReviewSubmits') ||
      !(editing ? facebookComposerAdvanceLabels() : facebookComposerPostLabels()).includes(
        nodes('composerReviewSubmits')[0]?.attributes['aria-label'] ?? '',
      )
    )
      return null;
    return {
      scope: FACEBOOK_REEL_MAIN,
      textCSS: FACEBOOK_REEL_TEXT,
      mediaCSS: FACEBOOK_COMPOSER_FILES,
      submit: editing
        ? null
        : {
            scope: FACEBOOK_REEL_MAIN,
            css: FACEBOOK_COMPOSER_REVIEW_SUBMIT,
            enabled:
              page.rows.some((row) => row.key === 'composerReviewDisabled') &&
              nodes('composerReviewDisabled').length === 0,
          },
      advance: editing
        ? {
            scope: FACEBOOK_REEL_MAIN,
            css: '[role="button"]' + facebookUILabelSelector(facebookComposerAdvanceLabels()),
            enabled:
              page.rows.some((row) => row.key === 'composerReviewDisabled') &&
              nodes('composerReviewDisabled').length === 0,
          }
        : null,
      phase: editing
        ? ('reel-edit-before-review' as const)
        : ('reel-review-before-submit' as const),
      purposeVerified: false as const,
      actingIdentityVerified: false as const,
      contentVerified: false as const,
    };
  }
  if (
    reviews.length &&
    heading.length === 1 &&
    FACEBOOK_POST_SETTINGS_LABELS.some((label) => label === heading[0]?.text)
  ) {
    const unique = (key: string, visible: boolean) =>
      nodes(key).length === 1 && (!visible || nodes(key)[0]?.visible);
    if (
      !unique('composerDialogs', true) ||
      !unique('composerForms', true) ||
      !unique('composerTextboxes', false) ||
      !unique('composerReviewDialogs', true) ||
      !unique('composerReviewHeadings', true) ||
      !FACEBOOK_POST_SETTINGS_LABELS.some(
        (label) => label === nodes('composerReviewHeadings')[0]?.text,
      ) ||
      !unique('composerReviewSubmits', true) ||
      !facebookComposerPostLabels().includes(
        nodes('composerReviewSubmits')[0]?.attributes['aria-label'] ?? '',
      )
    )
      return null;
    return {
      scope: FACEBOOK_COMPOSER_SCOPE,
      textCSS: FACEBOOK_COMPOSER_TEXT,
      mediaCSS: FACEBOOK_COMPOSER_FILES,
      submit: {
        scope: FACEBOOK_COMPOSER_SCOPE,
        css: FACEBOOK_COMPOSER_REVIEW_SUBMIT,
        enabled:
          page.rows.some((row) => row.key === 'composerReviewDisabled') &&
          nodes('composerReviewDisabled').length === 0,
      },
      advance: null,
      phase: 'review-before-submit' as const,
      purposeVerified: false as const,
      actingIdentityVerified: false as const,
      contentVerified: false as const,
    };
  }
  for (const key of ['composerDialogs', 'composerForms', 'composerTextboxes']) {
    const row = nodes(key);
    if (row.length !== 1 || !row[0]?.visible) return null;
  }
  // Opening and typing do not require a file input. Upload readiness is checked
  // by the media adapter only when the configured post actually contains media.
  const submits = nodes('composerSubmits');
  const submitLabel = submits[0]?.attributes['aria-label'];
  const disabled = nodes('composerDisabledActions');
  const enabled = (label: string) =>
    page.rows.some((row) => row.key === 'composerDisabledActions') &&
    !disabled.some((node) => node.attributes['aria-label'] === label);
  const submit =
    submits.length === 1 &&
    submits[0]?.visible &&
    typeof submitLabel === 'string' &&
    facebookComposerPostLabels().includes(submitLabel)
      ? {
          scope: FACEBOOK_COMPOSER_SCOPE,
          css: '[role="button"]' + facebookUILabelSelector([submitLabel]),
          enabled: enabled(submitLabel),
        }
      : null;
  const advances = nodes('composerAdvances'),
    advanceLabels = facebookComposerAdvanceLabels();
  const advanceLabel = advances[0]?.attributes['aria-label'];
  const advance =
    advanceLabels.length > 0 &&
    advances.length === 1 &&
    advances[0]?.visible &&
    typeof advanceLabel === 'string' &&
    advanceLabels.includes(advanceLabel)
      ? {
          scope: FACEBOOK_COMPOSER_SCOPE,
          css: '[role="button"]' + facebookUILabelSelector([advanceLabel]),
          enabled: enabled(advances[0].attributes['aria-label'] ?? ''),
        }
      : null;
  // Two competing navigation actions do not define a usable phase. Never call Next a Submit.
  const phase =
    submits.length && advances.length
      ? ('ambiguous' as const)
      : advance
        ? ('edit-before-review' as const)
        : submit
          ? ('direct-submit' as const)
          : ('unclassified' as const);
  return {
    scope: FACEBOOK_COMPOSER_SCOPE,
    textCSS: FACEBOOK_COMPOSER_TEXT,
    mediaCSS: FACEBOOK_COMPOSER_FILES,
    submit,
    advance,
    phase,
    purposeVerified: false as const,
    actingIdentityVerified: false as const,
    contentVerified: false as const,
  };
}
