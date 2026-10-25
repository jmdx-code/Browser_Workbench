import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import {
  postFixture,
  postRequest,
  dispatchedPost,
  deliverPostNotices,
  postReceipt,
} from './fixtures/material-post.js';
import { prepareBound, settlementFixture, verifyBound } from './fixtures/settlement.js';
import { dropTaskEndingSchema } from './fixtures/workspace-schema.js';
import type { KernelState, TabProof } from '../src/shared/kernel-state.js';
import { FACEBOOK_REEL_NEXT_CSS } from '../src/shared/facebook-browse-route.js';

test('a confirmed stop of a verified pre-submit draft is STOPPED; unknown inputs or missing stop confirmation remain failed', async () => {
  for (const scenario of [
    'verified-draft',
    'unknown-draft',
    'unknown-submit',
    'unconfirmed-stop',
  ] as const) {
    await postFixture(async (store, _file, catalog) => {
      const r = await postRequest(store, catalog);
      await store.materials.reserve(r);
      const original = await dispatchedPost(
        store,
        r,
        scenario === 'unknown-submit' ? 'SUBMIT' : 'OPEN_COMPOSER',
      );
      if (scenario === 'verified-draft' || scenario === 'unconfirmed-stop') {
        await store.tasks.acknowledgeBound({
          binding: original.binding,
          evidence: { inputReturned: true },
        });
        await store.materialPosts.verify(await postReceipt(store, r, original));
        await deliverPostNotices(store, r.context.profileId);
      } else await store.tasks.markBoundUnknown(original.binding, 'GENERATED_INPUT_RESULT_LOST');
      const control = await store.tasks.requestControl(r.jobId, 'stop', 'USER_STOP');
      assert.ok(control.controlRequestId);
      if (scenario !== 'unconfirmed-stop')
        await store.tasks.confirmControl(r.jobId, control.controlRequestId);
      const before = (await store.tasks.operations(r.jobId))[0];
      const requestId = await store.tasks.requestEnd(r.jobId);
      const stop = {
        profileId: r.context.profileId,
        connectionEpoch: r.context.connectionEpoch,
        requestId,
        state: 'stopped' as const,
      };
      await store.tasks.prepareEnd(r.jobId, stop);
      await deliverPostNotices(store, r.context.profileId);
      const result = await store.tasks.finishEnd(r.jobId, stop);
      assert.equal(result.state, scenario === 'verified-draft' ? 'STOPPED' : 'FAILED');
      assert.equal(
        (await store.materials.reservation(r.attemptId)).state,
        scenario === 'unknown-submit' ? 'REVIEW' : 'NOT_PUBLISHED',
      );
      const after = (await store.tasks.operations(r.jobId))[0];
      assert.equal(after?.status, before?.status);
      assert.deepEqual(after?.receipt, before?.receipt);
      assert.equal((await store.tasks.steps(r.jobId))[0]?.progress.published, 0);
      assert.equal((await store.tasks.finishEnd(r.jobId, stop)).state, result.state);
    }, false);
  }
});

test('confirmed user stop ends a cancelled browse wheel without rewriting UNKNOWN or crediting progress', async () => {
  for (const scenario of [
    'cancelled-wheel',
    'cancelled-next',
    'unregistered-next',
    'lost-wheel',
    'unconfirmed-stop',
    'arbitrary-click',
    'interactive-plan',
  ] as const) {
    await settlementFixture(async (store) => {
      const wheel = {
        kind: 'browseScroll' as const,
        tabId: 42,
        documentEpoch: 0,
        routeEpoch: 0,
        url: 'https://www.facebook.com/',
        timeOrigin: 10,
        fromY: 0,
        deltaY: 500,
      };
      let proof: TabProof | undefined;
      let row: ReturnType<typeof store.taskTabs.register> | undefined;
      const f = await prepareBound(
        store,
        scenario === 'interactive-plan' ? 1 : 0,
        scenario === 'arbitrary-click'
          ? undefined
          : scenario === 'cancelled-next' || scenario === 'unregistered-next'
            ? {
                kind: 'click',
                tabId: 42,
                documentEpoch: 0,
                routeEpoch: 0,
                target: { css: FACEBOOK_REEL_NEXT_CSS },
              }
            : wheel,
        async (plan, context) => {
          proof = {
            profileId: context.profileId,
            ownershipId: randomUUID(),
            browserSessionEpoch: randomUUID(),
            tabId: 42,
            targetId: randomUUID(),
          };
          row = await store.taskTabs.register(plan.id, proof, context);
        },
      );
      assert.ok(proof && row);
      if (scenario === 'cancelled-next') {
        await store.browseIntents.prepare(
          f.plan.id,
          f.step.id,
          f.binding.operationId,
          {
            kind: 'click',
            tabId: 42,
            documentEpoch: 0,
            routeEpoch: 0,
            target: { css: FACEBOOK_REEL_NEXT_CSS },
          },
          {
            kind: 'auxiliary',
            purpose: 'advance',
            beforeContentId: 'a'.repeat(64),
            proof,
            documentEpoch: 0,
            routeEpoch: 0,
          },
        );
      }
      const requested = await store.tasks.requestControl(f.plan.id, 'stop', 'USER_STOP');
      assert.ok(requested.controlRequestId);
      await store.tasks.markBoundUnknown(
        f.binding,
        scenario === 'lost-wheel' ? 'RESULT_LOST' : 'USER_STOP',
      );
      if (scenario !== 'unconfirmed-stop')
        await store.tasks.confirmControl(f.plan.id, requested.controlRequestId);
      const original = (await store.tasks.operations(f.plan.id))[0];
      const requestId = await store.tasks.requestEnd(f.plan.id);
      const stop = {
        profileId: f.profile.id,
        connectionEpoch: f.binding.connectionEpoch,
        requestId,
        state: 'stopped' as const,
      };
      await store.tasks.prepareEnd(f.plan.id, stop);
      await assert.rejects(
        async () => await store.tasks.finishEnd(f.plan.id, stop),
        /NOTICE_PENDING/,
      );
      await deliverPostNotices(store, f.profile.id);
      const result = await store.tasks.finishEnd(f.plan.id, stop);
      assert.equal(
        result.state,
        ['cancelled-wheel', 'cancelled-next'].includes(scenario) ? 'STOPPED' : 'FAILED',
      );
      const ended = (await store.tasks.operations(f.plan.id))[0];
      assert.equal(ended?.status, 'UNKNOWN');
      assert.deepEqual(ended?.receipt, original?.receipt);
      assert.deepEqual(ended?.binding, original?.binding);
      assert.equal(ended?.disposition?.outcome, 'ENDED_UNKNOWN');
      assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.effectiveMilliseconds, 0);
      assert.equal(
        (await store.tasks.get(f.plan.id)).controlConfirmed,
        scenario !== 'unconfirmed-stop',
      );
      assert.equal((await store.tasks.pendingEndings()).length, 0);
      assert.equal((await store.tasks.finishEnd(f.plan.id, stop)).state, result.state);
      const released = await store.taskTabs.confirmEndedReleased(
        proof.ownershipId,
        row.revision,
        {
          version: 1,
          profileId: proof.profileId,
          browserSessionEpoch: proof.browserSessionEpoch,
          operations: [],
          workspaceMain: proof,
          tabs: [
            {
              ownershipId: proof.ownershipId,
              proof,
              state: 'READY',
              url: 'https://www.facebook.com/',
              reason: '',
            },
          ],
        },
        f.plan.id,
      );
      assert.equal(released.state, 'RELEASED');
      assert.deepEqual(await store.tasks.retainedTaskPage(f.profile.id), proof);
    });
  }
});

test('ending releases lost child ownership while the exact independent registered main stays READY', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const original = await dispatchedPost(store, r, 'OPEN_COMPOSER');
    await store.tasks.markBoundUnknown(original.binding, 'EDITOR_CLOSED');
    const row = (await store.taskTabs.forPlan(r.jobId))[0];
    assert.ok(row);
    const main = { ...r.proof, ownershipId: randomUUID(), tabId: 43, targetId: randomUUID() };
    const inventory: KernelState = {
      version: 1,
      profileId: r.context.profileId,
      browserSessionEpoch: r.proof.browserSessionEpoch,
      operations: [],
      workspaceMain: main,
      tabs: [
        {
          ownershipId: r.proof.ownershipId,
          proof: r.proof,
          state: 'LOST',
          url: 'https://www.facebook.com/',
          reason: 'TASK_ENDED_OWNERSHIP_WITHDRAWN',
        },
        {
          ownershipId: main.ownershipId,
          proof: main,
          state: 'READY',
          url: 'https://www.facebook.com/',
          reason: '',
        },
      ],
    };
    const requestId = await store.tasks.requestEnd(r.jobId);
    const stop = {
      profileId: r.context.profileId,
      connectionEpoch: r.context.connectionEpoch,
      requestId,
      state: 'stopped' as const,
    };
    await store.tasks.prepareEnd(r.jobId, stop);
    await deliverPostNotices(store, r.context.profileId);
    await store.tasks.finishEnd(r.jobId, stop);
    const before = await store.tasks.operations(r.jobId);
    await assert.rejects(
      async () =>
        await store.taskTabs.confirmEndedLost(
          r.proof.ownershipId,
          row.revision,
          { ...inventory, workspaceMain: undefined },
          r.jobId,
        ),
      /未确认/,
    );
    const activeChild = {
      ...inventory,
      tabs: inventory.tabs.map((tab) => ({ ...tab, state: 'READY' as const })),
    };
    await assert.rejects(
      async () =>
        await store.taskTabs.confirmEndedReleased(
          r.proof.ownershipId,
          row.revision,
          activeChild,
          r.jobId,
        ),
      /不能保留主页面/,
    );
    await assert.rejects(
      async () =>
        await store.taskTabs.confirmEndedLost(
          r.proof.ownershipId,
          row.revision,
          activeChild,
          r.jobId,
        ),
      /未确认/,
    );
    const other = { ...main, ownershipId: randomUUID(), tabId: 44, targetId: randomUUID() };
    await assert.rejects(
      async () =>
        await store.taskTabs.confirmEndedLost(
          r.proof.ownershipId,
          row.revision,
          {
            ...inventory,
            tabs: [
              ...inventory.tabs,
              {
                ownershipId: other.ownershipId,
                proof: other,
                state: 'READY',
                url: 'https://www.facebook.com/',
                reason: '',
              },
            ],
          },
          r.jobId,
        ),
      /未确认/,
    );
    const released = await store.taskTabs.confirmEndedLost(
      r.proof.ownershipId,
      row.revision,
      inventory,
      r.jobId,
    );
    assert.equal(released.state, 'LOST');
    assert.equal(released.context, null);
    assert.deepEqual(await store.tasks.operations(r.jobId), before);
    assert.equal(before[0]?.status, 'UNKNOWN');
    assert.equal(inventory.tabs[1]?.state, 'READY');
  });
});

test('confirmed ending retains an exact native READY main without rewriting unknown or historical control', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const original = await dispatchedPost(store, r, 'OPEN_COMPOSER');
    await store.tasks.markBoundUnknown(original.binding, 'STOP_DURING_INPUT');
    const row = (await store.taskTabs.forPlan(r.jobId))[0];
    assert.ok(row);
    const native = {
      version: 1 as const,
      profileId: r.context.profileId,
      browserSessionEpoch: r.proof.browserSessionEpoch,
      operations: [],
      tabs: [
        {
          ownershipId: r.proof.ownershipId,
          proof: r.proof,
          state: 'READY' as const,
          url: 'https://www.facebook.com/',
          reason: '',
        },
      ],
    };
    await assert.rejects(
      async () =>
        await store.taskTabs.confirmEndedReleased(
          r.proof.ownershipId,
          row.revision,
          native,
          r.jobId,
        ),
      /未确认/,
    );
    const requestId = await store.tasks.requestEnd(r.jobId);
    const stop = {
      profileId: r.context.profileId,
      connectionEpoch: r.context.connectionEpoch,
      requestId,
      state: 'stopped' as const,
    };
    await store.tasks.prepareEnd(r.jobId, stop);
    await deliverPostNotices(store, r.context.profileId);
    await store.tasks.finishEnd(r.jobId, stop);
    const before = await store.tasks.get(r.jobId);
    const operations = await store.tasks.operations(r.jobId);
    const released = await store.taskTabs.confirmEndedReleased(
      r.proof.ownershipId,
      row.revision,
      native,
      r.jobId,
    );
    assert.equal(released.state, 'RELEASED');
    assert.equal(released.context, null);
    assert.deepEqual(await store.tasks.retainedTaskPage(r.context.profileId), r.proof);
    assert.deepEqual(await store.tasks.get(r.jobId), before);
    assert.deepEqual(await store.tasks.operations(r.jobId), operations);
    assert.equal(operations[0]?.status, 'UNKNOWN');
  });
});

test('ended draft without dispatched SUBMIT releases exact resource, retaining original unknown input', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const original = await dispatchedPost(store, r, 'SET_TEXT');
    await store.tasks.markBoundUnknown(original.binding, 'DRAFT_ACK_LOST');
    const endingId = await store.tasks.requestEnd(r.jobId);
    const stop = {
      profileId: r.context.profileId,
      connectionEpoch: r.context.connectionEpoch,
      requestId: endingId,
      state: 'stopped' as const,
    };
    await store.tasks.prepareEnd(r.jobId, stop);
    await assert.rejects(async () => await store.tasks.finishEnd(r.jobId, stop), /NOTICE_PENDING/);
    await deliverPostNotices(store, r.context.profileId);
    const result = await store.tasks.finishEnd(r.jobId, stop);
    assert.equal(result.state, 'FAILED');
    assert.equal(result.controlConfirmed, false);
    assert.equal((await store.tasks.operations(r.jobId))[0]?.status, 'UNKNOWN');
    assert.equal((await store.materials.reservation(r.attemptId)).state, 'NOT_PUBLISHED');
    assert.equal((await store.materialPosts.result(r.attemptId))?.basis, 'CURRENT_STOP_NO_SUBMIT');
    assert.equal((await store.materialPosts.archives()).length, 0);
    const next = await postRequest(store, catalog, { accountId: r.context.accountId });
    assert.equal((await store.materials.reserve(next)).state, 'RESERVED');
    assert.equal((await store.tasks.finishEnd(r.jobId, stop)).id, result.id);
  });
});

test('possibly dispatched SUBMIT holds only exact content; same account can publish other content', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const original = await dispatchedPost(store, r);
    await store.tasks.markBoundUnknown(original.binding, 'SUBMIT_RESULT_LOST');
    const requestId = await store.tasks.requestEnd(r.jobId);
    const stop = {
      profileId: r.context.profileId,
      connectionEpoch: r.context.connectionEpoch,
      requestId,
      state: 'stopped' as const,
    };
    await store.tasks.prepareEnd(r.jobId, stop);
    await deliverPostNotices(store, r.context.profileId);
    const result = await store.tasks.finishEnd(r.jobId, stop);
    assert.equal(result.reason, 'PUBLISH_RESULT_UNCONFIRMED');
    assert.equal((await store.materials.reservation(r.attemptId)).state, 'REVIEW');
    assert.equal(await store.materialPosts.result(r.attemptId), null);
    assert.equal((await store.materialPosts.archives()).length, 0);
    const other = await postRequest(store, catalog, {
      accountId: r.context.accountId,
      source: 'other.txt',
    });
    assert.equal((await store.materials.reserve(other)).state, 'RESERVED');
    await store.materialPosts.cancelUnsent(other.attemptId);
    const plan = await store.tasks.requestControl(other.jobId, 'stop');
    assert.ok(plan.controlRequestId);
    await store.tasks.confirmControl(other.jobId, plan.controlRequestId);
    const duplicate = await postRequest(store, catalog, { accountId: r.context.accountId });
    await assert.rejects(
      async () => await store.materials.reserve(duplicate),
      /MATERIAL_CONTENT_RESERVED/,
    );
  });
});

test('ending notice survives restart; original binding and historical control evidence are not rewritten', async () => {
  await settlementFixture(async (store, file) => {
    const f = await prepareBound(store);
    await store.tasks.markBoundUnknown(f.binding, 'RESULT_LOST');
    const requestId = await store.tasks.requestEnd(f.plan.id);
    const stop = {
      profileId: f.profile.id,
      connectionEpoch: randomUUID(),
      requestId,
      state: 'stopped' as const,
    };
    await store.tasks.prepareEnd(f.plan.id, stop);
    const notice = await store.tasks.settlements.claim(f.profile.id);
    assert.ok(notice?.claimToken);
    const reopened = await WorkspaceStore.open(file);
    try {
      reopened.tasks.settlements.recoverOnStartup();
      const retry = reopened.tasks.settlements.claim(f.profile.id);
      assert.ok(retry?.claimToken);
      assert.deepEqual(retry.resolution, notice.resolution);
      assert.notEqual(retry.claimToken, notice.claimToken);
      assert.throws(
        () =>
          reopened.tasks.settlements.delivered(f.binding.operationId, notice.claimToken!, {
            binding: notice.binding,
            resolution: notice.resolution,
          }),
        /代次已变化/,
      );
      reopened.tasks.settlements.delivered(f.binding.operationId, retry.claimToken, {
        binding: retry.binding,
        resolution: retry.resolution,
      });
      assert.equal(reopened.tasks.finishEnd(f.plan.id, stop).state, 'FAILED');
      assert.deepEqual(reopened.tasks.operations(f.plan.id)[0]?.binding, f.binding);
      assert.equal(reopened.tasks.get(f.plan.id).controlConfirmed, false);
      assert.equal(reopened.tasks.pendingEndings().length, 0);
    } finally {
      reopened.close();
    }
  });
});

test('migration18 preserves original business notice and delivery; original migration SQL stays frozen', async () => {
  await settlementFixture(async (store, file) => {
    const f = await prepareBound(store);
    await verifyBound(store, f);
    const notice = await store.tasks.settlements.claim(f.profile.id);
    assert.ok(notice?.claimToken);
    await store.tasks.settlements.delivered(f.binding.operationId, notice.claimToken, {
      binding: notice.binding,
      resolution: notice.resolution,
    });
    const db = new DatabaseSync(file);
    db.exec(dropTaskEndingSchema + 'PRAGMA user_version=17');
    const oldNotice = db.prepare('SELECT * FROM task_settlement_notices').all();
    const oldDelivery = db.prepare('SELECT * FROM task_settlement_delivery').all();
    db.close();
    const migrated = await WorkspaceStore.open(file);
    try {
      const check = new DatabaseSync(file, { readOnly: true });
      try {
        assert.deepEqual(
          check
            .prepare('SELECT operation_id,profile_id,body,created_at FROM task_settlement_notices')
            .all(),
          oldNotice,
        );
        assert.deepEqual(
          check
            .prepare(
              'SELECT operation_id,state,claim_token,attempts,next_attempt_at,reason,updated_at FROM task_settlement_delivery',
            )
            .all(),
          oldDelivery,
        );
        assert.equal(check.prepare('PRAGMA foreign_key_check').all().length, 0);
      } finally {
        check.close();
      }
      assert.deepEqual(
        migrated.tasks.settlements.list()[0],
        (await store.tasks.settlements.list())[0],
      );
      assert.equal(migrated.tasks.get(f.plan.id).state, 'RUNNING');
    } finally {
      migrated.close();
    }
  });
});
