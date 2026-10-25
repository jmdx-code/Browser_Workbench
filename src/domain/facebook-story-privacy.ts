import { Spec } from '../shared/browser-actions.js';
import type { z } from 'zod';
import { storyPrivacyTargets, type StoryPrivacy } from '../shared/facebook-story-privacy.js';

// Derived only from independently verified operations in this original attempt.
// It is not a second saved task state or permission to replay an operation.
export type StoryPrivacyCheckpoint =
  'OPEN_INITIAL' | 'SELECT_FRIENDS' | 'SAVE' | 'OPEN_SAVED' | 'CLOSE_VERIFIED' | 'READY';
export type StoryPrivacyDecision =
  | { kind: 'wait'; reason: string }
  | { kind: 'ready' }
  | { kind: 'action'; action: keyof typeof storyPrivacyTargets; target: z.infer<typeof Spec> };

export function decideStoryFriendsPrivacy(
  checkpoint: StoryPrivacyCheckpoint,
  reading: StoryPrivacy | null,
): StoryPrivacyDecision {
  if (!reading || reading.phase === 'UNAVAILABLE')
    return { kind: 'wait', reason: 'STORY_PRIVACY_UNAVAILABLE' };
  const action = (
    name: keyof typeof storyPrivacyTargets,
    allowed: boolean,
  ): StoryPrivacyDecision =>
    allowed
      ? { kind: 'action', action: name, target: Spec.parse(storyPrivacyTargets[name]) }
      : { kind: 'wait', reason: 'STORY_PRIVACY_CONTROL_NOT_READY' };
  if (checkpoint === 'READY') {
    if (reading.phase !== 'CLOSED') throw Error('STORY_PRIVACY_CHANGED_AFTER_VERIFICATION');
    return { kind: 'ready' };
  }
  if (checkpoint === 'OPEN_INITIAL' || checkpoint === 'OPEN_SAVED') {
    if (reading.phase !== 'CLOSED') throw Error('STORY_PRIVACY_UNEXPECTED_DIALOG');
    return action('open', reading.openEnabled);
  }
  if (checkpoint === 'SAVE' && reading.phase === 'CHANGE_CONFIRMATION')
    return action('saveChange', reading.saveEnabled);
  if (reading.phase !== 'MENU') throw Error('STORY_PRIVACY_DIALOG_CLOSED');
  if (checkpoint === 'SELECT_FRIENDS') {
    // Already-Friends still needs a verified close, but no redundant Save or range change.
    return reading.draftSelection === 'FRIENDS'
      ? action('close', reading.cancelEnabled)
      : action('selectFriends', reading.draftSelection !== null && reading.friendsEnabled);
  }
  if (reading.draftSelection !== 'FRIENDS') throw Error('STORY_FRIENDS_AUDIENCE_UNCONFIRMED');
  return checkpoint === 'SAVE'
    ? action('save', reading.saveEnabled)
    : action('close', reading.cancelEnabled);
}
