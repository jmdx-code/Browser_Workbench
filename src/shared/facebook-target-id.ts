const RESERVED_GROUP_SEGMENTS = new Set([
  'feed',
  'discover',
  'joins',
  'search',
  'create',
  'notifications',
  'categories',
  'your_groups',
  'settings',
]);

const RESERVED_PAGE_SEGMENTS = new Set([
  'p',
  'login',
  'login.php',
  'checkpoint',
  'recover',
  'r.php',
  'reg',
  'groups',
  'events',
  'watch',
  'reel',
  'reels',
  'stories',
  'marketplace',
  'gaming',
  'bookmarks',
  'notifications',
  'messages',
  'friends',
  'settings',
  'search',
  'hashtag',
  'share',
  'sharer',
  'sharer.php',
  'photo',
  'photo.php',
  'permalink.php',
  'story.php',
  'video.php',
  'posts',
  'videos',
  'photos',
  'about',
  'mentions',
  'reviews',
  'followers',
  'following',
  'community',
  'live',
  'feed',
  'home.php',
  'people',
  'pages',
  'profile.php',
  'help',
  'policies',
  'privacy',
  'saved',
  'memories',
  'feeds',
  'professional_dashboard',
  'adsmanager',
  'business',
  'latest',
]);

function safeDecodeSegment(value: string): string {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
}

export function extractFacebookGroupId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed) && !/(?:facebook\.com|fb\.com)/i.test(trimmed)) {
    return '';
  }

  const groupUrlMatch = /(?:facebook\.com|fb\.com)\/groups\/([^/?#&\s]+)/i.exec(trimmed);
  if (groupUrlMatch && groupUrlMatch[1]) {
    const seg = safeDecodeSegment(groupUrlMatch[1]);
    if (!seg || RESERVED_GROUP_SEGMENTS.has(seg.toLowerCase())) {
      return '';
    }
    return seg;
  }

  const relativeGroupMatch = /^\/?groups\/([^/?#&\s]+)/i.exec(trimmed);
  if (relativeGroupMatch && relativeGroupMatch[1]) {
    const seg = safeDecodeSegment(relativeGroupMatch[1]);
    if (!seg || RESERVED_GROUP_SEGMENTS.has(seg.toLowerCase())) {
      return '';
    }
    return seg;
  }

  if (/^(?:https?:\/\/)?(?:[\w-]+\.)*(?:facebook\.com|fb\.com)(?:\/|$)/i.test(trimmed)) {
    const queryGroupId = /[?&]group_id=(\d{5,})/i.exec(trimmed);
    return queryGroupId && queryGroupId[1] ? queryGroupId[1] : '';
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return '';
  }

  const cleaned = safeDecodeSegment((trimmed.split(/[?#]/)[0] ?? '').replace(/^\/+|\/+$/g, ''));
  if (!cleaned || /\s/.test(cleaned) || cleaned.includes('/')) {
    return '';
  }
  if (
    RESERVED_GROUP_SEGMENTS.has(cleaned.toLowerCase()) ||
    RESERVED_PAGE_SEGMENTS.has(cleaned.toLowerCase())
  ) {
    return '';
  }
  return cleaned;
}

export function extractFacebookPageId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^\d{5,}$/.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed) && !/(?:facebook\.com|fb\.com)/i.test(trimmed)) {
    return '';
  }

  const profileIdMatch = /profile\.php\?(?:[^#]*&)?id=(\d{5,})/i.exec(trimmed);
  if (profileIdMatch && profileIdMatch[1]) {
    return profileIdMatch[1];
  }

  const peopleOrPagesNumeric = /(?:^|\/)(?:people|pages)\/(?:[^/?#]+\/)+(\d{5,})(?:[/?#]|$)/i.exec(
    trimmed,
  );
  if (peopleOrPagesNumeric && peopleOrPagesNumeric[1]) {
    return peopleOrPagesNumeric[1];
  }

  const categoryOrPPageNumeric =
    /(?:^|\/)(?:p\/|pages\/(?:category\/[^/?#]+\/)?)[^/?#]*?-(\d{5,})(?:[/?#]|$)/i.exec(trimmed);
  if (categoryOrPPageNumeric && categoryOrPPageNumeric[1]) {
    return categoryOrPPageNumeric[1];
  }

  const userNumeric = /(?:^|\/)user\/(\d{5,})(?:[/?#]|$)/i.exec(trimmed);
  if (userNumeric && userNumeric[1]) {
    return userNumeric[1];
  }

  const fbPathMatch = /(?:facebook\.com|fb\.com)\/([^/?#&\s]+)/i.exec(trimmed);
  if (fbPathMatch && fbPathMatch[1]) {
    const seg = safeDecodeSegment(fbPathMatch[1]);
    if (!seg || RESERVED_PAGE_SEGMENTS.has(seg.toLowerCase())) {
      return '';
    }
    return seg;
  }

  if (/^(?:https?:\/\/)?(?:[\w-]+\.)*(?:facebook\.com|fb\.com)(?:\/|$)/i.test(trimmed)) {
    return '';
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return '';
  }

  const cleaned = safeDecodeSegment((trimmed.split(/[?#]/)[0] ?? '').replace(/^\/+|\/+$/g, ''));
  if (!cleaned || /\s/.test(cleaned) || cleaned.includes('/')) {
    return '';
  }
  if (RESERVED_PAGE_SEGMENTS.has(cleaned.toLowerCase())) {
    return '';
  }
  return cleaned;
}
