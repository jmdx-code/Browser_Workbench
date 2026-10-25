import { z } from 'zod';
import { FACEBOOK_UI_COPY } from './facebook-ui.js';

export const FACEBOOK_PROFILE_CONTROL_LABELS = FACEBOOK_UI_COPY.flatMap((copy) => [
  ...copy.profile,
]);

// Display resources are not account IDs or execution authority. Never allow arbitrary origins.
export function isFacebookAvatarURL(value: string) {
  try {
    const url = new URL(value);
    return (
      value.length <= 2048 &&
      !/[\u0000-\u0020\u007f]/.test(value) &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.fbcdn\.net$/.test(url.hostname)
    );
  } catch {
    return false;
  }
}
export const AvatarObservation = z
  .object({
    source: z.literal('facebook-home-profile-control'),
    url: z.string().max(2048).refine(isFacebookAvatarURL),
    actingIdentityVerified: z.literal(false),
  })
  .strict();
export type ObservedAvatar = z.infer<typeof AvatarObservation>;

// Names are short-lived UI observations, never actor authority or persistent profile aliases.
export const NameObservation = z
  .object({
    source: z.literal('facebook-home-composer'),
    name: z
      .string()
      .min(1)
      .max(150)
      .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value)),
    actingIdentityVerified: z.literal(false),
  })
  .strict();
export type ObservedName = z.infer<typeof NameObservation>;
