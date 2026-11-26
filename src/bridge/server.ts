import { flatMapAsync, mapAsync } from '../shared/async-collections.js';
import http from 'node:http';
import { mkdir, access, readFile } from 'node:fs/promises';
import { DatabaseSync, backup as backupDatabase } from 'node:sqlite';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { Core, type Peer } from './core.js';
import { devDiag } from '../shared/dev-diagnostics.js';
import { Store } from './store.js';
import type { BridgeStorePort } from '../infrastructure/persistence-port.js';
import type { Awaitable } from '../domain/persistence.js';
import { ORIGIN as DEFAULT_ORIGIN, Intent, LEASE_MS, Review, VERSION } from './protocol.js';
import {
  attachBridgeWsGateway,
  observeBridgeIncomingMessage,
  rotatePeerSecret,
  type ConnectionFailureEntry,
  type KernelBridgeHooks,
  type PendingRecoveryEntry,
} from './ws-peer-gateway.js';
export type { KernelBridgeHooks };
export { observeBridgeIncomingMessage };
const jsonResponse = (res: http.ServerResponse, code: number, value: unknown): void => {
  res.writeHead(code, {
    'Content-Type': 'application/json;charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
};
async function readJsonBody(req: http.IncomingMessage, limit = 131072): Promise<unknown> {
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
const PUBLIC_FILES: Record<string, string> = {
  '/dashboard.js': 'dashboard.js',
  '/style.css': 'style.css',
  '/kernel-fixture': 'kernel-fixture.html',
  '/kernel-fixture.js': 'kernel-fixture.js',
  '/kernel-frame': 'kernel-frame.html',
  '/kernel-frame.js': 'kernel-frame.js',
};
const IDENTIFICATION_FILES: Record<string, string> = {
  '/browser-identify.js': 'browser-identify.js',
  '/browser-identify.css': 'browser-identify.css',
};
const contentTypeFor = (file: string) =>
  file.endsWith('.js')
    ? 'text/javascript'
    : file.endsWith('.css')
      ? 'text/css'
      : 'text/html;charset=utf-8';
const BODY_1M = new Set([
  '/api/workspace/profiles/reorder',
  '/api/workspace/group-bumper/groups/add',
  '/api/workspace/group-bumper/pages/add',
  '/api/workspace/group-bumper/comments',
  '/api/workspace/group-bumper/page-comments',
  '/api/workspace/group-poster/groups/add',
  '/api/workspace/group-inviter/groups/add',
]);
function selectPostBodyLimit(pathname: string): number {
  if (
    pathname === '/api/workspace/resource-tables/save' ||
    pathname === '/api/workspace/group-poster/materials/save'
  )
    return 4 * 1024 * 1024;
  if (BODY_1M.has(pathname)) return 1024 * 1024;
  if (pathname === '/api/workspace/google-sheets/auth/credentials') return 512 * 1024;
  if (pathname === '/api/workspace/group-poster/materials/thumbnail') return 256 * 1024;
  return 131072;
}
async function serveRangeSampleMp4(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  root: string,
) {
  const bytes = await readFile(path.join(root, 'public/sample.mp4'));
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Length', bytes.length);
    return res.end(bytes);
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  const start = m && !m[1] && m[2] ? Math.max(0, bytes.length - Number(m[2])) : Number(m?.[1] ?? 0);
  let end = m && !m[1] && m[2] ? bytes.length - 1 : m?.[2] ? Number(m[2]) : bytes.length - 1;
  if (
    !m ||
    (!m[1] && !m[2]) ||
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
interface BridgeServerOptions {
  extensionIdle?: (peer: Peer) => Awaitable<void>;
  connectionRecoveryAllowed?: (profileId: string) => Awaitable<boolean>;
  store?: BridgeStorePort;
  autoRecoverConnections?: boolean;
  dataDir: string;
  port: number;
  root: string;
  extensionIds: string[];
  diagnosticsEnabled?: boolean;
  kernelHooks?: (context: { core: Core; store: BridgeStorePort }) => KernelBridgeHooks;
  boundServer?: { server: http.Server; bootstrapHandler: http.RequestListener };
  mcpHandler?: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
  onClose?: () => Awaitable<void>;
  appRoutes?: (context: {
    core: Core;
    store: BridgeStorePort;
  }) => (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    input?: unknown,
  ) => Promise<boolean>;
}
export async function startBridgeServer(options: BridgeServerOptions) {
  const { root, dataDir: data, port, extensionIds } = options;
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
    const prev = new DatabaseSync(databasePath, { readOnly: true });
    try {
      prev.exec('PRAGMA busy_timeout = 5000');
      const ver = prev.prepare('PRAGMA user_version').get() as
        { user_version?: number } | undefined;
      if (Number(ver?.user_version ?? 0) < 3)
        await backupDatabase(prev, path.join(data, 'before-v3-' + Date.now() + '.sqlite'));
    } finally {
      prev.close();
    }
  }
  const store = options.store ?? new Store(databasePath),
    core = new Core(store);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT_CONFIG_REJECTED');
  const ORIGIN = port === 18767 ? DEFAULT_ORIGIN : 'http://127.0.0.1:' + port,
    HOST = '127.0.0.1:' + port;
  if (!extensionIds.length || extensionIds.some((id) => !/^[a-p]{32}$/.test(id)))
    throw Error('INVALID_EXTENSION_ID_CONFIG');
  const kernel = options.kernelHooks?.({ core, store }),
    appHandler = options.appRoutes?.({ core, store }),
    connectionFailures = new Map<string, ConnectionFailureEntry>(),
    pendingRecovery = new Map<string, PendingRecoveryEntry>(),
    server = options.boundServer?.server ?? http.createServer();
  if (options.boundServer) server.removeListener('request', options.boundServer.bootstrapHandler);
  const admin = randomBytes(32).toString('hex');
  const adminCookie = port === 18767 ? 'bridgeAdmin' : `bridgeAdmin_${port}`;
  const authenticated = (req: http.IncomingMessage) =>
    (req.headers.cookie ?? '').split(';').some((c) => c.trim() === `${adminCookie}=${admin}`);
  const parseOp = (r: { result: string | null }) => ({
    ...r,
    result: r.result ? JSON.parse(r.result) : null,
  });
  const buildDiagnosticState = async () => {
    const profileRows = await store.profileList();
    return {
      version: VERSION,
      connection: { mode: 'automatic-local-port', port },
      profiles: await mapAsync(profileRows, async (rawProfile) => {
        const p = rawProfile as { profileId: string } & Record<string, unknown>,
          peer = core.peers.get(p.profileId);
        return {
          ...p,
          online: peer?.online ?? false,
          paused: peer?.paused ?? true,
          phase: peer?.phase ?? 'OFFLINE',
          synced: peer?.synced ?? false,
          error: peer?.error,
          unresolved: (await store.unresolved(p.profileId)).length,
          extensionVersion: peer?.extensionVersion,
          capabilities: peer?.capabilities,
        };
      }),
      operations: (await store.list()).map(parseOp),
      unresolved: (
        await flatMapAsync(
          profileRows,
          async (r) => await store.unresolved((r as { profileId: string }).profileId),
        )
      ).map(parseOp),
    };
  };
  server.on('request', async (req, res) => {
    const sendFile = async (filePath: string, contentType: string) => {
      res.setHeader('Content-Type', contentType);
      return res.end(await readFile(filePath));
    };
    try {
      if (![HOST, 'localhost:' + port].includes(req.headers.host ?? ''))
        return jsonResponse(res, 403, { error: 'HOST_REJECTED' });
      const u = new URL(req.url ?? '/', ORIGIN);
      if (u.pathname === '/mcp' && options.mcpHandler && (await options.mcpHandler(req, res)))
        return;
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob: https://*.fbcdn.net https://*.fbsbx.com https://i.gyazo.com https://*.gyazo.com https://*.googleusercontent.com https://drive.google.com; media-src 'self' blob:; frame-src 'self' http://localhost:18767; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
      if (req.method === 'GET') {
        if (u.pathname === '/' || u.pathname === '/workbench/') {
          res.setHeader('Set-Cookie', `${adminCookie}=${admin}; HttpOnly; SameSite=Strict; Path=/`);
          return await sendFile(path.join(root, 'web/index.html'), 'text/html;charset=utf-8');
        }
        if (/^\/workbench\/assets\/[A-Za-z0-9_.-]+$/.test(u.pathname)) {
          const file = path.join(root, 'web/assets', path.basename(u.pathname));
          return await sendFile(file, file.endsWith('.css') ? 'text/css' : 'text/javascript');
        }
        if (u.pathname === '/app-icon.svg')
          return await sendFile(path.join(root, 'public/app-icon.svg'), 'image/svg+xml');
        if (options.diagnosticsEnabled && u.pathname === '/sample.mp4')
          return await serveRangeSampleMp4(req, res, root);
        const idFile =
          u.pathname === '/fixture' && u.searchParams.get('identify') === '1'
            ? 'browser-identify.html'
            : IDENTIFICATION_FILES[u.pathname];
        if (idFile) {
          res.setHeader('Cache-Control', 'no-store');
          return await sendFile(path.join(root, 'public', idFile), contentTypeFor(idFile));
        }
        const pubFile = PUBLIC_FILES[u.pathname];
        if (options.diagnosticsEnabled && pubFile) {
          if (u.pathname === '/frame' || u.pathname === '/kernel-frame')
            res.setHeader(
              'Content-Security-Policy',
              "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors http://127.0.0.1:18767 http://localhost:18767",
            );
          return await sendFile(path.join(root, 'public', pubFile), contentTypeFor(u.pathname));
        }
      }
      if (req.headers.host !== HOST || !authenticated(req))
        return jsonResponse(res, 401, { error: 'ADMIN_REQUIRED' });
      if (req.method === 'GET') {
        if (u.pathname === '/api/bridge-connection-health')
          return jsonResponse(res, 200, {
            failures: [...connectionFailures.values()],
            pending: [...pendingRecovery.values()].map(({ id, profileId, expiresAt }) => ({
              id,
              profileId,
              expiresAt,
            })),
          });
        if (appHandler && (await appHandler(req, res, u.pathname))) return;
        if (options.diagnosticsEnabled && u.pathname === '/api/state')
          return jsonResponse(res, 200, await buildDiagnosticState());
      }
      if (req.method === 'POST') {
        if (req.headers.origin !== ORIGIN || req.headers['content-type'] !== 'application/json')
          return jsonResponse(res, 403, { error: 'ORIGIN_REJECTED' });
        const input = await readJsonBody(req, selectPostBodyLimit(u.pathname));
        if (u.pathname === '/api/bridge-connections/recover') {
          const request = z.object({ id: z.uuid(), profileId: z.uuid() }).strict().parse(input),
            pending = pendingRecovery.get(request.id),
            allowed = async () =>
              pending &&
              pending.profileId === request.profileId &&
              !core.peers.get(pending.profileId)?.online &&
              (await options.connectionRecoveryAllowed?.(pending.profileId)) === true &&
              pending.socket.readyState === WebSocket.OPEN &&
              Date.now() < pending.expiresAt;
          if (!pending || pending.busy || !(await allowed()))
            return jsonResponse(res, 409, { error: 'CONNECTION_RECOVERY_REVOKED' });
          pending.busy = true;
          try {
            await store.backup(
              path.join(data, `journal.before-connection-recovery-${pending.id}.sqlite`),
            );
            if (!(await allowed())) throw Error('CONNECTION_RECOVERY_REVOKED');
            const next = await rotatePeerSecret(
              store,
              pending.profileId,
              pending.extensionId,
              pending.expected,
            );
            pending.resolve(next);
            return jsonResponse(res, 200, { requested: true, profileId: pending.profileId });
          } catch (error) {
            pending.reject(Error('CONNECTION_RECOVERY_FAILED'));
            throw error;
          }
        }
        if (appHandler && (await appHandler(req, res, u.pathname, input))) return;
        if (!options.diagnosticsEnabled) return jsonResponse(res, 404, { error: 'NOT_FOUND' });
        if (u.pathname === '/api/command')
          return jsonResponse(res, 202, await core.submit(Intent.parse(input)));
        if (u.pathname === '/api/review') {
          const r = Review.parse(input);
          await core.review(r.profileId, r.commandId, r.decision, r.note);
          return jsonResponse(res, 200, { reviewed: true });
        }
        if (u.pathname === '/api/backup') {
          const file = `snapshot-${Date.now()}.sqlite`;
          await store.backup(path.join(data, file));
          return jsonResponse(res, 200, { file });
        }
        const pid = z
          .uuid()
          .parse(
            (input && typeof input === 'object' ? (input as Record<string, unknown>) : {})
              .profileId,
          );
        if (u.pathname === '/api/sync') {
          const peer = core.peers.get(pid);
          if (!peer) throw Error('OFFLINE');
          return jsonResponse(res, 200, await core.sync(peer));
        }
        if (u.pathname === '/api/resume') return jsonResponse(res, 200, await core.resume(pid));
        if (u.pathname === '/api/stop') return jsonResponse(res, 200, await core.stop(pid));
      }
      jsonResponse(res, 404, { error: 'NOT_FOUND' });
    } catch (e) {
      jsonResponse(res, 400, { error: e instanceof Error ? e.message : 'ERROR' });
    }
  });
  const wss = attachBridgeWsGateway({
    server,
    core,
    store,
    kernel,
    host: HOST,
    extensionIds,
    autoRecoverConnections: options.autoRecoverConnections,
    connectionRecoveryAllowed: options.connectionRecoveryAllowed,
    extensionIdle: options.extensionIdle,
    pendingRecovery,
    connectionFailures,
  });
  let tickInFlight = false;
  const heartbeat = setInterval(() => {
    for (const p of core.peers.values()) {
      if (!p.online) continue;
      try {
        p.send({ type: 'HEARTBEAT', connectionEpoch: p.epoch, leaseMs: LEASE_MS });
      } catch {
        void Promise.resolve(kernel?.disconnected(p)).catch(() => {});
        void core.disconnect(p).catch(() => {});
        try {
          p.close();
        } catch {}
      }
    }
    if (!tickInFlight) {
      tickInFlight = true;
      void Promise.resolve()
        .then(() => kernel?.tick())
        .catch((err: unknown) =>
          devDiag.record({
            level: 'WARN',
            category: 'BRIDGE_WS',
            event: 'KERNEL_TICK_ERROR',
            reason: err instanceof Error ? err.message.slice(0, 200) : 'KERNEL_TICK_ERROR',
          }),
        )
        .finally(() => (tickInFlight = false));
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
    return (closing ??= (async () => {
      await Promise.resolve(options.onClose?.()).catch(() => {});
      await kernel?.close();
      clearInterval(heartbeat);
      await core.shutdown();
      await new Promise<void>((resolve, reject) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (!options.store) await store.close();
    })());
  }
  return { core, store, kernel, origin: ORIGIN, close };
}
