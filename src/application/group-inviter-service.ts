import type { Awaitable } from '../domain/persistence.js';
import { ProductError } from '../domain/workspace.js';
import {
  GroupInviterState,
  StartGroupInviterRequest,
  StopGroupInviterProfilesRequest,
  type InviterGroupRow,
  type GroupInviterProfileStat,
  type GroupInviteLogRow,
} from '../shared/group-inviter.js';
import { devDiag } from '../shared/dev-diagnostics.js';
import type { ProfileTaskResultValue } from '../shared/task-contracts.js';

export interface GroupInviterRepository {
  hasInvitesForOperation?(
    operationId: string,
    profileId?: string,
    accountId?: string,
  ): Awaitable<boolean>;
  reserveInvites?(
    operationId: string,
    entries: ReadonlyArray<{
      profileId: string;
      accountId: string;
      friendId: string;
      friendName: string;
      groupId: string;
    }>,
  ): Awaitable<void>;
  saveProfileResult?(result: ProfileTaskResultValue): Awaitable<void>;
  listGroups(): Awaitable<InviterGroupRow[]>;
  upsertGroups(input: unknown): Awaitable<InviterGroupRow[]>;
  updateGroupAvatar(groupId: string, avatarUrl: string): Awaitable<void>;
  deleteGroups(input: unknown): Awaitable<number>;
  getInvitesPerGroup(): Awaitable<number>;
  setInvitesPerGroup(input: unknown): Awaitable<number>;
  getInvitedFriendIdsForGroup(groupId: string): Awaitable<Set<string>>;
  recordInvites(
    entries: ReadonlyArray<{
      profileId: string;
      accountId: string;
      friendId: string;
      friendName: string;
      groupId: string;
      invitedAt?: number;
    }>,
    operationId?: string,
  ): Awaitable<number>;
  getTotalInvitedByProfile(): Awaitable<Map<string, number>>;
  listLogs(filter?: {
    groupId?: string;
    profileId?: string;
    accountId?: string;
  }): Awaitable<GroupInviteLogRow[]>;
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
  fetchGroupAvatar(group: InviterGroupRow, allowIdleBrowser: boolean): Promise<string | null>;
  inviteForGroup(
    profileId: string,
    group: InviterGroupRow,
    invitesPerGroup: number,
    callbacks: GroupInviterRunCallbacks,
  ): Promise<void>;
}

interface ActiveRunState {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  cancelled: boolean;
  cancelledProfiles: Set<string>;
  activeProfiles: Set<string>;
  statusText: string;
  sessionCounts: Map<string, number>;
  profileStatus: Map<string, string>;
  submittedProfiles: Map<string, number>;
  failedProfiles: Set<string>;
  unconfirmedStops: Set<string>;
  workersFinished: boolean;
}

const randInt = (min: number, max: number) => Math.floor(min + Math.random() * (max - min + 1));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function shuffleArray<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const itemI = copy[i];
    const itemJ = copy[j];
    if (itemI !== undefined && itemJ !== undefined) {
      copy[i] = itemJ;
      copy[j] = itemI;
    }
  }
  return copy;
}

export function buildStaggeredGroupQueues(
  profileIds: readonly string[],
  groups: readonly InviterGroupRow[],
): Map<string, InviterGroupRow[]> {
  const base = shuffleArray(groups);
  const result = new Map<string, InviterGroupRow[]>();
  const m = Math.max(1, profileIds.length);
  const k = base.length;
  profileIds.forEach((profileId, idx) => {
    if (k <= 1) {
      result.set(profileId, [...base]);
      return;
    }
    const offset = Math.floor((idx * k) / m) % k;
    const rotated = [...base.slice(offset), ...base.slice(0, offset)];
    const first = rotated[0];
    const rest = shuffleArray(rotated.slice(1));
    result.set(profileId, first !== undefined ? [first, ...rest] : rest);
  });
  return result;
}

export class GroupInviterService {
  private activeRun: ActiveRunState | null = null;
  private startingProfiles = new Set<string>();
  private startingCancelled = new Set<string>();
  private startGeneration = 0;
  private lastRun: ActiveRunState | null = null;
  private avatarFetching = new Set<string>();

  constructor(
    private readonly repo: GroupInviterRepository,
    private readonly runner?: GroupInviterBrowserRunner,
    private readonly assertStartAllowed: () => void = () => {},
  ) {}

  hasActiveExecution(): boolean {
    return this.activeRun !== null || this.startingProfiles.size > 0;
  }
  async state(): Promise<GroupInviterState> {
    const groups = await this.repo.listGroups();
    const invitesPerGroup = await this.repo.getInvitesPerGroup();
    const totalsByProfile = await this.repo.getTotalInvitedByProfile();
    const run = this.activeRun ?? this.lastRun;
    const profileCounts: Record<string, GroupInviterProfileStat> = {};

    const allProfileIds = new Set<string>([
      ...totalsByProfile.keys(),
      ...(run ? run.sessionCounts.keys() : []),
      ...(run ? run.profileStatus.keys() : []),
      ...this.startingProfiles,
    ]);

    for (const pid of allProfileIds) {
      const status = this.startingProfiles.has(pid)
        ? this.startingCancelled.has(pid)
          ? '正在停止…'
          : '正在准备…'
        : run?.profileStatus.get(pid);
      profileCounts[pid] = {
        sessionInvited: run?.sessionCounts.get(pid) ?? 0,
        totalInvited: totalsByProfile.get(pid) ?? 0,
        ...(status ? { status } : {}),
      };
    }

    return GroupInviterState.parse({
      groups,
      invitesPerGroup,
      running: this.activeRun !== null || this.startingProfiles.size > 0,
      runId: run?.id ?? null,
      startedAt: run?.startedAt ?? null,
      finishedAt: this.activeRun ? null : (this.lastRun?.finishedAt ?? null),
      statusText: this.startingProfiles.size ? '正在准备…' : (run?.statusText ?? '就绪'),
      profileCounts,
    });
  }

  async addGroups(input: unknown): Promise<GroupInviterState> {
    await this.repo.upsertGroups(input);
    void this.fetchMissingAvatars();
    return await this.state();
  }

  async deleteGroups(input: unknown): Promise<GroupInviterState> {
    await this.repo.deleteGroups(input);
    return await this.state();
  }

  async updateSettings(input: unknown): Promise<GroupInviterState> {
    await this.repo.setInvitesPerGroup(input);
    return await this.state();
  }

  isProfileRunning(profileId: string): boolean {
    const run = this.activeRun;
    return this.startingProfiles.has(profileId) || run?.activeProfiles.has(profileId) === true;
  }

  async stop(): Promise<GroupInviterState> {
    this.startGeneration++;
    for (const id of this.startingProfiles) this.startingCancelled.add(id);
    if (this.activeRun) {
      this.activeRun.cancelled = true;
      for (const pid of this.activeRun.activeProfiles) {
        this.activeRun.cancelledProfiles.add(pid);
        this.activeRun.profileStatus.set(pid, '正在停止…');
      }
      this.activeRun.statusText = '正在停止…';
      devDiag.record({
        level: 'INFO',
        category: 'GROUP_INVITER',
        event: 'GROUP_INVITER_STOP_ALL',
        data: { runId: this.activeRun.id, profiles: [...this.activeRun.activeProfiles] },
      });
      await this.retryUnconfirmedStops(this.activeRun, [...this.activeRun.unconfirmedStops]);
    }
    return await this.state();
  }

  async stopProfiles(input: unknown): Promise<GroupInviterState> {
    const { profileIds } = StopGroupInviterProfilesRequest.parse(input);
    for (const id of profileIds) if (this.startingProfiles.has(id)) this.startingCancelled.add(id);
    const run = this.activeRun;
    if (run) {
      for (const pid of profileIds) {
        if (run.activeProfiles.has(pid)) {
          run.cancelledProfiles.add(pid);
          run.profileStatus.set(pid, '正在停止…');
          devDiag.record({
            level: 'INFO',
            category: 'GROUP_INVITER',
            event: 'GROUP_INVITER_STOP_PROFILE',
            profileId: pid,
            data: { runId: run.id },
          });
        }
      }
      if (run.activeProfiles.size === 0) {
        run.cancelled = true;
        run.statusText = '正在停止…';
      }
      await this.retryUnconfirmedStops(run, profileIds);
    }
    return await this.state();
  }

  async start(input: unknown): Promise<GroupInviterState> {
    const req = StartGroupInviterRequest.parse(input);
    this.assertStartAllowed();
    if (this.activeRun || this.startingProfiles.size) {
      throw new ProductError(
        'GROUP_INVITER_ALREADY_RUNNING',
        '小组邀请人正在运行中，请等待完成或先点击停止',
        409,
      );
    }
    const generation = this.startGeneration;
    this.startingProfiles = new Set(req.profileIds);
    const starting = this.startingProfiles;
    this.startingCancelled.clear();
    try {
      if (req.invitesPerGroup !== undefined) {
        await this.repo.setInvitesPerGroup({ invitesPerGroup: req.invitesPerGroup });
      }
      const invitesPerGroup = await this.repo.getInvitesPerGroup();
      const allGroups = new Map((await this.repo.listGroups()).map((g) => [g.groupId, g]));
      const selectedGroups = req.groupIds
        .map((id) => allGroups.get(id))
        .filter((g): g is InviterGroupRow => g !== undefined);
      if (selectedGroups.length === 0) {
        throw new ProductError('GROUP_INVITER_GROUPS_EMPTY', '未找到选中的小组，请刷新后重试', 404);
      }

      const uniqueProfiles = [...new Set(req.profileIds)];
      const profileStatus = new Map<string, string>();
      const eligibleProfiles: string[] = [];
      let skippedBusy = 0;
      let skippedOffline = 0;

      for (const id of uniqueProfiles) {
        if (generation !== this.startGeneration || this.startingCancelled.has(id)) {
          profileStatus.set(id, '已停止');
          continue;
        }
        if (await this.runner?.isProfileBusy?.(id)) {
          profileStatus.set(id, '跳过：正在执行其他任务');
          skippedBusy++;
        } else if (this.runner && !this.runner.isProfileReady(id)) {
          profileStatus.set(id, '跳过：浏览器未连接');
          skippedOffline++;
        } else {
          profileStatus.set(id, '准备中');
          eligibleProfiles.push(id);
        }
      }

      if (eligibleProfiles.length === 0) {
        throw new ProductError(
          'GROUP_INVITER_PROFILES_UNAVAILABLE',
          skippedBusy > 0 && skippedOffline > 0
            ? `所选浏览器中 ${skippedBusy} 个正在执行其他任务、${skippedOffline} 个未连接，无法启动`
            : skippedBusy > 0
              ? '所选浏览器正在执行其他任务，请先停止原任务或选择空闲浏览器'
              : '所选浏览器未连接，请先打开对应浏览器',
          409,
        );
      }

      for (let i = eligibleProfiles.length - 1; i >= 0; i--) {
        const id = eligibleProfiles[i];
        if (id && this.startingCancelled.has(id)) eligibleProfiles.splice(i, 1);
      }
      if (generation !== this.startGeneration || !eligibleProfiles.length)
        throw new ProductError('GROUP_INVITER_START_CANCELLED', '启动已取消，没有派发邀请', 409);
      const skippedNotes = [
        skippedBusy > 0 ? `跳过 ${skippedBusy} 个运行中` : '',
        skippedOffline > 0 ? `跳过 ${skippedOffline} 个未连接` : '',
      ].filter(Boolean);
      const run: ActiveRunState = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        startedAt: Date.now(),
        finishedAt: null,
        cancelled: false,
        cancelledProfiles: new Set<string>(),
        activeProfiles: new Set<string>(eligibleProfiles),
        statusText:
          `正在运行：${eligibleProfiles.length} 个账号 × ${selectedGroups.length} 个小组（每组最多 ${invitesPerGroup} 人）` +
          (skippedNotes.length ? `（已自动${skippedNotes.join('、')}）` : ''),
        sessionCounts: new Map(uniqueProfiles.map((id) => [id, 0])),
        submittedProfiles: new Map(),
        profileStatus,
        failedProfiles: new Set<string>(),
        unconfirmedStops: new Set<string>(),
        workersFinished: false,
      };
      this.assertStartAllowed();
      this.activeRun = run;
      devDiag.record({
        level: 'INFO',
        category: 'GROUP_INVITER',
        event: 'GROUP_INVITER_START',
        data: {
          runId: run.id,
          eligibleProfiles,
          skippedBusy,
          skippedOffline,
          groupCount: selectedGroups.length,
          invitesPerGroup,
        },
      });

      this.startingProfiles.clear();
      void this.executeRun(run, eligibleProfiles, selectedGroups, invitesPerGroup).catch(
        (error: unknown) => {
          devDiag.record({
            level: 'ERROR',
            category: 'GROUP_INVITER',
            event: 'GROUP_INVITER_RUN_ERROR',
            reason: error instanceof Error ? error.message.slice(0, 200) : 'UNKNOWN',
          });
        },
      );
      return await this.state();
    } finally {
      if (this.startingProfiles === starting) {
        this.startingProfiles.clear();
        this.startingCancelled.clear();
      }
    }
  }

  private finishRun(run: ActiveRunState) {
    if (!run.workersFinished || run.activeProfiles.size) return;
    run.finishedAt = Date.now();
    this.lastRun = run;
    if (this.activeRun === run) this.activeRun = null;
  }

  private async saveResult(run: ActiveRunState, profileId: string) {
    await this.repo.saveProfileResult?.({
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

  private async retryUnconfirmedStops(run: ActiveRunState, ids: readonly string[]) {
    for (const id of ids) {
      if (!run.unconfirmedStops.has(id) || !this.runner?.retryStop) continue;
      try {
        await this.runner.retryStop(id);
        run.unconfirmedStops.delete(id);
        run.activeProfiles.delete(id);
        run.profileStatus.set(id, '已停止（原邀请结果仍待核对）');
        await this.saveResult(run, id);
      } catch {
        run.profileStatus.set(id, '停止未确认，请保持浏览器在线后重试停止');
      }
    }
    this.finishRun(run);
  }

  private async fetchMissingAvatars(): Promise<void> {
    if (!this.runner) return;
    const missing = (await this.repo.listGroups()).filter(
      (g) => !g.avatarUrl && !this.avatarFetching.has(g.groupId),
    );
    if (missing.length === 0) return;

    for (const group of missing) {
      this.avatarFetching.add(group.groupId);
      try {
        const avatar = await this.runner.fetchGroupAvatar(group, this.activeRun === null);
        if (avatar) {
          await this.repo.updateGroupAvatar(group.groupId, avatar);
        }
      } catch {
        // Ignore background avatar errors; avatar will also be captured during actual run
      } finally {
        this.avatarFetching.delete(group.groupId);
      }
    }
  }

  private async executeRun(
    run: ActiveRunState,
    profileIds: readonly string[],
    groups: readonly InviterGroupRow[],
    invitesPerGroup: number,
  ): Promise<void> {
    try {
      if (!this.runner || !this.runner.isAvailable()) {
        run.statusText = '运行失败：浏览器内核桥接未就绪';
        for (const id of profileIds) {
          run.failedProfiles.add(id);
          run.profileStatus.set(id, run.statusText);
          await this.saveResult(run, id);
        }
        run.activeProfiles.clear();
        return;
      }
      const runner = this.runner;
      const queues = buildStaggeredGroupQueues(profileIds, groups);
      const isProfileCancelled = (profileId?: string) =>
        run.cancelled || (profileId ? run.cancelledProfiles.has(profileId) : false);

      const callbacks: GroupInviterRunCallbacks = {
        reportBatchResult: (profileId, _confirmed, pending) => {
          run.submittedProfiles.set(
            profileId,
            (run.submittedProfiles.get(profileId) ?? 0) + pending,
          );
        },
        isCancelled: (profileId?: string) => isProfileCancelled(profileId),
        setProfileStatus: (profileId, status) => {
          if (!isProfileCancelled(profileId)) {
            run.profileStatus.set(profileId, status);
          }
        },
        addSessionInvited: (profileId, count) => {
          run.sessionCounts.set(profileId, (run.sessionCounts.get(profileId) ?? 0) + count);
        },
      };

      const runWorkerForProfile = async (profileId: string, startupDelay: number) => {
        try {
          if (startupDelay > 0) {
            await sleep(startupDelay);
          }
          if (isProfileCancelled(profileId)) {
            run.profileStatus.set(profileId, '已停止');
            return;
          }
          if (await runner.isProfileBusy?.(profileId)) {
            run.profileStatus.set(profileId, '跳过：正在执行其他任务');
            run.failedProfiles.add(profileId);
            return;
          }
          if (!runner.isProfileReady(profileId)) {
            run.profileStatus.set(profileId, '离线或未就绪');
            run.failedProfiles.add(profileId);
            return;
          }

          const pending = [...(queues.get(profileId) ?? [])];
          while (pending.length > 0 && !isProfileCancelled(profileId)) {
            if (await runner.isProfileBusy?.(profileId)) {
              run.profileStatus.set(profileId, '已让出：主任务已启动');
              run.failedProfiles.add(profileId);
              return;
            }
            const group = pending.shift();
            if (!group) break;

            const groupStartAt = Date.now();
            try {
              await runner.inviteForGroup(profileId, group, invitesPerGroup, callbacks);
              devDiag.record({
                level: 'INFO',
                category: 'GROUP_INVITER',
                event: 'GROUP_INVITER_GROUP_DONE',
                profileId,
                durationMs: Date.now() - groupStartAt,
                data: {
                  runId: run.id,
                  groupId: group.groupId,
                  status: run.profileStatus.get(profileId) ?? '',
                  sessionInvited: run.sessionCounts.get(profileId) ?? 0,
                },
              });
            } catch (err) {
              run.failedProfiles.add(profileId);
              if (err instanceof Error && err.message === 'GROUP_INVITER_STOP_UNCONFIRMED') {
                run.unconfirmedStops.add(profileId);
                run.profileStatus.set(profileId, '停止未确认，请保持浏览器在线后重试停止');
                return;
              }
              const raw = err instanceof Error ? err.message : '异常';
              const explanation: Record<string, string> = {
                WINDOW_LAYOUT_TARGET_CHANGED: '任务标签已变化，请重新打开 Facebook 任务页',
                WINDOW_LAYOUT_MAIN_CHANGED: '任务主页已变化，请重新连接该浏览器',
                WINDOW_LAYOUT_DOCUMENT_SCOPE_CHANGED: '任务页不在 Facebook，请检查当前页面',
                WINDOW_LAYOUT_DOCUMENT_TIMEOUT: 'Facebook 页面加载超时，请检查网络',
                FACEBOOK_TASK_DOCUMENT_TIMEOUT: 'Facebook 页面加载超时，请检查网络',
                FACEBOOK_TASK_DOCUMENT_SCOPE_CHANGED:
                  'Facebook 页面已跳转，请检查是否需要登录或验证',
                GROUP_INVITER_CURRENT_ACCOUNT_OR_VISIBILITY_CHANGED:
                  '账号或页面可见状态发生变化，已停止本次邀请',
                GROUP_INVITER_CONNECTION_CHANGED: '浏览器连接已变化，请确认扩展在线',
              };
              const msg = (
                explanation[raw] ??
                raw.replace(/^GROUP_INVITER_NAVIGATION_FAILED:/, '打开小组失败：')
              ).slice(0, 100);
              run.profileStatus.set(
                profileId,
                err instanceof ProductError && err.code === 'GROUP_INVITER_VERIFICATION_REQUIRED'
                  ? '受限 · 需要手机验证或操作受限'
                  : `执行失败 · ${msg}`,
              );
              devDiag.record({
                level: 'ERROR',
                category: 'GROUP_INVITER',
                event: 'GROUP_INVITER_GROUP_ERROR',
                profileId,
                durationMs: Date.now() - groupStartAt,
                reason: raw.slice(0, 200),
                data: { runId: run.id, groupId: group.groupId, groupName: group.groupName },
              });
              // Do not continue input after an unverified action/commit.
              break;
            }

            if (pending.length > 0 && !isProfileCancelled(profileId)) {
              await sleep(randInt(2200, 4500));
            }
          }

          if (isProfileCancelled(profileId)) {
            run.profileStatus.set(profileId, '已停止');
          } else if (!run.failedProfiles.has(profileId)) {
            const confirmed = run.sessionCounts.get(profileId) ?? 0,
              pending = run.submittedProfiles.get(profileId) ?? 0;
            run.profileStatus.set(
              profileId,
              run.submittedProfiles.has(profileId)
                ? pending > 0
                  ? confirmed > 0
                    ? `已确认 ${confirmed} 人 · ${pending} 人待核对`
                    : `邀请已提交 · ${pending} 人待核对`
                  : `已确认 ${confirmed} 人`
                : run.profileStatus.get(profileId) === '无可邀请对象'
                  ? '无可邀请对象'
                  : '已完成',
            );
          }
        } catch (error) {
          run.failedProfiles.add(profileId);
          run.profileStatus.set(
            profileId,
            error instanceof Error ? error.message.slice(0, 100) : '执行失败',
          );
        } finally {
          if (!run.unconfirmedStops.has(profileId)) {
            // Keep occupancy through durable result save as well as native drain.
            try {
              await this.saveResult(run, profileId);
            } catch {
              run.profileStatus.set(profileId, '任务已结束，但结果保存失败');
            }
            run.activeProfiles.delete(profileId);
          }
        }
      };

      let startupDelay = 0;
      await Promise.all(
        profileIds.map((pid, index) => {
          if (index > 0) startupDelay += randInt(800, 1500);
          return runWorkerForProfile(pid, startupDelay);
        }),
      );

      const totalSession = [...run.sessionCounts.values()].reduce((a, b) => a + b, 0);
      run.statusText = run.cancelled
        ? `已停止 · 本次共邀请 ${totalSession} 位好友`
        : `${run.failedProfiles.size ? '运行结束（存在失败，请查看账号状态）' : [...run.submittedProfiles.values()].some((n) => n > 0) ? '运行结束（存在待核对，请查看账号状态）' : '运行完成'} · 本次共邀请 ${totalSession} 位好友`;
      if (run.unconfirmedStops.size) run.statusText = '停止未确认，仍保留浏览器占用；请重试停止';
      devDiag.record({
        level: 'INFO',
        category: 'GROUP_INVITER',
        event: 'GROUP_INVITER_FINISH',
        durationMs: Date.now() - run.startedAt,
        data: { runId: run.id, cancelled: run.cancelled, totalSession },
      });
    } finally {
      run.workersFinished = true;
      this.finishRun(run);
    }
  }
}
