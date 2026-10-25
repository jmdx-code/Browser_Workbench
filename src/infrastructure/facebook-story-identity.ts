import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { FacebookNativeActor } from '../shared/facebook-native-identity.js';
import { projectFacebookDocumentIdentity } from '../shared/facebook-document-identity.js';

const DocumentFence = z
  .object({
    url: z.enum([
      'https://www.facebook.com/stories/create/',
      'https://www.facebook.com/stories/create',
    ]),
    timeOrigin: z.number().finite().nonnegative(),
    ready: z.enum(['interactive', 'complete']),
  })
  .strict();
const Creator = z
  .object({
    url: DocumentFence.shape.url,
    ready: DocumentFence.shape.ready,
    actor: FacebookNativeActor.nullable(),
  })
  .strict();

// Selected native actor and the completed StoriesCreate creator stream must agree.
// A display name, ordinary post preload or an unfinished stream is not a substitute.
export async function readCurrentFacebookStoryIdentity(page: Page, guard: () => Awaitable<void>) {
  await guard();
  const observation = z
    .object({ before: z.unknown(), current: z.unknown(), after: z.unknown() })
    .strict()
    .parse(
      await page.evaluate(`(() => {
      const fence = () => ({url: location.href, timeOrigin: performance.timeOrigin, ready: document.readyState});
      const before = fence();
      const current = (${projectFacebookDocumentIdentity.toString()})("story");
      return {before, current, after: fence()};
    })()`),
    );
  await guard();
  const before = DocumentFence.parse(observation.before),
    current = Creator.parse(observation.current),
    after = DocumentFence.parse(observation.after);
  if (
    !current.actor ||
    before.url !== after.url ||
    current.url !== after.url ||
    before.timeOrigin !== after.timeOrigin
  )
    throw Error('FACEBOOK_CURRENT_STORY_IDENTITY_UNCONFIRMED');
  return { actor: current.actor, document: after, transport: 'document-preload' as const };
}
