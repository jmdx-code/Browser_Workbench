import { existsSync } from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import type { AutoSchedulerService } from '../../application/auto-scheduler-service.js';
import { BluestacksService } from '../../application/bluestacks-service.js';
import type { FeatureExecutionRegistry } from '../../application/feature-execution-registry.js';
import type { GoogleSheetsService } from '../../application/google-sheets-service.js';
import type { GroupBumperService } from '../../application/group-bumper-service.js';
import type { GroupInviterService } from '../../application/group-inviter-service.js';
import type { GroupPosterService } from '../../application/group-poster-service.js';
import type { ProfileInspectionService } from '../../application/profile-inspection.js';
import type { TaskService } from '../../application/task-service.js';
import type { WorkspaceService } from '../../application/workspace-service.js';
import type { Core } from '../../bridge/core.js';
import { ProductError } from '../../domain/workspace.js';
import type { BrowserWindowPort } from '../../shared/browser-window.js';
import type { PosterMaterial } from '../../shared/group-poster.js';
import type { ReloadResult } from '../../shared/software-update.js';
import type { WindowLayoutPort } from '../../shared/window-layout.js';
import type { ActiveAccountRuntime } from '../active-account-runtime.js';
import { syncProductAiWorkspaceDirectory } from '../ai-workspace.js';
import { BluestacksActiveRunner } from '../bluestacks-active-runner.js';
import { BluestacksGroupBumperRunner } from '../bluestacks-bumper-runner.js';
import { BluestacksDeviceManager } from '../bluestacks-device-manager.js';
import { BluestacksGroupInviterRunner } from '../bluestacks-inviter-runner.js';
import { BluestacksGroupPosterRunner } from '../bluestacks-poster-runner.js';
import { WindowsOcrClient } from '../bluestacks-vision.js';
import { BrowserLifecycleManager } from '../browser-lifecycle-manager.js';
import type { KernelBridge } from '../kernel-bridge.js';
import type { LocalBrowserLabels } from '../local-browser-labels.js';
import type { BridgeStorePort, WorkspaceStorePort } from '../persistence-port.js';
import {
  cleanupAllLocalBrowserProfiles,
  cleanupOfflineRegisteredProfiles,
  defaultLocalBrowserUserDataRoots,
} from '../saved-tab-groups-hygiene.js';
import { AgentBrowserManager } from './agent-browser-manager.js';
import type { WorkbenchMcpDependencies } from './mcp-context.js';
import { createWorkbenchMcpHttpHandler } from './mcp-server.js';
export interface McpRuntimeWiringInput {
  softwareVersion: string;
  extensionVersion: string;
  dataDir: string;
  port: number;
  core: Core;
  store: BridgeStorePort;
  repository: WorkspaceStorePort;
  browserLabels: LocalBrowserLabels;
  getMainKernel: () => KernelBridge | undefined;
  activeRuntime?: ActiveAccountRuntime | undefined;
  workspaceService: WorkspaceService;
  taskService: TaskService;
  inspection?: ProfileInspectionService | undefined;
  featureExecution: FeatureExecutionRegistry;
  groupPosterService: GroupPosterService;
  groupBumperService: GroupBumperService;
  groupInviterService: GroupInviterService;
  bluestacksService: BluestacksService;
  getAutoSchedulerService?: (() => AutoSchedulerService | undefined) | undefined;
  getGoogleSheetsService?: (() => GoogleSheetsService | undefined) | undefined;
  browserWindow?: BrowserWindowPort | undefined;
  windowLayout?: WindowLayoutPort | undefined;
  captureDiagnostics: WorkbenchMcpDependencies['captureDiagnostics'];
  devDiagFilePath: string;
  reloadExtensions: (ids?: string[]) => Promise<ReloadResult>;
  withMutation: <T>(work: () => Promise<T>) => Promise<T>;
}
export function createBluestacksRuntime(
  repository: WorkspaceStorePort,
  featureExecution: FeatureExecutionRegistry,
  posterMediaSource?:
    GroupPosterService | ((mediaSource: string) => Promise<{ localFilePath: string }>),
) {
  const ocrClient = new WindowsOcrClient();
  const devices = new BluestacksDeviceManager(repository.bluestacks, ocrClient);
  const ensurePosterMaterialLocal = posterMediaSource
    ? async (mat: PosterMaterial) => {
        if (!mat.mediaSource.trim()) return mat;
        if (typeof posterMediaSource === 'function')
          return mat.localFilePath && existsSync(mat.localFilePath)
            ? mat
            : { ...mat, localFilePath: (await posterMediaSource(mat.mediaSource)).localFilePath };
        return (
          (await posterMediaSource.prepareMaterialById(mat.id)) ??
          (mat.localFilePath && existsSync(mat.localFilePath)
            ? mat
            : await posterMediaSource.prepareAdHocMaterial(mat))
        );
      }
    : undefined;
  const service = new BluestacksService(
    repository.bluestacks,
    devices,
    new BluestacksGroupBumperRunner(
      repository.bluestacks,
      repository.targetLibrary,
      devices,
      ocrClient,
    ),
    featureExecution,
    {
      activeRunner: new BluestacksActiveRunner(devices, ocrClient),
      posterRunner: new BluestacksGroupPosterRunner(devices, ocrClient, {
        recordPost: (log) => repository.groupPoster.recordPost(log),
      }),
      inviterRunner: new BluestacksGroupInviterRunner(devices, ocrClient, {
        recordInvites: (entries) => repository.groupInviter.recordInvites(entries),
      }),
      listCombinations: () => repository.combinations(),
      listPosterMaterials: () => repository.groupPoster.materials(),
      hasGroupPostedMaterial: (gid, mid) => repository.groupPoster.hasGroupPostedMaterial(gid, mid),
      recordActiveProgress: (d) =>
        repository.activityStats.recordDailyActivity({
          carrier: 'bluestacks',
          profileId: d.profileId,
          accountId: d.accountId,
          durationMsDelta: d.durationMsDelta,
          friendsDelta: d.friendsDelta,
          likesDelta: 0,
          actionsDelta: 0,
          at: d.at,
        }),
      ...(ensurePosterMaterialLocal && { ensurePosterMaterialLocal }),
    },
  );
  return { ocrClient, service };
}
export function schedulePosterDriveCacheCleanup(groupPosterService: GroupPosterService): void {
  const run = () => void groupPosterService.cleanupExpiredDriveCache().catch(() => {});
  const t1 = setTimeout(run, 30_000).unref();
  const t2 = setInterval(run, 6 * 3600_000).unref();
  process.once('exit', () => (clearTimeout(t1), clearInterval(t2)));
}
export function openDesktopExtensionDirViaParent(): void {
  if (!process.parentPort)
    throw new ProductError('UPDATE_DESKTOP_REQUIRED', '请在桌面工作台中打开插件目录', 409);
  process.parentPort.postMessage({ type: 'OPEN_EXTENSION_DIRECTORY' });
}
export async function openDesktopAiWorkspaceViaParent(rootDir: string, softwareVersion: string) {
  if (!process.parentPort)
    throw new ProductError('UPDATE_DESKTOP_REQUIRED', '请在桌面工作台中打开 AI 专属工作夹', 409);
  const { directory } = await syncProductAiWorkspaceDirectory({ rootDir, softwareVersion });
  process.parentPort.postMessage({ type: 'OPEN_AI_WORKSPACE_DIRECTORY', directory });
  return { directory };
}
export function wireLifecycleAndMcpRuntime(input: McpRuntimeWiringInput): {
  profileLifecycle: BrowserLifecycleManager;
  agentBrowserManager: AgentBrowserManager;
  mcpHttpHandler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
} {
  const { core, store, repository, browserLabels, activeRuntime, featureExecution } = input;
  const profileLifecycle = new BrowserLifecycleManager({
    core,
    store,
    browserLabels,
    persistBindings: (bindings) => repository.upsertProfileLaunchBindings(bindings),
    stopActiveTasksForProfile: async (profileId) => {
      await featureExecution.stopProfilesAcrossModules([profileId]);
      const peer = core.peers.get(profileId);
      if (peer?.online && peer.phase === 'RUNNING') await core.stop(profileId);
    },
    releaseIdleKernelSession: async (profileId) => {
      await activeRuntime?.waitUntilProfileIdle(profileId, 5_000).catch(() => {});
      const peer = core.peers.get(profileId);
      if (peer?.online) await input.getMainKernel()?.releaseIdleForExtension(peer);
    },
  });
  void Promise.all([repository.profileLaunchBindings(), store.profileList()])
    .then(([bindings, rows]) => {
      browserLabels.hydrateBindings(bindings, new Set(rows.map((r) => String(r.profileId))));
      if (!process.env.BRIDGE_TEST_DATA_DIR && !process.env.WORKBENCH_SMOKE_OUT) {
        setTimeout(() => {
          try {
            const all = browserLabels.allBindings();
            const isOnline = (id: string) => Boolean(core.peers.get(id)?.online);
            cleanupOfflineRegisteredProfiles(all, isOnline, 'keep-one');
            cleanupAllLocalBrowserProfiles(
              defaultLocalBrowserUserDataRoots(),
              new Set(
                all
                  .filter((b) => isOnline(b.profileId))
                  .map((b) => path.join(b.userDataDir, b.profileDirectory)),
              ),
              'keep-one',
            );
          } catch {}
        }, 1500).unref();
      }
    })
    .catch(() => {});
  input.groupBumperService.setProfileLifecycle(profileLifecycle);
  input.groupPosterService.setProfileLifecycle(profileLifecycle);
  input.groupInviterService.setProfileLifecycle(profileLifecycle);
  const agentBrowserManager = new AgentBrowserManager(
    () => core,
    input.getMainKernel,
    featureExecution,
  );
  return {
    profileLifecycle,
    agentBrowserManager,
    mcpHttpHandler: createWorkbenchMcpHttpHandler(
      {
        ...input,
        getGroupBumperService: () => input.groupBumperService,
        agentBrowser: agentBrowserManager,
        profileLifecycle,
      },
      input.port,
    ),
  };
}
