import type { Awaitable } from '../domain/persistence.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FacebookPostOriginal } from '../domain/facebook-post-execution.js';
import type { PostResultCorrelation, PostEffects } from '../shared/facebook-post-observation.js';
import type { FacebookSubmissionWireAdapter } from './facebook-submission-network.js';
import { requiresNativePostBackground } from '../domain/material-post.js';

const id = z.string().regex(/^\d{1,30}$/);
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const keyFields = {
  operationId: z.uuid(),
  attemptId: z.uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  accountId: id,
  textDigest: z.string().regex(/^[a-f0-9]{64}$/),
  format: z.enum(['text', 'single-image', 'multi-image', 'video']),
  photos: z.array(id).max(20),
  videoId: id.nullable(),
};
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const nativePrivacy = z
  .object({
    allow: z.array(id).max(1000),
    base_state: z.string().regex(/^[A-Z_]{1,64}$/),
    deny: z.array(id).max(1000),
    tag_expansion_state: z.string().regex(/^[A-Z_]{1,64}$/),
  })
  .strict();
// These keys exist only in the bounded, per-operation Network observer. No credentials,
// audience member IDs or new persistent publication record are introduced.
const keySchema = z.discriminatedUnion('version', [
  z.object({ ...keyFields, version: z.literal(1), audience: z.literal('SELF') }).strict(),
  z
    .object({
      ...keyFields,
      version: z.literal(2),
      audience: z
        .object({ baseState: nativePrivacy.shape.base_state, privacyDigest: digestSchema })
        .strict(),
    })
    .strict(),
]);
export type FacebookSubmissionAudiencePolicy = 'require-self' | 'preserve-current';
type NativeRequest = z.infer<typeof keySchema>;
export interface AcceptedNativeFacebookPost {
  // Native acceptance is not a publication verdict. Numeric post IDs differ from visible
  // pfBid permalinks; Reels use the uploaded video ID instead of this numeric post ID.
  nativePostId: string;
  nativeStoryId: string;
  flow: 'ASYNC_SILENT' | 'ASYNC_NOTIF' | 'FALLBACK';
  photos: string[];
  videoId: string | null;
}
export interface NativeFacebookPostResultResolver {
  ready(): boolean;
  supportsOriginal?(original: FacebookPostOriginal): boolean;
  resolve(
    result: AcceptedNativeFacebookPost,
    original: FacebookPostOriginal,
    guard: () => Awaitable<void>,
  ):
    | Pick<PostResultCorrelation, 'postId' | 'photos' | 'videoId'>
    | null
    | Promise<Pick<PostResultCorrelation, 'postId' | 'photos' | 'videoId'> | null>;
  observedEffects?(
    original: FacebookPostOriginal,
    result: Pick<PostResultCorrelation, 'postId' | 'photos' | 'videoId'>,
    guard: () => Awaitable<void>,
  ): Awaitable<PostEffects | null>;
}

// Parse the fields observed in the authorized text/single-image/video submissions.
// Multi-image support extends the observed photo array structurally; its live request
// sample is still missing, so software support must not be reported as live acceptance.
// No request is sent. Credential parameters are neither retained nor included in the key.
export function matchNativeFacebookSubmission(
  postData: string,
  original: FacebookPostOriginal,
  policy: FacebookSubmissionAudiencePolicy = 'require-self',
) {
  try {
    if (postData.length > 512 * 1024 || original.link.purpose !== 'SUBMIT') return null;
    const params = new URLSearchParams(postData);
    for (const field of ['fb_api_req_friendly_name', 'av', 'variables'])
      if (params.getAll(field).length !== 1) return null;
    if (params.get('fb_api_req_friendly_name') !== 'ComposerStoryCreateMutation') return null;
    const variables = params.get('variables');
    if (!variables) return null;
    const vars = JSON.parse(variables) as { input?: Record<string, unknown> };
    const input = vars.input;
    if (
      !input ||
      params.get('av') !== original.intent.context.accountId ||
      input.actor_id !== original.intent.context.accountId
    )
      return null;
    const message = z
      .object({ ranges: z.array(z.never()).length(0), text: z.string() })
      .strict()
      .parse(input.message);
    if (message.text !== original.intent.snapshot.text) return null;
    const { privacy } = z.object({ privacy: nativePrivacy }).strict().parse(input.audience);
    if (
      policy === 'require-self' &&
      (privacy.base_state !== 'SELF' ||
        privacy.allow.length ||
        privacy.deny.length ||
        privacy.tag_expansion_state !== 'UNSPECIFIED')
    )
      return null;
    const colored = requiresNativePostBackground(original.intent);
    if (
      colored
        ? original.intent.snapshot.format !== 'text' ||
          typeof input.text_format_preset_id !== 'string' ||
          !/^[1-9]\d{0,29}$/.test(input.text_format_preset_id)
        : input.text_format_preset_id !== undefined && input.text_format_preset_id !== '0'
    )
      return null;
    if (
      input.inline_activities !== undefined &&
      (!Array.isArray(input.inline_activities) || input.inline_activities.length)
    )
      return null;
    const format = original.intent.snapshot.format;
    const attachments = input.attachments ?? [];
    let photos: string[] = [],
      videoId: string | null = null;
    const media = original.intent.snapshot.files.filter((file) => file.role !== 'text');
    if (format === 'text') {
      if (!Array.isArray(attachments) || attachments.length || media.length) return null;
    } else if (format === 'single-image' || format === 'multi-image') {
      const count = media.length;
      if (format === 'single-image' ? count !== 1 : count < 2 || count > 20) return null;
      if (media.some((file) => file.role !== 'image')) return null;
      const value = z
        .array(z.object({ photo: z.object({ id }).strict() }).strict())
        .length(count)
        .parse(attachments);
      photos = value.map((item) => item.photo.id);
      if (new Set(photos).size !== count) return null;
    } else {
      const value = z
        .array(
          z
            .object({
              video: z
                .object({
                  id,
                  audio_descriptions: z.null(),
                  additional_video_metadata: z
                    .object({ translatedAudioMetadata: z.array(z.never()).length(0) })
                    .strict(),
                  notify_when_processed: z.literal(true),
                  transcriptions: z.null(),
                  was_created_via_unified_video_flow: z
                    .object({ was_created_via_unified_video_flow: z.literal(true) })
                    .strict(),
                })
                .strict(),
            })
            .strict(),
        )
        .length(1)
        .parse(attachments);
      if (media.length !== 1 || media[0]?.role !== 'video') return null;
      const first = value[0];
      if (!first) return null;
      videoId = first.video.id;
    }
    return keySchema.parse({
      version: policy === 'require-self' ? 1 : 2,
      operationId: original.link.operationId,
      attemptId: original.intent.attemptId,
      fingerprint: original.intent.fingerprint,
      accountId: original.intent.context.accountId,
      textDigest: digest(message.text),
      audience:
        policy === 'require-self'
          ? 'SELF'
          : {
              baseState: privacy.base_state,
              privacyDigest: digest(JSON.stringify(privacy)),
            },
      format,
      photos,
      videoId,
    });
  } catch {
    return null;
  }
}

export function readAcceptedNativeFacebookPost(
  body: string,
  input: unknown,
): AcceptedNativeFacebookPost | null {
  try {
    if (Buffer.byteLength(body, 'utf8') > 512 * 1024) return null;
    const request = keySchema.parse(input);
    const envelope = z
      .object({
        data: z
          .object({
            story_create: z
              .object({
                story_id: z.string().max(200).nullable(),
                post_id: id.nullable(),
                publishing_flow: z.enum(['ASYNC_SILENT', 'ASYNC_NOTIF', 'FALLBACK']),
                story: z.record(z.string(), z.unknown()).nullable(),
              })
              .passthrough(),
          })
          .strict(),
        extensions: z.object({ is_final: z.literal(true) }).passthrough(),
      })
      .strict()
      .parse(JSON.parse(body));
    const result = envelope.data.story_create;
    const fallback = result.publishing_flow === 'FALLBACK';
    // The observed homepage FALLBACK has null top-level IDs and an embedded Story.
    // Only its canonical native story ID can supply the numeric result route; the
    // original independent result-page/content/media check still confirms publication.
    if (
      fallback
        ? result.post_id !== null ||
          result.story_id !== null ||
          typeof result.story?.id !== 'string'
        : result.story_id === null || result.story !== null
    )
      return null;
    const storyId = fallback ? z.string().max(200).parse(result.story?.id) : result.story_id;
    if (!storyId) return null;
    const decoded = Buffer.from(storyId, 'base64');
    const match = /^S:_I\d{1,30}:(\d{1,30})(?::(\d{1,30}))?$/.exec(decoded.toString('utf8'));
    // The captured FALLBACK Story repeats its post ID as a third component.
    // Never silently choose between conflicting IDs, or extend ASYNC by guessing.
    if (match?.[2] && (!fallback || match[2] !== match[1])) return null;
    // ASYNC_NOTIF also returns only story_id in the captured video response.
    // A missing top-level ID can be derived; a conflicting supplied ID is rejected.
    const postId = result.post_id ?? match?.[1];
    if (!postId || decoded.toString('base64') !== storyId || match?.[1] !== postId) return null;
    return {
      nativePostId: postId,
      nativeStoryId: storyId,
      flow: result.publishing_flow,
      photos: [...request.photos],
      videoId: request.videoId,
    };
  } catch {
    return null;
  }
}

export class NativeFacebookSubmissionWireAdapter implements FacebookSubmissionWireAdapter {
  private responseFailure: 'ACCEPTANCE_PARSE' | 'RESULT_PAGE' | 'RESULT_MEDIA' | null = null;
  responseFailureReason() {
    return this.responseFailure;
  }
  constructor(
    private readonly resolver?: NativeFacebookPostResultResolver,
    private readonly audiencePolicy:
      | FacebookSubmissionAudiencePolicy
      | ((
          original?: FacebookPostOriginal,
        ) => Awaitable<FacebookSubmissionAudiencePolicy>) = 'require-self',
  ) {}
  private async policy(original?: FacebookPostOriginal) {
    return typeof this.audiencePolicy === 'function'
      ? await this.audiencePolicy(original)
      : this.audiencePolicy;
  }
  async requiredAudience(original?: FacebookPostOriginal) {
    return (await this.policy(original)) === 'require-self' ? ('SELF' as const) : undefined;
  }
  // ID resolution must be installed and verified before the original input can be armed.
  // Native ASYNC acceptance alone is deliberately insufficient to enable a production actor.
  ready() {
    return this.resolver?.ready() === true;
  }
  supportsOriginal(original: FacebookPostOriginal) {
    const media = original.intent.snapshot.files.filter((file) => file.role !== 'text');
    const multi = original.intent.snapshot.format === 'multi-image';
    return (
      this.ready() &&
      (!multi ||
        (media.length >= 2 &&
          media.length <= 20 &&
          media.every((file) => file.role === 'image'))) &&
      this.resolver?.supportsOriginal?.(original) !== false
    );
  }
  async observedEffects(
    original: FacebookPostOriginal,
    result: PostResultCorrelation,
    guard: () => Awaitable<void>,
  ) {
    await guard();
    return (await this.resolver?.observedEffects?.(original, result, guard)) ?? null;
  }
  async match(postData: string, original: FacebookPostOriginal) {
    const value = matchNativeFacebookSubmission(postData, original, await this.policy(original));
    return value ? JSON.stringify(value) : null;
  }
  async result(
    body: string,
    requestKey: string,
    original: FacebookPostOriginal,
    guard: () => Awaitable<void> = () => {},
  ) {
    this.responseFailure = null;
    await guard();
    if (!this.supportsOriginal(original) || requestKey.length > 2048) return null;
    let request: NativeRequest;
    try {
      request = keySchema.parse(JSON.parse(requestKey));
    } catch {
      return null;
    }
    if (request.version !== ((await this.policy(original)) === 'require-self' ? 1 : 2)) return null;
    if (
      request.operationId !== original.link.operationId ||
      request.attemptId !== original.intent.attemptId ||
      request.fingerprint !== original.intent.fingerprint ||
      request.accountId !== original.intent.context.accountId ||
      request.textDigest !== digest(original.intent.snapshot.text) ||
      request.format !== original.intent.snapshot.format
    )
      return null;
    const accepted = readAcceptedNativeFacebookPost(body, request);
    if (!accepted) {
      this.responseFailure = 'ACCEPTANCE_PARSE';
      return null;
    }
    this.responseFailure = 'RESULT_PAGE';
    const result = await this.resolver?.resolve(accepted, original, guard);
    await guard();
    if (!result) return null;
    this.responseFailure = 'RESULT_MEDIA';
    if (
      result.videoId !== accepted.videoId ||
      JSON.stringify(result.photos) !== JSON.stringify(accepted.photos)
    )
      return null;
    this.responseFailure = null;
    return result;
  }
}
