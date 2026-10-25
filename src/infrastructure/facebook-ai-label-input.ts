import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import type { Action } from '../shared/browser-actions.js';
import type { FacebookPostOriginal } from '../domain/facebook-post-execution.js';
import {
  aiLabelTarget,
  postAILabelPurposes,
  type AILabelSetting,
} from '../shared/facebook-ai-label.js';
import { readFacebookAILabel } from './facebook-ai-label-reader.js';

export async function assertFacebookAILabelInput(
  page: Page,
  action: Action,
  original: { link: Pick<FacebookPostOriginal['link'], 'purpose'> },
  setting: AILabelSetting,
  guard: () => Awaitable<void>,
) {
  const purpose = original.link.purpose;
  const aiPurpose = postAILabelPurposes.find((value) => value === purpose);
  if (
    !aiPurpose &&
    !['SET_TEXT', 'PREPARE_MEDIA', 'UPLOAD_MEDIA', 'ADVANCE_COMPOSER', 'SUBMIT'].includes(purpose)
  )
    return false;
  if (setting === 'preserve-current') {
    if (aiPurpose) throw Error('POST_AI_LABEL_STEP_REQUIRED');
    return false;
  }
  const reading = await readFacebookAILabel(page, guard);
  await guard();
  const wanted = setting === 'on';
  if (!reading.ready || !reading.visible || reading.url !== page.url())
    throw Error('POST_AI_LABEL_DOCUMENT_CHANGED');
  if (!aiPurpose) {
    if (reading.phase !== 'composer' || reading.value !== wanted)
      throw Error('POST_AI_LABEL_UNCONFIRMED_BEFORE_CONTENT');
    return false;
  }
  const valid =
    aiPurpose === 'OPEN_AI_LABEL'
      ? reading.phase === 'composer' && reading.value !== wanted && !!reading.openCSS
      : reading.phase === 'settings' &&
        (aiPurpose === 'SET_AI_LABEL'
          ? reading.value !== wanted && reading.switchEnabled
          : reading.value === wanted && reading.confirmEnabled);
  const target = aiLabelTarget(aiPurpose, reading);
  if (
    !valid ||
    action.kind !== 'click' ||
    action.target.scope !== target.scope ||
    action.target.css !== target.css ||
    action.target.text !== ('text' in target ? target.text : undefined)
  )
    throw Error('POST_AI_LABEL_ACTION_UNCONFIRMED');
  return true;
}
