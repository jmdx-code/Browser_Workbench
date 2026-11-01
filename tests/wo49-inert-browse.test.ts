import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { evaluateKernelReadiness } from '../src/domain/kernel-readiness.js';
import type { KernelState, TabProof } from '../src/shared/kernel-state.js';
import type { Operation } from '../src/shared/task-contracts.js';
import { settlementFixture, prepareBound } from './fixtures/settlement.js';
import { SettlementNotifier } from '../src/application/settlement-notifier.js';
import { ProfileActorRegistry } from '../src/application/profile-actor-registry.js';
import { KernelProfileInspection } from '../src/infrastructure/kernel-profile-inspection.js';
import { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import { Core, type Peer } from '../src/bridge/core.js';
import { Store as BridgeStore } from '../src/bridge/store.js';
import { WatchTasks } from '../src/bridge/watch.js';

const wheel = {
  kind: 'browseScroll' as const,
  tabId: 42,
  url: 'https://www.facebook.com/reels/',
  documentEpoch: 0,
  routeEpoch: 0,
  timeOrigin: 100,
  fromY: 0,
  deltaY: 400,
};
const emptyRemote = (profileId: string): KernelState => ({
  version: 1,
  profileId,
  browserSessionEpoch: randomUUID(),
  tabs: [],
  operations: [],
});

test('WO49-2: offline-cancelled inert scroll gets a verified proof; remote-absent op with its notice is ready', async () =>
  settlementFixture(async (store) => {
    const f = prepareBound(store, 2, wheel);
    store.tasks.markBoundUnknown(f.binding, 'SOFTWARE_RESTART_UNCERTAIN');
    store.tasks.requestControl(f.plan.id, 'pause', 'SOFTWARE_RESTART_UNCERTAIN');
    store.tasks.recoverOnStartup();
    const ops = store.tasks.operations(f.plan.id);
    assert.equal(ops[0]?.status, 'FAILED');
    assert.equal(ops[0]?.inertBrowseProof?.verified, true);
    assert.equal(ops[0]?.inertBrowseProof?.planConfirmedStopped, true);
    // The real notice stays PENDING and undelivered, yet it is not an unbounded retry source.
    const notices = store.tasks.settlements.list(f.plan.profileId);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.state, 'PENDING');
    const verdict = evaluateKernelReadiness(
      f.plan.profileId,
      emptyRemote(f.plan.profileId),
      ops,
      notices,
    );
    assert.deepEqual(verdict, { ready: true, issues: [] });
  }));

test('WO49-2: a forged offlineBrowseCancelled flag on a like never makes readiness pass', async () =>
  settlementFixture(async (store) => {
    const f = prepareBound(store, 2);
    store.tasks.markBoundUnknown(f.binding, 'EXPECTED_UNKNOWN');
    const op = store.tasks.operations(f.plan.id)[0];
    assert.ok(op);
    const forged: Operation = {
      ...op,
      status: 'FAILED',
      receipt: { binding: f.binding, evidence: { offlineBrowseCancelled: true } },
    };
    const verdict = evaluateKernelReadiness(
      f.plan.profileId,
      emptyRemote(f.plan.profileId),
      [forged],
      [],
    );
    assert.equal(verdict.ready, false);
    assert.ok(verdict.issues.some((row) => row.reason === 'REMOTE_MISSING'));
  }));

test('WO49-2: unregistered click operations are never cancelled offline or settled as NOT_APPLIED', async () =>
  settlementFixture(async (store) => {
    const f = prepareBound(store, 2); // default fixture action is a '#counter' click
    store.tasks.markBoundUnknown(f.binding, 'EXPECTED_UNKNOWN');
    assert.equal(store.tasks.stopOfflineBrowse(f.plan.id), null);
    assert.equal(store.tasks.settleTransientBrowseOperations(f.plan.id, 'SELF_HEAL'), false);
    assert.equal(store.tasks.operations(f.plan.id)[0]?.status, 'UNKNOWN');
  }));

test('WO49-3: claim honours the kind filter and skips a quiesced inert notice without delivering it', async () =>
  settlementFixture(async (store) => {
    const f = prepareBound(store, 2, wheel);
    store.tasks.markBoundUnknown(f.binding, 'SOFTWARE_RESTART_UNCERTAIN');
    store.tasks.requestControl(f.plan.id, 'pause', 'SOFTWARE_RESTART_UNCERTAIN');
    store.tasks.recoverOnStartup();
    const profileId = f.plan.profileId;
    // Remote has no such operation: the extension rejected the earlier delivery.
    const first = store.tasks.settlements.claim(profileId, { kind: 'BUSINESS' });
    assert.ok(first?.claimToken);
    assert.equal(store.tasks.settlements.claim(profileId, { kind: 'END' }), null);
    store.tasks.settlements.retry(
      first.binding.operationId,
      first.claimToken,
      'KERNEL_OPERATION_BINDING_REJECTED',
    );
    // Quiesced: the confirmed-stopped inert plan is not claimed again, nor reported as blocking.
    assert.equal(store.tasks.settlements.hasUndelivered(profileId), false);
    const notices = store.tasks.settlements.list(profileId);
    assert.equal(notices[0]?.state, 'PENDING');
    assert.equal(notices[0]?.reason, 'KERNEL_OPERATION_BINDING_REJECTED');
  }));

test('WO49-3: a notifier restricted to BUSINESS never claims END notices', async () => {
  const claims: unknown[] = [];
  const notifier = new SettlementNotifier({
    claim: (_profileId: string, options?: { kind?: 'BUSINESS' | 'END' }) => {
      claims.push(options);
      return null;
    },
    list: () => [],
    delivered: () => {},
    retry: () => {},
    recoverOnStartup: () => {},
  });
  await notifier.flushOne(
    { profileId: randomUUID(), notify: async () => Promise.reject(Error('x')) },
    {
      kind: 'BUSINESS',
    },
  );
  assert.deepEqual(claims, [{ kind: 'BUSINESS' }]);
});

test('WO49-1 & WO49-3: withSummary delivers END_UNKNOWN via endUnknownOperation and reconcile rejects KERNEL_OPERATION_BINDING_REJECTED without fake receipt', async () => {
  const bridgeStore = new BridgeStore(':memory:');
  const core = new Core(bridgeStore);
  const kernel = new KernelBridge(core, new WatchTasks(core));
  const profileId = randomUUID();
  const sent: Record<string, unknown>[] = [];
  const peer: Peer = core.connect(
    profileId,
    (msg) => {
      const m = msg as Record<string, unknown>;
      sent.push(m);
      if (m.type === 'KERNEL_REQUEST') {
        const reqId = String(m.requestId);
        const leaseId = String(m.leaseId);
        const epoch = String(m.connectionEpoch);
        const kind = String(m.kind);
        queueMicrotask(() => {
          if (kind === 'open') {
            void kernel.message(peer, {
              type: 'KERNEL_REPLY',
              requestId: reqId,
              connectionEpoch: epoch,
              leaseId,
              result: { opened: true },
            });
          } else if (kind === 'stop') {
            void kernel.message(peer, {
              type: 'KERNEL_REPLY',
              requestId: reqId,
              connectionEpoch: epoch,
              leaseId,
              result: { requestId: reqId, state: 'stopped' },
            });
          } else if (kind === 'reconcileOperation') {
            void kernel.message(peer, {
              type: 'KERNEL_REPLY',
              requestId: reqId,
              connectionEpoch: epoch,
              leaseId,
              error: 'KERNEL_OPERATION_BINDING_REJECTED',
            });
          } else if (kind === 'endUnknownOperation') {
            const binding = m.binding as Record<string, unknown>;
            const disposition = m.disposition as Record<string, unknown>;
            void kernel.message(peer, {
              type: 'KERNEL_REPLY',
              requestId: reqId,
              connectionEpoch: epoch,
              leaseId,
              result: {
                ended: true,
                binding,
                resolution: disposition,
                stop: { requestId: reqId, state: 'stopped' },
                inventory: {
                  version: 1,
                  profileId,
                  browserSessionEpoch: randomUUID(),
                  tabs: [],
                  operations: [
                    {
                      binding,
                      state: 'UNKNOWN',
                      reason: 'IDLE_ORPHAN_ENDED',
                      resolution: null,
                      disposition,
                    },
                  ],
                },
              },
            });
          }
        });
      }
    },
    () => {},
  );
  peer.synced = true;
  peer.phase = 'PAUSED';
  peer.capabilities = ['kernel-journal-v1', 'kernel-unknown-end-v1'];

  try {
    const binding = {
      profileId,
      accountId: '100001',
      connectionEpoch: peer.epoch,
      leaseId: randomUUID(),
      generation: 1,
      operationId: randomUUID(),
      jobId: randomUUID(),
      stepId: randomUUID(),
      actionDigest: 'a'.repeat(64),
    };
    await assert.rejects(
      kernel.withSummary(peer, (port) =>
        port.notify(binding, {
          id: randomUUID(),
          outcome: 'NOT_APPLIED',
          evidenceDigest: 'b'.repeat(64),
        }),
      ),
      /KERNEL_OPERATION_BINDING_REJECTED/,
    );

    const endRes = {
      id: randomUUID(),
      outcome: 'ENDED_UNKNOWN' as const,
      evidenceDigest: 'c'.repeat(64),
    };
    const endReceipt = await kernel.withSummary(peer, (port) => port.notify(binding, endRes));
    assert.deepEqual(endReceipt, { binding, resolution: endRes });
  } finally {
    await kernel.close();
    await core.shutdown();
    bridgeStore.close();
  }
});

test('WO49-3: ProfileActorRegistry.observe stops running session and triggers browse self-heal retire when remote operation requires summary END disposition', async () =>
  settlementFixture(async (store) => {
    const f = prepareBound(store, 2, wheel);
    store.tasks.markBoundUnknown(f.binding, 'EXPECTED_UNKNOWN');
    const endingId = store.tasks.requestEnd(f.plan.id);
    store.tasks.prepareEnd(f.plan.id, {
      profileId: f.plan.profileId,
      connectionEpoch: f.binding.connectionEpoch,
      requestId: endingId,
      state: 'stopped',
    });
    // Simulate a running browse plan on the same profile while the previous op still needs END in remote inventory
    const combo = store.createCombination({
      name: 'browse-handoff',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [
        { id: randomUUID(), type: 'video', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
      ],
    });
    // Mark the old plan STOPPED so a new RUNNING plan can exist on the profile
    store.tasks.stopOfflineBrowse(f.plan.id, 'CLEANUP');
    const known = {
      id: f.plan.profileId,
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in' as const, id: f.binding.accountId, name: 'U', avatar: null },
    };
    const [plan2] = store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: combo.id,
        version: combo.version,
        profileIds: [f.plan.profileId],
      },
      [known],
    );
    assert.ok(plan2);
    store.tasks.claimNext([known], new Set(['video']));

    const retiredReasons: string[] = [];
    let stopCalled = 0;
    const registry = new ProfileActorRegistry(
      () => [known],
      store.tasks,
      store.tasks.settlements,
      store.taskControls,
      store.taskTabs,
      randomUUID,
      undefined,
      (_id, reason) => {
        retiredReasons.push(reason);
      },
    );
    const activeContext = {
      profileId: f.binding.profileId,
      accountId: f.binding.accountId,
      connectionEpoch: f.binding.connectionEpoch,
      leaseId: f.binding.leaseId,
      generation: f.binding.generation,
    };
    let currentSession: typeof activeContext | null = activeContext;
    await registry.attach({
      profileId: f.plan.profileId,
      ownedPlanId: () => plan2.id,
      profile: () => known,
      current: () => currentSession,
      inventory: async () => ({
        version: 1,
        profileId: f.plan.profileId,
        browserSessionEpoch: randomUUID(),
        tabs: [],
        operations: [
          {
            binding: f.binding,
            state: 'UNKNOWN',
            reason: 'PENDING_REMOTE_END',
            resolution: null,
          },
        ],
      }),
      notify: async (b, r) => ({ binding: b, resolution: r }),
      sendGuarded: async () => {
        throw Error('UNEXPECTED');
      },
      setFailureHandler: () => {},
      revokeInput: () => {},
      stop: async (stopBinding) => {
        stopCalled++;
        currentSession = null;
        return { ...stopBinding, state: 'stopped' };
      },
    });
    await registry.observe(f.plan.profileId);
    assert.equal(stopCalled, 1);
    assert.equal(registry.hasOwner(f.plan.profileId), false);
    assert.deepEqual(retiredReasons, ['END_DISPOSITION_SUMMARY_REQUIRED']);
  }));

test('WO49-4: deterministic open rejection releases kernel owner without core.stop, and stale priorStopRequestId does not kill new session', async () => {
  const bridgeStore = new BridgeStore(':memory:');
  const core = new Core(bridgeStore);
  const kernel = new KernelBridge(core, new WatchTasks(core));
  const profileId = randomUUID();
  let mode: 'reject-lease' | 'hold-open' = 'reject-lease';
  const peer: Peer = core.connect(
    profileId,
    (msg) => {
      const m = msg as Record<string, unknown>;
      if (m.type === 'KERNEL_REQUEST' && m.kind === 'open' && mode === 'reject-lease') {
        queueMicrotask(() => {
          void kernel.message(peer, {
            type: 'KERNEL_REPLY',
            requestId: String(m.requestId),
            connectionEpoch: String(m.connectionEpoch),
            leaseId: String(m.leaseId),
            error: 'KERNEL_LEASE_REJECTED:stale',
          });
        });
      }
    },
    () => {},
  );
  peer.synced = true;
  peer.phase = 'PAUSED';
  peer.capabilities = ['kernel-journal-v1', 'kernel-unknown-end-v1'];

  try {
    await assert.rejects(
      kernel.withSummary(peer, async () => 'ok'),
      /KERNEL_LEASE_REJECTED:stale/,
    );
    // Deterministic open rejection must not leave peer in STOPPING or retain kernelOwner
    assert.equal(peer.phase, 'PAUSED');

    // Now simulate a prior STOP that finished just before a new session is opened
    const stopReq = await core.stop(profileId);
    assert.ok(stopReq.requestId);
    assert.equal(await core.stopped(peer, stopReq.requestId), true);
    assert.equal(peer.lastStopRequestId, stopReq.requestId);
    assert.equal(peer.lastStoppedRequestId, stopReq.requestId);

    mode = 'hold-open';
    const pendingSummary = kernel.withSummary(peer, async () => 'ok');
    await new Promise((r) => setTimeout(r, 15));
    // Sending a late/stale controlStopped for the prior stopReq.requestId must NOT disconnect the new session
    kernel.controlStopped(peer, stopReq.requestId);
    // Now reply to open and stop so pendingSummary finishes cleanly
    await kernel.close();
    await assert.rejects(pendingSummary, /KERNEL_SERVICE_SHUTDOWN/);
  } finally {
    await kernel.close();
    await core.shutdown();
    bridgeStore.close();
  }
});

test('WO49-6: KernelProfileInspection.readQueuedCurrentActor passes browseAdmission and storyAdmission flags accurately', async () =>
  settlementFixture(async (store) => {
    const profileId = randomUUID();
    const known = {
      id: profileId,
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in' as const, id: '100001', name: 'U', avatar: null },
    };
    const browseCombo = store.createCombination({
      name: 'browse-combo',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [
        { id: randomUUID(), type: 'video', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
      ],
    });
    const [browsePlan] = store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: browseCombo.id,
        version: browseCombo.version,
        profileIds: [profileId],
      },
      [known],
    );
    assert.ok(browsePlan);

    const bridgeStore = new BridgeStore(':memory:');
    const core = new Core(bridgeStore);
    const peer = core.connect(
      profileId,
      () => {},
      () => {},
    );
    peer.synced = true;
    peer.phase = 'PAUSED';
    peer.capabilities = ['facebook-readonly-v2', 'kernel-journal-v1'];

    const tabProof: TabProof = {
      profileId,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 7,
      targetId: 't-7',
    };
    const capturedCalls: Array<{
      retainForTask: boolean;
      existingTab: TabProof | undefined;
      browseAdmission: boolean;
      storyAdmission: boolean;
    }> = [];
    const fakeKernel = {
      withSummary: async (
        _p: Peer,
        work: (port: {
          profileId: string;
          inventory(): Promise<KernelState>;
          notify(): Promise<never>;
        }) => Promise<unknown>,
      ) =>
        work({
          profileId,
          inventory: async () => ({
            version: 1,
            profileId,
            browserSessionEpoch: tabProof.browserSessionEpoch,
            workspaceMain: tabProof,
            tabs: [
              {
                ownershipId: tabProof.ownershipId,
                url: 'https://www.facebook.com/',
                state: 'READY',
                proof: tabProof,
                reason: '',
              },
            ],
            operations: [],
          }),
          notify: async () => {
            throw Error('UNEXPECTED');
          },
        }),
      inspectFacebookIdentity: async (
        _peer: Peer,
        _guard: () => unknown,
        retainForTask = false,
        existingTab?: TabProof,
        browseAdmission = false,
        storyAdmission = false,
      ) => {
        capturedCalls.push({ retainForTask, existingTab, browseAdmission, storyAdmission });
        return {
          actor: { accountId: '100001', name: 'U' },
          transport: 'document-preload' as const,
          connection: { profileId, connectionEpoch: peer.epoch },
          proof: tabProof,
          closedRecord: null,
          stop: { requestId: randomUUID(), state: 'stopped' as const },
          page: {
            url: 'https://www.facebook.com/',
            ready: 'complete' as const,
            timeOrigin: 1,
            rows: [],
          },
        };
      },
    } as unknown as KernelBridge;

    try {
      const inspection = new KernelProfileInspection(
        fakeKernel,
        core,
        store.tasks,
        store.tasks.settlements,
      );
      await inspection.readQueuedCurrentActor(
        browsePlan.id,
        { profileId, connectionEpoch: peer.epoch },
        () => {},
      );
      assert.equal(capturedCalls.length, 1);
      assert.deepEqual(capturedCalls[0], {
        retainForTask: true,
        existingTab: tabProof,
        browseAdmission: true,
        storyAdmission: false,
      });
    } finally {
      await core.shutdown();
      bridgeStore.close();
    }
  }));
