import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  assignSamplePlan,
  makeRuntimeProfiles,
  workspaceFixture,
} from './fixtures/workspace-fixture.js';
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

async function checkViews(store: WorkspaceStore, expected: 'COMPLETED' | 'FAILED', runs = 1) {
  const service = new TaskService(store.tasks);
  for (const status of ['all', 'completed', 'failed'] as const) {
    const indexed = await service.records({ groupBy: 'run', status, limit: 100 });
    assert.equal(
      indexed.total,
      status === 'all' ||
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
  workspaceFixture(async (store, file) => {
    const profile = makeRuntimeProfiles(1)[0]!;
    const { plan } = assignSamplePlan(store, { steps: [marketplace()], profile });
    store.tasks.claimPlanForProfile(profile.id, profile.account.id);
    const step = store.tasks.currentStepForPlan(plan.id, 1, 0);
    assert.ok(step);
    const final = store.tasks.skipStepDirect(plan.id, step.id, 'MARKETPLACE_UNAVAILABLE');
    assert.equal(final.state, 'COMPLETED');
    const [savedStep] = store.tasks.steps(plan.id);
    assert.ok(savedStep);
    assert.equal(savedStep.status, 'SKIPPED');
    assert.equal(savedStep.outcome?.reason, 'MARKETPLACE_UNAVAILABLE');
    assert.equal(savedStep.progress.effectiveMilliseconds, 0);
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
    assert.deepEqual(await checkViews(store, 'COMPLETED'), before);
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
    workspaceFixture(async (store) => {
      const profile = makeRuntimeProfiles(1)[0]!;
      const { plan } = assignSamplePlan(store, { steps: [marketplace(), feed()], profile });
      store.tasks.claimPlanForProfile(profile.id, profile.account.id);
      const step0 = store.tasks.currentStepForPlan(plan.id, 1, 0);
      assert.ok(step0);
      const afterSkip = store.tasks.skipStepDirect(plan.id, step0.id, 'MARKETPLACE_UNAVAILABLE');
      assert.equal(afterSkip.state, 'RUNNING');
      assert.equal(afterSkip.position, 1);
      const step1 = store.tasks.currentStepForPlan(plan.id, 1, 1);
      assert.ok(step1);
      if (failure) {
        assert.equal(
          store.tasks.failStepDirect(plan.id, step1.id, 'FACEBOOK_BROWSE_LOADING_OR_DIALOG_TIMEOUT')
            .state,
          'FAILED',
        );
      } else {
        assert.equal(
          store.tasks.completeStepDirect(plan.id, step1.id, {
            ...step1.progress,
            effectiveMilliseconds: 60000,
          }).state,
          'COMPLETED',
        );
      }
      await checkViews(store, failure ? 'FAILED' : 'COMPLETED');
    }));

test('normal marketplace skip remains successful over multiple rounds', async () =>
  workspaceFixture(async (store) => {
    const profile = makeRuntimeProfiles(1)[0]!;
    const combo = store.createCombination({
      name: 'Rounds',
      note: '',
      steps: [marketplace()],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 3 },
    });
    const [plan] = store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: combo.id,
        version: combo.version,
        profileIds: [profile.id],
      },
      [profile],
    );
    assert.ok(plan);
    store.tasks.claimPlanForProfile(profile.id, profile.account.id);
    for (let round = 1; round <= 3; round++) {
      const step = store.tasks.currentStepForPlan(plan.id, round, 0);
      assert.ok(step);
      const next = store.tasks.skipStepDirect(plan.id, step.id, 'MARKETPLACE_UNAVAILABLE');
      assert.equal(next.state, round === 3 ? 'COMPLETED' : 'RUNNING');
    }
    await checkViews(store, 'COMPLETED', 3);
  }));

for (const reason of [
  'FACEBOOK_BROWSE_LOADING_OR_DIALOG_TIMEOUT',
  'FACEBOOK_ACCOUNT_VERIFICATION_REQUIRED',
  'FACEBOOK_ACCOUNT_LOGGED_OUT',
])
  test(`real marketplace fault ${reason} is never converted to a successful skip`, async () =>
    workspaceFixture(async (store) => {
      const profile = makeRuntimeProfiles(1)[0]!;
      const { plan } = assignSamplePlan(store, { steps: [marketplace()], profile });
      store.tasks.claimPlanForProfile(profile.id, profile.account.id);
      const step = store.tasks.currentStepForPlan(plan.id, 1, 0);
      assert.ok(step);
      assert.equal(store.tasks.failStepDirect(plan.id, step.id, reason).state, 'FAILED');
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
