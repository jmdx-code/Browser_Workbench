import test from 'node:test';
import assert from 'node:assert/strict';
import type { KernelJsonObject } from '../src/shared/kernel-protocol.js';
import { navigateFacebookBoundPage } from '../src/infrastructure/facebook-bound-navigation.js';
import { FACEBOOK_TASK_DOCUMENT_READ } from '../src/infrastructure/facebook-task-document-ready.js';

test('one native navigation waits through parsed document reads without an SDK lifecycle event or repeated input', async () => {
  const methods: string[] = [];
  let reads = 0,
    clock = 0;
  await navigateFacebookBoundPage(
    {
      send: async (_target, method, params): Promise<KernelJsonObject> => {
        methods.push(method);
        if (method === 'Page.navigate') return { frameId: 'main' };
        assert.equal(params.expression, FACEBOOK_TASK_DOCUMENT_READ);
        reads++;
        return {
          result: {
            value: JSON.stringify(
              reads === 1
                ? { url: 'https://www.facebook.com/', ready: 'complete' }
                : reads === 2
                  ? { url: 'https://www.facebook.com/reels/', ready: 'loading' }
                  : { url: 'https://www.facebook.com/reel/123', ready: 'interactive' },
            ),
          },
        };
      },
    },
    7,
    'https://www.facebook.com/reels/',
    'https://www.facebook.com/',
    () => {},
    {
      now: () => clock,
      wait: async () => {
        clock += 150;
      },
    },
  );
  assert.deepEqual(methods, [
    'Page.navigate',
    'Runtime.evaluate',
    'Runtime.evaluate',
    'Runtime.evaluate',
  ]);
});

test('navigation rejects wrong document, download and cancellation, with no second navigation', async () => {
  for (const mode of ['foreign', 'download', 'revoke', 'loading', 'native-error']) {
    let inputs = 0,
      revoked = false,
      clock = 0;
    await assert.rejects(
      navigateFacebookBoundPage(
        {
          send: async (_target, method): Promise<KernelJsonObject> => {
            if (method === 'Page.navigate') {
              inputs++;
              if (mode === 'revoke') revoked = true;
              return {
                frameId: 'main',
                ...(mode === 'download' ? { isDownload: true } : {}),
                ...(mode === 'native-error' ? { errorText: 'failed' } : {}),
              };
            }
            return {
              result: {
                value: JSON.stringify({
                  url:
                    mode === 'foreign' ? 'https://example.com/' : 'https://www.facebook.com/reels/',
                  ready: mode === 'loading' ? 'loading' : 'complete',
                }),
              },
            };
          },
        },
        7,
        'https://www.facebook.com/reels/',
        'https://www.facebook.com/',
        () => {
          if (revoked) throw Error('REVOKED');
        },
        {
          now: () => clock,
          wait: async () => {
            clock += 10000;
          },
        },
      ),
    );
    assert.equal(inputs, 1);
  }
});

test('missing native context retries only the fixed read, and a story cannot redirect to another Facebook surface', async () => {
  let inputs = 0,
    reads = 0;
  const executor = {
    send: async (_target: unknown, method: string): Promise<KernelJsonObject> => {
      if (method === 'Page.navigate') {
        inputs++;
        return { frameId: 'main' };
      }
      if (++reads === 1)
        throw Error('{"code":-32000,"message":"Cannot find default execution context"}');
      return {
        result: {
          value: JSON.stringify({
            url: 'https://www.facebook.com/stories/create/',
            ready: 'complete',
          }),
        },
      };
    },
  };
  await navigateFacebookBoundPage(
    executor,
    7,
    'https://www.facebook.com/stories/create/',
    'https://www.facebook.com/',
    () => {},
    { wait: async () => {} },
  );
  assert.equal(inputs, 1);
  await assert.rejects(
    navigateFacebookBoundPage(
      {
        send: async (_target, method): Promise<KernelJsonObject> =>
          method === 'Page.navigate'
            ? { frameId: 'main' }
            : {
                result: {
                  value: JSON.stringify({
                    url: 'https://www.facebook.com/reel/999',
                    ready: 'complete',
                  }),
                },
              },
      },
      7,
      'https://www.facebook.com/stories/create/',
      'https://www.facebook.com/',
      () => {},
    ),
    /SCOPE_CHANGED/,
  );
});

test('default-mode bound navigation pre-checks Target.getTargetInfo during KERNEL_INITIAL_DOCUMENT_PENDING and accepts normalized Marketplace item URLs', async () => {
  const methods: string[] = [];
  let targetChecks = 0;
  await navigateFacebookBoundPage(
    {
      send: async (_target, method): Promise<KernelJsonObject> => {
        methods.push(method);
        if (method === 'Page.navigate') return { frameId: 'main' };
        if (method === 'Target.getTargetInfo') {
          targetChecks++;
          if (targetChecks === 1) throw Error('KERNEL_INITIAL_DOCUMENT_PENDING');
          return {
            targetInfo: {
              url: 'https://www.facebook.com/marketplace/item/2097025124256901/?ref=browse_tab',
            },
          };
        }
        return {
          result: {
            value: JSON.stringify({
              url: 'https://www.facebook.com/marketplace/item/2097025124256901/?ref=browse_tab',
              ready: 'complete',
            }),
          },
        };
      },
    },
    7,
    'https://www.facebook.com/marketplace/item/2097025124256901/',
    'https://www.facebook.com/marketplace/',
    () => {},
  );
  assert.deepEqual(methods, [
    'Page.navigate',
    'Target.getTargetInfo',
    'Target.getTargetInfo',
    'Runtime.evaluate',
  ]);
});

test('bound navigation to Marketplace home accepts regional Marketplace paths and tolerates pre-commit valid Facebook browse URLs', async () => {
  let evaluations = 0;
  await navigateFacebookBoundPage(
    {
      send: async (_target, method): Promise<KernelJsonObject> => {
        if (method === 'Page.navigate') return { frameId: 'main' };
        if (method === 'Target.getTargetInfo') {
          return {
            targetInfo: {
              url: 'https://www.facebook.com/marketplace/108659242498155/?ref=bookmark',
            },
          };
        }
        evaluations++;
        return {
          result: {
            value: JSON.stringify(
              evaluations === 1
                ? {
                    url: 'https://www.facebook.com/?sk=h_chr',
                    ready: 'loading',
                  }
                : {
                    url: 'https://www.facebook.com/marketplace/108659242498155/?ref=bookmark',
                    ready: 'interactive',
                  },
            ),
          },
        };
      },
    },
    7,
    'https://www.facebook.com/marketplace/',
    'https://www.facebook.com/',
    () => {},
  );
  assert.equal(evaluations, 2);
});
