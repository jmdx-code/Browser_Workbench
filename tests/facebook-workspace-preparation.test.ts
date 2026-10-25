import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  invitationDigest,
  prepareFacebookWorkspace,
} from '../src/infrastructure/facebook-workspace-preparation.js';
import { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import type { Peer } from '../src/bridge/core.js';
import type { KernelState } from '../src/shared/kernel-state.js';
import { Core } from '../src/bridge/core.js';
import { Store } from '../src/bridge/store.js';
import { BridgeBrowserWindow } from '../src/infrastructure/bridge-browser-window.js';
import type { Plan } from '../src/shared/task-contracts.js';
import { CleanupProfileTabsRequest } from '../src/shared/browser-window.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { WorkspaceService } from '../src/application/workspace-service.js';
import { BridgeProfileSource } from '../src/infrastructure/browser-source.js';
import { startBridgeServer } from '../src/bridge/server.js';
import { workspaceApi } from '../src/http/workspace-api.js';

function fixture() {
  const profileId = randomUUID(),
    browserSessionEpoch = randomUUID();
  const proof = {
    profileId,
    browserSessionEpoch,
    ownershipId: randomUUID(),
    tabId: 1,
    targetId: 'one',
  };
  const state: KernelState = {
    version: 1,
    profileId,
    browserSessionEpoch,
    operations: [],
    tabs: [
      {
        ownershipId: proof.ownershipId,
        proof,
        state: 'READY',
        url: 'https://www.facebook.com/groups/123',
        reason: '',
      },
    ],
    workspaceMain: proof,
  };
  const ended: string[] = [],
    discarded: number[] = [];
  let consolidated = 0;
  const peer = { profileId, capabilities: ['kernel-workspace-cleanup-v1'] } as Peer;
  const kernel = {
    withSummary: async (_: unknown, fn: (port: unknown) => Promise<unknown>) =>
      fn({
        inventory: async () => state,
        notify: async (binding: { operationId: string }, value: { outcome: string }) => {
          assert.equal(value.outcome, 'ENDED_UNKNOWN');
          ended.push(binding.operationId);
          const row = state.operations.find((r) => r.binding.operationId === binding.operationId)!;
          Reflect.set(row, 'disposition', value);
        },
      }),
    consolidateFacebookWorkspace: async (_: unknown, prefer: boolean) => {
      assert.equal(prefer, false);
      consolidated++;
      state.tabs = state.tabs.slice(0, 1);
      state.workspaceMain = proof;
      return { proof };
    },
    discardAdmissionTab: async (_: unknown, extra: { tabId: number }) => {
      discarded.push(extra.tabId);
      state.tabs = state.tabs.filter((t) => t.proof?.tabId !== extra.tabId);
    },
  } as unknown as KernelBridge;
  const operation = (
    label: string,
    status: 'UNKNOWN' | 'ACKNOWLEDGED' | 'DISPATCHING' = 'UNKNOWN',
  ) => {
    const operationId = randomUUID();
    const binding = {
      operationId,
      accountId: '12345',
      actionDigest: invitationDigest(label, '12345', operationId),
    };
    state.operations.push({
      binding,
      state: status,
      reason: '',
      resolution: null,
    } as KernelState['operations'][number]);
    return operationId;
  };
  return {
    state,
    proof,
    peer,
    kernel,
    ended,
    discarded,
    operation,
    consolidated: () => consolidated,
  };
}

test('single legacy group READY page is reused without creating another inspection page', async () => {
  const f = fixture();
  const result = await prepareFacebookWorkspace(f.kernel, f.peer, undefined, () => {});
  assert.deepEqual(result.proof, f.proof);
  assert.equal(f.consolidated(), 0);
});

test('production inspection passes automatically adopted proof to its reader; task connect reuses it', async () => {
  const f = fixture();
  f.peer.capabilities!.push(
    'facebook-task-kernel-v1',
    'facebook-task-main-frame-v1',
    'kernel-journal-v1',
    'kernel-operation-files-v1',
  );
  Object.setPrototypeOf(f.kernel, KernelBridge.prototype);
  Reflect.set(f.kernel, 'idlePages', new Map());
  const page = {};
  const connection = {
    proof: f.proof,
    browser: { contexts: () => [{ pages: () => [page] }] },
    closedInventory: f.state,
    close: async () => ({ state: 'stopped' }),
  };
  Reflect.set(f.kernel, 'connectOwned', async (_peer: Peer, files: string[], proof: unknown) => {
    assert.deepEqual(files, []);
    assert.deepEqual(proof, f.proof);
    return connection;
  });
  const result = await Reflect.get(KernelBridge.prototype, 'inspectOwnedFacebookPage').call(
    f.kernel,
    f.peer,
    () => {},
    'https://www.facebook.com/',
    async (received: unknown, proof: unknown) => {
      assert.equal(received, page);
      assert.deepEqual(proof, f.proof);
      return 'read-with-adopted-proof';
    },
  );
  assert.equal(result.reading, 'read-with-adopted-proof');
  assert.equal(result.closedRecord.state, 'READY');
  assert.equal(await f.kernel.connectFacebook(f.peer, '12345', () => {}), connection);
});

test('only acknowledged/unknown invitation Setup is ended; submissions and dispatches remain pending', async () => {
  const f = fixture();
  const ids = [
    f.operation('join-group'),
    f.operation('open-invite-modal', 'ACKNOWLEDGED'),
    f.operation('check-friend-30'),
  ];
  f.operation('send-group-invites');
  f.operation('enter-group', 'DISPATCHING');
  f.operation('unrecognized');
  await prepareFacebookWorkspace(f.kernel, f.peer, undefined, () => {});
  assert.deepEqual(f.ended, ids);
  assert.equal(f.consolidated(), 0);
  assert.equal(f.state.operations.filter((r) => !r.disposition).length, 3);
});

for (const mode of ['multiple', 'missing-main', 'legacy'] as const)
  test('workspace recovery: ' + mode, async () => {
    const f = fixture();
    if (mode === 'missing-main') delete f.state.workspaceMain;
    else
      f.state.tabs.push({
        ...f.state.tabs[0]!,
        ownershipId: randomUUID(),
        proof: { ...f.proof, ownershipId: randomUUID(), tabId: 2 },
      });
    if (mode === 'legacy') f.peer.capabilities = [];
    const result = await prepareFacebookWorkspace(f.kernel, f.peer, undefined, () => {});
    assert.deepEqual(result.proof, f.proof);
    assert.equal(f.state.tabs.length, 1);
    assert.equal(f.consolidated(), mode === 'legacy' ? 0 : 1);
    assert.deepEqual(f.discarded, mode === 'legacy' ? [2] : []);
  });

test('stop/revoked admission guard prevents workspace mutation', async () => {
  const f = fixture();
  f.operation('join-group');
  await assert.rejects(
    prepareFacebookWorkspace(f.kernel, f.peer, undefined, () => {
      throw Error('STOP');
    }),
    /STOP/,
  );
  assert.equal(f.ended.length, 0);
});

test('bulk cleanup counts idle/paused, offline, daily busy and inviter busy accurately', async () => {
  const store = new Store(':memory:');
  const core = new Core(store);
  const peers = Array.from({ length: 4 }, () =>
    core.connect(
      randomUUID(),
      () => {},
      () => {},
    ),
  );
  peers.forEach((p) => {
    p.synced = true;
    p.phase = 'PAUSED';
  });
  const called: string[] = [];
  const service = new BridgeBrowserWindow(
    core,
    {
      list: () =>
        [
          { profileId: peers[1]!.profileId, state: 'RUNNING' },
          { profileId: peers[3]!.profileId, state: 'PAUSED' },
        ] as Plan[],
    },
    undefined,
    async (id, prefer) => {
      assert.equal(prefer, false);
      called.push(id);
      return {
        profileId: id,
        proof: fixture().proof,
        url: 'https://www.facebook.com/',
        closedTabIds: [2, 3],
        remainingTabCount: 1,
      };
    },
    (id) => id === peers[2]!.profileId,
  );
  try {
    assert.deepEqual(
      await service.cleanupTabs([
        ...peers.map((p) => p.profileId),
        randomUUID(),
        peers[0]!.profileId,
      ]),
      { cleanedProfiles: 2, closedTabs: 4, skippedBusy: 2, skippedOffline: 1 },
    );
    assert.deepEqual(called, [peers[0]!.profileId, peers[3]!.profileId]);
  } finally {
    store.close();
  }
});

test('cleanup request validates UUID bounds and optional active-page preference', () => {
  assert.equal(CleanupProfileTabsRequest.safeParse({ profileIds: [] }).success, false);
  assert.equal(CleanupProfileTabsRequest.safeParse({ profileIds: ['not-uuid'] }).success, false);
  assert.equal(
    CleanupProfileTabsRequest.safeParse({ profileIds: Array.from({ length: 501 }, randomUUID) })
      .success,
    false,
  );
  assert.equal(
    CleanupProfileTabsRequest.safeParse({ profileIds: [randomUUID()], preferActiveTab: true })
      .success,
    true,
  );
});

test('authenticated cleanup-tabs HTTP routes to native consolidation and returns exact totals', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-cleanup-tabs-'));
  const repo = await WorkspaceStore.open(path.join(dir, 'workspace.sqlite'));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  let profileId = '';
  const calls: boolean[] = [];
  const server = await startBridgeServer({
    root: process.cwd(),
    dataDir: dir,
    port: address.port,
    extensionIds: ['a'.repeat(32)],
    appRoutes: ({ core, store, tasks }) => {
      const peer = core.connect(
        randomUUID(),
        () => {},
        () => {},
      );
      peer.synced = true;
      peer.phase = 'PAUSED';
      profileId = peer.profileId;
      const windows = new BridgeBrowserWindow(
        core,
        { list: () => [] },
        undefined,
        async (id, prefer) => {
          calls.push(prefer ?? false);
          return {
            profileId: id,
            proof: fixture().proof,
            url: 'https://www.facebook.com/',
            closedTabIds: [2, 3],
            remainingTabCount: 1,
          };
        },
      );
      return workspaceApi(
        new WorkspaceService(repo, new BridgeProfileSource(core, store, tasks)),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        windows,
      );
    },
  });
  try {
    await server.store.pair(profileId, 'fixture-secret', 'a'.repeat(32));
    const landing = await fetch(server.origin);
    const cookie = landing.headers.get('set-cookie')!.split(';')[0]!;
    const post = (body: unknown, authenticated = true) =>
      fetch(server.origin + '/api/workspace/profiles/cleanup-tabs', {
        method: 'POST',
        headers: {
          ...(authenticated ? { cookie } : {}),
          origin: server.origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    assert.equal((await post({ profileIds: [profileId] }, false)).status, 401);
    assert.equal((await post({ profileIds: [] })).status, 400);
    for (const preference of [undefined, true]) {
      const res = await post({
        profileIds: [profileId],
        ...(preference ? { preferActiveTab: true } : {}),
      });
      assert.equal(res.status, 200, await res.clone().text());
      assert.deepEqual(await res.json(), {
        cleanedProfiles: 1,
        closedTabs: 2,
        skippedBusy: 0,
        skippedOffline: 0,
      });
    }
    assert.deepEqual(calls, [false, true]);
  } finally {
    await server.close();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});
