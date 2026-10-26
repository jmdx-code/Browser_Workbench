import type { Awaitable } from './persistence.js';
import type { Action } from '../shared/browser-actions.js';
import type { PostIntent } from '../shared/material-index.js';
import type { AILabelSetting } from '../shared/facebook-ai-label.js';
import type {
  PostLink,
  PreparePost,
  AttemptResult,
  NegativePostEvidence,
  PendingArchive,
} from '../shared/material-post.js';
import type { ExecutionReceipt } from '../shared/task-execution.js';
import type { Operation } from '../shared/task-contracts.js';
import { storyPrivacyTargets } from '../shared/facebook-story-privacy.js';
import {
  facebookAILabelScope,
  facebookAILabelSwitch,
  postAILabelPurposes,
} from '../shared/facebook-ai-label.js';
import {
  FACEBOOK_BACKGROUND_OPTIONS,
  FACEBOOK_NO_BACKGROUND,
  facebookBackgroundScope,
  nativeSolidBackgrounds,
  nativeBackgroundCSS,
} from '../shared/facebook-background.js';

export const NATIVE_COLOR_BACKGROUND_MAX_CHARS = 120;
export const requiresNativePostBackground = (intent: PostIntent) =>
  'resource' in intent &&
  intent.resource.row.background === 'color' &&
  !intent.resource.row.media.length &&
  [...intent.snapshot.text.trim()].length <= NATIVE_COLOR_BACKGROUND_MAX_CHARS &&
  intent.snapshot.text.split('\n').length <= 4;

export const postAILabelSetting = (
  intent: PostIntent,
  stepAILabel?: AILabelSetting,
): AILabelSetting =>
  ('resource' in intent ? intent.resource.row.aiLabel : undefined) ??
  stepAILabel ??
  'preserve-current';

export interface MaterialPostRepository {
  prepare(input: PreparePost): Awaitable<Operation>;
  link(operationId: string): Awaitable<PostLink>;
  verify(receipt: ExecutionReceipt): Awaitable<void>;
  reconcile(receipt: ExecutionReceipt): Awaitable<void>;
  cancelUnsent(attemptId: string): Awaitable<void>;
  resolveNotPublished(evidence: NegativePostEvidence): Awaitable<void>;
  result(attemptId: string): Awaitable<AttemptResult | null>;
  archives(): Awaitable<PendingArchive[]>;
}
export function validatePostAction(
  intent: PostIntent,
  purpose: PostLink['purpose'],
  action: Action,
) {
  if (!('tabId' in action) || action.tabId !== intent.proof.tabId)
    throw Error('POST_ACTION_TARGET_MISMATCH');
  if (purpose === 'PREPARE_HOME') {
    if (action.kind !== 'browseNavigate' || action.url !== 'https://www.facebook.com/')
      throw Error('POST_HOME_PREPARATION_TARGET_MISMATCH');
  } else if (purpose === 'PREPARE_STORY') {
    if (
      action.kind !== 'browseNavigate' ||
      action.url !== 'https://www.facebook.com/stories/create/'
    )
      throw Error('STORY_PREPARATION_TARGET_MISMATCH');
  } else if (
    purpose === 'SELECT_FRIENDS' ||
    purpose === 'VERIFY_AUDIENCE' ||
    purpose === 'CLOSE_AUDIENCE'
  ) {
    const target =
      storyPrivacyTargets[
        purpose === 'SELECT_FRIENDS'
          ? 'selectFriends'
          : purpose === 'VERIFY_AUDIENCE'
            ? 'open'
            : 'close'
      ];
    if (
      action.kind !== 'click' ||
      action.target.scope !== ('scope' in target ? target.scope : undefined) ||
      action.target.css !== target.css ||
      action.target.text !== ('text' in target ? target.text : undefined)
    )
      throw Error('STORY_PRIVACY_TARGET_MISMATCH');
  } else if (postAILabelPurposes.some((value) => value === purpose)) {
    const allowed =
      purpose === 'OPEN_AI_LABEL'
        ? [
            '[role="button"][aria-label="AI label off"]',
            '[role="button"][aria-label="AI label on"]',
            '[role="button"][data-wb-ai-label-open="1"]',
          ]
        : purpose === 'SET_AI_LABEL'
          ? [facebookAILabelSwitch]
          : ['[data-wb-ai-label-confirm="1"]', '[role="button"]'];
    if (
      action.kind !== 'click' ||
      action.target.scope !== facebookAILabelScope ||
      !allowed.includes(action.target.css) ||
      action.target.text !==
        (purpose === 'CONFIRM_AI_LABEL' && action.target.css === '[role="button"]'
          ? 'Got it'
          : undefined)
    )
      throw Error('POST_AI_LABEL_TARGET_MISMATCH');
  } else if (purpose === 'OPEN_BACKGROUND' || purpose === 'SET_BACKGROUND') {
    const css =
      purpose === 'OPEN_BACKGROUND'
        ? [FACEBOOK_BACKGROUND_OPTIONS]
        : requiresNativePostBackground(intent)
          ? nativeSolidBackgrounds.map((value) => nativeBackgroundCSS(value.label))
          : [FACEBOOK_NO_BACKGROUND];
    if (
      action.kind !== 'click' ||
      action.target.scope !== facebookBackgroundScope ||
      !css.includes(action.target.css) ||
      action.target.text !== undefined
    )
      throw Error('POST_BACKGROUND_TARGET_MISMATCH');
  } else if (purpose === 'SET_TEXT') {
    if (action.kind !== 'typeText' || action.text !== intent.snapshot.text)
      throw Error('POST_TEXT_SNAPSHOT_MISMATCH');
  } else if (purpose === 'UPLOAD_MEDIA') {
    if (
      action.kind !== 'uploadMedia' ||
      action.attemptId !== intent.attemptId ||
      action.fingerprint !== intent.fingerprint
    )
      throw Error('POST_UPLOAD_INTENT_MISMATCH');
  } else if (action.kind !== 'click') throw Error('POST_ACTION_PURPOSE_INVALID');
  if (['PREPARE_MEDIA', 'UPLOAD_MEDIA'].includes(purpose) && intent.snapshot.format === 'text')
    throw Error('POST_MEDIA_REQUIRED');
}
export function assertMaterialHistoryEligibility(
  accountAlreadyUsed: boolean,
  anyAccountUsed: boolean,
  allowRepeat: boolean,
) {
  if (accountAlreadyUsed) throw Error('MATERIAL_CONTENT_ALREADY_USED_BY_ACCOUNT');
  if (anyAccountUsed && !allowRepeat) throw Error('MATERIAL_CONTENT_ALREADY_CONSUMED');
}
export function validatePostMediaObservation(
  intent: PostIntent,
  evidence: import('../shared/material-post.js').VerifiedPostReceipt['evidence'],
) {
  if (evidence.purpose !== 'UPLOAD_MEDIA' || evidence.outcome !== 'APPLIED') return;
  if (
    !evidence.media ||
    evidence.media.format !== intent.snapshot.format ||
    evidence.media.count !== intent.snapshot.files.filter((file) => file.role !== 'text').length
  )
    throw Error('POST_MEDIA_OBSERVATION_MISMATCH');
}
