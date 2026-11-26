import { access } from 'node:fs/promises';
import type http from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GlobalAccountAbnormalReporter } from './application/account-abnormal-reporter.js';
import type { AutoSchedulerService } from './application/auto-scheduler-service.js';
import type { BluestacksService } from './application/bluestacks-service.js';
import type { DataCleanupService } from './application/data-cleanup.js';
import type { FeatureExecutionRegistry } from './application/feature-execution-registry.js';
import type { GoogleSheetsService } from './application/google-sheets-service.js';
import type { GroupBumperService } from './application/group-bumper-service.js';
import type { GroupInviterService } from './application/group-inviter-service.js';
import type { GroupPosterService } from './application/group-poster-service.js';
import type { ProfileInspectionService } from './application/profile-inspection.js';
import { TaskNotificationMonitor } from './application/task-notification-monitor.js';
import type { WindowLayoutService } from './application/window-layout.js';
import { Workboard } from './application/workboard.js';
import type { WorkspaceBackupService } from './application/workspace-backup-service.js';
import { WorkspaceEventHub } from './application/workspace-event-hub.js';
import { workspaceApi } from './http/workspace-api.js';
import { startBridgeServer } from './bridge/server.js';
import type { ActiveAccountRuntime } from './infrastructure/active-account-runtime.js';
import { syncProductAiWorkspaceDirectory } from './infrastructure/ai-workspace.js';
import type { WindowsOcrClient } from './infrastructure/bluestacks-vision.js';
import { releaseControllerPort, reserveControllerPort } from './infrastructure/controller-port.js';
import { startDesktopHostingMonitor } from './infrastructure/desktop-hosting-monitor.js';
import { DevDiagnosticsFileWriter } from './infrastructure/dev-diagnostics-writer.js';
import type { ExtensionUpdates } from './infrastructure/extension-updates.js';
import { GraphAvatar } from './infrastructure/graph-avatar.js';
import { scheduleStartupAccountAvatarLocalization } from './infrastructure/group-bumper-avatar.js';
import type { KernelBridge } from './infrastructure/kernel-bridge.js';
import { LocalBrowserLabels } from './infrastructure/local-browser-labels.js';
import type { AgentBrowserManager } from './infrastructure/mcp/agent-browser-manager.js';
import {
  canonicalDataDirectory,
  productDataDirectory,
  syncProductExtensionDirectory,
} from './infrastructure/paths.js';
import { PersistenceClient } from './infrastructure/persistence-client.js';
import type { WorkspaceStorePort as WorkspaceStore } from './infrastructure/persistence-port.js';
import { FilesystemRuntimeLog } from './infrastructure/runtime-log.js';
import { loadServerConfig } from './infrastructure/server-config.js';
import { buildServerKernelHooks } from './infrastructure/server-kernel-wiring.js';
import { buildServerAppRoutes } from './infrastructure/server-routes-wiring.js';
import { runBoundedServerShutdown } from './infrastructure/server-shutdown.js';
import { applyPendingWorkspaceReset } from './infrastructure/workspace-reset.js';
import {
  applyPendingWorkspaceRestore,
  FilesystemWorkspaceRestore,
} from './infrastructure/workspace-restore.js';
import { devDiag } from './shared/dev-diagnostics.js';
import type { ProfileLifecyclePort } from './shared/profile-lifecycle.js';
import { LayoutDisplays } from './shared/window-layout.js';

const controllerLoopDelay = monitorEventLoopDelay({ resolution: 20 });
controllerLoopDelay.enable();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
const extensionSources = [
  path.join(root, 'extension-build'),
  ...(resourcesPath ? [path.join(resourcesPath, 'extension')] : []),
];
let extensionSource: string | undefined;
for (const candidate of extensionSources) {
  try {
    await access(path.join(candidate, 'manifest.json'));
    extensionSource = candidate;
    break;
  } catch {}
}
if (!extensionSource) throw Error('BUNDLED_EXTENSION_MISSING');
const bundledExtension = await syncProductExtensionDirectory(extensionSource);
const { softwareVersion, identity, executionAcceptance } = await loadServerConfig(root);
if (
  Boolean(process.env.WORKBENCH_AI_WORKSPACE_DIR?.trim()) ||
  (!process.env.WORKBENCH_SMOKE_OUT && !process.env.BRIDGE_TEST_DATA_DIR)
) {
  await syncProductAiWorkspaceDirectory({ rootDir: root, softwareVersion }).catch(
    (err: unknown) => {
      devDiag.record({
        level: 'WARN',
        category: 'SYSTEM',
        event: 'AI_WORKSPACE_SYNC_FAILED',
        reason: err instanceof Error ? err.message : 'SYNC_FAILED',
      });
    },
  );
}

let layoutDisplays = LayoutDisplays.parse(JSON.parse(process.env.WORKBENCH_DISPLAYS ?? '[]'));
const dataDir = await canonicalDataDirectory(
  process.env.WORKBENCH_DATA_DIR ?? process.env.BRIDGE_TEST_DATA_DIR ?? productDataDirectory(),
);
await applyPendingWorkspaceReset(dataDir);
const uploadCacheRoot = await canonicalDataDirectory(path.join(dataDir, 'upload-cache'));
const runtimeLog = new FilesystemRuntimeLog(path.join(dataDir, 'logs'));
const devDiagWriter = new DevDiagnosticsFileWriter(path.join(dataDir, 'logs'));
devDiagWriter.install();
const browserLabels = new LocalBrowserLabels([
  identity.extensionId,
  ...(identity.legacyExtensionId ? [identity.legacyExtensionId] : []),
]);
const graphAvatar = new GraphAvatar(() => process.env.WORKBENCH_GRAPH_AVATAR_TOKEN);
const port = Number(process.env.WORKBENCH_PORT ?? process.env.BRIDGE_TEST_PORT ?? 18767);
const binding = await reserveControllerPort(port);

let repository: WorkspaceStore;
let persistence: PersistenceClient;
let restoreRequested = false;
try {
  restoreRequested = (await new FilesystemWorkspaceRestore(dataDir).status()).state === 'READY';
  await applyPendingWorkspaceRestore(dataDir, softwareVersion);
  persistence = await PersistenceClient.open(dataDir, (completed, total) => {
    process.parentPort?.postMessage({ type: 'STARTUP_PROGRESS', completed, total });
  });
  repository = persistence.workspace;
  const diagnosticNames = new Map<string, string>();
  const diagnosticAliases = new Map<string, string>();
  persistence.observeResults((route: string, value: unknown) => {
    const target =
      route === 'workspace.profileAccountCache'
        ? diagnosticNames
        : route === 'workspace.profileMetadata'
          ? diagnosticAliases
          : null;
    if (!target || !(value instanceof Map)) return;
    target.clear();
    for (const [id, row] of value as Map<unknown, unknown>) {
      if (typeof id !== 'string' || !row || typeof row !== 'object') continue;
      const label =
        route === 'workspace.profileAccountCache' && 'name' in row
          ? row.name
          : 'alias' in row
            ? row.alias
            : null;
      if (typeof label === 'string' && label.trim()) target.set(id, label.trim());
    }
  });
  await repository.profileAccountCache();
  await repository.profileMetadata();
  devDiag.setProfileNameResolver(
    (profileId) =>
      diagnosticAliases.get(profileId) ||
      browserLabels.name(profileId)?.trim() ||
      diagnosticNames.get(profileId),
  );
} catch (error) {
  await releaseControllerPort(binding.server);
  throw error;
}

const workboard = new Workboard();
const eventHub = new WorkspaceEventHub();
let shuttingDown = false;
let windowLayout: WindowLayoutService | undefined;
let mainKernel: KernelBridge | undefined;
let inspection: ProfileInspectionService | undefined;
let activeRuntime: ActiveAccountRuntime | undefined;
let profileLifecycleRef: ProfileLifecyclePort | undefined;
let accountAbnormalReporterRef: GlobalAccountAbnormalReporter | undefined;
let extensionUpdates: ExtensionUpdates | undefined;
let softwareUpdateRef: ReturnType<typeof Object> | undefined;
let backups: WorkspaceBackupService | undefined;
let dataCleanup: DataCleanupService | undefined;
let bluestacksOcrClient: WindowsOcrClient | undefined;
let bluestacksServiceRef: BluestacksService | undefined;
let groupBumperServiceRef: GroupBumperService | undefined;
let groupPosterServiceRef: GroupPosterService | undefined;
let groupInviterServiceRef: GroupInviterService | undefined;
let autoSchedulerServiceRef: AutoSchedulerService | undefined;
let googleSheetsServiceRef: GoogleSheetsService | undefined;
let scheduleOfflineHygieneRef: ((profileId: string) => void) | undefined;
let featureExecutionRef: FeatureExecutionRegistry | undefined;
let agentBrowserManagerRef: AgentBrowserManager | undefined;
let autoInspectSweepRef: (() => Promise<void>) | undefined;
let mcpHttpHandler:
  ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>) | undefined;

let bridge: Awaited<ReturnType<typeof startBridgeServer>>;
try {
  await repository.tasks.recoverOnStartup(!restoreRequested);
  bridge = await startBridgeServer({
    extensionIdle: async (peer) => {
      try {
        await extensionUpdates?.automatic(peer);
      } catch (error) {
        devDiag.record({
          level: 'WARN',
          category: 'BRIDGE_WS',
          event: 'EXTENSION_AUTO_RELOAD_FAILED',
          profileId: peer.profileId,
          reason: error instanceof Error ? error.message : 'RELOAD_FAILED',
        });
      }
    },
    store: persistence.bridge,
    root,
    dataDir,
    port,
    boundServer: binding,
    onClose: () => eventHub.close(),
    mcpHandler: (req, res) => (mcpHttpHandler ? mcpHttpHandler(req, res) : Promise.resolve(false)),
    autoRecoverConnections: process.env.WORKBENCH_DIAGNOSTICS !== '1',
    connectionRecoveryAllowed:
      process.env.WORKBENCH_DIAGNOSTICS === '1'
        ? undefined
        : async (profileId) =>
            !(await repository.tasks.hasProfilePlanInStates(profileId, ['QUEUED', 'RUNNING'])),
    diagnosticsEnabled: process.env.WORKBENCH_DIAGNOSTICS === '1',
    kernelHooks:
      port === 18767 || process.env.WORKBENCH_SMOKE_WINDOW_LAYOUT === '1'
        ? ({ core }) =>
            buildServerKernelHooks({
              core,
              repository,
              persistence,
              workboard,
              browserLabels,
              graphAvatar,
              dataDir,
              uploadCacheRoot,
              executionAcceptance,
              eventHub,
              refs: {
                getLayoutDisplays: () => layoutDisplays,
                setWindowLayout: (v) => {
                  windowLayout = v;
                },
                setMainKernel: (v) => {
                  mainKernel = v;
                },
                setInspection: (v) => {
                  inspection = v;
                },
                getInspection: () => inspection,
                setActiveRuntime: (v) => {
                  activeRuntime = v;
                },
                getActiveRuntime: () => activeRuntime,
                getProfileLifecycle: () => profileLifecycleRef,
                getAccountAbnormalReporter: () => accountAbnormalReporterRef,
                getExtensionUpdates: () => extensionUpdates,
                getFeatureExecution: () => featureExecutionRef,
                getDataCleanup: () => dataCleanup,
                getBackups: () => backups,
                getSoftwareUpdate: () => softwareUpdateRef as never,
                getScheduleOfflineHygiene: () => scheduleOfflineHygieneRef,
              },
            })
        : undefined,
    extensionIds: process.env.BRIDGE_ALLOWED_EXTENSION_ID
      ? [process.env.BRIDGE_ALLOWED_EXTENSION_ID]
      : [identity.extensionId, 'penkjbecaaekdcpbpcfjekhikhjhoaai'],
    appRoutes: ({ core, store }) => {
      const wiredRoutes = buildServerAppRoutes({
        root,
        dataDir,
        uploadCacheRoot,
        port,
        softwareVersion,
        bundledExtensionVersion: bundledExtension.version,
        core,
        store,
        repository,
        persistence,
        workboard,
        browserLabels,
        runtimeLog,
        devDiagWriter,
        controllerLoopDelay,
        eventHub,
        refs: {
          getShuttingDown: () => shuttingDown,
          getInspection: () => inspection,
          getMainKernel: () => mainKernel,
          getActiveRuntime: () => activeRuntime,
          getWindowLayout: () => windowLayout,
          setExtensionUpdates: (v) => {
            extensionUpdates = v;
          },
          getExtensionUpdates: () => extensionUpdates,
          setSoftwareUpdate: (v) => {
            softwareUpdateRef = v;
          },
          getSoftwareUpdate: () => softwareUpdateRef as never,
          setBackups: (v) => {
            backups = v;
          },
          getBackups: () => backups,
          setDataCleanup: (v) => {
            dataCleanup = v;
          },
          getDataCleanup: () => dataCleanup,
          setFeatureExecution: (v) => {
            featureExecutionRef = v;
          },
          setAccountAbnormalReporter: (v) => {
            accountAbnormalReporterRef = v;
          },
          setProfileLifecycle: (v) => {
            profileLifecycleRef = v;
          },
          setScheduleOfflineHygiene: (fn) => {
            scheduleOfflineHygieneRef = fn;
          },
          setAutoInspectSweep: (fn) => {
            autoInspectSweepRef = fn;
          },
          setBluestacksOcrClient: (v) => {
            bluestacksOcrClient = v;
          },
          setBluestacksService: (v) => {
            bluestacksServiceRef = v;
          },
          setGroupBumperService: (v) => {
            groupBumperServiceRef = v;
          },
          setGroupPosterService: (v) => {
            groupPosterServiceRef = v;
          },
          setGroupInviterService: (v) => {
            groupInviterServiceRef = v;
          },
          setAutoSchedulerService: (v) => {
            autoSchedulerServiceRef = v;
          },
          getAutoSchedulerService: () => autoSchedulerServiceRef,
          setGoogleSheetsService: (v) => {
            googleSheetsServiceRef = v;
          },
          getGoogleSheetsService: () => googleSheetsServiceRef,
          setAgentBrowserManager: (v) => {
            agentBrowserManagerRef = v;
          },
          setMcpHttpHandler: (h) => {
            mcpHttpHandler = h;
          },
        },
      });
      return wiredRoutes.wrapHandler(workspaceApi(...wiredRoutes.apiArgs));
    },
  });
  await autoSchedulerServiceRef?.start();
  googleSheetsServiceRef?.start();
  eventHub.startDigestMonitor(async () => {
    const activeIds = (await featureExecutionRef?.activeModuleIds()) ?? [];
    const peerSig = [...bridge.core.peers.values()]
      .map((p) => `${p.profileId}:${p.online}:${p.phase}:${p.synced}:${p.browserWindowCount ?? 0}`)
      .sort()
      .join('|');
    const plansSig = (await repository.tasks.livePlans())
      .map((p) => `${p.id}:${p.state}:${p.position}:${p.round}`)
      .join('|');
    const todaySig = JSON.stringify(await repository.postBumpRecords.todayStats());
    const activeSig = [...activeIds].sort().join(',');
    return {
      workspace: peerSig,
      'runtime-summary': activeSig,
      tasks: plansSig,
      ...(activeIds.includes('group-bumper') || activeIds.includes('page-bumper')
        ? { 'group-bumper': `${activeSig}:${todaySig}` }
        : {}),
      ...(activeIds.includes('group-poster') ? { 'group-poster': `${activeSig}:${todaySig}` } : {}),
      ...(activeIds.includes('group-inviter') ? { 'group-inviter': activeSig } : {}),
      ...(activeIds.some((id) => id.startsWith('bluestacks-'))
        ? { bluestacks: `${activeSig}:${todaySig}` }
        : {}),
      ...(activeIds.includes('auto-scheduler') ? { 'auto-scheduler': activeSig } : {}),
      ...(activeIds.includes('google-sheets')
        ? { 'google-sheets': `${activeSig}:${todaySig}` }
        : {}),
    };
  }, 1000);
} catch (error) {
  eventHub.close();
  await persistence.close();
  await releaseControllerPort(binding.server);
  throw error;
}

const notifications = await TaskNotificationMonitor.open(
  repository,
  async () => await repository.preferences(),
  (value) => process.parentPort?.postMessage(value),
  async (events) => {
    void runtimeLog
      .append(
        events.map((event) => ({
          version: 1 as const,
          observedAt: new Date().toISOString(),
          sequence: event.sequence,
          event: event.type === 'FAILED' ? ('TASK_FAILED' as const) : ('TASK_COMPLETED' as const),
        })),
        (await repository.maintenanceSettings()).logRetentionDays,
      )
      .catch(() => {});
  },
);
void runtimeLog
  .append(
    [{ version: 1, observedAt: new Date().toISOString(), event: 'SOFTWARE_STARTED' }],
    (await repository.maintenanceSettings()).logRetentionDays,
  )
  .catch(() => {});
devDiag.record({
  level: 'INFO',
  category: 'SYSTEM',
  event: 'SOFTWARE_STARTED',
  data: { softwareVersion, port, logFilePath: devDiagWriter.filePath },
});

const cleanupTimer = setInterval(() => {
  void dataCleanup?.automatic().catch(() => {});
}, 60000);
let autoInspectRunning = false;
const runAutoInspectSweep = () => {
  if (autoInspectRunning || shuttingDown || !autoInspectSweepRef) return;
  autoInspectRunning = true;
  void autoInspectSweepRef()
    .catch(() => {})
    .finally(() => {
      autoInspectRunning = false;
    });
};
const autoInspectInitialTimer = setTimeout(runAutoInspectSweep, 1500);
autoInspectInitialTimer.unref?.();
const autoInspectTimer = setInterval(runAutoInspectSweep, 4000);
autoInspectTimer.unref?.();
const stopHostingMonitor = process.parentPort
  ? startDesktopHostingMonitor({
      isShuttingDown: () => shuttingDown,
      getFeatureExecution: () => featureExecutionRef,
      getGoogleSheets: () => googleSheetsServiceRef,
      listAutoSchedules: () => repository.autoScheduler.listSchedules(),
      isPreventSystemSleepEnabled: async () =>
        (await repository.autoScheduler.settings()).preventSystemSleep,
      postMessage: (msg) => process.parentPort?.postMessage(msg),
    })
  : () => {};
const notificationTimer = setInterval(async () => {
  try {
    await notifications.tick();
  } catch {}
}, 1000);
console.log('Browser Workbench dashboard: ' + bridge.origin);
process.parentPort?.postMessage({ type: 'READY', origin: bridge.origin });
const startupAvatarLocalization = scheduleStartupAccountAvatarLocalization({
  repository,
  inspection,
  isShuttingDown: () => shuttingDown,
  graphAvatarLookup: (accountId) => graphAvatar.lookup(accountId),
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await runBoundedServerShutdown({
    stopTimers: () => {
      startupAvatarLocalization.cancel();
      controllerLoopDelay.disable();
      clearInterval(notificationTimer);
      clearTimeout(autoInspectInitialTimer);
      clearInterval(autoInspectTimer);
      stopHostingMonitor();
      clearInterval(cleanupTimer);
    },
    stopServices: async () => {
      await Promise.allSettled([
        activeRuntime?.close(),
        autoSchedulerServiceRef?.shutdown(),
        googleSheetsServiceRef?.shutdown(),
        groupBumperServiceRef?.shutdown(),
        groupPosterServiceRef?.shutdown(),
        groupInviterServiceRef?.stop(),
        agentBrowserManagerRef?.closeAll(),
        bluestacksServiceRef?.stopAllForInstances(),
      ]);
      bluestacksOcrClient?.close();
    },
    recordStopping: () => {
      devDiag.record({ level: 'INFO', category: 'SYSTEM', event: 'SOFTWARE_STOPPING' });
    },
    closeBridge: () => bridge.close(),
    flushLogs: async () => {
      await Promise.all([
        runtimeLog
          .append(
            [{ version: 1, observedAt: new Date().toISOString(), event: 'SOFTWARE_STOPPED' }],
            (await repository.maintenanceSettings()).logRetentionDays,
          )
          .catch(() => {}),
        devDiagWriter.flush(),
      ]);
    },
    closePersistence: () => persistence.close(),
  });
  process.parentPort?.postMessage({ type: 'STOPPED' });
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.parentPort?.on('message', (event) => {
  if (event.data === 'SHUTDOWN') void shutdown();
  const update = event.data as { type?: unknown; displays?: unknown } | null;
  if (update?.type === 'DISPLAY_LAYOUT_CHANGED') {
    const parsed = LayoutDisplays.safeParse(update.displays);
    if (parsed.success) layoutDisplays = parsed.data;
  }
});
