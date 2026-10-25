import type { PageProjection } from '../shared/page-read.js';
import { kernelFacebookReadURL } from '../shared/kernel-policy.js';
import {
  FACEBOOK_UI_COPY,
  FACEBOOK_COMPOSER_SCOPE,
  FACEBOOK_COMPOSER_TEXT,
  FACEBOOK_COMPOSER_FILES,
  FACEBOOK_COMPOSER_REVIEW_SUBMIT,
  FACEBOOK_REEL_MAIN,
  FACEBOOK_REEL_TEXT,
  facebookComposerPostSelector,
  facebookUILabelSelector,
  facebookComposerPostLabels,
  FACEBOOK_POST_SETTINGS_LABELS,
  FACEBOOK_REEL_EDIT_LABELS,
  FACEBOOK_REEL_SETTINGS_LABELS,
  facebookComposerAdvanceLabels,
  normalizeFacebookUILocale,
  facebookComposerAdvanceSelector,
  type FacebookUILocale,
} from '../shared/facebook-ui.js';

// Read-only candidate. Callers must independently prove purpose, current actor and original content.
// Hidden native file inputs are normal; their owner form/textbox must be unique and visible.
export function observeFacebookComposerSurface(page: PageProjection, locale?: FacebookUILocale) {
  locale = normalizeFacebookUILocale(locale);
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
      !profileRoute ||
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
  if (reviews.length) {
    const unique = (key: string, visible: boolean) =>
      nodes(key).length === 1 && (!visible || nodes(key)[0]?.visible);
    if (
      !profileRoute ||
      !unique('composerDialogs', true) ||
      !unique('composerForms', true) ||
      !unique('composerTextboxes', false) ||
      !unique('composerAllFiles', false) ||
      !unique('composerMediaFiles', false) ||
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
  const allFiles = nodes('composerAllFiles'),
    mediaFiles = nodes('composerMediaFiles');
  if (
    allFiles.length !== 1 ||
    mediaFiles.length !== 1 ||
    allFiles[0]?.tag !== 'input' ||
    mediaFiles[0]?.tag !== 'input'
  )
    return null;
  const submits = nodes('composerSubmits'),
    copy = FACEBOOK_UI_COPY.find((item) => item.locale === locale);
  const submitLabel = submits[0]?.attributes['aria-label'];
  const disabled = nodes('composerDisabledActions');
  const enabled = (label: string) =>
    page.rows.some((row) => row.key === 'composerDisabledActions') &&
    !disabled.some((node) => node.attributes['aria-label'] === label);
  const submit =
    copy &&
    submits.length === 1 &&
    submits[0]?.visible &&
    typeof submitLabel === 'string' &&
    facebookComposerPostLabels(copy.locale).includes(submitLabel)
      ? {
          scope: FACEBOOK_COMPOSER_SCOPE,
          css: facebookComposerPostSelector(copy.locale),
          enabled: enabled(submitLabel),
        }
      : null;
  const advances = nodes('composerAdvances'),
    advanceLabels = facebookComposerAdvanceLabels(locale),
    advanceCSS = locale ? facebookComposerAdvanceSelector(locale) : null;
  const advance =
    advanceLabels.length > 0 &&
    advanceCSS &&
    advances.length === 1 &&
    advances[0]?.visible &&
    advanceLabels.includes(advances[0].attributes['aria-label'] ?? '')
      ? {
          scope: FACEBOOK_COMPOSER_SCOPE,
          css: advanceCSS,
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
