import { serializeDomEval, type createDomEvalRuntime } from '../shared-dom-eval-runtime.js';
import { createTargetDomHelpers } from './target-meta-helpers.js';
export interface InPageTargetProbeResult {
  href: string;
  readyState: string;
  navigated: boolean;
  abnormal: string | null;
  unavailableTarget: boolean;
  canonicalId: string | null;
  domName: string | null;
  domAvatarUrl: string | null;
  scopedHtml: string;
  summary: string | null;
}
interface TargetCandidateInput {
  expectedId: string;
  targetKind: 'groups' | 'pages';
  previousHref: string;
  previousTimeOrigin?: number;
  requireNavigation?: boolean;
}
function extractTargetCandidateEntry(
  _createDomRt: typeof createDomEvalRuntime,
  createMetaHelpers: typeof createTargetDomHelpers,
  input: TargetCandidateInput,
): InPageTargetProbeResult {
  const {
    cleanTargetHeading,
    isGenericTargetHeading,
    extractDeepLinkTargetId,
    isValidHttpAvatarUrl,
    matchesTargetEntity,
  } = createMetaHelpers();
  const { expectedId, targetKind, previousHref, previousTimeOrigin, requireNavigation } = input;
  const href = location.href;
  const readyState = document.readyState;
  const sameDocument =
    typeof previousTimeOrigin === 'number' &&
    previousTimeOrigin > 0 &&
    performance.timeOrigin === previousTimeOrigin;
  const emptyResult = (nav: boolean, abn: string | null = null): InPageTargetProbeResult => ({
    href,
    readyState,
    navigated: nav,
    abnormal: abn,
    unavailableTarget: false,
    canonicalId: null,
    domName: null,
    domAvatarUrl: null,
    scopedHtml: '',
    summary: null,
  });
  if (
    (previousHref && href === previousHref) ||
    (requireNavigation && sameDocument && (!previousHref || href === previousHref))
  )
    return emptyResult(false);
  const pathname = location.pathname.toLowerCase();
  let abnormal: string | null = /^\/checkpoint(?:\/|$)/.test(pathname)
    ? 'FACEBOOK_ACCOUNT_VERIFICATION_REQUIRED'
    : /^\/(?:disabled|suspended|account_status|restriction)(?:\/|$)/.test(pathname)
      ? 'FACEBOOK_ACCOUNT_RESTRICTED'
      : /^\/(?:login|recover)(?:\.php|\/|$)/.test(pathname)
        ? 'FACEBOOK_ACCOUNT_LOGGED_OUT'
        : null;
  if (!abnormal && (readyState === 'interactive' || readyState === 'complete')) {
    if (
      document.querySelector('input[name="email"]') &&
      document.querySelector('input[name="pass"]')
    ) {
      const hasCookie = /\bc_user=[1-9]\d*/.test(document.cookie || ''),
        hasNav = Boolean(
          document.querySelector(
            '[role="banner"] [aria-label*="Account" i], [role="banner"] [aria-label*="账号"], [role="banner"] [aria-label*="個人檔案"], [role="banner"] [aria-label*="个人主页"], [role="navigation"] [aria-label*="Account" i], [role="navigation"] [aria-label*="账号"]',
          ),
        ),
        hasActor = Array.from(document.scripts).some((s) => {
          const txt = s.textContent || '';
          return txt.includes('CurrentUserInitialData') && /"USER_ID"\s*:\s*"[1-9]\d*"/.test(txt);
        });
      if (!hasCookie && !hasNav && !hasActor) abnormal = 'FACEBOOK_ACCOUNT_LOGGED_OUT';
    }
    if (
      !abnormal &&
      /account has been disabled|your account is disabled|we suspended your account|账号已被停用|账户已被停用|已停用你的账户/i.test(
        (document.body?.innerText || '').slice(0, 3000),
      )
    )
      abnormal = 'FACEBOOK_ACCOUNT_RESTRICTED';
  }
  if (abnormal) return emptyResult(true, abnormal);
  let canonicalId: string | null = null;
  if (targetKind === 'groups') {
    const m = /^\/groups\/(\d{5,})(?:\/|$)/.exec(location.pathname);
    if (m?.[1]) canonicalId ??= m[1];
  } else {
    const qId = new URLSearchParams(location.search).get('id');
    if (qId && /^\d{5,}$/.test(qId)) canonicalId ??= qId;
    const m =
      /^\/(?:people|pages)\/[^/]+\/(\d{5,})(?:\/|$)/.exec(location.pathname) ??
      /^\/(\d{5,})\/?$/.exec(location.pathname);
    if (m?.[1]) canonicalId ??= m[1];
  }
  const metaParts: string[] = [];
  let metaTitle: string | null = null;
  let metaImage: string | null = null;
  for (const m of Array.from(document.querySelectorAll('meta'))) {
    const prop = (m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase();
    const content = m.getAttribute('content') || '';
    if (!prop || !content) continue;
    metaParts.push(m.outerHTML);
    if (prop === 'al:android:url' || prop === 'al:ios:url') {
      const deepId = extractDeepLinkTargetId(content, targetKind);
      if (deepId) canonicalId ??= deepId;
    } else if (prop === 'og:title' || prop === 'twitter:title') metaTitle ??= content;
    else if (prop === 'og:image' || prop === 'twitter:image') {
      if (isValidHttpAvatarUrl(content)) metaImage ??= content;
    }
  }
  const titleEl = document.querySelector('title');
  if (titleEl) metaParts.push(titleEl.outerHTML);
  let domName: string | null = null;
  for (const h1 of Array.from(document.querySelectorAll('[role="main"] h1, main h1, h1'))) {
    if (
      h1.closest(
        '[role="banner"], [role="navigation"], [role="complementary"], [role="feed"], [role="article"], [role="dialog"]',
      )
    )
      continue;
    const raw = cleanTargetHeading(h1.textContent || '');
    if (!isGenericTargetHeading(raw)) {
      domName = raw;
      break;
    }
  }
  if (!domName && metaTitle) {
    const cleaned = cleanTargetHeading(metaTitle);
    if (!isGenericTargetHeading(cleaned)) domName = cleaned;
  }
  const isValidCdnImage = (u: string) => isValidHttpAvatarUrl(u, { requireCdnHost: true });
  const isSmallActorIcon = (el: Element): boolean =>
    [el, el.closest('svg')].some((n) => {
      if (!n) return false;
      const small = (v: string | null | undefined) => {
        const num = Number.parseFloat(v || '');
        return Number.isFinite(num) && num > 0 && num <= 48;
      };
      const st = n.getAttribute('style') || '';
      return (
        small(n.getAttribute('width')) ||
        small(n.getAttribute('height')) ||
        small(/(?:^|;)\s*width\s*:\s*(\d+(?:\.\d+)?)px/i.exec(st)?.[1]) ||
        small(/(?:^|;)\s*height\s*:\s*(\d+(?:\.\d+)?)px/i.exec(st)?.[1])
      );
    });
  const isExcludedImageZone = (el: Element) =>
    Boolean(
      el.closest(
        '[role="feed"], [role="article"], [role="banner"], [role="navigation"], [role="complementary"], [role="dialog"], [role="form"]',
      ),
    );
  let domAvatarUrl: string | null = null;
  const mainRoot = document.querySelector('[role="main"], main') ?? document.body;
  if (mainRoot) {
    const pickAvatarFrom = (selector: string, skipCover: boolean): string | null => {
      for (const img of Array.from(mainRoot.querySelectorAll(selector))) {
        if (isExcludedImageZone(img) || isSmallActorIcon(img)) continue;
        if (skipCover && /cover/i.test(img.getAttribute('data-imgperflogname') || '')) continue;
        const src =
          (img as HTMLImageElement).currentSrc ||
          ['src', 'xlink:href', 'href'].map((a) => img.getAttribute(a)).find(Boolean) ||
          '';
        if (isValidCdnImage(src)) return src;
      }
      return null;
    };
    domAvatarUrl =
      targetKind === 'pages'
        ? (pickAvatarFrom('svg image', false) ?? pickAvatarFrom('img', true))
        : pickAvatarFrom('img[data-imgperflogname*="CoverPhoto" i], svg image, img', false);
  }
  if (!domAvatarUrl && metaImage && isValidCdnImage(metaImage)) domAvatarUrl = metaImage;
  const mainText = (mainRoot?.textContent || '').slice(0, 3000);
  const unavailableTarget =
    readyState === 'complete' &&
    !domName &&
    /This content isn't available|目前无法查看此内容|此内容目前无法显示|Page Not Found|找不到页面|這個頁面無法使用|目前無法查看此內容/i.test(
      mainText,
    );
  const rows: Record<string, unknown>[] = [];
  const refs = new Map<string, Record<string, unknown>>();
  let budget = 100000;
  const pictureKeyPattern =
    /^(?:id|__id|__typename|name|username|vanity|url|profile_url|group_url|profile_picture(?:\(|$)|profilePic(?:Large|Medium|Small)|profile_photo|cover_photo|group_cover_photo|cover_renderer|default_cover_photo|cover_photo_content|focused_image|viewer_image|full_image|primary_photo|image)/;
  const visit = (value: unknown, depth = 0): void => {
    if (!value || typeof value !== 'object' || depth > 40 || --budget < 0) return;
    if (Array.isArray(value)) {
      for (const v of value) visit(v, depth + 1);
      return;
    }
    const row = value as Record<string, unknown>;
    const id = String(row.id ?? row.__id ?? '');
    if (id) refs.set(id, row);
    if (matchesTargetEntity(row, targetKind, expectedId, canonicalId, location.origin)) {
      rows.push(
        Object.fromEntries(Object.entries(row).filter(([key]) => pictureKeyPattern.test(key))),
      );
    }
    for (const [key, v] of Object.entries(row)) {
      if (v && typeof v === 'object' && !Array.isArray(v))
        refs.set(key, v as Record<string, unknown>);
      visit(v, depth + 1);
    }
  };
  // Read only the target entity and its picture references from the active Relay environment.
  const hosts = mainRoot
    ? [mainRoot, ...Array.from(mainRoot.querySelectorAll('h1,svg image,img')).slice(0, 40)]
    : [];
  const environments = new Set<unknown>();
  for (const host of hosts) {
    const fiberKey = Object.keys(host).find((k) => k.startsWith('__reactFiber$'));
    let fiber = fiberKey ? (Reflect.get(host, fiberKey) as Record<string, unknown> | null) : null;
    for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber.return as typeof fiber) {
      const props = fiber.memoizedProps as Record<string, unknown> | undefined;
      if (!props) continue;
      const value = props.value as Record<string, unknown> | undefined;
      const queries = props.queries as Record<string, { environment?: unknown }> | undefined;
      for (const env of [
        props.environment,
        value?.environment,
        ...Object.values(queries ?? {}).map((q) => q?.environment),
      ]) {
        if (!env || environments.has(env)) continue;
        environments.add(env);
        try {
          type RelayEnv = {
            getStore(): { getSource(): { get(id: string): Record<string, unknown> | null } };
          };
          const source = (env as RelayEnv).getStore().getSource();
          const entity = source.get(canonicalId ?? expectedId);
          if (
            !entity ||
            !['User', 'Page', 'Group'].includes(String(entity.__typename)) ||
            String(entity.id ?? entity.__id) !== (canonicalId ?? expectedId)
          )
            continue;
          const linked = new Set<string>();
          const loadPictures = (v: unknown, depth = 0): void => {
            if (!v || typeof v !== 'object' || depth > 8 || linked.size > 40) return;
            const ref = (v as Record<string, unknown>).__ref;
            if (typeof ref === 'string' && !linked.has(ref)) {
              linked.add(ref);
              const row = source.get(ref);
              if (row) {
                refs.set(ref, row);
                loadPictures(row, depth + 1);
              }
            }
            for (const child of Object.values(v)) loadPictures(child, depth + 1);
          };
          const scoped = Object.fromEntries(
            Object.entries(entity).filter(([key]) => pictureKeyPattern.test(key)),
          );
          loadPictures(scoped);
          visit(scoped);
        } catch {}
      }
    }
  }
  for (const s of Array.from(document.scripts)) {
    const text = s.textContent || '';
    if (!text || text.length > 2_000_000 || (!text.startsWith('{') && !text.includes('"__bbox"')))
      continue;
    try {
      visit(JSON.parse(text) as unknown);
    } catch {}
  }
  const needed: Record<string, unknown> = {};
  const gather = (v: unknown, depth = 0): void => {
    if (!v || typeof v !== 'object' || depth > 8) return;
    for (const [key, val] of Object.entries(v)) {
      if (key === '__ref' && typeof val === 'string' && !needed[val] && refs.has(val)) {
        const row = refs.get(val);
        needed[val] = row;
        gather(row, depth + 1);
      } else gather(val, depth + 1);
    }
  };
  const score = (row: Record<string, unknown>) =>
    Object.entries(row).reduce(
      (n, [k, v]) =>
        n +
        (v &&
        typeof v === 'object' &&
        /^(?:profile_picture|profilePic|profile_photo|cover_photo|group_cover_photo|cover_renderer|default_cover_photo|focused_image| primary_photo)/.test(
          k,
        )
          ? 10
          : 0),
      0,
    );
  rows.sort((a, b) => score(b) - score(a));
  rows.slice(0, 12).forEach((row) => gather(row));
  const json = JSON.stringify({ entities: rows.slice(0, 12), references: needed });
  const summary = JSON.stringify({
    rows: rows.length,
    keys: rows.slice(0, 3).map((r) => Object.keys(r)),
    hasDomName: !!domName,
    hasDomAvatar: !!domAvatarUrl,
  });
  const metasJoined = metaParts.join('').slice(0, 60000);
  const scopedHtml =
    metasJoined +
    (json.length <= 220000
      ? '<script type="application/json">' + json.replace(/<\/script/gi, '<\\/script') + '</script>'
      : '');
  return {
    ...emptyResult(true),
    unavailableTarget,
    canonicalId,
    domName,
    domAvatarUrl,
    scopedHtml,
    summary,
  };
}
export const extractTargetCandidateInPage = serializeDomEval<
  (input: TargetCandidateInput) => InPageTargetProbeResult
>('extractTargetCandidateInPage', extractTargetCandidateEntry, { createTargetDomHelpers });
