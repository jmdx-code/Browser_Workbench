import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Core, Peer } from '../src/bridge/core.js';
import type { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import type { FacebookMaterialInputs } from '../src/infrastructure/kernel-managed-facebook-session.js';
import { NativeFacebookProfileFactory } from '../src/infrastructure/facebook-profile-factory.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import type { RuntimeProfile } from '../src/domain/tasks.js';

async function fixture(retained = false, cleanupFailure = false, workspace = false) {
  const store = await WorkspaceStore.open(':memory:');
  const id = randomUUID();
  const profile: RuntimeProfile = {
    id,
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: false,
    account: { state: 'unknown', id: null, name: null, avatar: null },
  };
  const saved = store.createCombination({
    name: '生成资料入队',
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
  const [plan] = store.tasks.assign(
    { requestId: randomUUID(), combinationId: saved.id, version: saved.version, profileIds: [id] },
    [profile],
  );
  assert.ok(plan);
  let time = 1000,
    reads = 0,
    opens = 0;
  const peer = {
    profileId: id,
    epoch: randomUUID(),
    online: true,
    synced: true,
    phase: 'PAUSED',
  } as unknown as Peer;
  const core = { peers: new Map([[id, peer]]), store: { unresolved: () => [] } } as unknown as Core;
  const proof = {
    profileId: id,
    ownershipId: randomUUID(),
    browserSessionEpoch: randomUUID(),
    tabId: 42,
    targetId: 'generated-readonly-target',
  };
  const evidence: NonNullable<
    Awaited<
      ReturnType<
        NonNullable<
          ConstructorParameters<typeof NativeFacebookProfileFactory>[6]
        >['readQueuedNativeActor']
      >
    >
  > = {
    actor: {
      version: 1,
      source: 'CometSettingsDropdownTriggerQuery',
      type: 'User',
      accountId: '123',
      name: '生成身份',
      checkedAt: 1000,
    },
    transport: 'document-preload',
    retained,
    workspaceRetained: workspace,
    connection: { profileId: id, connectionEpoch: peer.epoch },
    proof,
    closedRecord: {
      ownershipId: proof.ownershipId,
      proof,
      state: retained ? 'READY' : 'CLOSED',
      url: 'https://www.facebook.com/',
      reason: 'TAB_REMOVED',
    },
    stop: { requestId: randomUUID(), state: 'stopped' },
    page: {
      url: 'https://www.facebook.com/',
      timeOrigin: 100,
      ready: 'complete',
      visibility: 'visible',
      rows: [],
    },
  };
  let beforeRead: (guard: () => void) => Promise<void> = async () => {};
  let cleaned = 0;
  const factory = new NativeFacebookProfileFactory(
    {
      discardAdmissionTab: async (_peer: Peer, exact: typeof proof) => {
        assert.deepEqual(exact, proof);
        cleaned++;
        if (cleanupFailure) throw Error('GENERATED_CLEANUP_FAILURE');
      },
    } as unknown as KernelBridge,
    core,
    store.tasks,
    store.taskTabs,
    {} as FacebookMaterialInputs,
    () => time,
    {
      readQueuedNativeActor: async (planId, connection, guard) => {
        reads++;
        assert.equal(planId, plan.id);
        assert.equal(connection.connectionEpoch, peer.epoch);
        await guard();
        await beforeRead(guard);
        await guard();
        return evidence;
      },
    },
    async (_kernel, samePeer, claimed, authority) => {
      opens++;
      assert.equal(samePeer, peer);
      assert.equal(claimed.state, 'RUNNING');
      await authority.assertIdentity('123');
      if (retained) assert.deepEqual(authority.admissionTab?.(), proof);
      throw Error('GENERATED_OPEN_FAILURE');
    },
  );
  return {
    store,
    plan,
    peer,
    core,
    factory,
    evidence,
    counts: () => ({ reads, opens }),
    cleaned: () => cleaned,
    setTime: (t: number) => {
      time = t;
    },
    before: (fn: typeof beforeRead) => {
      beforeRead = fn;
    },
    close: async () => {
      await factory.close();
      store.close();
    },
  };
}

test('workspace admission preserves its main page when queued stop or opening fails', async () => {
  for (const cancel of [false, true]) {
    const f = await fixture(true, false, true);
    try {
      await f.factory.observeQueued(f.plan.id);
      if (cancel) {
        f.store.tasks.requestControl(f.plan.id, 'stop');
        await f.factory.forget(f.peer.profileId);
      } else {
        const profile = await f.factory.profile(f.peer.profileId);
        assert.ok(profile);
        assert.ok(f.store.tasks.claimNext([profile], new Set(['post'])));
        await assert.rejects(f.factory.openClaimed(f.plan.id), /GENERATED_OPEN_FAILURE/);
      }
      assert.equal(f.cleaned(), 0);
      assert.equal(f.store.tasks.operations(f.plan.id).length, 0);
    } finally {
      await f.close();
    }
  }
});

test('retained admission uses the same proof and cleans it after failed open without replay', async () => {
  const f = await fixture(true);
  try {
    await f.factory.observeQueued(f.plan.id);
    const profile = await f.factory.profile(f.peer.profileId);
    assert.ok(profile);
    assert.ok(f.store.tasks.claimNext([profile], new Set(['post'])));
    await assert.rejects(f.factory.openClaimed(f.plan.id), /GENERATED_OPEN_FAILURE/);
    assert.equal(f.cleaned(), 1);
    await assert.rejects(f.factory.openClaimed(f.plan.id), /UNCONSUMED_ADMISSION/);
    assert.equal(f.cleaned(), 1);
    assert.equal(f.store.tasks.operations(f.plan.id).length, 0);
  } finally {
    await f.close();
  }
});

test('failed admission cleanup cannot replace the original open failure or replay the consumed admission', async () => {
  const f = await fixture(true, true);
  try {
    await f.factory.observeQueued(f.plan.id);
    const profile = await f.factory.profile(f.peer.profileId);
    assert.ok(profile);
    assert.ok(f.store.tasks.claimNext([profile], new Set(['post'])));
    await assert.rejects(f.factory.openClaimed(f.plan.id), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, 'GENERATED_OPEN_FAILURE');
      assert.deepEqual(
        error.errors.map((item: Error) => item.message),
        ['GENERATED_OPEN_FAILURE', 'GENERATED_CLEANUP_FAILURE'],
      );
      return true;
    });
    await assert.rejects(f.factory.openClaimed(f.plan.id), /UNCONSUMED_ADMISSION/);
    assert.equal(f.cleaned(), 1);
    assert.equal(f.store.tasks.operations(f.plan.id).length, 0);
  } finally {
    await f.close();
  }
});

test('queued stop releases a retained admission instead of leaving a browser-wide block', async () => {
  const f = await fixture(true);
  try {
    await f.factory.observeQueued(f.plan.id);
    f.store.tasks.requestControl(f.plan.id, 'stop');
    await f.factory.forget(f.peer.profileId);
    assert.equal(f.cleaned(), 1);
    assert.equal(await f.factory.profile(f.peer.profileId), null);
    assert.equal(f.store.tasks.get(f.plan.id).state, 'STOPPED');
  } finally {
    await f.close();
  }
});

test('closed current native observation feeds only original claim, expires and failed SDK open consumes admission without retry', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.factory.profile(f.peer.profileId), null);
    const admission = await f.factory.observeQueued(f.plan.id);
    assert.equal(f.store.tasks.get(f.plan.id).state, 'QUEUED');
    assert.equal(admission.account.id, '123');
    // Returned caller data and the observer's object cannot alter the private evidence.
    admission.account.id = 'foreign';
    f.evidence.actor.accountId = 'foreign';
    assert.equal((await f.factory.profile(f.peer.profileId))?.account.id, '123');
    const claimed = f.store.tasks.claimNext(
      [(await f.factory.profile(f.peer.profileId))!],
      new Set(['post']),
    );
    assert.equal(claimed?.accountId, '123');
    await assert.rejects(f.factory.openClaimed(f.plan.id), /GENERATED_OPEN_FAILURE/);
    await assert.rejects(f.factory.openClaimed(f.plan.id), /UNCONSUMED_ADMISSION/);
    assert.deepEqual(f.counts(), { reads: 1, opens: 1 });
    assert.equal(f.store.tasks.operations(f.plan.id).length, 0);
    f.setTime(31_001);
    assert.equal(await f.factory.profile(f.peer.profileId), null);
  } finally {
    await f.close();
  }
});

test('queued observation is single-flight and a stop during await rejects late evidence before any claim', async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    f.before(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const first = f.factory.observeQueued(f.plan.id),
      second = f.factory.observeQueued(f.plan.id);
    assert.equal(first, second);
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.store.tasks.requestControl(f.plan.id, 'stop');
    release();
    await assert.rejects(first, /ADMISSION_REVOKED/);
    assert.equal(await f.factory.profile(f.peer.profileId), null);
    assert.deepEqual(f.counts(), { reads: 1, opens: 0 });
  } finally {
    await f.close();
  }
});

test('wrong close proof, replaced epoch and shutdown cannot produce current admission', async () => {
  for (const mode of ['proof', 'epoch', 'shutdown'] as const) {
    const f = await fixture();
    try {
      if (mode === 'proof')
        f.evidence.closedRecord.proof = { ...f.evidence.proof, targetId: 'foreign' };
      if (mode === 'epoch')
        f.before(async () => {
          f.peer.epoch = randomUUID();
        });
      if (mode === 'shutdown') await f.factory.close();
      await assert.rejects(f.factory.observeQueued(f.plan.id));
      assert.equal(await f.factory.profile(f.peer.profileId), null);
      assert.equal(f.store.tasks.get(f.plan.id).state, 'QUEUED');
      assert.equal(f.counts().opens, 0);
    } finally {
      await f.close();
    }
  }
});
