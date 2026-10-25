import { mediaRuntimeComponent } from './infrastructure/media-runtime-component.js';
import { SoftwareUpdateService } from './application/software-update-service.js';
import { SoftwareUpdateBackend } from './infrastructure/software-update-backend.js';
import { ExtensionUpdates } from './infrastructure/extension-updates.js';
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
import { KernelAuditRunner } from './infrastructure/kernel-audit-runner.js';
import { KernelPersistenceAudit } from './infrastructure/kernel-persistence-audit.js';
import { KernelStartupAudit } from './infrastructure/kernel-startup-audit.js';
import { KernelActorAudit } from './infrastructure/kernel-actor-audit.js';
import { KernelLifecycleAudit } from './infrastructure/kernel-lifecycle-audit.js';
import { KernelStopRetryAudit } from './infrastructure/kernel-stop-retry-audit.js';
import { FacebookReadAudit } from './infrastructure/facebook-read-audit.js';
import { FacebookFollowupAudit } from './infrastructure/facebook-followup-audit.js';
import { KernelUploadAudit } from './infrastructure/kernel-upload-audit.js';
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
import { FacebookNativeIdentityAudit } from './infrastructure/facebook-native-identity-audit.js';
import { FacebookAdmissionAudit } from './infrastructure/facebook-admission-audit.js';
import { FacebookDraftAudit } from './infrastructure/facebook-draft-audit.js';
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
let kernelAudit: KernelAuditRunner | undefined;
let persistenceAudit: KernelPersistenceAudit | undefined;
let startupAudit: KernelStartupAudit | undefined;
let actorAudit: KernelActorAudit | undefined;
let lifecycleAudit: KernelLifecycleAudit | undefined;
let stopRetryAudit: KernelStopRetryAudit | undefined;
let facebookReadAudit: FacebookReadAudit | undefined;
let facebookFollowupAudit: FacebookFollowupAudit | undefined;
let uploadAudit: KernelUploadAudit | undefined;
let inspection: ProfileInspectionService | undefined;
let nativeReview: NativeReviewService | undefined;
let mainKernel: KernelBridge | undefined;
let nativeIdentityAudit: FacebookNativeIdentityAudit | undefined;
let admissionAudit: FacebookAdmissionAudit | undefined;
let draftAudit: FacebookDraftAudit | undefined;
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
            );
            kernel.setWindowLayoutHook(
              (id, guard) => layout.arrange(id, guard),
              () => layout.isEnabled(),
              (id, guard, deadline) => layout.recover(id, guard, deadline),
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
            if (
              process.env.WORKBENCH_DIAGNOSTICS === '1' &&
              process.env.WORKBENCH_NATIVE_IDENTITY_AUDIT === '1'
            )
              nativeIdentityAudit = new FacebookNativeIdentityAudit(
                kernel,
                core,
                repository.tasks,
                path.join(root, 'audit'),
                process.env.WORKBENCH_NATIVE_IDENTITY_DECISION_AUDIT === '1',
                process.env.WORKBENCH_NATIVE_IDENTITY_SDK_AUDIT === '1',
              );
            else if (
              process.env.WORKBENCH_DIAGNOSTICS === '1' &&
              (process.env.WORKBENCH_FACEBOOK_DRAFT_AUDIT === '1' ||
                process.env.WORKBENCH_FACEBOOK_VIDEO_DRAFT_AUDIT === '1' ||
                process.env.WORKBENCH_FACEBOOK_LAST_TWO_DRAFT_AUDIT === '1' ||
                process.env.WORKBENCH_FACEBOOK_REMAINING_DRAFT_AUDIT === '1')
            )
              draftAudit = new FacebookDraftAudit(
                kernel,
                core,
                path.join(root, 'audit'),
                process.env.WORKBENCH_FACEBOOK_REMAINING_DRAFT_AUDIT === '1',
                process.env.WORKBENCH_FACEBOOK_LAST_TWO_DRAFT_AUDIT === '1',
                process.env.WORKBENCH_FACEBOOK_VIDEO_DRAFT_AUDIT === '1',
              );
            else if (
              process.env.WORKBENCH_DIAGNOSTICS === '1' &&
              (process.env.WORKBENCH_FACEBOOK_ADMISSION_AUDIT === '1' ||
                process.env.WORKBENCH_FACEBOOK_EMPTY_COMPOSER_AUDIT === '1')
            )
              admissionAudit = new FacebookAdmissionAudit(
                kernel,
                core,
                path.join(root, 'audit'),
                process.env.WORKBENCH_FACEBOOK_EMPTY_COMPOSER_AUDIT === '1',
                process.env.WORKBENCH_FACEBOOK_EMPTY_COMPOSER_RECOVERY_AUDIT === '1',
              );
            else if (
              process.env.WORKBENCH_DIAGNOSTICS === '1' &&
              process.env.WORKBENCH_UPLOAD_AUDIT === '1'
            )
              uploadAudit = new KernelUploadAudit(kernel, core, root, repository);
            else if (
              process.env.WORKBENCH_DIAGNOSTICS === '1' &&
              process.env.WORKBENCH_FACEBOOK_FOLLOWUP_AUDIT === '1'
            )
              facebookFollowupAudit = new FacebookFollowupAudit(
                kernel,
                core,
                repository,
                path.join(root, 'audit'),
              );
            else if (
              process.env.WORKBENCH_DIAGNOSTICS === '1' &&
              process.env.WORKBENCH_FACEBOOK_READ_AUDIT === '1'
            )
              facebookReadAudit = new FacebookReadAudit(kernel, core, path.join(root, 'audit'));
            else if (
              process.env.WORKBENCH_DIAGNOSTICS === '1' &&
              process.env.WORKBENCH_STOP_RETRY_AUDIT === '1'
            )
              stopRetryAudit = new KernelStopRetryAudit(kernel, core, path.join(root, 'audit'));
            else if (
              process.env.WORKBENCH_DIAGNOSTICS === '1' &&
              process.env.WORKBENCH_LIFECYCLE_AUDIT === '1'
            )
              lifecycleAudit = new KernelLifecycleAudit(kernel, core, path.join(root, 'audit'));
            else if (
              process.env.WORKBENCH_DIAGNOSTICS === '1' &&
              process.env.WORKBENCH_ACTOR_FENCE_AUDIT === '1'
            )
              actorAudit = new KernelActorAudit(kernel, core, path.join(root, 'audit'));
            else if (
              process.env.WORKBENCH_DIAGNOSTICS === '1' &&
              process.env.WORKBENCH_STARTUP_AUDIT === '1'
            )
              startupAudit = new KernelStartupAudit(
                kernel,
                core,
                repository,
                path.join(root, 'audit'),
              );
            else if (
              process.env.WORKBENCH_DIAGNOSTICS === '1' &&
              process.env.WORKBENCH_KERNEL_AUDIT === '1'
            )
              kernelAudit = new KernelAuditRunner(kernel, core, path.join(root, 'audit'));
            else if (
              process.env.WORKBENCH_DIAGNOSTICS === '1' &&
              (process.env.WORKBENCH_KERNEL_PERSISTENCE_AUDIT === '1' ||
                process.env.WORKBENCH_TASK_TAB_AUDIT === '1')
            )
              persistenceAudit = new KernelPersistenceAudit(
                kernel,
                core,
                path.join(root, 'audit'),
                process.env.WORKBENCH_TASK_TAB_AUDIT === '1',
              );
            return {
              message: async (peer, value) => await kernel.message(peer, value),
              disconnected: (peer) => kernel.disconnected(peer),
              controlStopped: async (peer) => {
                kernel.controlStopped(peer);
                await publishingRuntime?.parentControlStopped(peer);
              },
              tick: async () => {
                kernel.tick();
                void browserLabels
                  .refresh((await core.store.profileList()).map((row) => String(row.profileId)))
                  .catch(() => {});
                kernelAudit?.tick();

                persistenceAudit?.tick();
                startupAudit?.tick();
                actorAudit?.tick();
                lifecycleAudit?.tick();
                stopRetryAudit?.tick();
                facebookReadAudit?.tick();
                facebookFollowupAudit?.tick();
                uploadAudit?.tick();
                nativeIdentityAudit?.tick();
                admissionAudit?.tick();
                draftAudit?.tick();
                void publishingRuntime
                  ?.tick()
                  .catch((error) => console.error('Publishing runtime failed', error));
              },
              close: async () => {
                kernelAudit?.disable();
                nativeIdentityAudit?.disable();
                persistenceAudit?.disable();
                startupAudit?.disable();
                actorAudit?.disable();
                lifecycleAudit?.disable();
                stopRetryAudit?.disable();
                facebookReadAudit?.disable();
                facebookFollowupAudit?.disable();
                uploadAudit?.disable();
                const settling = inspection?.close();
                await admissionAudit?.close();
                await draftAudit?.close();
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
          groupInviterService.hasActiveExecution(),
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
          async (profileId) => {
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
        ),
        () => {
          dataCleanup?.assertNotResetting();
          backups?.assertIdle();
          softwareUpdate?.assertIdle();
        },
      );
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
          groupInviterService.isProfileRunning(id) ||
          (await repository.tasks.hasProfilePlanInStates(id, [
            'QUEUED',
            'RUNNING',
            'PAUSING',
            'STOPPING',
          ])),
        async (peer) => {
          await mainKernel?.releaseIdleForExtension(peer);
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
              groupInviterService.hasActiveExecution() ||
              publishingRuntime?.hasActiveExecution() ||
              (await repository.tasks.livePlans()).some((p) =>
                ['RUNNING', 'PAUSING', 'STOPPING'].includes(p.state),
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
            const active = (await repository.tasks.plansForProfile(profileId, ['RUNNING']))[0];
            const proof = active
              ? (await repository.taskTabs.forPlan(active.id)).find((row) => row.state === 'READY')
                  ?.proof
              : await repository.tasks.retainedTaskPage(profileId);
            if (!peer || !mainKernel) return null;
            try {
              // A released historical page may belong to an earlier browser session.
              if (!active && peer.capabilities?.includes('kernel-workspace-main-proof-v1'))
                return await mainKernel.revealRegisteredFacebookPage(peer);
              if (!proof) return null;
              return await mainKernel.revealOwnedFacebookPage(peer, proof);
            } catch (error) {
              const nativeCode =
                error instanceof Error &&
                /^(WORKSPACE_REVEAL_[A-Z_]+|KERNEL_[A-Z_]+)$/.test(error.message)
                  ? error.message
                  : 'WORKSPACE_REVEAL_UNAVAILABLE';
              const code =
                nativeCode === 'KERNEL_PROFILE_NOT_IDLE'
                  ? 'WORKSPACE_REVEAL_CHANNEL_BUSY'
                  : nativeCode;
              console.error(
                JSON.stringify({
                  event: 'WORKSPACE_REVEAL_FAILED',
                  profileId,
                  code,
                  trace: mainKernel.diagnostics(profileId).slice(-16),
                }),
              );
              throw new ProductError(
                code,
                code === 'WORKSPACE_REVEAL_CHANNEL_BUSY'
                  ? '控制通道正在建立或检查，请稍后显示原主页面'
                  : '主工作页暂不能显示，请查看连接状态和具体原因',
                409,
              );
            }
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
          (profileId) => groupInviterService.isProfileRunning(profileId),
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
        async (note?: string) => {
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
          const profileSummaries = wsSnapshot.profiles.map((p) => ({
            id: p.id,
            name: p.alias || p.browserName || p.id.slice(0, 8),
            online: p.online,
            phase: p.phase,
            synced: p.synced,
            profileWindowFocused: core.peers.get(p.id)?.profileWindowFocused ?? null,
            focusedWindowAt: core.peers.get(p.id)?.focusedWindowAt ?? null,
            presentationRecoverySupported:
              core.peers.get(p.id)?.capabilities?.includes('task-presentation-recovery-v1') ??
              false,
            unresolved: p.unresolved,
            accountState: p.account.state,
            accountName: p.account.name ?? null,
            kernelTraceTail: mainKernel ? mainKernel.diagnostics(p.id).slice(-20) : [],
          }));
          const inviterState = await groupInviterService.state();
          const entry = devDiag.record({
            level: 'SNAPSHOT',
            category: 'SNAPSHOT',
            event: 'USER_MANUAL_SNAPSHOT',
            reason: note?.trim() || 'USER_CLICKED_SNAPSHOT_BUTTON',
            data: {
              softwareVersion,
              controllerLoopDelay: {
                resolutionMs: 20,
                samples: controllerLoopDelay.count,
                maxSampleIntervalMs: controllerLoopDelay.count
                  ? controllerLoopDelay.max / 1e6
                  : null,
                p99SampleIntervalMs: controllerLoopDelay.count
                  ? controllerLoopDelay.percentile(99) / 1e6
                  : null,
              },
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
            },
          });
          return {
            filePath: devDiagWriter.filePath,
            entryId: entry.id,
            at: entry.at,
          };
        },
        dataCleanup,
        windowLayout,
        mediaComponent,
        softwareUpdate,
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
