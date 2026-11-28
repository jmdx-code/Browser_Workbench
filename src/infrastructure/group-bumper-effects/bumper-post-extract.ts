import type { BumperPost, ProjectGroupBumperInput } from '../group-bumper-effects.js';
import type { BumperMarkerAttr, extractBumperPostControls } from './bumper-post-controls.js';
import type { BumperDomRuntime, RecordValue } from './bumper-surface-meta.js';
export interface BumperStoryRootsCollection {
  singleDialogs: Map<Element, { story: RecordValue; key: string }>;
  articles: Element[];
}
export function collectBumperStoryRoots(
  rt: BumperDomRuntime,
  input: ProjectGroupBumperInput,
): BumperStoryRootsCollection {
  const { obj, text, visible, chain, relayCache, cardFor, commentRow } = rt;
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
          let p = root.parentElement?.closest('[role="article"]');
          p;
          p = root.parentElement?.closest('[role="article"]')
        )
          root = p;
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
  const singleDialogs = new Map<Element, { story: RecordValue; key: string }>();
  for (const dialog of Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(
    (d) => visible(d),
  )) {
    for (const element of [
      dialog,
      ...Array.from(dialog.querySelectorAll('[role="button"],[role="textbox"],a[href]')).slice(
        0,
        100,
      ),
    ]) {
      const frame = chain(element, 256).find((f) => /CometSinglePostDialogRoot/.test(f.name));
      const query = obj(obj(frame?.props.queries).singlePostDialogRootQueryReference);
      const key = text(obj(query.variables).storyID);
      const env = obj(query.environment);
      if (!key || typeof env.getStore !== 'function') continue;
      try {
        const store = obj(Reflect.apply(env.getStore, env, []));
        const source = obj(
          typeof store.getSource === 'function' ? Reflect.apply(store.getSource, store, []) : null,
        );
        if (typeof source.get !== 'function') continue;
        const story = obj(Reflect.apply(source.get, source, [key]));
        const id = text(story.post_id);
        if (!/^\d+$/.test(id) || (input.targetPostId && id !== input.targetPostId)) continue;
        singleDialogs.set(dialog, { story, key });
        dialog.setAttribute('data-wb-bumper-post-dialog', id);
        relayCache.set(key, story);
        const refs = obj(story.actors).__refs;
        for (const refId of [
          text(obj(story.feedback).__ref),
          ...(Array.isArray(refs) ? refs.filter((v): v is string => typeof v === 'string') : []),
        ])
          if (refId) relayCache.set(refId, obj(Reflect.apply(source.get, source, [refId])));
        roots.add(dialog);
        break;
      } catch {}
    }
  }
  const storyRoots = new Map<string | Element, Element>();
  for (const root of roots) {
    const card = cardFor(root);
    const single = singleDialogs.get(root);
    const story = single?.story ?? obj(card?.props.story ?? card?.props.feedUnit);
    const key = single?.key ?? (text(story.__id ?? story.id) || root);
    const previous = storyRoots.get(key);
    if (
      !previous ||
      (singleDialogs.has(root) && !singleDialogs.has(previous)) ||
      (singleDialogs.has(root) === singleDialogs.has(previous) && root.contains(previous))
    )
      storyRoots.set(key, root);
  }
  return { singleDialogs, articles: Array.from(storyRoots.values()).slice(0, 60) };
}
export function extractBumperPosts(
  rt: BumperDomRuntime,
  input: ProjectGroupBumperInput,
  rootsInfo: BumperStoryRootsCollection,
  extractControls: typeof extractBumperPostControls,
): { posts: BumperPost[]; loading: boolean } {
  const {
    record,
    obj,
    text,
    chain,
    label,
    age,
    decodeId,
    relayRecord,
    imageURL,
    actorAvatar,
    groupIds,
    cardFor,
    commentRow,
  } = rt;
  const { singleDialogs, articles } = rootsInfo;
  const posts: BumperPost[] = [];
  let loading = false;
  const markerFields = {
    'data-wb-bumper-post': 'postCSS',
    'data-wb-bumper-like': 'likeCSS',
    'data-wb-bumper-comment': 'commentCSS',
    'data-wb-bumper-open-comment': 'commentButtonCSS',
    'data-wb-bumper-share': 'shareCSS',
    'data-wb-bumper-video': 'videoCSS',
    'data-wb-bumper-video-play': 'videoPlayCSS',
    'data-wb-bumper-video-audio': 'videoAudioCSS',
  } as const;
  type Marker = keyof typeof markerFields;
  const marks = new Map<Element, Map<Marker, { id: string | null; rank: number }>>();
  const mark = (el: Element | undefined, attr: BumperMarkerAttr, id: string, rank: number) => {
    if (!el?.isConnected) return;
    let entries = marks.get(el);
    if (!entries) marks.set(el, (entries = new Map()));
    const previous = entries.get(attr);
    if (!previous || rank > previous.rank) entries.set(attr, { id, rank });
    else if (previous.id !== id && rank === previous.rank) entries.set(attr, { id: null, rank });
  };
  const seenPostIds = new Set<string>(),
    fbId = (fb: RecordValue) => text(fb.id ?? fb.__id),
    fbFromNative = (native: RecordValue, story: RecordValue) =>
      text(obj(native.feedback).__ref) || fbId(obj(story.feedback)),
    fbFromProps = (p: RecordValue) => fbId(obj(p.feedback)) || text(p.feedbackID ?? p.feedbackId);
  for (const article of articles) {
    const single = singleDialogs.get(article);
    if (input.targetPostId && singleDialogs.size && !single) continue;
    const primaryCard = single ? undefined : cardFor(article);
    const primaryStory =
      single?.story ?? obj(primaryCard?.props.story ?? primaryCard?.props.feedUnit);
    const storyKey = single?.key ?? text(primaryStory.__id ?? primaryStory.id);
    const primaryNative = single?.story ?? (storyKey ? relayRecord(article, storyKey) : {});
    const belongsToStory = (el: Element) => {
      if (commentRow(el)) return false;
      if (single) {
        const feedback = text(obj(primaryNative.feedback).__ref);
        const bindings = chain(el, 100)
          .map((f) => fbFromProps(f.props))
          .filter(Boolean);
        if (bindings.length) return !!feedback && bindings[0] === feedback;
        const owner = cardFor(el);
        const story = obj(owner?.props.story ?? owner?.props.feedUnit);
        const key = text(story.__id ?? story.id);
        return !key || key === storyKey;
      }
      if (!primaryCard) {
        if (cardFor(el)) return false;
        const nested = el.closest('[role="article"]');
        return !(nested && nested !== article && article.contains(nested));
      }
      const owner = cardFor(el);
      const story = obj(owner?.props.story ?? owner?.props.feedUnit);
      const key = text(story.__id ?? story.id);
      if (key) return key === storyKey;
      const feedback = fbFromNative(primaryNative, primaryStory);
      if (feedback && chain(el, 100).some((f) => fbId(obj(f.props.feedback)) === feedback))
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
            const fid = fbId(obj(f.props.feedback));
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
      .flatMap((el) => {
        const rows = chain(el);
        const boundary = primaryCard ? rows.findIndex((f) => f.fiber === primaryCard.fiber) : -1;
        return (boundary < 0 ? rows : rows.slice(0, boundary + 1)).map((f) => ({
          ...f,
          element: el,
        }));
      });
    if (frames.some((f) => /CometFeedGlimmer/.test(f.name))) {
      loading = true;
      continue;
    }
    let postId: string | null = storyPostId && /^\d+$/.test(storyPostId) ? storyPostId : null;
    let timeText = '';
    let created: number | null = null;
    let feedbackId: string | null = fbFromNative(primaryNative, primaryStory) || null;
    let pinned = false;
    const keepTime = (value: unknown) => {
      const v = label(value).trim();
      if (v && age(v) !== null && !timeText) timeText = v;
    };
    let fallbackPhotoId: string | null = null;
    for (const link of links.filter(belongsToStory)) {
      const candidateId = linkId(link.href);
      if (candidateId) {
        candidatePostIds.add(candidateId);
        if (/\/photo(?:\.php|\/|\?)/i.test(link.href) && !/pcb\.\d+/.test(link.href))
          fallbackPhotoId ??= candidateId;
        else postId ??= candidateId;
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
      const story = obj(p.story ?? p.feedUnit);
      const native = typeof story.__id === 'string' ? relayRecord(f.element, story.__id) : {};
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
      if (/CometUFIReactButtonBase/.test(f.name)) feedbackId ??= fbId(obj(p.feedback)) || null;
    }
    const decodedFbId = decodeId(feedbackId);
    if (decodedFbId && /^\d+$/.test(decodedFbId)) {
      candidatePostIds.add(decodedFbId);
      if (!storyPostId) postId = decodedFbId;
    }
    if (existingPostId && /^\d+$/.test(existingPostId)) candidatePostIds.add(existingPostId);
    if (postId && /^\d+$/.test(postId)) candidatePostIds.add(postId);
    if (input.targetPostId && postId !== input.targetPostId) continue;
    if (!postId || !/^\d+$/.test(postId) || seenPostIds.has(postId)) continue;
    seenPostIds.add(postId);
    const actorRefs = obj(primaryNative.actors).__refs;
    const primaryActorId = Array.isArray(actorRefs)
      ? text(actorRefs[0])
      : text(obj(Array.isArray(primaryStory.actors) ? primaryStory.actors[0] : null).id);
    const linkActorId = (a: HTMLAnchorElement) => {
      const id = chain(a).find((f) => /ActorHovercard/.test(f.name))?.props.actorID;
      if (typeof id === 'string') return id;
      const u = new URL(a.href);
      return /\/user\/([^/]+)/.exec(u.pathname)?.[1] ?? u.searchParams.get('id');
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
    const authorId: string | null = primaryActorId || (author ? linkActorId(author) : null);
    const aliases = authorLinks.flatMap((a) => {
      const u = new URL(a.href);
      return [
        /\/user\/([^/]+)/.exec(u.pathname)?.[1],
        /^\/([A-Za-z0-9._-]+)\/?$/.exec(u.pathname)?.[1],
      ].filter((v): v is string => !!v && v !== 'profile.php');
    });
    const isCompleteFeedUnitCard = Boolean(
      primaryCard && /CometFeedUnitCard|CometFeedUnitErrorBoundary/.test(primaryCard.name),
    );
    const markerRank = single ? 4 : isCompleteFeedUnitCard ? 3 : primaryCard ? 2 : 1;
    const ctl = extractControls(rt, {
      article,
      controls,
      frames,
      single,
      primaryCard,
      storyKey,
      postId,
      feedbackId,
      targetPostId: input.targetPostId,
      markerRank,
      belongsToStory,
      mark,
    });
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
    posts.push({
      postId,
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
      authorId,
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
      liked: ctl.liked,
      reactionState: ctl.reactionState,
      postCSS: '[data-wb-bumper-post="' + postId + '"]',
      likeCSS: ctl.like ? '[data-wb-bumper-like="' + postId + '"]' : null,
      commentCSS: ctl.comment ? '[data-wb-bumper-comment="' + postId + '"]' : null,
      commentButtonCSS: ctl.openComment ? '[data-wb-bumper-open-comment="' + postId + '"]' : null,
      shareCSS: ctl.share ? '[data-wb-bumper-share="' + postId + '"]' : null,
      hasVideo: ctl.hasVideo,
      videoEnded: ctl.videoEl?.ended === true,
      videoPaused: ctl.videoEl?.paused ?? true,
      videoFrames: ctl.videoEl?.getVideoPlaybackQuality?.().totalVideoFrames ?? 0,
      videoCurrentTime: ctl.videoCurrentTime,
      videoDuration: ctl.videoDuration,
      videoCSS: ctl.videoCSS,
      videoPlayCSS: ctl.videoPlayCSS,
      videoAudioCSS: ctl.videoAudioCSS,
      videoMuted: ctl.videoEl ? ctl.videoEl.muted || ctl.videoEl.volume === 0 : true,
      ...(ctl.videoSpeakerMuted !== undefined ? { videoSpeakerMuted: ctl.videoSpeakerMuted } : {}),
      comments: ctl.comments,
    });
  }
  const resolved = new Set(posts.map((p) => p.postId));
  const assigned = new Set<string>();
  for (const el of Array.from(
    document.querySelectorAll(
      Object.keys(markerFields)
        .map((a) => `[${a}]`)
        .join(','),
    ),
  ))
    for (const attr of Object.keys(markerFields) as Marker[])
      if (
        resolved.has(el.getAttribute(attr) ?? '') &&
        marks.get(el)?.get(attr)?.id !== el.getAttribute(attr)
      )
        el.removeAttribute(attr);
  for (const [el, entries] of marks)
    for (const [attr, owner] of entries)
      if (owner.id && resolved.has(owner.id) && el.isConnected) {
        if (el.getAttribute(attr) !== owner.id) el.setAttribute(attr, owner.id);
        assigned.add(attr + ':' + owner.id);
      }
  for (let i = posts.length - 1; i >= 0; i--) {
    const post = posts[i];
    if (!post) continue;
    for (const attr of Object.keys(markerFields) as Marker[])
      if (!assigned.has(attr + ':' + post.postId)) post[markerFields[attr]] = null;
    if (!post.postCSS) posts.splice(i, 1);
  }
  return { posts, loading };
}
