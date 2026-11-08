import type { StoryPage } from '../shared/facebook-story.js';
import type { PostIntent } from '../shared/material-index.js';
import { matchesDerivedStoryCaption } from './facebook-story-video.js';
import { sameExecution } from '../shared/task-execution.js';
import { sameTabProof } from './task-tabs.js';

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
  const transfer = story.videoTransfer;
  if (
    transfer &&
    (!sameExecution(transfer.binding, intent.context) ||
      !sameTabProof(transfer.proof, intent.proof) ||
      transfer.attemptId !== intent.attemptId ||
      transfer.fingerprint !== intent.fingerprint ||
      transfer.digest !== file?.digest ||
      transfer.bytes !== file?.bytes ||
      transfer.receivedBytes !== file?.bytes)
  )
    return false;
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
