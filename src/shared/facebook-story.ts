import { z } from 'zod';
import { NonNegFinite, PosInt, Sha256Hex, optBool, sMax, strictObj } from './contracts.js';
import { FacebookVideoTransfer, StoryPrivacyReading } from './facebook-post-options.js';
export const nativeStoryMediaTextLimit = 200;
const str200 = sMax(200),
  control = strictObj({ css: str200, enabled: z.boolean() });
export const FacebookStoryPage = strictObj({
  url: sMax(2048),
  timeOrigin: NonNegFinite,
  locale: sMax(40),
  ready: z.boolean(),
  visible: z.boolean(),
  phase: z.enum(['entry', 'text-editor', 'media-editor', 'ambiguous']),
  hasSelectedMedia: optBool,
  nativeVideoCanvas: z.literal(true).optional(),
  nativeVideoControls: strictObj({ css: sMax(1000), enabled: z.boolean() }).optional(),
  videoTransfer: FacebookVideoTransfer.optional(),
  nativeVideoInput: strictObj({
    bytes: PosInt.max(32 * 1024 * 1024),
    sha256: Sha256Hex,
  }).optional(),
  media: strictObj({
    kind: z.enum(['image', 'video']),
    ready: z.boolean(),
    bytes: PosInt.nullable(),
    sha256: Sha256Hex.nullable(),
  })
    .nullable()
    .optional(),
  addText: strictObj({ css: str200, text: z.literal('Add text').optional(), enabled: z.boolean() })
    .nullable()
    .optional(),
  textEditing: optBool,
  text: sMax(100_000).nullable(),
  textCSS: str200.nullable(),
  mediaCSS: str200.nullable(),
  textEntry: control.nullable(),
  submit: control.nullable(),
  fontCSS: str200.nullable(),
  ai: strictObj({ css: str200, checked: z.boolean() }).nullable(),
  privacy: StoryPrivacyReading.nullable(),
});
export type StoryPage = z.infer<typeof FacebookStoryPage>;
export const storyMediaTextFinish = {
  scope: '[data-wb-story-preview="1"]',
  css: '[data-wb-story-text-finish="1"]',
} as const;
