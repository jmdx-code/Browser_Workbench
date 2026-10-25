import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import {
  readCurrentFacebookBrowseIdentity,
  readCurrentFacebookBrowseSample,
} from '../src/infrastructure/facebook-browse-identity.js';

test('browse actor and document are sampled atomically without repeated transport waits; missing identity or revoked owner cannot authorize browsing', async () => {
  const sample = {
    url: 'https://www.facebook.com/watch/',
    ready: 'complete',
    timeOrigin: 100,
    actor: {
      version: 1,
      source: 'CometSettingsDropdownTriggerQuery',
      accountId: '123',
      name: '生成身份',
      type: 'User',
      checkedAt: 1000,
    },
  };
  let reads = 0;
  const page = {
    evaluate: async () => {
      reads++;
      return structuredClone(sample);
    },
  } as unknown as Page;
  const result = await readCurrentFacebookBrowseIdentity(page, () => {});
  assert.equal(reads, 1);
  assert.equal(result.actor.accountId, '123');
  assert.deepEqual(result.document, { url: sample.url, ready: 'complete', timeOrigin: 100 });
  const recovery = await readCurrentFacebookBrowseIdentity(
    {
      evaluate: async () => ({
        ...sample,
        url: 'https://www.facebook.com/marketplace/ineligible/',
      }),
    } as unknown as Page,
    () => {},
  );
  assert.equal(recovery.actor.accountId, '123');
  let guards = 0;
  await assert.rejects(
    readCurrentFacebookBrowseIdentity(page, () => {
      if (++guards === 2) throw Error('OWNER_REVOKED_DURING_READ');
    }),
    /OWNER_REVOKED/,
  );
  for (const invalid of [
    { ...sample, actor: null },
    { ...sample, url: 'https://outside.example/' },
    { ...sample, ready: 'loading' },
  ]) {
    await assert.rejects(
      readCurrentFacebookBrowseIdentity(
        { evaluate: async () => invalid } as unknown as Page,
        () => {},
      ),
    );
  }
});

test('a single guarded sample binds the visible page and fresh actor; loading waits, mixed documents reject', async () => {
  const sample = {
    page: {
      url: 'https://www.facebook.com/reels/',
      timeOrigin: 100,
      ready: true,
      visible: true,
      blocked: false,
      scrollY: 0,
      viewportHeight: 900,
      contentKey: 'video',
      video: null,
    },
    identity: {
      url: 'https://www.facebook.com/reels/',
      timeOrigin: 100,
      ready: 'complete',
      actor: {
        version: 1,
        source: 'CometSettingsDropdownTriggerQuery',
        accountId: '123',
        name: '生成身份',
        type: 'User',
        checkedAt: 1000,
      },
    },
  };
  let calls = 0;
  const page = {
    evaluate: async () => {
      calls++;
      return structuredClone(sample);
    },
  } as unknown as Page;
  assert.equal((await readCurrentFacebookBrowseSample(page, () => {})).actor?.accountId, '123');
  assert.equal(calls, 1);
  sample.identity.timeOrigin = 200;
  await assert.rejects(
    readCurrentFacebookBrowseSample(page, () => {}),
    /DOCUMENT_CHANGED/,
  );
  sample.page.ready = false;
  assert.equal((await readCurrentFacebookBrowseSample(page, () => {})).actor, null);
  let guards = 0;
  await assert.rejects(
    readCurrentFacebookBrowseSample(page, () => {
      if (++guards === 2) throw Error('OWNER_REVOKED');
    }),
    /OWNER_REVOKED/,
  );
});
