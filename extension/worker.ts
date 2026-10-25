import {
  VERSION,
  LEASE_MS,
  ORIGIN,
  Action,
  isWrite,
  allowedTaskURL,
  type Command,
  type Reply,
  type Action as ActionType,
} from '../src/bridge/protocol.js';
import { Journal, type Saved } from './journal.js';
import { mediaPoint } from './media-point.js';
import { ExtensionKernelChannel } from './kernel-channel.js';
import { initializeKernelJournal } from './kernel-storage.js';
import { bridgeHelloCapabilities } from '../src/shared/bridge-capabilities.js';
import { projectPage } from '../src/shared/page-projection.js';
import { projectFacebookDocumentIdentity } from '../src/shared/facebook-document-identity.js';
import { BridgeCommandQueue } from '../src/application/bridge-command-queue.js';
import { heartbeatLeaseDeadline } from '../src/shared/bridge-heartbeat.js';
import { ProfileHeartbeat } from '../src/application/profile-heartbeat.js';
import { ReconnectBackoff } from '../src/shared/reconnect-backoff.js';
const journal = new Journal(chrome.storage.local);
type Owned = {
  tabId: number;
  token: string;
  sourceURL?: string;
  documentEpoch: number;
  routeEpoch: number;
};
let profileId = '',
  secret = '',
  socket: WebSocket | undefined,
  epoch = '',
  leaseUntil = 0,
  paused = true,
  stopping = false;
let generation = 0,
  connectionSerial = 0,
  connecting = false;
const commands = new BridgeCommandQueue();
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
const reconnectBackoff = new ReconnectBackoff();
let manualPauseReconnect = false;
let connectionStage = 'disconnected',
  connectionFailure = '';
const owned = new Map<number, Owned>(),
  attached = new Set<number>(),
  frames = new Map<string, { tabId: number; sessionId: string }>();
let kernel = new ExtensionKernelChannel(
  () => ({
    profileId,
    epoch,
    valid: paused && !stopping && socket?.readyState === WebSocket.OPEN && Date.now() < leaseUntil,
  }),
  (message) => send(message),
);
async function init() {
  await journal.migrate();
  const config = await chrome.storage.local.get(['profileId', 'secret']);
  profileId = typeof config.profileId === 'string' ? config.profileId : crypto.randomUUID();
  secret = typeof config.secret === 'string' ? config.secret : '';
  await chrome.storage.local.set({ profileId });
  await initializeKernelJournal(profileId);
  const session = await chrome.storage.session.get('owned');
  for (const row of (session.owned ?? []) as Owned[])
    try {
      const t = await chrome.tabs.get(row.tabId);
      const currentURL =
        t.url ??
        (await chrome.debugger.getTargets()).find((target) => target.tabId === row.tabId)?.url ??
        '';
      if (
        (row.sourceURL?.startsWith('https:') && allowedTaskURL(currentURL)) ||
        new URL(currentURL).searchParams.get('bridgeTab') === row.token
      )
        owned.set(row.tabId, { ...row, documentEpoch: row.documentEpoch + 1 });
    } catch {}
}
const ready = init();
const send = (msg: unknown) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
};
async function saveOwned() {
  await chrome.storage.session.set({ owned: [...owned.values()] });
}
function localURL(url: string) {
  try {
    const u = new URL(url);
    return (
      ['http://127.0.0.1:18767', 'http://localhost:18767'].includes(u.origin) &&
      ['/fixture', '/frame'].includes(u.pathname)
    );
  } catch {
    return false;
  }
}
function guard(command: Command, startGeneration: number) {
  if (
    stopping ||
    (paused && isWrite(command.action)) ||
    generation !== startGeneration ||
    socket?.readyState !== WebSocket.OPEN ||
    command.connectionEpoch !== epoch ||
    Date.now() > leaseUntil ||
    Date.now() > command.deadline
  )
    throw Error('LEASE_OR_STOP_REJECTED');
}
async function requireOwned(tabId: number) {
  const o = owned.get(tabId);
  if (!o) throw Error('TAB_NOT_OWNED');
  const t = await chrome.tabs.get(tabId);
  if (t.status === 'loading') throw Error('TAB_SCOPE_CHANGED');
  const url =
    t.url ??
    (await chrome.debugger.getTargets()).find((target) => target.tabId === tabId)?.url ??
    '';
  if (
    o.sourceURL?.startsWith('https:')
      ? !allowedTaskURL(url)
      : !localURL(url) || new URL(url).searchParams.get('bridgeTab') !== o.token
  )
    throw Error('TAB_SCOPE_CHANGED');
  return o;
}
async function attach(o: Owned) {
  if (attached.has(o.tabId)) return;
  await chrome.debugger.attach({ tabId: o.tabId }, '1.3');
  attached.add(o.tabId);
  await chrome.debugger.sendCommand({ tabId: o.tabId }, 'Page.enable');
  await chrome.debugger.sendCommand({ tabId: o.tabId }, 'Runtime.enable');
  await chrome.debugger.sendCommand({ tabId: o.tabId }, 'Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [{ type: 'iframe', exclude: false }],
  });
}
async function evaluate(tabId: number, expression: string) {
  const result: any = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails)
    throw Error(
      String(result.exceptionDetails.exception?.description ?? 'PAGE_EVALUATION_FAILED').split(
        '\n',
      )[0],
    );
  return result.result?.value;
}
// Generic locator and hit testing. Facebook-specific selectors/flows belong in the local controller.
function inspectExpression(spec: unknown, mode: 'point' | 'focus') {
  return `(()=>{const spec=${JSON.stringify(spec)};if(document.visibilityState!=='visible')throw Error('TARGET_HIDDEN');const root=spec.scope?document.querySelectorAll(spec.scope):[document];if(root.length!==1)throw Error('SCOPE_AMBIGUOUS');const nodes=Array.from(root[0].querySelectorAll(spec.css)).filter(e=>!spec.text||e.textContent.includes(spec.text));if(nodes.length!==1)throw Error('TARGET_AMBIGUOUS');const e=nodes[0];if(e.disabled||e.getAttribute('aria-disabled')==='true')throw Error('TARGET_DISABLED');e.scrollIntoView({block:'center',inline:'center',behavior:'instant'});const r=e.getBoundingClientRect();const style=getComputedStyle(e);if(!r.width||!r.height||style.visibility!=='visible'||style.display==='none'||Number(style.opacity)===0)throw Error('TARGET_HIDDEN');const x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);if(!hit||!e.contains(hit))throw Error('TARGET_OCCLUDED');${mode === 'focus' ? 'e.focus();if(document.activeElement!==e)throw Error("FOCUS_FAILED");' : ''}return{x,y,url:location.href,tag:e.tagName};})()`;
}
async function observe(o: Owned) {
  const mediaOnly = o.sourceURL?.startsWith('https:');
  const value = await evaluate(
    o.tabId,
    `JSON.stringify({url:location.href,title:document.title,visibility:document.visibilityState,focused:document.hasFocus(),buttons:Array.from(document.querySelectorAll('button,[role=button]')).filter(e=>${mediaOnly ? '["Play","播放","播放视频","Play video","Pause","暂停"].includes(e.getAttribute("aria-label"))' : 'true'}).slice(0,100).map(e=>({id:e.id,text:${mediaOnly ? 'undefined' : 'e.innerText?.slice(0,120)'},label:e.getAttribute('aria-label')?.slice(0,120),disabled:e.disabled||e.getAttribute('aria-disabled')==='true'})),state:document.querySelector('#business-state')?.textContent,events:document.querySelector('#events')?.textContent,media:document.querySelector('#media-log')?.textContent,video:Array.from(document.querySelectorAll('video')).slice(0,10).map((v,index)=>{const r=v.getBoundingClientRect();const s=getComputedStyle(v);return{index,source:v.currentSrc,time:v.currentTime,paused:v.paused,readyState:v.readyState,duration:Number.isFinite(v.duration)?v.duration:null,loop:v.loop,rate:v.playbackRate,ended:v.ended,visible:s.visibility==='visible'&&s.display!=='none'&&Number(s.opacity)>0&&r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight,area:r.width*r.height}})})`,
  );
  const snapshot = JSON.parse(value);
  for (const video of snapshot.video) video.nodeId = await mediaNodeId(o.tabId, video.index);
  return {
    ...snapshot,
    tabId: o.tabId,
    documentEpoch: o.documentEpoch,
    routeEpoch: o.routeEpoch,
  };
}
async function mediaNodeId(tabId: number, index: number) {
  const result: any = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `document.querySelectorAll('video')[${index}]`,
    returnByValue: false,
  });
  const objectId = result.result?.objectId;
  if (!objectId) throw Error('MEDIA_CHANGED');
  try {
    const described: any = await chrome.debugger.sendCommand({ tabId }, 'DOM.describeNode', {
      objectId,
    });
    return described.node.backendNodeId as number;
  } finally {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.releaseObject', { objectId });
  }
}
async function execute(
  command: Command,
  g: number,
): Promise<{ status: Reply['status']; evidence: unknown }> {
  const action: ActionType = Action.parse(command.action);
  guard(command, g);
  if (action.kind === 'uploadMedia') throw Error('SDK_BOUND_UPLOAD_REQUIRED');
  if (action.kind === 'readFacebookDisplay') {
    const tabs = await chrome.tabs.query({ url: 'https://www.facebook.com/*' });
    guard(command, g);
    const tab = tabs
      .filter((t) => t.url === 'https://www.facebook.com/')
      .sort((a, b) => Number(b.active) - Number(a.active))[0];
    if (tab?.id === undefined) return { status: 'VERIFIED', evidence: { available: false } };
    const pages = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: projectPage,
      args: [action.projection],
    });
    guard(command, g);
    const actors = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: projectFacebookDocumentIdentity,
      args: ['home'],
    });
    guard(command, g);
    const page = pages.find((r) => r.frameId === 0),
      actor = actors.find((r) => r.frameId === 0);
    if (!page?.documentId || page.documentId !== actor?.documentId)
      throw Error('INSPECTION_DOCUMENT_CHANGED');
    return {
      status: 'VERIFIED',
      evidence: { available: true, tabId: tab.id, page: page.result, identity: actor.result },
    };
  }
  if (action.kind === 'createTab' || action.kind === 'createTaskTab') {
    const token = crypto.randomUUID();
    const taskURL = new URL(action.kind === 'createTab' ? ORIGIN + '/fixture' : action.url);
    if (taskURL.origin === ORIGIN) taskURL.searchParams.set('bridgeTab', token);
    const window = await chrome.windows.create({
      url: taskURL.href,
      type: 'normal',
      focused: action.kind === 'createTaskTab',
    });
    const t = window?.tabs?.[0];
    if (!t?.id) throw Error('TAB_CREATE_FAILED');
    const o: Owned = {
      tabId: t.id,
      token,
      sourceURL: taskURL.href,
      documentEpoch: 0,
      routeEpoch: 0,
    };
    owned.set(t.id, o);
    await saveOwned();
    return {
      status: 'VERIFIED',
      evidence: {
        tabId: t.id,
        url: taskURL.href,
        note: '仅确认标签页创建，页面加载另行观察',
      },
    };
  }
  // Software SDK browse decisions use the existing kernel/CDP path, never this legacy fixture executor.
  if (action.kind === 'readTabState') {
    if (!owned.has(action.tabId)) throw Error('TAB_NOT_OWNED');
    const tab = await chrome.tabs.get(action.tabId);
    guard(command, g);
    if (tab.status === 'loading')
      return { status: 'VERIFIED', evidence: { tabId: tab.id, status: 'loading' } };
    await requireOwned(action.tabId);
    const window = await chrome.windows.get(tab.windowId);
    guard(command, g);
    return {
      status: 'VERIFIED',
      evidence: {
        tabId: tab.id,
        status: 'complete',
        url: tab.url,
        state: window.state,
        focused: window.focused,
        active: tab.active,
      },
    };
  }
  if (
    action.kind === 'browseNavigate' ||
    action.kind === 'browsePlay' ||
    action.kind === 'browseScroll'
  )
    throw Error('BROWSE_REQUIRES_MANAGED_KERNEL');
  const o = await requireOwned(action.tabId);
  guard(command, g);
  if (action.kind === 'closeTab') {
    // An intentional task-tab close must not look like an unexpected debugger takeover.
    // Remove ownership of the debugger before detach emits its asynchronous event.
    if (attached.delete(o.tabId)) {
      await chrome.debugger.detach({ tabId: o.tabId });
    }
    await chrome.tabs.remove(o.tabId);
    owned.delete(o.tabId);
    await saveOwned();
    return { status: 'VERIFIED', evidence: { closedTab: o.tabId } };
  }
  if (action.kind === 'windowState' || action.kind === 'activateTab') {
    const t = await chrome.tabs.get(o.tabId);
    const w = await chrome.windows.get(t.windowId, { populate: true });
    if (!w.tabs?.every((tab) => tab.id && owned.has(tab.id)))
      throw Error('WINDOW_CONTAINS_USER_TAB');
    guard(command, g);
    if (action.kind === 'activateTab') {
      await chrome.windows.update(t.windowId, { state: 'normal' });
      guard(command, g);
      await chrome.tabs.update(o.tabId, { active: true });
      guard(command, g);
      await chrome.windows.update(t.windowId, { focused: true });
    } else await chrome.windows.update(t.windowId, { state: action.state });
    const actual = await chrome.windows.get(t.windowId);
    const activeTab = await chrome.tabs.get(o.tabId);
    if (
      action.kind === 'activateTab'
        ? actual.state !== 'normal' || !actual.focused || !activeTab.active
        : actual.state !== action.state
    )
      throw Error('WINDOW_STATE_UNVERIFIED');
    return {
      status: 'VERIFIED',
      evidence: {
        windowId: t.windowId,
        state: actual.state,
        focused: actual.focused,
        active: activeTab.active,
        note: '窗口状态回执不代表页面可见，仍需只读核验',
      },
    };
  }
  await attach(o);
  guard(command, g);
  if (action.kind === 'observe') return { status: 'VERIFIED', evidence: await observe(o) };
  if (action.kind === 'frameProbe') {
    const tree = await chrome.debugger.sendCommand({ tabId: o.tabId }, 'Page.getFrameTree');
    const children = [];
    for (const [targetId, f] of frames)
      if (f.tabId === o.tabId) {
        const frame = await chrome.debugger.sendCommand(
          { tabId: o.tabId, sessionId: f.sessionId },
          'Page.getFrameTree',
        );
        children.push({ targetId, sessionId: f.sessionId, frame });
      }
    return { status: 'VERIFIED', evidence: { tree, children } };
  }
  if (action.documentEpoch !== o.documentEpoch || action.routeEpoch !== o.routeEpoch)
    throw Error('STALE_OBSERVATION');
  if (action.kind === 'mediaClick') {
    if ((await mediaNodeId(o.tabId, action.mediaIndex)) !== action.mediaNodeId)
      throw Error('MEDIA_CHANGED');
    const expression = `(${mediaPoint.toString()})(${JSON.stringify(action)})`;
    const point = await evaluate(o.tabId, expression);
    guard(command, g);
    const fresh = await evaluate(o.tabId, expression);
    if ((await mediaNodeId(o.tabId, action.mediaIndex)) !== action.mediaNodeId)
      throw Error('MEDIA_CHANGED');
    if (o.documentEpoch !== action.documentEpoch || o.routeEpoch !== action.routeEpoch)
      throw Error('STALE_OBSERVATION');
    if (Math.abs(point.x - fresh.x) > 1 || Math.abs(point.y - fresh.y) > 1)
      throw Error('TARGET_MOVED');
    guard(command, g);
    await chrome.debugger.sendCommand({ tabId: o.tabId }, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...fresh,
      button: 'left',
      clickCount: 1,
    });
    await chrome.debugger.sendCommand({ tabId: o.tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...fresh,
      button: 'left',
      clickCount: 1,
    });
    return {
      status: 'ACKNOWLEDGED',
      evidence: { inputDispatched: true, note: '需要观察实际播放状态' },
    };
  }
  const point = await evaluate(
    o.tabId,
    inspectExpression(action.target, action.kind === 'typeText' ? 'focus' : 'point'),
  );
  guard(command, g);
  const current = await requireOwned(o.tabId);
  if (current.documentEpoch !== action.documentEpoch || current.routeEpoch !== action.routeEpoch)
    throw Error('STALE_OBSERVATION');
  if (action.kind === 'typeText')
    await chrome.debugger.sendCommand({ tabId: o.tabId }, 'Input.insertText', {
      text: action.text,
    });
  else {
    const fresh = await evaluate(o.tabId, inspectExpression(action.target, 'point'));
    guard(command, g);
    if (Math.abs(point.x - fresh.x) > 1 || Math.abs(point.y - fresh.y) > 1)
      throw Error('TARGET_MOVED');
    await chrome.debugger.sendCommand({ tabId: o.tabId }, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: fresh.x,
      y: fresh.y,
      button: 'left',
      clickCount: 1,
    });
    try {
      await chrome.debugger.sendCommand({ tabId: o.tabId }, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: fresh.x,
        y: fresh.y,
        button: 'left',
        clickCount: 1,
      });
    } catch {
      throw Error('INPUT_OUTCOME_UNKNOWN');
    }
  }
  return {
    status: 'ACKNOWLEDGED',
    evidence: { inputDispatched: true, note: '业务结果必须再观察核验；不能将本状态标成任务成功' },
  };
}
async function handle(command: Command, g: number) {
  let dispatched = false;
  let entry: Saved | undefined;
  try {
    if (command.version !== VERSION || !command.commandId || !command.operationId)
      throw Error('PROTOCOL_REJECTED');
    command.action = Action.parse(command.action);
    guard(command, g);
    const prepared = await journal.prepare(command);
    entry = prepared.entry;
    if (!prepared.fresh && entry) {
      send({
        type: 'RESULT',
        commandId: command.commandId,
        status: entry.status === 'DISPATCHING' ? 'UNKNOWN' : entry.status,
        evidence: entry.evidence,
        error: entry.error,
      });
      return;
    }
    guard(command, g);
    dispatched = true;
    const result = await execute(command, g);
    if (entry) await journal.finish(entry, result);
    send({ type: 'RESULT', commandId: command.commandId, ...result });
  } catch (e) {
    const error = e instanceof Error ? e.message : 'ERROR';
    const preconditions = [
      'STALE_OBSERVATION',
      'TARGET_AMBIGUOUS',
      'TARGET_DISABLED',
      'TARGET_HIDDEN',
      'TARGET_OCCLUDED',
      'TARGET_MOVED',
      'SCOPE_AMBIGUOUS',
      'FOCUS_FAILED',
      'TAB_NOT_OWNED',
      'TAB_SCOPE_CHANGED',
      'MEDIA_CHANGED',
      'MEDIA_STATE_CHANGED',
    ];
    const status: Reply['status'] =
      !isWrite(command.action) || !dispatched || preconditions.some((code) => error.includes(code))
        ? 'FAILED'
        : 'UNKNOWN';
    // A rejected capacity check must not itself grow the journal.
    if (entry) await journal.finish(entry, { status, error });
    send({ type: 'RESULT', commandId: command.commandId, status, error });
    if (status === 'UNKNOWN') {
      void freeze('UNKNOWN');
      send({ type: 'LOCAL_STOP' });
    }
  }
}
let freezing: Promise<void> | undefined;
function freeze(_reason: string): Promise<void> {
  if (freezing) return freezing;
  paused = true;
  generation++;
  stopping = true;
  freezing = (async () => {
    const kernelStopped = kernel.freeze();
    await commands.drainWrites();
    await kernelStopped;
    for (const tabId of [...attached]) {
      attached.delete(tabId);
      try {
        await chrome.debugger.detach({ tabId });
      } catch {}
    }
    frames.clear();
  })().finally(() => {
    stopping = false;
    freezing = undefined;
  });
  return freezing;
}
async function proof(challenge: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(challenge))),
    (x) => x.toString(16).padStart(2, '0'),
  ).join('');
}
async function connect() {
  await ready;
  if (
    manualPauseReconnect ||
    connecting ||
    socket?.readyState === WebSocket.OPEN ||
    !reconnectBackoff.canAttempt(performance.now())
  )
    return;
  try {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal', 'popup'] });
    if (windows.length === 0) return;
  } catch {}
  if (
    manualPauseReconnect ||
    connecting ||
    socket?.readyState === WebSocket.OPEN ||
    !reconnectBackoff.canAttempt(performance.now())
  )
    return;
  connecting = true;
  connectionStage = 'connecting';
  const serial = ++connectionSerial;
  const ws = new WebSocket('ws://127.0.0.1:18767/bridge');
  socket = ws;
  let inbox = Promise.resolve();
  const heartbeat = new ProfileHeartbeat(
    () => serial === connectionSerial && ws.readyState === WebSocket.OPEN,
    () => epoch,
    send,
    () => chrome.windows.getAll({ windowTypes: ['normal', 'popup'] }),
  );
  ws.onmessage = (event) => {
    if (serial !== connectionSerial) return;
    let incoming: unknown;
    try {
      incoming = JSON.parse(event.data);
    } catch {
      ws.close(1008, 'PROTOCOL_REJECTED');
      return;
    }
    const deadline = heartbeatLeaseDeadline(incoming, epoch, Date.now(), LEASE_MS);
    if (deadline !== null) {
      reconnectBackoff.healthy(performance.now());
      leaseUntil = deadline;
      heartbeat.pulse();
      return;
    }
    inbox = inbox
      .then(async () => {
        try {
          if (serial !== connectionSerial) return;
          const m = JSON.parse(event.data);
          if (m.type === 'CHALLENGE') {
            connectionStage = 'authenticating';
            if (m.version !== VERSION) throw Error('VERSION_MISMATCH');
            ws.send(
              JSON.stringify({
                type: 'HELLO',
                version: VERSION,
                extensionVersion: chrome.runtime.getManifest().version,
                capabilities: bridgeHelloCapabilities(m.capabilities),
                profileId,
                ...(secret ? { proof: await proof(m.challenge) } : {}),
              }),
            );
          } else if (m.type === 'WELCOME') {
            connectionStage = 'restoring';
            connecting = false;
            epoch = m.connectionEpoch;
            paused = true;
            await kernel.freeze();
            if (serial !== connectionSerial || ws.readyState !== WebSocket.OPEN) return;
            kernel = new ExtensionKernelChannel(
              () => ({
                profileId,
                epoch,
                valid:
                  paused &&
                  !stopping &&
                  socket?.readyState === WebSocket.OPEN &&
                  Date.now() < leaseUntil,
              }),
              (message) => send(message),
            );
            leaseUntil = Date.now() + Math.min(m.leaseMs, LEASE_MS);
            if (m.secret) {
              secret = m.secret;
              await chrome.storage.local.set({ secret });
            }
            connectionStage = 'ready';
            reconnectBackoff.connected(performance.now());
            connectionFailure = '';
            heartbeat.pulse();
          } else if (m.type === 'PROFILE_REMOVED') {
            manualPauseReconnect = true;
            connectionFailure = 'PROFILE_REMOVED';
            ws.close(1000, 'PROFILE_REMOVED');
            return;
          } else if (m.connectionEpoch !== epoch) throw Error('EPOCH_REJECTED');
          else if (m.type === 'HEARTBEAT') {
            const deadline = heartbeatLeaseDeadline(m, epoch, Date.now(), LEASE_MS);
            if (deadline === null) throw Error('HEARTBEAT_REJECTED');
            leaseUntil = deadline;
            heartbeat.pulse();
          } else if (m.type === 'KERNEL_REQUEST') {
            // Do not await a long Runtime call here: STOP must remain processable.
            kernel.receive(m);
          } else if (m.type === 'PRESENTATION_RECOVERY_PERMIT') {
            kernel.presentationRecoveryPermit(m);
          } else if (m.type === 'SYNC') {
            await freeze('SYNC');
            const entries = await journal.snapshot();
            send({ type: 'SYNC_STATE', requestId: m.requestId, connectionEpoch: epoch, entries });
          } else if (m.type === 'RESUME') {
            if (stopping || Date.now() >= leaseUntil) throw Error('RESUME_NOT_READY');
            paused = false;
            send({ type: 'RESUMED', requestId: m.requestId, connectionEpoch: epoch });
          } else if (m.type === 'STOP') {
            await freeze('CORE_STOP');
            send({ type: 'STOPPED', requestId: m.requestId, connectionEpoch: epoch });
          } else if (m.type === 'RELOAD_EXTENSION') {
            await freeze('EXTENSION_RELOAD');
            send({ type: 'EXTENSION_RELOADING', requestId: m.requestId, connectionEpoch: epoch });
            chrome.runtime.reload();
          } else if (m.type === 'COMMAND') {
            const receivedGeneration = generation;
            void commands
              .enqueue(isWrite(Action.parse(m.action)), () => handle(m, receivedGeneration))
              .catch(() => {});
          }
        } catch {
          connectionFailure = 'PROTOCOL_REJECTED';
          ws.close(1008, 'PROTOCOL_REJECTED');
        }
      })
      .catch(() => ws.close(1008, 'PROTOCOL_REJECTED'));
  };
  ws.onclose = (event) => {
    if (serial !== connectionSerial) return;
    connecting = false;
    connectionStage = 'disconnected';
    if (['AUTH_TIMEOUT', 'AUTH_OR_PROTOCOL_REJECTED', 'PROTOCOL_REJECTED'].includes(event.reason))
      connectionFailure = event.reason;
    else if (!connectionFailure) connectionFailure = 'CONNECTION_CLOSED';
    void freeze('DISCONNECTED')
      .catch(() => {})
      .finally(() => {
        if (serial !== connectionSerial) return;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (manualPauseReconnect) return;
        reconnectTimer = setTimeout(() => {
          void connect().catch(() => {});
        }, reconnectBackoff.failed(performance.now()));
      });
  };
  ws.onerror = () => {
    connectionFailure = 'NETWORK_UNAVAILABLE';
    ws.close();
  };
}
chrome.debugger.onEvent.addListener((source, method, p: any) => {
  if (source.tabId !== undefined)
    kernel.event({ tabId: source.tabId, sessionId: source.sessionId }, method, p);
  const o = source.tabId ? owned.get(source.tabId) : undefined;
  if (!o) return;
  if (method === 'Page.frameNavigated' && !source.sessionId && !p.frame.parentId) {
    o.documentEpoch++;
    o.routeEpoch++;
    void saveOwned();
  }
  if (method === 'Page.navigatedWithinDocument' && !source.sessionId) {
    o.routeEpoch++;
    void saveOwned();
  }
  if (method === 'Target.attachedToTarget' && p.targetInfo.type === 'iframe') {
    frames.set(p.targetInfo.targetId, { tabId: o.tabId, sessionId: p.sessionId });
    void chrome.debugger
      .sendCommand({ tabId: o.tabId, sessionId: p.sessionId }, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: 'iframe', exclude: false }],
      })
      .catch(() => {});
  }
  if (method === 'Target.detachedFromTarget')
    for (const [id, f] of frames) if (f.sessionId === p.sessionId) frames.delete(id);
});
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) kernel.detached(source.tabId);
  if (source.tabId === undefined || !attached.has(source.tabId)) return;
  if (!stopping) {
    void freeze('DEBUGGER_DETACHED');
    send({ type: 'LOCAL_STOP' });
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  kernel.removed(tabId);
  owned.delete(tabId);
  attached.delete(tabId);
  void saveOwned();
});
chrome.windows.onCreated.addListener(() => {
  manualPauseReconnect = false;
  reconnectBackoff.reset();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  void connect().catch(() => {});
});
chrome.windows.onRemoved.addListener(() => {
  void chrome.windows
    .getAll({ windowTypes: ['normal', 'popup'] })
    .then((windows) => {
      if (windows.length === 0 && socket?.readyState === WebSocket.OPEN) {
        send({
          type: 'PONG',
          connectionEpoch: epoch,
          windowCount: 0,
          profileWindowFocused: false,
        });
        socket.close(1000, 'BROWSER_WINDOW_CLOSED');
      }
    })
    .catch(() => {});
});
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  void (async () => {
    await ready;
    if (msg.type === 'CONNECT') {
      manualPauseReconnect = false;
      reconnectBackoff.reset();
      await connect();
      reply({ accepted: true });
    } else if (msg.type === 'STOP') {
      await freeze('USER_STOP');
      send({ type: 'LOCAL_STOP' });
      reply({ stopped: true });
    } else if (msg.type === 'STATUS')
      reply({
        profileId,
        connected: socket?.readyState === WebSocket.OPEN,
        connectionStage,
        connectionFailure,
        paired: Boolean(secret),
        paused,
        leaseRemainingMs: Math.max(0, leaseUntil - Date.now()),
        ownedTabs: [...owned.keys()],
      });
  })().catch((e) => reply({ error: e.message }));
  return true;
});
chrome.alarms.onAlarm.addListener(() => {
  void connect();
});
chrome.runtime.onStartup.addListener(() => {
  manualPauseReconnect = false;
  reconnectBackoff.reset();
  void connect().catch(() => {});
});
void chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
setInterval(() => {
  kernel.expire();
  if (!paused && Date.now() > leaseUntil) void freeze('LEASE_EXPIRED');
}, 500);
void ready.then(() => connect());
