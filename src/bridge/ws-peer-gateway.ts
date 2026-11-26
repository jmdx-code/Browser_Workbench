import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { Awaitable } from '../domain/persistence.js';
import type { BridgeStorePort } from '../infrastructure/persistence-port.js';
import { bridgeCapabilities } from '../shared/bridge-capabilities.js';
import { Id, NonNegInt, PosInt, sMax, strictObj } from '../shared/contracts.js';
import { devDiag } from '../shared/dev-diagnostics.js';
import type { Core, Peer } from './core.js';
import { LEASE_MS, VERSION, type Reply } from './protocol.js';
export interface KernelBridgeHooks {
  message(peer: Peer, value: unknown): Awaitable<boolean>;
  disconnected(peer: Peer): Awaitable<void>;
  controlStopped(peer: Peer, requestId?: string): Awaitable<void>;
  tick(): Awaitable<void>;
  close(): Promise<void>;
}
export interface ConnectionFailureEntry {
  profileId: string | null;
  code: string;
  fields: string[];
  at: number;
  count: number;
}
export interface PendingRecoveryEntry {
  id: string;
  profileId: string;
  extensionId: string;
  expected: string;
  socket: WebSocket;
  expiresAt: number;
  busy: boolean;
  resolve: (secret: string) => void;
  reject: (error: Error) => void;
}
function equalSecret(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
const diagWs = (
  event: string,
  level: 'INFO' | 'WARN' | 'ERROR',
  profileId?: string,
  reason?: string,
  data?: Record<string, unknown>,
) => devDiag.record({ level, category: 'BRIDGE_WS', event, profileId, reason, data });
export function observeBridgeIncomingMessage(
  raw: unknown,
  parsed: unknown,
  profileId?: string,
): { utf8Bytes: number; observed: boolean } {
  const utf8Bytes =
    Buffer.isBuffer(raw) || raw instanceof ArrayBuffer
      ? raw.byteLength
      : Array.isArray(raw)
        ? raw.reduce((acc, buf) => acc + (Buffer.isBuffer(buf) ? buf.byteLength : 0), 0)
        : Buffer.byteLength(String(raw ?? ''), 'utf8');
  if (utf8Bytes <= 2 * 1024 * 1024 || typeof parsed !== 'object' || parsed === null)
    return { utf8Bytes, observed: false };
  const record = parsed as Record<string, unknown>,
    ev =
      typeof record.event === 'object' && record.event !== null
        ? (record.event as Record<string, unknown>)
        : undefined;
  diagWs('BRIDGE_LARGE_MESSAGE_OBSERVED', 'WARN', profileId, 'LARGE_INCOMING_MESSAGE', {
    bytes: utf8Bytes,
    type: typeof record.type === 'string' ? record.type : 'UNKNOWN',
    method:
      typeof record.method === 'string'
        ? record.method
        : typeof ev?.method === 'string'
          ? ev.method
          : undefined,
    commandId: typeof record.commandId === 'string' ? record.commandId : undefined,
    requestId: typeof record.requestId === 'string' ? record.requestId : undefined,
    entriesCount: Array.isArray(record.entries) ? record.entries.length : undefined,
    topKeys: Object.keys(record).slice(0, 12),
  });
  return { utf8Bytes, observed: true };
}
const WinBoundsSchema = strictObj({
    left: z.number().int(),
    top: z.number().int(),
    width: z.number().int(),
    height: z.number().int(),
  }),
  WinInsetsSchema = strictObj({
    left: NonNegInt,
    top: NonNegInt,
    right: NonNegInt,
    bottom: NonNegInt,
  }),
  HelloSchema = strictObj({
    type: z.literal('HELLO'),
    version: z.literal(VERSION),
    extensionVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    capabilities: z.array(z.enum(bridgeCapabilities)).min(4).max(bridgeCapabilities.length),
    profileId: Id,
    pairingCode: z.string().optional(),
    proof: z.string().optional(),
  });
const REQUIRED_CAPS = [
  'operation-journal-v2',
  'stop-confirmation',
  'media-observation',
  'media-node-identity',
] as const;
const PROTOCOL_CODES = new Set([
  'AUTH_FAILED',
  'AUTH_EXTENSION_MISMATCH',
  'AUTH_PROOF_MISSING',
  'AUTH_PROOF_MISMATCH',
  'CAPABILITY_MISMATCH',
  'DUPLICATE_PROFILE',
  'EPOCH_REJECTED',
  'MESSAGE_REJECTED',
]);
const errOpt = sMax(500).optional(),
  optNn = NonNegInt.optional(),
  optPos = PosInt.optional(),
  reqErr = { requestId: Id, error: errOpt },
  winGeoFields = {
    requestId: Id,
    windowId: z.number().int().optional(),
    tabId: optNn,
    focused: z.boolean().optional(),
    state: sMax(40).optional(),
    bounds: WinBoundsSchema.optional(),
    contentInsets: WinInsetsSchema.optional(),
    error: errOpt,
  },
  ResultMsg = strictObj({
    type: z.literal('RESULT'),
    commandId: Id,
    status: z.enum(['ACKNOWLEDGED', 'VERIFIED', 'FAILED', 'UNKNOWN']),
    evidence: z.unknown().optional(),
    error: z.string().optional(),
  }),
  WinRevealedMsg = z.object({ ...reqErr, tabId: optPos, focused: z.boolean().optional() }),
  ExtraTabsMsg = z.object({
    ...reqErr,
    keptTabId: optPos,
    closedTabIds: z.array(PosInt).max(500).optional(),
    remainingTabCount: optPos,
  }),
  WinInspectedMsg = z.object({
    ...winGeoFields,
    lastFocusedAt: optNn,
    displays: z
      .array(WinBoundsSchema.extend({ id: sMax(80) }).strict())
      .max(32)
      .optional(),
  }),
  WinGeoMsg = z.object(winGeoFields),
  WinClosedMsg = z.object({
    requestId: Id,
    ok: z.boolean(),
    closedCount: optNn,
    remainingCount: optNn,
    error: sMax(240).optional(),
  });
function recordWsFailure(
  connectionFailures: Map<string, ConnectionFailureEntry>,
  profileId: string | null,
  error: unknown,
): string {
  const key = profileId ?? 'unidentified';
  const code =
    error instanceof z.ZodError
      ? 'SCHEMA_REJECTED'
      : error instanceof Error && PROTOCOL_CODES.has(error.message)
        ? error.message
        : 'PROTOCOL_REJECTED';
  const previous = connectionFailures.get(key);
  if (!previous && connectionFailures.size >= 32) {
    const oldest = connectionFailures.keys().next().value;
    if (oldest) connectionFailures.delete(oldest);
  }
  connectionFailures.set(key, {
    profileId,
    code,
    fields:
      error instanceof z.ZodError ? error.issues.map((i) => i.path.join('.')).slice(0, 8) : [],
    at: Date.now(),
    count: (previous?.count ?? 0) + 1,
  });
  return code;
}
const winRpc =
  <T extends { requestId: string }>(
    schema: z.ZodType<T>,
    fn: (core: Core, p: Peer, id: string, r: T) => void,
  ) =>
  (core: Core, p: Peer, v: unknown) => {
    const r = schema.parse(v);
    fn(core, p, r.requestId, r);
  };
const winRpcHandlers: Record<string, (core: Core, p: Peer, v: unknown) => void> = {
  BROWSER_WINDOW_REVEALED: winRpc(WinRevealedMsg, (c, p, id, r) => c.windowRevealed(p, id, r)),
  EXTRA_TABS_CLEANED: winRpc(ExtraTabsMsg, (c, p, id, r) => c.extraTabsCleaned(p, id, r)),
  BROWSER_WINDOW_INSPECTED: winRpc(WinInspectedMsg, (c, p, id, r) =>
    c.browserWindowInspected(p, id, r),
  ),
  BROWSER_WINDOW_POSITIONED: winRpc(WinGeoMsg, (c, p, id, r) =>
    c.browserWindowPositioned(p, id, r),
  ),
  BROWSER_WINDOWS_CLOSED: winRpc(WinClosedMsg, (c, p, id, r) => c.browserWindowsClosed(p, id, r)),
};
async function handleAuthedWsMessage(
  core: Core,
  kernel: KernelBridgeHooks | undefined,
  extensionIdle: ((peer: Peer) => Awaitable<void>) | undefined,
  peer: Peer,
  m: Record<string, unknown>,
  onPong: () => void,
) {
  if (m.type === 'RESULT') return void (await core.reply(peer, ResultMsg.parse(m) as Reply));
  if (m.type === 'LOCAL_STOP') return void (await core.stop(peer.profileId));
  if (m.connectionEpoch !== peer.epoch) throw Error('EPOCH_REJECTED');
  const winHandler = typeof m.type === 'string' ? winRpcHandlers[m.type] : undefined;
  if (winHandler) return winHandler(core, peer, m);
  switch (m.type) {
    case 'STOPPED':
    case 'RESUMED':
    case 'SYNC_STATE': {
      const rid =
        m.type === 'SYNC_STATE'
          ? z.string().parse(typeof m.requestId === 'string' ? m.requestId : randomUUID())
          : z.uuid().parse(m.requestId);
      if (m.type === 'STOPPED') {
        if (await core.stopped(peer, rid)) await kernel?.controlStopped(peer, rid);
      } else if (m.type === 'RESUMED') await core.resumed(peer, rid);
      else if (await core.synced(peer, rid, [])) await extensionIdle?.(peer);
      return;
    }
    case 'STOP_UNCONFIRMED':
    case 'SYNC_UNCONFIRMED':
      return void core.controlUnconfirmed(
        peer,
        z.uuid().parse(m.requestId),
        typeof m.error === 'string' && m.error ? m.error.slice(0, 120) : 'KERNEL_STOP_UNCONFIRMED',
      );
    case 'EXTENSION_RELOADING':
      return diagWs('EXTENSION_RELOADING', 'INFO', peer.profileId, undefined, {
        requestId: z.uuid().parse(m.requestId),
        epoch: peer.epoch,
      });
    case 'PONG': {
      if (m.windowCount !== undefined)
        peer.browserWindowCount = z.number().int().min(0).max(10000).parse(m.windowCount);
      if (
        typeof m.lastFocusedAt === 'number' &&
        Number.isFinite(m.lastFocusedAt) &&
        m.lastFocusedAt > 0
      )
        peer.focusedWindowAt = Math.max(peer.focusedWindowAt ?? 0, m.lastFocusedAt);
      if (
        peer.capabilities?.includes('profile-foreground-v1') &&
        m.profileWindowFocused !== undefined
      ) {
        peer.profileWindowFocused = z.boolean().parse(m.profileWindowFocused);
        if (peer.profileWindowFocused)
          peer.focusedWindowAt = Math.max(peer.focusedWindowAt ?? 0, Date.now());
      }
      onPong();
      return void (await extensionIdle?.(peer));
    }
    default:
      throw Error('MESSAGE_REJECTED');
  }
}
export async function rotatePeerSecret(
  store: BridgeStorePort,
  profileId: string,
  extensionId: string,
  expectedSecret: string,
): Promise<string> {
  const next = randomBytes(32).toString('hex');
  if (!(await store.replaceConnectionSecret(profileId, extensionId, expectedSecret, next)))
    throw Error('CONNECTION_RECOVERY_CHANGED');
  return next;
}
export function attachBridgeWsGateway({
  server,
  core,
  store,
  kernel,
  host,
  extensionIds,
  autoRecoverConnections,
  connectionRecoveryAllowed,
  extensionIdle,
  pendingRecovery,
  connectionFailures,
}: {
  server: http.Server;
  core: Core;
  store: BridgeStorePort;
  kernel: KernelBridgeHooks | undefined;
  host: string;
  extensionIds: readonly string[];
  autoRecoverConnections?: boolean;
  connectionRecoveryAllowed?: (profileId: string) => Awaitable<boolean>;
  extensionIdle?: (peer: Peer) => Awaitable<void>;
  pendingRecovery: Map<string, PendingRecoveryEntry>;
  connectionFailures: Map<string, ConnectionFailureEntry>;
}): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin ?? '';
    if (
      req.headers.host !== host ||
      req.url !== '/bridge' ||
      !extensionIds.some((id) => origin === 'chrome-extension://' + id)
    ) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return void socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const extensionId = (req.headers.origin ?? '').slice('chrome-extension://'.length),
      challenge = randomBytes(32).toString('hex');
    let peer: Peer | undefined,
      claimedProfileId: string | undefined,
      authenticationPending = false,
      recoveryId: string | undefined,
      lastPong = Date.now(),
      lastLivenessCheckAt = Date.now(),
      livenessPending = false;
    const liveness = setInterval(() => {
      const now = Date.now(),
        loopGapMs = now - lastLivenessCheckAt;
      lastLivenessCheckAt = now;
      if (loopGapMs > 1800 || !peer || now - lastPong <= LEASE_MS || livenessPending) return;
      livenessPending = true;
      setImmediate(() => {
        livenessPending = false;
        if (!peer || ws.readyState !== WebSocket.OPEN || Date.now() - lastPong <= LEASE_MS) return;
        peer.transportFailure = 'HEARTBEAT_TIMEOUT';
        diagWs('WS_HEARTBEAT_TIMEOUT', 'ERROR', peer.profileId, 'HEARTBEAT_TIMEOUT', {
          epoch: peer.epoch,
          silentMs: Date.now() - lastPong,
          leaseMs: LEASE_MS,
        });
        void Promise.resolve(kernel?.disconnected(peer)).catch(() => {});
        void core.disconnect(peer).catch(() => {});
        ws.terminate();
      });
    }, 1000);
    const authTimer = setTimeout(() => ws.close(1008, 'AUTH_TIMEOUT'), 5000);
    ws.on('error', (error) => {
      const code = 'code' in error ? String(error.code) : 'WS_SOCKET_ERROR';
      if (peer) peer.transportFailure = code;
      diagWs('WS_SOCKET_ERROR', 'WARN', peer?.profileId ?? claimedProfileId, code, {
        message: error.message.slice(0, 500),
      });
      ws.terminate();
    });
    ws.send(
      JSON.stringify({
        type: 'CHALLENGE',
        challenge,
        version: VERSION,
        capabilities: bridgeCapabilities,
      }),
    );
    ws.on('message', async (raw) => {
      try {
        const m = JSON.parse(raw.toString()) as Record<string, unknown>;
        observeBridgeIncomingMessage(raw, m, peer?.profileId ?? claimedProfileId);
        if (peer && m && typeof m === 'object' && typeof m.type === 'string') lastPong = Date.now();
        if (!peer) {
          if (authenticationPending) throw Error('AUTH_IN_PROGRESS');
          authenticationPending = true;
          const hello = HelloSchema.parse(m);
          if (
            new Set(hello.capabilities).size !== hello.capabilities.length ||
            !REQUIRED_CAPS.every((c) => hello.capabilities.includes(c))
          )
            throw Error('CAPABILITY_MISMATCH');
          const existing = await store.profile(hello.profileId);
          claimedProfileId = hello.profileId;
          let secret = existing?.secret,
            recovered = false;
          if (existing) {
            const expectedProof = createHmac('sha256', existing.secret)
              .update(challenge)
              .digest('hex');
            if (existing.extensionId !== extensionId) throw Error('AUTH_EXTENSION_MISMATCH');
            if (!hello.proof) throw Error('AUTH_PROOF_MISSING');
            if (!equalSecret(hello.proof, expectedProof)) {
              if (
                !/^[a-f0-9]{64}$/.test(hello.proof) ||
                pendingRecovery.size >= 32 ||
                core.peers.get(hello.profileId)?.online ||
                (await connectionRecoveryAllowed?.(hello.profileId)) !== true
              )
                throw Error('AUTH_PROOF_MISMATCH');
              if (autoRecoverConnections) {
                secret = await rotatePeerSecret(
                  store,
                  hello.profileId,
                  extensionId,
                  existing.secret,
                );
                recovered = true;
              } else {
                clearTimeout(authTimer);
                const id = (recoveryId = randomUUID());
                let timer: NodeJS.Timeout | undefined;
                try {
                  secret = await new Promise<string>((resolve, reject) => {
                    timer = setTimeout(() => reject(Error('CONNECTION_RECOVERY_EXPIRED')), 60_000);
                    pendingRecovery.set(id, {
                      id,
                      profileId: hello.profileId,
                      extensionId,
                      expected: existing.secret,
                      socket: ws,
                      expiresAt: Date.now() + 60_000,
                      busy: false,
                      resolve,
                      reject,
                    });
                  });
                  if (ws.readyState !== WebSocket.OPEN)
                    throw Error('CONNECTION_RECOVERY_DISCONNECTED');
                  recovered = true;
                } finally {
                  clearTimeout(timer);
                  pendingRecovery.delete(id);
                  recoveryId = undefined;
                }
              }
            }
          } else secret = randomBytes(32).toString('hex');
          if (!secret) throw Error('AUTH_SECRET_MISSING');
          if (!existing) await store.pair(hello.profileId, secret, extensionId);
          if (ws.readyState !== WebSocket.OPEN) throw Error('AUTH_DISCONNECTED');
          peer = core.connect(
            hello.profileId,
            (msg) => ws.send(JSON.stringify(msg)),
            () => ws.close(),
          );
          peer.extensionVersion = hello.extensionVersion;
          peer.capabilities = hello.capabilities;
          clearTimeout(authTimer);
          lastPong = Date.now();
          diagWs('WS_CONNECTED', 'INFO', peer.profileId, undefined, {
            epoch: peer.epoch,
            extensionVersion: peer.extensionVersion,
            recovered,
            firstPair: !existing,
          });
          ws.send(
            JSON.stringify({
              type: 'WELCOME',
              connectionEpoch: peer.epoch,
              secret: existing && !recovered ? undefined : secret,
              leaseMs: LEASE_MS,
              paused: true,
            }),
          );
          return;
        }
        if (await kernel?.message(peer, m)) return void (lastPong = Date.now());
        await handleAuthedWsMessage(core, kernel, extensionIdle, peer, m, () => {
          lastPong = Date.now();
        });
      } catch (error) {
        const profileId = peer?.profileId ?? claimedProfileId ?? null;
        diagWs(
          'WS_PROTOCOL_REJECTED',
          'WARN',
          profileId ?? undefined,
          recordWsFailure(connectionFailures, profileId, error),
        );
        ws.close(1008, 'AUTH_OR_PROTOCOL_REJECTED');
      }
    });
    ws.on('close', async (code) => {
      if (recoveryId)
        pendingRecovery.get(recoveryId)?.reject(Error('CONNECTION_RECOVERY_DISCONNECTED'));
      clearTimeout(authTimer);
      clearInterval(liveness);
      if (peer) {
        peer.transportFailure ??= 'SOCKET_CLOSED_' + code;
        diagWs('WS_DISCONNECTED', 'WARN', peer.profileId, peer.transportFailure, {
          epoch: peer.epoch,
          closeCode: code,
        });
        await kernel?.disconnected(peer);
        await core.disconnect(peer);
      }
    });
  });
  return wss;
}
