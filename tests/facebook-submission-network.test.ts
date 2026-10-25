import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import type { Page, Request, Response } from 'playwright-core';
import { postFixture, postRequest, dispatchedPost } from './fixtures/material-post.js';
import { FacebookSubmissionNetworkObserver } from '../src/infrastructure/facebook-submission-network.js';
import type { PostSubmissionDiagnostic } from '../src/infrastructure/facebook-submission-network.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';

// Fixture protocol is deliberately not a FB wire implementation. No external HTTP or FB input.
const adapter = {
  ready: () => true,
  match: (text: string) => (text === 'fixture-original-submit' ? 'fixture-key' : null),
  result: (text: string) =>
    text === 'fixture-post-result' ? { postId: 'newpost', photos: [], videoId: null } : null,
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function networkFixture(
  work: (fixture: {
    store: WorkspaceStore;
    events: EventEmitter;
    page: Page;
    native: Request;
    network: FacebookSubmissionNetworkObserver;
    op: Parameters<FacebookSubmissionNetworkObserver['start']>[1];
    original: Parameters<FacebookSubmissionNetworkObserver['start']>[2];
  }) => Promise<void>,
  diagnostic?: (value: PostSubmissionDiagnostic) => void,
) {
  await postFixture(async (store, _file, catalog) => {
    const request = await postRequest(store, catalog, { accountId: '123456' });
    await store.materials.reserve(request);
    const dispatched = await dispatchedPost(store, request);
    const operation = (await store.tasks.operations(request.jobId))[0];
    assert.ok(operation?.binding);
    const original = {
      intent: (await store.materials.reservation(request.attemptId)).intent,
      link: await store.materialPosts.link(operation.id),
    };
    await store.submissionObservations.capture({
      operationId: operation.id,
      binding: dispatched.binding,
      proof: request.proof,
      attemptId: request.attemptId,
      accountId: '123456',
      fingerprint: original.intent.fingerprint,
      postIds: [],
      checkedAt: Date.now(),
      url: 'https://www.facebook.com/post/create',
      timeOrigin: 100,
    });
    const events = new EventEmitter(),
      frame = {};
    const page = Object.assign(events, { mainFrame: () => frame }) as unknown as Page;
    const native = {
      url: () => 'https://www.facebook.com/api/graphql/',
      method: () => 'POST',
      frame: () => frame,
      postData: () => 'fixture-original-submit',
    } as Request;
    const network = new FacebookSubmissionNetworkObserver(
      store.submissionObservations,
      adapter,
      diagnostic,
    );
    try {
      await work({
        store,
        events,
        page,
        native,
        network,
        op: { ...operation, binding: dispatched.binding },
        original,
      });
    } finally {
      network.stop();
    }
  });
}

test('asynchronous native alias resolution remains pending and a stop cannot persist its late result', async () => {
  await networkFixture(async ({ store, events, page, native, op, original }) => {
    let release: ((value: { postId: string; photos: string[]; videoId: null }) => void) | undefined;
    const observer = new FacebookSubmissionNetworkObserver(store.submissionObservations, {
      ...adapter,
      result: async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    await observer.start(
      page,
      op,
      original,
      () => {},
      async () => {},
    );
    events.emit('request', native);
    events.emit('response', {
      request: () => native,
      status: () => 200,
      allHeaders: async () => ({ 'content-type': 'text/html' }),
      body: async () => Buffer.from('fixture-post-result'),
    });
    await tick();
    assert.equal(Boolean(release), false);
    assert.equal(await observer.read(page, op, original, () => {}), null);
    assert.equal(Boolean(release), false); // Native response alone cannot start the result-page read.
    assert.equal(
      await observer.read(page, { ...op, status: 'ACKNOWLEDGED' }, original, () => {}),
      null,
    );
    assert.ok(release);
    assert.equal(await observer.read(page, op, original, () => {}), null);
    observer.stop();
    release({ postId: 'late', photos: [], videoId: null });
    await tick();
    assert.equal(await store.submissionObservations.result(op.id), null);
    assert.equal(await store.materialPosts.result(original.intent.attemptId), null);
  });
});

test('unsupported native format is rejected before buffer setup and original UI submission', async () => {
  await networkFixture(async ({ store, events, page, op, original }) => {
    const network = new FacebookSubmissionNetworkObserver(store.submissionObservations, {
      ...adapter,
      supportsOriginal: () => false,
    });
    let buffers = 0;
    await assert.rejects(
      network.start(
        page,
        op,
        original,
        () => {},
        async () => {
          buffers++;
        },
      ),
      /SUBMISSION_REQUIRED/,
    );
    assert.equal(buffers, 0);
    assert.equal(events.listenerCount('request'), 0);
    assert.equal(await store.submissionObservations.result(op.id), null);
  });
});

test('background GraphQL queries do not poison the original matched submission budget', async () => {
  let captured: PostSubmissionDiagnostic | null = null;
  await networkFixture(
    async ({ store, events, page, native, network, op, original }) => {
      await network.start(
        page,
        op,
        original,
        () => {},
        async () => {},
      );
      for (let i = 0; i < 40; i++)
        events.emit('request', { ...native, postData: () => 'unrelated-background-query' });
      events.emit('request', { ...native, postData: () => 'x'.repeat(512 * 1024 + 1) });
      events.emit('request', native);
      events.emit('response', {
        request: () => native,
        status: () => 200,
        allHeaders: async () => ({ 'content-type': 'text/html' }),
        body: async () => Buffer.from('fixture-post-result'),
      });
      await tick();
      assert.equal(
        await network.read(page, { ...op, status: 'ACKNOWLEDGED' }, original, () => {}),
        null,
      );
      await tick();
      assert.equal(
        (await network.read(page, { ...op, status: 'ACKNOWLEDGED' }, original, () => {}))?.postId,
        'newpost',
      );
      assert.equal(await store.materialPosts.result(original.intent.attemptId), null);
    },
    (value) => {
      captured = value;
      throw Error('OPTIONAL_AUDIT_UNAVAILABLE');
    },
  );
  assert.ok(captured);
  assert.equal(JSON.stringify(captured).includes('fixture-post-result'), false);
});

test('stopping or revoking the original owner during buffer setup never arms a late listener', async () => {
  for (const reason of ['stop', 'owner'] as const)
    await networkFixture(async ({ events, page, network, op, original }) => {
      let release: (() => void) | undefined,
        current = true;
      const starting = network.start(
        page,
        op,
        original,
        () => {
          if (!current) throw Error('OWNER_CHANGED');
        },
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      await tick();
      assert.ok(release);
      await assert.rejects(
        network.start(
          page,
          op,
          original,
          () => {},
          async () => {},
        ),
        /SUBMISSION_REQUIRED/,
      );
      if (reason === 'stop') network.stop();
      else current = false;
      release();
      await assert.rejects(starting, /REVOKED|OWNER_CHANGED/);
      assert.equal(events.listenerCount('request'), 0);
      assert.equal(events.listenerCount('response'), 0);
    });
});

test('HTTP 200 with an excessive or unrecognized body cannot persist a publication result', async () => {
  for (const kind of ['length', 'decoded', 'unrecognized'] as const)
    await networkFixture(async ({ store, events, page, native, network, op, original }) => {
      await network.start(
        page,
        op,
        original,
        () => {},
        async () => {},
      );
      let reads = 0;
      events.emit('request', native);
      events.emit('response', {
        request: () => native,
        status: () => 200,
        allHeaders: async () => ({
          'content-type': 'text/html',
          ...(kind === 'length' ? { 'content-length': String(512 * 1024 + 1) } : {}),
        }),
        body: async () => {
          reads++;
          return kind === 'decoded'
            ? Buffer.alloc(512 * 1024 + 1)
            : Buffer.from('unrecognized-json-result');
        },
      });
      await tick();
      assert.equal(reads, kind === 'length' ? 0 : 1);
      if (kind === 'unrecognized') {
        assert.equal(
          await network.read(page, { ...op, status: 'ACKNOWLEDGED' }, original, () => {}),
          null,
        );
        await tick();
      }
      assert.equal(await store.submissionObservations.result(op.id), null);
      assert.equal(await store.materialPosts.result(original.intent.attemptId), null);
      await assert.rejects(
        network.read(page, op, original, () => {}),
        /RESPONSE_UNCONFIRMED/,
      );
    });
});
test('passive native response binds the original request, persists after ACK and revokes listeners without sending HTTP', async () => {
  await postFixture(async (store, file, catalog) => {
    const request = await postRequest(store, catalog, { accountId: '123456' });
    await store.materials.reserve(request);
    const dispatched = await dispatchedPost(store, request);
    const op = (await store.tasks.operations(request.jobId))[0];
    assert.ok(op?.binding);
    const original = {
      intent: (await store.materials.reservation(request.attemptId)).intent,
      link: await store.materialPosts.link(op.id),
    };
    await store.submissionObservations.capture({
      operationId: op.id,
      binding: dispatched.binding,
      proof: request.proof,
      attemptId: request.attemptId,
      accountId: '123456',
      fingerprint: original.intent.fingerprint,
      postIds: ['old'],
      checkedAt: Date.now(),
      url: 'https://www.facebook.com/post/create',
      timeOrigin: 100,
    });
    const events = new EventEmitter(),
      frame = {},
      page = Object.assign(events, { mainFrame: () => frame }) as unknown as Page;
    const network = new FacebookSubmissionNetworkObserver(store.submissionObservations, adapter);
    let bodyReads = 0;
    const native = {
      url: () => 'https://www.facebook.com/api/graphql/',
      method: () => 'POST',
      frame: () => frame,
      postData: () => 'fixture-original-submit',
    } as Request;
    events.emit('request', native); // Before original operation is armed: never observed/adopted.
    let buffersEnabled = false;
    await network.start(
      page,
      { ...op, binding: dispatched.binding },
      original,
      () => {},
      async () => {
        assert.equal(events.listenerCount('request'), 0);
        buffersEnabled = true;
      },
    );
    assert.equal(buffersEnabled, true);
    events.emit('response', {
      request: () => native,
      body: () => {
        bodyReads++;
      },
    });
    assert.equal(bodyReads, 0);
    for (const invalid of [
      { url: () => 'https://example.com/api/graphql/' },
      { frame: () => ({}) },
      { method: () => 'GET' },
      { url: () => 'https://www.facebook.com/api/graphql/?other=1' },
    ])
      events.emit('request', { ...native, ...invalid });
    events.emit('request', native);
    await store.tasks.acknowledgeBound({
      binding: dispatched.binding,
      evidence: { sdkReturned: true },
    });
    const ack = { ...op, status: 'ACKNOWLEDGED' as const, binding: dispatched.binding };
    const body = Buffer.from('fixture-post-result');
    const response = {
      request: () => native,
      status: () => 200,
      allHeaders: async () => ({
        // Actual empty-composer FB query: h3, JSON body labelled HTML, no Content-Length.
        'content-type': 'text/html; charset=utf-8',
      }),
      body: async () => {
        bodyReads++;
        return body;
      },
    } as unknown as Response;
    events.emit('response', response);
    assert.equal(await network.read(page, ack, original, () => {}), null);
    await tick();
    assert.equal(await network.read(page, ack, original, () => {}), null);
    await tick();
    const result = await network.read(page, ack, original, () => {});
    assert.equal(result?.postId, 'newpost');
    assert.equal(bodyReads, 1);
    assert.equal(events.listenerCount('request'), 0);
    assert.equal(events.listenerCount('response'), 0);
    assert.equal(await store.materialPosts.result(request.attemptId), null); // Interface result alone never consumes.
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(reopened.submissionObservations.result(op.id), result);
    } finally {
      await reopened.close();
    }
    const db = new DatabaseSync(file);
    try {
      assert.throws(() => db.exec("UPDATE facebook_submission_results SET body='{}'"), /IMMUTABLE/);
      assert.throws(() => db.exec('DELETE FROM facebook_submission_results'), /RETAIN/);
    } finally {
      db.close();
    }
  });
});

test('revocation during asynchronous response inspection prevents original result persistence; no retry or consumption', async () => {
  await postFixture(async (store, _file, catalog) => {
    const request = await postRequest(store, catalog, { accountId: '123456' });
    await store.materials.reserve(request);
    const dispatched = await dispatchedPost(store, request),
      op = (await store.tasks.operations(request.jobId))[0];
    assert.ok(op?.binding);
    const original = {
      intent: (await store.materials.reservation(request.attemptId)).intent,
      link: await store.materialPosts.link(op.id),
    };
    await store.submissionObservations.capture({
      operationId: op.id,
      binding: dispatched.binding,
      proof: request.proof,
      attemptId: request.attemptId,
      accountId: '123456',
      fingerprint: original.intent.fingerprint,
      postIds: [],
      checkedAt: Date.now(),
      url: 'https://www.facebook.com/post/create',
      timeOrigin: 100,
    });
    const events = new EventEmitter(),
      frame = {},
      page = Object.assign(events, { mainFrame: () => frame }) as unknown as Page;
    const network = new FacebookSubmissionNetworkObserver(store.submissionObservations, adapter);
    let current = true,
      resolveBody: ((body: Buffer) => void) | undefined;
    await network.start(
      page,
      { ...op, binding: dispatched.binding },
      original,
      () => {
        if (!current) throw Error('OWNER_CHANGED');
      },
      async () => {},
    );
    const native = {
      url: () => 'https://www.facebook.com/api/graphql/',
      method: () => 'POST',
      frame: () => frame,
      postData: () => 'fixture-original-submit',
    } as Request;
    events.emit('request', native);
    events.emit('response', {
      request: () => native,
      status: () => 200,
      allHeaders: async () => ({ 'content-length': '19', 'content-type': 'application/json' }),
      body: () =>
        new Promise<Buffer>((resolve) => {
          resolveBody = resolve;
        }),
    });
    await tick();
    assert.ok(resolveBody);
    current = false;
    resolveBody(Buffer.from('fixture-post-result'));
    await tick();
    assert.equal(await store.submissionObservations.result(op.id), null);
    await assert.rejects(
      network.read(page, { ...op, binding: dispatched.binding }, original, () => {}),
      /RESPONSE_UNCONFIRMED/,
    );
    network.stop();
    assert.equal(events.listenerCount('close'), 0);
    assert.equal(await store.materialPosts.result(request.attemptId), null);
  });
});
