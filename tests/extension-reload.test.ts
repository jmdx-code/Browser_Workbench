import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { startBridgeServer } from '../src/bridge/server.js';
import { bridgeCapabilities } from '../src/shared/bridge-capabilities.js';
import { ExtensionUpdates } from '../src/infrastructure/extension-updates.js';
import { devDiag } from '../src/shared/dev-diagnostics.js';
test(
  'real WebSocket old-version SYNC requests one reload and accepts EXTENSION_RELOADING acknowledgement',
  { timeout: 15000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wb-extension-reload-'));
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const addr = probe.address();
    assert.ok(addr && typeof addr !== 'string');
    await new Promise<void>((r) => probe.close(() => r()));
    let updates: ExtensionUpdates | undefined;
    const server = await startBridgeServer({
      root: process.cwd(),
      dataDir: dir,
      port: addr.port,
      extensionIds: ['a'.repeat(32)],
      extensionIdle: async (peer) => {
        updates ??= new ExtensionUpdates(server.core, '0.3.54', 'fixed', () => false);
        await updates.automatic(peer);
      },
    });
    const ws = new WebSocket(server.origin.replace('http:', 'ws:') + '/bridge', {
      origin: 'chrome-extension://' + 'a'.repeat(32),
    });
    const messages: Record<string, unknown>[] = [];
    const waiting: ((m: Record<string, unknown>) => void)[] = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (m.type === 'HEARTBEAT')
        ws.send(JSON.stringify({ type: 'PONG', connectionEpoch: m.connectionEpoch }));
      const waiter = waiting.shift();
      if (waiter) waiter(m);
      else messages.push(m);
    });
    const next = () =>
      messages.length
        ? Promise.resolve(messages.shift() as Record<string, unknown>)
        : new Promise<Record<string, unknown>>((r) => waiting.push(r));
    try {
      assert.equal((await next()).type, 'CHALLENGE');
      const id = randomUUID();
      ws.send(
        JSON.stringify({
          type: 'HELLO',
          version: 2,
          extensionVersion: '0.3.53',
          capabilities: [...bridgeCapabilities],
          profileId: id,
        }),
      );
      assert.equal((await next()).type, 'WELCOME');
      const sync = await next();
      assert.equal(sync.type, 'SYNC');
      ws.send(
        JSON.stringify({
          type: 'SYNC_STATE',
          connectionEpoch: sync.connectionEpoch,
          requestId: sync.requestId,
          entries: [],
        }),
      );
      let reload = await next();
      while (reload.type === 'HEARTBEAT') reload = await next();
      assert.equal(reload.type, 'RELOAD_EXTENSION');
      ws.send(
        JSON.stringify({
          type: 'EXTENSION_RELOADING',
          requestId: reload.requestId,
          connectionEpoch: reload.connectionEpoch,
        }),
      );
      const pong = once(ws, 'pong');
      ws.ping('alive');
      await pong;
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(ws.readyState, WebSocket.OPEN);
      assert.ok(
        devDiag.recent(40).some((e) => e.event === 'EXTENSION_RELOADING' && e.profileId === id),
      );
      assert.equal((await fetch(server.origin)).status, 200);
    } finally {
      ws.terminate();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
