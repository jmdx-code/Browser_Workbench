import { z } from 'zod';
import { PosInt, Sha256Hex, intRange, sReq, strictObj } from './contracts.js';
const dim = intRange(240, 4096);
// Immutable evidence on the original upload stage, not another publication/usage ledger.
export const StoryVideoDerivation = strictObj({
  version: z.literal(1),
  kind: z.literal('story-caption-video'),
  text: sReq(2000),
  sourceSha256: Sha256Hex,
  textSha256: Sha256Hex,
  captionSha256: Sha256Hex,
  rendererVersion: z.literal(1),
  runtimeArchiveSha256: Sha256Hex,
  digest: Sha256Hex,
  bytes: PosInt.max(10 * 1024 ** 3),
  width: dim,
  height: dim,
  duration: z.number().finite().positive(),
});
export type VideoDerivation = z.infer<typeof StoryVideoDerivation>;
