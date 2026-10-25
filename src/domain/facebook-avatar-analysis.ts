import type { PageProjection } from '../shared/page-read.js';
import {
  AvatarObservation,
  FACEBOOK_PROFILE_CONTROL_LABELS,
  type ObservedAvatar,
} from '../shared/account-display.js';
import { kernelFacebookReadURL } from '../shared/kernel-policy.js';

// A unique visible profile control on the home document is a display source only.
export function observeFacebookHomeAvatar(page: PageProjection): ObservedAvatar | null {
  if (!kernelFacebookReadURL(page.url) || new URL(page.url).pathname !== '/') return null;
  if (page.ready !== 'complete') return null;
  const nodes = (key: string) => page.rows.find((row) => row.key === key)?.nodes ?? [];
  if (nodes('loginForm').length) return null;
  const controls = nodes('ownProfileControls');
  const images = nodes('ownProfileImages');
  if (
    controls.length !== 1 ||
    !controls[0]?.visible ||
    images.length !== 1 ||
    !images[0]?.visible ||
    !FACEBOOK_PROFILE_CONTROL_LABELS.some(
      (label) => label === controls[0]?.attributes['aria-label'],
    )
  )
    return null;
  const image = images[0];
  if (!['img', 'image'].includes(image.tag.toLowerCase())) return null;
  const resources = [
    ...new Set(
      [image.attributes.href, image.attributes['xlink:href'], image.attributes.src].filter(
        (value): value is string => !!value,
      ),
    ),
  ];
  if (resources.length !== 1) return null;
  const parsed = AvatarObservation.safeParse({
    source: 'facebook-home-profile-control',
    url: resources[0],
    actingIdentityVerified: false,
  });
  return parsed.success ? parsed.data : null;
}
