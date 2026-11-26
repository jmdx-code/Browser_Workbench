import { ProductError } from '../../domain/workspace.js';
import { devDiag } from '../../shared/dev-diagnostics.js';
import type { InviterGroupRow } from '../../shared/group-inviter.js';
import type {
  ActiveRunState,
  GroupInviterBrowserRunner,
  GroupInviterRunCallbacks,
  InviterRuntimeState,
} from '../group-inviter-service.js';
import {
  HARD_BLOCK_MSG_RE,
  acquireConcurrencySlot,
  buildStaggeredQueues,
  ensureBrowserProfileOnline,
  errMsg,
  launchOfflineProfileInSlot,
  persistProfileTaskResult,
  randIntInRange,
  runTrackedScheduledWorker,
} from '../module-worker-pool.js';
import { isWorkAbortError, sleepAbortable } from '../workboard.js';

const INVITER_ERROR_EXPLANATIONS: Record<string, string> = {
  WINDOW_LAYOUT_TARGET_CHANGED: '任务标签已变化，请重新打开 Facebook 任务页',
  WINDOW_LAYOUT_MAIN_CHANGED: '任务主页已变化，请重新连接该浏览器',
  WINDOW_LAYOUT_DOCUMENT_SCOPE_CHANGED: '任务页不在 Facebook，请检查当前页面',
  WINDOW_LAYOUT_DOCUMENT_TIMEOUT: 'Facebook 页面加载超时，请检查网络',
  FACEBOOK_TASK_DOCUMENT_TIMEOUT: 'Facebook 页面加载超时，请检查网络',
  FACEBOOK_TASK_DOCUMENT_SCOPE_CHANGED: 'Facebook 页面已跳转，请检查是否需要登录或验证',
  GROUP_INVITER_CURRENT_ACCOUNT_OR_VISIBILITY_CHANGED: '账号或页面可见状态发生变化，已停止本次邀请',
  GROUP_INVITER_CONNECTION_CHANGED: '浏览器连接已变化，请确认扩展在线',
};

const isSkippableInviterGroupError = (err: unknown) =>
  (err instanceof ProductError &&
    [
      'GROUP_INVITER_GROUP_UNINVITABLE',
      'GROUP_INVITER_GROUP_NOT_READY',
      'GROUP_INVITER_GROUP_CHANGED',
    ].includes(err.code)) ||
  (err instanceof Error && err.message === 'GROUP_INVITER_CURRENT_GROUP_CHANGED');

const formatInviterCompletion = (
  confirmed: number,
  pending: number,
  lastStatus?: string,
): string =>
  pending > 0
    ? confirmed > 0
      ? `已确认 ${confirmed} 人 · ${pending} 人待核对`
      : `邀请已提交 · ${pending} 人待核对`
    : confirmed > 0
      ? `已确认 ${confirmed} 人`
      : lastStatus === '无可邀请对象'
        ? '无可邀请对象'
        : '已完成';

function classifyInviterGroupFailure(err: unknown) {
  const isVerif = err instanceof ProductError && err.code === 'GROUP_INVITER_VERIFICATION_REQUIRED';
  const raw = errMsg(err, '邀请异常');
  const explained = (
    INVITER_ERROR_EXPLANATIONS[raw] ??
    raw.replace(/^GROUP_INVITER_NAVIGATION_FAILED:/, '打开小组失败：')
  ).slice(0, 100);
  const hard =
    isVerif ||
    HARD_BLOCK_MSG_RE.test(raw) ||
    /GROUP_INVITER_CURRENT_ACCOUNT_OR_VISIBILITY_CHANGED|GROUP_INVITER_CONNECTION_CHANGED/i.test(
      raw,
    );
  return { raw, display: isVerif ? '受限 · 需要手机验证或操作受限' : explained, hard };
}

async function runInviterGroupLoop(
  runner: GroupInviterBrowserRunner,
  profileId: string,
  pending: InviterGroupRow[],
  invitesPerGroup: number,
  callbacks: GroupInviterRunCallbacks,
  signal: AbortSignal,
  stopped: () => boolean,
  hooks: {
    checkBeforeGroup?: () => Promise<boolean>;
    onGroupDone?: (group: InviterGroupRow, startedAt: number) => void;
    onGroupSkipped?: (group: InviterGroupRow, skipMsg: string, err: unknown) => void;
    onGroupError: (group: InviterGroupRow, err: unknown, startedAt: number) => 'return' | 'break';
  },
): Promise<boolean> {
  while (pending.length && !stopped()) {
    if (hooks.checkBeforeGroup && !(await hooks.checkBeforeGroup())) return true;
    const group = pending.shift();
    if (!group) break;
    const startedAt = Date.now();
    try {
      await runner.inviteForGroup(profileId, group, invitesPerGroup, callbacks);
      hooks.onGroupDone?.(group, startedAt);
    } catch (err) {
      if (isSkippableInviterGroupError(err)) {
        const msg =
          err instanceof ProductError
            ? err.message
            : `跳过：小组页面已跳转或无法直接加入 · ${group.groupName.slice(0, 10)}`;
        hooks.onGroupSkipped?.(group, msg, err);
        if (pending.length) await sleepAbortable(1000, signal);
        continue;
      }
      if (hooks.onGroupError(group, err, startedAt) === 'return') return true;
      break;
    }
    if (pending.length && !stopped()) await sleepAbortable(randIntInRange(2200, 4500), signal);
  }
  return false;
}

const diagInviter = (
  level: 'INFO' | 'ERROR',
  event: string,
  extra: {
    profileId?: string;
    durationMs?: number;
    reason?: string;
    data?: Record<string, unknown>;
  },
) => devDiag.record({ level, category: 'GROUP_INVITER', event, ...extra });

export async function executeInviterRun(
  ctx: InviterRuntimeState,
  run: ActiveRunState,
  profileIds: readonly string[],
  groups: readonly InviterGroupRow[],
  invitesPerGroup: number,
  maxConcurrentProfiles: number,
  pendingLaunchSet: ReadonlySet<string>,
  hooks: {
    saveResult: (run: ActiveRunState, profileId: string) => Promise<void>;
    finishRun: (run: ActiveRunState) => void;
  },
): Promise<void> {
  try {
    if (!ctx.runner || !ctx.runner.isAvailable()) {
      run.statusText = '运行失败：浏览器内核桥接未就绪';
      for (const id of profileIds) {
        run.failedProfiles.add(id);
        run.profileStatus.set(id, run.statusText);
        await hooks.saveResult(run, id);
        run.activeProfiles.delete(id);
      }
      return;
    }
    const runner = ctx.runner;
    const queues = buildStaggeredQueues(profileIds, groups);
    const isProfileCancelled = (pid?: string) =>
      run.cancelled || (pid ? run.cancelledProfiles.has(pid) : false);
    const abortedProfiles = new Set<string>();
    const callbacks: GroupInviterRunCallbacks = {
      reportBatchResult: (pid, _c, pending) =>
        void run.submittedProfiles.set(pid, (run.submittedProfiles.get(pid) ?? 0) + pending),
      isCancelled: (pid?: string) =>
        isProfileCancelled(pid) || (pid ? abortedProfiles.has(pid) : false),
      setProfileStatus: (pid, status) => {
        if (!isProfileCancelled(pid) && !abortedProfiles.has(pid))
          run.profileStatus.set(pid, status);
      },
      addSessionInvited: (pid, count) =>
        void run.sessionCounts.set(pid, (run.sessionCounts.get(pid) ?? 0) + count),
    };

    ctx.maxConcurrentProfiles = Math.max(1, maxConcurrentProfiles);
    const runWorkerForProfile = (profileId: string, startupDelay: number) =>
      ctx.workboard.runSoldier(
        { carrierId: profileId, carrierKind: 'browser', moduleId: 'group-inviter' },
        async (soldier) => {
          const stopped = () => isProfileCancelled(profileId) || soldier.signal.aborted;
          const onAbort = () => abortedProfiles.add(profileId);
          if (soldier.signal.aborted) abortedProfiles.add(profileId);
          else soldier.signal.addEventListener('abort', onAbort, { once: true });
          let slotAcquired = false;
          try {
            if (pendingLaunchSet.has(profileId) && ctx.profileLifecycle) {
              run.profileStatus.set(profileId, '正在启动浏览器…');
              const launched = await launchOfflineProfileInSlot(
                profileId,
                ctx.profileLifecycle,
                ctx.workboard,
                soldier.signal,
                (id) => runner.isProfileReady(id),
              );
              if (!launched.ok) {
                run.profileStatus.set(profileId, launched.reason);
                run.failedProfiles.add(profileId);
                return;
              }
              if (!stopped()) run.profileStatus.set(profileId, '准备中');
            }
            slotAcquired = await acquireConcurrencySlot({
              isFull: () => ctx.slotsInUse >= Math.max(1, ctx.maxConcurrentProfiles),
              isAborted: stopped,
              onQueued: () => void run.profileStatus.set(profileId, '排队等待并发槽位…'),
              waitStep: () => sleepAbortable(50, soldier.signal),
              acquire: () => void ctx.slotsInUse++,
            });
            if (!slotAcquired || stopped()) return void run.profileStatus.set(profileId, '已停止');
            if (startupDelay > 0) await sleepAbortable(startupDelay, soldier.signal);
            if (stopped()) return void run.profileStatus.set(profileId, '已停止');
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
            const returnedEarly = await runInviterGroupLoop(
              runner,
              profileId,
              [...(queues.get(profileId) ?? [])],
              invitesPerGroup,
              callbacks,
              soldier.signal,
              stopped,
              {
                checkBeforeGroup: async () => {
                  if (await runner.isProfileBusy?.(profileId)) {
                    run.profileStatus.set(profileId, '已让出：主任务已启动');
                    run.failedProfiles.add(profileId);
                    return false;
                  }
                  return true;
                },
                onGroupDone: (group, startAt) =>
                  diagInviter('INFO', 'GROUP_INVITER_GROUP_DONE', {
                    profileId,
                    durationMs: Date.now() - startAt,
                    data: {
                      runId: run.id,
                      groupId: group.groupId,
                      status: run.profileStatus.get(profileId) ?? '',
                      sessionInvited: run.sessionCounts.get(profileId) ?? 0,
                    },
                  }),
                onGroupSkipped: (group, skipMsg, err) => {
                  run.profileStatus.set(profileId, skipMsg);
                  diagInviter('INFO', 'GROUP_INVITER_GROUP_SKIPPED', {
                    profileId,
                    reason: err instanceof ProductError ? err.code : 'GROUP_INVITER_GROUP_CHANGED',
                    data: { runId: run.id, groupId: group.groupId },
                  });
                },
                onGroupError: (group, err, startAt) => {
                  run.failedProfiles.add(profileId);
                  if (err instanceof Error && err.message === 'GROUP_INVITER_STOP_UNCONFIRMED') {
                    run.unconfirmedStops.add(profileId);
                    run.profileStatus.set(profileId, '停止未确认，请保持浏览器在线后重试停止');
                    return 'return';
                  }
                  const { raw, display } = classifyInviterGroupFailure(err);
                  run.profileStatus.set(
                    profileId,
                    display.startsWith('受限') ? display : `执行失败 · ${display}`,
                  );
                  diagInviter('ERROR', 'GROUP_INVITER_GROUP_ERROR', {
                    profileId,
                    durationMs: Date.now() - startAt,
                    reason: raw.slice(0, 200),
                    data: { runId: run.id, groupId: group.groupId, groupName: group.groupName },
                  });
                  return 'break';
                },
              },
            );
            if (returnedEarly) return;
            if (stopped()) run.profileStatus.set(profileId, '已停止');
            else if (!run.failedProfiles.has(profileId)) {
              run.profileStatus.set(
                profileId,
                formatInviterCompletion(
                  run.sessionCounts.get(profileId) ?? 0,
                  run.submittedProfiles.get(profileId) ?? 0,
                  run.profileStatus.get(profileId),
                ),
              );
            }
          } catch (error) {
            if (stopped() || isWorkAbortError(error)) run.profileStatus.set(profileId, '已停止');
            else {
              run.failedProfiles.add(profileId);
              run.profileStatus.set(profileId, errMsg(error, '执行失败').slice(0, 100));
            }
          } finally {
            soldier.signal.removeEventListener('abort', onAbort);
            if (slotAcquired) ctx.slotsInUse = Math.max(0, ctx.slotsInUse - 1);
            if (!run.unconfirmedStops.has(profileId)) {
              await hooks
                .saveResult(run, profileId)
                .catch(() => void run.profileStatus.set(profileId, '任务已结束，但结果保存失败'));
              run.activeProfiles.delete(profileId);
            }
          }
        },
      );

    let startupDelay = 0;
    await Promise.all(
      profileIds.map((pid, index) => {
        if (index > 0) startupDelay += randIntInRange(800, 1500);
        return runTrackedScheduledWorker(
          ctx.workerPromises,
          pid,
          runWorkerForProfile(pid, startupDelay),
        );
      }),
    );
    if (!run.activeProfiles.size) {
      const totalSession = [...run.sessionCounts.values()].reduce((a, b) => a + b, 0);
      run.statusText = run.unconfirmedStops.size
        ? '停止未确认，仍保留浏览器占用；请重试停止'
        : run.cancelled
          ? `已停止 · 本次共邀请 ${totalSession} 位好友`
          : `${run.failedProfiles.size ? '运行结束（存在失败，请查看账号状态）' : [...run.submittedProfiles.values()].some((n) => n > 0) ? '运行结束（存在待核对，请查看账号状态）' : '运行完成'} · 本次共邀请 ${totalSession} 位好友`;
      diagInviter('INFO', 'GROUP_INVITER_FINISH', {
        durationMs: Date.now() - run.startedAt,
        data: { runId: run.id, cancelled: run.cancelled, totalSession },
      });
    }
  } finally {
    run.runningBatches = Math.max(0, run.runningBatches - 1);
    if (run.runningBatches === 0) run.workersFinished = true;
    hooks.finishRun(run);
  }
}

export async function runScheduledInviterProfileStep(
  ctx: InviterRuntimeState,
  input: {
    profileId: string;
    groupIds: string[];
    invitesPerGroup: number;
    playSoundOnComplete?: boolean;
    onProgress: (status: string, sessionInvited: number) => void;
  },
): Promise<{ invitedCount: number; status: string; hardBlocked: boolean; softIssue: boolean }> {
  ctx.assertStartAllowed();
  const { profileId, onProgress } = input;
  const skip = (status: string) => ({
    invitedCount: 0,
    status,
    hardBlocked: false,
    softIssue: true,
  });
  if (!ctx.runner || !ctx.runner.isAvailable()) return skip('跳过：浏览器内核桥接未就绪');
  const allGroups = await ctx.repo.listGroups();
  const selectedGroups = input.groupIds.flatMap((id) => allGroups.filter((g) => g.groupId === id));
  if (!selectedGroups.length) return skip('跳过：未找到有效的目标小组');
  const runner = ctx.runner;
  if (
    !(await ensureBrowserProfileOnline(
      profileId,
      () => runner.isProfileReady(profileId),
      ctx.profileLifecycle,
      () => onProgress('正在唤醒浏览器连接…', 0),
    ))
  )
    return skip('浏览器未就绪或连接断开');
  if (ctx.isProfileRunning(profileId)) return skip('跳过：该浏览器正在执行其他邀请任务');

  const runId = globalThis.crypto.randomUUID();
  const invitesPerGroup = Math.max(1, Math.min(50, Math.round(input.invitesPerGroup)));
  ctx.scheduledCancelledProfiles.delete(profileId);
  ctx.scheduledRunningProfiles.add(profileId);

  let sessionInvited = 0;
  let pendingSubmitted = 0;
  let statusText = '准备邀请…';
  let hardBlocked = false;
  let softIssue = false;
  let failed = false;
  let sawGroupSkip = false;

  await runTrackedScheduledWorker(
    ctx.workerPromises,
    profileId,
    ctx.workboard.runSoldier(
      { carrierId: profileId, carrierKind: 'browser', moduleId: 'group-inviter' },
      async (soldier) => {
        const stopped = () =>
          soldier.signal.aborted || ctx.scheduledCancelledProfiles.has(profileId);
        const callbacks: GroupInviterRunCallbacks = {
          reportBatchResult: (_pid, _c, pending) => void (pendingSubmitted += pending),
          isCancelled: stopped,
          setProfileStatus: (_pid, text) => {
            if (!stopped()) {
              statusText = text;
              onProgress(text, sessionInvited);
            }
          },
          addSessionInvited: (_pid, count) => {
            sessionInvited += count;
            onProgress(statusText, sessionInvited);
          },
        };
        try {
          await runInviterGroupLoop(
            runner,
            profileId,
            [
              ...(buildStaggeredQueues([profileId], selectedGroups).get(profileId) ??
                selectedGroups),
            ],
            invitesPerGroup,
            callbacks,
            soldier.signal,
            stopped,
            {
              onGroupSkipped: (_group, skipMsg) => {
                sawGroupSkip = true;
                statusText = skipMsg;
                onProgress(statusText, sessionInvited);
              },
              onGroupError: (_group, err) => {
                if (stopped() || isWorkAbortError(err)) return 'break';
                failed = true;
                const { display, hard } = classifyInviterGroupFailure(err);
                statusText = display;
                if (hard) hardBlocked = true;
                else softIssue = true;
                return 'break';
              },
            },
          );
          if (stopped()) statusText = '已停止';
          else if (!failed && !hardBlocked) {
            if (pendingSubmitted > 0 || sessionInvited > 0 || !sawGroupSkip)
              statusText = formatInviterCompletion(sessionInvited, pendingSubmitted, statusText);
            else softIssue = true;
          }
        } catch (err) {
          if (stopped() || isWorkAbortError(err)) statusText = '已停止';
          else {
            failed = true;
            softIssue = true;
            statusText = errMsg(err, '邀请异常').slice(0, 100);
          }
        } finally {
          await persistProfileTaskResult(ctx.repo.saveProfileResult?.bind(ctx.repo), {
            profileId,
            source: 'group-inviter',
            runId,
            name: '小组邀请人',
            state: stopped() ? 'STOPPED' : failed ? 'FAILED' : 'COMPLETED',
            reason: statusText,
            finishedAt: Date.now(),
            failedSteps: failed ? 1 : 0,
            skippedSteps: sawGroupSkip ? 1 : 0,
          });
          ctx.scheduledRunningProfiles.delete(profileId);
          ctx.scheduledCancelledProfiles.delete(profileId);
        }
      },
    ),
  );
  return { invitedCount: sessionInvited, status: statusText, hardBlocked, softIssue };
}
