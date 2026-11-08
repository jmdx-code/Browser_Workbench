import { z } from 'zod';

const id = z.string().regex(/^\d{1,30}$/);
const response = z.object({
  errors: z.never().optional(),
  data: z.object({
    story_create: z.object({
      story_id: z.null(),
      items: z.array(z.object({ story: z.object({ id: z.string().max(200) }) })).length(1),
      viewer: z.object({
        actor: z.object({
          id,
          __typename: z.literal('User'),
          story_bucket: z.object({ nodes: z.array(z.object({ id })).length(1) }),
        }),
      }),
    }),
  }),
  extensions: z.object({ is_final: z.literal(true) }),
});
export type NativeStoryCreation = { actorId: string; bucketId: string; storyId: string };
export function isNativeTextStoryRequest(body: string, actorId: string, text: string) {
  try {
    const params = new URLSearchParams(body);
    if (
      ['av', 'variables', 'fb_api_req_friendly_name'].some(
        (key) => params.getAll(key).length !== 1,
      ) ||
      params.get('av') !== actorId ||
      params.get('fb_api_req_friendly_name') !== 'StoriesCreateMutation'
    )
      return false;
    const vars = z
      .object({
        input: z.object({
          actor_id: id,
          source: z.literal('WWW'),
          audiences_is_complete: z.literal(true),
          audiences: z
            .array(
              z
                .object({
                  stories: z.object({ self: z.object({ target_id: id }).strict() }).strict(),
                })
                .strict(),
            )
            .length(1),
          message: z.object({ text: z.string(), ranges: z.array(z.never()).length(0) }).strict(),
          attachments: z.never().optional(),
        }),
      })
      .parse(JSON.parse(params.get('variables') ?? ''));
    return (
      vars.input.actor_id === actorId &&
      vars.input.audiences[0]?.stories.self.target_id === actorId &&
      vars.input.message.text === text
    );
  } catch {
    return false;
  }
}

// The observed photo request contains an empty overlays array after native rendering.
// Original media/text must match before input; unknown/nonempty overlay shapes stay unconfirmed.
export function isNativeMediaStoryRequest(
  body: string,
  actorId: string,
  text: string,
  format: 'single-image' | 'video',
  expectedVideoId?: string,
) {
  if (body.length > 512 * 1024) return false;
  try {
    const params = new URLSearchParams(body);
    if (
      ['av', 'variables', 'fb_api_req_friendly_name'].some(
        (key) => params.getAll(key).length !== 1,
      ) ||
      params.get('av') !== actorId ||
      params.get('fb_api_req_friendly_name') !== 'StoriesCreateMutation'
    )
      return false;
    const attachment =
      format === 'single-image'
        ? z
            .object({
              photo: z.object({ id, overlays: z.array(z.never()).length(0).optional() }).strict(),
            })
            .strict()
        : z.object({ video: z.object({ id }).strict() }).strict();
    const input = z
      .object({
        actor_id: id,
        source: z.literal('WWW'),
        audiences_is_complete: z.literal(true),
        audiences: z
          .array(
            z
              .object({
                stories: z.object({ self: z.object({ target_id: id }).strict() }).strict(),
              })
              .strict(),
          )
          .length(1),
        message: z
          .object({ text: z.string(), ranges: z.array(z.never()).length(0) })
          .strict()
          .optional(),
        attachments: z.array(attachment).length(1),
      })
      .parse(JSON.parse(params.get('variables') ?? '').input);
    const uploaded = input.attachments[0];
    return (
      input.actor_id === actorId &&
      input.audiences[0]?.stories.self.target_id === actorId &&
      (format !== 'video' ||
        expectedVideoId === undefined ||
        (!!uploaded && 'video' in uploaded && uploaded.video.id === expectedVideoId)) &&
      (input.message === undefined || input.message.text === '' || input.message.text === text)
    );
  } catch {
    return false;
  }
}

// This is the observed StoriesCreateMutation, not ordinary ComposerStoryCreateMutation.
// Complete native creation is accepted only for the matched original request and actor.
export function parseNativeStoryCreation(
  body: string,
  status: number,
  actorId: string,
): NativeStoryCreation | null {
  if (status !== 200 || Buffer.byteLength(body, 'utf8') > 512 * 1024) return null;
  try {
    const chunks = body
      .replace(/^for \(;;\);\s*/, '')
      .split(/\r?\n/)
      .filter((line) => line.trim());
    if (!chunks.length || chunks.length > 32) return null;
    let accepted: NativeStoryCreation | null = null;
    for (const chunk of chunks) {
      const raw: unknown = JSON.parse(chunk);
      if (raw && typeof raw === 'object' && 'errors' in raw) return null;
      const parsed = response.safeParse(raw);
      if (!parsed.success) continue;
      const created = parsed.data.data.story_create;
      const storyId = created.items[0]?.story.id;
      const bucketId = created.viewer.actor.story_bucket.nodes[0]?.id;
      if (
        !storyId ||
        !bucketId ||
        created.viewer.actor.id !== actorId ||
        !/^S:_ISC:\d{1,30}$/.test(Buffer.from(storyId, 'base64').toString('utf8')) ||
        Buffer.from(Buffer.from(storyId, 'base64')).toString('base64') !== storyId
      )
        return null;
      const next = { actorId, bucketId, storyId };
      if (accepted && JSON.stringify(accepted) !== JSON.stringify(next)) return null;
      accepted = next;
    }
    return accepted;
  } catch {
    return null;
  }
}

export function nativeStoryResultURL(value: NativeStoryCreation) {
  return 'https://www.facebook.com/stories/' + value.bucketId + '/' + value.storyId + '/';
}
