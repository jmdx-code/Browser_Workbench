import { z } from 'zod';
import {
  FbDigits,
  Id,
  NonNegFinite,
  PosInt,
  Sha256Hex,
  addIssue,
  optBool,
  sMax,
  strictObj,
} from './contracts.js';
import { FACEBOOK_COMPOSER_SCOPE } from './facebook-ui.js';
import { OwnedTabProof } from './kernel-state.js';
import { StoryVideoDerivation } from './story-video-derivation.js';
import { DispatchBinding } from './task-execution.js';
const COMPOSER_AUDIENCE_SCOPE = '[data-wb-audience-composer="1"]';
const AUDIENCE_GROUP_SCOPE = '[data-wb-audience-group="1"]';
const AUDIENCE_MENU_SCOPE = '[data-wb-audience-menu="1"]';
const AUDIENCE_DONE_CSS = '[data-wb-audience-done="1"]';
export const clearAudienceDefaultTarget = {
  scope: AUDIENCE_MENU_SCOPE,
  css: '[data-wb-audience-default="1"]',
} as const;
export const privacyTargets = {
  OPEN_AUDIENCE: { scope: COMPOSER_AUDIENCE_SCOPE, css: '[data-wb-audience-open="1"]' },
  SELECT_SELF: { scope: AUDIENCE_GROUP_SCOPE, css: '[data-wb-audience-self="1"]' },
  CONFIRM_AUDIENCE: { scope: AUDIENCE_MENU_SCOPE, css: AUDIENCE_DONE_CSS },
} as const;
export const ComposerAudienceReading = strictObj({
  url: sMax(4096),
  timeOrigin: NonNegFinite,
  ready: z.enum(['loading', 'interactive', 'complete']),
  phase: z.enum(['COMPOSER', 'MENU', 'UNAVAILABLE']),
  audience: z.literal('SELF').nullable(),
  draftEmpty: z.boolean(),
  openEnabled: z.boolean(),
  selfSelected: z.boolean(),
  selfEnabled: z.boolean(),
  defaultChecked: z.boolean().nullable(),
  confirmEnabled: z.boolean(),
  selfAvailable: optBool,
});
export type ComposerAudience = z.infer<typeof ComposerAudienceReading>;
export { PostAILabelSetting, type AILabelSetting } from './contracts.js';
export const facebookAILabelScope = '[data-wb-ai-label-scope="1"]';
export const facebookAILabelSwitch = '[role="switch"][data-wb-ai-label-switch="1"]';
const optCss = sMax(200).nullable();
export const facebookAILabelReading = strictObj({
  url: sMax(2048),
  timeOrigin: NonNegFinite,
  ready: z.boolean(),
  visible: z.boolean(),
  phase: z.enum(['absent', 'composer', 'settings', 'ambiguous']),
  value: z.boolean().nullable(),
  openCSS: optCss,
  switchEnabled: z.boolean(),
  confirmEnabled: z.boolean(),
  mode: z.enum(['dialog', 'inline']).optional(),
}).superRefine((v, ctx) => {
  if (['composer', 'settings'].includes(v.phase) && v.value === null)
    addIssue(ctx, 'AI_LABEL_VALUE_REQUIRED');
});
export type AILabelReading = z.infer<typeof facebookAILabelReading>;
const postAILabelPurposes = ['OPEN_AI_LABEL', 'SET_AI_LABEL', 'CONFIRM_AI_LABEL'] as const;
export type AILabelPurpose = (typeof postAILabelPurposes)[number];
export function aiLabelTarget(purpose: AILabelPurpose, reading: AILabelReading) {
  if (purpose === 'OPEN_AI_LABEL') {
    if (!reading.openCSS) throw Error('POST_AI_LABEL_CONFIGURATION_UNAVAILABLE');
    return { scope: facebookAILabelScope, css: reading.openCSS };
  }
  return {
    scope: facebookAILabelScope,
    css: purpose === 'SET_AI_LABEL' ? facebookAILabelSwitch : '[data-wb-ai-label-confirm="1"]',
  };
}
export const FACEBOOK_BACKGROUND_OPTIONS = '[data-wb-background-open="1"]';
export const FACEBOOK_NO_BACKGROUND = '[data-wb-background-clear="1"]';
export const nativeSolidBackgrounds = [
  { id: 'red', label: 'Solid red, background, background 2', color: 'rgb(226, 1, 59)' },
  { id: 'purple', label: 'Solid purple, background, background 1', color: 'rgb(198, 0, 255)' },
  { id: 'black', label: 'Solid black, background, background 3', color: 'rgb(17, 17, 17)' },
] as const;
export const nativeBackgroundCSS = (label: string) => {
  const solid = nativeSolidBackgrounds.find((v) => v.label === label);
  return solid ? `[data-wb-background="${solid.id}"]` : `[role="button"][aria-label="${label}"]`;
};
export const FacebookBackground = strictObj({
  url: sMax(4096),
  timeOrigin: NonNegFinite,
  ready: z.boolean(),
  visible: z.boolean(),
  draftEmpty: z.boolean(),
  phase: z.enum(['absent', 'plain', 'solid', 'unsupported', 'ambiguous']),
  openCSS: optCss,
  clearCSS: optCss,
  selectedCSS: optCss,
  options: z.array(strictObj({ id: z.enum(['red', 'purple', 'black']), css: sMax(200) })).max(3),
});
export const facebookBackgroundScope = FACEBOOK_COMPOSER_SCOPE;
export const StoryPrivacyReading = strictObj({
  phase: z.enum(['CLOSED', 'MENU', 'CHANGE_CONFIRMATION', 'UNAVAILABLE']),
  draftSelection: z.enum(['PUBLIC', 'FRIENDS', 'CUSTOM']).nullable(),
  openEnabled: z.boolean(),
  friendsEnabled: z.boolean(),
  saveEnabled: z.boolean(),
  cancelEnabled: z.boolean(),
});
export type StoryPrivacy = z.infer<typeof StoryPrivacyReading>;
const menu = '[data-wb-story-privacy-dialog="1"]';
const enabledCss = (attr: string) => `[${attr}="1"]:not([aria-disabled="true"]):not(:disabled)`;
export const storyPrivacyTargets = {
  open: { css: '[data-wb-story-privacy-open="1"]' },
  selectFriends: { scope: menu, css: '[data-wb-story-privacy-friends="1"]' },
  save: { scope: menu, css: enabledCss('data-wb-story-privacy-save') },
  saveChange: {
    scope: '[data-wb-story-privacy-change="1"]',
    css: enabledCss('data-wb-story-privacy-save'),
  },
  close: { scope: menu, css: enabledCss('data-wb-story-privacy-close') },
} as const;
export const FacebookVideoTransfer = strictObj({
  source: z.literal('owned-video-upload-transfer'),
  binding: DispatchBinding,
  proof: OwnedTabProof,
  attemptId: Id,
  stageId: Id,
  fingerprint: Sha256Hex,
  digest: Sha256Hex,
  bytes: PosInt,
  videoId: FbDigits,
  timeOrigin: NonNegFinite,
  url: sMax(4096),
  receivedBytes: PosInt,
  derivation: StoryVideoDerivation.optional(),
}).superRefine((t, ctx) => {
  if (
    t.derivation &&
    (t.digest !== t.derivation.digest ||
      t.bytes !== t.derivation.bytes ||
      t.receivedBytes !== t.bytes)
  )
    addIssue(ctx, 'VIDEO_DERIVATION_TRANSFER_MISMATCH');
});
