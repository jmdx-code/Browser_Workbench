import { z } from 'zod';

export const COMPOSER_AUDIENCE_SCOPE =
  '[role="dialog"]:has(form [role="textbox"][contenteditable="true"])';
export const AUDIENCE_GROUP_SCOPE = '[data-wb-audience-group="1"]';
export const AUDIENCE_MENU_SCOPE = '[data-wb-audience-menu="1"]';
export const AUDIENCE_DONE_CSS = '[data-wb-audience-done="1"]';
export const privacyTargets = {
  OPEN_AUDIENCE: { scope: COMPOSER_AUDIENCE_SCOPE, css: '[data-wb-audience-open="1"]' },
  SELECT_SELF: { scope: AUDIENCE_GROUP_SCOPE, css: '[data-wb-audience-self="1"]' },
  CONFIRM_AUDIENCE: { scope: AUDIENCE_MENU_SCOPE, css: AUDIENCE_DONE_CSS },
} as const;
export const ComposerAudienceReading = z
  .object({
    url: z.string().max(4096),
    timeOrigin: z.number().finite().nonnegative(),
    ready: z.enum(['loading', 'interactive', 'complete']),
    phase: z.enum(['COMPOSER', 'MENU', 'UNAVAILABLE']),
    audience: z.literal('SELF').nullable(),
    draftEmpty: z.boolean(),
    openEnabled: z.boolean(),
    selfSelected: z.boolean(),
    selfEnabled: z.boolean(),
    defaultChecked: z.boolean().nullable(),
    confirmEnabled: z.boolean(),
  })
  .strict();
export type ComposerAudience = z.infer<typeof ComposerAudienceReading>;
