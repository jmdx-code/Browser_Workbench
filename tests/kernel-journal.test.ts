import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { KernelJournal } from '../src/application/kernel-journal.js';
import { MemoryKernelStorage } from './fixtures/kernel-storage.js';
import { KernelPersistentState, type TabProof } from '../src/shared/kernel-state.js';
import type { Binding } from '../src/shared/task-execution.js';
import { ChromeKernelBackend } from '../extension/kernel-backend.js';
import { ExtensionKernelChannel } from '../extension/kernel-channel.js';
import { KernelJsonObject } from '../src/shared/kernel-protocol.js';
import { digestAction } from '../extension/journal.js';

const url = 'http://127.0.0.1:18767/kernel-fixture';
function binding(profileId: string): Binding {
  return {
    profileId,
    accountId: 'fixture-account',
    connectionEpoch: randomUUID(),
    leaseId: randomUUID(),
    generation: 0,
    operationId: randomUUID(),
    jobId: randomUUID(),
    stepId: randomUUID(),
    actionDigest: '0'.repeat(64),
  };
}
async function fixture() {
  const storage = new MemoryKernelStorage(),
    profileId = randomUUID(),
    epoch = randomUUID();
  const journal = new KernelJournal(storage);
  await journal.initialize(profileId, epoch);
  return { storage, profileId, epoch, journal, operation: binding(profileId) };
}
function proof(
  profileId: string,
  browserSessionEpoch: string,
  ownershipId = randomUUID(),
): TabProof {
  return { profileId, browserSessionEpoch, ownershipId, tabId: 7, targetId: 'native-target-7' };
}
test('operation is saved before input, same ID never starts twice, and changed content conflicts', async () => {
  const { journal, storage, operation } = await fixture();
  assert.equal((await journal.begin(operation)).fresh, true);
  assert.equal(KernelPersistentState.parse(storage.value).operations[0]?.state, 'DISPATCHING');
  assert.equal((await journal.begin(operation)).fresh, false);
  await assert.rejects(
    journal.begin({ ...operation, actionDigest: '1'.repeat(64) }),
    /ID_CONFLICT/,
  );
  await journal.finish(operation, 'ACKNOWLEDGED');
  assert.equal((await journal.begin(operation)).fresh, false);
  assert.equal((await journal.snapshot()).operations[0]?.state, 'ACKNOWLEDGED');
});
test('concurrent preparations cannot race past the single unresolved operation', async () => {
  const { journal, operation } = await fixture();
  const results = await Promise.allSettled([
    journal.begin(operation),
    journal.begin({ ...operation, operationId: randomUUID() }),
  ]);
  assert.equal(results.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal((await journal.snapshot()).operations.length, 1);
});
test('worker restart preserves uncertainty and refuses late ACK and new input rather than replaying', async () => {
  const { journal, storage, operation, profileId, epoch } = await fixture();
  await journal.begin(operation);
  const restarted = new KernelJournal(storage);
  await restarted.initialize(profileId, epoch);
  assert.equal((await restarted.snapshot()).operations[0]?.state, 'UNKNOWN');
  assert.equal((await restarted.begin(operation)).fresh, false);
  await assert.rejects(restarted.finish(operation, 'ACKNOWLEDGED'), /LATE_ACK/);
  await assert.rejects(
    restarted.begin({ ...operation, operationId: randomUUID() }),
    /REVIEW_REQUIRED/,
  );
});
test('failed storage write fails closed and cannot let cached state authorize input', async () => {
  const { journal, storage, operation } = await fixture();
  storage.fail = true;
  await assert.rejects(journal.begin(operation), /STORAGE_FAILURE/);
  assert.equal(journal.writable, false);
  storage.fail = false;
  await assert.rejects(journal.begin(operation), /NOT_READY/);
  assert.equal(KernelPersistentState.parse(storage.value).operations.length, 0);
});
test('foreign profile and future journal version refuse initialization without overwriting stored data', async () => {
  const { storage, profileId, epoch } = await fixture();
  const before = structuredClone(storage.value);
  await assert.rejects(
    new KernelJournal(storage).initialize(randomUUID(), epoch),
    /PROFILE_MISMATCH/,
  );
  assert.deepEqual(storage.value, before);
  storage.value = { ...KernelPersistentState.parse(before), version: 99 };
  await assert.rejects(new KernelJournal(storage).initialize(profileId, epoch));
  assert.equal(Reflect.get(storage.value as object, 'version'), 99);
});
test('creation reservation persists; interrupted creation stays unknown and cannot silently recreate', async () => {
  const { journal, storage, profileId, epoch } = await fixture();
  const id = randomUUID();
  await journal.prepareTab(id, url);
  assert.equal(KernelPersistentState.parse(storage.value).tabs[0]?.state, 'CREATING');
  const restarted = new KernelJournal(storage);
  await restarted.initialize(profileId, epoch);
  assert.equal((await restarted.snapshot()).tabs[0]?.state, 'UNKNOWN');
  await assert.rejects(restarted.prepareTab(id, url), /ALREADY_RECORDED/);
  await assert.rejects(restarted.prepareTab(randomUUID(), url), /REVIEW_REQUIRED/);
});
test('worker restart retains tab proof but extension reload or browser restart invalidates the session without erasing proof', async () => {
  const { journal, storage, profileId, epoch } = await fixture();
  const owned = proof(profileId, epoch);
  await journal.prepareTab(owned.ownershipId, url);
  await journal.confirmTab(owned);
  const worker = new KernelJournal(storage);
  await worker.initialize(profileId, epoch);
  assert.equal((await worker.snapshot()).tabs[0]?.state, 'READY');
  const reloaded = new KernelJournal(storage);
  await reloaded.initialize(profileId, randomUUID());
  assert.equal((await reloaded.snapshot()).tabs[0]?.state, 'LOST');
  assert.deepEqual((await reloaded.snapshot()).tabs[0]?.proof, owned);
});
test('operation uncertainty survives browser session changes independently of task tab status', async () => {
  const { journal, storage, operation, profileId } = await fixture();
  await journal.begin(operation);
  const restarted = new KernelJournal(storage);
  await restarted.initialize(profileId, randomUUID());
  assert.deepEqual((await restarted.snapshot()).operations[0]?.binding, operation);
  assert.equal((await restarted.snapshot()).operations[0]?.state, 'UNKNOWN');
});

test('explicit reconciliation preserves the original summary, is idempotent, and rejects conflicting resolution', async () => {
  const { journal, operation } = await fixture();
  await journal.begin(operation);
  await journal.finish(operation, 'UNKNOWN', 'DISCONNECTED');
  const resolution = {
    id: randomUUID(),
    outcome: 'NOT_APPLIED' as const,
    evidenceDigest: '1'.repeat(64),
  };
  await journal.reconcile(operation, resolution);
  await journal.reconcile(operation, resolution);
  const record = (await journal.snapshot()).operations[0];
  assert.equal(record?.state, 'RECONCILED');
  assert.deepEqual(record?.binding, operation);
  assert.equal(record?.reason, 'DISCONNECTED');
  await assert.rejects(
    journal.reconcile(operation, { ...resolution, outcome: 'VERIFIED' }),
    /CONFLICT/,
  );
  assert.equal((await journal.begin(operation)).fresh, false);
  const second = { ...operation, operationId: randomUUID() };
  assert.equal((await journal.begin(second)).fresh, true);
  await journal.finish(second, 'ACKNOWLEDGED');
  await journal.reconcile(second, { ...resolution, id: randomUUID() });
  assert.equal((await journal.snapshot()).operations[1]?.state, 'RECONCILED');
});

async function nativeFixture(
  run: (
    state: Awaited<ReturnType<typeof fixture>>,
    backend: ChromeKernelBackend,
    native: { creates: number; attaches: number; targetId: string; inputCalls: number },
  ) => Promise<void>,
) {
  const state = await fixture();
  const native = { creates: 0, attaches: 0, targetId: 'native-target-7', inputCalls: 0 };
  const original: unknown = Reflect.get(globalThis, 'chrome');
  const values: Record<string, unknown> = {};
  let groupId = -1;
  Reflect.set(globalThis, 'chrome', {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: values[key] }),
        set: async (next: object) => Object.assign(values, next),
      },
    },
    tabGroups: { update: async () => ({}) },
    tabs: {
      get: async (id: number) => ({ id, windowId: 8, groupId }),
      group: async () => {
        groupId = 7;
        return groupId;
      },
      create: async () => {
        native.creates++;
        assert.equal(KernelPersistentState.parse(state.storage.value).tabs[0]?.state, 'CREATING');
        return { id: 7 };
      },
      remove: async () => {},
    },
    debugger: {
      getTargets: async () => [
        { id: native.targetId, tabId: 7, type: 'page', url, attached: false },
      ],
      attach: async () => {
        native.attaches++;
      },
      detach: async () => {},
      sendCommand: async (_target: unknown, method: string) => {
        if (method.startsWith('Input.')) native.inputCalls++;
        return {
          targetInfo: {
            targetId: native.targetId,
            type: 'page',
            url,
            title: 'Fixture',
            attached: true,
          },
        };
      },
    },
  });
  try {
    await run(state, new ChromeKernelBackend(state.journal, () => false), native);
  } finally {
    Reflect.set(globalThis, 'chrome', original);
  }
}

test('presentation recovers a lost stream during ACK verification, re-arms a hidden native page, and STOP revokes recovery', async () => {
  await nativeFixture(async ({ journal, operation }) => {
    const native = Reflect.get(globalThis, 'chrome') as object;
    const tabs = Reflect.get(native, 'tabs') as object;
    const debug = Reflect.get(native, 'debugger') as object;
    const facebook = 'https://www.facebook.com/';
    let active: Binding | undefined = operation,
      live = true,
      failAck = false,
      starts = 0;
    const writes: unknown[] = [];
    Reflect.set(tabs, 'get', async () => ({
      id: 7,
      windowId: 9,
      groupId: 7,
      active: true,
      url: facebook,
    }));
    Reflect.set(tabs, 'update', async (_id: number, value: unknown) => {
      writes.push(value);
    });
    Reflect.set(native, 'windows', {
      getAll: async () => [],
      get: async () => ({ state: 'normal' }),
      update: async () => {
        throw Error('MUST_NOT_FOCUS_WINDOW');
      },
    });
    Reflect.set(debug, 'getTargets', async () => [
      { id: 'native-target-7', tabId: 7, type: 'page', url: facebook },
    ]);
    Reflect.set(debug, 'sendCommand', async (_target: unknown, method: string) => {
      if (method === 'Page.startScreencast') starts++;
      if (method === 'Page.screencastFrameAck' && failAck) throw Error('TRANSIENT_ACK_ERROR');
      if (method === 'Runtime.evaluate') return { result: { value: 'hidden' } };
      return {
        targetInfo: {
          targetId: 'native-target-7',
          type: 'page',
          url: facebook,
          title: '',
          attached: true,
        },
      };
    });
    const backend = new ChromeKernelBackend(
      journal,
      () => live && !!active,
      'facebook-task',
      () => live,
      () => active,
    );
    await backend.create(facebook);
    await backend.attach(7);
    await journal.begin(operation);
    await backend.send({ tabId: 7 }, 'Page.bringToFront', {});
    assert.equal(starts, 1);
    active = undefined; // Verification has read permission but no permission to replay business input.
    failAck = true;
    backend.consumeRendering({ tabId: 7 }, 'Page.screencastFrame', { sessionId: 1 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    failAck = false;
    backend.maintainPresentation();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(starts, 3); // Lost capture restarted, then hidden-page refresh.
    live = false;
    await backend.releaseRendering();
    backend.maintainPresentation();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(starts, 3);
    assert.deepEqual(writes, [{ active: true }]);
  });
});
test('native backend records creation before Chrome and same-URL user tab is never adopted by guessing', async () => {
  await nativeFixture(async ({ journal, profileId, epoch }, backend, native) => {
    await assert.rejects(backend.scope(7), /NOT_OWNED/);
    await assert.rejects(backend.adopt(proof(profileId, epoch)), /ADOPTION_REJECTED/);
    assert.equal(native.attaches, 0);
    await backend.create(url);
    assert.equal(native.creates, 1);
    assert.equal((await journal.snapshot()).tabs[0]?.state, 'READY');
  });
});
test('a new backend needs explicit exact proof and performs no attachment during ownership reconciliation', async () => {
  await nativeFixture(async ({ journal }, backend, native) => {
    await backend.create(url);
    const owned = (await journal.snapshot()).tabs[0]?.proof;
    assert.ok(owned);
    const restored = new ChromeKernelBackend(journal);
    assert.equal(restored.owns(7), false);
    await restored.adopt(owned);
    assert.equal(restored.owns(7), true);
    assert.equal(native.attaches, 0);
    await assert.rejects(restored.adopt({ ...owned, targetId: 'different' }), /ADOPTION_REJECTED/);
  });
});
test('reused tab ID with a different native target is rejected before any attachment or input', async () => {
  await nativeFixture(async ({ journal }, backend, native) => {
    await backend.create(url);
    native.targetId = 'reused-tab-different-target';
    await assert.rejects(backend.attach(7), /IDENTITY_CHANGED/);
    assert.equal(native.attaches, 0);
    assert.equal(native.inputCalls, 0);
    assert.equal((await journal.snapshot()).tabs[0]?.state, 'LOST');
  });
});

test('cleanup closes only the exact owned target after a foreign URL, while read scope and reused IDs remain rejected', async () => {
  await nativeFixture(async ({ journal }, backend, native) => {
    await backend.create(url);
    const nativeChrome: unknown = Reflect.get(globalThis, 'chrome');
    assert.ok(nativeChrome && typeof nativeChrome === 'object');
    const debug: unknown = Reflect.get(nativeChrome, 'debugger');
    assert.ok(debug && typeof debug === 'object');
    Reflect.set(debug, 'getTargets', async () => [
      { id: native.targetId, tabId: 7, type: 'page', url: 'https://example.com/' },
    ]);
    await assert.rejects(backend.scope(7), /SCOPE_CHANGED/);
    await backend.scopeForClose(7);
    await backend.remove(7);
    assert.equal((await journal.snapshot()).tabs[0]?.state, 'CLOSED');
    assert.equal(native.inputCalls, 0);
  });
  await nativeFixture(async ({ journal }, backend, native) => {
    await backend.create(url);
    native.targetId = 'reused-target';
    await assert.rejects(backend.scopeForClose(7), /IDENTITY_CHANGED/);
    assert.equal((await journal.snapshot()).tabs[0]?.state, 'LOST');
    assert.equal(native.inputCalls, 0);
  });
});
test('native creation is not called when its reservation fails to persist', async () => {
  await nativeFixture(async ({ storage }, backend, native) => {
    storage.fail = true;
    await assert.rejects(backend.create(url), /STORAGE_FAILURE/);
    assert.equal(native.creates, 0);
  });
});
test('even an attached native backend refuses input without an active persisted operation', async () => {
  await nativeFixture(async (_state, backend, native) => {
    await backend.create(url);
    await backend.attach(7);
    await assert.rejects(
      backend.send({ tabId: 7 }, 'Input.insertText', { text: 'blocked' }),
      /OPERATION_REQUIRED/,
    );
    assert.equal(native.inputCalls, 0);
  });
});

test('only the exact explicit activation focuses its owned window; ordinary input preserves focus and window geometry', async () => {
  for (const focused of [true, false])
    for (const kind of ['activate', 'other-tab', 'scroll', 'unbound'] as const)
      for (const state of ['minimized', 'maximized', 'normal'] as const)
        await nativeFixture(async ({ journal, operation }, _backend) => {
          const native: unknown = Reflect.get(globalThis, 'chrome');
          assert.ok(native && typeof native === 'object');
          const tabs: unknown = Reflect.get(native, 'tabs');
          assert.ok(tabs && typeof tabs === 'object');
          const writes: unknown[] = [];
          Reflect.set(tabs, 'get', async (id: number) => {
            assert.equal(id, 7);
            return { id, windowId: 9, groupId: 7 };
          });
          Reflect.set(tabs, 'update', async (id: number, value: unknown) => {
            writes.push(['tab', id, value]);
          });
          Reflect.set(native, 'windows', {
            getAll: async () => [{ id: 9, focused, type: 'normal' }],
            get: async (id: number) => {
              assert.equal(id, 9);
              return { id, state };
            },
            update: async (id: number, value: unknown) => {
              writes.push(['window', id, value]);
            },
          });
          const backend = new ChromeKernelBackend(
            journal,
            () => true,
            'facebook-task',
            () => true,
            () => (kind === 'unbound' ? undefined : operation),
          );
          const facebook = 'https://www.facebook.com/';
          const debug: unknown = Reflect.get(native, 'debugger');
          assert.ok(debug && typeof debug === 'object');
          Reflect.set(debug, 'getTargets', async () => [
            { id: 'native-target-7', tabId: 7, type: 'page', url: facebook },
          ]);
          Reflect.set(debug, 'sendCommand', async () => ({
            targetInfo: {
              targetId: 'native-target-7',
              type: 'page',
              url: facebook,
              title: '',
              attached: true,
            },
          }));
          await backend.create(facebook);
          await backend.attach(7);
          operation.actionDigest = await digestAction(
            kind === 'scroll'
              ? {
                  kind: 'browseScroll',
                  tabId: 7,
                  deltaY: 600,
                  fromY: 0,
                  documentEpoch: 0,
                  routeEpoch: 0,
                  url: facebook,
                  timeOrigin: 1,
                }
              : { kind: 'activateTab', tabId: kind === 'other-tab' ? 8 : 7 },
          );
          await journal.begin(operation);
          await backend.send({ tabId: 7 }, 'Page.bringToFront', {});
          assert.deepEqual(writes, [
            ...(state === 'minimized' && kind !== 'unbound'
              ? [['window', 9, { state: 'normal', focused: false }]]
              : []),
            ['tab', 7, { active: true }],
            ...(kind === 'activate' && focused ? [['window', 9, { focused: true }]] : []),
          ]);
          await assert.rejects(backend.send({ tabId: 8 }, 'Page.bringToFront', {}), /NOT_OWNED/);
        });
});

test('a live task stream restores its exact minimized window after operation ACK, and idle stop prevents further restoration', async () => {
  await nativeFixture(async ({ journal, operation }) => {
    const native = Reflect.get(globalThis, 'chrome') as object;
    const tabs = Reflect.get(native, 'tabs') as object;
    const debug = Reflect.get(native, 'debugger') as object;
    const facebook = 'https://www.facebook.com/';
    let activeOperation: Binding | undefined = operation;
    let alive = true;
    let minimized = false;
    const writes: unknown[] = [];
    Reflect.set(tabs, 'get', async () => ({
      id: 7,
      windowId: 9,
      groupId: 7,
      active: true,
      url: facebook,
    }));
    Reflect.set(tabs, 'update', async (id: number, value: unknown) => {
      writes.push(['tab', id, value]);
    });
    Reflect.set(native, 'windows', {
      getAll: async () => [],
      get: async () => ({ id: 9, state: minimized ? 'minimized' : 'normal' }),
      update: async (id: number, value: unknown) => {
        writes.push(['window', id, value]);
        minimized = false;
      },
    });
    Reflect.set(debug, 'getTargets', async () => [
      { id: 'native-target-7', tabId: 7, type: 'page', url: facebook },
    ]);
    Reflect.set(debug, 'sendCommand', async () => ({
      targetInfo: {
        targetId: 'native-target-7',
        type: 'page',
        url: facebook,
        title: '',
        attached: true,
      },
    }));
    const backend = new ChromeKernelBackend(
      journal,
      () => !!activeOperation && alive,
      'facebook-task',
      () => alive,
      () => activeOperation,
    );
    await backend.create(facebook);
    await backend.attach(7);
    await journal.begin(operation);
    await backend.send({ tabId: 7 }, 'Page.bringToFront', {});
    activeOperation = undefined;
    writes.length = 0;
    minimized = true;
    backend.maintainPresentation();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(writes, [['window', 9, { state: 'normal', focused: false }]]);
    alive = false;
    const stopping = backend.releaseRendering();
    minimized = true;
    writes.length = 0;
    backend.maintainPresentation();
    await stopping;
    assert.deepEqual(writes, []);
  });
});

test('stop or operation replacement during tab selection cannot focus a window afterward', async () => {
  for (const change of ['stop', 'replace'] as const)
    await nativeFixture(async ({ journal, operation }) => {
      const native = Reflect.get(globalThis, 'chrome') as object;
      const tabs = Reflect.get(native, 'tabs') as object;
      const debug = Reflect.get(native, 'debugger') as object;
      const facebook = 'https://www.facebook.com/';
      let allowed = true,
        current: Binding | undefined = operation,
        focusCalls = 0;
      Reflect.set(tabs, 'get', async () => ({ id: 7, windowId: 9, groupId: 7 }));
      Reflect.set(tabs, 'update', async () => {
        if (change === 'stop') allowed = false;
        else current = { ...operation, operationId: randomUUID() };
      });
      Reflect.set(native, 'windows', {
        get: async () => ({ id: 9, state: 'normal' }),
        update: async () => {
          focusCalls++;
        },
      });
      Reflect.set(debug, 'getTargets', async () => [
        { id: 'native-target-7', tabId: 7, type: 'page', url: facebook },
      ]);
      Reflect.set(debug, 'sendCommand', async () => ({
        targetInfo: {
          targetId: 'native-target-7',
          type: 'page',
          url: facebook,
          title: '',
          attached: true,
        },
      }));
      const backend = new ChromeKernelBackend(
        journal,
        () => allowed,
        'facebook-task',
        () => true,
        () => current,
      );
      await backend.create(facebook);
      await backend.attach(7);
      operation.actionDigest = await digestAction({ kind: 'activateTab', tabId: 7 });
      await journal.begin(operation);
      await assert.rejects(
        backend.send({ tabId: 7 }, 'Page.bringToFront', {}),
        /ACTIVATION_REVOKED/,
      );
      assert.equal(focusCalls, 0);
    });
});

test('stopping during activation window inspection prevents all subsequent native writes', async () => {
  await nativeFixture(async ({ journal, operation }, _backend) => {
    const native: unknown = Reflect.get(globalThis, 'chrome');
    assert.ok(native && typeof native === 'object');
    const tabs: unknown = Reflect.get(native, 'tabs'),
      debug: unknown = Reflect.get(native, 'debugger');
    assert.ok(tabs && typeof tabs === 'object' && debug && typeof debug === 'object');
    let allowed = true,
      writes = 0;
    Reflect.set(tabs, 'get', async () => ({ id: 7, windowId: 9, groupId: 7 }));
    Reflect.set(tabs, 'update', async () => {
      writes++;
    });
    Reflect.set(native, 'windows', {
      get: async () => {
        allowed = false;
        return { id: 9, state: 'minimized' };
      },
      update: async () => {
        writes++;
      },
    });
    const facebook = 'https://www.facebook.com/';
    Reflect.set(debug, 'getTargets', async () => [
      { id: 'native-target-7', tabId: 7, type: 'page', url: facebook },
    ]);
    Reflect.set(debug, 'sendCommand', async () => ({
      targetInfo: {
        targetId: 'native-target-7',
        type: 'page',
        url: facebook,
        title: '',
        attached: true,
      },
    }));
    const backend = new ChromeKernelBackend(
      journal,
      () => allowed,
      'facebook-task',
      () => true,
    );
    await backend.create(facebook);
    await backend.attach(7);
    await journal.begin(operation);
    await assert.rejects(backend.send({ tabId: 7 }, 'Page.bringToFront', {}), /ACTIVATION_REVOKED/);
    assert.equal(writes, 0);
  });
});

test('executor removal is identified before the native onRemoved callback and closed proof remains recorded', async () => {
  await nativeFixture(async ({ journal }, backend) => {
    await backend.create(url);
    const nativeChrome: unknown = Reflect.get(globalThis, 'chrome');
    assert.ok(nativeChrome && typeof nativeChrome === 'object');
    const tabs: unknown = Reflect.get(nativeChrome, 'tabs');
    assert.ok(tabs && typeof tabs === 'object');
    Reflect.set(tabs, 'remove', async (tabId: number) => {
      assert.equal(backend.expectedRemoval(tabId), true);
      backend.tabRemoved(tabId);
    });
    await backend.remove(7);
    assert.equal(backend.expectedRemoval(7), false);
    assert.equal(backend.owns(7), false);
    assert.equal((await journal.snapshot()).tabs[0]?.state, 'CLOSED');
  });
});

test('owned close handles only its pending main-page beforeunload once, without enabling general dialog input', async () => {
  await nativeFixture(async ({ journal }, _fixture, native) => {
    const nativeChrome: unknown = Reflect.get(globalThis, 'chrome');
    assert.ok(nativeChrome && typeof nativeChrome === 'object');
    const tabs: unknown = Reflect.get(nativeChrome, 'tabs'),
      debug: unknown = Reflect.get(nativeChrome, 'debugger');
    assert.ok(tabs && typeof tabs === 'object' && debug && typeof debug === 'object');
    const facebook = 'https://www.facebook.com/post/create';
    Reflect.set(debug, 'getTargets', async () => [
      { id: native.targetId, tabId: 7, type: 'page', url: facebook, attached: true },
    ]);
    let unblock: (() => void) | undefined;
    let removing = false;
    const wait = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    Reflect.set(tabs, 'remove', async () => {
      removing = true;
      await wait;
    });
    let accepts = 0;
    Reflect.set(debug, 'sendCommand', async (_source: unknown, method: string, params: unknown) => {
      if (method === 'Page.handleJavaScriptDialog') {
        assert.equal(removing, true);
        assert.deepEqual(params, { accept: true });
        accepts++;
        unblock?.();
      }
      return {
        targetInfo: {
          targetId: native.targetId,
          type: 'page',
          url: facebook,
          title: '',
          attached: true,
        },
      };
    });
    const backend = new ChromeKernelBackend(
      journal,
      () => false,
      'facebook-task',
      () => true,
    );
    await backend.create(facebook);
    await backend.attach(7);
    const event = { type: 'beforeunload', url: facebook };
    await backend.closingDialog({ tabId: 7 }, 'Page.javascriptDialogOpening', event);
    assert.equal(accepts, 0);
    const closing = backend.remove(7);
    while (!removing) await new Promise((resolve) => setImmediate(resolve));
    for (const [source, params] of [
      [{ tabId: 8 }, event],
      [{ tabId: 7, sessionId: 'child' }, event],
      [{ tabId: 7 }, { type: 'confirm', url: facebook }],
      [{ tabId: 7 }, { type: 'beforeunload', url: 'https://example.com' }],
    ] as const)
      await backend.closingDialog(source, 'Page.javascriptDialogOpening', params);
    assert.equal(accepts, 0);
    await assert.rejects(
      backend.send({ tabId: 7 }, 'Page.handleJavaScriptDialog', { accept: true }),
      /OPERATION_REQUIRED/,
    );
    await Promise.all([
      backend.closingDialog({ tabId: 7 }, 'Page.javascriptDialogOpening', event),
      backend.closingDialog({ tabId: 7 }, 'Page.javascriptDialogOpening', event),
    ]);
    await closing;
    assert.equal(accepts, 1);
    assert.equal((await journal.snapshot()).tabs[0]?.state, 'CLOSED');
  });
});

test('revocation while a close-dialog target check waits refuses the native acceptance', async () => {
  await nativeFixture(async ({ journal }, _fixture, native) => {
    const chromeValue: unknown = Reflect.get(globalThis, 'chrome');
    assert.ok(chromeValue && typeof chromeValue === 'object');
    const tabs: unknown = Reflect.get(chromeValue, 'tabs'),
      debug: unknown = Reflect.get(chromeValue, 'debugger');
    assert.ok(tabs && typeof tabs === 'object' && debug && typeof debug === 'object');
    const facebook = 'https://www.facebook.com/';
    let allowed = true,
      removing = false,
      accepts = 0;
    let unblock: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    Reflect.set(tabs, 'remove', async () => {
      removing = true;
      await wait;
    });
    Reflect.set(debug, 'getTargets', async () => {
      if (removing) allowed = false;
      return [{ id: native.targetId, tabId: 7, type: 'page', url: facebook, attached: true }];
    });
    Reflect.set(debug, 'sendCommand', async (_source: unknown, method: string) => {
      if (method === 'Page.handleJavaScriptDialog') accepts++;
      return {
        targetInfo: {
          targetId: native.targetId,
          type: 'page',
          url: facebook,
          title: '',
          attached: true,
        },
      };
    });
    const backend = new ChromeKernelBackend(
      journal,
      () => false,
      'facebook-task',
      () => allowed,
    );
    await backend.create(facebook);
    await backend.attach(7);
    const closing = backend.remove(7);
    while (!removing) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      backend.closingDialog({ tabId: 7 }, 'Page.javascriptDialogOpening', {
        type: 'beforeunload',
        url: facebook,
      }),
      /CLOSE_DIALOG_REVOKED/,
    );
    assert.equal(accepts, 0);
    unblock?.();
    await closing;
  });
});
test('STOP while operation persistence is pending drains its unknown summary and never enables later input', async () => {
  const { storage, journal, operation } = await fixture();
  let release: (() => void) | undefined;
  const block = new Promise<void>((resolve) => {
    release = resolve;
  });
  const replies: Record<string, unknown>[] = [];
  const backend = {
    scope: async () => {},
    attach: async () => ({
      targetId: 'test',
      type: 'page' as const,
      title: '',
      url,
      attached: true,
    }),
    detach: async () => {},
    create: async () => ({ tabId: 7 }),
    remove: async () => {},
    send: async () => ({}),
    owns: () => true,
    detached: () => {},
    expectedDetach: () => false,
  };
  const channel = new ExtensionKernelChannel(
    () => ({ profileId: operation.profileId, epoch: operation.connectionEpoch, valid: true }),
    (message) => replies.push(KernelJsonObject.parse(message)),
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
      connectionEpoch: operation.connectionEpoch,
      leaseId: operation.leaseId,
      ...body,
    });
    return requestId;
  };
  request({
    kind: 'open',
    stamp: {
      profileId: operation.profileId,
      connectionEpoch: operation.connectionEpoch,
      leaseId: operation.leaseId,
      generation: 0,
      expiresAt: Date.now() + 10_000,
    },
    files: [],
  });
  storage.beforeWrite = async () => {
    await block;
  };
  const begin = request({ kind: 'beginOperation', binding: operation });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stop = request({ kind: 'stop' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    replies.some((row) => row.requestId === stop),
    false,
  );
  assert.ok(release);
  release();
  await channel.freeze();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(String(replies.find((row) => row.requestId === begin)?.error), /FENCED/);
  assert.equal(
    KernelJsonObject.parse(replies.find((row) => row.requestId === stop)?.result).state,
    'stopped',
  );
  assert.equal((await journal.snapshot()).operations[0]?.state, 'UNKNOWN');
});

test('channel gates native input, finishes only the active binding, and a duplicate begin never enables a second input', async () => {
  const { journal, operation } = await fixture();
  let inputs = 0;
  let closeEvents = 0;
  let failNextScopePending = false;
  const replies: Record<string, unknown>[] = [];
  const backend = {
    scope: async () => {
      if (failNextScopePending) {
        failNextScopePending = false;
        throw Error('KERNEL_INITIAL_DOCUMENT_PENDING');
      }
    },
    attach: async () => ({
      targetId: 'test',
      type: 'page' as const,
      title: '',
      url,
      attached: true,
    }),
    detach: async () => {},
    create: async () => ({ tabId: 7 }),
    remove: async () => {},
    send: async () => {
      inputs++;
      return {};
    },
    owns: () => true,
    detached: () => {},
    expectedDetach: () => false,
    closingDialog: async () => {
      closeEvents++;
    },
  };
  const channel = new ExtensionKernelChannel(
    () => ({ profileId: operation.profileId, epoch: operation.connectionEpoch, valid: true }),
    (message) => replies.push(KernelJsonObject.parse(message)),
    () => backend,
    journal,
  );
  let sequence = 0;
  const request = async (body: Record<string, unknown>) => {
    const requestId = randomUUID();
    channel.receive({
      type: 'KERNEL_REQUEST',
      requestId,
      sequence: ++sequence,
      connectionEpoch: operation.connectionEpoch,
      leaseId: operation.leaseId,
      ...body,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const reply = replies.find((row) => row.requestId === requestId);
    assert.ok(reply);
    return reply;
  };
  await request({
    kind: 'open',
    stamp: {
      profileId: operation.profileId,
      connectionEpoch: operation.connectionEpoch,
      leaseId: operation.leaseId,
      generation: 0,
      expiresAt: Date.now() + 10_000,
    },
    files: [],
  });
  await request({ kind: 'create', url });
  await request({ kind: 'attach', tabId: 7 });
  const input = {
    kind: 'send',
    target: { tabId: 7 },
    method: 'Input.insertText',
    params: { text: 'fixture' },
  };
  assert.match(String((await request(input)).error), /OPERATION_REQUIRED/);
  assert.equal(inputs, 0);
  await request({ kind: 'beginOperation', binding: operation });
  await request(input);
  assert.equal(inputs, 1);
  failNextScopePending = true;
  assert.match(
    String(
      (
        await request({
          kind: 'send',
          target: { tabId: 7 },
          method: 'Runtime.evaluate',
          params: { expression: '1+1', returnByValue: true },
        })
      ).error,
    ),
    /KERNEL_INITIAL_DOCUMENT_PENDING/,
  );
  // An operation can fail before finishOperation. Its pending owned close still needs
  // the native backend's existing beforeunload handler after input has returned.
  channel.event({ tabId: 7 }, 'Page.javascriptDialogOpening', { type: 'beforeunload' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeEvents, 1);
  assert.match(
    String(
      (await request({ kind: 'finishOperation', binding: { ...operation, stepId: randomUUID() } }))
        .error,
    ),
    /NOT_ACTIVE/,
  );
  assert.equal(
    KernelJsonObject.parse((await request({ kind: 'finishOperation', binding: operation })).result)
      .acknowledged,
    true,
  );
  assert.equal((await journal.snapshot()).operations[0]?.state, 'ACKNOWLEDGED');
  assert.equal(
    KernelJsonObject.parse((await request({ kind: 'beginOperation', binding: operation })).result)
      .fresh,
    false,
  );
  assert.match(String((await request(input)).error), /OPERATION_REQUIRED/);
  assert.equal(inputs, 1);
  await channel.freeze();
});

test('consolidateWorkspace adopts the active user Facebook tab as workspaceMain and closes all other tabs including user-opened and LOST tabs', async () => {
  await nativeFixture(async ({ journal, profileId, epoch }) => {
    const native = Reflect.get(globalThis, 'chrome') as object;
    const tabs = Reflect.get(native, 'tabs') as object;
    const debug = Reflect.get(native, 'debugger') as object;
    const removedTabIds: number[] = [];
    const updatedTabs: Array<[number, unknown]> = [];
    const tabGroupIds = new Map<number, number>();
    Reflect.set(tabs, 'query', async () =>
      [
        { id: 101, windowId: 8, active: false, url: 'https://www.facebook.com/home.php' },
        { id: 202, windowId: 8, active: true, url: 'https://www.facebook.com/friends' },
        { id: 303, windowId: 8, active: false, url: 'https://example.com/user-tab' },
      ].filter((row) => !removedTabIds.includes(row.id)),
    );
    Reflect.set(tabs, 'get', async (id: number) => ({
      id,
      windowId: 8,
      groupId: tabGroupIds.get(id) ?? -1,
    }));
    Reflect.set(tabs, 'group', async ({ tabIds }: { tabIds: number[] }) => {
      for (const id of tabIds) tabGroupIds.set(id, 7);
      return 7;
    });
    Reflect.set(tabs, 'update', async (id: number, props: unknown) => {
      updatedTabs.push([id, props]);
      return { id, windowId: 8 };
    });
    Reflect.set(tabs, 'remove', async (id: number) => {
      removedTabIds.push(id);
    });
    Reflect.set(debug, 'getTargets', async () => [
      {
        id: 'target-101',
        tabId: 101,
        type: 'page',
        url: 'https://www.facebook.com/home.php',
        attached: false,
      },
      {
        id: 'target-202',
        tabId: 202,
        type: 'page',
        url: 'https://www.facebook.com/friends',
        attached: false,
      },
      {
        id: 'target-303',
        tabId: 303,
        type: 'page',
        url: 'https://example.com/user-tab',
        attached: false,
      },
    ]);

    const oldOwnershipId = randomUUID();
    await journal.prepareTab(oldOwnershipId, 'https://www.facebook.com/home.php');
    await journal.confirmTab({
      profileId,
      browserSessionEpoch: epoch,
      ownershipId: oldOwnershipId,
      tabId: 101,
      targetId: 'target-101',
    });

    const backend = new ChromeKernelBackend(
      journal,
      () => false,
      'facebook-task',
      () => true,
    );
    const orphan = binding(profileId);
    await journal.begin(orphan);
    const result = await backend.consolidateWorkspace(true);
    assert.equal(
      (await journal.snapshot()).operations.find(
        (op) => op.binding.operationId === orphan.operationId,
      )?.disposition?.outcome,
      'ENDED_UNKNOWN',
    );
    assert.equal(result.proof.tabId, 202);
    assert.equal(result.proof.targetId, 'target-202');
    assert.equal(result.url, 'https://www.facebook.com/friends');
    assert.deepEqual(result.closedTabIds, [101, 303]);
    assert.deepEqual(removedTabIds, [101, 303]);
    assert.equal(result.remainingTabCount, 1);
    assert.equal(backend.owns(202), true);
    assert.equal(backend.owns(101), false);
    const snapshot = await journal.snapshot();
    assert.equal(snapshot.tabs.find((row) => row.proof?.tabId === 202)?.state, 'READY');
    assert.equal(snapshot.tabs.find((row) => row.proof?.tabId === 101)?.state, 'CLOSED');
    const remaining = await chrome.tabs.query({});
    assert.deepEqual(
      remaining.map((tab) => tab.id),
      [202],
    );
    assert.equal(tabGroupIds.get(202), 7);
    const main = (await chrome.storage.local.get('workbenchWorkspaceMainPageV1'))[
      'workbenchWorkspaceMainPageV1'
    ];
    assert.equal(main.groupId, 7);
    assert.deepEqual(main.proof, result.proof);
  });
});

test('native window recovery survives visible reports and suspended renderer probes; healthy, denied and stopped pages never focus', async () => {
  for (const mode of [
    'hidden',
    'exposed',
    'exposed-visible',
    'exposed-focus',
    'exposed-denied',
    'exposed-stop',
    'healthy',
    'unfocused',
    'probe-stalled',
    'render-error',
    'denied',
    'stop',
  ] as const)
    await nativeFixture(async ({ journal, operation }) => {
      const native = Reflect.get(globalThis, 'chrome') as object;
      const tabs = Reflect.get(native, 'tabs') as object,
        debug = Reflect.get(native, 'debugger') as object;
      let at = 10000,
        live = true,
        active: Binding | undefined = operation,
        requests = 0,
        focus = 0;
      let release: ((allowed: boolean) => void) | undefined;
      let captureStarts = 0;
      let finishProbe: ((value: unknown) => void) | undefined;
      const diagnostics: Record<string, unknown>[] = [];
      const facebook = 'https://www.facebook.com/';
      Reflect.set(tabs, 'get', async () => ({
        id: 7,
        windowId: 9,
        groupId: 7,
        active: true,
        url: facebook,
      }));
      Reflect.set(tabs, 'update', async () => {});
      Reflect.set(native, 'windows', {
        getAll: async () => [],
        get: async () => ({
          state: 'normal',
          focused: mode === 'healthy' || mode === 'hidden' || focus > 0,
        }),
        update: async (_id: number, params: { focused?: boolean }) => {
          if (params.focused) focus++;
        },
      });
      Reflect.set(debug, 'getTargets', async () => [
        { id: 'native-target-7', tabId: 7, type: 'page', url: facebook },
      ]);
      Reflect.set(debug, 'sendCommand', async (_target: unknown, method: string) => {
        if (method === 'Page.startScreencast') captureStarts++;
        if (mode === 'render-error' && method === 'Page.startScreencast')
          throw Error('RENDERER_SUSPENDED');
        return method === 'Runtime.evaluate'
          ? mode === 'probe-stalled'
            ? new Promise((resolve) => {
                finishProbe = resolve;
              })
            : {
                result: {
                  value:
                    mode === 'healthy' || mode === 'unfocused' || mode === 'exposed-visible'
                      ? 'visible'
                      : 'hidden',
                },
              }
          : {
              targetInfo: {
                targetId: 'native-target-7',
                type: 'page',
                url: facebook,
                title: '',
                attached: true,
              },
            };
      });
      const backend = new ChromeKernelBackend(
        journal,
        () => live && !!active,
        'facebook-task',
        () => live,
        () => active,
        () => at,
      );
      backend.setPresentationRecoveryGate(async () => {
        requests++;
        return mode === 'stop' || mode === 'exposed-stop'
          ? await new Promise<boolean>((resolve) => {
              release = resolve;
            })
          : mode === 'exposed-focus'
            ? ('focus' as const)
            : mode !== 'denied' && mode !== 'exposed-denied';
      });
      backend.setPresentationObserver((_proof, state) => {
        diagnostics.push(state);
      });
      await backend.create(facebook);
      await backend.attach(7);
      const taskProof = (await journal.snapshot()).tabs[0]?.proof;
      assert.ok(taskProof);
      await backend.armTaskPresentation(taskProof);
      if (mode.startsWith('exposed')) {
        await backend.setWindowExposure(taskProof, true);
        await backend.send({ tabId: 7 }, 'Page.bringToFront', {});
      }
      active = undefined;
      backend.maintainPresentation();
      await new Promise<void>((r) => setImmediate(r));
      assert.equal(requests, 0);
      assert.equal(focus, 0);
      // A hidden report needs no additional four-second grace period.
      at = mode === 'hidden' || mode.startsWith('exposed') ? 12000 : 14000;
      backend.maintainPresentation();
      await new Promise<void>((r) => setImmediate(r));
      if (mode === 'stop' || mode === 'exposed-stop') {
        assert.ok(release);
        live = false;
        const drain = backend.releaseRendering();
        release(true);
        await drain;
      } else await backend.releaseRendering();
      assert.equal(requests, mode === 'healthy' || mode === 'exposed-visible' ? 0 : 1);
      if (mode.startsWith('exposed')) {
        assert.equal(captureStarts, 0);
        assert.equal(focus, 0);
      }
      if (mode === 'exposed') assert.ok(diagnostics.some((s) => s.phase === 'LAYOUT_RESULT'));
      assert.equal(
        focus,
        ['hidden', 'unfocused', 'probe-stalled', 'render-error'].includes(mode) ? 1 : 0,
      );
      assert.ok(diagnostics.some((state) => state.phase === 'ARMED'));
      if (focus)
        assert.ok(
          diagnostics.some(
            (state) => state.phase === 'FOCUS_RESULT' && state.windowFocused === true,
          ),
        );
      const beforeLateRead = diagnostics.length;
      finishProbe?.({ result: { value: 'hidden' } });
      await new Promise<void>((r) => setImmediate(r));
      assert.equal(diagnostics.length, beforeLateRead);
    });
});

test('presentation grant transport rejects stale or expired grants and STOP drains pending permits', async () => {
  for (const mode of ['granted', 'focus', 'focus-expired', 'expired', 'stopped'] as const) {
    const { journal, operation, epoch } = await fixture();
    const messages: Record<string, unknown>[] = [];
    let recover: ((proof: TabProof) => Promise<boolean | 'focus'>) | undefined;
    const backend = {
      scope: async () => {},
      attach: async () => ({
        targetId: 'native-target-7',
        type: 'page' as const,
        title: '',
        url,
        attached: true,
      }),
      detach: async () => {},
      create: async () => ({ tabId: 7 }),
      remove: async () => {},
      send: async () => ({}),
      owns: () => true,
      detached: () => {},
      expectedDetach: () => false,
      setPresentationRecoveryGate: (gate: (proof: TabProof) => Promise<boolean | 'focus'>) => {
        recover = gate;
      },
    };
    const channel = new ExtensionKernelChannel(
      () => ({ profileId: operation.profileId, epoch: operation.connectionEpoch, valid: true }),
      (m) => messages.push(KernelJsonObject.parse(m)),
      () => backend,
      journal,
    );
    channel.receive({
      type: 'KERNEL_REQUEST',
      requestId: randomUUID(),
      sequence: 1,
      connectionEpoch: operation.connectionEpoch,
      leaseId: operation.leaseId,
      kind: 'open',
      access: 'facebook-task',
      files: [],
      stamp: {
        profileId: operation.profileId,
        connectionEpoch: operation.connectionEpoch,
        leaseId: operation.leaseId,
        generation: 0,
        expiresAt: Date.now() + 10000,
      },
    });
    await new Promise<void>((r) => setImmediate(r));
    assert.ok(recover);
    const pending = recover(proof(operation.profileId, epoch));
    const request = messages.find((m) => m.type === 'PRESENTATION_RECOVERY_REQUEST');
    assert.ok(request);
    const permit = {
      type: 'PRESENTATION_RECOVERY_PERMIT',
      requestId: request.requestId,
      connectionEpoch: operation.connectionEpoch,
      leaseId: operation.leaseId,
      generation: 0,
      granted: true,
      expiresAt: Date.now() + 1000,
    };
    channel.presentationRecoveryPermit({ ...permit, leaseId: randomUUID() });
    if (mode === 'stopped') await channel.freeze();
    else
      channel.presentationRecoveryPermit({
        ...permit,
        ...(mode.startsWith('focus') ? { focusFallback: true } : {}),
        expiresAt: mode.includes('expired') ? Date.now() - 1 : permit.expiresAt,
      });
    assert.equal(await pending, mode === 'granted');
    await channel.freeze();
  }
});

test('control release reconciles only ACKed input and never clears original UNKNOWN', async () => {
  for (const state of ['ACKNOWLEDGED', 'UNKNOWN'] as const) {
    const { journal, operation } = await fixture();
    await journal.begin(operation);
    await journal.finish(operation, state);
    const resolution = {
      id: randomUUID(),
      outcome: 'CONTROL_RELEASED' as const,
      evidenceDigest: 'a'.repeat(64),
    };
    if (state === 'UNKNOWN') {
      await assert.rejects(journal.reconcile(operation, resolution), /ACK_REQUIRED/);
      assert.equal((await journal.snapshot()).operations[0]?.state, 'UNKNOWN');
      await assert.rejects(
        journal.begin({ ...operation, operationId: randomUUID() }),
        /REVIEW_REQUIRED/,
      );
    } else {
      await journal.reconcile(operation, resolution);
      assert.equal(
        (await journal.snapshot()).operations[0]?.resolution?.outcome,
        'CONTROL_RELEASED',
      );
      assert.equal((await journal.begin({ ...operation, operationId: randomUUID() })).fresh, true);
    }
  }
});
