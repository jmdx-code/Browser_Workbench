import { z } from 'zod';
import { StoryPrivacyReading } from './facebook-story-privacy.js';
import { FacebookVideoTransfer } from './facebook-video-transfer.js';

export const nativeStoryMediaTextLimit = 200;

export const FacebookStoryPage = z
  .object({
    url: z.string().max(2048),
    timeOrigin: z.number().finite().nonnegative(),
    locale: z.string().max(40),
    ready: z.boolean(),
    visible: z.boolean(),
    phase: z.enum(['entry', 'text-editor', 'media-editor', 'ambiguous']),
    nativeVideoCanvas: z.literal(true).optional(),
    nativeVideoControls: z
      .object({ css: z.string().max(1000), enabled: z.boolean() })
      .strict()
      .optional(),
    videoTransfer: FacebookVideoTransfer.optional(),
    nativeVideoInput: z
      .object({
        bytes: z
          .number()
          .int()
          .positive()
          .max(32 * 1024 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    media: z
      .object({
        kind: z.enum(['image', 'video']),
        ready: z.boolean(),
        bytes: z.number().int().positive().nullable(),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      })
      .strict()
      .nullable()
      .optional(),
    addText: z
      .object({
        css: z.string().max(200),
        text: z.literal('Add text').optional(),
        enabled: z.boolean(),
      })
      .strict()
      .nullable()
      .optional(),
    textEditing: z.boolean().optional(),
    text: z.string().max(100_000).nullable(),
    textCSS: z.string().max(200).nullable(),
    mediaCSS: z.string().max(200).nullable(),
    textEntry: z
      .object({ css: z.string().max(200), enabled: z.boolean() })
      .strict()
      .nullable(),
    submit: z
      .object({ css: z.string().max(200), enabled: z.boolean() })
      .strict()
      .nullable(),
    fontCSS: z.string().max(200).nullable(),
    ai: z
      .object({ css: z.string().max(200), checked: z.boolean() })
      .strict()
      .nullable(),
    privacy: StoryPrivacyReading.nullable(),
  })
  .strict();
export type StoryPage = z.infer<typeof FacebookStoryPage>;
export const storyMediaTextFinish = {
  scope: '[data-wb-story-preview="1"]',
  css: '[data-wb-story-text-finish="1"]',
} as const;
