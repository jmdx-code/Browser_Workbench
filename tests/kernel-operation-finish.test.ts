import test from 'node:test';
import assert from 'node:assert/strict';
import { finishKernelOperation } from '../src/infrastructure/kernel-operation-finish.js';

test('only explicitly rejected in-flight finishes wait for SDK quiescence', async () => {
  let finishes = 0,
    clock = 0;
  const result = await finishKernelOperation(
    async () => {
      if (++finishes < 3) throw Error('KERNEL_OPERATION_STILL_IN_FLIGHT');
      return { acknowledged: true };
    },
    () => {},
    {
      now: () => clock,
      wait: async () => {
        clock += 100;
      },
    },
  );
  assert.deepEqual(result, { acknowledged: true });
  assert.equal(finishes, 3);
  assert.equal(clock, 200);
});

test('unknown finish response, replaced binding and stop cannot be retried', async () => {
  for (const message of [
    'KERNEL_RPC_RESULT_UNKNOWN',
    'KERNEL_OPERATION_NOT_ACTIVE',
    'KERNEL_PEER_NOT_IDLE',
  ]) {
    let calls = 0;
    await assert.rejects(
      finishKernelOperation(
        async () => {
          calls++;
          throw Error(message);
        },
        () => {},
      ),
      { message },
    );
    assert.equal(calls, 1);
  }
  let calls = 0,
    revoked = false;
  await assert.rejects(
    finishKernelOperation(
      async () => {
        calls++;
        throw Error('KERNEL_OPERATION_STILL_IN_FLIGHT');
      },
      () => {
        if (revoked) throw Error('STOPPED');
      },
      {
        wait: async () => {
          revoked = true;
        },
      },
    ),
    /STOPPED/,
  );
  assert.equal(calls, 1);
});

test('a stuck original finish is bounded and does not acknowledge input', async () => {
  let clock = 0;
  await assert.rejects(
    finishKernelOperation(
      async () => {
        throw Error('KERNEL_OPERATION_STILL_IN_FLIGHT');
      },
      () => {},
      {
        now: () => clock,
        wait: async () => {
          clock += 100;
        },
      },
    ),
    /KERNEL_OPERATION_FINISH_TIMEOUT/,
  );
  assert.ok(clock >= 5000);
});
