import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphAvatar } from '../src/infrastructure/graph-avatar.js';

test('avatar lookups coalesce and cache; failed/silhouette responses never become usable images', async () => {
  let requests = 0,
    time = 1000;
  const request: typeof fetch = async (input, init) => {
    requests++;
    assert.equal(new URL(String(input)).origin, 'https://graph.facebook.com');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer generated-owned-token');
    return new Response(
      JSON.stringify({
        data: { url: 'https://static.xx.fbcdn.net/avatar.png', is_silhouette: false },
      }),
      { status: 200 },
    );
  };
  const avatars = new GraphAvatar(
    () => 'generated-owned-token',
    request,
    () => time,
  );
  const results = await Promise.all([avatars.lookup('123'), avatars.lookup('123')]);
  assert.deepEqual(results, [
    'https://static.xx.fbcdn.net/avatar.png',
    'https://static.xx.fbcdn.net/avatar.png',
  ]);
  await avatars.lookup('123');
  assert.equal(requests, 1);
  time += 6 * 3600000 + 1;
  await avatars.lookup('123');
  assert.equal(requests, 2);
  assert.equal(await avatars.lookup('../private'), null);
  const silhouettes = new GraphAvatar(
    () => 'generated',
    async () =>
      new Response(
        JSON.stringify({
          data: { url: 'https://static.xx.fbcdn.net/default.png', is_silhouette: true },
        }),
      ),
  );
  assert.equal(await silhouettes.lookup('123'), null);
  const failed = new GraphAvatar(
    () => 'generated',
    async () => {
      throw Error('generated request failure');
    },
  );
  assert.equal(await failed.lookup('123'), null);
});
