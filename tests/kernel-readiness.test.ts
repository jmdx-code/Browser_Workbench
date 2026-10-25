import { BusinessResolution } from '../src/shared/settlement.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { evaluateKernelReadiness } from '../src/domain/kernel-readiness.js';
import type { KernelState } from '../src/shared/kernel-state.js';
import { settlementFixture, prepareBound, verifyBound } from './fixtures/settlement.js';
function summary(f: ReturnType<typeof prepareBound>): KernelState {
  return {
    version: 1,
    profileId: f.profile.id,
    browserSessionEpoch: randomUUID(),
    tabs: [],
    operations: [
      { binding: f.binding, state: 'ACKNOWLEDGED', reason: 'native-ack', resolution: null },
    ],
  };
}
test('orphan ACK/DISPATCHING/UNKNOWN blocks readiness without importing or clearing remote records', async () => {
  await settlementFixture(async (store) => {
    const f = await prepareBound(store),
      remote = summary(f);
    for (const state of ['ACKNOWLEDGED', 'DISPATCHING', 'UNKNOWN'] as const) {
      remote.operations[0] = { binding: f.binding, state, reason: 'fixture', resolution: null };
      assert.equal(
        evaluateKernelReadiness(f.profile.id, remote, [], []).issues[0]?.reason,
        'ORPHAN_OPERATION',
      );
    }
    assert.equal((await store.tasks.operations(f.plan.id))[0]?.status, 'DISPATCHING');
  });
});
test('remote reconciled does not settle software unknown or release its account', async () => {
  await settlementFixture(async (store) => {
    const f = await prepareBound(store);
    await store.tasks.markBoundUnknown(f.binding, 'UNCONFIRMED');
    const remote = summary(f);
    remote.operations[0] = {
      binding: f.binding,
      state: 'RECONCILED',
      reason: 'remote-only',
      resolution: { id: randomUUID(), outcome: 'VERIFIED', evidenceDigest: 'a'.repeat(64) },
    };
    const verdict = evaluateKernelReadiness(
      f.profile.id,
      remote,
      await store.tasks.operations(f.plan.id),
      [],
    );
    assert.equal(verdict.ready, false);
    assert.ok(verdict.issues.some((row) => row.reason === 'BUSINESS_UNRESOLVED'));
    assert.equal((await store.tasks.get(f.plan.id)).state, 'REVIEW');
  });
});
test('settled local result stays blocked until matched notification delivery and remote resolution both exist', async () => {
  await settlementFixture(async (store) => {
    const f = await prepareBound(store);
    await verifyBound(store, f);
    const remote = summary(f);
    assert.equal(
      evaluateKernelReadiness(
        f.profile.id,
        remote,
        await store.tasks.operations(f.plan.id),
        await store.tasks.settlements.list(),
      ).ready,
      false,
    );
    const notice = await store.tasks.settlements.claim(f.profile.id);
    assert.ok(notice?.claimToken);
    await store.tasks.settlements.delivered(f.binding.operationId, notice.claimToken, {
      binding: notice.binding,
      resolution: BusinessResolution.parse(notice.resolution),
    });
    remote.operations[0] = {
      binding: f.binding,
      state: 'RECONCILED',
      reason: 'settled',
      resolution: BusinessResolution.parse(notice.resolution),
    };
    assert.equal(
      evaluateKernelReadiness(
        f.profile.id,
        remote,
        await store.tasks.operations(f.plan.id),
        await store.tasks.settlements.list(),
      ).ready,
      true,
    );
    assert.equal((await store.tasks.get(f.plan.id)).state, 'RUNNING');
  });
});
test('binding conflict, missing remote, and wrong resolution cannot grant readiness', async () => {
  await settlementFixture(async (store) => {
    const f = await prepareBound(store);
    await verifyBound(store, f);
    const notice = await store.tasks.settlements.claim(f.profile.id);
    assert.ok(notice?.claimToken);
    await store.tasks.settlements.delivered(f.binding.operationId, notice.claimToken, {
      binding: notice.binding,
      resolution: BusinessResolution.parse(notice.resolution),
    });
    const remote = summary(f);
    remote.operations[0] = {
      binding: { ...f.binding, leaseId: randomUUID() },
      state: 'RECONCILED',
      reason: 'foreign-lease',
      resolution: BusinessResolution.parse(notice.resolution),
    };
    assert.ok(
      evaluateKernelReadiness(
        f.profile.id,
        remote,
        await store.tasks.operations(f.plan.id),
        await store.tasks.settlements.list(),
      ).issues.some((row) => row.reason === 'BINDING_CONFLICT'),
    );
    remote.operations[0] = {
      binding: f.binding,
      state: 'RECONCILED',
      reason: 'bad-digest',
      resolution: {
        ...BusinessResolution.parse(notice.resolution),
        evidenceDigest: 'b'.repeat(64),
      },
    };
    assert.equal(
      evaluateKernelReadiness(
        f.profile.id,
        remote,
        await store.tasks.operations(f.plan.id),
        await store.tasks.settlements.list(),
      ).ready,
      false,
    );
    remote.operations = [];
    assert.ok(
      evaluateKernelReadiness(
        f.profile.id,
        remote,
        await store.tasks.operations(f.plan.id),
        await store.tasks.settlements.list(),
      ).issues.some((row) => row.reason === 'REMOTE_MISSING'),
    );
  });
});
test('unfinished tab creation blocks readiness, foreign profile inventory is rejected, settled orphan history never advances local business', async () => {
  await settlementFixture(async (store) => {
    const f = await prepareBound(store),
      remote = summary(f);
    remote.operations = [];
    remote.tabs = [
      {
        ownershipId: randomUUID(),
        url: 'about:blank',
        state: 'UNKNOWN',
        proof: null,
        reason: 'creation-result-unknown',
      },
    ];
    assert.equal(evaluateKernelReadiness(f.profile.id, remote, [], []).ready, false);
    assert.throws(() => evaluateKernelReadiness(randomUUID(), remote, [], []), /PROFILE_MISMATCH/);
    remote.tabs = [];
    remote.operations = [
      {
        binding: f.binding,
        state: 'RECONCILED',
        reason: 'retained-old-summary',
        resolution: { id: randomUUID(), outcome: 'NOT_APPLIED', evidenceDigest: 'a'.repeat(64) },
      },
    ];
    assert.equal(evaluateKernelReadiness(f.profile.id, remote, [], []).ready, true);
    assert.equal((await store.tasks.operations(f.plan.id))[0]?.status, 'DISPATCHING');
  });
});
