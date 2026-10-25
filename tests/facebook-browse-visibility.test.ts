import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSE_VISIBILITY_WAIT,
  waitForBrowseVisibility,
} from '../src/infrastructure/facebook-browse-visibility.js';

test('hidden browse waits without activation in another profile, then resumes original check', async () => {
  let visible = false,
    focused = false,
    activations = 0,
    waits = 0,
    checks = 0;
  const states: boolean[] = [];
  await waitForBrowseVisibility(
    async () => {
      checks++;
      if (!visible) throw Error(BROWSE_VISIBILITY_WAIT);
    },
    () => {},
    async () => {
      activations++;
      visible = true;
    },
    () => focused,
    async () => {
      if (++waits === 2) focused = true;
    },
    (waiting) => {
      states.push(waiting);
    },
  );
  assert.equal(activations, 1);
  assert.equal(waits, 3);
  assert.equal(checks, 4);
  assert.deepEqual(states, [true, false]);
});

test('activation preparation waits for permission without recursively activating', async () => {
  let allowed = false;
  await waitForBrowseVisibility(
    async () => {
      if (!allowed) throw Error(BROWSE_VISIBILITY_WAIT);
    },
    () => {},
    undefined,
    () => allowed,
    async () => {
      allowed = true;
    },
  );
});

test('stop during hidden wait revokes the original operation before activation', async () => {
  let stopped = false,
    activated = false;
  await assert.rejects(
    waitForBrowseVisibility(
      async () => {
        throw Error(BROWSE_VISIBILITY_WAIT);
      },
      () => {
        if (stopped) throw Error('ORIGINAL_OPERATION_REVOKED');
      },
      async () => {
        activated = true;
      },
      () => false,
      async () => {
        stopped = true;
      },
    ),
    /ORIGINAL_OPERATION_REVOKED/,
  );
  assert.equal(activated, false);
});

test('changed document and transport failures are not visibility waits', async () => {
  for (const reason of ['FACEBOOK_BROWSE_DOCUMENT_OR_TARGET_CHANGED', 'KERNEL_CONNECTION_LOST'])
    await assert.rejects(
      waitForBrowseVisibility(
        async () => {
          throw Error(reason);
        },
        () => {},
        async () => {
          assert.fail('must not activate');
        },
        () => true,
        async () => {
          assert.fail('must not wait');
        },
      ),
      new RegExp(reason),
    );
});

test('hidden wait has a recovery deadline, even when activation keeps succeeding without visibility', async () => {
  let at = 0,
    inputs = 0;
  await assert.rejects(
    waitForBrowseVisibility(
      async () => {
        throw Error(BROWSE_VISIBILITY_WAIT);
      },
      () => {},
      async () => {
        inputs++;
      },
      () => true,
      async () => {
        at += 10000;
      },
      undefined,
      () => at,
    ),
    /FACEBOOK_BROWSE_FOREGROUND_REQUIRED_TIMEOUT/,
  );
  assert.equal(at, 30000);
  assert.equal(inputs, 3);
});

test('stop wins over visibility deadline and no late activation is issued', async () => {
  let at = 0;
  await assert.rejects(
    waitForBrowseVisibility(
      async () => {
        throw Error(BROWSE_VISIBILITY_WAIT);
      },
      () => {
        if (at === 30000) throw Error('STOPPED');
      },
      undefined,
      () => false,
      async () => {
        at = 30000;
      },
      undefined,
      () => at,
    ),
    /STOPPED/,
  );
});

test('waiting status writes are awaited and revocation after them prevents activation', async () => {
  let stopped = false,
    activated = false;
  await assert.rejects(
    waitForBrowseVisibility(
      async () => {
        throw Error(BROWSE_VISIBILITY_WAIT);
      },
      () => {
        if (stopped) throw Error('STOPPED_DURING_STATUS');
      },
      async () => {
        activated = true;
      },
      () => true,
      async () => {},
      async () => {
        await Promise.resolve();
        stopped = true;
      },
    ),
    /STOPPED_DURING_STATUS/,
  );
  assert.equal(activated, false);
});
