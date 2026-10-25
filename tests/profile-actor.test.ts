import { BusinessResolution } from '../src/shared/settlement.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ProfileActor } from '../src/application/profile-actor.js';
import { ActorBrowserPort } from '../src/application/actor-browser-port.js';
import { TaskDispatcher } from '../src/application/task-dispatcher.js';
import type { ProfileActorSession, GuardedBrowserPort } from '../src/domain/profile-actor.js';
import type { KernelState } from '../src/shared/kernel-state.js';
import type { ExecutionSession, Binding } from '../src/shared/task-execution.js';
import type { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { settlementFixture, prepareBound, verifyBound } from './fixtures/settlement.js';

async function harness(store: WorkspaceStore) {
  const f = await prepareBound(store);
  await verifyBound(store, f);
  const notice = await store.tasks.settlements.claim(f.profile.id);
  assert.ok(notice?.claimToken);
  await store.tasks.settlements.delivered(f.binding.operationId, notice.claimToken, {
    binding: notice.binding,
    resolution: BusinessResolution.parse(notice.resolution),
  });
  const context: ExecutionSession = {
    profileId: f.binding.profileId,
    accountId: f.binding.accountId,
    connectionEpoch: f.binding.connectionEpoch,
    leaseId: f.binding.leaseId,
    generation: f.binding.generation,
  };
  const live = {
    context: context as ExecutionSession | null,
    native: context as ExecutionSession | null,
    runtime: f.profile,
    inputs: 0,
    observations: 0,
  };
  const remote: KernelState = {
    version: 1,
    profileId: f.profile.id,
    browserSessionEpoch: randomUUID(),
    tabs: [],
    operations: [
      {
        binding: f.binding,
        state: 'RECONCILED',
        reason: 'prior-fixture-verified',
        resolution: BusinessResolution.parse(notice.resolution),
      },
    ],
  };
  const port: ProfileActorSession = {
    profileId: f.profile.id,
    profile: () => live.runtime,
    current: () => live.context,
    inventory: async () => {
      live.observations++;
      return structuredClone(remote);
    },
    notify: async (binding, resolution) => {
      const record = remote.operations.find((op) => op.binding.operationId === binding.operationId);
      assert.ok(record);
      record.state = 'RECONCILED';
      record.resolution = BusinessResolution.parse(resolution);
      return { binding, resolution };
    },
  };
  const actor = new ProfileActor(port, store.tasks, store.tasks.settlements);
  const native: GuardedBrowserPort = {
    profiles: () => [live.runtime],
    session: () => live.native,
    send: async () => {
      throw Error('UNGUARDED_SEND_FORBIDDEN');
    },
    sendGuarded: async (operation, guard) => {
      await guard();
      live.inputs++;
      remote.operations.push({
        binding: operation.binding,
        state: 'ACKNOWLEDGED',
        reason: 'mock-native-ack',
        resolution: null,
      });
      return { binding: operation.binding, evidence: { fixtureOnly: true } };
    },
  };
  const browser = new ActorBrowserPort(native, [actor]),
    dispatcher = new TaskDispatcher(store.tasks, browser);
  await actor.observe();
  assert.equal((await actor.status()).state, 'READY');
  const prepare = async () =>
    await store.tasks.prepareOperation(f.plan.id, f.step.id, randomUUID(), {
      kind: 'click',
      tabId: 42,
      documentEpoch: 0,
      routeEpoch: 0,
      target: { css: '#counter' },
    });
  const take = async () => {
    const op = await store.tasks.takeBoundOperation(context);
    assert.ok(op?.binding);
    return { ...op, binding: op.binding };
  };
  return { ...f, live, remote, port, actor, native, browser, dispatcher, prepare, take, context };
}
const wait = () => {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    release: () => {
      assert.ok(release);
      release();
    },
  };
};

test('browser input fences use fresh exact-profile health without reading the full inventory', async () => {
  for (const changed of [false, true])
    await settlementFixture(async (store) => {
      const f = await harness(store);
      await f.prepare();
      const operation = await f.take();
      let reads = 0;
      f.native.profile = (profileId) => {
        assert.equal(profileId, operation.binding.profileId);
        reads++;
        return changed && reads > 1 ? undefined : f.live.runtime;
      };
      f.native.profiles = () => {
        throw Error('FULL_INVENTORY_ON_INPUT');
      };
      f.native.sendGuarded = async (op, guard) => {
        for (let i = 0; i < 384; i++) await guard();
        f.live.inputs++;
        return { binding: op.binding, evidence: { fixtureOnly: true } };
      };
      if (changed) {
        await assert.rejects(f.browser.send(operation), /ACTOR_BROWSER_CONTEXT_CHANGED/);
        assert.equal(f.live.inputs, 0);
      } else {
        const result = await f.browser.send(operation);
        assert.equal(result.binding.operationId, operation.id);
        assert.ok(reads >= 384);
        assert.equal(f.live.inputs, 1);
      }
    });
});

test('repeated live input fences read only their exact original operation, never profile history', async () => {
  await settlementFixture(async (store) => {
    const f = await harness(store);
    await f.prepare();
    const operation = await f.take();
    const read = store.tasks.findOperation.bind(store.tasks);
    assert.equal(await read(randomUUID(), operation.id), null);
    assert.equal(await read(f.plan.id, randomUUID()), null);
    let reads = 0;
    store.tasks.findOperation = (jobId, id) => {
      assert.equal(jobId, operation.jobId);
      assert.equal(id, operation.id);
      reads++;
      return read(jobId, id);
    };
    store.tasks.list = () => {
      throw Error('HISTORY_MUST_NOT_BE_READ_DURING_INPUT');
    };
    store.tasks.operations = () => {
      throw Error('HISTORY_MUST_NOT_BE_READ_DURING_INPUT');
    };
    const receipt = await f.actor.execute(operation, async (guard) => {
      for (let n = 0; n < 384; n++) await guard();
      return { binding: operation.binding, evidence: { fixtureOnly: true } };
    });
    assert.equal(receipt.binding.operationId, operation.id);
    assert.ok(reads >= 384);
    assert.equal((await f.actor.status()).state, 'AWAITING_VERIFICATION');
    await store.tasks.markBoundUnknown(operation.binding, 'GENERATED_REVOKE');
    assert.equal(await f.actor.session(), null);
  });
});

test('actor holds ACK for independent verification, blocks next binding until notification and preserves RUNNING during backpressure', async () => {
  await settlementFixture(async (store) => {
    const f = await harness(store);
    await f.prepare();
    assert.equal(await f.dispatcher.flushOne(), true);
    const op = (await store.tasks.operations(f.plan.id))[1];
    assert.ok(op?.binding);
    assert.equal(op.status, 'ACKNOWLEDGED');
    assert.equal((await f.actor.status()).state, 'AWAITING_VERIFICATION');
    await f.actor.observe();
    assert.equal(await f.dispatcher.flushOne(), false);
    assert.equal((await store.tasks.get(f.plan.id)).state, 'RUNNING');
    await f.dispatcher.verify(
      { binding: op.binding, evidence: { independentlyNotApplied: true } },
      'NOT_APPLIED',
    );
    await f.prepare();
    assert.equal(await f.dispatcher.flushOne(), false);
    assert.equal((await store.tasks.operations(f.plan.id))[2]?.binding, null);
    assert.equal((await store.tasks.get(f.plan.id)).state, 'RUNNING');
    await f.actor.observe();
    assert.equal((await f.actor.status()).state, 'READY');
    assert.equal(
      (await store.tasks.settlements.list(f.profile.id)).filter((row) => row.state === 'DELIVERED')
        .length,
      2,
    );
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.likes, 1);
  });
});
test('cached readiness is invalid for account, epoch, lease or generation changes; new observation is required', async () => {
  await settlementFixture(async (store) => {
    const f = await harness(store);
    for (const changed of [
      { ...f.context, connectionEpoch: randomUUID() },
      { ...f.context, leaseId: randomUUID() },
      { ...f.context, generation: 1 },
      { ...f.context, accountId: 'another-account' },
    ]) {
      f.live.context = changed;
      assert.equal(await f.actor.session(), null);
      assert.equal((await f.actor.status()).state, 'BLOCKED');
      f.live.context = f.context;
      assert.equal(await f.actor.session(), null);
      await f.actor.observe();
      assert.equal((await f.actor.status()).state, 'READY');
    }
  });
});
test('invalidation wins over an outstanding observation and concurrent observation does not read twice', async () => {
  await settlementFixture(async (store) => {
    const f = await harness(store),
      block = wait();
    let reads = 0;
    f.port.inventory = async () => {
      reads++;
      await block.promise;
      return f.remote;
    };
    const first = f.actor.observe(),
      second = f.actor.observe();
    assert.equal(first, second);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await f.actor.invalidate('USER_STOP');
    block.release();
    await first;
    assert.equal(reads, 1);
    assert.equal((await f.actor.status()).state, 'BLOCKED');
    assert.equal(await f.actor.session(), null);
  });
});
test('stop fences an SDK wait before its native input and preserves actual pending control ID and unknown lock', async () => {
  await settlementFixture(async (store) => {
    const f = await harness(store),
      block = wait();
    await f.prepare();
    f.native.sendGuarded = async (op, guard) => {
      await block.promise;
      await guard();
      f.live.inputs++;
      return { binding: op.binding, evidence: {} };
    };
    const sending = f.dispatcher.flushOne();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const pending = await store.tasks.requestControl(f.plan.id, 'stop');
    await f.actor.invalidate('STOP_REQUESTED');
    block.release();
    await sending;
    assert.equal(f.live.inputs, 0);
    assert.equal((await store.tasks.operations(f.plan.id))[1]?.status, 'UNKNOWN');
    assert.equal((await store.tasks.get(f.plan.id)).controlRequestId, pending.controlRequestId);
    assert.equal((await store.tasks.get(f.plan.id)).state, 'STOPPING');
    await f.actor.observe();
    assert.equal(await f.actor.session(), null);
  });
});
test('wrong receipt and late ordinary success retain unknown rather than advancing business count', async () => {
  await settlementFixture(async (store) => {
    const f = await harness(store);
    await f.prepare();
    f.native.sendGuarded = async (op, guard) => {
      await guard();
      return { binding: { ...op.binding, leaseId: randomUUID() }, evidence: {} };
    };
    await f.dispatcher.flushOne();
    const op = (await store.tasks.operations(f.plan.id))[1];
    assert.ok(op?.binding);
    assert.equal(op.status, 'UNKNOWN');
    await assert.rejects(
      async () =>
        await store.tasks.settleBound({ binding: op.binding as Binding, evidence: {} }, 'VERIFIED'),
      /独立核对/,
    );
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.likes, 1);
    assert.equal((await store.tasks.get(f.plan.id)).state, 'REVIEW');
  });
});
test('a second actor is independent while first waits, and neither duplicate send nor repeated actor registration is allowed', async () => {
  await settlementFixture(async (store) => {
    const first = await harness(store),
      second = await harness(store),
      block = wait();
    await first.prepare();
    const op = await first.take();
    const sending = first.actor.execute(op, async (guard) => {
      await block.promise;
      await guard();
      return { binding: op.binding, evidence: {} };
    });
    await assert.rejects(
      first.actor.execute(op, async () => {
        throw Error('MUST_NOT_RUN');
      }),
      /INPUT_NOT_READY/,
    );
    await second.prepare();
    const allProfiles: GuardedBrowserPort = {
      profiles: () => [first.live.runtime, second.live.runtime],
      session: (id) => (id === first.profile.id ? first.live.native : second.live.native),
      send: async () => {
        throw Error('UNGUARDED_SEND_FORBIDDEN');
      },
      sendGuarded: (operation, guard) =>
        (operation.binding.profileId === first.profile.id
          ? first.native
          : second.native
        ).sendGuarded(operation, guard),
    };
    const dispatcher = new TaskDispatcher(
      store.tasks,
      new ActorBrowserPort(allProfiles, [first.actor, second.actor]),
    );
    assert.equal(await dispatcher.flushOne(), true);
    assert.equal(second.live.inputs, 1);
    assert.throws(
      () => new ActorBrowserPort(first.native, [first.actor, first.actor]),
      /DUPLICATE_PROFILE_ACTOR/,
    );
    block.release();
    await sending;
  });
});
test('changed action cannot use a persisted binding even when operation and context IDs match', async () => {
  await settlementFixture(async (store) => {
    const f = await harness(store);
    await f.prepare();
    const op = await f.take();
    await assert.rejects(
      f.actor.execute(
        {
          ...op,
          action: {
            kind: 'click',
            tabId: 99,
            documentEpoch: 0,
            routeEpoch: 0,
            target: { css: '#counter' },
          },
        },
        async () => {
          throw Error('MUST_NOT_RUN');
        },
      ),
      /INPUT_NOT_READY/,
    );
    assert.equal(f.live.inputs, 0);
    assert.equal((await store.tasks.operations(f.plan.id))[1]?.status, 'DISPATCHING');
  });
});
test('notification reply loss blocks actor without pausing plan or replaying input', async () => {
  await settlementFixture(async (store) => {
    const f = await harness(store);
    await f.prepare();
    await f.dispatcher.flushOne();
    const op = (await store.tasks.operations(f.plan.id))[1];
    assert.ok(op?.binding);
    await f.dispatcher.verify(
      { binding: op.binding, evidence: { notApplied: true } },
      'NOT_APPLIED',
    );
    const original = f.port.notify;
    f.port.notify = async (binding, resolution) => {
      await original(binding, resolution);
      throw Error('LOST_REPLY');
    };
    await f.actor.observe();
    assert.equal((await f.actor.status()).state, 'BLOCKED');
    assert.equal(await f.actor.session(), null);
    assert.ok((await f.actor.status()).issues.some((issue) => issue.reason === 'NOTICE_PENDING'));
    assert.equal((await store.tasks.get(f.plan.id)).state, 'RUNNING');
    assert.equal(f.live.inputs, 1);
    assert.equal(await f.dispatcher.flushOne(), false);
  });
});
test('underlying native session change is fenced independently of actor observation cache', async () => {
  await settlementFixture(async (store) => {
    const f = await harness(store),
      block = wait();
    await f.prepare();
    f.native.sendGuarded = async (op, guard) => {
      await block.promise;
      await guard();
      f.live.inputs++;
      return { binding: op.binding, evidence: {} };
    };
    const sending = f.dispatcher.flushOne();
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.live.native = { ...f.context, leaseId: randomUUID() };
    assert.equal(await f.browser.session(f.profile.id), null);
    block.release();
    await sending;
    assert.equal(f.live.inputs, 0);
    assert.equal((await store.tasks.operations(f.plan.id))[1]?.status, 'UNKNOWN');
  });
});
test('unknown identity cannot gain a permit and observation does not resume paused plan', async () => {
  await settlementFixture(async (store) => {
    const f = await harness(store);
    f.live.runtime = {
      ...f.live.runtime,
      account: { state: 'unknown', id: null, name: null, avatar: null },
    };
    await f.actor.observe();
    assert.equal(await f.actor.session(), null);
    assert.equal((await f.actor.status()).reason, 'IDENTITY_OR_CHANNEL_REQUIRED');
    f.live.runtime = f.profile;
    const pending = await store.tasks.requestControl(f.plan.id, 'pause');
    assert.ok(pending.controlRequestId);
    await store.tasks.confirmControl(f.plan.id, pending.controlRequestId);
    await f.actor.observe();
    assert.equal((await store.tasks.get(f.plan.id)).state, 'PAUSED');
    assert.equal(await f.dispatcher.flushOne(), false);
  });
});
