import { readdir, rm, stat } from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';
import type { IntervalHistogram } from 'node:perf_hooks';
import { z } from 'zod';
import { isLocalAvatar } from '../shared/group-bumper.js';
import type { CacheOverview } from '../shared/material-cache-management.js';
import { GroupBumperService } from '../application/group-bumper-service.js';
import { GroupPosterService } from '../application/group-poster-service.js';
import { AutoSchedulerService } from '../application/auto-scheduler-service.js';
import { GoogleSheetsService } from '../application/google-sheets-service.js';
import { GroupInviterService } from '../application/group-inviter-service.js';
import { TaskService } from '../application/task-service.js';
import { ResourceTableService } from '../application/resource-table-service.js';
import { ResourceDownloadService } from '../application/resource-download-service.js';
import {
  MaterialUsageService,
  MaterialCacheManagement,
  WorkspaceMaintenance,
  type MaterialCacheBackend,
} from '../application/workspace-media-maintenance.js';
import { WorkspaceService } from '../application/workspace-service.js';
import { WorkspaceBackupService } from '../application/workspace-backup-service.js';
import { DataCleanupService } from '../application/data-cleanup.js';
import { SoftwareUpdateService } from '../application/software-update-service.js';
import {
  FeatureExecutionRegistry,
  ensureFeatureExecutionRegistry,
} from '../application/feature-execution-registry.js';
import {
  createGlobalAccountAbnormalReporter,
  type GlobalAccountAbnormalReporter,
} from '../application/account-abnormal-reporter.js';
import { taskBlocksSoftwareUpdate } from '../domain/system-ports.js';
import { ProductError, failError } from '../domain/workspace.js';
import { GroupBumperBrowserAdapter } from './group-bumper-runner.js';
import { TargetMetadataRefreshService } from './target-metadata-refresh.js';
import { FilesystemPosterMediaPreparer, GroupPosterBrowserAdapter } from './group-poster-runner.js';
import { GroupInviterBrowserAdapter } from './group-inviter-runner.js';
import { mediaRuntimeComponent } from './media-runtime-component.js';
import { SoftwareUpdateBackend } from './software-update-backend.js';
import { ExtensionUpdates, extensionReloadTasksBusy } from './extension-updates.js';
import { productAiWorkspaceDirectory } from './ai-workspace.js';
import { productExtensionDirectory } from './paths.js';
import { LogCleanup } from './log-cleanup.js';
import { prepareWorkspaceReset } from './workspace-reset.js';
import { FilesystemWorkspaceBackupWriter } from './workspace-backup-writer.js';
import { FilesystemWorkspaceRestore } from './workspace-restore.js';
import { BridgeProfileSource } from './browser-source.js';
import { BridgeBrowserWindow } from './bridge-browser-window.js';
import { PublicResourceDriveDownloader } from './resource-drive-downloader.js';
import { FilesystemResourceSourceReader } from './resource-source-reader.js';
import { createDiagnosticSnapshotBuilder, revealDiagnosticPackage } from './diagnostic-package.js';
import { GoogleOAuthManager } from './google-oauth.js';
import { GoogleSheetsRestClient } from './google-sheets-client.js';
import { SheetImageHostClient } from './sheet-image-host.js';
import { GoogleSheetsAutomationBridge } from './google-sheets-automation-bridge.js';
import {
  createBluestacksRuntime,
  openDesktopAiWorkspaceViaParent,
  openDesktopExtensionDirViaParent,
  schedulePosterDriveCacheCleanup,
  wireLifecycleAndMcpRuntime,
} from './mcp/mcp-runtime-wiring.js';
import type { AgentBrowserManager } from './mcp/agent-browser-manager.js';
import type { WindowsOcrClient } from './bluestacks-vision.js';
import type { BluestacksService } from '../application/bluestacks-service.js';
import type { ProfileInspectionService } from '../application/profile-inspection.js';
import type { WindowLayoutService } from '../application/window-layout.js';
import type { Core } from '../bridge/core.js';
import type { BridgeStorePort, WorkspaceStorePort as WorkspaceStore } from './persistence-port.js';
import type { PersistenceClient } from './persistence-client.js';
import type { Workboard } from '../application/workboard.js';
import type { LocalBrowserLabels } from './local-browser-labels.js';
import type { FilesystemRuntimeLog } from './runtime-log.js';
import type { DevDiagnosticsFileWriter } from './dev-diagnostics-writer.js';
import type { KernelBridge } from './kernel-bridge.js';
import type { ActiveAccountRuntime } from './active-account-runtime.js';
import type { DailyRiskActionKind } from '../shared/daily-risk-limits.js';
import type { ProfileLifecyclePort } from '../shared/profile-lifecycle.js';
import type { WorkspaceEventHub } from '../application/workspace-event-hub.js';
interface ServerRoutesContextRefs {
  getShuttingDown: () => boolean;
  getInspection: () => ProfileInspectionService | undefined;
  getMainKernel: () => KernelBridge | undefined;
  getActiveRuntime: () => ActiveAccountRuntime | undefined;
  getWindowLayout: () => WindowLayoutService | undefined;
  setExtensionUpdates: (v: ExtensionUpdates) => void;
  getExtensionUpdates: () => ExtensionUpdates | undefined;
  setSoftwareUpdate: (v: SoftwareUpdateService) => void;
  getSoftwareUpdate: () => SoftwareUpdateService | undefined;
  setBackups: (v: WorkspaceBackupService) => void;
  getBackups: () => WorkspaceBackupService | undefined;
  setDataCleanup: (v: DataCleanupService) => void;
  getDataCleanup: () => DataCleanupService | undefined;
  setFeatureExecution: (v: FeatureExecutionRegistry) => void;
  setAccountAbnormalReporter: (v: GlobalAccountAbnormalReporter) => void;
  setProfileLifecycle: (v: ProfileLifecyclePort) => void;
  setScheduleOfflineHygiene: (fn: (profileId: string) => void) => void;
  setAutoInspectSweep: (fn: () => Promise<void>) => void;
  setBluestacksOcrClient: (v: WindowsOcrClient | undefined) => void;
  setBluestacksService: (v: BluestacksService) => void;
  setGroupBumperService: (v: GroupBumperService) => void;
  setGroupPosterService: (v: GroupPosterService) => void;
  setGroupInviterService: (v: GroupInviterService) => void;
  setAutoSchedulerService: (v: AutoSchedulerService) => void;
  getAutoSchedulerService: () => AutoSchedulerService | undefined;
  setGoogleSheetsService: (v: GoogleSheetsService) => void;
  getGoogleSheetsService: () => GoogleSheetsService | undefined;
  setAgentBrowserManager: (v: AgentBrowserManager) => void;
  setMcpHttpHandler: (
    h: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>,
  ) => void;
}
const NON_MUTATING_POST_ROUTES = new Set([
  '/api/workspace/google-sheets/links/poll-schedule',
  '/api/workspace/google-sheets/links/poll-records',
  '/api/workspace/google-sheets/links/refresh-metrics',
  '/api/workspace/google-sheets/links/sync-library',
  '/api/workspace/google-sheets/links/import-library',
  '/api/workspace/tasks/records',
  '/api/workspace/resource-tables/read',
  '/api/workspace/data-cleanup/preview',
]);
const UuidSchema = z.uuid();
async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirBytes(full);
    else if (e.isFile()) total += (await stat(full).catch(() => null))?.size ?? 0;
  }
  return total;
}
function directCacheBackend(root: string): MaterialCacheBackend {
  return {
    async snapshot(): Promise<CacheOverview> {
      const dirents = await readdir(root, { withFileTypes: true }).catch(() => []);
      const entries: CacheOverview['entries'] = [];
      for (const d of dirents) {
        if (!d.isDirectory() || !UuidSchema.safeParse(d.name).success) continue;
        entries.push({
          stageId: d.name,
          bytes: await dirBytes(path.join(root, d.name)),
          eligible: true,
          reason: '',
        });
        if (entries.length >= 200) break;
      }
      return { version: 1, entries, truncated: dirents.length > entries.length };
    },
    async cleanStage(stageId: string) {
      await rm(path.join(root, UuidSchema.parse(stageId)), { recursive: true, force: true });
      return { cleaned: true, reason: '' };
    },
  };
}
export function buildServerAppRoutes({
  root,
  dataDir,
  uploadCacheRoot,
  port,
  softwareVersion,
  bundledExtensionVersion,
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
  refs,
}: {
  root: string;
  dataDir: string;
  uploadCacheRoot: string;
  port: number;
  softwareVersion: string;
  bundledExtensionVersion: string;
  core: Core;
  store: BridgeStorePort;
  repository: WorkspaceStore;
  persistence: PersistenceClient;
  workboard: Workboard;
  browserLabels: LocalBrowserLabels;
  runtimeLog: FilesystemRuntimeLog;
  devDiagWriter: DevDiagnosticsFileWriter;
  controllerLoopDelay: IntervalHistogram;
  eventHub: WorkspaceEventHub;
  refs: ServerRoutesContextRefs;
}) {
  const featureExecution = new FeatureExecutionRegistry();
  refs.setFeatureExecution(featureExecution);
  const backups = new WorkspaceBackupService(
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
  refs.setBackups(backups);
  const workspaceService = new WorkspaceService(
    repository,
    new BridgeProfileSource(
      core,
      store,
      refs.getInspection(),
      browserLabels,
      (id) => refs.getMainKernel()?.presentationStatus(id) ?? null,
    ),
  );
  const autoLayoutArranged = new Map<string, string>();
  refs.setAutoInspectSweep(async () => {
    if (refs.getShuttingDown() || process.env.WORKBENCH_DIAGNOSTICS === '1') return;
    const layout = refs.getWindowLayout();
    const layoutEnabled = layout?.isEnabled() === true;
    const layoutGen = layout?.currentGeneration() ?? 0;
    if (!layoutEnabled) autoLayoutArranged.clear();
    else {
      for (const [pid, tag] of autoLayoutArranged) {
        const peer = core.peers.get(pid);
        if (!peer?.online || peer.browserWindowCount === 0 || tag !== `${peer.epoch}:${layoutGen}`)
          autoLayoutArranged.delete(pid);
      }
    }
    const activeInspection = refs.getInspection();
    const cache = activeInspection ? await repository.profileAccountCache() : null;
    const candidates: string[] = [];
    for (const peer of core.peers.values()) {
      if (!peer.online || !peer.synced || peer.phase !== 'PAUSED' || peer.browserWindowCount === 0)
        continue;
      if (await featureExecution.isProfileBusy(peer.profileId)) continue;
      if (layout && layoutEnabled) {
        const tag = `${peer.epoch}:${layoutGen}`;
        if (autoLayoutArranged.get(peer.profileId) !== tag) {
          autoLayoutArranged.set(peer.profileId, tag);
          void layout.arrange(peer.profileId).catch(() => {});
        }
      }
      if (!activeInspection || !peer.capabilities?.includes('facebook-existing-display-v1'))
        continue;
      const cached = cache?.get(peer.profileId);
      if (cached?.id && isLocalAvatar(cached.avatar)) continue;
      candidates.push(peer.profileId);
    }
    if (activeInspection && candidates.length > 0) activeInspection.observeConnections(candidates);
  });
  const assertSystemIdle = () => {
    refs.getDataCleanup()?.assertNotResetting();
    refs.getBackups()?.assertIdle();
    refs.getSoftwareUpdate()?.assertIdle();
  };
  const taskService = new TaskService(
    repository.tasks,
    () => refs.getActiveRuntime(),
    assertSystemIdle,
  );
  taskService.setWorkboard(workboard);
  let groupBumperService: GroupBumperService | undefined;
  featureExecution.register({
    id: 'active-accounts',
    label: '活跃账号',
    isProfileRunning: (profileId) =>
      workboard.carrierModule(profileId) === 'active-accounts' ||
      repository.tasks.hasProfilePlanInStates(profileId, ['QUEUED', 'RUNNING']),
    hasActiveExecution: () =>
      workboard.isModuleActive('active-accounts') ||
      refs.getActiveRuntime()?.hasActiveExecution() === true,
    stopProfiles: async (profileIds) => {
      await Promise.all(profileIds.map((id) => taskService.stopActiveProfile(id)));
    },
  });
  const toAcctPatch = (p: {
    state: 'unknown' | 'logged-in' | 'logged-out' | 'restricted' | 'verification';
    accountId?: string | null;
    name?: string | null;
    avatar?: string | null;
  }) => ({
    state: p.state,
    ...(typeof p.accountId === 'string' ? { accountId: p.accountId } : {}),
    ...(typeof p.name === 'string' ? { name: p.name } : {}),
    ...(p.avatar !== undefined ? { avatar: p.avatar } : {}),
  });
  const accountAbnormalReporter = createGlobalAccountAbnormalReporter({
    updateProfileAccountCache: (profileId, patch) => {
      const { accountId, ...rest } = toAcctPatch(patch);
      return repository.updateProfileAccountCache(profileId, {
        ...rest,
        ...(accountId !== undefined ? { id: accountId } : {}),
        scope: patch.scope,
      });
    },
    syncExternalObservation: (profileId, patch) =>
      refs.getInspection()?.syncExternalObservation(profileId, toAcctPatch(patch)),
  });
  refs.setAccountAbnormalReporter(accountAbnormalReporter);
  const getKernel = () => refs.getMainKernel(),
    bumperAdapter = new GroupBumperBrowserAdapter(
      repository.groupBumper,
      getKernel,
      () => core,
      (id) => featureExecution.isProfileBusy(id, ['group-bumper', 'page-bumper']),
      1,
      accountAbnormalReporter,
    );
  const targetMetadataRefresh = new TargetMetadataRefreshService(bumperAdapter);
  const groupInviterService = new GroupInviterService(
    repository.groupInviter,
    new GroupInviterBrowserAdapter(
      repository.groupInviter,
      getKernel,
      () => core,
      (profileId) => featureExecution.isProfileBusy(profileId, 'group-inviter'),
      accountAbnormalReporter,
    ),
    assertSystemIdle,
    (items, options) => targetMetadataRefresh.refreshTargetBatch('groups', items, options),
    () => targetMetadataRefresh.stopRefresh('groups'),
  );
  groupInviterService.setFeatureExecutionRegistry(featureExecution);
  groupInviterService.setWorkboard(workboard);
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
  groupBumperService.setWorkboard(workboard);
  const mediaComponent = mediaRuntimeComponent(dataDir);
  const posterAdapter = new GroupPosterBrowserAdapter(
    repository.groupBumper,
    getKernel,
    () => core,
    (id) => featureExecution.isProfileBusy(id, 'group-poster'),
    1,
    repository.groupPoster,
    accountAbnormalReporter,
  );
  const posterMediaPreparer = new FilesystemPosterMediaPreparer(
    path.join(uploadCacheRoot, 'group-poster-media'),
    fetch,
    mediaComponent,
  );
  const groupPosterService = new GroupPosterService(
    repository.groupPoster,
    posterAdapter,
    posterMediaPreparer,
    featureExecution,
    assertSystemIdle,
    (kind, items, options) => targetMetadataRefresh.refreshTargetBatch(kind, items, options),
    () => targetMetadataRefresh.stopRefresh('groups'),
  );
  groupPosterService.setWorkboard(workboard);
  const bsRuntime = createBluestacksRuntime(repository, featureExecution, groupPosterService);
  refs.setBluestacksOcrClient(bsRuntime.ocrClient);
  const bluestacksService = bsRuntime.service;
  bluestacksService.setWorkboard(workboard);
  refs.setBluestacksService(bluestacksService);
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
    extensionVersion: bundledExtensionVersion,
  });
  const extensionUpdates = new ExtensionUpdates(
    core,
    bundledExtensionVersion,
    productExtensionDirectory(),
    async (id) =>
      (await featureExecution.isProfileBusy(id)) ||
      workboard.isCarrierBusy(id) ||
      core.hasPendingControlOrOperation(id) ||
      (await extensionReloadTasksBusy(repository.tasks, id)),
    async (peer) => {
      await refs.getMainKernel()?.releaseIdleForExtension(peer);
    },
  );
  refs.setExtensionUpdates(extensionUpdates);
  const softwareUpdate = new SoftwareUpdateService(
    {
      readConfig: () => updaterBackend.readConfig(),
      saveConfig: (config) => updaterBackend.saveConfig(config),
      check: (repo) => updaterBackend.check(repo),
      install: async (release, guard) => {
        await updaterBackend.install(release, guard);
        if (release.extensionVersion)
          refs.getExtensionUpdates()?.setVersion(release.extensionVersion);
      },
      assertCanApply: async () => {
        if (!process.parentPort)
          throw new ProductError('UPDATE_DESKTOP_REQUIRED', '请在桌面工作台中执行更新', 409);
        const activeLabels = await featureExecution.activeModuleLabels();
        const hasLiveTaskPlan = (await repository.tasks.livePlans()).some((p) =>
          taskBlocksSoftwareUpdate(
            p.state,
            core.peers.get(p.profileId)?.online === true,
            workboard.isCarrierBusy(p.profileId),
          ),
        );
        if (activeLabels.length > 0 || hasLiveTaskPlan)
          failError(
            'UPDATE_TASKS_ACTIVE',
            `当前有任务正在运行${activeLabels.length > 0 ? `（${activeLabels.join('、')}）` : ''}，请先暂停或停止任务后再执行一键更新`,
            409,
          );
        backups.assertIdle();
      },
      restart: () => process.parentPort?.postMessage({ type: 'REQUEST_RESTART' }),
      reloadExtensions: (ids) => extensionUpdates.reload(ids),
      openExtensionDirectory: () => openDesktopExtensionDirViaParent(),
      openAiWorkspaceDirectory: () => openDesktopAiWorkspaceViaParent(root, softwareVersion),
    },
    {
      software: softwareVersion,
      extension: bundledExtensionVersion,
      directory: productExtensionDirectory(),
      aiWorkspaceDirectory: productAiWorkspaceDirectory(),
    },
  );
  refs.setSoftwareUpdate(softwareUpdate);
  let mutations = 0;
  const dataCleanup = new DataCleanupService(
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
      if (activeLabels.length > 0)
        failError(
          'RESET_TASKS_ACTIVE',
          `请先停止当前正在执行的任务（${activeLabels.join('、')}）`,
          409,
        );
    },
    () => {
      mediaComponent.assertIdle();
      backups.assertIdle();
      if (mutations > 1)
        throw new ProductError('DATA_WRITES_ACTIVE', '有其他操作正在保存，请稍后重试', 409);
    },
    persistence.bridge,
  );
  refs.setDataCleanup(dataCleanup);
  const captureDiagnostics = createDiagnosticSnapshotBuilder({
    dataDir,
    softwareVersion,
    extensionVersion: bundledExtensionVersion,
    workspaceService,
    taskService,
    groupInviterService,
    getGroupBumperService: () => groupBumperService,
    groupPosterService,
    getBluestacksService: () => bluestacksService,
    getWindowLayout: refs.getWindowLayout,
    getAutoSchedulerService: refs.getAutoSchedulerService,
    getGoogleSheetsService: refs.getGoogleSheetsService,
    postBumpRecords: repository.postBumpRecords,
    tasksRepository: repository.tasks,
    core,
    getMainKernel: () => refs.getMainKernel(),
    controllerLoopDelay,
    devDiagFlush: () => devDiagWriter.flush(),
    devDiagFilePath: devDiagWriter.filePath,
  });
  refs.setGroupBumperService(groupBumperService);
  refs.setGroupPosterService(groupPosterService);
  refs.setGroupInviterService(groupInviterService);
  const browserWindow = new BridgeBrowserWindow(
    core,
    repository.tasks,
    async (profileId) => {
      const peer = core.peers.get(profileId),
        kernel = refs.getMainKernel();
      return peer && kernel ? kernel.revealRegisteredFacebookPage(peer) : null;
    },
    async (profileId, preferActiveTab = true) => {
      const peer = core.peers.get(profileId),
        kernel = refs.getMainKernel();
      if (!peer || !kernel)
        throw new ProductError('WORKSPACE_CLEANUP_UNAVAILABLE', '浏览器未连接或内核未就绪', 409);
      return kernel.consolidateFacebookWorkspace(peer, preferActiveTab);
    },
    async (profileId) =>
      workboard.isCarrierBusy(profileId) || (await featureExecution.isProfileBusy(profileId)),
  );
  const wired = wireLifecycleAndMcpRuntime({
    softwareVersion,
    extensionVersion: bundledExtensionVersion,
    dataDir,
    port,
    core,
    store,
    repository,
    browserLabels,
    getMainKernel: () => refs.getMainKernel(),
    activeRuntime: refs.getActiveRuntime(),
    workspaceService,
    taskService,
    inspection: refs.getInspection(),
    featureExecution,
    groupPosterService,
    groupBumperService,
    groupInviterService,
    bluestacksService,
    getAutoSchedulerService: () => refs.getAutoSchedulerService(),
    getGoogleSheetsService: () => refs.getGoogleSheetsService(),
    browserWindow,
    windowLayout: refs.getWindowLayout(),
    captureDiagnostics,
    devDiagFilePath: devDiagWriter.filePath,
    reloadExtensions: (ids) => extensionUpdates.reload(ids),
    withMutation: async (work) => {
      dataCleanup.assertNotResetting();
      mutations++;
      try {
        return await work();
      } finally {
        mutations--;
      }
    },
  });
  const { profileLifecycle } = wired;
  refs.setProfileLifecycle(profileLifecycle);
  refs.setScheduleOfflineHygiene((id) => profileLifecycle.scheduleOfflineTabGroupHygiene(id));
  const syncConcurrency = async (
    browserConcurrency: number,
    bluestacksConcurrency: number,
    launchStaggerMs?: number,
  ): Promise<void> => {
    workboard.setConcurrencyLimits({
      browserConcurrency,
      bluestacksConcurrency,
      ...(launchStaggerMs !== undefined ? { launchStaggerMs } : {}),
    });
    await Promise.all([
      taskService.syncMaxConcurrency(browserConcurrency),
      groupPosterService.syncMaxConcurrency(browserConcurrency),
      groupBumperService.syncMaxConcurrency(browserConcurrency),
      groupInviterService.syncMaxConcurrency(browserConcurrency),
      googleSheetsService?.syncMaxConcurrency(browserConcurrency, bluestacksConcurrency),
      bluestacksService.syncMaxConcurrency(bluestacksConcurrency),
    ]);
  };
  const autoSchedulerService = new AutoSchedulerService(repository.autoScheduler, {
    workspace: workspaceService,
    workboard,
    tasks: taskService,
    groupBumper: groupBumperService,
    groupPoster: groupPosterService,
    groupInviter: groupInviterService,
    bluestacks: bluestacksService,
    profileLifecycle,
    featureExecution,
    assertAllowed: assertSystemIdle,
    onConcurrencyChanged: (next) =>
      syncConcurrency(next.browserConcurrency, next.bluestacksConcurrency),
  });
  refs.setAutoSchedulerService(autoSchedulerService);
  const checkBrowserRiskLimit = (profileId: string, actionKind: DailyRiskActionKind) =>
    repository.activityStats.checkBrowserRiskLimit(profileId, actionKind);
  const googleOAuthManager = new GoogleOAuthManager(repository.googleSheets);
  const googleSheetsService = new GoogleSheetsService(repository.googleSheets, {
    workspace: workspaceService,
    groupBumper: groupBumperService,
    bluestacks: bluestacksService,
    oauth: googleOAuthManager,
    sheetsApi: new GoogleSheetsRestClient(googleOAuthManager),
    imageHost: new SheetImageHostClient(repository.googleSheets, googleOAuthManager),
    automation: new GoogleSheetsAutomationBridge(
      core,
      () => refs.getMainKernel() ?? null,
      posterAdapter,
      posterMediaPreparer,
      repository.groupBumper,
      googleOAuthManager,
    ),
    prepareMaterialMedia: async (mediaSource) => {
      const prep = await posterMediaPreparer.prepareWithOAuthFallback(mediaSource, () =>
        googleOAuthManager.getValidAccessToken(),
      );
      return {
        localFilePath: prep.localFilePath,
        mediaKind: prep.mediaKind === 'video' ? 'video' : 'image',
        thumbnailDataUrl: prep.thumbnailDataUrl ?? null,
        isTemporaryCache: prep.isTemporaryCache,
      };
    },
    cleanupPreparedMedia: (localFilePath) =>
      posterMediaPreparer.removeCachedDriveFile(localFilePath).then(() => undefined),
    workboard,
    checkDailyRiskLimit: checkBrowserRiskLimit,
    featureExecution,
    profileLifecycle,
    assertSystemIdle,
    postBumpRecords: repository.postBumpRecords,
  });
  featureExecution.register({
    id: 'google-sheets',
    label: 'Google 云表协同',
    isProfileRunning: (profileId) => googleSheetsService.isProfileRunning(profileId),
    hasActiveExecution: () => googleSheetsService.hasActiveExecution(),
    stopProfiles: (profileIds) => googleSheetsService.stopProfiles(profileIds),
  });
  refs.setGoogleSheetsService(googleSheetsService);
  groupPosterService.setPostBumpRecords(repository.postBumpRecords);
  groupBumperService.setPostBumpRecords(repository.postBumpRecords);
  bluestacksService.setPostBumpRecords(repository.postBumpRecords);
  groupPosterService.setCheckDailyRiskLimit(checkBrowserRiskLimit);
  groupBumperService.setCheckDailyRiskLimit(checkBrowserRiskLimit);
  groupInviterService.setCheckDailyRiskLimit(checkBrowserRiskLimit);
  void posterMediaPreparer.pruneOldCachedFiles(24 * 60 * 60_000).catch(() => {});
  void Promise.resolve(repository.autoScheduler.settings())
    .then((s) =>
      syncConcurrency(s.browserConcurrency, s.bluestacksConcurrency, s.launchStaggerSeconds * 1000),
    )
    .catch(() => {});
  refs.setAgentBrowserManager(wired.agentBrowserManager);
  refs.setMcpHttpHandler(wired.mcpHttpHandler);
  const apiArgs = [
    workspaceService,
    taskService,
    refs.getInspection(),
    new ResourceTableService(
      repository.resourceTables,
      new FilesystemResourceSourceReader(),
      Date.now,
      new ResourceDownloadService(
        repository.resourceTables,
        new PublicResourceDriveDownloader(path.join(dataDir, 'resource-downloads')),
      ),
    ),
    new MaterialUsageService(repository.materialUsage),
    backups,
    process.parentPort
      ? { restart: () => process.parentPort?.postMessage({ type: 'REQUEST_RESTART' }) }
      : undefined,
    browserWindow,
    new MaterialCacheManagement(directCacheBackend(uploadCacheRoot)),
    new WorkspaceMaintenance(repository, runtimeLog, {
      logDirectory: runtimeLog.directory,
      cacheDirectory: uploadCacheRoot,
    }),
    groupInviterService,
    captureDiagnostics,
    dataCleanup,
    refs.getWindowLayout(),
    mediaComponent,
    softwareUpdate,
    groupBumperService,
    (fileName?: string, targetDir?: string) =>
      revealDiagnosticPackage(dataDir, fileName, targetDir),
    featureExecution,
    groupPosterService,
    (id: string) => Boolean(core.peers.get(id)?.online),
    bluestacksService,
    profileLifecycle,
    autoSchedulerService,
    googleSheetsService,
    repository.postBumpRecords,
    eventHub,
    repository.activityStats,
    (id: string) => workboard.isCarrierBusy(id),
  ] as const;
  return {
    apiArgs,
    wrapHandler:
      (
        handler: (
          req: http.IncomingMessage,
          res: http.ServerResponse,
          route: string,
          input?: unknown,
        ) => Promise<boolean>,
      ) =>
      async (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        route: string,
        input?: unknown,
      ) => {
        if (
          req.method !== 'POST' ||
          NON_MUTATING_POST_ROUTES.has((req.url ?? '').split('?')[0] ?? '')
        )
          return handler(req, res, route, input);
        mutations++;
        try {
          return await handler(req, res, route, input);
        } finally {
          mutations--;
        }
      },
  };
}
