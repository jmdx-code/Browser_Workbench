import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesOriginalStoryMedia } from '../src/domain/facebook-story-media.js';
import type { PostIntent } from '../src/shared/material-index.js';
import type { StoryPage } from '../src/shared/facebook-story.js';

test('story media readiness requires the decoded original Blob bytes, role and exactly one immutable source', () => {
  for (const kind of ['image', 'video'] as const) {
    const intent = {
      snapshot: {
        format: kind === 'image' ? 'single-image' : 'video',
        files: [{ role: kind, digest: 'a'.repeat(64), bytes: 100 }],
      },
    } as unknown as PostIntent;
    const page = {
      phase: 'media-editor',
      media: { kind, ready: true, bytes: 100, sha256: 'a'.repeat(64) },
    } as StoryPage;
    assert.equal(matchesOriginalStoryMedia(page, intent), true);
    for (const change of [
      { ready: false },
      { bytes: null },
      { bytes: 101 },
      { sha256: null },
      { sha256: 'b'.repeat(64) },
      { kind: kind === 'image' ? 'video' : 'image' },
    ])
      assert.equal(
        matchesOriginalStoryMedia(
          { ...page, media: { ...page.media!, ...change } } as StoryPage,
          intent,
        ),
        false,
      );
    assert.equal(matchesOriginalStoryMedia({ ...page, phase: 'entry' }, intent), false);
    const duplicate = structuredClone(intent);
    duplicate.snapshot.files.push(structuredClone(duplicate.snapshot.files[0]!));
    assert.equal(matchesOriginalStoryMedia(page, duplicate), false);
  }
});
