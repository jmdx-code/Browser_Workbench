import type { FeatureExecutionRegistry } from '../application/feature-execution-registry.js';
import type { GoogleSheetsService } from '../application/google-sheets-service.js';
export interface DesktopHostingMonitorDeps {
  isShuttingDown: () => boolean;
  getFeatureExecution: () => FeatureExecutionRegistry | undefined;
  getGoogleSheets: () => GoogleSheetsService | undefined;
  listAutoSchedules: () =>
    ReadonlyArray<{ enabled: boolean }> | Promise<ReadonlyArray<{ enabled: boolean }>>;
  isPreventSystemSleepEnabled?: () => boolean | Promise<boolean>;
  postMessage: (msg: {
    type: 'SET_HOSTING_STATUS';
    runningCount: number;
    autoMonitorCount: number;
    keepAwake: boolean;
    summary: string;
  }) => void;
}
/**
 * Periodically computes active task & auto-monitor hosting state and notifies Electron main
 * for unified powerSaveBlocker management, tray tooltip updates, and close-window guards.
 */
export function startDesktopHostingMonitor(deps: DesktopHostingMonitorDeps): () => void {
  let lastKey = '';
  let inFlight = false;
  let stopped = false;
  const tick = () => {
    if (stopped || inFlight || deps.isShuttingDown()) return;
    inFlight = true;
    void (async () => {
      try {
        const parts: string[] = [];
        const activeLabels = (await deps.getFeatureExecution()?.activeModuleLabels()) ?? [];
        const runningCount = activeLabels.length;
        if (activeLabels.length > 0) {
          parts.push(`运行中：${activeLabels.slice(0, 2).join('、')}`);
        }
        const monitors = (await deps.getGoogleSheets()?.countEnabledMonitors()) ?? {
          scheduleEnabled: 0,
          recordsEnabled: 0,
        };
        const enabledScheds = (await Promise.resolve(deps.listAutoSchedules())).filter(
          (s) => s.enabled,
        ).length;
        const allowScheduleKeepAwake = deps.isPreventSystemSleepEnabled
          ? await Promise.resolve(deps.isPreventSystemSleepEnabled()).catch(() => true)
          : true;
        const autoMonitorCount = monitors.scheduleEnabled + monitors.recordsEnabled + enabledScheds;
        const keepAwake =
          runningCount > 0 ||
          monitors.scheduleEnabled > 0 ||
          monitors.recordsEnabled > 0 ||
          (enabledScheds > 0 && allowScheduleKeepAwake);
        if (monitors.scheduleEnabled > 0) parts.push(`自动发帖 ${monitors.scheduleEnabled} 表`);
        if (monitors.recordsEnabled > 0) parts.push(`自动顶贴 ${monitors.recordsEnabled} 表`);
        if (enabledScheds > 0) parts.push(`定时排班 ${enabledScheds} 项`);
        const summary = parts.join(' · ');
        const key = `${runningCount}:${autoMonitorCount}:${keepAwake ? 1 : 0}:${summary}`;
        if (!stopped && !deps.isShuttingDown() && key !== lastKey) {
          lastKey = key;
          deps.postMessage({
            type: 'SET_HOSTING_STATUS',
            runningCount,
            autoMonitorCount,
            keepAwake,
            summary,
          });
        }
      } catch {
      } finally {
        inFlight = false;
      }
    })();
  };
  const initial = setTimeout(tick, 1500);
  initial.unref?.();
  const interval = setInterval(tick, 4000);
  interval.unref?.();
  return () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(interval);
  };
}
