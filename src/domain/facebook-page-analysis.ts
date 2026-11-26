import type { PageProjection } from '../shared/page-read.js';
import { kernelFacebookReadURL } from '../shared/kernel-policy.js';
import { FacebookNativeActor } from '../shared/facebook-native-identity.js';
import type { InspectedAccount } from './system-ports.js';
export const pageNodes = (page: PageProjection, key: string) =>
  page.rows.find((r) => r.key === key)?.nodes ?? [];
// Same owned, completed home document; native actor and creator must agree. Login/checkpoint findings take precedence.
export function inspectedFacebookAccount(page: PageProjection, input: unknown, now: number) {
  const analysis = analyzeFacebookIdentityPage(page),
    actor = FacebookNativeActor.safeParse(input),
    links = pageNodes(page, 'composerProfileLinks'),
    regions = pageNodes(page, 'homeComposers'),
    fallback = { account: analysis.account, reason: analysis.reason };
  if (
    analysis.account.state !== 'unknown' ||
    page.url !== 'https://www.facebook.com/' ||
    page.ready !== 'complete' ||
    !actor.success ||
    now < actor.data.checkedAt ||
    now - actor.data.checkedAt >= 30_000 ||
    regions.length !== 1 ||
    !regions[0]?.visible ||
    links.length !== 1 ||
    !links[0]?.visible ||
    !links[0].attributes.href
  )
    return fallback;
  try {
    const u = new URL(links[0].attributes.href, page.url);
    if (
      u.origin !== 'https://www.facebook.com' ||
      u.pathname !== '/profile.php' ||
      u.searchParams.get('id') !== actor.data.accountId
    )
      return fallback;
  } catch {
    return fallback;
  }
  return {
    account: {
      state: 'logged-in' as const,
      id: actor.data.accountId,
      name: actor.data.name,
      avatar: null,
    },
    reason: '',
  };
}
export function analyzeFacebookIdentityPage(page: PageProjection) {
  if (!kernelFacebookReadURL(page.url)) throw Error('FB_IDENTITY_SCOPE_REJECTED');
  const path = new URL(page.url).pathname,
    visible = (key: string) => pageNodes(page, key).some((n) => n.visible),
    loginForms = pageNodes(page, 'loginForm');
  // limit=2 is an ambiguity sentinel. Never infer uniqueness from just the visible subset.
  const candidates = pageNodes(page, 'accountLinks')
    .filter((n) => n.visible && n.attributes.href)
    .flatMap((n) => {
      try {
        const u = new URL(n.attributes.href ?? '', page.url);
        if (!kernelFacebookReadURL(u.href)) return [];
        const id = u.pathname === '/profile.php' ? u.searchParams.get('id') : null;
        return [
          {
            url: u.href,
            id: id && /^\d{1,30}$/.test(id) ? id : null,
            label: n.text || n.attributes['aria-label'] || null,
          },
        ];
      } catch {
        return [];
      }
    });
  const state: InspectedAccount['state'] =
    page.ready !== 'complete'
      ? 'unknown'
      : /^\/checkpoint(?:\/|$)/.test(path)
        ? 'verification'
        : (path === '/' || /^\/login(?:\.php|\/|$)/.test(path)) &&
            loginForms.length === 1 &&
            loginForms[0]?.visible === true &&
            visible('loginEmail') &&
            visible('loginPassword') &&
            !candidates.length
          ? 'logged-out'
          : 'unknown';
  const reason =
    state === 'unknown'
      ? 'ACTING_ACCOUNT_UNVERIFIED'
      : state === 'verification'
        ? 'CHECKPOINT_ROUTE'
        : 'VISIBLE_LOGIN_FORM';
  return { account: { state, id: null, name: null, avatar: null }, candidates, reason };
}
