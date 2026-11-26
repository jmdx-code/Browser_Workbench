import { KernelJsonObject } from '../src/shared/kernel-protocol.js';
import {
  FacebookNativeActor,
  parseNativeFacebookActor,
  type NativeFacebookActor,
  type NativeFacebookIdentityRead,
} from '../src/shared/facebook-native-identity.js';
import { projectFacebookDocumentIdentity } from './facebook-document-identity.js';
import { sleep } from './workspace-page-group.js';
// Private bounded read on a freshly created, owned inspection tab. No page input or HTTP send.
export async function readNativeFacebookIdentity(
  tabId: number,
  assertCurrent: () => Promise<void>,
): Promise<NativeFacebookIdentityRead | null> {
  await assertCurrent();
  const FB_GQL = 'https://www.facebook.com/api/graphql/',
    fail = () => void (failed = true),
    sendCmd = (method: string, params?: Record<string, unknown>) =>
      chrome.debugger.sendCommand({ tabId }, method, params);
  const readMainFrame = async () =>
    KernelJsonObject.parse(
      KernelJsonObject.parse(KernelJsonObject.parse(await sendCmd('Page.getFrameTree')).frameTree)
        .frame,
    );
  const frame = await readMainFrame();
  if (typeof frame.id !== 'string' || frame.parentId !== undefined)
    throw Error('IDENTITY_MAIN_FRAME_REQUIRED');
  const requests = new Map<string, { av: string; loaderId: string; responseSeen: boolean }>(),
    pending = new Set<Promise<void>>();
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
    if (!params.success) return fail();
    const v = params.data,
      reqId = typeof v.requestId === 'string' ? v.requestId : null;
    if (method === 'Network.requestWillBeSent') {
      const req = KernelJsonObject.safeParse(v.request);
      if (
        !req.success ||
        req.data.url !== FB_GQL ||
        req.data.method !== 'POST' ||
        v.frameId !== frame.id ||
        !reqId
      )
        return;
      if (++count > 64) return fail();
      if (typeof req.data.postData !== 'string' || req.data.postData.length > 524288) return;
      const fields = new URLSearchParams(req.data.postData);
      if (fields.get('fb_api_req_friendly_name') !== 'CometSettingsDropdownTriggerQuery') return;
      const av = fields.get('av');
      if (
        fields.getAll('av').length !== 1 ||
        fields.getAll('fb_api_req_friendly_name').length !== 1 ||
        !av ||
        !/^\d{1,30}$/.test(av) ||
        typeof v.loaderId !== 'string'
      )
        return fail();
      requests.set(reqId, { av, loaderId: v.loaderId, responseSeen: false });
    } else if (method === 'Network.responseReceived' && reqId) {
      const entry = requests.get(reqId);
      if (!entry) return;
      const res = KernelJsonObject.safeParse(v.response);
      if (
        !res.success ||
        res.data.status !== 200 ||
        res.data.url !== FB_GQL ||
        v.loaderId !== entry.loaderId ||
        v.frameId !== frame.id
      )
        return fail();
      entry.responseSeen = true;
    } else if (method === 'Network.loadingFailed' && reqId && requests.has(reqId)) {
      fail();
    } else if (method === 'Network.loadingFinished' && reqId) {
      const entry = requests.get(reqId);
      if (!entry) return;
      if (!entry.responseSeen) return fail();
      requests.delete(reqId);
      const read = (async () => {
        await assertCurrent();
        if (!live) return;
        if (
          typeof v.encodedDataLength !== 'number' ||
          !Number.isFinite(v.encodedDataLength) ||
          v.encodedDataLength < 0 ||
          v.encodedDataLength > 524288
        )
          throw Error('IDENTITY_RESPONSE_BUDGET');
        const reply = KernelJsonObject.parse(
          await sendCmd('Network.getResponseBody', { requestId: reqId }),
        );
        await assertCurrent();
        if (!live) return;
        if (typeof reply.body !== 'string' || reply.base64Encoded === true)
          throw Error('IDENTITY_RESPONSE_ENCODING');
        const next = parseNativeFacebookActor(reply.body, entry.av, Date.now());
        if (!next || (actor && actor.accountId !== next.accountId))
          throw Error('IDENTITY_ACTOR_UNCONFIRMED');
        actor = next;
        actorLoader = entry.loaderId;
      })().catch(fail);
      pending.add(read);
      void read.finally(() => pending.delete(read));
    }
  };
  chrome.debugger.onEvent.addListener(listener);
  try {
    await assertCurrent();
    await sendCmd('Network.enable', {
      maxTotalBufferSize: 2097152,
      maxResourceBufferSize: 524288,
      maxPostDataSize: 524288,
    });
    await assertCurrent();
    await chrome.tabs.reload(tabId);
    await assertCurrent();
    for (
      const started = Date.now();
      !failed && (!actor || pending.size) && Date.now() - started < 5000;
    ) {
      await sleep(100);
      await assertCurrent();
    }
    if (failed || pending.size) return null;
    let transport: 'native-response' | 'document-preload' = 'native-response';
    if (!actor) {
      await assertCurrent();
      const docFrame = await readMainFrame();
      if (
        docFrame.id !== frame.id ||
        typeof docFrame.loaderId !== 'string' ||
        docFrame.url !== 'https://www.facebook.com/'
      )
        return null;
      await assertCurrent();
      const projection = KernelJsonObject.parse(
        await sendCmd('Runtime.evaluate', {
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
      actorLoader = docFrame.loaderId;
      transport = 'document-preload';
    }
    await assertCurrent();
    const finalFrame = await readMainFrame();
    await assertCurrent();
    return finalFrame.id === frame.id && finalFrame.loaderId === actorLoader
      ? { actor, frameId: frame.id, loaderId: actorLoader, transport }
      : null;
  } finally {
    live = false;
    chrome.debugger.onEvent.removeListener(listener);
    requests.clear();
    await Promise.allSettled([...pending]);
    try {
      await sendCmd('Network.disable');
    } catch {}
  }
}
