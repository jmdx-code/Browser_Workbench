const RESERVED_GROUP_SEGMENTS = new Set(
  'feed discover joins search create notifications categories your_groups settings'.split(' '),
);
const RESERVED_PAGE_SEGMENTS = new Set(
  'p login login.php checkpoint recover r.php reg groups events watch reel reels stories marketplace gaming bookmarks notifications messages friends settings search hashtag share sharer sharer.php photo photo.php permalink.php story.php video.php posts videos photos about mentions reviews followers following community live feed home.php people pages profile.php help policies privacy saved memories feeds professional_dashboard adsmanager business latest'.split(
    ' ',
  ),
);
function safeDecodeSegment(value: string): string {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
}
const isFbUrl = (trimmed: string) =>
  /^(?:https?:\/\/)?(?:[\w-]+\.)*(?:facebook\.com|fb\.com)(?:\/|$)/i.test(trimmed);
const isNonFbHttp = (trimmed: string) =>
  /^https?:\/\//i.test(trimmed) && !/(?:facebook\.com|fb\.com)/i.test(trimmed);
function cleanPlainTargetId(trimmed: string, isReserved: (lower: string) => boolean): string {
  if (/^https?:\/\//i.test(trimmed)) return '';
  const cleaned = safeDecodeSegment((trimmed.split(/[?#]/)[0] ?? '').replace(/^\/+|\/+$/g, ''));
  return !cleaned ||
    /\s/.test(cleaned) ||
    cleaned.includes('/') ||
    isReserved(cleaned.toLowerCase())
    ? ''
    : cleaned;
}
export function extractFacebookGroupId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || isNonFbHttp(trimmed)) return '';
  const match =
    /(?:facebook\.com|fb\.com)\/groups\/([^/?#&\s]+)/i.exec(trimmed) ??
    /^\/?groups\/([^/?#&\s]+)/i.exec(trimmed);
  if (match?.[1]) {
    const seg = safeDecodeSegment(match[1]);
    return seg && !RESERVED_GROUP_SEGMENTS.has(seg.toLowerCase()) ? seg : '';
  }
  if (isFbUrl(trimmed)) return /[?&]group_id=(\d{5,})/i.exec(trimmed)?.[1] ?? '';
  return cleanPlainTargetId(
    trimmed,
    (l) => RESERVED_GROUP_SEGMENTS.has(l) || RESERVED_PAGE_SEGMENTS.has(l),
  );
}
export function extractFacebookPageId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^\d{5,}$/.test(trimmed)) return trimmed;
  if (isNonFbHttp(trimmed)) return '';
  const direct =
    /profile\.php\?(?:[^#]*&)?id=(\d{5,})/i.exec(trimmed) ??
    /(?:^|\/)(?:people|pages)\/(?:[^/?#]+\/)+(\d{5,})(?:[/?#]|$)/i.exec(trimmed) ??
    /(?:^|\/)(?:p\/|pages\/(?:category\/[^/?#]+\/)?)[^/?#]*?-(\d{5,})(?:[/?#]|$)/i.exec(trimmed) ??
    /(?:^|\/)user\/(\d{5,})(?:[/?#]|$)/i.exec(trimmed);
  if (direct?.[1]) return direct[1];
  const fbPathMatch = /(?:facebook\.com|fb\.com)\/([^/?#&\s]+)/i.exec(trimmed);
  if (fbPathMatch?.[1]) {
    const seg = safeDecodeSegment(fbPathMatch[1]);
    return seg && !RESERVED_PAGE_SEGMENTS.has(seg.toLowerCase()) ? seg : '';
  }
  return isFbUrl(trimmed) ? '' : cleanPlainTargetId(trimmed, (l) => RESERVED_PAGE_SEGMENTS.has(l));
}
