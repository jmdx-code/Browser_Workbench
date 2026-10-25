import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../src/bridge/core.js';
import { Store } from '../src/bridge/store.js';
import { ExtensionKernelChannel } from '../extension/kernel-channel.js';
import { KernelJsonObject as JsonObjectSchema } from '../src/shared/kernel-protocol.js';
import { KernelLease } from '../src/domain/kernel-lease.js';
import { KernelExecutor } from '../src/application/kernel-executor.js';
import { KernelRelayModel } from '../src/infrastructure/kernel-relay-model.js';
import { openKernelRelayEndpoint } from '../src/infrastructure/kernel-relay-endpoint.js';
import { connectFixtureKernel } from '../src/infrastructure/kernel-browser.js';
import { kernelFixtureURL, assertKernelSessionCommand } from '../src/shared/kernel-policy.js';
import { KernelJournal } from '../src/application/kernel-journal.js';
import { MemoryKernelStorage } from './fixtures/kernel-storage.js';
import type {
  KernelBackend,
  KernelCdpMessage,
  KernelJsonObject,
  KernelStamp,
  KernelTarget,
  KernelTargetInfo,
} from '../src/shared/kernel-protocol.js';

const fixtureURL = 'http://127.0.0.1:18767/kernel-fixture';
class SimulatedChrome implements KernelBackend {
  readonly commands: { target: KernelTarget; method: string; params: KernelJsonObject }[] = [];
  readonly urls = new Map([
    [1, fixtureURL],
    [2, fixtureURL],
    [99, 'https://user-tab.example/'],
  ]);
  readonly attached = new Set<number>();
  readonly removed: number[] = [];
  emit: (target: KernelTarget, method: string, params: KernelJsonObject) => void = () => {};
  scopeBlock: Promise<void> | undefined;
  inputBlock: Promise<void> | undefined;
  attachBlock: Promise<void> | undefined;
  detachFailure = false;
  nextId = 3;
  async scope(tabId: number) {
    if (this.scopeBlock) await this.scopeBlock;
    if (!kernelFixtureURL(this.urls.get(tabId) ?? '')) throw Error('KERNEL_SCOPE_CHANGED');
  }
  async attach(tabId: number): Promise<KernelTargetInfo> {
    if (this.attachBlock) await this.attachBlock;
    this.attached.add(tabId);
    return {
      targetId: 'target-' + tabId,
      browserContextId: 'simulated-existing-context',
      type: 'page',
      url: this.urls.get(tabId) ?? '',
      title: 'Simulated fixture',
      attached: true,
    };
  }
  async detach(tabId: number) {
    if (this.detachFailure) throw Error('SIMULATED_DETACH_FAILED');
    this.attached.delete(tabId);
  }
  async create(url: string) {
    const tabId = this.nextId++;
    this.urls.set(tabId, url);
    return { tabId };
  }
  async remove(tabId: number) {
    this.removed.push(tabId);
    this.urls.delete(tabId);
    this.attached.delete(tabId);
  }
  async send(
    target: KernelTarget,
    method: string,
    params: KernelJsonObject,
  ): Promise<KernelJsonObject> {
    this.commands.push({ target, method, params });
    if (method.startsWith('Input.') && this.inputBlock) await this.inputBlock;
    if (method === 'Page.getFrameTree')
      return {
        frameTree: {
          frame: {
            id: 'target-' + target.tabId,
            url: this.urls.get(target.tabId) ?? '',
            loaderId: 'loader',
            securityOrigin: 'http://127.0.0.1:18767',
            mimeType: 'text/html',
            name: '',
          },
        },
      };
    if (method === 'Page.createIsolatedWorld') {
      const contextId = target.tabId * 10 + 2;
      this.emit(target, 'Runtime.executionContextCreated', {
        context: {
          id: contextId,
          origin: '',
          name: typeof params.worldName === 'string' ? params.worldName : '',
          auxData: { isDefault: false, frameId: 'target-' + target.tabId },
        },
      });
      return { executionContextId: contextId };
    }
    if (method === 'Runtime.enable')
      this.emit(target, 'Runtime.executionContextCreated', {
        context: {
          id: target.tabId * 10 + 1,
          origin: 'http://127.0.0.1:18767',
          name: '',
          auxData: { isDefault: true, frameId: 'target-' + target.tabId },
        },
      });
    return {};
  }
}
function setup(tabs = [1], files: ReadonlySet<string> = new Set()) {
  const chrome = new SimulatedChrome();
  const lease = new KernelLease(randomUUID(), randomUUID());
  const executor = new KernelExecutor(lease, chrome, tabs, files);
  const stamp: KernelStamp = {
    profileId: lease.profileId,
    connectionEpoch: lease.connectionEpoch,
    leaseId: randomUUID(),
    generation: 0,
    expiresAt: Date.now() + 10_000,
  };
  executor.grant(stamp);
  const model = new KernelRelayModel(executor, tabs);
  chrome.emit = (target, method, params) => model.debuggerEvent(target, method, params);
  return { chrome, lease, executor, stamp, model };
}
function deferred() {
  let done: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  return {
    promise,
    release: () => {
      assert.ok(done);
      done();
    },
  };
}

test('idle control release retains attachments, fences old commands, and resumes only at the new lease generation', async () => {
  const state = setup();
  await state.executor.attach(1);
  const requestId = randomUUID();
  const stop = await state.executor.stop(requestId, 100, true);
  assert.equal(stop.state, 'stopped');
  assert.equal(state.chrome.attached.has(1), true);
  const generation = state.lease.generation;
  assert.deepEqual(await state.executor.stop(requestId, 100, true), stop);
  assert.equal(state.lease.generation, generation);
  await assert.rejects(
    state.executor.send({ tabId: 1 }, 'Input.insertText', { text: 'stale' }),
    /FENCED/,
  );
  assert.throws(() => state.executor.grant(state.stamp), /LEASE_REJECTED/);
  state.executor.grant({ ...state.stamp, generation, expiresAt: Date.now() + 10_000 });
  await state.executor.send({ tabId: 1 }, 'Runtime.enable', {});
  assert.equal(state.chrome.attached.has(1), true);
  assert.equal((await state.executor.stop(randomUUID())).state, 'stopped');
  assert.equal(state.chrome.attached.has(1), false);
});

test('initial execution contexts wait for the main frame-tree reply and subsequent contexts remain live', async () => {
  const state = setup();
  const messages: KernelCdpMessage[] = [];
  state.model.connect((message) => messages.push(message));
  await state.model.receive({
    id: 1,
    method: 'Target.setAutoAttach',
    params: { autoAttach: true, flatten: true },
  });
  const attached = messages.find(
    (message) => 'method' in message && message.method === 'Target.attachedToTarget',
  );
  assert.ok(attached && 'params' in attached);
  const sessionId = String(attached.params?.sessionId);
  await state.model.receive({ id: 2, sessionId, method: 'Runtime.enable' });
  assert.equal(
    messages.some(
      (message) => 'method' in message && message.method === 'Runtime.executionContextCreated',
    ),
    false,
  );
  await state.model.receive({ id: 3, sessionId, method: 'Page.getFrameTree' });
  const frameReply = messages.findIndex((message) => 'id' in message && message.id === 3);
  const contextEvent = messages.findIndex(
    (message) => 'method' in message && message.method === 'Runtime.executionContextCreated',
  );
  assert.ok(frameReply >= 0 && contextEvent > frameReply);
  const before = messages.length;
  state.chrome.emit({ tabId: 1 }, 'Runtime.executionContextsCleared', {});
  assert.equal(messages.length, before + 1);
  await state.model.stop(randomUUID());
});

test('read-only identity RPC cannot relay native request credentials or accept UI input, and STOP revokes an awaiting actor read', async () => {
  const state = setup(),
    native = new SimulatedChrome(),
    replies: KernelJsonObject[] = [];
  const block = deferred();
  let observed = 0;
  const journal = new KernelJournal(new MemoryKernelStorage());
  await journal.initialize(state.lease.profileId, randomUUID());
  const backend = Object.assign(native, {
    scope: async (tabId: number) => {
      if (!native.urls.has(tabId)) throw Error('KERNEL_TAB_NOT_OWNED');
    },
    owns: (tabId: number) => native.urls.has(tabId),
    detached: (tabId: number) => {
      native.attached.delete(tabId);
    },
    expectedDetach: () => false,
    observeIdentity: async (_tabId: number, guard: () => void) => {
      observed++;
      await block.promise;
      guard();
      return {
        actor: {
          version: 1 as const,
          source: 'CometSettingsDropdownTriggerQuery' as const,
          accountId: '10000000000001',
          name: 'Nway Myint',
          type: 'User' as const,
          checkedAt: Date.now(),
        },
        frameId: 'main',
        loaderId: 'loader',
      };
    },
  });
  const channel = new ExtensionKernelChannel(
    () => ({ profileId: state.lease.profileId, epoch: state.lease.connectionEpoch, valid: true }),
    (m) => replies.push(JsonObjectSchema.parse(m)),
    () => backend,
    journal,
  );
  let sequence = 0;
  const request = (body: Record<string, unknown>) => {
    const requestId = randomUUID();
    channel.receive({
      type: 'KERNEL_REQUEST',
      requestId,
      sequence: ++sequence,
      connectionEpoch: state.lease.connectionEpoch,
      leaseId: state.stamp.leaseId,
      ...body,
    });
    return requestId;
  };
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  request({ kind: 'open', access: 'facebook-readonly', stamp: state.stamp, files: [] });
  await tick();
  request({ kind: 'create', url: 'https://www.facebook.com/' });
  await tick();
  request({ kind: 'attach', tabId: 3 });
  await tick();
  channel.event({ tabId: 3 }, 'Network.requestWillBeSent', {
    request: { postData: 'fb_dtsg=private', headers: { cookie: 'private' } },
  });
  assert.equal(
    replies.some((m) => m.type === 'KERNEL_EVENT' && m.method === 'Network.requestWillBeSent'),
    false,
  );
  const input = request({
    kind: 'send',
    target: { tabId: 3 },
    method: 'Input.insertText',
    params: { text: 'must not input' },
  });
  await tick();
  assert.match(
    String(replies.find((m) => m.requestId === input)?.error),
    /KERNEL_READONLY_METHOD_REJECTED|KERNEL_OPERATION_REQUIRED/,
  );
  const read = request({ kind: 'observeFacebookIdentity', tabId: 3 });
  await tick();
  assert.equal(observed, 1);
  request({ kind: 'stop' });
  await tick();
  block.release();
  await tick();
  await channel.freeze();
  await tick();
  assert.match(String(replies.find((m) => m.requestId === read)?.error), /FENCED/);
  assert.equal(
    native.commands.some((m) => m.method.startsWith('Input.')),
    false,
  );
});
async function connectedModel(tabs = [1]) {
  const state = setup(tabs);
  const messages: KernelCdpMessage[] = [];
  state.model.connect((m) => messages.push(m));
  await state.model.receive({
    id: 1,
    method: 'Target.setAutoAttach',
    params: { autoAttach: true, flatten: true },
  });
  const session = messages.find((m) => m.method === 'Target.attachedToTarget')?.params?.sessionId;
  assert.equal(typeof session, 'string');
  return { ...state, messages, session: String(session) };
}

test('native auto-attach frame filter is restricted when enabled and empty when disabled', () => {
  for (const autoAttach of [true, false]) {
    const params = assertKernelSessionCommand(
      'Target.setAutoAttach',
      { autoAttach, flatten: true, filter: [{ type: 'worker' }], waitForDebuggerOnStart: true },
      new Set(),
      'facebook-task',
    );
    assert.deepEqual(params.filter, autoAttach ? [{ type: 'iframe', exclude: false }] : []);
    assert.equal(params.waitForDebuggerOnStart, false);
  }
});

test('lease rejects foreign profiles, epochs and expired grants; stop invalidates old stamps', () => {
  const now = 10_000;
  const state = setup();
  const lease = new KernelLease(state.lease.profileId, state.lease.connectionEpoch, () => now);
  const stamp = { ...state.stamp, expiresAt: now + 1_000 };
  assert.throws(() => lease.grant({ ...stamp, profileId: randomUUID() }), /LEASE_REJECTED/);
  assert.throws(() => lease.grant({ ...stamp, connectionEpoch: randomUUID() }), /LEASE_REJECTED/);
  assert.throws(() => lease.grant({ ...stamp, expiresAt: now }), /LEASE_REJECTED/);
  lease.grant(stamp);
  lease.revoke();
  assert.throws(() => lease.check(stamp), /FENCED/);
  assert.throws(() => lease.grant(stamp), /LEASE_REJECTED/);
});

test('heartbeat renewal preserves the generation without invalidating an already accepted request', () => {
  let now = 10_000;
  const lease = new KernelLease(randomUUID(), randomUUID(), () => now);
  const stamp = {
    profileId: lease.profileId,
    connectionEpoch: lease.connectionEpoch,
    leaseId: randomUUID(),
    generation: 0,
    expiresAt: now + 1_000,
  };
  lease.grant(stamp);
  now += 500;
  lease.grant({ ...stamp, expiresAt: now + 2_000 });
  now += 600;
  assert.equal(lease.check(stamp).generation, 0);
  assert.throws(() => lease.grant({ ...stamp, expiresAt: now + 100 }), /LEASE_REJECTED/);
  now += 3_000;
  assert.throws(() => lease.check(stamp), /FENCED/);
});

test('browser-wide mutations and foreign targets are denied even with an owned session', async () => {
  const state = await connectedModel();
  for (const [index, method] of [
    'Browser.close',
    'Storage.clearDataForOrigin',
    'Network.clearBrowserCookies',
    'Emulation.setFocusEmulationEnabled',
  ].entries()) {
    await state.model.receive({ id: index + 2, sessionId: state.session, method, params: {} });
    assert.match(state.messages.at(-1)?.error?.message ?? '', /METHOD_REJECTED/);
  }
  await state.model.receive({
    id: 8,
    method: 'Target.closeTarget',
    params: { targetId: 'target-99' },
  });
  assert.match(state.messages.at(-1)?.error?.message ?? '', /TARGET_NOT_OWNED/);
  assert.equal(state.chrome.commands.length, 0);
  assert.deepEqual(state.chrome.removed, []);
  await state.model.stop(randomUUID());
});

test('unowned tabs and unannounced child sessions cannot execute', async () => {
  const state = setup();
  await assert.rejects(state.executor.attach(99), /TAB_NOT_OWNED/);
  await state.executor.attach(1);
  await assert.rejects(
    state.executor.send({ tabId: 1, sessionId: 'foreign-child' }, 'Input.insertText', {
      text: 'x',
    }),
    /CHILD_NOT_OWNED/,
  );
  assert.equal(state.chrome.commands.length, 0);
  await state.executor.stop(randomUUID());
});

test('fixture navigation and explicit upload file grants constrain the private transport', async () => {
  const state = setup([1], new Set(['D:\\fixture\\one.png']));
  await state.executor.attach(1);
  await assert.rejects(
    state.executor.send({ tabId: 1 }, 'Page.navigate', { url: 'https://www.facebook.com/' }),
    /URL_REJECTED/,
  );
  await assert.rejects(
    state.executor.send({ tabId: 1 }, 'DOM.setFileInputFiles', { files: ['C:\\private.txt'] }),
    /FILE_REJECTED/,
  );
  await state.executor.send({ tabId: 1 }, 'DOM.setFileInputFiles', {
    files: ['D:/fixture/one.png'],
    backendNodeId: 5,
  });
  assert.equal(state.chrome.commands.length, 1);
  await state.executor.stop(randomUUID());
});

test('a scope check already pending when stop arrives cannot dispatch later input', async () => {
  const state = setup();
  await state.executor.attach(1);
  const block = deferred();
  state.chrome.scopeBlock = block.promise;
  const input = state.executor.send({ tabId: 1 }, 'Input.insertText', { text: 'late' });
  const rejected = assert.rejects(input, /FENCED/);
  const stop = state.executor.stop(randomUUID());
  assert.equal(state.executor.state, 'stopping');
  block.release();
  await rejected;
  assert.equal((await stop).state, 'stopped');
  assert.equal(state.chrome.commands.length, 0);
});

test('an input sent before stop remains uncertain, and a late ACK cannot clear it', async () => {
  const state = setup();
  await state.executor.attach(1);
  const block = deferred();
  state.chrome.inputBlock = block.promise;
  const input = state.executor.send({ tabId: 1 }, 'Input.insertText', { text: 'pending' });
  const rejected = assert.rejects(input, /FENCED/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const id = randomUUID();
  const stopping = state.executor.stop(id, 15);
  assert.equal(state.executor.stop(id, 15), stopping);
  assert.throws(() => state.executor.stop(randomUUID()), /CONTROL_PENDING/);
  const first = await stopping;
  assert.equal(first.state, 'unconfirmed');
  assert.deepEqual(first.unresolvedMethods, ['Input.insertText']);
  assert.throws(
    () => state.executor.grant({ ...state.stamp, generation: state.lease.generation }),
    /STOP_NOT_CONFIRMED/,
  );
  block.release();
  await rejected;
  const second = await state.executor.stop(randomUUID());
  assert.equal(second.state, 'stopped');
  assert.deepEqual(second.unresolvedMethods, ['Input.insertText']);
  assert.throws(
    () => state.executor.grant({ ...state.stamp, generation: state.lease.generation }),
    /RESULT_REVIEW_REQUIRED/,
  );
});

test('late attach is detached before stop can confirm; detach failure cannot become success', async () => {
  const state = setup();
  const block = deferred();
  state.chrome.attachBlock = block.promise;
  const attach = state.executor.attach(1);
  const rejected = assert.rejects(attach, /FENCED/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stop = state.executor.stop(randomUUID());
  block.release();
  await rejected;
  assert.equal((await stop).state, 'stopped');
  assert.equal(state.chrome.attached.size, 0);
  const failing = setup();
  await failing.executor.attach(1);
  failing.chrome.detachFailure = true;
  assert.equal((await failing.executor.stop(randomUUID())).state, 'unconfirmed');
});

test('duplicate protocol IDs never replay an input', async () => {
  const state = await connectedModel();
  const command = {
    id: 2,
    sessionId: state.session,
    method: 'Input.insertText',
    params: { text: 'one' },
  };
  await state.model.receive(command);
  await state.model.receive(command);
  assert.equal(state.chrome.commands.length, 1);
  assert.match(state.messages.at(-1)?.error?.message ?? '', /DUPLICATE_COMMAND/);
  await state.model.stop(randomUUID());
});

test('child sessions with equal Chrome IDs remain scoped to the correct owned tab', async () => {
  const state = await connectedModel([1, 2]);
  for (const tabId of [1, 2])
    state.model.debuggerEvent({ tabId }, 'Target.attachedToTarget', {
      sessionId: 'same-child',
      waitingForDebugger: false,
      targetInfo: {
        targetId: 'frame-target-' + tabId,
        type: 'iframe',
        url: 'http://localhost:18767/kernel-frame',
        title: '',
        attached: true,
      },
    });
  const children = state.messages.filter(
    (m) => m.params?.sessionId && String(m.params.sessionId).startsWith('workbench-child-'),
  );
  assert.equal(children.length, 2);
  assert.notEqual(children[0]?.params?.sessionId, children[1]?.params?.sessionId);
  for (const [index, child] of children.entries())
    await state.model.receive({
      id: index + 2,
      sessionId: child.params?.sessionId,
      method: 'Input.insertText',
      params: { text: 'child' },
    });
  assert.deepEqual(
    state.chrome.commands.map((row) => row.target),
    [
      { tabId: 1, sessionId: 'same-child' },
      { tabId: 2, sessionId: 'same-child' },
    ],
  );
  await state.model.stop(randomUUID());
});

test('scope escape revokes the lease and stale debugger events are not forwarded', async () => {
  const state = await connectedModel();
  const before = state.messages.length;
  state.model.debuggerEvent({ tabId: 99 }, 'Runtime.consoleAPICalled', {});
  assert.equal(state.messages.length, before);
  state.model.debuggerEvent({ tabId: 1 }, 'Page.frameNavigated', {
    frame: { id: 'frame-1', url: 'https://outside.example/' },
  });
  assert.throws(() => state.lease.check(), /FENCED/);
  state.model.debuggerEvent({ tabId: 1 }, 'Runtime.consoleAPICalled', {});
  assert.equal(state.messages.length, before);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state.executor.state, 'stopped');
});

test('explicit local drain recovery cannot reopen the endpoint or authorize another input', async () => {
  const state = setup();
  await state.executor.attach(1);
  const relay = await openKernelRelayEndpoint(state.model);
  await assert.rejects(relay.retryClose(), /RETRY_IN_FLIGHT/);
  state.chrome.detachFailure = true;
  assert.equal((await relay.close()).state, 'unconfirmed');
  assert.equal((await relay.retryClose()).state, 'unconfirmed');
  state.chrome.detachFailure = false;
  const receipt = await relay.retryClose();
  assert.equal(receipt.state, 'stopped');
  assert.equal((await relay.close()).state, 'unconfirmed');
  assert.equal(state.chrome.attached.size, 0);
  await assert.rejects(
    state.executor.send({ tabId: 1 }, 'Input.insertText', { text: 'never' }),
    /NOT_OWNED|FENCED/,
  );
  assert.throws(() => state.executor.grant(state.stamp), /LEASE_REJECTED/);
  assert.equal(state.chrome.commands.length, 0);
});

test('loopback endpoint rejects browser origins and missing credentials before reserving a client', async () => {
  const state = setup();
  const relay = await openKernelRelayEndpoint(state.model);
  try {
    for (const options of [{}, { headers: relay.headers, origin: 'http://untrusted.example' }]) {
      const status = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(relay.endpoint, options);
        ws.on('unexpected-response', (_request, response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
          ws.terminate();
        });
        ws.on('open', () => {
          ws.terminate();
          reject(Error('UNAUTHORIZED_OPEN'));
        });
        ws.on('error', () => {});
      });
      assert.equal(status, 403);
    }
  } finally {
    await relay.close();
  }
});

test('real stable Playwright SDK connects through the guarded adapter to a simulated Chrome backend', async () => {
  const state = setup();
  const relay = await openKernelRelayEndpoint(state.model);
  let browser: Awaited<ReturnType<typeof connectFixtureKernel>> | undefined;
  try {
    browser = await connectFixtureKernel(relay.endpoint, relay.headers);
    const contexts = browser.contexts();
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0]?.pages().length, 1);
    const page = contexts[0]?.pages()[0];
    assert.ok(page);
    assert.equal(page.url(), fixtureURL);
    await page.keyboard.insertText('SDK-routed input, not a real browser action');
    assert.equal(
      state.chrome.commands.filter((row) => row.method === 'Input.insertText').length,
      1,
    );
    assert.equal(
      state.chrome.commands.some(
        (row) =>
          row.method === 'Emulation.setFocusEmulationEnabled' ||
          row.method === 'Emulation.setEmulatedMedia',
      ),
      false,
    );
    assert.equal(
      state.chrome.commands.every((row) => row.target.tabId === 1),
      true,
    );
  } finally {
    await browser?.close();
    await relay.close();
  }
});

test('frame-owner lookup and inspector events stay scoped to an owned tab and preserve mutation denials', async () => {
  const state = await connectedModel();
  await state.executor.send({ tabId: 1 }, 'DOM.getFrameOwner', { frameId: 'fixture-child' });
  await state.executor.send({ tabId: 1 }, 'Inspector.enable', {});
  assert.deepEqual(
    state.chrome.commands.slice(-2).map((row) => row.target.tabId),
    [1, 1],
  );
  await assert.rejects(
    state.executor.send({ tabId: 99 }, 'DOM.getFrameOwner', { frameId: 'foreign' }),
    /NOT_OWNED/,
  );
  await assert.rejects(
    state.executor.send({ tabId: 1 }, 'Storage.clearCookies', {}),
    /METHOD_REJECTED/,
  );
  await state.model.stop(randomUUID());
});

test('two real SDK clients with colliding simulated tab IDs stay in separate profile transports', async () => {
  const first = setup();
  const second = setup();
  const endpoints = await Promise.all([
    openKernelRelayEndpoint(first.model),
    openKernelRelayEndpoint(second.model),
  ]);
  const browsers: Awaited<ReturnType<typeof connectFixtureKernel>>[] = [];
  try {
    for (const endpoint of endpoints)
      browsers.push(await connectFixtureKernel(endpoint.endpoint, endpoint.headers));
    const pages = browsers.map((browser) => browser.contexts()[0]?.pages()[0]);
    assert.ok(pages[0]);
    assert.ok(pages[1]);
    await Promise.all([
      pages[0].keyboard.insertText('first'),
      pages[1].keyboard.insertText('second'),
    ]);
    assert.deepEqual(
      first.chrome.commands
        .filter((row) => row.method === 'Input.insertText')
        .map((row) => row.params.text),
      ['first'],
    );
    assert.deepEqual(
      second.chrome.commands
        .filter((row) => row.method === 'Input.insertText')
        .map((row) => row.params.text),
      ['second'],
    );
    await endpoints[0]?.close();
    await pages[1].keyboard.insertText('second-still-live');
    assert.equal(second.chrome.commands.at(-1)?.params.text, 'second-still-live');
    assert.equal(first.chrome.attached.size, 0);
  } finally {
    await Promise.all(browsers.map((browser) => browser.close()));
    await Promise.all(endpoints.map((endpoint) => endpoint.close()));
  }
});

test('stable SDK creates and closes pages within the existing context without browser-wide mutations', async () => {
  const state = setup();
  const relay = await openKernelRelayEndpoint(state.model);
  let browser: Awaited<ReturnType<typeof connectFixtureKernel>> | undefined;
  try {
    browser = await connectFixtureKernel(relay.endpoint, relay.headers);
    const context = browser.contexts()[0];
    assert.ok(context);
    const page = await context.newPage();
    assert.equal(page.url(), 'about:blank');
    await page.close();
    assert.deepEqual(state.chrome.removed, [3]);
    assert.equal(state.chrome.urls.get(99), 'https://user-tab.example/');
    assert.equal(
      state.chrome.commands.some(
        (row) => row.method.startsWith('Browser.') || row.method.startsWith('Storage.'),
      ),
      false,
    );
  } finally {
    await browser?.close();
    await relay.close();
  }
});

test('fixture kernel ownership blocks legacy commands/resume and is released only by the matching owner', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-kernel-owner-'));
  const store = new Store(path.join(directory, 'journal.sqlite'));
  const core = new Core(store);
  try {
    const id = randomUUID();
    store.pair(id, 'fixture-only-secret', 'a'.repeat(32));
    const peer = core.connect(
      id,
      () => {},
      () => {},
    );
    peer.synced = true;
    peer.phase = 'PAUSED';
    const owner = randomUUID();
    await core.claimFixtureKernel(peer, owner);
    await assert.rejects(async () => await core.resume(id), /KERNEL_PROFILE_BUSY/);
    await assert.rejects(
      async () =>
        await core.submit({
          profileId: id,
          operationId: randomUUID(),
          action: { kind: 'observe', tabId: 1 },
        }),
      /KERNEL_PROFILE_BUSY/,
    );
    core.releaseFixtureKernel(peer, randomUUID());
    await assert.rejects(async () => await core.resume(id), /KERNEL_PROFILE_BUSY/);
    core.releaseFixtureKernel(peer, owner);
    assert.equal((await core.resume(id)).accepted, true);
  } finally {
    await core.shutdown();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a prepared legacy read blocks kernel ownership until its queue settles', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-kernel-queued-'));
  const store = new Store(path.join(directory, 'journal.sqlite'));
  const core = new Core(store);
  try {
    const id = randomUUID();
    store.pair(id, 'fixture-only-secret', 'a'.repeat(32));
    const peer = core.connect(
      id,
      () => {},
      () => {},
    );
    peer.synced = true;
    peer.phase = 'PAUSED';
    await core.submit({
      profileId: id,
      operationId: randomUUID(),
      action: { kind: 'observe', tabId: 1 },
    });
    await assert.rejects(
      async () => await core.claimFixtureKernel(peer, randomUUID()),
      /KERNEL_PROFILE_NOT_IDLE/,
    );
    await core.stop(id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    peer.phase = 'PAUSED';
    await core.claimFixtureKernel(peer, randomUUID());
  } finally {
    await core.shutdown();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('extension channel processes STOP while a browser input is awaiting its result', async () => {
  const chrome = new SimulatedChrome();
  const state = setup();
  const replies: KernelJsonObject[] = [];
  const journal = new KernelJournal(new MemoryKernelStorage());
  await journal.initialize(state.lease.profileId, randomUUID());
  const channel = new ExtensionKernelChannel(
    () => ({ profileId: state.lease.profileId, epoch: state.lease.connectionEpoch, valid: true }),
    (message) => replies.push(JsonObjectSchema.parse(message)),
    () =>
      Object.assign(chrome, {
        owns: (tabId: number) => tabId !== 99 && chrome.urls.has(tabId),
        detached: (tabId: number) => {
          chrome.attached.delete(tabId);
        },
        expectedDetach: (_tabId: number) => false,
      }),
    journal,
  );
  let sequence = 0;
  const request = (body: Record<string, unknown>) => {
    const requestId = randomUUID();
    channel.receive({
      type: 'KERNEL_REQUEST',
      requestId,
      sequence: ++sequence,
      connectionEpoch: state.lease.connectionEpoch,
      leaseId: state.stamp.leaseId,
      ...body,
    });
    return requestId;
  };
  request({ kind: 'open', stamp: state.stamp, files: [] });
  request({ kind: 'create', url: fixtureURL });
  await new Promise<void>((resolve) => setImmediate(resolve));
  request({ kind: 'attach', tabId: 3 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  request({
    kind: 'beginOperation',
    binding: {
      profileId: state.lease.profileId,
      accountId: 'fixture-account',
      connectionEpoch: state.lease.connectionEpoch,
      leaseId: state.stamp.leaseId,
      generation: 0,
      operationId: randomUUID(),
      jobId: randomUUID(),
      stepId: randomUUID(),
      actionDigest: '0'.repeat(64),
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const block = deferred();
  chrome.inputBlock = block.promise;
  const input = request({
    kind: 'send',
    target: { tabId: 3 },
    method: 'Input.insertText',
    params: { text: 'pending' },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stop = request({ kind: 'stop' });
  const later = request({
    kind: 'send',
    target: { tabId: 3 },
    method: 'Input.insertText',
    params: { text: 'must-not-dispatch' },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(chrome.commands.length, 1);
  assert.equal(
    replies.some((reply) => reply.requestId === stop),
    false,
  );
  assert.match(
    String(replies.find((reply) => reply.requestId === later)?.error),
    /FENCED|NOT_OWNED|OPERATION_REQUIRED/,
  );
  const globalStop = channel.freeze();
  block.release();
  await globalStop;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(String(replies.find((reply) => reply.requestId === input)?.error), /FENCED/);
  const stopped = JsonObjectSchema.parse(replies.find((reply) => reply.requestId === stop)?.result);
  assert.equal(stopped.requestId, stop);
  assert.equal(stopped.state, 'stopped');
  assert.deepEqual(stopped.unresolvedMethods, ['Input.insertText']);
});

test('extension rejects an expired parent connection without executing a private request', async () => {
  const replies: KernelJsonObject[] = [];
  const state = setup();
  let created = 0;
  const channel = new ExtensionKernelChannel(
    () => ({ profileId: state.lease.profileId, epoch: state.lease.connectionEpoch, valid: false }),
    (message) => replies.push(JsonObjectSchema.parse(message)),
    () => {
      created++;
      throw Error('UNEXPECTED_BACKEND_CREATION');
    },
  );
  channel.receive({
    type: 'KERNEL_REQUEST',
    requestId: randomUUID(),
    sequence: 1,
    connectionEpoch: state.lease.connectionEpoch,
    leaseId: state.stamp.leaseId,
    kind: 'open',
    stamp: state.stamp,
    files: [],
  });
  assert.equal(created, 0);
  assert.equal(replies[0]?.error, 'KERNEL_CONTEXT_REJECTED');
});

test('a cleanly stopped extension session can reopen on the same connection and rejects the old lease', async () => {
  const chrome = new SimulatedChrome();
  const state = setup();
  const replies: KernelJsonObject[] = [];
  const channel = new ExtensionKernelChannel(
    () => ({ profileId: state.lease.profileId, epoch: state.lease.connectionEpoch, valid: true }),
    (message) => replies.push(JsonObjectSchema.parse(message)),
    () =>
      Object.assign(chrome, {
        owns: (tabId: number) => tabId !== 99 && chrome.urls.has(tabId),
        detached: (tabId: number) => {
          chrome.attached.delete(tabId);
        },
        expectedDetach: (_tabId: number) => false,
      }),
  );
  let sequence = 0;
  const send = (leaseId: string, body: Record<string, unknown>) => {
    const requestId = randomUUID();
    channel.receive({
      type: 'KERNEL_REQUEST',
      requestId,
      sequence: ++sequence,
      connectionEpoch: state.lease.connectionEpoch,
      leaseId,
      ...body,
    });
    return requestId;
  };
  send(state.stamp.leaseId, { kind: 'open', stamp: state.stamp, files: [] });
  send(state.stamp.leaseId, { kind: 'stop' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const nextStamp = { ...state.stamp, leaseId: randomUUID(), expiresAt: Date.now() + 10_000 };
  const next = send(nextStamp.leaseId, { kind: 'open', stamp: nextStamp, files: [] });
  send(nextStamp.leaseId, { kind: 'create', url: fixtureURL });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    JsonObjectSchema.parse(replies.find((reply) => reply.requestId === next)?.result).opened,
    true,
  );
  const stale = send(state.stamp.leaseId, {
    kind: 'send',
    target: { tabId: 3 },
    method: 'Input.insertText',
    params: { text: 'old-session' },
  });
  assert.equal(
    replies.find((reply) => reply.requestId === stale)?.error,
    'KERNEL_LEASE_NOT_CURRENT',
  );
  assert.equal(chrome.commands.length, 0);
  await channel.freeze();
});
