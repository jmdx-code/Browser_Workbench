import { z } from 'zod';
import { FACEBOOK_COMPOSER_SCOPE } from './facebook-ui.js';

export const PostAILabelSetting = z.enum(['preserve-current', 'on', 'off']);
export type AILabelSetting = z.infer<typeof PostAILabelSetting>;
export const facebookAILabelScope = FACEBOOK_COMPOSER_SCOPE;
export const facebookAILabelSwitch = '[role="switch"][aria-label="Add AI label"]';
export const facebookAILabelReading = z
  .object({
    url: z.string().max(2048),
    timeOrigin: z.number().finite().nonnegative(),
    ready: z.boolean(),
    visible: z.boolean(),
    phase: z.enum(['absent', 'composer', 'settings', 'ambiguous']),
    value: z.boolean().nullable(),
    openCSS: z.string().max(200).nullable(),
    switchEnabled: z.boolean(),
    confirmEnabled: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (['composer', 'settings'].includes(value.phase) && value.value === null)
      context.addIssue({ code: 'custom', message: 'AI_LABEL_VALUE_REQUIRED' });
  });
export type AILabelReading = z.infer<typeof facebookAILabelReading>;
export const postAILabelPurposes = ['OPEN_AI_LABEL', 'SET_AI_LABEL', 'CONFIRM_AI_LABEL'] as const;
export type AILabelPurpose = (typeof postAILabelPurposes)[number];
export function aiLabelTarget(purpose: AILabelPurpose, reading: AILabelReading) {
  if (purpose === 'OPEN_AI_LABEL') {
    if (!reading.openCSS) throw Error('POST_AI_LABEL_CONFIGURATION_UNAVAILABLE');
    return { scope: facebookAILabelScope, css: reading.openCSS };
  }
  return purpose === 'SET_AI_LABEL'
    ? { scope: facebookAILabelScope, css: facebookAILabelSwitch }
    : { scope: facebookAILabelScope, css: '[role="button"]', text: 'Got it' };
}
