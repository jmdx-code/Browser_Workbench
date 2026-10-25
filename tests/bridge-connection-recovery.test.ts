import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { startBridgeServer } from '../src/bridge/server.js';
import { bridgeCapabilities } from '../src/shared/bridge-capabilities.js';

test('explicit recovery binds a live failed socket, backs up credentials, preserves identity and resumes only authenticated pause', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bridge-connection-recovery-'));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const profileId = randomUUID(),
    extensionId = 'a'.repeat(32);
  let allowed = true;
  const server = await startBridgeServer({
    root: process.cwd(),
    port,
    dataDir: directory,
    extensionIds: [extensionId],
    connectionRecoveryAllowed: (id) => id === profileId && allowed,
  });
  const sockets: WebSocket[] = [];
  const open = async () => {
    const ws = new WebSocket(server.origin.replace('http:', 'ws:') + '/bridge', {
      origin: 'chrome-extension://' + extensionId,
    });
    sockets.push(ws);
    const messages: unknown[] = [];
    let deliver: ((value: unknown) => void) | undefined;
    ws.on('message', (raw) => {
      const value: unknown = JSON.parse(raw.toString());
      if (deliver) {
        const resolve = deliver;
        deliver = undefined;
        resolve(value);
      } else messages.push(value);
    });
    ws.on('error', () => {});
    const next = () =>
      messages.length
        ? Promise.resolve(messages.shift())
        : new Promise<unknown>((resolve) => {
            deliver = resolve;
          });
    return { ws, next };
  };
  const hello = {
    type: 'HELLO',
    version: 2,
    extensionVersion: '0.3.25',
    capabilities: [...bridgeCapabilities],
    profileId,
  };
  try {
    const landing = await fetch(server.origin + '/workbench/');
    const cookie = landing.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const headers = { cookie, origin: server.origin, 'content-type': 'application/json' };
    const client = await open();
    await client.next();
    client.ws.send(JSON.stringify(hello));
    const first = (await client.next()) as { type: string; secret: string };
    assert.equal(first.type, 'WELCOME');
    const closed = new Promise((resolve) => client.ws.once('close', resolve));
    client.ws.close();
    await closed;
    const before = await server.store.profile(profileId);
    assert.ok(before);
    const failed = await open();
    await failed.next();
    failed.ws.send(JSON.stringify({ ...hello, proof: '0'.repeat(64) }));
    let pending: { id: string; profileId: string }[] = [];
    for (let i = 0; i < 30 && !pending.length; i++) {
      pending = (
        (await (
          await fetch(server.origin + '/api/bridge-connection-health', { headers: { cookie } })
        ).json()) as { pending: typeof pending }
      ).pending;
      if (!pending.length) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(pending.length, 1);
    const attempt = pending[0];
    assert.ok(attempt);
    const request = { id: attempt.id, profileId: attempt.profileId };
    const post = (input: unknown, custom = headers) =>
      fetch(server.origin + '/api/bridge-connections/recover', {
        method: 'POST',
        headers: custom,
        body: JSON.stringify(input),
      });
    assert.equal((await post(request, { ...headers, cookie: '' })).status, 401);
    assert.equal((await post({ ...request, profileId: randomUUID() })).status, 409);
    allowed = false;
    assert.equal((await post(request)).status, 409);
    assert.equal((await server.store.profile(profileId))?.secret, before.secret);
    allowed = true;
    assert.equal((await post(request)).status, 200);
    const repaired = (await failed.next()) as { type: string; secret: string; paused: boolean };
    assert.equal(repaired.type, 'WELCOME');
    assert.equal(repaired.paused, true);
    assert.notEqual(repaired.secret, before.secret);
    const after = await server.store.profile(profileId);
    assert.deepEqual({ ...after }, { ...before, secret: repaired.secret });
    assert.ok(
      (await readdir(directory)).some(
        (file) =>
          file.startsWith('journal.before-connection-recovery-') && file.endsWith('.sqlite'),
      ),
    );
    assert.equal((await post(request)).status, 409);
    const repairedClosed = new Promise((resolve) => failed.ws.once('close', resolve));
    failed.ws.close();
    await repairedClosed;
    const reconnect = await open();
    const challenge = (await reconnect.next()) as { challenge: string };
    reconnect.ws.send(
      JSON.stringify({
        ...hello,
        proof: createHmac('sha256', repaired.secret).update(challenge.challenge).digest('hex'),
      }),
    );
    const welcomed = (await reconnect.next()) as { type: string; paused: boolean; secret?: string };
    assert.equal(welcomed.type, 'WELCOME');
    assert.equal(welcomed.paused, true);
    assert.equal(welcomed.secret, undefined);
  } finally {
    sockets.forEach((socket) => socket.terminate());
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
