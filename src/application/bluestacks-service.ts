import type { CompatibleRepository } from '../domain/persistence.js';
import { ProductError, failError } from '../domain/workspace.js';
import {
  BluestacksInstanceIdsInput,
  BluestacksRiskLimitSettings,
  type BluestacksBumperMode,
  type BluestacksInstance,
  type BluestacksState,
} from '../shared/bluestacks.js';
import { BumperSettings } from '../shared/group-bumper.js';
import type { PostBumpRecordsPort } from '../shared/post-bump-records.js';
import type { FeatureExecutionRegistry } from './feature-execution-registry.js';
import type { Workboard } from './workboard.js';
import {
  ensureInstanceOnlineForSchedule,
  parseStopInput as parseBsStopInput,
  pumpWorkerPool,
  runScheduledInstanceStep,
  startBumperRun,
  stopBumper as stopBsBumper,
} from './bluestacks/bs-bumper.js';
import {
  closeInstanceForce,
  startActive,
  startInviter,
  startPoster,
  stopAllForInstances,
} from './bluestacks/bs-extra-modules.js';
import {
  arrangeWindowsOp,
  buildServiceState,
  closeInstancesOp,
  inspectInstancesOp,
  installApkOp,
  launchInstancesOp,
  loginInstanceOp,
  showInstanceOp,
  stopInstanceOps,
  switchIdentityOp,
} from './bluestacks/bs-instance-ops.js';
import { startBatchLogin, stopBatchLogin } from './bluestacks/bs-batch-login.js';
import {
  runScheduledHealthCheckStep,
  startHealthCheck,
  stopHealthCheck,
} from './bluestacks/bs-patrols.js';
import {
  runDirectPosterForSheet,
  runDirectPostsForSheet,
  runScheduledActiveStep,
  runScheduledInviterStep,
  runScheduledPosterStep,
} from './bluestacks/bs-scheduled-and-sheets.js';
import {
  type BluestacksActiveRunnerPort,
  type BluestacksActiveStepParam,
  type BluestacksBumperRunnerPort,
  type BluestacksDeviceController,
  type BluestacksExtraRunners,
  type BluestacksInviterRunnerPort,
  type BluestacksPosterRunnerPort,
  type BluestacksServiceContext,
  type BluestacksServiceRepository,
  type ExtraExecutionKind,
  createBluestacksServiceContext,
  hasActiveExecution as hasBsActiveExecution,
  hasExtraExecution as hasBsExtraExecution,
  invalidateDiscoveryCache,
  isExternallyBusy,
  isProfileRunning as isBsProfileRunning,
  stopExtraWorkers,
} from './bluestacks/bs-types.js';
export type {
  BluestacksActiveRunnerPort,
  BluestacksActiveStepParam,
  BluestacksBumperRunnerPort,
  BluestacksDeviceController,
  BluestacksExtraRunners,
  BluestacksInviterRunnerPort,
  BluestacksPosterRunnerPort,
  BluestacksServiceRepository,
};
export class BluestacksService {
  private readonly ctx: BluestacksServiceContext;
  constructor(
    repo: CompatibleRepository<BluestacksServiceRepository>,
    devices: BluestacksDeviceController,
    runner: BluestacksBumperRunnerPort,
    registry?: FeatureExecutionRegistry,
    extra?: BluestacksExtraRunners,
  ) {
    this.ctx = createBluestacksServiceContext(repo, devices, runner, registry, extra);
    if (!registry) return;
    for (const [id, label, mode] of [
      ['bluestacks-group-bumper', '蓝蝶小组顶贴', 'group'],
      ['bluestacks-page-bumper', '蓝蝶专页顶贴', 'page'],
    ] as const) {
      registry.register({
        id,
        label,
        isProfileRunning: (instId) => this.isProfileRunning(instId, mode),
        hasActiveExecution: () => this.hasActiveExecution(mode),
        stopProfiles: async (ids) => void (await this.stopBumper(ids, mode)),
      });
    }
    for (const [id, label, kind] of [
      ['bluestacks-active', '蓝蝶活跃账号', 'active'],
      ['bluestacks-group-poster', '蓝蝶小组发帖', 'poster'],
      ['bluestacks-group-inviter', '蓝蝶小组邀请人', 'inviter'],
    ] as const) {
      registry.register({
        id,
        label,
        isProfileRunning: (instId) =>
          this.ctx.extraWorkers.get(instId)?.kind === kind ||
          this.ctx.queuedExtraTasks.get(instId)?.kind === kind,
        hasActiveExecution: () => this.hasExtraExecution(kind),
        stopProfiles: async (ids) => void (await this.stopExtra(kind, ids)),
      });
    }
    for (const [id, label, kind, stopAll, extraBusy, extraActive] of [
      [
        'bluestacks-batch-login',
        '蓝蝶批量登录',
        'batch-login',
        () => this.stopBatchLogin(),
        (pid: string) => this.ctx.loggingInIds.has(pid),
        () => Boolean(this.ctx.batchLoginState?.running) || this.ctx.loggingInIds.size > 0,
      ],
      [
        'bluestacks-health-check',
        '蓝蝶健康体检',
        'health-check',
        () => this.stopHealthCheck(),
        () => false,
        () => Boolean(this.ctx.healthCheckState?.running),
      ],
    ] as const) {
      registry.register({
        id,
        label,
        isProfileRunning: (pid) => this.ctx.extraWorkers.get(pid)?.kind === kind || extraBusy(pid),
        hasActiveExecution: () => extraActive() || this.hasExtraExecution(kind),
        stopProfiles: async (ids) =>
          void (await (!ids?.length ? stopAll() : this.stopExtra(kind, ids))),
      });
    }
  }
  setWorkboard = (workboard: Workboard) => void (this.ctx.workboard = workboard);
  getWorkboard = () => this.ctx.workboard;
  setPostBumpRecords = (port: PostBumpRecordsPort) => void (this.ctx.postBumpRecords = port);
  hasExtraExecution = (kind?: ExtraExecutionKind) => hasBsExtraExecution(this.ctx, kind);
  isProfileRunning = (instanceId: string, mode?: BluestacksBumperMode) =>
    isBsProfileRunning(this.ctx, instanceId, mode);
  hasActiveExecution = (mode?: BluestacksBumperMode) => hasBsActiveExecution(this.ctx, mode);
  state = (forceDiscover = false): Promise<BluestacksState> =>
    buildServiceState(this.ctx, forceDiscover);
  private async runAndState(fn: () => unknown, forceDiscover = false): Promise<BluestacksState> {
    await fn();
    return this.state(forceDiscover);
  }
  saveRiskLimitSettings(input: unknown): Promise<BluestacksState> {
    const parsed = BluestacksRiskLimitSettings.parse(input);
    if (!this.ctx.repo.saveRiskLimitSettings)
      throw new ProductError('BLUESTACKS_RISK_UNSUPPORTED', '当前存储层暂不支持保存风控限额', 400);
    return this.runAndState(() => this.ctx.repo.saveRiskLimitSettings?.(parsed));
  }
  updatePaths = (input: unknown) =>
    this.runAndState(async () => {
      await this.ctx.repo.savePaths(input);
      invalidateDiscoveryCache(this.ctx);
    }, true);
  private async saveModeBumperSettings(
    mode: BluestacksBumperMode,
    input: unknown,
  ): Promise<BluestacksState> {
    const saved =
      mode === 'page' && this.ctx.repo.savePageBumperSettings
        ? await this.ctx.repo.savePageBumperSettings(input)
        : await this.ctx.repo.saveBumperSettings(input);
    for (const q of this.ctx.queuedTasks) if (q.mode === mode) q.settings = saved;
    for (const [id, m] of this.ctx.activeWorkerModes.entries()) {
      if (m !== mode) continue;
      const live = this.ctx.activeWorkerSettings.get(id);
      if (live) Object.assign(live, saved);
      void this.ctx.devices
        .setInstanceSoundEnabled?.(id, Boolean(saved.enableSound))
        .catch(() => {});
    }
    pumpWorkerPool(this.ctx);
    return this.state(false);
  }
  saveBumperSettings = (input: unknown) => this.saveModeBumperSettings('group', input);
  savePageBumperSettings = (input: unknown) => this.saveModeBumperSettings('page', input);
  async syncMaxConcurrency(maxConcurrentProfiles: number): Promise<void> {
    const capped = Math.max(1, Math.min(50, Math.round(maxConcurrentProfiles)));
    this.ctx.workboard.bluestacksPermits.setLimit(capped);
    const saved = await this.ctx.repo.savedSettings();
    if (saved.bumperSettings.maxConcurrentProfiles !== capped) {
      await this.ctx.repo.saveBumperSettings(
        BumperSettings.parse({ ...saved.bumperSettings, maxConcurrentProfiles: capped }),
      );
    }
    if (
      this.ctx.repo.savePageBumperSettings &&
      saved.pageBumperSettings?.maxConcurrentProfiles !== capped
    ) {
      await this.ctx.repo.savePageBumperSettings(
        BumperSettings.parse({
          ...(saved.pageBumperSettings ?? saved.bumperSettings),
          maxConcurrentProfiles: capped,
        }),
      );
    }
    for (const q of this.ctx.queuedTasks)
      q.settings = { ...q.settings, maxConcurrentProfiles: capped };
    for (const s of this.ctx.activeWorkerSettings.values()) s.maxConcurrentProfiles = capped;
    pumpWorkerPool(this.ctx);
  }
  createFolder = (input: unknown) => this.runAndState(() => this.ctx.repo.createFolder(input));
  renameFolder = (input: unknown) => this.runAndState(() => this.ctx.repo.renameFolder(input));
  deleteFolder = (input: unknown) => this.runAndState(() => this.ctx.repo.deleteFolder(input));
  reorderFolders = (input: unknown) => this.runAndState(() => this.ctx.repo.reorderFolders(input));
  renameInstance = (input: unknown) => this.runAndState(() => this.ctx.repo.renameInstance(input));
  reorderInstances = (input: unknown) =>
    this.runAndState(() => this.ctx.repo.reorderInstances(input));
  deleteInstances = (input: unknown) =>
    this.runAndState(async () => {
      const { instanceIds } = BluestacksInstanceIdsInput.parse(input);
      for (const id of instanceIds) {
        if (this.isProfileRunning(id) || (await isExternallyBusy(this.ctx, id)))
          failError('INSTANCE_BUSY', '所选模拟器正在执行任务，请先停止后再移除记录', 409);
      }
      await this.ctx.repo.deleteInstances({ instanceIds });
    });
  launchInstances = (input: unknown) => this.runAndState(() => launchInstancesOp(this.ctx, input));
  closeInstances = async (input: unknown) => this.state(await closeInstancesOp(this.ctx, input));
  inspectInstances = (input: unknown) =>
    this.runAndState(() => inspectInstancesOp(this.ctx, input));
  startBumper = (input: unknown) =>
    this.runAndState(() => startBumperRun(this.ctx, input, 'group'));
  startPageBumper = (input: unknown) =>
    this.runAndState(() => startBumperRun(this.ctx, input, 'page'));
  stopBumper = (ids?: readonly string[], mode?: BluestacksBumperMode) =>
    this.runAndState(() => stopBsBumper(this.ctx, ids, mode));
  parseStopInput = (input: unknown) => parseBsStopInput(input);
  ensureInstanceOnlineForSchedule = (
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<BluestacksInstance> => ensureInstanceOnlineForSchedule(this.ctx, instanceId, signal);
  runScheduledInstanceStep = (input: Parameters<typeof runScheduledInstanceStep>[1]) =>
    runScheduledInstanceStep(this.ctx, input);
  closeInstanceForce = (instanceId: string) => closeInstanceForce(this.ctx, instanceId);
  showInstance = (input: unknown) => this.runAndState(() => showInstanceOp(this.ctx, input));
  arrangeWindows = (input: unknown) => this.runAndState(() => arrangeWindowsOp(this.ctx, input));
  installApk = (input: unknown) => this.runAndState(() => installApkOp(this.ctx, input));
  switchIdentity = (input: unknown) =>
    this.runAndState(() => switchIdentityOp(this.ctx, input), true);
  loginInstance = (input: unknown) => this.runAndState(() => loginInstanceOp(this.ctx, input));
  startBatchLogin = (input: unknown) => this.runAndState(() => startBatchLogin(this.ctx, input));
  stopBatchLogin = () => this.runAndState(() => stopBatchLogin(this.ctx));
  startHealthCheck = (input: unknown) => this.runAndState(() => startHealthCheck(this.ctx, input));
  stopHealthCheck = () => this.runAndState(() => stopHealthCheck(this.ctx));
  startActive = (input: unknown) => this.runAndState(() => startActive(this.ctx, input));
  startPoster = (input: unknown) => this.runAndState(() => startPoster(this.ctx, input));
  startInviter = (input: unknown) => this.runAndState(() => startInviter(this.ctx, input));
  stopExtra = (kind?: ExtraExecutionKind, ids?: readonly string[]) =>
    this.runAndState(() => stopExtraWorkers(this.ctx, kind, ids));
  stopBatchOp = (ids?: readonly string[]) => this.runAndState(() => stopInstanceOps(this.ctx, ids));
  stopAllForInstances = (ids?: readonly string[]) =>
    this.runAndState(() => stopAllForInstances(this.ctx, ids));
  runScheduledHealthCheckStep = (input: Parameters<typeof runScheduledHealthCheckStep>[1]) =>
    runScheduledHealthCheckStep(this.ctx, input);
  runScheduledActiveStep = (input: Parameters<typeof runScheduledActiveStep>[1]) =>
    runScheduledActiveStep(this.ctx, input);
  runScheduledPosterStep = (input: Parameters<typeof runScheduledPosterStep>[1]) =>
    runScheduledPosterStep(this.ctx, input);
  runScheduledInviterStep = (input: Parameters<typeof runScheduledInviterStep>[1]) =>
    runScheduledInviterStep(this.ctx, input);
  runDirectPostsForSheet = (input: Parameters<typeof runDirectPostsForSheet>[1]) =>
    runDirectPostsForSheet(this.ctx, input);
  runDirectPosterForSheet = (input: Parameters<typeof runDirectPosterForSheet>[1]) =>
    runDirectPosterForSheet(this.ctx, input);
}
