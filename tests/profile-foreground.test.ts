import test from 'node:test';
import assert from 'node:assert/strict';
import { profileForegroundGranted } from '../src/shared/profile-foreground.js';

test('foreground permission requires current negotiated profile focus, not browser model or a stale heartbeat', () => {
  const peer = {
    online: true,
    synced: true,
    capabilities: ['profile-foreground-v1'],
    profileWindowFocused: true,
    focusedWindowAt: 1000,
  };
  assert.equal(profileForegroundGranted(peer, 2000), true);
  for (const override of [
    { online: false },
    { synced: false },
    { capabilities: [] },
    { profileWindowFocused: false },
    { focusedWindowAt: undefined },
    { focusedWindowAt: NaN },
    { focusedWindowAt: 2001 },
    { focusedWindowAt: -2001 },
  ])
    assert.equal(profileForegroundGranted({ ...peer, ...override }, 2000), false);
});
