// The legacy Watch entry may redirect to the Reels feed or its current reel.
// Keep browsing restricted to these surfaces; an arbitrary Facebook URL is not a feed.
export type FacebookBrowseType = 'feed' | 'video' | 'marketplace' | 'friends';
// Marked from the current native next-card Fiber; shared by input and STOP checks.
export const FACEBOOK_REEL_NEXT_CSS = '[data-wb-reel-next="1"]';
export const FACEBOOK_FRIENDS_REQUESTS_URL = 'https://www.facebook.com/friends/requests/';
export const FACEBOOK_FRIEND_CONFIRM_CSS = '[data-wb-friend-confirm="1"]';
export const FACEBOOK_BROWSE_LIKE_CSS = '[data-wb-browse-like="1"]';
// Read/recovery scope only. This URL is never a valid browse action destination.
export function facebookMarketplaceUnavailableURL(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      value.length <= 2048 &&
      url.origin === 'https://www.facebook.com' &&
      !url.username &&
      !url.password &&
      /^\/marketplace\/ineligible\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
export function facebookBrowseSurface(value: string): FacebookBrowseType | null {
  try {
    const url = new URL(value);
    if (
      url.origin !== 'https://www.facebook.com' ||
      url.username ||
      url.password ||
      value.length > 2048
    )
      return null;
    if (url.pathname === '/') return 'feed';
    if (/^\/marketplace\/ineligible\/?$/.test(url.pathname)) return null;
    if (url.pathname === '/reel/' && url.search === '?s=tab' && !url.hash) return 'video';
    if (/^\/(?:watch|reels)\/?$/.test(url.pathname) || /^\/reel\/\d{1,30}\/?$/.test(url.pathname))
      return 'video';
    if (
      /^\/marketplace(?:\/(?:(?!(?:inbox|you|create|item|selling|buying|notifications|search)(?:\/|$))[a-z0-9_-]{1,80})(?:\/search)?|\/search)?\/?$/.test(
        url.pathname,
      ) ||
      /^\/marketplace\/item\/\d{1,30}\/?$/.test(url.pathname)
    )
      return 'marketplace';
    if (/^\/friends(?:\/requests)?\/?$/.test(url.pathname) && !url.search && !url.hash)
      return 'friends';
    return null;
  } catch {
    return null;
  }
}

export interface MarketplaceFilter {
  keyword: string;
  categoryId?: string;
  minPrice?: number;
  maxPrice?: number;
}
const filterOf = (value: string | MarketplaceFilter): MarketplaceFilter =>
  typeof value === 'string' ? { keyword: value } : value;
export const MARKETPLACE_HOME = 'https://www.facebook.com/marketplace/';
export function marketplaceBootstrap(value: string, filter: MarketplaceFilter): boolean {
  return !!filter.categoryId && value === MARKETPLACE_HOME;
}
export function facebookMarketplaceURL(
  value: string | MarketplaceFilter,
  nativeCategoryURL?: string,
): string {
  const filter = filterOf(value);
  if (filter.categoryId && !nativeCategoryURL) return MARKETPLACE_HOME;
  const url = new URL(
    nativeCategoryURL ??
      (filter.keyword.trim() ? 'https://www.facebook.com/marketplace/search/' : MARKETPLACE_HOME),
  );
  if (
    nativeCategoryURL &&
    (!matchesMarketplaceSearch(nativeCategoryURL, {
      keyword: '',
      categoryId: filter.categoryId,
    }) ||
      !filter.categoryId)
  )
    throw Error('MARKETPLACE_NATIVE_CATEGORY_REQUIRED');
  if (filter.keyword.trim()) url.searchParams.set('query', filter.keyword.trim());
  for (const name of ['minPrice', 'maxPrice'] as const) {
    const price = filter[name];
    if (price === undefined) url.searchParams.delete(name);
    else url.searchParams.set(name, String(price));
  }
  return url.href;
}

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
      /^\/marketplace(?:\/(?:(?!(?:inbox|you|create|item|selling|buying|notifications|search)(?:\/|$))[a-z0-9_-]{1,80}))?\/?$/.test(
        url.pathname,
      ) &&
      !['query', 'category_id', 'minPrice', 'maxPrice'].some((name) => url.searchParams.has(name))
    );
  if (
    !/^\/marketplace\/(?:(?!(?:inbox|you|create|item|selling|buying|notifications|search)\/)[a-z0-9_-]{1,80}\/)?search\/?$/.test(
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
