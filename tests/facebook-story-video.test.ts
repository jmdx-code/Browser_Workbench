import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { StoryPage } from '../src/shared/facebook-story.js';
import type { VideoTransfer } from '../src/shared/facebook-video-transfer.js';
import {
  matchesDerivedStoryCaption,
  withStoryVideoTransfer,
} from '../src/domain/facebook-story-video.js';
import { matchesOriginalStoryMedia } from '../src/domain/facebook-story-media.js';
import { postFixture, postRequest, dispatchedPost } from './fixtures/material-post.js';
import { FacebookStoryComposerObserver } from '../src/infrastructure/facebook-story-composer-observer.js';

test('canvas readiness requires original transfer and full source/caption lineage; no DOM text is fabricated', async () => {
  await postFixture(async (store, _file, catalog) => {
    const request = await postRequest(store, catalog, {
      destination: 'story',
      audience: 'friends',
    });
    const intent = structuredClone((await store.materials.reserve(request)).intent);
    const operation = await dispatchedPost(store, request, 'OPEN_COMPOSER');
    intent.snapshot.format = 'video';
    intent.snapshot.files[0]!.role = 'video';
    const source = intent.snapshot.files[0]!;
    const story: StoryPage = {
      url: 'https://www.facebook.com/stories/create/',
      timeOrigin: 10,
      locale: 'en',
      ready: true,
      visible: true,
      phase: 'ambiguous',
      nativeVideoCanvas: true,
      nativeVideoControls: { css: '[role="button"][aria-label="Share to story"]', enabled: true },
      media: null,
      text: null,
      textCSS: null,
      mediaCSS: null,
      textEntry: null,
      submit: null,
      fontCSS: null,
      ai: null,
      privacy: {
        phase: 'CLOSED',
        draftSelection: null,
        openEnabled: true,
        friendsEnabled: false,
        saveEnabled: false,
        cancelEnabled: false,
      },
    };
    const transfer: VideoTransfer = {
      source: 'owned-video-upload-transfer',
      binding: operation.binding,
      proof: intent.proof,
      attemptId: intent.attemptId,
      stageId: randomUUID(),
      fingerprint: intent.fingerprint,
      digest: 'a'.repeat(64),
      bytes: 100,
      videoId: '123',
      timeOrigin: 10,
      url: story.url,
      receivedBytes: 100,
      derivation: {
        version: 1,
        kind: 'story-caption-video',
        text: intent.snapshot.text,
        sourceSha256: source.digest,
        textSha256: createHash('sha256').update(intent.snapshot.text).digest('hex'),
        captionSha256: 'b'.repeat(64),
        rendererVersion: 1,
        runtimeArchiveSha256: 'c'.repeat(64),
        digest: 'a'.repeat(64),
        bytes: 100,
        width: 720,
        height: 1280,
        duration: 6,
      },
    };
    const ready = withStoryVideoTransfer(story, transfer);
    assert.equal(ready.phase, 'media-editor');
    assert.equal(ready.text, null);
    assert.equal(matchesDerivedStoryCaption(ready, intent), true);
    assert.equal(matchesOriginalStoryMedia(ready, intent), true);
    assert.equal(
      withStoryVideoTransfer(
        { ...story, nativeVideoControls: { ...story.nativeVideoControls!, enabled: false } },
        transfer,
      ).phase,
      'ambiguous',
    );
    assert.equal(
      withStoryVideoTransfer(story, { ...transfer, derivation: undefined }).phase,
      'ambiguous',
    );
    for (const change of [
      { ...transfer, attemptId: randomUUID() },
      { ...transfer, receivedBytes: 99 },
      { ...transfer, binding: { ...transfer.binding, accountId: 'other' } },
      { ...transfer, derivation: { ...transfer.derivation!, text: 'changed caption' } },
      { ...transfer, derivation: { ...transfer.derivation!, sourceSha256: 'd'.repeat(64) } },
      { ...transfer, proof: { ...transfer.proof, targetId: 'other' } },
    ])
      assert.equal(
        matchesDerivedStoryCaption(withStoryVideoTransfer(story, change), intent),
        false,
      );
    const observer = new FacebookStoryComposerObserver(async () => ready);
    const action = {
      kind: 'click' as const,
      tabId: intent.proof.tabId,
      documentEpoch: 0,
      routeEpoch: 0,
      target: { css: ready.submit!.css },
    };
    const post = {
      intent,
      link: {
        ...(await store.materialPosts.link(operation.binding.operationId)),
        purpose: 'SUBMIT' as const,
        action,
      },
    };
    await observer.assert({} as never, action, post, () => {});
    await assert.rejects(
      observer.assert(
        {} as never,
        action,
        { ...post, intent: { ...intent, snapshot: { ...intent.snapshot, text: 'changed' } } },
        () => {},
      ),
      /UNCONFIRMED/,
    );
  }, false);
});
