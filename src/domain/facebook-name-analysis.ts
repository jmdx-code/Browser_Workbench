import type { PageProjection } from '../shared/page-read.js';
import { NameObservation, type ObservedName } from '../shared/account-display.js';
import { kernelFacebookReadURL } from '../shared/kernel-policy.js';
import { matchFacebookHomeCopy } from '../shared/facebook-ui.js';

// One scoped home region, timeline and matching localized prompt. No guessing on unknown copy.
// A profile ID/link is deliberately not returned or accepted as execution permission.
export function observeFacebookHomeName(page: PageProjection): ObservedName | null {
  if (
    !kernelFacebookReadURL(page.url) ||
    new URL(page.url).pathname !== '/' ||
    page.ready === 'loading'
  )
    return null;
  const nodes = (key: string) => page.rows.find((row) => row.key === key)?.nodes ?? [];
  if (nodes('loginForm').length) return null;
  const regions = nodes('homeComposers'),
    links = nodes('composerProfileLinks'),
    prompts = nodes('composerPrompts');
  if (regions.length !== 1 || links.length !== 1 || prompts.length !== 1) return null;
  const region = regions[0],
    link = links[0],
    prompt = prompts[0];
  if (!region?.visible || !link?.visible || link.tag.toLowerCase() !== 'a' || !prompt?.visible)
    return null;
  const matched = matchFacebookHomeCopy(
    region.attributes['aria-label'] ?? '',
    link.attributes['aria-label'] ?? '',
    prompt.text,
  );
  if (!matched) return null;
  const name = matched.name;
  try {
    const href = link.attributes.href;
    if (!href || /[\u0000-\u0020\u007f]/.test(href)) return null;
    const url = new URL(href, 'https://www.facebook.com/');
    if (
      url.origin !== 'https://www.facebook.com' ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== '/profile.php' ||
      !/^\d{1,30}$/.test(url.searchParams.get('id') ?? '') ||
      [...url.searchParams.keys()].some((key) => key !== 'id') ||
      url.searchParams.getAll('id').length !== 1
    )
      return null;
  } catch {
    return null;
  }
  const parsed = NameObservation.safeParse({
    source: 'facebook-home-composer',
    name,
    actingIdentityVerified: false,
  });
  return parsed.success ? parsed.data : null;
}
