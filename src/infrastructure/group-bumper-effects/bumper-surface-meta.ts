import type { BumperSurface, ProjectGroupBumperInput } from '../group-bumper-effects.js';
import type { DomEvalRuntime, DomFiberFrame, DOMRecord } from '../shared-dom-eval-runtime.js';
export type RecordValue = DOMRecord;
export type FiberFrame = DomFiberFrame;
export interface BumperDomRuntime extends DomEvalRuntime {
  label: (v: unknown, depth?: number) => string;
  age: (value: string) => number | null;
  decodeId: (id: unknown) => string | null;
  reactionValue: (root: Element, value: unknown, depth?: number) => 'active' | 'none' | 'unknown';
  imageURL: (root: Element | null) => string | null;
  actorAvatar: (root: Element, actorId: string) => string | null;
  groupIds: Set<string>;
  pageIds: Set<string>;
  reservedPageSegment: RegExp;
  currentGroupIds: Set<string>;
  groupRefMatches: (props: RecordValue) => boolean;
  cardFor: (el: Element) => FiberFrame | undefined;
  isTopLevelCommentEditor: (el: Element) => boolean;
  commentRow: (el: Element) => boolean;
}
export function createBumperDomRuntime(
  createDomRt: () => DomEvalRuntime,
  input: ProjectGroupBumperInput,
): BumperDomRuntime {
  const domRt = createDomRt();
  const { record, obj, text, chain, relayRecord, clearDataAttrs } = domRt;
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
    if (/^(?:just now|刚刚|剛剛|vừa xong|เมื่อสักครู่|ယခုလေးတင်)$/u.test(v)) return 0;
    if (/^(?:yesterday|昨天|hôm qua|เมื่อวาน|မနေ့က)$/u.test(v)) return 24;
    const m =
      /^(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|分钟|分鐘|phút|นาที|မိနစ်|hours?|h|小时|小時|giờ|ชั่วโมง|နာရီ|days?|d|天|ngày|วัน|ရက်)(?:\b|$)/u.exec(
        v,
      );
    if (m)
      return (
        Number(m[1]) *
        (/^(?:m|分钟|分鐘|phút|นาที|မိနစ်)/u.test(m[2] ?? '')
          ? 1 / 60
          : /^(?:h|小时|小時|giờ|ชั่วโมง|နာရီ)/u.test(m[2] ?? '')
            ? 1
            : 24)
      );
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
  const reactionValue = (
    root: Element,
    value: unknown,
    depth = 0,
  ): 'active' | 'none' | 'unknown' => {
    if (value === null) return 'none';
    if (!record(value) || depth > 3) return 'unknown';
    if (typeof value.__ref === 'string')
      return reactionValue(root, relayRecord(root, value.__ref), depth + 1);
    const id = text(value.id ?? obj(value.reaction).id);
    if (value.reaction_type === 0 || id === '0') return 'none';
    if (
      /^[1-9]\d*$/.test(id) ||
      (typeof value.reaction_type === 'number' && value.reaction_type > 0)
    )
      return 'active';
    return 'unknown';
  };
  const imageURL = (root: Element | null): string | null => {
    if (!root) return null;
    for (const node of [root, ...Array.from(root.querySelectorAll('img,image,svg')).slice(0, 40)]) {
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
      if (seg && !reservedPageSegment.test(seg)) pageIds.add(decodeURIComponent(seg).toLowerCase());
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
      if (slug && slug.toLowerCase() !== 'profile.php' && !reservedPageSegment.test(slug))
        pageIds.add(decodeURIComponent(slug).toLowerCase());
    }
  }
  clearDataAttrs([
    'data-wb-bumper-group',
    'data-wb-bumper-welcome-dismiss',
    'data-wb-bumper-join',
    'data-wb-bumper-join-dismiss',
  ]);
  const currentGroupIds = new Set([input.groupId.toLowerCase(), ...groupIds]);
  const groupRefMatches = (props: RecordValue) =>
    [
      props.groupID,
      props.groupId,
      obj(props.group).id,
      obj(props.group).__id,
      obj(props['group$key']).__id,
    ].some((id) => typeof id === 'string' && currentGroupIds.has(id.toLowerCase()));
  const cards = new WeakMap<Element, FiberFrame | null>();
  const cardFor = (el: Element) => {
    if (cards.has(el)) return cards.get(el) ?? undefined;
    const frames = chain(el, 256);
    const fullCard = (rows: typeof frames) =>
      rows.find(
        (f) =>
          /CometFeedUnitCard|CometFeedUnitErrorBoundary/.test(f.name) &&
          record(f.props.story ?? f.props.feedUnit),
      );
    let card = fullCard(frames);
    const logger = frames.find(
      (f) => /CometFeedStoryClickLoggerContainer/.test(f.name) && record(f.props.story),
    );
    if (card && logger && frames.indexOf(logger) < frames.indexOf(card)) {
      const a = obj(card.props.story ?? card.props.feedUnit);
      const b = obj(logger.props.story);
      if (text(a.__id ?? a.id ?? a.post_id) !== text(b.__id ?? b.id ?? b.post_id)) card = undefined;
    }
    if (!card && logger) {
      const story = obj(logger.props.story);
      const storyId = text(story.__id ?? story.id ?? story.post_id);
      for (
        let d = 0, parent = el.parentElement;
        storyId && parent && d < 8;
        d++, parent = parent.parentElement
      ) {
        const candidate = fullCard(chain(parent, 256));
        const candidateStory = obj(candidate?.props.story ?? candidate?.props.feedUnit);
        if (
          candidate &&
          text(candidateStory.__id ?? candidateStory.id ?? candidateStory.post_id) === storyId
        ) {
          card = candidate;
          break;
        }
      }
    }
    card ??= logger;
    cards.set(el, card ?? null);
    return card;
  };
  const isTopLevelCommentEditor = (el: Element) => {
    if (
      !el.matches(
        '[role="textbox"][contenteditable="true"],div[contenteditable="true"][data-lexical-editor="true"],textarea',
      ) ||
      el.closest('[role="banner"]')
    )
      return false;
    const frames = chain(el, 100);
    if (
      frames.some(
        (f) =>
          /CometUFICommentRow|CometUFICommentWrapper/.test(f.name) &&
          (record(f.props.comment) || (typeof f.props.depth === 'number' && f.props.depth > 0)),
      )
    )
      return false;
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
  return {
    ...domRt,
    label,
    age,
    decodeId,
    reactionValue,
    imageURL,
    actorAvatar,
    groupIds,
    pageIds,
    reservedPageSegment,
    currentGroupIds,
    groupRefMatches,
    cardFor,
    isTopLevelCommentEditor,
    commentRow,
  };
}
export function discoverJoinAndSearchEntry(rt: BumperDomRuntime, input: ProjectGroupBumperInput) {
  const {
    obj,
    text,
    visible,
    ancestorsVisible,
    chain,
    decodeId,
    relayRecord,
    reservedPageSegment,
    currentGroupIds,
  } = rt;
  let groupEntryCSS: string | null = null;
  let groupEntryMatchedBy: 'id' | 'name' | null = null;
  let joinGroupCSS: string | null = null;
  let groupJoinState: NonNullable<BumperSurface['groupJoinState']> = 'unknown';
  if (/^\/groups\/(?!search(?:\/|$))[^/]+/i.test(location.pathname)) {
    const headers = Array.from(
      document.querySelectorAll<HTMLElement>(
        'main h1,[role="main"] h1,main [role="button"],main button,[role="main"] [role="button"],[role="main"] button',
      ),
    ).filter(
      (el) =>
        visible(el) &&
        ancestorsVisible(el) &&
        !el.closest('[role="feed"],[role="article"],[role="dialog"],[role="navigation"],nav'),
    );
    const joinCandidates: HTMLElement[] = [];
    for (const el of headers) {
      for (const gid of currentGroupIds) {
        const native = relayRecord(el, gid);
        if (native.__typename !== 'Group' || (native.id !== gid && native.__id !== gid)) continue;
        const state = text(native.viewer_join_state);
        if (state === 'MEMBER') groupJoinState = 'member';
        else if (groupJoinState !== 'member' && /PENDING|REQUESTED/.test(state))
          groupJoinState = 'pending';
        else if (groupJoinState === 'unknown' && state === 'CAN_JOIN') groupJoinState = 'can-join';
      }
      if (
        !el.matches('[role="button"],button') ||
        el.getAttribute('aria-disabled') === 'true' ||
        el.hasAttribute('disabled')
      )
        continue;
      for (const f of chain(el, 70)) {
        const marker = text(f.props.testid ?? f.props['data-testid']);
        const matchedId = /^group-can-join-(\d+)$/.exec(marker)?.[1];
        const actionGroup = /^client:(\d+):join_action\(/.exec(text(obj(f.props.action).__id))?.[1];
        if (
          /GroupsCometJoinForumButton/.test(f.name) &&
          ((matchedId && currentGroupIds.has(matchedId)) ||
            (actionGroup && currentGroupIds.has(actionGroup)))
        )
          joinCandidates.push(el);
      }
    }
    if (groupJoinState === 'unknown' && joinCandidates.length) groupJoinState = 'can-join';
    if (groupJoinState === 'can-join') {
      const joinBtn =
        joinCandidates.find((el) => el.getBoundingClientRect().top >= 160) ?? joinCandidates[0];
      if (joinBtn) {
        joinBtn.setAttribute('data-wb-bumper-join', '1');
        joinGroupCSS = '[data-wb-bumper-join="1"]';
      }
    }
  }
  if (/\/groups\/search|\/search/.test(location.pathname)) {
    const pageMode = input.groupId === '-' && !!input.pageId;
    const reservedPagePath =
      /^\/(?:search|groups|watch|marketplace|gaming|friends|bookmarks|notifications|messages|events|memories|saved|settings|help|login|checkpoint|reel|reels|stories|photo|photos|videos|permalink|posts|hashtag|share|l\.php)\/?$/i;
    const targetId = pageMode ? (input.pageId ?? '') : input.groupId;
    const nameKey = (pageMode ? input.pageName : input.groupName)?.trim();
    const matchNameKey = nameKey && nameKey !== targetId ? nameKey.toLowerCase() : null;
    const addEntityIds = (set: Set<string>, entity: RecordValue) => {
      const decoded = typeof entity.__id === 'string' ? decodeId(entity.__id) : null;
      for (const c of [entity.id, entity.__id, decoded])
        if (typeof c === 'string' && c.trim()) set.add(c.trim().toLowerCase());
    };
    let nameMatched: HTMLAnchorElement | null = null;
    let idMatched: HTMLAnchorElement | null = null;
    for (const link of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).filter(
      (l) => visible(l),
    )) {
      let u: URL;
      try {
        u = new URL(link.href);
      } catch {
        continue;
      }
      if (u.origin !== 'https://www.facebook.com') continue;
      const linkText = (link.textContent ?? '').trim().toLowerCase();
      const linkIds = new Set<string>();
      if (pageMode) {
        if (!(
          (u.pathname === '/profile.php' && !!u.searchParams.get('id')) ||
          (/^\/[^/]+\/?$/.test(u.pathname) && !reservedPagePath.test(u.pathname))
        ))
          continue;
        if (u.pathname === '/profile.php') {
          const qid = u.searchParams.get('id');
          if (qid) linkIds.add(qid.toLowerCase());
        } else {
          const seg = /^\/([^/]+)\/?$/.exec(u.pathname)?.[1];
          if (seg && !reservedPageSegment.test(seg))
            linkIds.add(decodeURIComponent(seg).toLowerCase());
        }
        for (const f of chain(link, 48)) {
          if (
            /ActorHovercard/.test(f.name) &&
            typeof f.props.actorID === 'string' &&
            f.props.actorID.trim()
          )
            linkIds.add(f.props.actorID.trim().toLowerCase());
          addEntityIds(
            linkIds,
            obj(
              f.props.page ??
                f.props.profile ??
                f.props.user ??
                f.props.entity ??
                f.props.actor ??
                f.props.node ??
                f.props['page$key'] ??
                f.props['profile$key'],
            ),
          );
        }
      } else {
        if (!/^\/groups\/(?!search(?:\/|$))[^/]+\/?$/i.test(u.pathname)) continue;
        const seg = /^\/groups\/([^/]+)\/?$/i.exec(u.pathname)?.[1];
        if (seg) linkIds.add(decodeURIComponent(seg).toLowerCase());
        for (const f of chain(link, 48)) {
          const entity = obj(f.props.group ?? f.props.entity ?? f.props['group$key']);
          if (
            entity.__typename === 'Group' ||
            /Group/.test(f.name) ||
            f.props.group != null ||
            f.props['group$key'] != null
          )
            addEntityIds(linkIds, entity);
        }
      }
      if (linkIds.has(targetId.toLowerCase())) {
        idMatched = link;
        break;
      }
      const numericIds = [...linkIds].filter((x) => /^\d+$/.test(x));
      if (/^\d+$/.test(targetId) && numericIds.length > 0 && !numericIds.includes(targetId))
        continue;
      if (!nameMatched && matchNameKey && linkText === matchNameKey) nameMatched = link;
    }
    const entryLink = idMatched ?? nameMatched;
    if (entryLink) {
      entryLink.setAttribute('data-wb-bumper-group', '1');
      groupEntryCSS = '[data-wb-bumper-group="1"]';
      groupEntryMatchedBy = idMatched ? 'id' : 'name';
    }
  }
  return { groupEntryCSS, groupEntryMatchedBy, joinGroupCSS, groupJoinState };
}
export function inspectBumperDialogsAndMeta(
  rt: BumperDomRuntime,
  input: ProjectGroupBumperInput,
  posts: {
    feedbackId: string | null;
    authorId: string | null;
    authorAliases: string[];
    authorAvatarUrl: string | null;
  }[],
  articlesLength: number,
  initialGroupJoinState: NonNullable<BumperSurface['groupJoinState']>,
  initialLoading: boolean,
) {
  const { record, obj, text, visible, chain, imageURL, actorAvatar, groupRefMatches } = rt;
  let groupJoinState = initialGroupJoinState;
  let loading = initialLoading;
  let restrictionReason: string | undefined;
  if (posts.length === 0) {
    const mainText =
      document.querySelector('main,[role="main"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    for (const script of Array.from(document.querySelectorAll('script[type="application/json"]'))) {
      const raw = script.textContent ?? '';
      if (!raw.includes('CometErrorRoot.react') || !raw.includes('comet.error')) continue;
      try {
        const stack: unknown[] = [JSON.parse(raw)];
        for (let budget = 25000; stack.length && budget-- > 0;) {
          const item = stack.pop();
          if (!record(item)) continue;
          const view = obj(item.rootView);
          const props = obj(view.props);
          if (
            item.tracePolicy === 'comet.error' &&
            obj(view.resource).__dr === 'CometErrorRoot.react'
          ) {
            const title = text(props.title);
            const body = text(props.body);
            const routeURL = text(item.url);
            if (
              (!routeURL || new URL(routeURL, location.href).href === location.href) &&
              title &&
              body &&
              mainText.includes(title) &&
              mainText.includes(body)
            )
              restrictionReason = title + ' · ' + body;
          }
          stack.push(...Object.values(item).filter((v) => v && typeof v === 'object'));
        }
      } catch {}
      if (restrictionReason) break;
    }
  }
  const visibleDialogs = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"],[role="alertdialog"],[aria-modal="true"]',
    ),
  ).filter((d) => visible(d));
  let checkpointRestricted = /^\/checkpoint(?:\/|\.php|$)/i.test(location.pathname);
  let joinRestrictionDismissCSS: string | null = null;
  const markJoinDismiss = (el: HTMLElement | undefined) => {
    if (!el || joinRestrictionDismissCSS) return;
    el.setAttribute('data-wb-bumper-join-dismiss', '1');
    joinRestrictionDismissCSS = '[data-wb-bumper-join-dismiss="1"]';
  };
  const restrictedDialogs = visibleDialogs.filter((d) => {
    let matched = !!d.querySelector('[data-testid="feature-intervention-ok-button"]');
    for (const e of [d, ...Array.from(d.querySelectorAll('[role="button"],button'))]) {
      for (const f of chain(e)) {
        if (/Checkpoint/.test(f.name)) {
          checkpointRestricted = true;
          matched = true;
        } else if (
          /GroupsCometFeatureInterventionDialog|CometErrorDialog|SentryBlockDialog/.test(f.name) ||
          JSON.stringify(f.props.testid ?? '').includes('feature-intervention-ok-button')
        )
          matched = true;
      }
    }
    return matched;
  });
  const restricted = !!restrictionReason || restrictedDialogs.length > 0;
  const actionButtonsIn = (root: Element) =>
    Array.from(root.querySelectorAll<HTMLElement>('[role="button"],button')).filter(
      (el) =>
        visible(el) &&
        !el.matches('a[href]') &&
        !el.closest('a[href]') &&
        el.getAttribute('aria-disabled') !== 'true' &&
        !el.hasAttribute('disabled'),
    );
  const hasFdsBtnType = (el: HTMLElement, btnType: 'primary' | 'secondary', maxDepth = 25) =>
    chain(el, maxDepth).some((f) => /FDSButton/.test(f.name) && f.props.type === btnType);
  if (!checkpointRestricted && !restrictionReason && restrictedDialogs[0]) {
    const btns = actionButtonsIn(restrictedDialogs[0]);
    markJoinDismiss(
      btns.find((el) => chain(el, 28).some((f) => /FDSCircleButton/.test(f.name))) ??
        btns.find(
          (el) =>
            el.getAttribute('data-testid') === 'feature-intervention-ok-button' ||
            hasFdsBtnType(el, 'primary', 28) ||
            hasFdsBtnType(el, 'secondary', 28) ||
            chain(el, 28).some((f) =>
              JSON.stringify(f.props.testid ?? '').includes('feature-intervention-ok-button'),
            ),
        ) ??
        btns.at(-1),
    );
  }
  let welcomeDismissCSS: string | null = null;
  let blockingDialog = false;
  if (!restricted) {
    for (const d of visibleDialogs) {
      const rect = d.getBoundingClientRect();
      const vw = window.innerWidth || 1024,
        vh = window.innerHeight || 768;
      const center =
        rect.left < vw * 0.5 &&
        rect.right > vw * 0.5 &&
        rect.top < vh * 0.5 &&
        rect.bottom > vh * 0.5;
      if (
        d.getAttribute('aria-modal') !== 'true' &&
        d.getAttribute('role') !== 'alertdialog' &&
        !center
      )
        continue;
      const fChain = [
        d,
        ...Array.from(
          d.querySelectorAll<HTMLElement>('[role="button"],button,[role="textbox"]'),
        ).slice(0, 120),
      ].flatMap((el) => chain(el, 90));
      if (
        fChain.some((f) => {
          const fb = obj(f.props.feedback);
          const fid = text(fb.id ?? fb.__id ?? f.props.feedbackID);
          return !!fid && posts.some((p) => p.feedbackId === fid);
        })
      )
        continue;
      const fields = !!d.querySelector(
        '[role="textbox"],textarea,input:not([type="hidden"]),[role="checkbox"],[role="radio"],[contenteditable="true"]',
      );
      const sameGroup = fChain.some((f) => groupRefMatches(f.props));
      if (
        fChain.some((f) => /Groups.*MembershipQuestions/.test(f.name)) ||
        (fields && sameGroup && groupJoinState !== 'member')
      )
        groupJoinState = 'questions';
      blockingDialog = true;
      const buttons = actionButtonsIn(d);
      const close = buttons.filter((el) => {
        const r = el.getBoundingClientRect();
        return (
          r.top >= rect.top - 4 &&
          r.top - rect.top <= 80 &&
          (Math.abs(r.left - rect.left) <= 80 || Math.abs(r.right - rect.right) <= 80) &&
          chain(el, 30).some((f) => /FDSCircleButton/.test(f.name))
        );
      });
      if (fields || groupJoinState === 'questions') {
        if (close.length === 1) markJoinDismiss(close[0]);
        continue;
      }
      const primary = buttons.filter((el) => hasFdsBtnType(el, 'primary'));
      const secondary = buttons.filter((el) => hasFdsBtnType(el, 'secondary'));
      const target =
        close.length === 1
          ? close[0]
          : sameGroup && groupJoinState === 'member' && primary.length === 1
            ? primary[0]
            : undefined;
      if (target) {
        target.setAttribute('data-wb-bumper-welcome-dismiss', '1');
        welcomeDismissCSS = '[data-wb-bumper-welcome-dismiss="1"]';
        break;
      }
      markJoinDismiss(close[0] ?? (primary.length === 1 ? primary[0] : undefined) ?? secondary[0]);
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
    ).some((el) => visible(el));
    if (hasProgress || (!!document.querySelector('[role="feed"]') && articlesLength === 0))
      loading = true;
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
    restricted,
    checkpointRestricted,
    restrictionReason,
    joinRestrictionDismissCSS,
    welcomeDismissCSS,
    blockingDialog,
    groupJoinState,
    avatarUrl,
    pageAvatarUrl,
    loading,
    groupTitle,
  };
}
