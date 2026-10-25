import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import type { Core, Peer } from '../src/bridge/core.js';
import type { PageProjection } from '../src/shared/page-read.js';
import { readCurrentFacebookIdentity } from '../src/infrastructure/facebook-current-identity.js';
import { NativeFacebookTaskAuthority } from '../src/infrastructure/facebook-task-authority.js';
import { postFixture, postRequest, postAction } from './fixtures/material-post.js';
import { randomUUID } from 'node:crypto';
import { settlementFixture } from './fixtures/settlement.js';
import type { RuntimeProfile } from '../src/domain/tasks.js';
import type { BrowsePage } from '../src/infrastructure/facebook-browse-reader.js';

test('a redirected or incomplete identity document produces an actionable admission failure', async () => {
  const redirected = {
    evaluate: async () => ({
      before: { url: 'https://www.facebook.com/login/', ready: 'complete', timeOrigin: 1 },
      selected: null,
      creator: null,
      after: null,
    }),
  } as unknown as Page;
  await assert.rejects(
    readCurrentFacebookIdentity(redirected, () => {}),
    /FACEBOOK_TASK_DOCUMENT_SCOPE_CHANGED/,
  );
  const incomplete = {
    evaluate: async () => ({
      before: { url: 'https://www.facebook.com/', ready: 'loading', timeOrigin: 1 },
      selected: null,
      creator: null,
      after: null,
    }),
  } as unknown as Page;
  await assert.rejects(
    readCurrentFacebookIdentity(incomplete, () => {}),
    /FACEBOOK_TASK_DOCUMENT_READ_FAILED/,
  );
});

function pageFixture(post = false) {
  const actor = {
    version: 1 as const,
    source: 'CometSettingsDropdownTriggerQuery' as const,
    accountId: '123',
    name: '生成身份',
    type: 'User' as const,
    checkedAt: 1000,
  };
  const fence = {
    url: post ? 'https://www.facebook.com/post/create' : 'https://www.facebook.com/',
    ready: 'complete' as const,
    timeOrigin: 100,
  };
  const creator: PageProjection = {
    ...fence,
    visibility: 'hidden',
    rows: [
      {
        key: 'homeComposers',
        nodes: [{ tag: 'div', text: '', visible: !post, attributes: { 'aria-label': '创建帖子' } }],
      },
      {
        key: 'composerProfileLinks',
        nodes: [
          {
            tag: 'a',
            text: '',
            visible: !post,
            attributes: {
              href: 'https://www.facebook.com/profile.php?id=123',
              'aria-label': '生成身份的时间线',
            },
          },
        ],
      },
    ],
  };
  let reads = 0,
    drift = false;
  const page = {
    evaluate: async (fn: unknown) => {
      if (typeof fn === 'string') {
        if (!fn.includes('const creator ='))
          return {
            url: fence.url,
            ready: fence.ready,
            timeOrigin: fence.timeOrigin,
            actor: { ...actor },
          };
        reads++;
        return {
          before: { ...fence },
          selected: { url: fence.url, ready: fence.ready, actor: { ...actor } },
          creator: structuredClone(creator),
          after: { ...fence, timeOrigin: drift ? 200 : fence.timeOrigin },
        };
      }
      if (typeof fn === 'function' && fn.name === 'projectPage') return structuredClone(creator);
      reads++;
      return { ...fence, timeOrigin: drift && reads > 1 ? 200 : 100 };
    },
  } as unknown as Page;
  return {
    page,
    actor,
    fence,
    creator,
    readCount: () => reads,
    drift: () => {
      drift = true;
    },
  };
}
test('same-document SDK actor is independently matched to creator on home and observed composer SPA', async () => {
  for (const post of [false, true]) {
    const f = pageFixture(post);
    const result = await readCurrentFacebookIdentity(f.page, () => {});
    assert.equal(result.actor.accountId, '123');
    assert.equal(result.document.url, f.fence.url);
    assert.equal(
      f.readCount(),
      1,
      'identity, creator and document fence share one synchronous read',
    );
  }
});
test('stale preload actor cannot bypass changed creator, document, unsupported route or revoked read', async () => {
  const foreign = pageFixture();
  foreign.creator.rows[1]!.nodes[0]!.attributes.href = 'https://www.facebook.com/profile.php?id=99';
  await assert.rejects(
    readCurrentFacebookIdentity(foreign.page, () => {}),
    /CREATOR_UNCONFIRMED/,
  );
  const changed = pageFixture();
  changed.drift();
  await assert.rejects(
    readCurrentFacebookIdentity(changed.page, () => {}),
    /IDENTITY_UNCONFIRMED/,
  );
  const unknown = pageFixture();
  unknown.fence.url = 'https://www.facebook.com/unknown';
  await assert.rejects(readCurrentFacebookIdentity(unknown.page, () => {}));
  const revoked = pageFixture();
  let n = 0;
  await assert.rejects(
    readCurrentFacebookIdentity(revoked.page, () => {
      if (++n === 2) throw Error('REVOKED');
    }),
    /REVOKED/,
  );
});
test('native task authority rejects expired bootstrap and permanently revokes input authority after actual read identity changes', async () =>
  postFixture(async (store, _file, catalog) => {
    const request = await postRequest(store, catalog, { accountId: '123' }),
      plan = await store.tasks.get(request.jobId);
    const f = pageFixture();
    const peer = {
      profileId: request.context.profileId,
      epoch: request.context.connectionEpoch,
      online: true,
      synced: true,
      phase: 'PAUSED',
    } as unknown as Peer;
    const core = {
      peers: new Map([[peer.profileId, peer]]),
      store: { unresolved: () => [] },
    } as unknown as Core;
    const readProof = {
      ...request.proof,
      ownershipId: randomUUID(),
      targetId: randomUUID(),
      tabId: 43,
    };
    const bootstrap: ConstructorParameters<typeof NativeFacebookTaskAuthority>[4] = {
      actor: f.actor,
      transport: 'document-preload',
      connection: { profileId: peer.profileId, connectionEpoch: peer.epoch },
      proof: readProof,
      closedRecord: {
        proof: readProof,
        ownershipId: readProof.ownershipId,
        url: 'https://www.facebook.com/',
        state: 'CLOSED',
        reason: 'TAB_REMOVED',
      },
      stop: { requestId: randomUUID(), state: 'stopped' },
      page: f.creator as ConstructorParameters<typeof NativeFacebookTaskAuthority>[4]['page'],
    };
    assert.throws(
      () => new NativeFacebookTaskAuthority(core, peer, store.tasks, plan, bootstrap, () => 32000),
      /FRESH_BOOTSTRAP/,
    );
    let identityReads = 0;
    const authority = new NativeFacebookTaskAuthority(
      core,
      peer,
      store.tasks,
      plan,
      bootstrap,
      () => 1000,
      async (...args) => {
        identityReads++;
        return readCurrentFacebookIdentity(...args);
      },
    );
    f.page.url = () => f.fence.url;
    await authority.bindPage(f.page, request.proof);
    await authority.assertTarget({ kind: 'activateTab', tabId: request.proof.tabId });
    await store.materials.reserve(request);
    const post = {
      intent: (await store.materials.reservation(request.attemptId)).intent,
      link: { ...(await postAction(store, request, 'SET_TEXT')), sequence: 1 },
    };
    identityReads = 0;
    await authority.assertInputTarget(post.link.action, post, 0);
    assert.equal(identityReads, 1, 'one fresh identity read per combined input check');
    await assert.rejects(
      authority.assertInputTarget(
        post.link.action,
        { ...post, intent: { ...post.intent, jobId: randomUUID() } },
        0,
      ),
      /ORIGINAL_POST_REQUIRED/,
    );
    f.actor.accountId = '99';
    f.creator.rows[1]!.nodes[0]!.attributes.href = 'https://www.facebook.com/profile.php?id=99';
    await assert.rejects(
      authority.assertTarget({ kind: 'activateTab', tabId: request.proof.tabId }),
      /ACCOUNT_CHANGED/,
    );
    f.actor.accountId = '123';
    await assert.rejects(async () => await authority.assertIdentity('123'), /AUTHORITY_REVOKED/);
    assert.equal((await authority.profile()).dispatchAllowed, false);
    assert.equal((await authority.profile()).unreadyReason, 'FACEBOOK_NATIVE_ACCOUNT_CHANGED');
    await store.tasks.reconcileRuntime([await authority.profile()]);
    assert.equal((await store.tasks.get(plan.id)).reason, 'FACEBOOK_NATIVE_ACCOUNT_CHANGED');
  }));

test('feed layout drift is not identity drift, but an excessive wheel budget remains fenced and recorded', async () =>
  settlementFixture(async (store) => {
    const profile: RuntimeProfile = {
      id: randomUUID(),
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in', id: '123', name: null, avatar: null },
    };
    const saved = await store.createCombination({
      name: 'Native fence fixture',
      note: 'Generated data',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
    });
    await store.tasks.assign(
      { requestId: randomUUID(), combinationId: saved.id, version: 1, profileIds: [profile.id] },
      [profile],
    );
    const plan = await store.tasks.claimNext([profile], new Set(['feed']));
    assert.ok(plan);
    const step = (await store.tasks.steps(plan.id))[0];
    assert.ok(step);
    const context = {
      profileId: profile.id,
      accountId: '123',
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: 0,
    };
    const proof = {
      profileId: profile.id,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 42,
      targetId: randomUUID(),
    };
    const actor = {
      version: 1 as const,
      source: 'CometSettingsDropdownTriggerQuery' as const,
      accountId: '123',
      name: 'Fixture',
      type: 'User' as const,
      checkedAt: 1000,
    };
    const reading: BrowsePage = {
      url: 'https://www.facebook.com/',
      timeOrigin: 100,
      ready: true,
      visible: true,
      blocked: false,
      scrollY: 6504,
      scrollMaxY: 12631,
      viewportHeight: 674,
      contentKey: 'loaded-fixture-post',
      video: null,
    };
    const page = {
      evaluate: async (fn: unknown) => {
        const identity = {
          url: reading.url,
          timeOrigin: reading.timeOrigin,
          ready: 'complete',
          actor,
        };
        if (typeof fn === 'string' && fn.includes('projectFacebookFeedInputFence'))
          return { identity, page: { ...structuredClone(reading), contentKey: null, video: null } };
        return typeof fn === 'string' ? identity : structuredClone(reading);
      },
    } as unknown as Page;
    const peer = {
      profileId: profile.id,
      epoch: context.connectionEpoch,
      online: true,
      synced: true,
      phase: 'PAUSED',
    } as unknown as Peer;
    const core = {
      peers: new Map([[profile.id, peer]]),
      store: { unresolved: () => [] },
    } as unknown as Core;
    const bootstrap: ConstructorParameters<typeof NativeFacebookTaskAuthority>[4] = {
      actor,
      transport: 'document-preload',
      connection: { profileId: profile.id, connectionEpoch: peer.epoch },
      proof: { ...proof, ownershipId: randomUUID(), targetId: randomUUID() },
      closedRecord: {
        proof: { ...proof, ownershipId: randomUUID(), targetId: randomUUID() },
        ownershipId: randomUUID(),
        url: reading.url,
        state: 'CLOSED',
        reason: 'TAB_REMOVED',
      },
      stop: { requestId: randomUUID(), state: 'stopped' },
      page: {
        url: reading.url,
        ready: 'complete',
        timeOrigin: 100,
        visibility: 'visible',
        rows: [],
      },
    };
    bootstrap.closedRecord!.proof = bootstrap.proof;
    bootstrap.closedRecord!.ownershipId = bootstrap.proof!.ownershipId;
    const authority = new NativeFacebookTaskAuthority(
      core,
      peer,
      store.tasks,
      plan,
      bootstrap,
      () => 1000,
    );
    await authority.bindPage(page, proof);
    const action = {
      kind: 'browseScroll' as const,
      tabId: 42,
      documentEpoch: 0,
      routeEpoch: 0,
      url: reading.url,
      timeOrigin: 100,
      fromY: 8085,
      deltaY: 539,
    };
    const prepared = await store.tasks.prepareOperation(plan.id, step.id, randomUUID(), action);
    const dispatched = await store.tasks.takeBoundOperation(context);
    assert.ok(dispatched?.binding);
    await authority.assertTarget(action, 90);
    assert.equal(
      (await store.tasks.events(plan.id)).some((x) => x.type === 'BROWSE_INPUT_FENCE'),
      false,
    );
    await assert.rejects(authority.assertTarget(action, 600), /DOCUMENT_OR_TARGET_CHANGED/);
    assert.equal((await store.tasks.operations(plan.id))[0]?.status, 'DISPATCHING');
    assert.equal((await store.tasks.steps(plan.id))[0]?.progress.effectiveMilliseconds, 0);
    const event = (await store.tasks.events(plan.id)).find((x) => x.type === 'BROWSE_INPUT_FENCE');
    assert.ok(event);
    assert.ok(event.detail && typeof event.detail === 'object' && !Array.isArray(event.detail));
    const pending = event.detail.pending;
    assert.ok(pending && typeof pending === 'object' && !Array.isArray(pending));
    assert.deepEqual(pending.inputFence, {
      fromY: 8085,
      requestedDelta: 539,
      appliedDelta: 600,
      positionMatches: false,
      movementValid: false,
      sameUrl: true,
      sameTimeOrigin: true,
    });
    assert.equal(prepared.id, dispatched.id);
    reading.visible = false;
    await assert.rejects(authority.assertTarget(action, 0, true), /BROWSE_VISIBILITY_WAIT/);
    peer.capabilities = ['profile-foreground-v1'];
    peer.profileWindowFocused = true;
    peer.focusedWindowAt = 1000;
    await authority.assertInputTarget(action, undefined, 0, true);
    await assert.rejects(authority.assertTarget(action, 0), /BROWSE_VISIBILITY_WAIT/);
    peer.profileWindowFocused = false;
    await assert.rejects(
      authority.assertInputTarget(action, undefined, 0, true),
      /BROWSE_VISIBILITY_WAIT/,
    );
  }));
