import type { PageProjection } from '../shared/page-read.js';
import { kernelFacebookReadURL } from '../shared/kernel-policy.js';
import { FacebookNativeActor } from '../shared/facebook-native-identity.js';
import type { InspectedAccount } from './profile-inspection.js';

// Same owned, completed home document; native actor and creator must agree. This is a
// display snapshot, never an input permit. Login/checkpoint findings take precedence.
export function inspectedFacebookAccount(page: PageProjection, input: unknown, now: number) {
  const analysis = analyzeFacebookIdentityPage(page);
  const actor = FacebookNativeActor.safeParse(input);
  const links = page.rows.find((row) => row.key === 'composerProfileLinks')?.nodes ?? [];
  const regions = page.rows.find((row) => row.key === 'homeComposers')?.nodes ?? [];
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
    return { account: analysis.account, reason: analysis.reason };
  try {
    const url = new URL(links[0].attributes.href, page.url);
    if (
      url.origin !== 'https://www.facebook.com' ||
      url.pathname !== '/profile.php' ||
      url.searchParams.get('id') !== actor.data.accountId
    )
      return { account: analysis.account, reason: analysis.reason };
  } catch {
    return { account: analysis.account, reason: analysis.reason };
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
  const path = new URL(page.url).pathname;
  const visible = (key: string) =>
    page.rows.find((row) => row.key === key)?.nodes.some((node) => node.visible) ?? false;
  // limit=2 is an ambiguity sentinel. Never infer uniqueness from just the visible subset.
  const loginForms = page.rows.find((row) => row.key === 'loginForm')?.nodes ?? [];
  const uniqueVisibleLoginForm = loginForms.length === 1 && loginForms[0]?.visible === true;
  const candidates = (page.rows.find((row) => row.key === 'accountLinks')?.nodes ?? [])
    .filter((node) => node.visible)
    .flatMap((node) => {
      const href = node.attributes.href;
      if (!href) return [];
      try {
        const url = new URL(href, page.url);
        if (!kernelFacebookReadURL(url.href)) return [];
        const id = url.pathname === '/profile.php' ? url.searchParams.get('id') : null;
        return [
          {
            url: url.href,
            id: id && /^\d{1,30}$/.test(id) ? id : null,
            label: node.text || node.attributes['aria-label'] || null,
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
            uniqueVisibleLoginForm &&
            visible('loginEmail') &&
            visible('loginPassword') &&
            candidates.length === 0
          ? 'logged-out'
          : 'unknown';
  return {
    account: { state, id: null, name: null, avatar: null },
    candidates,
    reason:
      state === 'unknown'
        ? 'ACTING_ACCOUNT_UNVERIFIED'
        : state === 'verification'
          ? 'CHECKPOINT_ROUTE'
          : 'VISIBLE_LOGIN_FORM',
  };
}

// /me/ can redirect to a personal profile; it does not prove the currently acting Page identity.
export function observeFacebookSelfProfile(page: PageProjection) {
  const analysis = analyzeFacebookIdentityPage(page);
  const url = new URL(page.url);
  const rawId = url.pathname === '/profile.php' ? url.searchParams.get('id') : null;
  const headings = [
    ...new Set(
      (page.rows.find((row) => row.key === 'profileHeading')?.nodes ?? [])
        .filter((node) => node.visible && node.text.trim())
        .map((node) => node.text.trim()),
    ),
  ];
  const usable = page.ready === 'complete' && analysis.account.state === 'unknown';
  return {
    account: analysis.account,
    identityReady: false,
    candidate: {
      id: usable && rawId && /^\d{1,30}$/.test(rawId) ? rawId : null,
      name: usable && headings.length === 1 ? (headings[0] ?? null) : null,
    },
    reason: 'SELF_ROUTE_IS_NOT_ACTOR_PROOF',
    avatarNodes: page.rows.find((row) => row.key === 'accountControlImages')?.nodes ?? [],
  };
}
