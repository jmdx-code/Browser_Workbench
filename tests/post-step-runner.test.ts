import { filterAsync, findAsync } from '../src/shared/async-collections.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ResourceMaterialPreparation } from '../src/application/resource-material-preparation.js';
import { FilesystemResourceMaterialVerifier } from '../src/infrastructure/resource-material-verifier.js';
import type { ResourceRowValue } from '../src/shared/resource-table.js';
import type { ResourceCatalog } from '../src/shared/resource-materials.js';
import { TaskStepRunner } from '../src/application/task-step-runner.js';
import type { PostStepExecutor } from '../src/domain/post-execution.js';
import type { Catalog } from '../src/shared/material-index.js';
import type { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { postFixture, postAction, postReceipt } from './fixtures/material-post.js';
import { browseHarness } from './fixtures/browse.js';

// Real original runner, actor, SQLite/outbox, reservations and settlements. Browser/identity/
// effects are simulated. No production workspace, real browser input or FB publication.
async function fixture(
  store: WorkspaceStore,
  catalog: Catalog,
  table?: { rows: ResourceRowValue[]; file: string },
) {
  let materialCatalog: Catalog | ResourceCatalog = catalog;
  const h = await browseHarness(
    store,
    1,
    {
      name: '发布与浏览同一循环隔离检查',
      note: '仅模拟效果',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [
        {
          id: randomUUID(),
          type: 'post',
          resourceDirectory: catalog.directory,
          ...(table ? { resourceMode: 'table' as const, resourceDirectory: '' } : {}),
          count: 2,
          allowRepeat: false,
          forbidSameAccountRepeat: true,
          archivePublished: true,
        },
        { id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
      ],
    },
    table?.rows,
  );
  const executor: PostStepExecutor = {
    available: () => true,
    decide: async (execution, held, guard) => {
      await guard();
      const current = held.find((row) => row.state === 'RESERVED');
      if (!current) {
        const source = table
          ? materialCatalog.sources[execution.step.progress.published]
          : materialCatalog.sources.find(
              (row) =>
                row.snapshot.source ===
                (execution.step.progress.published === 0 ? 'text.txt' : 'other.txt'),
            );
        const proof = h.proofs.get(execution.plan.profileId);
        assert.ok(source && proof);
        return {
          kind: 'reserve',
          request: {
            attemptId: randomUUID(),
            jobId: execution.plan.id,
            stepId: execution.step.id,
            expectedProgressRevision: execution.step.progress.revision,
            catalogId: materialCatalog.id,
            sourceId: source.id,
            context: execution.session,
            proof,
          },
        };
      }
      const phases = ['OPEN_COMPOSER', 'SET_TEXT', 'ADVANCE_COMPOSER', 'SUBMIT'] as const;
      const done = await filterAsync(
        await store.tasks.operations(execution.plan.id),
        async (op) =>
          op.stepId === execution.step.id &&
          (await store.materialPosts.link(op.id)).attemptId === current.intent.attemptId,
      );
      const purpose = phases[done.length];
      assert.ok(purpose);
      return { kind: 'action', operation: await postAction(store, current.intent, purpose) };
    },
    verify: async (_execution, operation, original, guard) => {
      await guard();
      return {
        kind: 'verified',
        receipt: await postReceipt(store, original.intent, {
          binding: operation.binding,
          prepared: original.link,
        }),
      };
    },
  };
  const runner = new TaskStepRunner(
    store.tasks,
    store.browseIntents,
    store.taskTabs,
    h.host,
    h.executors,
    h.clock,
    randomUUID,
    {
      materials: store.materials,
      posts: store.materialPosts,
      executor,
      resourceTablesAvailable: () => !!table,
    },
  );
  const plan = await store.tasks.claimNext(
    await h.host.schedulingProfiles(),
    new Set(['post', 'feed']),
    {
      resourceTables: !!table,
    },
  );
  assert.ok(plan);
  if (table) {
    materialCatalog = (
      await new ResourceMaterialPreparation(
        store.tasks.resources,
        new FilesystemResourceMaterialVerifier(),
        store.materials,
      ).prepare(plan.id, randomUUID(), () => {})
    ).catalog;
  }
  assert.ok(plan);
  return { h, executor, runner, plan };
}

test('publication wait reasons clear when original decisions and effect verification resume', async () => {
  await postFixture(async (store, _file, catalog) => {
    const f = await fixture(store, catalog);
    const decide = f.executor.decide.bind(f.executor);
    f.executor.decide = async () => ({ kind: 'wait', reason: 'POST_HOME_PREPARATION_BLOCKED' });
    assert.equal((await f.runner.advance(f.plan.id)).status, 'WAITING');
    assert.equal((await store.tasks.get(f.plan.id)).reason, 'POST_HOME_PREPARATION_BLOCKED');
    f.executor.decide = decide;
    assert.equal((await f.runner.advance(f.plan.id)).status, 'MATERIAL_RESERVED');
    assert.equal((await store.tasks.get(f.plan.id)).reason, '');
    await f.runner.advance(f.plan.id);
    const verify = f.executor.verify.bind(f.executor);
    f.executor.verify = async () => ({ kind: 'wait', reason: 'POST_EFFECT_PENDING' });
    assert.equal((await f.runner.advance(f.plan.id)).status, 'WAITING');
    assert.equal((await store.tasks.get(f.plan.id)).reason, 'POST_EFFECT_PENDING');
    f.executor.verify = verify;
    assert.equal((await f.runner.advance(f.plan.id)).status, 'VERIFIED');
    assert.equal((await store.tasks.get(f.plan.id)).reason, '');
  }, false);
});

test('one original cycle reserves, dispatches, independently settles two posts and advances to the saved next step', async () => {
  await postFixture(async (store, _file, catalog) => {
    const { h, runner, plan } = await fixture(store, catalog);
    for (let tick = 0; tick < 80 && (await store.tasks.get(plan.id)).position === 0; tick++) {
      const before = (await store.tasks.steps(plan.id))[0]?.progress.published;
      const result = await runner.advance(plan.id);
      const after = (await store.tasks.steps(plan.id))[0]?.progress.published;
      if (result.status === 'DISPATCHED') assert.equal(after, before); // ACK never increments business.
      assert.ok(
        !['PAUSED_OR_REVIEW', 'CONTROL_UNCONFIRMED', 'BUSINESS_UNKNOWN'].includes(result.status),
        JSON.stringify(result),
      );
    }
    assert.equal((await store.tasks.get(plan.id)).position, 1);
    assert.equal((await store.tasks.steps(plan.id))[0]?.progress.published, 2);
    assert.equal((await store.materialPosts.archives()).length, 2);
    assert.equal((await store.materials.forPlan(plan.id)).length, 2);
    assert.equal((await store.tasks.operations(plan.id)).length, 8);
    assert.ok((await store.tasks.operations(plan.id)).every((op) => op.status === 'VERIFIED'));
    for (let tick = 0; tick < 63 && (await store.tasks.get(plan.id)).state === 'RUNNING'; tick++) {
      h.clock.at += 1000;
      await runner.advance(plan.id);
    }
    assert.equal((await store.tasks.get(plan.id)).state, 'COMPLETED');
    assert.equal((await h.registry.status()).length, 0);
  });
});

test('an explicitly capable original loop claims the saved resource revision after table editing and settles old content without SQL promotion', async () => {
  await postFixture(async (store, file, catalog) => {
    const rows: ResourceRowValue[] = ['原文案第一行', '原文案第二行'].map((text) => ({
      id: randomUUID(),
      text,
      media: [],
      background: 'plain',
    }));
    const f = await fixture(store, catalog, { rows, file });
    await store.resourceTables.save(
      f.h.saved.id,
      1,
      rows.map((row) => ({ ...row, text: '编辑后的新文案 ' + row.text })),
    );
    for (let tick = 0; tick < 40 && (await store.tasks.get(f.plan.id)).position === 0; tick++) {
      const result = await f.runner.advance(f.plan.id);
      assert.ok(
        !['PAUSED_OR_REVIEW', 'CONTROL_UNCONFIRMED'].includes(result.status),
        JSON.stringify(result),
      );
    }
    assert.equal((await store.tasks.get(f.plan.id)).position, 1);
    const held = await store.materials.forPlan(f.plan.id);
    assert.deepEqual(
      held.map((row) => row.intent.snapshot.text).sort(),
      rows.map((row) => row.text).sort(),
    );
    assert.ok(
      held.every(
        (row) =>
          row.state === 'PUBLISHED' &&
          row.intent.directory === null &&
          'resource' in row.intent &&
          row.intent.resource.revision === 1,
      ),
    );
    assert.ok(
      (await store.materialPosts.archives()).every((item) => item.archiveDirectory === null),
    );
    const summary = (await store.resourceTables.usageSummaries()).find(
      (row) => row.combinationId === f.h.saved.id,
    );
    assert.equal(summary?.published, 0); // New edited definitions cannot inherit the old publications.
    assert.equal((await store.tasks.resources.binding(f.plan.id))?.resourceRevision, 1);
  });
});

test('unknown publication is retained under the same original binding and is never ordinary-verified or replayed', async () => {
  await postFixture(async (store, _file, catalog) => {
    const f = await fixture(store, catalog);
    let submitChecks = 0;
    const original = f.executor.verify;
    f.executor.verify = async (execution, operation, target, guard) => {
      if (target.link.purpose === 'SUBMIT') {
        submitChecks++;
        return { kind: 'unknown', reason: 'fixture result unavailable' };
      }
      return original(execution, operation, target, guard);
    };
    for (let tick = 0; tick < 30 && (await store.tasks.get(f.plan.id)).state === 'RUNNING'; tick++)
      await f.runner.advance(f.plan.id);
    assert.equal((await store.tasks.get(f.plan.id)).state, 'REVIEW');
    const submit = await findAsync(
      await store.tasks.operations(f.plan.id),
      async (op) => (await store.materialPosts.link(op.id)).purpose === 'SUBMIT',
    );
    assert.ok(submit?.binding);
    const originalBinding = structuredClone(submit.binding),
      inputs = f.h.inputs.get(f.plan.profileId);
    for (let tick = 0; tick < 4; tick++) await f.runner.advance(f.plan.id);
    assert.equal(submitChecks, 1);
    assert.equal(f.h.inputs.get(f.plan.profileId), inputs);
    assert.deepEqual(
      (await store.tasks.operations(f.plan.id)).find((op) => op.id === submit.id)?.binding,
      originalBinding,
    );
    assert.equal((await store.materials.forPlan(f.plan.id))[0]?.state, 'REVIEW');
    assert.equal((await store.materialPosts.archives()).length, 0);
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.published, 0);
  });
});

test('a forged post verdict cannot bypass original account validation or consume material', async () => {
  await postFixture(async (store, _file, catalog) => {
    const f = await fixture(store, catalog),
      original = f.executor.verify;
    f.executor.verify = async (execution, operation, target, guard) => {
      const verdict = await original(execution, operation, target, guard);
      if (verdict.kind === 'verified') verdict.receipt.evidence.observedAccountId = 'wrong-account';
      return verdict;
    };
    await f.runner.advance(f.plan.id); // Reserve.
    await f.runner.advance(f.plan.id); // Input ACK.
    const result = await f.runner.advance(f.plan.id);
    assert.equal(result.status, 'PAUSED_OR_REVIEW');
    assert.equal((await store.tasks.get(f.plan.id)).state, 'REVIEW');
    assert.equal((await store.tasks.operations(f.plan.id))[0]?.status, 'UNKNOWN');
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.published, 0);
    assert.equal((await store.materialPosts.archives()).length, 0);
  });
});

test('an unconfirmed post effect reaches a bounded timeout without resending or consuming content', async () => {
  for (const purpose of ['OPEN_COMPOSER', 'SUBMIT'] as const) {
    await postFixture(async (store, _file, catalog) => {
      const f = await fixture(store, catalog);
      const verify = f.executor.verify;
      f.executor.verify = async (execution, operation, original, guard) =>
        original.link.purpose === purpose
          ? { kind: 'wait', reason: 'fixture effect still processing' }
          : verify(execution, operation, original, guard);
      let waiting = false;
      for (let cycle = 0; cycle < 20 && !waiting; cycle++)
        waiting = (await f.runner.advance(f.plan.id)).status === 'WAITING';
      assert.equal(waiting, true);
      const pending = (await store.tasks.operations(f.plan.id)).find(
        (op) => op.status === 'ACKNOWLEDGED',
      );
      assert.ok(pending?.binding);
      const binding = structuredClone(pending.binding);
      const inputs = f.h.inputs.get(f.plan.profileId);
      f.h.clock.at += (purpose === 'SUBMIT' ? 180_000 : 30_000) - 1;
      assert.equal((await f.runner.advance(f.plan.id)).status, 'WAITING');
      f.h.clock.at += 1;
      const result = await f.runner.advance(f.plan.id);
      assert.equal(result.status, 'BUSINESS_UNKNOWN');
      assert.match(result.reason, new RegExp(`^POST_EFFECT_TIMEOUT:${purpose}:`));
      assert.equal((await store.tasks.get(f.plan.id)).state, 'REVIEW');
      for (let cycle = 0; cycle < 3; cycle++) await f.runner.advance(f.plan.id);
      const original = (await store.tasks.operations(f.plan.id)).find((op) => op.id === pending.id);
      assert.equal(original?.status, 'UNKNOWN');
      assert.deepEqual(original?.binding, binding);
      assert.equal(f.h.inputs.get(f.plan.profileId), inputs);
      assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.published, 0);
      assert.equal((await store.materialPosts.archives()).length, 0);
    });
  }
});

test('an asynchronous stale reservation cannot be committed after stop; concurrent ticks share one profile work item', async () => {
  await postFixture(async (store, _file, catalog) => {
    const f = await fixture(store, catalog),
      original = f.executor.decide;
    let release: (() => void) | undefined,
      entered: (() => void) | undefined,
      decisions = 0;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.executor.decide = async (execution, held, guard) => {
      decisions++;
      const result = await original(execution, held, guard);
      entered?.();
      await waiting;
      return result;
    };
    const first = f.runner.advance(f.plan.id),
      second = f.runner.advance(f.plan.id);
    assert.equal(first, second);
    await started;
    await store.tasks.requestControl(f.plan.id, 'stop');
    release?.();
    await first;
    assert.equal(decisions, 1);
    assert.equal((await store.materials.forPlan(f.plan.id)).length, 0);
    assert.equal((await store.tasks.operations(f.plan.id)).length, 0);
    assert.equal(f.h.inputs.get(f.plan.profileId), undefined);
  });
});
