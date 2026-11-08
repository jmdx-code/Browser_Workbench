import type { Dialog, Page } from 'playwright-core';
import type { Awaitable } from '../domain/persistence.js';
import { isEmptyStoryEditor } from '../domain/facebook-story-preparation.js';
import { readFacebookStoryPage } from './facebook-story-page-reader.js';
import { missingFacebookDefaultContext } from './facebook-task-document-ready.js';

// Used only within the original PREPARE_STORY operation after the previous
// attempt's NOT_PUBLISHED and exact retained-page proof have been checked.
export async function restartEmptyStoryPage(
  page: Page,
  navigate: () => Promise<void>,
  guard: () => Awaitable<void>,
  dialogScope: (active: boolean) => void,
) {
  const before = await readFacebookStoryPage(page, guard);
  if (!isEmptyStoryEditor(before)) throw Error('STORY_FOREIGN_DRAFT');
  await guard();
  let failure: unknown;
  const pending = new Set<Promise<void>>();
  const onDialog = (dialog: Dialog) => {
    if (dialog.type() !== 'beforeunload') return;
    const work = (async () => {
      await guard();
      await dialog.accept();
    })().catch((error: unknown) => {
      failure = error;
    });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };
  page.on('dialog', onDialog);
  dialogScope(true);
  try {
    await navigate();
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      await guard();
      if (failure) throw failure;
      try {
        const current = await readFacebookStoryPage(page, guard);
        if (current.timeOrigin !== before.timeOrigin && current.ready && current.phase === 'entry')
          return;
      } catch (error) {
        if (!missingFacebookDefaultContext(error)) throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw Error('STORY_RESTART_UNCONFIRMED');
  } finally {
    page.off('dialog', onDialog);
    await Promise.all(pending);
    dialogScope(false);
  }
}
