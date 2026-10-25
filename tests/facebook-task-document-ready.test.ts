import test from 'node:test';
import assert from 'node:assert/strict';
import {
  awaitFacebookTaskDocument,
  FACEBOOK_TASK_DOCUMENT_READ,
} from '../src/infrastructure/facebook-task-document-ready.js';
test('SDK attachment accepts a parsed interactive document without granting business readiness', async () => {
  let reads = 0;
  await awaitFacebookTaskDocument(
    {
      send: async () => {
        reads++;
        return {
          result: {
            value: JSON.stringify({ url: 'https://www.facebook.com/', ready: 'interactive' }),
          },
        };
      },
    },
    42,
    () => {},
  );
  assert.equal(reads, 1);
});

test('read-only result inspection accepts only its exact numeric Reel and rejects another result or arbitrary initial URL', async () => {
  const expectedUrl = 'https://www.facebook.com/reel/1384641833751659/';
  const read = (url: string) => ({
    send: async () => ({ result: { value: JSON.stringify({ url, ready: 'complete' }) } }),
  });
  await awaitFacebookTaskDocument(read(expectedUrl), 42, () => {}, { expectedUrl });
  await awaitFacebookTaskDocument(read(expectedUrl.slice(0, -1)), 42, () => {}, { expectedUrl });
  await assert.rejects(
    awaitFacebookTaskDocument(read('https://www.facebook.com/reel/999/'), 42, () => {}, {
      expectedUrl,
    }),
    /SCOPE_CHANGED/,
  );
  for (const url of [
    'https://example.com/',
    'https://www.facebook.com/reel/123/?token=x',
    'https://www.facebook.com/reel/abc/',
  ])
    await assert.rejects(
      awaitFacebookTaskDocument(read(url), 42, () => {}, { expectedUrl: url }),
      /INITIAL_ROUTE_REJECTED/,
    );
});
test('registered retained pages reconnect on supported current browse routes without navigating or weakening new-page scope', async () => {
  const read = (url: string) => ({
    send: async () => ({ result: { value: JSON.stringify({ url, ready: 'complete' }) } }),
  });
  for (const url of [
    'https://www.facebook.com/reel/1095721440113960',
    'https://www.facebook.com/watch/',
    'https://www.facebook.com/marketplace/',
    'https://www.facebook.com/marketplace/ineligible/',
  ]) {
    await awaitFacebookTaskDocument(read(url), 42, () => {}, { retainedPage: true });
    await assert.rejects(
      awaitFacebookTaskDocument(read(url), 42, () => {}),
      /SCOPE_CHANGED/,
    );
  }
  for (const url of ['https://example.com/', 'https://www.facebook.com/messages/'])
    await assert.rejects(
      awaitFacebookTaskDocument(read(url), 42, () => {}, { retainedPage: true }),
      /SCOPE_CHANGED/,
    );
  await assert.rejects(
    awaitFacebookTaskDocument(
      read('https://www.facebook.com/reel/123'),
      42,
      () => {
        throw Error('READ_REVOKED');
      },
      { retainedPage: true },
    ),
    /READ_REVOKED/,
  );
});

test('new task document readiness repeats only exact known context absence and loading; foreign, unknown, revoke and deadline stop it', async () => {
  let clock = 0,
    reads = 0;
  const executor = {
    send: async (_target: unknown, method: string, params: { expression?: unknown }) => {
      assert.equal(method, 'Runtime.evaluate');
      assert.equal(params.expression, FACEBOOK_TASK_DOCUMENT_READ);
      if (++reads === 1)
        throw Error('{"code":-32000,"message":"Cannot find default execution context"}');
      return {
        result: {
          value: JSON.stringify({
            url: 'https://www.facebook.com/',
            ready: reads === 2 ? 'loading' : 'complete',
          }),
        },
      };
    },
  };
  await awaitFacebookTaskDocument(executor, 42, () => {}, {
    now: () => clock,
    wait: async () => {
      clock += 200;
    },
  });
  assert.equal(reads, 3);
  for (const message of [
    'KERNEL_RPC_RESULT_UNKNOWN',
    '{"code":-32000,"message":"Unexpected context"}',
  ]) {
    let n = 0;
    await assert.rejects(
      awaitFacebookTaskDocument(
        {
          send: async () => {
            n++;
            throw Error(message);
          },
        },
        42,
        () => {},
      ),
    );
    assert.equal(n, 1);
  }
  await assert.rejects(
    awaitFacebookTaskDocument(
      {
        send: async () => ({
          result: { value: '{"url":"https://example.com/","ready":"complete"}' },
        }),
      },
      42,
      () => {},
    ),
    /SCOPE_CHANGED/,
  );
  clock = 0;
  await assert.rejects(
    awaitFacebookTaskDocument(
      {
        send: async () => ({
          result: { value: '{"url":"https://www.facebook.com/","ready":"loading"}' },
        }),
      },
      42,
      () => {},
      {
        now: () => clock,
        wait: async () => {
          clock += 1000;
        },
      },
    ),
    /DOCUMENT_TIMEOUT/,
  );
});

test('new owned page can finish its pending initial about:blank navigation but cannot return to blank after home', async () => {
  for (const backwards of [false, true]) {
    let n = 0;
    const documents = backwards
      ? [
          { url: 'https://www.facebook.com/', ready: 'loading' },
          { url: 'about:blank', ready: 'complete' },
        ]
      : [
          { url: 'about:blank', ready: 'complete' },
          { url: 'https://www.facebook.com/', ready: 'loading' },
          { url: 'https://www.facebook.com/', ready: 'complete' },
        ];
    const work = awaitFacebookTaskDocument(
      { send: async () => ({ result: { value: JSON.stringify(documents[n++]) } }) },
      42,
      () => {},
      { wait: async () => {} },
    );
    if (backwards) await assert.rejects(work, /SCOPE_CHANGED/);
    else await work;
    assert.equal(n, backwards ? 2 : 3);
  }
});

test('initial network loading may take twelve seconds but is bounded at thirty seconds without repeating navigation', async () => {
  for (const finishes of [true, false]) {
    let clock = 0,
      reads = 0;
    const work = awaitFacebookTaskDocument(
      {
        send: async (_target, method) => {
          assert.equal(method, 'Runtime.evaluate');
          reads++;
          return {
            result: {
              value: JSON.stringify({
                url: 'https://www.facebook.com/',
                ready: finishes && clock >= 12000 ? 'complete' : 'loading',
              }),
            },
          };
        },
      },
      42,
      () => {},
      {
        now: () => clock,
        wait: async () => {
          clock += 1000;
        },
      },
    );
    if (finishes) {
      await work;
      assert.equal(clock, 12000);
    } else {
      await assert.rejects(work, /DOCUMENT_TIMEOUT/);
      assert.equal(clock, 31000);
    }
    assert.equal(reads, finishes ? 13 : 31);
  }
});

test('fixed readiness read waits on explicit native initial-document pending but never retries generic scope escape', async () => {
  for (const pending of [true, false]) {
    let reads = 0;
    const work = awaitFacebookTaskDocument(
      {
        send: async () => {
          if (++reads === 1)
            throw Error(pending ? 'KERNEL_INITIAL_DOCUMENT_PENDING' : 'KERNEL_SCOPE_CHANGED');
          return {
            result: {
              value: JSON.stringify({ url: 'https://www.facebook.com/', ready: 'complete' }),
            },
          };
        },
      },
      42,
      () => {},
      { wait: async () => {} },
    );
    if (pending) {
      await work;
      assert.equal(reads, 2);
    } else {
      await assert.rejects(work, /SCOPE_CHANGED/);
      assert.equal(reads, 1);
    }
  }
});

test('empty composer inspection waits only for its exact initial route and never accepts home or a foreign composer URL', async () => {
  for (const url of [
    'https://www.facebook.com/post/create',
    'https://www.facebook.com/',
    'https://www.facebook.com/post/create?other=1',
  ]) {
    const commands: string[] = [];
    const result = awaitFacebookTaskDocument(
      {
        send: async (_target, method) => {
          commands.push(method);
          return { result: { value: JSON.stringify({ url, ready: 'complete' }) } };
        },
      },
      1,
      () => {},
      { expectedUrl: 'https://www.facebook.com/post/create' },
    );
    if (url === 'https://www.facebook.com/post/create') await result;
    else await assert.rejects(result, /SCOPE_CHANGED/);
    assert.deepEqual(commands, ['Runtime.evaluate']);
  }
});
