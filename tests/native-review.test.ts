import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NativeReviewService } from '../src/application/native-review.js';
import type { KernelState } from '../src/shared/kernel-state.js';
import { postFixture, postRequest, dispatchedPost } from './fixtures/material-post.js';

test('native review matches the entire original binding and reads retained UNKNOWN without settlement or release', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const op = await dispatchedPost(store, r, 'OPEN_COMPOSER');
    await store.tasks.markBoundUnknown(op.binding, 'test unknown');
    const stopping = await store.tasks.requestControl(r.jobId, 'stop');
    assert.ok(stopping.controlRequestId);
    await store.tasks.confirmControl(r.jobId, stopping.controlRequestId);
    const snapshot = async () => ({
      plan: await store.tasks.get(r.jobId),
      ops: await store.tasks.operations(r.jobId),
      held: await store.materials.reservation(r.attemptId),
      result: await store.materialPosts.result(r.attemptId),
      notices: await store.tasks.settlements.list(),
    });
    const before = await snapshot();
    const inventory: KernelState = {
      version: 1,
      profileId: r.context.profileId,
      browserSessionEpoch: r.proof.browserSessionEpoch,
      tabs: [
        {
          ownershipId: r.proof.ownershipId,
          url: 'https://www.facebook.com/',
          state: 'CLOSED',
          proof: r.proof,
          reason: 'test closed',
        },
      ],
      operations: [
        { binding: op.binding, state: 'ACKNOWLEDGED', resolution: null, reason: 'test ACK' },
      ],
    };
    let reads = 0;
    const service = new NativeReviewService(
      {
        read: async () => {
          reads++;
          return structuredClone(inventory);
        },
      },
      store.tasks,
    );
    const first = service.read({ profileId: r.context.profileId }),
      second = service.read({ profileId: r.context.profileId });
    assert.equal(first, second);
    const diagnostic = service.read({ profileId: r.context.profileId }, '2');
    assert.equal(diagnostic, service.read({ profileId: r.context.profileId }, '2'));
    const report = await first;
    assert.equal('version' in report, false);
    assert.equal('browserSessionEpoch' in report, false);
    assert.equal((await diagnostic).version, 2);
    assert.equal((await diagnostic).browserSessionEpoch, r.proof.browserSessionEpoch);
    assert.equal(reads, 1);
    assert.equal(report.unresolvedCount, 1);
    assert.equal(report.unclosedTabCount, 0);
    assert.equal(report.operations[0]?.local?.planId, r.jobId);
    assert.equal(report.operations[0]?.local?.operationState, 'UNKNOWN');
    assert.equal(report.operations[0]?.local?.controlConfirmed, true);
    assert.deepEqual(await snapshot(), before);
    assert.equal('binding' in report.operations[0]!, false);
    assert.equal('proof' in report.operations[0]!, false);
    inventory.operations[0]!.binding = { ...op.binding, leaseId: randomUUID() };
    const foreign = await service.read({ profileId: r.context.profileId });
    assert.equal(foreign.operations[0]?.id, op.binding.operationId);
    assert.equal(foreign.operations[0]?.local, null);
    assert.deepEqual(await snapshot(), before);
  });
});

test('native review rejects an active task before contacting transport and rejects a mismatched response', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog);
    let reads = 0;
    const service = new NativeReviewService(
      {
        read: async () => {
          reads++;
          return {
            version: 1,
            profileId: randomUUID(),
            browserSessionEpoch: randomUUID(),
            tabs: [],
            operations: [],
          };
        },
      },
      store.tasks,
    );
    await assert.rejects(service.read({ profileId: r.context.profileId }), /先暂停/);
    assert.equal(reads, 0);
    const stopping = await store.tasks.requestControl(r.jobId, 'stop');
    assert.ok(stopping.controlRequestId);
    await store.tasks.confirmControl(r.jobId, stopping.controlRequestId);
    await assert.rejects(service.read({ profileId: r.context.profileId }), /PROFILE_MISMATCH/);
    assert.equal(reads, 1);
    assert.equal((await store.tasks.get(r.jobId)).state, 'STOPPED');
  });
});

test('Phase A: releaseIdle enforces NATIVE_ORIGINAL_TASK_REQUIRED via hasPlanOrOperation and blocks active profile plans', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const op = await dispatchedPost(store, r, 'OPEN_COMPOSER');
    await store.tasks.markBoundUnknown(op.binding, 'test unknown');
    let candidateBinding = op.binding;
    const service = new NativeReviewService(
      {
        read: async () => ({
          version: 1,
          profileId: r.context.profileId,
          browserSessionEpoch: r.proof.browserSessionEpoch,
          tabs: [],
          operations: [],
        }),
        releaseIdle: async (_profileId, assertIdle, assertHistorical) => {
          await assertIdle();
          await assertHistorical?.(candidateBinding);
          return { released: 1, endedOperations: 1 };
        },
      },
      store.tasks,
    );

    // 1. Active plan blocks releaseIdle with NATIVE_REVIEW_BUSY
    await assert.rejects(
      () => service.releaseIdle({ profileId: r.context.profileId }),
      /请先停止这份浏览器的任务/,
    );

    // 2. End the plan so profile has no non-terminal plan
    const stop = await store.tasks.requestControl(r.jobId, 'stop');
    assert.ok(stop.controlRequestId);
    await store.tasks.confirmControl(r.jobId, stop.controlRequestId);
    const endingId = await store.tasks.requestEnd(r.jobId);
    const stopReceipt = {
      profileId: r.context.profileId,
      connectionEpoch: r.context.connectionEpoch,
      requestId: endingId,
      state: 'stopped' as const,
    };
    await store.tasks.prepareEnd(r.jobId, stopReceipt);
    for (const _notice of await store.tasks.settlements.list(r.context.profileId)) {
      const claimed = await store.tasks.settlements.claim(r.context.profileId);
      if (claimed?.claimToken) {
        await store.tasks.settlements.delivered(claimed.binding.operationId, claimed.claimToken, {
          binding: claimed.binding,
          resolution: claimed.resolution,
        });
      }
    }
    await store.tasks.finishEnd(r.jobId, stopReceipt);
    assert.equal((await store.tasks.get(r.jobId)).state, 'FAILED');

    // 3. Existing jobId OR existing operationId is blocked with NATIVE_ORIGINAL_TASK_REQUIRED
    candidateBinding = { ...op.binding, operationId: randomUUID() };
    await assert.rejects(
      () => service.releaseIdle({ profileId: r.context.profileId }),
      /请从原任务记录结束/,
    );
    candidateBinding = { ...op.binding, jobId: randomUUID() };
    await assert.rejects(
      () => service.releaseIdle({ profileId: r.context.profileId }),
      /请从原任务记录结束/,
    );

    // 4. Orphan binding with no local plan or operation succeeds
    candidateBinding = { ...op.binding, jobId: randomUUID(), operationId: randomUUID() };
    const res = await service.releaseIdle({ profileId: r.context.profileId });
    assert.deepEqual(res, { released: 1, endedOperations: 1 });
  });
});
