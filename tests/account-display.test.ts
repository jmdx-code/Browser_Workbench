import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { observeFacebookHomeAvatar } from '../src/domain/facebook-avatar-analysis.js';
import { AvatarObservation, isFacebookAvatarURL } from '../src/shared/account-display.js';
import { facebookDisplayInspectionProjection } from '../src/infrastructure/facebook-read-adapter.js';
import { validateProjection, type PageProjection } from '../src/shared/page-read.js';
import { ProfileInspectionService } from '../src/application/profile-inspection.js';
import { ProfileSchema } from '../src/shared/contracts.js';
import { inspectionAvatarURL } from '../src/renderer/inspection-presentation.js';

const resource = 'https://scontent.example.fbcdn.net/avatar.jpg?token=generated-fixture';
function page(): PageProjection {
  return {
    url: 'https://www.facebook.com/',
    timeOrigin: 1000,
    ready: 'complete',
    visibility: 'hidden',
    rows: facebookDisplayInspectionProjection.queries.map((q) => ({
      key: q.key,
      nodes:
        q.key === 'ownProfileControls'
          ? [{ tag: 'div', visible: true, text: '', attributes: { 'aria-label': '你的个人主页' } }]
          : q.key === 'ownProfileImages'
            ? [{ tag: 'image', visible: true, text: '', attributes: { 'xlink:href': resource } }]
            : [],
    })),
  };
}
function nodes(p: PageProjection, key: string) {
  const row = p.rows.find((r) => r.key === key);
  assert.ok(row);
  return row.nodes;
}
test('home avatar uses one scoped visible profile control and SVG or IMG resource; never grants identity', () => {
  const p = validateProjection(facebookDisplayInspectionProjection, page());
  const result = observeFacebookHomeAvatar(p);
  assert.deepEqual(result, {
    source: 'facebook-home-profile-control',
    url: resource,
    actingIdentityVerified: false,
  });
  for (const attr of ['href', 'src']) {
    const q = page();
    nodes(q, 'ownProfileImages')[0] = {
      tag: attr === 'src' ? 'img' : 'image',
      visible: true,
      text: '',
      attributes: { [attr]: resource },
    };
    assert.equal(observeFacebookHomeAvatar(q)?.url, resource);
  }
});
test('avatar rejects broad banner images, hidden or duplicate controls, login, other routes and incomplete documents', () => {
  for (const change of [
    (p: PageProjection) => {
      p.url = 'https://www.facebook.com/profile.php?id=123';
    },
    (p: PageProjection) => {
      p.url = 'https://www.facebook.com/checkpoint/';
    },
    (p: PageProjection) => {
      p.ready = 'interactive';
    },
    (p: PageProjection) => {
      nodes(p, 'loginForm').push({ tag: 'form', visible: false, text: '', attributes: {} });
    },
    (p: PageProjection) => {
      nodes(p, 'ownProfileControls').splice(0);
    },
    (p: PageProjection) => {
      const n = nodes(p, 'ownProfileControls')[0];
      assert.ok(n);
      n.visible = false;
    },
    (p: PageProjection) => {
      const n = nodes(p, 'ownProfileControls')[0];
      assert.ok(n);
      nodes(p, 'ownProfileControls').push({ ...n, visible: false });
    },
    (p: PageProjection) => {
      const n = nodes(p, 'ownProfileControls')[0];
      assert.ok(n);
      n.attributes['aria-label'] = 'Messenger';
    },
    (p: PageProjection) => {
      const n = nodes(p, 'ownProfileImages')[0];
      assert.ok(n);
      n.visible = false;
    },
    (p: PageProjection) => {
      const n = nodes(p, 'ownProfileImages')[0];
      assert.ok(n);
      nodes(p, 'ownProfileImages').push({ ...n });
    },
    (p: PageProjection) => {
      const n = nodes(p, 'ownProfileImages')[0];
      assert.ok(n);
      n.attributes.href = resource + '&different=1';
    },
  ]) {
    const p = page();
    change(p);
    assert.equal(observeFacebookHomeAvatar(p), null);
  }
});
test('avatar origins reject scripts, local addresses, credentials, alternate ports, fragments and suffix tricks', () => {
  assert.equal(isFacebookAvatarURL(resource), true);
  for (const value of [
    'javascript:alert(1)',
    'data:image/png;base64,AA==',
    'http://scontent.fbcdn.net/a',
    'https://127.0.0.1/a',
    'https://fbcdn.net.attacker.test/a',
    'https://scontent.fbcdn.net@attacker.test/a',
    'https://user@scontent.fbcdn.net/a',
    'https://scontent.fbcdn.net:444/a',
    'https://scontent.fbcdn.net/a#x',
    'https://attacker.test/a',
  ]) {
    assert.equal(isFacebookAvatarURL(value), false);
    assert.equal(
      AvatarObservation.safeParse({
        source: 'facebook-home-profile-control',
        url: value,
        actingIdentityVerified: false,
      }).success,
      false,
    );
  }
});
test('avatar observation is cleared on precise expiry, reconnect, invalidation and failed followup; account remains unknown', async () => {
  for (const action of ['expire', 'reconnect', 'cancel', 'fail']) {
    const id = randomUUID();
    let epoch = randomUUID(),
      time = 1000,
      fail = false;
    const service = new ProfileInspectionService(
      {
        connection: () => ({ profileId: id, connectionEpoch: epoch }),
        assertIdle: async () => {},
        read: async () => {
          if (fail) throw Error('private failure');
          return page();
        },
      },
      () => time,
    );
    service.request([id]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const row = service.get(id);
    assert.ok(row?.avatarObservation);
    assert.deepEqual(service.account(id), { state: 'unknown', id: null, name: null, avatar: null });
    row.avatarObservation.url = 'https://other.fbcdn.net/changed.jpg';
    assert.equal(service.get(id)?.avatarObservation?.url, resource);
    if (action === 'expire') time = 31000;
    if (action === 'reconnect') epoch = randomUUID();
    if (action === 'cancel') service.invalidate(id);
    if (action === 'fail') {
      fail = true;
      service.request([id]);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(service.get(id)?.avatarObservation, null);
    await service.close();
  }
});
test('renderer avatar rejects unavailable, foreign, offline, stale and logged-out observations', () => {
  const profile = ProfileSchema.parse({
    id: randomUUID(),
    alias: 'Generated',
    groupId: null,
    online: true,
    phase: 'PAUSED',
    synced: true,
    unresolved: 0,
    extensionVersion: '0.3.7',
    capabilities: [],
    account: { state: 'unknown', id: null, name: null, avatar: null },
  });
  const row = {
    profileId: profile.id,
    state: 'OBSERVED' as const,
    reason: 'ACTING_ACCOUNT_UNVERIFIED' as const,
    checkedAt: 1000,
    account: profile.account,
    avatarObservation: observeFacebookHomeAvatar(page()),
    nameObservation: null,
  };
  assert.equal(inspectionAvatarURL(profile, row, true, 1000), resource);
  assert.equal(inspectionAvatarURL(profile, row, false, 1000), null);
  assert.equal(inspectionAvatarURL({ ...profile, online: false }, row, true, 1000), null);
  assert.equal(inspectionAvatarURL(profile, { ...row, profileId: randomUUID() }, true, 1000), null);
  assert.equal(inspectionAvatarURL(profile, row, true, 31000), null);
  assert.equal(inspectionAvatarURL(profile, row, true, 999), null);
  assert.equal(
    inspectionAvatarURL(
      profile,
      { ...row, account: { ...row.account, state: 'logged-out' } },
      true,
      1000,
    ),
    null,
  );
});
