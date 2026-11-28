import type { Page } from 'playwright-core';
import type { BumperTarget } from '../shared/group-bumper.js';
import { createRelativePostAge, relativePostAge } from '../shared/relative-post-age.js';
import { serializeDomEval, type createDomEvalRuntime } from './shared-dom-eval-runtime.js';
import {
  createBumperDomRuntime,
  discoverJoinAndSearchEntry,
  inspectBumperDialogsAndMeta,
} from './group-bumper-effects/bumper-surface-meta.js';
import { extractBumperPostControls } from './group-bumper-effects/bumper-post-controls.js';
import {
  collectBumperStoryRoots,
  extractBumperPosts,
} from './group-bumper-effects/bumper-post-extract.js';
export { relativePostAge };
export interface ProjectGroupBumperInput {
  groupId: string;
  pageId?: string;
  groupName?: string;
  pageName?: string;
  targetPostId?: string;
}
export interface BumperPost {
  postId: string;
  postUrl: string;
  authorId: string | null;
  authorName: string;
  authorAliases: string[];
  authorAvatarUrl: string | null;
  pinned: boolean;
  ageHours: number | null;
  timeText: string;
  feedbackId: string | null;
  liked: boolean;
  reactionState?: 'active' | 'none' | 'unknown';
  postCSS?: string | null;
  likeCSS: string | null;
  commentCSS: string | null;
  commentButtonCSS: string | null;
  shareCSS?: string | null;
  hasVideo: boolean;
  videoEnded?: boolean;
  videoCurrentTime?: number;
  videoDuration?: number | null;
  videoCSS?: string | null;
  videoPlayCSS?: string | null;
  videoAudioCSS?: string | null;
  videoMuted?: boolean;
  videoSpeakerMuted?: boolean;
  videoPaused?: boolean;
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
  checkpointRestricted?: boolean;
  restrictionReason?: string;
  loading: boolean;
  groupEntryCSS: string | null;
  groupEntryMatchedBy?: 'id' | 'name' | null;
  groupJoinState?: 'unknown' | 'can-join' | 'member' | 'pending' | 'questions';
  blockingDialog?: boolean;
  postDialogs?: { postId: string; feedbackId: string | null; css: string }[];
  joinGroupCSS?: string | null;
  welcomeDismissCSS?: string | null;
  joinRestrictionDismissCSS?: string | null;
  posts: BumperPost[];
}
export interface BumperShareDialogState {
  open: boolean;
  dialogCount: number;
  storyButtonCSS: string | null;
  closeButtonCSS: string | null;
  restricted: boolean;
  toastConfirmed: boolean;
}
export function bumperAuthorMatch(
  post: Pick<BumperPost, 'authorId' | 'authorName'> & { authorAliases?: string[] },
  target: BumperTarget,
) {
  if (post.authorId && /^\d+$/.test(target.id)) return post.authorId === target.id;
  return (
    post.authorId === target.id ||
    post.authorAliases?.some((id) => id.toLowerCase() === target.id.toLowerCase()) === true ||
    post.authorName.trim() === target.name.trim()
  );
}
function projectShareDialogEntry(createRt: typeof createDomEvalRuntime): BumperShareDialogState {
  const { visible, enabled, chain, clearDataAttrs } = createRt();
  const vis = (el: Element) => visible(el, { opacity: true }),
    normText = (v: string | null) => (v ?? '').replace(/\s+/g, ' ').trim(),
    fiberNames = (el: Element, limit = 36) =>
      chain(el, limit, { fastScan: true })
        .map((f) => f.name)
        .filter(Boolean);
  clearDataAttrs(['data-wb-bumper-share-story', 'data-wb-bumper-share-close']);
  const storyExactRx =
    /^(?:你的快拍|分享到(?:你的)?快拍|添加到(?:你的)?快拍|你的限時動態|分享到(?:你的)?限時動態|新增到(?:你的)?限時動態|(?:Share\s+to\s+|Add\s+to\s+)?Your\s+story|Tin\s+của\s+bạn|สตอรี่ของคุณ|သင့်\s*Story|Cerita\s+Anda)$/iu;
  const storyPartialRx =
    /(?:你的快拍|你的限時動態|Your\s+story|Tin\s+của\s+bạn|สตอรี่ของคุณ|သင့်\s*Story)/iu;
  const shareTitleRx = /^(?:分享|轉發|转发|Share|Chia sẻ|แชร์|မျှဝေ)\b/iu;
  const closeLabelRx = /^(?:关闭|關閉|Close|Đóng|ปิด|ပိတ်ပါ)$/iu;
  const toastSuccessRx =
    /(?:已分享(?:到|至)(?:你的)?(?:快拍|限時動態)|已添加到(?:你的)?快拍|Shared\s+to\s+your\s+story|Added\s+to\s+your\s+story|Đã\s+chia\s+sẻ\s+lên\s+tin|แชร์ไปยังสตอรี่ของคุณแล้ว)/iu;
  const toastConfirmed = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="status"],[role="alert"],[data-visualcompletion="ignore-dynamic"]',
    ),
  )
    .filter(vis)
    .some((el) => {
      const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      return txt.length > 0 && txt.length <= 200 && toastSuccessRx.test(txt);
    });
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"],[role="alertdialog"],[aria-modal="true"]',
    ),
  ).filter(vis);
  let restricted = /^\/checkpoint(?:\/|\.php|$)/i.test(location.pathname);
  for (const d of dialogs) {
    if (d.querySelector('[data-testid="feature-intervention-ok-button"]')) {
      restricted = true;
      break;
    }
    if (
      [d, ...Array.from(d.querySelectorAll('[role="button"],button')).slice(0, 12)].some((n) =>
        fiberNames(n, 28).some((name) =>
          /Checkpoint|CometErrorDialog|SentryBlockDialog|GroupsCometFeatureInterventionDialog/.test(
            name,
          ),
        ),
      )
    ) {
      restricted = true;
      break;
    }
  }
  const activeButtons = (root: Element) =>
    Array.from(root.querySelectorAll<HTMLElement>('[role="button"],button')).filter(
      (el) => vis(el) && !el.matches('a[href]') && !el.closest('a[href]') && enabled(el),
    );
  const findStoryButton = (root: Element): HTMLElement | null => {
    const buttons = activeButtons(root);
    return (
      buttons.find((el) =>
        fiberNames(el, 32).some((name) =>
          /ShareToStory|StoryShare|AddToStory|ReshareToStory/i.test(name),
        ),
      ) ??
      buttons.find((el) => {
        const aria = normText(el.getAttribute('aria-label')),
          txt = normText(el.textContent);
        return storyExactRx.test(aria) || storyExactRx.test(txt);
      }) ??
      buttons.find((el) => {
        const aria = normText(el.getAttribute('aria-label')),
          txt = normText(el.textContent);
        return (
          (aria.length > 0 && aria.length <= 40 && storyPartialRx.test(aria)) ||
          (txt.length > 0 && txt.length <= 40 && storyPartialRx.test(txt))
        );
      }) ??
      null
    );
  };
  const isPostDetailDialog = (d: HTMLElement) =>
    d.hasAttribute('data-wb-bumper-post-dialog') ||
    !!d.querySelector(
      '[data-ad-rendering-role="like_button"],[data-ad-rendering-role="comment_button"]',
    ) ||
    [d, ...Array.from(d.querySelectorAll('[role="button"],button')).slice(0, 8)].some((n) =>
      fiberNames(n, 48).some((name) => /CometSinglePostDialogRoot/.test(name)),
    );
  let shareDialog: HTMLElement | null = null;
  let storyButton: HTMLElement | null = null;
  for (let i = dialogs.length - 1; i >= 0; i--) {
    const d = dialogs[i];
    if (!d || isPostDetailDialog(d)) continue;
    const candidateStory = findStoryButton(d);
    if (candidateStory) {
      shareDialog = d;
      storyButton = candidateStory;
      break;
    }
    const aria = normText(d.getAttribute('aria-label')),
      heading = normText(d.querySelector('h1,h2,[role="heading"]')?.textContent ?? null);
    if (
      fiberNames(d, 36).some((name) =>
        /ShareSheet|CometShare|ShareDialog|ShareComposer/i.test(name),
      ) ||
      shareTitleRx.test(aria) ||
      shareTitleRx.test(heading)
    ) {
      shareDialog = d;
      break;
    }
  }
  let storyButtonCSS: string | null = null;
  let closeButtonCSS: string | null = null;
  if (storyButton) {
    storyButton.setAttribute('data-wb-bumper-share-story', '1');
    storyButtonCSS = '[data-wb-bumper-share-story="1"]';
  }
  if (shareDialog) {
    const rect = shareDialog.getBoundingClientRect();
    const buttons = activeButtons(shareDialog);
    const closeBtn =
      buttons.find((el) =>
        closeLabelRx.test((el.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim()),
      ) ??
      buttons.find((el) => {
        const r = el.getBoundingClientRect();
        return (
          r.top >= rect.top - 4 &&
          r.top - rect.top <= 80 &&
          (Math.abs(r.left - rect.left) <= 80 || Math.abs(r.right - rect.right) <= 80) &&
          fiberNames(el, 28).some((name) => /FDSCircleButton/.test(name))
        );
      });
    if (closeBtn) {
      closeBtn.setAttribute('data-wb-bumper-share-close', '1');
      closeButtonCSS = '[data-wb-bumper-share-close="1"]';
    }
  }
  return {
    open: Boolean(shareDialog),
    dialogCount: dialogs.length,
    storyButtonCSS,
    closeButtonCSS,
    restricted,
    toastConfirmed,
  };
}
export const projectBumperShareDialog = serializeDomEval<() => BumperShareDialogState>(
  'projectBumperShareDialog',
  projectShareDialogEntry,
);
export async function readBumperShareDialog(page: Page): Promise<BumperShareDialogState> {
  return page.evaluate(projectBumperShareDialog);
}
function projectGroupBumperEntry(
  createDomRt: typeof createDomEvalRuntime,
  initBumperRt: typeof createBumperDomRuntime,
  discoverEntry: typeof discoverJoinAndSearchEntry,
  collectRoots: typeof collectBumperStoryRoots,
  extractControls: typeof extractBumperPostControls,
  extractPosts: typeof extractBumperPosts,
  inspectMeta: typeof inspectBumperDialogsAndMeta,
  createAge: typeof createRelativePostAge,
  input: ProjectGroupBumperInput,
): BumperSurface {
  const rt = initBumperRt(createDomRt, input, createAge);
  const discovery = discoverEntry(rt, input);
  const rootsInfo = collectRoots(rt, input);
  const { posts, loading: postLoading } = extractPosts(rt, input, rootsInfo, extractControls);
  const meta = inspectMeta(
    rt,
    input,
    posts,
    rootsInfo.articles.length,
    discovery.groupJoinState,
    postLoading,
  );
  const { obj, text, groupIds, pageIds } = rt;
  return {
    url: location.href,
    groupIds: [...groupIds],
    pageIds: [...pageIds],
    groupTitle: meta.groupTitle,
    avatarUrl: meta.avatarUrl,
    pageAvatarUrl: meta.pageAvatarUrl,
    ready:
      document.readyState !== 'loading' &&
      (posts.length > 0 || !!document.querySelector('main,[role="main"]')),
    visible: document.visibilityState === 'visible',
    restricted: meta.restricted,
    checkpointRestricted: meta.checkpointRestricted,
    ...(meta.restrictionReason ? { restrictionReason: meta.restrictionReason } : {}),
    loading: meta.loading,
    groupEntryCSS: discovery.groupEntryCSS,
    groupEntryMatchedBy: discovery.groupEntryMatchedBy,
    groupJoinState: meta.groupJoinState,
    blockingDialog: meta.blockingDialog,
    postDialogs: [...rootsInfo.singleDialogs].map(([, { story }]) => ({
      postId: text(story.post_id),
      feedbackId: text(obj(story.feedback).__ref) || null,
      css: `[data-wb-bumper-post-dialog="${text(story.post_id)}"]`,
    })),
    joinGroupCSS: discovery.joinGroupCSS,
    welcomeDismissCSS: meta.welcomeDismissCSS,
    joinRestrictionDismissCSS: meta.joinRestrictionDismissCSS,
    posts,
  };
}
export const projectGroupBumper = serializeDomEval<
  (input: ProjectGroupBumperInput) => BumperSurface
>('projectGroupBumper', projectGroupBumperEntry, {
  createBumperDomRuntime,
  discoverJoinAndSearchEntry,
  collectBumperStoryRoots,
  extractBumperPostControls,
  extractBumperPosts,
  inspectBumperDialogsAndMeta,
  createRelativePostAge,
});
export async function readGroupBumper(
  page: Page,
  input: ProjectGroupBumperInput,
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
