import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/bridge/store.js';
import { Core } from '../src/bridge/core.js';
import { WatchTasks } from '../src/bridge/watch.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import { KernelProfileInspection } from '../src/infrastructure/kernel-profile-inspection.js';
import { ProfileInspectionService } from '../src/application/profile-inspection.js';
import { KernelRequest } from '../src/shared/kernel-wire.js';
import { KernelJsonObject } from '../src/shared/kernel-protocol.js';
import type { KernelState } from '../src/shared/kernel-state.js';
import type { Command } from '../src/bridge/protocol.js';

// RPC replies here are emulated. This exercises the real software owner and adapter, not Chrome.
async function fixture(
  options: {
    native?: boolean;
    foreign?: boolean;
    changedLoader?: boolean;
    existing?: boolean;
    interactive?: boolean;
    absent?: boolean;
    unconfirmedOpen?: boolean;
  } = {},
) {
  const store = new Store(':memory:');
  const core = new Core(store);
  const tasks = new WatchTasks(core);
  const workspace = await WorkspaceStore.open(':memory:');
  const kernel = new KernelBridge(core, tasks);
  const id = randomUUID();
  const inventory: KernelState = {
    version: 1,
    profileId: id,
    browserSessionEpoch: randomUUID(),
    operations: [],
    tabs: [],
  };
  const requests: string[] = [];
  let wrongClose = false;
  const peer = core.connect(
    id,
    (raw) => {
      const command = raw as Command;
      if (command.type === 'COMMAND' && command.action.kind === 'readFacebookDisplay') {
        requests.push('readFacebookDisplay');
        const page = {
          url: 'https://www.facebook.com/',
          timeOrigin: 1000,
          ready: options.interactive ? 'interactive' : 'complete',
          visibility: 'visible',
          rows: command.action.projection.queries.map((q) => ({ key: q.key, nodes: [] })),
        };
        queueMicrotask(
          async () =>
            await core.reply(peer, {
              type: 'RESULT',
              commandId: command.commandId,
              status: 'VERIFIED',
              evidence: {
                available: !options.absent,
                page,
                identity: { url: page.url, ready: 'complete', actor: null },
              },
            }),
        );
        return;
      }
      const parse = KernelRequest.safeParse(raw);
      if (!parse.success) return;
      const request = parse.data;
      requests.push(request.kind);
      let value: unknown = {};
      switch (request.kind) {
        case 'open':
          value = options.unconfirmedOpen ? {} : { opened: true };
          break;
        case 'observeFacebookIdentity':
          value = {
            identity: {
              actor: {
                version: 1,
                source: 'CometSettingsDropdownTriggerQuery',
                accountId: '10000000000001',
                name: 'Nway Myint',
                type: 'User',
                checkedAt: Date.now(),
              },
              frameId: 'owned-main',
              loaderId: 'owned-loader',
            },
          };
          break;
        case 'create': {
          assert.ok(request.ownershipId);
          inventory.tabs.push({
            ownershipId: request.ownershipId,
            url: request.url,
            state: 'READY',
            reason: '',
            proof: {
              ownershipId: request.ownershipId,
              profileId: id,
              browserSessionEpoch: inventory.browserSessionEpoch,
              tabId: 77,
              targetId: 'owned-fb-target',
            },
          });
          value = { tabId: 77 };
          break;
        }
        case 'inventory':
          value = inventory;
          break;
        case 'revealOwnedPage':
          value = { tabId: request.proof.tabId, focused: true };
          break;
        case 'attach':
          value = {
            info: {
              targetId: 'owned-fb-target',
              type: 'page',
              title: '',
              url: options.native ? 'https://www.facebook.com/' : 'https://www.facebook.com/login/',
              attached: true,
            },
          };
          break;
        case 'project':
          value = {
            url: options.native ? 'https://www.facebook.com/' : 'https://www.facebook.com/login/',
            timeOrigin: 1000,
            ready: 'complete',
            visibility: 'visible',
            rows: request.projection.queries.map((q) => ({
              key: q.key,
              nodes:
                options.native && ['homeComposers', 'composerProfileLinks'].includes(q.key)
                  ? [
                      {
                        tag: 'a',
                        text: '',
                        visible: true,
                        attributes:
                          q.key === 'composerProfileLinks'
                            ? {
                                href:
                                  'https://www.facebook.com/profile.php?id=' +
                                  (options.foreign ? '99' : '10000000000001'),
                              }
                            : {},
                      },
                    ]
                  : q.key.startsWith('login') && !options.native
                    ? [{ tag: 'input', text: '', visible: true, attributes: {} }]
                    : [],
            })),
          };
          break;
        case 'remove':
          if (!wrongClose) {
            const row = inventory.tabs[0];
            if (row) row.state = 'CLOSED';
          }
          break;
        case 'stop':
          value = { state: 'stopped', requestId: request.requestId };
          break;
        case 'send':
          if (request.method === 'Page.getFrameTree')
            value = {
              frameTree: {
                frame: {
                  id: 'owned-main',
                  loaderId: options.changedLoader ? 'foreign-loader' : 'owned-loader',
                  url: 'https://www.facebook.com/',
                },
              },
            };
          else assert.equal(request.method, 'Page.enable');
          break;
      }
      const result = KernelJsonObject.parse(structuredClone(value));
      queueMicrotask(
        async () =>
          await kernel.message(peer, {
            type: 'KERNEL_REPLY',
            requestId: request.requestId,
            connectionEpoch: request.connectionEpoch,
            leaseId: request.leaseId,
            result,
          }),
      );
    },
    () => {},
  );
  peer.phase = 'PAUSED';
  peer.synced = true;
  peer.capabilities = ['kernel-journal-v1', 'facebook-readonly-v1', 'facebook-readonly-v2'];
  if (options.native) peer.capabilities.push('facebook-native-identity-v1');
  if (options.existing) peer.capabilities.push('facebook-existing-display-v1');
  const adapter = new KernelProfileInspection(kernel, core, workspace.tasks);
  const service = new ProfileInspectionService(adapter, Date.now);
  const close = async () => {
    const ending = service.close();
    await kernel.close();
    await ending;
    await core.disconnect(peer);
    store.close();
    workspace.close();
  };
  return {
    id,
    peer,
    inventory,
    requests,
    service,
    adapter,
    kernel,
    workspace,
    close,
    wrongClose: () => {
      wrongClose = true;
    },
  };
}
async function completed(service: ProfileInspectionService, id: string) {
  for (let n = 0; n < 30; n++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const row = service.get(id);
    if (row && !['QUEUED', 'READING'].includes(row.state)) return row;
  }
  throw Error('TEST_INSPECTION_NOT_COMPLETED');
}

test('queued daily admission consolidates extra READY pages and reuses a legacy group main without retained history', async () => {
  const f = await fixture({ native: true });
  try {
    f.peer.capabilities!.push('facebook-existing-display-v1', 'kernel-workspace-cleanup-v1');
    const saved = f.workspace.createCombination({
      name: '日常准入回归',
      note: '',
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    const [plan] = f.workspace.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: saved.id,
        version: saved.version,
        profileIds: [f.id],
      },
      [
        {
          id: f.id,
          online: true,
          synced: true,
          unresolved: 0,
          dispatchAllowed: false,
          account: { state: 'unknown', id: null, name: null, avatar: null },
        },
      ],
    );
    assert.ok(plan);
    const main = {
      profileId: f.id,
      browserSessionEpoch: f.inventory.browserSessionEpoch,
      ownershipId: randomUUID(),
      tabId: 7,
      targetId: 'legacy-group-page',
    };
    f.inventory.workspaceMain = main;
    f.inventory.tabs = [
      main,
      { ...main, ownershipId: randomUUID(), tabId: 8, targetId: 'extra-check-page' },
    ].map((proof) => ({
      proof,
      ownershipId: proof.ownershipId,
      state: 'READY',
      url: 'https://www.facebook.com/groups/123/',
      reason: '',
    }));
    let consolidated = 0,
      inspected = 0;
    f.kernel.consolidateFacebookWorkspace = async (_peer, prefer) => {
      assert.equal(prefer, false);
      consolidated++;
      f.inventory.tabs = f.inventory.tabs.slice(0, 1);
      return {
        profileId: f.id,
        proof: main,
        url: 'https://www.facebook.com/groups/123/',
        closedTabIds: [8],
        remainingTabCount: 1,
      };
    };
    Reflect.set(
      f.kernel,
      'inspectFacebookIdentity',
      async (_peer: unknown, guard: () => Promise<void>, retain: boolean, proof: unknown) => {
        await guard();
        assert.equal(retain, true);
        assert.deepEqual(proof, main);
        inspected++;
        return { actor: { accountId: '10000000000001' }, proof: main };
      },
    );
    const result = await f.adapter.readQueuedNativeActor(
      plan.id,
      { profileId: f.id, connectionEpoch: f.peer.epoch },
      () => {},
    );
    assert.equal(result?.actor.accountId, '10000000000001');
    assert.equal(consolidated, 1);
    assert.equal(inspected, 1);
    assert.equal(f.workspace.tasks.get(plan.id).state, 'QUEUED');
    assert.equal(f.workspace.tasks.operations(plan.id).length, 0);
    assert.equal(f.requests.includes('create'), false);
  } finally {
    await f.close();
  }
});

test('an existing interactive page with unknown actor is readable without granting identity or opening a new tab', async () => {
  const f = await fixture({ existing: true, interactive: true });
  try {
    const result = await f.adapter.readDisplay(
      { profileId: f.id, connectionEpoch: f.peer.epoch },
      () => {},
    );
    assert.equal(result.page.ready, 'interactive');
    assert.equal(result.actor, null);
    assert.deepEqual(f.requests, ['readFacebookDisplay']);
  } finally {
    await f.close();
  }
});

test('idle main display uses native ownership without SDK, attachment, creation or input', async () => {
  const f = await fixture();
  try {
    f.peer.capabilities?.push('kernel-owned-page-reveal-v1', 'facebook-task-kernel-v1');
    const proof = {
      profileId: f.id,
      browserSessionEpoch: f.inventory.browserSessionEpoch,
      ownershipId: randomUUID(),
      tabId: 7,
      targetId: 'registered-main',
    };
    f.inventory.workspaceMain = proof;
    f.inventory.tabs.push({
      ownershipId: proof.ownershipId,
      proof,
      state: 'READY',
      url: 'https://www.facebook.com/reel/123',
      reason: '',
    });
    assert.deepEqual(await f.kernel.revealOwnedFacebookPage(f.peer, proof), {
      profileId: f.id,
      tabId: 7,
      focused: true,
    });
    assert.deepEqual(f.requests, ['open', 'inventory', 'adopt', 'revealOwnedPage', 'stop']);
    assert.equal(f.inventory.tabs[0]?.state, 'READY');
  } finally {
    await f.close();
  }
});

test('explicit display uses independent window presentation even without a registered task proof', async () => {
  const f = await fixture();
  try {
    let reveals = 0;
    Reflect.set(Reflect.get(f.kernel, 'core'), 'revealBrowserWindow', async (id: string) => {
      assert.equal(id, f.id);
      reveals++;
      return { profileId: id, tabId: 77, focused: true as const };
    });
    assert.deepEqual(await f.kernel.revealRegisteredFacebookPage(f.peer), {
      profileId: f.id,
      tabId: 77,
      focused: true,
    });
    assert.equal(reveals, 1);
    assert.deepEqual(f.requests, []);
  } finally {
    await f.close();
  }
});

test('idle display rejects a stale registered proof and stops without changing any page', async () => {
  const f = await fixture();
  try {
    f.peer.capabilities?.push('kernel-owned-page-reveal-v1', 'facebook-task-kernel-v1');
    const proof = {
      profileId: f.id,
      browserSessionEpoch: f.inventory.browserSessionEpoch,
      ownershipId: randomUUID(),
      tabId: 7,
      targetId: 'registered-main',
    };
    f.inventory.workspaceMain = { ...proof, targetId: 'changed-target' };
    f.inventory.tabs.push({
      ownershipId: proof.ownershipId,
      proof: f.inventory.workspaceMain,
      state: 'READY',
      url: 'https://www.facebook.com/',
      reason: '',
    });
    await assert.rejects(
      f.kernel.revealOwnedFacebookPage(f.peer, proof),
      /WORKSPACE_REVEAL_PROOF_REJECTED/,
    );
    assert.deepEqual(f.requests, ['open', 'inventory', 'stop']);
  } finally {
    await f.close();
  }
});

test('public display permits only the registered idle main and delegates its exact proof without creating an inspection page', async () => {
  const f = await fixture();
  try {
    f.peer.capabilities?.push('kernel-workspace-main-proof-v1');
    const proof = {
      profileId: f.id,
      browserSessionEpoch: f.inventory.browserSessionEpoch,
      ownershipId: randomUUID(),
      tabId: 7,
      targetId: 'registered-main',
    };
    f.inventory.workspaceMain = proof;
    f.inventory.tabs.push({
      ownershipId: proof.ownershipId,
      proof,
      state: 'READY',
      url: 'https://www.facebook.com/reel/123',
      reason: '',
    });
    let observed = false;
    f.kernel.inspectRetainedFacebookDisplay = async (peer, received, guard) => {
      assert.equal(peer, f.peer);
      assert.deepEqual(received, proof);
      await guard();
      observed = true;
      return {
        page: {
          url: 'https://www.facebook.com/reel/123',
          timeOrigin: 1000,
          ready: 'complete',
          visibility: 'visible',
          rows: [],
        },
        actor: null,
      };
    };
    f.service.request([f.id]);
    assert.equal((await completed(f.service, f.id)).state, 'OBSERVED');
    assert.equal(observed, true);
    assert.equal(
      f.requests.some((request) =>
        ['create', 'attach', 'send', 'readFacebookDisplay'].includes(request),
      ),
      false,
    );
    const other = { ...proof, ownershipId: randomUUID(), tabId: 8, targetId: 'unresolved-other' };
    f.inventory.tabs.push({
      ownershipId: other.ownershipId,
      proof: other,
      state: 'READY',
      url: 'https://www.facebook.com/',
      reason: '',
    });
    f.peer.capabilities?.push('kernel-workspace-cleanup-v1');
    let consolidated = 0;
    f.kernel.consolidateFacebookWorkspace = async (peer, preferActive) => {
      assert.equal(peer, f.peer);
      assert.equal(preferActive, false);
      consolidated++;
      f.inventory.tabs = f.inventory.tabs.filter((row) => row.proof?.tabId === proof.tabId);
      return {
        profileId: f.id,
        proof,
        url: 'https://www.facebook.com/',
        closedTabIds: [other.tabId],
        remainingTabCount: 1,
      };
    };
    await f.adapter.assertIdle({ profileId: f.id, connectionEpoch: f.peer.epoch });
    assert.equal(consolidated, 1);
    assert.equal(f.inventory.tabs.length, 1);
  } finally {
    await f.close();
  }
});

test('missing native open acknowledgement cannot expose an account observation or create an inspection page', async () => {
  const f = await fixture({ unconfirmedOpen: true });
  try {
    f.service.request([f.id]);
    const result = await completed(f.service, f.id);
    assert.equal(result.state, 'FAILED');
    assert.equal(result.account.state, 'unknown');
    assert.equal(f.requests.includes('create'), false);
  } finally {
    await f.close();
  }
});

test('production read adapter completes summary, dedicated tab, projection, exact CLOSED and matching STOP before displaying login state', async () => {
  const f = await fixture();
  try {
    f.service.request([f.id]);
    const result = await completed(f.service, f.id);
    assert.equal(result.state, 'OBSERVED');
    assert.equal(result.account.state, 'logged-out');
    assert.deepEqual(f.requests, [
      'open',
      'inventory',
      'stop',
      'open',
      'create',
      'inventory',
      'attach',
      'send',
      'project',
      'remove',
      'inventory',
      'stop',
    ]);
    assert.equal(f.inventory.tabs[0]?.state, 'CLOSED');
  } finally {
    await f.close();
  }
});

test('public native display uses one closed read page and cannot create a plan or input operation', async () => {
  const f = await fixture({ native: true });
  try {
    f.service.observeConnections([f.id]);
    const result = await completed(f.service, f.id);
    assert.equal(result.account.state, 'logged-in');
    assert.equal(result.account.id, '10000000000001');
    assert.equal(result.account.name, 'Nway Myint');
    assert.equal(f.requests.filter((kind) => kind === 'create').length, 1);
    assert.equal(f.requests.filter((kind) => kind === 'observeFacebookIdentity').length, 1);
    assert.equal(f.inventory.tabs[0]?.state, 'CLOSED');
    assert.equal(f.requests.at(-1), 'stop');
    assert.equal(f.workspace.tasks.list().length, 0);
    assert.equal(f.inventory.operations.length, 0);
  } finally {
    await f.close();
  }
});

test('private queued bootstrap admits only its original untouched queue; public reads remain blocked and control across await revokes it', async () => {
  for (const revoke of [false, true]) {
    const f = await fixture({ native: true });
    try {
      const saved = f.workspace.createCombination({
        name: '生成待运行资料',
        note: '',
        steps: [
          {
            id: randomUUID(),
            type: 'post',
            resourceDirectory: 'C:\\generated',
            count: 1,
            allowRepeat: false,
            forbidSameAccountRepeat: true,
            archivePublished: true,
          },
        ],
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
      });
      const [plan] = f.workspace.tasks.assign(
        {
          requestId: randomUUID(),
          combinationId: saved.id,
          version: saved.version,
          profileIds: [f.id],
        },
        [
          {
            id: f.id,
            online: true,
            synced: true,
            unresolved: 0,
            dispatchAllowed: false,
            account: { state: 'unknown', id: null, name: null, avatar: null },
          },
        ],
      );
      assert.ok(plan);
      const connection = { profileId: f.id, connectionEpoch: f.peer.epoch };
      await assert.rejects(
        f.adapter.readNativeActor(connection, () => {}),
        /PLAN_PENDING/,
      );
      let calls = 0;
      const guard = () => {
        if (revoke && ++calls === 2) f.workspace.tasks.requestControl(plan.id, 'stop');
      };
      const work = f.adapter.readQueuedNativeActor(plan.id, connection, guard);
      if (revoke) await assert.rejects(work, /QUEUED_BOOTSTRAP_REVOKED/);
      else {
        const result = await work;
        assert.equal(result?.actor.accountId, '10000000000001');
        assert.equal(f.workspace.tasks.get(plan.id).state, 'QUEUED');
        assert.equal(f.workspace.tasks.operations(plan.id).length, 0);
        assert.equal(result.closedRecord?.state, 'CLOSED');
        assert.equal(f.requests.filter((kind) => kind === 'create').length, 1);
        assert.equal(f.requests.includes('remove'), true);
      }
    } finally {
      await f.close();
    }
  }
});

test('existing homepage display never creates or attaches a tab; absence leaves user pages untouched', async () => {
  for (const absent of [false, true]) {
    const f = await fixture({ existing: true, absent });
    try {
      const read = f.adapter.readDisplay(
        { profileId: f.id, connectionEpoch: f.peer.epoch },
        () => {},
      );
      if (absent) await assert.rejects(read, /INSPECTION_DOCUMENT_NOT_READY/);
      else assert.equal((await read).page.url, 'https://www.facebook.com/');
      assert.deepEqual(f.requests, ['readFacebookDisplay']);
      assert.equal(f.inventory.tabs.length, 0);
      assert.equal(f.inventory.operations.length, 0);
    } finally {
      await f.close();
    }
  }
});

test('private bootstrap accepts only native actor matched to the current document and homepage creator, with exact close and stop', async () => {
  for (const foreign of [false, true]) {
    const f = await fixture({ native: true, foreign });
    try {
      const decisions: string[] = [];
      const result = await f.adapter.readNativeActor(
        { profileId: f.id, connectionEpoch: f.peer.epoch },
        () => {},
        (decision) => decisions.push(decision.reason),
      );
      if (foreign) assert.equal(result, null);
      else {
        assert.equal(result?.actor.accountId, '10000000000001');
        assert.equal(result?.closedRecord.state, 'CLOSED');
      }
      assert.equal(f.inventory.tabs[0]?.state, 'CLOSED');
      assert.equal(f.requests.filter((kind) => kind === 'observeFacebookIdentity').length, 1);
      assert.equal(f.requests.at(-1), 'stop');
      assert.deepEqual(decisions, [
        foreign ? 'HOME_CREATOR_ACTOR_MISMATCH' : 'CURRENT_ACTOR_AND_CREATOR_MATCHED',
      ]);
    } finally {
      await f.close();
    }
  }
});

test('private native identity refuses a changed document and cannot bypass retained original native ownership', async () => {
  const changed = await fixture({ native: true, changedLoader: true });
  try {
    await assert.rejects(
      changed.adapter.readNativeActor(
        { profileId: changed.id, connectionEpoch: changed.peer.epoch },
        () => {},
      ),
      /FACEBOOK_IDENTITY_DOCUMENT_CHANGED/,
    );
    assert.equal(changed.inventory.tabs[0]?.state, 'CLOSED');
    assert.equal(changed.requests.filter((kind) => kind === 'remove').length, 1);
  } finally {
    await changed.close();
  }
  const retained = await fixture({ native: true });
  try {
    retained.inventory.tabs.push({
      ownershipId: randomUUID(),
      proof: null,
      state: 'UNKNOWN',
      url: 'https://www.facebook.com/',
      reason: 'CREATE_RESULT_UNKNOWN',
    });
    await assert.rejects(
      retained.adapter.readNativeActor(
        { profileId: retained.id, connectionEpoch: retained.peer.epoch },
        () => {},
      ),
      /INSPECTION_NATIVE_REVIEW_REQUIRED/,
    );
    assert.equal(retained.requests.includes('observeFacebookIdentity'), false);
    assert.equal(retained.requests.includes('create'), false);
  } finally {
    await retained.close();
  }
});

test('production capability gate refuses old extension without opening native session', async () => {
  const f = await fixture();
  try {
    f.peer.capabilities = ['kernel-journal-v1', 'facebook-readonly-v1'];
    f.service.request([f.id]);
    const result = await completed(f.service, f.id);
    assert.equal(result.reason, 'INSPECTION_EXTENSION_UPDATE_REQUIRED');
    assert.equal(f.requests.length, 0);
  } finally {
    await f.close();
  }
});

test('unknown native ownership is retained and blocks new page creation without automatic adoption or close', async () => {
  const f = await fixture();
  try {
    f.inventory.tabs.push({
      ownershipId: randomUUID(),
      proof: null,
      state: 'UNKNOWN',
      url: 'https://www.facebook.com/',
      reason: 'CREATE_RESULT_UNKNOWN',
    });
    f.service.request([f.id]);
    const result = await completed(f.service, f.id);
    assert.equal(result.reason, 'INSPECTION_NATIVE_REVIEW_REQUIRED');
    assert.deepEqual(f.requests, ['open', 'inventory', 'stop']);
    assert.equal(f.inventory.tabs[0]?.state, 'UNKNOWN');
  } finally {
    await f.close();
  }
});

test('unconfirmed native close discards login observation and retains original READY proof', async () => {
  const f = await fixture();
  try {
    f.wrongClose();
    f.service.request([f.id]);
    const result = await completed(f.service, f.id);
    assert.equal(result.state, 'FAILED');
    assert.equal(result.reason, 'INSPECTION_READ_RELEASE_UNCONFIRMED');
    assert.equal(result.account.state, 'unknown');
    assert.equal(f.inventory.tabs[0]?.state, 'READY');
    assert.ok(f.inventory.tabs[0]?.proof);
  } finally {
    await f.close();
  }
});
