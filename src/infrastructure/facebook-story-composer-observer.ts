import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import type { FacebookPostComposerObserver } from './facebook-composer-observer.js';
import type { Action } from '../shared/browser-actions.js';
import type { PostIntent } from '../shared/material-index.js';
import type { PostLink } from '../shared/material-post.js';
import { validatePostAction } from '../domain/material-post.js';
import { storyPrivacyTargets } from '../shared/facebook-story-privacy.js';
import { readFacebookStoryPage } from './facebook-story-page-reader.js';
import { readFacebookHomePreparation } from './facebook-home-preparation.js';
import { matchesOriginalStoryMedia } from '../domain/facebook-story-media.js';
import { matchesDerivedStoryCaption } from '../domain/facebook-story-video.js';
import { storyMediaTextFinish } from '../shared/facebook-story.js';

export class FacebookStoryComposerObserver implements FacebookPostComposerObserver {
  constructor(private readonly read = readFacebookStoryPage) {}
  async assert(
    page: Page,
    action: Action,
    post: { intent: PostIntent; link: PostLink },
    guard: () => Awaitable<void>,
  ) {
    await guard();
    validatePostAction(post.intent, post.link.purpose, action);
    const media = post.intent.snapshot.format !== 'text';
    if (media && !['single-image', 'video'].includes(post.intent.snapshot.format))
      throw Error('STORY_SINGLE_MEDIA_FORMAT_REQUIRED');
    if (post.link.purpose === 'PREPARE_STORY') {
      const home = await readFacebookHomePreparation(page, guard);
      await guard();
      if (!home.safe) throw Error('STORY_PREPARATION_BLOCKED');
      return;
    }
    const story = await this.read(page, guard);
    await guard();
    if (!story.ready || !story.visible || story.phase === 'ambiguous')
      throw Error('STORY_EDITOR_NOT_READY');
    const purpose = post.link.purpose;
    const empty = media
      ? story.phase === 'entry' && story.text === null
      : story.phase === 'text-editor' && story.text === '';
    let target: { scope?: string; css: string; text?: string } | null = null;
    if (
      media &&
      empty &&
      purpose === 'UPLOAD_MEDIA' &&
      story.privacy?.phase === 'CLOSED' &&
      story.mediaCSS
    )
      target = { css: story.mediaCSS };
    else if (
      !media &&
      purpose === 'OPEN_COMPOSER' &&
      story.phase === 'entry' &&
      story.textEntry?.enabled
    )
      target = { css: story.textEntry.css };
    else if (
      empty &&
      story.privacy?.phase === 'CLOSED' &&
      story.privacy.openEnabled &&
      (purpose === 'OPEN_AUDIENCE' || purpose === 'VERIFY_AUDIENCE')
    )
      target = storyPrivacyTargets.open;
    else if (empty && story.privacy?.phase === 'MENU') {
      if (
        purpose === 'SELECT_FRIENDS' &&
        story.privacy.draftSelection !== null &&
        story.privacy.friendsEnabled
      )
        target = storyPrivacyTargets.selectFriends;
      else if (story.privacy.draftSelection === 'FRIENDS') {
        if (purpose === 'CONFIRM_AUDIENCE' && story.privacy.saveEnabled)
          target = storyPrivacyTargets.save;
        if (purpose === 'CLOSE_AUDIENCE' && story.privacy.cancelEnabled)
          target = storyPrivacyTargets.close;
      }
    } else if (
      empty &&
      story.privacy?.phase === 'CHANGE_CONFIRMATION' &&
      purpose === 'CONFIRM_AUDIENCE' &&
      story.privacy.saveEnabled
    ) {
      target = storyPrivacyTargets.saveChange;
    } else if (story.phase === 'text-editor' && story.privacy?.phase === 'CLOSED') {
      if (
        purpose === 'SET_TEXT' &&
        story.textCSS &&
        (story.text === '' || story.text === post.intent.snapshot.text)
      )
        target = { css: story.textCSS };
      if (purpose === 'SUBMIT' && story.text === post.intent.snapshot.text && story.submit?.enabled)
        target = { css: story.submit.css };
    }
    if (
      media &&
      story.phase === 'media-editor' &&
      story.privacy?.phase === 'CLOSED' &&
      matchesOriginalStoryMedia(story, post.intent)
    ) {
      if (
        purpose === 'OPEN_COMPOSER' &&
        story.text === '' &&
        !story.textEditing &&
        story.addText?.enabled
      )
        target = { css: story.addText.css, text: story.addText.text };
      if (
        purpose === 'SET_TEXT' &&
        story.textEditing &&
        story.textCSS &&
        (story.text === '' || story.text === post.intent.snapshot.text)
      )
        target = { css: story.textCSS };
      if (purpose === 'ADVANCE_COMPOSER' && story.text === post.intent.snapshot.text)
        target = storyMediaTextFinish;
      if (
        purpose === 'SUBMIT' &&
        !story.textEditing &&
        (story.text === post.intent.snapshot.text ||
          matchesDerivedStoryCaption(story, post.intent)) &&
        story.submit?.enabled
      )
        target = { css: story.submit.css };
    }
    if (
      !target ||
      !('target' in action) ||
      action.target.scope !== target.scope ||
      action.target.css !== target.css ||
      action.target.text !== target.text
    )
      throw Error('STORY_COMPOSER_ACTION_UNCONFIRMED');
  }
}
