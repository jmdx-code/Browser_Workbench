import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { KernelExecutor } from '../src/application/kernel-executor.js';
import { KernelLease } from '../src/domain/kernel-lease.js';
import { readOwnedFacebookNativeResult } from '../src/infrastructure/kernel-facebook-result-lookup.js';
import {
  LookupNativeFacebookPostResultResolver,
  matchObservedFacebookNativeResult,
} from '../src/infrastructure/facebook-native-result-resolver.js';
import type { KernelBackend, KernelJsonObject } from '../src/shared/kernel-protocol.js';
import type { KernelState } from '../src/shared/kernel-state.js';
import type { FacebookPostOriginal } from '../src/domain/facebook-post-execution.js';
import type { PostEffects } from '../src/shared/facebook-post-observation.js';
import { TaskChildPageLifecycle, type ChildPageLifecycle } from '../src/shared/task-child-page.js';
import {
  facebookNativeResultUrl,
  sameFacebookNativeResultUrl,
} from '../src/shared/facebook-result-route.js';

test('video lookup follows the observed native link without trailing slash, preserving exact numeric route matching', () => {
  const actual = facebookNativeResultUrl(
    '10000000000004',
    '122142923169217254',
    '1584031386340020',
  );
  assert.equal(actual, 'https://www.facebook.com/reel/1584031386340020');
  assert.equal(sameFacebookNativeResultUrl(actual + '/', actual), true);
  assert.equal(sameFacebookNativeResultUrl(actual + '?other=1', actual), false);
  assert.equal(sameFacebookNativeResultUrl(actual + '1', actual), false);
});

const accountId = '10000000000001',
  nativePostId = '122203993346793784',
  photoId = '122203993178793784';
const alias = 'pfbid02QLXVgB872hh1pkkz9d711YYxv6RG1Yv2LjvcwPjuLDM6ybNhEYtX6DfaB4CK4mdpl';
const url =
  'https://www.facebook.com/permalink.php?story_fbid=' + nativePostId + '&id=' + accountId;
// Actual numeric-to-visible identifiers above are from native-numeric-result-alias.json.
// This fixture supplies only generated DOM fields and a simulated native owner.
const effects = (): PostEffects => ({
  url,
  timeOrigin: 1000,
  ready: 'complete',
  composer: null,
  posts: [
    {
      accountId,
      postId: alias,
      permalink: 'https://www.facebook.com/permalink.php?story_fbid=' + alias + '&id=' + accountId,
      text: '完整正文\n测试',
      expanded: true,
      nestedShare: false,
      photos: [photoId],
      videoId: null,
      videoReady: false,
    },
  ],
});
function fixture(
  options: {
    wrongClose?: boolean;
    revoke?: boolean;
    wrongUrl?: boolean;
    videoId?: string;
    readings?: PostEffects[];
    projectionError?: boolean;
    badPayload?: boolean;
    transientContext?: boolean;
    transientError?: string;
    unknownContext?: boolean;
    userClosed?: boolean;
    recycledClosed?: boolean;
  } = {},
) {
  const profileId = randomUUID(),
    browserSessionEpoch = randomUUID(),
    ownershipId = randomUUID();
  const proof = {
    profileId,
    browserSessionEpoch,
    ownershipId,
    tabId: 1,
    targetId: 'original-target',
  };
  const inventory: KernelState = {
    version: 1,
    profileId,
    browserSessionEpoch,
    tabs: [{ ownershipId, proof, state: 'READY', url: 'https://www.facebook.com/', reason: '' }],
    operations: [],
  };
  const created: string[] = [],
    removed: number[] = [],
    commands: string[] = [];
  let current = true;
  const backend: KernelBackend = {
    scope: async () => {},
    attach: async (tabId) => ({
      targetId: tabId === 1 ? 'original-target' : 'lookup-target',
      type: 'page',
      title: '',
      url,
      attached: true,
    }),
    detach: async () => {},
    create: async (targetUrl, id, foreground) => {
      assert.ok(id);
      assert.equal(foreground, Boolean(options.videoId || targetUrl.includes('/reel/')));
      created.push(targetUrl);
      const p = { ...proof, ownershipId: id, tabId: 2, targetId: 'lookup-target' };
      inventory.tabs.push({
        ownershipId: id,
        proof: p,
        state: 'READY',
        url: targetUrl,
        reason: '',
      });
      return { tabId: 2 };
    },
    remove: async (tabId) => {
      removed.push(tabId);
      if (!options.wrongClose) {
        const row = inventory.tabs.find((r) => r.proof?.tabId === tabId);
        if (row) row.state = 'CLOSED';
      }
    },
    send: async (_target, method): Promise<KernelJsonObject> => {
      commands.push(method);
      if (options.userClosed || options.recycledClosed) {
        const child = inventory.tabs.find((row) => row.proof?.tabId === 2);
        assert.ok(child?.proof);
        child.state = 'CLOSED';
        if (options.recycledClosed) child.proof = { ...child.proof, targetId: 'recycled-target' };
        throw Error('RESULT_CHILD_CLOSED_DURING_READ');
      }
      if (options.unknownContext) throw Error('KERNEL_RPC_RESULT_UNKNOWN');
      if (options.transientError && commands.length === 1) throw Error(options.transientError);
      if (options.transientContext && commands.length === 1)
        throw Error('{"code":-32000,"message":"Cannot find default execution context"}');
      if (options.projectionError) return { exceptionDetails: { text: 'projection failed' } };
      if (options.badPayload) return { result: { value: '{bad json' } };
      if (options.revoke) current = false;
      const reading = effects();
      if (options.videoId) {
        reading.url = 'https://www.facebook.com/reel/' + options.videoId + '/';
        reading.posts[0] = {
          ...reading.posts[0]!,
          postId: options.videoId,
          permalink: reading.url,
          photos: [],
          videoId: options.videoId,
          videoReady: true,
        };
      }
      if (options.wrongUrl) reading.url = 'https://www.facebook.com/';
      return {
        result: {
          value: JSON.stringify(
            options.readings?.[Math.min(commands.length - 1, options.readings.length - 1)] ??
              reading,
          ),
        },
      };
    },
  };
  const lease = new KernelLease(profileId, randomUUID()),
    executor = new KernelExecutor(lease, backend, [1], new Set(), 'facebook-task');
  executor.grant({
    profileId,
    connectionEpoch: lease.connectionEpoch,
    leaseId: randomUUID(),
    generation: 0,
    expiresAt: Date.now() + 10_000,
  });
  return {
    proof,
    inventory,
    executor,
    created,
    removed,
    commands,
    guard: () => {
      if (!current) throw Error('ORIGINAL_ACTOR_REVOKED');
    },
  };
}
test('result child lifecycle links original parent and records only independently confirmed close', async () => {
  for (const wrongClose of [false, true]) {
    const f = fixture({ wrongClose });
    const records: ChildPageLifecycle[] = [];
    const reading = readOwnedFacebookNativeResult(
      f.executor,
      async () => f.inventory,
      f.proof,
      accountId,
      nativePostId,
      f.guard,
      { lifecycle: (value) => records.push(value) },
    );
    if (wrongClose) await assert.rejects(reading, /NATIVE_RESULT_CLOSE_UNCONFIRMED/);
    else await reading;
    assert.deepEqual(
      records.map((row) => row.state),
      wrongClose ? ['REQUESTED', 'READY'] : ['REQUESTED', 'READY', 'CLOSED'],
    );
    assert.ok(records.every((row) => row.role === 'publication-result' && row.parent.tabId === 1));
    assert.equal(new Set(records.map((row) => row.ownershipId)).size, 1);
    assert.deepEqual(f.removed, [2]);
  }
});

test('failed lifecycle persistence cannot leave a freshly proven result child open', async () => {
  const f = fixture();
  const states: string[] = [];
  await assert.rejects(
    readOwnedFacebookNativeResult(
      f.executor,
      async () => f.inventory,
      f.proof,
      accountId,
      nativePostId,
      f.guard,
      {
        lifecycle: (value) => {
          states.push(value.state);
          if (value.state === 'READY') throw Error('LIFECYCLE_STORAGE_FAILED');
        },
      },
    ),
    /LIFECYCLE_STORAGE_FAILED/,
  );
  assert.deepEqual(states, ['REQUESTED', 'READY', 'CLOSED']);
  assert.deepEqual(f.removed, [2]);
  assert.equal(f.commands.length, 0);
});

test('child role evidence rejects parent reuse and cross-profile ownership', () => {
  const f = fixture();
  const ownershipId = randomUUID();
  const valid = {
    version: 1,
    role: 'publication-result',
    ownershipId,
    parent: f.proof,
    child: { ...f.proof, ownershipId, tabId: 2, targetId: 'child' },
    state: 'READY',
  };
  assert.equal(TaskChildPageLifecycle.safeParse(valid).success, true);
  for (const child of [
    f.proof,
    { ...valid.child, profileId: randomUUID() },
    { ...valid.child, targetId: f.proof.targetId },
    null,
  ])
    assert.equal(TaskChildPageLifecycle.safeParse({ ...valid, child }).success, false);
});

test('result initialization failure cleans only the freshly proven created child without retrying lookup', async () => {
  for (const foreign of [false, true]) {
    const f = fixture();
    let reads = 0;
    await assert.rejects(
      readOwnedFacebookNativeResult(
        f.executor,
        async () => {
          reads++;
          if (reads === 2) {
            if (foreign) {
              const child = f.inventory.tabs[1];
              assert.ok(child?.proof);
              child.proof = { ...child.proof, tabId: 3 };
            }
            throw Error('INITIAL_RESULT_INVENTORY_FAILED');
          }
          return structuredClone(f.inventory);
        },
        f.proof,
        accountId,
        nativePostId,
        f.guard,
      ),
      foreign ? /NATIVE_RESULT_CLOSE_OWNER_CHANGED/ : /INITIAL_RESULT_INVENTORY_FAILED/,
    );
    assert.equal(f.created.length, 1);
    assert.deepEqual(f.commands, []);
    assert.deepEqual(f.removed, foreign ? [] : [2]);
    assert.equal(f.inventory.tabs[0]?.state, 'READY');
    assert.equal(f.inventory.tabs[1]?.state, foreign ? 'READY' : 'CLOSED');
  }
});

test('an independently observed closed result child is not closed again and preserves the original read failure', async () => {
  for (const recycledClosed of [false, true]) {
    const f = fixture({ userClosed: true, recycledClosed });
    await assert.rejects(
      readOwnedFacebookNativeResult(
        f.executor,
        async () => structuredClone(f.inventory),
        f.proof,
        accountId,
        nativePostId,
        f.guard,
      ),
      recycledClosed ? /NATIVE_RESULT_CLOSE_OWNER_CHANGED/ : /RESULT_CHILD_CLOSED_DURING_READ/,
    );
    assert.deepEqual(f.removed, []);
    assert.equal(f.inventory.tabs[0]?.state, 'READY');
    assert.equal(f.inventory.tabs[1]?.state, 'CLOSED');
  }
});
test('native result lookup uses the same executor/owner, fixed numeric URL, no input, and returns only after exact lookup CLOSED proof', async () => {
  const f = fixture();
  const result = await readOwnedFacebookNativeResult(
    f.executor,
    async () => structuredClone(f.inventory),
    f.proof,
    accountId,
    nativePostId,
    f.guard,
  );
  assert.deepEqual(result, effects());
  assert.deepEqual(f.created, [url]);
  assert.deepEqual(f.commands, ['Runtime.evaluate']);
  assert.deepEqual(f.removed, [2]);
  assert.equal(f.inventory.tabs[0]?.state, 'READY');
  assert.equal(f.inventory.tabs[1]?.state, 'CLOSED');
});

test('result lookup waits through fresh about:blank and closes only its own page when projection or payload fails', async () => {
  const blank = effects();
  blank.url = 'about:blank';
  blank.posts = [];
  const f = fixture({ readings: [blank, effects()] });
  let clock = 0;
  assert.deepEqual(
    await readOwnedFacebookNativeResult(
      f.executor,
      async () => structuredClone(f.inventory),
      f.proof,
      accountId,
      nativePostId,
      f.guard,
      {
        now: () => clock,
        wait: async () => {
          clock += 250;
        },
      },
    ),
    effects(),
  );
  assert.equal(f.commands.length, 2);
  assert.deepEqual(f.removed, [2]);
  for (const options of [{ projectionError: true }, { badPayload: true }]) {
    const failed = fixture(options);
    await assert.rejects(
      readOwnedFacebookNativeResult(
        failed.executor,
        async () => structuredClone(failed.inventory),
        failed.proof,
        accountId,
        nativePostId,
        failed.guard,
      ),
    );
    assert.deepEqual(failed.removed, [2]);
    assert.equal(failed.inventory.tabs[0]?.state, 'READY');
    assert.equal(failed.inventory.tabs[1]?.state, 'CLOSED');
    assert.ok(failed.commands.every((command) => command === 'Runtime.evaluate'));
  }
});

test('result lookup repeats only the exact known pre-document read error and stops on an unknown transport result', async () => {
  for (const transientError of [
    '{"code":-32000,"message":"Cannot find default execution context"}',
    '{"code":-32000,"message":"Execution context was destroyed."}',
    '{"code":-32000,"message":"Cannot find context with specified id"}',
    'KERNEL_INITIAL_DOCUMENT_PENDING',
  ]) {
    const f = fixture({ transientError });
    let clock = 0;
    const result = await readOwnedFacebookNativeResult(
      f.executor,
      async () => structuredClone(f.inventory),
      f.proof,
      accountId,
      nativePostId,
      f.guard,
      {
        now: () => clock,
        wait: async () => {
          clock += 250;
        },
      },
    );
    assert.deepEqual(result, effects());
    assert.deepEqual(f.commands, ['Runtime.evaluate', 'Runtime.evaluate']);
    assert.deepEqual(f.removed, [2]);
  }
  const unknown = fixture({ unknownContext: true });
  await assert.rejects(
    readOwnedFacebookNativeResult(
      unknown.executor,
      async () => structuredClone(unknown.inventory),
      unknown.proof,
      accountId,
      nativePostId,
      unknown.guard,
    ),
    /KERNEL_RPC_RESULT_UNKNOWN/,
  );
  assert.deepEqual(unknown.commands, ['Runtime.evaluate']);
  assert.equal(unknown.inventory.tabs[0]?.state, 'READY');
});

test('result wait keeps the original result page until full original caption and decoded video agree, never retries a submit and closes a timed-out read', async () => {
  const videoId = '2092087444732127';
  const complete = effects();
  complete.url = 'https://www.facebook.com/reel/' + videoId + '/';
  const first = complete.posts[0];
  assert.ok(first);
  Object.assign(first, {
    postId: videoId,
    permalink: complete.url,
    photos: [],
    videoId,
    videoReady: true,
  });
  const original = {
    intent: {
      context: { accountId },
      snapshot: { text: first.text, format: 'video', files: [{ role: 'video' }] },
    },
    link: { purpose: 'SUBMIT' },
  } as unknown as FacebookPostOriginal;
  const native = {
    nativePostId,
    nativeStoryId: 'unused',
    flow: 'ASYNC_NOTIF' as const,
    photos: [],
    videoId,
  };
  const pending = structuredClone(complete);
  Object.assign(pending.posts[0] ?? {}, { text: '完整正文…', videoReady: false });
  for (const timeout of [false, true]) {
    const f = fixture({ readings: timeout ? [pending] : [pending, complete] });
    let clock = 0;
    const result = await readOwnedFacebookNativeResult(
      f.executor,
      async () => structuredClone(f.inventory),
      f.proof,
      accountId,
      nativePostId,
      f.guard,
      {
        videoId,
        now: () => clock,
        wait: async () => {
          // A ready upload can still produce a published video after the former
          // 30-second result deadline. It must not cause another submit or page.
          clock += timeout ? 1000 : 36_000;
        },
        accept: (reading) => matchObservedFacebookNativeResult(native, original, reading) !== null,
      },
    );
    assert.deepEqual(result, timeout ? null : complete);
    assert.equal(f.created.length, 1);
    assert.equal(f.commands.length, timeout ? 90 : 2);
    if (timeout) assert.equal(clock, 90_000);
    assert.ok(f.commands.every((command) => command === 'Runtime.evaluate'));
    assert.deepEqual(f.removed, [2]);
    assert.equal(f.inventory.tabs[0]?.state, 'READY');
    assert.equal(f.inventory.tabs[1]?.state, 'CLOSED');
  }
});

test('Reels lookup uses exact native video ID under the original owner and rejects wrong author, truncated caption, wrong video and unready playback', async () => {
  const videoId = '2092087444732127',
    f = fixture({ videoId });
  const result = await readOwnedFacebookNativeResult(
    f.executor,
    async () => structuredClone(f.inventory),
    f.proof,
    accountId,
    nativePostId,
    f.guard,
    { videoId },
  );
  assert.ok(result);
  assert.deepEqual(f.created, ['https://www.facebook.com/reel/' + videoId]);
  assert.deepEqual(f.commands, ['Runtime.evaluate']);
  assert.deepEqual(f.removed, [2]);
  const original = {
    intent: {
      context: { accountId },
      snapshot: { text: result.posts[0]!.text, format: 'video', files: [{ role: 'video' }] },
    },
    link: { purpose: 'SUBMIT' },
  } as unknown as FacebookPostOriginal;
  const accepted = {
    nativePostId,
    nativeStoryId: 'unused',
    flow: 'ASYNC_NOTIF' as const,
    photos: [],
    videoId,
  };
  for (const change of [
    'none',
    'no-slash',
    'query',
    'author',
    'caption',
    'route',
    'video',
    'decode',
    'pure-media',
  ]) {
    const value: PostEffects = structuredClone(result),
      post = value.posts[0]!;
    const intent = structuredClone(original);
    if (change === 'no-slash') {
      value.url = value.url.replace(/\/$/, '');
      post.permalink = value.url;
    }
    if (change === 'query') value.url += '?unrelated=1';
    if (change === 'author') post.accountId = '999';
    if (change === 'caption') post.text = '完整正文…';
    if (change === 'route') value.url = 'https://www.facebook.com/reel/999/';
    if (change === 'video') post.videoId = '999';
    if (change === 'decode') post.videoReady = false;
    if (change === 'pure-media') {
      intent.intent.snapshot.text = '';
      post.text = null;
    }
    const resolver = new LookupNativeFacebookPostResultResolver({
      ready: () => true,
      read: async () => value,
    });
    const resolved = await resolver.resolve(accepted, intent, () => {});
    if (change === 'none' || change === 'no-slash' || change === 'pure-media')
      assert.deepEqual(resolved, { postId: videoId, photos: [], videoId });
    else assert.equal(resolved, null, change);
  }
});
test('multi-image result lookup accepts the whole ordered image set and rejects partial, duplicate or foreign results', async () => {
  const photos = [photoId, '123456789']; // Second ID and all DOM fields are generated.
  const reading = effects();
  reading.posts[0]!.photos = photos;
  const original = {
    intent: {
      context: { accountId },
      snapshot: {
        text: reading.posts[0]!.text,
        format: 'multi-image',
        files: [{ role: 'image' }, { role: 'image' }],
      },
    },
    link: { purpose: 'SUBMIT' },
  } as unknown as FacebookPostOriginal;
  const accepted = {
    nativePostId,
    nativeStoryId: 'unused',
    flow: 'ASYNC_SILENT' as const,
    photos,
    videoId: null,
  };
  const resolver = new LookupNativeFacebookPostResultResolver({
    ready: () => true,
    read: async () => reading,
  });
  assert.equal(resolver.supportsOriginal(original), true);
  assert.deepEqual(await resolver.resolve(accepted, original, () => {}), {
    postId: alias,
    photos,
    videoId: null,
  });
  for (const change of [
    'partial',
    'extra',
    'order',
    'duplicate',
    'author',
    'caption',
    'route',
    'mixed-source',
  ]) {
    const wrong = structuredClone(reading),
      source = structuredClone(original);
    const post = wrong.posts[0]!;
    if (change === 'partial') post.photos.pop();
    if (change === 'extra') post.photos.push('999');
    if (change === 'order') post.photos.reverse();
    if (change === 'duplicate') {
      post.photos[1] = post.photos[0]!;
    }
    if (change === 'author') post.accountId = '999';
    if (change === 'caption') post.text += 'changed';
    if (change === 'route') wrong.url = 'https://www.facebook.com/';
    if (change === 'mixed-source') source.intent.snapshot.files[1]!.role = 'video';
    assert.equal(matchObservedFacebookNativeResult(accepted, source, wrong), null, change);
  }
});

test('native lookup does not accept a retained unrelated tab or ambiguous close and never removes the original task page', async () => {
  const f = fixture({ wrongClose: true });
  await assert.rejects(
    readOwnedFacebookNativeResult(
      f.executor,
      async () => structuredClone(f.inventory),
      f.proof,
      accountId,
      nativePostId,
      f.guard,
    ),
    /NATIVE_RESULT_CLOSE_UNCONFIRMED/,
  );
  assert.deepEqual(f.removed, [2]);
  const retained = fixture();
  retained.inventory.tabs.push({
    ownershipId: randomUUID(),
    proof: null,
    url: 'https://www.facebook.com/',
    state: 'UNKNOWN',
    reason: 'retained',
  });
  await assert.rejects(
    readOwnedFacebookNativeResult(
      retained.executor,
      async () => structuredClone(retained.inventory),
      retained.proof,
      accountId,
      nativePostId,
      retained.guard,
    ),
    /NATIVE_RESULT_OWNER_NOT_IDLE/,
  );
  assert.equal(retained.created.length, 0);
});
test('native lookup with a revoked actor leaves original proof for review; foreign result route closes only new owned page and yields no alias', async () => {
  const stopped = fixture({ revoke: true });
  await assert.rejects(
    readOwnedFacebookNativeResult(
      stopped.executor,
      async () => structuredClone(stopped.inventory),
      stopped.proof,
      accountId,
      nativePostId,
      stopped.guard,
    ),
    /ORIGINAL_ACTOR_REVOKED/,
  );
  assert.equal(stopped.inventory.tabs[1]?.state, 'READY');
  assert.equal(stopped.removed.length, 0);
  const changed = fixture({ wrongUrl: true });
  assert.equal(
    await readOwnedFacebookNativeResult(
      changed.executor,
      async () => structuredClone(changed.inventory),
      changed.proof,
      accountId,
      nativePostId,
      changed.guard,
    ),
    null,
  );
  assert.deepEqual(changed.removed, [2]);
});
test('alias resolver requires native numeric route, exact original text/author/native media and unique expanded own result; no latest-post fallback', async () => {
  const original = {
    intent: {
      context: { accountId },
      snapshot: {
        text: effects().posts[0]?.text,
        format: 'single-image',
        files: [{ role: 'image' }],
      },
    },
    link: { purpose: 'SUBMIT' },
  } as unknown as FacebookPostOriginal;
  const accepted = {
    nativePostId,
    nativeStoryId: 'unused',
    flow: 'ASYNC_SILENT' as const,
    photos: [photoId],
    videoId: null,
  };
  for (const change of [
    'none',
    'interactive',
    'loading',
    'route',
    'text',
    'actor',
    'media',
    'duplicate',
    'folded',
    'share',
    'foreign-numeric-link',
  ]) {
    const value = effects(),
      p = value.posts[0];
    assert.ok(p);
    if (change === 'interactive') value.ready = 'interactive';
    if (change === 'loading') value.ready = 'loading';
    if (change === 'route') value.url = 'https://www.facebook.com/';
    if (change === 'text') p.text += ' changed';
    if (change === 'actor') p.accountId = '99';
    if (change === 'media') p.photos = ['99'];
    if (change === 'duplicate') value.posts.push({ ...p });
    if (change === 'folded') p.expanded = false;
    if (change === 'share') p.nestedShare = true;
    if (change === 'foreign-numeric-link') {
      p.postId = '999';
      p.permalink = 'https://www.facebook.com/permalink.php?story_fbid=999&id=' + accountId;
    }
    const resolver = new LookupNativeFacebookPostResultResolver({
      ready: () => true,
      read: async () => value,
    });
    const resolved = await resolver.resolve(accepted, original, () => {});
    if (change === 'none' || change === 'interactive')
      assert.deepEqual(resolved, { postId: alias, photos: [photoId], videoId: null });
    else assert.equal(resolved, null, change);
  }
});

test('rendered paragraph gaps may collapse but a missing emoji, altered character or foreign native ID never matches', () => {
  const value = effects(),
    post = value.posts[0];
  assert.ok(post);
  post.photos = [];
  post.text = '\u{1f9e1} first paragraph\nSecond paragraph';
  post.postId = nativePostId;
  post.permalink = url;
  const original = {
    intent: {
      context: { accountId },
      snapshot: {
        text: '\u{1f9e1} first paragraph\n\nSecond paragraph',
        format: 'text',
        files: [],
      },
    },
    link: { purpose: 'SUBMIT' },
  } as unknown as FacebookPostOriginal;
  const accepted = {
    nativePostId,
    nativeStoryId: 'unused',
    flow: 'ASYNC_SILENT' as const,
    photos: [],
    videoId: null,
  };
  assert.ok(matchObservedFacebookNativeResult(accepted, original, value));
  post.text = 'first paragraph\nSecond paragraph';
  assert.equal(matchObservedFacebookNativeResult(accepted, original, value), null);
  post.text = '\u{1f9e1} first paragraph\nDifferent paragraph';
  assert.equal(matchObservedFacebookNativeResult(accepted, original, value), null);
});
