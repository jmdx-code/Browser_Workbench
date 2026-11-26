declare const __BUNDLED_EXTENSION_VERSION__: string | undefined;
const reportedExtensionVersion = (): string =>
  typeof __BUNDLED_EXTENSION_VERSION__ === 'string' && __BUNDLED_EXTENSION_VERSION__.length > 0
    ? __BUNDLED_EXTENSION_VERSION__
    : chrome.runtime.getManifest().version;
import { ProfileHeartbeat } from '../src/application/kernel-gates.js';
import {
  Action,
  LEASE_MS,
  VERSION,
  isWrite,
  type Command,
  type WindowBounds,
} from '../src/bridge/protocol.js';
import { bridgeHelloCapabilities } from '../src/shared/bridge-capabilities.js';
import { heartbeatLeaseDeadline } from '../src/shared/bridge-connection-health.js';
import { Id } from '../src/shared/contracts.js';
import { projectFacebookDocumentIdentity } from '../src/shared/facebook-document-identity.js';
import { projectPage } from '../src/shared/page-projection.js';
import { ReconnectBackoff } from '../src/shared/reconnect-backoff.js';
import { ExtensionKernelChannel } from './kernel-channel.js';
import { initializeKernelJournal } from './kernel-storage.js';
import {
  cleanupExtraTabs,
  closeProfileWindows,
  getLastUserFocusedAt,
  inspectBrowserWindow,
  isProgrammaticWindowMoveActive,
  positionBrowserWindow,
  recordUserWindowFocus,
  revealBrowserWindow,
} from './reveal-browser-window.js';
import { consolidateOpenWorkbenchGroups, withBoundedWait } from './workspace-page-group.js';
export interface OutgoingMessageDiagnostic {
  observed: boolean;
  utf8Bytes: number;
  type: string;
  method?: string;
  entriesCount?: number;
}
export function inspectOutgoingExtensionMessage(
  msg: unknown,
  serialized?: string,
): OutgoingMessageDiagnostic {
  const raw = typeof serialized === 'string' ? serialized : JSON.stringify(msg);
  if (raw.length <= 350_000) {
    return { observed: false, utf8Bytes: raw.length, type: 'UNKNOWN' };
  }
  const utf8Bytes = new TextEncoder().encode(raw).byteLength;
  const obj = (v: unknown) =>
      typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined,
    rec = obj(msg),
    ev = obj(rec?.event),
    str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const type = str(rec?.type) ?? 'UNKNOWN';
  const method = str(rec?.method) ?? str(ev?.method);
  const entriesCount = Array.isArray(rec?.entries) ? rec.entries.length : undefined;
  if (utf8Bytes > 1_048_576) {
    console.warn('[BrowserWorkbench][BridgeOutgoingLargeMessage]', {
      type,
      method,
      entriesCount,
      utf8Bytes,
    });
    return { observed: true, utf8Bytes, type, method, entriesCount };
  }
  return { observed: false, utf8Bytes, type, method, entriesCount };
}
let activeHeartbeat: ProfileHeartbeat | undefined,
  profileId = '',
  secret = '',
  socket: WebSocket | undefined,
  epoch = '',
  leaseUntil = 0,
  paused = true,
  stopping = false,
  connectionSerial = 0,
  connecting = false,
  freezeSerial = 0,
  reloadingExtension = false,
  closingBrowserWindows = false,
  reconnectTimer: ReturnType<typeof setTimeout> | undefined,
  manualPauseReconnect = false,
  connectionStage = 'disconnected',
  connectionFailure = '';
const defaultFreezeTimeoutMs = 8_000,
  welcomeFreezeTimeoutMs = 5_000,
  disconnectFreezeTimeoutMs = 5_000,
  reloadFreezeTimeoutMs = 1_500,
  reconnectBackoff = new ReconnectBackoff();
function createChannel(channelEpoch: string): ExtensionKernelChannel {
  const instance: ExtensionKernelChannel = new ExtensionKernelChannel(
    () => ({
      profileId,
      epoch: channelEpoch,
      valid:
        kernel === instance &&
        epoch === channelEpoch &&
        paused &&
        !stopping &&
        socket?.readyState === WebSocket.OPEN &&
        Date.now() < leaseUntil,
    }),
    (message) => {
      if (kernel === instance && epoch === channelEpoch) send(message);
    },
  );
  return instance;
}
let kernel = createChannel(epoch);
async function init() {
  const all = await chrome.storage.local.get(null);
  profileId = typeof all.profileId === 'string' ? all.profileId : crypto.randomUUID();
  secret = typeof all.secret === 'string' ? all.secret : '';
  const junkKeys = Object.keys(all).filter((k) => k !== 'profileId' && k !== 'secret');
  if (junkKeys.length > 0) await chrome.storage.local.remove(junkKeys).catch(() => {});
  await chrome.storage.local.set({ profileId });
  await chrome.storage.session?.remove('owned').catch(() => {});
  await initializeKernelJournal(profileId);
  void consolidateOpenWorkbenchGroups().catch(() => {});
}
const ready = typeof chrome !== 'undefined' && chrome?.storage?.local ? init() : Promise.resolve();
const send = (msg: unknown) => {
  if (socket?.readyState === WebSocket.OPEN) {
    const raw = JSON.stringify(msg);
    inspectOutgoingExtensionMessage(msg, raw);
    socket.send(raw);
  }
};
let freezing: Promise<void> | undefined;
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  const res = await withBoundedWait(promise, ms);
  if (!res.completed) throw Error('KERNEL_STOP_UNCONFIRMED');
  return res.value;
}
function freeze(_reason: string, options: { timeoutMs?: number } = {}): Promise<void> {
  if (freezing) return bounded(freezing, options.timeoutMs ?? defaultFreezeTimeoutMs);
  const token = ++freezeSerial,
    serial = connectionSerial,
    originalKernel = kernel,
    grantedLeaseUntil = leaseUntil;
  paused = true;
  leaseUntil = 0;
  stopping = true;
  freezing = bounded(originalKernel.freeze(), options.timeoutMs ?? defaultFreezeTimeoutMs)
    .then(() => {
      if (token === freezeSerial && serial === connectionSerial && originalKernel === kernel)
        leaseUntil = Math.max(leaseUntil, grantedLeaseUntil);
    })
    .finally(() => {
      if (token === freezeSerial) {
        stopping = false;
        freezing = undefined;
      }
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
const isSocketActive = (): boolean =>
  !!socket &&
  (socket.readyState === WebSocket.OPEN ||
    socket.readyState === (WebSocket.CONNECTING ?? 0) ||
    socket.readyState === (WebSocket.CLOSING ?? 2));
const clearReconnectTimer = () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
};
async function handleStatelessCommand(command: Command): Promise<void> {
  const sendRes = (extra: Record<string, unknown>) =>
    send({ type: 'RESULT', commandId: command.commandId, ...extra });
  try {
    if (command.version !== VERSION || !command.commandId || !command.operationId)
      throw Error('PROTOCOL_REJECTED');
    const action = Action.parse(command.action);
    if (
      stopping ||
      isWrite(action) ||
      socket?.readyState !== WebSocket.OPEN ||
      command.connectionEpoch !== epoch ||
      Date.now() > leaseUntil ||
      Date.now() > command.deadline
    )
      throw Error('LEASE_OR_STOP_REJECTED');
    if (action.kind !== 'readFacebookDisplay')
      throw Error('STATELESS_EXTENSION_COMMAND_UNSUPPORTED');
    const tabs = await chrome.tabs.query({ url: 'https://www.facebook.com/*' }),
      byActive = (a: chrome.tabs.Tab, b: chrome.tabs.Tab) => Number(b.active) - Number(a.active),
      tab =
        tabs.filter((t) => t.url === 'https://www.facebook.com/').sort(byActive)[0] ??
        tabs
          .filter((t) => typeof t.url === 'string' && t.url.startsWith('https://www.facebook.com/'))
          .sort(byActive)[0];
    if (tab?.id === undefined)
      return sendRes({ status: 'VERIFIED', evidence: { available: false } });
    const execMain = <A extends unknown[], R>(func: (...a: A) => R, args: A) =>
      chrome.scripting.executeScript({
        target: { tabId: tab.id as number },
        world: 'MAIN',
        func,
        args,
      });
    const [pages, actors] = await Promise.all([
      execMain(projectPage, [action.projection]),
      execMain(projectFacebookDocumentIdentity, [
        tab.url === 'https://www.facebook.com/' ? 'home' : 'browse',
      ]),
    ]);
    const page = pages.find((r) => r.frameId === 0),
      actor = actors.find((r) => r.frameId === 0);
    if (!page?.documentId || page.documentId !== actor?.documentId)
      throw Error('INSPECTION_DOCUMENT_CHANGED');
    sendRes({
      status: 'VERIFIED',
      evidence: { available: true, tabId: tab.id, page: page.result, identity: actor.result },
    });
  } catch (e) {
    sendRes({ status: 'FAILED', error: e instanceof Error ? e.message : 'ERROR' });
  }
}
function assertLifecycleReady(incoming: Record<string, unknown>, ws: WebSocket): boolean {
  if (
    connectionStage !== 'ready' ||
    ws.readyState !== WebSocket.OPEN ||
    incoming.connectionEpoch !== epoch ||
    !Id.safeParse(incoming.requestId).success
  ) {
    ws.close(1008, 'PROTOCOL_REJECTED');
    return false;
  }
  return true;
}
const closeBrowserSocket = (ws: WebSocket) => {
  send({ type: 'PONG', connectionEpoch: epoch, windowCount: 0, profileWindowFocused: false });
  ws.close(1000, 'BROWSER_WINDOW_CLOSED');
};
function handleLifecycleSocketMessage(
  incoming: Record<string, unknown>,
  serial: number,
  ws: WebSocket,
): boolean {
  const runLifecycle = (
    flag: 'reload' | 'close',
    reason: string,
    body: () => Promise<void>,
    onErr?: (err: unknown) => void,
  ) => {
    const busy = flag === 'reload' ? reloadingExtension : closingBrowserWindows;
    if (!assertLifecycleReady(incoming, ws) || busy) return true;
    const setBusy = (v: boolean) =>
      flag === 'reload' ? (reloadingExtension = v) : (closingBrowserWindows = v);
    setBusy(true);
    void (async () => {
      try {
        await freeze(reason, { timeoutMs: reloadFreezeTimeoutMs }).catch(() => {});
        await body();
      } catch (err) {
        onErr?.(err);
      } finally {
        setBusy(false);
      }
    })();
    return true;
  };
  if (incoming.type === 'RELOAD_EXTENSION')
    return runLifecycle('reload', 'EXTENSION_RELOAD', async () => {
      if (
        serial !== connectionSerial ||
        ws.readyState !== WebSocket.OPEN ||
        epoch !== incoming.connectionEpoch
      )
        return;
      send({
        type: 'EXTENSION_RELOADING',
        extensionVersion: reportedExtensionVersion(),
        requestId: incoming.requestId,
        connectionEpoch: epoch,
      });
      chrome.runtime.reload();
    });
  if (incoming.type === 'CLOSE_BROWSER_WINDOWS') {
    const sendClosed = (ok: boolean, closedCount: number, remainingCount: number, error?: string) =>
      serial === connectionSerial &&
      ws.readyState === WebSocket.OPEN &&
      (send({
        type: 'BROWSER_WINDOWS_CLOSED',
        requestId: incoming.requestId,
        connectionEpoch: epoch,
        ok,
        closedCount,
        remainingCount,
        ...(error !== undefined ? { error } : {}),
      }),
      true);
    return runLifecycle(
      'close',
      'BROWSER_CLOSE_REQUESTED',
      async () => {
        const { closedCount, remainingCount } = await closeProfileWindows();
        if (remainingCount > 0)
          return void sendClosed(false, closedCount, remainingCount, 'BROWSER_CLOSE_BLOCKED');
        if (sendClosed(true, closedCount, 0)) closeBrowserSocket(ws);
      },
      (err) => sendClosed(false, 0, 1, err instanceof Error ? err.message : 'BROWSER_CLOSE_FAILED'),
    );
  }
  return false;
}
function dispatchSocketWindowMessage(m: Record<string, unknown>): boolean {
  const replyRpc = (type: string, run: () => Promise<Record<string, unknown>>) => {
    void run().then(
      (result) => send({ type, requestId: m.requestId, connectionEpoch: epoch, ...result }),
      (error) =>
        send({
          type,
          requestId: m.requestId,
          connectionEpoch: epoch,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return true;
  };
  const map: Record<string, [string, () => Promise<Record<string, unknown>>]> = {
    REVEAL_BROWSER_WINDOW: ['BROWSER_WINDOW_REVEALED', () => revealBrowserWindow()],
    CLEANUP_EXTRA_TABS: [
      'EXTRA_TABS_CLEANED',
      () => cleanupExtraTabs(Boolean(m.preferActiveTab), new Set()),
    ],
    INSPECT_BROWSER_WINDOW: ['BROWSER_WINDOW_INSPECTED', () => inspectBrowserWindow()],
    POSITION_BROWSER_WINDOW: [
      'BROWSER_WINDOW_POSITIONED',
      async () => {
        const result = await positionBrowserWindow(m.bounds as WindowBounds, Boolean(m.focus));
        await kernel.exposePositionedWindow(result.tabId);
        return result;
      },
    ],
  };
  const entry = typeof m.type === 'string' ? map[m.type] : undefined;
  return entry ? replyRpc(entry[0], entry[1]) : false;
}
async function connect() {
  const canTry = () =>
    !manualPauseReconnect && !isSocketActive() && reconnectBackoff.canAttempt(performance.now());
  if (connecting || !canTry()) return;
  clearReconnectTimer();
  connecting = true;
  let openedSocket = false;
  try {
    await ready;
    if (!canTry()) return;
    try {
      if ((await chrome.windows.getAll({ windowTypes: ['normal', 'popup'] })).length === 0) return;
    } catch {}
    if (!canTry()) return;
    openedSocket = true;
  } finally {
    if (!openedSocket) connecting = false;
  }
  connectionStage = 'connecting';
  const serial = ++connectionSerial,
    ws = new WebSocket('ws://127.0.0.1:18767/bridge');
  socket = ws;
  let inbox = Promise.resolve();
  const heartbeat = (activeHeartbeat = new ProfileHeartbeat(
    () => serial === connectionSerial && ws.readyState === WebSocket.OPEN,
    () => epoch,
    send,
    () => chrome.windows.getAll({ windowTypes: ['normal', 'popup'] }),
    (focused) => {
      if (focused && !isProgrammaticWindowMoveActive()) recordUserWindowFocus(Date.now());
      return getLastUserFocusedAt();
    },
  ));
  ws.onmessage = (event) => {
    if (serial !== connectionSerial) return;
    let incoming: unknown;
    try {
      incoming = JSON.parse(event.data);
    } catch {
      ws.close(1008, 'PROTOCOL_REJECTED');
      return;
    }
    const fastDeadline = heartbeatLeaseDeadline(incoming, epoch, Date.now(), LEASE_MS);
    if (fastDeadline !== null) {
      reconnectBackoff.healthy(performance.now());
      leaseUntil = fastDeadline;
      heartbeat.pulse();
      return;
    }
    if (
      incoming &&
      typeof incoming === 'object' &&
      'type' in incoming &&
      handleLifecycleSocketMessage(incoming as Record<string, unknown>, serial, ws)
    )
      return;
    inbox = inbox
      .then(async () => {
        try {
          if (serial !== connectionSerial) return;
          const m = incoming as Record<string, unknown> & {
            type?: string;
            version?: number;
            capabilities?: unknown;
            challenge?: string;
            connectionEpoch?: string;
            leaseMs?: number;
            secret?: string;
            requestId?: string;
          };
          if (m.type === 'CHALLENGE') {
            connectionStage = 'authenticating';
            if (m.version !== VERSION) throw Error('VERSION_MISMATCH');
            ws.send(
              JSON.stringify({
                type: 'HELLO',
                version: VERSION,
                extensionVersion: reportedExtensionVersion(),
                capabilities: bridgeHelloCapabilities(m.capabilities),
                profileId,
                ...(secret && typeof m.challenge === 'string'
                  ? { proof: await proof(m.challenge) }
                  : {}),
              }),
            );
          } else if (m.type === 'WELCOME') {
            connectionStage = 'restoring';
            connecting = false;
            paused = true;
            const oldKernel = kernel;
            await freeze('WELCOME_RESET', { timeoutMs: welcomeFreezeTimeoutMs }).catch(() => {});
            if (serial !== connectionSerial || ws.readyState !== WebSocket.OPEN) return;
            oldKernel.abandon();
            ++freezeSerial;
            freezing = undefined;
            stopping = false;
            epoch = String(m.connectionEpoch ?? '');
            kernel = createChannel(epoch);
            leaseUntil = Date.now() + Math.min(Number(m.leaseMs ?? 0), LEASE_MS);
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
          } else if (m.connectionEpoch !== epoch) throw Error('EPOCH_REJECTED');
          else if (m.type === 'HEARTBEAT') {
            const deadline = heartbeatLeaseDeadline(m, epoch, Date.now(), LEASE_MS);
            if (deadline === null) throw Error('HEARTBEAT_REJECTED');
            leaseUntil = deadline;
            heartbeat.pulse();
          } else if (dispatchSocketWindowMessage(m)) return;
          else if (m.type === 'KERNEL_REQUEST') kernel.receive(m);
          else if (m.type === 'PRESENTATION_RECOVERY_PERMIT') kernel.presentationRecoveryPermit(m);
          else if (m.type === 'SYNC' || m.type === 'STOP') {
            await freeze(m.type === 'SYNC' ? 'SYNC' : 'CORE_STOP').catch(() => {});
            if (serial !== connectionSerial || m.connectionEpoch !== epoch) return;
            send(
              m.type === 'SYNC'
                ? {
                    type: 'SYNC_STATE',
                    requestId: m.requestId,
                    connectionEpoch: epoch,
                    entries: [],
                  }
                : { type: 'STOPPED', requestId: m.requestId, connectionEpoch: epoch },
            );
          } else if (m.type === 'RESUME') {
            paused = false;
            send({ type: 'RESUMED', requestId: m.requestId, connectionEpoch: epoch });
          } else if (m.type === 'COMMAND') {
            void handleStatelessCommand(m as unknown as Command);
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
    void freeze('DISCONNECTED', { timeoutMs: disconnectFreezeTimeoutMs })
      .catch(() => {})
      .finally(() => {
        if (serial !== connectionSerial) return;
        clearReconnectTimer();
        if (manualPauseReconnect) return;
        reconnectTimer = setTimeout(() => {
          void connect().catch(() => {});
        }, reconnectBackoff.failed(performance.now()));
      });
  };
  ws.onerror = () => {
    if (serial !== connectionSerial) return;
    connectionFailure = 'NETWORK_UNAVAILABLE';
    ws.close();
  };
}
const wakeAndConnect = (clearManualPause = false, checkCooldown = false) => {
  if (clearManualPause) manualPauseReconnect = false;
  if (
    manualPauseReconnect ||
    connecting ||
    isSocketActive() ||
    (checkCooldown && !reconnectBackoff.canAttempt(performance.now()))
  )
    return;
  reconnectBackoff.reset();
  clearReconnectTimer();
  void connect().catch(() => {});
};
if (typeof chrome !== 'undefined' && chrome?.debugger?.onEvent) {
  chrome.debugger.onEvent.addListener((source, method, p?: object) => {
    if (source.tabId !== undefined)
      kernel.event({ tabId: source.tabId, sessionId: source.sessionId }, method, p);
  });
  chrome.debugger.onDetach.addListener(
    (s, r) => s.tabId !== undefined && kernel.detached(s.tabId, r),
  );
  chrome.tabs.onRemoved.addListener((tabId) => kernel.removed(tabId));
  chrome.windows.onCreated.addListener(() => wakeAndConnect(true));
  chrome.windows.onRemoved.addListener(() => {
    void chrome.windows
      .getAll({ windowTypes: ['normal', 'popup'] })
      .then((windows) => {
        if (windows.length === 0 && socket?.readyState === WebSocket.OPEN)
          closeBrowserSocket(socket);
      })
      .catch(() => {});
  });
}
const pulseIfNormalWin = (win: chrome.windows.Window | undefined) => {
    if (!isProgrammaticWindowMoveActive() && win?.focused && (!win.type || win.type === 'normal')) {
      recordUserWindowFocus(Date.now());
      activeHeartbeat?.pulse();
    }
  },
  noteWindowIdFocus = (windowId: number) => {
    if (isProgrammaticWindowMoveActive()) return;
    wakeAndConnect(false, true);
    void chrome.windows
      .get(windowId)
      .then(pulseIfNormalWin)
      .catch(() => {});
  };
if (typeof chrome !== 'undefined') {
  chrome.windows?.onFocusChanged?.addListener((id) => {
    if (typeof id === 'number' && id !== chrome.windows.WINDOW_ID_NONE && id >= 0)
      noteWindowIdFocus(id);
  });
  chrome.windows?.onBoundsChanged?.addListener(pulseIfNormalWin);
  chrome.tabs?.onActivated?.addListener((info) => noteWindowIdFocus(info.windowId));
}
if (typeof chrome !== 'undefined' && chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
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
          ownedTabs: [],
        });
    })().catch((e) => reply({ error: e.message }));
    return true;
  });
  chrome.alarms.onAlarm.addListener(() => wakeAndConnect());
  chrome.runtime.onStartup.addListener(() => wakeAndConnect(true));
  void chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
  setInterval(() => {
    kernel.expire();
    if (!paused && Date.now() > leaseUntil) void freeze('LEASE_EXPIRED').catch(() => {});
  }, 500);
  void ready.then(() => connect());
}
