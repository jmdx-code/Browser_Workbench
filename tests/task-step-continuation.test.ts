import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  postFixture,
  postRequest,
  dispatchedPost,
  postReceipt,
  deliverPostNotices,
} from './fixtures/material-post.js';
import type { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import type { ReservationRequest } from '../src/shared/material-index.js';
import type { RuntimeProfile } from '../src/domain/tasks.js';

const following = () => [
  { id: randomUUID(), type: 'feed' as const, durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
];
async function fail(
  store: WorkspaceStore,
  r: ReservationRequest,
  purpose: 'SUBMIT' | 'SET_TEXT' = 'SUBMIT',
) {
  await store.materials.reserve(r);
  const original = await dispatchedPost(store, r, purpose),
    reason = 'POST_EFFECT_TIMEOUT:' + purpose;
  await store.tasks.noteStepFailure(r.jobId, r.stepId, reason);
  await store.tasks.markBoundUnknown(original.binding, reason);
  const control = await store.tasks.requestControl(r.jobId, 'pause', reason);
  assert.ok(control.controlRequestId);
  await store.tasks.confirmControl(r.jobId, control.controlRequestId);
  const endingId = await store.tasks.requestStepEnd(r.jobId, r.stepId, reason);
  const stop = {
    profileId: r.context.profileId,
    connectionEpoch: randomUUID(),
    requestId: endingId,
    state: 'stopped' as const,
  };
  return { original, stop };
}
async function close(store: WorkspaceStore, r: ReservationRequest) {
  const row = await store.taskTabs.get(r.proof.ownershipId);
  await store.taskTabs.confirmClosed(r.proof.ownershipId, row.revision, {
    version: 1,
    profileId: r.context.profileId,
    browserSessionEpoch: r.proof.browserSessionEpoch,
    operations: [],
    tabs: [
      {
        ownershipId: r.proof.ownershipId,
        url: 'https://www.facebook.com/',
        state: 'CLOSED',
        proof: r.proof,
        reason: 'GENERATED_CLOSE_PROOF',
      },
    ],
  });
}
function inventory(r: ReservationRequest): RuntimeProfile {
  return {
    id: r.context.profileId,
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: true,
    account: { state: 'logged-in', id: r.context.accountId, name: null, avatar: null },
  };
}

test('failed submission continues same plan only after stop, original notice and exact page closure', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog, { followingSteps: following() }),
      f = await fail(store, r);
    await assert.rejects(
      async () => await store.tasks.prepareEnd(r.jobId, { ...f.stop, requestId: randomUUID() }),
      /STOP_BINDING/,
    );
    await store.tasks.prepareEnd(r.jobId, f.stop);
    await assert.rejects(
      async () => await store.tasks.finishEnd(r.jobId, f.stop),
      /NOTICE_PENDING/,
    );
    await deliverPostNotices(store, r.context.profileId);
    assert.equal((await store.tasks.finishEnd(r.jobId, f.stop)).state, 'STOPPING');
    const failed = (await store.tasks.steps(r.jobId))[0];
    assert.equal(failed?.status, 'FAILED');
    assert.equal(failed?.outcome?.kind === 'FAILED' && failed.outcome.businessResult, 'UNKNOWN');
    assert.equal((await store.tasks.operations(r.jobId))[0]?.status, 'UNKNOWN');
    assert.equal((await store.materials.reservation(r.attemptId)).state, 'REVIEW');
    assert.equal((await store.tasks.blockingOperations(r.jobId)).length, 0);
    await assert.rejects(
      async () => await store.tasks.finishStepContinuation(r.jobId),
      /TAB_OWNERSHIP_PENDING/,
    );
    await close(store, r);
    const next = await store.tasks.finishStepContinuation(r.jobId);
    assert.equal(next.id, r.jobId);
    assert.equal(next.state, 'QUEUED');
    assert.equal(next.position, 1);
    const claimed = await store.tasks.claimNext([inventory(r)], new Set(['post', 'feed']));
    assert.equal(claimed?.id, r.jobId);
    const step = (await store.tasks.steps(r.jobId))[1];
    assert.ok(step);
    await store.tasks.checkpoint(r.jobId, step.id, 0, {
      ...step.progress,
      revision: 1,
      effectiveMilliseconds: 60000,
    });
    const final = await store.tasks.completeStep(r.jobId, step.id);
    assert.equal(final.state, 'FAILED');
    assert.equal(final.reason, 'PARTIAL_STEP_FAILURE');
    assert.equal((await store.tasks.operations(r.jobId))[0]?.id, f.original.binding.operationId);
    assert.equal((await store.tasks.operations(r.jobId))[0]?.status, 'UNKNOWN');
    assert.equal((await store.materialPosts.archives()).length, 0);
  }, false);
});

test('late independent submission verdict settles original usage without rewriting ended UNKNOWN, failed step or continuation', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog, { followingSteps: following() }),
      f = await fail(store, r);
    await store.tasks.prepareEnd(r.jobId, f.stop);
    await deliverPostNotices(store, r.context.profileId);
    await store.tasks.finishEnd(r.jobId, f.stop);
    await close(store, r);
    await store.tasks.finishStepContinuation(r.jobId);
    const before = {
      plan: await store.tasks.get(r.jobId),
      steps: await store.tasks.steps(r.jobId),
      operations: await store.tasks.operations(r.jobId),
    };
    const receipt = await postReceipt(store, r, f.original);
    await assert.rejects(
      async () => await store.materialPosts.verify(receipt),
      /RECONCILIATION_REQUIRED/,
    );
    await store.materialPosts.reconcile(receipt);
    assert.deepEqual(
      {
        plan: await store.tasks.get(r.jobId),
        steps: await store.tasks.steps(r.jobId),
        operations: await store.tasks.operations(r.jobId),
      },
      before,
    );
    assert.equal((await store.materials.reservation(r.attemptId)).state, 'PUBLISHED');
    assert.equal((await store.materialPosts.result(r.attemptId))?.outcome, 'PUBLISHED');
    assert.equal((await store.materialPosts.archives()).length, 0);
    await store.materialPosts.reconcile(receipt);
    await assert.rejects(
      async () =>
        await store.materialPosts.reconcile({
          ...receipt,
          evidence: {
            ...receipt.evidence,
            observationId: randomUUID(),
          },
        }),
      /VERDICT_CONFLICT/,
    );
    await assert.rejects(async () => await store.tasks.reconcileBound(receipt, 'VERIFIED'), {
      code: 'ENDED_OPERATION_REVIEW_REQUIRED',
    });
  }, false);
});

test('new page and operation can be prepared after ended unknown, old operation cannot replay or reconcile late', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog, { followingSteps: following() }),
      f = await fail(store, r, 'SET_TEXT');
    await store.tasks.prepareEnd(r.jobId, f.stop);
    await deliverPostNotices(store, r.context.profileId);
    await store.tasks.finishEnd(r.jobId, f.stop);
    await close(store, r);
    await store.tasks.finishStepContinuation(r.jobId);
    await store.tasks.claimNext([inventory(r)], new Set(['post', 'feed']));
    assert.equal((await store.materials.reservation(r.attemptId)).state, 'NOT_PUBLISHED');
    const proof = { ...r.proof, ownershipId: randomUUID(), tabId: 43, targetId: randomUUID() },
      context = { ...r.context, leaseId: randomUUID(), connectionEpoch: randomUUID() };
    await store.taskTabs.register(r.jobId, proof, context);
    const step = (await store.tasks.steps(r.jobId))[1];
    assert.ok(step);
    const op = await store.tasks.prepareOperation(r.jobId, step.id, randomUUID(), {
      kind: 'click',
      tabId: 43,
      documentEpoch: 0,
      routeEpoch: 0,
      target: { css: '#generated-next' },
    });
    assert.equal(op.status, 'PREPARED');
    assert.equal((await store.tasks.blockingOperations(r.jobId)).length, 1);
    assert.equal((await store.tasks.operations(r.jobId)).length, 2);
    await assert.rejects(
      async () =>
        await store.tasks.reconcileBound({ binding: f.original.binding, evidence: {} }, 'VERIFIED'),
      { code: 'ENDED_OPERATION_REVIEW_REQUIRED' },
    );
  }, false);
});

test('manual stop cancels pending step continuation and preserves original unknown', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog, { followingSteps: following() }),
      f = await fail(store, r);
    await store.tasks.cancelStepContinuation(r.jobId);
    await store.tasks.prepareEnd(r.jobId, f.stop);
    await deliverPostNotices(store, r.context.profileId);
    assert.equal((await store.tasks.finishEnd(r.jobId, f.stop)).state, 'FAILED');
    assert.equal((await store.tasks.steps(r.jobId))[1]?.status, 'PENDING');
    await assert.rejects(
      async () => await store.tasks.finishStepContinuation(r.jobId),
      /NOT_CONFIRMED/,
    );
    assert.equal((await store.tasks.operations(r.jobId))[0]?.status, 'UNKNOWN');
  }, false);
});

test('restart cancels automatic successor even after original step ending finished', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog, { followingSteps: following() }),
      f = await fail(store, r);
    await store.tasks.prepareEnd(r.jobId, f.stop);
    await deliverPostNotices(store, r.context.profileId);
    await store.tasks.finishEnd(r.jobId, f.stop);
    await store.tasks.recoverOnStartup();
    assert.equal(await store.tasks.stepEnding(r.jobId), null);
    assert.equal((await store.tasks.get(r.jobId)).state, 'REVIEW');
    await assert.rejects(
      async () => await store.tasks.finishStepContinuation(r.jobId),
      /NOT_CONFIRMED/,
    );
    assert.equal((await store.tasks.steps(r.jobId))[0]?.status, 'FAILED');
    assert.equal((await store.tasks.steps(r.jobId))[1]?.status, 'PENDING');
  }, false);
});

test('empty resource step skips only after current stop and page closure, then continues the original successor', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog, { followingSteps: following() }),
      reason = 'MATERIAL_NO_ELIGIBLE_RESOURCE';
    await store.tasks.noteStepFailure(r.jobId, r.stepId, reason);
    const control = await store.tasks.requestControl(r.jobId, 'pause', reason);
    assert.ok(control.controlRequestId);
    await store.tasks.confirmControl(r.jobId, control.controlRequestId);
    const endingId = await store.tasks.requestStepEnd(r.jobId, r.stepId, reason);
    const stop = {
      profileId: r.context.profileId,
      connectionEpoch: randomUUID(),
      requestId: endingId,
      state: 'stopped' as const,
    };
    await store.tasks.prepareEnd(r.jobId, stop);
    assert.equal((await store.tasks.finishEnd(r.jobId, stop)).state, 'STOPPING');
    const step = (await store.tasks.steps(r.jobId))[0];
    assert.equal(step?.status, 'SKIPPED');
    assert.equal(step?.outcome?.kind === 'SKIPPED' && step.outcome.reason, 'RESOURCE_EXHAUSTED');
    assert.equal((await store.tasks.operations(r.jobId)).length, 0);
    await assert.rejects(
      async () => await store.tasks.finishStepContinuation(r.jobId),
      /TAB_OWNERSHIP_PENDING/,
    );
    await close(store, r);
    const next = await store.tasks.finishStepContinuation(r.jobId);
    assert.equal(next.state, 'QUEUED');
    assert.equal(next.position, 1);
    assert.equal(next.id, r.jobId);
  }, false);
});

test('resource exhaustion after partial confirmed progress fails the unfinished step and preserves its count', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog, { count: 3, followingSteps: following() });
    const step = (await store.tasks.steps(r.jobId))[0];
    assert.ok(step);
    // Generated receipt exercises the original transaction, not an external publication.
    await store.materials.reserve(r);
    const operation = await dispatchedPost(store, r);
    await store.tasks.acknowledgeBound({
      binding: operation.binding,
      evidence: { inputReturned: true },
    });
    await store.materialPosts.verify(await postReceipt(store, r, operation));
    await deliverPostNotices(store, r.context.profileId);
    const reason = 'MATERIAL_NO_ELIGIBLE_RESOURCE';
    await store.tasks.noteStepFailure(r.jobId, r.stepId, reason);
    const control = await store.tasks.requestControl(r.jobId, 'pause', reason);
    assert.ok(control.controlRequestId);
    await store.tasks.confirmControl(r.jobId, control.controlRequestId);
    const endingId = await store.tasks.requestStepEnd(r.jobId, r.stepId, reason);
    const stop = {
      profileId: r.context.profileId,
      connectionEpoch: randomUUID(),
      requestId: endingId,
      state: 'stopped' as const,
    };
    await store.tasks.prepareEnd(r.jobId, stop);
    await store.tasks.finishEnd(r.jobId, stop);
    const ended = (await store.tasks.steps(r.jobId))[0];
    assert.equal(ended?.status, 'FAILED');
    assert.equal(ended?.progress.published, 1);
    assert.equal(ended?.outcome?.reason, 'RESOURCE_EXHAUSTED');
    await close(store, r);
    const next = await store.tasks.finishStepContinuation(r.jobId);
    assert.equal(next.state, 'QUEUED');
    assert.equal(next.position, 1);
    assert.equal((await store.tasks.operations(r.jobId)).length, 1);
  }, false);
});

test('manual cancellation after step settlement but before page closure cannot admit its successor', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog, { followingSteps: following() }),
      f = await fail(store, r);
    await store.tasks.prepareEnd(r.jobId, f.stop);
    await deliverPostNotices(store, r.context.profileId);
    await store.tasks.finishEnd(r.jobId, f.stop);
    const outcome = (await store.tasks.steps(r.jobId))[0]?.outcome;
    await store.tasks.cancelStepContinuation(r.jobId);
    await assert.rejects(async () => await close(store, r), {
      code: 'TASK_TAB_UNSETTLED_OPERATION',
    });
    await assert.rejects(
      async () => await store.tasks.finishStepContinuation(r.jobId),
      /NOT_CONFIRMED/,
    );
    await store.tasks.prepareEnd(r.jobId, f.stop);
    await deliverPostNotices(store, r.context.profileId);
    assert.equal((await store.tasks.finishEnd(r.jobId, f.stop)).state, 'FAILED');
    await close(store, r);
    assert.deepEqual((await store.tasks.steps(r.jobId))[0]?.outcome, outcome);
    assert.equal((await store.tasks.steps(r.jobId))[1]?.status, 'PENDING');
    assert.equal((await store.tasks.operations(r.jobId))[0]?.status, 'UNKNOWN');
  }, false);
});

test('database cannot administratively end raw UNKNOWN without original step-stop and notice proof', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog, { followingSteps: following() }),
      f = await fail(store, r);
    const db = new DatabaseSync(file);
    try {
      assert.throws(
        () =>
          db
            .prepare('UPDATE task_outbox SET control_ended=1 WHERE id=?')
            .run(f.original.binding.operationId),
        /STEP_END_STOP_AND_NOTICE_REQUIRED/,
      );
      assert.throws(
        () =>
          db
            .prepare('UPDATE material_reservations SET control_ended=1 WHERE attempt_id=?')
            .run(r.attemptId),
        /MATERIAL_END_STEP_STOP_REQUIRED/,
      );
    } finally {
      db.close();
    }
  }, false);
});
