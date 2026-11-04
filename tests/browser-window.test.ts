import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Core } from '../src/bridge/core.js';
import { Store } from '../src/bridge/store.js';
import { BridgeBrowserWindow } from '../src/infrastructure/bridge-browser-window.js';

test('display remains available during tasks, stopping, review and unsynced connections without creating tabs or changing controls', async () => {
  const store = new Store(':memory:');
  const core = new Core(store);
  const messages: object[] = [];
  const peer = core.connect(
    randomUUID(),
    (input) => {
      const m = input as { type: string; requestId: string };
      messages.push(m);
      assert.equal(m.type, 'REVEAL_BROWSER_WINDOW');
      queueMicrotask(() => core.windowRevealed(peer, m.requestId, { tabId: 7, focused: true }));
    },
    () => {},
  );
  peer.capabilities = ['browser-window-reveal-v1'];
  const service = new BridgeBrowserWindow(core, {
    list: () => assert.fail('display must not query plans'),
  });
  try {
    for (const phase of ['RUNNING', 'STOPPING', 'RECOVERING', 'PAUSED'] as const) {
      peer.phase = phase;
      peer.synced = false;
      assert.deepEqual(await service.show(peer.profileId, 'ignored'), {
        profileId: peer.profileId,
        tabId: 7,
        focused: true,
      });
      assert.equal(peer.phase, phase);
    }
    assert.equal(messages.length, 4);
    assert.equal(store.list().length, 0);
    await assert.rejects(service.show(randomUUID(), 'offline'), /未连接/);
  } finally {
    await core.shutdown();
    store.close();
  }
});

test('display rejects a forged reply and reports actual native failure without fixture fallback', async () => {
  const store = new Store(':memory:');
  const core = new Core(store);
  let requestId = '';
  const peer = core.connect(
    randomUUID(),
    (m) => {
      requestId = (m as { requestId: string }).requestId;
    },
    () => {},
  );
  peer.capabilities = ['browser-window-reveal-v1'];
  try {
    const result = core.revealBrowserWindow(peer.profileId);
    core.windowRevealed({ ...peer }, requestId, { tabId: 99, focused: true });
    core.windowRevealed(peer, requestId, { error: 'WORKSPACE_REVEAL_NO_WINDOW' });
    await assert.rejects(result, /NO_WINDOW/);
    assert.equal(store.list().length, 0);
  } finally {
    await core.shutdown();
    store.close();
  }
});

test('cleanupTabs falls back to lightweight CLEANUP_EXTRA_TABS when browser is busy on >= 0.3.59 and runs concurrently', async () => {
  const store = new Store(':memory:');
  const core = new Core(store);
  const peer = core.connect(
    randomUUID(),
    (input) => {
      const m = input as { type: string; requestId: string; preferActiveTab?: boolean };
      if (m.type === 'CLEANUP_EXTRA_TABS') {
        assert.equal(m.preferActiveTab, false);
        queueMicrotask(() =>
          core.extraTabsCleaned(peer, m.requestId, {
            keptTabId: 42,
            closedTabIds: [101, 102],
            remainingTabCount: 1,
          }),
        );
      }
    },
    () => {},
  );
  peer.extensionVersion = '0.3.59';
  peer.phase = 'PAUSED';
  peer.synced = true;
  peer.capabilities = ['browser-window-reveal-v1', 'kernel-workspace-cleanup-v1'];
  const service = new BridgeBrowserWindow(
    core,
    {
      list: async () => [],
      hasProfilePlanInStates: async () => false,
    },
    async () => ({
      profileId: peer.profileId,
      tabId: 42,
      focused: true as const,
    }),
    async () => {
      throw Error('KERNEL_RPC_FALLBACK');
    },
  );
  try {
    const res = await service.cleanupTabs([peer.profileId, randomUUID()]);
    assert.equal(res.cleanedProfiles, 1);
    assert.equal(res.closedTabs, 2);
    assert.equal(res.skippedBusy, 0);
    assert.equal(res.skippedOffline, 1);
  } finally {
    await core.shutdown();
    store.close();
  }
});
