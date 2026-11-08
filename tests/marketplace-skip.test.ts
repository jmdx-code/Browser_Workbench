import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { settlementFixture } from './fixtures/settlement.js';
import { browseHarness } from './fixtures/browse.js';
import { deliverPostNotices } from './fixtures/material-post.js';
import { TaskService } from '../src/application/task-service.js';
import { groupTaskRecords } from '../src/domain/task-run-records.js';
import { profileTaskResultLabel } from '../src/shared/profile-task-result.js';
import { ProfileTaskResult } from '../src/shared/task-contracts.js';
import { isSuccessfulTaskStep } from '../src/shared/task-step-outcome.js';
import { stepResultLabel, runSummary } from '../src/renderer/task-record-summary.js';
import type { WorkspaceStore } from '../src/infrastructure/workspace-store.js';

const marketplace = () => ({
  id: randomUUID(),
  type: 'marketplace' as const,
  durationMinutes: 1,
  keyword: '',
  maxLikes: 0 as const,
  minLikeCount: 0 as const,
});
const feed = () => ({
  id: randomUUID(),
  type: 'feed' as const,
  durationMinutes: 1,
  maxLikes: 0 as const,
  minLikeCount: 0 as const,
});
async function endStep(
  store: WorkspaceStore,
  id: string,
  reason = 'FACEBOOK_MARKETPLACE_UNAVAILABLE',
) {
  const plan = store.tasks.get(id),
    step = store.tasks.currentStepForPlan(id, plan.round, plan.position);
  assert.ok(step);
  store.tasks.noteStepFailure(id, step.id, reason);
  const control = store.tasks.requestControl(id, 'pause', reason);
  assert.ok(control.controlRequestId);
  if (!control.controlConfirmed) store.tasks.confirmControl(id, control.controlRequestId);
  const endingId = store.tasks.requestStepEnd(id, step.id, reason);
  const stop = {
    profileId: plan.profileId,
    connectionEpoch: randomUUID(),
    requestId: endingId,
    state: 'stopped' as const,
  };
  assert.throws(
    () => store.tasks.prepareEnd(id, { ...stop, requestId: randomUUID() }),
    /STOP_BINDING/,
  );
  store.tasks.prepareEnd(id, stop);
  await deliverPostNotices(store, plan.profileId);
  store.tasks.finishEnd(id, stop);
  const tabs = store.taskTabs
    .forPlan(id)
    .filter((t) => ['READY', 'RECHECK_REQUIRED'].includes(t.state));
  if (tabs.length)
    assert.throws(() => store.tasks.finishStepContinuation(id), /TAB_OWNERSHIP_PENDING/);
  for (const tab of tabs)
    store.taskTabs.confirmClosed(tab.proof.ownershipId, tab.revision, {
      version: 1,
      profileId: plan.profileId,
      browserSessionEpoch: tab.proof.browserSessionEpoch,
      operations: [],
      tabs: [
        {
          ownershipId: tab.proof.ownershipId,
          proof: tab.proof,
          state: 'CLOSED',
          url: 'https://www.facebook.com/',
          reason: 'FIXTURE_CLOSE',
        },
      ],
    });
  return store.tasks.finishStepContinuation(id);
}
async function checkViews(
  store: WorkspaceStore,
  expected: 'COMPLETED' | 'FAILED',
  runs = 1,
  compareLegacy = true,
) {
  const service = new TaskService(store.tasks);
  for (const status of ['all', 'completed', 'failed', 'review'] as const) {
    const indexed = await service.records({ groupBy: 'run', status, limit: 100 });
    const legacy = await service.recordsLegacy({ groupBy: 'run', status, limit: 100 });
    if (compareLegacy) assert.deepEqual(indexed.records, legacy.records);
    if (compareLegacy) assert.deepEqual(indexed.counts, legacy.counts);
    assert.equal(
      indexed.total,
      status === 'review'
        ? 0
        : status === 'all' ||
            (status === 'completed' && expected === 'COMPLETED') ||
            (status === 'failed' && expected === 'FAILED')
          ? runs
          : 0,
    );
  }
  const rows = (await service.records({ groupBy: 'run', status: 'all' })).records;
  assert.equal(groupTaskRecords(rows).at(-1)?.state, expected);
  return rows;
}

test('unavailable-only marketplace finishes successfully with zero fake browsing, green summary, completed filters and retained final snapshot', async () =>
  settlementFixture(async (store, file) => {
    const h = await browseHarness(store, 1, {
      name: 'Unavailable only',
      steps: [marketplace()],
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    const plan = await h.claim();
    const executor = h.executors.find((e) => e.type === 'marketplace');
    assert.ok(executor);
    executor.decide = async () => {
      throw Error('FACEBOOK_MARKETPLACE_UNAVAILABLE');
    };
    await h.runner.advance(plan.id);
    assert(store.tasks.events(plan.id).some((e) => e.type === 'STEP_SKIP_INTENT'));
    assert(!store.tasks.events(plan.id).some((e) => e.type === 'STEP_FAILURE_INTENT'));
    const final = await endStep(store, plan.id);
    assert.equal(final.state, 'COMPLETED');
    const [step] = store.tasks.steps(plan.id);
    assert.ok(step);
    assert.equal(step.status, 'SKIPPED');
    assert.equal(step.outcome?.reason, 'MARKETPLACE_UNAVAILABLE');
    assert.equal(step.progress.effectiveMilliseconds, 0);
    const before = await checkViews(store, 'COMPLETED');
    const first = before[0];
    assert.ok(first);
    assert.match(stepResultLabel(first), /当前身份不可用，已跳过/);
    assert.match(runSummary(before), /商城不可用，已正常跳过/);
    const result = ProfileTaskResult.parse(store.tasks.runtimeSnapshot().profileResults?.[0]);
    assert.equal(result.failedSteps, 0);
    assert.equal(result.skippedSteps, 1);
    assert.equal(profileTaskResultLabel(result).tone, 'ok');
    assert.match(profileTaskResultLabel(result).text, /成功（跳过1项）/);
    const boundary = { at: Date.now() + 1000, key: 'z' };
    while (store.dataCleanup.pruneDetails(boundary, 100)) {}
    assert.deepEqual(await checkViews(store, 'COMPLETED', 1, false), before);
    assert.equal(store.tasks.events(plan.id).length, 0);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally {
      db.close();
    }
  }));

for (const failure of [false, true])
  test(`marketplace skip continues the existing plan and preserves following ${failure ? 'failure' : 'success'}`, async () =>
    settlementFixture(async (store) => {
      const h = await browseHarness(store, 1, {
        name: 'Mixed',
        steps: [marketplace(), feed()],
        note: '',
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
      });
      const plan = await h.claim();
      assert.equal((await endStep(store, plan.id)).state, 'QUEUED');
      const resumed = store.tasks.claimNext(h.profiles, new Set(['marketplace', 'feed']));
      assert.ok(resumed);
      const step = store.tasks.currentStepForPlan(plan.id, 1, 1);
      assert.ok(step);
      if (failure)
        assert.equal(
          (await endStep(store, plan.id, 'FACEBOOK_BROWSE_LOADING_OR_DIALOG_TIMEOUT')).state,
          'FAILED',
        );
      else {
        store.tasks.checkpoint(plan.id, step.id, 0, {
          ...step.progress,
          revision: 1,
          effectiveMilliseconds: 60000,
        });
        assert.equal(store.tasks.completeStep(plan.id, step.id).state, 'COMPLETED');
      }
      await checkViews(store, failure ? 'FAILED' : 'COMPLETED');
    }));

test('normal marketplace skip remains successful over multiple rounds', async () =>
  settlementFixture(async (store) => {
    const h = await browseHarness(store, 1, {
      name: 'Rounds',
      steps: [marketplace()],
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 3 },
    });
    const plan = await h.claim();
    for (let round = 1; round <= 3; round++) {
      assert.equal((await endStep(store, plan.id)).state, round === 3 ? 'COMPLETED' : 'QUEUED');
      if (round < 3) assert.ok(store.tasks.claimNext(h.profiles, new Set(['marketplace'])));
    }
    await checkViews(store, 'COMPLETED', 3);
  }));

for (const reason of [
  'FACEBOOK_BROWSE_LOADING_OR_DIALOG_TIMEOUT',
  'FACEBOOK_ACCOUNT_VERIFICATION_REQUIRED',
  'FACEBOOK_ACCOUNT_LOGGED_OUT',
])
  test(`real marketplace fault ${reason} is never converted to a successful skip`, async () =>
    settlementFixture(async (store) => {
      const h = await browseHarness(store, 1, {
        name: 'Real error',
        steps: [marketplace()],
        note: '',
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
      });
      const plan = await h.claim();
      assert.equal((await endStep(store, plan.id, reason)).state, 'FAILED');
      assert.equal(store.tasks.steps(plan.id)[0]?.status, 'FAILED');
    }));

test('other skipped reasons and wrong step types do not become successful', () => {
  for (const reason of ['DEPENDENCY_FAILED', 'RESOURCE_EXHAUSTED', 'FEATURE_UNAVAILABLE'])
    assert.equal(
      isSuccessfulTaskStep('marketplace', 'SKIPPED', { kind: 'SKIPPED', reason }),
      false,
    );
  assert.equal(
    isSuccessfulTaskStep('feed', 'SKIPPED', { kind: 'SKIPPED', reason: 'MARKETPLACE_UNAVAILABLE' }),
    false,
  );
});

test('an UNKNOWN original marketplace navigation ends with the exact delivered notice and stop proof, then completes as a normal skip', async () =>
  settlementFixture(async (store) => {
    const h = await browseHarness(store, 1, {
      name: 'Real navigation shape',
      steps: [marketplace()],
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    const plan = await h.claim(),
      step = store.tasks.currentStepForPlan(plan.id, 1, 0),
      context = h.sessions.get(plan.profileId);
    assert.ok(step && context);
    store.tasks.prepareOperation(plan.id, step.id, randomUUID(), {
      kind: 'browseNavigate',
      tabId: 42,
      url: 'https://www.facebook.com/marketplace/',
    });
    const op = store.tasks.takeBoundOperation(context);
    assert.ok(op?.binding);
    store.tasks.acknowledgeBound({ binding: op.binding, evidence: { fixtureOnly: true } });
    store.tasks.markBoundUnknown(op.binding, 'FACEBOOK_MARKETPLACE_UNAVAILABLE');
    assert.equal((await endStep(store, plan.id)).state, 'COMPLETED');
    const original = store.tasks.operations(plan.id).find((o) => o.id === op.id);
    assert.ok(original);
    assert.equal(original.status, 'UNKNOWN');
    assert.equal(original.disposition?.outcome, 'ENDED_UNKNOWN');
    assert.equal(store.tasks.blockingOperations(plan.id).length, 0);
    const outcome = store.tasks.steps(plan.id)[0]?.outcome;
    assert.ok(outcome?.kind === 'SKIPPED');
    assert.equal(outcome.currentStop?.requestId, outcome.endingId);
    await checkViews(store, 'COMPLETED');
  }));
