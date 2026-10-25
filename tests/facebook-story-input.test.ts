import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Page, Request, Response } from 'playwright-core';
import { FacebookStoryComposerObserver } from '../src/infrastructure/facebook-story-composer-observer.js';
import {
  FacebookStorySubmissionObserver,
  describeStoryNativeValue,
  matchStoryResearchRequest,
} from '../src/infrastructure/facebook-story-submission-observer.js';
import { postFixture, postRequest, dispatchedPost } from './fixtures/material-post.js';
import { storyPrivacyTargets } from '../src/shared/facebook-story-privacy.js';
import type { StoryPage } from '../src/shared/facebook-story.js';
import { storyMediaTextFinish } from '../src/shared/facebook-story.js';

test('media text finish allows its own blur transition but rejects changed caption, media or target', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const item = await dispatchedPost(store, r);
    const intent = structuredClone((await store.materials.reservation(r.attemptId)).intent);
    intent.snapshot.format = 'single-image';
    intent.snapshot.files = [
      { ...intent.snapshot.files[0]!, role: 'image', digest: 'a'.repeat(64), bytes: 100 },
    ];
    const reading = storyPage(intent.snapshot.text);
    reading.phase = 'media-editor';
    reading.media = { kind: 'image', ready: true, bytes: 100, sha256: 'a'.repeat(64) };
    reading.privacy = { ...reading.privacy!, phase: 'CLOSED' };
    const action = {
      kind: 'click' as const,
      tabId: r.proof.tabId,
      documentEpoch: 0,
      routeEpoch: 0,
      target: storyMediaTextFinish,
    };
    const post = {
      intent,
      link: {
        ...(await store.materialPosts.link(item.prepared.operationId)),
        purpose: 'ADVANCE_COMPOSER' as const,
        action,
      },
    };
    const observer = new FacebookStoryComposerObserver(async () => structuredClone(reading));
    for (const editing of [true, false]) {
      reading.textEditing = editing;
      await observer.assert({} as Page, action, post, () => {});
    }
    reading.text += 'changed';
    await assert.rejects(
      observer.assert({} as Page, action, post, () => {}),
      /UNCONFIRMED/,
    );
    reading.text = intent.snapshot.text;
    reading.media.sha256 = 'b'.repeat(64);
    await assert.rejects(
      observer.assert({} as Page, action, post, () => {}),
      /UNCONFIRMED/,
    );
    reading.media.sha256 = 'a'.repeat(64);
    const wrong = { ...action, target: { ...storyMediaTextFinish, text: 'Share to story' } };
    await assert.rejects(
      observer.assert(
        {} as Page,
        wrong,
        { ...post, link: { ...post.link, action: wrong } },
        () => {},
      ),
      /UNCONFIRMED/,
    );
  }, false);
});

const storyPage = (text = ''): StoryPage => ({
  url: 'https://www.facebook.com/stories/create/',
  timeOrigin: 100,
  locale: 'en',
  ready: true,
  visible: true,
  phase: 'text-editor',
  text,
  textCSS: '[role="textbox"]',
  mediaCSS: null,
  textEntry: null,
  submit: { css: '[aria-label="Share to story"]', enabled: true },
  fontCSS: null,
  ai: null,
  privacy: {
    phase: 'MENU',
    draftSelection: 'FRIENDS',
    openEnabled: false,
    friendsEnabled: true,
    saveEnabled: true,
    cancelEnabled: true,
  },
});

test('media entry allows only the exact upload target after privacy closure and cannot submit from entry', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const item = await dispatchedPost(store, r);
    const intent = structuredClone((await store.materials.reservation(r.attemptId)).intent);
    intent.snapshot.format = 'single-image';
    const reading = storyPage();
    reading.phase = 'entry';
    reading.text = null;
    reading.textCSS = null;
    reading.mediaCSS = 'input[type="file"]:not([multiple])[accept*="image/"][accept*="video/"]';
    reading.privacy = { ...reading.privacy!, phase: 'CLOSED' };
    const observer = new FacebookStoryComposerObserver(async () => structuredClone(reading));
    const action = {
      kind: 'uploadMedia' as const,
      tabId: r.proof.tabId,
      documentEpoch: 0,
      routeEpoch: 0,
      attemptId: intent.attemptId,
      fingerprint: intent.fingerprint,
      target: { css: reading.mediaCSS },
    };
    const post = {
      intent,
      link: {
        ...(await store.materialPosts.link(item.prepared.operationId)),
        purpose: 'UPLOAD_MEDIA' as const,
        action,
      },
    };
    await observer.assert({} as Page, action, post, () => {});
    const wrong = { ...action, target: { css: 'input[type="file"]' } };
    await assert.rejects(
      observer.assert(
        {} as Page,
        wrong,
        { ...post, link: { ...post.link, action: wrong } },
        () => {},
      ),
      /UNCONFIRMED/,
    );
    reading.privacy.phase = 'MENU';
    await assert.rejects(
      observer.assert({} as Page, action, post, () => {}),
      /UNCONFIRMED/,
    );
    reading.privacy.phase = 'CLOSED';
    const submit = {
      kind: 'click' as const,
      tabId: r.proof.tabId,
      documentEpoch: 0,
      routeEpoch: 0,
      target: { css: reading.submit!.css },
    };
    await assert.rejects(
      observer.assert(
        {} as Page,
        submit,
        { intent, link: { ...post.link, purpose: 'SUBMIT', action: submit } },
        () => {},
      ),
      /UNCONFIRMED/,
    );
  }, false);
});

test('story composer checks fresh privacy, complete original text and exact targets; cancellation never turns into Save', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const item = await dispatchedPost(store, r),
      intent = (await store.materials.reservation(r.attemptId)).intent;
    let reading = storyPage();
    const observer = new FacebookStoryComposerObserver(async (_page, guard) => {
      await guard();
      return structuredClone(reading);
    });
    const action = {
      kind: 'click' as const,
      tabId: r.proof.tabId,
      documentEpoch: 0,
      routeEpoch: 0,
      target: storyPrivacyTargets.close,
    };
    const post = {
      intent,
      link: {
        ...(await store.materialPosts.link(item.prepared.operationId)),
        purpose: 'CLOSE_AUDIENCE' as const,
        action,
      },
    };
    await observer.assert({} as Page, action, post, () => {});
    reading.privacy = { ...reading.privacy!, draftSelection: 'PUBLIC' };
    await assert.rejects(
      observer.assert({} as Page, action, post, () => {}),
      /UNCONFIRMED/,
    );
    reading = storyPage(intent.snapshot.text);
    reading.privacy = { ...reading.privacy!, phase: 'CLOSED' };
    const submit = { ...action, target: { css: reading.submit!.css } };
    await observer.assert(
      {} as Page,
      submit,
      { intent, link: { ...post.link, purpose: 'SUBMIT', action: submit } },
      () => {},
    );
    reading.text += 'changed';
    await assert.rejects(
      observer.assert(
        {} as Page,
        submit,
        { intent, link: { ...post.link, purpose: 'SUBMIT', action: submit } },
        () => {},
      ),
      /UNCONFIRMED/,
    );
  }, false);
});

test('finite story sampling records only the original actor and full text request; a response never fabricates publication', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog, { accountId: '12345' });
    await store.materials.reserve(r);
    const item = await dispatchedPost(store, r);
    const operation = await store.tasks.findOperation(r.jobId, item.prepared.operationId);
    assert.ok(operation?.binding);
    const original = {
      intent: (await store.materials.reservation(r.attemptId)).intent,
      link: await store.materialPosts.link(operation.id),
    };
    const emitter = new EventEmitter();
    const notice = {
      url: 'https://www.facebook.com/stories',
      timeOrigin: 100,
      ready: 'complete',
      visible: true,
      notices: [] as string[],
      ownStoryLinks: [] as string[],
    };
    const page = Object.assign(emitter, {
      evaluate: async () => structuredClone(notice),
    }) as unknown as Page;
    const reading = storyPage(original.intent.snapshot.text);
    reading.privacy = { ...reading.privacy!, phase: 'CLOSED' };
    const diagnostic: unknown[] = [];
    const observer = new FacebookStorySubmissionObserver(
      store.submissionObservations,
      (value) => diagnostic.push(value),
      async () => reading,
    );
    let buffers = 0;
    await observer.prepare(
      page,
      operation as typeof operation & { binding: typeof item.binding },
      original,
      () => {},
      undefined,
      async () => {
        buffers++;
      },
    );
    assert.equal(buffers, 1);
    assert.equal(observer.ready(), true);
    const body = new URLSearchParams({
      av: r.context.accountId,
      fb_api_req_friendly_name: 'ObservedStoryCreateMutation',
      fb_dtsg: 'PRIVATE_CREDENTIAL',
      variables: JSON.stringify({
        input: {
          actor_id: r.context.accountId,
          message: { text: original.intent.snapshot.text },
          credential_token: 'PRIVATE_CREDENTIAL',
        },
      }),
    }).toString();
    assert.ok(matchStoryResearchRequest(body, original));
    const mediaOriginal = {
      ...original,
      intent: {
        ...original.intent,
        snapshot: { ...original.intent.snapshot, format: 'video' as const },
      },
    };
    const irrelevant = new URLSearchParams({
      av: r.context.accountId,
      fb_api_req_friendly_name: 'CometFeedStoryExecuteNFXActionMutation',
      variables: JSON.stringify({ input: { actor_id: r.context.accountId, type: 'HIDE_XOUT' } }),
    });
    assert.equal(matchStoryResearchRequest(irrelevant.toString(), mediaOriginal), null);
    assert.equal(
      matchStoryResearchRequest(
        body.replace(encodeURIComponent(original.intent.snapshot.text), 'other'),
        original,
      ),
      null,
    );
    const request = {
      url: () => 'https://www.facebook.com/api/graphql/',
      method: () => 'POST',
      postData: () => body,
    } as Request;
    emitter.emit('request', request);
    emitter.emit('response', {
      request: () => request,
      status: () => 200,
      text: async () =>
        JSON.stringify({
          data: { observed_create: { id: '123', __typename: 'Story' } },
          extensions: { is_final: true },
        }),
    } as unknown as Response);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(diagnostic.length, 2);
    const value = JSON.stringify(diagnostic);
    assert.equal(value.includes('PRIVATE_CREDENTIAL'), false);
    assert.equal(value.includes(original.intent.snapshot.text), false);
    assert.equal(await store.materialPosts.result(r.attemptId), null);
    const result = await observer.verify(
      page,
      operation as typeof operation & { binding: typeof item.binding },
      original,
      () => {},
    );
    assert.equal(result.kind, 'wait');
    const nativeBody = new URLSearchParams({
      av: r.context.accountId,
      fb_api_req_friendly_name: 'StoriesCreateMutation',
      variables: JSON.stringify({
        input: {
          actor_id: r.context.accountId,
          source: 'WWW',
          audiences_is_complete: true,
          audiences: [{ stories: { self: { target_id: r.context.accountId } } }],
          message: { text: original.intent.snapshot.text, ranges: [] },
        },
      }),
    }).toString();
    const nativeRequest = { ...request, postData: () => nativeBody } as Request;
    const created = {
      data: {
        story_create: {
          story_id: null,
          items: [{ story: { id: Buffer.from('S:_ISC:123').toString('base64') } }],
          viewer: {
            actor: {
              id: r.context.accountId,
              __typename: 'User',
              story_bucket: { nodes: [{ id: '456' }] },
            },
          },
        },
      },
      extensions: { is_final: true },
    };
    emitter.emit('request', nativeRequest);
    emitter.emit('response', {
      request: () => nativeRequest,
      status: () => 200,
      text: async () => JSON.stringify(created),
    } as unknown as Response);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      (
        await observer.verify(
          page,
          operation as typeof operation & { binding: typeof item.binding },
          original,
          () => {},
        )
      ).kind,
      'wait',
    );
    notice.notices = ['Story posted'];
    const published = await observer.verify(
      page,
      operation as typeof operation & { binding: typeof item.binding },
      original,
      () => {},
    );
    assert.equal(published.kind, 'verified');
    if (published.kind === 'verified')
      assert.equal(published.receipt.evidence.outcome, 'PUBLISHED');
    notice.url = 'https://www.facebook.com/';
    notice.ownStoryLinks = [
      'https://www.facebook.com/stories/456/' +
        created.data.story_create.items[0]!.story.id +
        '/?source=story_tray',
    ];
    assert.equal(
      (
        await observer.verify(
          page,
          operation as typeof operation & { binding: typeof item.binding },
          original,
          () => {},
        )
      ).kind,
      'verified',
    );
    notice.ownStoryLinks = ['https://www.facebook.com/stories/456/foreign/'];
    assert.equal(
      (
        await observer.verify(
          page,
          operation as typeof operation & { binding: typeof item.binding },
          original,
          () => {},
        )
      ).kind,
      'wait',
    );
    notice.url = 'https://www.facebook.com/stories';
    notice.timeOrigin++;
    assert.equal(
      (
        await observer.verify(
          page,
          operation as typeof operation & { binding: typeof item.binding },
          original,
          () => {},
        )
      ).kind,
      'wait',
    );
    observer.stop();
    assert.equal(emitter.listenerCount('request'), 0);
    assert.equal(emitter.listenerCount('response'), 0);
    await assert.rejects(
      observer.prepare(
        page,
        operation as typeof operation & { binding: typeof item.binding },
        original,
        () => {},
        undefined,
        async () => {},
      ),
      /ORIGINAL_SUBMIT_REQUIRED/,
    );
    assert.equal(
      JSON.stringify(
        describeStoryNativeValue({ access_token: 'secret', id: '123', text: 'original' }),
      ).includes('secret'),
      false,
    );
  }, false);
});
