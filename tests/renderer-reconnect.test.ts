import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/renderer/api.js';

const workspace = {
  schemaVersion: 1,
  groups: [],
  profiles: [],
  combinations: [],
  records: [],
  support: { comboExecution: false, accountIdentity: false, reason: '' },
};
const denied = () => Response.json({ error: 'ADMIN_REQUIRED' }, { status: 401 });
async function withFetch(
  replies: Response[],
  work: (calls: { url: string; options?: RequestInit }[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: { url: string; options?: RequestInit }[] = [];
  globalThis.fetch = async (input, options) => {
    options?.signal?.throwIfAborted();
    calls.push({ url: String(input), options });
    const reply = replies.shift();
    assert.ok(reply, 'UNEXPECTED_FETCH');
    return reply;
  };
  try {
    await work(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test('workspace polling renews only the same-origin bootstrap after a software restart', async () => {
  await withFetch(
    [denied(), new Response('<html></html>'), Response.json(workspace)],
    async (calls) => {
      assert.deepEqual(await api.snapshot(), workspace);
      assert.deepEqual(
        calls.map((call) => call.url),
        ['/api/workspace', '/workbench/', '/api/workspace'],
      );
      assert.ok(calls.every((call) => !call.options?.method || call.options.method === 'GET'));
      assert.equal(calls[1]?.options?.credentials, 'same-origin');
      assert.equal(calls[1]?.options?.redirect, 'error');
      assert.equal(calls[0]?.options?.signal, calls[2]?.options?.signal);
    },
  );
});

test('persistent authentication rejection does not recurse or silently accept a stale workspace', async () => {
  await withFetch([denied(), new Response('<html></html>'), denied()], async (calls) => {
    await assert.rejects(api.snapshot(), /ADMIN_REQUIRED/);
    assert.equal(calls.length, 3);
  });
});

test('failed bootstrap and a rejected host leave reads failed instead of bypassing checks', async () => {
  for (const replies of [
    [denied(), new Response('', { status: 503 })],
    [Response.json({ error: 'HOST_REJECTED' }, { status: 403 })],
  ])
    await withFetch(replies, async (calls) => {
      const count = replies.length;
      await assert.rejects(api.snapshot());
      assert.equal(calls.length, count);
    });
});

test('a rejected mutation is never renewed or replayed', async () => {
  await withFetch([denied()], async (calls) => {
    await assert.rejects(
      api.saveTaskSettings({ maxConcurrentProfiles: 2 }, AbortSignal.timeout(1000)),
      /ADMIN_REQUIRED/,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, '/api/workspace/tasks/settings');
    assert.equal(calls[0]?.options?.method, 'POST');
  });
});
