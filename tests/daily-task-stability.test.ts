import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { KernelManagedFacebookSession } from '../src/infrastructure/kernel-managed-facebook-session.js';
import { NativeFacebookTaskAuthority } from '../src/infrastructure/facebook-task-authority.js';
import { canonicalAction } from '../src/shared/browser-actions.js';
import type { Action } from '../src/shared/browser-actions.js';
import type { NativeInputGuard } from '../src/application/native-input-gate.js';
import { FacebookBrowsePage } from '../src/infrastructure/facebook-browse-reader.js';

test('paired native mouse release keeps ownership checks but does not re-read its pressed target', async () => {
  const context = {
    profileId: randomUUID(),
    accountId: '123',
    connectionEpoch: randomUUID(),
    leaseId: randomUUID(),
    generation: 1,
  };
  const proof = {
    profileId: context.profileId,
    ownershipId: randomUUID(),
    browserSessionEpoch: randomUUID(),
    tabId: 1,
    targetId: 'test',
  };
  const action: Action = {
    kind: 'click',
    tabId: 1,
    documentEpoch: 0,
    routeEpoch: 0,
    target: { css: '[data-wb-browse-like="1"]' },
  };
  const binding = {
    ...context,
    operationId: randomUUID(),
    jobId: randomUUID(),
    stepId: randomUUID(),
    actionDigest: createHash('sha256').update(canonicalAction(action)).digest('hex'),
  };
  let resourceGuard: NativeInputGuard,
    targetReads = 0,
    ownerChecks = 0,
    stop = false;
  const counts: number[] = [];
  const dispatch = async (type: string) => {
    await resourceGuard({
      target: { tabId: 1 },
      method: 'Input.dispatchMouseEvent',
      params: { type, button: 'left' },
    });
    counts.push(targetReads);
  };
  const page = {
    url: () => 'https://www.facebook.com/reels/',
    bringToFront: async () => {},
    locator: () => ({}),
    evaluate: async () => ({
      x: 50,
      y: 100,
      left: 20,
      top: 80,
      width: 60,
      height: 40,
      url: 'https://www.facebook.com/reels/',
      timeOrigin: 1,
      needsScroll: false,
    }),
    mouse: {
      click: async () => {
        await dispatch('mousePressed');
        await dispatch('mouseReleased');
      },
    },
  };
  const session = Object.create(
    KernelManagedFacebookSession.prototype,
  ) as KernelManagedFacebookSession;
  const connection = {
    proof,
    browser: { contexts: () => [{ pages: () => [page] }] },
    context: async () => context,
    execute: async (
      _binding: unknown,
      work: () => Promise<void>,
      _guard: unknown,
      _failure: unknown,
      guard: NativeInputGuard,
    ) => {
      resourceGuard = guard;
      await work();
      return { binding, value: undefined, targetUnavailableBeforeInput: false };
    },
  };
  for (const [key, value] of Object.entries({
    context,
    connection,
    plan: { id: binding.jobId },
    failure: async () => {},
    authority: {
      assertIdentity: async () => {
        ownerChecks++;
        if (stop) throw Error('STOPPED');
      },
      assertTarget: async () => {
        targetReads++;
      },
    },
    tabs: { assertForInput: async () => {} },
    tasks: { steps: async () => [{ id: binding.stepId, spec: { type: 'video' } }] },
  }))
    Reflect.set(session, key, value);
  const operation = {
    id: binding.operationId,
    jobId: binding.jobId,
    stepId: binding.stepId,
    action,
    binding,
  } as Parameters<KernelManagedFacebookSession['sendGuarded']>[0];
  await session.sendGuarded(operation, async () => {});
  assert.equal(counts.length, 2);
  assert.equal(counts[0], counts[1]);
  assert.ok(targetReads >= 3);
  assert.ok(ownerChecks > targetReads);
  // A subsequent unpaired release cannot reuse the previous operation's approval.
  const before = targetReads;
  await dispatch('mouseReleased');
  assert.ok(targetReads > before);
  stop = true;
  await assert.rejects(dispatch('mouseReleased'), /STOPPED/);
});

test('transient identity read retries once without revocation; explicit account change revokes immediately', async () => {
  const authority = Object.create(
    NativeFacebookTaskAuthority.prototype,
  ) as NativeFacebookTaskAuthority;
  Reflect.set(authority, 'assertLive', async () => {});
  const read = Reflect.get(authority, 'readWithRetry').bind(authority) as <T>(
    fn: () => Promise<T>,
  ) => Promise<T>;
  let calls = 0;
  assert.equal(
    await read(async () => {
      if (++calls === 1) throw Error('FACEBOOK_IDENTITY_UNCONFIRMED');
      return 'recovered';
    }),
    'recovered',
  );
  assert.equal(calls, 2);
  assert.notEqual(Reflect.get(authority, 'revoked'), true);
  calls = 0;
  await assert.rejects(
    read(async () => {
      calls++;
      throw Error('FACEBOOK_IDENTITY_UNCONFIRMED');
    }),
  );
  assert.equal(calls, 2);
  assert.notEqual(Reflect.get(authority, 'revoked'), true);
  calls = 0;
  await assert.rejects(
    read(async () => {
      calls++;
      throw Error('FACEBOOK_NATIVE_ACCOUNT_CHANGED');
    }),
  );
  assert.equal(calls, 1);
  assert.equal(Reflect.get(authority, 'revoked'), true);
});

test('zero playbackRate is a readable transition, not identity failure or credited playback', () => {
  const sample = {
    url: 'https://www.facebook.com/reels/',
    timeOrigin: 1,
    ready: true,
    visible: true,
    blocked: false,
    scrollY: 0,
    viewportHeight: 720,
    contentKey: 'reel',
    video: {
      css: 'video',
      source: 'test',
      timeSeconds: 1,
      durationSeconds: 60,
      paused: true,
      buffering: true,
      ended: false,
      readyState: 2,
      playbackRate: 0,
    },
  };
  const parsed = FacebookBrowsePage.safeParse(sample);
  assert.ok(parsed.success, JSON.stringify(parsed.error));
  assert.equal(parsed.data.video?.playbackRate, 0);
});
