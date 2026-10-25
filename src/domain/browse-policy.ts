import type { StepInstance, Progress } from '../shared/task-contracts.js';
import type { Action } from '../shared/browser-actions.js';
import type { Intent, Verdict, BrowseReading } from '../shared/browse-execution.js';
import type { ExecutionSession } from '../shared/task-execution.js';
import { sameExecution } from '../shared/task-execution.js';
import { sameTabProof } from './task-tabs.js';
import {
  facebookBrowseSurface,
  facebookMarketplaceItemURL,
  matchesMarketplaceSearch,
  marketplaceBootstrap,
  FACEBOOK_REEL_NEXT_CSS,
  FACEBOOK_FRIEND_CONFIRM_CSS,
} from '../shared/facebook-browse-route.js';

export function validateBrowseIntent(step: StepInstance, action: Action, intent: Intent): void {
  if (step.spec.type === 'post') throw Error('BROWSE_EXECUTOR_CANNOT_PUBLISH');
  if (
    ![
      'click',
      'mediaClick',
      'activateTab',
      'browseNavigate',
      'browseScroll',
      'browsePlay',
    ].includes(action.kind) ||
    !('tabId' in action) ||
    action.tabId !== intent.proof.tabId
  )
    throw Error('BROWSE_ACTION_SCOPE_REJECTED');
  if (
    action.kind === 'browseNavigate' &&
    (intent.kind !== 'auxiliary' ||
      intent.purpose !== 'advance' ||
      facebookBrowseSurface(action.url) !== step.spec.type)
  )
    throw Error('BROWSE_NAVIGATION_PURPOSE_REJECTED');
  if (
    action.kind === 'browseNavigate' &&
    step.spec.type === 'marketplace' &&
    !matchesMarketplaceSearch(action.url, step.spec) &&
    !marketplaceBootstrap(action.url, step.spec) &&
    !facebookMarketplaceItemURL(action.url)
  )
    throw Error('MARKETPLACE_SEARCH_TARGET_CHANGED');
  if (
    action.kind === 'browseScroll' &&
    (intent.kind !== 'auxiliary' ||
      intent.purpose !== 'advance' ||
      facebookBrowseSurface(action.url) !== step.spec.type)
  )
    throw Error('BROWSE_SCROLL_PURPOSE_REJECTED');
  if (
    action.kind === 'browsePlay' &&
    (step.spec.type !== 'video' ||
      intent.kind !== 'auxiliary' ||
      intent.purpose !== 'play' ||
      facebookBrowseSurface(action.url) !== 'video')
  )
    throw Error('BROWSE_PLAY_PURPOSE_REJECTED');
  if (
    action.kind === 'click' &&
    action.target.css === FACEBOOK_REEL_NEXT_CSS &&
    (step.spec.type !== 'video' ||
      intent.kind !== 'auxiliary' ||
      intent.purpose !== 'advance' ||
      !intent.beforeContentId ||
      action.target.scope !== undefined ||
      action.target.text !== undefined)
  )
    throw Error('BROWSE_REEL_NEXT_PURPOSE_REJECTED');
  if (
    action.kind === 'click' &&
    action.target.css === FACEBOOK_FRIEND_CONFIRM_CSS &&
    (step.spec.type !== 'friends' ||
      intent.kind !== 'auxiliary' ||
      intent.purpose !== 'acceptFriend' ||
      !intent.beforeContentId ||
      action.target.scope !== undefined ||
      action.target.text !== undefined)
  )
    throw Error('BROWSE_FRIEND_CONFIRM_PURPOSE_REJECTED');
  if (
    'documentEpoch' in action &&
    (action.documentEpoch !== intent.documentEpoch || action.routeEpoch !== intent.routeEpoch)
  )
    throw Error('BROWSE_ACTION_EPOCH_MISMATCH');
  if (
    intent.kind === 'like' &&
    (action.kind === 'activateTab' ||
      step.progress.likes >= step.spec.maxLikes ||
      intent.observedLikeCount < step.spec.minLikeCount)
  )
    throw Error('LIKE_TARGET_OR_BUDGET_REJECTED');
}
export function verifiedBrowseProgress(
  step: StepInstance,
  intent: Intent,
  verdict: Extract<Verdict, { outcome: 'VERIFIED' }>,
): Progress {
  if (step.spec.type === 'post') throw Error('BROWSE_EXECUTOR_CANNOT_PUBLISH');
  let likes = step.progress.likes;
  let accepted = step.progress.accepted;
  let cursor = step.progress.cursor;
  if (intent.kind === 'like') {
    if (
      verdict.effect.kind !== 'liked' ||
      verdict.effect.contentId !== intent.contentId ||
      likes >= step.spec.maxLikes
    )
      throw Error('LIKE_BUSINESS_EVIDENCE_MISMATCH');
    likes++;
  } else if (verdict.effect.kind !== 'auxiliary' || verdict.effect.purpose !== intent.purpose) {
    throw Error('AUXILIARY_BUSINESS_EVIDENCE_MISMATCH');
  } else if (step.spec.type === 'friends' && intent.purpose === 'acceptFriend') {
    if (step.spec.acceptMode === 'count' && (accepted ?? 0) >= step.spec.maxAccepts)
      throw Error('FRIEND_ACCEPT_BUDGET_EXCEEDED');
    accepted = (accepted ?? 0) + 1;
    if (verdict.effect.afterContentId) cursor = verdict.effect.afterContentId;
  }
  return {
    ...step.progress,
    revision: step.progress.revision + 1,
    likes,
    ...(accepted !== undefined ? { accepted } : {}),
    cursor,
  };
}
export type TimedBrowseReading = {
  reading: BrowseReading;
  context: ExecutionSession;
  stepId: string;
  startedAt: number;
  finishedAt: number;
};
// A feed observation may include bounded control-channel work; the five-second
// endpoint gap below still caps freshness. Video keeps its stricter media sample.
const usable = (sample: TimedBrowseReading) =>
  sample.reading.visible &&
  sample.reading.ready &&
  sample.finishedAt >= sample.startedAt &&
  sample.finishedAt - sample.startedAt <=
    (sample.reading.type === 'feed' || sample.reading.type === 'marketplace' ? 5000 : 2500) &&
  (sample.reading.type !== 'video' || (!sample.reading.paused && !sample.reading.buffering));
// Controller monotonic time only. No carry-over across route/media/lease/step changes or missing polls.
export function effectiveBrowseMilliseconds(
  previous: TimedBrowseReading | undefined,
  next: TimedBrowseReading,
): number {
  if (
    !previous ||
    !usable(previous) ||
    !usable(next) ||
    previous.stepId !== next.stepId ||
    !sameExecution(previous.context, next.context) ||
    !sameTabProof(previous.reading.proof, next.reading.proof) ||
    previous.reading.type !== next.reading.type ||
    previous.reading.contentId !== next.reading.contentId ||
    previous.reading.documentEpoch !== next.reading.documentEpoch ||
    previous.reading.routeEpoch !== next.reading.routeEpoch
  )
    return 0;
  const gap = next.finishedAt - previous.finishedAt,
    elapsed = next.startedAt - previous.finishedAt;
  if (gap <= 0 || elapsed <= 0) return 0;
  const documentReading = next.reading.type === 'feed' || next.reading.type === 'marketplace';
  // One second of read-completion jitter is allowed only when the next read
  // started within the original freshness window. Never bridge a missing poll,
  // action, changed document or a long-running read; cap credit at five seconds.
  if (gap > 5000 && (!documentReading || gap > 6000 || elapsed > 5000)) return 0;
  if (previous.reading.type === 'video' && next.reading.type === 'video') {
    const rate = next.reading.playbackRate,
      media = (next.reading.timeSeconds - previous.reading.timeSeconds) * 1000;
    if (rate !== previous.reading.playbackRate || media <= 0 || media > gap * rate + 250) return 0;
    return Math.floor(Math.min(elapsed, media / rate));
  }
  // Visible feed and marketplace observations use the same bounded endpoint rule.
  // Reading a page is controller work, not a pause in browsing. Route/content changes,
  // loading, hidden endpoints and missing polls still contribute nothing.
  return Math.floor(documentReading ? Math.min(gap, 5000) : elapsed);
}
