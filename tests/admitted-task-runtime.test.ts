import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AdmittedTaskRuntime } from '../src/application/admitted-task-runtime.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import type { RuntimeProfile } from '../src/domain/tasks.js';
import type { ManagedProfileSession, QueuedProfileFactory } from '../src/domain/profile-actor.js';
import type { KernelState } from '../src/shared/kernel-state.js';
import type { ExecutionSession } from '../src/shared/task-execution.js';

test('single-profile guards read fresh transport without scanning other profiles or reviving unhealthy identity', async () => {
  const store = await WorkspaceStore.open(':memory:');
  const id = randomUUID();
  let raw: RuntimeProfile | undefined = {
    id,
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: false,
    account: { state: 'unknown', id: null, name: null, avatar: null },
  };
  const known: RuntimeProfile = {
    ...raw,
    dispatchAllowed: true,
    account: { state: 'logged-in', id: '123', name: null, avatar: null },
  };
  let allReads = 0;
  const factory: QueuedProfileFactory = {
    profile: (profileId) => {
      assert.equal(profileId, id);
      return known;
    },
    observeQueued: async () => {
      throw Error('UNUSED');
    },
    openClaimed: async () => {
      throw Error('UNUSED');
    },
    forget: () => {},
    close: async () => {},
  };
  const runtime = new AdmittedTaskRuntime(
    store.tasks,
    store.taskTabs,
    store.tasks.settlements,
    store.taskControls,
    factory,
    () => {
      allReads++;
      return [];
    },
    randomUUID,
    () => raw,
  );
  try {
    assert.equal((await runtime.profile(id))?.account.id, '123');
    for (const change of [{ online: false }, { synced: false }, { unresolved: 1 }]) {
      raw = { ...known, ...change };
      assert.equal((await runtime.profile(id))?.dispatchAllowed, false);
    }
    raw = undefined;
    assert.equal(await runtime.profile(id), undefined);
    raw = { ...known, id: randomUUID() };
    assert.equal(await runtime.profile(id), undefined);
    assert.equal(allReads, 0);
  } finally {
    await runtime.close();
    await store.close();
  }
});

test('50 queued profiles inspect only available slots; full budget prevents new admission IO', async () => {
  const store = await WorkspaceStore.open(':memory:');
  store.tasks.setSettings({ maxConcurrentProfiles: 2 });
  const profiles: RuntimeProfile[] = Array.from({ length: 50 }, () => ({
    id: randomUUID(),
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: false,
    account: { state: 'unknown', id: null, name: null, avatar: null },
  }));
  const combination = store.createCombination({
    name: '批量准入预算',
    note: '生成身份，无浏览器操作',
    steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
  });
  store.tasks.assign(
    {
      requestId: randomUUID(),
      combinationId: combination.id,
      version: 1,
      profileIds: profiles.map((row) => row.id),
    },
    profiles,
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted = new Map<string, RuntimeProfile>();
  const reads: string[] = [];
  const factory: QueuedProfileFactory = {
    profile: (id) => admitted.get(id) ?? null,
    observeQueued: async (id) => {
      const plan = store.tasks.get(id);
      reads.push(plan.profileId);
      await gate;
      const raw = profiles.find((row) => row.id === plan.profileId);
      assert.ok(raw);
      const known: RuntimeProfile = {
        ...raw,
        dispatchAllowed: true,
        account: { state: 'logged-in', id: 'generated-' + raw.id, name: null, avatar: null },
      };
      admitted.set(raw.id, known);
      return known;
    },
    openClaimed: async () => {
      throw Error('NO_BROWSER_IN_BUDGET_TEST');
    },
    forget: (id) => {
      admitted.delete(id);
    },
    close: async () => {},
  };
  const runtime = new AdmittedTaskRuntime(
    store.tasks,
    store.taskTabs,
    store.tasks.settlements,
    store.taskControls,
    factory,
    () => profiles,
    randomUUID,
  );
  try {
    const requests = profiles.map(async (row) => runtime.observe(row.id));
    const settled = Promise.allSettled(requests);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reads.length, 2);
    release();
    const results = await settled;
    assert.equal(results.filter((row) => row.status === 'fulfilled').length, 2);
    assert.equal(
      results.filter(
        (row) => row.status === 'rejected' && String(row.reason).includes('CONCURRENCY_LIMIT'),
      ).length,
      48,
    );
    assert.ok(store.tasks.claimNext(await runtime.schedulingProfiles(), new Set(['feed'])));
    assert.ok(store.tasks.claimNext(await runtime.schedulingProfiles(), new Set(['feed'])));
    await assert.rejects(runtime.observe(profiles[2]!.id), /CONCURRENCY_LIMIT/);
    assert.equal(reads.length, 2);
    assert.equal(store.tasks.list().filter((row) => row.state === 'RUNNING').length, 2);
  } finally {
    release();
    await runtime.close();
    store.close();
  }
});

async function fixture(browse = false) {
  const store = await WorkspaceStore.open(':memory:');
  const profileId = randomUUID(),
    offlineId = randomUUID();
  const raw: RuntimeProfile = {
    id: profileId,
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: false,
    account: { state: 'unknown', id: null, name: null, avatar: null },
  };
  const offline: RuntimeProfile = { ...raw, id: offlineId, online: false };
  const known: RuntimeProfile = {
    ...raw,
    dispatchAllowed: true,
    account: { state: 'logged-in', id: 'generated-user', name: '生成资料', avatar: null },
  };
  const saved = store.createCombination({
    name: '原任务运行入口',
    note: '模拟，无真实浏览器',
    steps: browse
      ? [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }]
      : [
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
    {
      requestId: randomUUID(),
      combinationId: saved.id,
      version: saved.version,
      profileIds: [profileId],
    },
    [raw],
  );
  assert.ok(plan);
  const context: ExecutionSession = {
    profileId,
    accountId: 'generated-user',
    connectionEpoch: randomUUID(),
    leaseId: randomUUID(),
    generation: 0,
  };
  const proof = {
    profileId,
    ownershipId: randomUUID(),
    browserSessionEpoch: randomUUID(),
    tabId: 42,
    targetId: 'generated-owned-page',
  };
  const remote: KernelState = {
    version: 1,
    profileId,
    browserSessionEpoch: proof.browserSessionEpoch,
    operations: [],
    tabs: [
      {
        proof,
        ownershipId: proof.ownershipId,
        url: 'https://www.facebook.com/',
        state: 'READY',
        reason: '',
      },
    ],
  };
  let admitted = false,
    reads = 0,
    opens = 0,
    stops = 0;
  let current: ExecutionSession | null = context;
  let beforeOpen: () => Promise<void> = async () => {};
  const port: ManagedProfileSession = {
    profileId,
    profile: () => known,
    current: () => current,
    inventory: async () => structuredClone(remote),
    notify: async (binding, resolution) => ({ binding, resolution }),
    setFailureHandler: () => {},
    sendGuarded: async () => {
      throw Error('NO_INPUT_ALLOWED_IN_ADMISSION_TEST');
    },
    stop: async (binding) => {
      stops++;
      current = null;
      remote.tabs[0]!.state = 'CLOSED';
      return { ...binding, state: 'stopped' };
    },
  };
  const factory: QueuedProfileFactory = {
    profile: (id) => (admitted && id === profileId ? structuredClone(known) : null),
    observeQueued: async (id) => {
      assert.equal(id, plan.id);
      reads++;
      admitted = true;
      return structuredClone(known);
    },
    openClaimed: async (id) => {
      assert.equal(store.tasks.get(id).state, 'RUNNING');
      opens++;
      await beforeOpen();
      if (store.tasks.get(id).state === 'RUNNING') store.taskTabs.register(plan.id, proof, context);
      return port;
    },
    forget: () => {
      admitted = false;
    },
    close: async () => {
      admitted = false;
    },
  };
  const runtime = new AdmittedTaskRuntime(
    store.tasks,
    store.taskTabs,
    store.tasks.settlements,
    store.taskControls,
    factory,
    () => [raw, offline],
    randomUUID,
  );
  return {
    store,
    plan,
    runtime,
    raw,
    remote,
    context,
    port,
    counts: () => ({ reads, opens, stops }),
    before: (fn: typeof beforeOpen) => {
      beforeOpen = fn;
    },
    close: async () => {
      await runtime.close();
      store.close();
    },
  };
}

test('hundred-profile startup admits all hundred together without the old four-startup cap or preclaiming plans', async () => {
  const store = await WorkspaceStore.open(':memory:');
  const admitted = new Map<string, RuntimeProfile>();
  const profiles: RuntimeProfile[] = Array.from({ length: 100 }, () => ({
    id: randomUUID(),
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: false,
    account: { state: 'unknown', id: null, name: null, avatar: null },
  }));
  const known = new Map(
    profiles.map((p, i) => [
      p.id,
      {
        ...p,
        dispatchAllowed: true,
        account: { state: 'logged-in' as const, id: 'generated-' + i, name: null, avatar: null },
      },
    ]),
  );
  store.tasks.setSettings({ maxConcurrentProfiles: 100 });
  const saved = store.createCombination({
    name: 'Hundred startup budget',
    note: '',
    steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
  });
  store.tasks.assign(
    {
      requestId: randomUUID(),
      combinationId: saved.id,
      version: 1,
      profileIds: profiles.map((p) => p.id),
    },
    profiles,
  );
  let active = 0,
    maximum = 0;
  let releases: (() => void)[] = [];
  const factory: QueuedProfileFactory = {
    profile: (id) => admitted.get(id) ?? null,
    observeQueued: async (id) => {
      const plan = store.tasks.get(id);
      active++;
      maximum = Math.max(maximum, active);
      try {
        await new Promise<void>((resolve) => releases.push(resolve));
        admitted.set(plan.profileId, known.get(plan.profileId)!);
        return known.get(plan.profileId)!;
      } finally {
        active--;
      }
    },
    openClaimed: async () => {
      throw Error('NO_EXECUTOR_STARTED');
    },
    forget: () => {},
    close: async () => {},
  };
  const runtime = new AdmittedTaskRuntime(
    store.tasks,
    store.taskTabs,
    store.tasks.settlements,
    store.taskControls,
    factory,
    () => profiles,
    randomUUID,
  );
  try {
    while (admitted.size < 100) {
      const results = Promise.allSettled(
        profiles.filter((p) => !admitted.has(p.id)).map(async (p) => runtime.observe(p.id)),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(active, 100);
      assert.equal(runtime.startupStatus().active, active);
      assert.equal(store.tasks.livePlans().filter((p) => p.state === 'RUNNING').length, 0);
      const batch = releases;
      releases = [];
      batch.forEach((release) => release());
      await results;
      assert.equal(runtime.startupStatus().active, 0);
    }
    assert.equal(maximum, 100);
    assert.equal(runtime.startupStatus().deferred, 0);
    assert.equal(admitted.size, 100);
  } finally {
    releases.forEach((release) => release());
    await runtime.close();
    store.close();
  }
});

test('production admission wrapper carries a fresh proof through observation and preparation without a second scope', async () => {
  const f = await fixture(true);
  try {
    await f.runtime.observe(f.raw.id);
    assert.ok(f.store.tasks.claimNext(await f.runtime.schedulingProfiles(), new Set(['feed'])));
    await f.runtime.observe(f.raw.id);
    let checks = 0;
    f.port.confirmTaskTab = async () => {
      checks++;
    };
    f.port.inventory = async () => {
      throw Error('UNNECESSARY_FULL_HISTORY');
    };
    const first = f.runtime.observe(f.raw.id),
      second = f.runtime.observe(f.raw.id);
    assert.equal(first, second);
    const observed = (await first) || undefined;
    assert.ok(observed);
    assert.deepEqual(observed, f.remote.tabs[0]?.proof);
    assert.equal(checks, 1);
    await f.runtime.preparePlan(f.store.tasks.get(f.plan.id), f.context, observed || undefined);
    assert.equal(checks, 1);
    await f.runtime.preparePlan(f.store.tasks.get(f.plan.id), f.context);
    assert.equal(checks, 2);
    const row = f.store.taskTabs.forPlan(f.plan.id)[0];
    assert.ok(row && observed);
    f.store.taskTabs.requireRecheck(
      row.proof.ownershipId,
      row.revision,
      'GENERATED_RECHECK',
      f.plan.id,
    );
    await assert.rejects(
      f.runtime.preparePlan(f.store.tasks.get(f.plan.id), f.context, observed),
      /TASK_TAB_OBSERVATION_CHANGED/,
    );
    assert.equal(f.store.tasks.operations(f.plan.id).length, 0);
  } finally {
    await f.close();
  }
});

test('private queued identity enters original SQL claim then one original actor and exact task tab, preserves offline inventory and native stop binding', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.runtime.profiles()).length, 2);
    assert.equal((await f.runtime.schedulingProfiles())[0]?.dispatchAllowed, false);
    await f.runtime.observe(f.raw.id);
    assert.equal(await f.runtime.session(f.raw.id), null);
    assert.equal((await f.runtime.schedulingProfiles())[0]?.dispatchAllowed, true);
    const claimed = f.store.tasks.claimNext(
      await f.runtime.schedulingProfiles(),
      new Set(['post']),
    );
    assert.equal(claimed?.id, f.plan.id);
    const first = f.runtime.observe(f.raw.id),
      second = f.runtime.observe(f.raw.id);
    assert.equal(first, second);
    await first;
    assert.deepEqual(await f.runtime.session(f.raw.id), f.context);
    assert.equal((await f.runtime.registry.status()).length, 1);
    await f.runtime.preparePlan(f.store.tasks.get(f.plan.id), f.context);
    assert.equal(f.store.taskTabs.forPlan(f.plan.id).length, 1);
    f.remote.tabs[0]!.proof = { ...f.remote.tabs[0]!.proof!, targetId: 'foreign' };
    await assert.rejects(
      f.runtime.preparePlan(f.store.tasks.get(f.plan.id), f.context),
      /NATIVE_TASK_TAB_UNCONFIRMED/,
    );
    const stopped = await f.runtime.control(f.plan.id, 'stop');
    assert.equal(stopped.state, 'STOPPED');
    assert.equal(stopped.controlConfirmed, true);
    assert.equal(f.store.taskControls.list()[0]?.receipt?.requestId, stopped.controlRequestId);
    assert.deepEqual(f.counts(), { reads: 1, opens: 1, stops: 1 });
    assert.equal(f.store.tasks.operations(f.plan.id).length, 0);
  } finally {
    await f.close();
  }
});

test('stop while claimed SDK owner opens closes only that fresh owner and never fabricates plan stop confirmation', async () => {
  const f = await fixture();
  try {
    await f.runtime.observe(f.raw.id);
    f.store.tasks.claimNext(await f.runtime.schedulingProfiles(), new Set(['post']));
    let release!: () => void;
    f.before(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const opening = f.runtime.observe(f.raw.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const plan = f.store.tasks.requestControl(f.plan.id, 'stop');
    assert.equal(plan.state, 'STOPPING');
    release();
    await assert.rejects(opening, /OPEN_REVOKED/);
    assert.equal((await f.runtime.registry.status()).length, 0);
    assert.equal(f.counts().stops, 1);
    assert.equal(f.store.tasks.get(f.plan.id).controlConfirmed, false);
    assert.equal(f.store.tasks.operations(f.plan.id).length, 0);
  } finally {
    await f.close();
  }
});

test('startup handoff waits for its own actor without masking an offline transport or another plan', async () => {
  for (const mode of ['opening', 'offline', 'foreign'] as const) {
    const f = await fixture();
    try {
      await f.runtime.observe(f.raw.id);
      f.store.tasks.claimNext(await f.runtime.schedulingProfiles(), new Set(['post']));
      let release!: () => void;
      f.before(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const opening = f.runtime.observe(f.raw.id);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const profile = (await f.runtime.profiles()).find((row) => row.id === f.raw.id)!;
      assert.equal(profile.openingPlanId, f.plan.id);
      f.store.tasks.reconcileRuntime([
        {
          ...profile,
          dispatchAllowed: false,
          account: { state: 'unknown', id: null, name: null, avatar: null },
          online: mode !== 'offline',
          openingPlanId: mode === 'foreign' ? randomUUID() : f.plan.id,
        },
      ]);
      assert.equal(f.store.tasks.operations(f.plan.id).length, 0);
      assert.equal(f.store.tasks.get(f.plan.id).state, mode === 'opening' ? 'RUNNING' : 'PAUSING');
      release();
      if (mode === 'opening') {
        await opening;
        assert.equal((await f.runtime.profiles())[0]?.openingPlanId, undefined);
      } else await assert.rejects(opening, /OPEN_REVOKED/);
    } finally {
      await f.close();
    }
  }
});

test('explicit stop during opening revokes first and confirms only the returned original owner receipt', async () => {
  const f = await fixture(true);
  try {
    await f.runtime.observe(f.raw.id);
    f.store.tasks.claimNext(await f.runtime.schedulingProfiles(), new Set(['feed']));
    let release!: () => void;
    f.before(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const opening = f.runtime.observe(f.raw.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const rejectedOpening = assert.rejects(opening, /OPEN_REVOKED/);
    const stopping = f.runtime.controlFromUser(f.plan.id, 'stop', 'USER_STOP');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.store.tasks.get(f.plan.id).state, 'STOPPING');
    assert.equal(f.store.tasks.get(f.plan.id).controlConfirmed, false);
    assert.equal(f.counts().stops, 0);
    release();
    const stopped = await stopping;
    await rejectedOpening;
    assert.equal(stopped.state, 'STOPPED');
    assert.equal(stopped.controlConfirmed, true);
    assert.equal(f.store.taskControls.list()[0]?.receipt?.requestId, stopped.controlRequestId);
    assert.equal(f.store.tasks.operations(f.plan.id).length, 0);
    assert.equal((await f.runtime.registry.status()).length, 0);
    assert.equal(f.counts().stops, 1);
  } finally {
    await f.close();
  }
});

test('explicit opening cancellation cannot confirm a stop if admission fails without returning its owner', async () => {
  const f = await fixture(true);
  try {
    await f.runtime.observe(f.raw.id);
    f.store.tasks.claimNext(await f.runtime.schedulingProfiles(), new Set(['feed']));
    let release!: () => void;
    f.before(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw Error('INITIAL_OPEN_LOST');
    });
    const opening = f.runtime.observe(f.raw.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const rejectedOpening = assert.rejects(opening, /INITIAL_OPEN_LOST/);
    const stopping = f.runtime.controlFromUser(f.plan.id, 'stop', 'USER_STOP');
    const rejectedStop = assert.rejects(stopping, /OWNER_REQUIRED/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.store.tasks.get(f.plan.id).state, 'STOPPING');
    release();
    await Promise.all([rejectedOpening, rejectedStop]);
    assert.equal(f.store.tasks.get(f.plan.id).controlConfirmed, false);
    assert.equal(f.store.taskControls.list().length, 0);
    assert.equal(f.store.tasks.operations(f.plan.id).length, 0);
  } finally {
    await f.close();
  }
});

test('failed initial SDK admission persists original REVIEW and account lock without reopening, input or invented stop confirmation', async () => {
  const f = await fixture();
  try {
    await f.runtime.observe(f.raw.id);
    f.store.tasks.claimNext(await f.runtime.schedulingProfiles(), new Set(['post']));
    f.before(async () => {
      throw Error('INITIAL_NATIVE_DOCUMENT_UNKNOWN');
    });
    await assert.rejects(f.runtime.observe(f.raw.id), /INITIAL_NATIVE_DOCUMENT_UNKNOWN/);
    const failed = f.store.tasks.get(f.plan.id);
    assert.equal(failed.state, 'REVIEW');
    assert.equal(failed.reason, 'INITIAL_SESSION_FAILED:INITIAL_NATIVE_DOCUMENT_UNKNOWN');
    assert.equal(failed.controlConfirmed, false);
    assert.equal(f.store.taskControls.list().length, 0);
    assert.equal(f.store.tasks.operations(f.plan.id).length, 0);
    assert.equal((await f.runtime.registry.status()).length, 0);
    await assert.rejects(f.runtime.observe(f.raw.id), /EXPLICIT_RECOVERY_REQUIRED/);
    assert.equal(f.counts().opens, 1);
    const other = {
      ...f.raw,
      id: randomUUID(),
      account: { state: 'logged-in' as const, id: f.context.accountId, name: null, avatar: null },
      dispatchAllowed: true,
    };
    const queued = f.store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: failed.combinationId,
        version: failed.version,
        profileIds: [other.id],
      },
      [other],
    )[0];
    assert.ok(queued);
    assert.equal(f.store.tasks.claimNext([other], new Set(['post'])), null);
    assert.equal(f.store.tasks.get(queued.id).state, 'QUEUED');
  } finally {
    await f.close();
  }
});
