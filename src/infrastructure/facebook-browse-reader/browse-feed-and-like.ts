import type {
  FACEBOOK_BROWSE_LIKE_CSS,
  FACEBOOK_REEL_NEXT_CSS,
} from '../../shared/facebook-browse-route.js';
import type { BrowseRuntime, DOMRecord } from './browse-surfaces.js';
export interface StructuralPostSnapshot {
  area: number;
  key: string;
  element: Element;
  root: Element;
  imageCount: number;
  textLength: number;
  videoDuration: number | null;
  hasInlineVideo: boolean;
}
export interface BrowseFeedSnapshot {
  article: { el: Element; area: number; key: string | null } | null | undefined;
  structuralPosts: StructuralPostSnapshot[];
  orderedPosts: StructuralPostSnapshot[];
  structuralPost: StructuralPostSnapshot | undefined;
  reel: string;
  source: string;
  videoEntry: string | null;
  centerHit: Element | null;
  scrolling: Element[];
  nextReelCSS: typeof FACEBOOK_REEL_NEXT_CSS | null;
}
export interface BrowseLikeTarget {
  css: typeof FACEBOOK_BROWSE_LIKE_CSS | null;
  liked: boolean;
  likeCount: number;
  sponsored: boolean;
  text: string;
}
export function readBrowseFeedPosts(rt: BrowseRuntime): BrowseFeedSnapshot {
  const { reelSurface, feedLikeSurface, frames, visibleArea, main, video, feedText, canHitCenter } =
    rt;
  const article =
    main && feedLikeSurface
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
  const structuralPosts: StructuralPostSnapshot[] = [];
  for (const profile of Array.from(
    feedLikeSurface
      ? (main?.querySelectorAll('[data-ad-rendering-role="profile_name"]') ?? [])
      : [],
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
      const inlineVideos = feedLikeSurface
        ? Array.from(root.querySelectorAll('video'))
            .slice(0, 40)
            .map((el, index) => ({ el, index }))
            .filter(
              ({ el }) =>
                el.readyState >= 2 && el.videoWidth > 0 && el.videoHeight > 0 && el.error === null,
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
    const href = (link as HTMLAnchorElement).href;
    const area = visibleArea(link);
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
    for (
      let depth = 0, el: Element | null = centerHit;
      el && el !== main && depth < 24;
      depth++, el = el.parentElement
    )
      feedScrollCandidates.add(el);
  }
  const scrolling = main
    ? (feedLikeSurface || reelSurface
        ? [...feedScrollCandidates]
        : [...new Set([...feedScrollCandidates, ...Array.from(main.children ?? [])])]
      ).filter(
        (el) =>
          el.scrollHeight > el.clientHeight + 20 &&
          visibleArea(el) > 0 &&
          /auto|scroll/.test(getComputedStyle(el).overflowY),
      )
    : [];
  const nextReelCSS = '[data-wb-reel-next="1"]' as const;
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
              '[role="button"]:is([aria-label="Next Card"],[aria-label="Next reel"],[aria-label="Next video"],[aria-label="下一条快拍"],[aria-label="下一条视频"],[aria-label="下一个视频"],[aria-label="下一個連續短片"],[aria-label="နောက်ကတ်"]),button:is([aria-label="Next Card"],[aria-label="Next reel"],[aria-label="Next video"],[aria-label="下一条快拍"],[aria-label="下一条视频"],[aria-label="下一个视频"],[aria-label="下一個連續短片"],[aria-label="နောက်ကတ်"])',
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
  const nextButtonReady = Boolean(
    nextRoute &&
    !location.hash &&
    video &&
    nextButton &&
    visibleArea(nextButton) > 0 &&
    nextButton.getAttribute('aria-disabled') !== 'true' &&
    !nextButton.hasAttribute('disabled') &&
    canHitCenter(nextButton),
  );
  return {
    article,
    structuralPosts,
    orderedPosts,
    structuralPost,
    reel,
    source,
    videoEntry,
    centerHit,
    scrolling,
    nextReelCSS: nextButtonReady ? nextReelCSS : null,
  };
}
export function readBrowseLikeTarget(
  rt: BrowseRuntime,
  feed: BrowseFeedSnapshot,
): BrowseLikeTarget | null {
  const { reelSurface, feedLikeSurface, record, frames, visibleArea, main, video, canHitCenter } =
    rt;
  const { article, structuralPost } = feed;
  for (const old of Array.from(document.querySelectorAll('[data-wb-browse-like]')))
    old.removeAttribute('data-wb-browse-like');
  const likeScopeRoot = feedLikeSurface
    ? (structuralPost?.root ?? article?.el ?? null)
    : reelSurface && video
      ? main
      : null;
  if (!likeScopeRoot) return null;
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
    const chain = frames(el, 100);
    const feedback = reactionFrame(el)?.props.feedback;
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
            if (record(info) && 'reaction_type' in info)
              return info.reaction_type !== 0 && info.reaction_type !== null;
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
      } catch {}
    }
    return null;
  };
  const nonLikeRx =
    /comment|share|send|评论|評論|分享|发送|發送|မှတ်ချက်|ကွန်မန့်|မျှဝေ|ဝေမျှ|ပေးပို့/i;
  const matchesLikeLabel = (el: Element) => {
    if (visibleArea(el) <= 0) return false;
    const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
    if (nonLikeRx.test(label)) return false;
    return /^(?:like|liked|remove\s+like|unlike|love|care|haha|wow|sad|angry|赞|讚|取消赞|取消讚|已赞|已讚|大爱|大心|关心|加油|哈哈|哇|心碎|怒|ကြိုက်(?:သည်|တယ်|ခြင်းဖျက်)?|မကြိုက်(?:တော့)?|နှစ်သက်(?:သည်)?|သဘောကျ(?:သည်)?)(?:$|[\s,，·•:：0-9၀-၉])/i.test(
      label,
    );
  };
  const activeVideoArea = video ? visibleArea(video) : 0;
  const sharesCard = (el: Element) => {
    if (!video) return false;
    const siblingVideoThreshold = Math.max(1000, activeVideoArea * 0.25);
    for (
      let parent = video.parentElement;
      parent && parent !== main;
      parent = parent.parentElement
    ) {
      if (
        Array.from(parent.querySelectorAll('video')).filter(
          (v) => v === video || visibleArea(v) >= siblingVideoThreshold,
        ).length > 1
      )
        break;
      if (parent.contains(el)) return true;
    }
    return false;
  };
  const distanceToVideo = (el: Element) => {
    if (!video) return 0;
    const vr = video.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const y = r.top + r.height / 2;
    return reelSurface
      ? Math.max(vr.top - 24 - y, y - (vr.bottom + 60), 0) * 10000 + r.top
      : Math.max(vr.top - y, y - vr.bottom, 0) * 10000 + Math.abs(y - (vr.top + vr.bottom) / 2);
  };
  const sortReelButtons = <T extends Element>(list: T[], preferIcons: boolean) => {
    if (list.length > 1)
      list.sort(
        (a, b) =>
          Number(sharesCard(b)) - Number(sharesCard(a)) ||
          (preferIcons
            ? Number(matchesLikeLabel(b)) - Number(matchesLikeLabel(a)) ||
              Number(reactionIcons(b).length > 0) - Number(reactionIcons(a).length > 0)
            : 0) ||
          distanceToVideo(a) - distanceToVideo(b),
      );
    return list;
  };
  const excludedAncestorSelector =
    '[role="article"], [aria-label*="comment" i], [aria-label*="评论"], [aria-label*="評論"], [aria-label*="share" i], [aria-label*="send" i], [aria-label*="分享"], [aria-label*="发送"], [aria-label*="發送"], [aria-label*="မှတ်ချက်"], [aria-label*="မျှဝေ"], [role="dialog"]';
  const adLike = likeScopeRoot.querySelector('[data-ad-rendering-role="like_button"]');
  let likeBtn: Element | null = adLike
    ? (adLike.closest('[role="button"],button') ?? adLike)
    : null;
  if (!likeBtn && reelSurface) {
    const rawCandidates = Array.from(
      likeScopeRoot.querySelectorAll('[role="button"],button'),
    ).filter((el) => {
      if (visibleArea(el) <= 0 || el.closest(excludedAncestorSelector)) return false;
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
      return (
        !nonLikeRx.test(label) &&
        !!reactionFrame(el) &&
        (reactionIcons(el).length > 0 || !!el.querySelector('svg'))
      );
    });
    const candidates = rawCandidates.filter(
      (el) => !rawCandidates.some((other) => other !== el && el.contains(other)),
    );
    likeBtn = sortReelButtons(candidates, true)[0] ?? null;
  }
  if (!likeBtn) {
    const rawLabelCandidates = Array.from(likeScopeRoot.querySelectorAll('[role="button"],button'))
      .slice(0, 400)
      .filter(
        (el) => matchesLikeLabel(el) && (!reelSurface || !el.closest(excludedAncestorSelector)),
      );
    const labelCandidates = rawLabelCandidates.filter(
      (el) => !rawLabelCandidates.some((other) => other !== el && el.contains(other)),
    );
    if (reelSurface && video) sortReelButtons(labelCandidates, false);
    likeBtn = labelCandidates[0] ?? rawLabelCandidates[0] ?? null;
  }
  if (!likeBtn) return null;
  const ariaPressed =
    likeBtn.getAttribute('aria-pressed') === 'true' ||
    likeBtn.querySelector('[aria-pressed="true"]') !== null;
  const btnLabel = (likeBtn.getAttribute('aria-label') || likeBtn.textContent || '').trim();
  const labelLiked =
    /^(?:remove\s+|取消|收回)?(?:unlike|remove\s+like|liked|love|care|haha|wow|sad|angry|取消赞|取消讚|已赞|已讚|大爱|大心|关心|加油|哈哈|哇|心碎|怒|မကြိုက်(?:တော့)?|ကြိုက်ခြင်းဖျက်|မနှစ်သက်)(?:$|[\s,，·•:：0-9၀-၉])/i.test(
      btnLabel,
    ) ||
    /unlike|remove\s+like|\bliked\b|取消赞|取消讚|已赞|已讚|မကြိုက်|ကြိုက်ခြင်းဖျက်/i.test(
      btnLabel,
    );
  const colorProbe = adLike ?? likeBtn;
  const colorLiked = [
    colorProbe,
    ...Array.from(colorProbe.querySelectorAll('svg,path,g,span,i')).slice(0, 16),
  ].some((node) => {
    if (!node) return false;
    const style = getComputedStyle(node);
    const maskImage = style.maskImage || style.getPropertyValue('-webkit-mask-image') || '';
    const isMaskIcon =
      (maskImage !== '' && maskImage !== 'none') ||
      (node.tagName === 'I' && visibleArea(node) > 0 && visibleArea(node) <= 2500);
    const filter = (style.filter || '').trim().toLowerCase();
    if (filter && filter !== 'none' && /hue-rotate\(/i.test(filter) && /saturate\(/i.test(filter))
      return true;
    const candidates = [
      style.color,
      style.fill,
      style.stroke,
      ...(isMaskIcon ? [style.backgroundColor] : []),
      node.getAttribute('fill') ?? '',
      node.getAttribute('stroke') ?? '',
      node.getAttribute('color') ?? '',
    ];
    return candidates.some((color) => {
      const val = (color || '').trim().toLowerCase();
      if (!val || val === 'none' || val === 'currentcolor' || val === 'transparent') return false;
      if (
        ['#0866ff', '#1877f2', '#2078f4', 'var(--accent)', 'var(--primary-button-background)'].some(
          (k) => val.includes(k),
        )
      )
        return true;
      const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?/i.exec(val);
      if (!rgb) return false;
      const alpha = rgb[4] !== undefined ? Number(rgb[4]) : 1;
      if (Number.isFinite(alpha) && alpha <= 0.05) return false;
      const r = Number(rgb[1]),
        g = Number(rgb[2]),
        b = Number(rgb[3]);
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
  const liked =
    filledIcon ||
    nativeFeedback?.liked === true ||
    ariaPressed ||
    labelLiked ||
    colorLiked ||
    reactionSelected;
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
    const normalized = raw.replace(/[၀-၉]/g, (ch) => String(ch.charCodeAt(0) - 0x1040)).trim();
    const match =
      /(?:^|[^\d.])(\d+(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|m|万|萬|亿|億|ထောင်|သောင်း|သိန်း|သန်း)?(?=$|[^\dA-Za-z])/i.exec(
        normalized,
      );
    if (!match?.[1]) return null;
    const num = Number(match[1].replace(/,/g, ''));
    if (!Number.isFinite(num) || num < 0) return null;
    const unit = (match[2] ?? '').toLowerCase();
    const mult =
      unit === 'k' || unit === 'ထောင်'
        ? 1_000
        : unit === 'm' || unit === 'သန်း'
          ? 1_000_000
          : unit === '万' || unit === '萬' || unit === 'သောင်း'
            ? 10_000
            : unit === 'သိန်း'
              ? 100_000
              : unit === '亿' || unit === '億'
                ? 100_000_000
                : 1;
    return Math.round(num * mult);
  };
  let likeCount = 0;
  const reelNearbyCandidates: string[] = [];
  if (reelSurface) {
    const btnRect = likeBtn.getBoundingClientRect();
    if (likeBtn.parentElement) reelNearbyCandidates.push(likeBtn.parentElement.textContent ?? '');
    if (likeBtn.nextElementSibling)
      reelNearbyCandidates.push(
        likeBtn.nextElementSibling.getAttribute('aria-label') || '',
        likeBtn.nextElementSibling.textContent ?? '',
      );
    for (
      let d = 0, actionCol: Element | null = likeBtn.parentElement;
      actionCol && actionCol !== main && d < 3;
      d++, actionCol = actionCol.parentElement
    ) {
      for (const node of Array.from(actionCol.querySelectorAll('span,div')).slice(0, 24)) {
        const nr = node.getBoundingClientRect();
        if (Math.abs(nr.top - btnRect.top) < 88 && Math.abs(nr.left - btnRect.left) < 80)
          reelNearbyCandidates.push(node.getAttribute('aria-label') || '', node.textContent || '');
      }
    }
  }
  const countCandidates = [
    btnLabel,
    likeBtn.textContent ?? '',
    ...(reelSurface
      ? reelNearbyCandidates
      : Array.from(
          likeScopeRoot.querySelectorAll(
            '[aria-label*="like" i],[aria-label*="reaction" i],[aria-label*="赞"],[aria-label*="讚"],[aria-label*="心情"],[aria-label*="ကြိုက်"],[aria-label*="တုံ့ပြန်"],[aria-label*="နှစ်သက်"],[aria-label*="သဘောကျ"],[role="toolbar"]',
          ),
        )
          .slice(0, 30)
          .flatMap((el) => [el.getAttribute('aria-label') || '', el.textContent || ''])),
  ];
  for (const candidate of countCandidates) {
    if (
      !candidate ||
      /comment|share|评论|評論|分享|views|次播放|မှတ်ချက်|ကွန်မန့်|မျှဝေ|ဝေမျှ|ကြည့်ရှု/i.test(
        candidate,
      )
    )
      continue;
    const parsed = parseCompactCount(candidate);
    if (parsed !== null && parsed > 0) {
      likeCount = parsed;
      break;
    }
  }
  if (nativeFeedback?.count !== undefined) likeCount = nativeFeedback.count;
  let activeContentRoot: Element = likeScopeRoot;
  let activeVideoRect: DOMRect | null = null;
  if (reelSurface && video) {
    activeVideoRect = video.getBoundingClientRect();
    for (
      let candidateRoot: Element | null = video.parentElement;
      candidateRoot && candidateRoot !== main;
      candidateRoot = candidateRoot.parentElement
    ) {
      if (Array.from(candidateRoot.querySelectorAll('video')).some((v) => v !== video)) break;
      activeContentRoot = candidateRoot;
    }
  }
  const inActiveReelBand = (el: Element) => {
    if (!reelSurface || !activeVideoRect) return true;
    if (visibleArea(el) <= 0) return false;
    const r = el.getBoundingClientRect();
    return r.top <= activeVideoRect.bottom + 120 && r.bottom >= activeVideoRect.top - 120;
  };
  const sponsored =
    Array.from(
      activeContentRoot.querySelectorAll(
        'a[href*="/ads/about"],a[aria-label*="Sponsored" i],a[aria-label*="赞助"],a[aria-label*="贊助"],a[aria-label*="广告"],a[aria-label*="廣告"]',
      ),
    )
      .slice(0, 20)
      .some(inActiveReelBand) ||
    Array.from(activeContentRoot.querySelectorAll('span,a'))
      .slice(0, 60)
      .some(
        (el) =>
          inActiveReelBand(el) &&
          /^(?:Sponsored|赞助内容|贊助內容|赞助|贊助|广告|廣告)$/i.test(
            (el.textContent || '').trim(),
          ),
      );
  const msgNodes = Array.from(
    activeContentRoot.querySelectorAll(
      '[data-ad-rendering-role="profile_name"],[data-ad-rendering-role="story_message"],[data-ad-preview="message"],h2,h3,span[dir="auto"]',
    ),
  )
    .filter(inActiveReelBand)
    .slice(0, 24);
  const text = (
    msgNodes.length > 0
      ? msgNodes.map((el) => el.textContent || '').join(' ')
      : reelSurface
        ? ''
        : likeScopeRoot.textContent || ''
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
  return { css: likeCSS, liked, likeCount, sponsored, text };
}
