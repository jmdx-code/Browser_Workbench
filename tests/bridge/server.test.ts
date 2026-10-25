import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import { request } from 'node:http';
import { VERSION } from '../../src/bridge/protocol.js';
import { createServer } from 'node:net';
import { bridgeCapabilities } from '../../src/shared/bridge-capabilities.js';
const currentExtensionVersion = JSON.parse(
  await readFile('extension/manifest.json', 'utf8'),
).version;
let base = '';
let port = 0;
const extension = 'chrome-extension://' + 'a'.repeat(32);
function client(origin = extension) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/bridge', { origin });
  const queue: any[] = [];
  let waiter: ((v: any) => void) | undefined;
  ws.on('error', () => {});
  ws.on('message', (data) => {
    const value = JSON.parse(data.toString());
    if (waiter) {
      const resolve = waiter;
      waiter = undefined;
      resolve(value);
    } else queue.push(value);
  });
  return {
    ws,
    next: () =>
      queue.length
        ? Promise.resolve(queue.shift())
        : new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => {
              waiter = undefined;
              reject(Error('WS_MESSAGE_TIMEOUT'));
            }, 2500);
            waiter = (value) => {
              clearTimeout(timer);
              resolve(value);
            };
          }),
    closed: () => new Promise<number>((resolve) => ws.once('close', resolve)),
  };
}
test('HTTP/WS integration uses an isolated database and simulated peers, not a browser', async (t) => {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  port = (probe.address() as any).port;
  await new Promise<void>((r) => probe.close(() => r()));
  base = 'http://127.0.0.1:' + port;
  const dir = await mkdtemp(path.join(tmpdir(), 'new-bridge-'));
  const child = spawn(process.execPath, ['dist/src/server.js'], {
    env: {
      ...process.env,
      BRIDGE_TEST_DATA_DIR: dir,
      BRIDGE_TEST_PORT: String(port),
      BRIDGE_ALLOWED_EXTENSION_ID: 'a'.repeat(32),
      WORKBENCH_DIAGNOSTICS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sockets: WebSocket[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('SERVER_START_TIMEOUT')), 5000);
      child.stdout.on('data', (b) => {
        if (b.toString().includes('dashboard:')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(Error('SERVER_EXIT_' + code));
      });
    });
    const landing = await fetch(base);
    const cookie = landing.headers.get('set-cookie')!.split(';')[0]!;
    const state = async () =>
      (await (await fetch(base + '/api/state', { headers: { cookie } })).json()) as any;
    const post = (route: string, value: unknown, origin = base) =>
      fetch(base + route, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
    const profileId = randomUUID();
    let secret = '';
    await t.test(
      'new optional capabilities accepted, duplicate capability claims rejected',
      async () => {
        const required = [
          'operation-journal-v2',
          'stop-confirmation',
          'media-observation',
          'media-node-identity',
        ];
        const invalid = client();
        sockets.push(invalid.ws);
        await invalid.next();
        const rejected = invalid.closed();
        invalid.ws.send(
          JSON.stringify({
            type: 'HELLO',
            version: VERSION,
            extensionVersion: '0.2.2',
            profileId: randomUUID(),
            capabilities: [...required, 'media-node-identity'],
          }),
        );
        assert.equal(await rejected, 1008);
        const valid = client();
        sockets.push(valid.ws);
        await valid.next();
        valid.ws.send(
          JSON.stringify({
            type: 'HELLO',
            version: VERSION,
            extensionVersion: '0.3.3',
            profileId: randomUUID(),
            capabilities: [
              ...required,
              'task-activation',
              'media-surface-input',
              'fixture-kernel-v1',
              'kernel-journal-v1',
            ],
          }),
        );
        assert.equal((await valid.next()).type, 'WELCOME');
        const ended = valid.closed();
        valid.ws.close();
        await ended;
      },
    );
    await t.test(
      '0.3.4 full capability advertisement connects without weakening unknown-capability rejection',
      async () => {
        const next = client();
        sockets.push(next.ws);
        await next.next();
        next.ws.send(
          JSON.stringify({
            type: 'HELLO',
            version: VERSION,
            extensionVersion: '0.3.4',
            profileId: randomUUID(),
            capabilities: bridgeCapabilities.filter(
              (capability) =>
                capability !== 'facebook-readonly-v2' && capability !== 'kernel-operation-files-v1',
            ),
          }),
        );
        assert.equal((await next.next()).type, 'WELCOME');
        const ended = next.closed();
        next.ws.close();
        await ended;
        const invalid = client();
        sockets.push(invalid.ws);
        await invalid.next();
        const rejected = invalid.closed();
        invalid.ws.send(
          JSON.stringify({
            type: 'HELLO',
            version: VERSION,
            extensionVersion: '0.3.4',
            profileId: randomUUID(),
            capabilities: [...bridgeCapabilities.slice(0, 8), 'arbitrary-script'],
          }),
        );
        assert.equal(await rejected, 1008);
      },
    );
    await t.test(
      '0.3.6 full capability advertisement negotiates readonly v2 and operation files',
      async () => {
        const next = client();
        sockets.push(next.ws);
        await next.next();
        next.ws.send(
          JSON.stringify({
            type: 'HELLO',
            version: VERSION,
            extensionVersion: '0.3.6',
            profileId: randomUUID(),
            capabilities: bridgeCapabilities,
          }),
        );
        assert.equal((await next.next()).type, 'WELCOME');
        const ended = next.closed();
        next.ws.close();
        await ended;
      },
    );
    await t.test('API requires admin cookie, expected Host and Origin', async () => {
      assert.equal((await fetch(base + '/api/state')).status, 401);
      const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(
          base + '/api/state',
          { headers: { host: 'attacker.example', cookie } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on('error', reject);
        req.end();
      });
      assert.equal(hostStatus, 403);
      assert.equal((await post('/api/backup', {}, 'https://attacker.example')).status, 403);
    });
    await t.test('media serves valid bounded byte ranges and rejects invalid range', async () => {
      const r = await fetch(base + '/sample.mp4', { headers: { range: 'bytes=0-31' } });
      assert.equal(r.status, 206);
      assert.equal((await r.arrayBuffer()).byteLength, 32);
      assert.match(r.headers.get('content-range')!, /^bytes 0-31\//);
      assert.equal(
        (await fetch(base + '/sample.mp4', { headers: { range: 'bytes=999999999-' } })).status,
        416,
      );
    });
    await t.test('webpage origin cannot create a bridge session', async () => {
      const c = client(base);
      sockets.push(c.ws);
      assert.equal(await c.closed(), 1006);
    });
    await t.test('unapproved extension cannot bootstrap another profile', async () => {
      const c = client('chrome-extension://' + 'b'.repeat(32));
      sockets.push(c.ws);
      assert.equal(await c.closed(), 1006);
    });
    await t.test('unsupported protocol version is rejected', async () => {
      const c = client();
      sockets.push(c.ws);
      await c.next();
      const closed = c.closed();
      c.ws.send(JSON.stringify({ type: 'HELLO', version: 99, profileId }));
      assert.equal(await closed, 1008);
    });
    const paired = client();
    sockets.push(paired.ws);
    await paired.next();
    paired.ws.send(
      JSON.stringify({
        type: 'HELLO',
        version: VERSION,
        extensionVersion: currentExtensionVersion,
        capabilities: [...bridgeCapabilities],
        profileId,
      }),
    );
    const welcome = await paired.next();
    secret = welcome.secret;
    const sync = await paired.next();
    assert.equal(sync.type, 'SYNC');
    paired.ws.send(
      JSON.stringify({
        type: 'SYNC_STATE',
        requestId: sync.requestId,
        connectionEpoch: welcome.connectionEpoch,
        entries: [],
      }),
    );
    for (let i = 0; i < 30; i++) {
      if ((await state()).profiles.find((p: any) => p.profileId === profileId)?.synced) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await t.test(
      'fixed local port bootstraps without a code, starts paused and hides credentials',
      async () => {
        assert.equal(welcome.type, 'WELCOME');
        assert.equal(welcome.paused, true);
        assert.ok(secret);
        const s = await state();
        assert.equal(s.pairingCode, undefined);
        assert.deepEqual(s.connection, { mode: 'automatic-local-port', port });
        assert.equal(s.profiles.find((p: any) => p.profileId === profileId).paused, true);
        assert.ok(!JSON.stringify(s.profiles).includes(secret));
        const denied = await post('/api/command', {
          profileId,
          operationId: randomUUID(),
          action: { kind: 'createTab' },
        });
        assert.equal(denied.status, 400);
      },
    );
    await t.test(
      'parent STOP that interrupts SYNC automatically reconciles again without resuming input',
      async () => {
        const nextControl = async (type: string) => {
          for (let i = 0; i < 10; i++) {
            const message = await paired.next();
            if (message.type === type) return message;
            assert.equal(message.type, 'PING');
          }
          throw Error('EXPECTED_CONTROL_MISSING');
        };
        assert.equal((await post('/api/sync', { profileId })).status, 200);
        const interrupted = await nextControl('SYNC');
        assert.equal((await post('/api/stop', { profileId })).status, 200);
        const stop = await nextControl('STOP');
        paired.ws.send(
          JSON.stringify({
            type: 'SYNC_STATE',
            requestId: interrupted.requestId,
            connectionEpoch: welcome.connectionEpoch,
            entries: [],
          }),
        );
        paired.ws.send(
          JSON.stringify({
            type: 'STOPPED',
            requestId: stop.requestId,
            connectionEpoch: welcome.connectionEpoch,
          }),
        );
        const fresh = await nextControl('SYNC');
        assert.notEqual(fresh.requestId, interrupted.requestId);
        assert.notEqual(fresh.requestId, stop.requestId);
        paired.ws.send(
          JSON.stringify({
            type: 'SYNC_STATE',
            requestId: fresh.requestId,
            connectionEpoch: welcome.connectionEpoch,
            entries: [],
          }),
        );
        let profile;
        for (let i = 0; i < 30; i++) {
          profile = (await state()).profiles.find((p: any) => p.profileId === profileId);
          if (profile?.synced) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(profile?.synced, true);
        assert.equal(profile?.phase, 'PAUSED');
        assert.equal(profile?.paused, true);
        assert.equal((await state()).operations.length, 0);
      },
    );
    await t.test('command API rejects arbitrary CDP even after resume', async () => {
      assert.equal((await post('/api/resume', { profileId })).status, 200);
      let resume: any;
      for (let i = 0; i < 6; i++) {
        const m = await paired.next();
        if (m.type === 'RESUME') {
          resume = m;
          break;
        }
      }
      assert.ok(resume);
      paired.ws.send(
        JSON.stringify({
          type: 'RESUMED',
          requestId: resume.requestId,
          connectionEpoch: welcome.connectionEpoch,
        }),
      );
      for (let i = 0; i < 30; i++) {
        if (
          (await state()).profiles.find((p: any) => p.profileId === profileId)?.phase === 'RUNNING'
        )
          break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(
        (
          await post('/api/command', {
            profileId,
            operationId: randomUUID(),
            action: { kind: 'rawCDP', method: 'Runtime.evaluate' },
          })
        ).status,
        400,
      );
    });
    await t.test('simulated input ACK remains distinct from verified business result', async () => {
      const r = await post('/api/command', {
        profileId,
        operationId: randomUUID(),
        action: { kind: 'createTab' },
      });
      assert.equal(r.status, 202);
      let command: any;
      for (let i = 0; i < 6; i++) {
        const m = await paired.next();
        if (m.type === 'COMMAND') {
          command = m;
          break;
        }
      }
      assert.ok(command);
      paired.ws.send(
        JSON.stringify({
          type: 'RESULT',
          commandId: command.commandId,
          status: 'ACKNOWLEDGED',
          evidence: { simulated: true },
        }),
      );
      let row: any;
      for (let i = 0; i < 30; i++) {
        row = (await state()).operations.find((v: any) => v.commandId === command.commandId);
        if (row.status === 'ACKNOWLEDGED') break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(row.status, 'ACKNOWLEDGED');
    });
    const closed = paired.closed();
    paired.ws.close();
    await closed;
    await t.test('reconnect authenticates challenge with HMAC and defaults to paused', async () => {
      const c = client();
      sockets.push(c.ws);
      const challenge = await c.next();
      const proof = createHmac('sha256', secret).update(challenge.challenge).digest('hex');
      c.ws.send(
        JSON.stringify({
          type: 'HELLO',
          version: VERSION,
          extensionVersion: currentExtensionVersion,
          capabilities: [...bridgeCapabilities],
          profileId,
          proof,
        }),
      );
      const result = await c.next();
      assert.equal(result.type, 'WELCOME');
      assert.equal(result.paused, true);
      assert.equal(result.secret, undefined);
      const closed = c.closed();
      c.ws.close();
      await closed;
    });
    await t.test('stored secret cannot authenticate a different extension ID', async () => {
      const c = client('chrome-extension://' + 'b'.repeat(32));
      sockets.push(c.ws);
      assert.equal(await c.closed(), 1006);
    });
    await t.test('incorrect reconnect proof is rejected', async () => {
      const c = client();
      sockets.push(c.ws);
      await c.next();
      const closed = c.closed();
      c.ws.send(
        JSON.stringify({
          type: 'HELLO',
          version: VERSION,
          extensionVersion: currentExtensionVersion,
          capabilities: [...bridgeCapabilities],
          profileId,
          proof: 'invalid',
        }),
      );
      assert.equal(await closed, 1008);
    });
    await t.test(
      'connection health is authenticated and reports only bounded rejection metadata',
      async () => {
        assert.equal((await fetch(base + '/api/bridge-connection-health')).status, 401);
        const response = await fetch(base + '/api/bridge-connection-health', {
          headers: { cookie },
        });
        assert.equal(response.status, 200);
        const health = (await response.json()) as {
          failures: { profileId: string | null; code: string; fields: string[]; count: number }[];
        };
        assert.ok(
          health.failures.some(
            (row) => row.profileId === profileId && row.code === 'AUTH_PROOF_MISMATCH',
          ),
        );
        assert.ok(health.failures.length <= 32);
        assert.ok(health.failures.every((row) => row.fields.length <= 8));
        const serialized = JSON.stringify(health);
        assert.equal(serialized.includes('invalid'), false);
        assert.equal(serialized.includes('"secret"'), false);
        assert.equal(serialized.includes('"proof"'), false);
      },
    );
  } finally {
    sockets.forEach((ws) => ws.terminate());
    child.kill();
    await new Promise<void>((r) => (child.exitCode !== null ? r() : child.once('exit', () => r())));
    await rm(dir, { recursive: true, force: true });
  }
});
