import { z } from 'zod';
import { FbDigits, NonNegInt, sReq, strictObj } from './contracts.js';
const str300 = sReq(300);
export const FacebookNativeActor = strictObj({
  version: z.literal(1),
  source: z.literal('CometSettingsDropdownTriggerQuery'),
  accountId: FbDigits,
  name: str300,
  type: z.literal('User'),
  checkedAt: NonNegInt,
});
export type NativeFacebookActor = z.infer<typeof FacebookNativeActor>;
export const FacebookNativeIdentityRead = strictObj({
  actor: FacebookNativeActor,
  frameId: str300,
  loaderId: str300,
  transport: z.enum(['native-response', 'document-preload']).optional(),
});
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
    const actor = z
      .object({
        __typename: z.literal('User'),
        id: FacebookNativeActor.shape.accountId,
        name: FacebookNativeActor.shape.name,
      })
      .passthrough();
    const viewer = z
      .object({ actor, is_lar_acting_as_additional_profile: z.literal(false) })
      .passthrough();
    const envelope = z
      .object({
        data: z.object({ viewer }).passthrough(),
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
