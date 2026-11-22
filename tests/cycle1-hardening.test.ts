import test from 'node:test';
import assert from 'node:assert/strict';
import { matchBlueStacksWindow } from '../src/infrastructure/bluestacks-win32.js';
import { FacebookGroupSessionHelper } from '../src/infrastructure/facebook-group-session.js';
import { Core } from '../src/bridge/core.js';
import type { Store } from '../src/bridge/store.js';

function createMemoryBridgeStore(): Store {
  return {
    unresolved: async () => [],
    cancelPrepared: async () => {},
    reconcile: async () => {},
    get: async () => undefined,
    set: async () => {},
    prepare: async () => {
      throw Error('NOT_USED');
    },
    review: async () => {},
    facebookAllowed: async () => true,
  } as unknown as Store;
}

test('matchBlueStacksWindow rejects shared-port window belonging to another instance', () => {
  const windows = [
    { pid: 1001, hwnd: '111', title: 'BlueStacks Instance A', listeningPorts: [5555] },
  ];

  // Different target sharing port 5555 MUST NOT match Instance A's window
  const mismatched = matchBlueStacksWindow(windows, {
    displayName: 'BlueStacks Instance B',
    instanceKey: 'Pie64_2',
    adbPort: 5555,
    sharedPort: true,
  });
  assert.equal(mismatched, null);

  // Exact displayName match succeeds even on shared port 5555
  const exact = matchBlueStacksWindow(windows, {
    displayName: 'BlueStacks Instance A',
    instanceKey: 'Pie64_1',
    adbPort: 5555,
    sharedPort: true,
  });
  assert.equal(exact?.pid, 1001);

  // Dedicated (non-shared) port still matches by port
  const dedicated = matchBlueStacksWindow(
    [{ pid: 1002, hwnd: '222', title: 'Custom Window Title', listeningPorts: [5565] }],
    {
      displayName: 'BlueStacks Instance C',
      instanceKey: 'Pie64_3',
      adbPort: 5565,
      sharedPort: false,
    },
  );
  assert.equal(dedicated?.pid, 1002);
});

test('syncCanonicalGroupRedirect protects numeric IDs and blocks alias redirect on search clicks', async () => {
  const applied: Array<{ rawId: string; canonicalId?: string | null }> = [];
  const apply = (rawId: string, resolved: { canonicalId?: string | null }) => {
    applied.push({ rawId, canonicalId: resolved.canonicalId });
  };

  // Already-numeric group ID must NEVER be overwritten by a different numeric URL
  const numericProtected = await FacebookGroupSessionHelper.syncCanonicalGroupRedirect({
    currentUrl: 'https://www.facebook.com/groups/999888777666/',
    rawGroupId: '123456789012',
    allowAliasRedirect: true,
    applyResolvedMetadata: apply,
  });
  assert.equal(numericProtected.redirectedToCanonical, false);
  assert.equal(numericProtected.effectiveGroupId, '123456789012');
  assert.equal(numericProtected.canonicalGroupId, '123456789012');

  // Vanity alias navigated via search-by-name (allowAliasRedirect: false) must NOT adopt arbitrary ID
  const searchBlocked = await FacebookGroupSessionHelper.syncCanonicalGroupRedirect({
    currentUrl: 'https://www.facebook.com/groups/999888777666/',
    rawGroupId: 'my-vanity-group',
    allowAliasRedirect: false,
    applyResolvedMetadata: apply,
  });
  assert.equal(searchBlocked.redirectedToCanonical, false);
  assert.equal(searchBlocked.effectiveGroupId, 'my-vanity-group');
  assert.equal(searchBlocked.canonicalGroupId, null);

  // Vanity alias navigated via direct URL (allowAliasRedirect: true) resolves cleanly
  const directAllowed = await FacebookGroupSessionHelper.syncCanonicalGroupRedirect({
    currentUrl: 'https://www.facebook.com/groups/999888777666/',
    rawGroupId: 'my-vanity-group',
    allowAliasRedirect: true,
    applyResolvedMetadata: apply,
  });
  assert.equal(directAllowed.redirectedToCanonical, true);
  assert.equal(directAllowed.effectiveGroupId, '999888777666');
  assert.equal(directAllowed.canonicalGroupId, '999888777666');
  assert.equal(applied.at(-1)?.canonicalId, '999888777666');
});

test('Core.sync does not spoof STOPPING phase and stale peer cannot clear new peer control', async () => {
  const store = createMemoryBridgeStore();
  let releaseCancelPrepared: () => void = () => {};
  const cancelGate = new Promise<void>((resolve) => {
    releaseCancelPrepared = resolve;
  });
  let gateArmed = true;
  store.cancelPrepared = async () => {
    if (gateArmed) {
      gateArmed = false;
      await cancelGate;
    }
  };

  const sent: Array<{ peerTag: string; msg: Record<string, unknown> }> = [];
  const core = new Core(store, 5000);
  const peer1 = core.connect(
    'profile-sync-test',
    (msg) => sent.push({ peerTag: 'p1', msg: msg as Record<string, unknown> }),
    () => {},
  );

  // Start sync — paused inside cancelPrepared; phase must be SYNCING (never fake STOPPING)
  const syncPromise = core.sync(peer1);
  assert.equal(peer1.phase, 'SYNCING');

  // Calling stop() while sync() is awaiting cancelPrepared MUST still send a real STOP command
  const stopRes = await core.stop('profile-sync-test', 'req-stop-1');
  assert.equal(stopRes.requestId, 'req-stop-1');
  assert.ok(
    sent.some(
      (row) =>
        row.peerTag === 'p1' && row.msg.type === 'STOP' && row.msg.requestId === 'req-stop-1',
    ),
  );

  // Disconnect peer1 and reconnect peer2 before peer1's old sync resumes
  await core.disconnect(peer1);
  const peer2 = core.connect(
    'profile-sync-test',
    (msg) => sent.push({ peerTag: 'p2', msg: msg as Record<string, unknown> }),
    () => {},
  );
  const p2Stop = await core.stop('profile-sync-test', 'req-stop-2');
  assert.equal(p2Stop.requestId, 'req-stop-2');
  assert.equal(core.stoppingControllers.has('profile-sync-test'), true);

  // Now unblock peer1's old sync — it must reject OFFLINE and NOT wipe peer2's stoppingController
  releaseCancelPrepared();
  await assert.rejects(syncPromise, /OFFLINE/);
  assert.equal(core.peers.get('profile-sync-test'), peer2);
  assert.equal(core.stoppingControllers.has('profile-sync-test'), true);

  await core.shutdown();
});
