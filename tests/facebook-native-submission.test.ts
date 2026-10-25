import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FacebookPostOriginal } from '../src/domain/facebook-post-execution.js';
import {
  NativeFacebookSubmissionWireAdapter,
  matchNativeFacebookSubmission,
  readAcceptedNativeFacebookPost,
} from '../src/infrastructure/facebook-native-submission-wire.js';

const sample = JSON.parse(
  readFileSync('tests/fixtures/facebook-native-submission.json', 'utf8'),
) as {
  rows: {
    kind: string;
    request: {
      name: string;
      av: string;
      input: { message: { text: string }; attachments: unknown[]; [key: string]: unknown };
    };
    response: {
      data: { story_create: { post_id: string; publishing_flow: string } };
      extensions: { is_final: boolean };
    };
  }[];
};
const originalFor = (row: (typeof sample.rows)[number]): FacebookPostOriginal =>
  ({
    intent: {
      attemptId: randomUUID(),
      fingerprint: 'a'.repeat(64),
      context: { accountId: row.request.av },
      snapshot: {
        text: row.request.input.message.text,
        format: row.kind === 'text' ? 'text' : row.kind === 'single' ? 'single-image' : 'video',
        files: row.kind === 'text' ? [] : [{ role: row.kind === 'single' ? 'image' : 'video' }],
      },
    },
    link: { operationId: randomUUID(), purpose: 'SUBMIT' },
  }) as unknown as FacebookPostOriginal;
const encode = (row: (typeof sample.rows)[number]) =>
  new URLSearchParams({
    fb_api_req_friendly_name: row.request.name,
    av: row.request.av,
    variables: JSON.stringify({ input: row.request.input }),
    fb_dtsg: 'fixture-secret-must-not-retain',
  }).toString();

test('generated native color preset correlation requires the original color resource and rejects plain substitution', () => {
  const row = structuredClone(sample.rows[0]!);
  const original = originalFor(row);
  Object.assign(original.intent, {
    resource: { row: { background: 'color', media: [] } },
  });
  row.request.input.text_format_preset_id = '123456789';
  assert.ok(matchNativeFacebookSubmission(encode(row), original));
  assert.equal(matchNativeFacebookSubmission(encode(row), originalFor(row)), null);
  for (const value of [undefined, '0', '-1', 'unknown-background', 123456789]) {
    row.request.input.text_format_preset_id = value;
    assert.equal(matchNativeFacebookSubmission(encode(row), original), null);
  }
});

test('FALLBACK embedded canonical story ID resolves the native route without declaring publication', () => {
  // This exact canonical ID was captured from the approved live FALLBACK response.
  const row = sample.rows[0]!;
  const key = matchNativeFacebookSubmission(encode(row), originalFor(row));
  assert.ok(key);
  const storyId = 'UzpfSTYxNTkzNjE1NTY0NzA4OjEyMjExODg4NTQ2NTQ1Mzg1MjoxMjIxMTg4ODU0NjU0NTM4NTI=';
  const body = {
    data: {
      story_create: {
        post_id: null,
        story_id: null,
        publishing_flow: 'FALLBACK',
        story: { id: storyId },
      },
    },
    extensions: { is_final: true },
  };
  assert.equal(
    readAcceptedNativeFacebookPost(JSON.stringify(body), key)?.nativePostId,
    '122118885465453852',
  );
  for (const change of [
    'missing',
    'malformed',
    'mixed',
    'unfinished',
    'errors',
    'conflicting-component',
  ]) {
    const wrong = structuredClone(body);
    if (change === 'missing') wrong.data.story_create.story.id = '';
    if (change === 'malformed')
      wrong.data.story_create.story.id = Buffer.from('foreign-story').toString('base64');
    if (change === 'mixed')
      Object.assign(wrong.data.story_create, { post_id: row.response.data.story_create.post_id });
    if (change === 'unfinished') wrong.extensions.is_final = false;
    if (change === 'errors') Object.assign(wrong, { errors: [{ code: 1 }] });
    if (change === 'conflicting-component')
      wrong.data.story_create.story.id = Buffer.from(
        'S:_I10000000000006:122118885465453852:999',
      ).toString('base64');
    assert.equal(readAcceptedNativeFacebookPost(JSON.stringify(wrong), key), null, change);
  }
});

test('observed ASYNC_NOTIF video with null post_id derives its canonical Story route, not a publication verdict', () => {
  const row = sample.rows[2]!;
  const key = matchNativeFacebookSubmission(encode(row), originalFor(row));
  assert.ok(key);
  // Exact bounded shape/ID captured from the authorized BWFORM video response.
  const body = {
    data: {
      story_create: {
        post_id: null as string | null,
        story_id: 'UzpfSTYxNTkzNjE1NTY0NzA4OjEyMjExODg4MzY4MzQ1Mzg1Mg==',
        publishing_flow: 'ASYNC_NOTIF',
        story: null,
      },
    },
    extensions: { is_final: true },
  };
  assert.equal(
    readAcceptedNativeFacebookPost(JSON.stringify(body), key)?.nativePostId,
    '122118883683453852',
  );
  body.data.story_create.post_id = '999';
  assert.equal(readAcceptedNativeFacebookPost(JSON.stringify(body), key), null);
  body.data.story_create.post_id = null;
  body.data.story_create.story_id = '';
  assert.equal(readAcceptedNativeFacebookPost(JSON.stringify(body), key), null);
});

test('product audience policy preserves a generated native audience without retaining members or widening private research', async () => {
  // Public/custom variants are generated from the captured SELF envelope. Not live acceptance.
  for (const baseState of ['SELF', 'EVERYONE', 'ALL_FRIENDS', 'CUSTOM']) {
    const row = structuredClone(sample.rows[0]!);
    row.request.input.audience = {
      privacy: {
        base_state: baseState,
        allow: baseState === 'CUSTOM' ? ['11111111111111111111'] : [],
        deny: [],
        tag_expansion_state: 'UNSPECIFIED',
      },
    };
    const original = originalFor(row);
    const resolver = {
      ready: () => true,
      resolve: () => ({ postId: 'generated-visible-id', photos: [], videoId: null }),
    };
    const product = new NativeFacebookSubmissionWireAdapter(resolver, 'preserve-current');
    const privateTest = new NativeFacebookSubmissionWireAdapter(resolver);
    assert.equal(await product.requiredAudience(), undefined);
    assert.equal(await privateTest.requiredAudience(), 'SELF');
    const key = await product.match(encode(row), original);
    assert.ok(key);
    const parsed = JSON.parse(key);
    assert.equal(parsed.version, 2);
    assert.equal(parsed.audience.baseState, baseState);
    assert.match(parsed.audience.privacyDigest, /^[a-f0-9]{64}$/);
    assert.equal(key.includes('11111111111111111111'), false);
    assert.equal(
      (await product.result(JSON.stringify(row.response), key, original))?.postId,
      'generated-visible-id',
    );
    assert.equal((await privateTest.match(encode(row), original)) !== null, baseState === 'SELF');
    assert.equal(await privateTest.result(JSON.stringify(row.response), key, original), null);
  }
});

test('preserve-current policy still refuses wrong actor/content, malformed privacy and keys from a private observer', async () => {
  const row = sample.rows[1]!;
  const original = originalFor(row);
  const adapter = new NativeFacebookSubmissionWireAdapter(
    {
      ready: () => true,
      resolve: () => ({ postId: 'generated-visible-id', photos: [], videoId: null }),
    },
    'preserve-current',
  );
  const oldKey = matchNativeFacebookSubmission(encode(row), original);
  assert.ok(oldKey);
  assert.equal(
    await adapter.result(JSON.stringify(row.response), JSON.stringify(oldKey), original),
    null,
  );
  for (const change of ['actor', 'content', 'privacy']) {
    const changed = structuredClone(row);
    if (change === 'actor') changed.request.input.actor_id = '999';
    if (change === 'content') changed.request.input.message.text += 'changed';
    if (change === 'privacy')
      changed.request.input.audience = {
        privacy: {
          base_state: 'EVERYONE',
          allow: ['invalid member'],
          deny: [],
          tag_expansion_state: 'UNSPECIFIED',
        },
      };
    assert.equal(await adapter.match(encode(changed), original), null, change);
  }
});

test('actual native text/single/video samples yield acceptance metadata, never a ready publisher without ID resolution', async () => {
  for (const row of sample.rows) {
    const original = originalFor(row),
      data = encode(row),
      key = matchNativeFacebookSubmission(data, original);
    assert.ok(key);
    assert.equal(JSON.stringify(key).includes('fixture-secret'), false);
    const accepted = readAcceptedNativeFacebookPost(JSON.stringify(row.response), key);
    assert.equal(accepted?.nativePostId, row.response.data.story_create.post_id);
    assert.equal(accepted?.flow, row.response.data.story_create.publishing_flow);
    assert.equal(accepted?.photos.length, row.kind === 'single' ? 1 : 0);
    assert.equal(accepted?.videoId, row.kind === 'video' ? '2092087444732127' : null);
    const adapter = new NativeFacebookSubmissionWireAdapter();
    assert.equal(adapter.ready(), false);
    assert.equal(
      await adapter.result(JSON.stringify(row.response), JSON.stringify(key), original),
      null,
    );
  }
});
test('native matching refuses foreign actor, changed complete text, public audience, extra media and duplicate envelope fields', () => {
  const row = sample.rows[1]!;
  for (const change of [
    'actor',
    'text',
    'audience',
    'attachments',
    'duplicate',
    'name',
    'background',
  ]) {
    const copy = structuredClone(row),
      original = originalFor(row);
    if (change === 'actor') copy.request.input.actor_id = '999';
    if (change === 'text') copy.request.input.message.text += 'changed';
    if (change === 'audience')
      copy.request.input.audience = {
        privacy: {
          allow: [],
          deny: [],
          base_state: 'EVERYONE',
          tag_expansion_state: 'UNSPECIFIED',
        },
      };
    if (change === 'attachments')
      copy.request.input.attachments.push(structuredClone(copy.request.input.attachments[0]));
    if (change === 'name') copy.request.name = 'UnrecognizedMutation';
    if (change === 'background') copy.request.input.text_format_preset_id = 'unknown-background';
    const data = encode(copy) + (change === 'duplicate' ? '&av=' + row.request.av : '');
    assert.equal(matchNativeFacebookSubmission(data, original), null, change);
  }
});
test('HTTP-success JSON with errors, unfinished output, mismatched numeric story ID or unknown flow is not native acceptance', () => {
  const row = sample.rows[0]!,
    original = originalFor(row),
    key = matchNativeFacebookSubmission(encode(row), original);
  assert.ok(key);
  for (const change of ['errors', 'unfinished', 'numeric', 'flow', 'truncated']) {
    const response = structuredClone(row.response) as typeof row.response & { errors?: unknown[] };
    if (change === 'errors') response.errors = [{ message: 'fixture failure' }];
    if (change === 'unfinished') response.extensions.is_final = false;
    if (change === 'numeric') response.data.story_create.post_id = '999';
    if (change === 'flow') response.data.story_create.publishing_flow = 'UNOBSERVED_FLOW';
    let body = JSON.stringify(response);
    if (change === 'truncated') body = body.slice(0, -4);
    assert.equal(readAcceptedNativeFacebookPost(body, key), null, change);
  }
});
test('wire resolution keeps original operation/content binding and exact native media; malformed multi-image is rejected before input', async () => {
  const row = sample.rows[2]!,
    original = originalFor(row),
    body = JSON.stringify(row.response);
  const resolver = {
    ready: () => true,
    resolve: (r: { videoId: string | null; photos: string[] }) => ({
      postId: r.videoId!,
      photos: r.photos,
      videoId: r.videoId,
    }),
  };
  const adapter = new NativeFacebookSubmissionWireAdapter(resolver);
  const key = await adapter.match(encode(row), original);
  assert.ok(key);
  assert.equal((await adapter.result(body, key, original))?.postId, '2092087444732127');
  const other = structuredClone(original);
  other.link.operationId = randomUUID();
  assert.equal(await adapter.result(body, key, other), null);
  other.link.operationId = original.link.operationId;
  other.intent.snapshot.text += 'changed';
  assert.equal(await adapter.result(body, key, other), null);
  const wrong = new NativeFacebookSubmissionWireAdapter({
    ready: () => true,
    resolve: () => ({ postId: 'bad', photos: [], videoId: '999' }),
  });
  assert.equal(await wrong.result(body, key, original), null);
  const multi = structuredClone(original);
  multi.intent.snapshot.format = 'multi-image';
  assert.equal(adapter.supportsOriginal(multi), false);
  assert.equal(await adapter.match(encode(row), multi), null);
});

test('generated multi-image extension of the observed photo array matches exact count/order and original content only', async () => {
  // Constructed from the single-image wire shape, not a captured live multi-image request.
  const row = structuredClone(sample.rows[1]!);
  row.request.input.attachments.push({ photo: { id: '123456789' } });
  const original = originalFor(row);
  original.intent.snapshot.format = 'multi-image';
  original.intent.snapshot.files.push(structuredClone(original.intent.snapshot.files[0]!));
  const adapter = new NativeFacebookSubmissionWireAdapter({
    ready: () => true,
    resolve: (value) => ({ postId: 'generated-visible-id', photos: value.photos, videoId: null }),
  });
  assert.equal(adapter.supportsOriginal(original), true);
  const key = await adapter.match(encode(row), original);
  assert.ok(key);
  const expected = row.request.input.attachments.map(
    (value) => (value as { photo: { id: string } }).photo.id,
  );
  assert.deepEqual(JSON.parse(key).photos, expected);
  const resolved = await adapter.result(JSON.stringify(row.response), key, original);
  assert.deepEqual(resolved?.photos, expected);
  assert.equal(new NativeFacebookSubmissionWireAdapter().ready(), false);
  for (const change of ['missing', 'extra', 'duplicate', 'mixed', 'actor', 'body']) {
    const wrong = structuredClone(row);
    if (change === 'missing') wrong.request.input.attachments.pop();
    if (change === 'extra') wrong.request.input.attachments.push({ photo: { id: '999' } });
    if (change === 'duplicate')
      wrong.request.input.attachments[1] = structuredClone(wrong.request.input.attachments[0]);
    if (change === 'mixed') wrong.request.input.attachments[1] = { video: { id: '999' } };
    if (change === 'actor') wrong.request.input.actor_id = '999';
    if (change === 'body') wrong.request.input.message.text += 'changed';
    assert.equal(await adapter.match(encode(wrong), original), null, change);
  }
  const wrongOrder = new NativeFacebookSubmissionWireAdapter({
    ready: () => true,
    resolve: (value) => ({
      postId: 'generated-visible-id',
      photos: [...value.photos].reverse(),
      videoId: null,
    }),
  });
  assert.equal(await wrongOrder.result(JSON.stringify(row.response), key, original), null);
});
