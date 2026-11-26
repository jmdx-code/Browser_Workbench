import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { VERSION } from '../../src/bridge/protocol.js';
import { bridgeCapabilities } from '../../src/shared/bridge-capabilities.js';
import { startBridgeServer } from '../../src/bridge/server.js';
import { Core } from '../../src/bridge/core.js';
import { Store } from '../../src/bridge/store.js';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const addr = probe.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

test('bridge accepts legacy 0.3.89 HELLO without 1008 closure and triggers RELOAD_EXTENSION when idle', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-stateless-sync-'));
  const port = await freePort();
  const extensionId = 'eehghiicklfpnhliknglhagcipkjkjjf';
  const profileId = randomUUID();
  const reloaded: string[] = [];
  const bridge = await startBridgeServer({
    root: dir,
    dataDir: dir,
    port,
    extensionIds: [extensionId],
    extensionIdle: (peer) => {
      if (peer.extensionVersion === '0.3.89' && peer.synced && peer.phase === 'PAUSED') {
        reloaded.push(peer.profileId);
        void bridge.core.reloadExtension(peer.profileId);
      }
    },
  });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
      origin: `chrome-extension://${extensionId}`,
    });
    const received: Array<Record<string, unknown>> = [];
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('error', reject);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        received.push(msg);
        if (msg.type === 'CHALLENGE') {
          ws.send(
            JSON.stringify({
              type: 'HELLO',
              version: VERSION,
              extensionVersion: '0.3.89',
              capabilities: [...bridgeCapabilities],
              profileId,
            }),
          );
        } else if (msg.type === 'WELCOME') {
          ws.send(
            JSON.stringify({
              type: 'PONG',
              connectionEpoch: msg.connectionEpoch,
              windowCount: 1,
            }),
          );
        } else if (msg.type === 'RELOAD_EXTENSION') {
          resolve();
        }
      });
    });
    assert.deepEqual(reloaded, [profileId]);
    assert.equal(
      received.some((m) => m.type === 'SYNC'),
      false,
    );
    assert.equal(received.at(-1)?.type, 'RELOAD_EXTENSION');
    const peer = bridge.core.peers.get(profileId);
    assert.equal(peer?.synced, false);
    ws.close();
    const closeInfo = await closed;
    assert.notEqual(closeInfo.code, 1008);
  } finally {
    await bridge.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('stateless SYNC_STATE(entries:[]) authenticates reconnect with HMAC, enters PAUSED, and dispatches RESUME/COMMAND/STOP cleanly', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-stateless-reconnect-'));
  const port = await freePort();
  const extensionId = 'eehghiicklfpnhliknglhagcipkjkjjf';
  const profileId = randomUUID();
  const secret = 'a'.repeat(64);
  const store = new Store(':memory:');
  store.pair(profileId, secret, extensionId);
  const bridge = await startBridgeServer({
    root: dir,
    dataDir: dir,
    port,
    extensionIds: [extensionId],
    store,
  });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
      origin: `chrome-extension://${extensionId}`,
    });
    let connectionEpoch = '';
    await new Promise<void>((resolve, reject) => {
      ws.once('error', reject);
      ws.once('close', (code) => {
        if (!connectionEpoch) reject(new Error('WS_CLOSED_' + code));
      });
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (msg.type === 'CHALLENGE') {
          const proof = createHmac('sha256', secret).update(String(msg.challenge)).digest('hex');
          ws.send(
            JSON.stringify({
              type: 'HELLO',
              version: VERSION,
              extensionVersion: '0.3.92',
              capabilities: [...bridgeCapabilities],
              profileId,
              proof,
            }),
          );
        } else if (msg.type === 'WELCOME') {
          connectionEpoch = String(msg.connectionEpoch);
          ws.send(
            JSON.stringify({
              type: 'SYNC_STATE',
              connectionEpoch,
              requestId: randomUUID(),
              entries: [],
            }),
          );
          resolve();
        } else if (msg.type === 'RESUME') {
          ws.send(
            JSON.stringify({
              type: 'RESUMED',
              connectionEpoch,
              requestId: msg.requestId,
            }),
          );
        } else if (msg.type === 'STOP') {
          ws.send(
            JSON.stringify({
              type: 'STOPPED',
              connectionEpoch,
              requestId: msg.requestId,
            }),
          );
        } else if (msg.type === 'COMMAND') {
          ws.send(
            JSON.stringify({
              type: 'RESULT',
              commandId: msg.commandId,
              status: 'VERIFIED',
              evidence: { tabId: 7 },
            }),
          );
        }
      });
    });

    await new Promise((r) => setTimeout(r, 30));
    const peer = bridge.core.peers.get(profileId);
    assert.ok(peer);
    assert.equal(peer.synced, true);
    assert.equal(peer.phase, 'PAUSED');

    await bridge.core.resume(profileId);
    assert.equal(peer.phase, 'RUNNING');

    const submitted = await bridge.core.run({
      profileId,
      operationId: randomUUID(),
      action: { kind: 'createTab' },
    });
    assert.equal(submitted.status, 'VERIFIED');

    await bridge.core.stop(profileId);
    assert.equal(peer.phase, 'PAUSED');
    ws.close();
  } finally {
    await bridge.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Core exposes 3-state Phase (PAUSED/RUNNING/OFFLINE) and Store settles legacy unresolved rows on open', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-store-settle-'));
  const file = path.join(dir, 'bridge.sqlite');
  const legacyStore = new Store(file);
  const profileId = randomUUID();
  legacyStore.pair(profileId, 'sec', 'ext');
  const { row } = legacyStore.prepare({
    profileId,
    operationId: randomUUID(),
    action: { kind: 'createTab' },
  });
  legacyStore.close();

  const store = new Store(file);
  const core = new Core(store);
  try {
    assert.equal(store.get(row.commandId)?.status, 'CANCELLED');
    assert.deepEqual(store.unresolved(profileId), []);
    const peer = core.connect(
      profileId,
      () => {},
      () => {},
    );
    assert.equal(peer.phase, 'PAUSED');
    assert.equal((await core.inspectKernelProfileIdle(profileId)).idle, true);
    await core.disconnect(peer);
    assert.equal(peer.phase, 'OFFLINE');
  } finally {
    await core.shutdown();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
