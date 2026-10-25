import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import { FacebookSubmissionObserver } from '../src/infrastructure/facebook-submission-observer.js';
import { DOMFacebookPostBusinessObserver } from '../src/infrastructure/facebook-post-business-observer.js';
import {
  dropPostObservationSchema,
  latestMigrationBackupMarker,
} from './fixtures/workspace-schema.js';
import { postFixture, postRequest, dispatchedPost } from './fixtures/material-post.js';
import type { SubmissionBaseline, PostEffects } from '../src/shared/facebook-post-observation.js';
import type { Page } from 'playwright-core';
import { EventEmitter } from 'node:events';
import { FacebookSubmissionNetworkObserver } from '../src/infrastructure/facebook-submission-network.js';
import { NativeFacebookSubmissionWireAdapter } from '../src/infrastructure/facebook-native-submission-wire.js';
import { LookupNativeFacebookPostResultResolver } from '../src/infrastructure/facebook-native-result-resolver.js';

async function baseline(
  store: WorkspaceStore,
  request: ReturnType<typeof postRequest>,
  op: ReturnType<typeof dispatchedPost>,
): Promise<SubmissionBaseline> {
  const intent = (await store.materials.reservation(request.attemptId)).intent;
  return {
    operationId: op.binding.operationId,
    binding: op.binding,
    proof: request.proof,
    attemptId: request.attemptId,
    accountId: request.context.accountId,
    fingerprint: intent.fingerprint,
    checkedAt: Date.now(),
    postIds: ['old-post'],
    url: 'https://www.facebook.com/post/create',
    timeOrigin: 100,
  };
}
async function setup(store: WorkspaceStore, catalog: Parameters<typeof postRequest>[1]) {
  const request = await postRequest(store, catalog, { accountId: '123456' });
  await store.materials.reserve(request);
  const operation = await dispatchedPost(store, request);
  return { request, operation, value: await baseline(store, request, operation) };
}

test('independent media observation does not enable submission when result adapters are unavailable', async () => {
  await postFixture(async (store, _file, catalog) => {
    const { request, operation } = await setup(store, catalog);
    await store.tasks.acknowledgeBound({
      binding: operation.binding,
      evidence: { sdkReturned: true },
    });
    let reads = 0;
    const observer = new DOMFacebookPostBusinessObserver(
      store.submissionObservations,
      store.uploadStages,
      {
        ready: () => false,
        read: async () => {
          reads++;
          throw Error('RESULT_NOT_AVAILABLE');
        },
      },
      randomUUID,
      async () => {
        reads++;
        throw Error('EFFECT_NOT_REQUESTED');
      },
    );
    assert.equal(observer.ready(), false);
    assert.equal(observer.readyForPurpose('UPLOAD_MEDIA'), true);
    assert.equal(observer.readyForPurpose('SUBMIT'), false);
    assert.equal(observer.readyForPurpose('SET_TEXT'), false);
    const saved = (await store.tasks.operations(operation.binding.jobId)).find(
      (op) => op.id === operation.binding.operationId,
    )!;
    await assert.rejects(
      observer.verify(
        {} as Page,
        { ...saved, binding: operation.binding },
        {
          link: await store.materialPosts.link(saved.id),
          intent: (await store.materials.reservation(request.attemptId)).intent,
        },
        () => {},
      ),
      /POST_BUSINESS_PURPOSE_NOT_READY/,
    );
    assert.equal(reads, 0);
    assert.equal(await store.materialPosts.result(request.attemptId), null);
  });
});

test('original submit baseline is atomic, immutable, retained after ACK and reopen, with no consumption', async () => {
  await postFixture(async (store, file, catalog) => {
    const { request, operation, value } = await setup(store, catalog);
    assert.deepEqual(await store.submissionObservations.capture(value), value);
    assert.deepEqual(
      await store.submissionObservations.capture({ ...value, checkedAt: Date.now() }),
      value,
    );
    for (const changed of [
      { postIds: ['changed'] },
      { timeOrigin: 101 },
      { fingerprint: 'b'.repeat(64) },
      { proof: { ...value.proof, targetId: randomUUID() } },
      { binding: { ...value.binding, leaseId: randomUUID() } },
      { checkedAt: Date.now() - 6000 },
      { url: 'https://example.com/' },
    ])
      await assert.rejects(
        async () => await store.submissionObservations.capture({ ...value, ...changed }),
      );
    const db = new DatabaseSync(file);
    try {
      assert.throws(
        () => db.exec("UPDATE facebook_submission_observations SET body='{}'"),
        /IMMUTABLE/,
      );
      assert.throws(() => db.exec('DELETE FROM facebook_submission_observations'), /RETAIN/);
    } finally {
      db.close();
    }
    await store.tasks.acknowledgeBound({
      binding: operation.binding,
      evidence: { sdkReturned: true },
    });
    await assert.rejects(
      async () => await store.submissionObservations.capture(value),
      /ORIGINAL_ACTIVE_SUBMISSION_REQUIRED/,
    );
    assert.equal((await store.materials.reservation(request.attemptId)).state, 'RESERVED');
    assert.equal(await store.materialPosts.result(request.attemptId), null);
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.deepEqual(reopened.submissionObservations.get(operation.binding.operationId), value);
    } finally {
      await reopened.close();
    }
  });
});

test('baseline write rollback cannot fake preparation; auxiliary operations and UNKNOWN cannot capture', async () => {
  await postFixture(async (store, file, catalog) => {
    const { request, operation, value } = await setup(store, catalog);
    const db = new DatabaseSync(file);
    try {
      db.exec(
        "CREATE TRIGGER injected_capture BEFORE INSERT ON facebook_submission_observations BEGIN SELECT RAISE(ABORT,'INJECT_CAPTURE_FAILURE'); END",
      );
      await assert.rejects(
        async () => await store.submissionObservations.capture(value),
        /INJECT_CAPTURE_FAILURE/,
      );
      assert.equal(await store.submissionObservations.get(operation.binding.operationId), null);
      db.exec('DROP TRIGGER injected_capture');
      await store.tasks.markBoundUnknown(operation.binding, 'generated unknown');
      await assert.rejects(async () => await store.submissionObservations.capture(value));
      assert.equal(await store.materialPosts.result(request.attemptId), null);
    } finally {
      db.close();
    }
  });
  await postFixture(async (store, _file, catalog) => {
    const request = await postRequest(store, catalog, { accountId: '123456' });
    await store.materials.reserve(request);
    const operation = await dispatchedPost(store, request, 'SET_TEXT');
    await assert.rejects(
      async () =>
        await store.submissionObservations.capture(await baseline(store, request, operation)),
      /ORIGINAL_ACTIVE_SUBMISSION_REQUIRED/,
    );
  });
});

test('schema14 upgrade appends gate15 with backup and preserves original unresolved submit without inventing a baseline', async () => {
  await postFixture(async (store, file, catalog) => {
    const { request, operation } = await setup(store, catalog);
    const db = new DatabaseSync(file);
    db.exec(dropPostObservationSchema + 'PRAGMA user_version=14');
    db.close();
    const upgraded = await WorkspaceStore.open(file);
    try {
      const versionCheck = new DatabaseSync(file, { readOnly: true });
      try {
        assert.equal(
          versionCheck.prepare('PRAGMA user_version').get()?.user_version,
          workspaceSchemaVersion,
        );
      } finally {
        versionCheck.close();
      }
      assert.equal(upgraded.submissionObservations.get(operation.binding.operationId), null);
      assert.deepEqual(upgraded.tasks.operations(request.jobId)[0]?.binding, operation.binding);
      assert.equal(upgraded.tasks.operations(request.jobId)[0]?.status, 'DISPATCHING');
      assert.equal(upgraded.materials.reservation(request.attemptId).state, 'RESERVED');
      const name = (await readdir(path.dirname(file))).find((n) =>
        n.includes(latestMigrationBackupMarker),
      );
      assert.ok(name);
      const backup = new DatabaseSync(path.join(path.dirname(file), name), { readOnly: true });
      try {
        assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 14);
        assert.equal(
          backup.prepare('SELECT count(*) AS n FROM task_dispatch_bindings').get()?.n,
          1,
        );
      } finally {
        backup.close();
      }
    } finally {
      await upgraded.close();
    }
  });
});

test('original pre-click capture forbids replay and fences route replacement before native input', async () => {
  await postFixture(async (store, _file, catalog) => {
    const { request, operation } = await setup(store, catalog);
    const op = (await store.tasks.operations(request.jobId))[0];
    assert.ok(op?.binding);
    const original = {
      intent: (await store.materials.reservation(request.attemptId)).intent,
      link: await store.materialPosts.link(op.id),
    };
    const effects: PostEffects = {
      url: 'https://www.facebook.com/post/create',
      timeOrigin: 100,
      ready: 'complete',
      composer: {
        text: original.intent.snapshot.text,
        files: [],
        media: [],
        uploaded: false,
        busy: false,
        submitEnabled: true,
      },
      posts: [],
    };
    const page = { evaluate: async () => structuredClone(effects) } as unknown as Page;
    const observer = new FacebookSubmissionObserver(
      store.submissionObservations,
      async (_page, guard) => {
        await guard();
        return structuredClone(effects);
      },
    );
    await observer.prepare(page, { ...op, binding: operation.binding }, original, () => {});
    await observer.assert(page, { ...op, binding: operation.binding }, original, () => {});
    await assert.rejects(
      observer.prepare(page, { ...op, binding: operation.binding }, original, () => {}),
      /NO_REPLAY/,
    );
    effects.timeOrigin++;
    await assert.rejects(
      observer.assert(page, { ...op, binding: operation.binding }, original, () => {}),
      /DOCUMENT_OR_CONTENT_CHANGED/,
    );
    assert.equal((await store.submissionObservations.get(op.id))?.timeOrigin, 100);
  });
});

test('native SELF adapter refuses unknown/public audience before capture and rechecks it before every input', async () => {
  await postFixture(async (store, _file, catalog) => {
    const { request, operation } = await setup(store, catalog);
    const op = (await store.tasks.operations(request.jobId))[0];
    assert.ok(op?.binding);
    const original = {
      intent: (await store.materials.reservation(request.attemptId)).intent,
      link: await store.materialPosts.link(op.id),
    };
    const effects: PostEffects = {
      url: 'https://www.facebook.com/post/create',
      timeOrigin: 100,
      ready: 'complete',
      composer: {
        text: original.intent.snapshot.text,
        files: [],
        media: [],
        uploaded: false,
        busy: false,
        submitEnabled: true,
      },
      posts: [],
    };
    const page = new EventEmitter() as unknown as Page;
    const network = new FacebookSubmissionNetworkObserver(
      store.submissionObservations,
      new NativeFacebookSubmissionWireAdapter({ ready: () => true, resolve: () => null }),
    );
    let audience: 'SELF' | null = null,
      buffers = 0,
      timeOrigin = 100;
    const observer = new FacebookSubmissionObserver(
      store.submissionObservations,
      async () => structuredClone(effects),
      network,
      async (_page, guard) => {
        await guard();
        return { url: effects.url, ready: 'complete', timeOrigin, audience };
      },
    );
    const bound = { ...op, binding: operation.binding };
    const enable = async () => {
      buffers++;
    };
    try {
      await assert.rejects(
        observer.prepare(page, bound, original, () => {}, undefined, enable),
        /AUDIENCE_UNCONFIRMED_BEFORE_INPUT/,
      );
      assert.equal(await store.submissionObservations.get(op.id), null);
      assert.equal(buffers, 0);
      audience = 'SELF';
      effects.ready = 'loading';
      await assert.rejects(
        observer.prepare(page, bound, original, () => {}, undefined, enable),
        /COMPOSER_NOT_READY/,
      );
      effects.ready = 'interactive';
      await observer.prepare(page, bound, original, () => {}, undefined, enable);
      assert.equal(buffers, 1);
      await observer.assert(page, bound, original, () => {});
      audience = null;
      await assert.rejects(
        observer.assert(page, bound, original, () => {}),
        /AUDIENCE_UNCONFIRMED_BEFORE_INPUT/,
      );
      audience = 'SELF';
      timeOrigin++;
      await assert.rejects(
        observer.assert(page, bound, original, () => {}),
        /AUDIENCE_UNCONFIRMED_BEFORE_INPUT/,
      );
      assert.equal(await store.materialPosts.result(request.attemptId), null);
      assert.equal((await store.materials.reservation(request.attemptId)).state, 'RESERVED');
    } finally {
      observer.stop();
    }
  });
});

test('product preserves current audience while retaining original content and document guards', async () => {
  await postFixture(async (store, _file, catalog) => {
    const { request, operation } = await setup(store, catalog);
    const op = (await store.tasks.operations(request.jobId))[0];
    assert.ok(op?.binding);
    const original = {
      intent: (await store.materials.reservation(request.attemptId)).intent,
      link: await store.materialPosts.link(op.id),
    };
    const effects: PostEffects = {
      url: 'https://www.facebook.com/post/create',
      timeOrigin: 100,
      ready: 'complete',
      composer: {
        text: original.intent.snapshot.text,
        files: [],
        media: [],
        uploaded: false,
        busy: false,
        submitEnabled: true,
      },
      posts: [],
    };
    const network = new FacebookSubmissionNetworkObserver(
      store.submissionObservations,
      new NativeFacebookSubmissionWireAdapter(
        { ready: () => true, resolve: () => null },
        'preserve-current',
      ),
    );
    let buffers = 0;
    const observer = new FacebookSubmissionObserver(
      store.submissionObservations,
      async () => structuredClone(effects),
      network,
      async () => {
        throw Error('PRIVATE_RESEARCH_READER_MUST_NOT_GATE_PRODUCT');
      },
    );
    const bound = { ...op, binding: operation.binding };
    try {
      await observer.prepare(
        new EventEmitter() as unknown as Page,
        bound,
        original,
        () => {},
        undefined,
        async () => {
          buffers++;
        },
      );
      assert.equal(buffers, 1);
      await observer.assert({} as Page, bound, original, () => {});
      effects.composer!.text += ' changed';
      await assert.rejects(
        observer.assert({} as Page, bound, original, () => {}),
        /DOCUMENT_OR_CONTENT_CHANGED/,
      );
      effects.composer!.text = original.intent.snapshot.text;
      effects.timeOrigin++;
      await assert.rejects(
        observer.assert({} as Page, bound, original, () => {}),
        /DOCUMENT_OR_CONTENT_CHANGED/,
      );
      assert.equal(await store.materialPosts.result(request.attemptId), null);
      assert.equal((await store.materials.reservation(request.attemptId)).state, 'RESERVED');
    } finally {
      observer.stop();
    }
  });
});

test('exact native result DOM can settle without the homepage repeating it; stored correlation alone and baseline-old posts cannot', async () => {
  for (const preexisting of [false, true])
    await postFixture(async (store, _file, catalog) => {
      const { request, operation, value } = await setup(store, catalog);
      if (preexisting) value.postIds = ['newpost'];
      await store.submissionObservations.capture(value);
      await store.tasks.acknowledgeBound({
        binding: operation.binding,
        evidence: { sdkReturned: true },
      });
      const op = (await store.tasks.operations(request.jobId))[0];
      assert.ok(op?.binding);
      const original = {
        intent: (await store.materials.reservation(request.attemptId)).intent,
        link: await store.materialPosts.link(op.id),
      };
      const effects: PostEffects = {
        url: 'https://www.facebook.com/permalink.php?story_fbid=1234&id=123456',
        ready: 'complete',
        timeOrigin: 200,
        composer: null,
        posts: [
          {
            accountId: '123456',
            postId: 'newpost',
            permalink: 'https://www.facebook.com/permalink.php?story_fbid=newpost&id=123456',
            text: original.intent.snapshot.text,
            expanded: true,
            nestedShare: false,
            photos: [],
            videoId: null,
            videoReady: false,
          },
        ],
      };
      const resolver = new LookupNativeFacebookPostResultResolver({
        ready: () => true,
        read: async () => effects,
      });
      const accepted = {
        nativePostId: '1234',
        nativeStoryId: 'unused',
        flow: 'ASYNC_SILENT' as const,
        photos: [],
        videoId: null,
      };
      const key = await resolver.resolve(accepted, original, () => {});
      assert.ok(key);
      const correlation = {
        ...key,
        binding: operation.binding,
        proof: request.proof,
        attemptId: request.attemptId,
        fingerprint: original.intent.fingerprint,
      };
      const observer = new DOMFacebookPostBusinessObserver(
        store.submissionObservations,
        store.uploadStages,
        {
          ready: () => true,
          read: async () => correlation,
          observedEffects: async (o, r, g) => await resolver.observedEffects(o, r, g),
        },
        randomUUID,
        async () => {
          throw Error('HOMEPAGE_SHOULD_NOT_BE_READ_FOR_CLOSED_RESULT');
        },
      );
      const verdict = await observer.verify(
        {} as Page,
        { ...op, binding: operation.binding },
        original,
        () => {},
      );
      assert.equal(verdict.kind, preexisting ? 'wait' : 'verified');
      assert.equal(await store.materialPosts.result(request.attemptId), null);
      if (verdict.kind === 'verified') {
        await store.materialPosts.verify(verdict.receipt);
        assert.equal((await store.materials.reservation(request.attemptId)).state, 'PUBLISHED');
      }
      const freshResolver = new LookupNativeFacebookPostResultResolver({
        ready: () => true,
        read: async () => effects,
      });
      assert.equal(await freshResolver.observedEffects(original, correlation, () => {}), null);
      assert.equal(
        await resolver.observedEffects(
          {
            ...original,
            intent: {
              ...original.intent,
              snapshot: { ...original.intent.snapshot, text: 'changed' },
            },
          },
          correlation,
          () => {},
        ),
        null,
      );
    });
});

test('matching own timeline text alone cannot settle: original native result correlation is required', async () => {
  await postFixture(async (store, _file, catalog) => {
    const { request, operation, value } = await setup(store, catalog);
    await store.submissionObservations.capture(value);
    await store.tasks.acknowledgeBound({
      binding: operation.binding,
      evidence: { sdkReturned: true },
    });
    const op = (await store.tasks.operations(request.jobId))[0];
    assert.ok(op?.binding);
    const original = {
      intent: (await store.materials.reservation(request.attemptId)).intent,
      link: await store.materialPosts.link(op.id),
    };
    const effects: PostEffects = {
      url: 'https://www.facebook.com/',
      timeOrigin: 100,
      ready: 'complete',
      composer: null,
      posts: [
        {
          accountId: '123456',
          postId: 'newpost',
          permalink: 'https://www.facebook.com/permalink.php?story_fbid=newpost&id=123456',
          text: original.intent.snapshot.text,
          expanded: true,
          nestedShare: false,
          photos: [],
          videoId: null,
          videoReady: false,
        },
      ],
    };
    let correlation: ReturnType<
      (typeof import('../src/shared/facebook-post-observation.js'))['FacebookPostResultCorrelation']['parse']
    > | null = null;
    const observer = new DOMFacebookPostBusinessObserver(
      store.submissionObservations,
      store.uploadStages,
      { ready: () => true, read: async () => correlation },
      randomUUID,
      async () => effects,
    );
    const page = {} as Page;
    assert.equal(
      (await observer.verify(page, { ...op, binding: operation.binding }, original, () => {})).kind,
      'wait',
    );
    correlation = {
      binding: operation.binding,
      proof: request.proof,
      attemptId: request.attemptId,
      fingerprint: value.fingerprint,
      postId: 'newpost',
      photos: [],
      videoId: null,
    };
    const verdict = await observer.verify(
      page,
      { ...op, binding: operation.binding },
      original,
      () => {},
    );
    assert.equal(verdict.kind, 'verified');
    if (verdict.kind === 'verified') await store.materialPosts.verify(verdict.receipt);
    assert.equal((await store.materials.reservation(request.attemptId)).state, 'PUBLISHED');
    assert.equal((await store.tasks.steps(request.jobId))[0]?.progress.published, 1);
  });
});
