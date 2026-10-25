import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseNativeFacebookActor } from '../src/shared/facebook-native-identity.js';
import { readNativeFacebookIdentity } from '../extension/facebook-identity-reader.js';
import { ChromeKernelBackend } from '../extension/kernel-backend.js';
import { KernelJournal } from '../src/application/kernel-journal.js';
import { MemoryKernelStorage } from './fixtures/kernel-storage.js';
import { randomUUID } from 'node:crypto';

const sample = JSON.parse(
  await readFile('tests/fixtures/facebook-native-identity.json', 'utf8'),
) as {
  request: { av: string };
  response: {
    data: {
      viewer: {
        actor: { __typename: string; id: string; name: string };
        is_lar_acting_as_additional_profile: boolean;
      };
    };
    extensions: { is_final: boolean };
  };
};
test('actual selected menu actor response is sanitized and foreign, partial, additional-profile and errored responses cannot become identity', () => {
  const result = parseNativeFacebookActor(
    JSON.stringify({ ...sample.response, logout_whitelist: ['private metadata'] }),
    sample.request.av,
    1000,
  );
  assert.deepEqual(result, {
    version: 1,
    source: 'CometSettingsDropdownTriggerQuery',
    accountId: sample.request.av,
    name: 'Nway Myint',
    type: 'User',
    checkedAt: 1000,
  });
  assert.equal(parseNativeFacebookActor(JSON.stringify(sample.response), '99', 1000), null);
  for (const mutation of [
    { ...sample.response, errors: [{ message: 'unknown' }] },
    { ...sample.response, extensions: { is_final: false } },
    {
      ...sample.response,
      data: {
        viewer: { ...sample.response.data.viewer, is_lar_acting_as_additional_profile: true },
      },
    },
    {
      ...sample.response,
      data: {
        viewer: {
          ...sample.response.data.viewer,
          actor: { ...sample.response.data.viewer.actor, __typename: 'Page' },
        },
      },
    },
  ])
    assert.equal(parseNativeFacebookActor(JSON.stringify(mutation), sample.request.av, 1000), null);
  assert.equal(parseNativeFacebookActor('x'.repeat(524289), sample.request.av, 1000), null);
  assert.equal(
    parseNativeFacebookActor(
      JSON.stringify({ ...sample.response, extra: '中'.repeat(200_000) }),
      sample.request.av,
      1000,
    ),
    null,
  );
});
type Listener = (
  source: chrome.debugger.Debuggee & { sessionId?: string },
  method: string,
  params?: object,
) => void;
function fixture(
  options: {
    badActor?: boolean;
    loaderChange?: boolean;
    revoke?: boolean;
    foreignTarget?: boolean;
    preloadOnly?: boolean;
  } = {},
) {
  const listeners = new Set<Listener>(),
    commands: string[] = [],
    reloaded: number[] = [];
  let valid = true,
    frameReads = 0;
  const emit = (method: string, params: object) => {
    for (const fn of listeners) fn({ tabId: 42 }, method, params);
  };
  const mock = {
    debugger: {
      getTargets: async () => [
        { tabId: 42, id: 'native-target', type: 'page', url: 'https://www.facebook.com/' },
      ],
      attach: async () => {},
      detach: async () => {},
      onEvent: {
        addListener: (fn: Listener) => listeners.add(fn),
        removeListener: (fn: Listener) => listeners.delete(fn),
      },
      sendCommand: async (_target: object, method: string, _params?: object) => {
        commands.push(method);
        if (method === 'Target.getTargetInfo')
          return {
            targetInfo: {
              targetId: 'native-target',
              type: 'page',
              url:
                options.foreignTarget &&
                commands.filter((m) => m === 'Target.getTargetInfo').length > 1
                  ? 'https://www.facebook.com/me/'
                  : 'https://www.facebook.com/',
              title: '',
              attached: true,
            },
          };
        if (method === 'Page.getFrameTree') {
          frameReads++;
          return {
            frameTree: {
              frame: {
                id: 'main-frame',
                url: 'https://www.facebook.com/',
                loaderId:
                  options.loaderChange && frameReads > 1 ? 'foreign-loader' : 'original-loader',
              },
            },
          };
        }
        if (method === 'Runtime.evaluate')
          return {
            result: {
              value: {
                url: 'https://www.facebook.com/',
                ready: 'complete',
                actor: parseNativeFacebookActor(
                  JSON.stringify(sample.response),
                  sample.request.av,
                  Date.now(),
                ),
              },
            },
          };
        if (method === 'Network.getResponseBody')
          return {
            body: JSON.stringify(
              options.badActor ? { ...sample.response, errors: [{}] } : sample.response,
            ),
            base64Encoded: false,
          };
        return {};
      },
    },
    tabs: {
      create: async () => ({ id: 42 }),
      // Production manifest deliberately lacks tabs and FB host permission.
      get: async () => ({ id: 42 }),
      reload: async (id: number) => {
        reloaded.push(id);
        if (options.preloadOnly) return;
        emit('Network.requestWillBeSent', {
          requestId: 'native-request',
          frameId: 'main-frame',
          loaderId: 'original-loader',
          request: {
            url: 'https://www.facebook.com/api/graphql/',
            method: 'POST',
            postData: new URLSearchParams({
              av: sample.request.av,
              fb_api_req_friendly_name: 'CometSettingsDropdownTriggerQuery',
              fb_dtsg: 'credential must not escape',
            }).toString(),
          },
        });
        emit('Network.responseReceived', {
          requestId: 'native-request',
          frameId: 'main-frame',
          loaderId: 'original-loader',
          response: { url: 'https://www.facebook.com/api/graphql/', status: 200 },
        });
        if (options.revoke) valid = false;
        emit('Network.loadingFinished', { requestId: 'native-request', encodedDataLength: 300 });
      },
    },
  };
  const old = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', { value: mock, configurable: true });
  return {
    commands,
    reloaded,
    listeners,
    guard: async () => {
      if (!valid) throw Error('LEASE_REVOKED');
    },
    close: () => {
      if (old) Object.defineProperty(globalThis, 'chrome', old);
      else Reflect.deleteProperty(globalThis, 'chrome');
    },
  };
}
test('private native read enables bounded capture, reloads only its passed inspection tab and returns only selected fields with listeners removed', async () => {
  const f = fixture();
  try {
    const result = await readNativeFacebookIdentity(42, f.guard);
    assert.equal(result?.actor.accountId, sample.request.av);
    assert.deepEqual(f.reloaded, [42]);
    assert.equal(f.commands.filter((m) => m === 'Network.getResponseBody').length, 1);
    assert.equal(
      f.commands.filter((m) => m.startsWith('Input.') || m === 'Network.loadNetworkResource')
        .length,
      0,
    );
    assert.equal(f.listeners.size, 0);
    assert.equal(f.commands.at(-1), 'Network.disable');
    assert.equal(JSON.stringify(result).includes('credential'), false);
  } finally {
    f.close();
  }
});

test('Chrome native backend allows one read only on its new owned homepage and rejects adoption/repeat without reloading', async () => {
  const f = fixture();
  try {
    const journal = new KernelJournal(new MemoryKernelStorage());
    await journal.initialize(randomUUID(), randomUUID());
    const backend = new ChromeKernelBackend(
      journal,
      () => false,
      'facebook-readonly',
      () => true,
    );
    await assert.rejects(
      backend.observeIdentity(42, () => {}),
      /KERNEL_IDENTITY_TAB_REJECTED/,
    );
    const tab = await backend.create('https://www.facebook.com/');
    await backend.attach(tab.tabId);
    assert.equal(
      (await backend.observeIdentity(tab.tabId, () => {}))?.actor.accountId,
      sample.request.av,
    );
    await assert.rejects(
      backend.observeIdentity(tab.tabId, () => {}),
      /KERNEL_IDENTITY_TAB_REJECTED/,
    );
    const proof = (await journal.snapshot()).tabs[0]?.proof;
    assert.ok(proof);
    const adopted = new ChromeKernelBackend(
      journal,
      () => false,
      'facebook-readonly',
      () => true,
    );
    await adopted.adopt(proof);
    await adopted.attach(42);
    await assert.rejects(
      adopted.observeIdentity(42, () => {}),
      /KERNEL_IDENTITY_TAB_REJECTED/,
    );
    assert.deepEqual(f.reloaded, [42]);
  } finally {
    f.close();
  }
});
test('native actor errors or a changed document loader never return a valid actor', async () => {
  for (const options of [{ badActor: true }, { loaderChange: true }]) {
    const f = fixture(options);
    try {
      assert.equal(await readNativeFacebookIdentity(42, f.guard), null);
      assert.equal(f.listeners.size, 0);
    } finally {
      f.close();
    }
  }
});
test('missing natural identity request uses the bounded current-document preload without any native input', async () => {
  const f = fixture({ preloadOnly: true });
  try {
    const value = await readNativeFacebookIdentity(42, f.guard);
    assert.equal(value?.actor.accountId, sample.request.av);
    assert.equal(value?.transport, 'document-preload');
    assert.equal(f.commands.filter((m) => m === 'Runtime.evaluate').length, 1);
    assert.equal(
      f.commands.some((m) => m.startsWith('Input.')),
      false,
    );
    assert.equal(f.listeners.size, 0);
  } finally {
    f.close();
  }
});
test('identity read refuses a changed attached homepage without broadening permissions or reloading', async () => {
  const f = fixture({ foreignTarget: true });
  try {
    const journal = new KernelJournal(new MemoryKernelStorage());
    await journal.initialize(randomUUID(), randomUUID());
    const backend = new ChromeKernelBackend(
      journal,
      () => false,
      'facebook-readonly',
      () => true,
    );
    const tab = await backend.create('https://www.facebook.com/');
    await backend.attach(tab.tabId);
    await assert.rejects(
      backend.observeIdentity(tab.tabId, () => {}),
      /KERNEL_IDENTITY_HOME_REQUIRED/,
    );
    assert.deepEqual(f.reloaded, []);
    assert.equal(f.commands.includes('Network.getResponseBody'), false);
    assert.equal(f.listeners.size, 0);
  } finally {
    f.close();
  }
});
test('stop before native body read fences the asynchronous observer and removes its listener without exposing raw data', async () => {
  const f = fixture({ revoke: true });
  try {
    await assert.rejects(readNativeFacebookIdentity(42, f.guard), /LEASE_REVOKED/);
    assert.equal(f.commands.includes('Network.getResponseBody'), false);
    assert.equal(f.listeners.size, 0);
  } finally {
    f.close();
  }
});
