import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/bridge/store.js';
import { Core } from '../src/bridge/core.js';
import { WatchTasks } from '../src/bridge/watch.js';
import { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import { KernelJournal } from '../src/application/kernel-journal.js';
import { MemoryKernelStorage } from './fixtures/kernel-storage.js';
import { ExtensionKernelChannel } from '../extension/kernel-channel.js';
import type { KernelNativeBackend } from '../extension/kernel-backend.js';
import { KernelJsonObject } from '../src/shared/kernel-protocol.js';
import type { KernelState, TabProof } from '../src/shared/kernel-state.js';
import type { Binding } from '../src/shared/task-execution.js';
import { settlementFixture, prepareBound } from './fixtures/settlement.js';
import { TaskEndingCoordinator } from '../src/infrastructure/task-ending-coordinator.js';
import { FacebookPublishingRuntime } from '../src/infrastructure/facebook-publishing-runtime.js';
import { evaluateKernelReadiness } from '../src/domain/kernel-readiness.js';
import { NativeReviewService } from '../src/application/native-review.js';
import { KernelNativeReview } from '../src/infrastructure/kernel-native-review.js';
import { MAX_PENDING_KERNEL_RPC } from '../src/shared/kernel-capacity.js';
import { postFixture, postRequest, dispatchedPost } from './fixtures/material-post.js';

async function summaryHarness(
  badStop = false,
  holdRenew = false,
  initialBinding?: Binding,
  initialState: 'ACKNOWLEDGED' | 'UNKNOWN' = 'ACKNOWLEDGED',
  registeredMain?: TabProof,
  shared?: { core: Core; bridge: KernelBridge },
) {
  const store = new Store(':memory:'),
    core = shared?.core ?? new Core(store),
    profileId = initialBinding?.profileId ?? randomUUID();
  let channel: ExtensionKernelChannel | undefined,
    nativeCalls = 0;
  const peer = core.connect(
    profileId,
    (message) => {
      const body = KernelJsonObject.parse(message);
      if (holdRenew && body.kind === 'renew') return;
      if (body.type === 'KERNEL_REQUEST') channel?.receive(message);
    },
    () => {},
  );
  peer.phase = 'PAUSED';
  peer.synced = true;
  peer.capabilities = ['kernel-journal-v1'];
  const bridge = shared?.bridge ?? new KernelBridge(core, new WatchTasks(core));
  const journal = new KernelJournal(new MemoryKernelStorage());
  await journal.initialize(profileId, registeredMain?.browserSessionEpoch ?? randomUUID());
  const unexpected = async (): Promise<never> => {
    nativeCalls++;
    throw Error('UNEXPECTED_NATIVE_CALL');
  };
  const backend: KernelNativeBackend = {
    scope: unexpected,
    attach: unexpected,
    detach: unexpected,
    create: unexpected,
    remove: unexpected,
    send: unexpected,
    owns: () => false,
    detached: () => {},
    expectedDetach: () => false,
    inventory: async () => {
      const state = await journal.snapshot();
      return {
        ...state,
        ...(registeredMain &&
        state.tabs.some(
          (tab) => tab.ownershipId === registeredMain.ownershipId && tab.state === 'READY',
        )
          ? { workspaceMain: registeredMain }
          : {}),
      };
    },
  };
  channel = new ExtensionKernelChannel(
    () => ({ profileId, epoch: peer.epoch, valid: true }),
    async (message) => {
      const body = KernelJsonObject.parse(message);
      if (badStop && body.result && KernelJsonObject.parse(body.result).state === 'stopped')
        body.result = { ...KernelJsonObject.parse(body.result), requestId: randomUUID() };
      await bridge.message(peer, body);
    },
    () => backend,
    journal,
  );
  const binding: Binding = initialBinding ?? {
    profileId,
    accountId: 'fixture-only',
    connectionEpoch: randomUUID(),
    leaseId: randomUUID(),
    generation: 0,
    operationId: randomUUID(),
    jobId: randomUUID(),
    stepId: randomUUID(),
    actionDigest: 'a'.repeat(64),
  };
  await journal.begin(binding);
  await journal.finish(
    binding,
    initialState,
    initialState === 'UNKNOWN' ? 'FIXTURE_RESULT_LOST' : '',
  );
  return {
    bridge,
    peer,
    journal,
    binding,
    core,
    nativeCalls: () => nativeCalls,
    close: async () => {
      if (!shared) {
        await bridge.close();
        await core.shutdown();
      }
      store.close();
    },
  };
}
test('a saturated ordinary RPC lane still admits the exact stop and releases every pending request', async () => {
  const f = await summaryHarness();
  const originalSend = f.peer.send;
  let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await f.bridge.withSummary(f.peer, async (port) => {
      f.peer.send = (message) => {
        const value = KernelJsonObject.parse(message);
        if (value.kind !== 'inventory') originalSend(message);
      };
      pending = Promise.allSettled(
        Array.from({ length: MAX_PENDING_KERNEL_RPC }, () => port.inventory()),
      );
      await assert.rejects(port.inventory(), /KERNEL_RPC_CAPACITY_REJECTED/);
      const stop = await port.stopCurrent(randomUUID());
      assert.equal(stop.state, 'stopped');
    });
    assert.ok(pending);
    const settled = await pending;
    assert.equal(settled.length, MAX_PENDING_KERNEL_RPC);
    assert.ok(settled.every((result) => result.status === 'rejected'));
    f.peer.send = originalSend;
    await f.bridge.withSummary(f.peer, async (port) => {
      assert.equal((await port.inventory()).profileId, f.peer.profileId);
    });
    assert.equal(f.nativeCalls(), 0);
  } finally {
    f.peer.send = originalSend;
    await f.close();
  }
});

test('a pending ending cannot block another profile that reconnects on a later heartbeat', async () => {
  await settlementFixture(async (store) => {
    const first = await prepareBound(store),
      second = await prepareBound(store);
    for (const original of [first, second])
      await store.tasks.markBoundUnknown(original.binding, 'FIXTURE_RESULT_LOST');
    const f = await summaryHarness(false, false, first.binding, 'UNKNOWN');
    const other = await summaryHarness(false, false, second.binding, 'UNKNOWN', undefined, f);
    for (const peer of [f.peer, other.peer]) peer.capabilities?.push('kernel-unknown-end-v1');
    other.peer.online = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalSummary = f.bridge.withSummary.bind(f.bridge);
    let firstEntered = false;
    f.bridge.withSummary = async (peer, work) => {
      if (peer.profileId === first.profile.id) {
        firstEntered = true;
        await held;
      }
      return originalSummary(peer, work);
    };
    const product = new FacebookPublishingRuntime(f.bridge, f.core, store, 'fixture-only', () => [
      first.profile,
      second.profile,
    ]);
    const waitFor = async (condition: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 2000;
      while (!(await condition()) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(await condition(), 'ending did not progress independently');
    };
    try {
      await product.tick();
      await waitFor(() => firstEntered);
      other.peer.online = true;
      await product.tick();
      await waitFor(async () => (await store.tasks.get(second.plan.id)).state === 'FAILED');
      assert.equal((await store.tasks.get(first.plan.id)).state, 'STOPPING');
      assert.equal((await store.tasks.operations(second.plan.id))[0]?.status, 'UNKNOWN');
      assert.equal(
        (await other.journal.snapshot()).operations[0]?.disposition?.outcome,
        'ENDED_UNKNOWN',
      );
      release();
      await waitFor(async () => (await store.tasks.get(first.plan.id)).state === 'FAILED');
      assert.equal(f.nativeCalls() + other.nativeCalls(), 0);
    } finally {
      release();
      await product.close();
      await other.close();
      await f.close();
    }
  });
});
test('actual ending channel retains only registered main and releases a sole plan child beside it', async () => {
  for (const ownsMain of [true, false]) {
    await postFixture(async (store, _file, catalog) => {
      const r = await postRequest(store, catalog);
      await store.materials.reserve(r);
      const original = await dispatchedPost(store, r, 'OPEN_COMPOSER');
      await store.tasks.markBoundUnknown(original.binding, 'FIXTURE_RESULT_LOST');
      const main = ownsMain
        ? r.proof
        : { ...r.proof, ownershipId: randomUUID(), tabId: 43, targetId: randomUUID() };
      const f = await summaryHarness(false, false, original.binding, 'UNKNOWN', main);
      f.peer.capabilities?.push(
        'kernel-unknown-end-v1',
        'kernel-page-quiesce-v1',
        'kernel-workspace-main-proof-v1',
      );
      try {
        for (const proof of ownsMain ? [main] : [main, r.proof]) {
          await f.journal.prepareTab(proof.ownershipId, 'https://www.facebook.com/');
          await f.journal.confirmTab(proof);
        }
        const ended = await new TaskEndingCoordinator(f.bridge, f.core, store).end(r.jobId);
        assert.equal(ended.state, 'FAILED');
        const native = await f.journal.snapshot();
        assert.equal(
          native.tabs.find((tab) => tab.ownershipId === main.ownershipId)?.state,
          'READY',
        );
        assert.equal(
          (await store.taskTabs.forPlan(r.jobId))[0]?.state,
          ownsMain ? 'RELEASED' : 'LOST',
        );
        assert.equal((await store.tasks.operations(r.jobId))[0]?.status, 'UNKNOWN');
        assert.equal(native.operations[0]?.state, 'UNKNOWN');
        assert.equal(native.operations[0]?.disposition?.outcome, 'ENDED_UNKNOWN');
        assert.equal(f.nativeCalls(), 0);
      } finally {
        await f.close();
      }
    });
  }
});
test('closed publication editor continues its original independent successor through channel stop and ownership settlement', async () => {
  for (const closesMain of [true, false]) {
    await postFixture(async (store, _file, catalog) => {
      const r = await postRequest(store, catalog, {
        followingSteps: [
          { id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
        ],
      });
      await store.materials.reserve(r);
      const original = await dispatchedPost(store, r, 'OPEN_COMPOSER');
      const reason = 'FACEBOOK_POST_EDITOR_CLOSED';
      await store.tasks.noteStepFailure(r.jobId, r.stepId, reason);
      await store.tasks.markBoundUnknown(original.binding, reason);
      const control = await store.tasks.requestControl(r.jobId, 'pause', reason);
      assert.ok(control.controlRequestId);
      await store.tasks.confirmControl(r.jobId, control.controlRequestId);
      await store.tasks.requestStepEnd(r.jobId, r.stepId, reason);
      const main = closesMain
        ? r.proof
        : { ...r.proof, ownershipId: randomUUID(), tabId: 43, targetId: randomUUID() };
      const f = await summaryHarness(false, false, original.binding, 'UNKNOWN', main);
      f.peer.capabilities?.push(
        'kernel-unknown-end-v1',
        'kernel-page-quiesce-v1',
        'kernel-workspace-main-proof-v1',
      );
      try {
        for (const proof of closesMain ? [main] : [main, r.proof]) {
          await f.journal.prepareTab(proof.ownershipId, 'https://www.facebook.com/');
          await f.journal.confirmTab(proof);
        }
        await f.journal.tabState(r.proof.ownershipId, 'CLOSED', 'GENERATED_USER_TAB_CLOSE');
        const next = await new TaskEndingCoordinator(f.bridge, f.core, store).end(r.jobId);
        assert.equal(next.id, r.jobId);
        assert.equal(next.state, 'QUEUED');
        assert.equal(next.position, 1);
        assert.equal((await store.tasks.steps(r.jobId))[0]?.status, 'FAILED');
        assert.equal((await store.tasks.steps(r.jobId))[1]?.status, 'ACTIVE');
        assert.equal((await store.tasks.steps(r.jobId))[1]?.progress.effectiveMilliseconds, 0);
        assert.equal((await store.materials.reservation(r.attemptId)).state, 'NOT_PUBLISHED');
        assert.equal((await store.tasks.operations(r.jobId)).length, 1);
        assert.equal((await store.tasks.operations(r.jobId))[0]?.status, 'UNKNOWN');
        const native = await f.journal.snapshot();
        assert.equal(
          native.tabs.find((tab) => tab.ownershipId === main.ownershipId)?.state,
          closesMain ? 'CLOSED' : 'READY',
        );
        assert.equal(f.nativeCalls(), 0);
      } finally {
        await f.close();
      }
    }, false);
  }
});
test('a peer fence preserves the first session failure and sends no later RPC', async () => {
  const f = await summaryHarness();
  try {
    await assert.rejects(
      f.bridge.withSummary(f.peer, async () => {
        const sessions = (
          f.bridge as unknown as {
            sessions: Map<
              string,
              {
                fail(reason: string): void;
                request(body: { kind: 'inventory' }): Promise<unknown>;
              }
            >;
          }
        ).sessions;
        const session = sessions.get(f.peer.profileId);
        assert.ok(session);
        session.fail('KERNEL_LEASE_RENEW_FAILED:FIXTURE_RENEW_REJECTED');
        session.fail('LATER_CLEANUP_FAILURE');
        f.peer.phase = 'STOPPING';
        await assert.rejects(
          session.request({ kind: 'inventory' }),
          /^Error: KERNEL_LEASE_RENEW_FAILED:FIXTURE_RENEW_REJECTED$/,
        );
        assert.ok(
          f.bridge
            .diagnostics(f.peer.profileId)
            .some((row) =>
              row.event.includes(
                'peer-fenced:STOPPING:online=true:synced=true:reason=KERNEL_LEASE_RENEW_FAILED',
              ),
            ),
        );
        throw Error('FIXTURE_DONE');
      }),
      /FIXTURE_DONE/,
    );
    assert.equal(f.nativeCalls(), 0);
  } finally {
    await f.close();
  }
});

test('native diagnostics report initialization ownership as busy, not a storage failure, and release no foreign owner', async () => {
  const f = await summaryHarness();
  const owner = randomUUID();
  try {
    await f.core.claimFixtureKernel(f.peer, owner);
    const review = new KernelNativeReview(f.bridge, f.core);
    await assert.rejects(review.read(f.peer.profileId), {
      code: 'NATIVE_REVIEW_BUSY',
      status: 409,
    });
    await assert.rejects(
      async () => await f.core.claimFixtureKernel(f.peer, randomUUID()),
      /KERNEL_PROFILE_NOT_IDLE/,
    );
    f.core.releaseFixtureKernel(f.peer, owner);
    assert.equal((await review.read(f.peer.profileId)).profileId, f.peer.profileId);
    const timings = f.bridge
      .diagnostics(f.peer.profileId)
      .filter((row) => row.event.startsWith('rpc-finished:'));
    assert.ok(timings.some((row) => /^rpc-finished:inventory:REPLY:\d+ms$/.test(row.event)));
    assert.ok(timings.every((row) => !row.event.includes(f.binding.accountId)));
    assert.equal(f.nativeCalls(), 0);
  } finally {
    f.core.releaseFixtureKernel(f.peer, owner);
    await f.close();
  }
});

test('summary STOP and unknown disposition suppress old renewal before their read-only work returns', async () => {
  for (const mode of ['stop', 'unknown']) {
    const f = await summaryHarness(false, false, undefined, 'UNKNOWN');
    f.peer.capabilities?.push('kernel-unknown-end-v1');
    try {
      let stops = 0;
      const original = f.core.stop.bind(f.core);
      f.core.stop = async (profileId) => {
        stops++;
        return await original(profileId);
      };
      await f.bridge.withSummary(f.peer, async (port) => {
        if (mode === 'stop') {
          const receipt = await port.stopCurrent(randomUUID());
          assert.equal(receipt.state, 'stopped');
        } else {
          const disposition = {
            id: randomUUID(),
            outcome: 'ENDED_UNKNOWN' as const,
            evidenceDigest: 'c'.repeat(64),
          };
          assert.deepEqual(await port.notify(f.binding, disposition), {
            binding: f.binding,
            resolution: disposition,
          });
        }
        f.bridge.tick();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        assert.equal(stops, 0);
        assert.equal(f.peer.phase, 'PAUSED');
      });
      assert.equal(stops, 0);
      await f.bridge.withSummary(f.peer, async (port) => {
        assert.equal((await port.inventory()).profileId, f.peer.profileId);
      });
      assert.equal(f.nativeCalls(), 0);
    } finally {
      await f.close();
    }
  }
});

test('renewal rejected after summary owner closes cannot stop the peer or its next owner', async () => {
  const f = await summaryHarness(false, true);
  try {
    let stopCalls = 0;
    const originalStop = f.core.stop.bind(f.core);
    f.core.stop = async (profileId) => {
      stopCalls++;
      return await originalStop(profileId);
    };
    await f.bridge.withSummary(f.peer, async (port) => {
      await port.inventory();
      f.bridge.tick();
    });
    await Promise.resolve();
    assert.equal(stopCalls, 0);
    assert.equal(f.peer.phase, 'PAUSED');
    await f.bridge.withSummary(f.peer, async (port) => {
      assert.equal((await port.inventory()).profileId, f.peer.profileId);
    });
    assert.equal(stopCalls, 0);
    assert.equal(f.nativeCalls(), 0);
  } finally {
    await f.close();
  }
});
test('summary-only bridge reconciles original binding under new lease without invoking native backend and invalidates escaped port', async () => {
  const f = await summaryHarness();
  try {
    let escaped: (() => Promise<KernelState>) | undefined;
    const resolution = {
      id: randomUUID(),
      outcome: 'VERIFIED' as const,
      evidenceDigest: 'b'.repeat(64),
    };
    await f.bridge.withSummary(f.peer, async (port) => {
      escaped = port.inventory;
      assert.equal((await port.inventory()).operations[0]?.state, 'ACKNOWLEDGED');
      assert.deepEqual(await port.notify(f.binding, resolution), {
        binding: f.binding,
        resolution,
      });
    });
    assert.ok(escaped);
    await assert.rejects(escaped(), /SUMMARY_SESSION_CLOSED/);
    assert.equal(f.nativeCalls(), 0);
    assert.equal((await f.journal.snapshot()).operations[0]?.state, 'RECONCILED');
    await f.bridge.withSummary(f.peer, async (port) => {
      await port.notify(f.binding, resolution);
    });
    assert.equal(f.nativeCalls(), 0);
  } finally {
    await f.close();
  }
});
test('summary session refuses foreign profile and conflicting stable resolution, preserving original journal', async () => {
  const f = await summaryHarness();
  try {
    const resolution = {
      id: randomUUID(),
      outcome: 'VERIFIED' as const,
      evidenceDigest: 'b'.repeat(64),
    };
    await f.bridge.withSummary(f.peer, async (port) => {
      await assert.rejects(
        port.notify({ ...f.binding, profileId: randomUUID() }, resolution),
        /PROFILE_REJECTED/,
      );
      await port.notify(f.binding, resolution);
      await assert.rejects(
        port.notify(f.binding, { ...resolution, evidenceDigest: 'c'.repeat(64) }),
        /CONFLICT/,
      );
    });
    assert.deepEqual((await f.journal.snapshot()).operations[0]?.resolution, resolution);
    assert.equal(f.nativeCalls(), 0);
  } finally {
    await f.close();
  }
});
test('wrong inner stop request cannot release summary ownership or claim a new session', async () => {
  const f = await summaryHarness(true);
  try {
    await assert.rejects(
      f.bridge.withSummary(f.peer, async (port) => {
        await port.inventory();
      }),
      /STOP_RECEIPT_MISMATCH/,
    );
    assert.equal(f.peer.phase, 'STOPPING');
    await assert.rejects(
      f.bridge.withSummary(f.peer, async () => {}),
      /PROFILE_NOT_IDLE/,
    );
    assert.equal(f.nativeCalls(), 0);
  } finally {
    await f.close();
  }
});

test('original SQL plan ends through actual channel STOP and durable notice; UNKNOWN stays and next plan can claim', async () => {
  await settlementFixture(async (store) => {
    const original = await prepareBound(store);
    await store.tasks.markBoundUnknown(original.binding, 'FIXTURE_RESULT_LOST');
    const f = await summaryHarness(false, false, original.binding, 'UNKNOWN');
    f.peer.capabilities?.push('kernel-unknown-end-v1');
    try {
      const product = new FacebookPublishingRuntime(f.bridge, f.core, store, 'fixture-only', () => [
        original.profile,
      ]);
      const [first, duplicate] = await Promise.all([
        product.commandPlan(original.plan.id, 'stop'),
        product.commandPlan(original.plan.id, 'stop'),
      ]);
      assert.equal(first.state, 'FAILED');
      assert.deepEqual(first, duplicate);
      assert.equal(first.controlConfirmed, false); // No fabricated historical confirmation.
      assert.equal((await store.tasks.operations(first.id))[0]?.status, 'UNKNOWN');
      const inventory = await f.journal.snapshot();
      assert.equal(inventory.operations[0]?.state, 'UNKNOWN');
      assert.equal(inventory.operations[0]?.reason, 'FIXTURE_RESULT_LOST');
      assert.equal(inventory.operations[0]?.resolution, null);
      assert.equal(inventory.operations[0]?.disposition?.outcome, 'ENDED_UNKNOWN');
      assert.equal(
        evaluateKernelReadiness(
          first.profileId,
          inventory,
          await store.tasks.operations(first.id),
          await store.tasks.settlements.list(),
        ).ready,
        true,
      );
      assert.equal(f.nativeCalls(), 0); // No navigation, attach, upload or business send.
      await store.tasks.assign(
        {
          requestId: randomUUID(),
          combinationId: first.combinationId,
          version: first.version,
          profileIds: [first.profileId],
        },
        [original.profile],
      );
      assert.ok(await store.tasks.claimNext([original.profile], new Set(['video'])));
      const later = { ...original.binding, operationId: randomUUID(), jobId: randomUUID() };
      assert.equal((await f.journal.begin(later)).fresh, true);
      assert.equal((await f.journal.begin(original.binding)).fresh, false); // Never replay old input.
      await product.close();
    } finally {
      await f.close();
    }
  });
});

test('incorrect current stop leaves original UNKNOWN and account occupied; new ending intent persists', async () => {
  await settlementFixture(async (store) => {
    const original = await prepareBound(store);
    await store.tasks.markBoundUnknown(original.binding, 'FIXTURE_RESULT_LOST');
    const f = await summaryHarness(true, false, original.binding);
    f.peer.capabilities?.push('kernel-unknown-end-v1');
    try {
      const end = new TaskEndingCoordinator(f.bridge, f.core, store);
      await assert.rejects(end.end(original.plan.id), /STOP_RECEIPT_MISMATCH/);
      assert.equal((await store.tasks.get(original.plan.id)).state, 'STOPPING');
      assert.ok(await store.tasks.endingId(original.plan.id));
      assert.equal((await store.tasks.settlements.list()).length, 0);
      assert.equal((await f.journal.snapshot()).operations[0]?.disposition, undefined);
      assert.equal(f.nativeCalls(), 0);
    } finally {
      await f.close();
    }
  });
});

test('restart recovery ends a persisted stop with no local owner through current STOP and original notices', async () => {
  await settlementFixture(async (store) => {
    const original = await prepareBound(store);
    await store.tasks.markBoundUnknown(original.binding, 'FIXTURE_RESULT_LOST');
    await store.tasks.requestControl(original.plan.id, 'stop', 'USER_STOP');
    assert.equal(await store.tasks.endingId(original.plan.id), null);
    const f = await summaryHarness(false, false, original.binding, 'UNKNOWN');
    f.peer.capabilities?.push('kernel-unknown-end-v1');
    const product = new FacebookPublishingRuntime(f.bridge, f.core, store, 'fixture-only', () => [
      original.profile,
    ]);
    try {
      assert.equal((await product.runtime.registry.status()).length, 0);
      await product.tick();
      const deadline = Date.now() + 2000;
      while ((await store.tasks.get(original.plan.id)).state !== 'FAILED' && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal((await store.tasks.get(original.plan.id)).state, 'FAILED');
      assert.equal((await store.tasks.get(original.plan.id)).controlConfirmed, false);
      assert.equal((await store.tasks.operations(original.plan.id))[0]?.status, 'UNKNOWN');
      assert.equal(
        (await f.journal.snapshot()).operations[0]?.disposition?.outcome,
        'ENDED_UNKNOWN',
      );
      assert.equal((await store.tasks.pendingEndings()).length, 0);
      assert.equal(f.nativeCalls(), 0);
    } finally {
      await product.close();
      await f.close();
    }
  });
});

test('ending withdraws only the exact owned tab proof without closing a user page or claiming it CLOSED', async () => {
  const f = await summaryHarness();
  f.peer.capabilities?.push('kernel-unknown-end-v1');
  try {
    const ownershipId = randomUUID();
    const proof = {
      ownershipId,
      profileId: f.peer.profileId,
      browserSessionEpoch: (await f.journal.snapshot()).browserSessionEpoch,
      tabId: 42,
      targetId: randomUUID(),
    };
    await f.journal.prepareTab(ownershipId, 'https://www.facebook.com/');
    await f.journal.confirmTab(proof);
    await assert.rejects(
      f.bridge.withSummary(f.peer, (port) =>
        port.stopCurrent(randomUUID(), [{ ...proof, targetId: randomUUID() }]),
      ),
      /WITHDRAW_PROOF_REJECTED/,
    );
    assert.equal((await f.journal.snapshot()).tabs[0]?.state, 'READY');
    await f.bridge.withSummary(f.peer, (port) => port.stopCurrent(randomUUID(), [proof]));
    const row = (await f.journal.snapshot()).tabs[0];
    assert.equal(row?.state, 'LOST');
    assert.equal(row?.reason, 'TASK_ENDED_OWNERSHIP_WITHDRAWN');
    assert.deepEqual(row?.proof, proof);
    assert.equal(f.nativeCalls(), 0);
  } finally {
    await f.close();
  }
});

test('historical orphan ACK and proofless creation recover through original STOP/journal; no native inputs or business verdict are produced', async () => {
  await settlementFixture(async (store) => {
    const f = await summaryHarness();
    f.peer.capabilities?.push('kernel-unknown-end-v1', 'kernel-idle-tab-end-v1');
    const ownershipId = randomUUID();
    await f.journal.prepareTab(ownershipId, 'https://www.facebook.com/');
    await f.journal.tabState(ownershipId, 'UNKNOWN', 'CREATE_RESULT_UNKNOWN');
    const before = await f.journal.snapshot();
    try {
      const service = new NativeReviewService(
        new KernelNativeReview(f.bridge, f.core),
        store.tasks,
      );
      const result = await service.releaseIdle({ profileId: f.peer.profileId });
      assert.deepEqual(result, { released: 1, endedOperations: 1 });
      const after = await f.journal.snapshot();
      assert.equal(after.operations[0]?.state, 'ACKNOWLEDGED');
      assert.deepEqual(after.operations[0]?.binding, before.operations[0]?.binding);
      assert.equal(after.operations[0]?.resolution, null);
      assert.equal(after.operations[0]?.disposition?.outcome, 'ENDED_UNKNOWN');
      assert.equal(after.tabs[0]?.state, 'LOST');
      assert.equal(after.tabs[0]?.proof, null);
      assert.equal(f.nativeCalls(), 0);
      assert.deepEqual(await service.releaseIdle({ profileId: f.peer.profileId }), {
        released: 0,
        endedOperations: 0,
      });
      const report = await service.read({ profileId: f.peer.profileId });
      assert.equal(report.blockingCount, 0);
      assert.equal(report.activeTabCount, 0);
      assert.equal(report.operations[0]?.ended, true);
      assert.equal((await store.tasks.list()).length, 0);
    } finally {
      await f.close();
    }
  });
});
