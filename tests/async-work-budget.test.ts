import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncWorkBudget } from '../src/application/async-work-budget.js';

test('expensive phases are bounded, FIFO and recheck stop before any queued work starts', async () => {
  const budget = new AsyncWorkBudget(1, 2);
  let release!: () => void;
  const order: number[] = [];
  const first = budget.run(
    () => {},
    async () => {
      order.push(1);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 1;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  let current = true;
  const stopped = budget.run(
    () => {
      if (!current) throw Error('USER_STOP');
    },
    async () => {
      order.push(2);
    },
  );
  const stoppedResult = assert.rejects(stopped, /USER_STOP/);
  const last = budget.run(
    () => {},
    async () => {
      order.push(3);
      return 3;
    },
  );
  await assert.rejects(
    budget.run(
      () => {},
      async () => 4,
    ),
    /QUEUE_FULL/,
  );
  current = false;
  assert.deepEqual(budget.status(), { active: 1, waiting: 2, limit: 1 });
  release();
  assert.equal(await first, 1);
  await stoppedResult;
  assert.equal(await last, 3);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [1, 3]);
  assert.deepEqual(budget.status(), { active: 0, waiting: 0, limit: 1 });
});

test('native failure releases the permit without replaying work or swallowing its error', async () => {
  const budget = new AsyncWorkBudget(1, 4);
  let calls = 0;
  const failed = budget.run(
    () => {},
    async () => {
      calls++;
      throw Error('ACK_UNKNOWN');
    },
  );
  const next = budget.run(
    () => {},
    async () => {
      calls++;
      return 'next';
    },
  );
  await assert.rejects(failed, /ACK_UNKNOWN/);
  assert.equal(await next, 'next');
  assert.equal(calls, 2);
});
