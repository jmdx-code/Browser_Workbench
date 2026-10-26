import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import type { Core, Peer } from '../src/bridge/core.js';
import type { Plan } from '../src/shared/task-contracts.js';
import type { TaskRepository } from '../src/domain/tasks.js';
import { NativeFacebookTaskAuthority } from '../src/infrastructure/facebook-task-authority.js';
import {
  projectFacebookFeedInputFence,
  projectFacebookBrowsePage,
} from '../src/infrastructure/facebook-browse-reader.js';

test('feed content projection inspects scroll roots only under the actual center wheel target, without scanning all descendants', () => {
  const rect = () => ({ left: 0, top: 0, right: 500, bottom: 500, width: 500, height: 500 });
  const main = {
    tagName: 'MAIN',
    getBoundingClientRect: rect,
    getAttribute: () => null,
    scrollHeight: 500,
    clientHeight: 500,
    scrollTop: 0,
    contains: (_el: unknown) => true,
    querySelectorAll: (selector: string) => {
      assert.notEqual(selector, '*');
      return [];
    },
  };
  const root = {
    tagName: 'DIV',
    getBoundingClientRect: rect,
    getAttribute: () => null,
    scrollHeight: 2000,
    clientHeight: 500,
    scrollTop: 80,
    parentElement: main,
  };
  const child = {
    tagName: 'DIV',
    getBoundingClientRect: rect,
    getAttribute: () => null,
    scrollHeight: 50,
    clientHeight: 50,
    scrollTop: 0,
    parentElement: root,
  };
  let styles = 0;
  const value = runInNewContext('(' + projectFacebookBrowsePage.toString() + ')()', {
    document: {
      readyState: 'complete',
      visibilityState: 'visible',
      scrollingElement: { scrollHeight: 10000, clientHeight: 720 },
      elementFromPoint: () => child,
      querySelectorAll: (selector: string) => (selector === 'main,[role="main"]' ? [main] : []),
    },
    location: { href: 'https://www.facebook.com/', pathname: '/' },
    performance: { timeOrigin: 100 },
    innerWidth: 1280,
    innerHeight: 720,
    scrollY: 0,
    getComputedStyle: (el: unknown) => {
      styles++;
      return {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        overflowY: el === root ? 'auto' : 'visible',
      };
    },
  });
  assert.equal(value.scrollY, 80);
  assert.equal(value.structure.scrollRoots.length, 1);
  assert.equal(value.structure.scrollRoots[0].top, 80);
  assert.equal(value.structure.centerHit.withinMain, true);
  assert.ok(styles <= 10);
});

test('feed input fence reads only document/main/dialog fields, never descendants, posts or players and grants no content', () => {
  const element = {
    getAttribute: (name: string) => (name === 'aria-modal' ? 'true' : null),
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 500,
      bottom: 500,
      width: 500,
      height: 500,
    }),
  };
  for (const blocked of [false, true]) {
    const queried: string[] = [];
    const value = runInNewContext('(' + projectFacebookFeedInputFence.toString() + ')()', {
      document: {
        readyState: 'complete',
        visibilityState: 'visible',
        querySelectorAll: (selector: string) => {
          queried.push(selector);
          if (selector === 'main,[role="main"]') return [element];
          if (selector === '[role="dialog"]') return blocked ? [element] : [];
          throw Error('UNEXPECTED_SEMANTIC_READ');
        },
      },
      location: { href: 'https://www.facebook.com/' },
      performance: { timeOrigin: 100 },
      innerWidth: 1280,
      innerHeight: 720,
      scrollY: 100,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    });
    assert.equal(value.ready, true);
    assert.equal(value.blocked, blocked);
    assert.equal(value.contentKey, null);
    assert.equal(value.video, null);
    assert.deepEqual(queried, ['main,[role="main"]', '[role="dialog"]']);
  }
});

test('every feed scroll input gets one fresh atomic actor/document fence; hidden, changed document, actor and revoked owner cannot authorize input', async () => {
  for (const failure of [
    '',
    'hidden',
    'hidden-prepare-cap',
    'hidden-prepare-no-cap',
    'hidden-cap-input',
    'document',
    'actor',
    'stop',
    'window-original',
    'window-new',
    'window-foreign',
    'window-stopped',
    'window-unknown',
  ]) {
    const profileId = randomUUID(),
      epoch = randomUUID();
    const peer = { profileId, epoch, online: true, synced: true, phase: 'PAUSED' } as Peer;
    const plan = { id: randomUUID(), profileId, accountId: '123', state: 'RUNNING' } as Plan;
    if (failure.startsWith('window-'))
      plan.timing = {
        mode: 'window',
        startTime: '00:00',
        endTime: '00:01',
        timeZone: 'UTC',
        weekdays: [1, 2, 3, 4, 5, 6, 7],
      };
    const actor = {
      version: 1,
      source: 'CometSettingsDropdownTriggerQuery',
      accountId: '123',
      name: 'Generated',
      type: 'User',
      checkedAt: 1000,
    };
    const identity = {
      url: 'https://www.facebook.com/',
      ready: 'complete',
      timeOrigin: 100,
      actor,
    };
    const reading = {
      url: identity.url,
      timeOrigin: 100,
      ready: true,
      visible: true,
      blocked: false,
      scrollY: 0,
      viewportHeight: 720,
      contentKey: null,
      video: null,
    };
    const core = { peers: new Map([[profileId, peer]]) } as unknown as Core;
    const stepId = randomUUID();
    const action = {
      kind: 'browseScroll' as const,
      tabId: 1,
      url: identity.url,
      timeOrigin: 100,
      fromY: 0,
      deltaY: 500,
      documentEpoch: 0,
      routeEpoch: 0,
    };
    let now = 1000;
    const tasks = {
      get: () => plan,
      steps: () => [{ id: stepId, status: 'ACTIVE', spec: { type: 'feed', maxLikes: 0 } }],
      operations: () => [
        {
          stepId,
          action,
          status: failure === 'window-unknown' ? 'UNKNOWN' : 'DISPATCHING',
          createdAt: failure === 'window-new' ? 120000 : 1000,
          binding: {
            jobId: plan.id,
            profileId,
            accountId: failure === 'window-foreign' ? '456' : '123',
            connectionEpoch: epoch,
          },
        },
      ],
    } as unknown as TaskRepository;
    const bootstrap = {
      passive: true,
      connection: { profileId, connectionEpoch: epoch },
      actor,
    } as unknown as ConstructorParameters<typeof NativeFacebookTaskAuthority>[4];
    let reads = 0;
    const page = {
      evaluate: async (expression: string) => {
        reads++;
        if (reads === 1) return structuredClone(identity);
        assert.ok(expression.includes('projectFacebookFeedInputFence'));
        assert.equal(expression.includes('structuralPosts'), false);
        if (failure === 'stop') peer.online = false;
        return { identity: structuredClone(identity), page: structuredClone(reading) };
      },
    } as unknown as Page;
    const authority = new NativeFacebookTaskAuthority(
      core,
      peer,
      tasks,
      plan,
      bootstrap,
      () => now,
    );
    await authority.bindPage(page, {
      profileId,
      browserSessionEpoch: randomUUID(),
      ownershipId: randomUUID(),
      tabId: 1,
      targetId: 'target',
    });
    if (failure.startsWith('hidden')) reading.visible = false;
    if (failure === 'hidden-prepare-cap' || failure === 'hidden-cap-input') {
      peer.capabilities = ['kernel-background-presentation-v1'];
      assert.equal(authority.foregroundAllowed(), false);
      assert.equal(await authority.canPresentTaskPage(), true);
    }
    if (failure === 'document') reading.timeOrigin = 200;
    if (failure === 'actor') identity.actor.accountId = '456';
    if (failure.startsWith('window-')) {
      now = 120000;
      if (failure === 'window-stopped') plan.state = 'PAUSING';
    }
    const check = authority.assertTarget(action, 0, failure.startsWith('hidden-prepare'));
    if (failure && failure !== 'window-original' && failure !== 'hidden-prepare-cap')
      await assert.rejects(check);
    else await check;
    assert.equal(
      reads,
      failure.startsWith('window-') && failure !== 'window-original'
        ? 1
        : failure === 'document'
          ? 3
          : 2,
    );
  }
});
