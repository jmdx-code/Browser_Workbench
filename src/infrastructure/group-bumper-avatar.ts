import { MAX_ACCOUNT_AVATAR_BYTES } from '../shared/account-state-policy.js';
import { isLocalAvatar, MAX_LOCAL_AVATAR_BYTES } from '../shared/group-bumper.js';

export const MAX_AVATAR_DOWNLOAD_BYTES = 4 * 1024 * 1024; // 4MB

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
    .replace(/&(quot|apos|#039|lt|gt|nbsp|amp);/gi, (full, entity: string) => {
      switch (entity.toLowerCase()) {
        case 'quot':
          return '"';
        case 'apos':
        case '#039':
          return "'";
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'nbsp':
          return ' ';
        case 'amp':
          return '&';
        default:
          return full;
      }
    })
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

  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
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

  const entities: Record<string, unknown>[] = [],
    records = new Map<string, Record<string, unknown>>();
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
      const value = row[key];
      if (
        typeof value === 'string' &&
        /^https:\/\//.test(value) &&
        !/^https:\/\/(?:www\.)?facebook\.com\//i.test(value) &&
        !/static\.xx\.fbcdn\.net\/rsrc\.php/.test(value) &&
        !/\/rsrc\.php\//i.test(value) &&
        !/\/emoji\.php\//i.test(value)
      )
        return value;
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

export async function localizeAvatarBytesToDataUrl(bytes: Uint8Array): Promise<string | null> {
  if (!bytes || bytes.byteLength < 16 || bytes.byteLength > MAX_AVATAR_DOWNLOAD_BYTES) return null;
  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const image = await loadImage(Buffer.from(bytes));
    const width = Number(image.width);
    const height = Number(image.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16)
      return null;

    for (const maxDim of [256, 160, 128]) {
      const scale = Math.min(1, maxDim / Math.max(width, height));
      const targetW = Math.max(1, Math.round(width * scale));
      const targetH = Math.max(1, Math.round(height * scale));
      const canvas = createCanvas(targetW, targetH);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0, targetW, targetH);

      for (const mime of ['image/webp', 'image/jpeg'] as const) {
        for (const quality of [80, 60]) {
          try {
            const encoded =
              mime === 'image/webp'
                ? canvas.toBuffer('image/webp', quality)
                : canvas.toBuffer('image/jpeg', quality);
            const dataUrl = `data:${mime};base64,${Buffer.from(encoded).toString('base64')}`;
            if (isLocalAvatar(dataUrl) && dataUrl.length <= MAX_LOCAL_AVATAR_BYTES) {
              return dataUrl;
            }
          } catch {
            /* Try next format or quality */
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

const EXTERNAL_HIT_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const BROWSER_FALLBACK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

async function readBoundedImageStream(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (
    response.url &&
    (/\/rsrc\.php\//i.test(response.url) ||
      /\/emoji\.php\//i.test(response.url) ||
      /\/login\b/i.test(response.url))
  ) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('image/') || contentType.startsWith('image/svg')) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_AVATAR_DOWNLOAD_BYTES) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
  }
  if (!response.body) return null;
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
  if (total < 16) return null;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export async function fetchAndLocalizeAvatar(
  avatarUrl: string | null | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  if (typeof avatarUrl !== 'string') return null;
  const trimmed = avatarUrl.trim();
  if (!trimmed) return null;
  if (isLocalAvatar(trimmed)) return trimmed;
  if (
    !/^https?:\/\//i.test(trimmed) ||
    /\/rsrc\.php\//i.test(trimmed) ||
    /\/emoji\.php\//i.test(trimmed)
  )
    return null;

  const timeoutSignal = AbortSignal.timeout(8_000);
  const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

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
        const localized = await localizeAvatarBytesToDataUrl(bytes);
        if (localized) return localized;
      }
    } catch {
      /* Try fallback UA or return null */
    }
  }
  return null;
}

const accountAvatarSingleflight = new Map<string, Promise<string | null>>();

export async function localizeAccountAvatarBytesToDataUrl(
  bytes: Uint8Array,
): Promise<string | null> {
  if (!bytes || bytes.byteLength < 16 || bytes.byteLength > MAX_AVATAR_DOWNLOAD_BYTES) return null;
  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const image = await loadImage(Buffer.from(bytes));
    const width = Number(image.width);
    const height = Number(image.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16)
      return null;

    for (const maxDim of [96, 80, 64]) {
      const scale = Math.min(1, maxDim / Math.max(width, height));
      const targetW = Math.max(1, Math.round(width * scale));
      const targetH = Math.max(1, Math.round(height * scale));
      const canvas = createCanvas(targetW, targetH);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0, targetW, targetH);

      for (const mime of ['image/webp', 'image/jpeg'] as const) {
        for (const quality of [80, 65]) {
          try {
            const encoded =
              mime === 'image/webp'
                ? canvas.toBuffer('image/webp', quality)
                : canvas.toBuffer('image/jpeg', quality);
            const dataUrl = `data:${mime};base64,${Buffer.from(encoded).toString('base64')}`;
            if (isLocalAvatar(dataUrl) && dataUrl.length <= MAX_ACCOUNT_AVATAR_BYTES) {
              return dataUrl;
            }
          } catch {
            /* Try next format or quality */
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchAndLocalizeAccountAvatar(
  avatarUrl: string | null | undefined,
  signal?: AbortSignal,
  singleflightKey?: string,
): Promise<string | null> {
  if (typeof avatarUrl !== 'string') return null;
  const trimmed = avatarUrl.trim();
  if (!trimmed) return null;
  if (isLocalAvatar(trimmed)) return trimmed;
  if (
    !/^https?:\/\//i.test(trimmed) ||
    /\/rsrc\.php\//i.test(trimmed) ||
    /\/emoji\.php\//i.test(trimmed)
  )
    return null;

  const key = singleflightKey ? `${singleflightKey}|${trimmed}` : trimmed;
  const existing = accountAvatarSingleflight.get(key);
  if (existing) return existing;

  const task = (async (): Promise<string | null> => {
    const timeoutSignal = AbortSignal.timeout(6_000);
    const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
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
          const localized = await localizeAccountAvatarBytesToDataUrl(bytes);
          if (localized) return localized;
        }
      } catch {
        /* Try fallback UA or return null */
      }
    }
    return null;
  })().finally(() => {
    accountAvatarSingleflight.delete(key);
  });

  accountAvatarSingleflight.set(key, task);
  return task;
}

export async function verifyTargetAvatar(
  url: string | null,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!url || timeoutMs <= 0) return null;
  if (isLocalAvatar(url)) return url.trim();
  const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
  const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const localized = await fetchAndLocalizeAvatar(url, effectiveSignal);
  if (localized) return localized;
  return null;
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
      headers: {
        'User-Agent': EXTERNAL_HIT_UA,
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (response.ok && !/\/login\b/i.test(response.url)) {
      const html = await response.text();
      const parsed = parseTargetMetadataFromHtml(html, kind, id);
      canonicalId = parsed.canonicalId;
      name = parsed.name;
      rawAvatarUrl = parsed.avatarUrl;
    }
  } catch {
    /* Network failure does not block target persistence */
  }

  const graphTargetId = canonicalId && /^\d+$/.test(canonicalId) ? canonicalId : id;
  if (kind === 'pages' && (!rawAvatarUrl || !canonicalId) && /^\d+$/.test(graphTargetId)) {
    try {
      const graphSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(500, deadline - Date.now()))])
        : AbortSignal.timeout(Math.max(500, deadline - Date.now()));
      const graphRes = await fetch(
        `https://graph.facebook.com/${encodeURIComponent(graphTargetId)}/picture?type=large&redirect=false`,
        {
          signal: graphSignal,
          headers: { 'User-Agent': EXTERNAL_HIT_UA },
        },
      );
      if (graphRes.ok) {
        const payload = (await graphRes.json()) as {
          data?: { url?: string; is_silhouette?: boolean };
        };
        const picUrl = payload.data?.url;
        if (picUrl?.startsWith('https://') && !payload.data?.is_silhouette) {
          rawAvatarUrl ??= picUrl;
        }
      }
    } catch {
      /* Graph fallback is optional */
    }
  }

  const avatarUrl = rawAvatarUrl ? await fetchAndLocalizeAvatar(rawAvatarUrl, signal) : null;
  return { canonicalId, name, avatarUrl };
}

export async function fetchBumperAvatar(
  kind: 'groups' | 'pages',
  id: string,
): Promise<string | null> {
  const resolved = await resolveBumperTargetMetadata(kind, id);
  return resolved.avatarUrl;
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
      observed: {
        state: 'logged-in';
        id?: string | null;
        name?: string | null;
        avatar: string;
      },
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
              if (graphResult && isLocalAvatar(graphResult)) {
                localized = graphResult;
              } else if (graphResult && graphResult.startsWith('https://')) {
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
      } catch {
        // Silent background localization; preserve existing remote avatar on any error.
      }
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
