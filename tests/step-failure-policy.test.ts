import test from 'node:test';
import assert from 'node:assert/strict';
import { postFailureRequiresEnding } from '../src/domain/step-failure-policy.js';

test('native submission response/result failure ends only the failed post attempt; transient and user controls do not', () => {
  for (const reason of [
    'ORIGINAL_SUBMISSION_RESPONSE_UNCONFIRMED:RESULT_PAGE',
    'ORIGINAL_SUBMISSION_RESPONSE_UNCONFIRMED:ACCEPTANCE_PARSE',
    'POST_EFFECT_TIMEOUT:SUBMIT',
    'PUBLISH_RESULT_UNCONFIRMED',
    'STORY_NATIVE_RESULT_CONFLICT',
    'STORY_ORIGINAL_OBSERVER_REQUIRED',
    'STORY_ORIGINAL_PAGE_REQUIRED',
    'OWNED_TAB_CLOSED',
    'UPLOAD_STAGE_ROOT_INVALID',
    'FACEBOOK_POST_EDITOR_CLOSED',
    'POST_HOME_PREPARATION_INTERRUPTED',
    'POST_BACKGROUND_CONFIGURATION_UNAVAILABLE',
    'POST_BACKGROUND_CHANGED',
    'POST_BACKGROUND_UNCONFIRMED',
    'POST_BACKGROUND_DOCUMENT_CHANGED',
    'locator.click: Timeout 15000ms exceeded.\nCall log: waiting for original control',
  ])
    assert.equal(postFailureRequiresEnding(reason), true, reason);
  for (const reason of [
    'WAITING_FOR_PROFILE_FOREGROUND',
    'USER_PAUSE',
    'USER_STOP',
    'ACTOR_BACKPRESSURE',
    'DOCUMENT_LOADING',
    'POST_HOME_PREPARATION_BLOCKED',
    'POST_BACKGROUND_LOADING',
    'POST_BACKGROUND_CONTRACT_REQUIRED',
    'POST_BACKGROUND_TARGET_MISMATCH',
    'page.waitForLoadState: Timeout 15000ms exceeded.',
  ])
    assert.equal(postFailureRequiresEnding(reason), false, reason);
});
