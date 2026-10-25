import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { readFacebookHomePreparation } from '../src/infrastructure/facebook-home-preparation.js';

test('home preparation observes only, refuses drafts, dialogs, hidden or unsupported pages and fences document changes', async () => {
  for (const condition of [
    'ready',
    'home',
    'empty-composer',
    'draft',
    'dialog',
    'hidden',
    'foreign',
    'changed',
    'cancelled',
  ]) {
    let reads = 0;
    const url =
      condition === 'home' || condition === 'empty-composer'
        ? 'https://www.facebook.com/'
        : condition === 'foreign'
          ? 'https://www.facebook.com/messages/'
          : 'https://www.facebook.com/reel/123';
    const page = {
      evaluate: async () =>
        ++reads === 1
          ? {
              url,
              timeOrigin: 100,
              ready: true,
              visible: condition !== 'hidden',
              blocked: condition === 'dialog' || condition === 'empty-composer',
              scrollY: 0,
              viewportHeight: 700,
              contentKey: null,
              video: null,
            }
          : {
              url,
              timeOrigin: condition === 'changed' ? 200 : 100,
              draftPresent: condition === 'draft',
              emptyComposerOnlyDialog: condition === 'empty-composer',
            },
    } as unknown as Page;
    const guard = () => {
      if (condition === 'cancelled' && reads) throw Error('CANCELLED');
    };
    const result = readFacebookHomePreparation(page, guard);
    if (condition === 'changed' || condition === 'cancelled')
      await assert.rejects(result, /DOCUMENT_CHANGED|CANCELLED/);
    else {
      const reading = await result;
      assert.equal(
        reading.safe,
        condition === 'ready' || condition === 'home' || condition === 'empty-composer',
      );
      assert.equal(
        reading.reason,
        condition === 'hidden'
          ? 'FACEBOOK_BROWSE_FOREGROUND_REQUIRED'
          : 'POST_HOME_PREPARATION_BLOCKED',
      );
    }
    assert.ok(reads <= 2);
  }
});
