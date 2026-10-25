import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ProfileInspectionService } from '../src/application/profile-inspection.js';
import type { ProfileInspectionPort } from '../src/domain/profile-inspection.js';
import { facebookIdentityProjection } from '../src/infrastructure/facebook-read-adapter.js';
import type { PageProjection } from '../src/shared/page-read.js';
import { InspectProfiles } from '../src/shared/profile-inspection.js';
import { inspectedFacebookAccount } from '../src/domain/facebook-page-analysis.js';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
test('current Reels menu name is display only, with no account ID or login grant, and expires with its connection', async () => {
  for (const stale of [false, true]) {
    const f = fixture();
    const id = f.ids[0]!;
    f.port.readDisplay = async (_connection, guard) => {
      await guard();
      return {
        page: page('https://www.facebook.com/reel/123'),
        actor: {
          version: 1,
          source: 'CometSettingsDropdownTriggerQuery',
          accountId: '123',
          name: 'Current Menu Name',
          type: 'User',
          checkedAt: stale ? 0 : 1000,
        },
      };
    };
    f.setTime(stale ? 31000 : 1000);
    f.service.request([id]);
    await settle();
    assert.equal(f.service.account(id).state, 'unknown');
    assert.equal(f.service.account(id).id, null);
    assert.equal(f.service.account(id).name, stale ? null : 'Current Menu Name');
    assert.equal(f.service.get(id)?.nameObservation, null);
    f.connections.delete(id);
    assert.equal(f.service.account(id).name, null);
    await f.service.close();
  }
});

test('automatic display refresh is bounded, coalesces pending reads and withdraws on disconnect', async () => {
  const f = fixture();
  const id = f.ids[0]!;
  f.service.observeConnections([id]);
  await settle();
  assert.equal(f.calls.filter((call) => call.startsWith('read:')).length, 1);
  f.setTime(120999);
  f.service.observeConnections([id]);
  await settle();
  assert.equal(f.calls.filter((call) => call.startsWith('read:')).length, 1);
  f.setTime(121001);
  f.service.observeConnections([id]);
  f.service.observeConnections([id]);
  await settle();
  assert.equal(f.calls.filter((call) => call.startsWith('read:')).length, 2);
  f.connections.delete(id);
  assert.equal(f.service.account(id).avatar, null);
  assert.equal(f.service.get(id)?.reason, 'INSPECTION_CONNECTION_CHANGED');
  await f.service.close();
});
function page(url = 'https://www.facebook.com/'): PageProjection {
  return {
    url,
    timeOrigin: 1000,
    ready: 'complete',
    visibility: 'visible',
    rows: facebookIdentityProjection.queries.map((q) => ({ key: q.key, nodes: [] })),
  };
}
function fixture(count = 1) {
  const ids = Array.from({ length: count }, () => randomUUID());
  const connections = new Map<string, { profileId: string; connectionEpoch: string }>(
    ids.map((profileId) => [profileId, { profileId, connectionEpoch: randomUUID() }]),
  );
  let time = 1000;
  const calls: string[] = [];
  const port: ProfileInspectionPort = {
    connection: (id) => connections.get(id) ?? null,
    assertIdle: async (c) => {
      calls.push('idle:' + c.profileId);
    },
    read: async (c, guard) => {
      await guard();
      calls.push('read:' + c.profileId);
      return page();
    },
  };
  const service = new ProfileInspectionService(port, () => time);
  return {
    ids,
    connections,
    port,
    calls,
    service,
    elapse: () => {
      time += 30_001;
    },
    setTime: (value: number) => {
      time = value;
    },
  };
}

test('connection inspection is once per epoch, respects manual work and never loops on a blocked profile', async () => {
  const f = fixture(2),
    [first, blocked] = f.ids;
  assert.ok(first && blocked);
  f.port.assertIdle = async (connection) => {
    f.calls.push('idle:' + connection.profileId);
    if (connection.profileId === blocked) throw Error('INSPECTION_NATIVE_REVIEW_REQUIRED');
  };
  f.service.request([first]);
  await settle();
  f.service.observeConnections(f.ids);
  await settle();
  const before = f.calls.length;
  f.elapse();
  f.service.observeConnections(f.ids);
  await settle();
  assert.equal(f.calls.length, before);
  assert.equal(f.calls.filter((call) => call === 'read:' + first).length, 1);
  assert.equal(f.service.get(blocked)?.reason, 'INSPECTION_NATIVE_REVIEW_REQUIRED');
  assert.ok(!f.calls.includes('read:' + blocked));
  f.connections.set(first, { profileId: first, connectionEpoch: randomUUID() });
  f.service.observeConnections(f.ids);
  await settle();
  assert.equal(f.calls.filter((call) => call === 'read:' + first).length, 2);
  await f.service.close();
  f.service.observeConnections(f.ids);
  assert.equal(f.calls.length, before + 2);
});

function nativeDisplayPage() {
  const observed = page();
  for (const key of [
    'homeComposers',
    'composerProfileLinks',
    'ownProfileControls',
    'ownProfileImages',
  ])
    observed.rows.push({
      key,
      nodes: [
        {
          tag: key === 'ownProfileImages' ? 'image' : 'a',
          text: '',
          visible: true,
          attributes:
            key === 'composerProfileLinks'
              ? { href: '/profile.php?id=123456' }
              : key === 'ownProfileControls'
                ? { 'aria-label': 'Your profile' }
                : key === 'ownProfileImages'
                  ? { href: 'https://static.xx.fbcdn.net/avatar.png' }
                  : {},
        },
      ],
    });
  return observed;
}
const displayActor = () => ({
  version: 1 as const,
  source: 'CometSettingsDropdownTriggerQuery' as const,
  accountId: '123456',
  name: 'Current account',
  type: 'User' as const,
  checkedAt: 1000,
});

test('closed homepage keeps cached display without granting identity and retries when a homepage becomes available', async () => {
  const f = fixture(),
    id = f.ids[0]!;
  f.port.readDisplay = async () => ({ page: nativeDisplayPage(), actor: displayActor() });
  f.service.observeConnections([id]);
  await settle();
  f.port.readDisplay = async () => {
    throw Error('INSPECTION_DOCUMENT_NOT_READY');
  };
  f.service.request([id]);
  await settle();
  assert.equal(f.service.account(id).name, 'Current account');
  assert.equal(f.service.account(id).id, null);
  f.setTime(15999);
  f.service.observeConnections([id]);
  await settle();
  assert.equal(f.service.get(id)?.state, 'FAILED');
  f.port.readDisplay = async () => ({
    page: nativeDisplayPage(),
    actor: { ...displayActor(), checkedAt: 16001 },
  });
  f.setTime(16001);
  f.service.observeConnections([id]);
  await settle();
  assert.equal(f.service.account(id).id, '123456');
  await f.service.close();
});

test('native display withdraws login and ID on expiry while retaining only labels in the same connection', async () => {
  const f = fixture(),
    id = f.ids[0];
  assert.ok(id);
  f.port.readDisplay = async (_connection, guard) => {
    await guard();
    return { page: nativeDisplayPage(), actor: displayActor() };
  };
  f.service.observeConnections([id]);
  await settle();
  assert.equal(f.service.account(id).state, 'logged-in');
  assert.equal(f.service.account(id).id, '123456');
  assert.equal(f.service.account(id).avatar, 'https://static.xx.fbcdn.net/avatar.png');
  f.elapse();
  assert.deepEqual(f.service.account(id), {
    state: 'unknown',
    id: null,
    name: 'Current account',
    avatar: 'https://static.xx.fbcdn.net/avatar.png',
  });
  f.connections.set(id, { profileId: id, connectionEpoch: randomUUID() });
  assert.deepEqual(f.service.account(id), { state: 'unknown', id: null, name: null, avatar: null });
  await f.service.close();
});

test('native display rejects mismatched creator, stale actor, incomplete document and login/checkpoint contradictions', () => {
  assert.equal(
    inspectedFacebookAccount(nativeDisplayPage(), displayActor(), 1000).account.id,
    '123456',
  );
  for (const kind of ['mismatch', 'stale', 'future', 'loading', 'checkpoint', 'login']) {
    const observed = nativeDisplayPage(),
      actor = displayActor();
    let at = 1000;
    if (kind === 'mismatch') actor.accountId = '99';
    if (kind === 'stale') at = 31000;
    if (kind === 'future') at = 999;
    if (kind === 'loading') observed.ready = 'interactive';
    if (kind === 'checkpoint') observed.url = 'https://www.facebook.com/checkpoint/';
    if (kind === 'login') {
      observed.url = 'https://www.facebook.com/login/';
      for (const key of ['loginForm', 'loginEmail', 'loginPassword'])
        observed.rows
          .find((row) => row.key === key)
          ?.nodes.push({ tag: 'input', visible: true, text: '', attributes: {} });
    }
    assert.equal(inspectedFacebookAccount(observed, actor, at).account.id, null, kind);
  }
});

test('explicit refresh reaches read port once, duplicate request coalesces and personal link never grants acting identity', async () => {
  const f = fixture(),
    id = f.ids[0];
  assert.ok(id);
  f.port.read = async () => {
    const result = page('https://www.facebook.com/profile.php?id=123');
    result.rows
      .find((r) => r.key === 'accountLinks')
      ?.nodes.push({
        tag: 'a',
        visible: true,
        text: 'Someone',
        attributes: { href: '/profile.php?id=123' },
      });
    f.calls.push('read');
    return result;
  };
  assert.equal(f.service.request([id, id]).length, 1);
  f.service.request([id]);
  await settle();
  assert.equal(f.calls.filter((c) => c === 'read').length, 1);
  assert.equal(f.service.get(id)?.state, 'OBSERVED');
  assert.deepEqual(f.service.account(id), { state: 'unknown', id: null, name: null, avatar: null });
  await f.service.close();
});

test('visible login form and checkpoint are displayed, expire and disappear on connection replacement', async () => {
  for (const [url, expected] of [
    ['https://www.facebook.com/login/', 'logged-out'],
    ['https://www.facebook.com/checkpoint/', 'verification'],
  ]) {
    const f = fixture(),
      id = f.ids[0];
    assert.ok(id);
    f.port.read = async () => {
      const result = page(url);
      for (const key of ['loginForm', 'loginEmail', 'loginPassword'])
        result.rows
          .find((r) => r.key === key)
          ?.nodes.push({ tag: 'input', text: '', visible: true, attributes: {} });
      return result;
    };
    f.service.request([id]);
    await settle();
    assert.equal(f.service.account(id).state, expected);
    f.elapse();
    assert.equal(f.service.account(id).state, 'unknown');
    assert.equal(f.service.get(id)?.reason, 'INSPECTION_EXPIRED');
    f.connections.set(id, { profileId: id, connectionEpoch: randomUUID() });
    assert.equal(f.service.get(id)?.reason, 'INSPECTION_CONNECTION_CHANGED');
    await f.service.close();
  }
});

test('global budget is two while each profile remains serial and offline requests do not read', async () => {
  const f = fixture(4);
  let running = 0,
    peak = 0;
  const releases: (() => void)[] = [];
  f.port.read = async (_c, guard) => {
    await guard();
    peak = Math.max(peak, ++running);
    await new Promise<void>((resolve) => releases.push(resolve));
    await guard();
    running--;
    return page();
  };
  const offline = randomUUID();
  assert.equal(f.service.request([...f.ids, offline]).at(-1)?.reason, 'PROFILE_OFFLINE');
  await settle();
  assert.equal(running, 2);
  assert.equal(releases.length, 2);
  releases.splice(0).forEach((release) => release());
  await settle();
  assert.equal(running, 2);
  assert.equal(peak, 2);
  releases.splice(0).forEach((release) => release());
  await settle();
  assert.equal(f.calls.length, 4);
  await f.service.close();
});

test('stop invalidates waiting read synchronously, late result is discarded and same-profile retry waits for release', async () => {
  const f = fixture(),
    id = f.ids[0];
  assert.ok(id);
  let release = () => {};
  f.port.read = async (_c, guard) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await guard();
    return page();
  };
  f.service.request([id]);
  await settle();
  f.service.invalidate(id);
  assert.equal(f.service.request([id])[0]?.reason, 'INSPECTION_RELEASE_PENDING');
  release();
  await settle();
  assert.equal(f.service.get(id)?.reason, 'INSPECTION_CANCELLED');
  assert.equal(f.service.account(id).state, 'unknown');
  await f.service.close();
});

test('old epoch read cannot overwrite replacement or consume new epoch ownership', async () => {
  const f = fixture(),
    id = f.ids[0];
  assert.ok(id);
  let release = () => {};
  f.port.read = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return page('https://www.facebook.com/checkpoint/');
  };
  f.service.request([id]);
  await settle();
  f.connections.set(id, { profileId: id, connectionEpoch: randomUUID() });
  assert.equal(f.service.request([id])[0]?.reason, 'INSPECTION_RELEASE_PENDING');
  release();
  await settle();
  assert.equal(f.service.account(id).state, 'unknown');
  assert.equal(f.service.get(id)?.reason, 'INSPECTION_CONNECTION_CHANGED');
  await f.service.close();
});

test('failed idle/release and foreign documents cannot publish observations or automatically retry', async () => {
  for (const phase of ['idle', 'read', 'foreign']) {
    const f = fixture(),
      id = f.ids[0];
    assert.ok(id);
    if (phase === 'idle')
      f.port.assertIdle = async () => {
        throw Error('INSPECTION_NATIVE_REVIEW_REQUIRED');
      };
    else
      f.port.read = async () => {
        if (phase === 'read') throw Error('INSPECTION_READ_RELEASE_UNCONFIRMED');
        return page('https://evil.test/');
      };
    f.service.request([id]);
    await settle();
    assert.equal(f.service.get(id)?.state, 'FAILED');
    assert.equal(f.service.account(id).state, 'unknown');
    const before = f.calls.length;
    await settle();
    assert.equal(f.calls.length, before);
    await f.service.close();
  }
});

test('shutdown cancels queued work, rejects new requests and cannot accept an in-flight observation', async () => {
  const f = fixture(3);
  const releases: (() => void)[] = [];
  f.port.read = async () => {
    await new Promise<void>((resolve) => releases.push(resolve));
    return page();
  };
  f.service.request(f.ids);
  await settle();
  const closing = f.service.close();
  assert.throws(() => f.service.request(f.ids), /CLOSED/);
  releases.forEach((release) => release());
  await closing;
  assert.equal(f.calls.length, 2);
  for (const id of f.ids) assert.equal(f.service.account(id).state, 'unknown');
});

test('public inspect input rejects arbitrary URL, projection, account and native commands', () => {
  const profileIds = [randomUUID()];
  for (const extra of [
    { url: 'https://evil.test/' },
    { projection: {} },
    { accountId: '123' },
    { method: 'Runtime.evaluate' },
  ])
    assert.equal(InspectProfiles.safeParse({ profileIds, ...extra }).success, false);
  assert.equal(InspectProfiles.safeParse({ profileIds: [] }).success, false);
});

test('observation expires at the exact boundary and clock rollback cannot revive an expired account state', async () => {
  for (const nextTime of [31_000, 999]) {
    const f = fixture(),
      id = f.ids[0];
    assert.ok(id);
    f.port.read = async () => page('https://www.facebook.com/checkpoint/');
    f.service.request([id]);
    await settle();
    assert.equal(f.service.account(id).state, 'verification');
    f.setTime(nextTime);
    assert.equal(f.service.get(id)?.reason, 'INSPECTION_EXPIRED');
    f.setTime(1000);
    assert.equal(f.service.account(id).state, 'unknown');
    assert.equal(f.service.get(id)?.reason, 'INSPECTION_EXPIRED');
    await f.service.close();
  }
});

test('returned unknown accounts are independent values even on offline, cancelled and expired paths', async () => {
  const f = fixture(),
    id = f.ids[0];
  assert.ok(id);
  const detached = f.service.account(randomUUID());
  detached.name = 'Injected';
  assert.equal(f.service.account(randomUUID()).name, null);
  f.service.request([id]);
  await settle();
  f.elapse();
  const expired = f.service.get(id);
  assert.ok(expired);
  expired.account.name = 'Injected';
  assert.equal(f.service.get(id)?.account.name, null);
  f.service.invalidate(id);
  const cancelled = f.service.get(id);
  assert.ok(cancelled);
  cancelled.account.name = 'Injected';
  assert.equal(f.service.get(id)?.account.name, null);
  await f.service.close();
});

test('native close failures stay unconfirmed and public errors never expose page, path or credential details', async () => {
  for (const [message, expected] of [
    ['FACEBOOK_READ_TAB_CLOSE_UNCONFIRMED', 'INSPECTION_READ_RELEASE_UNCONFIRMED'],
    ['FACEBOOK_READ_STOP_UNCONFIRMED', 'INSPECTION_READ_RELEASE_UNCONFIRMED'],
    ['KERNEL_RPC_RESULT_UNKNOWN', 'INSPECTION_TRANSPORT_UNCONFIRMED'],
    ['KERNEL_DEBUGGER_DETACHED', 'INSPECTION_CONTROL_INTERRUPTED'],
    ['PAGE_READ_FOREIGN_DOCUMENT', 'INSPECTION_DOCUMENT_CHANGED'],
    [
      'Error from page /profile.php?id=private; local path C:/private; token=secret',
      'INSPECTION_FAILED',
    ],
    ['INSPECTION_FAILED: private details', 'INSPECTION_FAILED'],
  ]) {
    const f = fixture(),
      id = f.ids[0];
    assert.ok(id);
    f.port.read = async () => {
      throw Error(message);
    };
    f.service.request([id]);
    await settle();
    assert.equal(f.service.get(id)?.state, 'FAILED');
    assert.equal(f.service.get(id)?.reason, expected);
    assert.equal(f.service.account(id).state, 'unknown');
    await f.service.close();
  }
});

test('temporary busy inspection retries automatically once the same browser becomes idle', async () => {
  const f = fixture(),
    id = f.ids[0]!;
  let busy = true;
  f.port.assertIdle = async () => {
    if (busy) throw Error('KERNEL_PEER_NOT_IDLE');
  };
  f.service.observeConnections([id]);
  await settle();
  assert.equal(f.service.get(id)?.reason, 'INSPECTION_PROFILE_NOT_IDLE');
  busy = false;
  f.setTime(302_000);
  f.service.observeConnections([id]);
  await settle();
  assert.equal(f.calls.filter((call) => call.startsWith('read:')).length, 1);
  await f.service.close();
});
