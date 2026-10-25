import type { Awaitable } from '../domain/persistence.js';
import type { KernelExecutor } from '../application/kernel-executor.js';
import { KernelJsonObject } from '../shared/kernel-protocol.js';
import { sameFacebookNativeResultUrl } from '../shared/facebook-result-route.js';
import { FacebookBrowseURL } from '../shared/browser-actions.js';
import { facebookMarketplaceUnavailableURL } from '../shared/facebook-browse-route.js';

export const FACEBOOK_TASK_DOCUMENT_READ =
  'JSON.stringify({url:location.href,ready:document.readyState})';

export function missingFacebookDefaultContext(error: unknown) {
  if (!(error instanceof Error)) return false;
  try {
    const native = KernelJsonObject.parse(JSON.parse(error.message) as unknown);
    return (
      native.code === -32000 &&
      (native.message === 'Cannot find default execution context' ||
        native.message === 'Execution context was destroyed.' ||
        native.message === 'Cannot find context with specified id')
    );
  } catch {
    return false;
  }
}

// A new native tab may still have no default JS context immediately after debugger attach.
// Repeat only this fixed read and that exact observed CDP error; never repeat setup or input.
export async function awaitFacebookTaskDocument(
  executor: Pick<KernelExecutor, 'send'>,
  tabId: number,
  assertCurrent: () => Awaitable<void>,
  options: {
    now?: () => number;
    wait?: () => Promise<void>;
    observe?: (document: {
      scope: 'home' | 'initial-blank' | 'other';
      ready: string;
      url?: string;
    }) => void;
    expectedUrl?: string;
    retainedPage?: boolean;
  } = {},
) {
  const now = options.now ?? Date.now,
    wait = options.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 200))),
    started = now(),
    expectedUrl = options.expectedUrl ?? 'https://www.facebook.com/';
  if (
    ![
      'https://www.facebook.com/',
      'https://www.facebook.com/post/create',
      'https://www.facebook.com/marketplace/',
      'https://www.facebook.com/stories/create/',
      'https://www.facebook.com/friends',
      'https://www.facebook.com/friends/',
      'https://www.facebook.com/friends/requests',
      'https://www.facebook.com/friends/requests/',
    ].includes(expectedUrl) &&
    !/^https:\/\/www\.facebook\.com\/(?:reel|marketplace\/item)\/\d{1,30}\/$/.test(expectedUrl)
  )
    throw Error('FACEBOOK_TASK_INITIAL_ROUTE_REJECTED');
  let homeSeen = false;
  // Initial network navigation can exceed eight seconds. This bounded read does
  // not replay navigation or input; business readiness is still checked by the reader.
  for (let n = 0; n < 151; n++) {
    await assertCurrent();
    if (now() < started || now() - started > 30000) throw Error('FACEBOOK_TASK_DOCUMENT_TIMEOUT');
    try {
      const reply = await executor.send({ tabId }, 'Runtime.evaluate', {
        expression: FACEBOOK_TASK_DOCUMENT_READ,
        returnByValue: true,
      });
      await assertCurrent();
      if (reply.exceptionDetails) throw Error('FACEBOOK_TASK_DOCUMENT_READ_FAILED');
      const result = KernelJsonObject.parse(reply.result);
      if (typeof result.value !== 'string') throw Error('FACEBOOK_TASK_DOCUMENT_READ_FAILED');
      const document = KernelJsonObject.parse(JSON.parse(result.value) as unknown);
      const scope =
        typeof document.url === 'string' &&
        (sameFacebookNativeResultUrl(document.url, expectedUrl) ||
          (options.retainedPage === true &&
            (FacebookBrowseURL.safeParse(document.url).success ||
              facebookMarketplaceUnavailableURL(document.url) ||
              /^https:\/\/www\.facebook\.com\/friends(?:\/(?:requests|suggestions|list|birthdays|friendlist)?\/?)?(?:\?.*)?$/.test(
                document.url,
              ) ||
              /^https:\/\/www\.facebook\.com\/(?:groups|search|profile\.php|notifications|saved|memories|events|bookmarks)(?:\/[^?#]*)?(?:\?.*)?$/.test(
                document.url,
              ))))
          ? 'home'
          : document.url === 'about:blank' && !homeSeen
            ? 'initial-blank'
            : 'other';
      options.observe?.({
        scope,
        ready: typeof document.ready === 'string' ? document.ready : 'unknown',
        url: typeof document.url === 'string' ? document.url : '',
      });
      if (scope === 'other') throw Error('FACEBOOK_TASK_DOCUMENT_SCOPE_CHANGED');

      if (scope === 'home') homeSeen = true;
      // The SDK needs a parsed document, not every third-party subresource's load event.
      // Fresh actor, visible controls and business readiness are checked after attachment.
      if (scope === 'home' && ['interactive', 'complete'].includes(String(document.ready))) return;
      if (!['loading', 'interactive', 'complete'].includes(String(document.ready)))
        throw Error('FACEBOOK_TASK_DOCUMENT_READ_FAILED');
    } catch (error) {
      if (
        !missingFacebookDefaultContext(error) &&
        !(error instanceof Error && error.message === 'KERNEL_INITIAL_DOCUMENT_PENDING')
      )
        throw error;
    }
    await assertCurrent();
    await wait();
    await assertCurrent();
  }
  throw Error('FACEBOOK_TASK_DOCUMENT_TIMEOUT');
}
