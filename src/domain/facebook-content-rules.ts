import { Spec } from '../shared/browser-actions.js';
import {
  privacyTargets,
  clearAudienceDefaultTarget,
  aiLabelTarget,
  storyPrivacyTargets,
  type ComposerAudience,
  type AILabelReading,
  type AILabelSetting,
  type AILabelPurpose,
  type StoryPrivacy,
} from '../shared/facebook-post-options.js';
import {
  AvatarObservation,
  FACEBOOK_PROFILE_CONTROL_LABELS,
  NameObservation,
  type ObservedAvatar,
  type ObservedName,
} from '../shared/account-display.js';
import { kernelFacebookReadURL } from '../shared/kernel-policy.js';
import { matchFacebookHomeCopy } from '../shared/facebook-ui.js';
import type { z } from 'zod';
import { pageNodes } from './facebook-page-analysis.js';
import type { PageProjection } from '../shared/page-read.js';
export function audienceTarget(reading: ComposerAudience, purpose: keyof typeof privacyTargets) {
  if (reading.ready === 'loading' || !reading.draftEmpty) return null;
  if (
    purpose === 'CONFIRM_AUDIENCE' &&
    reading.phase === 'MENU' &&
    reading.selfSelected &&
    reading.defaultChecked === true
  )
    return Spec.parse(clearAudienceDefaultTarget);
  const allowed =
    purpose === 'OPEN_AUDIENCE'
      ? reading.phase === 'COMPOSER' && reading.openEnabled && reading.audience !== 'SELF'
      : purpose === 'SELECT_SELF'
        ? reading.phase === 'MENU' && !reading.selfSelected && reading.selfEnabled
        : reading.phase === 'MENU' &&
          reading.selfSelected &&
          reading.defaultChecked === false &&
          reading.confirmEnabled;
  return allowed ? Spec.parse(privacyTargets[purpose]) : null;
}
export function decidePostAILabel(
  setting: AILabelSetting,
  reading: AILabelReading | undefined,
  applied: (purpose: AILabelPurpose) => boolean,
) {
  if (setting === 'preserve-current') return { kind: 'ready' as const };
  if (!reading?.ready || !reading.visible) return { kind: 'wait' as const };
  const wanted = setting === 'on',
    opened = applied('OPEN_AI_LABEL'),
    changed = applied('SET_AI_LABEL'),
    confirmed = applied('CONFIRM_AI_LABEL'),
    action = (purpose: AILabelPurpose) => ({
      kind: 'action' as const,
      purpose,
      target: aiLabelTarget(purpose, reading),
    });
  if (reading.phase === 'composer') {
    if (reading.mode === 'inline') {
      if (reading.value === wanted) return { kind: 'ready' as const };
      if (changed) throw Error('POST_AI_LABEL_CHANGED');
      return reading.switchEnabled ? action('SET_AI_LABEL') : { kind: 'wait' as const };
    }
    if (opened && !confirmed) throw Error('POST_AI_LABEL_SETTINGS_CLOSED');
    if (reading.value === wanted) return { kind: 'ready' as const };
    if (opened || changed || confirmed) throw Error('POST_AI_LABEL_CHANGED');
    return action('OPEN_AI_LABEL');
  }
  if (reading.phase !== 'settings' || !opened || confirmed || reading.value === null)
    throw Error('POST_AI_LABEL_CONFIGURATION_UNAVAILABLE');
  if (reading.value !== wanted) {
    if (changed) throw Error('POST_AI_LABEL_CHANGED');
    return reading.switchEnabled ? action('SET_AI_LABEL') : { kind: 'wait' as const };
  }
  return reading.confirmEnabled ? action('CONFIRM_AI_LABEL') : { kind: 'wait' as const };
}
export type StoryPrivacyCheckpoint =
  'OPEN_INITIAL' | 'SELECT_FRIENDS' | 'SAVE' | 'OPEN_SAVED' | 'CLOSE_VERIFIED' | 'READY';
type StoryPrivacyDecision =
  | { kind: 'wait'; reason: string }
  | { kind: 'ready' }
  | { kind: 'action'; action: keyof typeof storyPrivacyTargets; target: z.infer<typeof Spec> };
export function decideStoryFriendsPrivacy(
  checkpoint: StoryPrivacyCheckpoint,
  reading: StoryPrivacy | null,
  audience: 'friends' | 'preserve-current' = 'friends',
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
    if (audience === 'preserve-current')
      return action('close', reading.draftSelection !== null && reading.cancelEnabled);
    if (reading.draftSelection !== 'FRIENDS' && !reading.friendsEnabled)
      throw Error('STORY_FRIENDS_AUDIENCE_UNAVAILABLE');
    return reading.draftSelection === 'FRIENDS'
      ? action('close', reading.cancelEnabled)
      : action('selectFriends', reading.draftSelection !== null && reading.friendsEnabled);
  }
  if (reading.draftSelection !== 'FRIENDS') throw Error('STORY_FRIENDS_AUDIENCE_UNCONFIRMED');
  return checkpoint === 'SAVE'
    ? action('save', reading.saveEnabled)
    : action('close', reading.cancelEnabled);
}
const isFacebookHome = (page: PageProjection, allowInteractive: boolean) =>
    kernelFacebookReadURL(page.url) &&
    new URL(page.url).pathname === '/' &&
    (allowInteractive ? page.ready !== 'loading' : page.ready === 'complete') &&
    !pageNodes(page, 'loginForm').length,
  parseObs = <T>(schema: z.ZodType<T>, raw: Record<string, unknown>): T | null => {
    const parsed = schema.safeParse({ ...raw, actingIdentityVerified: false });
    return parsed.success ? parsed.data : null;
  };
export function observeFacebookHomeAvatar(page: PageProjection): ObservedAvatar | null {
  if (!isFacebookHome(page, false)) return null;
  const controls = pageNodes(page, 'ownProfileControls'),
    images = pageNodes(page, 'ownProfileImages');
  if (
    controls.length !== 1 ||
    !controls[0]?.visible ||
    images.length !== 1 ||
    !images[0]?.visible ||
    !FACEBOOK_PROFILE_CONTROL_LABELS.includes(controls[0]?.attributes['aria-label'] ?? '')
  )
    return null;
  const img = images[0];
  if (!['img', 'image'].includes(img.tag.toLowerCase())) return null;
  const resources = [
    ...new Set(
      [img.attributes.href, img.attributes['xlink:href'], img.attributes.src].filter(
        (v): v is string => !!v,
      ),
    ),
  ];
  return resources.length === 1
    ? parseObs(AvatarObservation, { source: 'facebook-home-profile-control', url: resources[0] })
    : null;
}
export function observeFacebookHomeName(page: PageProjection): ObservedName | null {
  if (!isFacebookHome(page, true)) return null;
  const composers = pageNodes(page, 'homeComposers'),
    links = pageNodes(page, 'composerProfileLinks'),
    prompts = pageNodes(page, 'composerPrompts'),
    [region] = composers,
    [link] = links,
    [prompt] = prompts;
  if (
    composers.length !== 1 ||
    links.length !== 1 ||
    prompts.length !== 1 ||
    !region?.visible ||
    !link?.visible ||
    link.tag.toLowerCase() !== 'a' ||
    !prompt?.visible
  )
    return null;
  const matched = matchFacebookHomeCopy(
    region.attributes['aria-label'] ?? '',
    link.attributes['aria-label'] ?? '',
    prompt.text,
  );
  if (!matched) return null;
  try {
    const href = link.attributes.href;
    if (!href || /[\u0000-\u0020\u007f]/.test(href)) return null;
    const u = new URL(href, 'https://www.facebook.com/');
    if (
      u.origin !== 'https://www.facebook.com' ||
      u.username ||
      u.password ||
      u.hash ||
      u.pathname !== '/profile.php' ||
      !/^\d{1,30}$/.test(u.searchParams.get('id') ?? '') ||
      [...u.searchParams.keys()].some((k) => k !== 'id') ||
      u.searchParams.getAll('id').length !== 1
    )
      return null;
  } catch {
    return null;
  }
  return parseObs(NameObservation, { source: 'facebook-home-composer', name: matched.name });
}
