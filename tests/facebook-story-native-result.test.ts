import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNativeStoryCreation,
  isNativeTextStoryRequest,
  isNativeMediaStoryRequest,
  readStoryPublishedNotice,
} from '../src/infrastructure/facebook-story-native-result.js';
import type { Page } from 'playwright-core';

test('native home redirect confirms only the exact returned own-story link and current visible published notice', async () => {
  const created = {
    actorId: '456',
    bucketId: '789',
    storyId: Buffer.from('S:_ISC:123').toString('base64'),
  };
  const exact = 'https://www.facebook.com/stories/789/' + created.storyId + '/';
  const valid = {
    url: 'https://www.facebook.com/',
    timeOrigin: 100,
    ready: 'complete',
    visible: true,
    notices: ['Story posted'],
    ownStoryLinks: [exact + '?source=story_tray'],
  };
  const check = (value: unknown, context = created) =>
    readStoryPublishedNotice(
      { evaluate: async () => value } as unknown as Page,
      100,
      () => {},
      context,
    );
  assert.equal(await check(valid), true);
  for (const changed of [
    { ...valid, url: 'https://www.facebook.com/reel/' },
    { ...valid, timeOrigin: 101 },
    { ...valid, ready: 'loading' },
    { ...valid, visible: false },
    { ...valid, notices: [] },
    { ...valid, notices: ['Story posted', 'Story posted'] },
    { ...valid, ownStoryLinks: [] },
    { ...valid, ownStoryLinks: [exact, exact] },
    { ...valid, ownStoryLinks: [exact.replace('/789/', '/999/')] },
    { ...valid, ownStoryLinks: [exact.replace('www.facebook.com', 'foreign.example')] },
  ])
    assert.equal(await check(changed), false);
  assert.equal(
    await readStoryPublishedNotice(
      { evaluate: async () => valid } as unknown as Page,
      100,
      () => {},
    ),
    false,
  );
  assert.equal(
    await check({ ...valid, url: 'https://www.facebook.com/stories', ownStoryLinks: [] }),
    true,
  );
});

const native = () => ({
  data: {
    story_create: {
      story_id: null,
      items: [{ story: { id: Buffer.from('S:_ISC:123').toString('base64') } }],
      viewer: {
        actor: { id: '456', __typename: 'User', story_bucket: { nodes: [{ id: '789' }] } },
      },
    },
  },
  extensions: { is_final: true },
});

test('generated media-story envelope requires one matching media type, actor, own destination and unchanged optional text', () => {
  for (const format of ['single-image', 'video'] as const) {
    const input = {
      actor_id: '456',
      source: 'WWW',
      audiences_is_complete: true,
      audiences: [{ stories: { self: { target_id: '456' } } }],
      message: { text: '', ranges: [] },
      attachments: [
        format === 'single-image' ? { photo: { id: '111' } } : { video: { id: '222' } },
      ],
    };
    const encode = (value: unknown) =>
      new URLSearchParams({
        av: '456',
        fb_api_req_friendly_name: 'StoriesCreateMutation',
        variables: JSON.stringify({ input: value }),
      }).toString();
    assert.equal(isNativeMediaStoryRequest(encode(input), '456', 'original caption', format), true);
    if (format === 'video') {
      assert.equal(
        isNativeMediaStoryRequest(encode(input), '456', 'original caption', format, '222'),
        true,
      );
      assert.equal(
        isNativeMediaStoryRequest(encode(input), '456', 'original caption', format, '333'),
        false,
      );
    }
    if (format === 'single-image') {
      assert.equal(
        isNativeMediaStoryRequest(
          encode({ ...input, attachments: [{ photo: { id: '111', overlays: [] } }] }),
          '456',
          'original caption',
          format,
        ),
        true,
      );
      assert.equal(
        isNativeMediaStoryRequest(
          encode({
            ...input,
            attachments: [{ photo: { id: '111', overlays: [{ text: 'unverified' }] } }],
          }),
          '456',
          'original caption',
          format,
        ),
        false,
      );
    }
    assert.equal(isNativeTextStoryRequest(encode(input), '456', ''), false);
    for (const change of [
      { ...input, actor_id: '999' },
      { ...input, audiences: [{ stories: { self: { target_id: '999' } } }] },
      { ...input, attachments: [] },
      { ...input, attachments: [...input.attachments, ...input.attachments] },
      { ...input, message: { text: 'foreign caption', ranges: [] } },
      {
        ...input,
        attachments:
          format === 'single-image' ? [{ video: { id: '222' } }] : [{ photo: { id: '111' } }],
      },
    ])
      assert.equal(
        isNativeMediaStoryRequest(encode(change), '456', 'original caption', format),
        false,
      );
  }
});

test('observed 24h story result requires one item, native story identifier, matching actor, own bucket and final response', () => {
  const response = native();
  assert.deepEqual(parseNativeStoryCreation(JSON.stringify(response), 200, '456'), {
    actorId: '456',
    bucketId: '789',
    storyId: response.data.story_create.items[0]?.story.id,
  });
  assert.equal(parseNativeStoryCreation(JSON.stringify(response), 200, '123'), null);
  assert.equal(parseNativeStoryCreation(JSON.stringify(response), 201, '456'), null);
  response.extensions.is_final = false;
  assert.equal(parseNativeStoryCreation(JSON.stringify(response), 200, '456'), null);
  response.extensions.is_final = true;
  const item = response.data.story_create.items[0];
  assert.ok(item);
  response.data.story_create.items.push(item);
  assert.equal(parseNativeStoryCreation(JSON.stringify(response), 200, '456'), null);
  const ordinary = native();
  const ordinaryItem = ordinary.data.story_create.items[0];
  assert.ok(ordinaryItem);
  ordinaryItem.story.id = Buffer.from('S:_I:123').toString('base64');
  assert.equal(parseNativeStoryCreation(JSON.stringify(ordinary), 200, '456'), null);
  assert.equal(
    parseNativeStoryCreation(
      JSON.stringify({ ...native(), errors: [{ message: 'failed' }] }),
      200,
      '456',
    ),
    null,
  );
});

test('native story request cannot target another actor, audience, ordinary post or changed full text', () => {
  const vars = {
    input: {
      actor_id: '456',
      source: 'WWW',
      audiences_is_complete: true,
      audiences: [{ stories: { self: { target_id: '456' } } }],
      message: { text: 'exact text', ranges: [] },
    },
  };
  const params = new URLSearchParams({
    av: '456',
    fb_api_req_friendly_name: 'StoriesCreateMutation',
    variables: JSON.stringify(vars),
  });
  assert.equal(isNativeTextStoryRequest(params.toString(), '456', 'exact text'), true);
  assert.equal(isNativeTextStoryRequest(params.toString(), '456', 'other text'), false);
  params.set('fb_api_req_friendly_name', 'ComposerStoryCreateMutation');
  assert.equal(isNativeTextStoryRequest(params.toString(), '456', 'exact text'), false);
  params.set('fb_api_req_friendly_name', 'StoriesCreateMutation');
  const audience = vars.input.audiences[0];
  assert.ok(audience);
  audience.stories.self.target_id = '123';
  params.set('variables', JSON.stringify(vars));
  assert.equal(isNativeTextStoryRequest(params.toString(), '456', 'exact text'), false);
});
