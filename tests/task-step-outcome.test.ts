import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TaskStepLegacy as TaskStep } from '../src/shared/task-contracts.js';
import { TaskStepV2 } from '../src/shared/task-step-instance.js';
import { TaskStepFailure, TaskStepOutcome, TaskStepSkip } from '../src/shared/task-step-outcome.js';

const step = () => ({
  id: randomUUID(),
  jobId: randomUUID(),
  round: 1,
  position: 0,
  spec: { id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 },
  status: 'ACTIVE',
  progress: { revision: 0, effectiveMilliseconds: 0, likes: 0, published: 0, cursor: null },
});
const failure = () => {
  const endingId = randomUUID();
  return {
    version: 1,
    kind: 'FAILED',
    reason: 'CHILD_PAGE_CLOSED',
    endedAt: 1000,
    endingId,
    currentStop: {
      profileId: randomUUID(),
      connectionEpoch: randomUUID(),
      requestId: endingId,
      state: 'stopped',
    },
    submissionPhase: 'NOT_APPLICABLE',
    businessResult: 'NOT_APPLICABLE',
  };
};

test('candidate step contract reads all legacy states unchanged; legacy rejects new outcomes', () => {
  for (const status of ['PENDING', 'ACTIVE', 'COMPLETED']) {
    const original = { ...step(), status };
    assert.deepEqual(TaskStepV2.parse(original), TaskStep.parse(original));
    assert.equal(TaskStepV2.safeParse({ ...original, outcome: failure() }).success, false);
  }
  assert.equal(
    TaskStep.safeParse({ ...step(), status: 'FAILED', outcome: failure() }).success,
    false,
  );
});

test('failure must retain matching original end and actual stop, not a timeout or legacy flag', () => {
  const original = failure();
  assert.equal(
    TaskStepV2.parse({ ...step(), status: 'FAILED', outcome: original }).status,
    'FAILED',
  );
  for (const changed of [
    { ...original, endingId: randomUUID() },
    { ...original, currentStop: { ...original.currentStop, state: 'unknown' } },
    { ...original, currentStop: undefined },
    { ...original, controlConfirmed: true },
    { ...original, version: 2 },
    { ...original, reason: '' },
    { ...original, reason: 'x'.repeat(201) },
    { ...original, endedAt: -1 },
  ])
    assert.equal(TaskStepFailure.safeParse(changed).success, false);
  assert.equal(TaskStepV2.safeParse({ ...step(), status: 'FAILED' }).success, false);
  assert.equal(
    TaskStepV2.safeParse({ ...step(), status: 'SKIPPED', outcome: original }).success,
    false,
  );
});

test('submission stage cannot turn unknown publication into success or definite non-publication', () => {
  const permitted: Record<string, string[]> = {
    NOT_APPLICABLE: ['NOT_APPLICABLE'],
    BEFORE_SUBMIT: ['NOT_PUBLISHED'],
    SUBMIT_DISPATCHED: ['UNKNOWN'],
    RESULT_CONFIRMED: ['PUBLISHED', 'NOT_PUBLISHED'],
    UNKNOWN: ['UNKNOWN'],
  };
  for (const [submissionPhase, results] of Object.entries(permitted)) {
    for (const businessResult of ['NOT_APPLICABLE', 'PUBLISHED', 'NOT_PUBLISHED', 'UNKNOWN']) {
      assert.equal(
        TaskStepFailure.safeParse({ ...failure(), submissionPhase, businessResult }).success,
        results.includes(businessResult),
        `${submissionPhase}/${businessResult}`,
      );
    }
  }
  const original = step();
  const post = {
    id: randomUUID(),
    type: 'post',
    resourceDirectory: '',
    resourceMode: 'table',
    allowRepeat: false,
    forbidSameAccountRepeat: true,
    archivePublished: false,
    count: 1,
  };
  assert.equal(
    TaskStepV2.safeParse({ ...original, spec: post, status: 'FAILED', outcome: failure() }).success,
    false,
  );
  assert.equal(
    TaskStepV2.safeParse({
      ...original,
      spec: post,
      status: 'FAILED',
      outcome: { ...failure(), submissionPhase: 'UNKNOWN', businessResult: 'UNKNOWN' },
    }).success,
    true,
  );
  assert.equal(
    TaskStepV2.safeParse({
      ...original,
      status: 'FAILED',
      outcome: { ...failure(), submissionPhase: 'UNKNOWN', businessResult: 'UNKNOWN' },
    }).success,
    false,
  );
});

test('skip reasons are fixed and require exact dependency only when applicable', () => {
  const original = step();
  const skipped = {
    version: 1,
    kind: 'SKIPPED',
    reason: 'DEPENDENCY_FAILED',
    endedAt: 1000,
    dependencyStepId: randomUUID(),
  };
  assert.equal(
    TaskStepV2.safeParse({ ...original, status: 'SKIPPED', outcome: skipped }).success,
    true,
  );
  assert.equal(TaskStepSkip.safeParse({ ...skipped, dependencyStepId: undefined }).success, false);
  assert.equal(
    TaskStepV2.safeParse({
      ...original,
      status: 'SKIPPED',
      outcome: { ...skipped, dependencyStepId: original.id },
    }).success,
    false,
  );
  for (const reason of ['RESOURCE_EXHAUSTED', 'FEATURE_UNAVAILABLE']) {
    assert.equal(
      TaskStepOutcome.safeParse({ ...skipped, reason, dependencyStepId: undefined }).success,
      true,
    );
    assert.equal(TaskStepOutcome.safeParse({ ...skipped, reason }).success, false);
  }
  assert.equal(TaskStepSkip.safeParse({ ...skipped, reason: 'ARBITRARY_RULE' }).success, false);
});
