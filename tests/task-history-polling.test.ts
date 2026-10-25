import test from 'node:test';
import assert from 'node:assert/strict';
import { taskHistoryNeedsPolling } from '../src/renderer/task-history-polling.js';
import type { History } from '../src/shared/task-contracts.js';

test('only explicitly selected ended task histories stop polling; overview and unconfirmed controls keep reading', () => {
  const row = (state: History['plans'][number]['state']) => ({
    id: 'selected',
    state,
  });
  for (const state of [
    'FAILED',
    'COMPLETED',
    'STOPPED',
    'STOPPING',
    'PAUSING',
    'REVIEW',
    'PAUSED',
    'RUNNING',
    'QUEUED',
  ] as const) {
    const history = {
      selectedPlanId: 'selected',
      plans: [row(state)],
    } as Pick<History, 'plans' | 'selectedPlanId'>;
    assert.equal(
      taskHistoryNeedsPolling(history, 'selected'),
      !['FAILED', 'COMPLETED', 'STOPPED'].includes(state),
    );
    assert.equal(taskHistoryNeedsPolling(history, null), true);
    assert.equal(taskHistoryNeedsPolling(history, 'other'), true);
  }
});
