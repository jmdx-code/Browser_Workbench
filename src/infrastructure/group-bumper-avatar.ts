import { MAX_ACCOUNT_AVATAR_BYTES } from '../shared/account-state-policy.js';
import { isLocalAvatar, MAX_LOCAL_AVATAR_BYTES } from '../shared/group-bumper.js';
export const MAX_AVATAR_DOWNLOAD_BYTES = 4 * 1024 * 1024; // 4MB
const HTML_ENTITIES: Record<string, string> = {
  quot: '"',
  apos: "'",
  '#039': "'",
  lt: '<',
  gt: '>',
  nbsp: ' ',
  amp: '&',
};
export function decodeHtmlEntities(raw: string): string {
  const decoded = raw
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(
      /&(quot|apos|#039|lt|gt|nbsp|amp);/gi,
      (full, entity: string) => HTML_ENTITIES[entity.toLowerCase()] ?? full,
    )
    .replace(/\s+/g, ' ')
    .replace(/^\(\d+\+?\)\s*/, '')
    .replace(/\s*[|-]\s*Facebook\s*$/i, '')
    .trim();
  if (
    !decoded ||
    /^(?:Facebook|Log in or sign up to view|Log into Facebook|Log In|登录 Facebook|登入 Facebook|請先登入|请先登录|Error|错误|找不到内容|Content Not Found|目前無法查看此內容|目前无法查看此内容)$/i.test(
      decoded,
    )
  ) {
    return '';
  }
  return decoded;
}
export interface ResolvedTargetMetadata {
  canonicalId: string | null;
  name: string | null;
  avatarUrl: string | null;
}
export function parseTargetMetadataFromHtml(
  html: string,
  kind: 'groups' | 'pages',
  expectedId?: string,
): ResolvedTargetMetadata {
  let canonicalId: string | null = null;
  let name: string | null = null;
  let avatarUrl: string | null = null;
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const prop = /(?:property|name)=["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    const rawContent = /content=["']([^"']+)["']/i.exec(tag)?.[1] ?? '';
    if (!prop || !rawContent) continue;
    if (prop === 'al:android:url' || prop === 'al:ios:url') {
      const match =
        kind === 'pages'
          ? /fb:\/\/(?:profile|page)\/(\d+)/i.exec(rawContent)
          : /fb:\/\/group\/(\d+)/i.exec(rawContent);
      if (match?.[1]) canonicalId ??= match[1];
    } else if (prop === 'og:title' || prop === 'twitter:title') {
      const cleaned = decodeHtmlEntities(rawContent);
      if (cleaned) name ??= cleaned;
    } else if (prop === 'og:image' || prop === 'twitter:image') {
      const url = rawContent.replace(/&amp;/g, '&').trim();
      if (url.startsWith('https://') && !/static\.xx\.fbcdn\.net\/rsrc\.php/i.test(url)) {
        avatarUrl ??= url;
      }
    }
  }
  if (!name) {
    const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
    if (titleMatch) {
      const cleaned = decodeHtmlEntities(titleMatch);
      if (cleaned) name = cleaned;
    }
  }
  const entities: Record<string, unknown>[] = [];
  const records = new Map<string, Record<string, unknown>>();
  let budget = 100000;
  const collect = (value: unknown, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 40 || --budget < 0) return;
    if (Array.isArray(value)) {
      for (const v of value) collect(v, depth + 1);
      return;
    }
    const row = value as Record<string, unknown>;
    if (typeof (row.__id ?? row.id) === 'string') records.set(String(row.__id ?? row.id), row);
    entities.push(row);
    for (const [key, v] of Object.entries(row)) {
      if (v && typeof v === 'object' && !Array.isArray(v))
        records.set(key, v as Record<string, unknown>);
      collect(v, depth + 1);
    }
  };
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      collect(JSON.parse((match[1] ?? '').trim().replace(/^for\s*\(;;\);\s*/, '')) as unknown);
    } catch {}
  }
  const picture = (value: unknown, depth = 0): string | null => {
    if (!value || typeof value !== 'object' || depth > 8) return null;
    const row = value as Record<string, unknown>;
    for (const key of ['uri', 'url']) {
      const val = row[key];
      if (
        typeof val === 'string' &&
        /^https:\/\//.test(val) &&
        !/^https:\/\/(?:www\.)?facebook\.com\//i.test(val) &&
        !/static\.xx\.fbcdn\.net\/rsrc\.php|\/rsrc\.php\/|\/emoji\.php\//i.test(val)
      )
        return val;
    }
    if (typeof row.__ref === 'string') return picture(records.get(row.__ref), depth + 1);
    for (const key of [
      'image',
      'photo',
      'profile_picture',
      'cover_photo',
      'group_cover_photo',
      'cover_renderer',
      'default_cover_photo',
      'cover_photo_content',
      'focused_image',
      'viewer_image',
      'full_image',
      'primary_photo',
    ]) {
      const url = picture(row[key], depth + 1);
      if (url) return url;
    }
    return null;
  };
  let entityAvatar: string | null = null;
  for (const row of entities) {
    const id = String(row.id ?? row.__id ?? '');
    const type = String(row.__typename ?? '');
    if (type && !(kind === 'groups' ? /^Group$/ : /^(?:User|Page|Profile)$/).test(type)) continue;
    let matches = !!id && (id === expectedId || id === canonicalId);
    if (expectedId && !/^\d+$/.test(expectedId)) {
      matches ||= row.username === expectedId || row.vanity === expectedId;
      for (const key of ['url', 'profile_url', 'group_url'])
        if (typeof row[key] === 'string') {
          try {
            const u = new URL(row[key], 'https://www.facebook.com');
            matches ||=
              u.origin === 'https://www.facebook.com' &&
              u.pathname.replace(/\/$/, '').toLowerCase() ===
                (kind === 'groups' ? '/groups/' : '/') + expectedId.toLowerCase();
          } catch {}
        }
    }
    if (!matches) continue;
    if (/^\d+$/.test(id)) canonicalId ??= id;
    if (typeof row.name === 'string') name ||= decodeHtmlEntities(row.name) || null;
    const fields = Object.entries(row).filter(([key]) =>
      /^(?:cover_photo|group_cover_photo|cover_renderer|default_cover_photo|cover_photo_content|profile_picture|profilePic|primary_photo|focused_image|profile_photo)/.test(
        key,
      ),
    );
    fields.sort(([a], [b]) => {
      const rank = (key: string) =>
        kind === 'groups'
          ? /^(?:cover_photo|group_cover_photo|cover_renderer|default_cover_photo|cover_photo_content)/.test(
              key,
            )
            ? 0
            : 1
          : key === 'profilePicLarge'
            ? 0
            : key.startsWith('profile_picture')
              ? 1
              : key === 'profilePicMedium'
                ? 2
                : 3;
      return rank(a) - rank(b);
    });
    for (const [, value] of fields) entityAvatar ||= picture(value);
  }
  return { canonicalId, name, avatarUrl: entityAvatar ?? avatarUrl };
}
async function encodeAvatarBytesWithBudget(
  bytes: Uint8Array,
  maxDims: readonly number[],
  qualities: readonly number[],
  maxBytes: number,
): Promise<string | null> {
  if (!bytes || bytes.byteLength < 16 || bytes.byteLength > MAX_AVATAR_DOWNLOAD_BYTES) return null;
  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const image = await loadImage(Buffer.from(bytes));
    const width = Number(image.width);
    const height = Number(image.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16)
      return null;
    for (const maxDim of maxDims) {
      const scale = Math.min(1, maxDim / Math.max(width, height));
      const targetW = Math.max(1, Math.round(width * scale));
      const targetH = Math.max(1, Math.round(height * scale));
      const canvas = createCanvas(targetW, targetH);
      canvas.getContext('2d').drawImage(image, 0, 0, targetW, targetH);
      for (const mime of ['image/webp', 'image/jpeg'] as const) {
        for (const quality of qualities) {
          try {
            const encoded =
              mime === 'image/webp'
                ? canvas.toBuffer('image/webp', quality)
                : canvas.toBuffer('image/jpeg', quality);
            const dataUrl = `data:${mime};base64,${Buffer.from(encoded).toString('base64')}`;
            if (isLocalAvatar(dataUrl) && dataUrl.length <= maxBytes) return dataUrl;
          } catch {}
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}
export const localizeAvatarBytesToDataUrl = (bytes: Uint8Array): Promise<string | null> =>
  encodeAvatarBytesWithBudget(bytes, [256, 160, 128], [80, 60], MAX_LOCAL_AVATAR_BYTES);
export const localizeAccountAvatarBytesToDataUrl = (bytes: Uint8Array): Promise<string | null> =>
  encodeAvatarBytesWithBudget(bytes, [96, 80, 64], [80, 65], MAX_ACCOUNT_AVATAR_BYTES);
const EXTERNAL_HIT_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const BROWSER_FALLBACK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
async function readBoundedImageStream(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  const drop = async () => {
    await response.body?.cancel().catch(() => {});
    return null;
  };
  if (
    !response.ok ||
    (response.url && /\/rsrc\.php\/|\/emoji\.php\/|\/login\b/i.test(response.url))
  )
    return drop();
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('image/') || contentType.startsWith('image/svg')) return drop();
  const cl = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if ((Number.isFinite(cl) && cl > MAX_AVATAR_DOWNLOAD_BYTES) || !response.body) return drop();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        return null;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > MAX_AVATAR_DOWNLOAD_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error('AVATAR_DOWNLOAD_TOO_LARGE');
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return total < 16 ? null : Buffer.concat(chunks, total);
}
async function fetchLocalizedAvatarWithBudget(
  avatarUrl: string | null | undefined,
  opts: {
    timeoutMs: number;
    signal?: AbortSignal;
    encode: (bytes: Uint8Array) => Promise<string | null>;
  },
): Promise<string | null> {
  if (typeof avatarUrl !== 'string') return null;
  const trimmed = avatarUrl.trim();
  if (!trimmed) return null;
  if (isLocalAvatar(trimmed)) return trimmed;
  if (!/^https?:\/\//i.test(trimmed) || /\/rsrc\.php\/|\/emoji\.php\//i.test(trimmed)) return null;
  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
  const effectiveSignal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;
  for (const ua of [EXTERNAL_HIT_UA, BROWSER_FALLBACK_UA]) {
    if (effectiveSignal.aborted) return null;
    try {
      const response = await fetch(trimmed, {
        signal: effectiveSignal,
        headers: {
          'User-Agent': ua,
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
      });
      const bytes = await readBoundedImageStream(response, effectiveSignal);
      if (bytes) {
        const localized = await opts.encode(bytes);
        if (localized) return localized;
      }
    } catch {}
  }
  return null;
}
export const fetchAndLocalizeAvatar = (
  avatarUrl: string | null | undefined,
  signal?: AbortSignal,
): Promise<string | null> =>
  fetchLocalizedAvatarWithBudget(avatarUrl, {
    timeoutMs: 8_000,
    signal,
    encode: localizeAvatarBytesToDataUrl,
  });
const accountAvatarSingleflight = new Map<string, Promise<string | null>>();
export async function fetchAndLocalizeAccountAvatar(
  avatarUrl: string | null | undefined,
  signal?: AbortSignal,
  singleflightKey?: string,
): Promise<string | null> {
  if (typeof avatarUrl !== 'string') return null;
  const trimmed = avatarUrl.trim();
  if (!trimmed) return null;
  if (isLocalAvatar(trimmed)) return trimmed;
  if (!/^https?:\/\//i.test(trimmed) || /\/rsrc\.php\/|\/emoji\.php\//i.test(trimmed)) return null;
  const key = singleflightKey ? `${singleflightKey}|${trimmed}` : trimmed;
  const existing = accountAvatarSingleflight.get(key);
  if (existing) return existing;
  const task = fetchLocalizedAvatarWithBudget(trimmed, {
    timeoutMs: 6_000,
    signal,
    encode: localizeAccountAvatarBytesToDataUrl,
  }).finally(() => {
    accountAvatarSingleflight.delete(key);
  });
  accountAvatarSingleflight.set(key, task);
  return task;
}
export async function resolveBumperTargetMetadata(
  kind: 'groups' | 'pages',
  rawId: string,
  signal?: AbortSignal,
): Promise<ResolvedTargetMetadata> {
  const id = rawId.trim();
  if (!id) return { canonicalId: null, name: null, avatarUrl: null };
  const url =
    kind === 'groups'
      ? `https://www.facebook.com/groups/${encodeURIComponent(id)}/`
      : /^\d+$/.test(id)
        ? `https://www.facebook.com/profile.php?id=${encodeURIComponent(id)}`
        : `https://www.facebook.com/${encodeURIComponent(id)}`;
  let canonicalId: string | null = null;
  let name: string | null = null;
  let rawAvatarUrl: string | null = null;
  const deadline = Date.now() + 8000;
  try {
    const htmlSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(6000)])
      : AbortSignal.timeout(6000);
    const response = await fetch(url, {
      signal: htmlSignal,
      headers: { 'User-Agent': EXTERNAL_HIT_UA, Accept: 'text/html,application/xhtml+xml' },
    });
    if (response.ok && !/\/login\b/i.test(response.url)) {
      const parsed = parseTargetMetadataFromHtml(await response.text(), kind, id);
      canonicalId = parsed.canonicalId;
      name = parsed.name;
      rawAvatarUrl = parsed.avatarUrl;
    }
  } catch {}
  const graphTargetId = canonicalId && /^\d+$/.test(canonicalId) ? canonicalId : id;
  if (kind === 'pages' && (!rawAvatarUrl || !canonicalId) && /^\d+$/.test(graphTargetId)) {
    try {
      const timeout = AbortSignal.timeout(Math.max(500, deadline - Date.now()));
      const graphRes = await fetch(
        `https://graph.facebook.com/${encodeURIComponent(graphTargetId)}/picture?type=large&redirect=false`,
        {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: { 'User-Agent': EXTERNAL_HIT_UA },
        },
      );
      if (graphRes.ok) {
        const payload = (await graphRes.json()) as {
          data?: { url?: string; is_silhouette?: boolean };
        };
        if (payload.data?.url?.startsWith('https://') && !payload.data?.is_silhouette)
          rawAvatarUrl ??= payload.data.url;
      }
    } catch {}
  }
  return {
    canonicalId,
    name,
    avatarUrl: rawAvatarUrl ? await fetchAndLocalizeAvatar(rawAvatarUrl, signal) : null,
  };
}
export interface StartupAccountAvatarLocalizationDeps {
  repository: {
    profileAccountCache():
      | ReadonlyMap<
          string,
          { state: string; id?: string | null; name?: string | null; avatar?: string | null }
        >
      | Promise<
          ReadonlyMap<
            string,
            { state: string; id?: string | null; name?: string | null; avatar?: string | null }
          >
        >;
    updateProfileAccountCache(
      profileId: string,
      patch: { state: 'logged-in'; id?: string | null; avatar: string },
    ): unknown;
  };
  inspection?: {
    syncExternalObservation(
      profileId: string,
      observed: { state: 'logged-in'; id?: string | null; name?: string | null; avatar: string },
    ): void;
  };
  graphAvatarLookup?: (accountId: string) => Promise<string | null>;
  delayMs?: number;
  forceInTests?: boolean;
  isShuttingDown: () => boolean;
}
export interface StartupAccountAvatarLocalizationHandle {
  cancel(): void;
}
export function scheduleStartupAccountAvatarLocalization(
  deps: StartupAccountAvatarLocalizationDeps,
): StartupAccountAvatarLocalizationHandle {
  if (
    !deps.forceInTests &&
    (process.env.WORKBENCH_DIAGNOSTICS === '1' || process.env.NODE_TEST_CONTEXT)
  ) {
    return { cancel: () => {} };
  }
  const abortController = new AbortController();
  const timer = setTimeout(() => {
    void (async () => {
      try {
        if (abortController.signal.aborted || deps.isShuttingDown()) return;
        const entries = [...(await deps.repository.profileAccountCache()).entries()].filter(
          ([, row]) =>
            row.state === 'logged-in' &&
            typeof row.avatar === 'string' &&
            row.avatar.startsWith('https://'),
        );
        let cursor = 0;
        const worker = async () => {
          while (
            !abortController.signal.aborted &&
            !deps.isShuttingDown() &&
            cursor < entries.length
          ) {
            const item = entries[cursor++];
            if (!item) break;
            const [profileId, row] = item;
            if (!row.avatar) continue;
            let localized = await fetchAndLocalizeAccountAvatar(
              row.avatar,
              abortController.signal,
              `${profileId}:${row.id ?? ''}`,
            ).catch(() => null);
            if (
              !localized &&
              !abortController.signal.aborted &&
              !deps.isShuttingDown() &&
              row.id &&
              /^\d+$/.test(row.id.trim()) &&
              deps.graphAvatarLookup
            ) {
              const graphResult = await deps.graphAvatarLookup(row.id.trim()).catch(() => null);
              if (graphResult && isLocalAvatar(graphResult)) localized = graphResult;
              else if (graphResult && graphResult.startsWith('https://')) {
                localized = await fetchAndLocalizeAccountAvatar(
                  graphResult,
                  abortController.signal,
                  `${profileId}:${row.id}`,
                ).catch(() => null);
              }
            }
            if (!localized || abortController.signal.aborted || deps.isShuttingDown()) continue;
            const latest = (await deps.repository.profileAccountCache()).get(profileId);
            if (
              latest?.state === 'logged-in' &&
              !isLocalAvatar(latest.avatar) &&
              (!row.id || latest.id === row.id)
            ) {
              await deps.repository.updateProfileAccountCache(profileId, {
                state: 'logged-in',
                ...(latest.id ? { id: latest.id } : {}),
                avatar: localized,
              });
              deps.inspection?.syncExternalObservation(profileId, {
                state: 'logged-in',
                id: latest.id,
                name: latest.name,
                avatar: localized,
              });
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(3, entries.length) }, () => worker()));
      } catch {}
    })();
  }, deps.delayMs ?? 5_000);
  timer.unref();
  return {
    cancel: () => {
      clearTimeout(timer);
      abortController.abort();
    },
  };
}
