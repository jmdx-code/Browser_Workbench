import type { FeedTargetPage } from './contracts.js';
const tryDecode = (s: string, spaced = false) => {
  let out = s;
  try {
    out = decodeURIComponent(s);
  } catch {}
  return spaced ? out.replace(/[-_]+/g, ' ').trim() : out;
};
function extractFacebookPageFromUrl(rawUrl: string): { id?: string; fallbackName?: string } | null {
  try {
    const u = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : 'https://' + rawUrl);
    if (!/(?:^|\.)facebook\.com$/i.test(u.hostname)) return null;
    if (/^\/profile\.php$/i.test(u.pathname)) {
      const pid = u.searchParams.get('id')?.trim() ?? '';
      return /^\d{5,25}$/.test(pid) ? { id: pid, fallbackName: pid } : null;
    }
    const pp = /^\/(?:people|pages)\/([^/]+)\/(\d{5,25})\/?$/i.exec(u.pathname);
    if (pp?.[2]) return { id: pp[2], fallbackName: tryDecode(pp[1] ?? '', true) || pp[2] };
    const mp = /^\/p\/([^/]{2,180})\/?$/i.exec(u.pathname);
    if (mp?.[1]) {
      const slug = mp[1],
        tid = /-(\d{5,25})$/.exec(slug)?.[1];
      const decoded = tryDecode(tid ? slug.slice(0, -(tid.length + 1)) : slug, true);
      return { id: tid ?? slug, fallbackName: decoded || tid || slug };
    }
    const sg = /^\/([^/?#]+)\/?$/.exec(u.pathname);
    return sg?.[1] &&
      !/^(?:profile\.php|home\.php|search|groups|watch|reels|marketplace|friends)$/i.test(sg[1])
      ? { id: sg[1], fallbackName: tryDecode(sg[1]) }
      : null;
  } catch {
    return null;
  }
}
export function parseFeedTargetPagesText(raw: string): FeedTargetPage[] {
  const seen = new Set<string>(),
    out: FeedTargetPage[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let name = '',
      id: string | undefined;
    const urlMatch = /(?:https?:\/\/)?(?:www\.|m\.)?facebook\.com\/[^\s,，\t]+/i.exec(line);
    if (urlMatch?.[0]) {
      const extracted = extractFacebookPageFromUrl(urlMatch[0]);
      if (extracted) {
        id = extracted.id;
        const remainder = line
          .replace(urlMatch[0], '')
          .replace(/^[\s,，\t\-–—:|]+|[\s,，\t\-–—:|]+$/g, '')
          .trim();
        name = remainder || extracted.fallbackName || id || '';
      }
    }
    if (!name) {
      const parts = line
        .split(/[,，\t]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length >= 2 && parts[0] && parts[1]) {
        const firstIsId = /^\d{5,25}$/.test(parts[0]) && !/^\d{5,25}$/.test(parts[1]);
        id = firstIsId ? parts[0] : parts[1];
        name = firstIsId ? parts[1] : parts[0];
      } else if (parts[0]) {
        name = parts[0];
        if (/^\d{5,25}$/.test(parts[0])) id = parts[0];
      }
    }
    name = name.trim().slice(0, 200);
    if (id) id = id.trim().slice(0, 120);
    if (!name) continue;
    const dedupeKey = id ? `id:${id.toLowerCase()}` : `name:${name.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(id ? { id, name } : { name });
    if (out.length >= 100) break;
  }
  return out;
}
export const formatFeedTargetPagesText = (pages: readonly FeedTargetPage[]): string =>
  pages.map((p) => (p.id && p.id !== p.name ? `${p.name}, ${p.id}` : p.name)).join('\n');
