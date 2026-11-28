import type { CompatibleRepository } from '../../domain/persistence.js';
import type {
  BluestacksBatchLoginState,
  BluestacksBumperMode,
  BluestacksDailyUsageOverview,
  BluestacksFolder,
  BluestacksHealthCheckState,
  BluestacksInstance,
  BluestacksModuleProfileStat,
  BluestacksQuickActiveStepType,
  BluestacksRiskLimitSettings,
  BluestacksRuntimeConfig,
  BluestacksWorkerKind,
} from '../../shared/bluestacks.js';
import type { SavedCombination } from '../../shared/contracts.js';
import type {
  BumperProfileStat,
  BumperScope,
  BumperSettings,
  BumperTarget,
} from '../../shared/group-bumper.js';
import type { PosterLog, PosterMaterial } from '../../shared/group-poster.js';
import type { PostBumpRecordsPort } from '../../shared/post-bump-records.js';
import type { FeatureExecutionRegistry } from '../feature-execution-registry.js';
import { Workboard } from '../workboard.js';
export interface BluestacksActiveStepParam {
  type: BluestacksQuickActiveStepType;
  friendAction?: 'accept' | 'add_suggested';
  feedMode?: 'home' | 'random_profile' | 'random_page' | 'search_pages';
  durationMinutes?: number;
  maxLikes?: number;
  likeProbability?: number;
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
      onProgressDelta?: (delta: {
        durationMsDelta?: number;
        friendsDelta?: number;
        accountId?: string;
      }) => void;
      checkRiskLimit?: (
        kind: 'like' | 'post' | 'action',
      ) =>
        | Promise<{ allowed: boolean; reason: string | null }>
        | { allowed: boolean; reason: string | null };
      recordPostResult?: (entry: {
        status: 'success' | 'failed';
        isStory: boolean;
        captionPreview: string;
        errorReason?: string;
        accountId?: string;
        accountName?: string;
      }) => Promise<void> | void;
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
    options?: {
      getInvitedFriendIds?: (
        groupId: string,
      ) =>
        | Promise<ReadonlySet<string> | ReadonlyArray<string>>
        | ReadonlySet<string>
        | ReadonlyArray<string>;
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
  hasGroupPostedMaterial?: (groupId: string, materialId: string) => Promise<boolean> | boolean;
  recordActiveProgress?: (input: {
    profileId: string;
    accountId?: string;
    durationMsDelta?: number;
    friendsDelta?: number;
    at?: number;
  }) => Promise<void> | void;
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
  invitedFriendIdsForGroup?(groupId: string): ReadonlySet<string> | ReadonlyArray<string>;
}
type BsBounds = Record<'left' | 'top' | 'width' | 'height', number>;
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
    opts?: { columns?: number; gap?: number; monitorBounds?: BsBounds },
  ): Promise<number>;
  installFbLiteApk?(id: string, apk?: string, signal?: AbortSignal): Promise<BluestacksInstance>;
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
export type BsDiscoverySnap = {
  instances: BluestacksInstance[];
  config: BluestacksRuntimeConfig;
};
export type BsPostDone = {
  postId: string;
  liked: boolean;
  commented: boolean;
  commentText?: string | null;
};
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
      onPostDone?: (res: BsPostDone) => void | Promise<void>;
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
  closeWindowOnFinish?: boolean;
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
    workboard: new Workboard({ browserConcurrency: 100, bluestacksConcurrency: 50 }),
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
    instanceOpWorkers: new Map<
      string,
      {
        kind: 'launch' | 'inspect' | 'install-apk' | 'login' | 'switch-identity';
        controller: AbortController;
        promise: Promise<void>;
      }
    >(),
    pumpingPool: false,
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
    discoveryCache: null as (BsDiscoverySnap & { at: number }) | null,
    discoveryInFlight: null as Promise<BsDiscoverySnap> | null,
  };
}
export type BluestacksServiceContext = ReturnType<typeof createBluestacksServiceContext>;
export * from './bs-op-helpers.js';
