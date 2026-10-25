import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { combinationActivity } from '../src/renderer/combination-activity.js';
import { TaskPlan, type Plan } from '../src/shared/task-contracts.js';

const combinationId = randomUUID();
function plan(state: Plan['state'], createdAt = 1, batchId = randomUUID(), version = 1): Plan {
  return TaskPlan.parse({
    id: randomUUID(),
    batchId,
    profileId: randomUUID(),
    combinationId,
    version,
    accountId: null,
    state,
    reason: '',
    controlMode: null,
    controlRequestId: null,
    controlConfirmed: false,
    round: 1,
    position: 0,
    createdAt,
    updatedAt: createdAt,
    snapshot: {
      name: 'Fixture',
      note: '',
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    },
  });
}
test('never-run and a new combination version do not borrow an old success', () => {
  assert.equal(combinationActivity([], combinationId, 1).label, '未执行');
  assert.equal(combinationActivity([plan('COMPLETED')], combinationId, 2).label, '未执行');
});
test('latest batch includes each result rather than calling a partly failed batch completed', () => {
  const batch = randomUUID();
  assert.deepEqual(
    combinationActivity(
      [plan('COMPLETED', 1), plan('COMPLETED', 2, batch), plan('FAILED', 2, batch)],
      combinationId,
      1,
    ),
    { label: '上次：1 份完成 · 1 份失败', tone: 'orange' },
  );
});
test('active older versions and stop transitions remain visible above historical results', () => {
  assert.deepEqual(
    combinationActivity(
      [plan('COMPLETED', 3, randomUUID(), 2), plan('RUNNING'), plan('STOPPING')],
      combinationId,
      2,
    ),
    { label: '1 份执行中 · 1 份正在停止', tone: 'blue' },
  );
  assert.deepEqual(combinationActivity([plan('STOPPED')], combinationId, 1), {
    label: '上次：1 份停止',
    tone: 'gray',
  });
});
test('an active batch keeps its finished and failed profiles visible without borrowing other batches or versions', () => {
  const batch = randomUUID();
  assert.deepEqual(
    combinationActivity(
      [
        plan('RUNNING', 2, batch),
        plan('COMPLETED', 2, batch),
        plan('FAILED', 2, batch),
        plan('STOPPED', 1),
        plan('FAILED', 1, batch, 2),
      ],
      combinationId,
      1,
    ),
    { label: '1 份执行中 · 1 份完成 · 1 份失败', tone: 'orange' },
  );
});
