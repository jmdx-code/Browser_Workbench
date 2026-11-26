import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { Workboard } from '../dist/src/application/workboard.js';
import { WorkspaceEventHub } from '../dist/src/application/workspace-event-hub.js';
import { WorkspaceService } from '../dist/src/application/workspace-service.js';
import { VERSION } from '../dist/src/bridge/protocol.js';
import { startBridgeServer } from '../dist/src/bridge/server.js';
import { workspaceApi } from '../dist/src/http/workspace-api.js';
import { BridgeProfileSource } from '../dist/src/infrastructure/browser-source.js';
import { PersistenceClient } from '../dist/src/infrastructure/persistence-client.js';
import { bridgeCapabilities } from '../dist/src/shared/bridge-capabilities.js';

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  assert.ok(port > 0, 'failed to probe free loopback port');
  return port;
}

function connectWsPeer(port, extensionOrigin) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: extensionOrigin });
  const queue = [];
  let waiter;
  ws.on('error', () => {});
  ws.on('message', (data) => {
    const parsed = JSON.parse(data.toString());
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
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = undefined;
          reject(Error('WS_MESSAGE_TIMEOUT'));
        }, 6000);
        waiter = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
      });
    },
    closed: () => new Promise((resolve) => ws.once('close', resolve)),
  };
}

function openSseClient(base, cookie) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let invalidateCount = 0;
    let buffer = '';
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(Error('SSE_CONNECT_TIMEOUT'));
      }
    }, 5000);

    const req = http.get(
      `${base}/api/workspace/events`,
      { headers: { cookie, accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode !== 200) {
          clearTimeout(timer);
          reject(Error(`SSE_BAD_STATUS:${res.statusCode}`));
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            if (frame.includes('event: invalidate')) {
              invalidateCount += 1;
            }
          }
          if (!settled && chunk.includes('event: ready')) {
            settled = true;
            clearTimeout(timer);
            resolve({
              req,
              getInvalidateCount: () => invalidateCount,
            });
          }
        });
      },
    );
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-stress-100-'));
  const dataDir = path.join(dir, 'data');
  const webRoot = path.join(dir, 'root');
  await mkdir(dataDir, { recursive: true });
  await mkdir(path.join(webRoot, 'web'), { recursive: true });
  await writeFile(path.join(webRoot, 'web', 'index.html'), '<!doctype html><html></html>', 'utf8');
  const extensionVersion = JSON.parse(await readFile('extension/manifest.json', 'utf8')).version;

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
  const persistence = await PersistenceClient.open(dataDir);
  const eventHub = new WorkspaceEventHub({ coalesceMs: 25, keepaliveMs: 15_000, maxClients: 32 });
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  const sockets = [];
  const sseClients = [];

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
    const cookie = (landing.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    assert.ok(cookie.includes('bridgeAdmin'), `expected bridgeAdmin cookie, got: ${cookie}`);

    for (let i = 0; i < 8; i++) {
      sseClients.push(await openSseClient(base, cookie));
    }
    assert.equal(eventHub.clientCount(), 8);

    // Connect 100 real concurrent WebSocket peers in 4 waves of 25
    // (respecting PersistenceClient's 256 max concurrent worker IPC queue)
    const peers = [];
    for (let wave = 0; wave < 4; wave += 1) {
      const waveConnected = await Promise.all(
        Array.from({ length: 25 }, async (_, offset) => {
          const idx = wave * 25 + offset;
          const profileId = randomUUID();
          const client = connectWsPeer(port, extensionOrigin);
          sockets.push(client.ws);
          await client.next(); // CHALLENGE
          client.ws.send(
            JSON.stringify({
              type: 'HELLO',
              version: VERSION,
              extensionVersion,
              capabilities: [...bridgeCapabilities],
              profileId,
            }),
          );
          const welcome = await client.next();
          assert.equal(welcome.type, 'WELCOME');
          return { idx, profileId, secret: String(welcome.secret), client };
        }),
      );
      peers.push(...waveConnected);
    }

    // Exercise HMAC reconnect on first 10 peers while keeping 100 concurrent peers online
    await Promise.all(
      peers.slice(0, 10).map(async (peerEntry) => {
        const closedPromise = peerEntry.client.closed();
        peerEntry.client.ws.close();
        await closedPromise;

        const nextClient = connectWsPeer(port, extensionOrigin);
        sockets.push(nextClient.ws);
        const challenge = await nextClient.next();
        const proof = createHmac('sha256', peerEntry.secret)
          .update(String(challenge.challenge ?? ''))
          .digest('hex');
        nextClient.ws.send(
          JSON.stringify({
            type: 'HELLO',
            version: VERSION,
            extensionVersion,
            capabilities: [...bridgeCapabilities],
            profileId: peerEntry.profileId,
            proof,
          }),
        );
        const welcome = await nextClient.next();
        assert.equal(welcome.type, 'WELCOME');
        peerEntry.client = nextClient;
      }),
    );

    const onlinePeersPeak = [...bridge.core.peers.values()].filter((p) => p.online).length;
    assert.equal(onlinePeersPeak, 100, `expected 100 online peers, got ${onlinePeersPeak}`);

    const heapBeforeMb = process.memoryUsage().heapUsed / (1024 * 1024);
    const benchStart = performance.now();

    const workboard = new Workboard({
      browserConcurrency: 32,
      bluestacksConcurrency: 32,
      launchConcurrency: 16,
    });
    const workItems = Array.from({ length: 500 }, (_, i) => i);
    const pool = workboard.createPool(workItems, (item) => `item-${item}`);

    await Promise.all(
      peers.map((peerEntry, soldierIdx) =>
        workboard.runSoldier(
          {
            carrierId: peerEntry.profileId,
            carrierKind: soldierIdx % 2 === 0 ? 'browser' : 'bluestacks',
            moduleId: soldierIdx % 2 === 0 ? 'group-bumper' : 'bluestacks-bumper',
          },
          async (soldier) => {
            while (true) {
              const item = pool.claimNext();
              if (item === undefined) break;
              const permits =
                soldier.carrierKind === 'browser'
                  ? workboard.browserPermits
                  : workboard.bluestacksPermits;
              await permits.run(soldier.signal, async () => {
                await persistence.workspace.postBumpRecords.insert({
                  recordType: soldierIdx % 2 === 0 ? 'group_bump' : 'post',
                  carrier: soldier.carrierKind,
                  status: 'success',
                  profileId: peerEntry.profileId,
                  accountId: `acc-${soldierIdx}`,
                  accountName: `StressAccount-${soldierIdx}`,
                  groupId: `grp-${item % 20}`,
                  groupName: `StressGroup-${item % 20}`,
                  postId: `post-${item}`,
                  liked: true,
                  captionPreview: `stress-${item}`,
                });
                eventHub.emit(['records', 'group-bumper', 'group-poster'], `stress-${item}`);
                pool.markDone();
              });
            }
          },
        ),
      ),
    );

    // Allow coalesced SSE frames to flush to all 8 HTTP clients
    await new Promise((r) => setTimeout(r, 120));

    const persistedSummary = await persistence.workspace.postBumpRecords.list({ limit: 1 });
    const recordsPersisted = persistedSummary.total;
    assert.equal(recordsPersisted, 500, `expected 500 records persisted, got ${recordsPersisted}`);
    assert.equal(pool.completedCount(), 500);
    assert.equal(workboard.hasAnyActive(), false);

    const sseFramesPerClient = sseClients.map((client) => client.getInvalidateCount());
    const sseEventsReceived = sseFramesPerClient.reduce((sum, count) => sum + count, 0);
    assert.ok(
      sseFramesPerClient.every((count) => count > 0),
      `every SSE client should receive >= 1 invalidate frame: ${JSON.stringify(sseFramesPerClient)}`,
    );

    const durationMs = Number((performance.now() - benchStart).toFixed(2));
    const heapAfterMb = process.memoryUsage().heapUsed / (1024 * 1024);
    const eventLoopLagP99Ms = Number((loopDelay.percentile(99) / 1e6).toFixed(2));
    assert.ok(eventLoopLagP99Ms < 500, `eventLoopLagP99Ms too high: ${eventLoopLagP99Ms}`);

    // Close all 100 WS clients and verify zero peer leaks + fast shutdown
    for (const peerEntry of peers) {
      peerEntry.client.ws.close();
    }
    for (let i = 0; i < 80; i++) {
      if ([...bridge.core.peers.values()].filter((p) => p.online).length === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const leakedPeers = [...bridge.core.peers.values()].filter((p) => p.online).length;
    assert.equal(leakedPeers, 0, `expected 0 leaked online peers, got ${leakedPeers}`);

    const shutdownStart = performance.now();
    await bridge.close();
    await persistence.close();
    const shutdownMs = Number((performance.now() - shutdownStart).toFixed(2));
    assert.equal(eventHub.clientCount(), 0, 'expected all SSE clients detached after bridge.close');
    assert.ok(shutdownMs < 3000, `expected shutdown < 3000ms, got ${shutdownMs}ms`);

    console.log(
      JSON.stringify(
        {
          ok: true,
          onlinePeersPeak,
          recordsPersisted,
          sseClients: sseClients.length,
          sseEventsReceived,
          durationMs,
          eventLoopLagP99Ms,
          heapDeltaMb: Number((heapAfterMb - heapBeforeMb).toFixed(2)),
          leakedPeers,
          shutdownMs,
        },
        null,
        2,
      ),
    );
  } finally {
    loopDelay.disable();
    for (const sock of sockets) {
      try {
        sock.terminate();
      } catch {}
    }
    for (const client of sseClients) {
      try {
        client.req.destroy();
      } catch {}
    }
    await bridge.close().catch(() => {});
    await persistence.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

await main();
