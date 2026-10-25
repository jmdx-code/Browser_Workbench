import test from 'node:test';
import assert from 'node:assert/strict';
import { readFacebookAcrossNavigation } from '../src/infrastructure/facebook-navigation-read.js';

const replaced = () =>
  Error('page.evaluate: Execution context was destroyed, most likely because of a navigation.');
test('document replacement repeats only the read and preserves the same live guard', async () => {
  let reads = 0,
    clock = 0,
    checks = 0;
  const result = await readFacebookAcrossNavigation(
    async () => {
      if (++reads === 1) throw replaced();
      if (reads === 2)
        throw Error(
          JSON.stringify({ code: -32000, message: 'Cannot find default execution context' }),
        );
      return { url: 'https://www.facebook.com/reel/?s=tab' };
    },
    () => {
      checks++;
    },
    {
      now: () => clock,
      wait: async () => {
        clock += 150;
      },
    },
  );
  assert.equal(reads, 3);
  assert.equal(clock, 300);
  assert.ok(checks >= 7);
  assert.equal(result.url, 'https://www.facebook.com/reel/?s=tab');
});

test('navigation read never retries transport uncertainty, closed pages or revoked ownership', async () => {
  for (const message of [
    'KERNEL_RPC_RESULT_UNKNOWN',
    'Target page, context or browser has been closed',
    'FACEBOOK_NATIVE_ACCOUNT_CHANGED',
  ]) {
    let reads = 0;
    await assert.rejects(
      readFacebookAcrossNavigation(
        async () => {
          reads++;
          throw Error(message);
        },
        () => {},
      ),
      { message },
    );
    assert.equal(reads, 1);
  }
  let revoked = false,
    reads = 0;
  await assert.rejects(
    readFacebookAcrossNavigation(
      async () => {
        reads++;
        throw replaced();
      },
      () => {
        if (revoked) throw Error('REVOKED');
      },
      {
        wait: async () => {
          revoked = true;
        },
      },
    ),
    /REVOKED/,
  );
  assert.equal(reads, 1);
});

test('navigation read bounds a permanently missing context without accepting a stale result', async () => {
  let clock = 0,
    reads = 0;
  await assert.rejects(
    readFacebookAcrossNavigation(
      async () => {
        reads++;
        throw replaced();
      },
      () => {},
      {
        now: () => clock,
        wait: async () => {
          clock += 150;
        },
      },
    ),
    /FACEBOOK_NAVIGATION_READ_TIMEOUT/,
  );
  assert.ok(reads <= 35);
  assert.ok(clock >= 5000);
});

test('navigation context replacement without a trailing period repeats only the read', async () => {
  let reads = 0;
  const value = await readFacebookAcrossNavigation(
    async () => {
      if (++reads === 1)
        throw Error(
          'page.evaluate: Execution context was destroyed, most likely because of a navigation',
        );
      return 'ready';
    },
    () => {},
    { wait: async () => {} },
  );
  assert.equal(value, 'ready');
  assert.equal(reads, 2);
});
