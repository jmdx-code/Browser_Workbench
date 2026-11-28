import { isLocalAvatar, isTargetIncomplete, type BumperTarget } from '../../shared/group-bumper.js';
export interface TargetDomHelpers {
  cleanTargetHeading: (raw: string) => string;
  isGenericTargetHeading: (text: string) => boolean;
  extractDeepLinkTargetId: (rawContent: string, kind: 'groups' | 'pages') => string | null;
  isFacebookResourceNoiseUrl: (url: string) => boolean;
  isValidHttpAvatarUrl: (
    url: string | null | undefined,
    options?: { disallowFacebookOrigin?: boolean; requireCdnHost?: boolean },
  ) => boolean;
  matchesTargetEntity: (
    row: Record<string, unknown>,
    kind: 'groups' | 'pages',
    expectedId: string,
    canonicalId: string | null,
    baseOrigin?: string,
  ) => boolean;
}
/**
 * Self-contained factory usable both in Node and inside Playwright page.evaluate via serializeDomEval.
 */
export function createTargetDomHelpers(): TargetDomHelpers {
  const GENERIC_HEADING_RE =
    /^(?:Facebook|Notifications|通知|Chats|聊天|Groups|小组|社團|Pages|公共主页|粉絲專頁|专页|Marketplace|Watch|视频|目前无法查看此内容|目前無法查看此內容|This content isn't available|Page Not Found|找不到页面|找不到内容|Content Not Found|Log in or sign up to view|Log into Facebook|Log In|登录 Facebook|登入 Facebook|請先登入|请先登录|Error|错误)$/i;
  const NOISE_URL_RE = /static\.xx\.fbcdn\.net\/rsrc\.php|\/rsrc\.php\/|\/emoji\.php\//i;
  const cleanTargetHeading = (raw: string): string =>
    raw
      .replace(/\s+/g, ' ')
      .replace(/^\(\d+\+?\)\s*/, '')
      .replace(/\s*[|-]\s*Facebook\s*$/i, '')
      .trim();
  const isGenericTargetHeading = (text: string): boolean => !text || GENERIC_HEADING_RE.test(text);
  const extractDeepLinkTargetId = (rawContent: string, kind: 'groups' | 'pages'): string | null => {
    const match =
      kind === 'pages'
        ? /fb:\/\/(?:profile|page)\/(\d+)/i.exec(rawContent)
        : /fb:\/\/group\/(\d+)/i.exec(rawContent);
    return match?.[1] ?? null;
  };
  const isFacebookResourceNoiseUrl = (url: string): boolean => NOISE_URL_RE.test(url);
  const isValidHttpAvatarUrl = (
    url: string | null | undefined,
    options?: { disallowFacebookOrigin?: boolean; requireCdnHost?: boolean },
  ): boolean => {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return false;
    if (options?.disallowFacebookOrigin && /^https:\/\/(?:www\.)?facebook\.com\//i.test(url))
      return false;
    if (options?.requireCdnHost && !/fbcdn\.net|fbsbx\.com/i.test(url)) return false;
    return !NOISE_URL_RE.test(url);
  };
  const matchesTargetEntity = (
    row: Record<string, unknown>,
    kind: 'groups' | 'pages',
    expectedId: string,
    canonicalId: string | null,
    baseOrigin = 'https://www.facebook.com',
  ): boolean => {
    const id = String(row.id ?? row.__id ?? '');
    let matches = (!!id && id === expectedId) || (!!canonicalId && id === canonicalId);
    if (expectedId && !/^\d+$/.test(expectedId)) {
      const expLower = expectedId.toLowerCase();
      matches ||=
        String(row.username ?? '').toLowerCase() === expLower ||
        String(row.vanity ?? '').toLowerCase() === expLower;
    }
    const prefix = kind === 'groups' ? '/groups/' : '/';
    for (const key of ['url', 'profile_url', 'group_url']) {
      if (typeof row[key] === 'string') {
        try {
          const u = new URL(row[key], baseOrigin);
          const normPath = u.pathname.replace(/\/$/, '').toLowerCase();
          matches ||=
            u.origin === baseOrigin &&
            ((!!expectedId && normPath === prefix + expectedId.toLowerCase()) ||
              (!!canonicalId && normPath === prefix + canonicalId.toLowerCase()));
        } catch {}
      }
    }
    return matches;
  };
  return {
    cleanTargetHeading,
    isGenericTargetHeading,
    extractDeepLinkTargetId,
    isFacebookResourceNoiseUrl,
    isValidHttpAvatarUrl,
    matchesTargetEntity,
  };
}
export const targetDomHelpers = createTargetDomHelpers();
export function buildFacebookTargetUrl(kind: 'groups' | 'pages', rawId: string): string {
  const id = rawId.trim();
  return kind === 'groups'
    ? `https://www.facebook.com/groups/${encodeURIComponent(id)}/`
    : /^\d+$/.test(id)
      ? `https://www.facebook.com/profile.php?id=${encodeURIComponent(id)}`
      : `https://www.facebook.com/${encodeURIComponent(id)}`;
}
export const isAccountAbnormalCodeOrMessage = (msg: string): boolean =>
  /FACEBOOK_ACCOUNT_(?:LOGGED_OUT|VERIFICATION_REQUIRED|RESTRICTED)|FACEBOOK_METADATA_LOGIN_REQUIRED/.test(
    msg,
  );
export function resolveAvatarFallbackSource(
  bestRawAvatarUrl: string | null,
  existingAvatarUrl: string | null | undefined,
): { localized: string | null; sourceUrl: string | null } {
  const localized =
    typeof existingAvatarUrl === 'string' && isLocalAvatar(existingAvatarUrl)
      ? existingAvatarUrl
      : null;
  const sourceUrl =
    bestRawAvatarUrl ??
    (!localized && typeof existingAvatarUrl === 'string' && existingAvatarUrl.startsWith('https://')
      ? existingAvatarUrl
      : null);
  return { localized, sourceUrl };
}
export function buildTargetCompletionSnapshot(
  item: Pick<BumperTarget, 'id' | 'name' | 'avatarUrl'>,
  meta: { canonicalId?: string | null; name?: string | null; avatarUrl?: string | null },
): { target: { id: string; name: string; avatarUrl: string | null }; complete: boolean } {
  const target = {
    id: meta.canonicalId ?? item.id,
    name: meta.name ?? item.name,
    avatarUrl: meta.avatarUrl ?? (isLocalAvatar(item.avatarUrl) ? item.avatarUrl : null),
  };
  return { target, complete: !isTargetIncomplete(target) };
}
