import type { BluestacksService } from './bluestacks-service.js';
import type { GoogleSheetsService } from './google-sheets-service.js';
import type { GroupBumperService } from './group-bumper-service.js';
import type { GroupInviterService } from './group-inviter-service.js';
import type { GroupPosterService } from './group-poster-service.js';
import type { TaskService } from './task-service.js';

export interface GlobalConcurrencyTargets {
  tasks?: TaskService | undefined;
  groupBumper?: GroupBumperService | undefined;
  groupPoster?: GroupPosterService | undefined;
  groupInviter?: GroupInviterService | undefined;
  bluestacks?: BluestacksService | undefined;
  googleSheets?: GoogleSheetsService | undefined;
}

export async function syncGlobalConcurrencyToModules(
  next: { browserConcurrency: number; bluestacksConcurrency: number },
  targets: GlobalConcurrencyTargets,
): Promise<void> {
  const browserCapForTasks = Math.max(1, Math.min(100, Math.round(next.browserConcurrency)));
  const browserCapForFeatures = Math.max(1, Math.min(50, Math.round(next.browserConcurrency)));
  const bluestacksCap = Math.max(1, Math.min(50, Math.round(next.bluestacksConcurrency)));

  targets.googleSheets?.syncMaxConcurrency(browserCapForTasks, bluestacksCap);

  await Promise.allSettled([
    (async () => {
      if (!targets.tasks) return;
      const cur = await targets.tasks.settings();
      if (cur.maxConcurrentProfiles !== browserCapForTasks) {
        await targets.tasks.setSettings({ maxConcurrentProfiles: browserCapForTasks });
      }
    })(),
    (async () => {
      if (!targets.groupBumper) return;
      await targets.groupBumper.syncMaxConcurrency(browserCapForFeatures);
    })(),
    (async () => {
      if (!targets.groupPoster) return;
      await targets.groupPoster.syncMaxConcurrency(browserCapForFeatures);
    })(),
    (async () => {
      if (!targets.groupInviter) return;
      const st = await targets.groupInviter.state();
      if (st.maxConcurrentProfiles !== browserCapForFeatures) {
        await targets.groupInviter.updateSettings({
          maxConcurrentProfiles: browserCapForFeatures,
        });
      }
    })(),
    (async () => {
      if (!targets.bluestacks) return;
      await targets.bluestacks.syncMaxConcurrency(bluestacksCap);
    })(),
  ]);
}
