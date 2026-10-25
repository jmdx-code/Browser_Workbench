import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { FacebookNativeActor } from '../shared/facebook-native-identity.js';
import { projectFacebookDocumentIdentity } from '../shared/facebook-document-identity.js';
import { FacebookBrowseURL } from '../shared/browser-actions.js';
import { facebookMarketplaceUnavailableURL } from '../shared/facebook-browse-route.js';
import { readFacebookAcrossNavigation } from './facebook-navigation-read.js';
import {
  FacebookBrowsePage,
  projectFacebookBrowsePage,
  projectFacebookFeedInputFence,
} from './facebook-browse-reader.js';

const Fence = z
  .object({
    url: z.union([FacebookBrowseURL, z.string().refine(facebookMarketplaceUnavailableURL)]),
    timeOrigin: z.number().finite().nonnegative(),
    ready: z.enum(['interactive', 'complete']),
  })
  .strict();
const Actor = Fence.extend({ actor: FacebookNativeActor }).strict();
/* One synchronous browser evaluation ties the fresh actor to its document. The
 * JS turn cannot navigate between those reads; avoid three independent RPC waits
 * on every browse sample while retaining the current owner guards at both ends. */
const expression = `(() => {
  const timeOrigin = performance.timeOrigin;
  const identity = (${projectFacebookDocumentIdentity.toString()})("browse");
  return { ...identity, timeOrigin };
})()`;
// Browse cannot publish or like. Read the same observed User menu record on the current
// owned route; any available composer record must agree. Posting retains its stricter reader.
export async function readCurrentFacebookBrowseIdentity(page: Page, guard: () => Awaitable<void>) {
  await guard();
  const actor = Actor.parse(
    await readFacebookAcrossNavigation(() => page.evaluate(expression), guard),
  );
  await guard();
  const { actor: selected, ...document } = actor;
  return { actor: selected, document };
}

const sampleExpression = `(() => {
  const identity = (${projectFacebookDocumentIdentity.toString()})("browse");
  const page = (${projectFacebookBrowsePage.toString()})();
  return { identity: { ...identity, timeOrigin: page.timeOrigin }, page };
})()`;
const inputExpression = `(() => {
  const identity = (${projectFacebookDocumentIdentity.toString()})("browse");
  const page = (${projectFacebookFeedInputFence.toString()})();
  return { identity: { ...identity, timeOrigin: page.timeOrigin }, page };
})()`;
// A synchronous sample reads identity and playback together. There is no cached permission:
// navigation, actor changes and the owner guard are checked for every observation.
export async function readCurrentFacebookBrowseSample(
  page: Page,
  guard: () => Awaitable<void>,
  inputFence = false,
) {
  await guard();
  const sample = z
    .object({ identity: z.unknown(), page: FacebookBrowsePage })
    .strict()
    .parse(
      await readFacebookAcrossNavigation(
        () => page.evaluate(inputFence ? inputExpression : sampleExpression),
        guard,
      ),
    );
  await guard();
  const identity =
    sample.page.ready && (inputFence || !sample.page.blocked) ? Actor.parse(sample.identity) : null;
  if (
    identity &&
    (identity.url !== sample.page.url || identity.timeOrigin !== sample.page.timeOrigin)
  )
    throw Error('FACEBOOK_BROWSE_SAMPLE_DOCUMENT_CHANGED');
  return { page: sample.page, actor: identity?.actor ?? null };
}
