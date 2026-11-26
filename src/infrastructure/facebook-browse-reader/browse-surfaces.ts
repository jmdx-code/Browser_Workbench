import type {
  FACEBOOK_BROWSE_DIALOG_DISMISS_CSS,
  FACEBOOK_FRIEND_ADD_CSS,
  FACEBOOK_FRIEND_CONFIRM_CSS,
} from '../../shared/facebook-browse-route.js';
import {
  serializeDomEval,
  type DOMRecord,
  type createDomEvalRuntime,
} from '../shared-dom-eval-runtime.js';
import type { BrowseFeedSnapshot } from './browse-feed-and-like.js';
export type { DOMRecord };
export interface BrowseRuntime {
  homeSurface: boolean;
  reelSurface: boolean;
  searchPagesRoute: boolean;
  reservedDetourRx: RegExp;
  timelineDetourSurface: boolean;
  feedLikeSurface: boolean;
  record: (v: unknown) => v is DOMRecord;
  frames: (el: Element, limit?: number) => { name: string; props: DOMRecord }[];
  visibleArea: (el: Element) => number;
  mains: Element[];
  main: Element | null | undefined;
  dialogs: boolean;
  dialogDismissCSS: typeof FACEBOOK_BROWSE_DIALOG_DISMISS_CSS | null;
  videos: { el: HTMLVideoElement; area: number }[];
  video: HTMLVideoElement | null;
  cssPath: (el: Element) => string | null;
  feedText: (value: string) => string;
  canHitCenter: (el: Element, rect?: DOMRect) => boolean;
  canonicalDetourHref: (rawHref: string) => { url: string; id: string | null } | null;
  lookupRelayActor: (el: Element, actorId: string) => DOMRecord | null;
}
export function createBrowseRuntime(createRt: typeof createDomEvalRuntime): BrowseRuntime {
  const {
    record,
    frames,
    visibleArea,
    enabled,
    canHitCenter,
    lookupRelayActor,
    isBlockingBrowseDialog,
    clearDataAttrs,
  } = createRt();
  const homeSurface = location.pathname === '/',
    reelSurface =
      /^\/(?:watch|reels)\/?$/.test(location.pathname) ||
      /^\/reel\/\d{1,30}\/?$/.test(location.pathname) ||
      (location.pathname === '/reel/' && location.search === '?s=tab' && !location.hash),
    searchPagesRoute = /^\/search\/pages\/?$/i.test(location.pathname),
    reservedDetourRx =
      /^\/(?:login(?:\.php)?|recover|checkpoint|disabled|suspended|account_status|restriction|groups|messages|settings|help|privacy|policies|ads|business|marketplace|watch|reels|reel|stories|friends|events|pages|search|photo(?:\.php)?|photos|videos|video\.php|permalink\.php|posts|bookmarks|notifications|memories|saved|gaming|hashtag|share|sharer(?:\.php)?|l\.php|ajax|api|dialog|profile\.php|post|composer|feed|home\.php|index\.php|logout\.php|reg|r\.php|fundraisers|live|offers|jobs|weather|crisisresponse|professional_dashboard|latest|me|menu|directory|legal|about|careers|developers|communitystandards|support|p)(?:\/|$)/i,
    timelineDetourSurface =
      !homeSurface &&
      !reelSurface &&
      !searchPagesRoute &&
      ((location.pathname === '/profile.php' &&
        /^\d{5,25}$/.test(new URLSearchParams(location.search).get('id') ?? '')) ||
        /^\/(?:people|pages)\/[^/]+\/\d{5,25}\/?$/i.test(location.pathname) ||
        /^\/p\/[^/]{2,180}\/?$/i.test(location.pathname) ||
        (/^\/(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2}){2,160}\/?$/.test(location.pathname) &&
          !reservedDetourRx.test(location.pathname))),
    feedLikeSurface = homeSurface || timelineDetourSurface,
    mains = Array.from(document.querySelectorAll('main,[role="main"]')).filter(
      (el) => visibleArea(el) > 0,
    ),
    marketplaceSurface =
      /^\/marketplace(?:\/category\/[a-z0-9_-]{1,80}(?:\/search)?|\/(?:(?!(?:inbox|you|create|item|selling|buying|notifications|ineligible|search)(?:\/|$))[a-z0-9_-]{1,80})(?:\/search)?|\/search|\/item\/\d{1,30})?\/?$/i.test(
        location.pathname ?? '',
      ),
    main =
      mains.length === 1
        ? mains[0]
        : (marketplaceSurface || timelineDetourSurface || searchPagesRoute) && mains.length > 1
          ? [...mains].sort((a, b) => visibleArea(b) - visibleArea(a))[0]
          : null,
    blockingDialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(
      isBlockingBrowseDialog,
    ),
    dialogs = blockingDialogs.length > 0;
  clearDataAttrs(['data-wb-browse-dialog-dismiss']);
  let dialogDismissCSS: typeof FACEBOOK_BROWSE_DIALOG_DISMISS_CSS | null = null;
  if (dialogs) {
    const dangerousRe = /删除|刪除|Delete|注销|註銷|Deactivate|退出|登出|Log\s*Out|Sign\s*Out/i,
      primaryLabelRe = /^(?:关闭|關閉|Close|Dismiss|以后再说|稍后|稍後|Not\s*Now)$/i,
      secondaryLabelRe =
        /^(?:关闭|關閉|Close|Dismiss|以后再说|稍后|稍後|Not\s*Now|继续|繼續|Continue|知道了|Got\s*it|OK|确定|確定|取消|Cancel)$/i,
      candidates: { el: Element; priority: number }[] = [];
    for (const dlg of blockingDialogs)
      for (const btn of Array.from(dlg.querySelectorAll('[role="button"],button')).slice(0, 80)) {
        if (
          !enabled(btn) ||
          visibleArea(btn) <= 0 ||
          !canHitCenter(btn, { topMargin: 4, bottomMargin: 4, allowParentContains: true })
        )
          continue;
        const aria = (btn.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
          text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
        if (dangerousRe.test(aria) || dangerousRe.test(text)) continue;
        if (primaryLabelRe.test(aria)) candidates.push({ el: btn, priority: 1 });
        else if (secondaryLabelRe.test(aria) || secondaryLabelRe.test(text))
          candidates.push({ el: btn, priority: 2 });
      }
    const chosen = candidates.sort((a, b) => a.priority - b.priority)[0]?.el;
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
  const selected = videos[0],
    video = selected && (!videos[1] || selected.area > videos[1].area * 1.1) ? selected.el : null;
  if (feedLikeSurface || reelSurface) {
    for (const otherVid of Array.from(document.querySelectorAll('video'))) {
      if (otherVid === video) continue;
      const r = otherVid.getBoundingClientRect(),
        visibleH = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)),
        passedAbove = r.bottom < 80 || ((r.width === 0 || r.height === 0) && r.top <= 0);
      if (visibleArea(otherVid) > 0 && visibleH >= 120 && !passedAbove) continue;
      otherVid.preload = 'none';
      try {
        if (!otherVid.paused) otherVid.pause();
      } catch {}
      if (passedAbove && otherVid.getAttribute('data-wb-buffer-freed') !== '1') {
        try {
          otherVid.pause();
          if (otherVid.srcObject) otherVid.srcObject = null;
          if (otherVid.hasAttribute('src')) otherVid.removeAttribute('src');
          otherVid.load();
          otherVid.setAttribute('data-wb-buffer-freed', '1');
        } catch {}
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
      const idx = node.parentElement
        ? Array.from(node.parentElement.children).indexOf(node) + 1
        : 1;
      parts.unshift(node.tagName.toLowerCase() + ':nth-child(' + idx + ')');
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
  const canonicalDetourHref = (rawHref: string): { url: string; id: string | null } | null => {
    try {
      const u = new URL(rawHref, 'https://www.facebook.com');
      if (u.origin !== 'https://www.facebook.com' || u.username || u.password) return null;
      if (u.pathname === '/profile.php') {
        const id = u.searchParams.get('id') ?? '';
        return /^\d{5,25}$/.test(id)
          ? { url: 'https://www.facebook.com/profile.php?id=' + id, id }
          : null;
      }
      const pp = /^\/(people|pages)\/([^/]+)\/(\d{5,25})\/?$/i.exec(u.pathname);
      if (pp?.[3])
        return { url: `https://www.facebook.com/${pp[1]}/${pp[2]}/${pp[3]}/`, id: pp[3] };
      const mp = /^\/p\/([^/]{2,180})\/?$/i.exec(u.pathname);
      if (mp?.[1])
        return {
          url: `https://www.facebook.com/p/${mp[1]}/`,
          id: /-(\d{5,25})$/.exec(mp[1])?.[1] ?? mp[1],
        };
      const seg = /^\/((?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2}){2,160})\/?$/.exec(u.pathname)?.[1];
      return seg && !reservedDetourRx.test('/' + seg)
        ? { url: `https://www.facebook.com/${seg}/`, id: seg }
        : null;
    } catch {
      return null;
    }
  };
  return {
    homeSurface,
    reelSurface,
    searchPagesRoute,
    reservedDetourRx,
    timelineDetourSurface,
    feedLikeSurface,
    record,
    frames,
    visibleArea,
    mains,
    main,
    dialogs,
    dialogDismissCSS,
    videos,
    video,
    cssPath,
    feedText,
    canHitCenter: (el: Element, rect?: DOMRect) => canHitCenter(el, { rect }),
    canonicalDetourHref,
    lookupRelayActor,
  };
}
function projectFeedInputFenceEntry(createRt: typeof createDomEvalRuntime) {
  const { visible, isBlockingBrowseDialog } = createRt();
  const reservedDetourRx = new RegExp(
    '^\\/(?:login(?:\\.php)?|recover|checkpoint|disabled|suspended|account_status|restriction|groups|messages|settings|help|privacy|policies|ads|business|marketplace|watch|reels|reel|stories|friends|events|pages|search|photo(?:\\.php)?|photos|videos|video\\.php|permalink\\.php|posts|bookmarks|notifications|memories|saved|gaming|hashtag|share|sharer(?:\\.php)?|l\\.php|ajax|api|dialog|profile\\.php|post|composer|feed|home\\.php|index\\.php|logout\\.php|reg|r\\.php|fundraisers|live|offers|jobs|weather|crisisresponse|professional_dashboard|latest|me|menu|directory|legal|about|careers|developers|communitystandards|support|p)(?:\\/|$)',
    'i',
  );
  const marketplaceSurfaceRx = new RegExp(
    '^\\/marketplace(?:\\/category\\/[a-z0-9_-]{1,80}(?:\\/search)?|\\/(?:(?!(?:inbox|you|create|item|selling|buying|notifications|ineligible|search)(?:\\/|$))[a-z0-9_-]{1,80})(?:\\/search)?|\\/search|\\/item\\/\\d{1,30})?\\/?$',
    'i',
  );
  const mains = Array.from(document.querySelectorAll('main,[role="main"]')).filter((el) =>
    visible(el, { viewport: true, opacity: true }),
  );
  const path = location.pathname ?? '';
  const detourLikeSurface =
    /^\/search\/pages\/?$/i.test(path) ||
    (path === '/profile.php' &&
      /^\d{5,25}$/.test(new URLSearchParams(location.search).get('id') ?? '')) ||
    /^\/(?:people|pages)\/[^/]+\/\d{5,25}\/?$/i.test(path) ||
    /^\/p\/[^/]{2,180}\/?$/i.test(path) ||
    (/^\/(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2}){2,160}\/?$/.test(path) && !reservedDetourRx.test(path));
  return {
    url: location.href,
    timeOrigin: performance.timeOrigin,
    ready:
      document.readyState !== 'loading' &&
      (mains.length === 1 ||
        ((marketplaceSurfaceRx.test(path) || detourLikeSurface) && mains.length > 1)),
    visible: document.visibilityState === 'visible',
    blocked: Array.from(document.querySelectorAll('[role="dialog"]')).some(isBlockingBrowseDialog),
    scrollY: Math.max(0, scrollY),
    viewportHeight: innerHeight,
    contentKey: null,
    video: null,
  };
}
export const projectFacebookFeedInputFence = serializeDomEval<
  () => ReturnType<typeof projectFeedInputFenceEntry>
>('projectFacebookFeedInputFence', projectFeedInputFenceEntry);
export interface BrowseFriendsAndMarketSnapshot {
  friendsRoute: boolean;
  friendRequestsRoute: boolean;
  friendSuggestionsRoute: boolean;
  friendNav: Element | null | undefined;
  friendConfirmCSS: typeof FACEBOOK_FRIEND_CONFIRM_CSS | null;
  friendPendingCount: number;
  friendAddCSS: typeof FACEBOOK_FRIEND_ADD_CSS | null;
  friendSuggestedCount: number;
  friendKey: string | null;
  marketplace: boolean;
  marketplaceCategories: string[];
  items: string[];
  marketplaceKey: string | null;
  itemRoute: boolean;
  detailLoaded: boolean;
  marketplaceUnavailable: boolean;
}
export function readBrowseFriendsAndMarket(rt: BrowseRuntime): BrowseFriendsAndMarketSnapshot {
  const { record, frames, visibleArea, main, dialogs, feedText, canHitCenter } = rt;
  const friendsRoute = /^\/friends(?:\/(?:requests|suggestions))?\/?$/.test(location.pathname);
  const friendRequestsRoute = /^\/friends\/requests\/?$/.test(location.pathname);
  const friendSuggestionsRoute = /^\/friends\/suggestions\/?$/.test(location.pathname);
  for (const old of Array.from(
    document.querySelectorAll('[data-wb-friend-confirm],[data-wb-friend-add]'),
  )) {
    old.removeAttribute('data-wb-friend-confirm');
    old.removeAttribute('data-wb-friend-add');
  }
  const friendCandidates =
    friendRequestsRoute || friendSuggestionsRoute
      ? Array.from(document.querySelectorAll('[role="navigation"],main,[role="main"]')).filter(
          (el) => visibleArea(el) > 0,
        )
      : [];
  const friendNav =
    friendRequestsRoute || friendSuggestionsRoute
      ? (friendCandidates.find((el) =>
          Array.from(el.querySelectorAll('[role="button"],button')).some((b) =>
            frames(b).some((f) => f.name.includes('FriendingCometListItemWithButtons.react')),
          ),
        ) ??
        friendCandidates.find((el) => frames(el).some((f) => f.name.includes('FriendingComet'))) ??
        main)
      : null;
  const friendScroller =
    (friendRequestsRoute || friendSuggestionsRoute) && friendNav
      ? [friendNav, ...Array.from(friendNav.querySelectorAll('div')).slice(0, 240)].find(
          (el) =>
            el.scrollHeight > el.clientHeight + 20 &&
            visibleArea(el) > 0 &&
            /auto|scroll/.test(getComputedStyle(el).overflowY),
        )
      : undefined;
  const confirmLabels = new Set(['confirm', '确认', '確認']),
    enabledFriendButtons = (pred: (el: Element) => boolean) =>
      friendNav
        ? Array.from(friendNav.querySelectorAll('[role="button"], button')).filter(
            (el) =>
              el.getAttribute('aria-disabled') !== 'true' &&
              !el.hasAttribute('disabled') &&
              visibleArea(el) > 0 &&
              pred(el),
          )
        : [];
  const friendConfirmButtons = friendRequestsRoute
    ? enabledFriendButtons((el) => {
        const chain = frames(el),
          button = chain.find((f) => f.name.includes('FDSButton.react')),
          row = chain.find((f) => f.name.includes('FriendingCometListItemWithButtons.react')),
          group = chain.find((f) => f.name.includes('FDSButtonGroup.react'));
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
        return confirmLabels.has(
          (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase(),
        );
      })
    : [];
  const addFriendRejectRx =
    /^(?:移除|删除|刪除|Remove|Delete|取消|取消邀請|收回交友邀請|收回邀請|Cancel|已发送|已發送|已送出|Request\s+sent|Cancel\s+request|确认|確認|Confirm|发消息|發訊息|Message)/iu;
  const addFriendLabelRx =
    /^(?:把.+加为好友|把.+加為好友|加为好友|加為好友|添加好友|加朋友|加入朋友|新增朋友|Add\s+friend(?:\s+.+)?|Add\s+.+\s+as\s+a\s+friend|Thêm\s+bạn\s+bè|เพิ่มเพื่อน|သူငယ်ချင်းထည့်ရန်)$/iu;
  const friendAddButtons = friendSuggestionsRoute
    ? enabledFriendButtons((el) => {
        const aria = (el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
          txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if ((aria && addFriendRejectRx.test(aria)) || (txt && addFriendRejectRx.test(txt)))
          return false;
        const chain = frames(el),
          button = chain.find((f) => f.name.includes('FDSButton.react')),
          row = chain.find((f) => f.name.includes('FriendingCometListItemWithButtons.react')),
          group = chain.find((f) => f.name.includes('FDSButtonGroup.react'));
        if (button && row && record(row.props.user)) {
          const status = row.props.user.friendship_status,
            statusAllowed = status === 'CAN_REQUEST' || status === undefined || status === null,
            primaryOk =
              button.props.type === 'primary' ||
              (button.props.type === 'secondary' && addFriendLabelRx.test(aria || txt)),
            groupOk =
              !group ||
              (record(group.props.primary) &&
                (!group.props.primary.testid ||
                  !/remove|delete|cancel/i.test(String(group.props.primary.testid))));
          if (primaryOk && statusAllowed && groupOk) {
            if (!aria && !txt) return button.props.type === 'primary';
            return (
              button.props.type === 'primary' ||
              addFriendLabelRx.test(aria) ||
              addFriendLabelRx.test(txt)
            );
          }
          return false;
        }
        return addFriendLabelRx.test(aria) || addFriendLabelRx.test(txt);
      })
    : [];
  const resolveFriendStep = (
    buttons: Element[],
    attr: string,
    includeAriaFallback: boolean,
    prefix: string,
    countTag: string,
    scrollTag: string,
    loadingKey: string,
    exhaustedKey: string,
  ): { cssMatched: boolean; key: string | null } => {
    const first = buttons[0];
    if (!friendNav) return { cssMatched: false, key: null };
    if (first) {
      const btnRect = first.getBoundingClientRect();
      if (btnRect.top < 72 || btnRect.bottom > innerHeight - 24)
        first.scrollIntoView({ block: 'center' });
      let cssMatched = false;
      if (canHitCenter(first)) {
        first.setAttribute(attr, '1');
        cssMatched = true;
      }
      let href = '';
      for (
        let d = 0, card = first.parentElement;
        card && card !== friendNav && d < 8;
        d++, card = card.parentElement
      ) {
        const link = card.querySelector('a[href]');
        if (link) {
          href = link.getAttribute('href') || '';
          break;
        }
      }
      const user = frames(first).find((f) =>
        f.name.includes('FriendingCometListItemWithButtons.react'),
      )?.props.user;
      const cardSig =
        (record(user) && typeof user.id === 'string' ? user.id : href) ||
        (includeAriaFallback ? first.getAttribute('aria-label') || '' : '') ||
        feedText(first.parentElement?.parentElement?.textContent ?? '');
      return {
        cssMatched,
        key: `${prefix}:${cardSig.slice(0, 300)}|${countTag}:${buttons.length}`,
      };
    }
    if (
      friendScroller &&
      friendScroller.scrollTop + friendScroller.clientHeight < friendScroller.scrollHeight - 20
    ) {
      friendScroller.scrollTop += Math.max(160, Math.round(friendScroller.clientHeight * 0.75));
      return { cssMatched: false, key: `${scrollTag}:${Math.round(friendScroller.scrollTop)}` };
    }
    const isLoading = Array.from(
      friendNav.querySelectorAll(
        '[role="progressbar"],[data-visualcompletion="loading-state"],[aria-busy="true"]',
      ),
    ).some((el) => visibleArea(el) > 0);
    return { cssMatched: false, key: isLoading ? loadingKey : exhaustedKey };
  };
  let friendConfirmCSS: typeof FACEBOOK_FRIEND_CONFIRM_CSS | null = null;
  let friendAddCSS: typeof FACEBOOK_FRIEND_ADD_CSS | null = null;
  let friendKey: string | null = null;
  if (friendRequestsRoute && friendNav) {
    const res = resolveFriendStep(
      friendConfirmButtons,
      'data-wb-friend-confirm',
      false,
      'friend-req',
      'pending',
      'friend-scrolling',
      'friend-req-loading',
      'FRIENDS_REQUESTS_EXHAUSTED',
    );
    if (res.cssMatched) friendConfirmCSS = '[data-wb-friend-confirm="1"]';
    friendKey = res.key;
  } else if (friendSuggestionsRoute && friendNav) {
    const res = resolveFriendStep(
      friendAddButtons,
      'data-wb-friend-add',
      true,
      'friend-sug',
      'suggested',
      'friend-sug-scrolling',
      'friend-sug-loading',
      'FRIENDS_SUGGESTIONS_EXHAUSTED',
    );
    if (res.cssMatched) friendAddCSS = '[data-wb-friend-add="1"]';
    friendKey = res.key;
  }
  const marketplace =
    /^\/marketplace(?:\/category\/[a-z0-9_-]{1,80}(?:\/search)?|\/(?:(?!(?:inbox|you|create|item|selling|buying|notifications|ineligible|search)(?:\/|$))[a-z0-9_-]{1,80})(?:\/search)?|\/search)?\/?$/i.test(
      location.pathname,
    );
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
      .some((el) =>
        el instanceof HTMLImageElement
          ? el.complete && el.naturalWidth > 0 && visibleArea(el) >= 2500
          : visibleArea(el) >= 2500,
      ) ||
      Array.from(detailRoot.querySelectorAll('[role="button"],a[href*="/marketplace/"]'))
        .slice(0, 80)
        .some((el) => visibleArea(el) > 0));
  const detailLoaded = itemRoute && !!main && hasDetailText && hasDetailMediaOrAction;
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
  return {
    friendsRoute,
    friendRequestsRoute,
    friendSuggestionsRoute,
    friendNav,
    friendConfirmCSS,
    friendPendingCount: friendConfirmButtons.length,
    friendAddCSS,
    friendSuggestedCount: friendAddButtons.length,
    friendKey,
    marketplace,
    marketplaceCategories,
    items,
    marketplaceKey,
    itemRoute,
    detailLoaded,
    marketplaceUnavailable,
  };
}
export function readBrowseDetoursAndSearch(rt: BrowseRuntime, feed: BrowseFeedSnapshot) {
  const {
    homeSurface,
    searchPagesRoute,
    record,
    frames,
    visibleArea,
    main,
    canonicalDetourHref,
    lookupRelayActor,
  } = rt;
  const { orderedPosts } = feed;
  const feedDetourTargets: { url: string; kind: 'profile' | 'page'; name?: string }[] = [];
  if (homeSurface && main) {
    const seenDetourUrls = new Set<string>(),
      isPageActor = (o: DOMRecord, checkDelegate = false) =>
        o.__typename === 'Page' ||
        o.is_profile_plus === true ||
        o.is_verified === true ||
        typeof o.category_name === 'string' ||
        (checkDelegate && o.delegate_page !== undefined),
      candidateRoots = [
        ...orderedPosts.map((p) => p.root),
        ...Array.from(main.querySelectorAll('[role="article"]')).slice(0, 20),
      ];
    for (const postRoot of candidateRoots) {
      if (feedDetourTargets.length >= 12) break;
      if (visibleArea(postRoot) <= 0) continue;
      if (
        postRoot.querySelector(
          'a[href*="/ads/about"],a[aria-label*="Sponsored" i],a[aria-label*="赞助"],a[aria-label*="贊助"],a[aria-label*="广告"],a[aria-label*="廣告"]',
        ) !== null ||
        Array.from(postRoot.querySelectorAll('span,a'))
          .slice(0, 32)
          .some((el) =>
            /^(?:Sponsored|赞助内容|贊助內容|赞助|贊助|广告|廣告)$/i.test(
              (el.textContent || '').trim(),
            ),
          )
      )
        continue;
      const profileNameHost =
        postRoot.querySelector('[data-ad-rendering-role="profile_name"]') ?? postRoot;
      const authorLink = Array.from(profileNameHost.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .slice(0, 8)
        .find(
          (a) => canonicalDetourHref(a.href) !== null && (a.textContent ?? '').trim().length > 0,
        );
      if (!authorLink) continue;
      const parsed = canonicalDetourHref(authorLink.href);
      if (!parsed || seenDetourUrls.has(parsed.url)) continue;
      seenDetourUrls.add(parsed.url);
      const actorKindOf = (o: DOMRecord, checkDelegate = false): 'profile' | 'page' | null =>
        isPageActor(o, checkDelegate)
          ? 'page'
          : o.__typename === 'User' && (checkDelegate || o.is_profile_plus !== true)
            ? 'profile'
            : null;
      let kind: 'profile' | 'page' | null = null;
      for (const f of frames(authorLink, 48)) {
        const actorObj =
          [f.props.actor, f.props.profile, f.props.page, f.props.user].find(record) ?? null;
        if (actorObj && (kind = actorKindOf(actorObj))) break;
        if (typeof f.props.actorID === 'string' && f.props.actorID.trim()) {
          const relayActor = lookupRelayActor(authorLink, f.props.actorID.trim());
          if (relayActor && (kind = actorKindOf(relayActor, true))) break;
        }
      }
      if (!kind) {
        const hasFollowBtn = Array.from(postRoot.querySelectorAll('[role="button"],button'))
          .slice(0, 12)
          .some((btn) =>
            /^(?:关注|關注|追蹤|Follow|Following|已关注|已追蹤|点赞主页|赞专页)$/i.test(
              (btn.getAttribute('aria-label') || btn.textContent || '').trim(),
            ),
          );
        kind = hasFollowBtn ? 'page' : 'profile';
      }
      const authorName = (authorLink.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      feedDetourTargets.push({
        url: parsed.url,
        kind,
        ...(authorName ? { name: authorName } : {}),
      });
    }
  }
  const searchPageMatches: { url: string; id: string | null; name: string }[] = [];
  if (searchPagesRoute && main) {
    const seenSearchUrls = new Set<string>();
    const resultCards = Array.from(
      main.querySelectorAll('[role="article"],[role="listitem"]'),
    ).filter((el) => visibleArea(el) > 0);
    const links = (
      resultCards.length > 0
        ? resultCards.flatMap((c) => Array.from(c.querySelectorAll<HTMLAnchorElement>('a[href]')))
        : Array.from(main.querySelectorAll<HTMLAnchorElement>('a[href]'))
    ).slice(0, 240);
    for (const link of links) {
      if (searchPageMatches.length >= 12) break;
      if (visibleArea(link) <= 0) continue;
      const parsed = canonicalDetourHref(link.href);
      if (!parsed || seenSearchUrls.has(parsed.url)) continue;
      const textLabel = (link.textContent || '').replace(/\s+/g, ' ').trim();
      const ariaLabel = (link.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const safeAria =
        ariaLabel && !/^(?:头像|頭像|avatar|profile\s*photo|图片|圖片)$/i.test(ariaLabel)
          ? ariaLabel
          : '';
      const rawName = (textLabel || safeAria).slice(0, 200);
      if (!rawName || rawName.length < 2) continue;
      let resolvedId = parsed.id;
      for (const f of frames(link, 36)) {
        if (typeof f.props.actorID === 'string' && /^\d{5,25}$/.test(f.props.actorID)) {
          resolvedId = f.props.actorID;
          break;
        }
        const ent = [f.props.entity, f.props.profile, f.props.node].find(record) ?? null;
        if (ent && typeof ent.id === 'string' && /^\d{5,25}$/.test(ent.id)) {
          resolvedId = ent.id;
          break;
        }
      }
      seenSearchUrls.add(parsed.url);
      searchPageMatches.push({ url: parsed.url, id: resolvedId, name: rawName });
    }
  }
  return { feedDetourTargets, searchPageMatches };
}
