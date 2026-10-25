import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceTarget } from '../src/domain/facebook-audience.js';
import {
  ComposerAudienceReading,
  privacyTargets,
  type ComposerAudience,
} from '../src/shared/facebook-audience.js';

const reading = (patch: Partial<ComposerAudience> = {}): ComposerAudience =>
  ComposerAudienceReading.parse({
    url: 'https://www.facebook.com/',
    timeOrigin: 1000,
    ready: 'complete',
    phase: 'COMPOSER',
    audience: null,
    draftEmpty: true,
    openEnabled: true,
    selfSelected: false,
    selfEnabled: true,
    defaultChecked: false,
    confirmEnabled: true,
    ...patch,
  });
test('fixed private configuration chooses only observed controls on an empty original editor', () => {
  assert.deepEqual(
    audienceTarget(reading({ ready: 'interactive' }), 'OPEN_AUDIENCE'),
    audienceTarget(reading(), 'OPEN_AUDIENCE'),
  );
  assert.deepEqual(audienceTarget(reading(), 'OPEN_AUDIENCE'), {
    css: privacyTargets.OPEN_AUDIENCE.css,
    scope: privacyTargets.OPEN_AUDIENCE.scope,
  });
  assert.equal(audienceTarget(reading({ audience: 'SELF' }), 'OPEN_AUDIENCE'), null);
  assert.deepEqual(audienceTarget(reading({ phase: 'MENU' }), 'SELECT_SELF'), {
    css: privacyTargets.SELECT_SELF.css,
    scope: privacyTargets.SELECT_SELF.scope,
  });
  assert.equal(audienceTarget(reading({ phase: 'MENU', selfSelected: true }), 'SELECT_SELF'), null);
});
test('confirmation cannot alter default privacy, proceed during loading, or overwrite a foreign draft', () => {
  const menu = reading({ phase: 'MENU', selfSelected: true });
  assert.ok(audienceTarget(menu, 'CONFIRM_AUDIENCE'));
  for (const patch of [
    { defaultChecked: true },
    { defaultChecked: null },
    { selfSelected: false },
    { confirmEnabled: false },
    { draftEmpty: false },
    { ready: 'loading' as const },
    { phase: 'UNAVAILABLE' as const },
  ])
    assert.equal(audienceTarget({ ...menu, ...patch }, 'CONFIRM_AUDIENCE'), null);
  for (const purpose of ['OPEN_AUDIENCE', 'SELECT_SELF', 'CONFIRM_AUDIENCE'] as const)
    assert.equal(audienceTarget(reading({ phase: 'MENU', draftEmpty: false }), purpose), null);
});
