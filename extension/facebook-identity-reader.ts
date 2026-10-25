import { KernelJsonObject } from '../src/shared/kernel-protocol.js';
import {
  FacebookNativeActor,
  parseNativeFacebookActor,
  type NativeFacebookActor,
  type NativeFacebookIdentityRead,
} from '../src/shared/facebook-native-identity.js';
import { projectFacebookDocumentIdentity } from './facebook-document-identity.js';

// Private bounded read on a freshly created, owned inspection tab. The original public
// projection and raw read-only command whitelist stay unchanged. No page input or HTTP send.
export async function readNativeFacebookIdentity(
  tabId: number,
  assertCurrent: () => Promise<void>,
): Promise<NativeFacebookIdentityRead | null> {
  await assertCurrent();
  const frameReply = KernelJsonObject.parse(
    await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree'),
  );
  const frameTree = KernelJsonObject.parse(frameReply.frameTree),
    frame = KernelJsonObject.parse(frameTree.frame);
  if (typeof frame.id !== 'string' || frame.parentId !== undefined)
    throw Error('IDENTITY_MAIN_FRAME_REQUIRED');
  const requests = new Map<string, { av: string; loaderId: string; responseSeen: boolean }>();
  const pending = new Set<Promise<void>>();
  let actor: NativeFacebookActor | null = null,
    actorLoader = '',
    failed = false,
    live = true,
    count = 0;
  const listener = (
    source: chrome.debugger.Debuggee & { sessionId?: string },
    method: string,
    input?: object,
  ) => {
    if (!live || source.tabId !== tabId || source.sessionId) return;
    const params = KernelJsonObject.safeParse(input ?? {});
    if (!params.success) {
      failed = true;
      return;
    }
    const value = params.data;
    if (method === 'Network.requestWillBeSent') {
      const request = KernelJsonObject.safeParse(value.request);
      if (
        !request.success ||
        request.data.url !== 'https://www.facebook.com/api/graphql/' ||
        request.data.method !== 'POST' ||
        value.frameId !== frame.id ||
        typeof value.requestId !== 'string'
      )
        return;
      if (++count > 64) {
        failed = true;
        return;
      }
      const postData = request.data.postData;
      if (typeof postData !== 'string' || postData.length > 524288) return;
      const fields = new URLSearchParams(postData);
      if (fields.get('fb_api_req_friendly_name') !== 'CometSettingsDropdownTriggerQuery') return;
      const av = fields.get('av');
      if (
        fields.getAll('av').length !== 1 ||
        fields.getAll('fb_api_req_friendly_name').length !== 1 ||
        !av ||
        !/^\d{1,30}$/.test(av) ||
        typeof value.loaderId !== 'string'
      ) {
        failed = true;
        return;
      }
      requests.set(value.requestId, { av, loaderId: value.loaderId, responseSeen: false });
    }
    if (method === 'Network.responseReceived' && typeof value.requestId === 'string') {
      const request = requests.get(value.requestId);
      if (!request) return;
      const response = KernelJsonObject.safeParse(value.response);
      if (
        !response.success ||
        response.data.status !== 200 ||
        response.data.url !== 'https://www.facebook.com/api/graphql/' ||
        value.loaderId !== request.loaderId ||
        value.frameId !== frame.id
      ) {
        failed = true;
        return;
      }
      request.responseSeen = true;
    }
    if (
      method === 'Network.loadingFailed' &&
      typeof value.requestId === 'string' &&
      requests.has(value.requestId)
    )
      failed = true;
    if (method === 'Network.loadingFinished' && typeof value.requestId === 'string') {
      const request = requests.get(value.requestId);
      if (!request) return;
      if (!request.responseSeen) {
        failed = true;
        return;
      }
      requests.delete(value.requestId);
      const requestId = value.requestId;
      const read = (async () => {
        await assertCurrent();
        if (!live) return;
        if (
          typeof value.encodedDataLength !== 'number' ||
          !Number.isFinite(value.encodedDataLength) ||
          value.encodedDataLength < 0 ||
          value.encodedDataLength > 524288
        )
          throw Error('IDENTITY_RESPONSE_BUDGET');
        const reply = KernelJsonObject.parse(
          await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId }),
        );
        await assertCurrent();
        if (!live) return;
        // Native observed response was UTF-8 JSON. Unknown encodings are not guessed.
        if (typeof reply.body !== 'string' || reply.base64Encoded === true)
          throw Error('IDENTITY_RESPONSE_ENCODING');
        const next = parseNativeFacebookActor(reply.body, request.av, Date.now());
        if (!next || (actor && actor.accountId !== next.accountId))
          throw Error('IDENTITY_ACTOR_UNCONFIRMED');
        actor = next;
        actorLoader = request.loaderId;
      })().catch(() => {
        failed = true;
      });
      pending.add(read);
      void read.finally(() => pending.delete(read));
    }
  };
  chrome.debugger.onEvent.addListener(listener);
  try {
    await assertCurrent();
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
      maxTotalBufferSize: 2097152,
      maxResourceBufferSize: 524288,
      maxPostDataSize: 524288,
    });
    await assertCurrent();
    // Reload only this newly created read tab so cached initial requests cannot silently pass
    // as current evidence. Never adopts, reloads or modifies a user's existing tab.
    await chrome.tabs.reload(tabId);
    await assertCurrent();
    const started = Date.now();
    while (!failed && (!actor || pending.size) && Date.now() - started < 5000) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      await assertCurrent();
    }
    if (failed || pending.size) return null;
    let transport: 'native-response' | 'document-preload' = 'native-response';
    if (!actor) {
      await assertCurrent();
      const before = KernelJsonObject.parse(
        await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree'),
      );
      const documentFrame = KernelJsonObject.parse(KernelJsonObject.parse(before.frameTree).frame);
      if (
        documentFrame.id !== frame.id ||
        typeof documentFrame.loaderId !== 'string' ||
        documentFrame.url !== 'https://www.facebook.com/'
      )
        return null;
      await assertCurrent();
      const projection = KernelJsonObject.parse(
        await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: '(' + projectFacebookDocumentIdentity.toString() + ')()',
          returnByValue: true,
        }),
      );
      await assertCurrent();
      if (projection.exceptionDetails) return null;
      const value = KernelJsonObject.parse(KernelJsonObject.parse(projection.result).value);
      if (value.url !== 'https://www.facebook.com/' || value.ready !== 'complete') return null;
      const observed = FacebookNativeActor.nullable().safeParse(value.actor);
      if (!observed.success || !observed.data) return null;
      actor = observed.data;
      actorLoader = documentFrame.loaderId;
      transport = 'document-preload';
    }
    await assertCurrent();
    const last = KernelJsonObject.parse(
      await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree'),
    );
    const finalFrame = KernelJsonObject.parse(KernelJsonObject.parse(last.frameTree).frame);
    await assertCurrent();
    return finalFrame.id === frame.id && finalFrame.loaderId === actorLoader
      ? { actor, frameId: frame.id, loaderId: actorLoader, transport }
      : null;
  } finally {
    live = false;
    chrome.debugger.onEvent.removeListener(listener);
    requests.clear();
    // All asynchronous native reads recheck the original lease before sending a command.
    await Promise.allSettled([...pending]);
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Network.disable');
    } catch {
      /* stop may have detached */
    }
  }
}
