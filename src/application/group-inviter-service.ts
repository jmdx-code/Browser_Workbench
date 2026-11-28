import type { Awaitable } from '../domain/persistence.js';
import { ProductError, failError } from '../domain/workspace.js';
import { devDiag } from '../shared/dev-diagnostics.js';
import {
  isTargetIncomplete,
  type BumperRefreshResult,
  type BumperTarget,
} from '../shared/group-bumper.js';
import type { CheckDailyRiskLimitFn } from '../shared/daily-risk-limits.js';
import {
  GroupInviterState,
  InviterRunSummarySchema,
  StartGroupInviterRequest,
  StopGroupInviterProfilesRequest,
  type GroupInviteLogRow,
  type GroupInviterProfileStat,
  type GroupInviterSettings,
  type InviterGroupOutcome,
  type InviterGroupRow,
  type InviterRecordsQuery,
  type InviterRecordsResponse,
} from '../shared/group-inviter.js';
import type { ProfileLifecyclePort } from '../shared/profile-lifecycle.js';
import type { ProfileTaskResultValue } from '../shared/task-contracts.js';
import type { FeatureExecutionRegistry } from './feature-execution-registry.js';
import {
  executeInviterRun,
  runScheduledInviterProfileStep,
} from './inviter/inviter-run-executor.js';
import {
  admitAndPlanBrowserLaunch,
  awaitWorkersSettled,
  buildStaggeredQueues,
  errMsg,
  formatAvatarRefreshSummary,
  persistProfileTaskResult,
  runTargetAvatarRefresh,
  sleepMs,
} from './module-worker-pool.js';
import { Workboard } from './workboard.js';
type InviteEntryInput = {
  profileId: string;
  accountId: string;
  friendId: string;
  friendName: string;
  groupId: string;
  invitedAt?: number;
};
export interface GroupInviterRepository {
  hasInvitesForOperation?(opId: string, profileId?: string, accountId?: string): Awaitable<boolean>;
  reserveInvites?(opId: string, entries: ReadonlyArray<InviteEntryInput>): Awaitable<void>;
  releasePendingInvites?(opId: string): Awaitable<number>;
  saveProfileResult?(result: ProfileTaskResultValue): Awaitable<void>;
  listGroups(): Awaitable<InviterGroupRow[]>;
  upsertGroups(input: unknown): Awaitable<InviterGroupRow[]>;
  applyResolvedGroupMetadata?(
    rawGroupId: string,
    metadata: { canonicalId?: string | null; name?: string | null; avatarUrl?: string | null },
  ): Awaitable<void>;
  deleteGroups(input: unknown): Awaitable<number>;
  getSettings(): Awaitable<GroupInviterSettings>;
  saveSettings(input: unknown): Awaitable<GroupInviterSettings>;
  getInvitedFriendIdsForGroup(groupId: string): Awaitable<Set<string>>;
  recordInvites(entries: ReadonlyArray<InviteEntryInput>, operationId?: string): Awaitable<number>;
  getTotalInvitedByProfile(): Awaitable<Map<string, number>>;
  listLogs(filter?: {
    groupId?: string;
    profileId?: string;
    accountId?: string;
    search?: string;
    before?: number;
    beforeId?: string;
    limit?: number;
  }): Awaitable<GroupInviteLogRow[]>;
  queryEnrichedLogs?(query?: InviterRecordsQuery): Awaitable<InviterRecordsResponse>;
  deleteLogs?(input: unknown): Awaitable<{ deleted: number }>;
}
export interface GroupInviterRunCallbacks {
  reportBatchResult?(profileId: string, confirmed: number, pending: number): Awaitable<void>;
  isCancelled(profileId?: string): boolean;
  setProfileStatus(profileId: string, status: string): Awaitable<void>;
  addSessionInvited(profileId: string, count: number): Awaitable<void>;
}
export interface GroupInviterBrowserRunner {
  retryStop?(profileId: string): Promise<void>;
  isAvailable(): boolean;
  isProfileReady(profileId: string): boolean;
  isProfileBusy?(profileId: string): Awaitable<boolean>;
  inviteForGroup(
    profileId: string,
    group: InviterGroupRow,
    invitesPerGroup: number,
    callbacks: GroupInviterRunCallbacks,
  ): Promise<void>;
}
export interface ActiveRunState {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  cancelled: boolean;
  closeBrowserOnFinish?: boolean;
  cancelledProfiles: Set<string>;
  activeProfiles: Set<string>;
  statusText: string;
  sessionCounts: Map<string, number>;
  profileStatus: Map<string, string>;
  profileNames: Map<string, string>;
  submittedProfiles: Map<string, number>;
  failedProfiles: Set<string>;
  unconfirmedStops: Set<string>;
  groupResults: InviterGroupOutcome[];
  workersFinished: boolean;
  runningBatches: number;
}
export interface InviterRuntimeState {
  readonly repo: GroupInviterRepository;
  readonly runner?: GroupInviterBrowserRunner;
  readonly assertStartAllowed: () => void;
  activeRun: ActiveRunState | null;
  lastRun: ActiveRunState | null;
  startingProfiles: Set<string>;
  admittingProfiles: Set<string>;
  startingCancelled: Set<string>;
  startGeneration: number;
  scheduledRunningProfiles: Set<string>;
  scheduledCancelledProfiles: Set<string>;
  scheduledPlaySound?: boolean;
  featureExecution?: FeatureExecutionRegistry;
  profileLifecycle?: ProfileLifecyclePort;
  workboard: Workboard;
  workerPromises: Map<string, Promise<void>>;
  checkDailyRiskLimit?: CheckDailyRiskLimitFn;
  isProfileRunning(profileId: string): boolean;
}
export const buildStaggeredGroupQueues = (
  profileIds: readonly string[],
  groups: readonly InviterGroupRow[],
) => buildStaggeredQueues(profileIds, groups);
export class GroupInviterService {
  private readonly rt: InviterRuntimeState;
  private readonly avatarFetching = new Set<string>();
  private groupAvatarRefreshing = false;
  private avatarRefreshStatusText = '';
  private avatarRefreshAbort: AbortController | null = null;
  private featureExecution?: FeatureExecutionRegistry;
  constructor(
    private readonly repo: GroupInviterRepository,
    private readonly runner?: GroupInviterBrowserRunner,
    private readonly assertStartAllowed: () => void = () => {},
    private readonly refreshAvatars?: (
      items: BumperTarget[],
      options?: { signal?: AbortSignal; onUpdated?: () => void },
    ) => Promise<BumperRefreshResult | void>,
    private readonly stopAvatarRefresh?: () => void,
  ) {
    this.rt = {
      repo,
      runner,
      assertStartAllowed,
      activeRun: null,
      lastRun: null,
      startingProfiles: new Set(),
      admittingProfiles: new Set(),
      startingCancelled: new Set(),
      startGeneration: 0,
      scheduledRunningProfiles: new Set(),
      scheduledCancelledProfiles: new Set(),
      workboard: new Workboard({ browserConcurrency: 100, bluestacksConcurrency: 50 }),
      workerPromises: new Map(),
      isProfileRunning: (pid) => this.isProfileRunning(pid),
    };
  }
  private externalWorkboard = false;
  setFeatureExecutionRegistry = (registry: FeatureExecutionRegistry) => {
    this.featureExecution = registry;
    this.rt.featureExecution = registry;
  };
  setProfileLifecycle = (lifecycle: ProfileLifecyclePort) =>
    void (this.rt.profileLifecycle = lifecycle);
  setWorkboard = (workboard: Workboard) => {
    this.externalWorkboard = true;
    this.rt.workboard = workboard;
  };
  getWorkboard = () => this.rt.workboard;
  setCheckDailyRiskLimit = (fn: CheckDailyRiskLimitFn) => void (this.rt.checkDailyRiskLimit = fn);
  async syncMaxConcurrency(maxConcurrentProfiles: number): Promise<void> {
    const capped = Math.max(1, Math.min(50, Math.round(maxConcurrentProfiles)));
    this.rt.workboard.browserPermits.setLimit(capped);
    const current = await this.repo.getSettings();
    if (current.maxConcurrentProfiles !== capped) {
      await this.repo.saveSettings({ maxConcurrentProfiles: capped });
    }
  }
  queryEnrichedLogs = async (query: InviterRecordsQuery = {}): Promise<InviterRecordsResponse> =>
    (await this.repo.queryEnrichedLogs?.(query)) ?? { records: [], total: 0, hasMore: false };
  deleteLogs = async (input: unknown): Promise<{ deleted: number }> =>
    (await this.repo.deleteLogs?.(input)) ?? { deleted: 0 };
  private async readSettings(): Promise<GroupInviterSettings> {
    const s = await this.repo.getSettings();
    if (!this.externalWorkboard)
      this.rt.workboard.setConcurrencyLimits({ browserConcurrency: s.maxConcurrentProfiles });
    return s;
  }
  hasActiveExecution = () =>
    this.rt.activeRun !== null ||
    this.rt.startingProfiles.size > 0 ||
    this.rt.admittingProfiles.size > 0 ||
    this.rt.scheduledRunningProfiles.size > 0;
  isProfileRunning = (profileId: string) =>
    this.rt.admittingProfiles.has(profileId) ||
    this.rt.startingProfiles.has(profileId) ||
    this.rt.scheduledRunningProfiles.has(profileId) ||
    this.rt.activeRun?.activeProfiles.has(profileId) === true;
  async state(): Promise<GroupInviterState> {
    const [groups, settings, totalsByProfile] = await Promise.all([
      this.repo.listGroups(),
      this.readSettings(),
      this.repo.getTotalInvitedByProfile(),
    ]);
    const run = this.rt.activeRun ?? this.rt.lastRun;
    const profileCounts: Record<string, GroupInviterProfileStat> = {};
    for (const pid of new Set([
      ...totalsByProfile.keys(),
      ...(run ? [...run.sessionCounts.keys(), ...run.profileStatus.keys()] : []),
      ...this.rt.startingProfiles,
      ...this.rt.admittingProfiles,
    ])) {
      const status =
        this.rt.startingProfiles.has(pid) || this.rt.admittingProfiles.has(pid)
          ? this.rt.startingCancelled.has(pid)
            ? '正在停止…'
            : this.rt.admittingProfiles.has(pid)
              ? '正在启动浏览器…'
              : '正在准备…'
          : run?.profileStatus.get(pid);
      profileCounts[pid] = {
        sessionInvited: run?.sessionCounts.get(pid) ?? 0,
        totalInvited: totalsByProfile.get(pid) ?? 0,
        running: this.isProfileRunning(pid),
        ...(status ? { status } : {}),
      };
    }
    const finishedLast =
      this.rt.lastRun && this.rt.lastRun.finishedAt !== null ? this.rt.lastRun : null;
    const playSoundOnComplete =
      this.rt.scheduledRunningProfiles.size > 0 && this.rt.scheduledPlaySound !== undefined
        ? this.rt.scheduledPlaySound
        : settings.playSoundOnComplete;
    return GroupInviterState.parse({
      groups,
      invitesPerGroup: settings.invitesPerGroup,
      maxConcurrentProfiles: settings.maxConcurrentProfiles,
      playSoundOnComplete,
      closeBrowserOnFinish: settings.closeBrowserOnFinish ?? false,
      running: this.hasActiveExecution(),
      groupAvatarRefreshing: this.groupAvatarRefreshing || this.avatarFetching.size > 0,
      ...(this.avatarRefreshStatusText
        ? { avatarRefreshStatusText: this.avatarRefreshStatusText }
        : {}),
      runId: run?.id ?? null,
      startedAt: run?.startedAt ?? null,
      finishedAt: this.rt.activeRun ? null : (this.rt.lastRun?.finishedAt ?? null),
      statusText: this.rt.admittingProfiles.size
        ? '正在自动启动所选离线浏览器…'
        : this.rt.startingProfiles.size
          ? '正在准备…'
          : this.rt.activeRun
            ? this.rt.activeRun.statusText
            : this.rt.scheduledRunningProfiles.size > 0
              ? '定时任务执行中…'
              : (this.rt.lastRun?.statusText ?? '就绪'),
      profileCounts,
      ...(finishedLast
        ? {
            lastRunSummary: InviterRunSummarySchema.parse({
              runId: finishedLast.id,
              invitedTotal: [...finishedLast.sessionCounts.values()].reduce((a, b) => a + b, 0),
              pendingTotal: [...finishedLast.submittedProfiles.values()].reduce((a, b) => a + b, 0),
              failedProfiles: [...finishedLast.failedProfiles],
              finishedAt: finishedLast.finishedAt ?? Date.now(),
              groupResults: finishedLast.groupResults,
            }),
          }
        : {}),
    });
  }
  private async runAndState(fn: () => unknown): Promise<GroupInviterState> {
    await fn();
    return this.state();
  }
  addGroups = (input: unknown) =>
    this.runAndState(async () => {
      await this.repo.upsertGroups(input);
      void this.fetchMissingAvatars();
    });
  deleteGroups = (input: unknown) => this.runAndState(() => this.repo.deleteGroups(input));
  updateSettings = (input: unknown) =>
    this.runAndState(async () => {
      const saved = await this.repo.saveSettings(input);
      if (!this.externalWorkboard)
        this.rt.workboard.setConcurrencyLimits({ browserConcurrency: saved.maxConcurrentProfiles });
    });
  async logs(
    search = '',
    before?: number,
    limit = 300,
    beforeId?: string,
  ): Promise<GroupInviteLogRow[]> {
    const q = search.trim().toLowerCase();
    const safeLimit = Math.max(1, Math.min(2000, Math.floor(limit)));
    const rows = await this.repo.listLogs({
      ...(q ? { search: q } : {}),
      ...(before !== undefined ? { before } : {}),
      ...(beforeId ? { beforeId } : {}),
      limit: safeLimit,
    });
    return rows
      .filter(
        (r) =>
          (before === undefined ||
            r.invitedAt < before ||
            (Boolean(beforeId) && r.invitedAt === before && r.id > (beforeId ?? ''))) &&
          (!q ||
            [r.friendName, r.friendId, r.groupId, r.profileId, r.accountId].some((v) =>
              v.toLowerCase().includes(q),
            )),
      )
      .slice(0, safeLimit);
  }
  private finishRun(run: ActiveRunState): void {
    if (!run.workersFinished || run.runningBatches > 0 || run.activeProfiles.size) return;
    run.finishedAt = Date.now();
    this.rt.lastRun = run;
    if (this.rt.activeRun === run) this.rt.activeRun = null;
  }
  private saveProfileResult(run: ActiveRunState, profileId: string): Promise<void> {
    return persistProfileTaskResult(this.repo.saveProfileResult?.bind(this.repo), {
      profileId,
      source: 'group-inviter',
      runId: run.id,
      name: '小组邀请人',
      state:
        run.cancelled || run.cancelledProfiles.has(profileId)
          ? 'STOPPED'
          : run.failedProfiles.has(profileId)
            ? 'FAILED'
            : 'COMPLETED',
      reason: run.profileStatus.get(profileId) ?? '',
      finishedAt: Date.now(),
      failedSteps: run.failedProfiles.has(profileId) ? 1 : 0,
      skippedSteps: 0,
    });
  }
  private async retryUnconfirmedStops(run: ActiveRunState, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      if (!run.unconfirmedStops.has(id) || !this.runner?.retryStop) continue;
      try {
        await this.runner.retryStop(id);
        run.unconfirmedStops.delete(id);
        run.activeProfiles.delete(id);
        run.profileStatus.set(id, '已停止（原邀请结果仍待核对）');
        await this.saveProfileResult(run, id);
      } catch {
        run.profileStatus.set(id, '停止未确认，请保持浏览器在线后重试停止');
      }
    }
    this.finishRun(run);
  }
  private stopTargets = (profileIds?: readonly string[]) =>
    this.runAndState(async () => {
      const isAll = !profileIds;
      if (isAll) this.rt.startGeneration++;
      const startCandidates = isAll
        ? [...this.rt.startingProfiles, ...this.rt.admittingProfiles]
        : profileIds.filter(
            (id) => this.rt.startingProfiles.has(id) || this.rt.admittingProfiles.has(id),
          );
      const schedCandidates = isAll
        ? [...this.rt.scheduledRunningProfiles]
        : profileIds.filter((id) => this.rt.scheduledRunningProfiles.has(id));
      for (const id of startCandidates) {
        this.rt.startingCancelled.add(id);
        this.rt.workboard.abortCarrier(id, 'USER_STOP');
      }
      for (const id of schedCandidates) {
        this.rt.scheduledCancelledProfiles.add(id);
        this.rt.workboard.abortCarrier(id, 'USER_STOP');
      }
      if (profileIds) for (const id of profileIds) this.rt.workboard.abortCarrier(id, 'USER_STOP');
      const run = this.rt.activeRun;
      const targetPids = run
        ? isAll
          ? [...run.activeProfiles]
          : profileIds.filter((pid) => run.activeProfiles.has(pid))
        : [];
      if (run) {
        if (isAll) run.cancelled = true;
        for (const pid of targetPids) {
          run.cancelledProfiles.add(pid);
          run.profileStatus.set(pid, '正在停止…');
          if (isAll) this.rt.workboard.abortCarrier(pid, 'USER_STOP');
          else
            devDiag.emit('INFO', 'GROUP_INVITER', 'GROUP_INVITER_STOP_PROFILE', {
              profileId: pid,
              data: { runId: run.id },
            });
        }
        if (isAll) {
          run.statusText = '正在停止…';
          devDiag.emit('INFO', 'GROUP_INVITER', 'GROUP_INVITER_STOP_ALL', {
            data: { runId: run.id, profiles: targetPids },
          });
          await this.retryUnconfirmedStops(run, [...run.unconfirmedStops]);
        } else {
          if (
            !run.activeProfiles.size ||
            [...run.activeProfiles].every((pid) => run.cancelledProfiles.has(pid))
          ) {
            run.cancelled = true;
            run.statusText = '正在停止…';
          }
          await this.retryUnconfirmedStops(run, profileIds);
        }
      }
      const waitIds = [...new Set([...(profileIds ?? targetPids), ...schedCandidates])];
      if (waitIds.length)
        await awaitWorkersSettled(
          waitIds.map((p) => this.rt.workerPromises.get(p)),
          6_000,
        );
    });
  stop = () => this.stopTargets();
  stopProfiles = (input: unknown) =>
    this.stopTargets(StopGroupInviterProfilesRequest.parse(input).profileIds);
  start = (input: unknown) =>
    this.runAndState(async () => {
      const req = StartGroupInviterRequest.parse(input);
      this.assertStartAllowed();
      const candidateProfiles = [...new Set(req.profileIds)].filter(
        (id) => !this.isProfileRunning(id) && !this.rt.admittingProfiles.has(id),
      );
      if (
        this.rt.startingProfiles.size > 0 ||
        this.rt.admittingProfiles.size > 0 ||
        (this.rt.activeRun && !candidateProfiles.length)
      )
        failError(
          'GROUP_INVITER_ALREADY_RUNNING',
          '小组邀请人正在运行中，请等待完成或先点击停止',
          409,
        );
      const generation = this.rt.startGeneration;
      const reservedIds = this.featureExecution
        ? (await this.featureExecution.tryReserve('group-inviter', candidateProfiles)).reservedIds
        : candidateProfiles;
      for (const id of reservedIds) {
        this.rt.admittingProfiles.add(id);
        this.rt.startingCancelled.delete(id);
      }
      let admittedBatch: Set<string> | null = null;
      try {
        const { pendingLaunchSet, launchFailureReasons, admission } =
          await admitAndPlanBrowserLaunch({
            launchCandidates: this.runner ? candidateProfiles : [],
            admitIds: () => candidateProfiles,
            moduleId: 'group-inviter',
            profileLifecycle: this.runner ? this.rt.profileLifecycle : undefined,
            featureExecution: this.featureExecution,
            isProfileReady: (id) => this.runner?.isProfileReady(id) ?? true,
            isAlreadyRunningInCurrentModule: (id) =>
              this.rt.startingProfiles.has(id) ||
              this.rt.activeRun?.activeProfiles.has(id) === true,
            isProfileBusyInRunner: async (id) => Boolean(await this.runner?.isProfileBusy?.(id)),
          });
        for (const id of candidateProfiles) this.rt.admittingProfiles.delete(id);
        admittedBatch = new Set(admission.admittedProfileIds);
        this.rt.startingProfiles = admittedBatch;
        const settingsPatch: Record<string, unknown> = {};
        for (const k of [
          'invitesPerGroup',
          'maxConcurrentProfiles',
          'playSoundOnComplete',
          'closeBrowserOnFinish',
        ] as const)
          if (req[k] !== undefined) settingsPatch[k] = req[k];
        if (Object.keys(settingsPatch).length) await this.repo.saveSettings(settingsPatch);
        const settings = await this.readSettings();
        const closeBrowserOnFinish = Boolean(
          req.closeBrowserOnFinish ?? settings.closeBrowserOnFinish,
        );
        const allGroups = new Map((await this.repo.listGroups()).map((g) => [g.groupId, g]));
        const selectedGroups = [...new Set(req.groupIds)]
          .map((id) => allGroups.get(id))
          .filter((g): g is InviterGroupRow => g !== undefined);
        if (!selectedGroups.length)
          failError('GROUP_INVITER_GROUPS_EMPTY', '未找到选中的小组，请刷新后重试', 404);
        const profileStatus = new Map<string, string>();
        for (const item of [...admission.skippedBusy, ...admission.skippedOffline])
          profileStatus.set(
            item.profileId,
            launchFailureReasons.get(item.profileId) ?? item.reason,
          );
        const skippedBusy = admission.skippedBusy.length;
        const skippedOffline = admission.skippedOffline.length;
        const eligibleProfiles: string[] = [];
        for (const id of admission.admittedProfileIds) {
          if (generation !== this.rt.startGeneration || this.rt.startingCancelled.has(id)) {
            profileStatus.set(id, '已停止');
            continue;
          }
          profileStatus.set(id, pendingLaunchSet.has(id) ? '正在启动浏览器…' : '准备中');
          eligibleProfiles.push(id);
        }
        if (!admission.admittedProfileIds.length) {
          const firstFail = [...launchFailureReasons.values()][0]?.replace(/^跳过：/, '');
          failError(
            'GROUP_INVITER_PROFILES_UNAVAILABLE',
            skippedBusy > 0 && skippedOffline > 0
              ? `所选浏览器中 ${skippedBusy} 个正在执行其他任务、${skippedOffline} 个未连接${firstFail ? `（${firstFail}）` : ''}，无法启动`
              : skippedBusy > 0
                ? (admission.skippedBusy[0]?.reason ??
                  '所选浏览器正在执行其他任务，请先停止原任务或选择空闲浏览器')
                : firstFail
                  ? `所选浏览器启动失败：${firstFail}`
                  : '所选浏览器未连接，请先打开对应浏览器',
            409,
          );
        }
        for (let i = eligibleProfiles.length - 1; i >= 0; i--) {
          const id = eligibleProfiles[i];
          if (id && this.rt.startingCancelled.has(id)) eligibleProfiles.splice(i, 1);
        }
        if (generation !== this.rt.startGeneration || !eligibleProfiles.length)
          throw new ProductError('GROUP_INVITER_START_CANCELLED', '启动已取消，没有派发邀请', 409);
        const skippedNotes = [
          skippedBusy > 0 ? `跳过 ${skippedBusy} 个运行中` : '',
          skippedOffline > 0 ? `跳过 ${skippedOffline} 个未连接` : '',
        ].filter(Boolean);
        const makeStatus = (n: number) =>
          `正在运行：${n} 个账号 × ${selectedGroups.length} 个小组（每组最多 ${settings.invitesPerGroup} 人）${skippedNotes.length ? `（已自动${skippedNotes.join('、')}）` : ''}`;
        let run = this.rt.activeRun;
        if (run) {
          for (const id of candidateProfiles) {
            if (!run.sessionCounts.has(id)) run.sessionCounts.set(id, 0);
            const st = profileStatus.get(id);
            if (st) run.profileStatus.set(id, st);
          }
          for (const id of eligibleProfiles) {
            run.cancelledProfiles.delete(id);
            run.failedProfiles.delete(id);
            run.activeProfiles.add(id);
          }
          run.workersFinished = false;
          run.runningBatches += 1;
          if (closeBrowserOnFinish) run.closeBrowserOnFinish = true;
          run.statusText = makeStatus(run.activeProfiles.size);
        } else {
          run = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            startedAt: Date.now(),
            finishedAt: null,
            cancelled: false,
            closeBrowserOnFinish,
            cancelledProfiles: new Set(),
            activeProfiles: new Set(eligibleProfiles),
            statusText: makeStatus(eligibleProfiles.length),
            sessionCounts: new Map(candidateProfiles.map((id) => [id, 0])),
            submittedProfiles: new Map(),
            profileStatus,
            profileNames: new Map(),
            failedProfiles: new Set(),
            unconfirmedStops: new Set(),
            groupResults: [],
            workersFinished: false,
            runningBatches: 1,
          };
          this.assertStartAllowed();
          this.rt.activeRun = run;
        }
        devDiag.emit('INFO', 'GROUP_INVITER', 'GROUP_INVITER_START', {
          data: {
            runId: run.id,
            eligibleProfiles,
            skippedBusy,
            skippedOffline,
            groupCount: selectedGroups.length,
            invitesPerGroup: settings.invitesPerGroup,
          },
        });
        this.rt.startingProfiles.clear();
        void executeInviterRun(
          this.rt,
          run,
          eligibleProfiles,
          selectedGroups,
          settings.invitesPerGroup,
          settings.maxConcurrentProfiles,
          pendingLaunchSet,
          {
            saveResult: (r, pid) => this.saveProfileResult(r, pid),
            finishRun: (r) => this.finishRun(r),
          },
        ).catch((error: unknown) =>
          devDiag.emit('ERROR', 'GROUP_INVITER', 'GROUP_INVITER_RUN_ERROR', {
            reason: errMsg(error, 'UNKNOWN').slice(0, 200),
          }),
        );
        if (pendingLaunchSet.size > 0) {
          await Promise.resolve();
          await Promise.resolve();
        }
      } finally {
        for (const id of reservedIds) this.rt.admittingProfiles.delete(id);
        this.featureExecution?.releaseReservation('group-inviter', reservedIds);
        if (admittedBatch && this.rt.startingProfiles === admittedBatch) {
          this.rt.startingProfiles.clear();
          this.rt.startingCancelled.clear();
        }
      }
    });
  private async fetchMissingAvatars(selectedIds?: readonly string[]): Promise<void> {
    const refreshFn = this.refreshAvatars;
    if (!refreshFn) {
      if (selectedIds !== undefined) this.avatarRefreshStatusText = '当前未启用小组资料刷新服务';
      return;
    }
    if (this.hasActiveExecution())
      return void (this.avatarRefreshStatusText =
        '运行中暂不刷新头像，停止任务后可点击「刷新头像」补齐');
    const allGroups = await this.repo.listGroups();
    const idSet = selectedIds?.length ? new Set(selectedIds) : null;
    const missing = allGroups.filter(
      (g) =>
        (idSet
          ? idSet.has(g.groupId)
          : isTargetIncomplete({ id: g.groupId, name: g.groupName, avatarUrl: g.avatarUrl })) &&
        !this.avatarFetching.has(g.groupId),
    );
    if (!missing.length) {
      if (idSet) this.avatarRefreshStatusText = '未找到需要刷新的小组';
      return;
    }
    this.avatarRefreshStatusText = `正在刷新 ${missing.length} 个小组资料…`;
    for (const g of missing) this.avatarFetching.add(g.groupId);
    const targets: BumperTarget[] = missing.map((g) => ({
      id: g.groupId,
      name: g.groupName,
      avatarUrl: g.avatarUrl,
      folderId: g.folderId ?? null,
      sortOrder: g.sortOrder ?? 0,
      totalBumpedCount: g.totalInvitedCount ?? 0,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
    }));
    await runTargetAvatarRefresh({
      targets,
      refresh: (signal) => refreshFn(targets, { signal }),
      getAbort: () => this.avatarRefreshAbort,
      setAbort: (ctrl) => void (this.avatarRefreshAbort = ctrl),
      setRefreshing: (active) => void (this.groupAvatarRefreshing = active),
      waitMs: 1000 * 60 * 10,
      onResult: (res, aborted) =>
        void (this.avatarRefreshStatusText = aborted
          ? '已停止刷新小组头像'
          : formatAvatarRefreshSummary(res, '项', '刷新小组头像完成')),
      onError: (_err, aborted) =>
        void (this.avatarRefreshStatusText = aborted
          ? '已停止刷新小组头像'
          : '刷新小组头像失败，请稍后重试'),
      onFinally: () => {
        for (const g of missing) this.avatarFetching.delete(g.groupId);
      },
    });
  }
  refreshGroups = (ids?: readonly string[]) =>
    this.runAndState(() => Promise.race([this.fetchMissingAvatars(ids), sleepMs(20)]));
  stopRefreshGroups = () =>
    this.runAndState(() => {
      this.avatarRefreshAbort?.abort(new Error('FACEBOOK_METADATA_BATCH_ABORTED'));
      this.avatarRefreshAbort = null;
      this.stopAvatarRefresh?.();
      this.groupAvatarRefreshing = false;
      this.avatarFetching.clear();
      this.avatarRefreshStatusText = '已停止刷新小组头像';
    });
  runScheduledProfileStep = (input: Parameters<typeof runScheduledInviterProfileStep>[1]) =>
    runScheduledInviterProfileStep(this.rt, input);
}
