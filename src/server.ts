import { recoverBumperOperations } from './infrastructure/group-bumper-recovery.js';
import { retireClosedKernelSession } from './infrastructure/kernel-session-retirement.js';
const controllerStartedAt = Date.now();
import {
  fetchAndLocalizeAccountAvatar,
  scheduleStartupAccountAvatarLocalization,
} from './infrastructure/group-bumper-avatar.js';
import { isLocalAvatar } from './shared/group-bumper.js';
import { GroupBumperService } from './application/group-bumper-service.js';
import { GroupPosterService } from './application/group-poster-service.js';
import {
  FeatureExecutionRegistry,
  ensureFeatureExecutionRegistry,
} from './application/feature-execution-registry.js';
import { createGlobalAccountAbnormalReporter } from './application/account-abnormal-reporter.js';
import { GroupBumperBrowserAdapter } from './infrastructure/group-bumper-runner.js';
import { TargetMetadataRefreshService } from './infrastructure/target-metadata-refresh.js';
import {
  FilesystemPosterMediaPreparer,
  GroupPosterBrowserAdapter,
  recoverPosterOperations,
} from './infrastructure/group-poster-runner.js';
import { mediaRuntimeComponent } from './infrastructure/media-runtime-component.js';
import { SoftwareUpdateService } from './application/software-update-service.js';
import { taskBlocksSoftwareUpdate } from './domain/software-update.js';
import { SoftwareUpdateBackend } from './infrastructure/software-update-backend.js';
import { ExtensionUpdates, extensionReloadTasksBusy } from './infrastructure/extension-updates.js';
import {
  productExtensionDirectory,
  syncProductExtensionDirectory,
} from './infrastructure/paths.js';
import {
  productAiWorkspaceDirectory,
  syncProductAiWorkspaceDirectory,
} from './infrastructure/ai-workspace.js';
import { access } from 'node:fs/promises';
import { DataCleanupService } from './application/data-cleanup.js';
import { LogCleanup } from './infrastructure/log-cleanup.js';
import {
  prepareWorkspaceReset,
  applyPendingWorkspaceReset,
} from './infrastructure/workspace-reset.js';
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
import type { BluestacksService } from './application/bluestacks-service.js';
import type { WindowsOcrClient } from './infrastructure/bluestacks-vision.js';
import { devDiag } from './shared/dev-diagnostics.js';
import { DevDiagnosticsFileWriter } from './infrastructure/dev-diagnostics-writer.js';
import type http from 'node:http';
import {
  createDiagnosticSnapshotBuilder,
  revealDiagnosticPackage,
} from './infrastructure/diagnostic-package.js';
import type { AgentBrowserManager } from './infrastructure/mcp/agent-browser-manager.js';
import {
  createBluestacksRuntime,
  openDesktopAiWorkspaceViaParent,
  openDesktopExtensionDirViaParent,
  schedulePosterDriveCacheCleanup,
  wireLifecycleAndMcpRuntime,
} from './infrastructure/mcp/mcp-runtime-wiring.js';

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
let bluestacksOcrClient: WindowsOcrClient | undefined;
let bluestacksServiceRef: BluestacksService | undefined;
let groupBumperServiceRef: GroupBumperService | undefined;
let agentBrowserManagerRef: AgentBrowserManager | undefined;
let mcpHttpHandler:
  ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>) | undefined;
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
    mcpHandler: (req, res) => (mcpHttpHandler ? mcpHttpHandler(req, res) : Promise.resolve(false)),
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
            kernel.retireClosedSession = (peer, port, state) =>
              retireClosedKernelSession(repository, peer, port, state, controllerStartedAt);
            kernel.recoverBumperWorkspace = (peer, guard) =>
              recoverBumperOperations(kernel, peer, repository.groupBumper, guard);
            kernel.recoverPosterWorkspace = (peer, guard) =>
              recoverPosterOperations(kernel, peer, repository.groupPoster, guard);
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
            const localizeAvatar = (url: string, key: string) =>
              fetchAndLocalizeAccountAvatar(url, undefined, key).catch(() => null);
            kernel.setAccountObserver({
              shouldRefreshAvatar: async (profileId, accountId) => {
                const cached = (await repository.profileAccountCache()).get(profileId);
                return (
                  !isLocalAvatar(cached?.avatar) ||
                  cached?.id !== accountId ||
                  Date.now() - (cached?.avatarUpdatedAt ?? 0) >= 6 * 3600_000
                );
              },
              onObserved: async (profileId, account) => {
                const previous = (await repository.profileAccountCache()).get(profileId);
                let resolvedAvatar = account.avatar;
                if (resolvedAvatar && !isLocalAvatar(resolvedAvatar)) {
                  const localized = await localizeAvatar(
                    resolvedAvatar,
                    `${profileId}:${account.id ?? ''}`,
                  );
                  if (localized) resolvedAvatar = localized;
                  else if (isLocalAvatar(previous?.avatar) && previous?.id === account.id)
                    resolvedAvatar = previous?.avatar ?? null;
                }
                await repository.updateProfileAccountCache(profileId, {
                  ...account,
                  ...(resolvedAvatar !== undefined ? { avatar: resolvedAvatar } : {}),
                });
                const latest = (await repository.profileAccountCache()).get(profileId);
                const effectiveAvatar =
                  latest?.avatar ??
                  (resolvedAvatar !== undefined
                    ? resolvedAvatar
                    : previous?.id === account.id
                      ? previous?.avatar
                      : null);
                inspection?.syncExternalObservation(profileId, {
                  ...account,
                  ...(effectiveAvatar !== undefined ? { avatar: effectiveAvatar } : {}),
                });
                const staleAvatar =
                  !isLocalAvatar(previous?.avatar) ||
                  previous?.id !== account.id ||
                  Date.now() - (previous?.avatarUpdatedAt ?? 0) >= 6 * 3600_000;
                if (
                  account.state === 'logged-in' &&
                  account.id &&
                  !isLocalAvatar(effectiveAvatar) &&
                  staleAvatar
                ) {
                  const accountId = account.id;
                  void graphAvatar
                    .lookup(accountId)
                    .then(async (url) => {
                      if (!url) return;
                      const finalAvatar =
                        (await localizeAvatar(url, `${profileId}:${accountId}`)) ?? url;
                      await repository.updateProfileAccountCache(profileId, {
                        state: 'logged-in',
                        id: accountId,
                        avatar: finalAvatar,
                        liveConfirmedLoggedIn: true,
                      });
                      inspection?.syncExternalObservation(profileId, {
                        state: 'logged-in',
                        id: accountId,
                        avatar: finalAvatar,
                      });
                    })
                    .catch(() => {});
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
                let resolvedAvatar =
                  account.state === 'logged-out'
                    ? null
                    : ['restricted', 'verification'].includes(account.state)
                      ? undefined
                      : account.avatar;
                if (resolvedAvatar && !isLocalAvatar(resolvedAvatar)) {
                  const localized = await localizeAvatar(
                    resolvedAvatar,
                    `${profileId}:${account.id ?? ''}`,
                  );
                  if (localized) resolvedAvatar = localized;
                }
                await repository.updateProfileAccountCache(profileId, {
                  state: account.state,
                  ...(account.id ? { id: account.id } : {}),
                  ...(account.name ? { name: account.name } : {}),
                  ...(resolvedAvatar !== undefined ? { avatar: resolvedAvatar } : {}),
                  liveConfirmedLoggedIn: account.state === 'logged-in',
                });
                if (resolvedAvatar && isLocalAvatar(resolvedAvatar)) {
                  inspection?.syncExternalObservation(profileId, {
                    state: account.state,
                    id: account.id,
                    name: account.name,
                    avatar: resolvedAvatar,
                  });
                }
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
                void (async () => {
                  const ids = (await core.store.profileList()).map((row) => String(row.profileId));
                  const newlyBound = await browserLabels.refresh(ids);
                  if (newlyBound.length > 0) {
                    await repository.upsertProfileLaunchBindings(newlyBound);
                  }
                })().catch(() => {});
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
      const featureExecution = new FeatureExecutionRegistry();
      backups = new WorkspaceBackupService(
        repository.tasks,
        new FilesystemWorkspaceBackupWriter(
          async (file) => repository.backup(file),
          async (file) => store.backup(file),
          softwareVersion,
          dataDir,
        ),
        new FilesystemWorkspaceRestore(dataDir),
        () => featureExecution.hasAnyActiveExecution(),
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
      const assertSystemIdle = () => {
        dataCleanup?.assertNotResetting();
        backups?.assertIdle();
        softwareUpdate?.assertIdle();
      };
      const taskService = new TaskService(
        repository.tasks,
        () => publishingRuntime,
        assertSystemIdle,
        () => featureEvidence,
        () => {
          void publishingRuntime?.tick().catch(() => {});
        },
      );
      let groupBumperService: GroupBumperService | undefined;
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
        stopProfiles: async (profileIds) => {
          await Promise.all(profileIds.map((id) => taskService.stopActiveProfile(id)));
        },
      });
      const accountAbnormalReporter = createGlobalAccountAbnormalReporter({
        updateProfileAccountCache: (profileId, patch) =>
          repository.updateProfileAccountCache(profileId, {
            state: patch.state,
            scope: patch.scope,
            ...(patch.accountId !== undefined ? { id: patch.accountId } : {}),
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
          }),
        syncExternalObservation: (profileId, patch) => {
          inspection?.syncExternalObservation(profileId, {
            state: patch.state,
            ...(patch.accountId !== undefined ? { id: patch.accountId } : {}),
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
          });
        },
      });
      const bumperAdapter = new GroupBumperBrowserAdapter(
        repository.groupBumper,
        () => mainKernel,
        () => core,
        async (id) => {
          for (const participant of featureExecution.participants()) {
            if (participant.id === 'group-bumper' || participant.id === 'page-bumper') continue;
            if (await participant.isProfileRunning(id)) return true;
          }
          return false;
        },
        1,
        accountAbnormalReporter,
      );
      const targetMetadataRefresh = new TargetMetadataRefreshService(bumperAdapter);
      const groupInviterService = new GroupInviterService(
        repository.groupInviter,
        new GroupInviterBrowserAdapter(
          repository.groupInviter,
          () => mainKernel,
          () => core,
          undefined,
          (profileId) => featureExecution.isProfileBusy(profileId, 'group-inviter'),
          targetMetadataRefresh,
          accountAbnormalReporter,
        ),
        assertSystemIdle,
        (items, options) => targetMetadataRefresh.refreshTargetBatch('groups', items, options),
        () => targetMetadataRefresh.stopRefresh('groups'),
      );
      groupInviterService.setFeatureExecutionRegistry(featureExecution);
      groupBumperService = new GroupBumperService(
        repository.groupBumper,
        bumperAdapter,
        async () => ({
          comments: await repository.groupBumper.comments(),
          total: await repository.groupBumper.total(),
        }),
        assertSystemIdle,
        (kind, items, options) => targetMetadataRefresh.refreshTargetBatch(kind, items, options),
        undefined,
        (kind) => targetMetadataRefresh.stopRefresh(kind),
      );
      groupBumperService.setFeatureExecutionRegistry(featureExecution);
      const mediaComponent = mediaRuntimeComponent(dataDir);
      const posterAdapter = new GroupPosterBrowserAdapter(
        repository.groupBumper,
        () => mainKernel,
        () => core,
        (id) => featureExecution.isProfileBusy(id, 'group-poster'),
        1,
        repository.groupPoster,
        accountAbnormalReporter,
      );
      const groupPosterService = new GroupPosterService(
        repository.groupPoster,
        posterAdapter,
        new FilesystemPosterMediaPreparer(
          path.join(uploadCacheRoot, 'group-poster-media'),
          fetch,
          mediaComponent,
        ),
        featureExecution,
        assertSystemIdle,
        (kind, items, options) => targetMetadataRefresh.refreshTargetBatch(kind, items, options),
        () => targetMetadataRefresh.stopRefresh('groups'),
      );
      const bsRuntime = createBluestacksRuntime(repository, featureExecution);
      bluestacksOcrClient = bsRuntime.ocrClient;
      const bluestacksService = bsRuntime.service;
      bluestacksServiceRef = bluestacksService;
      ensureFeatureExecutionRegistry(featureExecution, {
        groupInviter: groupInviterService,
        groupBumper: groupBumperService,
        groupPoster: groupPosterService,
        bluestacks: bluestacksService,
      });
      schedulePosterDriveCacheCleanup(groupPosterService);
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
          (await featureExecution.isProfileBusy(id)) ||
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
            const activeLabels = await featureExecution.activeModuleLabels();
            const hasLiveTaskPlan = (await repository.tasks.livePlans()).some((p) =>
              taskBlocksSoftwareUpdate(
                p.state,
                core.peers.get(p.profileId)?.online === true,
                publishingRuntime?.hasOwner(p.profileId) === true,
              ),
            );
            if (activeLabels.length > 0 || hasLiveTaskPlan) {
              const moduleSuffix = activeLabels.length > 0 ? `（${activeLabels.join('、')}）` : '';
              throw new ProductError(
                'UPDATE_TASKS_ACTIVE',
                `当前有任务正在运行${moduleSuffix}，请先暂停或停止任务后再执行一键更新`,
                409,
              );
            }
            backups?.assertIdle();
          },
          restart: () => {
            process.parentPort?.postMessage({ type: 'REQUEST_RESTART' });
          },
          reloadExtensions: (ids) => {
            if (!extensionUpdates) throw Error('EXTENSION_UPDATE_UNAVAILABLE');
            return extensionUpdates.reload(ids);
          },
          openExtensionDirectory: () => openDesktopExtensionDirViaParent(),
          openAiWorkspaceDirectory: () => openDesktopAiWorkspaceViaParent(root, softwareVersion),
        },
        {
          software: softwareVersion,
          extension: bundledExtension.version,
          directory: productExtensionDirectory(),
          aiWorkspaceDirectory: productAiWorkspaceDirectory(),
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
          const activeLabels = await featureExecution.activeModuleLabels();
          if (activeLabels.length > 0) {
            throw new ProductError(
              'RESET_TASKS_ACTIVE',
              `请先停止当前正在执行的任务（${activeLabels.join('、')}）`,
              409,
            );
          }
        },
        () => {
          mediaComponent.assertIdle();
          backups?.assertIdle();
          if (mutations > 1)
            throw new ProductError('DATA_WRITES_ACTIVE', '有其他操作正在保存，请稍后重试', 409);
        },
        persistence.bridge,
      );
      const captureDiagnostics = createDiagnosticSnapshotBuilder({
        dataDir,
        softwareVersion,
        extensionVersion: bundledExtension.version,
        workspaceService,
        taskService,
        groupInviterService,
        getGroupBumperService: () => groupBumperService,
        groupPosterService,
        tasksRepository: repository.tasks,
        taskTabsRepository: repository.taskTabs,
        core,
        getMainKernel: () => mainKernel,
        controllerLoopDelay,
        devDiagFlush: () => devDiagWriter.flush(),
        devDiagFilePath: devDiagWriter.filePath,
      });
      groupBumperServiceRef = groupBumperService;
      const wired = wireLifecycleAndMcpRuntime({
        softwareVersion,
        extensionVersion: bundledExtension.version,
        dataDir,
        port,
        core,
        store,
        repository,
        browserLabels,
        getMainKernel: () => mainKernel,
        publishingRuntime,
        workspaceService,
        taskService,
        inspection,
        featureExecution,
        groupPosterService,
        groupBumperService,
        groupInviterService,
        bluestacksService,
        captureDiagnostics,
        devDiagFilePath: devDiagWriter.filePath,
        reloadExtensions: (ids) => {
          if (!extensionUpdates) throw Error('EXTENSION_UPDATE_UNAVAILABLE');
          return extensionUpdates.reload(ids);
        },
        withMutation: async (work) => {
          dataCleanup?.assertNotResetting();
          mutations++;
          try {
            return await work();
          } finally {
            mutations--;
          }
        },
      });
      const { profileLifecycle } = wired;
      agentBrowserManagerRef = wired.agentBrowserManager;
      mcpHttpHandler = wired.mcpHttpHandler;
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
          (profileId) => featureExecution.isProfileBusy(profileId),
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
        captureDiagnostics,
        dataCleanup,
        windowLayout,
        mediaComponent,
        softwareUpdate,
        groupBumperService,
        (fileName, targetDir) => revealDiagnosticPackage(dataDir, fileName, targetDir),
        featureExecution,
        groupPosterService,
        (id) => Boolean(core.peers.get(id)?.online),
        bluestacksService,
        profileLifecycle,
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
const startupAvatarLocalization = scheduleStartupAccountAvatarLocalization({
  repository,
  inspection,
  isShuttingDown: () => shuttingDown,
  graphAvatarLookup: (accountId) => graphAvatar.lookup(accountId),
});
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  startupAvatarLocalization.cancel();
  controllerLoopDelay.disable();
  if (notificationTimer) clearInterval(notificationTimer);
  clearInterval(cleanupTimer);
  groupBumperServiceRef?.shutdown();
  await agentBrowserManagerRef?.closeAll().catch(() => {});
  await bluestacksServiceRef?.stopBumper().catch(() => {});
  bluestacksOcrClient?.close();
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
