import type http from 'node:http';
import type { Core } from '../../bridge/core.js';
import type { BridgeStorePort, WorkspaceStorePort } from '../persistence-port.js';
import type { LocalBrowserLabels } from '../local-browser-labels.js';
import { BrowserLifecycleManager } from '../browser-lifecycle-manager.js';
import { BluestacksDeviceManager } from '../bluestacks-device-manager.js';
import { BluestacksGroupBumperRunner } from '../bluestacks-bumper-runner.js';
import { WindowsOcrClient } from '../bluestacks-vision.js';
import type { FacebookPublishingRuntime } from '../facebook-publishing-runtime.js';
import type { FeatureExecutionRegistry } from '../../application/feature-execution-registry.js';
import type { GroupBumperService } from '../../application/group-bumper-service.js';
import type { GroupPosterService } from '../../application/group-poster-service.js';
import type { GroupInviterService } from '../../application/group-inviter-service.js';
import { BluestacksService } from '../../application/bluestacks-service.js';
import { ProductError } from '../../domain/workspace.js';
import { syncProductAiWorkspaceDirectory } from '../ai-workspace.js';
import type { WorkspaceService } from '../../application/workspace-service.js';
import type { TaskService } from '../../application/task-service.js';
import type { ProfileInspectionService } from '../../application/profile-inspection.js';
import type { KernelBridge } from '../kernel-bridge.js';
import type { ReloadResult } from '../../shared/software-update.js';
import { AgentBrowserManager } from './agent-browser-manager.js';
import { createWorkbenchMcpHttpHandler } from './mcp-server.js';
import type { WorkbenchMcpDependencies } from './mcp-context.js';

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
  publishingRuntime?: FacebookPublishingRuntime | undefined;
  workspaceService: WorkspaceService;
  taskService: TaskService;
  inspection?: ProfileInspectionService | undefined;
  featureExecution: FeatureExecutionRegistry;
  groupPosterService: GroupPosterService;
  groupBumperService: GroupBumperService;
  groupInviterService: GroupInviterService;
  bluestacksService: BluestacksService;
  captureDiagnostics: WorkbenchMcpDependencies['captureDiagnostics'];
  devDiagFilePath: string;
  reloadExtensions: (ids?: string[]) => Promise<ReloadResult>;
  withMutation: <T>(work: () => Promise<T>) => Promise<T>;
}

export function createBluestacksRuntime(
  repository: WorkspaceStorePort,
  featureExecution: FeatureExecutionRegistry,
): { ocrClient: WindowsOcrClient; service: BluestacksService } {
  const ocrClient = new WindowsOcrClient();
  const devices = new BluestacksDeviceManager(repository.bluestacks, ocrClient);
  const runner = new BluestacksGroupBumperRunner(
    repository.bluestacks,
    repository.targetLibrary,
    devices,
    ocrClient,
  );
  const service = new BluestacksService(repository.bluestacks, devices, runner, featureExecution);
  return { ocrClient, service };
}

export function schedulePosterDriveCacheCleanup(groupPosterService: GroupPosterService): void {
  const startupTimer = setTimeout(
    () => void groupPosterService.cleanupExpiredDriveCache().catch(() => {}),
    30_000,
  ).unref();
  const intervalTimer = setInterval(
    () => void groupPosterService.cleanupExpiredDriveCache().catch(() => {}),
    6 * 3600_000,
  ).unref();
  process.once('exit', () => {
    clearTimeout(startupTimer);
    clearInterval(intervalTimer);
  });
}

export function openDesktopExtensionDirViaParent(): void {
  if (!process.parentPort)
    throw new ProductError('UPDATE_DESKTOP_REQUIRED', '请在桌面工作台中打开插件目录', 409);
  process.parentPort.postMessage({ type: 'OPEN_EXTENSION_DIRECTORY' });
}

export async function openDesktopAiWorkspaceViaParent(
  rootDir: string,
  softwareVersion: string,
): Promise<{ directory: string }> {
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
  const {
    core,
    store,
    repository,
    browserLabels,
    featureExecution,
    publishingRuntime,
    groupBumperService,
    groupPosterService,
    groupInviterService,
  } = input;

  const profileLifecycle = new BrowserLifecycleManager({
    core,
    store,
    browserLabels,
    persistBindings: async (bindings) => {
      await repository.upsertProfileLaunchBindings(bindings);
    },
    stopActiveTasksForProfile: async (profileId) => {
      await featureExecution.stopProfilesAcrossModules([profileId]);
      const peer = core.peers.get(profileId);
      if (peer?.online && peer.phase === 'RUNNING') {
        await core.stop(profileId);
      }
    },
  });

  void Promise.all([repository.profileLaunchBindings(), store.profileList()])
    .then(([savedBindings, rows]) => {
      browserLabels.hydrateBindings(savedBindings, new Set(rows.map((r) => String(r.profileId))));
    })
    .catch(() => {});

  publishingRuntime?.setProfileLifecycle(profileLifecycle);
  groupBumperService.setProfileLifecycle(profileLifecycle);
  groupBumperService.startScheduler();
  groupPosterService.setProfileLifecycle(profileLifecycle);
  groupInviterService.setProfileLifecycle(profileLifecycle);

  const agentBrowserManager = new AgentBrowserManager(
    () => core,
    input.getMainKernel,
    featureExecution,
  );

  const mcpHttpHandler = createWorkbenchMcpHttpHandler(
    {
      softwareVersion: input.softwareVersion,
      extensionVersion: input.extensionVersion,
      dataDir: input.dataDir,
      core,
      store,
      getMainKernel: input.getMainKernel,
      workspaceService: input.workspaceService,
      taskService: input.taskService,
      inspection: input.inspection,
      featureExecution,
      groupPosterService,
      getGroupBumperService: () => groupBumperService,
      groupInviterService,
      bluestacksService: input.bluestacksService,
      agentBrowser: agentBrowserManager,
      profileLifecycle,
      captureDiagnostics: input.captureDiagnostics,
      devDiagFilePath: input.devDiagFilePath,
      reloadExtensions: input.reloadExtensions,
      withMutation: input.withMutation,
    },
    input.port,
  );

  return { profileLifecycle, agentBrowserManager, mcpHttpHandler };
}
