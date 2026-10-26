import { flatMapAsync, mapAsync } from '../shared/async-collections.js';
import http from 'node:http';
import { readFile, mkdir, access } from 'node:fs/promises';
import { DatabaseSync, backup as backupDatabase } from 'node:sqlite';
import path from 'node:path';
import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { bridgeCapabilities } from '../shared/bridge-capabilities.js';
import { Core, type Peer } from './core.js';
import { devDiag } from '../shared/dev-diagnostics.js';
export interface KernelBridgeHooks {
  message(peer: Peer, value: unknown): Awaitable<boolean>;
  disconnected(peer: Peer): Awaitable<void>;
  controlStopped(peer: Peer): Awaitable<void>;
  tick(): Awaitable<void>;
  close(): Promise<void>;
}
import { Store } from './store.js';
import type { BridgeStorePort } from '../infrastructure/persistence-port.js';
import type { Awaitable } from '../domain/persistence.js';
import { WatchTasks } from './watch.js';
import {
  ORIGIN as DEFAULT_ORIGIN,
  LEASE_MS,
  VERSION,
  Intent,
  JournalEntry,
  Review,
  isWrite,
  type Reply,
} from './protocol.js';
export interface BridgeServerOptions {
  extensionIdle?: (peer: Peer) => Awaitable<void>;
  connectionRecoveryAllowed?: (profileId: string) => Awaitable<boolean>;
  store?: BridgeStorePort;
  autoRecoverConnections?: boolean;
  dataDir: string;
  port: number;
  root: string;
  extensionIds: string[];
  diagnosticsEnabled?: boolean;
  kernelHooks?: (context: {
    core: Core;
    store: BridgeStorePort;
    tasks: WatchTasks;
  }) => KernelBridgeHooks;
  boundServer?: { server: http.Server; bootstrapHandler: http.RequestListener };
  appRoutes?: (context: {
    core: Core;
    store: BridgeStorePort;
    tasks: WatchTasks;
  }) => (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    input?: unknown,
  ) => Promise<boolean>;
}
export async function startBridgeServer(options: BridgeServerOptions) {
  const root = options.root;
  const data = options.dataDir;
  await mkdir(data, { recursive: true });
  const databasePath = path.join(data, 'journal.sqlite');
  let existingDatabase = false;
  try {
    await access(databasePath);
    existingDatabase = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existingDatabase && !options.store) {
    const previous = new DatabaseSync(databasePath, { readOnly: true });
    try {
      if ((previous.prepare('PRAGMA user_version').get() as any).user_version < 2)
        await backupDatabase(previous, path.join(data, 'before-v2-' + Date.now() + '.sqlite'));
    } finally {
      previous.close();
    }
  }
  const store = options.store ?? new Store(databasePath);
  const core = new Core(store);
  const tasks = new WatchTasks(core);
  const admin = randomBytes(32).toString('hex');
  const port = options.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT_CONFIG_REJECTED');
  const ORIGIN = port === 18767 ? DEFAULT_ORIGIN : 'http://127.0.0.1:' + port;
  const HOST = '127.0.0.1:' + port;
  // This ID was observed from the new extension already installed in Chrome 004.
  // Browser-origin allowlisting is the bootstrap boundary, not authentication of other OS processes.
  const extensionIds = options.extensionIds;
  if (!extensionIds.length || extensionIds.some((id) => !/^[a-p]{32}$/.test(id)))
    throw Error('INVALID_EXTENSION_ID_CONFIG');
  const kernel = options.kernelHooks?.({ core, store, tasks });
  const appHandler = options.appRoutes?.({ core, store, tasks });
  const connectionFailures = new Map<
    string,
    { profileId: string | null; code: string; fields: string[]; at: number; count: number }
  >();
  const pendingRecovery = new Map<
    string,
    {
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
  >();
  function equalSecret(a: string, b: string) {
    const x = Buffer.from(a),
      y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  }
  async function body(req: http.IncomingMessage, limit = 131072) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const part of req) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      bytes += chunk.length;
      if (bytes > limit) throw Error('BODY_TOO_LARGE');
      chunks.push(chunk);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  }
  function json(res: http.ServerResponse, code: number, value: unknown) {
    res.writeHead(code, {
      'Content-Type': 'application/json;charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(value));
  }
  function authenticated(req: http.IncomingMessage) {
    return (req.headers.cookie ?? '').split(';').some((c) => c.trim() === 'bridgeAdmin=' + admin);
  }
  async function state() {
    return {
      version: VERSION,
      connection: { mode: 'automatic-local-port', port },
      profiles: await mapAsync(await store.profileList(), async (p: any) => ({
        ...p,
        online: core.peers.get(p.profileId)?.online ?? false,
        paused: core.peers.get(p.profileId)?.paused ?? true,
        phase: core.peers.get(p.profileId)?.phase ?? 'OFFLINE',
        synced: core.peers.get(p.profileId)?.synced ?? false,
        error: core.peers.get(p.profileId)?.error,
        unresolved: (await store.unresolved(p.profileId)).length,
        extensionVersion: core.peers.get(p.profileId)?.extensionVersion,
        capabilities: core.peers.get(p.profileId)?.capabilities,
      })),
      operations: (await store.list()).map((r) => ({
        ...r,
        result: r.result ? JSON.parse(r.result) : null,
      })),
      tasks: (await store.tasks()).map((r: any) => ({
        ...r,
        spec: JSON.parse(r.spec),
        evidence: r.evidence ? JSON.parse(r.evidence) : null,
      })),
      unresolved: await mapAsync(
        await flatMapAsync(
          await store.profileList(),
          async (p: any) => await store.unresolved(p.profileId),
        ),
        (r) => ({ ...r, result: r.result ? JSON.parse(r.result) : null }),
      ),
    };
  }
  const server = options.boundServer?.server ?? http.createServer();
  if (options.boundServer) server.removeListener('request', options.boundServer.bootstrapHandler);
  server.on('request', async (req, res) => {
    try {
      if (![HOST, 'localhost:' + port].includes(req.headers.host ?? ''))
        return json(res, 403, { error: 'HOST_REJECTED' });
      const u = new URL(req.url ?? '/', ORIGIN);
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob: https://*.fbcdn.net; media-src 'self' blob:; frame-src 'self' http://localhost:18767; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/workbench/')) {
        res.setHeader('Set-Cookie', `bridgeAdmin=${admin}; HttpOnly; SameSite=Strict; Path=/`);
        res.setHeader('Content-Type', 'text/html;charset=utf-8');
        return res.end(await readFile(path.join(root, 'web/index.html')));
      }
      if (req.method === 'GET' && /^\/workbench\/assets\/[A-Za-z0-9_.-]+$/.test(u.pathname)) {
        const file = path.join(root, 'web/assets', path.basename(u.pathname));
        res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript');
        return res.end(await readFile(file));
      }
      if (req.method === 'GET' && u.pathname === '/app-icon.svg') {
        res.setHeader('Content-Type', 'image/svg+xml');
        return res.end(await readFile(path.join(root, 'public/app-icon.svg')));
      }
      if (options.diagnosticsEnabled && req.method === 'GET' && u.pathname === '/sample.mp4') {
        const bytes = await readFile(path.join(root, 'public/sample.mp4'));
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');
        const range = req.headers.range;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          let start = Number(match?.[1] ?? 0),
            end = match?.[2] ? Number(match[2]) : bytes.length - 1;
          if (match && !match[1] && match[2]) {
            start = Math.max(0, bytes.length - Number(match[2]));
            end = bytes.length - 1;
          }
          if (
            !match ||
            (!match[1] && !match[2]) ||
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            start >= bytes.length ||
            end < start
          ) {
            res.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` });
            return res.end();
          }
          end = Math.min(end, bytes.length - 1);
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
            'Content-Length': end - start + 1,
          });
          return res.end(bytes.subarray(start, end + 1));
        }
        res.setHeader('Content-Length', bytes.length);
        return res.end(bytes);
      }
      const publicFiles: Record<string, string> = {
        '/dashboard.js': 'dashboard.js',
        '/style.css': 'style.css',
        '/fixture': 'fixture.html',
        '/fixture.js': 'fixture.js',
        '/frame': 'frame.html',
        '/kernel-fixture': 'kernel-fixture.html',
        '/kernel-fixture.js': 'kernel-fixture.js',
        '/kernel-frame': 'kernel-frame.html',
        '/kernel-frame.js': 'kernel-frame.js',
      };
      const identificationFiles: Record<string, string> = {
        '/browser-identify.js': 'browser-identify.js',
        '/browser-identify.css': 'browser-identify.css',
      };
      const identificationFile =
        u.pathname === '/fixture' && u.searchParams.get('identify') === '1'
          ? 'browser-identify.html'
          : identificationFiles[u.pathname];
      if (req.method === 'GET' && identificationFile) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader(
          'Content-Type',
          identificationFile.endsWith('.js')
            ? 'text/javascript'
            : identificationFile.endsWith('.css')
              ? 'text/css'
              : 'text/html;charset=utf-8',
        );
        return res.end(await readFile(path.join(root, 'public', identificationFile)));
      }
      if (options.diagnosticsEnabled && req.method === 'GET' && publicFiles[u.pathname]) {
        if (u.pathname === '/frame' || u.pathname === '/kernel-frame')
          res.setHeader(
            'Content-Security-Policy',
            "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors http://127.0.0.1:18767 http://localhost:18767",
          );
        res.setHeader(
          'Content-Type',
          u.pathname.endsWith('.js')
            ? 'text/javascript'
            : u.pathname.endsWith('.css')
              ? 'text/css'
              : 'text/html;charset=utf-8',
        );
        return res.end(await readFile(path.join(root, 'public', publicFiles[u.pathname]!)));
      }
      if (req.headers.host !== HOST || !authenticated(req))
        return json(res, 401, { error: 'ADMIN_REQUIRED' });
      if (req.method === 'GET' && u.pathname === '/api/bridge-connection-health')
        return json(res, 200, {
          failures: [...connectionFailures.values()],
          pending: [...pendingRecovery.values()].map(({ id, profileId, expiresAt }) => ({
            id,
            profileId,
            expiresAt,
          })),
        });
      if (req.method === 'GET' && appHandler && (await appHandler(req, res, u.pathname))) return;
      if (options.diagnosticsEnabled && req.method === 'GET' && u.pathname === '/api/state')
        return json(res, 200, await state());
      if (req.method === 'POST') {
        if (req.headers.origin !== ORIGIN || req.headers['content-type'] !== 'application/json')
          return json(res, 403, { error: 'ORIGIN_REJECTED' });
        const input = await body(
          req,
          u.pathname === '/api/workspace/resource-tables/save' ? 4 * 1024 * 1024 : 131072,
        );
        if (u.pathname === '/api/bridge-connections/recover') {
          const request = z.object({ id: z.uuid(), profileId: z.uuid() }).strict().parse(input);
          const pending = pendingRecovery.get(request.id);
          const allowed = async () =>
            pending &&
            pending.profileId === request.profileId &&
            !core.peers.get(pending.profileId)?.online &&
            (await options.connectionRecoveryAllowed?.(pending.profileId)) === true &&
            pending.socket.readyState === WebSocket.OPEN &&
            Date.now() < pending.expiresAt;
          if (!pending || pending.busy || !(await allowed()))
            return json(res, 409, { error: 'CONNECTION_RECOVERY_REVOKED' });
          pending.busy = true;
          try {
            await store.backup(
              path.join(data, 'journal.before-connection-recovery-' + pending.id + '.sqlite'),
            );
            if (!(await allowed())) throw Error('CONNECTION_RECOVERY_REVOKED');
            const next = randomBytes(32).toString('hex');
            if (
              !(await store.replaceConnectionSecret(
                pending.profileId,
                pending.extensionId,
                pending.expected,
                next,
              ))
            )
              throw Error('CONNECTION_RECOVERY_CHANGED');
            pending.resolve(next);
            return json(res, 200, { requested: true, profileId: pending.profileId });
          } catch (error) {
            pending.reject(Error('CONNECTION_RECOVERY_FAILED'));
            throw error;
          }
        }
        if (appHandler && (await appHandler(req, res, u.pathname, input))) return;
        if (!options.diagnosticsEnabled) return json(res, 404, { error: 'NOT_FOUND' });
        if (u.pathname === '/api/command') {
          const intent = Intent.parse(input);
          if (
            tasks.busy(intent.profileId) &&
            isWrite(intent.action) &&
            intent.action.kind !== 'windowState'
          )
            throw Error('PROFILE_TASK_BUSY');
          return json(res, 202, await core.submit(intent));
        }
        if (u.pathname === '/api/watch') return json(res, 202, await tasks.start(input));
        if (u.pathname === '/api/review') {
          const review = Review.parse(input);
          await core.review(review.profileId, review.commandId, review.decision, review.note);
          return json(res, 200, { reviewed: true });
        }
        if (u.pathname === '/api/backup') {
          const file = 'snapshot-' + Date.now() + '.sqlite';
          await store.backup(path.join(data, file));
          return json(res, 200, { file });
        }
        const profileId = z.string().uuid().parse(input.profileId);
        if (u.pathname === '/api/authorize-facebook') {
          if (input.confirm !== 'AUTHORIZE_OWN_TASK_VIDEO_TABS') throw Error('CONSENT_REQUIRED');
          if (!(await store.profile(profileId))) throw Error('PROFILE_NOT_FOUND');
          await store.allowFacebook(profileId);
          return json(res, 200, { authorized: true });
        }
        if (u.pathname === '/api/sync') {
          const peer = core.peers.get(profileId);
          if (!peer) throw Error('OFFLINE');
          tasks.stop(profileId);
          return json(res, 200, await core.sync(peer));
        }
        if (u.pathname === '/api/retire-legacy-fixture') {
          const rows = (await store.unresolved(profileId)).filter((r) => r.legacyFixture === 1);
          for (const row of rows)
            await core.review(
              profileId,
              row.commandId,
              'ABANDON',
              '结束旧版本机测试，不重放、不宣称成功',
            );
          return json(res, 200, { abandoned: rows.length });
        }
        if (u.pathname === '/api/resume') {
          return json(res, 200, await core.resume(profileId));
        }
        if (u.pathname === '/api/stop') {
          tasks.stop(profileId);
          return json(res, 200, await core.stop(profileId));
        }
      }
      json(res, 404, { error: 'NOT_FOUND' });
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : 'ERROR' });
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin ?? '';
    if (
      req.headers.host !== HOST ||
      req.url !== '/bridge' ||
      !extensionIds.some((id) => origin === 'chrome-extension://' + id)
    ) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const extensionId = req.headers.origin!.slice('chrome-extension://'.length);
    const challenge = randomBytes(32).toString('hex');
    let peer: Peer | undefined;
    let claimedProfileId: string | undefined;
    let authenticationPending = false;
    let recoveryId: string | undefined;
    let lastPong = Date.now();
    let lastLivenessCheckAt = Date.now(),
      livenessPending = false;
    const liveness = setInterval(() => {
      const now = Date.now(),
        loopGapMs = now - lastLivenessCheckAt;
      lastLivenessCheckAt = now;
      if (loopGapMs > 1800) return;
      if (!peer || now - lastPong <= LEASE_MS || livenessPending) return;
      livenessPending = true;
      setImmediate(() => {
        livenessPending = false;
        if (!peer || ws.readyState !== WebSocket.OPEN || Date.now() - lastPong <= LEASE_MS) return;
        const silentMs = Date.now() - lastPong;
        peer.transportFailure = 'HEARTBEAT_TIMEOUT';
        devDiag.record({
          level: 'ERROR',
          category: 'BRIDGE_WS',
          event: 'WS_HEARTBEAT_TIMEOUT',
          profileId: peer.profileId,
          reason: 'HEARTBEAT_TIMEOUT',
          data: { epoch: peer.epoch, silentMs, leaseMs: LEASE_MS },
        });
        void core.disconnect(peer).catch(() => {});
        ws.terminate();
      });
    }, 1000);
    const authTimer = setTimeout(() => ws.close(1008, 'AUTH_TIMEOUT'), 5000);
    ws.on('error', (error) => {
      const code = 'code' in error ? String(error.code) : 'WS_SOCKET_ERROR';
      if (peer) peer.transportFailure = code;
      devDiag.record({
        level: 'WARN',
        category: 'BRIDGE_WS',
        event: 'WS_SOCKET_ERROR',
        profileId: peer?.profileId ?? claimedProfileId,
        reason: code,
        data: { message: error.message.slice(0, 500) },
      });
      // A broken/oversized frame ends this transport only. The existing close
      // handler releases its timers, lease and kernel connection.
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
        const m = JSON.parse(raw.toString());
        if (peer && m && typeof m === 'object' && typeof m.type === 'string') lastPong = Date.now();
        if (!peer) {
          if (authenticationPending) throw Error('AUTH_IN_PROGRESS');
          authenticationPending = true;
          const hello = z
            .object({
              type: z.literal('HELLO'),
              version: z.literal(VERSION),
              extensionVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
              capabilities: z
                .array(z.enum(bridgeCapabilities))
                .min(4)
                .max(bridgeCapabilities.length),
              profileId: z.string().uuid(),
              pairingCode: z.string().optional(),
              proof: z.string().optional(),
            })
            .strict()
            .parse(m);
          if (
            new Set(hello.capabilities).size !== hello.capabilities.length ||
            ![
              'operation-journal-v2',
              'stop-confirmation',
              'media-observation',
              'media-node-identity',
            ].every((c) => hello.capabilities.includes(c as (typeof hello.capabilities)[number]))
          )
            throw Error('CAPABILITY_MISMATCH');
          const existing = await store.profile(hello.profileId);
          claimedProfileId = hello.profileId;
          let secret = existing?.secret;
          let recovered = false;
          if (existing) {
            const proof = createHmac('sha256', existing.secret).update(challenge).digest('hex');
            if (existing.extensionId !== extensionId) throw Error('AUTH_EXTENSION_MISMATCH');
            if (!hello.proof) throw Error('AUTH_PROOF_MISSING');
            if (!equalSecret(hello.proof, proof)) {
              if (
                !/^[a-f0-9]{64}$/.test(hello.proof) ||
                pendingRecovery.size >= 32 ||
                core.peers.get(hello.profileId)?.online ||
                (await options.connectionRecoveryAllowed?.(hello.profileId)) !== true
              )
                throw Error('AUTH_PROOF_MISMATCH');
              if (options.autoRecoverConnections) {
                const next = randomBytes(32).toString('hex');
                if (
                  !(await store.replaceConnectionSecret(
                    hello.profileId,
                    extensionId,
                    existing.secret,
                    next,
                  ))
                )
                  throw Error('CONNECTION_RECOVERY_CHANGED');
                secret = next;
                recovered = true;
              } else {
                clearTimeout(authTimer);
                recoveryId = randomUUID();
                const id = recoveryId;
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
          } else {
            // Only the configured extension origin can reach this bootstrap path.
            // Existing identities still require challenge/HMAC proof on every reconnect.
            secret = randomBytes(32).toString('hex');
          }
          if (!existing) await store.pair(hello.profileId, secret!, extensionId);
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
          devDiag.record({
            level: 'INFO',
            category: 'BRIDGE_WS',
            event: 'WS_CONNECTED',
            profileId: peer.profileId,
            data: {
              epoch: peer.epoch,
              extensionVersion: peer.extensionVersion,
              recovered,
              firstPair: !existing,
            },
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
          await core.sync(peer);
          return;
        }
        if (await kernel?.message(peer, m)) {
          lastPong = Date.now();
          return;
        }
        if (m.type === 'RESULT') {
          const result = z
            .object({
              type: z.literal('RESULT'),
              commandId: z.string().uuid(),
              status: z.enum(['ACKNOWLEDGED', 'VERIFIED', 'FAILED', 'UNKNOWN']),
              evidence: z.unknown().optional(),
              error: z.string().optional(),
            })
            .strict()
            .parse(m);
          await core.reply(peer, result as Reply);
        } else if (m.type === 'LOCAL_STOP') {
          await core.stop(peer.profileId);
        } else if (['STOPPED', 'RESUMED', 'SYNC_STATE'].includes(m.type)) {
          if (m.connectionEpoch !== peer.epoch) throw Error('EPOCH_REJECTED');
          const requestId = z.string().uuid().parse(m.requestId);
          if (m.type === 'STOPPED') {
            if (await core.stopped(peer, requestId)) {
              await kernel?.controlStopped(peer);
              // A parent stop may interrupt SYNC or follow a control timeout. Retire
              // the old SDK owner first, then reconcile; STOPPED alone grants no input.
              if (!peer.synced) await core.sync(peer);
            }
          } else if (m.type === 'RESUMED') await core.resumed(peer, requestId);
          else {
            const synced = await core.synced(
              peer,
              requestId,
              z.array(JournalEntry).max(500).parse(m.entries),
            );
            if (synced) await options.extensionIdle?.(peer);
          }
        } else if (m.type === 'EXTENSION_RELOADING') {
          if (m.connectionEpoch !== peer.epoch) throw Error('EPOCH_REJECTED');
          const requestId = z.string().uuid().parse(m.requestId);
          devDiag.record({
            level: 'INFO',
            category: 'BRIDGE_WS',
            event: 'EXTENSION_RELOADING',
            profileId: peer.profileId,
            data: { requestId, epoch: peer.epoch },
          });
        } else if (m.type === 'PONG') {
          if (m.connectionEpoch !== peer.epoch) throw Error('EPOCH_REJECTED');
          if (m.windowCount !== undefined)
            peer.browserWindowCount = z.number().int().min(0).max(10000).parse(m.windowCount);
          if (
            peer.capabilities?.includes('profile-foreground-v1') &&
            m.profileWindowFocused !== undefined
          ) {
            peer.profileWindowFocused = z.boolean().parse(m.profileWindowFocused);
            peer.focusedWindowAt = Date.now();
          }
          lastPong = Date.now();
          await options.extensionIdle?.(peer);
        } else throw Error('MESSAGE_REJECTED');
      } catch (error) {
        const profileId = peer?.profileId ?? claimedProfileId ?? null;
        const key = profileId ?? 'unidentified';
        const code =
          error instanceof z.ZodError
            ? 'SCHEMA_REJECTED'
            : error instanceof Error &&
                [
                  'AUTH_FAILED',
                  'AUTH_EXTENSION_MISMATCH',
                  'AUTH_PROOF_MISSING',
                  'AUTH_PROOF_MISMATCH',
                  'CAPABILITY_MISMATCH',
                  'DUPLICATE_PROFILE',
                  'EPOCH_REJECTED',
                  'MESSAGE_REJECTED',
                ].includes(error.message)
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
            error instanceof z.ZodError
              ? error.issues.map((issue) => issue.path.join('.')).slice(0, 8)
              : [],
          at: Date.now(),
          count: (previous?.count ?? 0) + 1,
        });
        devDiag.record({
          level: 'WARN',
          category: 'BRIDGE_WS',
          event: 'WS_PROTOCOL_REJECTED',
          profileId: profileId ?? undefined,
          reason: code,
        });
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
        devDiag.record({
          level: 'WARN',
          category: 'BRIDGE_WS',
          event: 'WS_DISCONNECTED',
          profileId: peer.profileId,
          reason: peer.transportFailure,
          data: { epoch: peer.epoch, closeCode: code },
        });
        await kernel?.disconnected(peer);
        await core.disconnect(peer);
      }
    });
  });
  let tickInFlight = false;
  const heartbeat = setInterval(() => {
    for (const p of core.peers.values())
      if (p.online)
        try {
          p.send({ type: 'HEARTBEAT', connectionEpoch: p.epoch, leaseMs: LEASE_MS });
        } catch {
          void core.disconnect(p).catch(() => {});
        }
    if (!tickInFlight) {
      tickInFlight = true;
      void Promise.resolve()
        .then(() => kernel?.tick())
        .catch((error: unknown) => {
          devDiag.record({
            level: 'WARN',
            category: 'BRIDGE_WS',
            event: 'KERNEL_TICK_ERROR',
            reason: error instanceof Error ? error.message.slice(0, 200) : 'KERNEL_TICK_ERROR',
          });
        })
        .finally(() => {
          tickInFlight = false;
        });
    }
  }, 1500);
  try {
    if (!server.listening)
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
  } catch (error) {
    clearInterval(heartbeat);
    await core.shutdown();
    if (!options.store) await store.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      await kernel?.close();
      clearInterval(heartbeat);
      tasks.shutdown();
      await core.shutdown();
      await new Promise<void>((resolve, reject) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (!options.store) await store.close();
    })();
    return closing;
  }
  return { core, store, tasks, kernel, origin: ORIGIN, close };
}
