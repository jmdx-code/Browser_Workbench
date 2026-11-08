import type { StoryPage } from '../shared/facebook-story.js';

// An empty editor is not enough to grant recovery: the caller must also check
// the previous, ended attempt and the exact retained page in the repository.
export function isEmptyStoryEditor(story: StoryPage | undefined): boolean {
  return Boolean(
    story?.ready &&
    story.visible &&
    story.phase === 'text-editor' &&
    story.text === '' &&
    !story.media &&
    !story.hasSelectedMedia &&
    !story.nativeVideoCanvas &&
    !story.nativeVideoInput &&
    !story.videoTransfer &&
    (story.privacy?.phase === 'CLOSED' ||
      (story.privacy?.phase === 'MENU' && story.privacy.draftSelection !== null)),
  );
}
