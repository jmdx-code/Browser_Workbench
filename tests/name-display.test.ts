import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { observeFacebookHomeName } from '../src/domain/facebook-name-analysis.js';
import { facebookDisplayInspectionProjection } from '../src/infrastructure/facebook-read-adapter.js';
import { type PageProjection, validateProjection } from '../src/shared/page-read.js';
import { ProfileInspectionService } from '../src/application/profile-inspection.js';
import { ProfileInspections, inspectionResponse } from '../src/shared/profile-inspection.js';
import { ProfileSchema } from '../src/shared/contracts.js';
import { inspectionDisplayName } from '../src/renderer/inspection-presentation.js';

function page(): PageProjection {
  const data = {
    homeComposers: [
      { tag: 'div', visible: true, text: '', attributes: { 'aria-label': '创建帖子' } },
    ],
    composerProfileLinks: [
      {
        tag: 'a',
        visible: true,
        text: '',
        attributes: {
          'aria-label': 'Generated Name的时间线',
          href: 'https://www.facebook.com/profile.php?id=123',
        },
      },
    ],
    composerPrompts: [
      { tag: 'div', visible: true, text: 'Generated Name，分享你的新鲜事吧！', attributes: {} },
    ],
  };
  return {
    url: 'https://www.facebook.com/',
    ready: 'complete',
    visibility: 'hidden',
    timeOrigin: 1000,
    rows: facebookDisplayInspectionProjection.queries.map((q) => ({
      key: q.key,
      nodes: data[q.key as keyof typeof data] ?? [],
    })),
  };
}
function row(p: PageProjection, key: string) {
  const result = p.rows.find((r) => r.key === key);
  assert.ok(result);
  return result;
}

function firstNode(p: PageProjection, key: string) {
  const n = row(p, key).nodes[0];
  assert.ok(n);
  return n;
}

test('composer requires a unique visible region, matching timeline and prompt, with no identity authority', () => {
  const p = validateProjection(facebookDisplayInspectionProjection, page());
  assert.deepEqual(observeFacebookHomeName(p), {
    source: 'facebook-home-composer',
    name: 'Generated Name',
    actingIdentityVerified: false,
  });
  assert.deepEqual(
    observeFacebookHomeName({ ...p, ready: 'interactive' }),
    observeFacebookHomeName(p),
  );
  for (const change of [
    (p: PageProjection) => {
      p.ready = 'loading';
    },
    (p: PageProjection) => {
      p.url = 'https://www.facebook.com/me/';
    },
    (p: PageProjection) => {
      row(p, 'loginForm').nodes.push({ tag: 'form', visible: false, text: '', attributes: {} });
    },
    (p: PageProjection) => {
      firstNode(p, 'composerPrompts').text = 'Other，分享你的新鲜事吧！';
    },
    (p: PageProjection) => {
      firstNode(p, 'composerProfileLinks').attributes.href =
        'https://attacker.test/profile.php?id=123';
    },
    (p: PageProjection) => {
      firstNode(p, 'composerProfileLinks').attributes.href = '/profile.php?id=123&id=456';
    },
    (p: PageProjection) => {
      firstNode(p, 'composerProfileLinks').attributes.href = '/profile.php?id=123&extra=1';
    },
    (p: PageProjection) => {
      firstNode(p, 'composerProfileLinks').attributes['aria-label'] = '的时间线';
    },
  ]) {
    const p = page();
    change(p);
    assert.equal(observeFacebookHomeName(p), null);
  }
  for (const key of ['homeComposers', 'composerProfileLinks', 'composerPrompts']) {
    const p = page();
    firstNode(p, key).visible = false;
    assert.equal(observeFacebookHomeName(p), null);
    const q = page();
    row(q, key).nodes.push({ ...firstNode(q, key), visible: false });
    assert.equal(observeFacebookHomeName(q), null);
  }
});
test('name expires and clears on disconnect, cancellation and failed check; never alters the account', async () => {
  for (const action of ['expire', 'reconnect', 'cancel', 'fail', 'clock']) {
    const id = randomUUID();
    let epoch = randomUUID(),
      time = 1000,
      fail = false;
    const service = new ProfileInspectionService(
      {
        connection: () => ({ profileId: id, connectionEpoch: epoch }),
        assertIdle: async () => {},
        read: async () => {
          if (fail) throw Error('private');
          return page();
        },
      },
      () => time,
    );
    service.request([id]);
    await new Promise<void>((r) => setImmediate(r));
    const result = service.get(id);
    assert.ok(result?.nameObservation);
    result.nameObservation.name = 'Changed';
    assert.equal(service.get(id)?.nameObservation?.name, 'Generated Name');
    assert.equal(service.account(id).name, null);
    assert.equal(service.account(id).id, null);
    if (action === 'expire') time = 31000;
    if (action === 'clock') time = 999;
    if (action === 'reconnect') epoch = randomUUID();
    if (action === 'cancel') service.invalidate(id);
    if (action === 'fail') {
      fail = true;
      service.request([id]);
      await new Promise<void>((r) => setImmediate(r));
    }
    assert.equal(service.get(id)?.nameObservation, null);
    await service.close();
  }
});
test('inspection HTTP versions omit unsupported fields and preserve legacy strict clients', () => {
  const profileId = randomUUID();
  const input = {
    results: [
      {
        profileId,
        state: 'OBSERVED',
        reason: 'ACTING_ACCOUNT_UNVERIFIED',
        checkedAt: 1000,
        account: { state: 'unknown', id: null, name: null, avatar: null },
        nameObservation: observeFacebookHomeName(page()),
      },
    ],
  };
  for (const version of [undefined, 'garbage', '0'])
    assert.equal(
      Object.hasOwn(inspectionResponse(input, version).results[0] ?? {}, 'nameObservation'),
      false,
    );
  const v1 = inspectionResponse(input, '1');
  assert.equal(Object.hasOwn(v1.results[0] ?? {}, 'avatarObservation'), true);
  assert.equal(Object.hasOwn(v1.results[0] ?? {}, 'nameObservation'), false);
  const v2 = ProfileInspections.parse(inspectionResponse(input, '2'));
  assert.equal(v2.results[0]?.nameObservation?.name, 'Generated Name');
});
test('name display rejects stale or foreign observations and never changes profile aliases', () => {
  const profile = ProfileSchema.parse({
    id: randomUUID(),
    alias: 'Browser alias',
    groupId: null,
    online: true,
    phase: 'PAUSED',
    synced: true,
    unresolved: 0,
    extensionVersion: '0.3.7',
    capabilities: [],
    account: { state: 'unknown', id: null, name: null, avatar: null },
  });
  const observed = ProfileInspections.parse({
    results: [
      {
        profileId: profile.id,
        state: 'OBSERVED',
        reason: 'ACTING_ACCOUNT_UNVERIFIED',
        checkedAt: 1000,
        account: profile.account,
        nameObservation: observeFacebookHomeName(page()),
      },
    ],
  }).results[0];
  assert.ok(observed);
  assert.equal(inspectionDisplayName(profile, observed, true, 1000), 'Generated Name');
  for (const time of [999, 31000])
    assert.equal(inspectionDisplayName(profile, observed, true, time), null);
  assert.equal(inspectionDisplayName(profile, observed, false, 1000), null);
  assert.equal(inspectionDisplayName({ ...profile, online: false }, observed, true, 1000), null);
  assert.equal(
    inspectionDisplayName(profile, { ...observed, profileId: randomUUID() }, true, 1000),
    null,
  );
  assert.equal(profile.alias, 'Browser alias');
  assert.equal(profile.account.name, null);
});
