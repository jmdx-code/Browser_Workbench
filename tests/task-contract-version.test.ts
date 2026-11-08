import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTaskContract } from '../src/http/task-contract-version.js';

test('old task readers keep legacy results but fail explicitly on failed/skipped step shapes', () => {
  for (const version of [undefined, '1', '2'])
    assert.doesNotThrow(() =>
      assertTaskContract(version, [{ status: 'COMPLETED' }, { status: 'ACTIVE' }]),
    );
  for (const status of ['FAILED', 'SKIPPED']) {
    for (const version of [undefined, '1'])
      assert.throws(() => assertTaskContract(version, [{ status }]), {
        code: 'TASK_CONTRACT_UPGRADE_REQUIRED',
      });
    assert.doesNotThrow(() => assertTaskContract('2', [{ status, outcome: {} }]));
  }
  for (const version of ['0', '6', ['2']])
    assert.throws(() => assertTaskContract(version, []), { code: 'TASK_CONTRACT_UNSUPPORTED' });
});
test('explicit AI label settings require contract4 and do not alter legacy task negotiation', () => {
  const plans = [{ snapshot: { steps: [{ type: 'post', aiLabel: 'on' }] } }];
  for (const version of [undefined, '1', '2', '3'])
    assert.throws(() => assertTaskContract(version, [], plans), {
      code: 'TASK_CONTRACT_UPGRADE_REQUIRED',
    });
  assert.doesNotThrow(() => assertTaskContract('4', [], plans));
  assert.doesNotThrow(() => assertTaskContract('4', [{ status: 'FAILED', outcome: {} }]));
});
test('Friends story plans and history require task contract3 while old SELF remains contract2', () => {
  const plans = [{ snapshot: { steps: [{ type: 'post', audience: 'friends' }] } }];
  for (const version of [undefined, '1', '2']) {
    assert.throws(() => assertTaskContract(version, [], plans), {
      code: 'TASK_CONTRACT_UPGRADE_REQUIRED',
    });
    assert.throws(
      () =>
        assertTaskContract(version, [
          { status: 'ACTIVE', spec: { type: 'post', audience: 'friends' } },
        ]),
      { code: 'TASK_CONTRACT_UPGRADE_REQUIRED' },
    );
  }
  assert.doesNotThrow(() => assertTaskContract('3', [], plans));
  assert.doesNotThrow(() =>
    assertTaskContract('2', [], [{ snapshot: { steps: [{ type: 'post', audience: 'self' }] } }]),
  );
});

test('marketplace skip results require contract5 while newer readers preserve all prior contracts', () => {
  const steps = [
    { status: 'SKIPPED', outcome: { kind: 'SKIPPED', reason: 'MARKETPLACE_UNAVAILABLE' } },
  ];
  for (const version of [undefined, '1', '2', '3', '4'])
    assert.throws(() => assertTaskContract(version, steps), {
      code: 'TASK_CONTRACT_UPGRADE_REQUIRED',
    });
  assert.doesNotThrow(() => assertTaskContract('5', steps));
  assert.doesNotThrow(() =>
    assertTaskContract(
      '5',
      [],
      [{ snapshot: { steps: [{ type: 'post', audience: 'friends', aiLabel: 'on' }] } }],
    ),
  );
});
