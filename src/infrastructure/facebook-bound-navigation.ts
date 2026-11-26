import type { Awaitable } from '../domain/persistence.js';
import type { KernelExecutor } from '../application/kernel-executor.js';
import { KernelJsonObject } from '../shared/kernel-protocol.js';
import {
  facebookBrowseSurface,
  facebookDetourMatchesTarget,
  facebookFeedDetourURL,
  facebookFriendsRouteMatches,
  facebookMarketplaceItemURL,
  matchesMarketplaceSearch,
} from '../shared/facebook-browse-route.js';
import { kernelAccessURL } from '../shared/kernel-policy.js';
import {
  FACEBOOK_TASK_DOCUMENT_READ,
  missingFacebookDefaultContext,
} from './facebook-task-document-ready.js';
import { devDiag } from '../shared/dev-diagnostics.js';
// One native navigation inside the original operation. Read-only probes do not repeat input
// or depend on a relayed SDK lifecycle event. This is an ACK, never browsing progress.
export async function navigateFacebookBoundPage(
  executor: Pick<KernelExecutor, 'send'>,
  tabId: number,
  url: string,
  previousUrl: string,
  guard: () => Awaitable<void>,
  options: { now?: () => number; wait?: () => Promise<void> } = {},
) {
  await guard();
  if (!kernelAccessURL(url, 'facebook-task')) throw Error('FACEBOOK_NAVIGATION_SCOPE_CHANGED');
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 150)));
  const started = now();
  const genericVideo = /^https:\/\/www\.facebook\.com\/(?:reels|watch)\/?$/.test(url);
  const genericFriends =
    /^https:\/\/www\.facebook\.com\/friends\/(?:requests|suggestions)\/?$/.test(url);
  const detourTarget = facebookFeedDetourURL(url);
  const marketplaceItem = facebookMarketplaceItemURL(url);
  const genericMarketplaceHome = url === 'https://www.facebook.com/marketplace/';
  const reply = await executor.send({ tabId }, 'Page.navigate', { url });
  await guard();
  if (reply.errorText || reply.isDownload || typeof reply.frameId !== 'string' || !reply.frameId) {
    const reason = reply.isDownload
      ? 'FACEBOOK_NAVIGATION_DOWNLOAD_REJECTED'
      : 'FACEBOOK_NAVIGATION_REJECTED';
    devDiag.record({
      level: 'WARN',
      category: 'BROWSER_ACTION',
      event: 'FACEBOOK_NAVIGATION_REJECTED_DETAIL',
      url,
      reason,
      data: {
        tabId,
        previousUrl,
        errorText: typeof reply.errorText === 'string' ? reply.errorText : null,
        isDownload: Boolean(reply.isDownload),
        hasFrameId: typeof reply.frameId === 'string' && reply.frameId.length > 0,
      },
    });
    throw Error(reason);
  }
  if (!options.wait) {
    await new Promise<void>((resolve) => setTimeout(resolve, genericFriends ? 1500 : 800));
    await guard();
  }
  let entered = false;
  for (let read = 0; read < 201; read++) {
    await guard();
    if (now() < started || now() - started > 30_000)
      throw Error('FACEBOOK_NAVIGATION_DOCUMENT_TIMEOUT');
    try {
      if (!options.wait && !entered) {
        const targetReply = await executor.send({ tabId }, 'Target.getTargetInfo', {});
        await guard();
        const targetInfo = KernelJsonObject.safeParse(targetReply.targetInfo);
        if (
          targetInfo.success &&
          typeof targetInfo.data.url === 'string' &&
          ['about:blank', ''].includes(targetInfo.data.url)
        ) {
          await wait();
          await guard();
          continue;
        }
      }
      const result = await executor.send({ tabId }, 'Runtime.evaluate', {
        expression: FACEBOOK_TASK_DOCUMENT_READ,
        returnByValue: true,
      });
      await guard();
      if (result.exceptionDetails) throw Error('FACEBOOK_NAVIGATION_DOCUMENT_INVALID');
      const value = KernelJsonObject.parse(result.result);
      if (typeof value.value !== 'string') throw Error('FACEBOOK_NAVIGATION_DOCUMENT_INVALID');
      const document = KernelJsonObject.parse(JSON.parse(value.value));
      const targetSurface = facebookBrowseSurface(url);
      const currentSurface =
        typeof document.url === 'string' ? facebookBrowseSurface(document.url) : null;
      const targetIsSuggestedFriends =
        /^https:\/\/www\.facebook\.com\/friends\/suggestions\/?$/.test(url);
      const matches =
        typeof document.url === 'string' &&
        (document.url === url ||
          (!genericFriends && !detourTarget && document.url.startsWith(url)) ||
          (targetSurface !== null && !genericFriends && currentSurface === targetSurface) ||
          (detourTarget && facebookDetourMatchesTarget(document.url, url, previousUrl)) ||
          (marketplaceItem !== null &&
            facebookMarketplaceItemURL(document.url) === marketplaceItem) ||
          (genericMarketplaceHome && matchesMarketplaceSearch(document.url, '')) ||
          (genericVideo && currentSurface === 'video') ||
          (genericFriends &&
            facebookFriendsRouteMatches(
              document.url,
              targetIsSuggestedFriends ? 'add_suggested' : 'accept',
            )));
      if (matches) entered = true;
      else if (
        typeof document.url !== 'string' ||
        (document.url !== 'about:blank' && !kernelAccessURL(document.url, 'facebook-task')) ||
        ((targetSurface === null || options.wait !== undefined) &&
          (entered ||
            (document.url !== previousUrl &&
              document.url !== 'about:blank' &&
              (options.wait !== undefined || (document.ready !== 'loading' && read >= 10)))))
      )
        throw Error('FACEBOOK_NAVIGATION_SCOPE_CHANGED');
      if (!['loading', 'interactive', 'complete'].includes(String(document.ready)))
        throw Error('FACEBOOK_NAVIGATION_DOCUMENT_INVALID');
      if (matches && document.ready !== 'loading') return;
    } catch (error) {
      if (
        !missingFacebookDefaultContext(error) &&
        !(error instanceof Error && error.message === 'KERNEL_INITIAL_DOCUMENT_PENDING')
      )
        throw error;
    }
    await wait();
    await guard();
  }
  throw Error('FACEBOOK_NAVIGATION_DOCUMENT_TIMEOUT');
}
