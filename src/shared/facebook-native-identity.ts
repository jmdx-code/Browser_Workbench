import { z } from 'zod';

export const FacebookNativeActor = z
  .object({
    version: z.literal(1),
    source: z.literal('CometSettingsDropdownTriggerQuery'),
    accountId: z.string().regex(/^\d{1,30}$/),
    name: z.string().min(1).max(300),
    type: z.literal('User'),
    checkedAt: z.number().int().nonnegative(),
  })
  .strict();
export type NativeFacebookActor = z.infer<typeof FacebookNativeActor>;
export const FacebookNativeIdentityRead = z
  .object({
    actor: FacebookNativeActor,
    frameId: z.string().min(1).max(300),
    loaderId: z.string().min(1).max(300),
    transport: z.enum(['native-response', 'document-preload']).optional(),
  })
  .strict();
export type NativeFacebookIdentityRead = z.infer<typeof FacebookNativeIdentityRead>;

// Selected, sanitized fields only. Never return the original body (which includes logout
// metadata), request credentials, other eligible profiles, or an execution permission.
export function parseNativeFacebookActor(
  body: string,
  av: string,
  checkedAt: number,
): NativeFacebookActor | null {
  try {
    if (body.length > 524288 || new TextEncoder().encode(body).byteLength > 524288) return null;
    const envelope = z
      .object({
        data: z
          .object({
            viewer: z
              .object({
                actor: z
                  .object({
                    __typename: z.literal('User'),
                    id: FacebookNativeActor.shape.accountId,
                    name: FacebookNativeActor.shape.name,
                  })
                  .passthrough(),
                is_lar_acting_as_additional_profile: z.literal(false),
              })
              .passthrough(),
          })
          .passthrough(),
        extensions: z.object({ is_final: z.literal(true) }).passthrough(),
      })
      .passthrough()
      .parse(JSON.parse(body));
    if ('errors' in envelope || envelope.data.viewer.actor.id !== av) return null;
    return FacebookNativeActor.parse({
      version: 1,
      source: 'CometSettingsDropdownTriggerQuery',
      accountId: av,
      name: envelope.data.viewer.actor.name,
      type: 'User',
      checkedAt,
    });
  } catch {
    return null;
  }
}
