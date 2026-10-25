import { flatMapAsync } from '../src/shared/async-collections.js';
import { BusinessResolution } from '../src/shared/settlement.js';
import { latestMigrationBackupMarker } from './fixtures/workspace-schema.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ProfileActorRegistry } from '../src/application/profile-actor-registry.js';
import { TaskDispatcher } from '../src/application/task-dispatcher.js';
import { TaskCycleHost } from '../src/application/task-cycle-host.js';
import type { ManagedProfileSession } from '../src/domain/profile-actor.js';
import type { RuntimeProfile } from '../src/domain/tasks.js';
import type { ExecutionSession } from '../src/shared/task-execution.js';
import type { StopBinding, ControlBinding } from '../src/shared/task-control.js';
import type { KernelState } from '../src/shared/kernel-state.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { settlementFixture, prepareBound } from './fixtures/settlement.js';
import { dropControlSchema } from './fixtures/control.js';
import { postFixture, postRequest } from './fixtures/material-post.js';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

function latch() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    promise,
    release: () => {
      assert.ok(resolve);
      resolve();
    },
  };
}

test('matched parent stop retires only the revoked same-epoch cancellation owner without confirming history or another profile', async () => {
  await settlementFixture(async (store) => {
    const h = await harness(store),
      f = await h.add(),
      other = await h.add(),
      gate = latch();
    f.port.stop = async (binding) => {
      await gate.promise;
      return { ...binding, state: 'stopped' };
    };
    assert.equal(
      await h.registry.retireParentStoppedOwner(f.profile.id, f.context.connectionEpoch),
      false,
    );
    const stopping = h.registry.control(f.plan.id, 'stop', 'USER_STOP');
    const rejected = assert.rejects(stopping, /ACTOR_STOP_OWNER_CHANGED/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      await h.registry.retireParentStoppedOwner(f.profile.id, f.context.connectionEpoch),
      false,
    );
    f.live.context = null;
    assert.equal(await h.registry.retireParentStoppedOwner(f.profile.id, randomUUID()), false);
    const before = await store.tasks.get(f.plan.id);
    assert.equal(
      await h.registry.retireParentStoppedOwner(f.profile.id, f.context.connectionEpoch),
      true,
    );
    assert.deepEqual(await store.tasks.get(f.plan.id), before);
    assert.equal(before.controlConfirmed, false);
    assert.ok((await h.registry.status()).some((entry) => entry.profileId === other.profile.id));
    gate.release();
    await rejected;
    assert.equal((await store.tasks.get(f.plan.id)).controlConfirmed, false);
    assert.equal((await store.tasks.get(f.plan.id)).state, 'STOPPING');
    await h.registry.close();
  });
});

test('replaced disconnected stop owner retires locally without confirming old stop; late receipt cannot mutate the plan', async () => {
  await settlementFixture(async (store) => {
    const h = await harness(store),
      f = await h.add(),
      gate = latch();
    await store.taskTabs.register(
      f.plan.id,
      {
        profileId: f.profile.id,
        ownershipId: randomUUID(),
        browserSessionEpoch: randomUUID(),
        tabId: 42,
        targetId: randomUUID(),
      },
      f.context,
    );
    f.port.stop = async (binding) => {
      await gate.promise;
      return { ...binding, state: 'stopped' };
    };
    const stopping = h.registry.control(f.plan.id, 'pause', 'GENERATED_CONNECTION_LOST');
    const rejected = assert.rejects(stopping, /ACTOR_STOP_OWNER_CHANGED/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      await h.registry.retireReplacedOwner(f.profile.id, randomUUID()),
      false,
      'live port cannot be retired',
    );
    f.live.context = null;
    assert.equal(
      await h.registry.retireReplacedOwner(f.profile.id, f.context.connectionEpoch),
      false,
      'same connection cannot be retired',
    );
    assert.equal(await h.registry.retireReplacedOwner(f.profile.id, randomUUID()), true);
    assert.equal((await h.registry.status()).length, 0);
    assert.equal((await store.tasks.get(f.plan.id)).controlConfirmed, false);
    gate.release();
    await rejected;
    assert.equal((await store.tasks.get(f.plan.id)).controlConfirmed, false);
    assert.equal((await store.tasks.get(f.plan.id)).state, 'PAUSING');
    assert.equal((await store.taskTabs.forPlan(f.plan.id))[0]?.state, 'RECHECK_REQUIRED');
  });
});

test('upload preparation failure from the SDK lifecycle records the post step intent before current control stops', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const profile: RuntimeProfile = {
      id: r.context.profileId,
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in', id: r.context.accountId, name: null, avatar: null },
    };
    const registry = new ProfileActorRegistry(
      () => [profile],
      store.tasks,
      store.tasks.settlements,
      store.taskControls,
      store.taskTabs,
      randomUUID,
    );
    let context: ExecutionSession | null = r.context,
      fail: ((reason: string) => Promise<void>) | undefined;
    const port: ManagedProfileSession = {
      profileId: profile.id,
      profile: () => profile,
      current: () => context,
      inventory: async () => ({
        version: 1,
        profileId: profile.id,
        browserSessionEpoch: r.proof.browserSessionEpoch,
        operations: [],
        tabs: [],
      }),
      notify: async (binding, resolution) => ({ binding, resolution }),
      setFailureHandler: (handler) => {
        fail = handler;
      },
      sendGuarded: async () => {
        throw Error('GENERATED_NO_INPUT');
      },
      stop: async (binding) => {
        context = null;
        return { ...binding, state: 'stopped' };
      },
    };
    await registry.attach(port);
    assert.ok(fail);
    await fail('UPLOAD_STAGE_ROOT_INVALID');
    assert.equal((await store.tasks.stepEnding(r.jobId))?.stepId, r.stepId);
    assert.equal((await store.tasks.stepEnding(r.jobId))?.reason, 'UPLOAD_STAGE_ROOT_INVALID');
    assert.equal((await store.tasks.get(r.jobId)).controlConfirmed, true);
    assert.equal((await store.tasks.get(r.jobId)).state, 'PAUSED');
  }, false);
});
async function harness(store: WorkspaceStore) {
  const rows = new Map<string, RuntimeProfile>();
  const registry = new ProfileActorRegistry(
    () => [...rows.values()],
    store.tasks,
    store.tasks.settlements,
    store.taskControls,
    store.taskTabs,
    randomUUID,
  );
  async function add(maxLikes = 1) {
    const f = await prepareBound(store, maxLikes);
    await store.tasks.acknowledgeBound(f.receipt);
    await store.tasks.settleBound(f.receipt, 'NOT_APPLIED');
    const notice = await store.tasks.settlements.claim(f.profile.id);
    assert.ok(notice?.claimToken);
    await store.tasks.settlements.delivered(f.binding.operationId, notice.claimToken, {
      binding: notice.binding,
      resolution: BusinessResolution.parse(notice.resolution),
    });
    const context: ExecutionSession = {
      profileId: f.profile.id,
      accountId: f.binding.accountId,
      connectionEpoch: f.binding.connectionEpoch,
      leaseId: f.binding.leaseId,
      generation: f.binding.generation,
    };
    const live = {
      context: context as ExecutionSession | null,
      inputs: 0,
      stops: [] as StopBinding[],
      failure: null as ((reason: string) => Promise<void>) | null,
    };
    rows.set(f.profile.id, f.profile);
    const remote: KernelState = {
      version: 1,
      profileId: f.profile.id,
      browserSessionEpoch: randomUUID(),
      tabs: [],
      operations: [
        {
          binding: f.binding,
          state: 'RECONCILED',
          reason: 'fixture',
          resolution: BusinessResolution.parse(notice.resolution),
        },
      ],
    };
    const port: ManagedProfileSession = {
      profileId: f.profile.id,
      profile: () => rows.get(f.profile.id) ?? f.profile,
      current: () => live.context,
      inventory: async () => remote,
      notify: async (binding, resolution) => ({ binding, resolution }),
      setFailureHandler: (handler) => {
        live.failure = handler;
      },
      sendGuarded: async (operation, guard) => {
        await guard();
        live.inputs++;
        return { binding: operation.binding, evidence: { fixtureOnly: true } };
      },
      stop: async (binding) => {
        live.stops.push(binding);
        live.context = null;
        return { ...binding, state: 'stopped' };
      },
    };
    await registry.attach(port);
    await registry.observe(f.profile.id);
    const prepare = async () =>
      await store.tasks.prepareOperation(f.plan.id, f.step.id, randomUUID(), {
        kind: 'click',
        tabId: 42,
        documentEpoch: 0,
        routeEpoch: 0,
        target: { css: '#counter' },
      });
    return { ...f, port, live, context, prepare };
  }
  return { rows, registry, add, dispatcher: new TaskDispatcher(store.tasks, registry) };
}

test('fresh exact task scope avoids full history and rejects revocation during the await', async () => {
  await settlementFixture(async (store) => {
    const h = await harness(store),
      f = await h.add();
    const proof = {
      profileId: f.profile.id,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 42,
      targetId: randomUUID(),
    };
    await store.taskTabs.register(f.plan.id, proof, f.context);
    let checks = 0;
    f.port.inventory = async () => {
      throw Error('UNNECESSARY_FULL_HISTORY');
    };
    f.port.confirmTaskTab = async (expected) => {
      assert.deepEqual(expected, proof);
      checks++;
    };
    assert.deepEqual(await h.registry.currentTaskTab(f.plan, f.context), proof);
    assert.equal(checks, 1);
    f.port.confirmTaskTab = async () => {
      throw Error('NATIVE_TARGET_CHANGED');
    };
    await assert.rejects(h.registry.currentTaskTab(f.plan, f.context), /NATIVE_TARGET_CHANGED/);
    const gate = latch();
    f.port.confirmTaskTab = async () => {
      await gate.promise;
    };
    const pending = h.registry.currentTaskTab(f.plan, f.context);
    f.live.context = null;
    gate.release();
    await assert.rejects(pending, /ACTOR_TASK_TAB_CONTEXT_CHANGED/);
  });
});

test('legacy and recheck task scopes still require full native inventory', async () => {
  await settlementFixture(async (store) => {
    const h = await harness(store),
      f = await h.add();
    const proof = {
      profileId: f.profile.id,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 42,
      targetId: randomUUID(),
    };
    const row = await store.taskTabs.register(f.plan.id, proof, f.context);
    let reads = 0;
    f.port.inventory = async () => {
      reads++;
      return {
        version: 1,
        profileId: f.profile.id,
        browserSessionEpoch: proof.browserSessionEpoch,
        operations: [],
        tabs: [],
      };
    };
    await assert.rejects(
      h.registry.currentTaskTab(f.plan, f.context),
      /ACTOR_NATIVE_TASK_TAB_UNCONFIRMED/,
    );
    await store.taskTabs.requireRecheck(
      proof.ownershipId,
      row.revision,
      'GENERATED_RECHECK',
      f.plan.id,
    );
    f.port.confirmTaskTab = async () => {
      throw Error('RECHECK_CANNOT_USE_FAST_PATH');
    };
    await assert.rejects(
      h.registry.currentTaskTab(f.plan, f.context),
      /ACTOR_NATIVE_TASK_TAB_UNCONFIRMED/,
    );
    assert.equal(reads, 2);
  });
});

test('healthy browse-only observation retains the reconciled actor but always confirms current scope', async () => {
  await settlementFixture(async (store) => {
    const h = await harness(store),
      f = await h.add(0);
    const proof = {
      profileId: f.profile.id,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 42,
      targetId: randomUUID(),
    };
    await store.taskTabs.register(f.plan.id, proof, f.context);
    let checks = 0;
    f.port.confirmTaskTab = async () => {
      checks++;
    };
    f.port.inventory = async () => {
      throw Error('UNNECESSARY_IDLE_HISTORY');
    };
    const observed = await h.registry.observe(f.profile.id);
    assert.deepEqual(observed, proof);
    const host = new TaskCycleHost(h.registry, store.taskTabs, {
      currentTaskTab: async () => {
        throw Error('DUPLICATE_NATIVE_SCOPE');
      },
    });
    await host.preparePlan(await store.tasks.get(f.plan.id), f.context, observed || undefined);
    assert.equal(checks, 1);
    assert.deepEqual(await h.registry.session(f.profile.id), f.context);
    assert.deepEqual(await h.registry.observe(f.profile.id), proof);
    assert.equal(checks, 2);
    const row = await store.taskTabs.get(proof.ownershipId, f.plan.id);
    await store.taskTabs.requireRecheck(
      proof.ownershipId,
      row.revision,
      'GENERATED_RECHECK',
      f.plan.id,
    );
    await assert.rejects(
      host.preparePlan(await store.tasks.get(f.plan.id), f.context, proof),
      /TASK_TAB_OBSERVATION_CHANGED/,
    );
    await store.taskTabs.confirmObserved(
      proof.ownershipId,
      row.revision + 1,
      proof,
      f.context,
      f.plan.id,
    );
    await f.prepare();
    await assert.rejects(h.registry.observe(f.profile.id), /UNNECESSARY_IDLE_HISTORY/);
    assert.equal(await h.registry.session(f.profile.id), null);
  });
});

test('fresh reconciled inventory transfers its exact browse proof once, but not after stop or a foreign target', async () => {
  for (const scenario of ['healthy', 'stopped', 'foreign-target'] as const) {
    await settlementFixture(async (store) => {
      const h = await harness(store),
        f = await h.add(0);
      const inventory = await f.port.inventory();
      const proof = {
        profileId: f.profile.id,
        ownershipId: randomUUID(),
        browserSessionEpoch: inventory.browserSessionEpoch,
        tabId: 42,
        targetId: randomUUID(),
      };
      await store.taskTabs.register(f.plan.id, proof, f.context);
      let reads = 0;
      f.port.inventory = async () => {
        reads++;
        if (scenario === 'stopped') await h.registry.control(f.plan.id, 'stop', 'USER_STOP');
        return {
          ...inventory,
          tabs: [
            {
              ownershipId: proof.ownershipId,
              state: 'READY',
              proof: scenario === 'foreign-target' ? { ...proof, targetId: randomUUID() } : proof,
              url: 'https://www.facebook.com/',
              reason: '',
            },
          ],
        };
      };
      const observed = await h.registry.observe(f.profile.id);
      assert.equal(reads, 1);
      if (scenario === 'healthy') {
        assert.deepEqual(observed, proof);
        const host = new TaskCycleHost(h.registry, store.taskTabs, {
          currentTaskTab: async () => {
            throw Error('DUPLICATE_NATIVE_SCOPE');
          },
        });
        await host.preparePlan(await store.tasks.get(f.plan.id), f.context, observed || undefined);
        assert.equal(reads, 1);
      } else {
        assert.equal(observed, undefined);
        if (scenario === 'stopped') {
          assert.equal(await h.registry.session(f.profile.id), null);
          assert.equal((await store.tasks.get(f.plan.id)).state, 'STOPPED');
        } else {
          await assert.rejects(
            h.registry.currentTaskTab(f.plan, f.context),
            /NATIVE_TASK_TAB_UNCONFIRMED/,
          );
        }
      }
      assert.equal(f.live.inputs, 0);
      await h.registry.close();
    });
  }
});

test('failed fresh idle scope immediately revokes the cached actor permit', async () => {
  await settlementFixture(async (store) => {
    const h = await harness(store),
      f = await h.add(0);
    const proof = {
      profileId: f.profile.id,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 42,
      targetId: randomUUID(),
    };
    await store.taskTabs.register(f.plan.id, proof, f.context);
    f.port.confirmTaskTab = async () => {
      throw Error('NATIVE_TARGET_CHANGED');
    };
    await assert.rejects(h.registry.observe(f.profile.id), /NATIVE_TARGET_CHANGED/);
    assert.equal(await h.registry.session(f.profile.id), null);
    assert.equal((await h.registry.status())[0]?.actor.state, 'BLOCKED');
  });
});

test('registry preserves complete runtime inventory, rejects duplicate owners and requires explicit observation', async () => {
  await settlementFixture(async (store) => {
    const h = await harness(store),
      first = await h.add(),
      second = await h.add();
    await assert.rejects(async () => await h.registry.attach(first.port), /ALREADY_OWNED/);
    h.rows.set(randomUUID(), { ...first.profile, id: randomUUID(), online: false });
    assert.equal((await h.registry.profiles()).length, 3);
    await first.prepare();
    await second.prepare();
    assert.equal(await h.dispatcher.flushOne(), true);
    assert.equal((await store.tasks.get(second.plan.id)).state, 'RUNNING');
    assert.equal(
      (await h.registry.schedulingProfiles()).find((p) => p.id === first.profile.id)
        ?.dispatchAllowed,
      false,
    );
    await h.registry.close();
    assert.equal((await h.registry.status()).length, 0);
  });
});

test('actual stop cancels a pending SDK wait, fences native input, persists matching control and retains UNKNOWN lock', async () => {
  await settlementFixture(async (store, file) => {
    const h = await harness(store),
      f = await h.add(),
      blocked = latch();
    await f.prepare();
    f.port.sendGuarded = async (operation, guard) => {
      await blocked.promise;
      await guard();
      f.live.inputs++;
      return { binding: operation.binding, evidence: {} };
    };
    f.port.stop = async (binding) => {
      assert.equal((await store.taskControls.list())[0]?.binding.requestId, binding.requestId);
      assert.equal((await store.tasks.operations(f.plan.id))[1]?.status, 'UNKNOWN');
      f.live.stops.push(binding);
      f.live.context = null;
      blocked.release();
      return { ...binding, state: 'stopped' };
    };
    const sending = h.dispatcher.flushOne();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stopped = await h.registry.control(f.plan.id, 'stop');
    await sending;
    assert.equal(f.live.inputs, 0);
    assert.equal(stopped.state, 'REVIEW');
    assert.equal(stopped.controlConfirmed, true);
    assert.equal(
      (await store.taskControls.list())[0]?.receipt?.requestId,
      stopped.controlRequestId,
    );
    assert.equal(await h.registry.session(f.profile.id), null);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT count(*) AS count FROM task_account_locks').get()?.count, 1);
    } finally {
      db.close();
    }
  });
});

test('every stop identity field is checked and a bad receipt neither confirms the plan nor releases the owner', async () => {
  for (const change of [
    'requestId',
    'profileId',
    'accountId',
    'connectionEpoch',
    'leaseId',
    'generation',
  ] as const) {
    await settlementFixture(async (store) => {
      const h = await harness(store),
        f = await h.add();
      f.port.stop = async (binding) => ({
        ...binding,
        state: 'stopped',
        [change]: change === 'generation' ? binding.generation + 1 : randomUUID(),
      });
      await assert.rejects(h.registry.control(f.plan.id, 'stop'), /RECEIPT_MISMATCH/);
      assert.equal((await store.tasks.get(f.plan.id)).state, 'STOPPING');
      assert.equal((await store.tasks.get(f.plan.id)).controlConfirmed, false);
      assert.equal((await store.taskControls.list())[0]?.receipt, null);
      assert.equal((await h.registry.status())[0]?.lifecycle, 'STOP_UNCONFIRMED');
      await assert.rejects(async () => await h.registry.attach(f.port), /ALREADY_OWNED/);
    });
  }
});

test('duplicate current stop coalesces its native cancellation and confirmation', async () => {
  await settlementFixture(async (store) => {
    const h = await harness(store),
      f = await h.add(),
      blocked = latch();
    f.port.stop = async (binding) => {
      f.live.stops.push(binding);
      await blocked.promise;
      return { ...binding, state: 'stopped' };
    };
    const first = h.registry.control(f.plan.id, 'stop'),
      second = h.registry.control(f.plan.id, 'stop');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.live.stops.length, 1);
    blocked.release();
    assert.equal((await first).state, 'STOPPED');
    assert.equal((await second).state, 'STOPPED');
    assert.equal((await store.taskControls.list()).length, 1);
    assert.equal(
      (await store.tasks.events(f.plan.id)).filter((e) => e.type === 'CONTROL_CONFIRMED').length,
      1,
    );
  });
});

test('superseded pause receipt cannot confirm a newer stop even when the old physical session stopped', async () => {
  await settlementFixture(async (store) => {
    const h = await harness(store),
      f = await h.add(),
      blocked = latch();
    f.port.stop = async (binding) => {
      await blocked.promise;
      return { ...binding, state: 'stopped' };
    };
    const pausing = h.registry.control(f.plan.id, 'pause');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const oldId = (await store.tasks.get(f.plan.id)).controlRequestId;
    await store.tasks.requestControl(f.plan.id, 'stop', 'INDEPENDENT_SUPERSEDING_CONTROL');
    const nextId = (await store.tasks.get(f.plan.id)).controlRequestId;
    assert.notEqual(oldId, nextId);
    blocked.release();
    await assert.rejects(pausing, /当前待确认请求/);
    assert.equal((await store.tasks.get(f.plan.id)).state, 'STOPPING');
    assert.equal((await store.tasks.get(f.plan.id)).controlConfirmed, false);
    assert.ok((await store.taskControls.list()).every((row) => row.receipt === null));
    assert.equal((await h.registry.status())[0]?.lifecycle, 'STOP_UNCONFIRMED');
  });
});

test('service pause then stop waits for one actual cancellation without creating a conflicting native request', async () => {
  await settlementFixture(async (store) => {
    const h = await harness(store),
      f = await h.add(),
      blocked = latch();
    f.port.stop = async (binding) => {
      f.live.stops.push(binding);
      await blocked.promise;
      return { ...binding, state: 'stopped' };
    };
    const pausing = h.registry.control(f.plan.id, 'pause'),
      stopping = h.registry.control(f.plan.id, 'stop');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const id = (await store.tasks.get(f.plan.id)).controlRequestId;
    assert.equal((await store.tasks.get(f.plan.id)).state, 'PAUSING');
    blocked.release();
    await pausing;
    const plan = await stopping;
    assert.equal(plan.state, 'STOPPED');
    assert.equal(plan.controlRequestId, id);
    assert.equal(f.live.stops.length, 1);
    assert.equal((await store.taskControls.list()).length, 1);
  });
});

test('stop after confirmed pause with UNKNOWN changes desired disposition and never releases or replays the side effect', async () => {
  await settlementFixture(async (store) => {
    const h = await harness(store),
      f = await h.add();
    await f.prepare();
    await h.dispatcher.flushOne();
    const paused = await h.registry.control(f.plan.id, 'pause');
    assert.equal(paused.state, 'REVIEW');
    const plan = await h.registry.control(f.plan.id, 'stop');
    assert.equal(plan.state, 'REVIEW');
    assert.equal(plan.controlMode, 'stop');
    assert.equal(plan.controlConfirmed, true);
    assert.equal(plan.controlRequestId, paused.controlRequestId);
    assert.equal(f.live.stops.length, 1);
    const operation = (await store.tasks.operations(f.plan.id))[1];
    assert.ok(operation?.binding);
    assert.equal(operation.status, 'UNKNOWN');
    assert.equal(f.live.inputs, 1);
    await store.tasks.reconcileBound(
      { binding: operation.binding, evidence: { independentNotApplied: true } },
      'NOT_APPLIED',
    );
    assert.equal((await store.tasks.get(f.plan.id)).state, 'STOPPED');
  });
});

test('stale disconnect callback cannot stop a newly attached owner or another profile', async () => {
  await settlementFixture(async (store) => {
    const h = await harness(store),
      f = await h.add(),
      second = await h.add();
    await h.registry.control(f.plan.id, 'stop');
    f.live.context = { ...f.context, leaseId: randomUUID(), connectionEpoch: randomUUID() };
    await h.registry.attach(f.port);
    assert.equal(await h.registry.session(f.profile.id), null);
    await assert.rejects(
      h.registry.detach(f.profile.id, f.context, 'LATE_CALLBACK'),
      /STALE_ACTOR_DETACH/,
    );
    assert.equal(f.live.stops.length, 1);
    assert.equal(second.live.stops.length, 0);
    assert.equal((await h.registry.status()).length, 2);
  });
});

test('account change retires old plan with stop while unknown identity pauses without inventing a ban', async () => {
  await settlementFixture(async (store) => {
    const h = await harness(store),
      first = await h.add(),
      second = await h.add();
    h.rows.set(first.profile.id, {
      ...first.profile,
      account: { state: 'logged-in', id: 'new-account', name: null, avatar: null },
    });
    h.rows.set(second.profile.id, {
      ...second.profile,
      account: { state: 'unknown', id: null, name: null, avatar: null },
    });
    await h.registry.reconcileOwners();
    assert.equal((await store.tasks.get(first.plan.id)).state, 'STOPPED');
    assert.equal((await store.tasks.get(second.plan.id)).state, 'PAUSED');
    assert.equal(first.live.inputs + second.live.inputs, 0);
    assert.equal(h.rows.get(second.profile.id)?.account.state, 'unknown');
  });
});

test('one failed shutdown does not block another profile and its unconfirmed owner remains fenced', async () => {
  await settlementFixture(async (store) => {
    const h = await harness(store),
      first = await h.add(),
      second = await h.add();
    first.port.stop = async () => {
      throw Error('TRANSPORT_LOST');
    };
    await assert.rejects(h.registry.close(), /SHUTDOWN_UNCONFIRMED/);
    assert.equal((await store.tasks.get(first.plan.id)).state, 'PAUSING');
    assert.equal((await store.tasks.get(second.plan.id)).state, 'PAUSED');
    assert.equal((await h.registry.status()).length, 1);
    assert.equal((await h.registry.status())[0]?.lifecycle, 'STOP_UNCONFIRMED');
    assert.equal(await h.registry.session(first.profile.id), null);
  });
});

test('execution failure routes cancellation through persisted current plan request rather than a random SDK close ID', async () => {
  await settlementFixture(async (store) => {
    const h = await harness(store),
      f = await h.add();
    await f.prepare();
    f.port.sendGuarded = async () => {
      assert.ok(f.live.failure);
      await f.live.failure('SDK_QUERY_FAILED');
      throw Error('SDK_QUERY_FAILED');
    };
    await h.dispatcher.flushOne();
    const plan = await store.tasks.get(f.plan.id);
    assert.equal(plan.state, 'REVIEW');
    assert.equal(plan.controlConfirmed, true);
    assert.equal(f.live.stops[0]?.requestId, plan.controlRequestId);
    assert.equal((await store.tasks.operations(plan.id))[1]?.status, 'UNKNOWN');
    assert.equal(f.live.inputs, 0);
  });
});

test('persisted control cannot be rebound to a new lease, reopened storage does not recover it, restart rejects late receipt', async () => {
  await settlementFixture(async (store, file) => {
    const h = await harness(store),
      f = await h.add();
    const plan = await store.tasks.requestControl(f.plan.id, 'stop');
    assert.ok(plan.controlRequestId);
    const binding: ControlBinding = {
      ...f.context,
      requestId: plan.controlRequestId,
      jobId: plan.id,
      mode: 'stop',
    };
    await store.taskControls.bind(binding);
    await assert.rejects(
      async () => await store.taskControls.bind({ ...binding, leaseId: randomUUID() }),
      /不可更改/,
    );
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.equal(reopened.tasks.get(plan.id).state, 'STOPPING');
      assert.equal(reopened.taskControls.list()[0]?.receipt, null);
      reopened.tasks.recoverOnStartup();
      assert.equal(reopened.tasks.get(plan.id).state, 'REVIEW');
      const { jobId: _job, mode: _mode, ...stop } = binding;
      assert.throws(
        () => reopened.taskControls.confirm(binding, { ...stop, state: 'stopped' }),
        /当前待确认请求/,
      );
      assert.equal(reopened.taskControls.list()[0]?.receipt, null);
    } finally {
      reopened.close();
    }
  });
});

test('schema5 forward migration backs up original plans and user data, never manufactures stop receipts', async () => {
  await settlementFixture(async (store, file) => {
    const f = await prepareBound(store),
      before = await store.tasks.get(f.plan.id),
      db = new DatabaseSync(file);
    try {
      db.exec(dropControlSchema + 'PRAGMA user_version=5');
    } finally {
      db.close();
    }
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(reopened.tasks.get(f.plan.id), before);
      assert.deepEqual(reopened.taskControls.list(), []);
      const backups = (await readdir(path.dirname(file))).filter((name) =>
        name.includes(latestMigrationBackupMarker),
      );
      assert.equal(backups.length, 1);
      const backup = new DatabaseSync(path.join(path.dirname(file), String(backups[0])), {
        readOnly: true,
      });
      try {
        assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 5);
      } finally {
        backup.close();
      }
    } finally {
      reopened.close();
    }
  });
});

test('stop receipt and confirmation roll back together; committed binding and receipt cannot be edited or deleted', async () => {
  await settlementFixture(async (store, file) => {
    const f = await prepareBound(store),
      plan = await store.tasks.requestControl(f.plan.id, 'stop');
    assert.ok(plan.controlRequestId);
    const control: ControlBinding = {
      profileId: f.binding.profileId,
      accountId: f.binding.accountId,
      connectionEpoch: f.binding.connectionEpoch,
      leaseId: f.binding.leaseId,
      generation: f.binding.generation,
      requestId: plan.controlRequestId,
      jobId: plan.id,
      mode: 'stop',
    };
    await store.taskControls.bind(control);
    const { jobId: _job, mode: _mode, ...stop } = control;
    const receipt = { ...stop, state: 'stopped' as const },
      db = new DatabaseSync(file);
    try {
      db.exec(
        "CREATE TRIGGER reject_control_confirm BEFORE UPDATE OF control_confirmed ON task_plans WHEN NEW.control_confirmed=1 BEGIN SELECT RAISE(ABORT,'INJECTED_CONFIRM_FAILURE'); END",
      );
      await assert.rejects(
        async () => await store.taskControls.confirm(control, receipt),
        /INJECTED_CONFIRM_FAILURE/,
      );
      assert.equal((await store.taskControls.list())[0]?.receipt, null);
      assert.equal((await store.tasks.get(plan.id)).controlConfirmed, false);
      db.exec('DROP TRIGGER reject_control_confirm');
      const confirmed = await store.taskControls.confirm(control, receipt);
      assert.equal(confirmed.state, 'REVIEW');
      assert.deepEqual(await store.taskControls.confirm(control, receipt), confirmed);
      assert.throws(
        () => db.prepare('UPDATE task_control_bindings SET body=?').run('{}'),
        /IMMUTABLE_TASK_CONTROL_BINDING/,
      );
      assert.throws(
        () => db.prepare('DELETE FROM task_control_bindings').run(),
        /RETAIN_TASK_CONTROL_BINDING/,
      );
      assert.throws(
        () => db.prepare('UPDATE task_control_receipts SET body=?').run('{}'),
        /IMMUTABLE_TASK_CONTROL_RECEIPT/,
      );
      assert.throws(
        () => db.prepare('DELETE FROM task_control_receipts').run(),
        /RETAIN_TASK_CONTROL_RECEIPT/,
      );
    } finally {
      db.close();
    }
  });
});

test('explicit same-owner retry recovers a lost stop receipt once and never resumes or repeats input', async () => {
  await settlementFixture(async (store) => {
    const h = await harness(store),
      f = await h.add(),
      blocked = latch();
    f.port.stop = async (binding) => {
      f.live.stops.push(binding);
      f.live.context = null;
      throw Error('STOP_REPLY_LOST');
    };
    await assert.rejects(h.registry.control(f.plan.id, 'stop'), /STOP_REPLY_LOST/);
    const binding = f.live.stops[0];
    assert.ok(binding);
    assert.equal((await h.registry.status())[0]?.lifecycle, 'STOP_UNCONFIRMED');
    assert.equal(await h.registry.session(f.profile.id), null);
    assert.equal((await store.taskControls.list())[0]?.receipt, null);
    let retries = 0;
    f.port.retryStop = async (value) => {
      retries++;
      assert.deepEqual(value, binding);
      await blocked.promise;
      return { ...value, state: 'stopped' };
    };
    await assert.rejects(
      h.registry.retryStop({ ...binding, leaseId: randomUUID() }),
      /BINDING_MISMATCH/,
    );
    const first = h.registry.retryStop(binding),
      second = h.registry.retryStop(binding);
    assert.equal(first, second);
    blocked.release();
    await Promise.all([first, second]);
    assert.equal(retries, 1);
    assert.equal((await store.tasks.get(f.plan.id)).state, 'STOPPED');
    assert.equal((await store.tasks.get(f.plan.id)).controlConfirmed, true);
    assert.equal((await store.taskControls.list())[0]?.receipt?.requestId, binding.requestId);
    assert.equal((await h.registry.status()).length, 0);
    assert.equal(f.live.inputs, 0);
    assert.equal(f.live.stops.length, 1);
  });
});

test('user stop recovers the original failed pause receipt before changing disposition; ordinary control never retries', async () => {
  await settlementFixture(async (store) => {
    const h = await harness(store),
      f = await h.add(),
      blocked = latch();
    f.port.stop = async (binding) => {
      f.live.stops.push(binding);
      throw Error('STOP_REPLY_LOST');
    };
    await assert.rejects(h.registry.control(f.plan.id, 'pause'), /STOP_REPLY_LOST/);
    const original = f.live.stops[0];
    assert.ok(original);
    let retries = 0;
    f.port.retryStop = async (binding) => {
      assert.deepEqual(binding, original);
      retries++;
      await blocked.promise;
      return { ...binding, state: 'stopped' };
    };
    await assert.rejects(h.registry.control(f.plan.id, 'pause'), /STOP_REPLY_LOST/);
    assert.equal(retries, 0);
    const first = h.registry.controlFromUser(f.plan.id, 'stop'),
      second = h.registry.controlFromUser(f.plan.id, 'stop');
    blocked.release();
    assert.equal((await first).state, 'STOPPED');
    assert.equal((await second).state, 'STOPPED');
    assert.equal(retries, 1);
    assert.equal(f.live.stops.length, 1);
    assert.equal(f.live.inputs, 0);
    assert.equal((await store.taskControls.list())[0]?.receipt?.requestId, original.requestId);
    assert.equal((await store.tasks.get(f.plan.id)).controlMode, 'stop');
  });
});
test('retry mismatch and receipt transaction failure preserve fenced owner until exact confirmation commits', async () => {
  await settlementFixture(async (store, file) => {
    const h = await harness(store),
      f = await h.add();
    f.port.stop = async (binding) => {
      f.live.stops.push(binding);
      throw Error('STOP_FAILED');
    };
    await assert.rejects(h.registry.control(f.plan.id, 'pause'), /STOP_FAILED/);
    const binding = f.live.stops[0];
    assert.ok(binding);
    f.port.retryStop = async (value) => ({
      ...value,
      generation: value.generation + 1,
      state: 'stopped',
    });
    await assert.rejects(h.registry.retryStop(binding), /RECEIPT_MISMATCH/);
    const db = new DatabaseSync(file);
    try {
      db.exec(
        "CREATE TRIGGER reject_retry_confirm BEFORE UPDATE OF control_confirmed ON task_plans WHEN NEW.control_confirmed=1 BEGIN SELECT RAISE(ABORT,'RETRY_CONFIRM_FAILED'); END",
      );
      f.port.retryStop = async (value) => ({ ...value, state: 'stopped' });
      await assert.rejects(h.registry.retryStop(binding), /RETRY_CONFIRM_FAILED/);
      assert.equal((await store.taskControls.list())[0]?.receipt, null);
      assert.equal((await h.registry.status())[0]?.lifecycle, 'STOP_UNCONFIRMED');
      assert.equal(await h.registry.session(f.profile.id), null);
      db.exec('DROP TRIGGER reject_retry_confirm');
      await h.registry.retryStop(binding);
      assert.equal((await store.tasks.get(f.plan.id)).state, 'PAUSED');
      assert.equal((await h.registry.status()).length, 0);
      assert.equal(f.live.inputs, 0);
    } finally {
      db.close();
    }
  });
});
test('superseded control or startup recovery rejects original retry before contacting its native session', async () => {
  for (const restart of [false, true]) {
    await settlementFixture(async (store) => {
      const h = await harness(store),
        f = await h.add();
      f.port.stop = async (binding) => {
        f.live.stops.push(binding);
        throw Error('STOP_FAILED');
      };
      await assert.rejects(h.registry.control(f.plan.id, 'pause'), /STOP_FAILED/);
      const binding = f.live.stops[0];
      assert.ok(binding);
      let retries = 0;
      f.port.retryStop = async (value) => {
        retries++;
        return { ...value, state: 'stopped' };
      };
      if (restart) await store.tasks.recoverOnStartup();
      else await store.tasks.requestControl(f.plan.id, 'stop', 'SUPERSEDING');
      await assert.rejects(h.registry.retryStop(binding), /CONTROL_CHANGED/);
      assert.equal(retries, 0);
      assert.equal((await h.registry.status())[0]?.lifecycle, 'STOP_UNCONFIRMED');
      assert.equal((await store.taskControls.list())[0]?.receipt, null);
      assert.equal(f.live.inputs, 0);
    });
  }
});
test('retry confirms physical stop but preserves ACK uncertainty, lock and final user intent', async () => {
  await settlementFixture(async (store, file) => {
    const h = await harness(store),
      f = await h.add();
    await f.prepare();
    await h.dispatcher.flushOne();
    const operation = (await store.tasks.operations(f.plan.id))[1];
    assert.ok(operation?.binding);
    assert.equal(operation.status, 'ACKNOWLEDGED');
    f.port.stop = async (binding) => {
      f.live.stops.push(binding);
      throw Error('REPLY_LOST');
    };
    await assert.rejects(h.registry.control(f.plan.id, 'stop'), /REPLY_LOST/);
    const binding = f.live.stops[0];
    assert.ok(binding);
    f.port.retryStop = async (value) => ({ ...value, state: 'stopped' });
    await h.registry.retryStop(binding);
    const plan = await store.tasks.get(f.plan.id),
      db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(plan.state, 'REVIEW');
      assert.equal(plan.controlMode, 'stop');
      assert.equal(plan.controlConfirmed, true);
      assert.equal((await store.tasks.operations(plan.id))[1]?.status, 'UNKNOWN');
      assert.equal(db.prepare('SELECT count(*) AS count FROM task_account_locks').get()?.count, 1);
      assert.equal((await h.registry.status()).length, 0);
      assert.equal(f.live.inputs, 1); // Only the preceding simulated input, never replayed by retry.
    } finally {
      db.close();
    }
  });
});

test('conflicting unbound close cannot start a retry while original native cancellation is still pending', async () => {
  await settlementFixture(async (store) => {
    const h = await harness(store),
      f = await h.add(),
      blocked = latch();
    await store.tasks.checkpoint(f.plan.id, f.step.id, 0, {
      ...f.step.progress,
      revision: 1,
      effectiveMilliseconds: 60000,
    });
    await store.tasks.completeStep(f.plan.id, f.step.id);
    f.port.stop = async (binding) => {
      f.live.stops.push(binding);
      await blocked.promise;
      return { ...binding, state: 'stopped' };
    };
    let retries = 0;
    f.port.retryStop = async (binding) => {
      retries++;
      return { ...binding, state: 'stopped' };
    };
    const closing = h.registry.detach(f.profile.id, f.context, 'TASK_COMPLETED');
    await assert.rejects(
      h.registry.detach(f.profile.id, f.context, 'COMPETING_CLOSE'),
      /REQUEST_CONFLICT/,
    );
    const original = f.live.stops[0];
    assert.ok(original);
    await assert.rejects(h.registry.retryStop(original), /IN_FLIGHT/);
    assert.equal(retries, 0);
    blocked.release();
    await closing;
    assert.equal((await h.registry.status()).length, 0);
    assert.equal(f.live.stops.length, 1);
  });
});

test('Phase A: stopEntry activeForProfile matches legacy list().filter + forPlan across all tab states, multi-plan ownership, and revision conflicts', async () => {
  await settlementFixture(async (store) => {
    const h = await harness(store),
      f = await h.add(0),
      other = await h.add(0);

    // Stop f.plan first so it becomes the historical completed/stopped plan on f.profile,
    // then assign and claim a new active plan on the same f.profile to test multi-plan ownershipId reuse!
    const sharedOwnershipId = randomUUID();
    const sharedProof = {
      profileId: f.profile.id,
      ownershipId: sharedOwnershipId,
      browserSessionEpoch: randomUUID(),
      tabId: 101,
      targetId: randomUUID(),
    };
    const histTab = await store.taskTabs.register(f.plan.id, sharedProof, f.context);
    await h.registry.control(f.plan.id, 'stop', 'HIST_STOP');
    const histStopBinding = f.live.stops[0];
    assert.ok(histStopBinding);
    await store.taskTabs.confirmReleased(
      sharedOwnershipId,
      histTab.revision + 1,
      {
        version: 1,
        profileId: f.profile.id,
        browserSessionEpoch: sharedProof.browserSessionEpoch,
        operations: [],
        workspaceMain: sharedProof,
        tabs: [
          {
            ownershipId: sharedOwnershipId,
            proof: sharedProof,
            state: 'READY',
            url: 'https://www.facebook.com/',
            reason: '',
          },
        ],
      },
      { ...histStopBinding, state: 'stopped' },
      f.plan.id,
    );
    const histPlan = f.plan;

    // Assign and claim a new active plan on f.profile
    const nextBatchId = randomUUID();
    const [activePlan] = await store.tasks.assign(
      {
        requestId: nextBatchId,
        combinationId: histPlan.combinationId,
        version: histPlan.version,
        profileIds: [f.profile.id],
      },
      [f.profile],
    );
    assert.ok(activePlan);
    // Verify batchExists / plansForBatch idempotency and conflict detection
    assert.equal(await store.tasks.batchExists(nextBatchId), true);
    assert.equal(await store.tasks.batchExists(randomUUID()), false);
    assert.deepEqual(
      (await store.tasks.plansForBatch(nextBatchId)).map((p) => p.id),
      [activePlan.id],
    );
    assert.deepEqual(
      (
        await store.tasks.assign(
          {
            requestId: nextBatchId,
            combinationId: histPlan.combinationId,
            version: histPlan.version,
            profileIds: [f.profile.id],
          },
          [],
        )
      ).map((p) => p.id),
      [activePlan.id],
    );
    await assert.rejects(
      async () =>
        await store.tasks.assign(
          {
            requestId: nextBatchId,
            combinationId: histPlan.combinationId,
            version: histPlan.version,
            profileIds: [other.profile.id],
          },
          [other.profile],
        ),
      /BATCH_ID_CONFLICT|参数不同/,
    );

    const claimed = await store.tasks.claimNext([f.profile], new Set(['video']));
    assert.ok(claimed && claimed.id === activePlan.id);
    const nextContext: ExecutionSession = {
      profileId: f.profile.id,
      accountId: f.context.accountId,
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: 1,
    };
    f.live.context = nextContext;
    await h.registry.attach(f.port);

    // 1. CLOSED and LOST on activePlan (registered and closed/lost first since idx_task_tab_state_active_profile enforces at most 1 active tab per profile)
    const closedProof = {
      profileId: f.profile.id,
      ownershipId: randomUUID(),
      browserSessionEpoch: sharedProof.browserSessionEpoch,
      tabId: 104,
      targetId: randomUUID(),
    };
    const closedRow = await store.taskTabs.register(activePlan.id, closedProof, nextContext);
    await store.taskTabs.confirmClosed(
      closedProof.ownershipId,
      closedRow.revision,
      {
        version: 1,
        profileId: f.profile.id,
        browserSessionEpoch: closedProof.browserSessionEpoch,
        operations: [],
        tabs: [
          {
            ownershipId: closedProof.ownershipId,
            proof: closedProof,
            state: 'CLOSED',
            url: 'https://www.facebook.com/',
            reason: 'CLOSED',
          },
        ],
      },
      activePlan.id,
    );
    const lostProof = {
      profileId: f.profile.id,
      ownershipId: randomUUID(),
      browserSessionEpoch: sharedProof.browserSessionEpoch,
      tabId: 105,
      targetId: randomUUID(),
    };
    const lostRow = await store.taskTabs.register(activePlan.id, lostProof, nextContext);
    await store.taskTabs.markLost(
      lostProof.ownershipId,
      lostRow.revision,
      'LOST_TAB',
      activePlan.id,
    );

    // 2. Multi-plan ownershipId: registered on histPlan (RELEASED), now re-registered on activePlan (READY)
    await store.taskTabs.register(activePlan.id, sharedProof, nextContext);

    // 3. Other profile's READY tab
    const otherProof = {
      profileId: other.profile.id,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 201,
      targetId: randomUUID(),
    };
    await store.taskTabs.register(other.plan.id, otherProof, other.context);

    // Verify activeForProfile equivalence across:
    // (a) READY with matching context
    const checkEquivalence = async (ctx: ExecutionSession) => {
      const legacyCandidates = (
        await flatMapAsync(
          (await store.tasks.list()).filter((plan) => plan.profileId === f.profile.id),
          async (plan) => await store.taskTabs.forPlan(plan.id),
        )
      ).filter(
        (row) =>
          row.state === 'READY' &&
          row.context &&
          row.context.profileId === ctx.profileId &&
          row.context.accountId === ctx.accountId &&
          row.context.connectionEpoch === ctx.connectionEpoch &&
          row.context.leaseId === ctx.leaseId &&
          row.context.generation === ctx.generation,
      );
      const scopedCandidates = (await store.taskTabs.activeForProfile(f.profile.id)).filter(
        (row) =>
          row.state === 'READY' &&
          row.context &&
          row.context.profileId === ctx.profileId &&
          row.context.accountId === ctx.accountId &&
          row.context.connectionEpoch === ctx.connectionEpoch &&
          row.context.leaseId === ctx.leaseId &&
          row.context.generation === ctx.generation,
      );
      assert.deepEqual(
        scopedCandidates.map((r) => ({
          ownershipId: r.proof.ownershipId,
          jobId: r.jobId,
          rev: r.revision,
        })),
        legacyCandidates.map((r) => ({
          ownershipId: r.proof.ownershipId,
          jobId: r.jobId,
          rev: r.revision,
        })),
      );
      return scopedCandidates;
    };

    assert.equal((await checkEquivalence(nextContext)).length, 1);
    // (b) READY with older/mismatched generation context -> 0 matching candidates in both legacy and scoped
    assert.equal(
      (await checkEquivalence({ ...nextContext, generation: nextContext.generation + 1 })).length,
      0,
    );

    // (c) RECHECK_REQUIRED -> returned by activeForProfile, ignored by stopEntry's READY filter
    const beforeRecheck = await store.taskTabs.get(sharedOwnershipId, activePlan.id);
    const rechecked = await store.taskTabs.requireRecheck(
      sharedOwnershipId,
      beforeRecheck.revision,
      'PRIOR_RECHECK',
      activePlan.id,
    );
    assert.equal(
      (await store.taskTabs.activeForProfile(f.profile.id))[0]?.state,
      'RECHECK_REQUIRED',
    );
    assert.equal((await checkEquivalence(nextContext)).length, 0);

    // Restore to READY with matching nextContext via confirmObserved
    await store.taskTabs.confirmObserved(
      sharedOwnershipId,
      rechecked.revision,
      sharedProof,
      nextContext,
      activePlan.id,
    );
    assert.equal((await checkEquivalence(nextContext)).length, 1);

    // (d) Revision conflict handling: mismatched revision throws TASK_TAB_REVISION_CONFLICT without mutating state
    const currentReady = await store.taskTabs.get(sharedOwnershipId, activePlan.id);
    await assert.rejects(
      async () =>
        await store.taskTabs.requireRecheck(
          sharedOwnershipId,
          currentReady.revision + 99,
          'SDK_OWNER_STOP_REQUESTED',
          activePlan.id,
        ),
      /标签页核对记录已变化/,
    );
    assert.equal((await store.taskTabs.get(sharedOwnershipId, activePlan.id)).state, 'READY');

    const stopped = await h.registry.control(activePlan.id, 'stop', 'USER_STOP');
    assert.equal(stopped.state, 'STOPPED');

    // sharedProof on activePlan transitioned to RECHECK_REQUIRED with SDK_OWNER_STOP_REQUESTED; histPlan row stayed RELEASED
    assert.equal((await store.taskTabs.get(sharedOwnershipId, histPlan.id)).state, 'RELEASED');
    const currentShared = await store.taskTabs.get(sharedOwnershipId, activePlan.id);
    assert.equal(currentShared.state, 'RECHECK_REQUIRED');
    assert.equal(currentShared.reason, 'SDK_OWNER_STOP_REQUESTED');

    // CLOSED and LOST untouched
    assert.equal(
      (await store.taskTabs.get(closedProof.ownershipId, activePlan.id)).state,
      'CLOSED',
    );
    assert.equal((await store.taskTabs.get(lostProof.ownershipId, activePlan.id)).state, 'LOST');
    // Other profile's READY tab untouched
    assert.equal((await store.taskTabs.get(otherProof.ownershipId, other.plan.id)).state, 'READY');
  });
});
