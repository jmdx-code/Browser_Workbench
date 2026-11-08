import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNativeStoryCreation,
  isNativeTextStoryRequest,
  isNativeMediaStoryRequest,
} from '../src/infrastructure/facebook-story-native-result.js';

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

test('native story final response supports anti-XSSI JSON chunks and rejects any errors or conflicting created IDs', () => {
  const valid = native();
  assert.equal(
    parseNativeStoryCreation(
      'for (;;);' + JSON.stringify({ data: {} }) + '\n' + JSON.stringify(valid),
      200,
      '456',
    )?.bucketId,
    '789',
  );
  assert.equal(
    parseNativeStoryCreation(
      JSON.stringify(valid) + '\n' + JSON.stringify({ errors: [{ message: 'rejected' }] }),
      200,
      '456',
    ),
    null,
  );
  const other = native();
  other.data.story_create.items[0]!.story.id = Buffer.from('S:_ISC:124').toString('base64');
  assert.equal(
    parseNativeStoryCreation(JSON.stringify(valid) + '\n' + JSON.stringify(other), 200, '456'),
    null,
  );
});
