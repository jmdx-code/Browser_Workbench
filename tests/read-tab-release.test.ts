import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { releaseFacebookReadTab } from '../src/application/read-tab-release.js';
import { assertReadTabUnassociated } from '../src/domain/read-tab-protection.js';
import { observeFacebookSelfProfile } from '../src/domain/facebook-page-analysis.js';
import { facebookSelfProfileProjection } from '../src/infrastructure/facebook-read-adapter.js';
import { validateProjection, type PageProjection } from '../src/shared/page-read.js';
import type { KernelState, TabProof } from '../src/shared/kernel-state.js';

function setup() {
  const proof: TabProof = {
    ownershipId: randomUUID(),
    profileId: randomUUID(),
    browserSessionEpoch: randomUUID(),
    tabId: 9,
    targetId: 'native-target',
  };
  const state: KernelState = {
    version: 1,
    profileId: proof.profileId,
    browserSessionEpoch: proof.browserSessionEpoch,
    operations: [],
    tabs: [
      {
        ownershipId: proof.ownershipId,
        url: 'https://www.facebook.com/',
        state: 'READY',
        proof,
        reason: 'CREATED',
      },
    ],
  };
  const calls: string[] = [];
  let current = true;
  let protectedNow = false;
  const port = {
    assertCurrent: () => {
      if (!current) throw Error('CONTEXT_CHANGED');
    },
    assertUnassociated: (owned: TabProof) =>
      assertReadTabUnassociated(owned, { profilePlans: protectedNow ? 1 : 0, associated: [] }),
    inventory: async () => structuredClone(state),
    adopt: async (owned: TabProof) => {
      assert.deepEqual(owned, proof);
      calls.push('native-adopt');
    },
    remove: async (tabId: number) => {
      assert.equal(tabId, proof.tabId);
      calls.push('native-remove');
      const row = state.tabs[0];
      if (row) row.state = 'CLOSED';
    },
  };
  return {
    proof,
    state,
    port,
    calls,
    revoke: () => {
      current = false;
    },
    protect: () => {
      protectedNow = true;
    },
  };
}

test('read release uses a full proof, native adoption and matching CLOSED inventory', async () => {
  const fixture = setup();
  const result = await releaseFacebookReadTab(fixture.proof, fixture.port);
  assert.deepEqual(fixture.calls, ['native-adopt', 'native-remove']);
  assert.equal(result.before.state, 'READY');
  assert.equal(result.closed.state, 'CLOSED');
  assert.deepEqual(result.closed.proof, fixture.proof);
});
test('same URL and tab ID do not authorize a different target', async () => {
  const fixture = setup();
  await assert.rejects(
    releaseFacebookReadTab({ ...fixture.proof, targetId: 'different' }, fixture.port),
    /PROOF_REJECTED/,
  );
  assert.deepEqual(fixture.calls, []);
});
test('old browser epoch and UNKNOWN/LOST/CREATING records cannot be released', async () => {
  for (const phase of ['UNKNOWN', 'LOST', 'CREATING'] as const) {
    const fixture = setup();
    const row = fixture.state.tabs[0];
    if (row) row.state = phase;
    await assert.rejects(releaseFacebookReadTab(fixture.proof, fixture.port), /PROOF_REJECTED/);
    assert.deepEqual(fixture.calls, []);
  }
  const fixture = setup();
  await assert.rejects(
    releaseFacebookReadTab({ ...fixture.proof, browserSessionEpoch: randomUUID() }, fixture.port),
    /PROOF_REJECTED/,
  );
});
test('a profile mismatch or foreign URL fails without native adoption', async () => {
  for (const change of ['profile', 'url']) {
    const fixture = setup();
    if (change === 'profile') fixture.state.profileId = randomUUID();
    else {
      const row = fixture.state.tabs[0];
      if (row) row.url = 'https://example.com/';
    }
    await assert.rejects(releaseFacebookReadTab(fixture.proof, fixture.port));
    assert.deepEqual(fixture.calls, []);
  }
});
test('a native adoption failure never falls back to remove by tab ID', async () => {
  const fixture = setup();
  fixture.port.adopt = async () => {
    throw Error('NATIVE_TARGET_CHANGED');
  };
  await assert.rejects(
    releaseFacebookReadTab(fixture.proof, fixture.port),
    /NATIVE_TARGET_CHANGED/,
  );
  assert.deepEqual(fixture.calls, []);
});
test('connection replacement during inventory stops before adoption', async () => {
  const fixture = setup();
  fixture.port.inventory = async () => {
    fixture.revoke();
    return fixture.state;
  };
  await assert.rejects(releaseFacebookReadTab(fixture.proof, fixture.port), /CONTEXT_CHANGED/);
  assert.deepEqual(fixture.calls, []);
});
test('a plan arriving during native adoption protects the target before removal', async () => {
  const fixture = setup();
  fixture.port.adopt = async () => {
    fixture.calls.push('native-adopt');
    fixture.protect();
  };
  await assert.rejects(releaseFacebookReadTab(fixture.proof, fixture.port), /PRODUCT_PROTECTED/);
  assert.deepEqual(fixture.calls, ['native-adopt']);
});
test('a remove receipt without exact CLOSED proof cannot confirm closure', async () => {
  const fixture = setup();
  fixture.port.remove = async () => {
    fixture.calls.push('native-remove');
  };
  await assert.rejects(releaseFacebookReadTab(fixture.proof, fixture.port), /CLOSE_UNCONFIRMED/);
  fixture.port.remove = async () => {
    const row = fixture.state.tabs[0];
    if (row) {
      row.state = 'CLOSED';
      row.proof = { ...fixture.proof, targetId: 'different' };
    }
  };
  await assert.rejects(releaseFacebookReadTab(fixture.proof, fixture.port), /CLOSE_UNCONFIRMED/);
});
test('product ownership protects physical targets even with a different ownership UUID', () => {
  const { proof } = setup();
  for (const associated of [
    proof,
    { ...proof, ownershipId: randomUUID() },
    { ...proof, ownershipId: randomUUID(), tabId: 100 },
  ])
    assert.throws(
      () => assertReadTabUnassociated(proof, { profilePlans: 0, associated: [associated] }),
      /PRODUCT_PROTECTED/,
    );
  assert.throws(
    () => assertReadTabUnassociated(proof, { profilePlans: 1, associated: [] }),
    /PRODUCT_PROTECTED/,
  );
  assert.doesNotThrow(() => assertReadTabUnassociated(proof, { profilePlans: 0, associated: [] }));
});

test('unresolved remote business blocks read-tab release without native calls', async () => {
  const fixture = setup();
  fixture.state.operations.push({
    binding: {
      profileId: fixture.proof.profileId,
      accountId: 'actual-account',
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: 0,
      operationId: randomUUID(),
      jobId: randomUUID(),
      stepId: randomUUID(),
      actionDigest: '0'.repeat(64),
    },
    state: 'UNKNOWN',
    reason: 'PENDING_REVIEW',
    resolution: null,
  });
  await assert.rejects(releaseFacebookReadTab(fixture.proof, fixture.port), /PROOF_REJECTED/);
  assert.deepEqual(fixture.calls, []);
});

function selfPage(): PageProjection {
  return {
    url: 'https://www.facebook.com/profile.php?id=12345',
    timeOrigin: 1000,
    ready: 'complete',
    visibility: 'hidden',
    rows: facebookSelfProfileProjection.queries.map((query) => ({
      key: query.key,
      nodes:
        query.key === 'profileHeading'
          ? [{ tag: 'h1', text: 'Own profile', visible: true, attributes: {} }]
          : [],
    })),
  };
}
test('a self-route canonical ID and one heading remain a candidate, not an actor permit', () => {
  const page = validateProjection(facebookSelfProfileProjection, selfPage());
  const result = observeFacebookSelfProfile(page);
  assert.deepEqual(result.candidate, { id: '12345', name: 'Own profile' });
  assert.equal(result.identityReady, false);
  assert.deepEqual(result.account, { state: 'unknown', id: null, name: null, avatar: null });
});
test('hidden or ambiguous profile headings do not become a candidate name', () => {
  const page = selfPage();
  const heading = page.rows.find((row) => row.key === 'profileHeading');
  if (heading) heading.nodes = [{ tag: 'h1', text: 'hidden', visible: false, attributes: {} }];
  assert.equal(observeFacebookSelfProfile(page).candidate.name, null);
  if (heading)
    heading.nodes = ['first', 'second'].map((text) => ({
      tag: 'h1',
      text,
      visible: true,
      attributes: {},
    }));
  assert.equal(observeFacebookSelfProfile(page).candidate.name, null);
});
test('self-profile loading/checkpoint/foreign results never promote acting identity', () => {
  const page = selfPage();
  page.ready = 'loading';
  assert.deepEqual(observeFacebookSelfProfile(page).candidate, { id: null, name: null });
  page.ready = 'complete';
  page.url = 'https://www.facebook.com/checkpoint/';
  assert.equal(observeFacebookSelfProfile(page).account.state, 'verification');
  assert.equal(observeFacebookSelfProfile(page).candidate.name, null);
  page.url = 'https://example.com/';
  assert.throws(() => observeFacebookSelfProfile(page), /SCOPE_REJECTED/);
});
