import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { WorkspaceEventHub, type SseClientStream } from '../src/application/workspace-event-hub.js';
import { WorkspaceService } from '../src/application/workspace-service.js';
import { VERSION } from '../src/bridge/protocol.js';
import { startBridgeServer } from '../src/bridge/server.js';
import { workspaceApi } from '../src/http/workspace-api.js';
import { BridgeProfileSource } from '../src/infrastructure/browser-source.js';
import { PersistenceClient } from '../src/infrastructure/persistence-client.js';
import { bridgeCapabilities } from '../src/shared/bridge-capabilities.js';
import { inferEventTopicsForRoute } from '../src/shared/workspace-events.js';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  assert.ok(port > 0);
  return port;
}

interface WsClient {
  ws: WebSocket;
  next: () => Promise<Record<string, unknown>>;
  closed: () => Promise<number>;
}

function connectWsPeer(port: number, extensionOrigin: string): WsClient {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: extensionOrigin });
  const queue: Record<string, unknown>[] = [];
  let waiter: ((value: Record<string, unknown>) => void) | undefined;
  ws.on('error', () => {});
  ws.on('message', (data) => {
    const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
    if (waiter) {
      const resolve = waiter;
      waiter = undefined;
      resolve(parsed);
    } else {
      queue.push(parsed);
    }
  });
  return {
    ws,
    next: () => {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = undefined;
          reject(Error('WS_MESSAGE_TIMEOUT'));
        }, 4000);
        waiter = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
      });
    },
    closed: () => new Promise<number>((resolve) => ws.once('close', resolve)),
  };
}

class MemorySseStream implements SseClientStream {
  readonly chunks: string[] = [];
  closed = false;
  private readonly closeHandlers: Array<() => void> = [];

  write(chunk: string): boolean {
    if (this.closed) return false;
    this.chunks.push(chunk);
    return true;
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of [...this.closeHandlers]) {
      handler();
    }
  }

  onClose(cb: () => void): void {
    this.closeHandlers.push(cb);
  }
}

test('WorkspaceEventHub coalesces bursts, enforces maxClients, detects digest changes, and closes cleanly', async () => {
  assert.deepEqual(inferEventTopicsForRoute('/api/workspace/tasks/records'), []);
  assert.deepEqual(inferEventTopicsForRoute('/api/workspace/post-bump-records/list'), []);
  assert.ok(inferEventTopicsForRoute('/api/workspace/groups/create').includes('workspace'));

  const hub = new WorkspaceEventHub({ coalesceMs: 25, keepaliveMs: 0, maxClients: 2 });
  const s1 = new MemorySseStream();
  const s2 = new MemorySseStream();
  const s3 = new MemorySseStream();

  assert.equal(hub.attach(s1), true);
  assert.equal(hub.attach(s2), true);
  assert.equal(hub.attach(s3), true);
  // maxClients=2 evicts oldest s1
  assert.equal(s1.closed, true);
  assert.equal(hub.clientCount(), 2);

  // Empty topics are ignored without bumping version
  hub.emit([], 'ignored');
  hub.emit(['workspace', 'tasks'], 'burst-1');
  hub.emit(['tasks', 'records'], 'burst-2');
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(hub.version(), 1);
  const invalidateChunk = s2.chunks.find((chunk) => chunk.includes('event: invalidate'));
  assert.ok(invalidateChunk, 'expected coalesced invalidate frame');
  assert.match(invalidateChunk, /"workspace"/);
  assert.match(invalidateChunk, /"tasks"/);
  assert.match(invalidateChunk, /"records"/);

  let step = 0;
  hub.startDigestMonitor(async () => {
    step += 1;
    return {
      workspace: 'same',
      records: step >= 2 ? 'changed' : 'initial',
    };
  }, 20);
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(
    s3.chunks.some((chunk) => chunk.includes('"state-change"') && chunk.includes('"records"')),
    'expected digest monitor invalidate broadcast',
  );

  hub.close();
  assert.equal(hub.clientCount(), 0);
  assert.equal(s2.closed, true);
  assert.equal(s3.closed, true);
});

test('SSE endpoint streams mutations and closes cleanly alongside 20 concurrent HMAC WS peers', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-sse-ws-'));
  const dataDir = path.join(dir, 'data');
  const webRoot = path.join(dir, 'root');
  await mkdir(dataDir, { recursive: true });
  await mkdir(path.join(webRoot, 'web'), { recursive: true });
  await writeFile(path.join(webRoot, 'web', 'index.html'), '<!doctype html><html></html>', 'utf8');
  const extensionVersion = (
    JSON.parse(await readFile('extension/manifest.json', 'utf8')) as { version: string }
  ).version;

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
  const persistence = await PersistenceClient.open(dataDir);
  const eventHub = new WorkspaceEventHub({ coalesceMs: 15, keepaliveMs: 1000, maxClients: 16 });
  const sockets: WebSocket[] = [];
  let sseReq: http.ClientRequest | undefined;

  const bridge = await startBridgeServer({
    dataDir,
    port,
    root: webRoot,
    extensionIds: ['a'.repeat(32)],
    store: persistence.bridge,
    onClose: () => eventHub.close(),
    appRoutes: ({ core }) => {
      const service = new WorkspaceService(
        persistence.workspace,
        new BridgeProfileSource(core, persistence.bridge),
      );
      return workspaceApi(
        service,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        persistence.workspace.postBumpRecords,
        eventHub,
      );
    },
  });

  try {
    const landing = await fetch(base);
    assert.equal(landing.status, 200);
    const cookieHeader = landing.headers.get('set-cookie') ?? '';
    const cookie = cookieHeader.split(';')[0] ?? '';
    assert.ok(cookie.includes('bridgeAdmin'), `unexpected cookie header: ${cookieHeader}`);

    let sseBuffer = '';
    let sseEnded = false;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('SSE_READY_TIMEOUT')), 4000);
      sseReq = http.get(
        `${base}/api/workspace/events`,
        { headers: { cookie, accept: 'text/event-stream' } },
        (res) => {
          assert.equal(res.statusCode, 200);
          assert.match(String(res.headers['content-type'] ?? ''), /text\/event-stream/);
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            sseBuffer += chunk;
            if (sseBuffer.includes('event: ready')) {
              clearTimeout(timer);
              resolve();
            }
          });
          res.on('end', () => {
            sseEnded = true;
          });
        },
      );
      sseReq.on('error', (err) => {
        if (!sseEnded) reject(err);
      });
    });

    const createGroupRes = await fetch(`${base}/api/workspace/groups/create`, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'SSE Live Group', color: 'blue' }),
    });
    assert.equal(createGroupRes.status, 201);

    for (let i = 0; i < 40; i++) {
      if (sseBuffer.includes('event: invalidate') && sseBuffer.includes('"workspace"')) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(
      sseBuffer.includes('event: invalidate') && sseBuffer.includes('"workspace"'),
      `expected workspace invalidation in SSE stream, got: ${sseBuffer}`,
    );

    const peerRecords: Array<{ profileId: string; secret: string; client: WsClient }> = [];
    for (let i = 0; i < 20; i++) {
      const profileId = randomUUID();
      const peer = connectWsPeer(port, extensionOrigin);
      sockets.push(peer.ws);
      await peer.next(); // CHALLENGE
      peer.ws.send(
        JSON.stringify({
          type: 'HELLO',
          version: VERSION,
          extensionVersion,
          capabilities: [...bridgeCapabilities],
          profileId,
        }),
      );
      const welcome = await peer.next();
      assert.equal(welcome.type, 'WELCOME');
      assert.equal(typeof welcome.secret, 'string');
      peerRecords.push({ profileId, secret: String(welcome.secret), client: peer });
    }
    const onlineCount = [...bridge.core.peers.values()].filter((p) => p.online).length;
    assert.equal(onlineCount, 20);

    // Verify HMAC reconnect on peer 0
    const first = peerRecords[0];
    assert.ok(first);
    const firstClosed = first.client.closed();
    first.client.ws.close();
    await firstClosed;

    const reconnected = connectWsPeer(port, extensionOrigin);
    sockets.push(reconnected.ws);
    const challenge = await reconnected.next();
    const proof = createHmac('sha256', first.secret)
      .update(String(challenge.challenge ?? ''))
      .digest('hex');
    reconnected.ws.send(
      JSON.stringify({
        type: 'HELLO',
        version: VERSION,
        extensionVersion,
        capabilities: [...bridgeCapabilities],
        profileId: first.profileId,
        proof,
      }),
    );
    const rew = await reconnected.next();
    assert.equal(rew.type, 'WELCOME');

    for (const sock of sockets) {
      if (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING) {
        sock.close();
      }
    }
    for (let i = 0; i < 40; i++) {
      if ([...bridge.core.peers.values()].filter((p) => p.online).length === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal([...bridge.core.peers.values()].filter((p) => p.online).length, 0);
  } finally {
    for (const sock of sockets) {
      try {
        sock.terminate();
      } catch {}
    }
    const closeStart = performance.now();
    await bridge.close();
    await persistence.close();
    const shutdownMs = performance.now() - closeStart;
    assert.equal(eventHub.clientCount(), 0);
    assert.ok(shutdownMs < 3000, `expected shutdown < 3000ms, got ${shutdownMs}ms`);
    sseReq?.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});
