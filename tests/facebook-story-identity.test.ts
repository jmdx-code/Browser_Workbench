import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { readCurrentFacebookStoryIdentity } from '../src/infrastructure/facebook-story-identity.js';

const document = {
  url: 'https://www.facebook.com/stories/create/',
  timeOrigin: 120,
  ready: 'complete',
};
const creator = {
  url: document.url,
  ready: 'complete',
  actor: {
    version: 1,
    source: 'CometSettingsDropdownTriggerQuery',
    accountId: '123',
    name: 'Generated fixture',
    type: 'User',
    checkedAt: 500,
  },
};
function page(values: unknown[]) {
  return {
    evaluate: async () =>
      structuredClone({ before: values[0], current: values[1], after: values[2] }),
  } as unknown as Page;
}
test('story identity fences both document reads and preserves the existing guard on every await', async () => {
  const parsed = { ...document, ready: 'interactive' };
  assert.equal(
    (
      await readCurrentFacebookStoryIdentity(
        page([parsed, { ...creator, ready: 'interactive' }, parsed]),
        () => {},
      )
    ).actor.accountId,
    '123',
  );
  let guards = 0;
  const result = await readCurrentFacebookStoryIdentity(page([document, creator, document]), () => {
    guards++;
  });
  assert.equal(guards, 2);
  assert.equal(result.actor.accountId, '123');
  assert.equal(result.transport, 'document-preload');
  guards = 0;
  await assert.rejects(
    readCurrentFacebookStoryIdentity(page([document, creator, document]), () => {
      if (++guards === 2) throw Error('OWNER_REVOKED');
    }),
    /OWNER_REVOKED/,
  );
});
test('story identity never accepts navigation, incomplete documents or a missing current creator', async () => {
  for (const values of [
    [document, { ...creator, actor: null }, document],
    [document, creator, { ...document, timeOrigin: 121 }],
    [document, creator, { ...document, url: 'https://www.facebook.com/' }],
    [{ ...document, ready: 'loading' }, creator, document],
  ])
    await assert.rejects(readCurrentFacebookStoryIdentity(page(values), () => {}));
});
