import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import vm from 'node:vm';
import { TaskRendering } from '../extension/task-rendering.js';
import { ChromeKernelBackend, isBenignDetachError } from '../extension/kernel-backend.js';
import { ExtensionKernelChannel } from '../extension/kernel-channel.js';
import { KernelExecutor } from '../src/application/kernel-executor.js';
import { KernelLease } from '../src/domain/kernel-lease.js';
import { KernelJournal } from '../src/application/kernel-journal.js';
import { MemoryKernelStorage } from './fixtures/kernel-storage.js';
import { Core } from '../src/bridge/core.js';
import { Store } from '../src/bridge/store.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const never = () => new Promise<void>(() => {});

test('WO50-1: rendering release is bounded; forgotten startup/release cannot disable a replacement', async () => {
  const start = deferred();
  const calls: string[] = [];
  const rendering = new TaskRendering(async (_target, method, params) => {
    calls.push(method + ':' + String(params.enabled));
    if (params.enabled === true && calls.length === 1) await start.promise;
  });
  const first = rendering.ensure(7, 'old', () => {}).catch(() => {});
  assert.equal(await rendering.release(7, 10), false);
  await rendering.ensure(7, 'new', () => {});
  const count = calls.length;
  start.resolve();
  await first;
  await tick();
  assert.equal(calls.length, count, 'old startup must not issue its lifecycle command');
  rendering.forget(7);
  const stop = deferred();
  const second = new TaskRendering(async (_target, method, params) => {
    if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === false)
      await stop.promise;
  });
  await second.ensure(7, 'old', () => {});
  const releasing = second.release(7, 200);
  await tick();
  second.forget(7);
  await second.ensure(7, 'new', () => {});
  assert.equal(await releasing, false);
  await second.ensure(7, 'new', () => {}); // Old release must not forget the new capture.
  stop.resolve();
  second.forget(7);
});

test('WO50-2: backend detach does not wait for rendering; failed/timeout detach remains tracked', async () => {
  const original = Reflect.get(globalThis, 'chrome');
  let fail = false,
    hang = false,
    detached = 0;
  Reflect.set(globalThis, 'chrome', {
    debugger: {
      sendCommand: never,
      detach: async () => {
        detached++;
        if (fail) throw Error('Cannot access target');
        if (hang) await never();
      },
    },
  });
  try {
    const journal = new KernelJournal(new MemoryKernelStorage());
    await journal.initialize(randomUUID(), randomUUID());
    const backend = new ChromeKernelBackend(journal);
    const attached = Reflect.get(backend, 'attached') as Map<number, string>;
    const owned = Reflect.get(backend, 'owned') as Map<number, object>;
    owned.set(7, {});
    attached.set(7, 'target');
    const starting = backend.rendering.ensure(7, 'target', () => {}).catch(() => {});
    void starting;
    await backend.detach(7, 10);
    assert.equal(detached, 1);
    assert.equal(attached.has(7), false);
    attached.set(7, 'target');
    fail = true;
    await assert.rejects(backend.detach(7, 10), /Cannot access/);
    assert.equal(attached.has(7), true);
    fail = false;
    hang = true;
    await assert.rejects(backend.detach(7, 10), /DEBUGGER_DETACH_TIMEOUT/);
    assert.equal(attached.has(7), true);
    assert.equal(isBenignDetachError(Error('Cannot access target')), false);
  } finally {
    Reflect.set(globalThis, 'chrome', original);
  }
});

async function channelFixture() {
  const profileId = randomUUID(),
    epoch = randomUUID();
  const journal = new KernelJournal(new MemoryKernelStorage());
  await journal.initialize(profileId, epoch);
  const output: Record<string, unknown>[] = [];
  const channel = new ExtensionKernelChannel(
    () => ({ profileId, epoch, valid: true }),
    (m) => output.push(m as Record<string, unknown>),
    undefined,
    journal,
  );
  const executor = new KernelExecutor(
    new KernelLease(profileId, epoch),
    {
      attach: async () => {
        throw Error('UNUSED');
      },
      detach: async () => {},
      create: async () => ({ tabId: 7 }),
      scope: async () => {},
      remove: async () => {},
      send: async () => ({}),
    },
    [],
  );
  Reflect.set(channel, 'executor', executor);
  return { channel, executor, journal, output };
}
const fast = {
  previousTimeoutMs: 10,
  journalTimeoutMs: 10,
  releaseTimeoutMs: 10,
  stopTimeoutMs: 20,
};
test('WO50-3/4: quiesce and window/business cleanup timeout stay unconfirmed; never emit STOPPED', async () => {
  const s = await channelFixture();
  s.channel.rendering = new TaskRendering(never);
  const pending = s.channel.rendering.ensure(7, 'test', () => {}).catch(() => {});
  void pending;
  const result = await s.channel.stopExecutor(randomUUID(), false, fast);
  assert.equal(result.state, 'unconfirmed');
  assert.ok(result.unresolvedMethods.includes('TaskRendering.release'));
  assert.equal(s.channel.isStopUnconfirmed(), true);
  const t = await channelFixture();
  Reflect.set(Reflect.get(t.channel, 'windows'), 'drain', never);
  (Reflect.get(t.channel, 'businessPending') as Set<Promise<unknown>>).add(never());
  assert.equal((await t.channel.control({ type: 'STOP' }, fast)).state, 'unconfirmed');
  assert.equal(
    t.output.some((m) => m.type === 'STOPPED'),
    false,
  );
  assert.equal(t.output.at(-1)?.type, 'STOP_UNCONFIRMED');
});

test('WO50-6: real control timeout consumes timer and recovery reload is still fenced by owners', async () => {
  const store = new Store(':memory:');
  const core = new Core(store, 10);
  const messages: Record<string, unknown>[] = [];
  const peer = core.connect(
    randomUUID(),
    (m) => messages.push(m as Record<string, unknown>),
    () => {},
  );
  peer.phase = 'PAUSED';
  peer.synced = true;
  try {
    await core.stop(peer.profileId);
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(core.stoppingControllers.has(peer.profileId), false);
    assert.equal(peer.error, 'STOP_CONFIRMATION_TIMEOUT');
    assert.equal((await core.reloadExtension(peer.profileId)).requested, true);
    assert.equal(messages.at(-1)?.type, 'RELOAD_EXTENSION');
    peer.phase = 'RECOVERING';
    peer.error = 'STOP_CONFIRMATION_TIMEOUT';
    (Reflect.get(core, 'kernelOwners') as Map<string, string>).set(peer.profileId, 'owner');
    assert.equal((await core.reloadExtension(peer.profileId)).requested, false);
  } finally {
    await core.disconnect(peer);
    store.close();
  }
});

test('WO50-10: journal/previous stop cannot postpone detach, and unconfirmed input stays fenced', async () => {
  const s = await channelFixture();
  let calls = 0;
  Reflect.set(s.channel, 'activeOperation', {});
  Reflect.set(s.channel, 'stoppingRpc', never());
  Reflect.set(s.journal, 'finish', () => {
    calls++;
    return never();
  });
  let detachStarted = false;
  Reflect.set(s.executor, 'forceDetachAll', async () => {
    detachStarted = true;
  });
  const result = s.channel.stopExecutor(randomUUID(), true, fast);
  assert.equal(detachStarted, true);
  const evidence = await result;
  assert.equal(calls, 1);
  assert.equal(evidence.state, 'unconfirmed');
  assert.ok(evidence.unresolvedMethods.includes('KernelJournal.finish'));
  assert.ok(evidence.unresolvedMethods.includes('PreviousStop'));
  assert.throws(() => s.executor.lease.check(), /KERNEL_FENCED/);
  const retry = await s.channel.stopExecutor(randomUUID(), true, fast);
  assert.equal(
    retry.state,
    'unconfirmed',
    'another STOP must not forget an unfinished prior journal write',
  );
  assert.ok(retry.unresolvedMethods.includes('KernelJournal.finish'));
});

// Bundle the actual worker, appending test-only lexical access. No test hooks ship in the extension.
let workerCode: Promise<string> | undefined;
async function workerHarness() {
  workerCode ??= (async () => {
    const source = (await readFile('extension/worker.ts', 'utf8'))
      .replace('defaultFreezeTimeoutMs = 8_000', 'defaultFreezeTimeoutMs = 20')
      .replace('welcomeFreezeTimeoutMs = 5_000', 'welcomeFreezeTimeoutMs = 20')
      .replace('disconnectFreezeTimeoutMs = 5_000', 'disconnectFreezeTimeoutMs = 20')
      .replace('reloadFreezeTimeoutMs = 1_500', 'reloadFreezeTimeoutMs = 20');
    const result = await build({
      stdin: {
        contents:
          source +
          `
globalThis.wo50 = {
  freeze, attached, frames, commands,
  get state() { return {epoch, kernelStopUnconfirmed, stopping, freezing: !!freezing, reloadingExtension}; },
  setKernel(value) { kernel = value; },
  replace(epochValue) { ++freezeSerial; ++connectionSerial; epoch = epochValue; kernel = createChannel(epoch); },
  prepared(epochValue) { epoch = epochValue; paused = true; stopping = false; kernelStopUnconfirmed = false; connectionStage = 'ready'; leaseUntil = Date.now()+10000; },
};`,
        resolveDir: process.cwd() + '/extension',
        loader: 'ts',
      },
      bundle: true,
      write: false,
      format: 'iife',
      define: { __BUNDLED_EXTENSION_VERSION__: JSON.stringify('0.3.73') },
      platform: 'browser',
      logLevel: 'silent',
    });
    return result.outputFiles[0]!.text;
  })();
  const sockets: FakeSocket[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const callbacks = () => ({ addListener: () => {} });
  let detach: () => Promise<void> = async () => {};
  let reloads = 0;
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    sent: Record<string, unknown>[] = [];
    onmessage?: (e: { data: string }) => void;
    onclose?: (e: { reason: string }) => void;
    onerror?: () => void;
    constructor(_url: string) {
      sockets.push(this);
    }
    send(value: string) {
      this.sent.push(JSON.parse(value) as Record<string, unknown>);
    }
    close(_code?: number, reason = '') {
      this.readyState = 3;
      this.onclose?.({ reason });
    }
    message(value: object) {
      this.onmessage?.({ data: JSON.stringify(value) });
    }
  }
  const context = vm.createContext({
    console,
    crypto: webcrypto,
    URL,
    performance,
    structuredClone,
    TextEncoder,
    TextDecoder,
    WebSocket: FakeSocket,
    setTimeout: (fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      timers.add(t);
      return t;
    },
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    chrome: {
      storage: {},
      debugger: { detach: () => detach(), onEvent: callbacks(), onDetach: callbacks() },
      tabs: { onRemoved: callbacks(), onActivated: callbacks() },
      windows: { getAll: async () => [{ id: 1 }], onCreated: callbacks(), onRemoved: callbacks() },
      runtime: {
        id: 'test',
        getManifest: () => ({ version: '0.3.70' }),
        onMessage: callbacks(),
        onStartup: callbacks(),
        reload: () => {
          reloads++;
        },
      },
      alarms: { onAlarm: callbacks(), create: async () => {} },
    },
  });
  vm.runInContext(await workerCode, context);
  await tick();
  await tick();
  type Hooks = {
    freeze(reason: string, options?: { timeoutMs: number }): Promise<void>;
    attached: Set<number>;
    frames: Map<string, object>;
    commands: { drainWrites(): Promise<void> };
    state: {
      epoch: string;
      kernelStopUnconfirmed: boolean;
      stopping: boolean;
      freezing: boolean;
      reloadingExtension: boolean;
    };
    setKernel(value: object): void;
    replace(value: string): void;
    prepared(value: string): void;
  };
  const api = context.wo50 as Hooks;
  return {
    api,
    sockets,
    get reloads() {
      return reloads;
    },
    setDetach(fn: () => Promise<void>) {
      detach = fn;
    },
    cleanup() {
      for (const timer of timers) clearTimeout(timer);
    },
  };
}

test('WO50-7/8: actual worker detaches before hung writes, bounds freeze, and ignores late old cleanup', async () => {
  const h = await workerHarness();
  try {
    const pending = deferred();
    let detached = 0;
    h.api.setKernel({ freeze: async () => {}, isStopUnconfirmed: () => false });
    h.api.commands.drainWrites = () => pending.promise;
    h.api.prepared(randomUUID());
    h.api.attached.add(7);
    const late = deferred();
    h.setDetach(() => {
      detached++;
      return late.promise;
    });
    const result = h.api.freeze('TEST', { timeoutMs: 10 });
    assert.equal(detached, 1);
    await assert.rejects(result, /KERNEL_STOP_UNCONFIRMED/);
    assert.equal(h.api.attached.has(7), true);
    h.api.replace(randomUUID());
    h.api.attached.add(7);
    h.api.frames.set('new', {});
    late.resolve();
    pending.resolve();
    await tick();
    assert.equal(h.api.attached.has(7), true);
    assert.equal(h.api.frames.has('new'), true);
  } finally {
    h.cleanup();
  }
});

test('WO50-4/5: actual worker STOP never confirms failed freeze; reload bypasses inbox and resets after stale request', async () => {
  const h = await workerHarness();
  try {
    const ws = h.sockets[0]!;
    assert.ok(ws);
    const epoch = randomUUID();
    h.api.prepared(epoch);
    h.api.setKernel({ freeze: never, isStopUnconfirmed: () => true });
    ws.message({ type: 'STOP', requestId: randomUUID(), connectionEpoch: epoch });
    ws.message({ type: 'RELOAD_EXTENSION', requestId: randomUUID(), connectionEpoch: epoch });
    ws.message({ type: 'RELOAD_EXTENSION', requestId: randomUUID(), connectionEpoch: epoch });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(h.reloads, 1);
    assert.equal(
      ws.sent.some((m) => m.type === 'STOP_UNCONFIRMED'),
      true,
    );
    assert.equal(
      ws.sent.some((m) => m.type === 'STOPPED'),
      false,
    );
    assert.equal(ws.sent.filter((m) => m.type === 'EXTENSION_RELOADING').length, 1);
  } finally {
    h.cleanup();
  }
  const t = await workerHarness();
  try {
    const ws = t.sockets[0]!;
    const oldEpoch = randomUUID();
    t.api.prepared(oldEpoch);
    t.api.setKernel({ freeze: never, isStopUnconfirmed: () => true });
    ws.message({ type: 'RELOAD_EXTENSION', requestId: randomUUID(), connectionEpoch: oldEpoch });
    t.api.prepared(randomUUID());
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(t.reloads, 0);
    assert.equal(t.api.state.reloadingExtension, false);
    ws.message({
      type: 'RELOAD_EXTENSION',
      requestId: randomUUID(),
      connectionEpoch: t.api.state.epoch,
    });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(t.reloads, 1);
  } finally {
    t.cleanup();
  }
});

test('WO50-9: actual worker disconnect schedules reconnect despite hung writes and preserves unconfirmed fence', async () => {
  const h = await workerHarness();
  try {
    const ws = h.sockets[0]!;
    h.api.prepared(randomUUID());
    h.api.commands.drainWrites = never;
    h.api.setKernel({ freeze: never, isStopUnconfirmed: () => true });
    ws.close();
    await new Promise((r) => setTimeout(r, 650));
    assert.ok(h.sockets.length >= 2);
    assert.equal(h.api.state.kernelStopUnconfirmed, true);
  } finally {
    h.cleanup();
  }
});

test('WO50: actual WELCOME keeps communication alive but blocks SYNC/RESUME after unconfirmed old cleanup', async () => {
  const h = await workerHarness();
  try {
    const ws = h.sockets[0]!;
    h.api.prepared(randomUUID());
    let abandoned = false;
    h.api.setKernel({
      freeze: never,
      isStopUnconfirmed: () => true,
      abandon: () => {
        abandoned = true;
      },
    });
    const epoch = randomUUID();
    ws.message({ type: 'WELCOME', connectionEpoch: epoch, leaseMs: 10000 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(abandoned, true);
    assert.equal(h.api.state.epoch, epoch);
    assert.equal(h.api.state.kernelStopUnconfirmed, true);
    ws.message({ type: 'SYNC', requestId: randomUUID(), connectionEpoch: epoch });
    ws.message({ type: 'RESUME', requestId: randomUUID(), connectionEpoch: epoch });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ws.readyState, 1);
    assert.equal(
      ws.sent.some((m) => m.type === 'SYNC_STATE' || m.type === 'RESUMED'),
      false,
    );
    ws.message({ type: 'RELOAD_EXTENSION', requestId: randomUUID(), connectionEpoch: epoch });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.reloads, 1);
  } finally {
    h.cleanup();
  }
});

test('WO51: actual worker HELLO and reload acknowledge bundled version despite newer manifest metadata', async () => {
  const h = await workerHarness();
  try {
    const ws = h.sockets[0]!;
    ws.message({ type: 'CHALLENGE', version: 2, challenge: 'fixture', capabilities: [] });
    await tick();
    await tick();
    const hello = ws.sent.find((m) => m.type === 'HELLO');
    assert.ok(hello);
    assert.equal(hello.extensionVersion, '0.3.73');
    h.api.prepared(randomUUID());
    h.api.setKernel({ freeze: async () => {}, isStopUnconfirmed: () => false });
    ws.message({
      type: 'RELOAD_EXTENSION',
      requestId: randomUUID(),
      connectionEpoch: h.api.state.epoch,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(ws.sent.find((m) => m.type === 'EXTENSION_RELOADING')?.extensionVersion, '0.3.73');
  } finally {
    h.cleanup();
  }
});
