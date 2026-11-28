type FacebookBrowseType = 'feed' | 'video' | 'marketplace' | 'friends';
type FacebookAbnormalAccountReason =
  | 'FACEBOOK_ACCOUNT_VERIFICATION_REQUIRED'
  | 'FACEBOOK_ACCOUNT_RESTRICTED'
  | 'FACEBOOK_ACCOUNT_LOGGED_OUT';
const safeFbUrl = (value: string, allowMobile = false): URL | null => {
  if (value.length > 2048) return null;
  try {
    const u = new URL(value);
    const okOrigin =
      u.origin === 'https://www.facebook.com' ||
      (allowMobile && u.origin === 'https://m.facebook.com');
    return okOrigin && !u.username && !u.password ? u : null;
  } catch {
    return null;
  }
};
export function classifyFacebookAbnormalUrl(value: string): FacebookAbnormalAccountReason | null {
  const url = safeFbUrl(value, true);
  if (!url) return null;
  if (/^\/checkpoint(?:\/|$)/i.test(url.pathname)) return 'FACEBOOK_ACCOUNT_VERIFICATION_REQUIRED';
  if (/^\/(?:disabled|suspended|account_status|restriction)(?:\/|$)/i.test(url.pathname))
    return 'FACEBOOK_ACCOUNT_RESTRICTED';
  if (/^\/(?:login|recover)(?:\.php|\/|$)/i.test(url.pathname))
    return 'FACEBOOK_ACCOUNT_LOGGED_OUT';
  return null;
}
// Marked from the current native next-card Fiber; shared by input and STOP checks.
export const FACEBOOK_REEL_NEXT_CSS = '[data-wb-reel-next="1"]';
export const FACEBOOK_FRIENDS_REQUESTS_URL = 'https://www.facebook.com/friends/requests/';
export const FACEBOOK_FRIENDS_SUGGESTIONS_URL = 'https://www.facebook.com/friends/suggestions';
export const FACEBOOK_FRIEND_CONFIRM_CSS = '[data-wb-friend-confirm="1"]';
export const FACEBOOK_FRIEND_ADD_CSS = '[data-wb-friend-add="1"]';
export const FACEBOOK_BROWSE_LIKE_CSS = '[data-wb-browse-like="1"]';
export const FACEBOOK_BROWSE_DIALOG_DISMISS_CSS = '[data-wb-browse-dialog-dismiss="1"]';
const RESERVED_DETOUR_SEGMENTS = new Set(
  'login login.php recover checkpoint disabled suspended account_status restriction groups messages settings help privacy policies ads business marketplace watch reels reel stories friends events pages search photo photo.php photos videos video.php permalink.php posts bookmarks notifications memories saved gaming hashtag share sharer sharer.php l.php ajax api dialog profile.php post composer feed home.php index.php logout.php reg r.php fundraisers live offers jobs weather crisisresponse professional_dashboard latest me menu directory legal about careers developers communitystandards support p'.split(
    ' ',
  ),
);
export const facebookSearchPagesURL = (query: string) =>
  'https://www.facebook.com/search/pages/?q=' + encodeURIComponent(query.trim());
const facebookSearchPagesQuery = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://www.facebook.com' || !/^\/search\/pages\/?$/i.test(url.pathname))
      return null;
    const q = url.searchParams.get('q')?.trim() ?? '';
    return q.length > 0 && q.length <= 200 ? q : null;
  } catch {
    return null;
  }
};
export function facebookPageDirectURL(idOrSlug: string): string {
  const cleaned = idOrSlug.trim();
  return /^\d+$/.test(cleaned)
    ? 'https://www.facebook.com/profile.php?id=' + encodeURIComponent(cleaned)
    : 'https://www.facebook.com/' + encodeURIComponent(cleaned) + '/';
}
export function facebookFeedDetourURL(value: string): boolean {
  const url = safeFbUrl(value);
  if (!url) return false;
  if (/^\/search\/pages\/?$/i.test(url.pathname)) {
    const q = url.searchParams.get('q')?.trim() ?? '';
    return q.length > 0 && q.length <= 200;
  }
  if (url.pathname === '/profile.php') return /^\d{5,25}$/.test(url.searchParams.get('id') ?? '');
  if (
    /^\/(?:people|pages)\/[^/]+\/\d{5,25}\/?$/i.test(url.pathname) ||
    /^\/p\/[^/]{2,180}\/?$/i.test(url.pathname)
  )
    return true;
  const seg = /^\/((?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2}){2,160})\/?$/.exec(url.pathname)?.[1];
  return Boolean(seg && !RESERVED_DETOUR_SEGMENTS.has(seg.toLowerCase()));
}
export function facebookDetourMatchesTarget(
  currentUrl: string,
  targetUrl: string,
  previousUrl?: string,
): boolean {
  if (!facebookFeedDetourURL(currentUrl) || !facebookFeedDetourURL(targetUrl)) return false;
  const targetQ = facebookSearchPagesQuery(targetUrl);
  const currentQ = facebookSearchPagesQuery(currentUrl);
  if (targetQ !== null)
    return currentQ !== null && currentQ.toLowerCase() === targetQ.toLowerCase();
  if (currentQ !== null) return false;
  if (currentUrl === targetUrl) return true;
  return !(previousUrl && previousUrl !== targetUrl && currentUrl === previousUrl);
}
type StepDetourSpec = {
  type: string;
  feedMode?: string | undefined;
  randomProfileVisitChance?: number | undefined;
  randomPageVisitChance?: number | undefined;
};
export const facebookFeedDetourEnabled = (spec: StepDetourSpec): boolean =>
  spec.type === 'feed' &&
  ((spec.feedMode ?? 'home') !== 'home' ||
    (spec.randomProfileVisitChance ?? 0) > 0 ||
    (spec.randomPageVisitChance ?? 0) > 0);
export function facebookBrowseSurfaceForStep(
  value: string,
  spec: StepDetourSpec,
): FacebookBrowseType | null {
  return (
    facebookBrowseSurface(value) ??
    (facebookFeedDetourEnabled(spec) && facebookFeedDetourURL(value) ? 'feed' : null)
  );
}
export function facebookFriendsRouteMatches(
  value: string,
  friendAction?: 'accept' | 'add_suggested',
): boolean {
  const url = safeFbUrl(value);
  return Boolean(
    url &&
    (friendAction === 'add_suggested'
      ? /^\/friends\/suggestions\/?$/
      : /^\/friends\/requests\/?$/
    ).test(url.pathname),
  );
}
// Read/recovery scope only. This URL is never a valid browse action destination.
export const facebookMarketplaceUnavailableURL = (value: string): boolean =>
  Boolean(safeFbUrl(value)?.pathname.match(/^\/marketplace\/ineligible\/?$/));
export const facebookPostStoryLandingURL = (value: string): boolean =>
  Boolean(safeFbUrl(value)?.pathname.match(/^\/stories\/?$/i));
export function facebookBrowseSurface(value: string): FacebookBrowseType | null {
  const url = safeFbUrl(value);
  if (!url) return null;
  const p = url.pathname;
  if (p === '/') return 'feed';
  if (/^\/marketplace\/ineligible\/?$/.test(p)) return null;
  if (p === '/reel/' && url.search === '?s=tab' && !url.hash) return 'video';
  if (/^\/(?:watch|reels)\/?$/.test(p) || /^\/reel\/\d{1,30}\/?$/.test(p)) return 'video';
  if (
    /^\/marketplace(?:\/category\/[a-z0-9_-]{1,80}(?:\/search)?|\/(?:(?!(?:inbox|you|create|item|selling|buying|notifications|ineligible|search)(?:\/|$))[a-z0-9_-]{1,80})(?:\/search)?|\/search)?\/?$/i.test(
      p,
    ) ||
    /^\/marketplace\/item\/\d{1,30}\/?$/.test(p)
  )
    return 'marketplace';
  if (/^\/friends(?:\/(?:requests|suggestions))?\/?$/.test(p) && !url.search && !url.hash)
    return 'friends';
  return null;
}
interface MarketplaceFilter {
  keyword: string;
  categoryId?: string;
  minPrice?: number;
  maxPrice?: number;
}
const filterOf = (value: string | MarketplaceFilter): MarketplaceFilter =>
  typeof value === 'string' ? { keyword: value } : value;
export const MARKETPLACE_HOME = 'https://www.facebook.com/marketplace/';
export function facebookMarketplaceItemURL(value: string): string | null {
  if (facebookBrowseSurface(value) !== 'marketplace') return null;
  const url = new URL(value);
  const match = /^\/marketplace\/item\/(\d{1,30})\/?$/.exec(url.pathname);
  return match ? 'https://www.facebook.com/marketplace/item/' + match[1] + '/' : null;
}
export function matchesMarketplaceSearch(
  value: string,
  valueFilter: string | MarketplaceFilter,
): boolean {
  if (facebookBrowseSurface(value) !== 'marketplace') return false;
  const url = new URL(value),
    filter = filterOf(valueFilter),
    keyword = filter.keyword.trim();
  const search =
    !!keyword ||
    !!filter.categoryId ||
    filter.minPrice !== undefined ||
    filter.maxPrice !== undefined;
  if (!search)
    return (
      /^\/marketplace(?:\/(?:category\/[a-z0-9_-]{1,80}(?:\/search)?|(?!(?:inbox|you|create|item|selling|buying|notifications|ineligible|search|category)(?:\/|$))[a-z0-9_-]{1,80}))?\/?$/i.test(
        url.pathname,
      ) &&
      !['query', 'category_id', 'minPrice', 'maxPrice'].some((name) => url.searchParams.has(name))
    );
  if (
    !/^\/marketplace\/(?:category\/[a-z0-9_-]{1,80}\/|(?:(?!(?:inbox|you|create|item|selling|buying|notifications|ineligible|search|category)\/)[a-z0-9_-]{1,80}\/))?search\/?$/i.test(
      url.pathname,
    )
  )
    return false;
  if (
    url.searchParams.getAll('query').length > 1 ||
    (keyword && url.searchParams.get('query') !== keyword)
  )
    return false;
  for (const [name, requested] of [
    ['category_id', filter.categoryId],
    ['minPrice', filter.minPrice],
    ['maxPrice', filter.maxPrice],
  ] as const) {
    const values = url.searchParams.getAll(name);
    if (
      requested === undefined
        ? values.length !== 0
        : values.length !== 1 ||
          (name === 'category_id'
            ? values[0] !== String(requested)
            : !/^\d+(?:\.\d{1,2})?$/.test(values[0] ?? '') || Number(values[0]) !== requested)
    )
      return false;
  }
  return true;
}
