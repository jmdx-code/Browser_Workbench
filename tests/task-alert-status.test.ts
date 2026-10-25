import test from 'node:test';
import assert from 'node:assert/strict';
import { taskAlertReason } from '../src/renderer/task-alerts.js';

test('pending stop status takes priority over an operation failure, but ended failures retain their reason', () => {
  for (const state of ['PAUSING', 'STOPPING'] as const) {
    assert.equal(
      taskAlertReason({ state, reason: 'OPERATION_RESULT_UNCONFIRMED' }, { online: true }).summary,
      '等待浏览器停止确认',
    );
    assert.equal(
      taskAlertReason({ state, reason: 'OPERATION_RESULT_UNCONFIRMED' }, { online: false }).summary,
      '浏览器未连接',
    );
  }
  assert.equal(
    taskAlertReason({ state: 'FAILED', reason: 'OPERATION_RESULT_UNCONFIRMED' }, { online: false })
      .summary,
    '操作结果未确认',
  );
});
