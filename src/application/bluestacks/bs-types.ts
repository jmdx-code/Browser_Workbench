import type { CompatibleRepository } from '../../domain/persistence.js';
import { ProductError } from '../../domain/workspace.js';
import {
  DEFAULT_BLUESTACKS_RISK_LIMIT_SETTINGS,
  bluestacksDisplayTitle,
  evaluateBluestacksRiskQuota,
  isBluestacksPortraitResolution,
  type BluestacksBatchLoginState,
  type BluestacksBumperMode,
  type BluestacksDailyUsageOverview,
  type BluestacksFolder,
  type BluestacksHealthCheckState,
  type BluestacksInstance,
  type BluestacksModuleProfileStat,
  type BluestacksQuickActiveStepType,
  type BluestacksRiskActionKind,
  type BluestacksRiskLimitSettings,
  type BluestacksRuntimeConfig,
  type BluestacksWorkerKind,
} from '../../shared/bluestacks.js';
import type { SavedCombination } from '../../shared/contracts.js';
import type {
  BumperDailyStat,
  BumperProfileStat,
  BumperScope,
  BumperSettings,
  BumperTarget,
} from '../../shared/group-bumper.js';
import type { PosterLog, PosterMaterial } from '../../shared/group-poster.js';
import type { PostBumpRecordsPort } from '../../shared/post-bump-records.js';
import type { FeatureExecutionRegistry } from '../feature-execution-registry.js';
import {
  errMsg,
  extractRiskAbortReason,
  ignoreError,
  linkAbortSignal,
  sleepMs,
} from '../module-worker-pool.js';
import { Workboard } from '../workboard.js';

export interface BluestacksActiveStepParam {
  type: BluestacksQuickActiveStepType;
  friendAction?: 'accept' | 'add_suggested';
  feedMode?: 'home' | 'random_profile' | 'random_page' | 'search_pages';
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
      action(kind?: 'like' | 'post' | 'action'): void;
      onStepChange?: (stepIndex: number) => void;
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
    options: {
      maxGroupsPerInstance: number;
      materialsPerGroup?: number;
      postToTimeline: boolean;
      claimNextGroupJob?: () =>
        | Promise<{ group: BumperTarget; material: PosterMaterial } | null>
        | { group: BumperTarget; material: PosterMaterial }
        | null;
      releaseGroupJob?: (groupId: string, materialId: string, posted: boolean) => void;
      hasGroupPostedMaterial?: (groupId: string, materialId: string) => Promise<boolean> | boolean;
    },
    signal: AbortSignal,
    callbacks: {
      status(text: string): void;
      posted(): void;
      onPostLog?(log: PosterLog, isTimeline: boolean): Promise<void> | void;
      onTargetFailed?(info: {
        groupId: string;
        groupName: string;
        isTimeline: boolean;
        material: PosterMaterial;
        reason: string;
      }): Promise<void> | void;
    },
  ): Promise<{ posted: number; skipped: number; notes: string[] }>;
}

export interface BluestacksInviterRunnerPort {
  run(
    instanceId: string,
    groups: readonly BumperTarget[],
    invitesPerGroup: number,
    signal: AbortSignal,
    callbacks: { status(text: string): void; invited(delta: number): void },
  ): Promise<{ invited: number; skippedGroups: number; notes: string[] }>;
}

export interface BluestacksExtraRunners {
  activeRunner?: BluestacksActiveRunnerPort;
  posterRunner?: BluestacksPosterRunnerPort;
  inviterRunner?: BluestacksInviterRunnerPort;
  listCombinations?: () => Promise<SavedCombination[]> | SavedCombination[];
  listPosterMaterials?: () => Promise<PosterMaterial[]> | PosterMaterial[];
  ensurePosterMaterialLocal?: (material: PosterMaterial) => Promise<PosterMaterial>;
  hasGroupPostedMaterial?: (groupId: string, materialId: string) => Promise<boolean> | boolean;
}

type SavedSettingsShape = {
  installDir: string | null;
  confPath: string | null;
  bumperSettings: BumperSettings;
  pageBumperSettings?: BumperSettings;
  riskLimitSettings?: BluestacksRiskLimitSettings;
};

export interface BluestacksServiceRepository {
  savedSettings(): SavedSettingsShape;
  savePaths(input: unknown): SavedSettingsShape;
  saveBumperSettings(input: unknown): BumperSettings;
  savePageBumperSettings?(input: unknown): BumperSettings;
  saveRiskLimitSettings?(input: unknown): BluestacksRiskLimitSettings;
  recordDailyActiveAction?(
    id: string,
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
    ids?: readonly string[],
    opts?: { columns?: number; gap?: number },
  ): Promise<number>;
  installFbLiteApk?(
    id: string,
    apkPath?: string,
    signal?: AbortSignal,
  ): Promise<BluestacksInstance>;
  switchIdentity?(
    instanceId: string,
    target: { targetName?: string; targetType?: 'personal' | 'page' },
    signal?: AbortSignal,
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
    callbacks: { status(text: string, today?: number): void; added(today: number): void },
    mode?: BluestacksBumperMode,
    options?: { lockEnableSound?: boolean },
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

export interface QueuedBluestacksTask {
  instanceId: string;
  mode: BluestacksBumperMode;
  groups: BumperTarget[];
  pages: BumperTarget[];
  settings: BumperSettings;
  controller: AbortController;
}

export type ExtraExecutionKind =
  | 'active'
  | 'poster'
  | 'inviter'
  | 'sheets-bumper'
  | 'sheets-poster'
  | 'batch-login'
  | 'health-check';

export function createBluestacksServiceContext(
  repo: CompatibleRepository<BluestacksServiceRepository>,
  devices: BluestacksDeviceController,
  runner: BluestacksBumperRunnerPort,
  registry?: FeatureExecutionRegistry,
  extra?: BluestacksExtraRunners,
) {
  return {
    repo,
    devices,
    runner,
    registry,
    extra,
    workboard: new Workboard(),
    postBumpRecords: undefined as PostBumpRecordsPort | undefined,
    profileStats: new Map<string, BumperProfileStat>(),
    pageProfileStats: new Map<string, BumperProfileStat>(),
    activeProfileStats: new Map<string, BluestacksModuleProfileStat>(),
    posterProfileStats: new Map<string, BluestacksModuleProfileStat>(),
    inviterProfileStats: new Map<string, BluestacksModuleProfileStat>(),
    activeWorkers: new Map<string, Promise<void>>(),
    activeWorkerModes: new Map<string, BluestacksBumperMode>(),
    activeWorkerSettings: new Map<string, BumperSettings>(),
    abortControllers: new Map<string, AbortController>(),
    extraWorkers: new Map<
      string,
      {
        kind: Exclude<BluestacksWorkerKind, 'group-bumper' | 'page-bumper'>;
        controller: AbortController;
        promise: Promise<void>;
      }
    >(),
    queuedExtraTasks: new Map<
      string,
      {
        kind: 'active' | 'poster' | 'inviter';
        controller: AbortController;
        statsMap: Map<string, BluestacksModuleProfileStat>;
      }
    >(),
    queuedTasks: [] as QueuedBluestacksTask[],
    launchingIds: new Set<string>(),
    closingIds: new Set<string>(),
    inspectingIds: new Set<string>(),
    installingIds: new Set<string>(),
    loggingInIds: new Set<string>(),
    switchingIds: new Set<string>(),
    pumpingPool: false,
    activeConcurrencyCap: null as number | null,
    statusText: '请选择蓝蝶窗口、目标小组和目标主页',
    pageStatusText: '请选择蓝蝶窗口和目标专页',
    activeStatusText: '请选择蓝蝶窗口与活跃任务组合或快捷动作',
    posterStatusText: '请选择蓝蝶窗口、发帖素材与目标小组',
    inviterStatusText: '请选择蓝蝶窗口与目标小组（需个人账号身份）',
    batchLoginStarting: false,
    batchLoginState: null as BluestacksBatchLoginState | null,
    batchLoginAbort: null as AbortController | null,
    batchLoginRunnerPromise: null as Promise<void> | null,
    healthCheckStarting: false,
    healthCheckState: null as BluestacksHealthCheckState | null,
    healthCheckAbort: null as AbortController | null,
    healthCheckRunnerPromise: null as Promise<void> | null,
    discoveryCache: null as {
      at: number;
      instances: BluestacksInstance[];
      config: BluestacksRuntimeConfig;
    } | null,
    discoveryInFlight: null as Promise<{
      instances: BluestacksInstance[];
      config: BluestacksRuntimeConfig;
    }> | null,
  };
}

export type BluestacksServiceContext = ReturnType<typeof createBluestacksServiceContext>;
export const bsCarrierId = (instanceId: string) => `bs:${instanceId}`;
export const invalidateDiscoveryCache = (ctx: BluestacksServiceContext) =>
  void (ctx.discoveryCache = null);

export async function withTrackedDeviceOp<T>(
  ctx: BluestacksServiceContext,
  trackSet: Set<string>,
  instanceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  trackSet.add(instanceId);
  try {
    return await fn();
  } finally {
    trackSet.delete(instanceId);
    invalidateDiscoveryCache(ctx);
  }
}

export function setBsStat<T extends BumperProfileStat>(
  statsMap: Map<string, T>,
  id: string,
  patch: Partial<T> & { running: boolean; status: string },
): void {
  const cur = statsMap.get(id);
  const prevSteps =
    patch.running &&
    !('steps' in patch) &&
    cur &&
    'steps' in cur &&
    Array.isArray((cur as { steps?: unknown }).steps)
      ? { steps: (cur as { steps?: unknown }).steps }
      : {};
  statsMap.set(id, {
    session: cur?.session ?? 0,
    today: cur?.today ?? 0,
    ...prevSteps,
    ...patch,
  } as T);
}

export const saveLastStatusSafe = (ctx: BluestacksServiceContext, id: string, status: string) =>
  ignoreError(ctx.repo.saveLastStatus(id, status.slice(0, 120)));

export const recordBsFailure = (
  ctx: BluestacksServiceContext,
  input: Parameters<PostBumpRecordsPort['insert']>[0],
) => {
  if (ctx.postBumpRecords) void ignoreError(ctx.postBumpRecords.insert(input));
};

export function classifyBsWorkerError(ctrl: AbortController, err: unknown, fallback = '运行异常') {
  const riskReason = extractRiskAbortReason(ctrl.signal, err);
  const rawMsg = errMsg(err, fallback);
  return { riskReason, rawMsg, stopped: ctrl.signal.aborted || rawMsg === 'TASK_STOPPED' };
}

export function deleteAllBsStats(ctx: BluestacksServiceContext, instanceId: string): void {
  for (const map of [
    ctx.profileStats,
    ctx.pageProfileStats,
    ctx.activeProfileStats,
    ctx.posterProfileStats,
    ctx.inviterProfileStats,
  ])
    map.delete(instanceId);
}

export function runWithBsSoldier<T>(
  ctx: BluestacksServiceContext,
  instanceId: string,
  moduleId: string,
  controller: AbortController,
  work: () => Promise<T>,
): Promise<T> {
  const cid = bsCarrierId(instanceId);
  const enter = () =>
    ctx.workboard.runSoldier(
      { carrierId: cid, carrierKind: 'bluestacks', moduleId },
      async (soldier) => {
        const onAbort = () =>
          !controller.signal.aborted && controller.abort(new Error('TASK_STOPPED'));
        if (soldier.signal.aborted) onAbort();
        else soldier.signal.addEventListener('abort', onAbort, { once: true });
        try {
          return await work();
        } finally {
          soldier.signal.removeEventListener('abort', onAbort);
        }
      },
    );
  return ctx.workboard.isCarrierBusy(cid)
    ? ctx.workboard.waitUntilCarrierIdle(cid, 1500).then(enter)
    : enter();
}

export function runLinkedExtraWorker<T>(
  ctx: BluestacksServiceContext,
  instanceId: string,
  kind: ExtraExecutionKind,
  externalSignal: AbortSignal | undefined,
  onAbortedInitially: () => T,
  execute: (controller: AbortController) => Promise<T>,
  cleanup?: () => Promise<void> | void,
): Promise<T> {
  const { controller, abortedInitially, detach } = linkAbortSignal(externalSignal);
  if (abortedInitially) return Promise.resolve(onAbortedInitially());
  const run = (async () => {
    try {
      return await execute(controller);
    } finally {
      detach();
      ctx.extraWorkers.delete(instanceId);
      await cleanup?.();
    }
  })();
  ctx.extraWorkers.set(instanceId, {
    kind,
    controller,
    promise: run.then(
      () => undefined,
      () => undefined,
    ),
  });
  return run;
}

export function hasExtraExecution(
  ctx: BluestacksServiceContext,
  kind?: ExtraExecutionKind,
): boolean {
  for (const w of ctx.extraWorkers.values()) if (!kind || w.kind === kind) return true;
  for (const q of ctx.queuedExtraTasks.values()) if (!kind || q.kind === kind) return true;
  return false;
}

const transientSets = (ctx: BluestacksServiceContext) => [
  ctx.launchingIds,
  ctx.closingIds,
  ctx.inspectingIds,
  ctx.installingIds,
  ctx.loggingInIds,
  ctx.switchingIds,
];

export function isProfileRunning(
  ctx: BluestacksServiceContext,
  instanceId: string,
  mode?: BluestacksBumperMode,
): boolean {
  if (mode)
    return (
      (ctx.activeWorkers.has(instanceId) && ctx.activeWorkerModes.get(instanceId) === mode) ||
      ctx.queuedTasks.some((t) => t.instanceId === instanceId && t.mode === mode)
    );
  return (
    ctx.activeWorkers.has(instanceId) ||
    ctx.queuedTasks.some((t) => t.instanceId === instanceId) ||
    ctx.extraWorkers.has(instanceId) ||
    ctx.queuedExtraTasks.has(instanceId) ||
    ctx.closingIds.has(instanceId)
  );
}

export function hasActiveExecution(
  ctx: BluestacksServiceContext,
  mode?: BluestacksBumperMode,
): boolean {
  if (mode) {
    for (const m of ctx.activeWorkerModes.values()) if (m === mode) return true;
    return ctx.queuedTasks.some((t) => t.mode === mode);
  }
  return (
    ctx.activeWorkers.size > 0 ||
    ctx.queuedTasks.length > 0 ||
    ctx.extraWorkers.size > 0 ||
    ctx.queuedExtraTasks.size > 0 ||
    transientSets(ctx).some((s) => s.size > 0) ||
    Boolean(ctx.batchLoginState?.running) ||
    Boolean(ctx.healthCheckState?.running)
  );
}

export const isInstanceBusyInOtherWorker = (
  ctx: BluestacksServiceContext,
  instanceId: string,
): boolean =>
  isProfileRunning(ctx, instanceId) || transientSets(ctx).some((s) => s.has(instanceId));

export async function getDiscoverySnapshot(ctx: BluestacksServiceContext, force = false) {
  const cached = ctx.discoveryCache;
  if (!force && cached && Date.now() - cached.at < 2500)
    return {
      instances: await ctx.repo.listInstances([...ctx.devices.getOnlineKeys()]),
      config: cached.config,
    };
  if (ctx.discoveryInFlight) return ctx.discoveryInFlight;
  const p = ctx.devices
    .discoverInstances()
    .then(
      (res) => (
        (ctx.discoveryCache = { at: Date.now(), instances: res.instances, config: res.config }),
        res
      ),
    )
    .finally(() => {
      if (ctx.discoveryInFlight === p) ctx.discoveryInFlight = null;
    });
  ctx.discoveryInFlight = p;
  return p;
}

export async function ensurePortraitInstanceOnline(
  ctx: BluestacksServiceContext,
  instanceId: string,
  opts: {
    forceDiscover: boolean;
    launchStatus: string;
    signal?: AbortSignal;
    waitWhileLaunching?: boolean;
    onStatus?: (text: string) => void;
  },
): Promise<BluestacksInstance> {
  if (opts.waitWhileLaunching) {
    while (ctx.launchingIds.has(instanceId) && !opts.signal?.aborted) {
      opts.onStatus?.('等待蓝蝶窗口启动完成…');
      await sleepMs(300, opts.signal);
    }
    if (opts.signal?.aborted) throw new Error('TASK_STOPPED');
  }
  const existing = (await getDiscoverySnapshot(ctx, opts.forceDiscover)).instances.find(
    (i) => i.id === instanceId,
  );
  if (!existing)
    throw new ProductError('BLUESTACKS_INSTANCE_NOT_FOUND', '未找到指定的蓝蝶模拟器实例', 404);
  if (!isBluestacksPortraitResolution(existing.fbWidth, existing.fbHeight))
    throw new ProductError(
      'BLUESTACKS_LANDSCAPE_UNSUPPORTED',
      `模拟器为横屏 (${existing.fbWidth}×${existing.fbHeight})，需改为竖屏`,
      400,
    );
  if (existing.online) return existing;
  opts.onStatus?.('正在自动启动蓝蝶窗口…');
  return withTrackedDeviceOp(ctx, ctx.launchingIds, instanceId, async () => {
    const launched = await ctx.devices.launchInstance(instanceId, opts.signal);
    await saveLastStatusSafe(ctx, instanceId, opts.launchStatus);
    return launched;
  });
}

const TRANSIENT_LABELS = [
  ['launchingIds', '正在启动窗口…'],
  ['closingIds', '正在关闭窗口…'],
  ['inspectingIds', '正在识别账号…'],
  ['installingIds', '正在安装 FB Lite…'],
  ['loggingInIds', '正在自动登录账号…'],
  ['switchingIds', '正在切换身份…'],
] as const;

export function buildDefaultInstanceStatus(
  ctx: BluestacksServiceContext,
  inst: BluestacksInstance,
): string {
  for (const [key, label] of TRANSIENT_LABELS) if (ctx[key].has(inst.id)) return label;
  if (!inst.online)
    return inst.lastStatus === '窗口已启动' || inst.lastStatus?.startsWith('账号已识别')
      ? '未启动'
      : inst.lastStatus || '未启动';
  if (!isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight))
    return `横屏 ${inst.fbWidth}×${inst.fbHeight}（需改竖屏）`;
  if (inst.fbLiteInstalled === false || inst.accountState === 'missing-app')
    return '未安装 FB Lite';
  if (inst.accountState === 'logged-out') return '未登录 FB Lite';
  if (inst.accountState === 'verification') return '需安全验证 (Checkpoint)';
  if (inst.accountState === 'restricted') return '账号受限/停用';
  return inst.lastStatus === '已关闭' || inst.lastStatus?.startsWith('启动失败')
    ? '在线就绪'
    : inst.lastStatus || '在线就绪';
}

export async function guardInstanceRiskQuota(
  ctx: BluestacksServiceContext,
  instanceId: string,
  actionKind: BluestacksRiskActionKind,
  saveStatus = true,
): Promise<string | null> {
  if (!ctx.repo.dailyInstanceUsage) return null;
  const [saved, usage] = await Promise.all([
    ctx.repo.savedSettings(),
    Promise.resolve(ctx.repo.dailyInstanceUsage()).catch(() => null),
  ]);
  const risk = saved.riskLimitSettings ?? DEFAULT_BLUESTACKS_RISK_LIMIT_SETTINGS;
  if (!risk.enabled || !usage) return null;
  const counts = usage.perInstance[instanceId] ?? {
    groupBumpsToday: 0,
    pageBumpsToday: 0,
    postsToday: 0,
    invitesToday: 0,
    activeLikesToday: 0,
    activeActionsToday: 0,
  };
  const res = evaluateBluestacksRiskQuota(risk, instanceId, counts, actionKind);
  if (res.allowed) return null;
  const msg = res.reason ?? '今日已达蓝蝶风控安全上限，自动休眠保护';
  if (saveStatus) await saveLastStatusSafe(ctx, instanceId, msg);
  return msg;
}

export const triggerRiskQuotaAbort = (
  ctx: BluestacksServiceContext,
  instanceId: string,
  actionKind: BluestacksRiskActionKind,
  controller: AbortController,
) =>
  void guardInstanceRiskQuota(ctx, instanceId, actionKind, false)
    .then(
      (msg) =>
        msg &&
        !controller.signal.aborted &&
        controller.abort(new Error(`RISK_LIMIT_REACHED:${msg}`)),
    )
    .catch(() => {});

const OWN_REGISTRY_IDS = new Set([
  'bluestacks-group-bumper',
  'bluestacks-page-bumper',
  'bluestacks-active',
  'bluestacks-group-poster',
  'bluestacks-group-inviter',
  'bluestacks-batch-login',
  'bluestacks-health-check',
]);

export async function isExternallyBusy(
  ctx: BluestacksServiceContext,
  instanceId: string,
): Promise<boolean> {
  if (!ctx.registry) return false;
  for (const p of ctx.registry.participants())
    if (!OWN_REGISTRY_IDS.has(p.id) && (await p.isProfileRunning(instanceId))) return true;
  return false;
}

export async function prepareIdlePortraitInstances(
  ctx: BluestacksServiceContext,
  profileIds: readonly string[],
  instances: readonly BluestacksInstance[],
  riskKind: BluestacksRiskActionKind,
  statsMap: Map<string, BumperProfileStat>,
  busyMessage = '所选蓝蝶窗口正忙于其他任务',
): Promise<string[]> {
  const instMap = new Map(instances.map((i) => [i.id, i]));
  const idleIds = [...new Set(profileIds)].filter((id) => !isProfileRunning(ctx, id));
  if (!idleIds.length)
    throw new ProductError('INSTANCES_ALREADY_RUNNING', '所选模拟器已在运行队列中', 409);
  const eligibleReady: string[] = [];
  const skippedReasons: string[] = [];
  for (const id of idleIds) {
    const inst = instMap.get(id);
    if (!inst) continue;
    const label = bluestacksDisplayTitle(inst);
    if (ctx.closingIds.has(id)) {
      skippedReasons.push(`${label} 正在关闭`);
      setBsStat(statsMap, id, { running: false, status: '跳过：窗口正在关闭' });
    } else if (!isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight)) {
      skippedReasons.push(`${label} 为横屏 (${inst.fbWidth}×${inst.fbHeight})`);
      setBsStat(statsMap, id, {
        running: false,
        status: `跳过：横屏 ${inst.fbWidth}×${inst.fbHeight}（需改竖屏）`,
      });
    } else eligibleReady.push(id);
  }
  if (!eligibleReady.length)
    throw new ProductError(
      'NO_ONLINE_PORTRAIT_INSTANCES',
      skippedReasons.length
        ? `无法启动运行：${skippedReasons.slice(0, 3).join('；')}`
        : '未找到可用的竖屏蓝蝶窗口，请先检查蓝蝶分辨率设置',
      400,
    );
  const idleReady: string[] = [];
  for (const id of eligibleReady) if (!(await isExternallyBusy(ctx, id))) idleReady.push(id);
  if (!idleReady.length) throw new ProductError('NO_IDLE_INSTANCES', busyMessage, 409);

  const allowedIds: string[] = [];
  let firstBlocked: string | null = null;
  for (const id of idleReady) {
    const blockedMsg = await guardInstanceRiskQuota(ctx, id, riskKind);
    if (!blockedMsg) allowedIds.push(id);
    else {
      firstBlocked ??= blockedMsg;
      setBsStat(statsMap, id, { running: false, status: blockedMsg });
    }
  }
  if (!allowedIds.length && firstBlocked)
    throw new ProductError('BLUESTACKS_DAILY_RISK_LIMIT', firstBlocked, 409);
  return allowedIds;
}

export async function stopExtraWorkers(
  ctx: BluestacksServiceContext,
  kind?: ExtraExecutionKind,
  ids?: readonly string[],
): Promise<void> {
  const idSet = ids?.length ? new Set(ids) : null;
  for (const [id, q] of [...ctx.queuedExtraTasks.entries()]) {
    if ((kind && q.kind !== kind) || (idSet && !idSet.has(id))) continue;
    q.controller.abort(new Error('TASK_STOPPED'));
    ctx.workboard.abortCarrier(bsCarrierId(id), 'TASK_STOPPED');
    ctx.queuedExtraTasks.delete(id);
    setBsStat(q.statsMap, id, { running: false, status: '已停止' });
  }
  const waits: Promise<void>[] = [];
  for (const [id, w] of ctx.extraWorkers.entries()) {
    if ((kind && w.kind !== kind) || (idSet && !idSet.has(id))) continue;
    w.controller.abort(new Error('TASK_STOPPED'));
    ctx.workboard.abortCarrier(bsCarrierId(id), 'TASK_STOPPED');
    waits.push(w.promise);
  }
  if (waits.length) await Promise.allSettled(waits);
  for (const [k, field, msg] of [
    ['active', 'activeStatusText', '已停止蓝蝶活跃任务'],
    ['poster', 'posterStatusText', '已停止蓝蝶发帖任务'],
    ['inviter', 'inviterStatusText', '已停止蓝蝶小组邀请任务'],
  ] as const) {
    if ((!kind || kind === k) && !hasExtraExecution(ctx, k)) ctx[field] = msg;
  }
}
