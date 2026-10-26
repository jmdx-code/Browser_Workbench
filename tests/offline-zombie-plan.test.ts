import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { settlementFixture, prepareBound } from './fixtures/settlement.js';
import { postFixture, postRequest } from './fixtures/material-post.js';
import { browseHarness } from './fixtures/browse.js';
import { ProfileActorRegistry } from '../src/application/profile-actor-registry.js';
import { TaskEndingCoordinator } from '../src/infrastructure/task-ending-coordinator.js';
import type { Core } from '../src/bridge/core.js';
import type { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import { taskBlocksSoftwareUpdate } from '../src/domain/software-update.js';
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

test('offline ownerless stopping plans do not block updates while running or owned plans still do', () => {
  for (const state of ['PAUSING', 'STOPPING'] as const) {
    assert.equal(taskBlocksSoftwareUpdate(state, false, false), false);
    assert.equal(taskBlocksSoftwareUpdate(state, true, false), true);
    assert.equal(taskBlocksSoftwareUpdate(state, false, true), true);
  }
  assert.equal(taskBlocksSoftwareUpdate('RUNNING', false, false), true);
  assert.equal(taskBlocksSoftwareUpdate('STOPPED', true, true), false);
});

test('scheduler does not repeatedly request control for an ownerless review plan', async () =>
  settlementFixture(async (store) => {
    const h = await browseHarness(store),
      plan = await h.claim(),
      step = store.tasks.steps(plan.id)[0]!;
    store.tasks.prepareOperation(plan.id, step.id, randomUUID(), wheel);
    const operation = store.tasks.takeBoundOperation(h.sessions.get(plan.profileId)!);
    assert.ok(operation?.binding);
    store.tasks.markBoundUnknown(operation.binding, 'RESTART');
    h.host.hasOwner = () => false;
    let calls = 0;
    h.host.control = async () => {
      calls++;
      throw Error('UNEXPECTED_CONTROL');
    };
    await h.runner.tick();
    assert.equal(calls, 0);
    assert.equal(store.tasks.get(plan.id).state, 'REVIEW');
  }));

test('restart cancels only inert pending browsing, stops the plan and retains its history and progress', async () =>
  settlementFixture(async (store) => {
    const f = prepareBound(store, 2, wheel);
    store.tasks.markBoundUnknown(f.binding, 'SOFTWARE_RESTART_UNCERTAIN');
    store.tasks.requestControl(f.plan.id, 'pause', 'SOFTWARE_RESTART_UNCERTAIN');
    const before = store.tasks.steps(f.plan.id)[0]!.progress;
    store.tasks.recoverOnStartup();
    const plan = store.tasks.get(f.plan.id);
    assert.equal(plan.state, 'STOPPED');
    assert.equal(plan.controlConfirmed, true);
    assert.equal(store.tasks.operations(plan.id)[0]?.status, 'FAILED');
    assert.equal(store.tasks.unresolved(plan.id), false);
    assert.deepEqual(store.tasks.steps(plan.id)[0]?.progress, before);
    assert.equal(
      store.tasks.settlements.list(plan.profileId)[0]?.resolution.outcome,
      'NOT_APPLIED',
    );
    store.tasks.recoverOnStartup();
    assert.equal(store.tasks.get(plan.id).state, 'STOPPED');
  }));

test('no actor owner must not write PAUSING or STOPPING into a review plan', async () =>
  settlementFixture(async (store) => {
    const f = prepareBound(store);
    store.tasks.markBoundUnknown(f.binding, 'EXPECTED_UNKNOWN');
    const registry = new ProfileActorRegistry(
      () => [],
      store.tasks,
      store.tasks.settlements,
      store.taskControls,
      store.taskTabs,
      randomUUID,
    );
    const before = store.tasks.get(f.plan.id),
      events = store.tasks.events(f.plan.id).length;
    await assert.rejects(registry.control(f.plan.id, 'stop'), /ACTOR_STOP_OWNER_REQUIRED/);
    assert.deepEqual(store.tasks.get(f.plan.id), before);
    assert.equal(store.tasks.events(f.plan.id).length, events);
  }));

test('offline stop needs both a disconnected peer and no owner; unsafe clicks remain unresolved', async () => {
  for (const safe of [true, false])
    await settlementFixture(async (store) => {
      const f = prepareBound(store, 2, safe ? wheel : undefined);
      store.tasks.markBoundUnknown(f.binding, 'EXPECTED_UNKNOWN');
      const peers = new Map(),
        coordinator = new TaskEndingCoordinator(
          {} as KernelBridge,
          { peers } as unknown as Core,
          store,
        );
      assert.equal(await coordinator.stopOffline(f.plan.id, true), null);
      peers.set(f.plan.profileId, { online: true });
      assert.equal(await coordinator.stopOffline(f.plan.id, false), null);
      peers.clear();
      const stopped = await coordinator.stopOffline(f.plan.id, false);
      assert.equal(stopped?.state ?? null, safe ? 'STOPPED' : null);
      if (!safe) {
        assert.equal(store.tasks.get(f.plan.id).state, 'REVIEW');
        await assert.rejects(coordinator.end(f.plan.id));
        assert.equal(store.tasks.get(f.plan.id).state, 'REVIEW');
      }
    });
});

test('registered next-card may end offline but an unregistered lookalike cannot', async () => {
  await settlementFixture(async (store) => {
    const h = await browseHarness(store),
      plan = await h.claim(),
      step = store.tasks.steps(plan.id)[0]!,
      proof = h.proofs.get(plan.profileId)!;
    const action = {
      kind: 'click' as const,
      tabId: proof.tabId,
      documentEpoch: 0,
      routeEpoch: 0,
      target: { css: '[data-wb-reel-next="1"]' },
    };
    await store.browseIntents.prepare(plan.id, step.id, randomUUID(), action, {
      kind: 'auxiliary',
      purpose: 'advance',
      beforeContentId: 'a'.repeat(64),
      proof,
      documentEpoch: 0,
      routeEpoch: 0,
    });
    const op = store.tasks.takeBoundOperation(h.sessions.get(plan.profileId)!);
    assert.ok(op?.binding);
    store.tasks.markBoundUnknown(op.binding, 'RESTART');
    store.tasks.recoverOnStartup();
    assert.equal(store.tasks.get(plan.id).state, 'STOPPED');
  });
  await settlementFixture(async (store) => {
    const f = prepareBound(store, 2, {
      kind: 'click',
      tabId: 42,
      documentEpoch: 0,
      routeEpoch: 0,
      target: { css: '[data-wb-reel-next="1"]' },
    });
    store.tasks.markBoundUnknown(f.binding, 'RESTART');
    store.tasks.recoverOnStartup();
    assert.equal(store.tasks.get(f.plan.id).state, 'REVIEW');
  });
});

test('reserved post materials prevent offline auto cancellation', async () =>
  postFixture(async (store, _file, catalog) => {
    const request = await postRequest(store, catalog);
    await store.materials.reserve(request);
    assert.equal(store.tasks.stopOfflineBrowse(request.jobId), null);
    store.tasks.recoverOnStartup();
    assert.notEqual(store.tasks.get(request.jobId).state, 'STOPPED');
  }));
