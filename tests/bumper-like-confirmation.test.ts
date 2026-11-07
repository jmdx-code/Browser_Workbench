import {
  BUMPER_REACTION_IDS,
  projectBumperReactionTarget,
} from '../src/infrastructure/bumper-reaction-target.js';
// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Page } from 'playwright-core';
import { projectBumperReactionRead } from '../src/infrastructure/bumper-reaction-read.js';
import {
  confirmedBumperGraphQL,
  observeBumperGraphql,
} from '../src/infrastructure/group-bumper-runner.js';
import { projectGroupBumper } from '../src/infrastructure/group-bumper-effects.js';
const scope = {
  actorId: '61500000000001',
  postId: '123456789012345',
  feedbackId: 'opaque-feedback',
};
const reactionId = '1635855486666999';
const variables = {
  input: {
    actor_id: scope.actorId,
    feedback_id: scope.feedbackId,
    feedback_reaction_id: reactionId,
  },
};
const body = (
  info: unknown = { id: reactionId },
  actor = scope.actorId,
  feedback = scope.feedbackId,
) => ({
  data: {
    feedback_react: {
      feedback: { id: feedback, viewer_actor: { id: actor }, viewer_feedback_reaction_info: info },
    },
  },
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});
it('accepts actual Like, Care and Love root info.id responses, with chunks/prefix; rejects mismatched, zero, empty and error evidence', () => {
  for (const id of [reactionId, '613557422527858', '1678524932434102']) {
    expect(
      confirmedBumperGraphQL({
        ...scope,
        kind: 'like',
        status: 200,
        variables: { input: { ...variables.input, feedback_reaction_id: id } },
        body:
          'for (;;);' +
          JSON.stringify(body({ id })) +
          '\n' +
          JSON.stringify({ extensions: { is_final: true } }),
      }),
    ).toBe(true);
  }
  const base = {
    ...scope,
    kind: 'like' as const,
    status: 200,
    variables,
    body: JSON.stringify(body()),
  };
  for (const change of [
    { body: JSON.stringify(body(null)) },
    { body: JSON.stringify(body({})) },
    { body: JSON.stringify(body({ reaction_type: 0 })) },
    { body: JSON.stringify(body({ id: '0' })) },
    { body: JSON.stringify(body({ id: reactionId }, 'other')) },
    { body: JSON.stringify(body({ id: reactionId }, scope.actorId, 'other')) },
    { body: JSON.stringify({ ...body(), errors: [{ message: 'denied' }] }) },
    { status: 403 },
    { variables: { input: { ...variables.input, actor_id: 'other' } } },
    { variables: { input: { ...variables.input, feedback_reaction_id: '0' } } },
    { variables: { input: { ...variables.input, feedback_reaction_id: '613557422527858' } } },
  ])
    expect(confirmedBumperGraphQL({ ...base, ...change })).toBe(false);
});
it('paired native errors remain failures even if a later optimistic/success payload is present', async () => {
  const page = new EventEmitter();
  const observer = observeBumperGraphql(page as unknown as Page, { ...scope, kind: 'like' });
  const request = {
    method: () => 'POST',
    url: () => 'https://www.facebook.com/api/graphql/',
    postData: () =>
      new URLSearchParams({
        fb_api_req_friendly_name: 'CometUFIFeedbackReactMutation',
        variables: JSON.stringify(variables),
      }).toString(),
  };
  page.emit('request', request);
  page.emit('response', {
    request: () => request,
    status: () => 200,
    text: async () => JSON.stringify({ errors: [{ message: 'denied' }] }),
  });
  await observer.close();
  expect(observer.failed()).toBe(true);
  expect(observer.confirmed()).toBe(false);
});
function fixture(payload: unknown, complete = true) {
  vi.stubGlobal(
    'location',
    new URL('https://www.facebook.com/' + scope.actorId + '/posts/' + scope.postId + '/'),
  );
  document.body.innerHTML = '<button data-wb-bumper-like="' + scope.postId + '"></button>';
  const unsubscribe = vi.fn();
  const execute = vi.fn(() => ({
    subscribe: (observer: { next: (v: unknown) => void; complete: () => void }) => {
      observer.next(payload);
      if (complete) observer.complete();
      return { unsubscribe };
    },
  }));
  const storyId = 'native-story-id';
  const owner = {
    node: {
      params: {
        id: '123456789',
        name: 'CurrentNativeStoryQuery',
        operationKind: 'query',
        providedVariables: { flag: true },
      },
    },
    variables: { storyID: storyId, resolvedNativeFlag: true },
  };
  const environment = {
    getNetwork: () => ({ execute }),
    getStore: () => ({
      getSource: () => ({
        get: (id: string) =>
          id === storyId ? { post_id: scope.postId, feedback: { __ref: scope.feedbackId } } : null,
      }),
    }),
  };
  Reflect.set(document.querySelector('button')!, '__reactFiber$test', {
    memoizedProps: { story: { __id: storyId, __fragmentOwner: owner }, environment },
    return: null,
  });
  return { execute, unsubscribe, owner };
}
const queryPayload = (info: unknown, actor = scope.actorId, post = scope.postId) => [
  {
    data: {
      node: {
        __typename: 'Story',
        id: 'native-story-id',
        post_id: post,
        feedback: {
          id: scope.feedbackId,
          viewer_actor: { id: actor },
          viewer_feedback_reaction_info: info,
        },
      },
    },
  },
];
it('uses actual prepared native query/variables once with force, accepting positive or explicit null without Relay optimistic writes', async () => {
  for (const info of [{ id: reactionId }, null]) {
    const f = fixture(queryPayload(info));
    expect((await projectBumperReactionRead(scope)).state).toBe(info ? 'active' : 'none');
    expect(f.execute).toHaveBeenCalledExactlyOnceWith(f.owner.node.params, f.owner.variables, {
      force: true,
    });
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  }
});
it('fresh read rejects wrong actor, graph errors, missing and zero reaction records, and invalidates timed-out partial results', async () => {
  for (const payload of [
    queryPayload({ id: reactionId }, 'wrong'),
    queryPayload({ id: '0' }),
    queryPayload({ id: reactionId, reaction_type: 0 }),
    queryPayload({ id: reactionId }, scope.actorId, '99999999999'),
    queryPayload({}),
    [{ errors: [{ message: 'no' }], data: queryPayload({ id: reactionId })[0]?.data }],
  ]) {
    fixture(payload);
    expect((await projectBumperReactionRead(scope)).state).toBe('unknown');
  }
  vi.useFakeTimers();
  const f = fixture(queryPayload({ id: reactionId }), false);
  const pending = projectBumperReactionRead(scope);
  await vi.advanceTimersByTimeAsync(4000);
  expect((await pending).state).toBe('unknown');
  expect(f.unsubscribe).toHaveBeenCalledOnce();
});
it('fresh read never issues a query when the store Story points to a different post', async () => {
  const f = fixture(queryPayload({ id: reactionId }));
  expect((await projectBumperReactionRead({ ...scope, postId: '999999999999' })).state).toBe(
    'unknown',
  );
  expect(f.execute).not.toHaveBeenCalled();
});
it('reader resolves current actor Relay references; empty/unresolved/zero is not liked and default actor cannot override explicit null', () => {
  const group = '111111111111111',
    author = '61500000000002',
    feedback = scope.feedbackId;
  vi.stubGlobal('location', new URL('https://www.facebook.com/groups/' + group + '/'));
  for (const [info, record, expected] of [
    [null, null, 'none'],
    [{}, null, 'unknown'],
    [{ reaction_type: 0 }, null, 'none'],
    [{ __ref: 'missing' }, null, 'unknown'],
    [{ __ref: 'reaction' }, { id: reactionId }, 'active'],
  ] as const) {
    document.body.innerHTML =
      '<main><article role="article"><a href="/groups/' +
      group +
      '/user/' +
      author +
      '/">Page</a><a href="/groups/' +
      group +
      '/posts/' +
      scope.postId +
      '/">1h</a><button role="button">React</button></article></main>';
    for (const el of Array.from(document.querySelectorAll('*')))
      el.getBoundingClientRect = () => ({
        x: 1,
        y: 1,
        left: 1,
        top: 1,
        right: 400,
        bottom: 200,
        width: 399,
        height: 199,
        toJSON: () => ({}),
      });
    const card = {
      type: { displayName: 'CometFeedUnitCard.react' },
      memoizedProps: {
        story: {
          __id: 's',
          post_id: scope.postId,
          actors: [{ id: author }],
          creation_time: Date.now() / 1000 - 3600,
        },
      },
      return: null,
    };
    const native = {
      'viewer_feedback_reaction_info(use_default_actor:false)': info,
      'viewer_feedback_reaction_info(use_default_actor:true)': { id: reactionId },
    };
    const environment = {
      getStore: () => ({
        getSource: () => ({
          get: (id: string) => (id === feedback ? native : id === 'reaction' ? record : null),
        }),
      }),
    };
    Reflect.set(document.querySelector('article')!, '__reactFiber$test', card);
    Reflect.set(document.querySelector('button')!, '__reactFiber$test', {
      type: { displayName: 'CometUFIReactButtonBase.react' },
      memoizedProps: { feedback: { id: feedback }, environment },
      return: card,
    });
    const state = projectGroupBumper({ groupId: group, pageId: author });
    expect(state.posts[0]?.reactionState).toBe(expected);
    expect(state.posts[0]?.liked).toBe(expected === 'active');
  }
});

it('selected reaction must match both the request and response, even if another reaction succeeded', async () => {
  const expected = BUMPER_REACTION_IDS.care;
  const base = { ...scope, kind: 'like' as const, status: 200, expectedReactionId: expected };
  expect(confirmedBumperGraphQL({ ...base, variables, body: JSON.stringify(body()) })).toBe(false);
  expect(
    confirmedBumperGraphQL({
      ...base,
      variables: { input: { ...variables.input, feedback_reaction_id: expected } },
      body: JSON.stringify(body({ id: expected })),
    }),
  ).toBe(true);
  const page = new EventEmitter(),
    observer = observeBumperGraphql(page as unknown as Page, {
      ...scope,
      kind: 'like',
      expectedReactionId: expected,
    });
  const req = {
    method: () => 'POST',
    url: () => 'https://www.facebook.com/api/graphql/',
    postData: () =>
      new URLSearchParams({
        fb_api_req_friendly_name: 'CometUFIFeedbackReactMutation',
        variables: JSON.stringify(variables),
      }).toString(),
  };
  page.emit('request', req);
  page.emit('response', {
    request: () => req,
    status: () => 200,
    text: async () => JSON.stringify(body()),
  });
  await observer.close();
  expect(observer.confirmed()).toBe(false);
  expect(observer.failed()).toBe(true);
});
function nativeDockButton(
  id: string,
  feedback = scope.feedbackId,
  parentName = 'CometUFIReactionsMenuDock.react',
  cached = false,
) {
  const el = document.createElement('button');
  el.setAttribute('aria-label', '任意文字 / أي نص / อะไรก็ได้');
  el.style.direction = 'rtl';
  el.getBoundingClientRect = () => ({
    x: 1,
    y: 1,
    left: 1,
    top: 1,
    right: 200,
    bottom: 90,
    width: 199,
    height: 89,
    toJSON: () => ({}),
  });
  document.body.append(el);
  const dock = {
    type: { displayName: parentName },
    memoizedProps: { feedback: { __id: feedback } },
    return: null,
  };
  const strategy = {
    type: { displayName: 'CometUFIReactionStrategy.react' },
    memoizedProps: { reactionID: id, feedback: { __id: feedback } },
    return: dock,
  };
  const frame = { stateNode: el, type: 'button', memoizedProps: {}, return: strategy };
  if (cached) {
    Reflect.set(el, '__testNewFiber', frame);
  } else Reflect.set(el, '__reactFiber$test', frame);
  return el;
}
it('all native reaction IDs work with arbitrary labels, RTL and reordered DOM; no position or language fallback', () => {
  for (const [key, id] of Object.entries(BUMPER_REACTION_IDS).reverse()) {
    document.body.innerHTML = '';
    Reflect.deleteProperty(window, '__wbReactRootNodesV1');
    nativeDockButton(id, scope.feedbackId, 'CometUFITopReactionsRenderer.react');
    nativeDockButton(id, 'another-post');
    const correct = nativeDockButton(id);
    const css = projectBumperReactionTarget({ ...scope, reactionId: id });
    expect(css, key).not.toBeNull();
    expect(document.querySelector(css!), key).toBe(correct);
  }
  document.body.innerHTML = '';
  nativeDockButton(BUMPER_REACTION_IDS.love);
  expect(
    projectBumperReactionTarget({ ...scope, reactionId: BUMPER_REACTION_IDS.care }),
  ).toBeNull();
});
it('discovers newly mounted dock nodes in a container-only React tree with a stale host cache', () => {
  document.body.innerHTML = '<main></main>';
  Reflect.set(window, '__wbReactRootNodesV1', new WeakMap());
  const el = nativeDockButton(
    BUMPER_REACTION_IDS.care,
    scope.feedbackId,
    'CometUFIReactionsMenuDock.react',
    true,
  );
  const frame = Reflect.get(el, '__testNewFiber');
  Reflect.set(document.querySelector('main')!, '__reactContainer$test', {
    stateNode: { current: { child: frame } },
  });
  const css = projectBumperReactionTarget({ ...scope, reactionId: BUMPER_REACTION_IDS.care });
  expect(css).not.toBeNull();
  expect(document.querySelector(css!)).toBe(el);
});
it('rejects comment, disabled, absent and ambiguous reaction controls instead of substituting a different action', () => {
  for (const parent of ['CometUFICommentRow.react', 'CometUFIClassicTopReactions.react']) {
    document.body.innerHTML = '';
    nativeDockButton(BUMPER_REACTION_IDS.care, scope.feedbackId, parent);
    expect(
      projectBumperReactionTarget({ ...scope, reactionId: BUMPER_REACTION_IDS.care }),
    ).toBeNull();
  }
  document.body.innerHTML = '';
  const disabled = nativeDockButton(BUMPER_REACTION_IDS.care);
  disabled.setAttribute('disabled', '');
  expect(
    projectBumperReactionTarget({ ...scope, reactionId: BUMPER_REACTION_IDS.care }),
  ).toBeNull();
  disabled.removeAttribute('disabled');
  nativeDockButton(BUMPER_REACTION_IDS.care);
  expect(
    projectBumperReactionTarget({ ...scope, reactionId: BUMPER_REACTION_IDS.care }),
  ).toBeNull();
});
it('drains a matching response body at the deadline without another submission and remains bounded on missing evidence', async () => {
  const page = new EventEmitter();
  const observer = observeBumperGraphql(page as unknown as Page, { ...scope, kind: 'like' });
  const request = {
    method: () => 'POST',
    url: () => 'https://www.facebook.com/api/graphql/',
    postData: () =>
      new URLSearchParams({
        fb_api_req_friendly_name: 'CometUFIFeedbackReactMutation',
        variables: JSON.stringify(variables),
      }).toString(),
  };
  page.emit('request', request);
  let finish!: (body: string) => void;
  page.emit('response', {
    request: () => request,
    status: () => 200,
    text: () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  });
  expect(observer.confirmed()).toBe(false);
  const draining = observer.waitForEvidence(500);
  setTimeout(() => finish(JSON.stringify(body())), 20);
  await draining;
  expect(observer.confirmed()).toBe(true);
  await observer.close();
  expect(page.listenerCount('request')).toBe(0);
  const missing = observeBumperGraphql(page as unknown as Page, { ...scope, kind: 'like' });
  page.emit('request', request);
  const started = Date.now();
  await missing.waitForEvidence(30);
  expect(Date.now() - started).toBeLessThan(300);
  expect(missing.confirmed()).toBe(false);
  await expect(
    missing.waitForEvidence(50, () => {
      throw Error('stopped');
    }),
  ).rejects.toThrow('stopped');
  await missing.close();
});
