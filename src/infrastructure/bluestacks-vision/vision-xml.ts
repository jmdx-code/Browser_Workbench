import { createHash } from 'node:crypto';
import type { Canvas, SKRSContext2D } from '@napi-rs/canvas';
export const CANONICAL_WIDTH = 900;
export const CANONICAL_HEIGHT = 1600;
export interface RectBounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}
export interface LiteXmlNode {
  index: number;
  text: string;
  resourceId: string;
  className: string;
  packageName: string;
  contentDesc: string;
  clickable: boolean;
  longClickable: boolean;
  focused: boolean;
  scrollable: boolean;
  bounds: RectBounds;
  children: LiteXmlNode[];
}
export function makeCanonicalRect(x1: number, y1: number, x2: number, y2: number): RectBounds {
  const cx1 = Math.max(0, Math.min(CANONICAL_WIDTH, Math.round(x1))),
    cy1 = Math.max(0, Math.min(CANONICAL_HEIGHT, Math.round(y1)));
  const cx2 = Math.max(cx1, Math.min(CANONICAL_WIDTH, Math.round(x2))),
    cy2 = Math.max(cy1, Math.min(CANONICAL_HEIGHT, Math.round(y2)));
  const w = Math.max(0, cx2 - cx1),
    h = Math.max(0, cy2 - cy1);
  return {
    x1: cx1,
    y1: cy1,
    x2: cx2,
    y2: cy2,
    w,
    h,
    cx: Math.round(cx1 + w / 2),
    cy: Math.round(cy1 + h / 2),
  };
}
export function scaleBoundsTo900(
  rawX1: number,
  rawY1: number,
  rawX2: number,
  rawY2: number,
  screenW = CANONICAL_WIDTH,
  screenH = CANONICAL_HEIGHT,
): RectBounds {
  const sw = screenW > 0 ? screenW : CANONICAL_WIDTH,
    sh = screenH > 0 ? screenH : CANONICAL_HEIGHT;
  const sx = CANONICAL_WIDTH / sw,
    sy = CANONICAL_HEIGHT / sh;
  return makeCanonicalRect(rawX1 * sx, rawY1 * sy, rawX2 * sx, rawY2 * sy);
}
export function scalePointFrom900(
  x900: number,
  y900: number,
  screenW = CANONICAL_WIDTH,
  screenH = CANONICAL_HEIGHT,
): { x: number; y: number } {
  const sw = screenW > 0 ? screenW : CANONICAL_WIDTH,
    sh = screenH > 0 ? screenH : CANONICAL_HEIGHT;
  return {
    x: Math.max(0, Math.min(sw - 1, Math.round((x900 * sw) / CANONICAL_WIDTH))),
    y: Math.max(0, Math.min(sh - 1, Math.round((y900 * sh) / CANONICAL_HEIGHT))),
  };
}
export function parseBoundsString(
  raw: string,
  screenW = CANONICAL_WIDTH,
  screenH = CANONICAL_HEIGHT,
): RectBounds | null {
  const m = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(raw.trim());
  if (!m) return null;
  const b = scaleBoundsTo900(
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    screenW,
    screenH,
  );
  return b.w > 0 && b.h > 0 ? b : null;
}
const decodeXmlEntities = (raw: string) =>
  raw
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
function parseXmlAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {},
    attrRegex = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(attrText)) !== null)
    if (m[1]) attrs[m[1]] = decodeXmlEntities(m[2] ?? m[3] ?? '');
  return attrs;
}
const mkLiteNode = (bounds: RectBounds, className: string): LiteXmlNode => ({
  index: 0,
  text: '',
  resourceId: '',
  className,
  packageName: 'com.facebook.lite',
  contentDesc: '',
  clickable: false,
  longClickable: false,
  focused: false,
  scrollable: false,
  bounds,
  children: [],
});
export function parseLiteXml(
  xmlText: string,
  screenW = CANONICAL_WIDTH,
  screenH = CANONICAL_HEIGHT,
): LiteXmlNode | null {
  if (!xmlText || !xmlText.includes('<node')) return null;
  const tagRegex = /<\/?node\b([^>]*?)(\/?)>/g,
    stack: LiteXmlNode[] = [];
  let root: LiteXmlNode | null = null,
    skippedDepth = 0,
    match: RegExpExecArray | null;
  while ((match = tagRegex.exec(xmlText)) !== null) {
    const fullTag = match[0],
      attrPart = match[1] ?? '',
      selfClosing = match[2] === '/';
    if (fullTag.startsWith('</')) {
      if (skippedDepth > 0) skippedDepth--;
      else if (stack.length > 0) stack.pop();
      continue;
    }
    if (skippedDepth > 0) {
      if (!selfClosing) skippedDepth++;
      continue;
    }
    const attrs = parseXmlAttributes(attrPart);
    const bounds = parseBoundsString(attrs['bounds'] ?? '', screenW, screenH);
    if (!bounds) {
      if (!selfClosing) skippedDepth = 1;
      continue;
    }
    const node: LiteXmlNode = {
      index: Number(attrs['index'] ?? 0),
      text: attrs['text'] ?? '',
      resourceId: attrs['resource-id'] ?? '',
      className: attrs['class'] ?? '',
      packageName: attrs['package'] ?? '',
      contentDesc: attrs['content-desc'] ?? '',
      clickable: attrs['clickable'] === 'true',
      longClickable: attrs['long-clickable'] === 'true',
      focused: attrs['focused'] === 'true',
      scrollable: attrs['scrollable'] === 'true',
      bounds,
      children: [],
    };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else if (!root) root = node;
    if (!selfClosing) stack.push(node);
  }
  return root;
}
export function parseDumpsysTop(
  dumpsysText: string,
  screenW = CANONICAL_WIDTH,
  screenH = CANONICAL_HEIGHT,
): LiteXmlNode | null {
  const lines = dumpsysText.split(/\r?\n/);
  let inFbLiteActivity = false,
    currentActivityResumed = false,
    inHierarchy = false,
    hierarchyBaseIndent = -1;
  const stack: Array<{ indent: number; rawX1: number; rawY1: number; node: LiteXmlNode }> = [];
  let rootNode: LiteXmlNode | null = null,
    resumedRootNode: LiteXmlNode | null = null,
    lastValidRootNode: LiteXmlNode | null = null,
    skipUntilIndent = -1,
    effScreenW = screenW,
    effScreenH = screenH;
  const isFullViewportContainer = (n: LiteXmlNode): boolean =>
    n.bounds.w >= 840 && n.bounds.h >= 980 && n.bounds.y1 <= 260;
  const hasFullViewportScrollableDescendant = (n: LiteXmlNode): boolean =>
    n.children.some(
      (c) =>
        ((c.scrollable || c.className.includes('RecyclerView')) && isFullViewportContainer(c)) ||
        hasFullViewportScrollableDescendant(c),
    );
  const markStructuralFeedContainers = (node: LiteXmlNode, treeRoot: LiteXmlNode): void => {
    for (const c of node.children) markStructuralFeedContainers(c, treeRoot);
    if (node === treeRoot || node.clickable || node.children.length === 0) return;
    if (!isFullViewportContainer(node) || hasFullViewportScrollableDescendant(node)) return;
    if (/^(?:android|com\.android)\./.test(node.className) || node.className.includes('DecorView'))
      return;
    const hasFeedChildren =
      node.children.length >= 2 || node.children.some((c) => c.bounds.h < 980 || c.bounds.w < 840);
    if (!hasFeedChildren) return;
    node.scrollable = true;
    if (!node.className.includes('RecyclerView')) {
      node.className = 'androidx.recyclerview.widget.RecyclerView';
    }
  };
  const commitCurrentHierarchy = () => {
    if (rootNode && rootNode.children.length > 0) {
      markStructuralFeedContainers(rootNode, rootNode);
      lastValidRootNode = rootNode;
      if (currentActivityResumed) resumedRootNode = rootNode;
    }
  };
  const viewRegex =
    /^(\s+)([^\s{]+)\{[0-9a-f]+\s+(\S+)\s+(\S+)\s+(-?\d+),(-?\d+)-(-?\d+),(-?\d+)(?:\s+#[0-9a-f]+(?:\s+([^\s}]+))?)?[^}]*\}/;
  for (const line of lines) {
    if (/^\s*ACTIVITY\s+(\S+)/.test(line)) {
      commitCurrentHierarchy();
      inFbLiteActivity = Boolean(
        /^\s*ACTIVITY\s+(\S+)/.exec(line)?.[1]?.startsWith('com.facebook.lite/'),
      );
      currentActivityResumed = false;
      inHierarchy = false;
      rootNode = null;
      continue;
    }
    if (!inFbLiteActivity) continue;
    if (!inHierarchy) {
      if (/\bmResumed=true\b/.test(line)) currentActivityResumed = true;
      const hMatch = /^(\s+)View Hierarchy:\s*$/.exec(line);
      if (hMatch && hMatch[1] !== undefined) {
        inHierarchy = true;
        hierarchyBaseIndent = hMatch[1].length;
        effScreenW = screenW;
        effScreenH = screenH;
        stack.length = 0;
        rootNode = null;
        skipUntilIndent = -1;
      }
      continue;
    }
    const indent = /^(\s*)/.exec(line)?.[1]?.length ?? 0;
    if (line.trim().length > 0 && indent <= hierarchyBaseIndent) {
      commitCurrentHierarchy();
      inHierarchy = false;
      rootNode = null;
      continue;
    }
    if (skipUntilIndent !== -1) {
      if (indent > skipUntilIndent) continue;
      skipUntilIndent = -1;
    }
    if (!rootNode && (line.includes('DecorView@') || line.includes('DecorView{'))) {
      rootNode = mkLiteNode(
        makeCanonicalRect(0, 0, CANONICAL_WIDTH, CANONICAL_HEIGHT),
        'com.android.internal.policy.DecorView',
      );
      stack.push({ indent, rawX1: 0, rawY1: 0, node: rootNode });
      continue;
    }
    const m = viewRegex.exec(line);
    if (!m || !rootNode) continue;
    const rawClass = m[2] ?? '',
      f1 = m[3] ?? '',
      f2 = m[4] ?? '',
      relX1 = Number(m[5]),
      relY1 = Number(m[6]),
      relX2 = Number(m[7]),
      relY2 = Number(m[8]),
      resId = m[9] ?? '';
    if (f1[0] !== 'V') {
      skipUntilIndent = indent;
      continue;
    }
    while (stack.length > 1) {
      const topEntry = stack.at(-1);
      if (!topEntry || topEntry.indent < indent) break;
      stack.pop();
    }
    const parent = stack.at(-1);
    if (!parent) continue;
    const rawX1 = parent.rawX1 + relX1,
      rawY1 = parent.rawY1 + relY1,
      rawX2 = parent.rawX1 + relX2,
      rawY2 = parent.rawY1 + relY2;
    if (rawX2 <= rawX1 || rawY2 <= rawY1) {
      skipUntilIndent = indent;
      continue;
    }
    if (
      parent.node === rootNode &&
      rootNode.children.length === 0 &&
      relX1 === 0 &&
      relY1 === 0 &&
      relX2 >= 300 &&
      relY2 >= 300
    ) {
      effScreenW = relX2;
      effScreenH = relY2;
    }
    const scaled = scaleBoundsTo900(rawX1, rawY1, rawX2, rawY2, effScreenW, effScreenH);
    if (scaled.w === 0 || scaled.h === 0) {
      skipUntilIndent = indent;
      continue;
    }
    const isRecycler =
      rawClass.includes('RecyclerView') ||
      rawClass.includes('ListView') ||
      parent.node.className.includes('SwipeRefreshLayout');
    const node: LiteXmlNode = {
      index: parent.node.children.length,
      text: '',
      resourceId: resId,
      className: isRecycler ? 'androidx.recyclerview.widget.RecyclerView' : rawClass,
      packageName: 'com.facebook.lite',
      contentDesc: '',
      clickable: f1[6] === 'C' || f1[5] === 'C',
      longClickable: f1[7] === 'L' || f1[6] === 'L',
      focused: f2[1] === 'F',
      scrollable: isRecycler,
      bounds: scaled,
      children: [],
    };
    parent.node.children.push(node);
    stack.push({ indent, rawX1, rawY1, node });
  }
  commitCurrentHierarchy();
  return resumedRootNode ?? lastValidRootNode ?? rootNode;
}
export function flattenLiteNodes(root: LiteXmlNode | null): LiteXmlNode[] {
  if (!root) return [];
  const out: LiteXmlNode[] = [];
  const visit = (n: LiteXmlNode) => {
    out.push(n);
    for (const c of n.children) visit(c);
  };
  visit(root);
  return out;
}
const hashToNumericPostId = (seed: string) =>
  BigInt('0x' + createHash('sha256').update(seed).digest('hex').slice(0, 14)).toString(10);
async function fetchRedirectLocation(url: string): Promise<string | null> {
  const res = await fetch(url, {
    method: 'HEAD',
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
    headers: { 'User-Agent': 'facebookexternalhit/1.1' },
  });
  return res.headers.get('location');
}
export async function resolveSharePostUrl(
  rawUrl: string,
  fallbackGroupId: string,
  mode: 'group' | 'page' = 'group',
): Promise<{ postId: string; postUrl: string }> {
  const cleaned = rawUrl.trim();
  const extractFromUrl = (uStr: string): { postId: string; postUrl: string } | null => {
    try {
      const u = new URL(uStr);
      if (mode === 'page') {
        const reel = /^\/reel\/(\d+)/i.exec(u.pathname)?.[1];
        if (reel) return { postId: reel, postUrl: `https://www.facebook.com/reel/${reel}/` };
        const pv =
          /^\/([^/]+)\/videos\/(?:[^/]+\/)?(\d+)/i.exec(u.pathname) ??
          /^\/videos\/(\d+)/i.exec(u.pathname);
        if (pv) {
          const vid = pv[2] ?? pv[1],
            owner = pv[2] ? pv[1] : fallbackGroupId;
          if (vid && /^\d+$/.test(vid))
            return {
              postId: vid,
              postUrl: owner
                ? `https://www.facebook.com/${encodeURIComponent(owner)}/videos/${vid}/`
                : `https://www.facebook.com/watch/?v=${vid}`,
            };
        }
        const watchVid =
          u.pathname === '/watch/' || u.pathname === '/watch' ? u.searchParams.get('v') : null;
        if (watchVid && /^\d+$/.test(watchVid))
          return { postId: watchVid, postUrl: `https://www.facebook.com/watch/?v=${watchVid}` };
        const storyFbid = u.searchParams.get('story_fbid')?.trim() ?? '',
          ownerId = u.searchParams.get('id')?.trim() || fallbackGroupId;
        if (storyFbid) {
          const postId = /^\d+$/.test(storyFbid) ? storyFbid : hashToNumericPostId(storyFbid);
          return {
            postId,
            postUrl: `https://www.facebook.com/permalink.php?story_fbid=${encodeURIComponent(storyFbid)}&id=${encodeURIComponent(ownerId)}`,
          };
        }
        const pp = /^\/(?!groups\/|share\/)([^/]+)\/(?:posts|permalink)\/([^/?#]+)/i.exec(
          u.pathname,
        );
        if (pp?.[1] && pp[2]) {
          const rawPid = pp[2],
            postId = /^\d+$/.test(rawPid) ? rawPid : hashToNumericPostId(rawPid);
          return {
            postId,
            postUrl: `https://www.facebook.com/${encodeURIComponent(pp[1])}/posts/${encodeURIComponent(rawPid)}/`,
          };
        }
        const fbid = u.searchParams.get('fbid')?.trim() ?? /pcb\.(\d+)/.exec(u.href)?.[1] ?? '';
        if (fbid && /^\d+$/.test(fbid))
          return {
            postId: fbid,
            postUrl: u.searchParams.get('fbid')
              ? `https://www.facebook.com/photo.php?fbid=${fbid}`
              : `https://www.facebook.com/${encodeURIComponent(fallbackGroupId)}/posts/${fbid}/`,
          };
        return null;
      }
      const m = /^\/groups\/([^/]+)\/(?:posts|permalink)\/(\d+)/i.exec(u.pathname);
      const pid =
        m?.[2] ??
        u.searchParams.get('story_fbid') ??
        /pcb\.(\d+)/.exec(u.href)?.[1] ??
        /^\/(?:reel|videos|posts)\/(\d+)/.exec(u.pathname)?.[1];
      const gid = m?.[1] ?? fallbackGroupId;
      if (pid && /^\d+$/.test(pid))
        return {
          postId: pid,
          postUrl: `https://www.facebook.com/groups/${encodeURIComponent(gid)}/posts/${pid}/`,
        };
    } catch {}
    return null;
  };
  const direct = extractFromUrl(cleaned);
  if (direct) return direct;
  if (/^https?:\/\//i.test(cleaned)) {
    try {
      const loc = await fetchRedirectLocation(cleaned);
      if (loc) {
        const resolved = extractFromUrl(new URL(loc, cleaned).href);
        if (resolved) return resolved;
      }
    } catch {}
  }
  const hashDigits = hashToNumericPostId(cleaned);
  let cleanFallbackUrl = cleaned;
  if (cleaned.startsWith('http')) {
    try {
      const u = new URL(cleaned);
      for (const k of ['app', 'mibextid', 'rdid', 'share_url']) u.searchParams.delete(k);
      cleanFallbackUrl = u.toString();
    } catch {}
  }
  return {
    postId: hashDigits,
    postUrl: cleaned.startsWith('http')
      ? cleanFallbackUrl
      : mode === 'page'
        ? `https://www.facebook.com/${encodeURIComponent(fallbackGroupId)}/posts/${hashDigits}/`
        : `https://www.facebook.com/groups/${encodeURIComponent(fallbackGroupId)}/posts/${hashDigits}/`,
  };
}
export async function resolveProfileShareUrl(
  rawUrl: string,
): Promise<{ numericId: string | null; resolvedUrl: string }> {
  const extractNumeric = (urlStr: string): string | null => {
    try {
      const u = new URL(urlStr),
        qId = u.searchParams.get('id')?.trim() ?? '';
      if (/^\d{5,}$/.test(qId)) return qId;
      return (
        /^\/people\/[^/]+\/(\d{5,})/i.exec(u.pathname)?.[1] ??
        /^\/(\d{5,})(?:\/|$)/.exec(u.pathname)?.[1] ??
        null
      );
    } catch {
      return null;
    }
  };
  let current = rawUrl.trim();
  const direct = extractNumeric(current);
  if (direct) return { numericId: direct, resolvedUrl: current };
  for (let hop = 0; hop < 3 && /^https?:\/\//i.test(current); hop++) {
    try {
      const loc = await fetchRedirectLocation(current);
      if (!loc) break;
      current = new URL(loc, current).href;
      const found = extractNumeric(current);
      if (found) return { numericId: found, resolvedUrl: current };
    } catch {
      break;
    }
  }
  return { numericId: null, resolvedUrl: current };
}
export function readPngDimensions(pngBuffer: Buffer): { width: number; height: number } | null {
  if (
    pngBuffer.byteLength < 24 ||
    pngBuffer[0] !== 0x89 ||
    pngBuffer[1] !== 0x50 ||
    pngBuffer[2] !== 0x4e ||
    pngBuffer[3] !== 0x47
  )
    return null;
  const width = pngBuffer.readUInt32BE(16),
    height = pngBuffer.readUInt32BE(20);
  return width > 0 && height > 0 && width <= 10000 && height <= 10000 ? { width, height } : null;
}
export type CanonicalFrame = { canvas: Canvas; ctx: SKRSContext2D };
const canonicalFrameCache = new WeakMap<Buffer, Promise<CanonicalFrame | null>>();
export async function getCanonicalFrame(pngBuffer: Buffer): Promise<CanonicalFrame | null> {
  const existing = canonicalFrameCache.get(pngBuffer);
  if (existing) return existing;
  const promise = (async (): Promise<CanonicalFrame | null> => {
    try {
      const { createCanvas, loadImage } = await import('@napi-rs/canvas');
      const img = await loadImage(pngBuffer);
      if (!img.width || !img.height) return null;
      const canvas = createCanvas(CANONICAL_WIDTH, CANONICAL_HEIGHT),
        ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, CANONICAL_WIDTH, CANONICAL_HEIGHT);
      return { canvas, ctx };
    } catch {
      return null;
    }
  })();
  canonicalFrameCache.set(pngBuffer, promise);
  return promise;
}
export function clampCrop(
  left: number,
  top: number,
  width: number,
  height: number,
  minSize = 8,
): { left: number; top: number; width: number; height: number } | null {
  const l = Math.max(0, Math.min(CANONICAL_WIDTH - 1, Math.round(left)));
  const t = Math.max(0, Math.min(CANONICAL_HEIGHT - 1, Math.round(top)));
  const w = Math.max(1, Math.min(CANONICAL_WIDTH - l, Math.round(width)));
  const h = Math.max(1, Math.min(CANONICAL_HEIGHT - t, Math.round(height)));
  return w < minSize || h < minSize ? null : { left: l, top: t, width: w, height: h };
}
async function countMatchingPixels(
  pngBuffer: Buffer,
  bounds: RectBounds,
  insetX: number,
  insetY: number,
  minCrop: number,
  pred: (r: number, g: number, b: number) => boolean,
): Promise<{ matched: number; total: number } | null> {
  const frame = await getCanonicalFrame(pngBuffer);
  if (!frame) return null;
  const crop = clampCrop(
    bounds.x1 + insetX,
    bounds.y1 + insetY,
    Math.max(8, bounds.w - insetX * 2),
    Math.max(8, bounds.h - insetY * 2),
    minCrop,
  );
  if (!crop) return null;
  const { data } = frame.ctx.getImageData(crop.left, crop.top, crop.width, crop.height);
  let matched = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (pred(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0)) matched++;
  }
  return { matched, total: data.length / 4 };
}
const isBlue = (r: number, g: number, b: number) => b >= 135 && b - r >= 35 && b - g >= 8;
export async function isLikeButtonBlue(pngBuffer: Buffer, bounds: RectBounds): Promise<boolean> {
  const res = await countMatchingPixels(pngBuffer, bounds, bounds.w >= 160 ? 24 : 4, 6, 8, isBlue);
  return (res?.matched ?? 0) >= 20;
}
export async function isSolidBlueButton(pngBuffer: Buffer, bounds: RectBounds): Promise<boolean> {
  const res = await countMatchingPixels(
    pngBuffer,
    bounds,
    Math.min(18, Math.floor(bounds.w * 0.12)),
    Math.min(8, Math.floor(bounds.h * 0.15)),
    6,
    (r, g, b) => b >= 150 && b - r >= 55 && b - g >= 18,
  );
  return Boolean(res && res.total > 0 && res.matched / res.total >= 0.4);
}
export async function isGalleryCameraTile(pngBuffer: Buffer, bounds: RectBounds): Promise<boolean> {
  const frame = await getCanonicalFrame(pngBuffer);
  if (!frame) return false;
  const crop = clampCrop(bounds.x1, bounds.y1, bounds.w, bounds.h, 24);
  if (!crop) return false;
  const ctx = frame.canvas.getContext('2d');
  const { data } = ctx.getImageData(crop.left, crop.top, crop.width, crop.height);
  const inset = Math.min(10, Math.max(4, Math.floor(Math.min(crop.width, crop.height) * 0.08)));
  const cornerPts: Array<[number, number]> = [
    [inset, inset],
    [crop.width - 1 - inset, inset],
    [inset, crop.height - 1 - inset],
    [crop.width - 1 - inset, crop.height - 1 - inset],
  ];
  let minR = 255,
    maxR = 0,
    minG = 255,
    maxG = 0,
    minB = 255,
    maxB = 0;
  for (const [cx, cy] of cornerPts) {
    const idx = (cy * crop.width + cx) * 4;
    const r = data[idx] ?? 0,
      g = data[idx + 1] ?? 0,
      b = data[idx + 2] ?? 0;
    if (Math.min(r, g, b) < 210 || Math.max(r, g, b) - Math.min(r, g, b) > 14) return false;
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (g < minG) minG = g;
    if (g > maxG) maxG = g;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
  }
  if (maxR - minR > 12 || maxG - minG > 12 || maxB - minB > 12) return false;
  const xStart = Math.floor(crop.width * 0.25),
    xEnd = Math.floor(crop.width * 0.75),
    yStart = Math.floor(crop.height * 0.25),
    yEnd = Math.floor(crop.height * 0.75);
  let matched = 0,
    total = 0;
  for (let y = yStart; y < yEnd; y += 3) {
    for (let x = xStart; x < xEnd; x += 3) {
      const idx = (y * crop.width + x) * 4;
      total++;
      if (isBlue(data[idx] ?? 0, data[idx + 1] ?? 0, data[idx + 2] ?? 0)) matched++;
    }
  }
  return total > 0 && matched / total >= 0.25;
}
export async function isReactionButtonActive(
  pngBuffer: Buffer,
  bounds: RectBounds,
): Promise<boolean> {
  const res = await countMatchingPixels(
    pngBuffer,
    bounds,
    bounds.w >= 160 ? 24 : 4,
    6,
    8,
    (r, g, b) =>
      isBlue(r, g, b) ||
      (r >= 175 && r - g >= 55 && r - b >= 35) ||
      (r >= 180 && g >= 115 && r - b >= 65 && g - b >= 40),
  );
  return (res?.matched ?? 0) >= 20;
}
export async function detectVideoSpeakerState(
  pngBuffer: Buffer,
  soundBounds: RectBounds,
): Promise<'muted' | 'unmuted' | 'unknown'> {
  const frame = await getCanonicalFrame(pngBuffer);
  if (!frame) return 'unknown';
  const crop = clampCrop(soundBounds.x1, soundBounds.y1, soundBounds.w, soundBounds.h, 24);
  if (!crop) return 'unknown';
  try {
    const { createCanvas } = await import('@napi-rs/canvas');
    const norm = createCanvas(60, 60),
      ctx = norm.getContext('2d');
    ctx.drawImage(frame.canvas, crop.left, crop.top, crop.width, crop.height, 0, 0, 60, 60);
    const { data } = ctx.getImageData(0, 0, 60, 60);
    let darkBg = 0,
      coneBright = 0,
      waveBright = 0;
    for (let y = 0; y < 60; y++) {
      for (let x = 0; x < 60; x++) {
        const idx = (y * 60 + x) * 4,
          r = data[idx] ?? 0,
          g = data[idx + 1] ?? 0,
          b = data[idx + 2] ?? 0;
        const dx = x - 30,
          dy = y - 30;
        if (dx * dx + dy * dy <= 24 * 24 && r < 95 && g < 95 && b < 95) darkBg++;
        if (r < 175 || g < 175 || b < 175) continue;
        if (x >= 15 && x <= 28 && y >= 22 && y <= 37) coneBright++;
        if (
          (x >= 31 && x <= 48 && y >= 17 && y <= 23) ||
          (x >= 31 && x <= 48 && y >= 36 && y <= 41) ||
          (x >= 41 && x <= 48 && y >= 20 && y <= 39)
        )
          waveBright++;
      }
    }
    if (darkBg < 320 || coneBright < 24) return 'unknown';
    return waveBright >= 20 ? 'unmuted' : waveBright <= 6 ? 'muted' : 'unknown';
  } catch {
    return 'unknown';
  }
}
function regionMetricSync(
  frame: CanonicalFrame,
  left: number,
  top: number,
  width: number,
  height: number,
  mode: 'mean' | 'white',
): number | null {
  const crop = clampCrop(left, top, width, height, 4);
  if (!crop) return null;
  const { data } = frame.ctx.getImageData(crop.left, crop.top, crop.width, crop.height);
  const total = data.length / 4;
  if (total <= 0) return null;
  let acc = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0,
      g = data[i + 1] ?? 0,
      b = data[i + 2] ?? 0;
    if (mode === 'mean') acc += r + g + b;
    else if (r >= 235 && g >= 235 && b >= 235 && Math.max(r, g, b) - Math.min(r, g, b) <= 15) acc++;
  }
  return mode === 'mean' ? acc / (total * 3) : acc / total;
}
const isBottomSheetFrame = (frame: CanonicalFrame) => {
  const top = regionMetricSync(frame, 140, 46, 200, 42, 'mean'),
    sheet = regionMetricSync(frame, 520, 1220, 260, 180, 'mean');
  return top !== null && sheet !== null && top < 165 && sheet > 220;
};
export async function isBottomSheetOpen(pngBuffer: Buffer): Promise<boolean> {
  const frame = await getCanonicalFrame(pngBuffer);
  return frame ? isBottomSheetFrame(frame) : false;
}
export interface BottomSheetIdentityRow {
  avatarBounds: RectBounds;
  rowBounds: RectBounds;
  titleBounds: RectBounds;
  fullTextBounds: RectBounds;
  checkBounds: RectBounds;
  isActiveBlueCheck: boolean;
}
export async function detectBottomSheetIdentityRows(
  pngBuffer: Buffer,
): Promise<BottomSheetIdentityRow[]> {
  try {
    const frame = await getCanonicalFrame(pngBuffer);
    if (!frame) return [];
    const { data } = frame.ctx.getImageData(0, 0, CANONICAL_WIDTH, CANONICAL_HEIGHT);
    const lumAt = (x: number, y: number): number => {
      const idx = (y * CANONICAL_WIDTH + x) * 4;
      return 0.299 * (data[idx] ?? 0) + 0.587 * (data[idx + 1] ?? 0) + 0.114 * (data[idx + 2] ?? 0);
    };
    let sheetTopY = -1;
    for (let y = 1520; y >= 340; y -= 2) {
      if (!(lumAt(18, y) >= 235 && lumAt(882, y) >= 235)) {
        sheetTopY = y + 2;
        break;
      }
    }
    if (sheetTopY < 0 || sheetTopY > 1390) return [];
    const scanStartY = Math.min(1450, sheetTopY + 20),
      scanEndY = 1455;
    const isAvatarRowY = new Uint8Array(CANONICAL_HEIGHT);
    for (let y = scanStartY; y < scanEndY; y++) {
      let nonWhiteAvatar = 0,
        midBorderGray = 0;
      for (let x = 50; x <= 118; x += 2) if (lumAt(x, y) < 228) nonWhiteAvatar++;
      for (let x = 180; x <= 740; x += 8) {
        const l = lumAt(x, y);
        if (l >= 195 && l <= 238) midBorderGray++;
      }
      if (nonWhiteAvatar >= 9 && midBorderGray < 55) isAvatarRowY[y] = 1;
    }
    const blobs: Array<{ y1: number; y2: number }> = [];
    let runStart = -1,
      whiteGap = 0;
    const pushBlob = (y2: number) => {
      if (y2 - runStart >= 36 && y2 - runStart <= 96) blobs.push({ y1: runStart, y2 });
    };
    for (let y = scanStartY; y <= scanEndY; y++) {
      if (isAvatarRowY[y] === 1) {
        if (runStart < 0) runStart = y;
        whiteGap = 0;
      } else if (runStart >= 0 && ++whiteGap > 4) {
        pushBlob(y - whiteGap);
        runStart = -1;
        whiteGap = 0;
      }
    }
    if (runStart >= 0) pushBlob(scanEndY - whiteGap);
    return blobs.map((blob) => {
      const h = blob.y2 - blob.y1,
        cY = (y: number) => Math.max(0, Math.min(CANONICAL_HEIGHT, y)),
        yTop = cY(blob.y1 - 8),
        yBot = cY(blob.y2 + 8),
        checkBounds = makeCanonicalRect(785, yTop, 875, yBot);
      let bluePx = 0;
      for (let y = checkBounds.y1; y < checkBounds.y2; y += 2) {
        for (let x = checkBounds.x1; x < checkBounds.x2; x += 2) {
          const idx = (y * CANONICAL_WIDTH + x) * 4,
            r = data[idx] ?? 0,
            g = data[idx + 1] ?? 0,
            b = data[idx + 2] ?? 0;
          if (b >= 175 && b - r >= 65 && b - g >= 25) bluePx++;
        }
      }
      return {
        avatarBounds: makeCanonicalRect(46, blob.y1, 120, blob.y2),
        rowBounds: makeCanonicalRect(36, cY(blob.y1 - 14), 864, cY(blob.y2 + 14)),
        titleBounds: makeCanonicalRect(126, yTop, 775, cY(blob.y1 + Math.round(h * 0.58))),
        fullTextBounds: makeCanonicalRect(126, yTop, 775, yBot),
        checkBounds,
        isActiveBlueCheck: bluePx >= 18,
      };
    });
  } catch {
    return [];
  }
}
export async function isDarkScreenOrReelMode(pngBuffer: Buffer): Promise<boolean> {
  const frame = await getCanonicalFrame(pngBuffer);
  if (!frame || isBottomSheetFrame(frame)) return false;
  const topBarMean = regionMetricSync(frame, 120, 44, 620, 50, 'mean'),
    bottomBarMean = regionMetricSync(frame, 120, 1445, 620, 65, 'mean'),
    topWhiteRatio = regionMetricSync(frame, 100, 40, 660, 56, 'white');
  if (topWhiteRatio !== null && topWhiteRatio < 0.35) return true;
  return Boolean(
    topBarMean !== null && bottomBarMean !== null && topBarMean < 105 && bottomBarMean < 105,
  );
}
