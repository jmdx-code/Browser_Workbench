import { pageNodes } from './facebook-page-analysis.js';
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
const baseFlags = {
  purposeVerified: false as const,
  actingIdentityVerified: false as const,
  contentVerified: false as const,
};
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
  const nodes = (key: string) => pageNodes(page, key);
  if (nodes('loginForm').length) return null;
  const uniq = (key: string, visible = true) => {
    const rows = nodes(key);
    return rows.length === 1 && (!visible || rows[0]?.visible);
  };
  const reviews = nodes('composerReviewDialogs'),
    heading = nodes('composerReviewHeadings'),
    headingText = heading[0]?.text ?? '',
    reviewEnabled =
      page.rows.some((r) => r.key === 'composerReviewDisabled') &&
      !nodes('composerReviewDisabled').length,
    hasBase = () => uniq('composerDialogs') && uniq('composerForms'),
    hasReview = () =>
      hasBase() &&
      uniq('composerReviewDialogs') &&
      uniq('composerReviewHeadings') &&
      uniq('composerReviewSubmits'),
    reviewLabel = () => nodes('composerReviewSubmits')[0]?.attributes['aria-label'] ?? '',
    reviewRes = (
      scope: string,
      textCSS: string,
      phase: 'reel-edit-before-review' | 'reel-review-before-submit' | 'review-before-submit',
      editing = false,
    ) => ({
      scope,
      textCSS,
      mediaCSS: FACEBOOK_COMPOSER_FILES,
      submit: editing
        ? null
        : { scope, css: FACEBOOK_COMPOSER_REVIEW_SUBMIT, enabled: reviewEnabled },
      advance: editing
        ? {
            scope,
            css: '[role="button"]' + facebookUILabelSelector(facebookComposerAdvanceLabels()),
            enabled: reviewEnabled,
          }
        : null,
      phase,
      ...baseFlags,
    });
  const hasHeading = (labels: readonly string[]) => labels.includes(headingText);
  if (
    reviews.length &&
    heading.length === 1 &&
    (hasHeading(FACEBOOK_REEL_EDIT_LABELS) || hasHeading(FACEBOOK_REEL_SETTINGS_LABELS))
  ) {
    const editing = hasHeading(FACEBOOK_REEL_EDIT_LABELS),
      allowed = editing ? facebookComposerAdvanceLabels() : facebookComposerPostLabels();
    if (!hasReview() || !allowed.includes(reviewLabel())) return null;
    return reviewRes(
      FACEBOOK_REEL_MAIN,
      FACEBOOK_REEL_TEXT,
      editing ? 'reel-edit-before-review' : 'reel-review-before-submit',
      editing,
    );
  }
  if (reviews.length && heading.length === 1 && hasHeading(FACEBOOK_POST_SETTINGS_LABELS)) {
    if (
      !hasReview() ||
      !uniq('composerTextboxes', false) ||
      !facebookComposerPostLabels().includes(reviewLabel())
    )
      return null;
    return reviewRes(FACEBOOK_COMPOSER_SCOPE, FACEBOOK_COMPOSER_TEXT, 'review-before-submit');
  }
  if (!hasBase() || !uniq('composerTextboxes')) return null;
  const submits = nodes('composerSubmits'),
    disabled = nodes('composerDisabledActions'),
    hasDisabledRow = page.rows.some((row) => row.key === 'composerDisabledActions');
  const btn = (list: ReturnType<typeof nodes>, allowed: readonly string[]) => {
    const label = list[0]?.attributes['aria-label'];
    if (
      list.length !== 1 ||
      !list[0]?.visible ||
      typeof label !== 'string' ||
      !allowed.includes(label)
    )
      return null;
    return {
      scope: FACEBOOK_COMPOSER_SCOPE,
      css: '[role="button"]' + facebookUILabelSelector([label]),
      enabled: hasDisabledRow && !disabled.some((n) => n.attributes['aria-label'] === label),
    };
  };
  const submit = btn(submits, facebookComposerPostLabels()),
    advances = nodes('composerAdvances'),
    advanceLabels = facebookComposerAdvanceLabels(),
    advance = advanceLabels.length > 0 ? btn(advances, advanceLabels) : null;
  if (advance && submits[0]?.attributes['aria-label']) void submits[0].attributes['aria-label'];
  return {
    scope: FACEBOOK_COMPOSER_SCOPE,
    textCSS: FACEBOOK_COMPOSER_TEXT,
    mediaCSS: FACEBOOK_COMPOSER_FILES,
    submit,
    advance,
    phase:
      submits.length && advances.length
        ? ('ambiguous' as const)
        : advance
          ? ('edit-before-review' as const)
          : submit
            ? ('direct-submit' as const)
            : ('unclassified' as const),
    ...baseFlags,
  };
}
