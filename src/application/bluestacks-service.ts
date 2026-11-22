import type { CompatibleRepository } from '../domain/persistence.js';
import { ProductError } from '../domain/workspace.js';
import {
  BluestacksArrangeWindowsInput,
  BluestacksInstallApkInput,
  BluestacksInstanceIdsInput,
  BluestacksLoginInput,
  BluestacksRiskLimitSettings,
  BluestacksShowInstanceInput,
  BluestacksSwitchIdentityInput,
  DEFAULT_BLUESTACKS_RISK_LIMIT_SETTINGS,
  StartBluestacksActiveInput,
  StartBluestacksBatchLoginInput,
  StartBluestacksBumperInput,
  StartBluestacksHealthCheckInput,
  StartBluestacksInviterInput,
  StartBluestacksPageBumperInput,
  StartBluestacksPosterInput,
  StopBluestacksBumperInput,
  bluestacksDisplayTitle,
  classifyHealthErrorMessage,
  evaluateBluestacksRiskQuota,
  healthCategoryLabel,
  isBluestacksPortraitResolution,
  maskLoginAccountLabel,
  normalizeTotpSecret,
  type BluestacksBatchLoginItemProgress,
  type BluestacksBatchLoginState,
  type BluestacksBumperMode,
  type BluestacksDailyUsageOverview,
  type BluestacksFolder,
  type BluestacksHealthCategory,
  type BluestacksHealthCheckItem,
  type BluestacksHealthCheckState,
  type BluestacksInstance,
  type BluestacksModuleProfileStat,
  type BluestacksQuickActiveStepType,
  type BluestacksRiskActionKind,
  type BluestacksRuntimeConfig,
  type BluestacksState,
  type BluestacksWorkerKind,
} from '../shared/bluestacks.js';
import type { SavedCombination } from '../shared/contracts.js';
import { PAGE_TIMELINE_SYNTHETIC_GROUP_ID } from '../shared/google-sheets.js';
import type {
  BumperDailyStat,
  BumperProfileStat,
  BumperScope,
  BumperSettings,
  BumperTarget,
} from '../shared/group-bumper.js';
import type { PosterLog, PosterMaterial } from '../shared/group-poster.js';
import type { FeatureExecutionRegistry } from './feature-execution-registry.js';
import { buildStaggeredBumperQueues } from './group-bumper-service.js';

export interface BluestacksActiveStepParam {
  type: BluestacksQuickActiveStepType;
  durationMinutes?: number;
  maxLikes?: number;
  maxAccepts?: number;
  caption?: string;
  mediaPath?: string;
  background?: string;
}

export interface BluestacksActiveRunnerPort {
  run(
    instanceId: string,
    steps: readonly BluestacksActiveStepParam[],
    signal: AbortSignal,
    callbacks: {
      status(text: string): void;
      action(): void;
    },
  ): Promise<{
    completedSteps: number;
    skippedSteps: number;
    likes: number;
    acceptedFriends: number;
    published: number;
    notes: string[];
  }>;
}

export interface BluestacksPosterRunnerPort {
  run(
    instanceId: string,
    materials: readonly PosterMaterial[],
    groups: readonly BumperTarget[],
    options: { maxGroupsPerInstance: number; postToTimeline: boolean },
    signal: AbortSignal,
    callbacks: {
      status(text: string): void;
      posted(): void;
      onPostLog?(log: PosterLog, isTimeline: boolean): Promise<void> | void;
    },
  ): Promise<{ posted: number; skipped: number; notes: string[] }>;
}

export interface BluestacksInviterRunnerPort {
  run(
    instanceId: string,
    groups: readonly BumperTarget[],
    invitesPerGroup: number,
    signal: AbortSignal,
    callbacks: {
      status(text: string): void;
      invited(delta: number): void;
    },
  ): Promise<{ invited: number; skippedGroups: number; notes: string[] }>;
}

export interface BluestacksExtraRunners {
  activeRunner?: BluestacksActiveRunnerPort;
  posterRunner?: BluestacksPosterRunnerPort;
  inviterRunner?: BluestacksInviterRunnerPort;
  listCombinations?: () => Promise<SavedCombination[]> | SavedCombination[];
  listPosterMaterials?: () => Promise<PosterMaterial[]> | PosterMaterial[];
  ensurePosterMaterialLocal?: (material: PosterMaterial) => Promise<PosterMaterial>;
}

export interface BluestacksServiceRepository {
  savedSettings(): {
    installDir: string | null;
    confPath: string | null;
    bumperSettings: BumperSettings;
    pageBumperSettings?: BumperSettings;
    riskLimitSettings?: BluestacksRiskLimitSettings;
  };
  savePaths(input: unknown): {
    installDir: string | null;
    confPath: string | null;
    bumperSettings: BumperSettings;
    pageBumperSettings?: BumperSettings;
    riskLimitSettings?: BluestacksRiskLimitSettings;
  };
  saveBumperSettings(input: unknown): BumperSettings;
  savePageBumperSettings?(input: unknown): BumperSettings;
  saveRiskLimitSettings?(input: unknown): BluestacksRiskLimitSettings;
  recordDailyActiveAction?(
    instanceId: string,
    kind?: 'like' | 'action',
    delta?: number,
    now?: number,
  ): void;
  dailyInstanceUsage?(now?: number): BluestacksDailyUsageOverview;
  folders(): BluestacksFolder[];
  createFolder(input: unknown): BluestacksFolder;
  renameFolder(input: unknown): BluestacksFolder;
  deleteFolder(input: unknown): void;
  reorderFolders(input: unknown): void;
  listInstances(onlineKeys?: ReadonlyArray<string>): BluestacksInstance[];
  getInstance(id: string): BluestacksInstance | null;
  saveLastStatus(id: string, status: string | null): void;
  renameInstance(input: unknown): BluestacksInstance;
  reorderInstances(input: unknown): void;
  deleteInstances(input: unknown): number;
  targets(kind: 'groups' | 'pages'): BumperTarget[];
  todayCounts(now?: number, sourceMode?: BumperScope): Record<string, number>;
  total(sourceMode?: BumperScope): number;
  weeklyDailyCounts(now?: number, sourceMode?: BumperScope): BumperDailyStat[];
}

export interface BluestacksDeviceController {
  getOnlineKeys(): ReadonlySet<string>;
  discoverInstances(): Promise<{
    instances: BluestacksInstance[];
    config: BluestacksRuntimeConfig;
  }>;
  launchInstance(instanceId: string, signal?: AbortSignal): Promise<BluestacksInstance>;
  closeInstance(instanceId: string): Promise<void>;
  inspectAccount(instanceId: string, signal?: AbortSignal): Promise<BluestacksInstance>;
  setInstanceSoundEnabled?(
    instanceId: string,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<void>;
  showInstance?(instanceId: string): Promise<boolean>;
  arrangeWindows?(
    instanceIds?: readonly string[],
    options?: { columns?: number; gap?: number },
  ): Promise<number>;
  installFbLiteApk?(
    instanceId: string,
    explicitApkPath?: string,
    signal?: AbortSignal,
  ): Promise<BluestacksInstance>;
  switchIdentity?(
    instanceId: string,
    target: { targetName?: string; targetType?: 'personal' | 'page' },
    signal?: AbortSignal,
  ): Promise<BluestacksInstance>;
  loginAccount?(
    instanceId: string,
    credentials: {
      account: string;
      password: string;
      totpSecret?: string;
      saveLoginInfo?: boolean;
      ifAlreadyLoggedIn?: 'skip' | 'clear-and-relogin';
    },
    signal?: AbortSignal,
    onProgress?: (status: string) => void,
  ): Promise<BluestacksInstance>;
  loginAccountDetailed?(
    instanceId: string,
    credentials: {
      account: string;
      password: string;
      totpSecret?: string;
      saveLoginInfo?: boolean;
      ifAlreadyLoggedIn?: 'skip' | 'clear-and-relogin';
    },
    signal?: AbortSignal,
    onProgress?: (status: string) => void,
  ): Promise<{ instance: BluestacksInstance; skippedAlreadyLoggedIn: boolean }>;
  probeFbLiteInstalled?(
    serial: string,
    force?: boolean,
    signal?: AbortSignal,
  ): Promise<boolean | null>;
}

export interface BluestacksBumperRunnerPort {
  run(
    instanceId: string,
    groups: readonly BumperTarget[],
    pages: readonly BumperTarget[],
    settings: BumperSettings,
    signal: AbortSignal,
    callbacks: {
      status(text: string, today?: number): void;
      added(today: number): void;
    },
    mode?: BluestacksBumperMode,
  ): Promise<void>;
  runDirectPosts?(
    instanceId: string,
    posts: ReadonlyArray<{
      postId: string;
      postUrl: string;
      groupId: string;
      groupName: string;
      pageId: string;
      pageName: string;
    }>,
    settings: BumperSettings,
    commentPool: readonly string[],
    signal: AbortSignal,
    callbacks: {
      status(text: string): void;
      onPostDone?: (res: {
        postId: string;
        liked: boolean;
        commented: boolean;
        commentText?: string | null;
      }) => void | Promise<void>;
    },
  ): Promise<{ bumped: number; attempted: number }>;
}

interface QueuedBluestacksTask {
  instanceId: string;
  mode: BluestacksBumperMode;
  groups: BumperTarget[];
  pages: BumperTarget[];
  settings: BumperSettings;
  controller: AbortController;
}

const DISCOVERY_CACHE_TTL_MS = 2500;

function delayMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class BluestacksService {
  private readonly profileStats = new Map<string, BumperProfileStat>();
  private readonly pageProfileStats = new Map<string, BumperProfileStat>();
  private readonly activeProfileStats = new Map<string, BluestacksModuleProfileStat>();
  private readonly posterProfileStats = new Map<string, BluestacksModuleProfileStat>();
  private readonly inviterProfileStats = new Map<string, BluestacksModuleProfileStat>();
  private readonly activeWorkers = new Map<string, Promise<void>>();
  private readonly activeWorkerModes = new Map<string, BluestacksBumperMode>();
  private readonly activeWorkerSettings = new Map<string, BumperSettings>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly extraWorkers = new Map<
    string,
    {
      kind: Exclude<BluestacksWorkerKind, 'group-bumper' | 'page-bumper'>;
      controller: AbortController;
      promise: Promise<void>;
    }
  >();
  private readonly queuedExtraTasks = new Map<
    string,
    {
      kind: 'active' | 'poster' | 'inviter';
      controller: AbortController;
      statsMap: Map<string, BluestacksModuleProfileStat>;
    }
  >();
  private readonly queuedTasks: QueuedBluestacksTask[] = [];
  private readonly launchingIds = new Set<string>();
  private readonly closingIds = new Set<string>();
  private readonly inspectingIds = new Set<string>();
  private readonly installingIds = new Set<string>();
  private readonly loggingInIds = new Set<string>();
  private readonly switchingIds = new Set<string>();
  private pumpingPool = false;
  private activeConcurrencyCap = 4;
  private statusText = '请选择蓝蝶窗口、目标小组和目标主页';
  private pageStatusText = '请选择蓝蝶窗口和目标专页';
  private activeStatusText = '请选择蓝蝶窗口与活跃任务组合或快捷动作';
  private posterStatusText = '请选择蓝蝶窗口、发帖素材与目标小组';
  private inviterStatusText = '请选择蓝蝶窗口与目标小组（需个人账号身份）';
  private batchLoginStarting = false;
  private batchLoginState: BluestacksBatchLoginState | null = null;
  private batchLoginAbort: AbortController | null = null;
  private batchLoginRunnerPromise: Promise<void> | null = null;
  private healthCheckStarting = false;
  private healthCheckState: BluestacksHealthCheckState | null = null;
  private healthCheckAbort: AbortController | null = null;
  private healthCheckRunnerPromise: Promise<void> | null = null;

  private discoveryCache: {
    at: number;
    instances: BluestacksInstance[];
    config: BluestacksRuntimeConfig;
  } | null = null;
  private discoveryInFlight: Promise<{
    instances: BluestacksInstance[];
    config: BluestacksRuntimeConfig;
  }> | null = null;

  constructor(
    private readonly repo: CompatibleRepository<BluestacksServiceRepository>,
    private readonly devices: BluestacksDeviceController,
    private readonly runner: BluestacksBumperRunnerPort,
    private readonly registry?: FeatureExecutionRegistry,
    private readonly extra?: BluestacksExtraRunners,
  ) {
    registry?.register({
      id: 'bluestacks-group-bumper',
      label: '蓝蝶小组顶贴',
      isProfileRunning: (id) => this.isProfileRunning(id, 'group'),
      hasActiveExecution: () => this.hasActiveExecution('group'),
      stopProfiles: async (ids) => {
        await this.stopBumper(ids, 'group');
      },
    });
    registry?.register({
      id: 'bluestacks-page-bumper',
      label: '蓝蝶专页顶贴',
      isProfileRunning: (id) => this.isProfileRunning(id, 'page'),
      hasActiveExecution: () => this.hasActiveExecution('page'),
      stopProfiles: async (ids) => {
        await this.stopBumper(ids, 'page');
      },
    });
    registry?.register({
      id: 'bluestacks-active',
      label: '蓝蝶活跃账号',
      isProfileRunning: (id) =>
        this.extraWorkers.get(id)?.kind === 'active' ||
        this.queuedExtraTasks.get(id)?.kind === 'active',
      hasActiveExecution: () => this.hasExtraExecution('active'),
      stopProfiles: async (ids) => {
        await this.stopExtra('active', ids);
      },
    });
    registry?.register({
      id: 'bluestacks-group-poster',
      label: '蓝蝶小组发帖',
      isProfileRunning: (id) =>
        this.extraWorkers.get(id)?.kind === 'poster' ||
        this.queuedExtraTasks.get(id)?.kind === 'poster',
      hasActiveExecution: () => this.hasExtraExecution('poster'),
      stopProfiles: async (ids) => {
        await this.stopExtra('poster', ids);
      },
    });
    registry?.register({
      id: 'bluestacks-group-inviter',
      label: '蓝蝶小组邀请人',
      isProfileRunning: (id) =>
        this.extraWorkers.get(id)?.kind === 'inviter' ||
        this.queuedExtraTasks.get(id)?.kind === 'inviter',
      hasActiveExecution: () => this.hasExtraExecution('inviter'),
      stopProfiles: async (ids) => {
        await this.stopExtra('inviter', ids);
      },
    });
    registry?.register({
      id: 'bluestacks-batch-login',
      label: '蓝蝶批量登录',
      isProfileRunning: (id) =>
        this.extraWorkers.get(id)?.kind === 'batch-login' || this.loggingInIds.has(id),
      hasActiveExecution: () =>
        Boolean(this.batchLoginState?.running) ||
        this.hasExtraExecution('batch-login') ||
        this.loggingInIds.size > 0,
      stopProfiles: async (ids) => {
        if (!ids || ids.length === 0) {
          await this.stopBatchLogin();
        } else {
          await this.stopExtra('batch-login', ids);
        }
      },
    });
    registry?.register({
      id: 'bluestacks-health-check',
      label: '蓝蝶健康体检',
      isProfileRunning: (id) => this.extraWorkers.get(id)?.kind === 'health-check',
      hasActiveExecution: () =>
        Boolean(this.healthCheckState?.running) || this.hasExtraExecution('health-check'),
      stopProfiles: async (ids) => {
        if (!ids || ids.length === 0) {
          await this.stopHealthCheck();
        } else {
          await this.stopExtra('health-check', ids);
        }
      },
    });
  }

  hasExtraExecution(
    kind?:
      | 'active'
      | 'poster'
      | 'inviter'
      | 'sheets-bumper'
      | 'sheets-poster'
      | 'batch-login'
      | 'health-check',
  ): boolean {
    for (const w of this.extraWorkers.values()) {
      if (!kind || w.kind === kind) return true;
    }
    for (const q of this.queuedExtraTasks.values()) {
      if (!kind || q.kind === kind) return true;
    }
    return false;
  }

  isProfileRunning(instanceId: string, mode?: BluestacksBumperMode): boolean {
    if (mode) {
      return (
        (this.activeWorkers.has(instanceId) && this.activeWorkerModes.get(instanceId) === mode) ||
        this.queuedTasks.some((t) => t.instanceId === instanceId && t.mode === mode)
      );
    }
    return (
      this.activeWorkers.has(instanceId) ||
      this.queuedTasks.some((t) => t.instanceId === instanceId) ||
      this.extraWorkers.has(instanceId) ||
      this.queuedExtraTasks.has(instanceId) ||
      this.closingIds.has(instanceId)
    );
  }

  hasActiveExecution(mode?: BluestacksBumperMode): boolean {
    if (mode) {
      for (const m of this.activeWorkerModes.values()) {
        if (m === mode) return true;
      }
      return this.queuedTasks.some((t) => t.mode === mode);
    }
    return (
      this.activeWorkers.size > 0 ||
      this.queuedTasks.length > 0 ||
      this.extraWorkers.size > 0 ||
      this.queuedExtraTasks.size > 0 ||
      this.launchingIds.size > 0 ||
      this.closingIds.size > 0 ||
      this.inspectingIds.size > 0 ||
      this.installingIds.size > 0 ||
      this.loggingInIds.size > 0 ||
      this.switchingIds.size > 0 ||
      Boolean(this.batchLoginState?.running) ||
      Boolean(this.healthCheckState?.running)
    );
  }

  private async getDiscoverySnapshot(force = false): Promise<{
    instances: BluestacksInstance[];
    config: BluestacksRuntimeConfig;
  }> {
    if (
      !force &&
      this.discoveryCache &&
      Date.now() - this.discoveryCache.at < DISCOVERY_CACHE_TTL_MS
    ) {
      const onlineKeys = [...this.devices.getOnlineKeys()];
      const instances = await this.repo.listInstances(onlineKeys);
      return { instances, config: this.discoveryCache.config };
    }
    if (this.discoveryInFlight) {
      return this.discoveryInFlight;
    }
    const p = this.devices
      .discoverInstances()
      .then((res) => {
        this.discoveryCache = {
          at: Date.now(),
          instances: res.instances,
          config: res.config,
        };
        return res;
      })
      .finally(() => {
        if (this.discoveryInFlight === p) this.discoveryInFlight = null;
      });
    this.discoveryInFlight = p;
    return p;
  }

  private invalidateDiscoveryCache(): void {
    this.discoveryCache = null;
  }

  private buildDefaultInstanceStatus(inst: BluestacksInstance): string {
    if (this.launchingIds.has(inst.id)) return '正在启动窗口…';
    if (this.closingIds.has(inst.id)) return '正在关闭窗口…';
    if (this.inspectingIds.has(inst.id)) return '正在识别账号…';
    if (this.installingIds.has(inst.id)) return '正在安装 FB Lite…';
    if (this.loggingInIds.has(inst.id)) return '正在自动登录账号…';
    if (this.switchingIds.has(inst.id)) return '正在切换身份…';
    if (!inst.online) {
      if (inst.lastStatus === '窗口已启动' || inst.lastStatus?.startsWith('账号已识别')) {
        return '未启动';
      }
      return inst.lastStatus || '未启动';
    }
    if (!isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight)) {
      return `横屏 ${inst.fbWidth}×${inst.fbHeight}（需改竖屏）`;
    }
    if (inst.fbLiteInstalled === false || inst.accountState === 'missing-app') {
      return '未安装 FB Lite';
    }
    if (inst.accountState === 'logged-out') {
      return '未登录 FB Lite';
    }
    if (inst.accountState === 'verification') {
      return '需安全验证 (Checkpoint)';
    }
    if (inst.accountState === 'restricted') {
      return '账号受限/停用';
    }
    if (inst.lastStatus === '已关闭' || inst.lastStatus?.startsWith('启动失败')) {
      return '在线就绪';
    }
    return inst.lastStatus || '在线就绪';
  }

  async state(forceDiscover = false): Promise<BluestacksState> {
    const [
      { instances, config },
      folders,
      saved,
      counts,
      pageCounts,
      total,
      pageTotal,
      dailyStats,
      pageDailyStats,
      dailyUsage,
    ] = await Promise.all([
      this.getDiscoverySnapshot(forceDiscover),
      this.repo.folders(),
      this.repo.savedSettings(),
      this.repo.todayCounts(undefined, 'group'),
      this.repo.todayCounts(undefined, 'page'),
      this.repo.total('group'),
      this.repo.total('page'),
      this.repo.weeklyDailyCounts(undefined, 'group'),
      this.repo.weeklyDailyCounts(undefined, 'page'),
      this.repo.dailyInstanceUsage
        ? Promise.resolve(this.repo.dailyInstanceUsage()).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);

    const buildCountsMap = (
      mode: BluestacksBumperMode,
      statsMap: Map<string, BumperProfileStat>,
      todayByInst: Record<string, number>,
    ): Record<string, BumperProfileStat> => {
      const result: Record<string, BumperProfileStat> = {};
      for (const inst of instances) {
        const today = todayByInst[inst.id] ?? 0;
        const runtimeStat = statsMap.get(inst.id);
        const isRunning = this.isProfileRunning(inst.id, mode);
        const staleOfflineSkip = !isRunning && runtimeStat?.status === '跳过：模拟器未启动';
        if (runtimeStat && !staleOfflineSkip) {
          result[inst.id] = {
            ...runtimeStat,
            running: isRunning,
            today,
          };
        } else {
          if (staleOfflineSkip) statsMap.delete(inst.id);
          result[inst.id] = {
            running: isRunning,
            status: this.buildDefaultInstanceStatus(inst),
            session: 0,
            today,
          };
        }
      }
      return result;
    };

    const profileCounts = buildCountsMap('group', this.profileStats, counts);
    const pageBumperProfileCounts = buildCountsMap('page', this.pageProfileStats, pageCounts);
    const buildExtraMap = (
      kind: 'active' | 'poster' | 'inviter',
      statsMap: Map<string, BluestacksModuleProfileStat>,
    ): Record<string, BluestacksModuleProfileStat> => {
      const out: Record<string, BluestacksModuleProfileStat> = {};
      for (const inst of instances) {
        const running = this.extraWorkers.get(inst.id)?.kind === kind;
        const cur = statsMap.get(inst.id);
        const staleOfflineSkip = !running && cur?.status === '跳过：模拟器未启动';
        const instDaily = dailyUsage?.perInstance[inst.id];
        const persistedToday =
          kind === 'active'
            ? (instDaily?.activeLikesToday ?? 0)
            : kind === 'poster'
              ? (instDaily?.postsToday ?? 0)
              : (instDaily?.invitesToday ?? 0);
        if (staleOfflineSkip) statsMap.delete(inst.id);
        out[inst.id] =
          cur && !staleOfflineSkip
            ? { ...cur, running, today: Math.max(cur.today, persistedToday) }
            : {
                running,
                status: this.buildDefaultInstanceStatus(inst),
                session: 0,
                today: persistedToday,
              };
      }
      return out;
    };
    const pageBumperSettings = saved.pageBumperSettings ?? saved.bumperSettings;
    const riskLimitSettings = saved.riskLimitSettings ?? DEFAULT_BLUESTACKS_RISK_LIMIT_SETTINGS;

    return {
      instances,
      folders,
      config,
      bumperSettings: saved.bumperSettings,
      pageBumperSettings,
      running: this.hasActiveExecution('group'),
      pageBumperRunning: this.hasActiveExecution('page'),
      activeRunning: this.hasExtraExecution('active'),
      posterRunning: this.hasExtraExecution('poster'),
      inviterRunning: this.hasExtraExecution('inviter'),
      launchingIds: [...this.launchingIds],
      closingIds: [...this.closingIds],
      inspectingIds: [...this.inspectingIds],
      installingIds: [...this.installingIds],
      loggingInIds: [...this.loggingInIds],
      switchingIds: [...this.switchingIds],
      statusText: this.statusText,
      pageBumperStatusText: this.pageStatusText,
      activeStatusText: this.activeStatusText,
      posterStatusText: this.posterStatusText,
      inviterStatusText: this.inviterStatusText,
      profileCounts,
      pageBumperProfileCounts,
      activeProfileCounts: buildExtraMap('active', this.activeProfileStats),
      posterProfileCounts: buildExtraMap('poster', this.posterProfileStats),
      inviterProfileCounts: buildExtraMap('inviter', this.inviterProfileStats),
      total,
      pageTotal,
      dailyStats,
      pageDailyStats,
      batchLogin: this.batchLoginState
        ? {
            ...this.batchLoginState,
            items: this.batchLoginState.items.map((item) => ({ ...item })),
          }
        : null,
      healthCheck: this.healthCheckState
        ? {
            ...this.healthCheckState,
            items: this.healthCheckState.items.map((item) => ({ ...item })),
          }
        : null,
      riskLimitSettings,
      ...(dailyUsage ? { dailyUsage } : {}),
    };
  }

  async saveRiskLimitSettings(input: unknown): Promise<BluestacksState> {
    const parsed = BluestacksRiskLimitSettings.parse(input);
    if (!this.repo.saveRiskLimitSettings) {
      throw new ProductError('BLUESTACKS_RISK_UNSUPPORTED', '当前存储层暂不支持保存风控限额', 400);
    }
    await this.repo.saveRiskLimitSettings(parsed);
    return this.state(false);
  }

  private extractRiskLimitAbortReason(signal: AbortSignal, err: unknown): string | null {
    const sigReason = signal.reason;
    const sigMsg =
      sigReason instanceof Error
        ? sigReason.message
        : typeof sigReason === 'string'
          ? sigReason
          : '';
    if (sigMsg.startsWith('RISK_LIMIT_REACHED:')) {
      return sigMsg.slice('RISK_LIMIT_REACHED:'.length);
    }
    const errMsg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
    if (errMsg.startsWith('RISK_LIMIT_REACHED:')) {
      return errMsg.slice('RISK_LIMIT_REACHED:'.length);
    }
    return null;
  }

  private async checkInstanceRiskQuota(
    instanceId: string,
    actionKind: BluestacksRiskActionKind,
  ): Promise<{ allowed: boolean; reason: string | null }> {
    if (!this.repo.dailyInstanceUsage) return { allowed: true, reason: null };
    const [saved, usage] = await Promise.all([
      this.repo.savedSettings(),
      Promise.resolve(this.repo.dailyInstanceUsage()).catch(() => null),
    ]);
    const riskSettings = saved.riskLimitSettings ?? DEFAULT_BLUESTACKS_RISK_LIMIT_SETTINGS;
    if (!riskSettings.enabled || !usage) return { allowed: true, reason: null };
    const counts = usage.perInstance[instanceId] ?? {
      groupBumpsToday: 0,
      pageBumpsToday: 0,
      postsToday: 0,
      invitesToday: 0,
      activeLikesToday: 0,
      activeActionsToday: 0,
    };
    const res = evaluateBluestacksRiskQuota(riskSettings, instanceId, counts, actionKind);
    return { allowed: res.allowed, reason: res.reason };
  }

  private async filterInstancesByRiskQuota(
    ids: readonly string[],
    actionKind: BluestacksRiskActionKind,
    statsMap: Map<string, { running: boolean; status: string; session: number; today: number }>,
  ): Promise<string[]> {
    const allowedIds: string[] = [];
    const blockedReasons: string[] = [];
    for (const id of ids) {
      const check = await this.checkInstanceRiskQuota(id, actionKind);
      if (check.allowed) {
        allowedIds.push(id);
      } else {
        const msg = check.reason ?? '今日已达蓝蝶风控安全上限，自动休眠保护';
        blockedReasons.push(msg);
        const cur = statsMap.get(id);
        statsMap.set(id, {
          running: false,
          status: msg,
          session: cur?.session ?? 0,
          today: cur?.today ?? 0,
        });
        await Promise.resolve(this.repo.saveLastStatus(id, msg.slice(0, 120))).catch(() => {});
      }
    }
    if (allowedIds.length === 0 && blockedReasons.length > 0) {
      throw new ProductError(
        'BLUESTACKS_DAILY_RISK_LIMIT',
        blockedReasons[0] ?? '今日已达蓝蝶风控安全上限，自动休眠保护',
        409,
      );
    }
    return allowedIds;
  }

  async updatePaths(input: unknown): Promise<BluestacksState> {
    await this.repo.savePaths(input);
    this.invalidateDiscoveryCache();
    return this.state(true);
  }

  async saveBumperSettings(input: unknown): Promise<BluestacksState> {
    const saved = await this.repo.saveBumperSettings(input);
    if (!this.hasActiveExecution('page') || this.hasActiveExecution('group')) {
      this.activeConcurrencyCap = Math.max(1, saved.maxConcurrentProfiles);
    }
    for (const q of this.queuedTasks) {
      if (q.mode === 'group') q.settings = saved;
    }
    for (const [id, m] of this.activeWorkerModes.entries()) {
      if (m === 'group') {
        const live = this.activeWorkerSettings.get(id);
        if (live) Object.assign(live, saved);
        void this.devices.setInstanceSoundEnabled?.(id, Boolean(saved.enableSound)).catch(() => {});
      }
    }
    this.pumpWorkerPool();
    return this.state(false);
  }

  async savePageBumperSettings(input: unknown): Promise<BluestacksState> {
    const saved = this.repo.savePageBumperSettings
      ? await this.repo.savePageBumperSettings(input)
      : await this.repo.saveBumperSettings(input);
    if (!this.hasActiveExecution('group') || this.hasActiveExecution('page')) {
      this.activeConcurrencyCap = Math.max(1, saved.maxConcurrentProfiles);
    }
    for (const q of this.queuedTasks) {
      if (q.mode === 'page') q.settings = saved;
    }
    for (const [id, m] of this.activeWorkerModes.entries()) {
      if (m === 'page') {
        const live = this.activeWorkerSettings.get(id);
        if (live) Object.assign(live, saved);
        void this.devices.setInstanceSoundEnabled?.(id, Boolean(saved.enableSound)).catch(() => {});
      }
    }
    this.pumpWorkerPool();
    return this.state(false);
  }

  async syncMaxConcurrency(maxConcurrentProfiles: number): Promise<void> {
    const capped = Math.max(1, Math.min(50, Math.round(maxConcurrentProfiles)));
    const saved = await this.repo.savedSettings();
    const nextBumper =
      saved.bumperSettings.maxConcurrentProfiles !== capped
        ? { ...saved.bumperSettings, maxConcurrentProfiles: capped }
        : saved.bumperSettings;
    const pageBase = saved.pageBumperSettings ?? saved.bumperSettings;
    const nextPage =
      pageBase.maxConcurrentProfiles !== capped
        ? { ...pageBase, maxConcurrentProfiles: capped }
        : pageBase;
    if (saved.bumperSettings.maxConcurrentProfiles !== capped) {
      await this.repo.saveBumperSettings(nextBumper);
    }
    if (pageBase.maxConcurrentProfiles !== capped && this.repo.savePageBumperSettings) {
      await this.repo.savePageBumperSettings(nextPage);
    }
    this.activeConcurrencyCap = capped;
    this.pumpWorkerPool();
  }

  async createFolder(input: unknown): Promise<BluestacksState> {
    await this.repo.createFolder(input);
    return this.state(false);
  }

  async renameFolder(input: unknown): Promise<BluestacksState> {
    await this.repo.renameFolder(input);
    return this.state(false);
  }

  async deleteFolder(input: unknown): Promise<BluestacksState> {
    await this.repo.deleteFolder(input);
    return this.state(false);
  }

  async reorderFolders(input: unknown): Promise<BluestacksState> {
    await this.repo.reorderFolders(input);
    return this.state(false);
  }

  async renameInstance(input: unknown): Promise<BluestacksState> {
    await this.repo.renameInstance(input);
    return this.state(false);
  }

  async reorderInstances(input: unknown): Promise<BluestacksState> {
    await this.repo.reorderInstances(input);
    return this.state(false);
  }

  private async isExternallyBusy(instanceId: string): Promise<boolean> {
    if (!this.registry) return false;
    const ownIds = new Set([
      'bluestacks-group-bumper',
      'bluestacks-page-bumper',
      'bluestacks-active',
      'bluestacks-group-poster',
      'bluestacks-group-inviter',
      'bluestacks-batch-login',
      'bluestacks-health-check',
    ]);
    for (const p of this.registry.participants()) {
      if (ownIds.has(p.id)) continue;
      if (await p.isProfileRunning(instanceId)) return true;
    }
    return false;
  }

  async deleteInstances(input: unknown): Promise<BluestacksState> {
    const { instanceIds } = BluestacksInstanceIdsInput.parse(input);
    for (const id of instanceIds) {
      if (this.isProfileRunning(id) || (await this.isExternallyBusy(id))) {
        throw new ProductError(
          'INSTANCE_BUSY',
          '所选模拟器正在执行任务，请先停止后再移除记录',
          409,
        );
      }
    }
    await this.repo.deleteInstances({ instanceIds });
    return this.state(false);
  }

  async launchInstances(input: unknown): Promise<BluestacksState> {
    const { instanceIds } = BluestacksInstanceIdsInput.parse(input);
    const toLaunch = [...new Set(instanceIds)].filter(
      (id) => !this.launchingIds.has(id) && !this.closingIds.has(id),
    );
    if (toLaunch.length === 0) return this.state(false);

    for (const id of toLaunch) this.launchingIds.add(id);
    this.statusText = `正在启动 ${toLaunch.length} 个蓝蝶窗口…`;

    void (async () => {
      let okCount = 0;
      const errors: string[] = [];
      for (let i = 0; i < toLaunch.length; i++) {
        const id = toLaunch[i];
        if (!id) continue;
        try {
          await this.devices.launchInstance(id);
          await Promise.resolve(this.repo.saveLastStatus(id, '窗口已启动')).catch(() => {});
          okCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : '启动失败';
          errors.push(msg);
          await Promise.resolve(this.repo.saveLastStatus(id, `启动失败: ${msg}`)).catch(() => {});
        } finally {
          this.launchingIds.delete(id);
          this.invalidateDiscoveryCache();
        }
        if (i + 1 < toLaunch.length) {
          await delayMs(1200);
        }
      }
      this.statusText =
        errors.length === 0
          ? `已启动 ${okCount} 个蓝蝶窗口`
          : `窗口启动完成：成功 ${okCount} 个，异常 ${errors.length} 个（${errors[0]}）`;
    })();

    return this.state(false);
  }

  async closeInstances(input: unknown): Promise<BluestacksState> {
    const { instanceIds } = BluestacksInstanceIdsInput.parse(input);
    for (const id of instanceIds) {
      if (this.isProfileRunning(id) || (await this.isExternallyBusy(id))) {
        throw new ProductError(
          'INSTANCE_BUSY',
          '所选蓝蝶窗口正在执行顶贴或排班任务，请先停止任务后再关闭窗口',
          409,
        );
      }
    }
    const toClose = [...new Set(instanceIds)].filter((id) => !this.closingIds.has(id));
    if (toClose.length === 0) return this.state(false);

    for (const id of toClose) this.closingIds.add(id);
    this.statusText = `正在关闭 ${toClose.length} 个蓝蝶窗口…`;

    try {
      for (const id of toClose) {
        try {
          await this.devices.closeInstance(id);
          await Promise.resolve(this.repo.saveLastStatus(id, '已关闭')).catch(() => {});
          this.profileStats.delete(id);
          this.pageProfileStats.delete(id);
          this.activeProfileStats.delete(id);
          this.posterProfileStats.delete(id);
          this.inviterProfileStats.delete(id);
        } finally {
          this.closingIds.delete(id);
        }
      }
      this.invalidateDiscoveryCache();
      this.statusText = `已关闭 ${toClose.length} 个蓝蝶窗口`;
    } catch (err) {
      this.invalidateDiscoveryCache();
      throw err;
    }
    return this.state(true);
  }

  async inspectInstances(input: unknown): Promise<BluestacksState> {
    const { instanceIds } = BluestacksInstanceIdsInput.parse(input);
    const targets: string[] = [];
    for (const id of new Set(instanceIds)) {
      if (
        this.inspectingIds.has(id) ||
        this.launchingIds.has(id) ||
        this.closingIds.has(id) ||
        this.isProfileRunning(id) ||
        (await this.isExternallyBusy(id))
      ) {
        continue;
      }
      targets.push(id);
    }
    if (targets.length === 0) {
      throw new ProductError('NO_IDLE_INSTANCES', '所选模拟器正在执行操作，请稍候', 409);
    }

    for (const id of targets) this.inspectingIds.add(id);
    this.statusText = `正在识别 ${targets.length} 个蓝蝶窗口的 FB Lite 账号…`;

    void (async () => {
      let okCount = 0;
      const errors: string[] = [];
      for (const id of targets) {
        try {
          await this.ensureInstanceOnlineForManualAction(id, undefined, (msg) => {
            this.statusText = msg;
            void Promise.resolve(this.repo.saveLastStatus(id, msg)).catch(() => {});
          });
          const updated = await this.devices.inspectAccount(id);
          const inspectLabel =
            updated.accountState === 'verification'
              ? '账号需验证 (Checkpoint)'
              : updated.accountState === 'restricted'
                ? '账号已受限/停用'
                : `账号已识别 · ${updated.accountName || bluestacksDisplayTitle(updated)}`;
          await Promise.resolve(this.repo.saveLastStatus(id, inspectLabel)).catch(() => {});
          okCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : '账号识别失败';
          errors.push(msg);
          await Promise.resolve(this.repo.saveLastStatus(id, `识别失败 · ${msg}`)).catch(() => {});
        } finally {
          this.inspectingIds.delete(id);
          this.invalidateDiscoveryCache();
        }
      }
      this.statusText =
        errors.length === 0
          ? `账号识别完成：成功识别 ${okCount} 个窗口`
          : `账号识别完成：成功 ${okCount} 个，异常 ${errors.length} 个（${errors[0]}）`;
    })();

    return this.state(false);
  }

  /**
   * Ensures a portrait BlueStacks instance is online before executing a manual task or
   * single-instance action. If the emulator is currently closed, automatically launches it
   * (honoring serialized spawn pacing and AbortSignal cancellation).
   */
  private async ensureInstanceOnlineForManualAction(
    instanceId: string,
    signal?: AbortSignal,
    onStatus?: (text: string) => void,
  ): Promise<BluestacksInstance> {
    while (this.launchingIds.has(instanceId) && !signal?.aborted) {
      onStatus?.('等待蓝蝶窗口启动完成…');
      await delayMs(300, signal);
    }
    if (signal?.aborted) {
      throw new Error('TASK_STOPPED');
    }

    const snap = await this.getDiscoverySnapshot(false);
    const existing = snap.instances.find((i) => i.id === instanceId);
    if (!existing) {
      throw new ProductError('BLUESTACKS_INSTANCE_NOT_FOUND', '未找到指定的蓝蝶模拟器实例', 404);
    }
    if (!isBluestacksPortraitResolution(existing.fbWidth, existing.fbHeight)) {
      throw new ProductError(
        'BLUESTACKS_LANDSCAPE_UNSUPPORTED',
        `模拟器为横屏 (${existing.fbWidth}×${existing.fbHeight})，需改为竖屏`,
        400,
      );
    }
    if (existing.online) return existing;

    onStatus?.('正在自动启动蓝蝶窗口…');
    this.launchingIds.add(instanceId);
    try {
      const launched = await this.devices.launchInstance(instanceId, signal);
      await Promise.resolve(this.repo.saveLastStatus(instanceId, '窗口已自动启动')).catch(() => {});
      return launched;
    } finally {
      this.launchingIds.delete(instanceId);
      this.invalidateDiscoveryCache();
    }
  }

  private filterReadyInstancesForRun(
    profileIds: readonly string[],
    instances: readonly BluestacksInstance[],
    statsMap: Map<string, BumperProfileStat>,
  ): string[] {
    const instMap = new Map(instances.map((i) => [i.id, i]));
    const idleIds = [...new Set(profileIds)].filter((id) => !this.isProfileRunning(id));
    if (idleIds.length === 0) {
      throw new ProductError('INSTANCES_ALREADY_RUNNING', '所选模拟器已在运行队列中', 409);
    }

    const eligibleReady: string[] = [];
    const skippedReasons: string[] = [];
    for (const id of idleIds) {
      const inst = instMap.get(id);
      if (!inst) continue;
      const label = bluestacksDisplayTitle(inst);
      if (this.closingIds.has(id)) {
        skippedReasons.push(`${label} 正在关闭`);
        statsMap.set(id, {
          running: false,
          status: '跳过：窗口正在关闭',
          session: 0,
          today: 0,
        });
        continue;
      }
      if (!isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight)) {
        skippedReasons.push(`${label} 为横屏 (${inst.fbWidth}×${inst.fbHeight})`);
        statsMap.set(id, {
          running: false,
          status: `跳过：横屏 ${inst.fbWidth}×${inst.fbHeight}（需改竖屏）`,
          session: 0,
          today: 0,
        });
        continue;
      }
      eligibleReady.push(id);
    }

    if (eligibleReady.length === 0) {
      throw new ProductError(
        'NO_ONLINE_PORTRAIT_INSTANCES',
        skippedReasons.length > 0
          ? `无法启动运行：${skippedReasons.slice(0, 3).join('；')}`
          : '未找到可用的竖屏蓝蝶窗口，请先检查蓝蝶分辨率设置',
        400,
      );
    }
    return eligibleReady;
  }

  private countModeRunners(mode: BluestacksBumperMode): number {
    let n = 0;
    for (const m of this.activeWorkerModes.values()) {
      if (m === mode) n++;
    }
    for (const q of this.queuedTasks) {
      if (q.mode === mode) n++;
    }
    return n;
  }

  async startBumper(input: unknown): Promise<BluestacksState> {
    const { profileIds, groupIds, pageIds } = StartBluestacksBumperInput.parse(input);
    const [{ instances }, allGroups, allPages, saved, counts] = await Promise.all([
      this.getDiscoverySnapshot(true),
      this.repo.targets('groups'),
      this.repo.targets('pages'),
      this.repo.savedSettings(),
      this.repo.todayCounts(undefined, 'group'),
    ]);

    const selectedGroups = allGroups.filter((g) => groupIds.includes(g.id));
    const selectedPages = allPages.filter((p) => pageIds.includes(p.id));
    if (selectedGroups.length === 0 || selectedPages.length === 0) {
      throw new ProductError('BUMPER_TARGETS_EMPTY', '请至少选择一个有效小组和一个目标主页', 400);
    }

    const rawReady = this.filterReadyInstancesForRun(profileIds, instances, this.profileStats);
    const idleReady: string[] = [];
    for (const id of rawReady) {
      if (!(await this.isExternallyBusy(id))) idleReady.push(id);
    }
    if (idleReady.length === 0) {
      throw new ProductError('NO_IDLE_INSTANCES', '所选蓝蝶窗口正忙于其他任务，请稍候再试', 409);
    }
    const onlineReady = await this.filterInstancesByRiskQuota(idleReady, 'bump', this.profileStats);
    const settings = saved.bumperSettings;
    this.activeConcurrencyCap = Math.max(1, settings.maxConcurrentProfiles);
    const staggeredGroupQueues = buildStaggeredBumperQueues(onlineReady, selectedGroups);

    for (const id of onlineReady) {
      const controller = new AbortController();
      this.abortControllers.set(id, controller);
      this.queuedTasks.push({
        instanceId: id,
        mode: 'group',
        groups: staggeredGroupQueues.get(id) ?? [...selectedGroups],
        pages: [...selectedPages],
        settings,
        controller,
      });
      this.profileStats.set(id, {
        running: true,
        status: '排队等待并发槽位…',
        session: 0,
        today: counts[id] ?? 0,
      });
    }

    this.statusText = `正在运行 ${this.countModeRunners('group')} 个蓝蝶模拟器（最大并发 ${this.activeConcurrencyCap}）`;
    this.pumpWorkerPool();
    return this.state(false);
  }

  async startPageBumper(input: unknown): Promise<BluestacksState> {
    const { profileIds, pageIds } = StartBluestacksPageBumperInput.parse(input);
    const [{ instances }, allPages, saved, counts] = await Promise.all([
      this.getDiscoverySnapshot(true),
      this.repo.targets('pages'),
      this.repo.savedSettings(),
      this.repo.todayCounts(undefined, 'page'),
    ]);

    const selectedPages = allPages.filter((p) => pageIds.includes(p.id));
    if (selectedPages.length === 0) {
      throw new ProductError('BUMPER_TARGETS_EMPTY', '请至少选择一个有效的目标专页', 400);
    }

    const rawReady = this.filterReadyInstancesForRun(profileIds, instances, this.pageProfileStats);
    const idleReady: string[] = [];
    for (const id of rawReady) {
      if (!(await this.isExternallyBusy(id))) idleReady.push(id);
    }
    if (idleReady.length === 0) {
      throw new ProductError('NO_IDLE_INSTANCES', '所选蓝蝶窗口正忙于其他任务，请稍候再试', 409);
    }
    const onlineReady = await this.filterInstancesByRiskQuota(
      idleReady,
      'bump',
      this.pageProfileStats,
    );
    const settings = saved.pageBumperSettings ?? saved.bumperSettings;
    this.activeConcurrencyCap = Math.max(1, settings.maxConcurrentProfiles);
    const staggeredPageQueues = buildStaggeredBumperQueues(onlineReady, selectedPages);

    for (const id of onlineReady) {
      const controller = new AbortController();
      this.abortControllers.set(id, controller);
      this.queuedTasks.push({
        instanceId: id,
        mode: 'page',
        groups: [],
        pages: staggeredPageQueues.get(id) ?? [...selectedPages],
        settings,
        controller,
      });
      this.pageProfileStats.set(id, {
        running: true,
        status: '排队等待并发槽位…',
        session: 0,
        today: counts[id] ?? 0,
      });
    }

    this.pageStatusText = `正在运行 ${this.countModeRunners('page')} 个蓝蝶模拟器（最大并发 ${this.activeConcurrencyCap}）`;
    this.pumpWorkerPool();
    return this.state(false);
  }

  private pumpWorkerPool(): void {
    if (this.pumpingPool) return;
    this.pumpingPool = true;
    try {
      while (this.activeWorkers.size < this.activeConcurrencyCap && this.queuedTasks.length > 0) {
        const nextTask = this.queuedTasks.shift();
        if (!nextTask) break;
        if (nextTask.controller.signal.aborted) {
          this.abortControllers.delete(nextTask.instanceId);
          continue;
        }
        const slotIndex = this.activeWorkers.size;
        nextTask.settings = { ...nextTask.settings };
        this.activeWorkerModes.set(nextTask.instanceId, nextTask.mode);
        this.activeWorkerSettings.set(nextTask.instanceId, nextTask.settings);
        const workerPromise = this.executeInstanceTask(nextTask, slotIndex * 650).finally(() => {
          this.activeWorkers.delete(nextTask.instanceId);
          this.activeWorkerModes.delete(nextTask.instanceId);
          this.activeWorkerSettings.delete(nextTask.instanceId);
          this.abortControllers.delete(nextTask.instanceId);
          if (nextTask.mode === 'page') {
            if (this.hasActiveExecution('page')) {
              this.pageStatusText = `正在运行 ${this.countModeRunners('page')} 个蓝蝶模拟器`;
            } else {
              this.pageStatusText = '蓝蝶专页顶贴运行结束';
            }
          } else {
            if (this.hasActiveExecution('group')) {
              this.statusText = `正在运行 ${this.countModeRunners('group')} 个蓝蝶模拟器`;
            } else {
              this.statusText = '蓝蝶小组顶贴运行结束';
            }
          }
          if (this.hasActiveExecution()) {
            this.pumpWorkerPool();
          }
        });
        this.activeWorkers.set(nextTask.instanceId, workerPromise);
      }
    } finally {
      this.pumpingPool = false;
    }
  }

  private async executeInstanceTask(
    task: QueuedBluestacksTask,
    initialDelayMs: number,
  ): Promise<void> {
    const { instanceId, mode, groups, pages, settings, controller } = task;
    const isPage = mode === 'page';
    const modeLabel = isPage ? '蓝蝶专页顶贴' : '蓝蝶小组顶贴';
    const statsMap = isPage ? this.pageProfileStats : this.profileStats;

    const setStat = (patch: Partial<BumperProfileStat>) => {
      const prev = statsMap.get(instanceId) ?? {
        running: true,
        status: '准备中…',
        session: 0,
        today: 0,
      };
      statsMap.set(instanceId, { ...prev, ...patch });
    };

    try {
      if (initialDelayMs > 0 && !controller.signal.aborted) {
        await delayMs(initialDelayMs, controller.signal);
      }
      while (
        (this.inspectingIds.has(instanceId) || this.launchingIds.has(instanceId)) &&
        !controller.signal.aborted
      ) {
        setStat({ running: true, status: '等待窗口就绪/账号识别完成…' });
        await delayMs(300, controller.signal);
      }
      if (controller.signal.aborted) {
        setStat({ running: false, status: '已停止' });
        await this.repo.saveLastStatus(instanceId, `上次已停止 · ${modeLabel}`);
        return;
      }

      // Auto-launch closed portrait instance seamlessly inside concurrency slot
      await this.ensureInstanceOnlineForManualAction(instanceId, controller.signal, (msg) => {
        setStat({ running: true, status: msg });
        if (isPage) this.pageStatusText = msg;
        else this.statusText = msg;
      });

      if (controller.signal.aborted) {
        setStat({ running: false, status: '已停止' });
        await this.repo.saveLastStatus(instanceId, `上次已停止 · ${modeLabel}`);
        return;
      }

      setStat({ running: true, status: '正在启动任务…' });
      await this.runner.run(
        instanceId,
        groups,
        pages,
        settings,
        controller.signal,
        {
          status: (text, today) => {
            setStat({
              running: true,
              status: text,
              ...(today !== undefined ? { today } : {}),
            });
            if (isPage) this.pageStatusText = text;
            else this.statusText = text;
          },
          added: (today) => {
            const cur = statsMap.get(instanceId);
            setStat({
              session: (cur?.session ?? 0) + 1,
              today,
            });
            void this.checkInstanceRiskQuota(instanceId, 'bump').then((q) => {
              if (!q.allowed && !controller.signal.aborted) {
                controller.abort(
                  new Error(
                    `RISK_LIMIT_REACHED:${q.reason ?? '今日已达蓝蝶风控安全上限，自动休眠保护'}`,
                  ),
                );
              }
            });
          },
        },
        mode,
      );

      const finalStat = statsMap.get(instanceId);
      const addedCount = finalStat?.session ?? 0;
      const doneMsg = `已完成（本次顶贴 ${addedCount} 条）`;
      setStat({ running: false, status: doneMsg });
      await this.repo.saveLastStatus(
        instanceId,
        `上次成功 · ${isPage ? '专页顶贴' : '顶贴'} ${addedCount} 条`,
      );
    } catch (err) {
      const riskReason = this.extractRiskLimitAbortReason(controller.signal, err);
      if (riskReason) {
        setStat({ running: false, status: riskReason });
        await this.repo.saveLastStatus(instanceId, riskReason.slice(0, 120));
        return;
      }
      const rawMsg = err instanceof Error ? err.message : '运行异常';
      const isStopped = controller.signal.aborted || rawMsg === 'TASK_STOPPED';
      const displayMsg = isStopped ? '已停止' : rawMsg;
      setStat({ running: false, status: displayMsg });
      await this.repo.saveLastStatus(
        instanceId,
        isStopped ? `上次已停止 · ${modeLabel}` : `上次异常 · ${rawMsg.slice(0, 80)}`,
      );
    }
  }

  async stopBumper(ids?: readonly string[], mode?: BluestacksBumperMode): Promise<BluestacksState> {
    const targetIds = ids && ids.length > 0 ? new Set(ids) : null;
    const matchedIds = targetIds
      ? [...targetIds]
      : [
          ...new Set([
            ...[...this.activeWorkers.keys()].filter(
              (id) => !mode || this.activeWorkerModes.get(id) === mode,
            ),
            ...this.queuedTasks.filter((q) => !mode || q.mode === mode).map((q) => q.instanceId),
          ]),
        ];

    for (let i = this.queuedTasks.length - 1; i >= 0; i--) {
      const q = this.queuedTasks[i];
      if (q && (!targetIds || targetIds.has(q.instanceId)) && (!mode || q.mode === mode)) {
        q.controller.abort(new Error('TASK_STOPPED'));
        this.abortControllers.delete(q.instanceId);
        this.queuedTasks.splice(i, 1);
        const statsMap = q.mode === 'page' ? this.pageProfileStats : this.profileStats;
        const modeLabel = q.mode === 'page' ? '蓝蝶专页顶贴' : '蓝蝶小组顶贴';
        const cur = statsMap.get(q.instanceId);
        statsMap.set(q.instanceId, {
          running: false,
          status: '已停止',
          session: cur?.session ?? 0,
          today: cur?.today ?? 0,
        });
        await this.repo.saveLastStatus(q.instanceId, `上次已停止 · ${modeLabel}`);
      }
    }

    const activePromisesToWait: Promise<void>[] = [];
    for (const id of matchedIds) {
      const activeMode = this.activeWorkerModes.get(id);
      if (mode && activeMode && activeMode !== mode) continue;
      const ctrl = this.abortControllers.get(id);
      if (ctrl) ctrl.abort(new Error('TASK_STOPPED'));
      const worker = this.activeWorkers.get(id);
      if (worker) {
        const statsMap = activeMode === 'page' ? this.pageProfileStats : this.profileStats;
        const cur = statsMap.get(id);
        if (cur) {
          statsMap.set(id, { ...cur, status: '正在停止…' });
        }
        activePromisesToWait.push(worker);
      }
    }

    if (activePromisesToWait.length > 0) {
      await Promise.allSettled(activePromisesToWait);
    }

    if ((!mode || mode === 'group') && !this.hasActiveExecution('group')) {
      this.statusText = '已停止蓝蝶小组顶贴任务';
    }
    if ((!mode || mode === 'page') && !this.hasActiveExecution('page')) {
      this.pageStatusText = '已停止蓝蝶专页顶贴任务';
    }
    return this.state(false);
  }

  parseStopInput(input: unknown): string[] | undefined {
    if (!input || (typeof input === 'object' && Object.keys(input).length === 0)) {
      return undefined;
    }
    return StopBluestacksBumperInput.parse(input).profileIds;
  }

  /**
   * 供「定时排班」使用的阻塞式单实例启动与竖屏就绪校验。
   */
  async ensureInstanceOnlineForSchedule(
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<BluestacksInstance> {
    const { instances } = await this.getDiscoverySnapshot(true);
    const existing = instances.find((i) => i.id === instanceId);
    if (!existing) {
      throw new ProductError('BLUESTACKS_INSTANCE_NOT_FOUND', '未找到指定的蓝蝶模拟器实例', 404);
    }
    if (!isBluestacksPortraitResolution(existing.fbWidth, existing.fbHeight)) {
      throw new ProductError(
        'BLUESTACKS_LANDSCAPE_UNSUPPORTED',
        `模拟器为横屏 (${existing.fbWidth}×${existing.fbHeight})，需改为竖屏`,
        400,
      );
    }
    if (existing.online) return existing;

    this.launchingIds.add(instanceId);
    try {
      const launched = await this.devices.launchInstance(instanceId, signal);
      await this.repo.saveLastStatus(instanceId, '排班自动启动成功');
      return launched;
    } finally {
      this.launchingIds.delete(instanceId);
      this.invalidateDiscoveryCache();
    }
  }

  /**
   * 供「定时排班」使用的单模拟器顶贴步骤执行。
   */
  async runScheduledInstanceStep(input: {
    instanceId: string;
    mode: BluestacksBumperMode;
    groupIds: string[];
    pageIds: string[];
    enableSound?: boolean | undefined;
    minConcurrency: number;
    signal?: AbortSignal | undefined;
    onProgress: (status: string, sessionBumps: number) => void;
  }): Promise<{
    bumpedCount: number;
    status: string;
    hardBlocked: boolean;
    softIssue: boolean;
  }> {
    const { instanceId, mode, onProgress } = input;
    if (
      this.isProfileRunning(instanceId) ||
      this.closingIds.has(instanceId) ||
      this.inspectingIds.has(instanceId)
    ) {
      return {
        bumpedCount: 0,
        status: '跳过：该蓝蝶实例正在执行其他操作',
        hardBlocked: false,
        softIssue: true,
      };
    }
    const isPage = mode === 'page';
    const modeLabel = isPage ? '蓝蝶专页顶贴' : '蓝蝶小组顶贴';
    const [allGroups, allPages, saved, counts] = await Promise.all([
      this.repo.targets('groups'),
      this.repo.targets('pages'),
      this.repo.savedSettings(),
      this.repo.todayCounts(undefined, mode),
    ]);
    const selectedPages = allPages.filter((p) => input.pageIds.includes(p.id));
    const selectedGroups = isPage ? [] : allGroups.filter((g) => input.groupIds.includes(g.id));
    if (selectedPages.length === 0 || (!isPage && selectedGroups.length === 0)) {
      return {
        bumpedCount: 0,
        status: '跳过：未找到有效的目标小组或专页',
        hardBlocked: false,
        softIssue: true,
      };
    }

    const riskPre = await this.checkInstanceRiskQuota(instanceId, 'bump');
    if (!riskPre.allowed) {
      const msg = riskPre.reason ?? '今日已达蓝蝶风控安全上限，自动休眠保护';
      await Promise.resolve(this.repo.saveLastStatus(instanceId, msg.slice(0, 120))).catch(
        () => {},
      );
      return {
        bumpedCount: 0,
        status: msg,
        hardBlocked: false,
        softIssue: true,
      };
    }

    const baseSettings = isPage
      ? (saved.pageBumperSettings ?? saved.bumperSettings)
      : saved.bumperSettings;
    const settings: BumperSettings = {
      ...baseSettings,
      maxConcurrentProfiles: Math.max(baseSettings.maxConcurrentProfiles, input.minConcurrency),
      ...(input.enableSound !== undefined ? { enableSound: input.enableSound } : {}),
    };

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(new Error('TASK_STOPPED'));
    input.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const statsMap = isPage ? this.pageProfileStats : this.profileStats;
    const stat: BumperProfileStat = {
      running: true,
      status: '正在启动顶贴…',
      session: 0,
      today: counts[instanceId] ?? 0,
    };
    statsMap.set(instanceId, stat);
    this.abortControllers.set(instanceId, controller);
    this.activeWorkerModes.set(instanceId, mode);
    this.activeWorkerSettings.set(instanceId, settings);

    let hardBlocked = false;
    let softIssue = false;

    const workerPromise = (async () => {
      try {
        await this.runner.run(
          instanceId,
          selectedGroups,
          selectedPages,
          settings,
          controller.signal,
          {
            status: (text, today) => {
              stat.status = text;
              if (today !== undefined) stat.today = today;
              onProgress(text, stat.session);
            },
            added: (today) => {
              stat.session += 1;
              stat.today = today;
              onProgress(stat.status, stat.session);
              void this.checkInstanceRiskQuota(instanceId, 'bump').then((q) => {
                if (!q.allowed && !controller.signal.aborted) {
                  controller.abort(
                    new Error(
                      `RISK_LIMIT_REACHED:${q.reason ?? '今日已达蓝蝶风控安全上限，自动休眠保护'}`,
                    ),
                  );
                }
              });
            },
          },
          mode,
        );
        stat.running = false;
        stat.status = `已完成（本次顶贴 ${stat.session} 条）`;
        await this.repo.saveLastStatus(instanceId, `排班完成 · ${modeLabel} ${stat.session} 条`);
      } catch (err) {
        const riskReason = this.extractRiskLimitAbortReason(controller.signal, err);
        if (riskReason) {
          stat.running = false;
          stat.status = riskReason;
          softIssue = true;
          await this.repo.saveLastStatus(instanceId, riskReason.slice(0, 120));
          return;
        }
        const rawMsg = err instanceof Error ? err.message : '运行异常';
        const isStopped = controller.signal.aborted || rawMsg === 'TASK_STOPPED';
        stat.running = false;
        stat.status = isStopped ? '已停止' : rawMsg;
        if (!isStopped) {
          if (/退出登录|未登录|需验证|安全验证|Checkpoint|封号|封禁|停用|账号异常/i.test(rawMsg)) {
            hardBlocked = true;
          } else {
            softIssue = true;
          }
        }
        await this.repo.saveLastStatus(
          instanceId,
          isStopped ? `排班停止 · ${modeLabel}` : `排班异常 · ${rawMsg.slice(0, 80)}`,
        );
      } finally {
        input.signal?.removeEventListener('abort', onExternalAbort);
      }
    })();

    this.activeWorkers.set(instanceId, workerPromise);
    try {
      await workerPromise;
    } finally {
      this.activeWorkers.delete(instanceId);
      this.activeWorkerModes.delete(instanceId);
      this.activeWorkerSettings.delete(instanceId);
      this.abortControllers.delete(instanceId);
    }

    return {
      bumpedCount: stat.session,
      status: stat.status,
      hardBlocked,
      softIssue,
    };
  }

  /**
   * 排班收尾强制停止并关闭指定蓝蝶实例窗口。
   */
  async closeInstanceForce(instanceId: string): Promise<void> {
    if (this.isProfileRunning(instanceId)) {
      await this.stopAllForInstances([instanceId]).catch(() => {});
    }
    this.closingIds.add(instanceId);
    try {
      await this.devices.closeInstance(instanceId);
      await this.repo.saveLastStatus(instanceId, '排班结束已自动关闭');
      this.profileStats.delete(instanceId);
      this.pageProfileStats.delete(instanceId);
      this.activeProfileStats.delete(instanceId);
      this.posterProfileStats.delete(instanceId);
      this.inviterProfileStats.delete(instanceId);
    } finally {
      this.closingIds.delete(instanceId);
      this.invalidateDiscoveryCache();
    }
  }

  // ---- Window, APK, Identity & Auto-Login Controls ----

  async showInstance(input: unknown): Promise<BluestacksState> {
    const { instanceId } = BluestacksShowInstanceInput.parse(input);
    if (!this.devices.showInstance) {
      throw new ProductError('BLUESTACKS_UNSUPPORTED', '当前环境不支持窗口置前', 400);
    }
    await this.devices.showInstance(instanceId);
    return this.state(false);
  }

  async arrangeWindows(input: unknown): Promise<BluestacksState> {
    const parsed = BluestacksArrangeWindowsInput.parse(input ?? {});
    if (!this.devices.arrangeWindows) {
      throw new ProductError('BLUESTACKS_UNSUPPORTED', '当前环境不支持自动平铺窗口', 400);
    }
    const arranged = await this.devices.arrangeWindows(parsed.instanceIds, {
      columns: parsed.columns,
      gap: parsed.gap,
    });
    this.statusText =
      arranged > 0 ? `已自动平铺 ${arranged} 个蓝蝶窗口` : '当前没有可平铺的在线蓝蝶窗口';
    return this.state(false);
  }

  async installApk(input: unknown): Promise<BluestacksState> {
    const { instanceIds, apkPath } = BluestacksInstallApkInput.parse(input);
    if (!this.devices.installFbLiteApk) {
      throw new ProductError('BLUESTACKS_UNSUPPORTED', '当前环境不支持自动安装 FB Lite APK', 400);
    }
    const targets = [...new Set(instanceIds)].filter(
      (id) => !this.installingIds.has(id) && !this.isProfileRunning(id),
    );
    if (targets.length === 0) {
      throw new ProductError('NO_IDLE_INSTANCES', '所选蓝蝶窗口正忙，请稍候再试', 409);
    }
    for (const id of targets) this.installingIds.add(id);
    this.statusText = `正在为 ${targets.length} 个蓝蝶窗口安装 FB Lite…`;

    void (async () => {
      let ok = 0;
      const errs: string[] = [];
      for (const id of targets) {
        try {
          await this.ensureInstanceOnlineForManualAction(id, undefined, (msg) => {
            this.statusText = msg;
            void Promise.resolve(this.repo.saveLastStatus(id, msg)).catch(() => {});
          });
          const updated = await this.devices.installFbLiteApk?.(id, apkPath);
          await Promise.resolve(
            this.repo.saveLastStatus(
              id,
              `已安装 FB Lite${updated?.fbLiteVersion ? ' ' + updated.fbLiteVersion : ''}`,
            ),
          ).catch(() => {});
          ok++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : '安装失败';
          errs.push(msg);
          await Promise.resolve(
            this.repo.saveLastStatus(id, `安装失败 · ${msg.slice(0, 80)}`),
          ).catch(() => {});
        } finally {
          this.installingIds.delete(id);
          this.invalidateDiscoveryCache();
        }
      }
      this.statusText =
        errs.length === 0
          ? `FB Lite 安装完成：成功 ${ok} 个窗口`
          : `FB Lite 安装完成：成功 ${ok} 个，失败 ${errs.length} 个（${errs[0]}）`;
    })();

    return this.state(false);
  }

  async switchIdentity(input: unknown): Promise<BluestacksState> {
    const parsed = BluestacksSwitchIdentityInput.parse(input);
    if (!this.devices.switchIdentity) {
      throw new ProductError('BLUESTACKS_UNSUPPORTED', '当前环境不支持切换身份', 400);
    }
    if (this.isProfileRunning(parsed.instanceId) || this.switchingIds.has(parsed.instanceId)) {
      throw new ProductError('INSTANCE_BUSY', '该蓝蝶窗口正在执行其他操作，请先停止', 409);
    }
    this.switchingIds.add(parsed.instanceId);
    try {
      await this.ensureInstanceOnlineForManualAction(parsed.instanceId, undefined, (msg) => {
        this.statusText = msg;
      });
      const updated = await this.devices.switchIdentity(parsed.instanceId, {
        targetName: parsed.targetName,
        targetType: parsed.targetType,
      });
      const roleLabel = updated.identityType === 'page' ? '专页' : '个人';
      await Promise.resolve(
        this.repo.saveLastStatus(
          parsed.instanceId,
          `已切换为${roleLabel}身份 · ${updated.accountName || bluestacksDisplayTitle(updated)}`,
        ),
      ).catch(() => {});
      this.statusText = `已切换为${roleLabel}身份：${updated.accountName}`;
      this.invalidateDiscoveryCache();
    } finally {
      this.switchingIds.delete(parsed.instanceId);
    }
    return this.state(true);
  }

  async loginInstance(input: unknown): Promise<BluestacksState> {
    const parsed = BluestacksLoginInput.parse(input);
    if (!this.devices.loginAccount) {
      throw new ProductError('BLUESTACKS_UNSUPPORTED', '当前环境不支持自动登录', 400);
    }
    if (this.isProfileRunning(parsed.instanceId) || this.loggingInIds.has(parsed.instanceId)) {
      throw new ProductError('INSTANCE_BUSY', '该蓝蝶窗口正在执行其他操作，请稍候再试', 409);
    }
    this.loggingInIds.add(parsed.instanceId);
    this.statusText = '正在自动登录 FB Lite 账号…';

    void (async () => {
      try {
        await this.ensureInstanceOnlineForManualAction(parsed.instanceId, undefined, (msg) => {
          this.statusText = msg;
          void Promise.resolve(this.repo.saveLastStatus(parsed.instanceId, msg)).catch(() => {});
        });
        const updated = await this.devices.loginAccount?.(
          parsed.instanceId,
          {
            account: parsed.account,
            password: parsed.password,
            totpSecret: parsed.totpSecret,
            saveLoginInfo: parsed.saveLoginInfo,
            ifAlreadyLoggedIn: parsed.ifAlreadyLoggedIn,
          },
          undefined,
          (progressText) => {
            this.statusText = progressText;
            void Promise.resolve(this.repo.saveLastStatus(parsed.instanceId, progressText)).catch(
              () => {},
            );
          },
        );
        if (updated) {
          const msg = `登录成功 · ${updated.accountName || bluestacksDisplayTitle(updated)}`;
          this.statusText = msg;
          await Promise.resolve(this.repo.saveLastStatus(parsed.instanceId, msg)).catch(() => {});
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '自动登录失败';
        this.statusText = `登录失败：${msg}`;
        await Promise.resolve(
          this.repo.saveLastStatus(parsed.instanceId, `登录失败 · ${msg.slice(0, 80)}`),
        ).catch(() => {});
      } finally {
        this.loggingInIds.delete(parsed.instanceId);
        this.invalidateDiscoveryCache();
      }
    })();

    return this.state(false);
  }

  private recomputeBatchLoginCounts(state: BluestacksBatchLoginState): void {
    let completed = 0;
    let succeeded = 0;
    let skipped = 0;
    let verification = 0;
    let restricted = 0;
    let failed = 0;
    let stopped = 0;
    for (const item of state.items) {
      if (item.status === 'queued' || item.status === 'running') continue;
      completed++;
      if (item.status === 'succeeded') succeeded++;
      else if (item.status === 'skipped') skipped++;
      else if (item.status === 'verification') verification++;
      else if (item.status === 'restricted') restricted++;
      else if (item.status === 'failed') failed++;
      else if (item.status === 'stopped') stopped++;
    }
    state.completed = completed;
    state.succeeded = succeeded;
    state.skipped = skipped;
    state.verification = verification;
    state.restricted = restricted;
    state.failed = failed;
    state.stopped = stopped;
    if (state.running) {
      state.statusText = `正在批量登录 (${completed}/${state.total} · 成功 ${succeeded}${
        verification + restricted + failed > 0
          ? ` · 异常/失败 ${verification + restricted + failed}`
          : ''
      })`;
    } else {
      const parts: string[] = [`成功 ${succeeded}`];
      if (skipped > 0) parts.push(`跳过 ${skipped}`);
      if (verification > 0) parts.push(`待验证 ${verification}`);
      if (restricted > 0) parts.push(`受限 ${restricted}`);
      if (failed > 0) parts.push(`失败 ${failed}`);
      if (stopped > 0) parts.push(`已停 ${stopped}`);
      state.statusText = `批量登录已结束 (${completed}/${state.total} · ${parts.join(' / ')})`;
    }
  }

  /**
   * Starts a concurrent batch FB Lite auto-login queue across multiple BlueStacks instances.
   * Credentials & TOTP secrets exist ONLY in volatile worker memory and are immediately scrubbed
   * upon each item's completion, stop, or error.
   */
  async startBatchLogin(input: unknown): Promise<BluestacksState> {
    if (this.batchLoginStarting || this.batchLoginState?.running) {
      throw new ProductError(
        'BATCH_LOGIN_ALREADY_RUNNING',
        '当前已有批量自动登录任务正在运行，请等待完成或先停止',
        409,
      );
    }
    const parsed = StartBluestacksBatchLoginInput.parse(input);
    if (!this.devices.loginAccount && !this.devices.loginAccountDetailed) {
      throw new ProductError('BLUESTACKS_UNSUPPORTED', '当前环境不支持自动登录', 400);
    }
    const seenIds = new Set<string>();
    for (const item of parsed.items) {
      if (seenIds.has(item.instanceId)) {
        throw new ProductError(
          'BATCH_LOGIN_DUPLICATE_INSTANCE',
          '批量登录列表中存在重复的蓝蝶实例，请确保每个蓝蝶窗口仅分配一个账号',
          400,
        );
      }
      seenIds.add(item.instanceId);
    }

    this.batchLoginStarting = true;
    try {
      const { instances } = await this.getDiscoverySnapshot(true);
      const byId = new Map(instances.map((i) => [i.id, i]));
      const saved = await this.repo.savedSettings();
      const cap = Math.max(
        1,
        Math.min(
          parsed.maxConcurrency,
          Math.max(saved.bumperSettings.maxConcurrentProfiles, this.activeConcurrencyCap, 1),
        ),
      );

      const batchAbort = new AbortController();
      const progressItems: BluestacksBatchLoginItemProgress[] = parsed.items.map((entry) => {
        const inst = byId.get(entry.instanceId);
        return {
          instanceId: entry.instanceId,
          instanceName: inst ? bluestacksDisplayTitle(inst) : entry.instanceId.slice(0, 8),
          maskedAccount: maskLoginAccountLabel(entry.account),
          hasTotp: Boolean(entry.totpSecret?.trim()),
          status: 'queued',
          stepText: '排队等待并发槽位…',
        };
      });

      const runState: BluestacksBatchLoginState = {
        runId: crypto.randomUUID(),
        running: true,
        startedAt: Date.now(),
        finishedAt: null,
        total: progressItems.length,
        completed: 0,
        succeeded: 0,
        skipped: 0,
        verification: 0,
        restricted: 0,
        failed: 0,
        stopped: 0,
        statusText: `准备批量登录 ${progressItems.length} 台蓝蝶（并发 ${cap}）…`,
        items: progressItems,
      };

      const volatileQueue = parsed.items.map((entry, idx) => ({
        index: idx,
        instanceId: entry.instanceId,
        account: entry.account,
        password: entry.password,
        totpSecret: entry.totpSecret ? normalizeTotpSecret(entry.totpSecret) : '',
      }));

      const scrubEntry = (e: { account: string; password: string; totpSecret: string }) => {
        e.account = '';
        e.password = '';
        e.totpSecret = '';
      };

      this.batchLoginState = runState;
      this.batchLoginAbort = batchAbort;
      this.statusText = runState.statusText;

      const executeOne = async (entry: (typeof volatileQueue)[number]) => {
        const item = progressItems[entry.index];
        if (!item) {
          scrubEntry(entry);
          return;
        }
        const itemCtrl = new AbortController();
        const onBatchAbort = () => itemCtrl.abort(new Error('TASK_STOPPED'));
        if (batchAbort.signal.aborted) {
          itemCtrl.abort(new Error('TASK_STOPPED'));
        } else {
          batchAbort.signal.addEventListener('abort', onBatchAbort, { once: true });
        }

        const setStep = (text: string) => {
          item.stepText = text;
          this.statusText = `${item.instanceName}：${text}`;
          void Promise.resolve(
            this.repo.saveLastStatus(entry.instanceId, text.slice(0, 120)),
          ).catch(() => {});
        };

        let launchedByBatch = false;
        let shouldCloseOnExit = false;
        let claimedExtra = false;
        const workerEntry: {
          kind: 'batch-login';
          controller: AbortController;
          promise: Promise<void>;
        } = {
          kind: 'batch-login',
          controller: itemCtrl,
          promise: Promise.resolve(),
        };

        const workerPromise = (async () => {
          try {
            if (itemCtrl.signal.aborted) {
              item.status = 'stopped';
              item.stepText = '已停止';
              return;
            }
            item.status = 'running';
            item.startedAt = Date.now();

            const snap = await this.getDiscoverySnapshot(false);
            let inst = snap.instances.find((i) => i.id === entry.instanceId);
            if (!inst) {
              item.status = 'failed';
              item.error = '蓝蝶实例不存在';
              item.stepText = '实例不存在';
              return;
            }
            item.instanceName = bluestacksDisplayTitle(inst);

            if (!isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight)) {
              item.status = 'skipped';
              item.error = `横屏分辨率 (${inst.fbWidth}×${inst.fbHeight}) 不支持`;
              item.stepText = item.error;
              return;
            }
            const busyExternally = this.registry
              ? await this.registry.isProfileBusy(entry.instanceId, 'bluestacks-batch-login')
              : false;
            // Final synchronous TOCTOU guard immediately before claiming extraWorkers
            const activeExtra = this.extraWorkers.get(entry.instanceId);
            const busyInOtherWorker =
              this.activeWorkers.has(entry.instanceId) ||
              this.queuedTasks.some((t) => t.instanceId === entry.instanceId) ||
              this.queuedExtraTasks.has(entry.instanceId) ||
              activeExtra !== undefined;
            if (
              busyExternally ||
              busyInOtherWorker ||
              this.closingIds.has(entry.instanceId) ||
              this.launchingIds.has(entry.instanceId) ||
              this.loggingInIds.has(entry.instanceId)
            ) {
              item.status = 'skipped';
              item.error = '实例正在执行其他任务，已跳过';
              item.stepText = item.error;
              return;
            }
            this.extraWorkers.set(entry.instanceId, workerEntry);
            claimedExtra = true;

            if (
              parsed.ifAlreadyLoggedIn === 'skip' &&
              inst.accountState === 'logged-in' &&
              inst.accountName
            ) {
              item.status = 'skipped';
              item.accountName = inst.accountName;
              item.numericAccountId = inst.numericAccountId || undefined;
              item.stepText = `已登录（${inst.accountName}），按策略跳过`;
              return;
            }

            this.loggingInIds.add(entry.instanceId);

            if (!inst.online) {
              if (!parsed.autoLaunch) {
                item.status = 'skipped';
                item.error = '实例未启动且未开启自动拉起';
                item.stepText = item.error;
                return;
              }
              setStep('正在自动启动蓝蝶窗口…');
              this.launchingIds.add(entry.instanceId);
              try {
                inst = await this.devices.launchInstance(entry.instanceId, itemCtrl.signal);
                launchedByBatch = true;
                shouldCloseOnExit = parsed.closeOnFinish;
              } finally {
                this.launchingIds.delete(entry.instanceId);
                this.invalidateDiscoveryCache();
              }
            } else {
              shouldCloseOnExit = parsed.closeOnFinish;
            }

            if (itemCtrl.signal.aborted) {
              item.status = 'stopped';
              item.stepText = '已停止';
              return;
            }

            const probeInstalled = this.devices.probeFbLiteInstalled
              ? await this.devices.probeFbLiteInstalled(inst.serial, true, itemCtrl.signal)
              : inst.fbLiteInstalled;
            if (probeInstalled === false) {
              if (!parsed.autoInstallApk || !this.devices.installFbLiteApk) {
                item.status = 'failed';
                item.error = '未安装 FB Lite 且未开启自动安装 APK';
                item.stepText = item.error;
                return;
              }
              setStep('未检测到 FB Lite，正在自动安装 APK…');
              this.installingIds.add(entry.instanceId);
              try {
                inst = await this.devices.installFbLiteApk(
                  entry.instanceId,
                  undefined,
                  itemCtrl.signal,
                );
              } finally {
                this.installingIds.delete(entry.instanceId);
                this.invalidateDiscoveryCache();
              }
            }

            if (itemCtrl.signal.aborted) {
              item.status = 'stopped';
              item.stepText = '已停止';
              return;
            }

            setStep('正在自动登录 FB Lite…');
            let loggedInInst: BluestacksInstance;
            let skippedAlreadyLoggedIn = false;
            if (this.devices.loginAccountDetailed) {
              const res = await this.devices.loginAccountDetailed(
                entry.instanceId,
                {
                  account: entry.account,
                  password: entry.password,
                  totpSecret: entry.totpSecret || undefined,
                  saveLoginInfo: parsed.saveLoginInfo,
                  ifAlreadyLoggedIn: parsed.ifAlreadyLoggedIn,
                },
                itemCtrl.signal,
                setStep,
              );
              loggedInInst = res.instance;
              skippedAlreadyLoggedIn = res.skippedAlreadyLoggedIn;
            } else if (this.devices.loginAccount) {
              loggedInInst = await this.devices.loginAccount(
                entry.instanceId,
                {
                  account: entry.account,
                  password: entry.password,
                  totpSecret: entry.totpSecret || undefined,
                  saveLoginInfo: parsed.saveLoginInfo,
                  ifAlreadyLoggedIn: parsed.ifAlreadyLoggedIn,
                },
                itemCtrl.signal,
                setStep,
              );
            } else {
              throw new ProductError('BLUESTACKS_UNSUPPORTED', '当前环境不支持自动登录', 400);
            }

            item.accountName = loggedInInst.accountName || undefined;
            item.numericAccountId = loggedInInst.numericAccountId || undefined;
            if (skippedAlreadyLoggedIn) {
              if (!launchedByBatch) shouldCloseOnExit = false;
              item.status = 'skipped';
              item.stepText = `原已登录（${loggedInInst.accountName || item.instanceName}），已跳过`;
            } else {
              item.status = 'succeeded';
              const idTag = loggedInInst.numericAccountId
                ? ` · ID ${loggedInInst.numericAccountId}`
                : '';
              item.stepText = `登录成功 · ${loggedInInst.accountName || item.instanceName}${idTag}`;
              await Promise.resolve(
                this.repo.saveLastStatus(entry.instanceId, item.stepText.slice(0, 120)),
              ).catch(() => {});
            }
          } catch (err) {
            const code = err instanceof ProductError ? err.code : '';
            const msg = err instanceof Error ? err.message : '自动登录异常';
            if (itemCtrl.signal.aborted || msg === 'TASK_STOPPED') {
              item.status = 'stopped';
              item.stepText = '已手动停止';
            } else if (
              code === 'BLUESTACKS_ACCOUNT_CHECKPOINT' ||
              /Checkpoint|安全验证/i.test(msg)
            ) {
              item.status = 'verification';
              item.error = msg;
              item.stepText = '触发安全验证 (Checkpoint)';
            } else if (code === 'BLUESTACKS_ACCOUNT_RESTRICTED' || /封禁|停用|受限/i.test(msg)) {
              item.status = 'restricted';
              item.error = msg;
              item.stepText = '账号受限/停用';
            } else {
              item.status = 'failed';
              item.error = msg;
              item.stepText = `登录失败 · ${msg.slice(0, 80)}`;
            }
            await Promise.resolve(
              this.repo.saveLastStatus(entry.instanceId, item.stepText.slice(0, 120)),
            ).catch(() => {});
          } finally {
            scrubEntry(entry);
            batchAbort.signal.removeEventListener('abort', onBatchAbort);
            if (claimedExtra) {
              this.loggingInIds.delete(entry.instanceId);
              if (this.extraWorkers.get(entry.instanceId) === workerEntry) {
                this.extraWorkers.delete(entry.instanceId);
              }
            }

            if (shouldCloseOnExit && (launchedByBatch || parsed.closeOnFinish)) {
              const prevText = item.stepText;
              item.stepText = `${prevText}（正在关窗释放内存…）`;
              this.closingIds.add(entry.instanceId);
              try {
                await this.devices.closeInstance(entry.instanceId).catch(() => {});
              } finally {
                this.closingIds.delete(entry.instanceId);
              }
              item.stepText = prevText;
            }
            item.finishedAt = Date.now();
            this.invalidateDiscoveryCache();
            this.recomputeBatchLoginCounts(runState);
          }
        })();

        workerEntry.promise = workerPromise;
        await workerPromise;
      };

      let runnerPromise: Promise<void> | null = null;
      runnerPromise = (async () => {
        let cursor = 0;
        const worker = async () => {
          while (cursor < volatileQueue.length) {
            const next = volatileQueue[cursor++];
            if (!next) break;
            if (batchAbort.signal.aborted) {
              scrubEntry(next);
              const it = progressItems[next.index];
              if (it && it.status === 'queued') {
                it.status = 'stopped';
                it.stepText = '已取消排队';
                it.finishedAt = Date.now();
                this.recomputeBatchLoginCounts(runState);
              }
              continue;
            }
            await executeOne(next);
          }
        };
        try {
          const workerCount = Math.min(cap, volatileQueue.length);
          await Promise.all(Array.from({ length: workerCount }, () => worker()));
        } finally {
          for (const e of volatileQueue) scrubEntry(e);
          runState.running = false;
          runState.finishedAt = Date.now();
          this.recomputeBatchLoginCounts(runState);
          this.statusText = runState.statusText;
          if (this.batchLoginAbort === batchAbort) this.batchLoginAbort = null;
          if (this.batchLoginRunnerPromise === runnerPromise) this.batchLoginRunnerPromise = null;
          this.invalidateDiscoveryCache();
        }
      })();

      this.batchLoginRunnerPromise = runnerPromise;
      return this.state(false);
    } finally {
      this.batchLoginStarting = false;
    }
  }

  async stopBatchLogin(): Promise<BluestacksState> {
    if (this.batchLoginAbort) {
      this.batchLoginAbort.abort(new Error('TASK_STOPPED'));
    }
    if (this.batchLoginState?.running) {
      for (const item of this.batchLoginState.items) {
        if (item.status === 'queued') {
          item.status = 'stopped';
          item.stepText = '已取消排队';
          item.finishedAt = Date.now();
        }
      }
      this.recomputeBatchLoginCounts(this.batchLoginState);
    }
    await this.stopExtra('batch-login');
    if (this.batchLoginRunnerPromise) {
      await Promise.allSettled([this.batchLoginRunnerPromise]);
    }
    return this.state(false);
  }

  private recomputeHealthCheckCounts(state: BluestacksHealthCheckState): void {
    let completed = 0;
    let healthy = 0;
    let loggedOut = 0;
    let verification = 0;
    let restricted = 0;
    let missingApp = 0;
    let landscape = 0;
    let launchFailed = 0;
    let skipped = 0;
    let stopped = 0;
    let autoRepaired = 0;

    for (const item of state.items) {
      if (item.autoRepaired) autoRepaired++;
      if (item.status !== 'done') continue;
      completed++;
      switch (item.category) {
        case 'healthy':
          healthy++;
          break;
        case 'logged-out':
          loggedOut++;
          break;
        case 'verification':
          verification++;
          break;
        case 'restricted':
          restricted++;
          break;
        case 'missing-app':
          missingApp++;
          break;
        case 'landscape':
          landscape++;
          break;
        case 'launch-failed':
          launchFailed++;
          break;
        case 'skipped':
          skipped++;
          break;
        case 'stopped':
          stopped++;
          break;
      }
    }

    state.completed = completed;
    state.healthy = healthy;
    state.loggedOut = loggedOut;
    state.verification = verification;
    state.restricted = restricted;
    state.missingApp = missingApp;
    state.landscape = landscape;
    state.launchFailed = launchFailed;
    state.skipped = skipped;
    state.stopped = stopped;
    state.autoRepaired = autoRepaired;

    const abnormal = loggedOut + verification + restricted + missingApp + landscape + launchFailed;
    if (state.running) {
      state.statusText = `正在批量体检 (${completed}/${state.total} · 健康 ${healthy}${
        abnormal > 0 ? ` · 异常 ${abnormal}` : ''
      })`;
    } else {
      const parts: string[] = [`健康 ${healthy}`];
      if (loggedOut > 0) parts.push(`未登录 ${loggedOut}`);
      if (verification > 0) parts.push(`待验证 ${verification}`);
      if (restricted > 0) parts.push(`受限 ${restricted}`);
      if (missingApp > 0) parts.push(`缺App ${missingApp}`);
      if (landscape > 0) parts.push(`横屏 ${landscape}`);
      if (launchFailed > 0) parts.push(`失败 ${launchFailed}`);
      if (skipped > 0) parts.push(`跳过 ${skipped}`);
      if (stopped > 0) parts.push(`已停 ${stopped}`);
      state.statusText = `批量体检已完成 (${completed}/${state.total} · ${parts.join(' / ')})`;
    }
  }

  private mapAccountStateToHealthCategory(
    accountState: BluestacksInstance['accountState'],
  ): BluestacksHealthCategory {
    switch (accountState) {
      case 'logged-in':
        return 'healthy';
      case 'logged-out':
        return 'logged-out';
      case 'verification':
        return 'verification';
      case 'restricted':
        return 'restricted';
      case 'missing-app':
        return 'missing-app';
      default:
        return 'launch-failed';
    }
  }

  /**
   * Runs a concurrent batch health patrol across selected BlueStacks instances:
   * checks portrait resolution, auto-launches offline windows, probes/auto-repairs FB Lite APK,
   * inspects live login/Checkpoint/restricted status & numeric IDs, and optionally closes windows.
   */
  async startHealthCheck(input: unknown): Promise<BluestacksState> {
    if (this.healthCheckStarting || this.healthCheckState?.running) {
      throw new ProductError(
        'HEALTH_CHECK_ALREADY_RUNNING',
        '当前已有蓝蝶批量体检任务正在运行，请等待完成或先停止',
        409,
      );
    }
    const parsed = StartBluestacksHealthCheckInput.parse(input);
    const uniqueIds = [...new Set(parsed.instanceIds)];

    this.healthCheckStarting = true;
    try {
      const { instances } = await this.getDiscoverySnapshot(true);
      const byId = new Map(instances.map((i) => [i.id, i]));
      const saved = await this.repo.savedSettings();
      const cap = Math.max(
        1,
        Math.min(
          parsed.maxConcurrency,
          Math.max(saved.bumperSettings.maxConcurrentProfiles, this.activeConcurrencyCap, 1),
        ),
      );

      const patrolAbort = new AbortController();
      const items: BluestacksHealthCheckItem[] = uniqueIds.map((id) => {
        const inst = byId.get(id);
        return {
          instanceId: id,
          instanceName: inst ? bluestacksDisplayTitle(inst) : id.slice(0, 8),
          resolution: inst ? `${inst.fbWidth}×${inst.fbHeight}` : '-',
          status: 'queued',
          category: null,
          stepText: '排队等待并发槽位…',
          fbLiteVersion: inst?.fbLiteVersion ?? null,
          androidSdk: inst?.androidSdk ?? null,
        };
      });

      const runState: BluestacksHealthCheckState = {
        runId: crypto.randomUUID(),
        running: true,
        startedAt: Date.now(),
        finishedAt: null,
        total: items.length,
        completed: 0,
        healthy: 0,
        loggedOut: 0,
        verification: 0,
        restricted: 0,
        missingApp: 0,
        landscape: 0,
        launchFailed: 0,
        skipped: 0,
        stopped: 0,
        autoRepaired: 0,
        statusText: `准备批量体检 ${items.length} 台蓝蝶（并发 ${cap}）…`,
        items,
      };

      this.healthCheckState = runState;
      this.healthCheckAbort = patrolAbort;
      this.statusText = runState.statusText;

      const executeOne = async (idx: number) => {
        const item = items[idx];
        if (!item) return;
        const instanceId = item.instanceId;
        const itemCtrl = new AbortController();
        const onPatrolAbort = () => itemCtrl.abort(new Error('TASK_STOPPED'));
        if (patrolAbort.signal.aborted) {
          itemCtrl.abort(new Error('TASK_STOPPED'));
        } else {
          patrolAbort.signal.addEventListener('abort', onPatrolAbort, { once: true });
        }

        const setStep = (text: string) => {
          item.stepText = text;
          this.statusText = `${item.instanceName}：${text}`;
        };

        let shouldCloseOnExit = false;
        let claimedExtra = false;
        const workerEntry: {
          kind: 'health-check';
          controller: AbortController;
          promise: Promise<void>;
        } = {
          kind: 'health-check',
          controller: itemCtrl,
          promise: Promise.resolve(),
        };

        const workerPromise = (async () => {
          try {
            if (itemCtrl.signal.aborted) {
              item.category = 'stopped';
              item.stepText = '已手动停止';
              return;
            }
            item.status = 'running';
            item.startedAt = Date.now();

            const snap = await this.getDiscoverySnapshot(false);
            let inst = snap.instances.find((i) => i.id === instanceId);
            if (!inst) {
              item.category = 'launch-failed';
              item.error = '蓝蝶实例不存在';
              item.stepText = '实例不存在';
              return;
            }
            item.instanceName = bluestacksDisplayTitle(inst);
            item.resolution = `${inst.fbWidth}×${inst.fbHeight}`;
            item.fbLiteVersion = inst.fbLiteVersion ?? null;
            item.androidSdk = inst.androidSdk ?? null;

            if (!isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight)) {
              item.category = 'landscape';
              item.error = `横屏分辨率 (${inst.fbWidth}×${inst.fbHeight}) 不支持自动化，请在多开器改为竖屏`;
              item.stepText = `横屏 ${inst.fbWidth}×${inst.fbHeight}（未拉起）`;
              return;
            }

            const busyExternally = this.registry
              ? await this.registry.isProfileBusy(instanceId, 'bluestacks-health-check')
              : false;
            const activeExtra = this.extraWorkers.get(instanceId);
            const busyInOtherWorker =
              this.activeWorkers.has(instanceId) ||
              this.queuedTasks.some((t) => t.instanceId === instanceId) ||
              this.queuedExtraTasks.has(instanceId) ||
              activeExtra !== undefined;
            if (
              busyExternally ||
              busyInOtherWorker ||
              this.launchingIds.has(instanceId) ||
              this.closingIds.has(instanceId) ||
              this.inspectingIds.has(instanceId) ||
              this.installingIds.has(instanceId) ||
              this.loggingInIds.has(instanceId) ||
              this.switchingIds.has(instanceId)
            ) {
              item.category = 'skipped';
              item.stepText = '实例正忙于其他任务，已跳过';
              return;
            }
            this.extraWorkers.set(instanceId, workerEntry);
            claimedExtra = true;

            if (!inst.online) {
              if (!parsed.autoLaunch) {
                item.category = 'launch-failed';
                item.error = '实例未启动且未开启自动拉起';
                item.stepText = item.error;
                return;
              }
              shouldCloseOnExit = parsed.closeOnFinish;
              setStep('正在自动拉起蓝蝶窗口…');
              this.launchingIds.add(instanceId);
              try {
                inst = await this.devices.launchInstance(instanceId, itemCtrl.signal);
              } finally {
                this.launchingIds.delete(instanceId);
                this.invalidateDiscoveryCache();
              }
              item.resolution = `${inst.fbWidth}×${inst.fbHeight}`;
              item.androidSdk = inst.androidSdk ?? item.androidSdk;
            } else {
              shouldCloseOnExit = parsed.closeOnFinish;
            }

            if (itemCtrl.signal.aborted) {
              item.category = 'stopped';
              item.stepText = '已手动停止';
              return;
            }

            const probeInstalled = this.devices.probeFbLiteInstalled
              ? await this.devices.probeFbLiteInstalled(inst.serial, true, itemCtrl.signal)
              : inst.fbLiteInstalled;
            if (
              probeInstalled === false &&
              parsed.autoInstallApk &&
              this.devices.installFbLiteApk
            ) {
              setStep('未检测到 FB Lite，正在自动装包修复…');
              this.installingIds.add(instanceId);
              try {
                inst = await this.devices.installFbLiteApk(instanceId, undefined, itemCtrl.signal);
                item.autoRepaired = true;
                item.fbLiteVersion = inst.fbLiteVersion ?? item.fbLiteVersion;
              } finally {
                this.installingIds.delete(instanceId);
                this.invalidateDiscoveryCache();
              }
            }

            if (itemCtrl.signal.aborted) {
              item.category = 'stopped';
              item.stepText = '已手动停止';
              return;
            }

            setStep('正在检测 FB Lite 登录与账号状态…');
            this.inspectingIds.add(instanceId);
            let inspected: BluestacksInstance;
            try {
              inspected = await this.devices.inspectAccount(instanceId, itemCtrl.signal);
            } finally {
              this.inspectingIds.delete(instanceId);
              this.invalidateDiscoveryCache();
            }

            item.resolution = `${inspected.fbWidth}×${inspected.fbHeight}`;
            item.fbLiteVersion = inspected.fbLiteVersion ?? item.fbLiteVersion;
            item.androidSdk = inspected.androidSdk ?? item.androidSdk;
            item.identityType = inspected.identityType ?? 'unknown';
            item.accountName = inspected.accountName || undefined;
            item.numericAccountId = inspected.numericAccountId || undefined;
            item.managedPageCount =
              inspected.managedIdentities?.filter((m) => m.identityType === 'page').length ?? 0;

            const cat = this.mapAccountStateToHealthCategory(inspected.accountState);
            item.category = cat;
            if (cat === 'healthy') {
              const roleTag =
                inspected.identityType === 'page'
                  ? '专页'
                  : inspected.identityType === 'personal'
                    ? '个人'
                    : '';
              const idTag = inspected.numericAccountId ? ` · ID ${inspected.numericAccountId}` : '';
              item.stepText = `健康正常${roleTag ? ` (${roleTag})` : ''} · ${inspected.accountName || item.instanceName}${idTag}`;
            } else {
              item.stepText = healthCategoryLabel(cat);
              if (cat === 'verification') item.error = '触发安全验证 (Checkpoint)';
              else if (cat === 'restricted') item.error = '账号受限或已停用';
            }
            await Promise.resolve(
              this.repo.saveLastStatus(instanceId, `体检：${item.stepText}`.slice(0, 120)),
            ).catch(() => {});
          } catch (err) {
            const msg = err instanceof Error ? err.message : '体检检测异常';
            if (itemCtrl.signal.aborted || msg === 'TASK_STOPPED') {
              item.category = 'stopped';
              item.stepText = '已手动停止';
            } else {
              const latest = await Promise.resolve(this.repo.getInstance(instanceId)).catch(
                () => null,
              );
              if (latest) {
                item.fbLiteVersion = latest.fbLiteVersion ?? item.fbLiteVersion;
                item.androidSdk = latest.androidSdk ?? item.androidSdk;
                item.resolution = `${latest.fbWidth}×${latest.fbHeight}`;
              }
              const cat = classifyHealthErrorMessage(msg, latest?.accountState);
              item.category = cat;
              item.error = msg;
              item.stepText =
                cat === 'missing-app'
                  ? '未安装 FB Lite'
                  : cat === 'logged-out'
                    ? item.autoRepaired
                      ? '已自动装包 · 待登录账号'
                      : 'FB Lite 未登录账号'
                    : cat === 'verification'
                      ? '账号需安全验证 (Checkpoint)'
                      : cat === 'restricted'
                        ? '账号受限/停用'
                        : `检测异常 · ${msg.slice(0, 72)}`;
            }
            await Promise.resolve(
              this.repo.saveLastStatus(instanceId, `体检：${item.stepText}`.slice(0, 120)),
            ).catch(() => {});
          } finally {
            patrolAbort.signal.removeEventListener('abort', onPatrolAbort);
            if (claimedExtra && this.extraWorkers.get(instanceId) === workerEntry) {
              this.extraWorkers.delete(instanceId);
            }

            if (shouldCloseOnExit) {
              const prevText = item.stepText;
              item.stepText = `${prevText}（正在关窗释放内存…）`;
              this.closingIds.add(instanceId);
              try {
                await this.devices.closeInstance(instanceId).catch(() => {});
              } finally {
                this.closingIds.delete(instanceId);
              }
              item.stepText = prevText;
            }

            item.status = 'done';
            item.finishedAt = Date.now();
            this.invalidateDiscoveryCache();
            this.recomputeHealthCheckCounts(runState);
          }
        })();

        workerEntry.promise = workerPromise;
        await workerPromise;
      };

      let runnerPromise: Promise<void> | null = null;
      runnerPromise = (async () => {
        let cursor = 0;
        const worker = async () => {
          while (cursor < items.length) {
            const idx = cursor++;
            if (patrolAbort.signal.aborted) {
              const it = items[idx];
              if (it && it.status === 'queued') {
                it.status = 'done';
                it.category = 'stopped';
                it.stepText = '已取消排队';
                it.finishedAt = Date.now();
                this.recomputeHealthCheckCounts(runState);
              }
              continue;
            }
            await executeOne(idx);
          }
        };
        try {
          const workerCount = Math.min(cap, items.length);
          await Promise.all(Array.from({ length: workerCount }, () => worker()));
        } finally {
          runState.running = false;
          runState.finishedAt = Date.now();
          this.recomputeHealthCheckCounts(runState);
          this.statusText = runState.statusText;
          if (this.healthCheckAbort === patrolAbort) this.healthCheckAbort = null;
          if (this.healthCheckRunnerPromise === runnerPromise) this.healthCheckRunnerPromise = null;
          this.invalidateDiscoveryCache();
        }
      })();

      this.healthCheckRunnerPromise = runnerPromise;
      return this.state(false);
    } finally {
      this.healthCheckStarting = false;
    }
  }

  async stopHealthCheck(): Promise<BluestacksState> {
    if (this.healthCheckAbort) {
      this.healthCheckAbort.abort(new Error('TASK_STOPPED'));
    }
    if (this.healthCheckState?.running) {
      for (const item of this.healthCheckState.items) {
        if (item.status === 'queued') {
          item.status = 'done';
          item.category = 'stopped';
          item.stepText = '已取消排队';
          item.finishedAt = Date.now();
        }
      }
      this.recomputeHealthCheckCounts(this.healthCheckState);
    }
    await this.stopExtra('health-check');
    if (this.healthCheckRunnerPromise) {
      await Promise.allSettled([this.healthCheckRunnerPromise]);
    }
    return this.state(false);
  }

  // ---- Extended BlueStacks Feature Engines: Active Accounts / Group Poster / Group Inviter ----

  private async runExtraConcurrentBatch(
    kind: 'active' | 'poster' | 'inviter',
    instanceIds: readonly string[],
    statsMap: Map<string, BluestacksModuleProfileStat>,
    workFn: (
      instanceId: string,
      signal: AbortSignal,
      abortForRiskLimit: (reason: string) => void,
    ) => Promise<string>,
  ): Promise<void> {
    const saved = await this.repo.savedSettings();
    const cap = Math.max(1, saved.bumperSettings.maxConcurrentProfiles, this.activeConcurrencyCap);
    const queue: string[] = [];
    const controllers = new Map<string, AbortController>();
    for (const id of instanceIds) {
      if (this.extraWorkers.has(id) || this.queuedExtraTasks.has(id)) continue;
      const ctrl = new AbortController();
      controllers.set(id, ctrl);
      queue.push(id);
      this.queuedExtraTasks.set(id, { kind, controller: ctrl, statsMap });
      const prev = statsMap.get(id);
      statsMap.set(id, {
        running: true,
        status: '排队等待并发槽位…',
        session: 0,
        today: prev?.today ?? 0,
      });
    }

    const launchOne = async (id: string) => {
      const ctrl = controllers.get(id);
      if (!ctrl || ctrl.signal.aborted) {
        statsMap.set(id, { running: false, status: '已停止', session: 0, today: 0 });
        return;
      }
      try {
        // Auto-launch closed portrait instance seamlessly inside the concurrency slot
        await this.ensureInstanceOnlineForManualAction(id, ctrl.signal, (msg) => {
          const cur = statsMap.get(id);
          statsMap.set(id, {
            running: true,
            status: msg,
            session: cur?.session ?? 0,
            today: cur?.today ?? 0,
          });
          if (kind === 'active') this.activeStatusText = msg;
          else if (kind === 'poster') this.posterStatusText = msg;
          else this.inviterStatusText = msg;
        });
        if (ctrl.signal.aborted) {
          throw new Error('TASK_STOPPED');
        }
        const summary = await workFn(id, ctrl.signal, (reason) => {
          if (!ctrl.signal.aborted) {
            ctrl.abort(new Error(`RISK_LIMIT_REACHED:${reason}`));
          }
        });
        const cur = statsMap.get(id);
        statsMap.set(id, {
          running: false,
          status: summary,
          session: cur?.session ?? 0,
          today: cur?.today ?? 0,
        });
        await Promise.resolve(this.repo.saveLastStatus(id, summary.slice(0, 120))).catch(() => {});
      } catch (err) {
        const riskReason = this.extractRiskLimitAbortReason(ctrl.signal, err);
        const cur = statsMap.get(id);
        if (riskReason) {
          statsMap.set(id, {
            running: false,
            status: riskReason,
            session: cur?.session ?? 0,
            today: cur?.today ?? 0,
          });
          await Promise.resolve(this.repo.saveLastStatus(id, riskReason.slice(0, 120))).catch(
            () => {},
          );
          return;
        }
        const msg = err instanceof Error ? err.message : '运行异常';
        const stopped = ctrl.signal.aborted || msg === 'TASK_STOPPED';
        statsMap.set(id, {
          running: false,
          status: stopped ? '已停止' : msg,
          session: cur?.session ?? 0,
          today: cur?.today ?? 0,
        });
        await Promise.resolve(
          this.repo.saveLastStatus(id, stopped ? '上次已停止' : `上次异常 · ${msg.slice(0, 80)}`),
        ).catch(() => {});
      } finally {
        this.extraWorkers.delete(id);
      }
    };

    const runners: Promise<void>[] = [];
    const pump = async () => {
      while (queue.length > 0) {
        const nextId = queue.shift();
        if (!nextId) break;
        const queuedEntry = this.queuedExtraTasks.get(nextId);
        const ctrl = controllers.get(nextId);
        if (queuedEntry?.controller === ctrl) {
          this.queuedExtraTasks.delete(nextId);
        }
        if (!ctrl || ctrl.signal.aborted) {
          const prev = statsMap.get(nextId);
          statsMap.set(nextId, {
            running: false,
            status: '已停止',
            session: prev?.session ?? 0,
            today: prev?.today ?? 0,
          });
          continue;
        }
        const p = launchOne(nextId);
        this.extraWorkers.set(nextId, { kind, controller: ctrl, promise: p });
        await p;
      }
    };
    const workerCount = Math.min(cap, Math.max(1, queue.length));
    for (let i = 0; i < workerCount; i++) {
      runners.push(pump());
    }
    void Promise.allSettled(runners).then(() => {
      if (kind === 'active' && !this.hasExtraExecution('active')) {
        this.activeStatusText = '蓝蝶活跃账号运行结束';
      } else if (kind === 'poster' && !this.hasExtraExecution('poster')) {
        this.posterStatusText = '蓝蝶小组发帖运行结束';
      } else if (kind === 'inviter' && !this.hasExtraExecution('inviter')) {
        this.inviterStatusText = '蓝蝶小组邀请人运行结束';
      }
    });
  }

  private async resolveActiveSteps(input: {
    combinationId?: string;
    quickStep?: BluestacksActiveStepParam;
  }): Promise<BluestacksActiveStepParam[]> {
    if (input.quickStep) {
      return [input.quickStep];
    }
    if (input.combinationId) {
      const combos = this.extra?.listCombinations ? await this.extra.listCombinations() : [];
      const found = combos.find((c) => c.id === input.combinationId);
      const saved = found?.saved;
      if (!saved || saved.steps.length === 0) {
        throw new ProductError('COMBINATION_NOT_FOUND', '未找到有效的已保存任务组合', 404);
      }
      const steps: BluestacksActiveStepParam[] = [];
      for (const s of saved.steps) {
        if (s.type === 'feed' || s.type === 'video') {
          steps.push({ type: s.type, durationMinutes: s.durationMinutes, maxLikes: s.maxLikes });
        } else if (s.type === 'marketplace') {
          steps.push({ type: 'marketplace', durationMinutes: s.durationMinutes });
        } else if (s.type === 'friends') {
          steps.push({
            type: 'friends',
            durationMinutes: s.durationMinutes,
            maxAccepts: s.maxAccepts,
          });
        } else if (s.type === 'post') {
          steps.push({ type: s.destination === 'story' ? 'story' : 'post' });
        }
      }
      if (steps.length === 0) {
        throw new ProductError('COMBINATION_EMPTY', '该组合中没有可在蓝蝶执行的步骤', 400);
      }
      return steps;
    }
    throw new ProductError('ACTIVE_STEPS_EMPTY', '请指定活跃任务组合或快捷单步动作', 400);
  }

  async startActive(input: unknown): Promise<BluestacksState> {
    const parsed = StartBluestacksActiveInput.parse(input);
    if (!this.extra?.activeRunner) {
      throw new ProductError('BLUESTACKS_ACTIVE_UNAVAILABLE', '蓝蝶活跃执行器未就绪', 500);
    }
    const steps = await this.resolveActiveSteps({
      combinationId: parsed.combinationId,
      quickStep: parsed.quickStep,
    });
    const { instances } = await this.getDiscoverySnapshot(true);
    const rawReady = this.filterReadyInstancesForRun(
      parsed.instanceIds,
      instances,
      this.activeProfileStats,
    );
    const idleReady: string[] = [];
    for (const id of rawReady) {
      if (!(await this.isExternallyBusy(id))) idleReady.push(id);
    }
    if (idleReady.length === 0) {
      throw new ProductError('NO_IDLE_INSTANCES', '所选蓝蝶窗口正忙于其他任务', 409);
    }
    const ready = await this.filterInstancesByRiskQuota(
      idleReady,
      'active-like',
      this.activeProfileStats,
    );
    this.activeStatusText = `正在运行 ${ready.length} 个蓝蝶活跃任务…`;
    const activeRunner = this.extra.activeRunner;
    await this.runExtraConcurrentBatch(
      'active',
      ready,
      this.activeProfileStats,
      async (id, signal, abortForRiskLimit) => {
        const outcome = await activeRunner.run(id, steps, signal, {
          status: (text) => {
            const cur = this.activeProfileStats.get(id);
            this.activeProfileStats.set(id, {
              running: true,
              status: text,
              session: cur?.session ?? 0,
              today: cur?.today ?? 0,
            });
            this.activeStatusText = text;
          },
          action: () => {
            const cur = this.activeProfileStats.get(id);
            if (cur) {
              cur.session += 1;
              cur.today += 1;
            }
            void Promise.resolve(this.repo.recordDailyActiveAction?.(id, 'like', 1))
              .then(() => this.checkInstanceRiskQuota(id, 'active-like'))
              .then((q) => {
                if (!q.allowed) {
                  abortForRiskLimit(q.reason ?? '今日已达蓝蝶风控安全上限，自动休眠保护');
                }
              })
              .catch(() => {});
          },
        });
        const parts = [
          `完成 ${outcome.completedSteps} 步`,
          ...(outcome.likes > 0 ? [`点赞 ${outcome.likes}`] : []),
          ...(outcome.acceptedFriends > 0 ? [`加好友 ${outcome.acceptedFriends}`] : []),
          ...(outcome.published > 0 ? [`发布 ${outcome.published}`] : []),
          ...(outcome.skippedSteps > 0 ? [`跳过 ${outcome.skippedSteps} 步`] : []),
        ];
        return `活跃完成 · ${parts.join(' · ')}`;
      },
    );
    return this.state(false);
  }

  async startPoster(input: unknown): Promise<BluestacksState> {
    const parsed = StartBluestacksPosterInput.parse(input);
    if (!this.extra?.posterRunner) {
      throw new ProductError('BLUESTACKS_POSTER_UNAVAILABLE', '蓝蝶发帖执行器未就绪', 500);
    }
    const [{ instances }, allGroups, allMaterials] = await Promise.all([
      this.getDiscoverySnapshot(true),
      this.repo.targets('groups'),
      this.extra.listPosterMaterials ? this.extra.listPosterMaterials() : [],
    ]);
    const selectedMaterials = allMaterials.filter((m) => parsed.materialIds.includes(m.id));
    if (selectedMaterials.length === 0) {
      throw new ProductError('POSTER_MATERIALS_EMPTY', '请至少选择一张有效的发帖素材卡', 400);
    }
    const selectedGroups = allGroups.filter((g) => parsed.groupIds.includes(g.id));
    if (selectedGroups.length === 0 && !parsed.postToTimeline) {
      throw new ProductError('POSTER_GROUPS_EMPTY', '请至少选择一个有效小组或开启发时间线', 400);
    }

    const preparedMaterials: PosterMaterial[] = [];
    for (const mat of selectedMaterials) {
      preparedMaterials.push(
        this.extra.ensurePosterMaterialLocal
          ? await this.extra.ensurePosterMaterialLocal(mat).catch(() => mat)
          : mat,
      );
    }

    const rawReady = this.filterReadyInstancesForRun(
      parsed.instanceIds,
      instances,
      this.posterProfileStats,
    );
    const idleReady: string[] = [];
    for (const id of rawReady) {
      if (!(await this.isExternallyBusy(id))) idleReady.push(id);
    }
    if (idleReady.length === 0) {
      throw new ProductError('NO_IDLE_INSTANCES', '所选蓝蝶窗口正忙于其他任务', 409);
    }
    const ready = await this.filterInstancesByRiskQuota(idleReady, 'post', this.posterProfileStats);

    const staggered = buildStaggeredBumperQueues(ready, selectedGroups);
    this.posterStatusText = `正在运行 ${ready.length} 个蓝蝶发帖任务…`;
    const posterRunner = this.extra.posterRunner;
    await this.runExtraConcurrentBatch(
      'poster',
      ready,
      this.posterProfileStats,
      async (id, signal, abortForRiskLimit) => {
        const outcome = await posterRunner.run(
          id,
          preparedMaterials,
          staggered.get(id) ?? selectedGroups,
          {
            maxGroupsPerInstance: parsed.maxGroupsPerInstance,
            postToTimeline: parsed.postToTimeline,
          },
          signal,
          {
            status: (text) => {
              const cur = this.posterProfileStats.get(id);
              this.posterProfileStats.set(id, {
                running: true,
                status: text,
                session: cur?.session ?? 0,
                today: cur?.today ?? 0,
              });
              this.posterStatusText = text;
            },
            posted: () => {
              const cur = this.posterProfileStats.get(id);
              if (cur) {
                cur.session += 1;
                cur.today += 1;
              }
              void this.checkInstanceRiskQuota(id, 'post')
                .then((q) => {
                  if (!q.allowed) {
                    abortForRiskLimit(q.reason ?? '今日已达蓝蝶风控安全上限，自动休眠保护');
                  }
                })
                .catch(() => {});
            },
          },
        );
        return `发帖完成 · 成功 ${outcome.posted} 条${outcome.skipped > 0 ? `，跳过 ${outcome.skipped}` : ''}`;
      },
    );
    return this.state(false);
  }

  async startInviter(input: unknown): Promise<BluestacksState> {
    const parsed = StartBluestacksInviterInput.parse(input);
    if (!this.extra?.inviterRunner) {
      throw new ProductError('BLUESTACKS_INVITER_UNAVAILABLE', '蓝蝶邀请执行器未就绪', 500);
    }
    const [{ instances }, allGroups] = await Promise.all([
      this.getDiscoverySnapshot(true),
      this.repo.targets('groups'),
    ]);
    const selectedGroups = allGroups.filter((g) => parsed.groupIds.includes(g.id));
    if (selectedGroups.length === 0) {
      throw new ProductError('INVITER_GROUPS_EMPTY', '请至少选择一个有效的目标小组', 400);
    }
    const rawReady = this.filterReadyInstancesForRun(
      parsed.instanceIds,
      instances,
      this.inviterProfileStats,
    );
    const idleReady: string[] = [];
    for (const id of rawReady) {
      if (!(await this.isExternallyBusy(id))) idleReady.push(id);
    }
    if (idleReady.length === 0) {
      throw new ProductError('NO_IDLE_INSTANCES', '所选蓝蝶窗口正忙于其他任务', 409);
    }
    const ready = await this.filterInstancesByRiskQuota(
      idleReady,
      'invite',
      this.inviterProfileStats,
    );

    const staggered = buildStaggeredBumperQueues(ready, selectedGroups);
    this.inviterStatusText = `正在运行 ${ready.length} 个蓝蝶小组邀请任务…`;
    const inviterRunner = this.extra.inviterRunner;
    await this.runExtraConcurrentBatch(
      'inviter',
      ready,
      this.inviterProfileStats,
      async (id, signal, abortForRiskLimit) => {
        const outcome = await inviterRunner.run(
          id,
          staggered.get(id) ?? selectedGroups,
          parsed.invitesPerGroup,
          signal,
          {
            status: (text) => {
              const cur = this.inviterProfileStats.get(id);
              this.inviterProfileStats.set(id, {
                running: true,
                status: text,
                session: cur?.session ?? 0,
                today: cur?.today ?? 0,
              });
              this.inviterStatusText = text;
            },
            invited: (delta) => {
              const cur = this.inviterProfileStats.get(id);
              if (cur) {
                cur.session += delta;
                cur.today += delta;
              }
              void this.checkInstanceRiskQuota(id, 'invite')
                .then((q) => {
                  if (!q.allowed) {
                    abortForRiskLimit(q.reason ?? '今日已达蓝蝶风控安全上限，自动休眠保护');
                  }
                })
                .catch(() => {});
            },
          },
        );
        return `邀请完成 · 已邀请 ${outcome.invited} 人${outcome.skippedGroups > 0 ? `，跳过 ${outcome.skippedGroups} 群` : ''}`;
      },
    );
    return this.state(false);
  }

  async stopExtra(
    kind?:
      | 'active'
      | 'poster'
      | 'inviter'
      | 'sheets-bumper'
      | 'sheets-poster'
      | 'batch-login'
      | 'health-check',
    ids?: readonly string[],
  ): Promise<BluestacksState> {
    const idSet = ids && ids.length > 0 ? new Set(ids) : null;
    for (const [id, queued] of [...this.queuedExtraTasks.entries()]) {
      if (kind && queued.kind !== kind) continue;
      if (idSet && !idSet.has(id)) continue;
      queued.controller.abort(new Error('TASK_STOPPED'));
      this.queuedExtraTasks.delete(id);
      const prev = queued.statsMap.get(id);
      queued.statsMap.set(id, {
        running: false,
        status: '已停止',
        session: prev?.session ?? 0,
        today: prev?.today ?? 0,
      });
    }
    const waits: Promise<void>[] = [];
    for (const [id, worker] of this.extraWorkers.entries()) {
      if (kind && worker.kind !== kind) continue;
      if (idSet && !idSet.has(id)) continue;
      worker.controller.abort(new Error('TASK_STOPPED'));
      waits.push(worker.promise);
    }
    if (waits.length > 0) await Promise.allSettled(waits);
    if (!kind || kind === 'active') this.activeStatusText = '已停止蓝蝶活跃任务';
    if (!kind || kind === 'poster') this.posterStatusText = '已停止蓝蝶发帖任务';
    if (!kind || kind === 'inviter') this.inviterStatusText = '已停止蓝蝶小组邀请任务';
    return this.state(false);
  }

  async stopAllForInstances(ids?: readonly string[]): Promise<BluestacksState> {
    const tasks: Promise<unknown>[] = [this.stopBumper(ids), this.stopExtra(undefined, ids)];
    if (!ids || ids.length === 0) {
      tasks.push(this.stopBatchLogin());
      tasks.push(this.stopHealthCheck());
    }
    await Promise.allSettled(tasks);
    return this.state(false);
  }

  // ---- Auto-Scheduler & Cloud Sheets Bridge Hooks ----

  async runScheduledHealthCheckStep(input: {
    instanceId: string;
    autoInstallApk?: boolean;
    signal?: AbortSignal;
    onProgress: (status: string) => void;
  }): Promise<{
    category: BluestacksHealthCategory;
    status: string;
    hardBlocked: boolean;
    softIssue: boolean;
    autoRepaired: boolean;
  }> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(new Error('TASK_STOPPED'));
    input.signal?.addEventListener('abort', onAbort, { once: true });

    let category: BluestacksHealthCategory = 'healthy';
    let finalStatus = '健康正常';
    let hardBlocked = false;
    let softIssue = false;
    let autoRepaired = false;

    const promise = (async () => {
      try {
        const snap = await this.getDiscoverySnapshot(false);
        let inst = snap.instances.find((i) => i.id === input.instanceId);
        if (!inst) {
          category = 'launch-failed';
          finalStatus = '蓝蝶实例不存在';
          softIssue = true;
          return;
        }
        if (!isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight)) {
          category = 'landscape';
          finalStatus = `横屏 ${inst.fbWidth}×${inst.fbHeight}（需改竖屏）`;
          hardBlocked = true;
          return;
        }

        input.onProgress('正在探测 FB Lite 安装状态…');
        const probeInstalled = this.devices.probeFbLiteInstalled
          ? await this.devices.probeFbLiteInstalled(inst.serial, true, controller.signal)
          : inst.fbLiteInstalled;
        if (probeInstalled === false && input.autoInstallApk && this.devices.installFbLiteApk) {
          input.onProgress('缺少 FB Lite，正在自动装包修复…');
          this.installingIds.add(input.instanceId);
          try {
            inst = await this.devices.installFbLiteApk(
              input.instanceId,
              undefined,
              controller.signal,
            );
            autoRepaired = true;
          } finally {
            this.installingIds.delete(input.instanceId);
            this.invalidateDiscoveryCache();
          }
        }

        input.onProgress('正在检测 FB Lite 账号健康状态…');
        this.inspectingIds.add(input.instanceId);
        let inspected: BluestacksInstance;
        try {
          inspected = await this.devices.inspectAccount(input.instanceId, controller.signal);
        } finally {
          this.inspectingIds.delete(input.instanceId);
          this.invalidateDiscoveryCache();
        }

        category = this.mapAccountStateToHealthCategory(inspected.accountState);
        if (category === 'healthy') {
          const idTag = inspected.numericAccountId ? ` · ID ${inspected.numericAccountId}` : '';
          finalStatus = `体检健康 · ${inspected.accountName || bluestacksDisplayTitle(inspected)}${idTag}`;
        } else {
          finalStatus = healthCategoryLabel(category);
          hardBlocked =
            category === 'verification' ||
            category === 'restricted' ||
            category === 'logged-out' ||
            category === 'missing-app';
          if (!hardBlocked) softIssue = true;
        }
        input.onProgress(finalStatus);
        await Promise.resolve(
          this.repo.saveLastStatus(input.instanceId, finalStatus.slice(0, 120)),
        ).catch(() => {});
      } catch (err) {
        const msg = err instanceof Error ? err.message : '体检异常';
        if (controller.signal.aborted || msg === 'TASK_STOPPED') {
          category = 'stopped';
          finalStatus = '已停止';
        } else {
          const latest = await Promise.resolve(this.repo.getInstance(input.instanceId)).catch(
            () => null,
          );
          category = classifyHealthErrorMessage(msg, latest?.accountState);
          finalStatus =
            category === 'missing-app'
              ? '未安装 FB Lite'
              : category === 'logged-out'
                ? autoRepaired
                  ? '已自动装包，账号未登录'
                  : 'FB Lite 未登录账号'
                : category === 'verification'
                  ? '账号需安全验证 (Checkpoint)'
                  : category === 'restricted'
                    ? '账号已受限/停用'
                    : msg.slice(0, 100);
          if (
            category === 'missing-app' ||
            category === 'logged-out' ||
            category === 'verification' ||
            category === 'restricted' ||
            category === 'landscape'
          ) {
            hardBlocked = true;
          } else {
            softIssue = true;
          }
          await Promise.resolve(
            this.repo.saveLastStatus(input.instanceId, `体检：${finalStatus}`.slice(0, 120)),
          ).catch(() => {});
        }
      } finally {
        input.signal?.removeEventListener('abort', onAbort);
        this.extraWorkers.delete(input.instanceId);
        this.invalidateDiscoveryCache();
      }
    })();
    this.extraWorkers.set(input.instanceId, { kind: 'health-check', controller, promise });
    await promise;
    return { category, status: finalStatus, hardBlocked, softIssue, autoRepaired };
  }

  async runScheduledActiveStep(input: {
    instanceId: string;
    combinationId?: string;
    quickStep?: BluestacksActiveStepParam;
    signal?: AbortSignal;
    onProgress: (status: string) => void;
  }): Promise<{ status: string; hardBlocked: boolean; softIssue: boolean }> {
    if (!this.extra?.activeRunner) {
      return { status: '跳过：蓝蝶活跃执行器未就绪', hardBlocked: false, softIssue: true };
    }
    const riskPre = await this.checkInstanceRiskQuota(input.instanceId, 'active-like');
    if (!riskPre.allowed) {
      const msg = riskPre.reason ?? '今日已达蓝蝶风控安全上限，自动休眠保护';
      await Promise.resolve(this.repo.saveLastStatus(input.instanceId, msg.slice(0, 120))).catch(
        () => {},
      );
      return { status: msg, hardBlocked: false, softIssue: true };
    }
    const steps = await this.resolveActiveSteps({
      combinationId: input.combinationId,
      quickStep: input.quickStep,
    });
    const controller = new AbortController();
    const onAbort = () => controller.abort(new Error('TASK_STOPPED'));
    input.signal?.addEventListener('abort', onAbort, { once: true });
    let hardBlocked = false;
    let softIssue = false;
    let finalStatus = '活跃步骤完成';
    const promise = (async () => {
      try {
        const res = await this.extra?.activeRunner?.run(
          input.instanceId,
          steps,
          controller.signal,
          {
            status: (text) => {
              this.activeProfileStats.set(input.instanceId, {
                running: true,
                status: text,
                session: 0,
                today: 0,
              });
              input.onProgress(text);
            },
            action: () => {
              void Promise.resolve(this.repo.recordDailyActiveAction?.(input.instanceId, 'like', 1))
                .then(() => this.checkInstanceRiskQuota(input.instanceId, 'active-like'))
                .then((q) => {
                  if (!q.allowed && !controller.signal.aborted) {
                    controller.abort(
                      new Error(
                        `RISK_LIMIT_REACHED:${q.reason ?? '今日已达蓝蝶风控安全上限，自动休眠保护'}`,
                      ),
                    );
                  }
                })
                .catch(() => {});
            },
          },
        );
        finalStatus = res ? `完成 ${res.completedSteps} 步 · 点赞 ${res.likes}` : '活跃步骤完成';
      } catch (err) {
        const riskReason = this.extractRiskLimitAbortReason(controller.signal, err);
        if (riskReason) {
          finalStatus = riskReason;
          softIssue = true;
          await Promise.resolve(
            this.repo.saveLastStatus(input.instanceId, riskReason.slice(0, 120)),
          ).catch(() => {});
          return;
        }
        const msg = err instanceof Error ? err.message : '活跃异常';
        finalStatus = msg;
        if (/退出登录|未登录|安全验证|Checkpoint|封禁|停用/.test(msg)) hardBlocked = true;
        else if (!controller.signal.aborted && msg !== 'TASK_STOPPED') softIssue = true;
      } finally {
        input.signal?.removeEventListener('abort', onAbort);
        this.extraWorkers.delete(input.instanceId);
        this.activeProfileStats.set(input.instanceId, {
          running: false,
          status: finalStatus,
          session: 0,
          today: 0,
        });
      }
    })();
    this.extraWorkers.set(input.instanceId, { kind: 'active', controller, promise });
    await promise;
    return { status: finalStatus, hardBlocked, softIssue };
  }

  async runScheduledPosterStep(input: {
    instanceId: string;
    materialIds: string[];
    groupIds: string[];
    maxGroupsPerProfile: number;
    postToTimeline?: boolean;
    signal?: AbortSignal;
    onProgress: (status: string, sessionPosted: number) => void;
  }): Promise<{ postedCount: number; status: string; hardBlocked: boolean; softIssue: boolean }> {
    if (!this.extra?.posterRunner) {
      return {
        postedCount: 0,
        status: '跳过：蓝蝶发帖执行器未就绪',
        hardBlocked: false,
        softIssue: true,
      };
    }
    const riskPre = await this.checkInstanceRiskQuota(input.instanceId, 'post');
    if (!riskPre.allowed) {
      const msg = riskPre.reason ?? '今日已达蓝蝶风控安全上限，自动休眠保护';
      await Promise.resolve(this.repo.saveLastStatus(input.instanceId, msg.slice(0, 120))).catch(
        () => {},
      );
      return { postedCount: 0, status: msg, hardBlocked: false, softIssue: true };
    }
    const [allGroups, allMaterials] = await Promise.all([
      this.repo.targets('groups'),
      this.extra.listPosterMaterials ? this.extra.listPosterMaterials() : [],
    ]);
    const mats = allMaterials.filter((m) => input.materialIds.includes(m.id));
    const grps = allGroups.filter((g) => input.groupIds.includes(g.id));
    if (mats.length === 0 || (grps.length === 0 && !input.postToTimeline)) {
      return {
        postedCount: 0,
        status: '跳过：发帖素材或目标小组为空',
        hardBlocked: false,
        softIssue: true,
      };
    }
    const prepared: PosterMaterial[] = [];
    for (const mat of mats) {
      prepared.push(
        this.extra.ensurePosterMaterialLocal
          ? await this.extra.ensurePosterMaterialLocal(mat).catch(() => mat)
          : mat,
      );
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(new Error('TASK_STOPPED'));
    input.signal?.addEventListener('abort', onAbort, { once: true });
    let postedCount = 0;
    let hardBlocked = false;
    let softIssue = false;
    let finalStatus = '发帖完成';
    const promise = (async () => {
      try {
        const res = await this.extra?.posterRunner?.run(
          input.instanceId,
          prepared,
          grps,
          {
            maxGroupsPerInstance: input.maxGroupsPerProfile,
            postToTimeline: Boolean(input.postToTimeline),
          },
          controller.signal,
          {
            status: (text) => input.onProgress(text, postedCount),
            posted: () => {
              postedCount++;
              input.onProgress(`已发帖 ${postedCount} 组`, postedCount);
              void this.checkInstanceRiskQuota(input.instanceId, 'post')
                .then((q) => {
                  if (!q.allowed && !controller.signal.aborted) {
                    controller.abort(
                      new Error(
                        `RISK_LIMIT_REACHED:${q.reason ?? '今日已达蓝蝶风控安全上限，自动休眠保护'}`,
                      ),
                    );
                  }
                })
                .catch(() => {});
            },
          },
        );
        const totalPosted = res?.posted ?? postedCount;
        if (totalPosted === 0 && (res?.skipped ?? 0) > 0) {
          softIssue = true;
          finalStatus = res?.notes[0] ?? `发帖跳过 ${res?.skipped ?? 0} 条`;
        } else {
          finalStatus = `已发帖 ${totalPosted} 条`;
        }
      } catch (err) {
        const riskReason = this.extractRiskLimitAbortReason(controller.signal, err);
        if (riskReason) {
          finalStatus = riskReason;
          softIssue = true;
          await Promise.resolve(
            this.repo.saveLastStatus(input.instanceId, riskReason.slice(0, 120)),
          ).catch(() => {});
          return;
        }
        const msg = err instanceof Error ? err.message : '发帖异常';
        finalStatus = msg;
        if (/退出登录|未登录|安全验证|Checkpoint|封禁|停用/.test(msg)) hardBlocked = true;
        else if (!controller.signal.aborted && msg !== 'TASK_STOPPED') softIssue = true;
      } finally {
        input.signal?.removeEventListener('abort', onAbort);
        this.extraWorkers.delete(input.instanceId);
      }
    })();
    this.extraWorkers.set(input.instanceId, { kind: 'poster', controller, promise });
    await promise;
    return { postedCount, status: finalStatus, hardBlocked, softIssue };
  }

  async runScheduledInviterStep(input: {
    instanceId: string;
    groupIds: string[];
    invitesPerGroup: number;
    signal?: AbortSignal;
    onProgress: (status: string, sessionInvited: number) => void;
  }): Promise<{ invitedCount: number; status: string; hardBlocked: boolean; softIssue: boolean }> {
    if (!this.extra?.inviterRunner) {
      return {
        invitedCount: 0,
        status: '跳过：蓝蝶邀请执行器未就绪',
        hardBlocked: false,
        softIssue: true,
      };
    }
    const riskPre = await this.checkInstanceRiskQuota(input.instanceId, 'invite');
    if (!riskPre.allowed) {
      const msg = riskPre.reason ?? '今日已达蓝蝶风控安全上限，自动休眠保护';
      await Promise.resolve(this.repo.saveLastStatus(input.instanceId, msg.slice(0, 120))).catch(
        () => {},
      );
      return { invitedCount: 0, status: msg, hardBlocked: false, softIssue: true };
    }
    const allGroups = await this.repo.targets('groups');
    const grps = allGroups.filter((g) => input.groupIds.includes(g.id));
    if (grps.length === 0) {
      return {
        invitedCount: 0,
        status: '跳过：未找到有效目标小组',
        hardBlocked: false,
        softIssue: true,
      };
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(new Error('TASK_STOPPED'));
    input.signal?.addEventListener('abort', onAbort, { once: true });
    let invitedCount = 0;
    let hardBlocked = false;
    let softIssue = false;
    let finalStatus = '邀请完成';
    const promise = (async () => {
      try {
        const res = await this.extra?.inviterRunner?.run(
          input.instanceId,
          grps,
          input.invitesPerGroup,
          controller.signal,
          {
            status: (text) => input.onProgress(text, invitedCount),
            invited: (delta) => {
              invitedCount += delta;
              input.onProgress(`已邀请 ${invitedCount} 人`, invitedCount);
              void this.checkInstanceRiskQuota(input.instanceId, 'invite')
                .then((q) => {
                  if (!q.allowed && !controller.signal.aborted) {
                    controller.abort(
                      new Error(
                        `RISK_LIMIT_REACHED:${q.reason ?? '今日已达蓝蝶风控安全上限，自动休眠保护'}`,
                      ),
                    );
                  }
                })
                .catch(() => {});
            },
          },
        );
        finalStatus = `已邀请 ${res?.invited ?? invitedCount} 人`;
      } catch (err) {
        const riskReason = this.extractRiskLimitAbortReason(controller.signal, err);
        if (riskReason) {
          finalStatus = riskReason;
          softIssue = true;
          await Promise.resolve(
            this.repo.saveLastStatus(input.instanceId, riskReason.slice(0, 120)),
          ).catch(() => {});
          return;
        }
        const msg = err instanceof Error ? err.message : '邀请异常';
        finalStatus = msg;
        if (/退出登录|未登录|安全验证|Checkpoint|封禁|停用/.test(msg)) hardBlocked = true;
        else if (!controller.signal.aborted && msg !== 'TASK_STOPPED') softIssue = true;
      } finally {
        input.signal?.removeEventListener('abort', onAbort);
        this.extraWorkers.delete(input.instanceId);
      }
    })();
    this.extraWorkers.set(input.instanceId, { kind: 'inviter', controller, promise });
    await promise;
    return { invitedCount, status: finalStatus, hardBlocked, softIssue };
  }

  async runDirectPostsForSheet(input: {
    instanceId: string;
    posts: ReadonlyArray<{
      postId: string;
      postUrl: string;
      groupId: string;
      groupName: string;
      pageId: string;
      pageName: string;
    }>;
    settings: BumperSettings;
    commentPool: readonly string[];
    signal?: AbortSignal;
    onProgress?: (status: string) => void;
    onPostDone?: (res: {
      postId: string;
      liked: boolean;
      commented: boolean;
      commentText?: string | null;
    }) => void | Promise<void>;
  }): Promise<{ bumped: number; attempted: number }> {
    if (!this.runner.runDirectPosts) {
      return { bumped: 0, attempted: 0 };
    }
    const riskPre = await this.checkInstanceRiskQuota(input.instanceId, 'bump');
    if (!riskPre.allowed) {
      input.onProgress?.(riskPre.reason ?? '今日已达蓝蝶风控安全上限，自动休眠保护');
      return { bumped: 0, attempted: 0 };
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(new Error('TASK_STOPPED'));
    input.signal?.addEventListener('abort', onAbort, { once: true });
    let result = { bumped: 0, attempted: 0 };
    const promise = (async () => {
      try {
        await this.ensureInstanceOnlineForSchedule(input.instanceId, controller.signal);
        result = (await this.runner.runDirectPosts?.(
          input.instanceId,
          input.posts,
          input.settings,
          input.commentPool,
          controller.signal,
          {
            status: (text) => input.onProgress?.(text),
            onPostDone: input.onPostDone,
          },
        )) ?? { bumped: 0, attempted: 0 };
      } finally {
        input.signal?.removeEventListener('abort', onAbort);
        this.extraWorkers.delete(input.instanceId);
      }
    })();
    this.extraWorkers.set(input.instanceId, { kind: 'sheets-bumper', controller, promise });
    await promise;
    return result;
  }

  /**
   * 供云表协同「排贴表」直接调度蓝蝶模拟器执行单条排贴任务：
   * 支持离线自动唤醒、自动匹配切换专页身份、媒体本地准备、时间线/小组逐条回调回写，并在完成后自动关窗释放内存。
   */
  async runDirectPosterForSheet(input: {
    instanceId: string;
    targetPageId?: string | undefined;
    targetPageName?: string | undefined;
    material: PosterMaterial;
    targets: readonly BumperTarget[];
    closeOnFinish?: boolean | undefined;
    signal?: AbortSignal | undefined;
    onStatus?: ((text: string) => void) | undefined;
    onPosted?: ((log: PosterLog, isTimeline: boolean) => Promise<void> | void) | undefined;
  }): Promise<{ postedCount: number; timelinePosted: boolean; error?: string | undefined }> {
    if (!this.extra?.posterRunner) {
      return { postedCount: 0, timelinePosted: false, error: '蓝蝶发帖执行器未就绪' };
    }
    const riskPre = await this.checkInstanceRiskQuota(input.instanceId, 'post');
    if (!riskPre.allowed) {
      const msg = riskPre.reason ?? '今日已达蓝蝶风控安全上限，自动休眠保护';
      input.onStatus?.(msg);
      return { postedCount: 0, timelinePosted: false, error: msg };
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(new Error('TASK_STOPPED'));
    if (input.signal?.aborted) {
      controller.abort(new Error('TASK_STOPPED'));
    } else {
      input.signal?.addEventListener('abort', onAbort, { once: true });
    }

    let postedCount = 0;
    let timelinePosted = false;
    let errorMsg: string | undefined;
    let shouldCloseOnExit = false;

    const promise = (async () => {
      try {
        const snapBefore = await this.getDiscoverySnapshot(false);
        const beforeInst = snapBefore.instances.find((i) => i.id === input.instanceId);
        const wasOnline = Boolean(beforeInst?.online);

        input.onStatus?.(wasOnline ? '正在校验蓝蝶在线状态…' : '正在自动启动蓝蝶窗口…');
        let inst = await this.ensureInstanceOnlineForSchedule(input.instanceId, controller.signal);
        shouldCloseOnExit = input.closeOnFinish !== false;

        // If targetPageName matches one of this emulator's managed Page identities and it isn't active yet, auto-switch!
        const normTargetId = (input.targetPageId ?? '').trim().toLowerCase();
        const normTargetName = (input.targetPageName ?? '').trim().toLowerCase();
        const currentMatchesId =
          Boolean(normTargetId) &&
          ((inst.numericAccountId ?? '').trim().toLowerCase() === normTargetId ||
            inst.accountId.trim().toLowerCase() === normTargetId);
        const currentMatchesName =
          Boolean(normTargetName) && inst.accountName.trim().toLowerCase() === normTargetName;

        if (!currentMatchesId && !currentMatchesName && this.devices.switchIdentity) {
          const managedPage = (inst.managedIdentities ?? []).find(
            (m) =>
              m.identityType === 'page' &&
              !m.active &&
              Boolean(normTargetName) &&
              (m.name.trim().toLowerCase() === normTargetName ||
                m.name.trim().toLowerCase().includes(normTargetName) ||
                normTargetName.includes(m.name.trim().toLowerCase())),
          );
          if (managedPage) {
            input.onStatus?.(`正在自动切换专页身份：${managedPage.name}…`);
            this.switchingIds.add(input.instanceId);
            try {
              inst = await this.devices.switchIdentity(
                input.instanceId,
                { targetName: managedPage.name, targetType: 'page' },
                controller.signal,
              );
            } finally {
              this.switchingIds.delete(input.instanceId);
              this.invalidateDiscoveryCache();
            }
          }
        }

        const preparedMaterial =
          !input.material.localFilePath &&
          input.material.mediaSource &&
          this.extra?.ensurePosterMaterialLocal
            ? await this.extra.ensurePosterMaterialLocal(input.material).catch(() => input.material)
            : input.material;

        const postToTimeline = input.targets.some((t) => t.id === PAGE_TIMELINE_SYNTHETIC_GROUP_ID);
        const groupTargets = input.targets.filter((t) => t.id !== PAGE_TIMELINE_SYNTHETIC_GROUP_ID);

        const outcome = await this.extra?.posterRunner?.run(
          input.instanceId,
          [preparedMaterial],
          groupTargets,
          {
            maxGroupsPerInstance: Math.max(groupTargets.length, 0),
            postToTimeline,
          },
          controller.signal,
          {
            status: (text) => input.onStatus?.(text),
            posted: () => {},
            onPostLog: async (log, isTimeline) => {
              if (isTimeline) {
                timelinePosted = true;
              } else {
                postedCount++;
              }
              await input.onPosted?.(log, isTimeline);
              const q = await this.checkInstanceRiskQuota(input.instanceId, 'post');
              if (!q.allowed && !controller.signal.aborted) {
                controller.abort(
                  new Error(
                    `RISK_LIMIT_REACHED:${q.reason ?? '今日已达蓝蝶风控安全上限，自动休眠保护'}`,
                  ),
                );
              }
            },
          },
        );
        if (postedCount === 0 && !timelinePosted && outcome && outcome.notes.length > 0) {
          errorMsg = outcome.notes[0];
        }
      } catch (err) {
        const riskReason = this.extractRiskLimitAbortReason(controller.signal, err);
        if (riskReason) {
          errorMsg = riskReason;
          await Promise.resolve(
            this.repo.saveLastStatus(input.instanceId, riskReason.slice(0, 120)),
          ).catch(() => {});
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          errorMsg = controller.signal.aborted || msg === 'TASK_STOPPED' ? '任务已手动停止' : msg;
        }
      } finally {
        input.signal?.removeEventListener('abort', onAbort);
        this.extraWorkers.delete(input.instanceId);
        if (shouldCloseOnExit) {
          input.onStatus?.('发布结束，正在自动关闭蓝蝶窗口释放内存…');
          this.closingIds.add(input.instanceId);
          try {
            await this.devices.closeInstance(input.instanceId).catch(() => {});
          } finally {
            this.closingIds.delete(input.instanceId);
          }
        }
        this.invalidateDiscoveryCache();
      }
    })();

    this.extraWorkers.set(input.instanceId, { kind: 'sheets-poster', controller, promise });
    await promise;
    return {
      postedCount,
      timelinePosted,
      ...(errorMsg ? { error: errorMsg } : {}),
    };
  }
}
