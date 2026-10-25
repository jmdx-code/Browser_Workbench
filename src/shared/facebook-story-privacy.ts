import { z } from 'zod';

export const StoryPrivacyReading = z
  .object({
    phase: z.enum(['CLOSED', 'MENU', 'CHANGE_CONFIRMATION', 'UNAVAILABLE']),
    draftSelection: z.enum(['PUBLIC', 'FRIENDS', 'CUSTOM']).nullable(),
    openEnabled: z.boolean(),
    friendsEnabled: z.boolean(),
    saveEnabled: z.boolean(),
    cancelEnabled: z.boolean(),
  })
  .strict();
export type StoryPrivacy = z.infer<typeof StoryPrivacyReading>;

const menu = '[data-wb-story-privacy-dialog="1"]';
export const storyPrivacyTargets = {
  open: { css: '[data-wb-story-privacy-open="1"]' },
  selectFriends: { scope: menu, css: '[data-wb-story-privacy-friends="1"]' },
  save: {
    scope: menu,
    css: '[data-wb-story-privacy-save="1"]:not([aria-disabled="true"]):not(:disabled)',
  },
  saveChange: {
    scope: '[data-wb-story-privacy-change="1"]',
    css: '[data-wb-story-privacy-save="1"]:not([aria-disabled="true"]):not(:disabled)',
  },
  close: {
    scope: menu,
    css: '[data-wb-story-privacy-close="1"]:not([aria-disabled="true"]):not(:disabled)',
  },
} as const;
