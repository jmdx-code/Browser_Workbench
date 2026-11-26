import test from 'node:test';
import assert from 'node:assert/strict';
import { taskAlertReason } from '../src/renderer/task-alerts.js';

test('disconnected running plan prioritizes connection guidance, while failed plan keeps failure reason', () => {
  assert.equal(
    taskAlertReason({ state: 'RUNNING', reason: '' }, { online: false }).summary,
    '浏览器未连接',
  );
  assert.equal(
    taskAlertReason({ state: 'FAILED', reason: 'OPERATION_RESULT_UNCONFIRMED' }, { online: false })
      .summary,
    '操作结果未确认',
  );
  assert.equal(
    taskAlertReason({ state: 'FAILED', reason: '' }, { online: true }).summary,
    '任务失败',
  );
});
