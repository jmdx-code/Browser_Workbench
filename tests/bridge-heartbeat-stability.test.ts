import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startBridgeServer } from '../src/bridge/server.js';
import { bridgeCapabilities } from '../src/shared/bridge-capabilities.js';
import { LEASE_MS } from '../src/bridge/protocol.js';
import { createServer } from 'node:net';

test(
  'heartbeats precede a slow non-reentrant tick and queued PONG survives an actual event-loop stall',
  { timeout: 25000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bridge-heartbeat-stability-'));
    let release!: () => void,
      tickCalls = 0;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const extensionId = 'a'.repeat(32);
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const address = probe.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>((r) => probe.close(() => r()));
    const server = await startBridgeServer({
      port,
      root: process.cwd(),
      dataDir: directory,
      extensionIds: [extensionId],
      kernelHooks: () => ({
        message: () => false,
        disconnected: () => {},
        controlStopped: () => {},
        close: async () => {},
        tick: async () => {
          tickCalls++;
          await hold;
        },
      }),
    });
    const profileId = randomUUID();
    let beats = 0,
      welcomed = false;
    const ws = new WebSocket(server.origin.replace('http:', 'ws:') + '/bridge', {
      origin: 'chrome-extension://' + extensionId,
    });
    ws.on('error', () => {});
    const welcome = new Promise<void>((resolve, reject) => {
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'CHALLENGE')
          ws.send(
            JSON.stringify({
              type: 'HELLO',
              version: 2,
              extensionVersion: '0.3.55',
              capabilities: [...bridgeCapabilities],
              profileId,
            }),
          );
        if (m.type === 'WELCOME') {
          welcomed = true;
          resolve();
        }
        if (m.type === 'HEARTBEAT') {
          beats++;
          ws.send(JSON.stringify({ type: 'PONG', connectionEpoch: m.connectionEpoch }));
        }
      });
      ws.on('close', () => {
        if (!welcomed) reject(Error('CLOSED_BEFORE_WELCOME'));
      });
    });
    try {
      await welcome;
      await new Promise((r) => setTimeout(r, 3300));
      assert.ok(beats >= 2);
      assert.equal(tickCalls, 1, 'business tick must not overlap itself');
      const before = beats;
      // The old 4.5s timer would cut all peers before socket I/O could resume.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LEASE_MS + 150);
      await new Promise((r) => setTimeout(r, 1800));
      assert.ok(beats > before);
      assert.equal(ws.readyState, WebSocket.OPEN);
      assert.equal(server.core.peers.get(profileId)?.online, true);
      assert.equal(tickCalls, 1);
    } finally {
      release();
      ws.terminate();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
