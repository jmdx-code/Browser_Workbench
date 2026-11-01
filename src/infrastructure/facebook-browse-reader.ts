import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  BrowseScrollRoot,
  BrowseCenterHit,
  BrowseVisiblePlayer,
  BrowsePendingDiagnostic,
  BrowseContentPosition,
} from '../shared/browse-execution.js';
import {
  FACEBOOK_REEL_NEXT_CSS,
  FACEBOOK_FRIEND_CONFIRM_CSS,
  FACEBOOK_BROWSE_LIKE_CSS,
  FACEBOOK_BROWSE_DIALOG_DISMISS_CSS,
} from '../shared/facebook-browse-route.js';
export {
  FACEBOOK_REEL_NEXT_CSS,
  FACEBOOK_FRIEND_CONFIRM_CSS,
  FACEBOOK_BROWSE_LIKE_CSS,
  FACEBOOK_BROWSE_DIALOG_DISMISS_CSS,
} from '../shared/facebook-browse-route.js';

export const FacebookBrowsePage = z
  .object({
    url: z.string().max(4096),
    timeOrigin: z.number().finite().nonnegative(),
    ready: z.boolean(),
    visible: z.boolean(),
    blocked: z.boolean(),
    scrollY: z.number().finite().nonnegative(),
    scrollMaxY: z.number().finite().nonnegative().optional(),
    viewportHeight: z.number().finite().nonnegative(),
    contentKey: z.string().max(2000).nullable(),
    contentPosition: BrowseContentPosition.nullable().optional(),
    recommendedDwellMs: z.number().int().min(1400).max(30000).optional(),
    nextScrollDeltaY: z.number().int().min(100).max(1200).optional(),
    videoEntry: z.string().max(2048).nullable().optional(),
    nextReelCSS: z.literal(FACEBOOK_REEL_NEXT_CSS).nullable().optional(),
    friendConfirmCSS: z.literal(FACEBOOK_FRIEND_CONFIRM_CSS).nullable().optional(),
    friendPendingCount: z.number().int().nonnegative().optional(),
    dialogDismissCSS: z.literal(FACEBOOK_BROWSE_DIALOG_DISMISS_CSS).nullable().optional(),
    likeTarget: z
      .object({
        css: z.literal(FACEBOOK_BROWSE_LIKE_CSS).nullable(),
        liked: z.boolean(),
        likeCount: z.number().int().nonnegative(),
        sponsored: z.boolean(),
        text: z.string().max(1000),
      })
      .strict()
      .nullable()
      .optional(),
    marketplaceItems: z.array(z.string().max(2048)).max(8).optional(),
    marketplaceUnavailable: z.boolean().optional(),
    marketplaceCategories: z.array(z.string().max(2048)).max(32).optional(),
    structure: z
      .object({
        mainCount: z.number().int().nonnegative(),
        allVideos: z.number().int().nonnegative(),
        mainVideos: z.number().int().nonnegative(),
        visibleVideos: z.number().int().nonnegative(),
        structuralPosts: z.number().int().nonnegative().optional(),
        scrollRoots: z.array(BrowseScrollRoot).max(4).optional(),
        centerHit: BrowseCenterHit.nullable().optional(),
        players: z.array(BrowseVisiblePlayer).max(8).optional(),
      })
      .strict()
      .optional(),
    video: z
      .object({
        css: z.string().max(300).nullable(),
        source: z.string().max(4096),
        paused: z.boolean(),
        buffering: z.boolean(),
        failed: z.boolean().optional(),
        readyState: z.number().int().min(0).max(4).optional(),
        ended: z.boolean(),
        timeSeconds: z.number().finite().nonnegative(),
        durationSeconds: z.number().finite().positive().nullable().optional(),
        playbackRate: z.number().min(0).max(4),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type BrowsePage = z.infer<typeof FacebookBrowsePage>;

// Input preparation does not need post bodies, players, or the diagnostic descendant scan.
// This read grants no content/progress; the independent effect reader remains unchanged.
export function projectFacebookFeedInputFence() {
  type DOMRecord = Record<string, unknown>;
  const record = (v: unknown): v is DOMRecord => !!v && typeof v === 'object';
  const cacheHost = (typeof window === 'undefined' ? document : window) as unknown as {
    __wbReactRootNodesV1?: WeakMap<Element, DOMRecord>;
  };
  const rootNodes = (cacheHost.__wbReactRootNodesV1 ??= new WeakMap<Element, DOMRecord>());
  let rootScanned = false;
  let cachedFiberKey = '';
  const currentRootNode = (node: DOMRecord | undefined): DOMRecord | undefined => {
    for (const candidate of [node, record(node?.alternate) ? node.alternate : undefined]) {
      let root: unknown = candidate;
      for (let depth = 0; record(root) && depth < 256; depth++) {
        if (!root.return) {
          if (record(root.stateNode) && root.stateNode.current === root) return candidate;
          break;
        }
        root = root.return;
      }
    }
    return undefined;
  };
  const fiberNode = (el: Element) => {
    const key =
      cachedFiberKey && cachedFiberKey in el
        ? cachedFiberKey
        : Object.keys(el).find(
            (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
          );
    if (key) {
      cachedFiberKey = key;
      const raw: unknown = Reflect.get(el, key);
      if (record(raw)) {
        const resolved = currentRootNode(raw) ?? raw;
        rootNodes.set(el, resolved);
        return resolved;
      }
      return raw;
    }
    const cached = currentRootNode(rootNodes.get(el));
    if (cached) {
      rootNodes.set(el, cached);
      return cached;
    }
    if (!rootScanned) {
      rootScanned = true;
      const stack: unknown[] = [],
        seen = new Set<unknown>();
      const primaryHosts = Array.from(
        document.querySelectorAll(
          'video, [role="main"], [role="presentation"], [data-pagelet], body, [id^="mount"]',
        ),
      ).slice(0, 40);
      const hosts =
        primaryHosts.length > 0
          ? primaryHosts
          : Array.from(document.querySelectorAll('*')).slice(0, 40);
      for (const host of hosts)
        for (const k of Object.keys(host).filter((k) => k.startsWith('__reactContainer$'))) {
          const r: unknown = Reflect.get(host, k);
          stack.push(record(r) && record(r.stateNode) ? (r.stateNode.current ?? r) : r);
        }
      while (stack.length && seen.size < 3000) {
        const f = stack.pop();
        if (!record(f) || seen.has(f)) continue;
        seen.add(f);
        if (f.stateNode instanceof Element) rootNodes.set(f.stateNode, f);
        const child = f.child;
        if (child) stack.push(child);
        const sibling = f.sibling;
        if (sibling) stack.push(sibling);
      }
    }
    return rootNodes.get(el);
  };
  const frames = (el: Element, limit = 40) => {
    const primary: { name: string; props: DOMRecord }[] = [];
    const secondary: { name: string; props: DOMRecord }[] = [];
    const frameOf = (node: DOMRecord) => {
      const t = node.type ?? node.elementType;
      const name =
        typeof t === 'function'
          ? String(Reflect.get(t, 'displayName') ?? t.name)
          : record(t)
            ? String(t.displayName ?? '')
            : typeof t === 'string'
              ? t
              : '';
      const memoProps = record(node.memoizedProps) ? node.memoizedProps : null;
      const pendingProps = record(node.pendingProps) ? node.pendingProps : null;
      const props =
        memoProps && (!pendingProps || pendingProps === memoProps)
          ? memoProps
          : pendingProps && !memoProps
            ? pendingProps
            : memoProps && pendingProps
              ? { ...pendingProps, ...memoProps }
              : {};
      return { name, props };
    };
    let f: unknown = fiberNode(el);
    for (let i = 0; record(f) && i < limit; i++, f = f.return) {
      primary.push(frameOf(f));
      if (record(f.alternate)) secondary.push(frameOf(f.alternate));
    }
    return [...primary, ...secondary];
  };
  const blockingDialog = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (
      r.width <= 0 ||
      r.height <= 0 ||
      r.bottom <= 0 ||
      r.right <= 0 ||
      r.top >= innerHeight ||
      r.left >= innerWidth
    )
      return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)
      return false;
    if (el.getAttribute('aria-modal') === 'true') return true;
    const chain = frames(el, 48);
    if (chain.some((f) => f.name.includes('GroupsCometFeatureInterventionDialog'))) return true;
    if (
      chain.some(
        (f) =>
          f.name.includes('CometTopNavListDropdown.react') ||
          f.name.includes('CometMessagingJewelDropdown.react') ||
          f.name.includes('MWV2ChatTabsRoot.react') ||
          f.name.includes('MWV2ChatTabsLayout.react'),
      )
    )
      return false;
    // Edge chat/popovers do not cover the main interaction point. A central
    // dialog must also own the topmost hit, rather than merely have a large box.
    const main = document.querySelector('main,[role="main"]');
    const mr = main?.getBoundingClientRect();
    const x = mr
      ? Math.max(0, mr.left) + (Math.min(innerWidth, mr.right) - Math.max(0, mr.left)) / 2
      : innerWidth / 2;
    const y = mr
      ? Math.max(0, mr.top) + (Math.min(innerHeight, mr.bottom) - Math.max(0, mr.top)) / 2
      : innerHeight / 2;
    const hit = document.elementFromPoint(x, y);
    return r.left <= x && r.right >= x && r.top <= y && r.bottom >= y && !!hit && el.contains(hit);
  };

  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    if (
      rect.right <= 0 ||
      rect.bottom <= 0 ||
      rect.left >= innerWidth ||
      rect.top >= innerHeight ||
      rect.width <= 0 ||
      rect.height <= 0
    )
      return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  };
  const mains = Array.from(document.querySelectorAll('main,[role="main"]')).filter(visible);
  const marketplaceSurface =
    /^\/marketplace(?:\/category\/[a-z0-9_-]{1,80}(?:\/search)?|\/(?:(?!(?:inbox|you|create|item|selling|buying|notifications|ineligible|search)(?:\/|$))[a-z0-9_-]{1,80})(?:\/search)?|\/search|\/item\/\d{1,30})?\/?$/i.test(
      location.pathname ?? '',
    );
  return {
    url: location.href,
    timeOrigin: performance.timeOrigin,
    ready:
      document.readyState !== 'loading' &&
      (mains.length === 1 || (marketplaceSurface && mains.length > 1)),
    visible: document.visibilityState === 'visible',
    blocked: Array.from(document.querySelectorAll('[role="dialog"]')).some(blockingDialog),
    scrollY: Math.max(0, scrollY),
    viewportHeight: innerHeight,
    contentKey: null,
    video: null,
  };
}
export function browsePageDiagnostic(page: BrowsePage) {
  return BrowsePendingDiagnostic.parse({
    version: page.contentPosition ? 2 : 1,
    ...(page.contentPosition ? { contentPosition: page.contentPosition } : {}),
    independent: true,
    url: page.url,
    timeOrigin: page.timeOrigin,
    ready: page.ready,
    visible: page.visible,
    blocked: page.blocked,
    scrollY: page.scrollY,
    scrollMaxY: page.scrollMaxY ?? null,
    viewportHeight: page.viewportHeight,
    contentId: page.contentKey ? createHash('sha256').update(page.contentKey).digest('hex') : null,
    mainCount: page.structure?.mainCount ?? null,
    scrollRoots: page.structure?.scrollRoots ?? [],
    centerHit: page.structure?.centerHit ?? null,
    visiblePlayers: page.structure?.players ?? [],
    structuralPosts: page.structure?.structuralPosts ?? null,
  });
}

// Bounded current-page DOM/Fiber read with observed legacy label fallbacks.
// Only local target markers/scroll preparation; no social action or network request.
export function projectFacebookBrowsePage() {
  const homeSurface = location.pathname === '/';
  const reelSurface =
    /^\/(?:watch|reels)\/?$/.test(location.pathname) ||
    /^\/reel\/\d{1,30}\/?$/.test(location.pathname) ||
    (location.pathname === '/reel/' && location.search === '?s=tab' && !location.hash);
  type DOMRecord = Record<string, unknown>;
  const record = (v: unknown): v is DOMRecord => !!v && typeof v === 'object';
  const cacheHost = (typeof window === 'undefined' ? document : window) as unknown as {
    __wbReactRootNodesV1?: WeakMap<Element, DOMRecord>;
  };
  const rootNodes = (cacheHost.__wbReactRootNodesV1 ??= new WeakMap<Element, DOMRecord>());
  let rootScanned = false;
  let cachedFiberKey = '';
  const currentRootNode = (node: DOMRecord | undefined): DOMRecord | undefined => {
    for (const candidate of [node, record(node?.alternate) ? node.alternate : undefined]) {
      let root: unknown = candidate;
      for (let depth = 0; record(root) && depth < 256; depth++) {
        if (!root.return) {
          if (record(root.stateNode) && root.stateNode.current === root) return candidate;
          break;
        }
        root = root.return;
      }
    }
    return undefined;
  };
  const fiberNode = (el: Element) => {
    const key =
      cachedFiberKey && cachedFiberKey in el
        ? cachedFiberKey
        : Object.keys(el).find(
            (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
          );
    if (key) {
      cachedFiberKey = key;
      const raw: unknown = Reflect.get(el, key);
      if (record(raw)) {
        const resolved = currentRootNode(raw) ?? raw;
        rootNodes.set(el, resolved);
        return resolved;
      }
      return raw;
    }
    const cached = currentRootNode(rootNodes.get(el));
    if (cached) {
      rootNodes.set(el, cached);
      return cached;
    }
    if (!rootScanned) {
      rootScanned = true;
      const stack: unknown[] = [],
        seen = new Set<unknown>();
      const primaryHosts = Array.from(
        document.querySelectorAll(
          'video, [role="main"], [role="presentation"], [data-pagelet], body, [id^="mount"]',
        ),
      ).slice(0, 40);
      const hosts =
        primaryHosts.length > 0
          ? primaryHosts
          : Array.from(document.querySelectorAll('*')).slice(0, 40);
      for (const host of hosts)
        for (const k of Object.keys(host).filter((k) => k.startsWith('__reactContainer$'))) {
          const r: unknown = Reflect.get(host, k);
          stack.push(record(r) && record(r.stateNode) ? (r.stateNode.current ?? r) : r);
        }
      while (stack.length && seen.size < 3000) {
        const f = stack.pop();
        if (!record(f) || seen.has(f)) continue;
        seen.add(f);
        if (f.stateNode instanceof Element) rootNodes.set(f.stateNode, f);
        const child = f.child;
        if (child) stack.push(child);
        const sibling = f.sibling;
        if (sibling) stack.push(sibling);
      }
    }
    return rootNodes.get(el);
  };
  const frames = (el: Element, limit = 40) => {
    const primary: { name: string; props: DOMRecord }[] = [];
    const secondary: { name: string; props: DOMRecord }[] = [];
    const frameOf = (node: DOMRecord) => {
      const t = node.type ?? node.elementType;
      const name =
        typeof t === 'function'
          ? String(Reflect.get(t, 'displayName') ?? t.name)
          : record(t)
            ? String(t.displayName ?? '')
            : typeof t === 'string'
              ? t
              : '';
      const memoProps = record(node.memoizedProps) ? node.memoizedProps : null;
      const pendingProps = record(node.pendingProps) ? node.pendingProps : null;
      const props =
        memoProps && (!pendingProps || pendingProps === memoProps)
          ? memoProps
          : pendingProps && !memoProps
            ? pendingProps
            : memoProps && pendingProps
              ? { ...pendingProps, ...memoProps }
              : {};
      return { name, props };
    };
    let f: unknown = fiberNode(el);
    for (let i = 0; record(f) && i < limit; i++, f = f.return) {
      primary.push(frameOf(f));
      if (record(f.alternate)) secondary.push(frameOf(f.alternate));
    }
    return [...primary, ...secondary];
  };
  const blockingDialog = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (
      r.width <= 0 ||
      r.height <= 0 ||
      r.bottom <= 0 ||
      r.right <= 0 ||
      r.top >= innerHeight ||
      r.left >= innerWidth
    )
      return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)
      return false;
    if (el.getAttribute('aria-modal') === 'true') return true;
    const chain = frames(el, 48);
    if (chain.some((f) => f.name.includes('GroupsCometFeatureInterventionDialog'))) return true;
    if (
      chain.some(
        (f) =>
          f.name.includes('CometTopNavListDropdown.react') ||
          f.name.includes('CometMessagingJewelDropdown.react') ||
          f.name.includes('MWV2ChatTabsRoot.react') ||
          f.name.includes('MWV2ChatTabsLayout.react'),
      )
    )
      return false;
    // Edge chat/popovers do not cover the main interaction point. A central
    // dialog must also own the topmost hit, rather than merely have a large box.
    const main = document.querySelector('main,[role="main"]');
    const mr = main?.getBoundingClientRect();
    const x = mr
      ? Math.max(0, mr.left) + (Math.min(innerWidth, mr.right) - Math.max(0, mr.left)) / 2
      : innerWidth / 2;
    const y = mr
      ? Math.max(0, mr.top) + (Math.min(innerHeight, mr.bottom) - Math.max(0, mr.top)) / 2
      : innerHeight / 2;
    const hit = document.elementFromPoint(x, y);
    return r.left <= x && r.right >= x && r.top <= y && r.bottom >= y && !!hit && el.contains(hit);
  };

  const visibleArea = (el: Element) => {
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    if (w <= 0) return 0;
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    if (h <= 0) return 0;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)
      return 0;
    return w * h;
  };
  const mains = Array.from(document.querySelectorAll('main,[role="main"]')).filter(
    (el) => visibleArea(el) > 0,
  );
  const marketplaceSurface =
    /^\/marketplace(?:\/category\/[a-z0-9_-]{1,80}(?:\/search)?|\/(?:(?!(?:inbox|you|create|item|selling|buying|notifications|ineligible|search)(?:\/|$))[a-z0-9_-]{1,80})(?:\/search)?|\/search|\/item\/\d{1,30})?\/?$/i.test(
      location.pathname ?? '',
    );
  const main =
    mains.length === 1
      ? mains[0]
      : marketplaceSurface && mains.length > 1
        ? [...mains].sort((a, b) => visibleArea(b) - visibleArea(a))[0]
        : null;
  const blockingDialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(
    blockingDialog,
  );
  const dialogs = blockingDialogs.length > 0;
  for (const old of Array.from(document.querySelectorAll('[data-wb-browse-dialog-dismiss]')))
    old.removeAttribute('data-wb-browse-dialog-dismiss');
  let dialogDismissCSS: typeof FACEBOOK_BROWSE_DIALOG_DISMISS_CSS | null = null;
  if (dialogs) {
    const canHitDialogBtn = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.top < 4 ||
        rect.bottom > innerHeight - 4 ||
        x < 0 ||
        x >= innerWidth ||
        y < 0 ||
        y >= innerHeight
      )
        return false;
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit && (hit === el || el.contains(hit) || hit.contains(el)));
    };
    const dangerousRe = /删除|刪除|Delete|注销|註銷|Deactivate|退出|登出|Log\s*Out|Sign\s*Out/i;
    const primaryLabelRe = /^(?:关闭|關閉|Close|Dismiss|以后再说|稍后|稍後|Not\s*Now)$/i;
    const secondaryLabelRe =
      /^(?:关闭|關閉|Close|Dismiss|以后再说|稍后|稍後|Not\s*Now|继续|繼續|Continue|知道了|Got\s*it|OK|确定|確定|取消|Cancel)$/i;
    const candidates: { el: Element; priority: number }[] = [];
    for (const dlg of blockingDialogs) {
      for (const btn of Array.from(dlg.querySelectorAll('[role="button"],button')).slice(0, 80)) {
        if (
          btn.getAttribute('aria-disabled') === 'true' ||
          btn.hasAttribute('disabled') ||
          visibleArea(btn) <= 0 ||
          !canHitDialogBtn(btn)
        )
          continue;
        const aria = (btn.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
        if (dangerousRe.test(aria) || dangerousRe.test(text)) continue;
        if (primaryLabelRe.test(aria)) {
          candidates.push({ el: btn, priority: 1 });
        } else if (secondaryLabelRe.test(aria) || secondaryLabelRe.test(text)) {
          candidates.push({ el: btn, priority: 2 });
        }
      }
    }
    candidates.sort((a, b) => a.priority - b.priority);
    const chosen = candidates[0]?.el;
    if (chosen) {
      chosen.setAttribute('data-wb-browse-dialog-dismiss', '1');
      dialogDismissCSS = '[data-wb-browse-dialog-dismiss="1"]';
    }
  }
  const videos = main
    ? Array.from(main.querySelectorAll('video'))
        .slice(0, 100)
        .map((el) => ({ el, area: visibleArea(el) }))
        .filter((v) => v.area > 0)
        .sort((a, b) => b.area - a.area)
    : [];
  const selected = videos[0];
  // Equal-sized visible players are ambiguous; do not start an arbitrary one.
  const video =
    selected && (!videos[1] || selected.area > videos[1].area * 1.1) ? selected.el : null;
  // Do not retain decoder buffers for already-passed feed/Reel media. The current
  // player and visible previews are untouched; keeping the DOM preserves React ownership.
  if (homeSurface || reelSurface) {
    for (const otherVid of Array.from(document.querySelectorAll('video'))) {
      if (otherVid === video) continue;
      const otherRect = otherVid.getBoundingClientRect();
      const visibleH = Math.max(
        0,
        Math.min(otherRect.bottom, innerHeight) - Math.max(otherRect.top, 0),
      );
      const passedAbove =
        otherRect.bottom < 80 ||
        ((otherRect.width === 0 || otherRect.height === 0) && otherRect.top <= 0);
      if (visibleArea(otherVid) > 0 && visibleH >= 120 && !passedAbove) continue;
      otherVid.preload = 'none';
      try {
        if (!otherVid.paused) otherVid.pause();
      } catch {
        /* Detached/unsupported player. */
      }
      if (passedAbove && otherVid.getAttribute('data-wb-buffer-freed') !== '1') {
        try {
          otherVid.pause();
          if (otherVid.srcObject) otherVid.srcObject = null;
          if (otherVid.hasAttribute('src')) otherVid.removeAttribute('src');
          otherVid.load();
          otherVid.setAttribute('data-wb-buffer-freed', '1');
        } catch {
          /* Media teardown must not interrupt reading the active player. */
        }
      }
    }
  }
  const cssPath = (el: Element) => {
    if (el.tagName === 'VIDEO' && document.querySelectorAll('video').length === 1) return 'video';
    const src = el.getAttribute('src');
    if (el.tagName === 'VIDEO' && src) {
      const css = 'video[src=' + JSON.stringify(src) + ']';
      if (css.length <= 300 && document.querySelectorAll(css).length === 1) return css;
    }
    const parts: string[] = [];
    for (let node: Element | null = el; node && parts.length < 32; node = node.parentElement) {
      const index = node.parentElement
        ? Array.from(node.parentElement.children).indexOf(node) + 1
        : 1;
      parts.unshift(node.tagName.toLowerCase() + ':nth-child(' + index + ')');
      if (parts.length > 2 && node.parentElement && node.parentElement !== main) continue;
      const css = parts.join('>');
      if (css.length > 300) return null;
      const matches = document.querySelectorAll(css);
      if (matches.length === 1 && matches[0] === el) return css;
    }
    return null;
  };
  const feedText = (value: string) =>
    value
      .replace(/\b\d{1,2}:\d{2}(?:\s*\/\s*\d{1,2}:\d{2})?/g, '[media-time]')
      .trim()
      .slice(0, 512);
  const article =
    main && homeSurface
      ? Array.from(main.querySelectorAll('[role="article"]'))
          .slice(0, 100)
          .map((el) => ({
            el,
            area: visibleArea(el),
            key:
              el
                .querySelector('a[href*="/posts/"],a[href*="story_fbid="]')
                ?.getAttribute('href')
                ?.replace(/[?&]__cft__.*$/, '') ||
              feedText(el.textContent ?? '') ||
              null,
          }))
          .filter((row) => row.area > 0 && row.key && row.el.getAttribute('aria-busy') !== 'true')
          .sort((a, b) => b.area - a.area)[0]
      : null;
  // Observed Facebook posts may have no article role. Require a single native
  // author boundary, post-action markers (some posts disable sharing and have no share_button),
  // and visible loaded body content.
  const structuralPosts: {
    area: number;
    key: string;
    element: Element;
    root: Element;
    imageCount: number;
    textLength: number;
    videoDuration: number | null;
    hasInlineVideo: boolean;
  }[] = [];
  for (const profile of Array.from(
    homeSurface ? (main?.querySelectorAll('[data-ad-rendering-role="profile_name"]') ?? []) : [],
  ).slice(0, 40)) {
    let root = profile.parentElement;
    for (let depth = 0; root && root !== main && depth < 24; depth++, root = root.parentElement) {
      if (root.querySelectorAll('[data-ad-rendering-role="profile_name"]').length !== 1) break;
      if (root.getAttribute('aria-busy') === 'true') break;
      if (
        !root.querySelector(
          '[data-ad-rendering-role="like_button"],[data-ad-rendering-role="comment_button"],[data-ad-rendering-role="share_button"]',
        )
      )
        continue;
      const bodies = Array.from(
        root.querySelectorAll(
          '[data-ad-rendering-role="story_message"],[data-ad-preview="message"]',
        ),
      )
        .map((el) => ({ element: el, area: visibleArea(el), key: feedText(el.textContent ?? '') }))
        .filter((row) => row.area > 0 && row.key);
      const pictures = Array.from(root.querySelectorAll('img'))
        .slice(0, 40)
        .filter((el) => el.complete && el.naturalWidth > 0)
        .map((el) => ({
          element: el,
          area: visibleArea(el),
          key: (el.closest('a[href]')?.getAttribute('href') || el.currentSrc).slice(0, 1000),
        }))
        .filter((row) => row.area >= 10000 && row.key);
      const inlineVideos =
        location.pathname === '/'
          ? Array.from(root.querySelectorAll('video'))
              .slice(0, 40)
              .map((el, index) => ({ el, index }))
              .filter(
                ({ el }) =>
                  el.readyState >= 2 &&
                  el.videoWidth > 0 &&
                  el.videoHeight > 0 &&
                  el.error === null,
              )
              .map(({ el, index }) => ({
                element: el,
                videoEl: el,
                area: visibleArea(el),
                key:
                  'video:' +
                  (el.currentSrc || el.getAttribute('src') || 'decoded:' + index).slice(0, 1000),
              }))
              .filter((row) => row.area >= 10000)
          : [];
      const content = [...bodies, ...pictures, ...inlineVideos].sort((a, b) => b.area - a.area)[0];
      if (content) {
        const inlineVid = inlineVideos[0]?.videoEl;
        const vidDur =
          inlineVid && Number.isFinite(inlineVid.duration) && inlineVid.duration > 0
            ? inlineVid.duration
            : null;
        structuralPosts.push({
          area: content.area,
          key: 'post:' + feedText(profile.textContent ?? '') + '|' + content.key,
          element: content.element,
          root,
          imageCount: pictures.length,
          textLength: bodies.reduce((sum, b) => sum + b.key.length, 0),
          videoDuration: vidDur,
          hasInlineVideo: inlineVideos.length > 0,
        });
      }
      break;
    }
  }
  const orderedPosts = [...structuralPosts].sort(
    (a, b) => a.root.getBoundingClientRect().top - b.root.getBoundingClientRect().top,
  );
  const structuralPost = [...structuralPosts].sort((a, b) => b.area - a.area)[0];
  // Worker-backed MSE uses srcObject rather than a URL. On an exact Reel route,
  // its native content ID scopes the one visible player; it is not playback evidence.
  // Actual decoded/advancing media time remains necessary for effective progress.
  const reel = /^https:\/\/www\.facebook\.com\/reel\/\d{1,30}\/?(?:[?#].*)?$/.test(location.href)
    ? new URL(location.href).origin + new URL(location.href).pathname.replace(/\/$/, '')
    : '';
  const source =
    video?.currentSrc ||
    video?.getAttribute('src') ||
    (video?.srcObject && reel ? 'srcObject:' + reel : '');
  const entries = new Map<string, number>();
  for (const link of Array.from(
    reelSurface && !reel ? (main?.querySelectorAll('a[href]') ?? []) : [],
  ).slice(0, 500)) {
    const href = (link as HTMLAnchorElement).href,
      area = visibleArea(link);
    if (
      /^https:\/\/www\.facebook\.com\/reel\/\d{1,30}\/?(?:[?#].*)?$/.test(href) &&
      href.length <= 2048 &&
      area > 0
    )
      entries.set(href, Math.max(entries.get(href) ?? 0, area));
  }
  const candidates = [...entries].sort((a, b) => b[1] - a[1]);
  const videoEntry =
    candidates[0] && (!candidates[1] || candidates[0][1] > candidates[1][1] * 1.1)
      ? candidates[0][0]
      : null;
  const centerHit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  const feedScrollCandidates = main ? new Set<Element>([main]) : new Set<Element>();
  if (main && centerHit && main.contains(centerHit)) {
    let element: Element | null = centerHit;
    for (
      let depth = 0;
      element && element !== main && depth < 24;
      depth++, element = element.parentElement
    )
      feedScrollCandidates.add(element);
  }
  const scrolling = main
    ? (homeSurface || reelSurface
        ? [...feedScrollCandidates]
        : [...new Set([...feedScrollCandidates, ...Array.from(main.children ?? [])])]
      ).filter((el) => {
        if (el.scrollHeight <= el.clientHeight + 20 || visibleArea(el) <= 0) return false;
        const style = getComputedStyle(el);
        return /auto|scroll/.test(style.overflowY);
      })
    : [];
  const canHitCenter = (el: Element, rect = el.getBoundingClientRect()) => {
    const x = Math.round(rect.left + rect.width / 2),
      y = Math.round(rect.top + rect.height / 2);
    if (
      rect.top < 60 ||
      rect.bottom > innerHeight - 16 ||
      x < 0 ||
      x >= innerWidth ||
      y < 0 ||
      y >= innerHeight
    )
      return false;
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit && (hit === el || el.contains(hit)));
  };
  const nextReelCSS = '[data-wb-reel-next="1"]';
  for (const el of Array.from(document.querySelectorAll('[data-wb-reel-next]')))
    el.removeAttribute('data-wb-reel-next');
  const nextRoute =
    /^\/(?:reels|watch)\/?$/.test(location.pathname) ||
    /^\/reel\/\d{1,30}\/?$/.test(location.pathname) ||
    (location.pathname === '/reel/' && location.search === '?s=tab');
  const nextCandidates = Array.from(
    nextRoute ? (main?.querySelectorAll('[role="button"],button') ?? []) : [],
  ).filter(
    (el) =>
      visibleArea(el) > 0 &&
      frames(el, 20).some(
        (f) =>
          f.name.includes('FBUnifiedVideoNavigationButton.react') &&
          f.props.direction === 'next-card',
      ),
  );
  // Retain only previously observed labels as a legacy fallback.
  const nextButtons = nextCandidates.length
    ? nextCandidates.filter(
        (el) =>
          !frames(el, 20).some(
            (f) =>
              f.name.includes('FBUnifiedVideoNavigationButton.react') && f.props.disabled === true,
          ),
      )
    : Array.from(
        nextRoute
          ? (main?.querySelectorAll(
              '[role="button"]:is([aria-label="Next Card"],[aria-label="下一条快拍"])',
            ) ?? [])
          : [],
      );
  const nextButton = nextButtons.length === 1 ? nextButtons[0] : undefined;
  if (
    nextButton &&
    nextButton.getAttribute('aria-disabled') !== 'true' &&
    !nextButton.hasAttribute('disabled') &&
    canHitCenter(nextButton)
  )
    nextButton.setAttribute('data-wb-reel-next', '1');
  const friendsRoute = /^\/friends(?:\/requests)?\/?$/.test(location.pathname);
  const friendRequestsRoute = /^\/friends\/requests\/?$/.test(location.pathname);
  for (const old of Array.from(document.querySelectorAll('[data-wb-friend-confirm]')))
    old.removeAttribute('data-wb-friend-confirm');
  const friendNav = friendRequestsRoute
    ? (Array.from(document.querySelectorAll('[role="navigation"],main,[role="main"]')).find(
        (el) =>
          visibleArea(el) > 0 &&
          (frames(el).some((f) => f.name.includes('FriendingComet')) ||
            Array.from(el.querySelectorAll('[role="button"],button')).some((b) =>
              frames(b).some((f) => f.name.includes('FriendingCometListItemWithButtons.react')),
            )),
      ) ?? main)
    : null;
  const friendScroller =
    friendRequestsRoute && friendNav
      ? [friendNav, ...Array.from(friendNav.querySelectorAll('div')).slice(0, 240)].find((el) => {
          if (el.scrollHeight <= el.clientHeight + 20 || visibleArea(el) <= 0) return false;
          const style = getComputedStyle(el);
          return /auto|scroll/.test(style.overflowY);
        })
      : undefined;
  const confirmLabels = new Set(['confirm', '确认', '確認']);
  const friendConfirmButtons =
    friendRequestsRoute && friendNav
      ? Array.from(friendNav.querySelectorAll('[role="button"], button')).filter((el) => {
          if (
            el.getAttribute('aria-disabled') === 'true' ||
            el.hasAttribute('disabled') ||
            visibleArea(el) <= 0
          )
            return false;
          const chain = frames(el);
          const button = chain.find((f) => f.name.includes('FDSButton.react'));
          const row = chain.find((f) => f.name.includes('FriendingCometListItemWithButtons.react'));
          const group = chain.find((f) => f.name.includes('FDSButtonGroup.react'));
          if (button || row) {
            return (
              button?.props.type === 'primary' &&
              !!row &&
              record(row.props.user) &&
              row.props.user.friendship_status === 'INCOMING_REQUEST' &&
              ((record(group?.props.primary) && group.props.primary.testid === 'confirm_button') ||
                (record(group?.props.secondary) && group.props.secondary.type === 'secondary'))
            );
          }
          const label = (el.getAttribute('aria-label') || el.textContent || '')
            .trim()
            .toLowerCase();
          return confirmLabels.has(label);
        })
      : [];
  const firstConfirmButton = friendConfirmButtons[0];
  let friendConfirmCSS: typeof FACEBOOK_FRIEND_CONFIRM_CSS | null = null;
  let friendKey: string | null = null;
  if (friendRequestsRoute && friendNav) {
    if (firstConfirmButton) {
      const btnRect = firstConfirmButton.getBoundingClientRect();
      if (btnRect.top < 72 || btnRect.bottom > innerHeight - 24) {
        firstConfirmButton.scrollIntoView({ block: 'center' });
      }
      if (canHitCenter(firstConfirmButton)) {
        firstConfirmButton.setAttribute('data-wb-friend-confirm', '1');
        friendConfirmCSS = '[data-wb-friend-confirm="1"]';
      }
      let card: Element | null = firstConfirmButton.parentElement;
      let href = '';
      for (let d = 0; card && card !== friendNav && d < 8; d++, card = card.parentElement) {
        const link = card.querySelector('a[href]');
        if (link) {
          href = link.getAttribute('href') || '';
          break;
        }
      }
      const requestRow = frames(firstConfirmButton).find((f) =>
        f.name.includes('FriendingCometListItemWithButtons.react'),
      );
      const user = requestRow?.props.user;
      const cardSig =
        (record(user) && typeof user.id === 'string' ? user.id : href) ||
        feedText(firstConfirmButton.parentElement?.parentElement?.textContent ?? '');
      friendKey = 'friend-req:' + cardSig.slice(0, 300) + '|pending:' + friendConfirmButtons.length;
    } else if (
      friendScroller &&
      friendScroller.scrollTop + friendScroller.clientHeight < friendScroller.scrollHeight - 20
    ) {
      friendScroller.scrollTop += Math.max(160, Math.round(friendScroller.clientHeight * 0.75));
      friendKey = 'friend-scrolling:' + Math.round(friendScroller.scrollTop);
    } else {
      friendKey = 'FRIENDS_REQUESTS_EXHAUSTED';
    }
  }
  const marketplace =
    /^\/marketplace(?:\/category\/[a-z0-9_-]{1,80}(?:\/search)?|\/(?:(?!(?:inbox|you|create|item|selling|buying|notifications|ineligible|search)(?:\/|$))[a-z0-9_-]{1,80})(?:\/search)?|\/search)?\/?$/i.test(
      location.pathname,
    );
  // Category links may be below the fold in the sidebar. Read only their native URLs,
  // never other sidebar text, messages or hidden application stores.
  const marketplaceCategories = marketplace
    ? [
        ...new Set(
          Array.from(document.querySelectorAll('a[href*="category_id="]'))
            .slice(0, 200)
            .map((el) => (el as HTMLAnchorElement).href)
            .filter((href) => {
              if (href.length > 2048) return false;
              const url = new URL(href);
              return (
                url.origin === 'https://www.facebook.com' &&
                /^\/marketplace\/(?:category\/[a-z0-9_-]{1,80}\/|(?:(?!(?:inbox|you|create|item|selling|buying|notifications|ineligible|search)\/)[a-z0-9_-]{1,80}\/))?search\/?$/i.test(
                  url.pathname,
                ) &&
                url.searchParams.getAll('category_id').length === 1 &&
                /^\d{1,30}$/.test(url.searchParams.get('category_id') ?? '') &&
                url.searchParams.getAll('query').length <= 1
              );
            }),
        ),
      ].slice(0, 32)
    : [];
  const items = marketplace
    ? Array.from(main?.querySelectorAll('a[href]') ?? [])
        .slice(0, 1000)
        .filter((el) => {
          const href = (el as HTMLAnchorElement).href;
          if (
            !/^https:\/\/www\.facebook\.com\/marketplace\/item\/\d{1,30}\/?(?:[?#].*)?$/.test(href)
          )
            return false;
          return (
            visibleArea(el) > 0 ||
            (el.firstElementChild ? visibleArea(el.firstElementChild) > 0 : false) ||
            (el.parentElement ? visibleArea(el.parentElement) > 0 : false)
          );
        })
        .map((el) => new URL((el as HTMLAnchorElement).href).pathname)
    : [];
  const marketplaceKey = [...new Set(items)].slice(0, 8).join('|') || null;
  const itemRoute = /^\/marketplace\/item\/\d{1,30}\/?$/.test(location.pathname);
  // A numeric route alone is not loaded product content. Require visible title/heading text and
  // visible product media or action buttons before crediting a detail dwell.
  const detailRoot = main ?? document.body;
  const hasDetailText =
    itemRoute &&
    !!main &&
    (Array.from(detailRoot.querySelectorAll('h1,h2,h3,[role="heading"],span[dir="auto"]'))
      .slice(0, 120)
      .some((el) => visibleArea(el) > 0 && (el.textContent?.trim().length ?? 0) >= 2) ||
      (main.textContent?.replace(/\s+/g, ' ').trim().length ?? 0) >= 20);
  const hasDetailMediaOrAction =
    itemRoute &&
    !!main &&
    (Array.from(detailRoot.querySelectorAll('img,video,svg image'))
      .slice(0, 120)
      .some((el) => {
        if (el instanceof HTMLImageElement) {
          return el.complete && el.naturalWidth > 0 && visibleArea(el) >= 2500;
        }
        return visibleArea(el) >= 2500;
      }) ||
      Array.from(detailRoot.querySelectorAll('[role="button"],a[href*="/marketplace/"]'))
        .slice(0, 80)
        .some((el) => visibleArea(el) > 0));
  const detailLoaded = itemRoute && !!main && hasDetailText && hasDetailMediaOrAction;
  // Only a visible native empty-state heading, never arbitrary body/product text.
  const noAccessRoute = /^\/marketplace\/ineligible\/?$/.test(location.pathname);
  const marketRoot = main ?? (noAccessRoute ? document.body : null);
  const checkMarketUnavailable =
    (marketplace || itemRoute || noAccessRoute) &&
    !!marketRoot &&
    !dialogs &&
    document.readyState !== 'loading' &&
    !detailLoaded &&
    items.length === 0 &&
    !Array.from(marketRoot.querySelectorAll('a[href]'))
      .slice(0, 1000)
      .some(
        (el) =>
          visibleArea(el) > 0 &&
          /^https:\/\/www\.facebook\.com\/marketplace\/item\/\d{1,30}\/?(?:[?#].*)?$/.test(
            (el as HTMLAnchorElement).href,
          ),
      );
  const nativeNoAccess =
    checkMarketUnavailable &&
    !!marketRoot &&
    Array.from(marketRoot.querySelectorAll('div,span,svg'))
      .slice(0, 1000)
      .some(
        (el) =>
          visibleArea(el) > 0 &&
          frames(el).some(
            (f) =>
              f.name.includes('CometMarketplaceNoAccessContent.react') ||
              f.name.includes('CometMarketplaceNoAccessContentContainer.react'),
          ),
      );
  const marketplaceUnavailable =
    checkMarketUnavailable &&
    !!marketRoot &&
    (nativeNoAccess ||
      Array.from(marketRoot.querySelectorAll('h1,h2,[role="heading"]'))
        .slice(0, 40)
        .some(
          (el) =>
            visibleArea(el) > 0 &&
            !el.closest('article,[role="article"],a') &&
            /^(?:Marketplace isn['’]t available to you|You can['’]t use Marketplace right now|(?:你目前|您目前|你现在|您现在)?(?:无法|無法)使用\s*Marketplace)[.!。！]?$/i.test(
              (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
            ),
        ));
  const anchor = source && video ? video : (structuralPost?.element ?? article?.el);
  const rect = location.pathname === '/' ? anchor?.getBoundingClientRect() : undefined;
  const contentPosition =
    rect && rect.right > rect.left && rect.bottom > rect.top
      ? {
          left: rect.left,
          top: rect.top,
          width: rect.right - rect.left,
          height: rect.bottom - rect.top,
          viewportHeight: innerHeight,
        }
      : null;
  const currentScrollY = Math.max(0, scrollY, ...scrolling.map((el) => el.scrollTop));
  const currentScrollMaxY = Math.max(
    0,
    (document.scrollingElement?.scrollHeight ?? 0) -
      (document.scrollingElement?.clientHeight ?? innerHeight),
    ...scrolling.map((el) => el.scrollHeight - el.clientHeight),
  );
  const videoDurationSeconds =
    video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
  let recommendedDwellMs: number | undefined;
  let nextScrollDeltaY: number | undefined;
  if (friendRequestsRoute) {
    recommendedDwellMs = Math.round(1450 + Math.random() * 1850);
  } else if (marketplace || itemRoute) {
    recommendedDwellMs = itemRoute
      ? Math.round(2400 + Math.random() * 1800)
      : Math.round(2200 + Math.random() * 1600);
    nextScrollDeltaY = Math.round(380 + Math.random() * 280);
  } else if (reelSurface && video) {
    const roll = Math.random();
    if (videoDurationSeconds) {
      if (roll < 0.48) {
        const ratio =
          videoDurationSeconds <= 18 ? 0.92 + Math.random() * 0.33 : 0.78 + Math.random() * 0.27;
        recommendedDwellMs = Math.max(
          5500,
          Math.min(
            26500,
            Math.round(videoDurationSeconds * 1000 * ratio + (Math.random() - 0.3) * 1400),
          ),
        );
      } else if (roll < 0.82) {
        const ratio = 0.48 + Math.random() * 0.34;
        recommendedDwellMs = Math.max(
          4500,
          Math.min(
            19500,
            Math.round(videoDurationSeconds * 1000 * ratio + (Math.random() - 0.5) * 1200),
          ),
        );
      } else {
        recommendedDwellMs = Math.round(3200 + Math.random() * 2600);
      }
    } else {
      recommendedDwellMs =
        roll < 0.75
          ? Math.round(7500 + Math.random() * 9500)
          : Math.round(3800 + Math.random() * 2400);
    }
  } else if (location.pathname === '/') {
    if (structuralPost) {
      if (structuralPost.hasInlineVideo || (source && video)) {
        const dur = structuralPost.videoDuration ?? videoDurationSeconds;
        recommendedDwellMs = dur
          ? dur <= 22
            ? Math.max(3000, Math.min(7500, Math.round(dur * 1000 * (0.4 + Math.random() * 0.25))))
            : Math.round(3500 + Math.random() * 3800)
          : Math.round(3200 + Math.random() * 3500);
      } else if (structuralPost.imageCount > 0) {
        recommendedDwellMs = Math.max(
          2200,
          Math.min(
            5200,
            Math.round(
              2100 +
                Math.min(3, structuralPost.imageCount) * 550 +
                Math.min(1200, Math.floor(structuralPost.textLength / 100) * 240) +
                Math.random() * 1300,
            ),
          ),
        );
      } else {
        recommendedDwellMs = Math.max(
          1900,
          Math.min(
            4200,
            Math.round(
              1800 +
                Math.min(1300, Math.floor(structuralPost.textLength / 90) * 240) +
                Math.random() * 1100,
            ),
          ),
        );
      }
    } else if (article) {
      recommendedDwellMs = Math.round(2200 + Math.random() * 1800);
    } else {
      recommendedDwellMs = 2000;
    }
    const targetCenterY = 56 + (innerHeight - 56) * 0.5;
    const anchorRect = anchor?.getBoundingClientRect();
    const anchorCenterY = anchorRect ? anchorRect.top + anchorRect.height * 0.5 : 0;
    let computedDelta: number | null = null;
    if (
      anchorRect &&
      anchorRect.bottom > innerHeight * 0.82 &&
      anchorCenterY > targetCenterY + 115
    ) {
      computedDelta = Math.round(anchorCenterY - targetCenterY + (Math.random() - 0.5) * 36);
    } else {
      const currentTop = structuralPost?.root.getBoundingClientRect().top ?? anchorRect?.top ?? 56;
      const nextPost = orderedPosts.find((candidate) => {
        const r = candidate.root.getBoundingClientRect();
        const focal = candidate.element.getBoundingClientRect();
        const center = focal.height > 0 ? focal.top + focal.height * 0.5 : r.top + r.height * 0.45;
        return r.top > currentTop + 72 && center > targetCenterY + 90;
      });
      if (nextPost) {
        const focalRect = nextPost.element.getBoundingClientRect();
        const rootRect = nextPost.root.getBoundingClientRect();
        const focalCenterY =
          focalRect.height > 60 && focalRect.height <= (innerHeight - 56) * 0.92
            ? focalRect.top + focalRect.height * 0.5
            : rootRect.top + Math.min(rootRect.height * 0.45, (innerHeight - 56) * 0.44);
        computedDelta = Math.round(focalCenterY - targetCenterY + (Math.random() - 0.5) * 44);
      }
    }
    if (computedDelta === null || currentScrollMaxY - currentScrollY <= innerHeight * 1.15) {
      computedDelta = Math.max(
        computedDelta ?? 0,
        Math.round(
          Math.max(
            currentScrollMaxY - currentScrollY + 220,
            innerHeight * (0.68 + Math.random() * 0.2),
          ),
        ),
      );
    }
    nextScrollDeltaY = Math.max(140, Math.min(1080, computedDelta));
  }
  for (const old of Array.from(document.querySelectorAll('[data-wb-browse-like]')))
    old.removeAttribute('data-wb-browse-like');
  const likeScopeRoot =
    location.pathname === '/'
      ? (structuralPost?.root ?? article?.el ?? null)
      : reelSurface && video
        ? main
        : null;
  let likeTarget: {
    css: typeof FACEBOOK_BROWSE_LIKE_CSS | null;
    liked: boolean;
    likeCount: number;
    sponsored: boolean;
    text: string;
  } | null = null;
  const isReactionSelected = (props: DOMRecord | undefined) =>
    props?.selected === true ||
    props?.isSelected === true ||
    props?.pressed === true ||
    props?.isReacted === true ||
    props?.active === true;
  const reactionFrames = (el: Element) =>
    frames(el).filter((f) => f.name.includes('CometUFIReactButtonBase.react'));
  const reactionFrame = (el: Element) => {
    const matching = reactionFrames(el);
    return matching.find((f) => isReactionSelected(f.props)) ?? matching[0];
  };
  const reactionIcons = (el: Element) =>
    Array.from(el.querySelectorAll('svg,img,[data-visualcompletion="css-img"]'))
      .flatMap((icon) => frames(icon, 28))
      .filter(
        (f) =>
          /^FBNucleus.*Like.*Icon\.react$/i.test(f.name) ||
          /(?:^|\b)Like(?:Filled|Active)?Icon/i.test(f.name) ||
          f.name === 'CometReactionIcon.react',
      );
  const feedbackEvidence = (el: Element) => {
    const chain = frames(el, 100),
      feedback = reactionFrame(el)?.props.feedback;
    if (!record(feedback) || typeof feedback.__id !== 'string') return null;
    for (const f of chain) {
      const value = f.props.value;
      const env =
        record(value) && record(value.environment) ? value.environment : f.props.environment;
      if (!record(env) || typeof env.getStore !== 'function') continue;
      try {
        const store = Reflect.apply(env.getStore, env, []);
        const source =
          record(store) && typeof store.getSource === 'function'
            ? Reflect.apply(store.getSource, store, [])
            : null;
        if (!record(source) || typeof source.get !== 'function') continue;
        const data: unknown = Reflect.apply(source.get, source, [feedback.__id]);
        if (!record(data)) continue;
        const props = reactionFrame(el)?.props;
        const liked =
          Object.keys(data).some((key) => {
            if (
              key !== 'viewer_feedback_reaction_info' &&
              !key.startsWith('viewer_feedback_reaction_info(')
            )
              return false;
            const info = data[key];
            if (info === null || info === undefined) return false;
            if (record(info) && 'reaction_type' in info) {
              return info.reaction_type !== 0 && info.reaction_type !== null;
            }
            return true;
          }) ||
          (data.viewer_reaction !== undefined &&
            data.viewer_reaction !== null &&
            data.viewer_reaction !== 0) ||
          data.is_viewer_reacted === true ||
          isReactionSelected(props);
        const connection = data.reactors;
        const reactors: unknown =
          record(connection) && typeof connection.__ref === 'string'
            ? Reflect.apply(source.get, source, [connection.__ref])
            : null;
        const count =
          record(reactors) &&
          typeof reactors.count === 'number' &&
          Number.isSafeInteger(reactors.count) &&
          reactors.count >= 0
            ? reactors.count
            : undefined;
        return { liked, count };
      } catch {
        /* Fall back to native DOM state when this exact local record is unavailable. */
      }
    }
    return null;
  };
  if (likeScopeRoot) {
    const matchesLikeLabel = (el: Element) => {
      if (visibleArea(el) <= 0) return false;
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
      if (/comment|share|send|评论|評論|分享|发送|發送/i.test(label)) return false;
      return /^(?:like|liked|remove\s+like|unlike|love|care|haha|wow|sad|angry|赞|讚|取消赞|取消讚|已赞|已讚|大爱|大心|关心|加油|哈哈|哇|心碎|怒)(?:$|[\s·•:：0-9])/i.test(
        label,
      );
    };
    const sharesCard = (el: Element) => {
      if (!video) return false;
      for (
        let parent = video.parentElement;
        parent && parent !== main;
        parent = parent.parentElement
      ) {
        if (
          Array.from(parent.querySelectorAll('video')).filter((v) => visibleArea(v) > 0).length > 1
        )
          break;
        if (parent.contains(el)) return true;
      }
      return false;
    };
    const distanceToVideo = (el: Element) => {
      if (!video) return 0;
      const vr = video.getBoundingClientRect();
      const r = el.getBoundingClientRect(),
        y = r.top + r.height / 2;
      return (
        Math.max(vr.top - y, y - vr.bottom, 0) * 10000 + Math.abs(y - (vr.top + vr.bottom) / 2)
      );
    };
    const adLike = likeScopeRoot.querySelector('[data-ad-rendering-role="like_button"]');
    let likeBtn: Element | null = adLike
      ? (adLike.closest('[role="button"],button') ?? adLike)
      : null;
    if (!likeBtn && reelSurface) {
      const rawCandidates = Array.from(
        likeScopeRoot.querySelectorAll('[role="button"],button'),
      ).filter(
        (el) =>
          visibleArea(el) > 0 &&
          !el.closest(
            '[role="article"], [aria-label*="comment" i], [aria-label*="评论"], [aria-label*="評論"], [role="dialog"]',
          ) &&
          !!reactionFrame(el) &&
          (reactionIcons(el).length > 0 || !!el.querySelector('svg')),
      );
      const candidates = rawCandidates.filter(
        (el) => !rawCandidates.some((other) => other !== el && el.contains(other)),
      );
      if (candidates.length > 1) {
        candidates.sort(
          (a, b) =>
            Number(sharesCard(b)) - Number(sharesCard(a)) ||
            Number(matchesLikeLabel(b)) - Number(matchesLikeLabel(a)) ||
            distanceToVideo(a) - distanceToVideo(b),
        );
      }
      likeBtn = candidates[0] ?? null;
    }
    if (!likeBtn) {
      const rawLabelCandidates = Array.from(
        likeScopeRoot.querySelectorAll('[role="button"],button'),
      )
        .slice(0, 400)
        .filter(
          (el) =>
            matchesLikeLabel(el) &&
            (!reelSurface ||
              !el.closest(
                '[role="article"], [aria-label*="comment" i], [aria-label*="评论"], [aria-label*="評論"], [role="dialog"]',
              )),
        );
      const labelCandidates = rawLabelCandidates.filter(
        (el) => !rawLabelCandidates.some((other) => other !== el && el.contains(other)),
      );
      if (reelSurface && video && labelCandidates.length > 1) {
        labelCandidates.sort(
          (a, b) =>
            Number(sharesCard(b)) - Number(sharesCard(a)) ||
            distanceToVideo(a) - distanceToVideo(b),
        );
      }
      likeBtn = labelCandidates[0] ?? rawLabelCandidates[0] ?? null;
    }
    if (likeBtn) {
      const ariaPressed =
        likeBtn.getAttribute('aria-pressed') === 'true' ||
        likeBtn.querySelector('[aria-pressed="true"]') !== null;
      const btnLabel = (likeBtn.getAttribute('aria-label') || likeBtn.textContent || '').trim();
      const labelLiked =
        /^(?:remove\s+|取消|收回)?(?:unlike|remove\s+like|liked|love|care|haha|wow|sad|angry|取消赞|取消讚|已赞|已讚|大爱|大心|关心|加油|哈哈|哇|心碎|怒)(?:$|[\s·•:：0-9])/i.test(
          btnLabel,
        ) || /unlike|remove\s+like|\bliked\b|取消赞|取消讚|已赞|已讚/i.test(btnLabel);
      const colorProbe = adLike ?? likeBtn;
      const colorNodes = [
        colorProbe,
        ...Array.from(colorProbe.querySelectorAll('svg,path,g,span,i')).slice(0, 16),
      ];
      const colorLiked = colorNodes.some((node) => {
        if (!node) return false;
        const style = getComputedStyle(node);
        const candidates = [
          style.color,
          style.fill,
          style.stroke,
          node.getAttribute('fill') ?? '',
          node.getAttribute('stroke') ?? '',
          node.getAttribute('color') ?? '',
        ];
        return candidates.some((color) => {
          const val = (color || '').trim().toLowerCase();
          if (!val || val === 'none' || val === 'currentcolor' || val === 'transparent')
            return false;
          if (
            val.includes('#0866ff') ||
            val.includes('#1877f2') ||
            val.includes('#2078f4') ||
            val.includes('var(--accent)') ||
            val.includes('var(--primary-button-background)')
          )
            return true;
          const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(val);
          if (!rgbMatch) return false;
          const r = Number(rgbMatch[1]),
            g = Number(rgbMatch[2]),
            b = Number(rgbMatch[3]);
          return (b > 180 && b > r + 40) || Math.max(r, g, b) - Math.min(r, g, b) >= 45;
        });
      });
      const nativeFeedback = feedbackEvidence(likeBtn);
      const filledIcon = reactionIcons(likeBtn).some(
        (f) =>
          /^FBNucleus.*Like(?:Filled|Active).*Icon\.react$/i.test(f.name) ||
          /(?:^|\b)Like(?:Filled|Active)Icon/i.test(f.name) ||
          f.name === 'CometReactionIcon.react',
      );
      const reactionSelected = reactionFrames(likeBtn).some((f) => isReactionSelected(f.props));
      const domLiked = ariaPressed || labelLiked || colorLiked || reactionSelected;
      const liked = filledIcon || nativeFeedback?.liked === true || domLiked;
      let likeCSS: typeof FACEBOOK_BROWSE_LIKE_CSS | null = null;
      if (
        likeBtn.getAttribute('aria-disabled') !== 'true' &&
        !likeBtn.hasAttribute('disabled') &&
        visibleArea(likeBtn) > 0
      ) {
        const br = likeBtn.getBoundingClientRect();
        if (
          br.top >= 60 &&
          br.bottom <= innerHeight - 16 &&
          br.left >= 0 &&
          br.right <= innerWidth &&
          canHitCenter(likeBtn, br)
        ) {
          likeBtn.setAttribute('data-wb-browse-like', '1');
          likeCSS = '[data-wb-browse-like="1"]';
        }
      }
      const parseCompactCount = (raw: string): number | null => {
        const match =
          /(?:^|[^\d.])(\d+(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kKmM万萬亿億])?(?=$|[^\dA-Za-z])/.exec(
            raw.trim(),
          );
        if (!match || !match[1]) return null;
        const num = Number(match[1].replace(/,/g, ''));
        if (!Number.isFinite(num) || num < 0) return null;
        const unit = (match[2] ?? '').toLowerCase();
        const mult =
          unit === 'k'
            ? 1_000
            : unit === 'm'
              ? 1_000_000
              : unit === '万' || unit === '萬'
                ? 10_000
                : unit === '亿' || unit === '億'
                  ? 100_000_000
                  : 1;
        return Math.round(num * mult);
      };
      let likeCount = 0;
      const reelNearbyCandidates: string[] = [];
      if (reelSurface) {
        const btnRect = likeBtn.getBoundingClientRect();
        if (likeBtn.parentElement)
          reelNearbyCandidates.push(likeBtn.parentElement.textContent ?? '');
        let actionCol: Element | null = likeBtn.parentElement;
        for (
          let d = 0;
          actionCol && actionCol !== main && d < 3;
          d++, actionCol = actionCol.parentElement
        ) {
          for (const node of Array.from(actionCol.querySelectorAll('span,div')).slice(0, 24)) {
            const nr = node.getBoundingClientRect();
            if (Math.abs(nr.top - btnRect.top) < 64 && Math.abs(nr.left - btnRect.left) < 80) {
              reelNearbyCandidates.push(
                node.getAttribute('aria-label') || '',
                node.textContent || '',
              );
            }
          }
        }
      }
      const candidates = [
        btnLabel,
        likeBtn.textContent ?? '',
        ...(reelSurface
          ? reelNearbyCandidates
          : Array.from(
              likeScopeRoot.querySelectorAll(
                '[aria-label*="like" i],[aria-label*="reaction" i],[aria-label*="赞"],[aria-label*="讚"],[aria-label*="心情"],[role="toolbar"]',
              ),
            )
              .slice(0, 30)
              .flatMap((el) => [el.getAttribute('aria-label') || '', el.textContent || ''])),
      ];
      for (const candidate of candidates) {
        if (!candidate || /comment|share|评论|評論|分享|views|次播放/i.test(candidate)) continue;
        const parsed = parseCompactCount(candidate);
        if (parsed !== null && parsed > 0) {
          likeCount = parsed;
          break;
        }
      }
      if (nativeFeedback?.count !== undefined) likeCount = nativeFeedback.count;
      const sponsored =
        likeScopeRoot.querySelector(
          'a[href*="/ads/about"],a[aria-label*="Sponsored" i],a[aria-label*="赞助"],a[aria-label*="贊助"],a[aria-label*="广告"],a[aria-label*="廣告"]',
        ) !== null ||
        Array.from(likeScopeRoot.querySelectorAll('span,a'))
          .slice(0, 60)
          .some((el) =>
            /^(?:Sponsored|赞助内容|贊助內容|赞助|贊助|广告|廣告)$/i.test(
              (el.textContent || '').trim(),
            ),
          );
      const msgNodes = Array.from(
        likeScopeRoot.querySelectorAll(
          '[data-ad-rendering-role="profile_name"],[data-ad-rendering-role="story_message"],[data-ad-preview="message"],h2,h3,span[dir="auto"]',
        ),
      ).slice(0, 24);
      const text = (
        msgNodes.length > 0
          ? msgNodes.map((el) => el.textContent || '').join(' ')
          : likeScopeRoot.textContent || ''
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1000);
      likeTarget = { css: likeCSS, liked, likeCount, sponsored, text };
    }
  }
  return {
    url: location.href,
    timeOrigin: performance.timeOrigin,
    ready: document.readyState !== 'loading' && (friendsRoute ? !!main || !!friendNav : !!main),
    visible: document.visibilityState === 'visible',
    blocked: dialogs,
    scrollY: currentScrollY,
    scrollMaxY: currentScrollMaxY,
    viewportHeight: innerHeight,
    contentPosition,
    ...(recommendedDwellMs !== undefined ? { recommendedDwellMs } : {}),
    ...(nextScrollDeltaY !== undefined ? { nextScrollDeltaY } : {}),
    ...(likeTarget !== null ? { likeTarget } : {}),
    ...(dialogDismissCSS !== null ? { dialogDismissCSS } : {}),
    contentKey: friendRequestsRoute
      ? friendKey
      : marketplace
        ? marketplaceKey
        : itemRoute
          ? detailLoaded
            ? 'item:' + location.pathname.replace(/\/$/, '')
            : null
          : source
            ? source.slice(0, 2000)
            : (structuralPost?.key ?? article?.key ?? null),
    videoEntry,
    nextReelCSS:
      (/^\/reel\/\d+\/?$/.test(location.pathname) ||
        (location.pathname === '/reel/' && location.search === '?s=tab' && !location.hash)) &&
      video &&
      nextButton &&
      visibleArea(nextButton) > 0 &&
      nextButton.getAttribute('aria-disabled') !== 'true' &&
      !nextButton.hasAttribute('disabled') &&
      canHitCenter(nextButton)
        ? nextReelCSS
        : null,
    ...(friendRequestsRoute
      ? {
          friendConfirmCSS,
          friendPendingCount: friendConfirmButtons.length,
        }
      : {}),
    marketplaceCategories,
    marketplaceUnavailable,
    marketplaceItems: [...new Set(items)]
      .slice(0, 8)
      .map((item) => 'https://www.facebook.com' + item.replace(/\/?$/, '/')),
    structure: {
      scrollRoots: scrolling.slice(0, 4).map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName.slice(0, 12),
          role: el.getAttribute('role')?.slice(0, 40) ?? null,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          top: Math.max(0, el.scrollTop),
          max: Math.max(0, el.scrollHeight - el.clientHeight),
        };
      }),
      centerHit: centerHit
        ? {
            tag: centerHit.tagName.slice(0, 12),
            role: centerHit.getAttribute('role')?.slice(0, 40) ?? null,
            withinMain: !!main?.contains(centerHit),
          }
        : null,
      mainCount: mains.length,
      allVideos: document.querySelectorAll('video').length,
      mainVideos: main?.querySelectorAll('video').length ?? 0,
      visibleVideos: videos.length,
      structuralPosts: structuralPosts.length,
      players: Array.from(main?.querySelectorAll('video') ?? [])
        .slice(0, 8)
        .map((el) => ({
          area: visibleArea(el),
          sourceLength: (el.currentSrc || el.getAttribute('src') || '').length,
          srcObject: el.srcObject !== null,
          readyState: el.readyState,
          paused: el.paused,
          ended: el.ended,
          timeSeconds: Number.isFinite(el.currentTime) ? Math.max(0, el.currentTime) : 0,
          errorCode: el.error?.code ?? null,
          videoWidth: el.videoWidth,
          videoHeight: el.videoHeight,
        })),
    },
    video:
      video && source && source.length <= 4096 && Number.isFinite(video.currentTime)
        ? {
            css: cssPath(video),
            source,
            paused: video.paused,
            buffering: video.readyState < 3 || video.error !== null,
            failed: video.error !== null,
            readyState: video.readyState,
            ended: video.ended,
            timeSeconds: Math.max(0, video.currentTime),
            ...(videoDurationSeconds !== null ? { durationSeconds: videoDurationSeconds } : {}),
            playbackRate:
              Number.isFinite(video.playbackRate) &&
              video.playbackRate >= 0 &&
              video.playbackRate <= 4
                ? video.playbackRate
                : 1,
          }
        : null,
  };
}
export async function readFacebookBrowsePage(
  page: Page,
  guard: () => Awaitable<void>,
): Promise<BrowsePage> {
  await guard();
  const result = FacebookBrowsePage.parse(await page.evaluate(projectFacebookBrowsePage));
  await guard();
  return result;
}
