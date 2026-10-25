import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { FacebookNativeActor } from '../shared/facebook-native-identity.js';
import { projectFacebookDocumentIdentity } from '../shared/facebook-document-identity.js';
import { projectPage } from '../shared/page-projection.js';
import { PageReadRequest, validateProjection } from '../shared/page-read.js';
import { facebookDisplayInspectionProjection } from './facebook-read-adapter.js';

const DocumentFence = z
  .object({
    url: z.enum(['https://www.facebook.com/', 'https://www.facebook.com/post/create']),
    timeOrigin: z.number().finite().nonnegative(),
    ready: z.enum(['interactive', 'complete']),
  })
  .strict();
const CurrentActor = z
  .object({
    url: DocumentFence.shape.url,
    ready: DocumentFence.shape.ready,
    actor: FacebookNativeActor.nullable(),
  })
  .strict();
const creatorProjection = PageReadRequest.parse({
  queries: facebookDisplayInspectionProjection.queries.filter((query) =>
    ['homeComposers', 'composerProfileLinks'].includes(query.key),
  ),
});

// SDK reads only, on the already owned task page. No navigation, reload, menu, JS store or input.
// A retained page can reach home through SPA navigation without an inline-composer preload.
// The selected native actor must still match the unique current creator below, in one document.
export async function readCurrentFacebookIdentity(
  page: Page,
  assertCurrent: () => Awaitable<void>,
) {
  await assertCurrent();
  const parseFence = (input: unknown) => {
    const result = DocumentFence.safeParse(input);
    if (!result.success)
      throw Error(
        result.error.issues.some((issue) => issue.path[0] === 'url')
          ? 'FACEBOOK_TASK_DOCUMENT_SCOPE_CHANGED'
          : 'FACEBOOK_TASK_DOCUMENT_READ_FAILED',
      );
    return result.data;
  };
  // One synchronous document observation, not four remote round trips inside every
  // mouse/key protocol guard. No identity or input permission is cached between commands.
  const observation = z
    .object({
      before: z.unknown(),
      selected: z.unknown(),
      creator: z.unknown(),
      after: z.unknown(),
    })
    .strict()
    .parse(
      await page.evaluate(`(() => {
    const fence = () => ({url: location.href, timeOrigin: performance.timeOrigin, ready: document.readyState});
    const before = fence();
    const selected = (${projectFacebookDocumentIdentity.toString()})("post-current");
    const creator = (${projectPage.toString()})(${JSON.stringify(creatorProjection)});
    return {before, selected, creator, after: fence()};
  })()`),
    );
  await assertCurrent();
  const before = parseFence(observation.before),
    after = parseFence(observation.after),
    selected = CurrentActor.parse(observation.selected),
    creator = validateProjection(creatorProjection, observation.creator);
  if (
    !selected.actor ||
    before.url !== after.url ||
    selected.url !== after.url ||
    before.timeOrigin !== after.timeOrigin ||
    creator.url !== after.url ||
    creator.timeOrigin !== after.timeOrigin
  )
    throw Error('FACEBOOK_CURRENT_NATIVE_IDENTITY_UNCONFIRMED');
  const regions = creator.rows.find((row) => row.key === 'homeComposers')?.nodes ?? [];
  const links = creator.rows.find((row) => row.key === 'composerProfileLinks')?.nodes ?? [];
  const href = links[0]?.attributes.href;
  if (regions.length !== 1 || links.length !== 1 || !href)
    throw Error('FACEBOOK_CURRENT_CREATOR_UNCONFIRMED');
  const url = new URL(href, after.url);
  if (
    url.origin !== 'https://www.facebook.com' ||
    url.pathname !== '/profile.php' ||
    url.searchParams.get('id') !== selected.actor.accountId ||
    (after.url === 'https://www.facebook.com/' && (!regions[0]?.visible || !links[0]?.visible))
  )
    throw Error('FACEBOOK_CURRENT_CREATOR_UNCONFIRMED');
  return {
    actor: selected.actor,
    document: after,
    transport: 'document-preload' as const,
    creator,
  };
}
