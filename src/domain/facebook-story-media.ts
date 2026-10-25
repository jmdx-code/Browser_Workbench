import type { StoryPage } from '../shared/facebook-story.js';
import type { PostIntent } from '../shared/material-index.js';
import { matchesDerivedStoryCaption } from './facebook-story-video.js';

export function matchesOriginalStoryMedia(story: StoryPage, intent: PostIntent) {
  if (matchesDerivedStoryCaption(story, intent)) return true;
  const files = intent.snapshot.files.filter((file) => file.role !== 'text');
  const file = files.length === 1 ? files[0] : null;
  const kind =
    intent.snapshot.format === 'single-image'
      ? 'image'
      : intent.snapshot.format === 'video'
        ? 'video'
        : null;
  return (
    !!kind &&
    !!file &&
    file.role === kind &&
    story.phase === 'media-editor' &&
    story.media?.kind === kind &&
    story.media.ready &&
    story.media.bytes === file.bytes &&
    story.media.sha256 === file.digest
  );
}
