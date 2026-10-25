import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { observedNewOwnPost, observedMediaUpload } from '../src/domain/facebook-post-effects.js';
import type { PostEffects, SubmissionBaseline } from '../src/shared/facebook-post-observation.js';
import type { PostIntent } from '../src/shared/material-index.js';
import type { UploadManifest } from '../src/shared/material-upload.js';

function fixture(format: 'text' | 'single-image' | 'multi-image' | 'video') {
  const count = format === 'text' ? 0 : format === 'multi-image' ? 2 : 1;
  const files = Array.from({ length: count }, (_, i) => ({
    relativePath: 'source-' + i + '.png',
    role: format === 'video' ? ('video' as const) : ('image' as const),
    digest: String(i).repeat(64),
    bytes: 1024,
    proof: { dev: '1', ino: '2', size: '1024', mtimeNs: '1', ctimeNs: '1' },
  }));
  const intent = {
    attemptId: randomUUID(),
    fingerprint: 'a'.repeat(64),
    context: { accountId: '123' },
    snapshot: { text: '文案\n🙂العربية complete suffix', format, files },
  } as PostIntent;
  const operationId = randomUUID(),
    profileId = randomUUID();
  const baseline: SubmissionBaseline = {
    operationId,
    binding: {
      operationId,
      profileId,
      accountId: '123',
      jobId: randomUUID(),
      stepId: randomUUID(),
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: 0,
      actionDigest: 'a'.repeat(64),
    },
    proof: {
      profileId,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      targetId: randomUUID(),
      tabId: 42,
    },
    attemptId: intent.attemptId,
    accountId: '123',
    fingerprint: intent.fingerprint,
    postIds: ['old'],
    url: 'https://www.facebook.com/',
    timeOrigin: 1000,
    checkedAt: 1000,
  };
  const effects: PostEffects = {
    url: 'https://www.facebook.com/',
    timeOrigin: 1000,
    ready: 'complete',
    composer: null,
    posts: [
      {
        accountId: '123',
        postId: 'new',
        permalink: 'https://www.facebook.com/reel/new/',
        text: intent.snapshot.text + ' ',
        expanded: true,
        nestedShare: false,
        photos: format.includes('image') ? files.map((_, i) => String(i)) : [],
        videoId: format === 'video' ? 'new' : null,
        videoReady: format === 'video',
      },
    ],
  };
  const manifest = {
    version: 1,
    attemptId: intent.attemptId,
    fingerprint: intent.fingerprint,
    files: files.map((original, i) => ({
      original,
      name: String(i).padStart(2, '0') + '-' + original.digest + '.png',
    })),
  } as UploadManifest;
  return { intent, baseline, effects, manifest };
}
test('independent result rejects old, wrong-author, nested shares, truncated, ambiguous and uncorrelated pure-media posts', () => {
  for (const format of ['text', 'single-image', 'multi-image', 'video'] as const) {
    const f = fixture(format);
    assert.equal(observedNewOwnPost(f.effects, f.intent, f.baseline)?.postId, 'new');
    assert.equal(
      observedNewOwnPost({ ...f.effects, ready: 'interactive' }, f.intent, f.baseline)?.postId,
      'new',
    );
    assert.equal(
      observedNewOwnPost({ ...f.effects, ready: 'loading' }, f.intent, f.baseline),
      null,
    );
    const bad = structuredClone(f.effects);
    bad.posts[0]!.accountId = 'other';
    assert.equal(observedNewOwnPost(bad, f.intent, f.baseline), null);
    bad.posts[0]!.accountId = '123';
    bad.posts[0]!.nestedShare = true;
    assert.equal(observedNewOwnPost(bad, f.intent, f.baseline), null);
    bad.posts[0]!.nestedShare = false;
    bad.posts[0]!.text = '文案\n🙂العربية wrong suffix';
    assert.equal(observedNewOwnPost(bad, f.intent, f.baseline), null);
    assert.equal(
      observedNewOwnPost(f.effects, f.intent, { ...f.baseline, postIds: ['new'] }),
      null,
    );
    f.effects.posts.push({
      ...f.effects.posts[0]!,
      postId: 'second',
      videoId: format === 'video' ? 'second' : null,
    });
    assert.equal(observedNewOwnPost(f.effects, f.intent, f.baseline), null);
    f.effects.posts.pop();
    f.intent.snapshot.text = '';
    f.effects.posts[0]!.text = '';
    assert.equal(observedNewOwnPost(f.effects, f.intent, f.baseline), null);
    if (format !== 'text') {
      const original = f.effects.posts[0]!;
      const result = {
        binding: f.baseline.binding,
        proof: f.baseline.proof,
        attemptId: f.intent.attemptId,
        fingerprint: f.intent.fingerprint,
        postId: 'new',
        photos: original.photos,
        videoId: original.videoId,
      };
      assert.equal(observedNewOwnPost(f.effects, f.intent, f.baseline, result)?.postId, 'new');
      assert.equal(
        observedNewOwnPost(f.effects, f.intent, f.baseline, {
          ...result,
          binding: { ...result.binding, leaseId: randomUUID() },
        }),
        null,
      );
      assert.equal(
        observedNewOwnPost(f.effects, f.intent, f.baseline, { ...result, postId: 'different' }),
        null,
      );
    }
  }
});
test('media readiness requires original stage names, sizes, order and real uploaded cards beyond file input ACK', () => {
  for (const format of ['single-image', 'multi-image', 'video'] as const) {
    const f = fixture(format);
    f.effects.composer = {
      text: f.intent.snapshot.text,
      uploaded: true,
      busy: false,
      submitEnabled: true,
      files: f.manifest.files.map((file) => ({ name: file.name, size: file.original.bytes })),
      media: f.manifest.files.map((file) => ({
        kind: format === 'video' ? 'video' : 'image',
        name: format === 'video' ? null : file.name,
        ready: true,
      })),
    };
    assert.equal(observedMediaUpload(f.effects, f.intent, f.manifest)?.format, format);
    assert.equal(
      observedMediaUpload({ ...f.effects, ready: 'interactive' }, f.intent, f.manifest)?.format,
      format,
    );
    assert.equal(
      observedMediaUpload({ ...f.effects, ready: 'loading' }, f.intent, f.manifest),
      null,
    );
    f.effects.composer.uploaded = false;
    assert.equal(observedMediaUpload(f.effects, f.intent, f.manifest), null);
    f.effects.composer.uploaded = true;
    f.effects.composer.files[0]!.size++;
    assert.equal(observedMediaUpload(f.effects, f.intent, f.manifest), null);
    f.effects.composer.files[0]!.size--;
    f.effects.composer.busy = true;
    assert.equal(observedMediaUpload(f.effects, f.intent, f.manifest), null);
    f.effects.composer.busy = false;
    f.effects.composer.media[0]!.ready = false;
    assert.equal(observedMediaUpload(f.effects, f.intent, f.manifest), null);
  }
});

test('cleared Facebook image inputs require the complete ordered decoded stage names, never anonymous video cards', () => {
  for (const format of ['single-image', 'multi-image', 'video'] as const) {
    const f = fixture(format);
    const composer = {
      text: f.intent.snapshot.text,
      uploaded: true,
      busy: false,
      submitEnabled: true,
      files: [],
      media: f.manifest.files.map((file) => ({
        kind: format === 'video' ? ('video' as const) : ('image' as const),
        name: format === 'video' ? null : file.name,
        ready: true,
      })),
    };
    f.effects.composer = composer;
    assert.equal(
      observedMediaUpload(f.effects, f.intent, f.manifest)?.format ?? null,
      format === 'video' ? null : format,
    );
    const first = composer.media[0];
    if (!first) throw Error('TEST_MEDIA_REQUIRED');
    first.name = 'source-0.png';
    assert.equal(observedMediaUpload(f.effects, f.intent, f.manifest), null);
    first.name = f.manifest.files[0]?.name ?? null;
    first.ready = false;
    assert.equal(observedMediaUpload(f.effects, f.intent, f.manifest), null);
    first.ready = true;
    composer.media.reverse();
    if (format === 'multi-image')
      assert.equal(observedMediaUpload(f.effects, f.intent, f.manifest), null);
    composer.media.reverse();
    composer.uploaded = false;
    assert.equal(
      observedMediaUpload(f.effects, f.intent, f.manifest)?.format ?? null,
      format === 'video' ? null : format,
    );
    // Localized upload-summary text may be absent. The complete ordered decoded stage
    // cards, cleared input, original body and enabled action remain mandatory.
    composer.busy = true;
    assert.equal(observedMediaUpload(f.effects, f.intent, f.manifest), null);
  }
});

test('cleared video input requires decoded original bytes and an enabled next or submit action', () => {
  const f = fixture('video');
  const file = f.intent.snapshot.files[0]!;
  f.effects.composer = {
    text: f.intent.snapshot.text,
    uploaded: true,
    busy: false,
    submitEnabled: false,
    advanceEnabled: true,
    files: [],
    media: [
      {
        kind: 'video',
        name: null,
        ready: true,
        previewBytes: { source: 'owned-preview-blob', sha256: file.digest, size: file.bytes },
      },
    ],
  };
  const good = structuredClone(f.effects);
  assert.equal(observedMediaUpload(good, f.intent, f.manifest)?.format, 'video');
  const untranslatedSummary = structuredClone(good);
  untranslatedSummary.composer!.uploaded = false;
  assert.equal(observedMediaUpload(untranslatedSummary, f.intent, f.manifest)?.format, 'video');
  const mutations: Array<(c: NonNullable<PostEffects['composer']>) => void> = [
    (c) => {
      delete c.media[0]!.previewBytes;
    },
    (c) => {
      c.media[0]!.previewBytes!.sha256 = 'f'.repeat(64);
    },
    (c) => {
      c.media[0]!.previewBytes!.size++;
    },
    (c) => {
      c.media[0]!.ready = false;
    },
    (c) => {
      c.advanceEnabled = false;
    },
    (c) => {
      c.busy = true;
    },
    (c) => {
      c.text += 'changed';
    },
    (c) => {
      c.files = [{ name: 'different.mp4', size: file.bytes }];
    },
    (c) => {
      c.files = [{ name: f.manifest.files[0]!.name, size: file.bytes + 1 }];
    },
    (c) => {
      c.media.push(structuredClone(c.media[0]!));
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(good);
    mutate(changed.composer!);
    assert.equal(observedMediaUpload(changed, f.intent, f.manifest), null);
  }
  const submit = structuredClone(good);
  submit.composer!.advanceEnabled = false;
  submit.composer!.submitEnabled = true;
  assert.equal(observedMediaUpload(submit, f.intent, f.manifest)?.format, 'video');
  assert.equal(
    observedMediaUpload(good, f.intent, { ...f.manifest, attemptId: randomUUID() }),
    null,
  );
});

test('nameless decoded image previews require the complete original byte digests in order', () => {
  const f = fixture('multi-image');
  const composer: NonNullable<PostEffects['composer']> = {
    text: f.intent.snapshot.text,
    files: [],
    uploaded: false,
    busy: false,
    submitEnabled: true,
    media: f.intent.snapshot.files.map((file) => ({
      kind: 'image',
      name: null,
      ready: true,
      previewBytes: { source: 'owned-preview-blob', sha256: file.digest, size: file.bytes },
    })),
  };
  f.effects.composer = composer;
  assert.equal(observedMediaUpload(f.effects, f.intent, f.manifest)?.format, 'multi-image');
  const original = structuredClone(composer);
  const bad: NonNullable<PostEffects['composer']>[] = [];
  const swapped = structuredClone(original);
  swapped.media.reverse();
  bad.push(swapped);
  const wrongBytes = structuredClone(original);
  wrongBytes.media[0]!.previewBytes!.size++;
  bad.push(wrongBytes);
  const wrongHash = structuredClone(original);
  wrongHash.media[0]!.previewBytes!.sha256 = 'f'.repeat(64);
  bad.push(wrongHash);
  const missing = structuredClone(original);
  delete missing.media[0]!.previewBytes;
  bad.push(missing);
  const pending = structuredClone(original);
  pending.media[0]!.ready = false;
  bad.push(pending);
  const wrongInput = structuredClone(original);
  wrongInput.files = [{ name: 'unrelated.png', size: 1024 }];
  bad.push(wrongInput);
  const wrongText = structuredClone(original);
  wrongText.text += 'changed';
  bad.push(wrongText);
  const disabled = structuredClone(original);
  disabled.submitEnabled = false;
  bad.push(disabled);
  for (const value of bad) {
    f.effects.composer = value;
    assert.equal(observedMediaUpload(f.effects, f.intent, f.manifest), null);
  }
});
