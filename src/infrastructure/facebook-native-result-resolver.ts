import type { Awaitable } from '../domain/persistence.js';
import type { FacebookPostOriginal } from '../domain/facebook-post-execution.js';
import { FacebookPostEffects, type PostEffects } from '../shared/facebook-post-observation.js';
import type {
  AcceptedNativeFacebookPost,
  NativeFacebookPostResultResolver,
} from './facebook-native-submission-wire.js';
import {
  facebookNativeResultUrl,
  sameFacebookNativeResultUrl,
} from '../shared/facebook-result-route.js';

// The port opens a new read page under the existing task's native owner, closes that exact
// proof, and checks the original pending SUBMIT before and after every await. It cannot input.
export interface NativeFacebookResultLookup {
  ready(): boolean;
  read(
    original: FacebookPostOriginal,
    result: AcceptedNativeFacebookPost,
    guard: () => Awaitable<void>,
  ): Promise<PostEffects | null>;
}

export class LookupNativeFacebookPostResultResolver implements NativeFacebookPostResultResolver {
  // One ephemeral observation for this managed owner. Durable native correlations remain
  // in the original repository; reopening it never manufactures this closed-page evidence.
  private observation: {
    original: FacebookPostOriginal;
    effects: PostEffects;
    result: { postId: string; photos: string[]; videoId: string | null };
  } | null = null;
  constructor(private readonly lookup: NativeFacebookResultLookup) {}
  ready() {
    return this.lookup.ready();
  }
  supportsOriginal(original: FacebookPostOriginal) {
    return (
      this.ready() &&
      ['text', 'single-image', 'multi-image', 'video'].includes(original.intent.snapshot.format)
    );
  }
  async resolve(
    result: AcceptedNativeFacebookPost,
    original: FacebookPostOriginal,
    guard: () => Awaitable<void>,
  ) {
    this.observation = null;
    await guard();
    if (
      !this.supportsOriginal(original) ||
      original.link.purpose !== 'SUBMIT' ||
      (original.intent.snapshot.format === 'video') !== Boolean(result.videoId)
    )
      return null;
    const input = await this.lookup.read(original, result, guard);
    await guard();
    if (!input) return null;
    const matched = matchObservedFacebookNativeResult(result, original, input);
    if (matched) this.observation = structuredClone({ original, effects: input, result: matched });
    return matched;
  }
  async observedEffects(
    original: FacebookPostOriginal,
    result: { postId: string; photos: string[]; videoId: string | null },
    guard: () => Awaitable<void>,
  ) {
    await guard();
    const saved = this.observation;
    if (
      !saved ||
      JSON.stringify(saved.original) !== JSON.stringify(original) ||
      saved.result.postId !== result.postId ||
      saved.result.videoId !== result.videoId ||
      JSON.stringify(saved.result.photos) !== JSON.stringify(result.photos)
    )
      return null;
    return structuredClone(saved.effects);
  }
}

// The exact same original-content predicate is used during the bounded read wait and again
// by the final resolver. An initial thumbnail, folded caption or foreign post cannot end it.
export function matchObservedFacebookNativeResult(
  result: AcceptedNativeFacebookPost,
  original: FacebookPostOriginal,
  input: PostEffects,
) {
  if (
    original.link.purpose !== 'SUBMIT' ||
    !['text', 'single-image', 'multi-image', 'video'].includes(original.intent.snapshot.format) ||
    (original.intent.snapshot.format === 'video') !== Boolean(result.videoId)
  )
    return null;
  const effects = FacebookPostEffects.parse(input);
  const wanted = new URL(
    facebookNativeResultUrl(original.intent.context.accountId, result.nativePostId, result.videoId),
  );
  // Only the exact native numeric result route is accepted, including query values. Feed,
  // unrelated redirect and inferred latest-post matches cannot manufacture an alias.
  if (
    !sameFacebookNativeResultUrl(effects.url, wanted.href) ||
    effects.ready === 'loading' ||
    effects.composer
  )
    return null;
  // Rendering collapses paragraph gaps; keep all characters, including emoji, in order.
  // The matched original UI/native request still validates the unmodified full text.
  const normalize = (value: string) => value.replace(/\s+/gu, ' ').trim();
  const candidates = effects.posts.filter(
    (post) =>
      post.accountId === original.intent.context.accountId &&
      post.expanded &&
      !post.nestedShare &&
      (original.intent.snapshot.text === ''
        ? post.text === null || normalize(post.text ?? '') === ''
        : post.text !== null &&
          normalize(post.text) === normalize(original.intent.snapshot.text)) &&
      post.postId &&
      post.permalink,
  );
  if (candidates.length !== 1) return null;
  const post = candidates[0];
  if (!post?.postId || !post.permalink) return null;
  if (!result.videoId && /^\d{1,30}$/.test(post.postId) && post.postId !== result.nativePostId)
    return null;
  const url = new URL(post.permalink);
  if (
    url.origin !== 'https://www.facebook.com' ||
    (result.videoId
      ? !sameFacebookNativeResultUrl(url.href, wanted.href) || post.postId !== result.videoId
      : url.pathname !== '/permalink.php' ||
        url.searchParams.get('story_fbid') !== post.postId ||
        url.searchParams.get('id') !== post.accountId ||
        url.searchParams.size !== 2)
  )
    return null;
  if (
    JSON.stringify(post.photos) !== JSON.stringify(result.photos) ||
    post.videoId !== result.videoId ||
    (result.videoId && !post.videoReady)
  )
    return null;
  // Force the published format's original constraints; this is still a causal result key,
  // not a PostReceipt or resource consumption transaction.
  const media = original.intent.snapshot.files.filter((file) => file.role !== 'text');
  if (
    original.intent.snapshot.format === 'text' &&
    (media.length || post.photos.length || post.videoId)
  )
    return null;
  if (
    original.intent.snapshot.format === 'single-image' &&
    (media.length !== 1 || post.photos.length !== 1 || post.videoId)
  )
    return null;
  if (
    original.intent.snapshot.format === 'video' &&
    (media.length !== 1 || !post.videoId || post.photos.length)
  )
    return null;
  if (
    original.intent.snapshot.format === 'multi-image' &&
    (media.length < 2 ||
      media.length > 20 ||
      media.some((file) => file.role !== 'image') ||
      post.photos.length !== media.length ||
      new Set(post.photos).size !== media.length ||
      post.videoId)
  )
    return null;
  return { postId: post.postId, photos: [...post.photos], videoId: post.videoId };
}
