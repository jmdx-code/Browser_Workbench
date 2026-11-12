import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Canvas, SKRSContext2D } from '@napi-rs/canvas';
import { isLocalAvatar } from '../shared/group-bumper.js';

export const CANONICAL_WIDTH = 900;
export const CANONICAL_HEIGHT = 1600;
const MAX_LOCAL_AVATAR_LEN = 128 * 1024;

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

export interface LitePostHeader {
  bounds: RectBounds;
  avatarBounds: RectBounds;
  authorNameBounds: RectBounds;
  timestampBounds: RectBounds;
  moreMenuBounds: RectBounds | null;
}

export interface LitePostActionBar {
  y1: number;
  y2: number;
  likeBounds: RectBounds;
  commentBounds: RectBounds;
  shareBounds: RectBounds;
}

export interface LitePostCard {
  header: LitePostHeader;
  actionBar: LitePostActionBar | null;
  cardBounds: RectBounds;
}

export function makeCanonicalRect(x1: number, y1: number, x2: number, y2: number): RectBounds {
  const cx1 = Math.max(0, Math.min(CANONICAL_WIDTH, Math.round(x1)));
  const cy1 = Math.max(0, Math.min(CANONICAL_HEIGHT, Math.round(y1)));
  const cx2 = Math.max(cx1, Math.min(CANONICAL_WIDTH, Math.round(x2)));
  const cy2 = Math.max(cy1, Math.min(CANONICAL_HEIGHT, Math.round(y2)));
  const w = Math.max(0, cx2 - cx1);
  const h = Math.max(0, cy2 - cy1);
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
  const sw = screenW > 0 ? screenW : CANONICAL_WIDTH;
  const sh = screenH > 0 ? screenH : CANONICAL_HEIGHT;
  const sx = CANONICAL_WIDTH / sw;
  const sy = CANONICAL_HEIGHT / sh;
  return makeCanonicalRect(rawX1 * sx, rawY1 * sy, rawX2 * sx, rawY2 * sy);
}

export function scalePointFrom900(
  x900: number,
  y900: number,
  screenW = CANONICAL_WIDTH,
  screenH = CANONICAL_HEIGHT,
): { x: number; y: number } {
  const sw = screenW > 0 ? screenW : CANONICAL_WIDTH;
  const sh = screenH > 0 ? screenH : CANONICAL_HEIGHT;
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

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

function parseXmlAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(attrText)) !== null) {
    const key = m[1];
    const val = m[2] ?? m[3] ?? '';
    if (key) attrs[key] = decodeXmlEntities(val);
  }
  return attrs;
}

export function parseLiteXml(
  xmlText: string,
  screenW = CANONICAL_WIDTH,
  screenH = CANONICAL_HEIGHT,
): LiteXmlNode | null {
  if (!xmlText || !xmlText.includes('<node')) return null;
  const tagRegex = /<\/?node\b([^>]*?)(\/?)>/g;
  const stack: LiteXmlNode[] = [];
  let root: LiteXmlNode | null = null;
  let skippedDepth = 0;

  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(xmlText)) !== null) {
    const fullTag = match[0];
    const attrPart = match[1] ?? '';
    const selfClosing = match[2] === '/';
    const isClosing = fullTag.startsWith('</');

    if (isClosing) {
      if (skippedDepth > 0) {
        skippedDepth--;
      } else if (stack.length > 0) {
        stack.pop();
      }
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
    if (parent) {
      parent.children.push(node);
    } else if (!root) {
      root = node;
    }

    if (!selfClosing) {
      stack.push(node);
    }
  }

  return root;
}

export function parseDumpsysTop(
  dumpsysText: string,
  screenW = CANONICAL_WIDTH,
  screenH = CANONICAL_HEIGHT,
): LiteXmlNode | null {
  const lines = dumpsysText.split(/\r?\n/);
  let inFbLiteActivity = false;
  let currentActivityResumed = false;
  let inHierarchy = false;
  let hierarchyBaseIndent = -1;

  interface StackEntry {
    indent: number;
    rawX1: number;
    rawY1: number;
    node: LiteXmlNode;
  }

  const stack: StackEntry[] = [];
  let rootNode: LiteXmlNode | null = null;
  let resumedRootNode: LiteXmlNode | null = null;
  let lastValidRootNode: LiteXmlNode | null = null;
  let skipUntilIndent = -1;

  const commitCurrentHierarchy = () => {
    if (rootNode && rootNode.children.length > 0) {
      lastValidRootNode = rootNode;
      if (currentActivityResumed) {
        resumedRootNode = rootNode;
      }
    }
  };

  const viewRegex =
    /^(\s+)([^\s{]+)\{[0-9a-f]+\s+(\S+)\s+(\S+)\s+(-?\d+),(-?\d+)-(-?\d+),(-?\d+)(?:\s+#[0-9a-f]+(?:\s+([^\s}]+))?)?\}/;

  for (const line of lines) {
    if (/^\s*ACTIVITY\s+(\S+)/.test(line)) {
      commitCurrentHierarchy();
      const actMatch = /^\s*ACTIVITY\s+(\S+)/.exec(line);
      inFbLiteActivity = Boolean(actMatch?.[1]?.startsWith('com.facebook.lite/'));
      currentActivityResumed = false;
      inHierarchy = false;
      rootNode = null;
      continue;
    }
    if (!inFbLiteActivity) continue;

    if (!inHierarchy) {
      if (/\bmResumed=true\b/.test(line)) {
        currentActivityResumed = true;
      }
      const hMatch = /^(\s+)View Hierarchy:\s*$/.exec(line);
      if (hMatch && hMatch[1] !== undefined) {
        inHierarchy = true;
        hierarchyBaseIndent = hMatch[1].length;
        stack.length = 0;
        rootNode = null;
        skipUntilIndent = -1;
      }
      continue;
    }

    const indentMatch = /^(\s*)/.exec(line);
    const indent = indentMatch?.[1]?.length ?? 0;
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
      rootNode = {
        index: 0,
        text: '',
        resourceId: '',
        className: 'com.android.internal.policy.DecorView',
        packageName: 'com.facebook.lite',
        contentDesc: '',
        clickable: false,
        longClickable: false,
        focused: false,
        scrollable: false,
        bounds: makeCanonicalRect(0, 0, CANONICAL_WIDTH, CANONICAL_HEIGHT),
        children: [],
      };
      stack.push({ indent, rawX1: 0, rawY1: 0, node: rootNode });
      continue;
    }

    const m = viewRegex.exec(line);
    if (!m || !rootNode) continue;

    const rawClass = m[2] ?? '';
    const f1 = m[3] ?? '';
    const f2 = m[4] ?? '';
    const relX1 = Number(m[5]);
    const relY1 = Number(m[6]);
    const relX2 = Number(m[7]);
    const relY2 = Number(m[8]);
    const resId = m[9] ?? '';

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

    const rawX1 = parent.rawX1 + relX1;
    const rawY1 = parent.rawY1 + relY1;
    const rawX2 = parent.rawX1 + relX2;
    const rawY2 = parent.rawY1 + relY2;

    if (rawX2 <= rawX1 || rawY2 <= rawY1) {
      skipUntilIndent = indent;
      continue;
    }

    const scaled = scaleBoundsTo900(rawX1, rawY1, rawX2, rawY2, screenW, screenH);
    if (scaled.w === 0 || scaled.h === 0) {
      skipUntilIndent = indent;
      continue;
    }

    const isRecycler = rawClass === 'X.10N' || rawClass.includes('RecyclerView');
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

export function findTextInputNode(root: LiteXmlNode | null): LiteXmlNode | null {
  const all = flattenLiteNodes(root);
  return (
    all.find(
      (n) =>
        n.className.includes('MultiAutoCompleteTextView') ||
        n.className.includes('EditText') ||
        (n.focused && n.clickable && n.longClickable && n.bounds.w >= 400 && n.bounds.h <= 120),
    ) ?? null
  );
}

function makeRect(x1: number, y1: number, x2: number, y2: number): RectBounds {
  const b = makeCanonicalRect(x1, y1, x2, y2);
  if (b.w >= 1 && b.h >= 1) return b;
  const cx2 = Math.min(CANONICAL_WIDTH, b.x1 + Math.max(1, b.w));
  const cy2 = Math.min(CANONICAL_HEIGHT, b.y1 + Math.max(1, b.h));
  return makeCanonicalRect(b.x1, b.y1, cx2, cy2);
}

function selectMainFeedScope(root: LiteXmlNode | null): {
  feedNodes: LiteXmlNode[];
  maxSafeY: number;
} {
  if (!root) return { feedNodes: [], maxSafeY: 1520 };
  const rawAll = flattenLiteNodes(root);
  const fullFeedRecyclers = rawAll.filter(
    (n) =>
      n.className.includes('RecyclerView') &&
      n.scrollable &&
      n.bounds.w >= 840 &&
      n.bounds.h >= 980 &&
      n.bounds.y1 <= 260,
  );
  const mainRecycler = fullFeedRecyclers.at(-1);
  const feedNodes = mainRecycler ? flattenLiteNodes(mainRecycler) : rawAll;
  const feedNodeSet = new Set<LiteXmlNode>(feedNodes);

  let maxSafeY = 1520;
  for (const n of rawAll) {
    if (feedNodeSet.has(n)) continue;
    if (
      n.clickable &&
      n.bounds.w >= 780 &&
      n.bounds.h >= 44 &&
      n.bounds.h <= 78 &&
      n.bounds.y1 >= 1420 &&
      n.bounds.y2 <= 1535
    ) {
      maxSafeY = Math.min(maxSafeY, n.bounds.y1 - 4);
    }
  }
  return { feedNodes, maxSafeY };
}

export function extractActionBars(root: LiteXmlNode | null): LitePostActionBar[] {
  if (!root) return [];
  const { feedNodes: all, maxSafeY } = selectMainFeedScope(root);

  const actionBars: LitePostActionBar[] = [];
  const likeCandidates = all.filter(
    (n) =>
      n.clickable &&
      n.longClickable &&
      n.bounds.x1 <= 24 &&
      Math.abs(n.bounds.x2 - 300) <= 24 &&
      n.bounds.h >= 42 &&
      n.bounds.h <= 84 &&
      n.bounds.y1 >= 115 &&
      n.bounds.y2 <= maxSafeY,
  );
  for (const like of likeCandidates) {
    const comment = all.find(
      (n) =>
        n.clickable &&
        Math.abs(n.bounds.y1 - like.bounds.y1) <= 8 &&
        Math.abs(n.bounds.x1 - 300) <= 24 &&
        Math.abs(n.bounds.x2 - 600) <= 24,
    );
    const share = all.find(
      (n) =>
        n.clickable &&
        Math.abs(n.bounds.y1 - like.bounds.y1) <= 8 &&
        Math.abs(n.bounds.x1 - 600) <= 24 &&
        Math.abs(n.bounds.x2 - 900) <= 24,
    );
    if (comment && share && !actionBars.some((ab) => Math.abs(ab.y1 - like.bounds.y1) < 20)) {
      actionBars.push({
        y1: like.bounds.y1,
        y2: like.bounds.y2,
        likeBounds: like.bounds,
        commentBounds: comment.bounds,
        shareBounds: share.bounds,
      });
    }
  }
  actionBars.sort((a, b) => a.y1 - b.y1);
  return actionBars;
}

export function extractPostCards(root: LiteXmlNode | null): LitePostCard[] {
  if (!root) return [];
  const { feedNodes: all, maxSafeY } = selectMainFeedScope(root);

  const headers: LitePostHeader[] = [];
  for (const node of all) {
    const b = node.bounds;
    if (b.x1 > 4 || b.x2 < 896 || b.h < 66 || b.h > 118 || b.y1 < 76 || b.y2 > maxSafeY) continue;
    const first = node.children[0];
    if (!first || first.bounds.y1 < 96 || node.children.length < 2) continue;
    const second = node.children.find((c) => c.bounds.x1 >= 78 && c.bounds.x1 <= 134);
    if (
      first.bounds.x1 <= 42 &&
      first.bounds.x2 >= 68 &&
      first.bounds.x2 <= 118 &&
      first.bounds.w >= 42 &&
      first.bounds.w <= 88 &&
      second
    ) {
      const sortedSub = [...second.children].sort((a, bSub) => a.bounds.y1 - bSub.bounds.y1);
      const clickableAuthorNode = sortedSub.find(
        (c) => c.clickable && c.bounds.x1 <= 124 && c.bounds.y1 <= second.bounds.y1 + 18,
      );
      const nameNode = clickableAuthorNode ?? sortedSub[0];
      const authorNameBounds = nameNode
        ? makeRect(
            Math.max(84, nameNode.bounds.x1 - 4),
            Math.max(b.y1, nameNode.bounds.y1 - 4),
            Math.min(820, nameNode.bounds.x2 + 12),
            Math.min(b.y2, nameNode.bounds.y2 + 6),
          )
        : makeRect(88, b.y1 + 14, 520, b.y1 + 52);
      const tsNode = sortedSub.findLast((c) => c.bounds.y1 >= second.bounds.y1 + 18);
      const tsY1 = tsNode ? tsNode.bounds.y1 - 4 : nameNode ? nameNode.bounds.y2 - 2 : b.y1 + 46;
      const tsY2 = tsNode ? tsNode.bounds.y2 + 4 : tsY1 + 32;
      const tsX2 = tsNode ? Math.min(420, Math.max(190, tsNode.bounds.x2 + 28)) : 320;
      const timestampBounds = makeRect(84, tsY1, tsX2, Math.min(b.y2 + 6, tsY2));
      const moreNode =
        node.children.find((c) => c.clickable && c.bounds.x1 >= 790 && c.bounds.x2 <= 900) ?? null;
      if (!moreNode) continue;
      if (!headers.some((h) => Math.abs(h.bounds.y1 - b.y1) < 25)) {
        headers.push({
          bounds: b,
          avatarBounds: first.bounds,
          authorNameBounds,
          timestampBounds,
          moreMenuBounds: moreNode.bounds,
        });
      }
    }
  }
  headers.sort((a, b) => a.bounds.y1 - b.bounds.y1);

  const actionBars = extractActionBars(root);
  const usedBars = new Set<LitePostActionBar>();
  const cards: LitePostCard[] = [];
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    if (!header) continue;
    const nextHeaderY = headers[i + 1]?.bounds.y1 ?? CANONICAL_HEIGHT;
    const bar =
      actionBars.find(
        (ab) => !usedBars.has(ab) && ab.y1 > header.bounds.y2 && ab.y1 < nextHeaderY,
      ) ?? null;
    if (bar) usedBars.add(bar);
    cards.push({
      header,
      actionBar: bar,
      cardBounds: makeRect(
        0,
        header.bounds.y1,
        CANONICAL_WIDTH,
        bar ? bar.y2 : Math.min(1528, nextHeaderY),
      ),
    });
  }
  return cards;
}

export function findSeeMoreButtonNode(root: LiteXmlNode | null): LiteXmlNode | null {
  if (!root) return null;
  const all = flattenLiteNodes(root);
  return (
    all.find((n) => {
      const onlyChild = n.children[0];
      return (
        n.clickable &&
        n.bounds.x1 <= 4 &&
        n.bounds.x2 >= 896 &&
        n.bounds.h >= 46 &&
        n.bounds.h <= 70 &&
        n.bounds.y1 >= 300 &&
        n.bounds.y2 <= 1525 &&
        n.children.length === 1 &&
        Boolean(onlyChild && onlyChild.bounds.x1 >= 345 && onlyChild.bounds.x2 <= 555)
      );
    }) ?? null
  );
}

export function findJoinGroupButtonNode(root: LiteXmlNode | null): LiteXmlNode | null {
  if (!root) return null;
  const all = flattenLiteNodes(root);
  return (
    all.find(
      (n) =>
        n.clickable &&
        n.bounds.x1 <= 32 &&
        n.bounds.x2 >= 868 &&
        n.bounds.w >= 836 &&
        n.bounds.h >= 44 &&
        n.bounds.h <= 74 &&
        n.bounds.y1 >= 555 &&
        n.bounds.y2 <= 925,
    ) ?? null
  );
}

export function findRelatedGroupsCloseButtonNode(root: LiteXmlNode | null): LiteXmlNode | null {
  if (!root) return null;
  const all = flattenLiteNodes(root);
  for (const n of all) {
    if (
      n.bounds.x1 <= 4 &&
      n.bounds.x2 >= 896 &&
      n.bounds.h >= 350 &&
      n.bounds.y1 >= 635 &&
      n.bounds.y2 <= 1355 &&
      n.children.some((c) => c.className.includes('RecyclerView'))
    ) {
      const closeBtn = n.children.find(
        (c) =>
          c.clickable &&
          c.bounds.x1 >= 825 &&
          c.bounds.x2 <= 895 &&
          c.bounds.w >= 24 &&
          c.bounds.w <= 55 &&
          c.bounds.h >= 24 &&
          c.bounds.h <= 55 &&
          c.bounds.y1 <= n.bounds.y1 + 74,
      );
      if (closeBtn) return closeBtn;
    }
  }
  return null;
}

export function findGroupSortButtonNode(root: LiteXmlNode | null): LiteXmlNode | null {
  if (!root) return null;
  const all = flattenLiteNodes(root);
  for (const n of all) {
    if (
      n.bounds.x1 <= 4 &&
      n.bounds.x2 >= 896 &&
      n.bounds.h >= 52 &&
      n.bounds.h <= 92 &&
      n.bounds.y1 >= 345 &&
      n.bounds.y2 <= 1560 &&
      n.children.length === 2
    ) {
      const leftLabel = n.children.find(
        (c) => !c.clickable && c.bounds.x1 >= 8 && c.bounds.x1 <= 44 && c.bounds.x2 <= 285,
      );
      const rightBtn = n.children.find(
        (c) =>
          c.clickable &&
          c.bounds.x1 >= 825 &&
          c.bounds.x2 <= 896 &&
          c.bounds.w >= 24 &&
          c.bounds.w <= 55 &&
          c.bounds.h >= 24 &&
          c.bounds.h <= 55,
      );
      if (leftLabel && rightBtn) return rightBtn;
    }
  }
  return null;
}

export function readPngDimensions(pngBuffer: Buffer): { width: number; height: number } | null {
  if (pngBuffer.byteLength < 24) return null;
  if (
    pngBuffer[0] !== 0x89 ||
    pngBuffer[1] !== 0x50 ||
    pngBuffer[2] !== 0x4e ||
    pngBuffer[3] !== 0x47
  ) {
    return null;
  }
  const width = pngBuffer.readUInt32BE(16);
  const height = pngBuffer.readUInt32BE(20);
  if (width <= 0 || height <= 0 || width > 10000 || height > 10000) return null;
  return { width, height };
}

interface CanonicalFrame {
  canvas: Canvas;
  ctx: SKRSContext2D;
}

const canonicalFrameCache = new WeakMap<Buffer, Promise<CanonicalFrame | null>>();
const MAX_SIGNATURE_CACHE = 512;

async function getCanonicalFrame(pngBuffer: Buffer): Promise<CanonicalFrame | null> {
  const existing = canonicalFrameCache.get(pngBuffer);
  if (existing) return existing;
  const promise = (async (): Promise<CanonicalFrame | null> => {
    try {
      const { createCanvas, loadImage } = await import('@napi-rs/canvas');
      const img = await loadImage(pngBuffer);
      if (!img.width || !img.height) return null;
      const canvas = createCanvas(CANONICAL_WIDTH, CANONICAL_HEIGHT);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, CANONICAL_WIDTH, CANONICAL_HEIGHT);
      return { canvas, ctx };
    } catch {
      return null;
    }
  })();
  canonicalFrameCache.set(pngBuffer, promise);
  return promise;
}

function clampCrop(
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
  if (w < minSize || h < minSize) return null;
  return { left: l, top: t, width: w, height: h };
}

export async function isLikeButtonBlue(pngBuffer: Buffer, bounds: RectBounds): Promise<boolean> {
  const frame = await getCanonicalFrame(pngBuffer);
  if (!frame) return false;
  const insetX = bounds.w >= 160 ? 24 : 4;
  const crop = clampCrop(
    bounds.x1 + insetX,
    bounds.y1 + 6,
    Math.max(10, bounds.w - insetX * 2),
    Math.max(10, bounds.h - 12),
    8,
  );
  if (!crop) return false;
  const { data } = frame.ctx.getImageData(crop.left, crop.top, crop.width, crop.height);
  let bluePixels = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    if (b >= 135 && b - r >= 35 && b - g >= 8) bluePixels++;
  }
  return bluePixels >= 20;
}

function regionMeanBrightnessSync(
  frame: CanonicalFrame,
  left: number,
  top: number,
  width: number,
  height: number,
): number | null {
  const crop = clampCrop(left, top, width, height, 4);
  if (!crop) return null;
  const { data } = frame.ctx.getImageData(crop.left, crop.top, crop.width, crop.height);
  const pixels = data.length / 4;
  if (pixels <= 0) return null;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += (data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0);
  }
  return sum / (pixels * 3);
}

function regionWhitePixelRatioSync(
  frame: CanonicalFrame,
  left: number,
  top: number,
  width: number,
  height: number,
): number | null {
  const crop = clampCrop(left, top, width, height, 4);
  if (!crop) return null;
  const { data } = frame.ctx.getImageData(crop.left, crop.top, crop.width, crop.height);
  const total = data.length / 4;
  if (total <= 0) return null;
  let white = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    if (r >= 235 && g >= 235 && b >= 235 && Math.max(r, g, b) - Math.min(r, g, b) <= 15) {
      white++;
    }
  }
  return white / total;
}

export async function isBottomSheetOpen(pngBuffer: Buffer): Promise<boolean> {
  const frame = await getCanonicalFrame(pngBuffer);
  if (!frame) return false;
  const topBarMean = regionMeanBrightnessSync(frame, 140, 46, 200, 42);
  const sheetMean = regionMeanBrightnessSync(frame, 520, 1220, 260, 180);
  if (topBarMean === null || sheetMean === null) return false;
  return topBarMean < 165 && sheetMean > 220;
}

export async function isDarkScreenOrReelMode(pngBuffer: Buffer): Promise<boolean> {
  const frame = await getCanonicalFrame(pngBuffer);
  if (!frame) return false;
  const topBarMean = regionMeanBrightnessSync(frame, 120, 44, 620, 50);
  const bottomBarMean = regionMeanBrightnessSync(frame, 120, 1445, 620, 65);
  const topWhiteRatio = regionWhitePixelRatioSync(frame, 100, 40, 660, 56);
  const sheetMean = regionMeanBrightnessSync(frame, 520, 1220, 260, 180);
  const topSheetMean = regionMeanBrightnessSync(frame, 140, 46, 200, 42);
  if (topSheetMean !== null && sheetMean !== null && topSheetMean < 165 && sheetMean > 220) {
    return false;
  }
  if (topWhiteRatio !== null && topWhiteRatio < 0.35) return true;
  if (topBarMean !== null && bottomBarMean !== null && topBarMean < 105 && bottomBarMean < 105) {
    return true;
  }
  return false;
}

export async function cropToDataUrl(
  pngBuffer: Buffer,
  bounds: RectBounds,
  size = 96,
): Promise<string | null> {
  const frame = await getCanonicalFrame(pngBuffer);
  if (!frame) return null;
  const crop = clampCrop(bounds.x1, bounds.y1, bounds.w, bounds.h, 8);
  if (!crop) return null;
  try {
    const { createCanvas } = await import('@napi-rs/canvas');
    const out = createCanvas(size, size);
    const outCtx = out.getContext('2d');
    const aspect = crop.width / crop.height;
    let sx = crop.left;
    let sy = crop.top;
    let sw = crop.width;
    let sh = crop.height;
    if (aspect > 1) {
      sw = crop.height;
      sx = crop.left + (crop.width - sw) / 2;
    } else if (aspect < 1) {
      sh = crop.width;
      sy = crop.top + (crop.height - sh) / 2;
    }
    outCtx.drawImage(frame.canvas, sx, sy, sw, sh, 0, 0, size, size);
    for (const mime of ['image/webp', 'image/jpeg'] as const) {
      for (const quality of [82, 65]) {
        const encoded =
          mime === 'image/webp'
            ? out.toBuffer('image/webp', quality)
            : out.toBuffer('image/jpeg', quality);
        const dataUrl = `data:${mime};base64,${Buffer.from(encoded).toString('base64')}`;
        if (isLocalAvatar(dataUrl) && dataUrl.length <= MAX_LOCAL_AVATAR_LEN) {
          return dataUrl;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function rgbaToNormalizedSignature(rgba: Uint8ClampedArray): Float32Array | null {
  const rgbLen = (rgba.length / 4) * 3;
  if (rgbLen <= 0) return null;
  const vec = new Float32Array(rgbLen);
  let sum = 0;
  let p = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i] ?? 0;
    const g = rgba[i + 1] ?? 0;
    const b = rgba[i + 2] ?? 0;
    vec[p++] = r;
    vec[p++] = g;
    vec[p++] = b;
    sum += r + g + b;
  }
  const mean = sum / rgbLen;
  let normSq = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = (vec[i] ?? 0) - mean;
    vec[i] = v;
    normSq += v * v;
  }
  const norm = Math.sqrt(normSq);
  if (norm > 1e-5) {
    for (let i = 0; i < vec.length; i++) {
      vec[i] = (vec[i] ?? 0) / norm;
    }
  }
  return vec;
}

export async function getRegionSignature(
  pngBuffer: Buffer,
  bounds: RectBounds,
): Promise<Float32Array | null> {
  const frame = await getCanonicalFrame(pngBuffer);
  if (!frame) return null;
  const crop = clampCrop(bounds.x1, bounds.y1, bounds.w, bounds.h, 8);
  if (!crop) return null;
  try {
    const { createCanvas } = await import('@napi-rs/canvas');
    const c = createCanvas(24, 24);
    const ctx = c.getContext('2d');
    const side = Math.min(crop.width, crop.height);
    const sx = crop.left + (crop.width - side) / 2;
    const sy = crop.top + (crop.height - side) / 2;
    ctx.drawImage(frame.canvas, sx, sy, side, side, 0, 0, 24, 24);
    return rgbaToNormalizedSignature(ctx.getImageData(0, 0, 24, 24).data);
  } catch {
    return null;
  }
}

export function signatureSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return Math.max(0, Math.min(1, (dot + 1) / 2));
}

const avatarFeatureCache = new Map<string, Float32Array[]>();

function extractAvatarMaskedVector(rgba: Uint8ClampedArray): Float32Array | null {
  if (rgba.length < 24 * 24 * 4) return null;
  const out: number[] = [];
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      const dx = x - 11.5;
      const dy = y - 11.5;
      if (dx * dx + dy * dy > 8.8 * 8.8) continue;
      // Exclude FB Lite bottom-right online status dot / sub-avatar badge zone
      const bdx = x - 20.5;
      const bdy = y - 20.0;
      if (bdx * bdx + bdy * bdy <= 6.8 * 6.8) continue;
      const idx = (y * 24 + x) * 4;
      out.push((rgba[idx] ?? 0) / 255, (rgba[idx + 1] ?? 0) / 255, (rgba[idx + 2] ?? 0) / 255);
    }
  }
  return out.length > 0 ? new Float32Array(out) : null;
}

function hybridAvatarVectorSimilarity(a: Float32Array, b: Float32Array): number {
  const n = a.length;
  if (n === 0 || n !== b.length) return 0;
  let dotRaw = 0;
  let na = 0;
  let nb = 0;
  let mad = 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dotRaw += ai * bi;
    na += ai * ai;
    nb += bi * bi;
    mad += Math.abs(ai - bi);
    sumA += ai;
    sumB += bi;
  }
  const cosRaw = na > 1e-6 && nb > 1e-6 ? dotRaw / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  const rawScore = cosRaw * Math.max(0, 1 - (mad / n) * 0.65);

  const meanA = sumA / n;
  const meanB = sumB / n;
  let dotZ = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = (a[i] ?? 0) - meanA;
    const db = (b[i] ?? 0) - meanB;
    dotZ += da * db;
    va += da * da;
    vb += db * db;
  }
  const znccScore =
    va > 1e-5 && vb > 1e-5
      ? Math.max(0, Math.min(1, (dotZ / (Math.sqrt(va) * Math.sqrt(vb)) + 1) / 2))
      : rawScore;
  return 0.55 * rawScore + 0.45 * znccScore;
}

async function getReferenceAvatarVariants(referenceUrl: string): Promise<Float32Array[] | null> {
  const cached = avatarFeatureCache.get(referenceUrl);
  if (cached) return cached;
  try {
    let inputBuffer: Buffer;
    if (referenceUrl.startsWith('data:image/')) {
      const b64 = referenceUrl.split(',')[1];
      if (!b64) return null;
      inputBuffer = Buffer.from(b64, 'base64');
    } else if (referenceUrl.startsWith('https://') || referenceUrl.startsWith('http://')) {
      const res = await fetch(referenceUrl, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      inputBuffer = Buffer.from(await res.arrayBuffer());
    } else {
      return null;
    }
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(inputBuffer);
    if (!img.width || !img.height) return null;
    const c = createCanvas(24, 24);
    const ctx = c.getContext('2d');
    const baseSide = Math.min(img.width, img.height);
    const variants: Float32Array[] = [];
    for (const cropFrac of [1.0, 0.86, 0.78]) {
      for (const offsetY of [-0.05, 0, 0.05]) {
        const sw = baseSide * cropFrac;
        const sh = baseSide * cropFrac;
        const sx = (img.width - sw) / 2;
        const sy = Math.max(
          0,
          Math.min(img.height - sh, (img.height - sh) / 2 + baseSide * offsetY),
        );
        ctx.clearRect(0, 0, 24, 24);
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, 24, 24);
        const vec = extractAvatarMaskedVector(ctx.getImageData(0, 0, 24, 24).data);
        if (vec) variants.push(vec);
      }
    }
    if (variants.length > 0) {
      if (avatarFeatureCache.size >= MAX_SIGNATURE_CACHE) {
        const oldestKey = avatarFeatureCache.keys().next().value;
        if (oldestKey !== undefined) avatarFeatureCache.delete(oldestKey);
      }
      avatarFeatureCache.set(referenceUrl, variants);
      return variants;
    }
    return null;
  } catch {
    return null;
  }
}

async function getRegionAvatarVector(
  pngBuffer: Buffer,
  bounds: RectBounds,
): Promise<Float32Array | null> {
  const frame = await getCanonicalFrame(pngBuffer);
  if (!frame) return null;
  const crop = clampCrop(bounds.x1, bounds.y1, bounds.w, bounds.h, 8);
  if (!crop) return null;
  try {
    const { createCanvas } = await import('@napi-rs/canvas');
    const c = createCanvas(24, 24);
    const ctx = c.getContext('2d');
    const side = Math.min(crop.width, crop.height);
    const sx = crop.left + (crop.width - side) / 2;
    const sy = crop.top + (crop.height - side) / 2;
    ctx.drawImage(frame.canvas, sx, sy, side, side, 0, 0, 24, 24);
    return extractAvatarMaskedVector(ctx.getImageData(0, 0, 24, 24).data);
  } catch {
    return null;
  }
}

export async function compareAvatarToRegion(
  pngBuffer: Buffer,
  bounds: RectBounds,
  referenceAvatarUrl: string | null,
): Promise<number> {
  if (!referenceAvatarUrl) return 0;
  const [regionVec, refVariants] = await Promise.all([
    getRegionAvatarVector(pngBuffer, bounds),
    getReferenceAvatarVariants(referenceAvatarUrl),
  ]);
  if (!regionVec || !refVariants || refVariants.length === 0) return 0;
  let best = 0;
  for (const refVec of refVariants) {
    const sim = hybridAvatarVectorSimilarity(regionVec, refVec);
    if (sim > best) best = sim;
  }
  return best;
}

export async function resolveSharePostUrl(
  rawUrl: string,
  fallbackGroupId: string,
): Promise<{ postId: string; postUrl: string }> {
  const cleaned = rawUrl.trim();
  const extractFromUrl = (uStr: string): { postId: string; postUrl: string } | null => {
    try {
      const u = new URL(uStr);
      const m = /^\/groups\/([^/]+)\/(?:posts|permalink)\/(\d+)/i.exec(u.pathname);
      const pid =
        m?.[2] ??
        u.searchParams.get('story_fbid') ??
        /pcb\.(\d+)/.exec(u.href)?.[1] ??
        /^\/(?:reel|videos|posts)\/(\d+)/.exec(u.pathname)?.[1];
      const gid = m?.[1] ?? fallbackGroupId;
      if (pid && /^\d+$/.test(pid)) {
        return {
          postId: pid,
          postUrl: `https://www.facebook.com/groups/${encodeURIComponent(gid)}/posts/${pid}/`,
        };
      }
    } catch {
      /* ignore malformed URL */
    }
    return null;
  };

  const direct = extractFromUrl(cleaned);
  if (direct) return direct;

  if (/^https?:\/\//i.test(cleaned)) {
    try {
      const res = await fetch(cleaned, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'facebookexternalhit/1.1' },
      });
      const loc = res.headers.get('location');
      if (loc) {
        const resolved = extractFromUrl(new URL(loc, cleaned).href);
        if (resolved) return resolved;
      }
    } catch {
      /* fallback to deterministic numeric ID below */
    }
  }

  const hashDigits = BigInt(
    '0x' + createHash('sha256').update(cleaned).digest('hex').slice(0, 14),
  ).toString(10);
  return {
    postId: hashDigits,
    postUrl: cleaned.startsWith('http')
      ? cleaned
      : `https://www.facebook.com/groups/${encodeURIComponent(fallbackGroupId)}/posts/${hashDigits}/`,
  };
}

const WINRT_OCR_POWERSHELL_SCRIPT = `
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataWriter, Windows.Foundation, ContentType = WindowsRuntime]

$asTaskMethods = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethod }
$asTaskGeneric = $asTaskMethods[0]
function Await-WinRT($op, [Type]$resultType) {
  $m = $asTaskGeneric.MakeGenericMethod($resultType)
  $t = $m.Invoke($null, @($op))
  return $t.GetAwaiter().GetResult()
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line -eq "__EXIT__") { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $reqId = 0
  try {
    $req = $line | ConvertFrom-Json
    $reqId = [int]$req.id
    if ($null -eq $engine) {
      $out = @{ id = $reqId; text = "" } | ConvertTo-Json -Compress
      [Console]::Out.WriteLine($out)
      [Console]::Out.Flush()
      continue
    }
    $bytes = [Convert]::FromBase64String([string]$req.b64)
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $writer = New-Object Windows.Storage.Streams.DataWriter($stream.GetOutputStreamAt(0))
    $writer.WriteBytes($bytes)
    $null = Await-WinRT ($writer.StoreAsync()) ([uint32])
    $writer.DetachStream() | Out-Null
    $writer.Dispose()
    $stream.Seek(0)
    $decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bmp = Await-WinRT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await-WinRT ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    $bmp.Dispose()
    $stream.Dispose()
    $out = @{ id = $reqId; text = [string]$res.Text } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($out)
    [Console]::Out.Flush()
  } catch {
    $out = @{ id = $reqId; text = "" } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($out)
    [Console]::Out.Flush()
  }
}
`;

export interface OcrRecognizer {
  recognizeBounds(pngBuffer: Buffer, bounds: RectBounds): Promise<string>;
  close(): void;
}

export class WindowsOcrClient implements OcrRecognizer {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<
    number,
    { resolve: (text: string) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private queue: Promise<unknown> = Promise.resolve();

  private ensureProcess(): ChildProcessWithoutNullStreams | null {
    if (this.closed || process.platform !== 'win32') return null;
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
      return this.proc;
    }
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        WINRT_OCR_POWERSHELL_SCRIPT,
      ],
      { windowsHide: true },
    );
    this.stdoutBuffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString('utf8');
      let nlIdx: number;
      while ((nlIdx = this.stdoutBuffer.indexOf('\n')) !== -1) {
        const line = this.stdoutBuffer.slice(0, nlIdx).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(nlIdx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { id?: number; text?: string };
          if (typeof parsed.id === 'number') {
            const waiter = this.pending.get(parsed.id);
            if (waiter) {
              clearTimeout(waiter.timer);
              this.pending.delete(parsed.id);
              waiter.resolve(String(parsed.text ?? ''));
            }
          }
        } catch {
          /* ignore non-JSON output */
        }
      }
    });
    const flushPendingEmpty = () => {
      for (const [id, waiter] of this.pending) {
        clearTimeout(waiter.timer);
        waiter.resolve('');
        this.pending.delete(id);
      }
      if (this.proc === child) this.proc = null;
    };
    child.on('exit', flushPendingEmpty);
    child.on('error', flushPendingEmpty);
    this.proc = child;
    return child;
  }

  private async buildUpscaledContrastPngBase64(
    pngBuffer: Buffer,
    bounds: RectBounds,
  ): Promise<string | null> {
    const frame = await getCanonicalFrame(pngBuffer);
    if (!frame) return null;
    const crop = clampCrop(bounds.x1, bounds.y1, bounds.w, bounds.h, 10);
    if (!crop) return null;
    const { createCanvas } = await import('@napi-rs/canvas');
    const scale = crop.height <= 46 ? 3 : 2;
    const pad = 18;
    const innerW = crop.width * scale;
    const innerH = crop.height * scale;
    const outW = innerW + pad * 2;
    const outH = innerH + pad * 2;
    const out = createCanvas(outW, outH);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(
      frame.canvas,
      crop.left,
      crop.top,
      crop.width,
      crop.height,
      pad,
      pad,
      innerW,
      innerH,
    );

    // Grayscale + contrast stretch inside crop area while keeping clean white quiet-zone border
    const imgData = ctx.getImageData(0, 0, outW, outH);
    const d = imgData.data;
    let minL = 255;
    let maxL = 0;
    for (let y = pad; y < pad + innerH; y++) {
      for (let x = pad; x < pad + innerW; x++) {
        const i = (y * outW + x) * 4;
        const lum = Math.round(
          0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0),
        );
        d[i] = lum;
        if (lum < minL) minL = lum;
        if (lum > maxL) maxL = lum;
      }
    }
    const span = Math.max(1, maxL - minL);
    for (let y = pad; y < pad + innerH; y++) {
      for (let x = pad; x < pad + innerW; x++) {
        const i = (y * outW + x) * 4;
        const stretched =
          span >= 20 ? Math.round((((d[i] ?? 0) - minL) * 255) / span) : (d[i] ?? 0);
        d[i] = stretched;
        d[i + 1] = stretched;
        d[i + 2] = stretched;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    return Buffer.from(out.toBuffer('image/png')).toString('base64');
  }

  async recognizeBounds(pngBuffer: Buffer, bounds: RectBounds): Promise<string> {
    const task = this.queue.then(async () => {
      if (this.closed) return '';
      try {
        const b64 = await this.buildUpscaledContrastPngBase64(pngBuffer, bounds);
        if (!b64) return '';
        const child = this.ensureProcess();
        if (!child || !child.stdin.writable) return '';
        const id = this.nextId++;
        const rawText = await new Promise<string>((resolve) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            resolve('');
          }, 8000);
          this.pending.set(id, { resolve, timer });
          child.stdin.write(JSON.stringify({ id, b64 }) + '\n');
        });
        return rawText.replace(/\s+/g, ' ').trim();
      } catch {
        return '';
      }
    });
    this.queue = task.catch(() => '');
    return task;
  }

  close(): void {
    this.closed = true;
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.resolve('');
      this.pending.delete(id);
    }
    if (this.proc) {
      try {
        if (this.proc.stdin.writable) {
          this.proc.stdin.write('__EXIT__\n');
        }
        this.proc.kill();
      } catch {
        /* ignore cleanup errors */
      }
      this.proc = null;
    }
  }
}
