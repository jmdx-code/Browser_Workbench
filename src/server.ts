import { recoverBumperOperations } from './infrastructure/group-bumper-recovery.js';
import { GroupBumperService } from './application/group-bumper-service.js';
import { FeatureExecutionRegistry } from './application/feature-execution-registry.js';
import { GroupBumperBrowserAdapter } from './infrastructure/group-bumper-runner.js';
import { mediaRuntimeComponent } from './infrastructure/media-runtime-component.js';
import { SoftwareUpdateService } from './application/software-update-service.js';
import { taskBlocksSoftwareUpdate } from './domain/software-update.js';
import { SoftwareUpdateBackend } from './infrastructure/software-update-backend.js';
import { ExtensionUpdates, extensionReloadTasksBusy } from './infrastructure/extension-updates.js';
import {
  productExtensionDirectory,
  syncProductExtensionDirectory,
} from './infrastructure/paths.js';
import { access } from 'node:fs/promises';
import { DataCleanupService } from './application/data-cleanup.js';
import { LogCleanup } from './infrastructure/log-cleanup.js';
import {
  prepareWorkspaceReset,
  applyPendingWorkspaceReset,
} from './infrastructure/workspace-reset.js';
import { mapAsync } from './shared/async-collections.js';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { FilesystemRuntimeLog } from './infrastructure/runtime-log.js';
import { WorkspaceMaintenance } from './application/workspace-maintenance.js';
import { TaskNotificationMonitor } from './application/task-notification-monitor.js';
import { ProductError } from './domain/workspace.js';
const controllerLoopDelay = monitorEventLoopDelay({ resolution: 20 });
controllerLoopDelay.enable();
import { WorkspaceBackupService } from './application/workspace-backup-service.js';
import { FilesystemWorkspaceBackupWriter } from './infrastructure/workspace-backup-writer.js';
import {
  FilesystemWorkspaceRestore,
  applyPendingWorkspaceRestore,
} from './infrastructure/workspace-restore.js';
import { fileURLToPath } from 'node:url';
import { loadServerConfig } from './infrastructure/server-config.js';
import { startBridgeServer } from './bridge/server.js';
import type { WorkspaceStorePort as WorkspaceStore } from './infrastructure/persistence-port.js';
import { PersistenceClient } from './infrastructure/persistence-client.js';
import { BridgeProfileSource } from './infrastructure/browser-source.js';
import { WorkspaceService } from './application/workspace-service.js';
import { workspaceApi } from './http/workspace-api.js';
import { productDataDirectory, canonicalDataDirectory } from './infrastructure/paths.js';
import { TaskService } from './application/task-service.js';
import { reserveControllerPort, releaseControllerPort } from './infrastructure/controller-port.js';
import { KernelBridge } from './infrastructure/kernel-bridge.js';
import { MaterialPreflightService } from './application/material-preflight.js';
import { FilesystemMaterialScanner } from './infrastructure/material-scanner.js';
import { checkKnownFacebookVideo } from './infrastructure/video-metadata.js';
import { FilesystemMaterialMediaReader } from './infrastructure/material-media-reader.js';
import { FilesystemMaterialSnapshotVerifier } from './infrastructure/material-source-verifier.js';
import { ProfileInspectionService } from './application/profile-inspection.js';
import { ResourceTableService } from './application/resource-table-service.js';
import { ResourceDownloadService } from './application/resource-download-service.js';
import { PublicResourceDriveDownloader } from './infrastructure/resource-drive-downloader.js';
import { FilesystemResourceSourceReader } from './infrastructure/resource-source-reader.js';
import { KernelProfileInspection } from './infrastructure/kernel-profile-inspection.js';
import { FacebookPublishingRuntime } from './infrastructure/facebook-publishing-runtime.js';
import { ArchiveManagementService } from './application/archive-management.js';
import { MaterialUsageService } from './application/material-usage-service.js';
import { MaterialCacheManagement } from './application/material-cache-management.js';
import { MaterialCacheCleanup } from './application/material-cache-cleanup.js';
import { FilesystemMaterialCacheCleaner } from './infrastructure/material-cache-cleaner.js';
import { NativeReviewService } from './application/native-review.js';
import { KernelNativeReview } from './infrastructure/kernel-native-review.js';
import { BridgeBrowserWindow } from './infrastructure/bridge-browser-window.js';
import { LocalBrowserLabels } from './infrastructure/local-browser-labels.js';
import { GraphAvatar } from './infrastructure/graph-avatar.js';
import { GroupInviterService } from './application/group-inviter-service.js';
import { GroupInviterBrowserAdapter } from './infrastructure/group-inviter-runner.js';
import { devDiag } from './shared/dev-diagnostics.js';
import { DevDiagnosticsFileWriter } from './infrastructure/dev-diagnostics-writer.js';
import {
  buildDiagnosticFeedbackPackage,
  revealDiagnosticPackage,
} from './infrastructure/diagnostic-package.js';

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
let softwareUpdate: SoftwareUpdateService | undefined;
let extensionUpdates: ExtensionUpdates | undefined;
const {
  softwareVersion,
  identity,
  executionAcceptance,
  featureEvidence,
  publicationAcceptanceScope,
} = await loadServerConfig(root);
import { WindowLayoutService } from './application/window-layout.js';
import { LayoutDisplays, defaultWindowLayout } from './shared/window-layout.js';
let layoutDisplays = LayoutDisplays.parse(JSON.parse(process.env.WORKBENCH_DISPLAYS ?? '[]'));
let windowLayout: WindowLayoutService | undefined;
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
// Own the port before touching either database: a second process must not recover a live instance's work.
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
  const observeNames = (route: string, value: unknown) => {
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
  };
  persistence.observeResults(observeNames);
  await repository.profileAccountCache();
  await repository.profileMetadata();
  devDiag.setProfileNameResolver((profileId) => {
    return (
      diagnosticAliases.get(profileId) ||
      browserLabels.name(profileId)?.trim() ||
      diagnosticNames.get(profileId)
    );
  });
} catch (error) {
  await releaseControllerPort(binding.server);
  throw error;
}
let bridge: Awaited<ReturnType<typeof startBridgeServer>>;
let inspection: ProfileInspectionService | undefined;
let nativeReview: NativeReviewService | undefined;
let mainKernel: KernelBridge | undefined;
let publishingRuntime: FacebookPublishingRuntime | undefined;
let backups: WorkspaceBackupService | undefined;
let dataCleanup: DataCleanupService | undefined;
const materialPreflight = new MaterialPreflightService(
  new FilesystemMaterialScanner(undefined, checkKnownFacebookVideo),
  () => new Date().toISOString(),
  new FilesystemMaterialMediaReader(),
  new FilesystemMaterialSnapshotVerifier(),
);
try {
  await repository.tasks.recoverOnStartup(!restoreRequested);
  await repository.taskTabs.recoverOnStartup();
  await repository.tasks.settlements.recoverOnStartup();
  await repository.uploadStages.recoverOnStartup();
  await repository.cacheCleanup.recoverOnStartup();
  await repository.archivePreparation.recoverOnStartup();
  await repository.archiveExecution.recoverOnStartup();
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
    autoRecoverConnections: process.env.WORKBENCH_DIAGNOSTICS !== '1',
    connectionRecoveryAllowed:
      process.env.WORKBENCH_DIAGNOSTICS === '1'
        ? undefined
        : async (profileId) =>
            (await publishingRuntime?.canRecoverConnectionForEnding(profileId)) === true ||
            !(await repository.tasks.hasProfilePlanInStates(profileId, [
              'QUEUED',
              'RUNNING',
              'PAUSING',
              'PAUSED',
              'STOPPING',
              'REVIEW',
            ])),
    diagnosticsEnabled: process.env.WORKBENCH_DIAGNOSTICS === '1',
    kernelHooks:
      port === 18767 || process.env.WORKBENCH_SMOKE_WINDOW_LAYOUT === '1'
        ? ({ core, tasks }) => {
            const kernel = new KernelBridge(core, tasks);
            kernel.recoverBumperWorkspace = (peer, guard) =>
              recoverBumperOperations(kernel, peer, repository.groupBumper, guard);
            const layout = new WindowLayoutService(
              () => layoutDisplays,
              {
                read: (id) => kernel.taskWindow(id),
                move: (id, expected, rect, exposed, deadline, focus) =>
                  kernel.taskWindow(id, expected, rect, exposed, deadline, focus),
              },
              async () => (await repository.preferences()).windowLayout ?? defaultWindowLayout,
              async (value) => {
                const saved = await repository.preferences();
                const { version: _version, revision, ...values } = saved;
                await repository.updatePreferences({
                  expectedRevision: revision,
                  values: { ...values, windowLayout: value },
                });
              },
              process.env.WORKBENCH_TRACE_TIMING === '1'
                ? (data) => console.error(JSON.stringify({ event: 'WINDOW_LAYOUT_TRIAL', data }))
                : undefined,
              () => {
                let bestId: string | null = null;
                let bestAt = 0;
                for (const peer of core.peers.values()) {
                  if (!peer.online) continue;
                  const at = peer.focusedWindowAt ?? 0;
                  if (at > bestAt) {
                    bestAt = at;
                    bestId = peer.profileId;
                  }
                }
                return bestId;
              },
            );
            kernel.setWindowLayoutHook(
              (id, guard) => layout.arrange(id, guard),
              () => layout.isEnabled(),
              undefined,
              (id, at) => layout.visible(id, at),
            );
            windowLayout = layout;
            kernel.setAccountObserver({
              shouldRefreshAvatar: async (profileId, accountId) => {
                const cached = (await repository.profileAccountCache()).get(profileId);
                return (
                  !cached?.avatar ||
                  cached.id !== accountId ||
                  Date.now() - (cached.avatarUpdatedAt ?? 0) >= 6 * 3600_000
                );
              },
              onObserved: async (profileId, account) => {
                await repository.updateProfileAccountCache(profileId, account);
                if (account.state === 'logged-in' && account.id && !account.avatar) {
                  const cached = (await repository.profileAccountCache()).get(profileId);
                  if (
                    !cached?.avatar ||
                    cached.id !== account.id ||
                    Date.now() - (cached.avatarUpdatedAt ?? 0) >= 6 * 3600_000
                  ) {
                    const accountId = account.id;
                    void graphAvatar
                      .lookup(accountId)
                      .then(async (url) => {
                        if (url) {
                          await repository.updateProfileAccountCache(profileId, {
                            state: 'logged-in',
                            id: accountId,
                            avatar: url,
                          });
                        }
                      })
                      .catch(() => {});
                  }
                }
              },
            });
            mainKernel = kernel;
            persistence.setFailureHandler((error) => {
              kernel.revokeInputs('PERSISTENCE_UNAVAILABLE');
              for (const peer of core.peers.values()) {
                if (peer.online) void core.stop(peer.profileId).catch(() => {});
              }
              console.error('Persistence worker failed; input authority revoked:', error);
            });
            nativeReview = new NativeReviewService(
              new KernelNativeReview(kernel, core),
              repository.tasks,
            );
            inspection = new ProfileInspectionService(
              new KernelProfileInspection(kernel, core, repository.tasks),
              Date.now,
              (accountId) => graphAvatar.lookup(accountId),
              async (profileId, account) => {
                await repository.updateProfileAccountCache(profileId, {
                  state: account.state,
                  ...(account.id ? { id: account.id } : {}),
                  ...(account.name ? { name: account.name } : {}),
                  avatar: ['logged-out', 'restricted', 'verification'].includes(account.state)
                    ? null
                    : account.avatar,
                });
              },
            );
            if (process.env.WORKBENCH_DIAGNOSTICS !== '1')
              publishingRuntime = new FacebookPublishingRuntime(
                kernel,
                core,
                repository,
                dataDir,
                async () =>
                  (await new BridgeProfileSource(core, core.store, tasks).profiles()).map(
                    (profile) => ({
                      id: profile.id,
                      online: profile.online,
                      synced: profile.synced,
                      unresolved: profile.unresolved,
                      account: profile.account,
                      dispatchAllowed: false,
                    }),
                  ),
                {
                  feed: () => executionAcceptance.feed,
                  video: () => executionAcceptance.video,
                  marketplace: () => executionAcceptance.marketplace,
                  post: () => executionAcceptance.post,
                  story: () => executionAcceptance.story,
                  friends: () => executionAcceptance.friends,
                },
                undefined,
                undefined,
                undefined,
                undefined,
                () => {
                  dataCleanup?.assertNotResetting();
                  backups?.assertIdle();
                  softwareUpdate?.assertIdle();
                },
                publicationAcceptanceScope,
                uploadCacheRoot,
                async (profileId) => {
                  const profile = await new BridgeProfileSource(core, core.store, tasks).profile(
                    profileId,
                  );
                  return profile
                    ? {
                        id: profile.id,
                        online: profile.online,
                        synced: profile.synced,
                        unresolved: profile.unresolved,
                        account: profile.account,
                        dispatchAllowed: false,
                      }
                    : undefined;
                },
              );
            return {
              message: async (peer, value) => await kernel.message(peer, value),
              disconnected: (peer) => kernel.disconnected(peer),
              controlStopped: async (peer, requestId) => {
                kernel.controlStopped(peer, requestId);
                await publishingRuntime?.parentControlStopped(peer);
              },
              tick: async () => {
                kernel.tick();
                void browserLabels
                  .refresh((await core.store.profileList()).map((row) => String(row.profileId)))
                  .catch(() => {});
                void publishingRuntime
                  ?.tick()
                  .catch((error) => console.error('Publishing runtime failed', error));
              },
              close: async () => {
                const settling = inspection?.close();
                await publishingRuntime?.close();
                await kernel.close();
                await settling;
              },
            };
          }
        : undefined,
    extensionIds: process.env.BRIDGE_ALLOWED_EXTENSION_ID
      ? [process.env.BRIDGE_ALLOWED_EXTENSION_ID]
      : [identity.extensionId, 'penkjbecaaekdcpbpcfjekhikhjhoaai'],
    appRoutes: ({ core, store, tasks }) => {
      backups = new WorkspaceBackupService(
        repository.tasks,
        new FilesystemWorkspaceBackupWriter(
          async (file) => repository.backup(file),
          async (file) => store.backup(file),
          softwareVersion,
          dataDir,
        ),
        new FilesystemWorkspaceRestore(dataDir),
        () =>
          (publishingRuntime?.hasActiveExecution() ?? false) ||
          groupInviterService.hasActiveExecution() ||
          groupBumperService?.hasActiveExecution() === true,
      );
      const workspaceService = new WorkspaceService(
        repository,
        new BridgeProfileSource(
          core,
          store,
          tasks,
          inspection,
          browserLabels,
          (id) => mainKernel?.presentationStatus(id) ?? null,
        ),
      );
      const taskService = new TaskService(
        repository.tasks,
        () => publishingRuntime,
        () => {
          dataCleanup?.assertNotResetting();
          backups?.assertIdle();
          softwareUpdate?.assertIdle();
        },
        () => featureEvidence,
        () => {
          void publishingRuntime?.tick().catch(() => {});
        },
      );
      let groupBumperService: GroupBumperService | undefined;
      const featureExecution = new FeatureExecutionRegistry();
      featureExecution.register({
        id: 'active-accounts',
        label: '活跃账号',
        isProfileRunning: async (profileId) => {
          await repository.tasks.releaseErroredPausedPlans([profileId]);
          return await repository.tasks.hasProfilePlanInStates(profileId, [
            'QUEUED',
            'RUNNING',
            'PAUSING',
            'PAUSED',
            'STOPPING',
            'REVIEW',
          ]);
        },
        hasActiveExecution: () => publishingRuntime?.hasActiveExecution() === true,
      });
      const groupInviterService = new GroupInviterService(
        repository.groupInviter,
        new GroupInviterBrowserAdapter(
          repository.groupInviter,
          () => mainKernel,
          () => core,
          async (profileId) => {
            const p = await new BridgeProfileSource(
              core,
              store,
              tasks,
              inspection,
              browserLabels,
            ).profile(profileId);
            return (
              p?.account.id ?? (await repository.profileAccountCache()).get(profileId)?.id ?? null
            );
          },
          (profileId) => featureExecution.isProfileBusy(profileId, 'group-inviter'),
        ),
        () => {
          dataCleanup?.assertNotResetting();
          backups?.assertIdle();
          softwareUpdate?.assertIdle();
        },
      );
      featureExecution.register({
        id: 'group-inviter',
        label: '小组邀请人',
        isProfileRunning: (profileId) => groupInviterService.isProfileRunning(profileId),
        hasActiveExecution: () => groupInviterService.hasActiveExecution(),
        stopProfiles: async (profileIds) => {
          await groupInviterService.stopProfiles({ profileIds: [...profileIds] });
        },
      });
      const bumperAdapter = new GroupBumperBrowserAdapter(
        repository.groupBumper,
        () => mainKernel,
        () => core,
        (id) => featureExecution.isProfileBusy(id, 'group-bumper'),
      );
      groupBumperService = new GroupBumperService(
        repository.groupBumper,
        bumperAdapter,
        async () => ({
          comments: await repository.groupBumper.comments(),
          total: await repository.groupBumper.total(),
        }),
        () => {
          dataCleanup?.assertNotResetting();
          backups?.assertIdle();
          softwareUpdate?.assertIdle();
        },
        (kind, items, options) => bumperAdapter.refreshTargetBatch(kind, items, options),
      );

      featureExecution.register({
        id: 'group-bumper',
        label: '小组顶贴',
        isProfileRunning: (profileId) => groupBumperService?.isProfileRunning(profileId) === true,
        hasActiveExecution: () => groupBumperService?.hasActiveExecution() === true,
        stopProfiles: async (profileIds) => {
          await groupBumperService?.stop([...profileIds]);
        },
      });
      const mediaComponent = mediaRuntimeComponent(dataDir);
      const updaterBackend = new SoftwareUpdateBackend({
        root,
        dataDir,
        softwareVersion,
        extensionVersion: bundledExtension.version,
      });
      extensionUpdates = new ExtensionUpdates(
        core,
        bundledExtension.version,
        productExtensionDirectory(),
        async (id) =>
          groupBumperService?.isProfileRunning(id) === true ||
          groupInviterService.isProfileRunning(id) ||
          publishingRuntime?.hasExecutionOrOpening(id) === true ||
          core.hasPendingControlOrOperation(id) ||
          (await store.unresolved(id)).length > 0 ||
          (await extensionReloadTasksBusy(repository.tasks, repository.tasks.settlements, id)),
        async (peer) => {
          await mainKernel?.releaseIdleForExtension(peer);
          publishingRuntime?.clearStartupBackoff(peer.profileId);
        },
      );
      softwareUpdate = new SoftwareUpdateService(
        {
          readConfig: () => updaterBackend.readConfig(),
          saveConfig: (config) => updaterBackend.saveConfig(config),
          check: (repo) => updaterBackend.check(repo),
          install: async (release, guard) => {
            await updaterBackend.install(release, guard);
            if (release.extensionVersion) extensionUpdates?.setVersion(release.extensionVersion);
          },
          assertCanApply: async () => {
            if (!process.parentPort)
              throw new ProductError('UPDATE_DESKTOP_REQUIRED', '请在桌面工作台中执行更新', 409);
            if (
              groupBumperService?.hasActiveExecution() === true ||
              groupInviterService.hasActiveExecution() ||
              publishingRuntime?.hasActiveExecution() ||
              (await repository.tasks.livePlans()).some((p) =>
                taskBlocksSoftwareUpdate(
                  p.state,
                  core.peers.get(p.profileId)?.online === true,
                  publishingRuntime?.hasOwner(p.profileId) === true,
                ),
              )
            )
              throw new ProductError(
                'UPDATE_TASKS_ACTIVE',
                '当前有任务正在运行，请先暂停或停止任务后再执行一键更新',
                409,
              );
            backups?.assertIdle();
          },
          restart: () => {
            process.parentPort?.postMessage({ type: 'REQUEST_RESTART' });
          },
          reloadExtensions: (ids) => {
            if (!extensionUpdates) throw Error('EXTENSION_UPDATE_UNAVAILABLE');
            return extensionUpdates.reload(ids);
          },
          openExtensionDirectory: () => {
            if (!process.parentPort)
              throw new ProductError(
                'UPDATE_DESKTOP_REQUIRED',
                '请在桌面工作台中打开插件目录',
                409,
              );
            process.parentPort.postMessage({ type: 'OPEN_EXTENSION_DIRECTORY' });
          },
        },
        {
          software: softwareVersion,
          extension: bundledExtension.version,
          directory: productExtensionDirectory(),
        },
      );
      let mutations = 0;
      dataCleanup = new DataCleanupService(
        repository.dataCleanup,
        new LogCleanup(runtimeLog.directory, (work) =>
          runtimeLog.exclusive(() => devDiagWriter.exclusive(work)),
        ),
        process.parentPort
          ? {
              directory: dataDir,
              prepare: () => prepareWorkspaceReset(dataDir),
              restart: () => process.parentPort?.postMessage({ type: 'REQUEST_RESET' }),
            }
          : undefined,
        async () => {
          if (publishingRuntime?.hasActiveExecution())
            throw new ProductError('RESET_TASKS_ACTIVE', '请先停止当前正在执行的任务', 409);
          if (groupBumperService?.hasActiveExecution())
            throw new ProductError('RESET_BUMPER_ACTIVE', '请先停止小组顶贴任务', 409);
          if ((await groupInviterService.state()).running)
            throw new ProductError('RESET_INVITER_ACTIVE', '请先停止小组邀请任务', 409);
        },
        () => {
          mediaComponent.assertIdle();
          backups?.assertIdle();
          if (mutations > 1)
            throw new ProductError('DATA_WRITES_ACTIVE', '有其他操作正在保存，请稍后重试', 409);
        },
      );
      const handler = workspaceApi(
        workspaceService,
        taskService,
        materialPreflight,
        inspection,
        new ResourceTableService(
          repository.resourceTables,
          new FilesystemResourceSourceReader(),
          Date.now,
          new ResourceDownloadService(
            repository.resourceTables,
            new PublicResourceDriveDownloader(path.join(dataDir, 'resource-downloads')),
          ),
        ),
        new ArchiveManagementService(repository.archivePreparation, () => undefined),
        nativeReview,
        new MaterialUsageService(repository.materialUsage),
        backups,
        process.parentPort
          ? { restart: () => process.parentPort?.postMessage({ type: 'REQUEST_RESTART' }) }
          : undefined,
        new BridgeBrowserWindow(
          core,
          repository.tasks,
          async (profileId) => {
            const peer = core.peers.get(profileId);
            if (!peer || !mainKernel) return null;
            return mainKernel.revealRegisteredFacebookPage(peer);
          },
          async (profileId, preferActiveTab = true) => {
            const peer = core.peers.get(profileId);
            if (!peer || !mainKernel)
              throw new ProductError(
                'WORKSPACE_CLEANUP_UNAVAILABLE',
                '浏览器未连接或内核未就绪',
                409,
              );
            return mainKernel.consolidateFacebookWorkspace(peer, preferActiveTab);
          },
          (profileId) =>
            groupInviterService.isProfileRunning(profileId) ||
            groupBumperService?.isProfileRunning(profileId) === true,
        ),
        new MaterialCacheManagement(
          repository.cacheCleanup,
          new MaterialCacheCleanup(
            repository.cacheCleanup,
            new FilesystemMaterialCacheCleaner(repository.cacheCleanup, uploadCacheRoot),
          ),
        ),
        new WorkspaceMaintenance(repository, runtimeLog, {
          logDirectory: runtimeLog.directory,
          cacheDirectory: uploadCacheRoot,
        }),
        groupInviterService,
        async (diagInput) => {
          const note = diagInput?.note;
          const uiContext = diagInput?.uiContext;
          const wsSnapshot = await workspaceService.snapshot();
          const runtime = await taskService.runtimeOverview();
          const activePlans = await mapAsync(runtime.plans.slice(-16), async (plan) => {
            const activeStep = await repository.tasks.currentStepForPlan(
              plan.id,
              plan.round,
              plan.position,
            );
            const recentOps = (await repository.tasks.recentOperations(plan.id, 6)).map((op) => ({
              id: op.id,
              kind: op.action.kind,
              status: op.status,
              disposition: op.disposition ?? null,
              updatedAt: op.updatedAt,
            }));
            return {
              id: plan.id,
              profileId: plan.profileId,
              profileName:
                wsSnapshot.profiles.find((p) => p.id === plan.profileId)?.alias ||
                wsSnapshot.profiles.find((p) => p.id === plan.profileId)?.browserName ||
                plan.profileId.slice(0, 8),
              combinationName: plan.snapshot.name,
              state: plan.state,
              reason: plan.reason,
              round: plan.round,
              position: plan.position,
              activeStep: activeStep
                ? {
                    id: activeStep.id,
                    type: activeStep.spec.type,
                    status: activeStep.status,
                    progress: activeStep.progress,
                  }
                : null,
              recentOps,
            };
          });
          const profileSummaries = wsSnapshot.profiles.map((p) => {
            const peer = core.peers.get(p.id);
            return {
              id: p.id,
              name: p.alias || p.browserName || p.id.slice(0, 8),
              alias: p.alias ?? '',
              browserName: p.browserName ?? '',
              online: p.online,
              phase: p.phase,
              synced: p.synced,
              unresolved: p.unresolved,
              extensionVersion: peer?.extensionVersion ?? null,
              accountState: p.account.state,
              accountId: p.account.id ?? null,
              accountName: p.account.name ?? null,
              profileWindowFocused: peer?.profileWindowFocused ?? null,
              focusedWindowAt: peer?.focusedWindowAt ?? null,
              presentationRecoverySupported:
                peer?.capabilities?.includes('task-presentation-recovery-v1') ?? false,
              kernelTraceTail: mainKernel ? mainKernel.diagnostics(p.id).slice(-50) : [],
            };
          });
          const inviterState = await groupInviterService.state();
          const inviterLogs = await groupInviterService.logs('', undefined, 300);
          const bumperState = groupBumperService ? await groupBumperService.state() : null;
          const bumperLogs = groupBumperService
            ? await groupBumperService.logs('', undefined, undefined, 300)
            : [];
          const loopDelaySummary = {
            resolutionMs: 20,
            samples: controllerLoopDelay.count,
            maxSampleIntervalMs: controllerLoopDelay.count ? controllerLoopDelay.max / 1e6 : null,
            p99SampleIntervalMs: controllerLoopDelay.count
              ? controllerLoopDelay.percentile(99) / 1e6
              : null,
          };
          const entry = devDiag.record({
            level: 'SNAPSHOT',
            category: 'SNAPSHOT',
            event: 'USER_MANUAL_SNAPSHOT',
            reason: note?.trim() || uiContext?.trim() || 'USER_CLICKED_SNAPSHOT_BUTTON',
            data: {
              softwareVersion,
              uiContext: uiContext?.trim() || '',
              controllerLoopDelay: loopDelaySummary,
              controllerMemory: process.memoryUsage(),
              settings: runtime.settings,
              profiles: profileSummaries,
              plans: activePlans,
              plansTruncated: runtime.plans.length > activePlans.length,
              groupInviter: {
                running: inviterState.running,
                runId: inviterState.runId,
                statusText: inviterState.statusText,
                profileCounts: inviterState.profileCounts,
              },
              groupBumper: bumperState
                ? {
                    running: bumperState.running,
                    statusText: bumperState.statusText,
                    profileCounts: bumperState.profileCounts,
                  }
                : null,
            },
          });
          const combinationsSummary = wsSnapshot.combinations.map((row) => ({
            id: row.id,
            version: row.version,
            revision: row.revision,
            updatedAt: row.updatedAt,
            saved: row.saved
              ? {
                  name: row.saved.name,
                  note: row.saved.note,
                  randomOrder: row.saved.randomOrder,
                  loop: row.saved.loop,
                  steps: row.saved.steps,
                }
              : null,
          }));
          return await buildDiagnosticFeedbackPackage({
            dataDir,
            softwareVersion,
            extensionVersion: bundledExtension.version,
            note,
            uiContext,
            targetDir: diagInput?.targetDir,
            reveal: diagInput?.reveal,
            entryId: entry.id,
            at: entry.at,
            controllerLoopDelay: loopDelaySummary,
            profiles: profileSummaries,
            combinations: combinationsSummary,
            groupInviter: {
              state: inviterState,
              logs: inviterLogs,
            },
            groupBumper: bumperState
              ? {
                  state: bumperState,
                  logs: bumperLogs,
                }
              : null,
            tasksRepository: repository.tasks,
            taskTabsRepository: repository.taskTabs,
            devDiagFlush: () => devDiagWriter.flush(),
            devDiagFilePath: devDiagWriter.filePath,
          });
        },
        dataCleanup,
        windowLayout,
        mediaComponent,
        softwareUpdate,
        groupBumperService,
        (fileName, targetDir) => revealDiagnosticPackage(dataDir, fileName, targetDir),
        featureExecution,
      );
      return async (...args) => {
        const [req] = args;
        if (req.method !== 'POST') return handler(...args);
        mutations++;
        try {
          return await handler(...args);
        } finally {
          mutations--;
        }
      };
    },
  });
  // Product policy: source files remain in place. Historical archive records are read-only;
  // no archive worker, preparation, copy, source delete or movement is launched.
} catch (error) {
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
  data: {
    softwareVersion,
    port,
    logFilePath: devDiagWriter.filePath,
  },
});
const cleanupTimer = setInterval(() => {
  void dataCleanup?.automatic().catch(() => {});
}, 60000);
const notificationTimer = setInterval(async () => {
  try {
    await notifications.tick();
  } catch {
    /* Notification failures never alter task execution. */
  }
}, 1000);
console.log('Browser Workbench dashboard: ' + bridge.origin);
process.parentPort?.postMessage({ type: 'READY', origin: bridge.origin });
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  controllerLoopDelay.disable();
  if (notificationTimer) clearInterval(notificationTimer);
  clearInterval(cleanupTimer);
  devDiag.record({
    level: 'INFO',
    category: 'SYSTEM',
    event: 'SOFTWARE_STOPPING',
  });
  await bridge.close();
  let logTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all([
      runtimeLog
        .append(
          [{ version: 1, observedAt: new Date().toISOString(), event: 'SOFTWARE_STOPPED' }],
          (await repository.maintenanceSettings()).logRetentionDays,
        )
        .catch(() => {}),
      devDiagWriter.flush(),
    ]),
    new Promise<void>((resolve) => {
      logTimer = setTimeout(resolve, 1000);
    }),
  ]);
  if (logTimer) clearTimeout(logTimer);
  await persistence.close();
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
