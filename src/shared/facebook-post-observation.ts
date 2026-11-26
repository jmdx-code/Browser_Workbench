import { z } from 'zod';
import {
  FbDigits,
  NonNegFinite,
  NonNegInt,
  Sha256Hex,
  optBool,
  sMax,
  strictObj,
} from './contracts.js';
// Private DOM observations from the owned task page, never a public publishing permission.
const media = strictObj({
  kind: z.enum(['image', 'video']),
  name: sMax(200).nullable(),
  ready: z.boolean(),
  durationSeconds: z.number().finite().positive().optional(),
  previewBytes: strictObj({
    source: z.literal('owned-preview-blob'),
    sha256: Sha256Hex,
    size: NonNegInt.max(32 * 1024 * 1024),
  }).optional(),
});
export const FacebookPostEffects = strictObj({
  url: sMax(4096),
  timeOrigin: NonNegFinite,
  ready: z.enum(['loading', 'interactive', 'complete']),
  composer: strictObj({
    text: sMax(100_000),
    files: z.array(strictObj({ name: sMax(200), size: NonNegInt })).max(20),
    media: z.array(media).max(20),
    uploaded: z.boolean(),
    busy: z.boolean(),
    submitEnabled: z.boolean(),
    advanceEnabled: optBool,
  }).nullable(),
  posts: z
    .array(
      strictObj({
        accountId: FbDigits.nullable(),
        postId: sMax(200).nullable(),
        permalink: sMax(4096).nullable(),
        text: sMax(100_000).nullable(),
        expanded: z.boolean(),
        nestedShare: z.boolean(),
        photos: z.array(FbDigits).max(20),
        videoId: FbDigits.nullable(),
        videoReady: z.boolean(),
      }),
    )
    .max(20),
});
export type PostEffects = z.infer<typeof FacebookPostEffects>;
