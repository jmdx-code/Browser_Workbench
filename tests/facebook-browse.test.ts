import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { FacebookBrowseStepExecutor } from '../src/infrastructure/facebook-browse-step-executor.js';
import type { BrowsePage } from '../src/infrastructure/facebook-browse-reader.js';
import { FACEBOOK_REEL_NEXT_CSS } from '../src/infrastructure/facebook-browse-reader.js';
import type { Operation } from '../src/shared/task-contracts.js';
import type { Intent } from '../src/shared/browse-execution.js';
import { BrowseDecision, BrowseVerdict } from '../src/shared/browse-execution.js';
import { BrowsePendingDiagnostic } from '../src/shared/browse-execution.js';
import { browseHarness } from './fixtures/browse.js';
import { settlementFixture } from './fixtures/settlement.js';
import { TaskStepRunner } from '../src/application/task-step-runner.js';
import { validateBrowseIntent } from '../src/domain/browse-policy.js';
import { StepSchema } from '../src/shared/contracts.js';
import {
  facebookBrowseSurface,
  facebookMarketplaceURL,
  facebookMarketplaceItemURL,
  matchesMarketplaceSearch,
  FACEBOOK_FRIEND_CONFIRM_CSS,
  FACEBOOK_FRIENDS_REQUESTS_URL,
  FACEBOOK_BROWSE_LIKE_CSS,
} from '../src/shared/facebook-browse-route.js';

const page = (): BrowsePage => ({
  url: 'https://www.facebook.com/',
  timeOrigin: 100,
  ready: true,
  visible: true,
  blocked: false,
  scrollY: 0,
  viewportHeight: 900,
  contentKey: 'generated-article',
  video: null,
});

test('a claimed plan waits for the startup pool instead of failing or pausing, then continues on the next tick', async () =>
  fixture('feed', async (f) => {
    const observe = f.h.host.observe.bind(f.h.host),
      control = f.h.host.control.bind(f.h.host);
    let limited = true,
      controls = 0;
    f.h.host.observe = async (id) => {
      if (limited) throw Error('CONCURRENCY_LIMIT');
      return observe(id);
    };
    f.h.host.control = async (...args) => {
      controls++;
      return control(...args);
    };
    const runner = new TaskStepRunner(
      f.h.store.tasks,
      f.h.store.browseIntents,
      f.h.store.taskTabs,
      f.h.host,
      [f.executor],
      f.h.clock,
      randomUUID,
    );
    const waiting = await runner.advance(f.execution.plan.id);
    assert.equal(waiting.status, 'WAITING');
    assert.equal(waiting.reason, 'CONCURRENCY_LIMIT');
    assert.equal((await f.h.store.tasks.get(f.execution.plan.id)).state, 'RUNNING');
    assert.equal(controls, 0);
    assert.equal((await f.h.store.tasks.operations(f.execution.plan.id)).length, 0);
    limited = false;
    await runner.advance(f.execution.plan.id);
    assert.equal((await f.h.store.tasks.get(f.execution.plan.id)).state, 'RUNNING');
    assert.notEqual((await f.h.store.tasks.get(f.execution.plan.id)).reason, 'CONCURRENCY_LIMIT');
    assert.equal(controls, 0);
  }));

test('marketplace ineligible is a specific failure before loading waits, and is not an allowed browsing destination', async () => {
  assert.equal(facebookBrowseSurface('https://www.facebook.com/marketplace/ineligible/'), null);
  assert.equal(
    matchesMarketplaceSearch('https://www.facebook.com/marketplace/ineligible/', ''),
    false,
  );
  await fixture('marketplace', async (f) => {
    f.reading.url = 'https://www.facebook.com/marketplace/ineligible/';
    f.reading.ready = false;
    await assert.rejects(
      f.executor.decide(f.execution, () => {}),
      /FACEBOOK_MARKETPLACE_UNAVAILABLE/,
    );
    const action = {
      kind: 'browseNavigate' as const,
      tabId: f.h.proofs.get(f.execution.plan.profileId)!.tabId,
      url: 'https://www.facebook.com/marketplace/',
    };
    const op = operation(f, action);
    await assert.rejects(
      f.executor.verify(
        f.execution,
        op,
        {
          kind: 'auxiliary',
          purpose: 'advance',
          proof: f.h.proofs.get(f.execution.plan.profileId)!,
          documentEpoch: 0,
          routeEpoch: 0,
        },
        () => {},
      ),
      /FACEBOOK_MARKETPLACE_UNAVAILABLE/,
    );
    assert.equal(f.execution.step.progress.effectiveMilliseconds, 0);
  });
});

test('a retained unavailable marketplace can navigate to the configured feed without granting any browse time or accepting it as an action destination', async () =>
  fixture('feed', async (f) => {
    f.reading.url = 'https://www.facebook.com/marketplace/ineligible/';
    f.reading.ready = false;
    f.reading.contentKey = null;
    const decision = await f.executor.decide(f.execution, () => {});
    assert.ok(decision.kind === 'action' && decision.action.kind === 'browseNavigate');
    assert.equal(decision.action.url, 'https://www.facebook.com/');
    assert.equal(decision.observation, undefined);
    assert.equal(f.execution.step.progress.effectiveMilliseconds, 0);
  }));

test('feed action carries its independent pre-input endpoint and verified scrolling seeds only a new visible endpoint', async () =>
  fixture('feed', async (f) => {
    await f.executor.decide(f.execution, () => {});
    f.h.clock.at = 1000;
    await f.executor.decide(f.execution, () => {});
    f.h.clock.at = 9000;
    const decision = await f.executor.decide(f.execution, () => {});
    assert.ok(decision.kind === 'action' && decision.action.kind === 'browseScroll');
    assert.equal(decision.observation?.type, 'feed');
    const op = operation(f, decision.action);
    f.reading.scrollY = 600;
    const verified = await f.executor.verify(f.execution, op, decision.intent, () => {});
    assert.equal(verified.outcome, 'VERIFIED');
    assert.ok(verified.outcome === 'VERIFIED' && verified.observation?.visible);
    f.reading.visible = false;
    const hidden = await f.executor.verify(f.execution, op, decision.intent, () => {});
    if (hidden.outcome === 'VERIFIED') assert.equal(hidden.observation, undefined);
    assert.equal(f.execution.step.progress.effectiveMilliseconds, 0);
  }));

test('a bounded negative foreground wait skips only repeated hidden reads and immediately rechecks permission recovery', async () =>
  fixture('feed', async (f) => {
    let allowed: boolean | undefined = false,
      reads = 0;
    const executor = new FacebookBrowseStepExecutor(
      'feed',
      {
        foregroundAllowed: async (_e, guard) => {
          await guard();
          return allowed;
        },
        read: async (_e, guard) => {
          await guard();
          reads++;
          return {
            context: f.execution.session,
            proof: f.h.proofs.get(f.execution.plan.profileId)!,
            page: structuredClone(f.reading),
            foregroundAllowed: allowed,
          };
        },
      },
      () => true,
      () => f.h.clock.at,
    );
    f.reading.visible = false;
    assert.equal((await executor.decide(f.execution, () => {})).kind, 'wait');
    assert.equal(reads, 1);
    f.h.clock.at = 1000;
    assert.deepEqual(await executor.decide(f.execution, () => {}), {
      kind: 'wait',
      reason: 'FACEBOOK_BROWSE_FOREGROUND_REQUIRED',
    });
    assert.equal(reads, 1);
    await assert.rejects(
      executor.decide(f.execution, () => {
        throw Error('ORIGINAL_SCOPE_STOPPED');
      }),
      /ORIGINAL_SCOPE_STOPPED/,
    );
    allowed = true;
    f.reading.visible = true;
    assert.equal((await executor.decide(f.execution, () => {})).kind, 'observe');
    assert.equal(reads, 2);
    allowed = false;
    f.reading.visible = false;
    await executor.decide(f.execution, () => {});
    assert.equal(reads, 3);
    f.h.clock.at = 3000;
    await executor.decide(f.execution, () => {});
    assert.equal(reads, 4);
    allowed = undefined;
    await executor.decide(f.execution, () => {});
    assert.equal(reads, 5);
    allowed = false;
    await executor.decide(
      { ...f.execution, step: { ...f.execution.step, id: randomUUID() } },
      () => {},
    );
    assert.equal(reads, 6);
    f.h.clock.at = 0;
    await executor.decide(f.execution, () => {});
    assert.equal(reads, 7);
    assert.equal(f.execution.step.progress.effectiveMilliseconds, 0);
  }));

test('a background-capable owner restores its hidden task via original activation without inventing foreground or progress', async () =>
  fixture('feed', async (f) => {
    let canPresent = false;
    const executor = new FacebookBrowseStepExecutor(
      'feed',
      {
        foregroundAllowed: () => false,
        canPresentTaskPage: async (_execution, guard) => {
          await guard();
          return canPresent;
        },
        read: async (_execution, guard) => {
          await guard();
          return {
            context: f.execution.session,
            proof: f.h.proofs.get(f.execution.plan.profileId)!,
            page: structuredClone(f.reading),
            foregroundAllowed: false,
            canPresentTaskPage: canPresent,
          };
        },
      },
      () => true,
      () => f.h.clock.at,
    );
    f.reading.visible = false;
    assert.equal((await executor.decide(f.execution, () => {})).kind, 'wait');
    canPresent = true;
    const decision = await executor.decide(f.execution, () => {});
    assert.equal(decision.kind, 'action');
    if (decision.kind !== 'action') throw Error('ACTIVATION_REQUIRED');
    assert.equal(decision.action.kind, 'activateTab');
    assert.equal(f.reading.visible, false);
    assert.equal(f.execution.step.progress.effectiveMilliseconds, 0);
    await assert.rejects(
      executor.decide(f.execution, () => {
        throw Error('ORIGINAL_SCOPE_STOPPED');
      }),
      /ORIGINAL_SCOPE_STOPPED/,
    );
    f.reading.visible = true;
    assert.equal((await executor.decide(f.execution, () => {})).kind, 'observe');
  }));

test('a visible owned task page needs no entry activation, while a hidden page still needs independent visibility verification', async () =>
  fixture(
    'feed',
    async (f) => {
      f.executor = new FacebookBrowseStepExecutor(
        'feed',
        {
          read: async (_execution, guard) => {
            await guard();
            return {
              context: f.execution.session,
              proof: f.h.proofs.get(f.execution.plan.profileId)!,
              page: structuredClone(f.reading),
              foregroundAllowed: true,
            };
          },
        },
        () => true,
        () => f.h.clock.at,
      );
      const first = await f.executor.decide(f.execution, () => {});
      assert.equal(first.kind, 'observe');
      f.reading.visible = false;
      const hidden = await f.executor.decide(f.execution, () => {});
      assert.ok(hidden.kind === 'action' && hidden.action.kind === 'activateTab');
      const op = operation(f, hidden.action);
      assert.equal(
        (await f.executor.verify(f.execution, op, hidden.intent, () => {})).outcome,
        'WAIT',
      );
      f.reading.visible = true;
      assert.equal(
        (await f.executor.verify(f.execution, op, hidden.intent, () => {})).outcome,
        'VERIFIED',
      );
      assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
      assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
      assert.equal(f.execution.step.progress.effectiveMilliseconds, 0);
      f.execution.session.generation++;
      const next = await f.executor.decide(f.execution, () => {});
      assert.equal(next.kind, 'observe');
    },
    0,
    false,
  ));

test('Reels advances using its unambiguous native next control and verifies loaded changed media, never the click ACK', async () =>
  fixture('video', async (f) => {
    f.reading.url = 'https://www.facebook.com/reel/123/';
    f.reading.contentKey = 'original-stream';
    f.reading.nextReelCSS = FACEBOOK_REEL_NEXT_CSS;
    f.reading.video = {
      css: 'video',
      source: 'original-stream',
      paused: false,
      buffering: false,
      ended: false,
      readyState: 4,
      timeSeconds: 3,
      playbackRate: 1,
    };
    await f.executor.decide(f.execution, () => {});
    f.h.clock.at = 31000;
    const decision = await f.executor.decide(f.execution, () => {});
    assert.ok(decision.kind === 'action' && decision.action.kind === 'click');
    validateBrowseIntent(f.execution.step, decision.action, decision.intent);
    const op = operation(f, decision.action);
    assert.equal(
      (await f.executor.verify(f.execution, op, decision.intent, () => {})).outcome,
      'WAIT',
    );
    f.reading.url = 'https://www.facebook.com/reel/456/';
    f.reading.contentKey = 'next-stream';
    f.reading.video.source = 'next-stream';
    for (const key of ['visible', 'ready'] as const) {
      f.reading[key] = false;
      assert.equal(
        (await f.executor.verify(f.execution, op, decision.intent, () => {})).outcome,
        'WAIT',
      );
      f.reading[key] = true;
    }
    f.reading.video.buffering = true;
    assert.equal(
      (await f.executor.verify(f.execution, op, decision.intent, () => {})).outcome,
      'WAIT',
    );
    f.reading.video.buffering = false;
    assert.equal(
      (await f.executor.verify(f.execution, op, decision.intent, () => {})).outcome,
      'VERIFIED',
    );
    assert.equal(f.execution.step.progress.effectiveMilliseconds, 0);
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    assert.throws(
      () =>
        validateBrowseIntent(
          {
            ...f.execution.step,
            spec: StepSchema.parse({
              id: randomUUID(),
              type: 'feed',
              durationMinutes: 1,
              maxLikes: 0,
              minLikeCount: 0,
            }),
          },
          decision.action,
          decision.intent,
        ),
      /NEXT_PURPOSE/,
    );
    assert.throws(
      () =>
        validateBrowseIntent(f.execution.step, decision.action, {
          ...decision.intent,
          purpose: 'play',
        } as Intent),
      /NEXT_PURPOSE/,
    );
  }));

test('hidden browse pages recover before deadline with a new dwell baseline', async () => {
  for (const type of ['feed', 'video'] as const)
    await fixture(type, async (f) => {
      if (type === 'video') {
        f.reading.url = 'https://www.facebook.com/reel/123/';
        f.reading.video = {
          css: 'video',
          source: 'original-stream',
          paused: false,
          buffering: false,
          ended: false,
          readyState: 4,
          timeSeconds: 3,
          playbackRate: 1,
        };
      }
      f.reading.visible = false;
      assert.deepEqual(await f.executor.decide(f.execution, () => {}), {
        kind: 'wait',
        reason: 'FACEBOOK_BROWSE_FOREGROUND_REQUIRED',
      });
      f.h.clock.at = 29000;
      assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'wait');
      assert.equal(f.execution.step.progress.effectiveMilliseconds, 0);
      f.reading.visible = true;
      assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    });
});

test('feed observation clock follows the visible document across live post text updates but not a navigation', async () =>
  fixture('feed', async (f) => {
    const first = await f.executor.decide(f.execution, () => {});
    assert.ok(first.kind === 'observe');
    f.reading.contentKey = 'same feed, live video timer 0:24 / 2:18';
    const second = await f.executor.decide(f.execution, () => {});
    assert.ok(second.kind === 'observe');
    assert.equal(second.observation.contentId, first.observation.contentId);
    f.reading.timeOrigin++;
    const next = await f.executor.decide(f.execution, () => {});
    assert.ok(next.kind === 'observe');
    assert.notEqual(next.observation.contentId, first.observation.contentId);
  }));

test('original visual wheel baseline confirms same-post movement after virtualization, never from unchanged, resized, wrong-direction or excessive geometry', async () => {
  for (const changed of [
    'advanced',
    'unchanged',
    'resized',
    'wrong-direction',
    'excessive',
    'hidden',
    'wrong-anchor',
    'legacy',
  ]) {
    await fixture('feed', async (f) => {
      f.reading.scrollY = 7904;
      await f.executor.decide(f.execution, () => {});
      f.h.clock.at = 1000;
      assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
      f.h.clock.at = 9000;
      const decision = await f.executor.decide(f.execution, () => {});
      assert.ok(decision.kind === 'action' && decision.action.kind === 'browseScroll');
      assert.ok(decision.intent.kind === 'auxiliary' && decision.intent.beforeContentId);
      const position = { left: 400, top: 100, width: 500, height: 1200, viewportHeight: 900 };
      const op = operation(f, decision.action);
      const start = {
        version: 2,
        url: f.reading.url,
        timeOrigin: f.reading.timeOrigin,
        scrollY: 7904,
        anchor: { contentId: decision.intent.beforeContentId, position },
      };
      if (changed === 'wrong-anchor') start.anchor.contentId = '0'.repeat(64);
      op.receipt = {
        binding: op.binding,
        evidence: {
          wheelStart:
            changed === 'legacy'
              ? { version: 1, url: start.url, timeOrigin: start.timeOrigin, scrollY: start.scrollY }
              : start,
        },
      };
      f.reading.scrollY = 6972;
      f.reading.contentPosition = { ...position, top: -455 };
      if (changed === 'unchanged') f.reading.contentPosition.top = 100;
      if (changed === 'resized') f.reading.contentPosition.height = 1600;
      if (changed === 'wrong-direction') f.reading.contentPosition.top = 655;
      if (changed === 'excessive') f.reading.contentPosition.top = -900;
      if (changed === 'hidden') f.reading.visible = false;
      const result = await f.executor.verify(f.execution, op, decision.intent, () => {});
      assert.equal(result.outcome, changed === 'advanced' ? 'VERIFIED' : 'WAIT');
      assert.equal(f.execution.step.progress.effectiveMilliseconds, 0);
      if (changed === 'unchanged') {
        assert.equal(
          result.receipt.evidence &&
            typeof result.receipt.evidence === 'object' &&
            !Array.isArray(result.receipt.evidence) &&
            'pending' in result.receipt.evidence &&
            BrowsePendingDiagnostic.parse(result.receipt.evidence.pending).version,
          2,
        );
      }
    });
  }
});

test('unrecognized feed content does not block exploration and execution-time wheel baseline survives layout contraction', async () =>
  fixture('feed', async (f) => {
    f.reading.contentKey = null;
    f.reading.scrollY = 8085;
    assert.deepEqual(await f.executor.decide(f.execution, () => {}), {
      kind: 'wait',
      reason: 'FACEBOOK_FEED_CONTENT_REQUIRED',
    });
    f.h.clock.at = 6000;
    const exploration = await f.executor.decide(f.execution, () => {});
    assert.ok(exploration.kind === 'action' && exploration.action.kind === 'browseScroll');
    const op = operation(f, exploration.action);
    op.receipt = {
      binding: op.binding,
      evidence: {
        sdkReturned: true,
        wheelStart: {
          version: 1,
          url: f.reading.url,
          timeOrigin: f.reading.timeOrigin,
          scrollY: 6504,
        },
      },
    };
    f.reading.scrollY = 7043;
    assert.equal(
      (await f.executor.verify(f.execution, op, exploration.intent, () => {})).outcome,
      'VERIFIED',
    );
    assert.equal(f.execution.step.progress.effectiveMilliseconds, 0);
    op.receipt = {
      binding: { ...op.binding, operationId: randomUUID() },
      evidence: {
        wheelStart: {
          version: 1,
          url: f.reading.url,
          timeOrigin: f.reading.timeOrigin,
          scrollY: 6504,
        },
      },
    };
    await assert.rejects(
      f.executor.verify(f.execution, op, exploration.intent, () => {}),
      /WHEEL_START_ORIGINAL_REQUIRED/,
    );
    f.reading.scrollY = 6504;
    f.reading.contentKey = 'loaded-next-post';
    f.h.clock.at = 26000;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 27000;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 35000;
    const decision = await f.executor.decide(f.execution, () => {});
    assert.ok(decision.kind === 'action' && decision.action.kind === 'browseScroll');
    assert.equal(decision.action.fromY, 6504);
    assert.ok(decision.intent.kind === 'auxiliary' && decision.intent.beforeContentId);
    assert.equal(f.execution.step.progress.effectiveMilliseconds, 0);
  }));

test('feed exploration settles when usable content appears after a virtual layout contraction, but never from ACK or a hidden/foreign document', async () =>
  fixture('feed', async (f) => {
    f.reading.contentKey = null;
    f.reading.scrollY = 8680;
    await f.executor.decide(f.execution, () => {});
    f.h.clock.at = 6000;
    const decision = await f.executor.decide(f.execution, () => {});
    assert.ok(decision.kind === 'action' && decision.action.kind === 'browseScroll');
    const op = operation(f, decision.action);
    f.reading.scrollY = 7174.4;
    assert.equal(
      (await f.executor.verify(f.execution, op, decision.intent, () => {})).outcome,
      'WAIT',
    );
    f.reading.contentKey = 'independently-loaded-visible-post';
    f.reading.visible = false;
    assert.equal(
      (await f.executor.verify(f.execution, op, decision.intent, () => {})).outcome,
      'WAIT',
    );
    f.reading.visible = true;
    f.reading.timeOrigin++;
    assert.equal(
      (await f.executor.verify(f.execution, op, decision.intent, () => {})).outcome,
      'WAIT',
    );
    f.reading.timeOrigin--;
    f.reading.blocked = true;
    assert.equal(
      (await f.executor.verify(f.execution, op, decision.intent, () => {})).outcome,
      'WAIT',
    );
    f.reading.blocked = false;
    assert.equal(
      (await f.executor.verify(f.execution, op, decision.intent, () => {})).outcome,
      'VERIFIED',
    );
    assert.equal(f.execution.step.progress.effectiveMilliseconds, 0);
  }));

test('feed and Reels loading or missing content have a bounded wait, while recovered content clears the prior wait', async () => {
  for (const type of ['feed', 'video'] as const)
    await fixture(type, async (f) => {
      f.reading.url =
        type === 'feed' ? 'https://www.facebook.com/' : 'https://www.facebook.com/reels/';
      f.reading.ready = false;
      assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'wait');
      f.h.clock.at = 31000;
      await assert.rejects(
        f.executor.decide(f.execution, () => {}),
        /LOADING_OR_DIALOG_TIMEOUT/,
      );
      f.reading.ready = true;
      if (type === 'video')
        f.reading.video = {
          css: 'video',
          source: 'blob:generated',
          paused: false,
          buffering: false,
          ended: false,
          timeSeconds: 1,
          playbackRate: 1,
        };
      assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
      f.reading.ready = false;
      f.h.clock.at = 50000;
      assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'wait');
    });
});

test('buffering Reels never become valid playback and end bounded waiting without blocking other profiles', async () =>
  fixture('video', async (f) => {
    f.reading.url = 'https://www.facebook.com/reels/';
    f.reading.video = {
      css: 'video',
      source: 'blob:generated',
      paused: false,
      buffering: true,
      ended: false,
      timeSeconds: 0,
      playbackRate: 1,
    };
    const observation = await f.executor.decide(f.execution, () => {});
    assert.ok(
      observation.kind === 'observe' &&
        observation.observation.type === 'video' &&
        observation.observation.buffering,
    );
    // Keep the same document so a stalled player cannot reset its wait by repainting.
    f.h.clock.at = 29000;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 31000;
    f.reading.timeOrigin++;
    await assert.rejects(
      f.executor.decide(f.execution, () => {}),
      /PLAYBACK_STALLED_TIMEOUT/,
    );
  }));

test('feed end and layout contraction settle a clipped wheel without inventing movement or leaving an unknown operation', async () =>
  fixture('feed', async (f) => {
    f.reading.scrollY = 8352;
    f.reading.scrollMaxY = 10000;
    await f.executor.decide(f.execution, () => {});
    f.h.clock.at = 1000;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 9000;
    const decision = await f.executor.decide(f.execution, () => {});
    assert.ok(decision.kind === 'action' && decision.action.kind === 'browseScroll');
    if (decision.kind !== 'action') throw Error('SCROLL_REQUIRED');
    const op = operation(f, decision.action);
    // Mirrors the observed real contraction: 8352 before wheel, 8100 at the new bottom.
    f.reading.scrollY = 8100;
    f.reading.scrollMaxY = 8100;
    assert.equal(
      (await f.executor.verify(f.execution, op, decision.intent, () => {})).outcome,
      'NOT_APPLIED',
    );
    f.h.clock.at = 21000;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.reading.timeOrigin++;
    assert.equal(
      (await f.executor.verify(f.execution, op, decision.intent, () => {})).outcome,
      'WAIT',
    );
  }));

test('virtual feed layout may decrease scrollTop while the original wheel advances the visible content', async () =>
  fixture('feed', async (f) => {
    f.reading.contentKey = 'observed-original-post';
    f.reading.scrollY = 6264;
    f.reading.scrollMaxY = 16000;
    await f.executor.decide(f.execution, () => {});
    f.h.clock.at = 1000;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 9000;
    const decision = await f.executor.decide(f.execution, () => {});
    assert.ok(decision.kind === 'action' && decision.action.kind === 'browseScroll');
    if (decision.kind !== 'action') throw Error('SCROLL_REQUIRED');
    const op = operation(f, decision.action);
    f.reading.scrollY = 5584;
    f.reading.contentKey = 'observed-next-post';
    assert.equal(
      (await f.executor.verify(f.execution, op, decision.intent, () => {})).outcome,
      'VERIFIED',
    );
    assert.equal(f.execution.step.progress.effectiveMilliseconds, 0);
    f.reading.contentKey = 'observed-original-post';
    const waiting = await f.executor.verify(f.execution, op, decision.intent, () => {});
    assert.equal(waiting.outcome, 'WAIT');
    const evidence = waiting.receipt.evidence;
    assert.ok(evidence && typeof evidence === 'object' && !Array.isArray(evidence));
    const diagnostic = BrowsePendingDiagnostic.parse(evidence.pending);
    assert.equal(diagnostic.scrollY, 5584);
    assert.equal(diagnostic.scrollMaxY, 16000);
    assert.equal(diagnostic.contentId?.length, 64);
    assert.ok(!JSON.stringify(diagnostic).includes('observed-original-post'));
    assert.equal(BrowsePendingDiagnostic.safeParse({ ...diagnostic, version: 2 }).success, false);
    f.reading.contentKey = 'observed-next-post';
    f.reading.visible = false;
    assert.equal(
      (await f.executor.verify(f.execution, op, decision.intent, () => {})).outcome,
      'WAIT',
    );
  }));

test('Marketplace routes isolate list/search from messages, selling and external destinations', () => {
  for (const route of [
    '/marketplace/',
    '/marketplace/search/?query=phone',
    '/marketplace/item/123/',
  ])
    assert.equal(facebookBrowseSurface('https://www.facebook.com' + route), 'marketplace');
  for (const route of [
    '/marketplace/create/',
    '/marketplace/you/selling/',
    '/messages/',
    '/marketplace/item/not-a-number/',
  ])
    assert.equal(facebookBrowseSurface('https://www.facebook.com' + route), null);
  assert.equal(facebookBrowseSurface('https://www.facebook.com.evil.example/marketplace/'), null);
  assert.equal(
    facebookMarketplaceItemURL('https://www.facebook.com/marketplace/item/123/?ref=feed'),
    'https://www.facebook.com/marketplace/item/123/',
  );
  assert.equal(facebookMarketplaceItemURL('https://www.facebook.com/marketplace/create/'), null);
  assert.equal(
    matchesMarketplaceSearch(facebookMarketplaceURL('手机 & phone'), '手机 & phone'),
    true,
  );
  assert.equal(
    matchesMarketplaceSearch(
      'https://www.facebook.com/marketplace/search/?query=phone&query=other',
      'phone',
    ),
    false,
  );
});

test('Marketplace detail dwell returns to the saved search and visits another observed item', async () =>
  fixture('marketplace', async (f) => {
    f.reading.url = facebookMarketplaceURL('手机 & phone');
    f.reading.contentKey = '/marketplace/item/123/|/marketplace/item/456/';
    f.reading.marketplaceItems = [
      'https://www.facebook.com/marketplace/item/123/',
      'https://www.facebook.com/marketplace/item/456/',
    ];
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 8000;
    const entry = await f.executor.decide(f.execution, () => {});
    assert.ok(entry.kind === 'action' && entry.action.kind === 'browseNavigate');
    assert.equal(entry.action.url, f.reading.marketplaceItems[0]);
    validateBrowseIntent(f.execution.step, entry.action, entry.intent);
    const operationEntry = operation(f, entry.action);
    f.reading.url = f.reading.marketplaceItems[1] ?? '';
    assert.equal(
      (await f.executor.verify(f.execution, operationEntry, entry.intent, () => {})).outcome,
      'WAIT',
    );
    f.reading.url = entry.action.url;
    f.reading.contentKey = null;
    assert.equal(
      (await f.executor.verify(f.execution, operationEntry, entry.intent, () => {})).outcome,
      'WAIT',
    );
    f.reading.contentKey = 'item:/marketplace/item/123';
    assert.equal(
      (await f.executor.verify(f.execution, operationEntry, entry.intent, () => {})).outcome,
      'VERIFIED',
    );
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 16000;
    const back = await f.executor.decide(f.execution, () => {});
    assert.ok(back.kind === 'action' && back.action.kind === 'browseNavigate');
    assert.equal(back.action.url, facebookMarketplaceURL('手机 & phone'));
    f.reading.url = back.action.url;
    f.reading.contentKey = '/marketplace/item/123/|/marketplace/item/456/';
    assert.equal(
      (await f.executor.verify(f.execution, operation(f, back.action), back.intent, () => {}))
        .outcome,
      'VERIFIED',
    );
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 24000;
    const second = await f.executor.decide(f.execution, () => {});
    assert.ok(second.kind === 'action' && second.action.kind === 'browseNavigate');
    assert.equal(second.action.url, f.reading.marketplaceItems[1]);
    f.reading.visible = false;
    const hidden = await f.executor.decide(f.execution, () => {});
    assert.ok(hidden.kind === 'action' && hidden.action.kind === 'activateTab');
  }));
test('Marketplace native category retains locale and region; both prices are required on the observed search', async () =>
  fixture('marketplace', async (f) => {
    const spec = StepSchema.parse({
      ...f.execution.step.spec,
      keyword: '',
      categoryId: '479353692612078',
      minPrice: 10,
      maxPrice: 200,
    });
    f.execution.step.spec = spec;
    const native =
      'https://www.facebook.com/marketplace/christchurch/search/?category_id=479353692612078&query=電子產品&referral_ui_component=category_menu_item';
    const target = facebookMarketplaceURL(spec.type === 'marketplace' ? spec : '', native);
    assert.equal(new URL(target).searchParams.get('query'), '電子產品');
    assert.equal(facebookBrowseSurface(target), 'marketplace');
    let decision = await f.executor.decide(f.execution, () => {});
    assert.ok(decision.kind === 'action' && decision.action.kind === 'browseNavigate');
    assert.equal(decision.action.url, 'https://www.facebook.com/marketplace/');
    validateBrowseIntent(f.execution.step, decision.action, decision.intent);
    f.reading.url = decision.action.url;
    assert.equal(
      (
        await f.executor.verify(
          f.execution,
          operation(f, decision.action),
          decision.intent,
          () => {},
        )
      ).outcome,
      'VERIFIED',
    );
    f.reading.marketplaceCategories = [native];
    decision = await f.executor.decide(f.execution, () => {});
    assert.ok(decision.kind === 'action' && decision.action.kind === 'browseNavigate');
    assert.equal(decision.action.url, target);
    validateBrowseIntent(f.execution.step, decision.action, decision.intent);
    const op = operation(f, decision.action);
    const filteredAction = decision.action,
      filteredIntent = decision.intent;
    const missingMinimum = new URL(target);
    missingMinimum.searchParams.delete('minPrice');
    f.reading.url = missingMinimum.href;
    assert.equal(
      (await f.executor.verify(f.execution, op, decision.intent, () => {})).outcome,
      'WAIT',
    );
    assert.throws(
      () =>
        validateBrowseIntent(
          f.execution.step,
          { ...filteredAction, url: missingMinimum.href },
          filteredIntent,
        ),
      /SEARCH_TARGET_CHANGED/,
    );
    f.reading.url = target;
    assert.equal(
      (await f.executor.verify(f.execution, op, decision.intent, () => {})).outcome,
      'VERIFIED',
    );
    f.reading.marketplaceItems = ['https://www.facebook.com/marketplace/item/123/'];
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 8000;
    decision = await f.executor.decide(f.execution, () => {});
    assert.ok(decision.kind === 'action' && decision.action.kind === 'browseNavigate');
    f.reading.url = decision.action.url;
    f.reading.marketplaceCategories = [];
    f.reading.contentKey = 'item:123';
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 16000;
    decision = await f.executor.decide(f.execution, () => {});
    assert.ok(decision.kind === 'action' && decision.action.kind === 'browseNavigate');
    assert.equal(decision.action.url, target);
  }));
test('Marketplace invalid price settings reject on save and duplicate filter params never match', () => {
  const base = {
    id: randomUUID(),
    type: 'marketplace',
    keyword: '',
    durationMinutes: 1,
    maxLikes: 0,
    minLikeCount: 0,
  };
  assert.equal(StepSchema.safeParse({ ...base, minPrice: 10 }).success, false);
  assert.equal(
    StepSchema.safeParse({ ...base, keyword: 'phone', minPrice: 200, maxPrice: 10 }).success,
    false,
  );
  const filter = { keyword: 'phone', minPrice: 0, maxPrice: 200 };
  const url = facebookMarketplaceURL(filter);
  assert.equal(matchesMarketplaceSearch(url, filter), true);
  assert.equal(matchesMarketplaceSearch(url + '&minPrice=0', filter), false);
  assert.equal(
    matchesMarketplaceSearch(url.replace('maxPrice=200', 'maxPrice=201'), filter),
    false,
  );
  assert.equal(facebookBrowseSurface('https://www.facebook.com/marketplace/inbox/search/'), null);
  // Reserved action/message routes cannot masquerade as regional search.
  assert.equal(facebookBrowseSurface('https://www.facebook.com/marketplace/inbox/'), null);
});
test('Marketplace executor keeps configured search, requires visible items and verifies only the original navigation', async () =>
  fixture('marketplace', async (f) => {
    const decision = BrowseDecision.parse(await f.executor.decide(f.execution, () => {}));
    assert.equal(decision.kind, 'action');
    if (decision.kind !== 'action') throw Error('NAVIGATION_REQUIRED');
    validateBrowseIntent(f.execution.step, decision.action, decision.intent);
    const op = operation(f, decision.action);
    f.reading.url = facebookMarketplaceURL('other');
    assert.equal(
      (await f.executor.verify(f.execution, op, decision.intent, () => {})).outcome,
      'WAIT',
    );
    assert.throws(
      () =>
        validateBrowseIntent(
          f.execution.step,
          { kind: 'browseNavigate', tabId: decision.intent.proof.tabId, url: f.reading.url },
          decision.intent,
        ),
      /SEARCH_TARGET_CHANGED/,
    );
    f.reading.url = facebookMarketplaceURL('手机 & phone');
    assert.equal(
      (await f.executor.verify(f.execution, op, decision.intent, () => {})).outcome,
      'VERIFIED',
    );
    f.reading.contentKey = null;
    f.h.clock.at = 20000;
    assert.deepEqual(await f.executor.decide(f.execution, () => {}), {
      kind: 'wait',
      reason: 'FACEBOOK_MARKETPLACE_ITEMS_REQUIRED',
    });
    f.reading.contentKey = '/marketplace/item/123/';
    const observation = await f.executor.decide(f.execution, () => {});
    assert.equal(observation.kind, 'observe');
    if (observation.kind === 'observe') assert.equal(observation.observation.type, 'marketplace');
    f.reading.visible = false;
    const activate = await f.executor.decide(f.execution, () => {});
    assert.equal(activate.kind, 'action');
    if (activate.kind === 'action') assert.equal(activate.action.kind, 'activateTab');
  }));

async function fixture(
  type: 'feed' | 'video' | 'marketplace' | 'friends',
  work: (f: {
    h: Awaited<ReturnType<typeof browseHarness>>;
    reading: BrowsePage;
    executor: FacebookBrowseStepExecutor;
    execution: Parameters<FacebookBrowseStepExecutor['decide']>[0];
  }) => Promise<void>,
  maxLikes = 0,
  primeEntry = true,
  friendsOptions: { acceptMode: 'count' | 'all'; maxAccepts: number } = {
    acceptMode: 'count',
    maxAccepts: 2,
  },
) {
  await settlementFixture(async (store) => {
    const h = await browseHarness(store, 1, {
      name: '浏览源码模拟',
      note: '不是FB验收',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [
        type === 'marketplace'
          ? {
              id: randomUUID(),
              type,
              durationMinutes: 1,
              maxLikes: 0,
              minLikeCount: 0,
              keyword: '手机 & phone',
            }
          : type === 'friends'
            ? {
                id: randomUUID(),
                type: 'friends',
                durationMinutes: 15,
                acceptMode: friendsOptions.acceptMode,
                maxAccepts: friendsOptions.maxAccepts,
                maxLikes: 0,
                minLikeCount: 0,
              }
            : { id: randomUUID(), type, durationMinutes: 1, maxLikes, minLikeCount: 0 },
      ],
    });
    const plan = await h.claim(),
      step = (await store.tasks.steps(plan.id))[0]!,
      session = h.sessions.get(plan.profileId)!;
    const reading = page();
    const executor = new FacebookBrowseStepExecutor(
      type,
      {
        read: async (_e, guard) => {
          await guard();
          return {
            context: session,
            proof: h.proofs.get(plan.profileId)!,
            page: structuredClone(reading),
          };
        },
      },
      () => true,
      () => h.clock.at,
      () => {},
      async (accountId: string | null, contentId: string) =>
        await store.browseIntents.hasAccountLiked(accountId, contentId),
    );
    const f = { h, reading, executor, execution: { plan, step, session } };
    if (primeEntry) {
      const proof = h.proofs.get(plan.profileId)!;
      await executor.verify(
        f.execution,
        operation(f, { kind: 'activateTab', tabId: proof.tabId }),
        { kind: 'auxiliary', purpose: 'activate', proof, documentEpoch: 0, routeEpoch: 0 },
        () => {},
      );
    }
    await work(f);
  });
}
function operation(
  f: Parameters<Parameters<typeof fixture>[1]>[0],
  action: Operation['action'],
): Operation & { binding: NonNullable<Operation['binding']> } {
  const id = randomUUID();
  return {
    id,
    jobId: f.execution.plan.id,
    stepId: f.execution.step.id,
    action,
    status: 'ACKNOWLEDGED' as const,
    receipt: null,
    checkpointApplied: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    binding: {
      ...f.execution.session,
      operationId: id,
      jobId: f.execution.plan.id,
      stepId: f.execution.step.id,
      actionDigest: createHash('sha256').update(JSON.stringify(action)).digest('hex'),
    },
  };
}

test('Watch navigation accepts the Reels redirect; play and scroll retain the exact current route', async () =>
  fixture('video', async (f) => {
    const navigation = await f.executor.decide(f.execution, () => {});
    if (navigation.kind !== 'action') throw Error('NAV_REQUIRED');
    for (const url of [
      'https://www.facebook.com/reels/',
      'https://www.facebook.com/reel/123456?mibextid=test',
    ]) {
      f.reading.url = url;
      assert.equal(
        (
          await f.executor.verify(
            f.execution,
            operation(f, navigation.action),
            navigation.intent,
            () => {},
          )
        ).outcome,
        'VERIFIED',
      );
      f.reading.video = {
        css: 'html>body>main>video',
        source: 'blob:sample',
        paused: true,
        buffering: false,
        ended: false,
        timeSeconds: 0,
        playbackRate: 1,
      };
      const play = await f.executor.decide(f.execution, () => {});
      assert.ok(play.kind === 'action' && play.action.kind === 'browsePlay');
      if (play.kind !== 'action' || play.action.kind !== 'browsePlay') throw Error('PLAY_REQUIRED');
      assert.equal(play.action.url, url);
      validateBrowseIntent(f.execution.step, play.action, play.intent);
      f.reading.video.ended = true;
      const scroll = await f.executor.decide(f.execution, () => {});
      assert.ok(scroll.kind === 'action' && scroll.action.kind === 'browseScroll');
      if (scroll.kind !== 'action' || scroll.action.kind !== 'browseScroll')
        throw Error('SCROLL_REQUIRED');
      assert.equal(scroll.action.url, url);
      validateBrowseIntent(f.execution.step, scroll.action, scroll.intent);
    }
    for (const url of [
      'https://www.facebook.com/login/',
      'https://www.facebook.com/groups/123',
      'https://www.facebook.com.evil.test/reels/',
    ]) {
      f.reading.url = url;
      assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'wait');
    }
  }));

test('feed observes, scrolls after its dwell and waits for original scroll effect without claiming an ACK is success', async () =>
  fixture('feed', async (f) => {
    assert.equal(
      BrowseDecision.parse(await f.executor.decide(f.execution, () => {})).kind,
      'observe',
    );
    f.h.clock.at = 1000;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 8000;
    const decision = BrowseDecision.parse(await f.executor.decide(f.execution, () => {}));
    assert.equal(decision.kind, 'action');
    if (decision.kind !== 'action') throw Error('ACTION_REQUIRED');
    assert.equal(decision.action.kind, 'browseScroll');
    validateBrowseIntent(f.execution.step, decision.action, decision.intent);
    const op = operation(f, decision.action);
    assert.equal(
      (await f.executor.verify(f.execution, op, decision.intent, () => {})).outcome,
      'WAIT',
    );
    f.reading.scrollY = 720;
    assert.equal(
      BrowseVerdict.parse(await f.executor.verify(f.execution, op, decision.intent, () => {}))
        .outcome,
      'VERIFIED',
    );
    // A large article/player can remain dominant after the wheel. Give it a fresh dwell
    // rather than immediately scrolling again and permanently losing timed observations.
    f.h.clock.at = 9000;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 10000;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 16000;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'action');
    f.reading.timeOrigin++;
    assert.equal(
      (await f.executor.verify(f.execution, op, decision.intent, () => {})).outcome,
      'WAIT',
    );
  }));

test('slow feed control cycles leave two observation opportunities before every loaded-content wheel', async () =>
  fixture('feed', async (f) => {
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 10000;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 20000;
    const decision = await f.executor.decide(f.execution, () => {});
    assert.ok(decision.kind === 'action' && decision.action.kind === 'browseScroll');
    const op = operation(f, decision.action);
    f.reading.scrollY = 720;
    assert.equal(
      (await f.executor.verify(f.execution, op, decision.intent, () => {})).outcome,
      'VERIFIED',
    );
    f.h.clock.at = 30000;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 40000;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.reading.blocked = true;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'wait');
    f.reading.blocked = false;
    f.h.clock.at = 50000;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 60000;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 70000;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'action');
    assert.equal(f.execution.step.progress.effectiveMilliseconds, 0);
  }));

test('video navigates, starts exact selected media, measures playback and advances ended media', async () =>
  fixture('video', async (f) => {
    const navigation = BrowseDecision.parse(await f.executor.decide(f.execution, () => {}));
    if (navigation.kind !== 'action' || navigation.action.kind !== 'browseNavigate')
      throw Error('NAV_REQUIRED');
    validateBrowseIntent(f.execution.step, navigation.action, navigation.intent);
    f.reading.url = navigation.action.url;
    assert.equal(
      (
        await f.executor.verify(
          f.execution,
          operation(f, navigation.action),
          navigation.intent,
          () => {},
        )
      ).outcome,
      'VERIFIED',
    );
    f.reading.video = {
      css: 'html>body>main>video',
      source: 'blob:generated',
      paused: true,
      buffering: true,
      ended: false,
      timeSeconds: 0,
      playbackRate: 1,
    };
    const play = BrowseDecision.parse(await f.executor.decide(f.execution, () => {}));
    if (play.kind !== 'action' || play.action.kind !== 'browsePlay') throw Error('PLAY_REQUIRED');
    validateBrowseIntent(f.execution.step, play.action, play.intent);
    const op = operation(f, play.action);
    f.reading.video.paused = false;
    assert.equal((await f.executor.verify(f.execution, op, play.intent, () => {})).outcome, 'WAIT');
    f.reading.video.buffering = false;
    assert.equal(
      (await f.executor.verify(f.execution, op, play.intent, () => {})).outcome,
      'VERIFIED',
    );
    f.reading.video.source = 'blob:other';
    assert.equal((await f.executor.verify(f.execution, op, play.intent, () => {})).outcome, 'WAIT');
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.reading.video.ended = true;
    const next = await f.executor.decide(f.execution, () => {});
    assert.ok(next.kind === 'action' && next.action.kind === 'browseScroll');
  }));

test('video entry cards navigate to their observed reel; missing players never trigger a blind wheel', async () =>
  fixture('video', async (f) => {
    f.reading.url = 'https://www.facebook.com/reels/';
    await f.executor.decide(f.execution, () => {});
    f.h.clock.at = 10000;
    const waiting = await f.executor.decide(f.execution, () => {});
    assert.equal(waiting.kind, 'wait');
    f.reading.videoEntry = 'https://www.facebook.com/reel/123';
    const entry = await f.executor.decide(f.execution, () => {});
    assert.ok(entry.kind === 'action' && entry.action.kind === 'browseNavigate');
    if (entry.kind !== 'action' || entry.action.kind !== 'browseNavigate')
      throw Error('ENTRY_REQUIRED');
    assert.equal(entry.action.url, f.reading.videoEntry);
    validateBrowseIntent(f.execution.step, entry.action, entry.intent);
  }));

test('loading, dialogs and hidden feed wait, configured likes are explicitly unsupported, wrong routes cannot be adopted', async () => {
  await fixture('feed', async (f) => {
    f.reading.ready = false;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'wait');
    f.reading.ready = true;
    f.reading.blocked = true;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'wait');
    f.reading.blocked = false;
    f.reading.visible = false;
    const decision = await f.executor.decide(f.execution, () => {});
    assert.deepEqual(decision, { kind: 'wait', reason: 'FACEBOOK_BROWSE_FOREGROUND_REQUIRED' });
    f.reading.url = 'https://www.facebook.com/checkpoint/';
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'wait');
  });
  await fixture('marketplace', async (f) => {
    (f.execution.step.spec as { maxLikes: number }).maxLikes = 1;
    assert.deepEqual(await f.executor.decide(f.execution, () => {}), {
      kind: 'wait',
      reason: 'BROWSE_LIKE_EXECUTOR_UNAVAILABLE',
    });
  });
});

test('changed owner, proof and binding cannot settle a browse action; route and purpose cannot escape the step', async () =>
  fixture('feed', async (f) => {
    const intent: Intent = {
      kind: 'auxiliary',
      purpose: 'advance',
      proof: f.h.proofs.get(f.execution.plan.profileId)!,
      documentEpoch: 0,
      routeEpoch: 0,
    };
    assert.throws(
      () =>
        validateBrowseIntent(
          f.execution.step,
          {
            kind: 'browseNavigate',
            tabId: intent.proof.tabId,
            url: 'https://www.facebook.com/watch/',
          },
          intent,
        ),
      /PURPOSE_REJECTED/,
    );
    const action = {
      kind: 'browseNavigate' as const,
      tabId: intent.proof.tabId,
      url: 'https://www.facebook.com/' as const,
    };
    const op = operation(f, action);
    await assert.rejects(
      f.executor.verify(
        f.execution,
        { ...op, binding: { ...op.binding, accountId: 'wrong' } },
        intent,
        () => {},
      ),
      /ORIGINAL_REQUIRED/,
    );
    await assert.rejects(
      f.executor.verify(
        f.execution,
        op,
        { ...intent, proof: { ...intent.proof, targetId: 'other' } },
        () => {},
      ),
      /ORIGINAL_REQUIRED/,
    );
    await assert.rejects(
      f.executor.decide(
        { ...f.execution, session: { ...f.execution.session, leaseId: randomUUID() } },
        () => {},
      ),
      /OWNER_REQUIRED/,
    );
  }));

for (const type of ['feed', 'marketplace'] as const)
  test(
    'original SQLite runner completes ' +
      type +
      ' duration with navigation/scroll and no publication ledger',
    async () =>
      fixture(type, async (f) => {
        if (type === 'marketplace')
          f.reading.marketplaceItems = [
            'https://www.facebook.com/marketplace/item/123/',
            'https://www.facebook.com/marketplace/item/456/',
          ];
        const port = f.h.ports.get(f.execution.plan.profileId)!,
          send = port.sendGuarded!;
        port.sendGuarded = async (op, guard) => {
          const result = await send(op, guard);
          if (op.action.kind === 'browseScroll') {
            f.reading.scrollY += op.action.deltaY;
            f.reading.contentKey = 'generated-article-' + f.reading.scrollY;
          }
          if (op.action.kind === 'browseNavigate') {
            f.reading.url = op.action.url;
            if (type === 'marketplace')
              f.reading.contentKey = facebookMarketplaceItemURL(op.action.url)
                ? 'item:' + op.action.url
                : 'generated-list';
          }
          return result;
        };
        const runner = new TaskStepRunner(
          f.h.store.tasks,
          f.h.store.browseIntents,
          f.h.store.taskTabs,
          f.h.host,
          [f.executor],
          f.h.clock,
          randomUUID,
        );
        for (
          let i = 0;
          i < 160 && (await f.h.store.tasks.get(f.execution.plan.id)).state === 'RUNNING';
          i++
        ) {
          f.h.clock.at = i * 1000;
          await runner.advance(f.execution.plan.id);
        }
        assert.equal((await f.h.store.tasks.get(f.execution.plan.id)).state, 'COMPLETED');
        assert.equal(
          (await f.h.store.tasks.steps(f.execution.plan.id))[0]?.progress.effectiveMilliseconds,
          60000,
        );
        assert.ok(
          (await f.h.store.tasks.operations(f.execution.plan.id)).every(
            (op) =>
              ['browseScroll', 'browseNavigate'].includes(op.action.kind) &&
              op.status === 'VERIFIED',
          ),
        );
        assert.equal((await f.h.store.materials.forPlan(f.execution.plan.id)).length, 0);
        if (type === 'marketplace')
          assert.ok(
            (await f.h.store.tasks.operations(f.execution.plan.id)).some(
              (op) =>
                op.action.kind === 'browseNavigate' && facebookMarketplaceItemURL(op.action.url),
            ),
          );
      }),
  );

test('empty Marketplace does not run forever or credit invisible content', async () =>
  fixture('marketplace', async (f) => {
    f.reading.url = facebookMarketplaceURL('手机 & phone');
    f.reading.contentKey = null;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'wait');
    f.h.clock.at = 30000;
    await assert.rejects(
      f.executor.decide(f.execution, () => {}),
      /FACEBOOK_MARKETPLACE_ITEMS_REQUIRED_TIMEOUT/,
    );
    f.reading.contentKey = '/marketplace/item/123/';
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
  }));

test('human-like recommendedDwellMs and nextScrollDeltaY govern feed framing and Reels duration-based dwell', async () => {
  await fixture('feed', async (f) => {
    f.reading.recommendedDwellMs = 11_500;
    f.reading.nextScrollDeltaY = 485;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 8000;
    // Still dwelling because recommendedDwellMs is 11.5s (> legacy 5.2s)
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 12_000;
    const decision = await f.executor.decide(f.execution, () => {});
    assert.ok(decision.kind === 'action' && decision.action.kind === 'browseScroll');
    if (decision.kind === 'action' && decision.action.kind === 'browseScroll')
      assert.equal(decision.action.deltaY, 485);
  });
  await fixture('video', async (f) => {
    f.reading.url = 'https://www.facebook.com/reel/888/';
    f.reading.contentKey = 'reel-888';
    f.reading.nextReelCSS = FACEBOOK_REEL_NEXT_CSS;
    f.reading.recommendedDwellMs = 14_200;
    f.reading.video = {
      css: 'video',
      source: 'reel-888',
      paused: false,
      buffering: false,
      ended: false,
      readyState: 4,
      timeSeconds: 2,
      durationSeconds: 18,
      playbackRate: 1,
    };
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 10_000;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 15_000;
    const advance = await f.executor.decide(f.execution, () => {});
    assert.ok(advance.kind === 'action' && advance.action.kind === 'click');
  });
});

test('friends step navigates to /friends/requests/, confirms requests with DOM verification, and completes by count or exhaustion', async () => {
  await fixture(
    'friends',
    async (f) => {
      // 1. Navigates from home to /friends/requests/
      const nav = await f.executor.decide(f.execution, () => {});
      assert.ok(
        nav.kind === 'action' &&
          nav.action.kind === 'browseNavigate' &&
          nav.action.url === FACEBOOK_FRIENDS_REQUESTS_URL,
      );
      if (nav.kind !== 'action') throw Error('NAV_REQUIRED');
      validateBrowseIntent(f.execution.step, nav.action, nav.intent);

      const port = f.h.ports.get(f.execution.plan.profileId)!,
        send = port.sendGuarded!;
      let pending = 3;
      f.reading.url = FACEBOOK_FRIENDS_REQUESTS_URL;
      f.reading.contentKey = 'friend-req-1';
      f.reading.friendConfirmCSS = FACEBOOK_FRIEND_CONFIRM_CSS;
      f.reading.friendPendingCount = pending;
      f.reading.recommendedDwellMs = 1500;

      port.sendGuarded = async (op, guard) => {
        const result = await send(op, guard);
        if (op.action.kind === 'click' && op.action.target.css === FACEBOOK_FRIEND_CONFIRM_CSS) {
          pending--;
          f.reading.friendPendingCount = pending;
          f.reading.contentKey =
            pending > 0 ? 'friend-req-' + (4 - pending) : 'FRIENDS_REQUESTS_EXHAUSTED';
          if (pending === 0) delete f.reading.friendConfirmCSS;
        }
        return result;
      };

      const runner = new TaskStepRunner(
        f.h.store.tasks,
        f.h.store.browseIntents,
        f.h.store.taskTabs,
        f.h.host,
        [f.executor],
        f.h.clock,
        randomUUID,
      );
      for (
        let i = 0;
        i < 30 && (await f.h.store.tasks.get(f.execution.plan.id)).state === 'RUNNING';
        i++
      ) {
        f.h.clock.at = i * 2000;
        await runner.advance(f.execution.plan.id);
      }
      assert.equal((await f.h.store.tasks.get(f.execution.plan.id)).state, 'COMPLETED');
      assert.equal((await f.h.store.tasks.steps(f.execution.plan.id))[0]?.progress.accepted, 2);
      assert.equal(pending, 1);
    },
    0,
    true,
    { acceptMode: 'count', maxAccepts: 2 },
  );

  await fixture(
    'friends',
    async (f) => {
      const port = f.h.ports.get(f.execution.plan.profileId)!,
        send = port.sendGuarded!;
      let pending = 1;
      f.reading.url = FACEBOOK_FRIENDS_REQUESTS_URL;
      f.reading.contentKey = 'friend-req-only-1';
      f.reading.friendConfirmCSS = FACEBOOK_FRIEND_CONFIRM_CSS;
      f.reading.friendPendingCount = pending;
      f.reading.recommendedDwellMs = 1500;

      port.sendGuarded = async (op, guard) => {
        const result = await send(op, guard);
        if (op.action.kind === 'click' && op.action.target.css === FACEBOOK_FRIEND_CONFIRM_CSS) {
          pending = 0;
          f.reading.friendPendingCount = 0;
          f.reading.contentKey = 'FRIENDS_REQUESTS_EXHAUSTED';
          delete f.reading.friendConfirmCSS;
        }
        return result;
      };

      const runner = new TaskStepRunner(
        f.h.store.tasks,
        f.h.store.browseIntents,
        f.h.store.taskTabs,
        f.h.host,
        [f.executor],
        f.h.clock,
        randomUUID,
      );
      for (
        let i = 0;
        i < 20 && (await f.h.store.tasks.get(f.execution.plan.id)).state === 'RUNNING';
        i++
      ) {
        f.h.clock.at = i * 2000;
        await runner.advance(f.execution.plan.id);
      }
      assert.equal((await f.h.store.tasks.get(f.execution.plan.id)).state, 'COMPLETED');
      assert.equal((await f.h.store.tasks.steps(f.execution.plan.id))[0]?.progress.accepted, 1);
    },
    0,
    true,
    { acceptMode: 'all', maxAccepts: 500 },
  );
});

test('Marketplace resets leftover item detail route on new step start and alternates item visits with list scrolling when recommendedDwellMs is present', async () =>
  fixture('marketplace', async (f) => {
    const searchUrl = facebookMarketplaceURL('手机 & phone');
    // 1. Retained tab left on a detail route from a previous task/step must navigate to searchUrl first
    f.reading.url = 'https://www.facebook.com/marketplace/item/4627178774179934/';
    f.reading.contentKey = 'item:/marketplace/item/4627178774179934';
    const resetNav = await f.executor.decide(f.execution, () => {});
    assert.ok(resetNav.kind === 'action' && resetNav.action.kind === 'browseNavigate');
    if (resetNav.kind === 'action' && resetNav.action.kind === 'browseNavigate') {
      assert.equal(resetNav.action.url, searchUrl);
    }

    // 2. On list page with recommendedDwellMs, visits item 1 after recommendedDwellMs
    f.reading.url = searchUrl;
    f.reading.contentKey = '/marketplace/item/111/|/marketplace/item/222/';
    f.reading.marketplaceItems = [
      'https://www.facebook.com/marketplace/item/111/',
      'https://www.facebook.com/marketplace/item/222/',
    ];
    f.reading.recommendedDwellMs = 2800;
    f.reading.nextScrollDeltaY = 460;
    f.reading.scrollY = 0;
    f.reading.scrollMaxY = 2400;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 3000;
    const visitFirst = await f.executor.decide(f.execution, () => {});
    assert.ok(visitFirst.kind === 'action' && visitFirst.action.kind === 'browseNavigate');
    if (visitFirst.kind === 'action' && visitFirst.action.kind === 'browseNavigate') {
      assert.equal(visitFirst.action.url, 'https://www.facebook.com/marketplace/item/111/');
    }

    // 3. On item 1 detail page, dwells for recommendedDwellMs and navigates back to searchUrl
    f.reading.url = 'https://www.facebook.com/marketplace/item/111/';
    f.reading.contentKey = 'item:/marketplace/item/111';
    f.reading.recommendedDwellMs = 3100;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 6200;
    const backToList = await f.executor.decide(f.execution, () => {});
    assert.ok(backToList.kind === 'action' && backToList.action.kind === 'browseNavigate');
    if (backToList.kind === 'action' && backToList.action.kind === 'browseNavigate') {
      assert.equal(backToList.action.url, searchUrl);
    }

    // 4. Back on list page after 1 viewed item (viewed.items.size === 1, scrollY < 700), alternates with list scroll
    f.reading.url = searchUrl;
    f.reading.contentKey = '/marketplace/item/111/|/marketplace/item/222/';
    f.reading.recommendedDwellMs = 2500;
    f.reading.nextScrollDeltaY = 480;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 7500;
    assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
    f.h.clock.at = 9000;
    const scrollList = await f.executor.decide(f.execution, () => {});
    assert.ok(scrollList.kind === 'action' && scrollList.action.kind === 'browseScroll');
    if (scrollList.kind === 'action' && scrollList.action.kind === 'browseScroll') {
      assert.equal(scrollList.action.deltaY, 480);
    }
  }));

test('feed filtered random liking respects sponsored, minLikeCount, keyword filters, probability, and verifies DOM liked state', async () =>
  fixture(
    'feed',
    async (f) => {
      f.execution.step.spec = StepSchema.parse({
        ...f.execution.step.spec,
        maxLikes: 2,
        minLikeCount: 10,
        likeProbability: 100,
        includeKeywords: '折扣, 好物',
        excludeKeywords: '诈骗',
        skipSponsored: true,
      });

      // 1. Sponsored post is skipped -> falls through to scroll after dwell
      f.reading.contentKey = 'post-sponsored-1';
      f.reading.recommendedDwellMs = 2000;
      f.reading.likeTarget = {
        css: FACEBOOK_BROWSE_LIKE_CSS,
        liked: false,
        likeCount: 50,
        sponsored: true,
        text: '限时折扣好物推荐',
      };
      assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
      f.h.clock.at = 1000;
      assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
      f.h.clock.at = 2500;
      const dSponsored = await f.executor.decide(f.execution, () => {});
      assert.ok(dSponsored.kind === 'action' && dSponsored.action.kind === 'browseScroll');

      // 2. Post matching all filters triggers like click after ~1.8s observation
      f.reading.scrollY = 500;
      f.reading.contentKey = 'post-valid-2';
      const validLikeTarget = {
        css: FACEBOOK_BROWSE_LIKE_CSS as typeof FACEBOOK_BROWSE_LIKE_CSS,
        liked: false,
        likeCount: 25,
        sponsored: false,
        text: '今日好物分享给大家',
      };
      f.reading.likeTarget = validLikeTarget;
      f.h.clock.at = 3000;
      assert.equal((await f.executor.decide(f.execution, () => {})).kind, 'observe');
      f.h.clock.at = 5000;
      const dLike = await f.executor.decide(f.execution, () => {});
      assert.ok(
        dLike.kind === 'action' &&
          dLike.action.kind === 'click' &&
          dLike.action.target.css === FACEBOOK_BROWSE_LIKE_CSS &&
          dLike.intent.kind === 'like',
      );
      if (dLike.kind !== 'action') throw Error('LIKE_ACTION_REQUIRED');
      validateBrowseIntent(f.execution.step, dLike.action, dLike.intent);

      // Verify waits until DOM reflects liked === true
      const likeOp = operation(f, dLike.action);
      assert.equal(
        (await f.executor.verify(f.execution, likeOp, dLike.intent, () => {})).outcome,
        'WAIT',
      );
      validLikeTarget.liked = true;
      const verified = await f.executor.verify(f.execution, likeOp, dLike.intent, () => {});
      assert.equal(verified.outcome, 'VERIFIED');
      if (verified.outcome === 'VERIFIED') {
        assert.equal(verified.effect.kind, 'liked');
      }
    },
    2,
  ));

test('hidden decide reaches its deadline without granting browsing time or input', async () => {
  await fixture('feed', async (f) => {
    f.reading.visible = false;
    await f.executor.decide(f.execution, () => {});
    f.h.clock.at = 30000;
    await assert.rejects(
      f.executor.decide(f.execution, () => {}),
      /FACEBOOK_BROWSE_FOREGROUND_REQUIRED_TIMEOUT/,
    );
    assert.equal(f.execution.step.progress.effectiveMilliseconds, 0);
  });
});

test('structured marketplace empty-state denial fails immediately with unchanged URL', async () => {
  await fixture('marketplace', async (f) => {
    f.reading.url = 'https://www.facebook.com/marketplace/';
    f.reading.marketplaceUnavailable = true;
    f.reading.contentKey = null;
    await assert.rejects(
      f.executor.decide(f.execution, () => {}),
      /FACEBOOK_MARKETPLACE_UNAVAILABLE/,
    );
    assert.equal(f.execution.step.progress.effectiveMilliseconds, 0);
  });
});
