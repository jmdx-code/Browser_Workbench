import test from 'node:test';
import assert from 'node:assert/strict';
import { decideStoryFriendsPrivacy } from '../src/domain/facebook-story-privacy.js';
import type { StoryPrivacy } from '../src/shared/facebook-story-privacy.js';

const menu: StoryPrivacy = {
  phase: 'MENU',
  draftSelection: 'PUBLIC',
  openEnabled: false,
  friendsEnabled: true,
  saveEnabled: true,
  cancelEnabled: true,
};
const closed: StoryPrivacy = { ...menu, phase: 'CLOSED', draftSelection: null, openEnabled: true };
test('Friends story workflow distinguishes saved re-open from a selected draft and never broadens to Public', () => {
  assert.equal(decideStoryFriendsPrivacy('OPEN_INITIAL', closed).kind, 'action');
  const select = decideStoryFriendsPrivacy('SELECT_FRIENDS', menu);
  assert.equal(select.kind, 'action');
  if (select.kind === 'action')
    assert.equal(select.target.css, '[data-wb-story-privacy-friends="1"]');
  assert.throws(() => decideStoryFriendsPrivacy('SAVE', menu), /FRIENDS_AUDIENCE_UNCONFIRMED/);
  const friends = { ...menu, draftSelection: 'FRIENDS' as const };
  const save = decideStoryFriendsPrivacy('SAVE', friends);
  assert.equal(save.kind === 'action' && save.action, 'save');
  const reopen = decideStoryFriendsPrivacy('OPEN_SAVED', closed);
  assert.equal(reopen.kind === 'action' && reopen.action, 'open');
  assert.throws(
    () => decideStoryFriendsPrivacy('CLOSE_VERIFIED', menu),
    /FRIENDS_AUDIENCE_UNCONFIRMED/,
  );
  const close = decideStoryFriendsPrivacy('CLOSE_VERIFIED', friends);
  assert.equal(close.kind === 'action' && close.action, 'close');
  assert.equal(decideStoryFriendsPrivacy('READY', closed).kind, 'ready');
});
test('already Friends is closed without a redundant Save; unavailable or disabled controls never become ready', () => {
  const result = decideStoryFriendsPrivacy('SELECT_FRIENDS', {
    ...menu,
    draftSelection: 'FRIENDS',
  });
  assert.equal(result.kind === 'action' && result.action, 'close');
  assert.equal(
    decideStoryFriendsPrivacy('SAVE', { ...menu, draftSelection: 'FRIENDS', saveEnabled: false })
      .kind,
    'wait',
  );
  assert.equal(decideStoryFriendsPrivacy('READY', null).kind, 'wait');
  assert.equal(decideStoryFriendsPrivacy('READY', { ...menu, phase: 'UNAVAILABLE' }).kind, 'wait');
  assert.throws(() => decideStoryFriendsPrivacy('READY', menu), /CHANGED_AFTER_VERIFICATION/);
  assert.throws(() => decideStoryFriendsPrivacy('CLOSE_VERIFIED', closed), /DIALOG_CLOSED/);
  assert.throws(() => decideStoryFriendsPrivacy('OPEN_INITIAL', menu), /UNEXPECTED_DIALOG/);
});
