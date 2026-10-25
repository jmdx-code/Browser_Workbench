import type { StoryPage } from '../shared/facebook-story.js';
import type { VideoTransfer } from '../shared/facebook-video-transfer.js';
import type { PostIntent } from '../shared/material-index.js';
import { sameExecution } from '../shared/task-execution.js';
import { sameTabProof } from './task-tabs.js';

// This merges private stage/transfer evidence with the current native editor.
// It does not replace DOM text with an invented observed caption.
export function withStoryVideoTransfer(
  story: StoryPage,
  transfer: VideoTransfer | null,
): StoryPage {
  if (!transfer || transfer.url !== story.url || transfer.timeOrigin !== story.timeOrigin)
    return story;
  const linked = { ...story, videoTransfer: transfer };
  if (
    !transfer.derivation ||
    !story.nativeVideoCanvas ||
    !story.ready ||
    !story.visible ||
    !story.nativeVideoControls?.enabled
  )
    return linked;
  return {
    ...linked,
    phase: 'media-editor',
    media: { kind: 'video', ready: true, bytes: transfer.bytes, sha256: transfer.digest },
    submit: story.nativeVideoControls,
  };
}
export function matchesDerivedStoryCaption(story: StoryPage, intent: PostIntent) {
  const transfer = story.videoTransfer,
    recipe = transfer?.derivation;
  const files = intent.snapshot.files.filter((file) => file.role !== 'text'),
    file = files[0];
  return (
    !!transfer &&
    !!recipe &&
    intent.snapshot.format === 'video' &&
    files.length === 1 &&
    file?.role === 'video' &&
    recipe.sourceSha256 === file.digest &&
    recipe.text === intent.snapshot.text &&
    transfer.attemptId === intent.attemptId &&
    transfer.fingerprint === intent.fingerprint &&
    sameExecution(transfer.binding, intent.context) &&
    sameTabProof(transfer.proof, intent.proof) &&
    transfer.digest === recipe.digest &&
    transfer.bytes === recipe.bytes &&
    transfer.receivedBytes === recipe.bytes &&
    transfer.url === story.url &&
    transfer.timeOrigin === story.timeOrigin &&
    story.nativeVideoCanvas === true &&
    story.phase === 'media-editor' &&
    story.media?.kind === 'video' &&
    story.media.ready &&
    story.media.sha256 === recipe.digest &&
    story.media.bytes === recipe.bytes
  );
}
