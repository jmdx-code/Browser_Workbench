import type { BumperReactionType } from '../../shared/group-bumper.js';
import {
  CANONICAL_HEIGHT,
  CANONICAL_WIDTH,
  flattenLiteNodes,
  makeCanonicalRect,
  type LiteXmlNode,
  type RectBounds,
} from './vision-xml.js';
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
export interface LiteInlineVideoControls {
  videoBounds: RectBounds | null;
  soundBounds: RectBounds | null;
  ended: boolean;
}
export const isLiteTextInputClass = (c: string): boolean =>
  c.includes('TextInputView') || c.includes('MultiAutoCompleteTextView') || c.includes('EditText');
export const findAllTextInputNodes = (root: LiteXmlNode | null): LiteXmlNode[] =>
  flattenLiteNodes(root)
    .filter(
      (n) =>
        isLiteTextInputClass(n.className) ||
        (n.focused && n.clickable && n.longClickable && n.bounds.w >= 400 && n.bounds.h <= 140),
    )
    .sort((a, b) => a.bounds.y1 - b.bounds.y1);
export const findTextInputNode = (root: LiteXmlNode | null): LiteXmlNode | null =>
  findAllTextInputNodes(root)[0] ?? null;
export interface DetectedHomeTabBar {
  identityHint: 'personal' | 'page';
  collapsed: boolean;
  tabs: RectBounds[];
}
export function detectHomeTabBar(root: LiteXmlNode | null): DetectedHomeTabBar | null {
  if (!root) return null;
  const all = flattenLiteNodes(root),
    groupByRow = (nodes: LiteXmlNode[]) => {
      const rows: LiteXmlNode[][] = [];
      for (const n of nodes) {
        const match = rows.find(
          (r) =>
            r[0] &&
            Math.abs(r[0].bounds.y1 - n.bounds.y1) <= 16 &&
            Math.abs(r[0].bounds.h - n.bounds.h) <= 16,
        );
        if (match) {
          if (!match.some((x) => Math.abs(x.bounds.x1 - n.bounds.x1) < 35)) match.push(n);
        } else rows.push([n]);
      }
      return rows;
    };
  const specs = [
    { hint: 'personal' as const, y2Max: 255, wMin: 115, wMax: 195, ok: (n: number) => n >= 5 },
    { hint: 'page' as const, y2Max: 255, wMin: 196, wMax: 265, ok: (n: number) => n === 4 },
  ];
  for (const s of specs) {
    const cands = all.filter(
      (n) =>
        n.clickable &&
        n.bounds.y1 >= 20 &&
        n.bounds.y2 <= s.y2Max &&
        n.bounds.w >= s.wMin &&
        n.bounds.w <= s.wMax &&
        n.bounds.h >= 40 &&
        n.bounds.h <= 110,
    );
    for (const row of groupByRow(cands)) {
      if (!s.ok(row.length)) continue;
      const sorted = [...row].sort((a, b) => a.bounds.x1 - b.bounds.x1);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      if (!first || !last || last.bounds.x2 - first.bounds.x1 < 660) continue;
      return {
        identityHint: s.hint,
        collapsed: first.bounds.y1 < 75,
        tabs: sorted.map((n) => n.bounds),
      };
    }
  }
  return null;
}
export function classifyAbnormalScreenText(
  rawOcrText: string,
): 'logged-out' | 'verification' | 'restricted' | null {
  const compact = rawOcrText.replace(/\s+/g, '').toLowerCase();
  if (!compact) return null;
  if (
    /accountdisabled|youraccount(?:is|hasbeen)disabled|wedisabledyouraccount|suspendedyouraccount|we'vesuspendedyouraccount|wehavedisabled|账号已停用|账户已停用|帐户已停用|已停用你的账户|已封禁|永久封禁|账户被封/i.test(
      compact,
    )
  )
    return 'restricted';
  if (
    /secureyouraccount|suspiciousactivity|passasecuritycheck|createanewpassword|confirmyouridentity|accountlocked|we'velockedyouraccount|weneedtoconfirm|checkpoint|验证你的身份|确认你的身份|安全检查|保护你的账户|检测到可疑活动|账户已锁定|账号已锁定|申诉|上传身份证/i.test(
      compact,
    )
  )
    return 'verification';
  if (
    /手机号或邮箱.*密码.*登录|创建新账户|创建新账号|createnewaccount|forgotpassword\?|忘记密码了/i.test(
      compact,
    )
  )
    return 'logged-out';
  return null;
}
export function extractReactionPopupButtons(
  root: LiteXmlNode | null,
  likeBounds: RectBounds,
): Partial<Record<BumperReactionType, RectBounds>> {
  const result: Partial<Record<BumperReactionType, RectBounds>> = {};
  if (!root) return result;
  const candidates = flattenLiteNodes(root).filter(
      (n) =>
        n.clickable &&
        n.bounds.w >= 70 &&
        n.bounds.w <= 170 &&
        n.bounds.h >= 70 &&
        n.bounds.h <= 160 &&
        n.bounds.y1 >= Math.max(0, likeBounds.y1 - 320) &&
        n.bounds.y2 <= likeBounds.y1 + 24,
    ),
    unique: LiteXmlNode[] = [];
  for (const c of candidates)
    if (
      !unique.some(
        (u) => Math.abs(u.bounds.cx - c.bounds.cx) < 40 && Math.abs(u.bounds.cy - c.bounds.cy) < 40,
      )
    )
      unique.push(c);
  const rows: LiteXmlNode[][] = [];
  for (const n of unique) {
    const r = rows.find((row) => row[0] && Math.abs(row[0].bounds.cy - n.bounds.cy) <= 45);
    if (r) r.push(n);
    else rows.push([n]);
  }
  rows.sort((a, b) => (a[0]?.bounds.cy ?? 0) - (b[0]?.bounds.cy ?? 0));
  for (const row of rows) row.sort((a, b) => a.bounds.x1 - b.bounds.x1);
  if (rows.length >= 2) {
    const topRow = rows[0] ?? [],
      bottomRow = rows[1] ?? [];
    if (topRow.length === 3 && bottomRow.length === 4) {
      (['like', 'love', 'care'] as BumperReactionType[]).forEach((t, i) => {
        const b = topRow[i]?.bounds;
        if (b) result[t] = b;
      });
      (['haha', 'wow', 'sad', 'angry'] as BumperReactionType[]).forEach((t, i) => {
        const b = bottomRow[i]?.bounds;
        if (b) result[t] = b;
      });
      return result;
    }
  }
  const widestRow = rows.find((r) => r.length >= 6);
  if (widestRow) {
    const seq: BumperReactionType[] =
      widestRow.length >= 7
        ? ['like', 'love', 'care', 'haha', 'wow', 'sad', 'angry']
        : ['like', 'love', 'haha', 'wow', 'sad', 'angry'];
    seq.forEach((t, i) => {
      const b = widestRow[i]?.bounds;
      if (b) result[t] = b;
    });
  }
  return result;
}
function makeRect(x1: number, y1: number, x2: number, y2: number): RectBounds {
  const b = makeCanonicalRect(x1, y1, x2, y2);
  if (b.w >= 1 && b.h >= 1) return b;
  return makeCanonicalRect(
    b.x1,
    b.y1,
    Math.min(CANONICAL_WIDTH, b.x1 + Math.max(1, b.w)),
    Math.min(CANONICAL_HEIGHT, b.y1 + Math.max(1, b.h)),
  );
}
function selectMainFeedScope(root: LiteXmlNode | null): {
  feedNodes: LiteXmlNode[];
  maxSafeY: number;
} {
  if (!root) return { feedNodes: [], maxSafeY: 1520 };
  const rawAll = flattenLiteNodes(root),
    mainRecycler = rawAll
      .filter(
        (n) =>
          n.className.includes('RecyclerView') &&
          n.scrollable &&
          n.bounds.w >= 840 &&
          n.bounds.h >= 980 &&
          n.bounds.y1 <= 260,
      )
      .at(-1),
    feedNodes = mainRecycler ? flattenLiteNodes(mainRecycler) : rawAll,
    feedNodeSet = new Set<LiteXmlNode>(feedNodes);
  let maxSafeY = 1520;
  for (const n of rawAll) {
    if (
      !feedNodeSet.has(n) &&
      n.clickable &&
      n.bounds.w >= 780 &&
      n.bounds.h >= 44 &&
      n.bounds.h <= 78 &&
      n.bounds.y1 >= 1420 &&
      n.bounds.y2 <= 1535
    )
      maxSafeY = Math.min(maxSafeY, n.bounds.y1 - 4);
  }
  return { feedNodes, maxSafeY };
}
export function extractActionBars(root: LiteXmlNode | null): LitePostActionBar[] {
  if (!root) return [];
  const { feedNodes: all, maxSafeY } = selectMainFeedScope(root),
    actionBars: LitePostActionBar[] = [],
    likeCandidates = all.filter(
      (n) =>
        n.clickable &&
        n.bounds.x1 <= 36 &&
        span(n.bounds.x2, 240, 340) &&
        span(n.bounds.h, 38, 92) &&
        n.bounds.y1 >= 100 &&
        n.bounds.y2 <= maxSafeY,
    );
  for (const like of likeCandidates) {
    const findPeer = (x1Min: number, x1Max: number, x2Min: number, x2Max: number) =>
      all.find(
        (n) =>
          n.clickable &&
          n !== like &&
          Math.abs(n.bounds.y1 - like.bounds.y1) <= 12 &&
          Math.abs(n.bounds.h - like.bounds.h) <= 14 &&
          span(n.bounds.x1, x1Min, x1Max) &&
          span(n.bounds.x2, x2Min, x2Max),
      );
    const comment = findPeer(260, 345, 555, 640),
      share = findPeer(560, 645, 855, 900);
    if (!comment || !share) continue;
    const widths = [like.bounds.w, comment.bounds.w, share.bounds.w],
      isBalancedTriad =
        Math.max(...widths) - Math.min(...widths) <= 24 &&
        comment.bounds.x1 - like.bounds.x2 <= 14 &&
        share.bounds.x1 - comment.bounds.x2 <= 14 &&
        share.bounds.x2 - like.bounds.x1 >= 840,
      hasLikeCue = like.longClickable || /赞|讚|like/i.test(`${like.contentDesc} ${like.text}`);
    if (
      (hasLikeCue || isBalancedTriad) &&
      !actionBars.some((ab) => Math.abs(ab.y1 - like.bounds.y1) < 20)
    )
      actionBars.push({
        y1: like.bounds.y1,
        y2: like.bounds.y2,
        likeBounds: like.bounds,
        commentBounds: comment.bounds,
        shareBounds: share.bounds,
      });
  }
  return actionBars.sort((a, b) => a.y1 - b.y1);
}
function findCardAvatarNode(headerNode: LiteXmlNode): LiteXmlNode | undefined {
  const isAvatar = (c: LiteXmlNode) =>
    c.bounds.x1 <= 48 &&
    span(c.bounds.x2, 62, 126) &&
    span(c.bounds.w, 38, 96) &&
    span(c.bounds.h, 38, 96) &&
    c.bounds.y1 >= 80 &&
    c.bounds.cy >= 106;
  const direct = headerNode.children.find(isAvatar);
  if (direct) return direct;
  for (const child of headerNode.children) {
    if (child.bounds.x1 <= 48 && child.bounds.x2 <= 135) {
      const nested = child.children.find(isAvatar);
      if (nested) return nested;
    }
  }
  return undefined;
}
function findCardMoreMenuNode(
  headerNode: LiteXmlNode,
  avatarNode: LiteXmlNode,
  second: LiteXmlNode,
): LiteXmlNode | null {
  const secondSet = new Set(flattenLiteNodes(second));
  const isMoreCand = (c: LiteXmlNode) =>
    c !== headerNode &&
    c !== avatarNode &&
    !secondSet.has(c) &&
    c.clickable &&
    c.bounds.x1 >= 740 &&
    c.bounds.x2 <= 900 &&
    c.bounds.w <= 125 &&
    c.bounds.h <= 115 &&
    c.bounds.cy >= 106;
  const direct = headerNode.children.filter(isMoreCand);
  const cands = direct.length > 0 ? direct : flattenLiteNodes(headerNode).filter(isMoreCand);
  if (cands.length === 0) return null;
  const semantic = cands.find((c) =>
    /more|更多|选项|菜單|菜单|menu/i.test(`${c.contentDesc} ${c.text}`),
  );
  if (semantic) return semantic;
  // When both "..." and "X" sit side-by-side in FB Lite 524 headers, "..." sits left of "X".
  return [...cands].sort((a, b) => a.bounds.x1 - b.bounds.x1)[0] ?? null;
}
export function extractPostCards(root: LiteXmlNode | null): LitePostCard[] {
  if (!root) return [];
  const { feedNodes: all, maxSafeY } = selectMainFeedScope(root),
    homeTabBottom = detectHomeTabBar(root)?.tabs[0]?.y2 ?? -1,
    headers: LitePostHeader[] = [];
  for (const node of all) {
    const b = node.bounds;
    if (
      b.x1 > 24 ||
      b.x2 < 876 ||
      !span(b.h, 58, 150) ||
      b.y1 < 72 ||
      b.y2 > maxSafeY ||
      node.children.length < 2
    )
      continue;
    const avatarNode = findCardAvatarNode(node);
    const second = avatarNode
      ? node.children.find(
          (c) =>
            c !== avatarNode &&
            c.bounds.x1 >= avatarNode.bounds.x2 - 4 &&
            c.bounds.x1 <= 150 &&
            c.bounds.w >= 140,
        )
      : undefined;
    if (avatarNode && second) {
      const moreNode = findCardMoreMenuNode(node, avatarNode, second);
      if (!moreNode) continue;
      const sortedSub = flattenLiteNodes(second)
        .filter((c) => c !== second)
        .sort((a, bSub) => a.bounds.y1 - bSub.bounds.y1);
      if (homeTabBottom > 0 && b.y1 <= homeTabBottom + 40 && sortedSub.length <= 1) continue;
      const nameNode =
          sortedSub.find(
            (c) => c.clickable && c.bounds.x1 <= 145 && c.bounds.y1 <= second.bounds.y1 + 22,
          ) ?? sortedSub[0],
        authorNameBounds = nameNode
          ? makeRect(
              Math.max(80, nameNode.bounds.x1 - 4),
              Math.max(b.y1, nameNode.bounds.y1 - 4),
              Math.min(820, nameNode.bounds.x2 + 12),
              Math.min(b.y2, nameNode.bounds.y2 + 6),
            )
          : makeRect(88, b.y1 + 14, 520, b.y1 + 52),
        tsNode = sortedSub.findLast((c) => c.bounds.y1 >= second.bounds.y1 + 18),
        tsY1 = tsNode ? tsNode.bounds.y1 - 4 : nameNode ? nameNode.bounds.y2 - 2 : b.y1 + 46,
        tsY2 = tsNode ? tsNode.bounds.y2 + 4 : tsY1 + 32,
        tsX2 = tsNode ? Math.min(760, Math.max(220, tsNode.bounds.x2 + 28)) : 320,
        timestampBounds = makeRect(80, tsY1, tsX2, Math.min(b.y2 + 6, tsY2));
      if (!headers.some((h) => Math.abs(h.bounds.y1 - b.y1) < 25))
        headers.push({
          bounds: b,
          avatarBounds: avatarNode.bounds,
          authorNameBounds,
          timestampBounds,
          moreMenuBounds: moreNode.bounds,
        });
    }
  }
  headers.sort((a, b) => a.bounds.y1 - b.bounds.y1);
  const actionBars = extractActionBars(root),
    usedBars = new Set<LitePostActionBar>();
  return headers.map((header, i) => {
    const nextHeaderY = headers[i + 1]?.bounds.y1 ?? CANONICAL_HEIGHT,
      bar =
        actionBars.find(
          (ab) => !usedBars.has(ab) && ab.y1 > header.bounds.y2 && ab.y1 < nextHeaderY,
        ) ?? null;
    if (bar) usedBars.add(bar);
    return {
      header,
      actionBar: bar,
      cardBounds: makeRect(
        0,
        header.bounds.y1,
        CANONICAL_WIDTH,
        bar ? bar.y2 : Math.min(1528, nextHeaderY),
      ),
    };
  });
}
function span(v: number, min: number, max: number): boolean {
  return v >= min && v <= max;
}
const isRightCornerCloseBtn = (c: LiteXmlNode) =>
  c.clickable &&
  span(c.bounds.x1, 825, 896) &&
  c.bounds.x2 <= 896 &&
  span(c.bounds.w, 24, 55) &&
  span(c.bounds.h, 24, 55);
export function hasPageTopBar(root: LiteXmlNode | null): boolean {
  if (!root) return false;
  const all = flattenLiteNodes(root),
    barBtn = (n: LiteXmlNode) => n.clickable && n.bounds.y1 >= 28 && n.bounds.y2 <= 112;
  return (
    all.some((n) => barBtn(n) && n.bounds.x1 <= 12 && n.bounds.x2 <= 96) &&
    all.some((n) => barBtn(n) && n.bounds.x1 >= 730 && n.bounds.x2 <= 900)
  );
}
export function extractInlineVideoControls(
  root: LiteXmlNode | null,
  minY: number,
  maxY: number,
  headerOnScreen = true,
): LiteInlineVideoControls {
  if (!root || maxY <= minY) return { videoBounds: null, soundBounds: null, ended: false };
  let videoBounds: RectBounds | null = null,
    soundBounds: RectBounds | null = null,
    ended = false;
  const matchesCardVerticalSpan = (b: RectBounds): boolean =>
    headerOnScreen
      ? b.y1 >= minY - 110 && b.y2 > minY + 32 && b.y1 < maxY - 24 && b.y2 <= maxY + 80
      : b.y2 > 140 && b.y1 < maxY - 24 && b.y2 <= maxY + 80;
  for (const n of flattenLiteNodes(root)) {
    if (
      /(?:^|:id\/)video_view$/i.test(n.resourceId) &&
      n.bounds.h >= 160 &&
      matchesCardVerticalSpan(n.bounds) &&
      (!videoBounds || n.bounds.h > videoBounds.h)
    )
      videoBounds = n.bounds;
    if (
      /(?:^|:id\/)(?:carbon_)?sound_image_view$/i.test(n.resourceId) &&
      n.bounds.w >= 32 &&
      n.bounds.h >= 32 &&
      n.bounds.x1 >= 720 &&
      n.bounds.y1 >= Math.max(108, headerOnScreen ? minY - 12 : 108) &&
      n.bounds.y2 <= Math.min(1492, maxY + 24)
    )
      soundBounds = n.bounds;
    if (
      /(?:^|:id\/)end_of_video_cta$/i.test(n.resourceId) &&
      n.bounds.h >= 120 &&
      matchesCardVerticalSpan(n.bounds)
    )
      ended = true;
  }
  return { videoBounds, soundBounds, ended };
}
export function hasPageHeroHeader(root: LiteXmlNode | null): boolean {
  if (!root) return false;
  const { feedNodes } = selectMainFeedScope(root);
  if (
    feedNodes.some(
      (n) =>
        span(n.bounds.w, 180, 360) &&
        span(n.bounds.h, 180, 360) &&
        Math.abs(n.bounds.cx - 450) <= 45 &&
        span(n.bounds.y1, 160, 460),
    )
  )
    return true;
  const cta = (pred: (n: LiteXmlNode) => boolean) =>
    feedNodes.some(
      (n) =>
        n.clickable &&
        span(n.bounds.h, 40, 80) &&
        n.bounds.y1 >= 420 &&
        n.bounds.y2 <= 1050 &&
        pred(n),
    );
  return (
    cta((n) => n.bounds.x1 <= 32 && Math.abs(n.bounds.x2 - 444) <= 26) &&
    cta((n) => Math.abs(n.bounds.x1 - 456) <= 26 && n.bounds.x2 >= 868)
  );
}
export const findSeeMoreButtonNode = (root: LiteXmlNode | null): LiteXmlNode | null =>
  flattenLiteNodes(root).find((n) => {
    const onlyChild = n.children[0];
    return (
      n.clickable &&
      n.bounds.x1 <= 4 &&
      n.bounds.x2 >= 896 &&
      span(n.bounds.h, 46, 70) &&
      n.bounds.y1 >= 300 &&
      n.bounds.y2 <= 1525 &&
      n.children.length === 1 &&
      Boolean(onlyChild && span(onlyChild.bounds.x1, 345, 555) && onlyChild.bounds.x2 <= 555)
    );
  }) ?? null;
export const findJoinGroupButtonNode = (root: LiteXmlNode | null): LiteXmlNode | null =>
  flattenLiteNodes(root).find(
    (n) =>
      n.clickable &&
      n.bounds.x1 <= 32 &&
      n.bounds.x2 >= 868 &&
      n.bounds.w >= 836 &&
      span(n.bounds.h, 44, 74) &&
      n.bounds.y1 >= 555 &&
      n.bounds.y2 <= 925,
  ) ?? null;
export function findRelatedGroupsCloseButtonNode(root: LiteXmlNode | null): LiteXmlNode | null {
  for (const n of flattenLiteNodes(root)) {
    if (
      n.bounds.x1 <= 4 &&
      n.bounds.x2 >= 896 &&
      n.bounds.h >= 350 &&
      n.bounds.y1 >= 635 &&
      n.bounds.y2 <= 1355 &&
      n.children.some((c) => c.className.includes('RecyclerView'))
    ) {
      const closeBtn = n.children.find(
        (c) => isRightCornerCloseBtn(c) && c.bounds.x2 <= 895 && c.bounds.y1 <= n.bounds.y1 + 74,
      );
      if (closeBtn) return closeBtn;
    }
  }
  return null;
}
export function findGroupSortButtonNode(root: LiteXmlNode | null): LiteXmlNode | null {
  for (const n of flattenLiteNodes(root)) {
    if (
      n.bounds.x1 <= 4 &&
      n.bounds.x2 >= 896 &&
      span(n.bounds.h, 52, 92) &&
      span(n.bounds.y1, 345, 1560) &&
      n.bounds.y2 <= 1560 &&
      n.children.length === 2
    ) {
      const leftLabel = n.children.find(
          (c) => !c.clickable && span(c.bounds.x1, 8, 44) && c.bounds.x2 <= 285,
        ),
        rightBtn = n.children.find(isRightCornerCloseBtn);
      if (leftLabel && rightBtn) return rightBtn;
    }
  }
  return null;
}
