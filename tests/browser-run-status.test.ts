import test from 'node:test';
import assert from 'node:assert/strict';
import { browseRunStatus } from '../src/renderer/browse-run-status.js';
import type { ProfilePresentationStatus } from '../src/shared/presentation-recovery.js';

test('focus acknowledgement never alone marks browsing healthy; hidden, stale and nonadvancing evidence remains visible', () => {
  const monitor: ProfilePresentationStatus = {
    active: true,
    checkedAt: 20000,
    visibilityAt: 20000,
    visibility: 'visible',
    windowFocused: true,
    lastRecoveryAt: 19000,
    reportedFocused: true,
    error: null,
  };
  const base = {
    now: 20000,
    running: true,
    online: true,
    supported: true,
    monitor,
    progressSince: 19000,
    lastAdvancedAt: null,
  };
  assert.notEqual(browseRunStatus(base).tone, 'ok');
  assert.equal(browseRunStatus({ ...base, lastAdvancedAt: 19500 }).tone, 'ok');
  assert.equal(browseRunStatus({ ...base, progressSince: 9000 }).tone, 'warn');
  assert.equal(
    browseRunStatus({
      ...base,
      lastAdvancedAt: 19500,
      monitor: { ...monitor, visibility: 'hidden' },
    }).tone,
    'warn',
  );
  assert.equal(
    browseRunStatus({
      ...base,
      lastAdvancedAt: 19500,
      monitor: { ...monitor, visibilityAt: 10000 },
    }).tone,
    'warn',
  );
  assert.equal(
    browseRunStatus({ ...base, lastAdvancedAt: 19500, monitor: { ...monitor, checkedAt: 10000 } })
      .tone,
    'warn',
  );
  assert.equal(browseRunStatus({ ...base, online: false }).tone, 'warn');
  assert.notEqual(browseRunStatus({ ...base, running: false }).tone, 'ok');
});
