import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startBridgeServer } from '../src/bridge/server.js';
import { bridgeCapabilities } from '../src/shared/bridge-capabilities.js';
import { devDiag } from '../src/shared/dev-diagnostics.js';

test(
  'oversized frames close only the failed socket; authenticated peer and HTTP service survive',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bridge-socket-error-'));
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const address = probe.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>((r) => probe.close(() => r()));
    const extensionId = 'a'.repeat(32),
      sockets: WebSocket[] = [];
    const server = await startBridgeServer({
      port,
      root: process.cwd(),
      dataDir: directory,
      extensionIds: [extensionId],
    });
    const open = async (authenticate = true) => {
      const ws = new WebSocket(server.origin.replace('http:', 'ws:') + '/bridge', {
        origin: 'chrome-extension://' + extensionId,
      });
      sockets.push(ws);
      ws.on('error', () => {});
      const messages: Record<string, unknown>[] = [],
        waiters: ((v: Record<string, unknown>) => void)[] = [];
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type === 'HEARTBEAT')
          ws.send(JSON.stringify({ type: 'PONG', connectionEpoch: message.connectionEpoch }));
        const waiter = waiters.shift();
        if (waiter) waiter(message);
        else messages.push(message);
      });
      const next = () =>
        messages.length
          ? Promise.resolve(messages.shift()!)
          : new Promise<Record<string, unknown>>((r) => waiters.push(r));
      assert.equal((await next()).type, 'CHALLENGE');
      const profileId = randomUUID();
      if (authenticate) {
        ws.send(
          JSON.stringify({
            type: 'HELLO',
            version: 2,
            extensionVersion: '0.3.54',
            capabilities: [...bridgeCapabilities],
            profileId,
          }),
        );
        assert.equal((await next()).type, 'WELCOME');
      }
      return { ws, profileId, next };
    };
    try {
      const healthy = await open();
      for (const authenticate of [true, false]) {
        const failed = await open(authenticate);
        const closed = once(failed.ws, 'close');
        failed.ws.send(Buffer.alloc(4 * 1024 * 1024 + 1, 65));
        await closed;
        while ((await healthy.next()).type !== 'HEARTBEAT') {
          /* Drain the initial SYNC before testing a live heartbeat. */
        }
        const pong = once(healthy.ws, 'pong');
        healthy.ws.ping('still-running');
        await pong;
        assert.equal(healthy.ws.readyState, WebSocket.OPEN);
        assert.equal(server.core.peers.get(healthy.profileId)?.online, true);
        assert.equal((await fetch(server.origin + '/workbench/')).status, 200);
        const warning = devDiag
          .recent(30)
          .find(
            (e) =>
              e.category === 'BRIDGE_WS' &&
              e.event === 'WS_SOCKET_ERROR' &&
              e.reason === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' &&
              (!authenticate || e.profileId === failed.profileId),
          );
        assert.ok(warning);
        assert.equal(warning.level, 'WARN');
        if (authenticate) assert.equal(server.core.peers.get(failed.profileId)?.online, false);
      }
      // A new client can still authenticate after both errors.
      const fresh = await open();
      assert.equal(server.core.peers.get(fresh.profileId)?.online, true);
    } finally {
      for (const ws of sockets) ws.terminate();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
