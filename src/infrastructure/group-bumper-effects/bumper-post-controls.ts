import type { BumperPost } from '../group-bumper-effects.js';
import type { BumperDomRuntime, FiberFrame, RecordValue } from './bumper-surface-meta.js';
export type BumperMarkerAttr =
  | 'data-wb-bumper-post'
  | 'data-wb-bumper-like'
  | 'data-wb-bumper-comment'
  | 'data-wb-bumper-open-comment'
  | 'data-wb-bumper-share'
  | 'data-wb-bumper-video'
  | 'data-wb-bumper-video-play'
  | 'data-wb-bumper-video-audio';
export interface PostControlsInput {
  article: Element;
  controls: HTMLElement[];
  frames: Array<FiberFrame & { element: Element }>;
  single: { story: RecordValue; key: string } | undefined;
  primaryCard: FiberFrame | undefined;
  storyKey: string;
  postId: string;
  feedbackId: string | null;
  targetPostId: string | undefined;
  markerRank: number;
  belongsToStory: (el: Element) => boolean;
  mark: (el: Element | undefined, attr: BumperMarkerAttr, id: string, rank: number) => void;
}
export function extractBumperPostControls(rt: BumperDomRuntime, ctx: PostControlsInput) {
  const { record, obj, text, visible, chain, decodeId, relayRecord, reactionValue, commentRow } =
    rt;
  const {
    article,
    controls,
    frames,
    single,
    primaryCard,
    storyKey,
    postId,
    feedbackId,
    targetPostId,
    markerRank,
    belongsToStory,
    mark,
  } = ctx;
  let liked = false;
  let reactionState: 'active' | 'none' | 'unknown' = 'unknown';
  let like: HTMLElement | undefined;
  let comment: HTMLElement | undefined;
  let openComment: HTMLElement | undefined;
  let share: HTMLElement | undefined;
  const postShareLabelRx =
      /^(?:分享|轉發|转发|将此内容发送给好友|將此內容傳送給朋友|Send this to friends|Share(?:\s+(?:post|this|video|photo|reel))?\b|Chia sẻ|แชร์|မျှဝေ)/iu,
    feedbackIdOf = (f: FiberFrame) => {
      const fb = obj(f.props.feedback);
      return text(fb.id ?? fb.__id ?? f.props.feedbackID ?? f.props.feedbackId);
    },
    hasRole = (el: Element, role: string) =>
      el.getAttribute('data-ad-rendering-role') === role ||
      !!el.querySelector(`[data-ad-rendering-role="${role}"]`),
    editorSel =
      '[role="textbox"][contenteditable="true"],div[contenteditable="true"][data-lexical-editor="true"]',
    findCommentBox = (root: Element) =>
      Array.from(root.querySelectorAll<HTMLElement>(editorSel)).find(
        (el) =>
          belongsToStory(el) && !el.closest('[role="banner"]') && !commentRow(el) && visible(el),
      ),
    findRoleBtn = (root: Element, role: string) =>
      root.querySelector<HTMLElement>(
        `[role="button"][data-ad-rendering-role="${role}"],button[data-ad-rendering-role="${role}"]`,
      ) ??
      root
        .querySelector<HTMLElement>(`[data-ad-rendering-role="${role}"]`)
        ?.closest<HTMLElement>('[role="button"],button') ??
      undefined;
  for (const el of controls.filter(belongsToStory))
    for (const f of chain(el)) {
      const actionFeedbackId = feedbackIdOf(f);
      if (feedbackId && actionFeedbackId && actionFeedbackId !== feedbackId) continue;
      if (
        /CometUFIReactButtonBase/.test(f.name) &&
        el.matches('[role="button"],button') &&
        !chain(el).some((n) => /CometUFIComment/.test(n.name))
      ) {
        if (el.getAttribute('data-ad-rendering-role') === 'like_button' || !like) like = el;
        const fb = obj(f.props.feedback);
        const native = feedbackId ? relayRecord(el, feedbackId) : {};
        const nativeKey = [
          'viewer_feedback_reaction_info(use_default_actor:false)',
          'viewer_feedback_reaction_info',
        ].find((k) => Object.prototype.hasOwnProperty.call(native, k));
        if (nativeKey) reactionState = reactionValue(el, native[nativeKey]);
        else if (Object.prototype.hasOwnProperty.call(fb, 'viewer_feedback_reaction_info'))
          reactionState = reactionValue(el, fb.viewer_feedback_reaction_info);
        else if (
          f.props.isReacted === true ||
          f.props.selected === true ||
          f.props.isSelected === true ||
          f.props.pressed === true
        )
          reactionState = 'active';
        liked = reactionState === 'active';
      }
      if (/CometUFICommentAction/.test(f.name) && el.matches('[role="button"],button'))
        openComment = el;
      if (
        /CometUFIShare|UFI2ShareAction|CometFeedStoryShare|UFIShareAction|ShareActionButton/i.test(
          f.name,
        ) &&
        el.matches('[role="button"],button') &&
        !commentRow(el)
      ) {
        if (el.getAttribute('data-ad-rendering-role') === 'share_button' || !share) share = el;
      }
      if (
        /CometUFIComposerInputWithActionsForLexicalInner/.test(f.name) &&
        f.props.commentAction === 'ADD' &&
        el.matches('[role="textbox"][contenteditable="true"]') &&
        !el.closest('[role="banner"]') &&
        visible(el)
      )
        comment = el;
    }
  const matchesShareLabel = (el: Element) =>
    postShareLabelRx.test((el.getAttribute('aria-label') ?? '').trim()) ||
    ((el.textContent ?? '').trim().length > 0 &&
      (el.textContent ?? '').trim().length <= 16 &&
      /^(?:分享|轉發|转发|Share|Chia sẻ|แชร์|မျှဝေ)$/iu.test((el.textContent ?? '').trim()));
  for (const el of controls.filter(belongsToStory)) {
    if (
      !comment &&
      el.matches(editorSel) &&
      !el.closest('[role="banner"]') &&
      !commentRow(el) &&
      visible(el)
    )
      comment = el;
    if (!el.matches('[role="button"],button') || commentRow(el)) continue;
    const hasConflictingFeedback =
      !!feedbackId &&
      chain(el).some((f) => {
        const fid = feedbackIdOf(f);
        return !!fid && fid !== feedbackId;
      });
    if (hasConflictingFeedback) continue;
    if (!like && hasRole(el, 'like_button')) like = el;
    if (!openComment && hasRole(el, 'comment_button')) openComment = el;
    if (
      !share &&
      !el.closest('[role="banner"]') &&
      (hasRole(el, 'share_button') ||
        (visible(el) &&
          el.getAttribute('aria-disabled') !== 'true' &&
          !el.hasAttribute('disabled') &&
          matchesShareLabel(el)))
    )
      share = el;
  }
  if (!share && like) {
    for (
      let d = 0, ufiBar: HTMLElement | null = like.parentElement;
      ufiBar && ufiBar !== article && article.contains(ufiBar) && d < 5;
      d++, ufiBar = ufiBar.parentElement
    ) {
      const foundShare = Array.from(
        ufiBar.querySelectorAll<HTMLElement>('[role="button"],button'),
      ).find(
        (el) =>
          el !== like &&
          !commentRow(el) &&
          visible(el) &&
          el.getAttribute('aria-disabled') !== 'true' &&
          !el.hasAttribute('disabled') &&
          (hasRole(el, 'share_button') || matchesShareLabel(el)),
      );
      if (foundShare) {
        share = foundShare;
        break;
      }
    }
  }
  comment ??= findCommentBox(article);
  let matchedDialog: HTMLElement | undefined;
  if (!comment || !like || targetPostId === postId) {
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(
      (d) =>
        visible(d) &&
        !d.hasAttribute('data-wb-bumper-welcome-dismiss') &&
        !d.querySelector('[data-wb-bumper-welcome-dismiss]'),
    );
    matchedDialog = dialogs
      .filter((d) => {
        if (single && d === article) return true;
        return [
          d,
          ...Array.from(
            d.querySelectorAll<HTMLElement>('[role="button"],button,[role="textbox"],a[href]'),
          ).slice(0, 80),
        ].some((el) =>
          chain(el).some((f) => {
            const fid = feedbackIdOf(f);
            if (feedbackId && fid && fid === feedbackId) return true;
            const story = obj(f.props.story ?? f.props.feedUnit);
            return (decodeId(story.id ?? story.__id) || text(story.post_id)) === postId;
          }),
        );
      })
      .at(-1);
    if (matchedDialog) {
      comment ??= findCommentBox(matchedDialog);
      like ??= findRoleBtn(matchedDialog, 'like_button');
      share ??= findRoleBtn(matchedDialog, 'share_button');
    }
  }
  mark(article, 'data-wb-bumper-post', postId, markerRank);
  if (like) {
    if (reactionState === 'unknown' && like.getAttribute('aria-pressed') === 'false')
      reactionState = 'none';
    if (reactionState === 'unknown' && like.getAttribute('aria-pressed') === 'true') {
      reactionState = 'active';
      liked = true;
    }
    mark(like, 'data-wb-bumper-like', postId, markerRank);
  }
  mark(comment, 'data-wb-bumper-comment', postId, markerRank);
  mark(openComment, 'data-wb-bumper-open-comment', postId, markerRank);
  mark(share, 'data-wb-bumper-share', postId, markerRank);
  const comments: BumperPost['comments'] = [];
  for (const row of [
    ...Array.from(article.querySelectorAll('[role="article"],li')),
    ...(matchedDialog ? Array.from(matchedDialog.querySelectorAll('[role="article"],li')) : []),
  ]) {
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
  const isCompleteFeedUnitCard = Boolean(
    primaryCard && /CometFeedUnitCard|CometFeedUnitErrorBoundary/.test(primaryCard.name),
  );
  const findEnclosingFeedUnitCard = (el: Element) => {
    const matchCard = (node: Element) =>
      chain(node, 256).find(
        (f) =>
          /CometFeedUnitCard|CometFeedUnitErrorBoundary/.test(f.name) &&
          record(f.props.story ?? f.props.feedUnit),
      );
    const direct = matchCard(el);
    if (direct) return direct;
    for (
      let d = 0, parent = el.parentElement;
      parent && article.contains(parent) && d < 48;
      d++, parent = parent.parentElement
    ) {
      const candidate = matchCard(parent);
      if (candidate) return candidate;
    }
    return undefined;
  };
  const belongsToPostMedia = (el: Element) => {
    if (commentRow(el)) return false;
    if (belongsToStory(el)) return true;
    const nestedArticle = el.closest('[role="article"]');
    if (
      nestedArticle &&
      nestedArticle !== article &&
      (!article.contains(nestedArticle) || commentRow(nestedArticle))
    )
      return false;
    if (single) return article.contains(el);
    if (!isCompleteFeedUnitCard || !primaryCard) return false;
    const enclosingCard = findEnclosingFeedUnitCard(el);
    if (!enclosingCard) return false;
    if (
      enclosingCard.fiber === primaryCard.fiber ||
      enclosingCard.fiber.alternate === primaryCard.fiber
    )
      return true;
    const enclosingStory = obj(enclosingCard.props.story ?? enclosingCard.props.feedUnit);
    return !!storyKey && text(enclosingStory.__id ?? enclosingStory.id) === storyKey;
  };
  const candidateVideos = Array.from(article.querySelectorAll<HTMLVideoElement>('video')).filter(
    (v) => !commentRow(v) && belongsToPostMedia(v),
  );
  const videoEl =
    candidateVideos.filter(belongsToStory).find((v) => visible(v)) ??
    candidateVideos.find((v) => visible(v)) ??
    candidateVideos.find(belongsToStory) ??
    candidateVideos[0];
  const hasVideoContainer =
    !!videoEl ||
    frames.some((f) => /CometVideoPlayer|VideoPlayer|TahoeVideo/i.test(f.name)) ||
    Array.from(
      article.querySelectorAll(
        '[data-pagelet*="video" i],a[href*="/reel/"],a[href*="/videos/"],a[href*="/watch/"]',
      ),
    ).some(belongsToPostMedia);
  let hasVideo = false;
  let videoCurrentTime = 0;
  let videoDuration: number | null = null;
  let videoCSS: string | null = null;
  let videoPlayCSS: string | null = null;
  let videoAudioCSS: string | null = null;
  let videoSpeakerMuted: boolean | undefined;
  const isPlayControl = (el: HTMLElement) =>
    el.matches('[role="button"],button') &&
    visible(el) &&
    chain(el).some(
      (f) =>
        (/VideoPlayerPlayButton/.test(f.name) && f.props.isVisible !== false) ||
        (/VideoPlayerPlaybackControlBase/.test(f.name) && f.props.playbackIcon === 'play'),
    );
  const playControl =
    controls.filter(belongsToStory).find(isPlayControl) ??
    controls.filter(belongsToPostMedia).find(isPlayControl);
  if (playControl) {
    mark(playControl, 'data-wb-bumper-video-play', postId, markerRank);
    videoPlayCSS = '[data-wb-bumper-video-play="' + postId + '"]';
  }
  if (videoEl || hasVideoContainer) {
    hasVideo = true;
    const unmuteLabelRx =
      /^(?:Unmute(?:\s+(?:video|audio))?|Turn on (?:sound|audio)|Sound is off|Tap to unmute|Click to unmute|取消(?:视频)?静音|取消(?:影片)?靜音|开启(?:视频)?声音|開啟(?:影片)?聲音|打开(?:视频)?声音|打開(?:影片)?聲音|点击开启声音|點擊開啟聲音|恢复声音|恢復聲音|Bật âm thanh|เปิดเสียง|အသံဖွင့်(?:ပါ)?|Nyalakan suara)$/i;
    const muteLabelRx =
      /^(?:Mute(?:\s+(?:video|audio))?|Turn off (?:sound|audio)|Sound is on|Tap to mute|Click to mute|(?:将视频)?静音|(?:將影片)?靜音|关闭(?:视频)?声音|關閉(?:影片)?聲音|Tắt âm thanh|ปิดเสียง|အသံပိတ်(?:ပါ)?|Matikan suara)$/i;
    const audioControlBoxReady = (el: Element): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const matchesAudioControl = (
      el: Element,
      allowZeroOpacityOverlay: boolean,
    ): el is HTMLElement => {
      const enclosingAnchor = el.closest('a[href]');
      const isInlineMediaCardAnchor =
        !!enclosingAnchor &&
        article.contains(enclosingAnchor) &&
        Boolean(
          (videoEl && enclosingAnchor.contains(videoEl)) ||
          /\/(?:reel|reels|videos|watch)(?:\/|\?|$)/i.test(
            enclosingAnchor.getAttribute('href') ?? '',
          ),
        );
      if (
        !el.matches('[role="button"],button') ||
        commentRow(el) ||
        el.matches('a[href]') ||
        (enclosingAnchor && !isInlineMediaCardAnchor) ||
        !(visible(el) || (allowZeroOpacityOverlay && audioControlBoxReady(el)))
      )
        return false;
      const label = (el.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim();
      if (label && (unmuteLabelRx.test(label) || muteLabelRx.test(label))) return true;
      return chain(el).some(
        (f) =>
          /VideoPlayerAudio|VideoPlayerMute|AudioButton|VolumeButton|VolumeControl|MuteButton|SoundToggle|ReelsAudio/i.test(
            f.name,
          ) ||
          (/VideoPlayer|Audio|Volume|Mute|Sound/i.test(f.name) &&
            (typeof f.props.isMuted === 'boolean' ||
              typeof f.props.muted === 'boolean' ||
              typeof f.props.onToggleMute === 'function' ||
              typeof f.props.onMuteChange === 'function')),
      );
    };
    const storyControls = controls.filter(belongsToStory);
    const mediaControls = controls.filter(belongsToPostMedia);
    const audioControl =
      storyControls.find((el) => matchesAudioControl(el, false)) ??
      mediaControls.find((el) => matchesAudioControl(el, false)) ??
      (videoEl && visible(videoEl)
        ? (storyControls.find((el) => matchesAudioControl(el, true)) ??
          mediaControls.find((el) => matchesAudioControl(el, true)))
        : undefined);
    if (audioControl) {
      mark(audioControl, 'data-wb-bumper-video-audio', postId, markerRank);
      videoAudioCSS = '[data-wb-bumper-video-audio="' + postId + '"]';
      const audioLabel = (audioControl.getAttribute('aria-label') ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (audioLabel && unmuteLabelRx.test(audioLabel)) videoSpeakerMuted = true;
      else if (audioLabel && muteLabelRx.test(audioLabel)) videoSpeakerMuted = false;
      else {
        const muteFrame = chain(audioControl).find(
          (f) => typeof f.props.isMuted === 'boolean' || typeof f.props.muted === 'boolean',
        );
        if (muteFrame)
          videoSpeakerMuted =
            typeof muteFrame.props.isMuted === 'boolean'
              ? muteFrame.props.isMuted
              : Boolean(muteFrame.props.muted);
      }
    }
    if (videoEl) {
      mark(videoEl, 'data-wb-bumper-video', postId, markerRank);
      videoCSS = '[data-wb-bumper-video="' + postId + '"]';
      videoCurrentTime = Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : 0;
      videoDuration =
        Number.isFinite(videoEl.duration) && videoEl.duration > 0 ? videoEl.duration : null;
    }
  }
  return {
    liked,
    reactionState,
    like,
    comment,
    openComment,
    share,
    comments,
    hasVideo,
    videoEl,
    videoCurrentTime,
    videoDuration,
    videoCSS,
    videoPlayCSS,
    videoAudioCSS,
    videoSpeakerMuted,
  };
}
