import type { BluestacksService } from './bluestacks-service.js';
import type { GoogleSheetsService } from './google-sheets-service.js';
import type { GroupBumperService } from './group-bumper-service.js';
import type { GroupInviterService } from './group-inviter-service.js';
import type { GroupPosterService } from './group-poster-service.js';
import type { TaskService } from './task-service.js';
import type { Workboard } from './workboard.js';

export interface GlobalConcurrencyTargets {
  workboard?: Workboard | undefined;
  tasks?: TaskService | undefined;
  groupBumper?: GroupBumperService | undefined;
  groupPoster?: GroupPosterService | undefined;
  groupInviter?: GroupInviterService | undefined;
  bluestacks?: BluestacksService | undefined;
  googleSheets?: GoogleSheetsService | undefined;
}

const clamp = (n: number, max: number) => Math.max(1, Math.min(max, Math.round(n)));

export async function syncGlobalConcurrencyToModules(
  next: { browserConcurrency: number; bluestacksConcurrency: number },
  targets: GlobalConcurrencyTargets,
): Promise<void> {
  const browserTasks = clamp(next.browserConcurrency, 100);
  const browserFeatures = clamp(next.browserConcurrency, 50);
  const bsCap = clamp(next.bluestacksConcurrency, 50);

  targets.workboard?.browserPermits.setLimit(browserTasks);
  targets.workboard?.bluestacksPermits.setLimit(bsCap);
  targets.googleSheets?.syncMaxConcurrency(browserTasks, bsCap);

  await Promise.allSettled([
    targets.tasks &&
      targets.tasks.settings().then((cur) => {
        if (cur.maxConcurrentProfiles !== browserTasks)
          return targets.tasks?.setSettings({ maxConcurrentProfiles: browserTasks });
      }),
    targets.groupBumper?.syncMaxConcurrency(browserFeatures),
    targets.groupPoster?.syncMaxConcurrency(browserFeatures),
    targets.groupInviter &&
      targets.groupInviter.state().then((st) => {
        if (st.maxConcurrentProfiles !== browserFeatures)
          return targets.groupInviter?.updateSettings({ maxConcurrentProfiles: browserFeatures });
      }),
    targets.bluestacks?.syncMaxConcurrency(bsCap),
  ]);
}
