import type { Page } from 'playwright-core';
import type { BumperTarget } from '../shared/group-bumper.js';

export function extractBumperPost(raw: string, groupId: string) {
  try {
    const url = new URL(raw, 'https://www.facebook.com');
    if (url.origin !== 'https://www.facebook.com') return null;
    const match = /^\/groups\/([^/]+)\/(?:posts|permalink)\/(\d+)/i.exec(url.pathname);
    if (match && match[1]?.toLowerCase() !== groupId.toLowerCase()) return null;
    const postId =
      match?.[2] ??
      /^\/reel\/(\d+)/i.exec(url.pathname)?.[1] ??
      url.searchParams.get('story_fbid') ??
      /pcb\.(\d+)/.exec(url.href)?.[1];
    return postId && /^\d+$/.test(postId)
      ? {
          postId,
          postUrl: `https://www.facebook.com/groups/${encodeURIComponent(groupId)}/posts/${postId}/`,
        }
      : null;
  } catch {
    return null;
  }
}
export function relativePostAge(text: string, now = Date.now()): number | null {
  const value = text.trim().toLowerCase();
  if (/^(?:just now|刚刚|剛剛)$/.test(value)) return 0;
  if (/^(?:yesterday|昨天)$/.test(value)) return 24;
  const match =
    /^(\d+(?:\.\d+)?)\s*(m|min(?:ute)?s?|分钟|分鐘|h|hours?|小时|小時|d|days?|天)/u.exec(value);
  if (match) {
    const unit = match[2] ?? '';
    return (
      Number(match[1]) *
      (/^(?:m|分钟|分鐘)/.test(unit) ? 1 / 60 : /^(?:h|小时|小時)/.test(unit) ? 1 : 24)
    );
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) && timestamp <= now ? (now - timestamp) / 3600000 : null;
}
export function bumperAuthorMatch(
  post: Pick<BumperPost, 'authorId' | 'authorName'> & { authorAliases?: string[] },
  target: BumperTarget,
) {
  // A known contradictory stable ID always wins over a similar display name.
  if (post.authorId && /^\d+$/.test(target.id)) return post.authorId === target.id;
  return (
    post.authorId === target.id ||
    post.authorAliases?.some((id) => id.toLowerCase() === target.id.toLowerCase()) === true ||
    post.authorName.trim() === target.name.trim()
  );
}
export interface BumperPost {
  postId: string;
  postUrl: string;
  sourceEvidence?: { frames: Record<string, unknown>[]; parents: Record<string, unknown>[] };
  authorId: string | null;
  authorName: string;
  authorAliases: string[];
  authorAvatarUrl: string | null;
  pinned: boolean;
  ageHours: number | null;
  timeText: string;
  feedbackId: string | null;
  liked: boolean;
  postCSS?: string | null;
  likeCSS: string | null;
  commentCSS: string | null;
  commentButtonCSS: string | null;
  hasVideo: boolean;
  videoEnded?: boolean;
  videoCurrentTime?: number;
  videoDuration?: number | null;
  videoCSS?: string | null;
  videoPaused?: boolean;
  videoReadyState?: number;
  videoCurrentSrc?: string;
  videoFrames?: number;
  comments: { id: string; text: string; authorId: string | null }[];
}
export interface BumperSurface {
  url: string;
  groupIds: string[];
  pageIds?: string[];
  groupTitle?: string | null;
  avatarUrl: string | null;
  pageAvatarUrl: string | null;
  ready: boolean;
  visible: boolean;
  restricted: boolean;
  loading: boolean;
  groupEntryCSS: string | null;
  groupEntryMatchedBy?: 'id' | 'name' | null;
  joinGroupCSS?: string | null;
  welcomeDismissCSS?: string | null;
  posts: BumperPost[];
}

// Self-contained native-page projection. Only scoped control markers are written.
export function projectGroupBumper(input: {
  groupId: string;
  pageId?: string;
  /** 搜索结果页入口的名称兜底匹配（ID 未命中时按链接文本精确匹配）。 */
  groupName?: string;
  pageName?: string;
  targetPostId?: string;
  audit?: boolean;
}): BumperSurface {
  type RecordValue = Record<string, unknown>;
  const record = (v: unknown): v is RecordValue => !!v && typeof v === 'object';
  const obj = (v: unknown): RecordValue => (record(v) ? v : {});
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect(),
      s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const ancestorsVisible = (el: Element): boolean => {
    const selfStyle = getComputedStyle(el);
    if (!(Number.parseFloat(selfStyle.opacity || '1') > 0)) return false;
    let cur: Element | null = el.parentElement;
    for (
      let depth = 0;
      cur && cur !== document.body && depth < 12;
      depth++, cur = cur.parentElement
    ) {
      const s = getComputedStyle(cur);
      if (
        s.display === 'none' ||
        s.visibility === 'hidden' ||
        Number.parseFloat(s.opacity || '1') === 0
      )
        return false;
    }
    return true;
  };
  const cacheHost = (typeof window === 'undefined' ? document : window) as unknown as {
    __wbReactRootNodesV1?: WeakMap<Element, RecordValue>;
  };
  const rootFibers = (cacheHost.__wbReactRootNodesV1 ??= new WeakMap<Element, RecordValue>());
  let rootScanned = false;
  const currentRootFiber = (node: RecordValue | undefined): RecordValue | undefined => {
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
  const rootFiber = (el: Element) => {
    // Some current React builds expose only __reactContainer$, not per-node Fiber keys.
    const cached = currentRootFiber(rootFibers.get(el));
    if (cached) {
      rootFibers.set(el, cached);
      return cached;
    }
    if (!rootScanned) {
      rootScanned = true;
      const seen = new Set<unknown>(),
        stack: unknown[] = [];
      for (const host of Array.from(document.querySelectorAll('*')))
        for (const key of Object.keys(host).filter((k) => k.startsWith('__reactContainer$'))) {
          const root = Reflect.get(host, key);
          stack.push(
            record(root) && record(root.stateNode) ? (root.stateNode.current ?? root) : root,
          );
        }
      while (stack.length && seen.size < 100000) {
        const f = stack.pop();
        if (!record(f) || seen.has(f)) continue;
        seen.add(f);
        if (f.stateNode instanceof Element) rootFibers.set(f.stateNode, f);
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
    }
    return rootFibers.get(el);
  };
  const chain = (el: Element, limit = 48) => {
    const key = Object.keys(el).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
    );
    let node: unknown = key ? Reflect.get(el, key) : rootFiber(el);
    const result: { name: string; props: RecordValue; fiber: RecordValue }[] = [];
    for (let n = 0; n < limit && record(node); n++, node = node.return) {
      const type = node.elementType ?? node.type;
      const name =
        typeof type === 'function'
          ? String(Reflect.get(type, 'displayName') ?? type.name)
          : record(type)
            ? String(type.displayName ?? '')
            : typeof type === 'string'
              ? type
              : '';
      const props = node.memoizedProps ?? node.pendingProps;
      result.push({ name, props: record(props) ? props : {}, fiber: node });
    }
    return result;
  };

  const label = (v: unknown, depth = 0): string => {
    if (depth > 5) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map((x) => label(x, depth + 1)).join(' ');
    const p = obj(v);
    return label(
      p.$1 ?? p.text ?? p.children ?? obj(p.props).content ?? obj(p.props).children,
      depth + 1,
    );
  };
  const age = (value: string): number | null => {
    const v = value.trim().toLowerCase();
    if (/^(?:just now|刚刚|剛剛)$/.test(v)) return 0;
    if (/^(?:yesterday|昨天)$/.test(v)) return 24;
    const m =
      /^(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|分钟|分鐘|hours?|h|小时|小時|days?|d|天)(?:\b|$)/u.exec(
        v,
      );
    if (m)
      return (
        Number(m[1]) *
        (/^(?:m|分钟|分鐘)/.test(m[2] ?? '')
          ? 1 / 60
          : /^(?:h|小时|小時)/.test(m[2] ?? '')
            ? 1
            : 24)
      );
    // Only plausible date labels, never a plain count or a person's display name.
    if (
      !/\d{4}|\d{1,2}[/:月日]|\b(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(
        v,
      )
    )
      return null;
    const n = Date.parse(value);
    return Number.isFinite(n) && n <= Date.now() ? Math.max(0, (Date.now() - n) / 3600000) : null;
  };
  const decodeId = (id: unknown): string | null => {
    if (typeof id !== 'string') return null;
    try {
      return /(?:^feedback:|:VK:|:)(\d{8,25})$/.exec(atob(id))?.[1] ?? null;
    } catch {
      return null;
    }
  };
  const relayCache = new Map<string, RecordValue>();
  const relayRecord = (element: Element, id: string): RecordValue => {
    const cached = relayCache.get(id);
    if (cached) return cached;
    for (const f of chain(element, 256)) {
      const env = obj(obj(f.props.value).environment ?? f.props.environment);
      if (typeof env.getStore !== 'function') continue;
      try {
        const store = obj(Reflect.apply(env.getStore, env, [])),
          source = obj(
            typeof store.getSource === 'function'
              ? Reflect.apply(store.getSource, store, [])
              : null,
          );
        if (typeof source.get === 'function') {
          const row = obj(Reflect.apply(source.get, source, [id]));
          relayCache.set(id, row);
          return row;
        }
      } catch {}
    }
    return {};
  };
  const imageURL = (root: Element | null): string | null => {
    if (!root) return null;
    const nodes = [root, ...Array.from(root.querySelectorAll('img,image,svg')).slice(0, 40)];
    for (const node of nodes) {
      let url =
        node instanceof HTMLImageElement
          ? node.currentSrc || node.src
          : node.tagName.toLowerCase() === 'image'
            ? (node.getAttribute('xlink:href') ?? node.getAttribute('href'))
            : null;
      if (url?.startsWith('https://')) return url;
      for (const f of chain(node, 24))
        if (/FDSProfilePhoto|ProfilePhoto/.test(f.name)) {
          url = text(obj(f.props.source).uri);
          if (url.startsWith('https://')) return url;
        }
    }
    return null;
  };
  const actorAvatar = (root: Element, actorId: string): string | null => {
    const actor = relayRecord(root, actorId);
    const pick = (v: unknown, depth = 0): string | null => {
      if (!record(v) || depth > 4) return null;
      if (
        typeof v.uri === 'string' &&
        v.uri.startsWith('https://') &&
        !/static\.xx\.fbcdn\.net\/rsrc\.php/.test(v.uri)
      )
        return v.uri;
      if (typeof v.__ref === 'string') return pick(relayRecord(root, v.__ref), depth + 1);
      return null;
    };
    for (const [key, v] of Object.entries(actor))
      if (
        /^(?:profile_picture(?:\(|$)|profilePic(?:Large|Medium|Small)$|profile_photo$)/.test(key)
      ) {
        const url = pick(v);
        if (url) return url;
      }
    return null;
  };
  const groupIds = new Set<string>();
  const pageIds = new Set<string>();
  let groupEntryMatchedBy: 'id' | 'name' | null = null;
  const reservedPageSegment =
    /^(?:search|groups|watch|marketplace|gaming|friends|bookmarks|notifications|messages|events|memories|saved|settings|help|login|checkpoint|reel|reels|stories|photo|photos|videos|permalink|posts|hashtag|share|l\.php)$/i;
  const route = /^\/groups\/([^/]+)/.exec(location.pathname)?.[1];
  if (route) groupIds.add(decodeURIComponent(route).toLowerCase());
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
  if (canonical) {
    const id = /\/groups\/([^/]+)/.exec(canonical)?.[1];
    if (id) groupIds.add(id.toLowerCase());
  }
  if (!/^\/(?:search|groups)(?:\/|$)/i.test(location.pathname)) {
    if (location.pathname === '/profile.php') {
      const pid = new URLSearchParams(location.search).get('id');
      if (pid) pageIds.add(pid.toLowerCase());
    } else {
      const seg = /^\/([^/]+)/.exec(location.pathname)?.[1];
      if (seg && !reservedPageSegment.test(seg)) {
        pageIds.add(decodeURIComponent(seg).toLowerCase());
      }
    }
    const metaValues = [
      canonical,
      ...Array.from(document.querySelectorAll<HTMLMetaElement>('meta[property^="al:"]')).map(
        (m) => m.content,
      ),
    ];
    for (const raw of metaValues) {
      if (!raw) continue;
      for (const re of [
        /\/profile\.php\?[^#]*?\bid=(\d+)/i,
        /fb:\/\/page\/(\d+)/i,
        /fb:\/\/profile\/(\d+)/i,
      ]) {
        const m = re.exec(raw)?.[1];
        if (m) pageIds.add(m.toLowerCase());
      }
      const slug = /facebook\.com\/([^/?#]+)/i.exec(raw)?.[1];
      if (slug && slug.toLowerCase() !== 'profile.php' && !reservedPageSegment.test(slug)) {
        pageIds.add(decodeURIComponent(slug).toLowerCase());
      }
    }
  }
  let groupEntryCSS: string | null = null;
  document
    .querySelectorAll(
      '[data-wb-bumper-group],[data-wb-bumper-welcome-dismiss],[data-wb-bumper-join],[data-wb-bumper-post]',
    )
    .forEach((e) => {
      e.removeAttribute('data-wb-bumper-group');
      e.removeAttribute('data-wb-bumper-welcome-dismiss');
      e.removeAttribute('data-wb-bumper-join');
      if (!input.targetPostId || e.getAttribute('data-wb-bumper-post') === input.targetPostId) {
        e.removeAttribute('data-wb-bumper-post');
      }
    });
  let joinGroupCSS: string | null = null;
  if (/^\/groups\/(?!search(?:\/|$))[^/]+/i.test(location.pathname)) {
    const headerButtons = Array.from(
      document.querySelectorAll<HTMLElement>(
        'main [role="button"], main button, [role="main"] [role="button"], [role="main"] button',
      ),
    ).filter(
      (el) =>
        visible(el) &&
        ancestorsVisible(el) &&
        el.getAttribute('aria-disabled') !== 'true' &&
        !el.closest('[role="feed"], [role="article"], [role="dialog"], [role="navigation"], nav'),
    );
    const joinCandidates = headerButtons.filter((el) => {
      const raw = (el.getAttribute('aria-label') || el.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (
        /^(?:Joined|已加入|Pending|待审核|待審核|Cancel request|取消请求|取消請求|Invite|邀请|邀請)$/i.test(
          raw,
        )
      )
        return false;
      if (
        /^(?:Join group|Join|加入小组|加入小組|加入社團|加入社团|加入群组|加入群組|加入)$/i.test(
          raw,
        )
      )
        return true;
      return chain(el, 16).some(
        (f) =>
          /GroupsCometJoinButton/i.test(f.name) &&
          !/JOINED|REQUESTED/i.test(String(f.props.joinState ?? f.props.viewerJoinState ?? '')),
      );
    });
    const joinBtn =
      joinCandidates.find((el) => el.getBoundingClientRect().top >= 160) ?? joinCandidates[0];
    if (joinBtn) {
      joinBtn.setAttribute('data-wb-bumper-join', '1');
      joinGroupCSS = '[data-wb-bumper-join="1"]';
    }
  }
  if (/\/groups\/search|\/search/.test(location.pathname)) {
    // 搜索结果入口：只认合法的专页/小组主页链接（排除帖子、照片、话题、外链等子链接，
    // 防止因继承同一张结果卡片的 Fiber 而误标）；ID 匹配优先，其次才按名称精确匹配。
    const pageMode = input.groupId === '-' && !!input.pageId;
    const reservedPagePath =
      /^\/(?:search|groups|watch|marketplace|gaming|friends|bookmarks|notifications|messages|events|memories|saved|settings|help|login|checkpoint|reel|reels|stories|photo|photos|videos|permalink|posts|hashtag|share|l\.php)\/?$/i;
    const pageNameKey =
      input.pageName && input.pageName.trim() && input.pageName.trim() !== input.pageId
        ? input.pageName.trim().toLowerCase()
        : null;
    const groupNameKey =
      input.groupName && input.groupName.trim() && input.groupName.trim() !== input.groupId
        ? input.groupName.trim().toLowerCase()
        : null;
    let nameMatched: HTMLAnchorElement | null = null;
    let idMatched: HTMLAnchorElement | null = null;
    for (const link of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).filter(
      visible,
    )) {
      let u: URL;
      try {
        u = new URL(link.href);
      } catch {
        continue;
      }
      if (u.origin !== 'https://www.facebook.com') continue;
      const text = (link.textContent ?? '').trim().toLowerCase();
      if (pageMode && input.pageId) {
        const isPageHome =
          (u.pathname === '/profile.php' && !!u.searchParams.get('id')) ||
          (/^\/[^/]+\/?$/.test(u.pathname) && !reservedPagePath.test(u.pathname));
        if (!isPageHome) continue;
        const pageId = input.pageId;
        const linkIds = new Set<string>();
        if (u.pathname === '/profile.php') {
          const qid = u.searchParams.get('id');
          if (qid) linkIds.add(qid.toLowerCase());
        } else {
          const seg = /^\/([^/]+)\/?$/.exec(u.pathname)?.[1];
          if (seg && !reservedPageSegment.test(seg)) {
            linkIds.add(decodeURIComponent(seg).toLowerCase());
          }
        }
        for (const f of chain(link, 48)) {
          if (/ActorHovercard/.test(f.name) && typeof f.props.actorID === 'string') {
            const aid = f.props.actorID.trim().toLowerCase();
            if (aid) linkIds.add(aid);
          }
          const entity = obj(
            f.props.page ??
              f.props.profile ??
              f.props.user ??
              f.props.entity ??
              f.props.actor ??
              f.props.node ??
              f.props['page$key'] ??
              f.props['profile$key'],
          );
          const decodedEntityId = typeof entity.__id === 'string' ? decodeId(entity.__id) : null;
          for (const candidate of [entity.id, entity.__id, decodedEntityId]) {
            if (typeof candidate === 'string' && candidate.trim()) {
              linkIds.add(candidate.trim().toLowerCase());
            }
          }
        }
        const idHit = linkIds.has(pageId.toLowerCase());
        if (idHit) {
          idMatched = link;
          break;
        }
        const numericLinkIds = [...linkIds].filter((x) => /^\d+$/.test(x));
        if (/^\d+$/.test(pageId) && numericLinkIds.length > 0 && !numericLinkIds.includes(pageId)) {
          continue;
        }
        if (!nameMatched && pageNameKey && text === pageNameKey) nameMatched = link;
      } else {
        if (!/^\/groups\/(?!search(?:\/|$))[^/]+\/?$/i.test(u.pathname)) continue;
        const linkGroupIds = new Set<string>();
        const pathGroupSeg = /^\/groups\/([^/]+)\/?$/i.exec(u.pathname)?.[1];
        if (pathGroupSeg) linkGroupIds.add(decodeURIComponent(pathGroupSeg).toLowerCase());
        for (const f of chain(link, 48)) {
          const entity = obj(f.props.group ?? f.props.entity ?? f.props['group$key']);
          if (
            entity.__typename === 'Group' ||
            /Group/.test(f.name) ||
            f.props.group != null ||
            f.props['group$key'] != null
          ) {
            const decodedEntityId = typeof entity.__id === 'string' ? decodeId(entity.__id) : null;
            for (const candidate of [entity.id, entity.__id, decodedEntityId]) {
              if (typeof candidate === 'string' && candidate.trim()) {
                linkGroupIds.add(candidate.trim().toLowerCase());
              }
            }
          }
        }
        const idHit = linkGroupIds.has(input.groupId.toLowerCase());
        if (idHit) {
          idMatched = link;
          break;
        }
        const numericGroupIds = [...linkGroupIds].filter((x) => /^\d+$/.test(x));
        if (
          /^\d+$/.test(input.groupId) &&
          numericGroupIds.length > 0 &&
          !numericGroupIds.includes(input.groupId)
        ) {
          continue;
        }
        if (!nameMatched && groupNameKey && text === groupNameKey) nameMatched = link;
      }
    }
    const entryLink = idMatched ?? nameMatched;
    if (entryLink) {
      entryLink.setAttribute('data-wb-bumper-group', '1');
      groupEntryCSS = '[data-wb-bumper-group="1"]';
      groupEntryMatchedBy = idMatched ? 'id' : 'name';
    }
  }
  const posts: BumperPost[] = [];
  let loading = false;
  document
    .querySelectorAll(
      '[data-wb-bumper-like],[data-wb-bumper-comment],[data-wb-bumper-open-comment],[data-wb-bumper-video]',
    )
    .forEach((e) => {
      for (const attr of [
        'data-wb-bumper-like',
        'data-wb-bumper-comment',
        'data-wb-bumper-open-comment',
        'data-wb-bumper-video',
      ]) {
        if (!input.targetPostId || e.getAttribute(attr) === input.targetPostId) {
          e.removeAttribute(attr);
        }
      }
    });
  // Native feed cards need not have role=article; comment rows do. Resolve the
  // actual feed-card host before reading identity, author or action controls.
  const cards = new WeakMap<Element, ReturnType<typeof chain>[number] | null>();
  const cardFor = (el: Element) => {
    if (cards.has(el)) return cards.get(el) ?? undefined;
    const frames = chain(el, 256);
    const card =
      frames.find(
        (f) =>
          /CometFeedUnitCard|CometFeedUnitErrorBoundary/.test(f.name) &&
          record(f.props.story ?? f.props.feedUnit),
      ) ??
      frames.find(
        (f) => /CometFeedStoryClickLoggerContainer/.test(f.name) && record(f.props.story),
      );
    cards.set(el, card ?? null);
    return card;
  };
  const isTopLevelCommentEditor = (el: Element) => {
    if (
      !el.matches(
        '[role="textbox"][contenteditable="true"],div[contenteditable="true"][data-lexical-editor="true"],textarea',
      ) ||
      Boolean(el.closest('[role="banner"]'))
    ) {
      return false;
    }
    const frames = chain(el, 100);
    const insideExistingCommentOrReply = frames.some(
      (f) =>
        /CometUFICommentRow|CometUFICommentWrapper/.test(f.name) &&
        (record(f.props.comment) || (typeof f.props.depth === 'number' && f.props.depth > 0)),
    );
    if (insideExistingCommentOrReply) return false;
    return frames.some(
      (f) =>
        (/CometUFIComposerInputWithActionsForLexical/.test(f.name) &&
          (f.props.commentAction === 'ADD' || f.props.commentAction == null) &&
          (f.props.depth === 0 || f.props.depth == null)) ||
        (/CometUFICommentRow/.test(f.name) &&
          f.props.isComposer === true &&
          !record(f.props.comment) &&
          (f.props.depth === 0 || f.props.depth == null)),
    );
  };
  const commentRow = (el: Element) =>
    !isTopLevelCommentEditor(el) &&
    chain(el, 100).some((f) => /CometUFICommentRow|CometUFICommentWrapper/.test(f.name));
  const roots = new Set<Element>();
  for (const seed of Array.from(
    document.querySelectorAll(
      '[role="article"],[role="feed"] > *,a[href*="/posts/"],a[href*="/permalink/"],a[href*="story_fbid"],a[href*="pcb."],a[href*="/groups/"][href*="/user/"],a[href*="/reel/"],[data-ad-rendering-role="like_button"],[data-ad-rendering-role="comment_button"]',
    ),
  )) {
    if (!visible(seed)) continue;
    const card = cardFor(seed);
    let root = seed;
    if (card) {
      while (root.parentElement && cardFor(root.parentElement)?.fiber === card.fiber)
        root = root.parentElement;
    } else {
      const article = seed.closest('[role="article"]');
      if (article) {
        if (commentRow(article)) continue;
        root = article;
        for (
          let parent = root.parentElement?.closest('[role="article"]');
          parent;
          parent = root.parentElement?.closest('[role="article"]')
        )
          root = parent;
      } else {
        const feedUnit =
          seed.parentElement?.getAttribute('role') === 'feed'
            ? seed
            : seed.closest('[role="feed"] > *');
        if (!feedUnit || commentRow(feedUnit)) continue;
        root = feedUnit;
      }
    }
    roots.add(root);
  }
  const storyRoots = new Map<string | Element, Element>();
  for (const root of roots) {
    const card = cardFor(root);
    const story = obj(card?.props.story ?? card?.props.feedUnit);
    const key = text(story.__id ?? story.id) || root;
    const previous = storyRoots.get(key);
    if (!previous || root.contains(previous)) storyRoots.set(key, root);
  }
  const articles = Array.from(storyRoots.values()).slice(0, 60);
  const seenPostIds = new Set<string>();
  for (const article of articles) {
    const primaryCard = cardFor(article);
    const primaryStory = obj(primaryCard?.props.story ?? primaryCard?.props.feedUnit);
    const storyKey = text(primaryStory.__id ?? primaryStory.id);
    const primaryNative = storyKey ? relayRecord(article, storyKey) : {};
    const belongsToStory = (el: Element) => {
      if (commentRow(el)) return false;
      if (!primaryCard) return true;
      const owner = cardFor(el),
        story = obj(owner?.props.story ?? owner?.props.feedUnit);
      const key = text(story.__id ?? story.id);
      if (key) return key === storyKey;
      // React alternate trees may not share Fiber object identities. A native
      // main-feedback binding can still identify the same post's action bar.
      const feedback = text(
        obj(primaryNative.feedback).__ref ??
          obj(primaryStory.feedback).id ??
          obj(primaryStory.feedback).__id,
      );
      if (
        feedback &&
        chain(el, 100).some(
          (f) => text(obj(f.props.feedback).id ?? obj(f.props.feedback).__id) === feedback,
        )
      )
        return true;
      if (!owner) {
        const nearestArticle = el.closest('[role="article"]');
        if (
          nearestArticle &&
          nearestArticle !== article &&
          (!article.contains(nearestArticle) || commentRow(nearestArticle))
        )
          return false;
        if (
          feedback &&
          chain(el, 100).some((f) => {
            const fid = text(obj(f.props.feedback).id ?? obj(f.props.feedback).__id);
            return !!fid && fid !== feedback;
          })
        )
          return false;
        return true;
      }
      return false;
    };
    const links = Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href]'));
    const linkId = (raw: unknown): string | null => {
      if (typeof raw !== 'string') return null;
      try {
        const u = new URL(raw, location.href);
        if (u.origin !== 'https://www.facebook.com') return null;
        const m = /^\/groups\/([^/]+)\/(?:posts|permalink)\/(\d+)/.exec(u.pathname);
        if (
          m &&
          !groupIds.has((m[1] ?? '').toLowerCase()) &&
          m[1]?.toLowerCase() !== input.groupId.toLowerCase()
        )
          return null;
        const rawCandidate =
          m?.[2] ??
          /^\/reel\/(\d+)/i.exec(u.pathname)?.[1] ??
          u.searchParams.get('story_fbid') ??
          /pcb\.(\d+)/.exec(u.href)?.[1] ??
          /^\/(?!groups(?:\/|$))[^/]+\/(?:posts|videos|permalink)\/(\d+)/i.exec(u.pathname)?.[1] ??
          (/^\/(?:watch|video\.php)\/?$/i.test(u.pathname) ? u.searchParams.get('v') : null) ??
          (/^\/photo(?:\.php|\/)?$/i.test(u.pathname) ? u.searchParams.get('fbid') : null) ??
          null;
        return rawCandidate && /^\d+$/.test(rawCandidate) ? rawCandidate : null;
      } catch {
        return null;
      }
    };
    const existingPostId = article.getAttribute('data-wb-bumper-post');
    const storyPostId = text(primaryNative.post_id ?? primaryStory.post_id) || decodeId(storyKey);
    const candidatePostIds = new Set<string>();
    if (existingPostId && /^\d+$/.test(existingPostId)) candidatePostIds.add(existingPostId);
    if (storyPostId && /^\d+$/.test(storyPostId)) candidatePostIds.add(storyPostId);
    const controls = Array.from(
      article.querySelectorAll<HTMLElement>('[role="button"],button,[role="textbox"]'),
    );
    const frames = [
      article,
      ...links,
      ...controls,
      ...Array.from(article.querySelectorAll('span,abbr,time')).slice(0, 140),
    ]
      .filter(belongsToStory)
      .flatMap((el) => chain(el).map((f) => ({ ...f, element: el })));
    if (frames.some((f) => /CometFeedGlimmer/.test(f.name))) {
      loading = true;
      continue;
    }
    let postId: string | null = storyPostId && /^\d+$/.test(storyPostId) ? storyPostId : null,
      timeText = '',
      created: number | null = null,
      feedbackId: string | null =
        text(
          obj(primaryNative.feedback).__ref ??
            obj(primaryStory.feedback).id ??
            obj(primaryStory.feedback).__id,
        ) || null,
      liked = false,
      pinned = false;
    const keepTime = (value: unknown) => {
      const v = label(value).trim();
      if (v && age(v) !== null && !timeText) timeText = v;
    };
    let fallbackPhotoId: string | null = null;
    for (const link of links.filter(belongsToStory)) {
      const candidateId = linkId(link.href);
      if (candidateId) {
        candidatePostIds.add(candidateId);
        if (/\/photo(?:\.php|\/|\?)/i.test(link.href) && !/pcb\.\d+/.test(link.href)) {
          fallbackPhotoId ??= candidateId;
        } else {
          postId ??= candidateId;
        }
      }
      keepTime(link.getAttribute('aria-label'));
      keepTime(link.textContent);
    }
    if (fallbackPhotoId) candidatePostIds.add(fallbackPhotoId);
    postId ??= fallbackPhotoId;
    const timeSeen = new Set<unknown>();
    let timeBudget = 0;
    const findTime = (value: unknown, depth = 0) => {
      if (!record(value) || depth > 4 || timeBudget++ > 700 || timeSeen.has(value)) return;
      timeSeen.add(value);
      for (const [key, v] of Object.entries(value)) {
        if ((key === 'creation_time' || key === 'publish_time') && typeof v === 'number' && v > 0)
          created ??= v;
        else if (!/children|owner|environment|^return$|^type$/i.test(key)) findTime(v, depth + 1);
      }
    };
    findTime(primaryStory);
    findTime(primaryNative);
    for (const f of frames) {
      const p = f.props;
      if (/GHLLink|CometLink|FDSLink|BaseLink/.test(f.name)) {
        const fiberLinkId = linkId(p.href ?? obj(p.link).url);
        if (fiberLinkId) {
          candidatePostIds.add(fiberLinkId);
          postId ??= fiberLinkId;
        }
        keepTime(p.label);
        keepTime(p['aria-label']);
      }
      if (/Tooltip/.test(f.name)) keepTime(p.tooltip);
      if (p.isPinned === true || p.is_pinned === true || p.is_pinned_for_viewer === true)
        pinned = true;
      const group = p.groupID ?? obj(p['group$key']).__id;
      if (typeof group === 'string') groupIds.add(group.toLowerCase());
      const story = obj(p.story ?? p.feedUnit),
        native = typeof story.__id === 'string' ? relayRecord(f.element, story.__id) : {};
      if (/CometFeedUnitCard|CometFeedUnitErrorBoundary|CometFeedStory|UFIStory/.test(f.name)) {
        const storyDecodedId = decodeId(story.id ?? story.__id);
        if (storyDecodedId && /^\d+$/.test(storyDecodedId)) {
          candidatePostIds.add(storyDecodedId);
          postId ??= storyDecodedId;
        }
      }
      pinned ||=
        story.is_pinned === true ||
        native.is_pinned === true ||
        story.is_pinned_for_viewer === true;
      if (!primaryCard || text(story.__id ?? story.id) === storyKey) {
        findTime(story);
        findTime(native);
        if (typeof p.creation_time === 'number') created ??= p.creation_time;
      }
      if (/CometUFIReactButtonBase/.test(f.name)) {
        const fb = obj(p.feedback);
        feedbackId ??= text(fb.id ?? fb.__id) || null;
      }
    }
    const decodedFbId = decodeId(feedbackId);
    if (decodedFbId && /^\d+$/.test(decodedFbId)) {
      candidatePostIds.add(decodedFbId);
      postId ??= decodedFbId;
    }
    if (existingPostId && /^\d+$/.test(existingPostId)) candidatePostIds.add(existingPostId);
    if (postId && /^\d+$/.test(postId)) candidatePostIds.add(postId);
    if (input.targetPostId) {
      if (!candidatePostIds.has(input.targetPostId)) continue;
      postId = input.targetPostId;
    }
    if (!postId || !/^\d+$/.test(postId)) continue;
    if (seenPostIds.has(postId)) continue;
    seenPostIds.add(postId);
    const actorRefs = obj(primaryNative.actors).__refs;
    const primaryActorId = Array.isArray(actorRefs)
      ? text(actorRefs[0])
      : text(obj(Array.isArray(primaryStory.actors) ? primaryStory.actors[0] : null).id);
    const linkActorId = (a: HTMLAnchorElement) => {
      const u = new URL(a.href);
      const id = chain(a).find((f) => /ActorHovercard/.test(f.name))?.props.actorID;
      return typeof id === 'string'
        ? id
        : (/\/user\/([^/]+)/.exec(u.pathname)?.[1] ?? u.searchParams.get('id'));
    };
    const authorLinks = links
      .filter(belongsToStory)
      .filter(
        (a) =>
          (!primaryActorId || linkActorId(a) === primaryActorId) &&
          (/\/groups\/[^/]+\/user\/[^/]+|profile\.php\?id=\d+/.test(a.href) ||
            chain(a).some((f) => /ActorHovercard/.test(f.name))),
      );
    const author = authorLinks.find((a) => a.textContent?.trim()) ?? authorLinks[0];
    let authorId: string | null = primaryActorId || null;
    if (author) {
      const u = new URL(author.href);
      authorId ??= /\/user\/([^/]+)/.exec(u.pathname)?.[1] ?? u.searchParams.get('id');
      const id = chain(author).find((f) => /ActorHovercard/.test(f.name))?.props.actorID;
      if (!authorId && typeof id === 'string') authorId = id;
    }
    const aliases = authorLinks.flatMap((a) => {
      const u = new URL(a.href);
      return [
        /\/user\/([^/]+)/.exec(u.pathname)?.[1],
        /^\/([A-Za-z0-9._-]+)\/?$/.exec(u.pathname)?.[1],
      ].filter((v): v is string => !!v && v !== 'profile.php');
    });
    let like: HTMLElement | undefined,
      comment: HTMLElement | undefined,
      openComment: HTMLElement | undefined;
    for (const el of controls.filter(belongsToStory))
      for (const f of chain(el)) {
        const actionFeedbackId = text(
          obj(f.props.feedback).id ??
            obj(f.props.feedback).__id ??
            f.props.feedbackID ??
            f.props.feedbackId,
        );
        if (feedbackId && actionFeedbackId && actionFeedbackId !== feedbackId) continue;
        if (
          /CometUFIReactButtonBase/.test(f.name) &&
          el.matches('[role="button"],button') &&
          !chain(el).some((n) => /CometUFIComment/.test(n.name))
        ) {
          if (el.getAttribute('data-ad-rendering-role') === 'like_button' || !like) like = el;
          const fb = obj(f.props.feedback),
            native = feedbackId ? relayRecord(el, feedbackId) : {};
          liked ||=
            obj(fb.viewer_feedback_reaction_info).reaction_type != null ||
            f.props.isReacted === true ||
            f.props.selected === true ||
            f.props.isSelected === true ||
            f.props.pressed === true ||
            Object.entries(native).some(
              ([k, v]) =>
                (k === 'viewer_feedback_reaction_info' ||
                  k.startsWith('viewer_feedback_reaction_info(')) &&
                v != null,
            );
        }
        if (/CometUFICommentAction/.test(f.name) && el.matches('[role="button"],button'))
          openComment = el;
        if (
          /CometUFIComposerInputWithActionsForLexicalInner/.test(f.name) &&
          f.props.commentAction === 'ADD' &&
          el.matches('[role="textbox"][contenteditable="true"]') &&
          !el.closest('[role="banner"]') &&
          visible(el)
        )
          comment = el;
      }
    for (const el of controls.filter(belongsToStory)) {
      if (
        !comment &&
        el.matches(
          '[role="textbox"][contenteditable="true"],div[contenteditable="true"][data-lexical-editor="true"]',
        ) &&
        !el.closest('[role="banner"]') &&
        !commentRow(el) &&
        visible(el)
      ) {
        comment = el;
      }
      if (!el.matches('[role="button"],button') || commentRow(el)) continue;
      const hasConflictingFeedback =
        !!feedbackId &&
        chain(el).some((f) => {
          const fid = text(
            obj(f.props.feedback).id ??
              obj(f.props.feedback).__id ??
              f.props.feedbackID ??
              f.props.feedbackId,
          );
          return !!fid && fid !== feedbackId;
        });
      if (hasConflictingFeedback) continue;
      if (
        !like &&
        (el.getAttribute('data-ad-rendering-role') === 'like_button' ||
          !!el.querySelector('[data-ad-rendering-role="like_button"]'))
      )
        like = el;
      if (
        !openComment &&
        (el.getAttribute('data-ad-rendering-role') === 'comment_button' ||
          !!el.querySelector('[data-ad-rendering-role="comment_button"]'))
      )
        openComment = el;
    }
    if (!comment) {
      comment = Array.from(
        article.querySelectorAll<HTMLElement>(
          '[role="textbox"][contenteditable="true"],div[contenteditable="true"][data-lexical-editor="true"]',
        ),
      ).filter(
        (el) =>
          belongsToStory(el) && !el.closest('[role="banner"]') && !commentRow(el) && visible(el),
      )[0];
    }
    let matchedDialog: HTMLElement | undefined;
    if (!comment || !like || input.targetPostId === postId) {
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(
        (d) =>
          visible(d) &&
          !/notifications|通知|messenger|聊天/i.test(d.getAttribute('aria-label') ?? '') &&
          !d.hasAttribute('data-wb-bumper-welcome-dismiss') &&
          !d.querySelector('[data-wb-bumper-welcome-dismiss]'),
      );
      matchedDialog = dialogs
        .filter((d) => {
          const dialogLinks = Array.from(d.querySelectorAll<HTMLAnchorElement>('a[href]'));
          if (dialogLinks.some((a) => candidatePostIds.has(linkId(a.href) ?? ''))) return true;
          const dialogEls = [
            d,
            ...Array.from(
              d.querySelectorAll<HTMLElement>('[role="button"],button,[role="textbox"],a[href]'),
            ).slice(0, 80),
          ];
          if (
            dialogEls.some((el) =>
              chain(el).some((f) => {
                const fb = obj(f.props.feedback);
                const fid = text(fb.id ?? fb.__id ?? f.props.feedbackID ?? f.props.feedbackId);
                if (feedbackId && fid && fid === feedbackId) return true;
                const story = obj(f.props.story ?? f.props.feedUnit);
                const sid = decodeId(story.id ?? story.__id) || text(story.post_id);
                return !!sid && candidatePostIds.has(sid);
              }),
            )
          )
            return true;
          if (
            input.targetPostId === postId &&
            Array.from(
              d.querySelectorAll<HTMLElement>(
                '[role="textbox"][contenteditable="true"],div[contenteditable="true"][data-lexical-editor="true"]',
              ),
            ).filter((el) => !el.closest('[role="banner"]') && !commentRow(el) && visible(el))
              .length > 0
          )
            return true;
          return false;
        })
        .at(-1);
      if (matchedDialog) {
        if (!comment) {
          comment = Array.from(
            matchedDialog.querySelectorAll<HTMLElement>(
              '[role="textbox"][contenteditable="true"],div[contenteditable="true"][data-lexical-editor="true"]',
            ),
          ).filter((el) => !el.closest('[role="banner"]') && !commentRow(el) && visible(el))[0];
        }
        if (!like) {
          like =
            matchedDialog.querySelector<HTMLElement>(
              '[role="button"][data-ad-rendering-role="like_button"],button[data-ad-rendering-role="like_button"]',
            ) ??
            matchedDialog
              .querySelector<HTMLElement>('[data-ad-rendering-role="like_button"]')
              ?.closest<HTMLElement>('[role="button"],button') ??
            undefined;
        }
      }
    }
    article.setAttribute('data-wb-bumper-post', postId);
    if (like) {
      liked ||=
        like.getAttribute('aria-pressed') === 'true' ||
        /^(?:Remove\s+|Liked|取消赞|取消讚|已赞|已讚|Love|Care|Haha|Wow|Sad|Angry|大爱|大心|超愛|超爱|抱抱|加油|笑趴|哈|哇|心碎|心疼|呜|嗚|怒|အရမ်းကြိုက်တယ်|ဂရုစိုက်တယ်|ဟားဟား|ဝိုး|ဝမ်းနည်းတယ်|ဒေါသထွက်တယ်|Yêu\s*thích|Thương\s*thương|Buồn|Phẫn\s*nộ|รักเลย|ห่วงใย|ฮ่าๆ|ว้าว|เศร้า|โกรธ)/i.test(
          like.getAttribute('aria-label') ?? '',
        );
      like.setAttribute('data-wb-bumper-like', postId);
    }
    comment?.setAttribute('data-wb-bumper-comment', postId);
    openComment?.setAttribute('data-wb-bumper-open-comment', postId);
    const comments: BumperPost['comments'] = [];
    const commentContainers = [
      ...Array.from(article.querySelectorAll('[role="article"],li')),
      ...(matchedDialog ? Array.from(matchedDialog.querySelectorAll('[role="article"],li')) : []),
    ];
    for (const row of commentContainers) {
      const c = chain(row)
        .map((f) => obj(f.props.comment))
        .map((c) => (typeof c.__id === 'string' ? { ...relayRecord(row, c.__id), ...c } : c))
        .find((c) => typeof c.id === 'string' && typeof obj(c.body).text === 'string');
      if (c)
        comments.push({
          id: text(c.id),
          text: text(obj(c.body).text),
          authorId: text(obj(c.author).id ?? obj(c.author).__ref) || null,
        });
    }
    const stamp = Array.from(
      article.querySelectorAll<HTMLElement>('abbr[data-utime],time[datetime]'),
    ).find(belongsToStory);
    if (!created && stamp?.getAttribute('data-utime'))
      created = Number(stamp.getAttribute('data-utime'));
    keepTime(stamp?.getAttribute('datetime'));
    let authorAvatarUrl: string | null = primaryActorId
      ? actorAvatar(article, primaryActorId)
      : null;
    for (const link of authorLinks) {
      authorAvatarUrl ??= imageURL(link);
      if (authorAvatarUrl) break;
    }
    const candidateVideos = Array.from(article.querySelectorAll<HTMLVideoElement>('video')).filter(
      (v) => !commentRow(v),
    );
    const videoEl =
      candidateVideos.filter(belongsToStory).find(visible) ??
      candidateVideos.find(visible) ??
      candidateVideos.find(belongsToStory) ??
      candidateVideos[0];
    const hasVideoContainer =
      !!videoEl ||
      frames.some((f) => /CometVideoPlayer|VideoPlayer|TahoeVideo/i.test(f.name)) ||
      !!article.querySelector(
        '[data-pagelet*="video" i],[aria-label*="Play video" i],[aria-label*="播放视频"],[aria-label*="播放影片"],a[href*="/reel/"],a[href*="/videos/"],a[href*="/watch/"]',
      );
    let hasVideo = false,
      videoCurrentTime = 0,
      videoDuration: number | null = null,
      videoCSS: string | null = null;
    if (videoEl || hasVideoContainer) {
      hasVideo = true;
      if (videoEl) {
        videoEl.setAttribute('data-wb-bumper-video', postId);
        videoCSS = '[data-wb-bumper-video="' + postId + '"]';
        videoCurrentTime = Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : 0;
        videoDuration =
          Number.isFinite(videoEl.duration) && videoEl.duration > 0 ? videoEl.duration : null;
      }
    }
    const sourceEvidence =
      input.audit && posts.length < 3
        ? {
            frames: [
              {
                component: primaryCard?.name ?? null,
                storyId: storyKey,
                postId,
                nativePostId: primaryNative.post_id ?? null,
                nativeActorId: primaryActorId || null,
                feedbackId,
                creationTime: created,
                controls: controls.slice(0, 24).map((el) => ({
                  role: el.getAttribute('role'),
                  label: el.getAttribute('aria-label'),
                  renderingRole: el.getAttribute('data-ad-rendering-role'),
                  disabled: el.getAttribute('aria-disabled'),
                  html: el.outerHTML.slice(0, 1200),
                  belongs: belongsToStory(el),
                  commentRow: commentRow(el),
                  commentAncestors: chain(el)
                    .filter((f) => /CometUFIComment/.test(f.name))
                    .map((f) => f.name),
                  feedback: chain(el)
                    .filter((f) => /ReactButton|Reaction|UFI/.test(f.name))
                    .map((f) => ({
                      name: f.name,
                      keys: Object.keys(f.props).slice(0, 35),
                      feedback: {
                        id: obj(f.props.feedback).id ?? obj(f.props.feedback).__id ?? null,
                      },
                    }))
                    .slice(0, 12),
                })),
              },
            ],
            parents: [{ tag: article.tagName, role: article.getAttribute('role') }],
          }
        : undefined;
    posts.push({
      postId,
      ...(sourceEvidence ? { sourceEvidence } : {}),
      postUrl:
        input.groupId === '-'
          ? 'https://www.facebook.com/' +
            encodeURIComponent(input.pageId || authorId || 'facebook') +
            '/posts/' +
            postId +
            '/'
          : 'https://www.facebook.com/groups/' +
            encodeURIComponent(input.groupId) +
            '/posts/' +
            postId +
            '/',
      authorId:
        authorId ??
        (input.pageId && location.pathname.includes('/user/' + input.pageId + '/')
          ? input.pageId
          : null),
      authorName:
        (primaryActorId ? text(relayRecord(article, primaryActorId).name) : '') ||
        author?.textContent?.trim() ||
        '',
      authorAliases: aliases,
      authorAvatarUrl,
      pinned,
      ageHours: created ? Math.max(0, (Date.now() - created * 1000) / 3600000) : age(timeText),
      timeText,
      feedbackId,
      liked,
      postCSS: '[data-wb-bumper-post="' + postId + '"]',
      likeCSS: like ? '[data-wb-bumper-like="' + postId + '"]' : null,
      commentCSS: comment ? '[data-wb-bumper-comment="' + postId + '"]' : null,
      commentButtonCSS: openComment ? '[data-wb-bumper-open-comment="' + postId + '"]' : null,
      hasVideo,
      videoEnded: videoEl?.ended === true,
      videoPaused: videoEl?.paused ?? true,
      videoReadyState: videoEl?.readyState ?? 0,
      videoCurrentSrc: videoEl?.currentSrc ?? '',
      videoFrames: videoEl?.getVideoPlaybackQuality?.().totalVideoFrames ?? 0,
      videoCurrentTime,
      videoDuration,
      videoCSS,
      comments,
    });
  }
  const restricted = Array.from(document.querySelectorAll('[role="dialog"]'))
    .filter(visible)
    .some(
      (d) =>
        /Temporarily Blocked|暂时被禁止|限制了某些活动|restrict certain activity|Try Again Later|稍后再试/i.test(
          d.textContent ?? '',
        ) ||
        [d, ...Array.from(d.querySelectorAll('[role="button"],button'))].some((e) =>
          chain(e).some(
            (f) =>
              /GroupsCometFeatureInterventionDialog|Checkpoint|CometErrorDialog|SentryBlockDialog/.test(
                f.name,
              ) || JSON.stringify(f.props.testid ?? '').includes('feature-intervention-ok-button'),
          ),
        ),
    );
  let welcomeDismissCSS: string | null = null;
  if (!restricted) {
    for (const d of Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible)) {
      if (
        d.querySelector(
          '[role="checkbox"],[role="textbox"],textarea,input:not([type="hidden"]),[contenteditable="true"]',
        ) ||
        /notifications|通知|messenger|聊天/i.test(d.getAttribute('aria-label') ?? '')
      )
        continue;
      const buttons = Array.from(d.querySelectorAll<HTMLElement>('[role="button"],button')).filter(
        visible,
      );
      const isWelcomeDialog = /欢迎加入|歡迎加入|Welcome to|管理員團隊|管理员团队|Admin team/i.test(
        d.textContent ?? '',
      );
      const continueBtn = buttons.find((b) =>
        /^(?:继续|繼續|Continue|知道了|Got\s*it|OK|確定|确定)$/i.test(
          (b.getAttribute('aria-label') || b.textContent || '').trim(),
        ),
      );
      const explicitCloseBtn = buttons.find((b) =>
        /^(?:Close|关闭|關閉)$/i.test((b.getAttribute('aria-label') || '').trim()),
      );
      const closeBtn = isWelcomeDialog
        ? (continueBtn ?? explicitCloseBtn ?? buttons.at(-1))
        : (continueBtn ?? explicitCloseBtn);
      if (closeBtn) {
        closeBtn.setAttribute('data-wb-bumper-welcome-dismiss', '1');
        welcomeDismissCSS = '[data-wb-bumper-welcome-dismiss="1"]';
        break;
      }
    }
  }
  const outside = Array.from(
    document.querySelectorAll(
      'main img,main svg[role="img"],[role="main"] img,[role="main"] svg[role="img"]',
    ),
  ).filter((e) => !e.closest('[role="article"]') && !e.closest('[role="navigation"],nav'));
  const cover = document.querySelector(
    'img[data-imgperflogname="profileCoverPhoto"],a[aria-label*="Cover" i] img,a[aria-label*="封面"] img',
  );
  const avatarUrl =
    imageURL(cover) ??
    outside.map(imageURL).find(Boolean) ??
    document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content ??
    null;
  const pageAvatarUrl = input.pageId
    ? (posts.find(
        (p) => p.authorId === input.pageId || p.authorAliases.includes(input.pageId ?? ''),
      )?.authorAvatarUrl ??
      actorAvatar(
        document.querySelector('main,[role="main"]') ?? document.documentElement,
        input.pageId,
      ) ??
      Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .filter((a) => {
          try {
            const u = new URL(a.href);
            return (
              (u.origin === location.origin &&
                (/\/user\/([^/]+)/.exec(u.pathname)?.[1] === input.pageId ||
                  (u.pathname === '/profile.php' && u.searchParams.get('id') === input.pageId))) ||
              chain(a).some(
                (f) => /ActorHovercard/.test(f.name) && f.props.actorID === input.pageId,
              )
            );
          } catch {
            return false;
          }
        })
        .map(imageURL)
        .find(Boolean) ??
      null)
    : null;
  if (posts.length === 0 && !loading) {
    const hasProgress = Array.from(
      document.querySelectorAll('[role="progressbar"], [data-visualcompletion="loading-state"]'),
    ).some(visible);
    const hasEmptyFeed = !!document.querySelector('[role="feed"]') && articles.length === 0;
    if (hasProgress || hasEmptyFeed) {
      loading = true;
    }
  }
  const rawTitle =
    document.querySelector('main h1, [role="main"] h1')?.textContent?.trim() ||
    document
      .querySelector<HTMLMetaElement>('meta[property="og:title"]')
      ?.content?.replace(/\s*[|｜\-–—]\s*Facebook.*$/i, '')
      .trim() ||
    null;
  const groupTitle =
    rawTitle && !/^(?:Facebook|Log in|登录|登入|Groups|小组|社團)$/i.test(rawTitle)
      ? rawTitle
      : null;
  return {
    url: location.href,
    groupIds: [...groupIds],
    pageIds: [...pageIds],
    groupTitle,
    avatarUrl,
    pageAvatarUrl,
    ready:
      document.readyState !== 'loading' &&
      (posts.length > 0 || !!document.querySelector('main,[role="main"]')),
    visible: document.visibilityState === 'visible',
    restricted,
    loading,
    groupEntryCSS,
    groupEntryMatchedBy,
    joinGroupCSS,
    welcomeDismissCSS,
    posts,
  };
}
export async function readGroupBumper(
  page: Page,
  input: {
    groupId: string;
    pageId?: string;
    groupName?: string;
    pageName?: string;
    targetPostId?: string;
    audit?: boolean;
  },
): Promise<BumperSurface> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const state = await page.evaluate(projectGroupBumper, input);
      return {
        ...state,
        posts: state.posts.map((p) => ({
          ...p,
          ageHours: p.ageHours ?? relativePostAge(p.timeText),
        })),
      };
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        attempt < 2 &&
        /Cannot find context with specified id|Execution context was destroyed|Execution context is not available/i.test(
          msg,
        )
      ) {
        await new Promise<void>((r) => setTimeout(r, 300));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
