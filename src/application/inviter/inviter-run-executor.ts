import { ProductError } from '../../domain/workspace.js';
import { devDiag } from '../../shared/dev-diagnostics.js';
import type { InviterGroupOutcome, InviterGroupRow } from '../../shared/group-inviter.js';
import type {
  ActiveRunState,
  GroupInviterBrowserRunner,
  GroupInviterRunCallbacks,
  InviterRuntimeState,
} from '../group-inviter-service.js';
import {
  HARD_BLOCK_MSG_RE,
  acquireCarrierSlotAndLaunch,
  acquireOnlineBrowserPermit,
  buildStaggeredQueues,
  checkRiskLimitSafe,
  closeIdleProfileAfterFinish,
  errMsg,
  persistProfileTaskResult,
  randIntInRange,
  runTrackedScheduledWorker,
  sortTargetsOnlineFirst,
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
type SkippableGroupClassification = { status: 'skipped' | 'failed'; code: string; message: string };
const UNINVITABLE = new Set(['GROUP_INVITER_GROUP_UNINVITABLE', 'GROUP_INVITER_GROUP_CHANGED']);
const GROUP_SKIPPABLE_FAIL = new Set([
  'GROUP_INVITER_GROUP_NOT_READY',
  'GROUP_INVITER_SEND_BUTTON_UNAVAILABLE',
  'GROUP_INVITER_INVITE_MODAL_UNAVAILABLE',
]);
const MSG_SKIPPABLE_FAIL = new Set([
  'GROUP_INVITER_INVITE_ENTRY_REQUIRED',
  'GROUP_INVITER_INVITE_MENU_CHANGED',
  'GROUP_INVITER_CONTROL_UNAVAILABLE',
  'GROUP_INVITER_SELECTION_CHANGED',
  'GROUP_INVITER_RECIPIENT_CHANGED',
]);
const classifySkippableInviterGroupError = (
  err: unknown,
  groupName: string,
): SkippableGroupClassification | null => {
  const shortName = groupName.slice(0, 10);
  if (err instanceof ProductError) {
    if (UNINVITABLE.has(err.code))
      return { status: 'skipped', code: err.code, message: err.message };
    if (
      GROUP_SKIPPABLE_FAIL.has(err.code) ||
      (err.code === 'GROUP_INVITER_PAGE_NOT_READY' && err.message.includes('加载超时')) ||
      (err.code === 'GROUP_INVITER_EFFECT_UNCONFIRMED' && !err.message.startsWith('邀请结果'))
    )
      return { status: 'failed', code: err.code, message: err.message };
    return null;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg === 'GROUP_INVITER_STOP_UNCONFIRMED' ||
    msg === 'GROUP_INVITER_CANCELLED' ||
    HARD_BLOCK_MSG_RE.test(msg) ||
    /GROUP_INVITER_CURRENT_ACCOUNT_OR_VISIBILITY_CHANGED|GROUP_INVITER_CONNECTION_CHANGED|GROUP_INVITER_CANCELLED/i.test(
      msg,
    )
  )
    return null;
  if (msg === 'GROUP_INVITER_CURRENT_GROUP_CHANGED')
    return {
      status: 'skipped',
      code: msg,
      message: `跳过：小组页面已跳转或无法直接加入 · ${shortName}`,
    };
  if (/^GROUP_INVITER_NAVIGATION_FAILED:/.test(msg))
    return {
      status: 'failed',
      code: 'GROUP_INVITER_NAVIGATION_FAILED',
      message: msg.replace(/^GROUP_INVITER_NAVIGATION_FAILED:/, '打开小组失败：').slice(0, 100),
    };
  if (MSG_SKIPPABLE_FAIL.has(msg) || /邀请发送按钮不可用|邀请发送按钮无法点击/.test(msg))
    return { status: 'failed', code: msg, message: `跳过：${msg.slice(0, 80)} · ${shortName}` };
  if (/locator\.click:|outside.*viewport|intercepts pointer events|not visible/i.test(msg))
    return {
      status: 'failed',
      code: 'GROUP_INVITER_CONTROL_CLICK_FAILED',
      message: `跳过：小组操作按钮不可点击 · ${shortName}`,
    };
  return null;
};
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
type GroupLoopSummary = { invited: number; pending: number; lastStatus: string };
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
    onGroupDone?: (group: InviterGroupRow, startedAt: number, summary: GroupLoopSummary) => void;
    onGroupSkipped?: (
      group: InviterGroupRow,
      skip: SkippableGroupClassification,
      err: unknown,
    ) => void;
    onGroupError: (
      group: InviterGroupRow,
      err: unknown,
      startedAt: number,
      summary: GroupLoopSummary,
    ) => 'return' | 'continue' | 'break';
  },
): Promise<boolean> {
  while (pending.length && !stopped()) {
    if (hooks.checkBeforeGroup && !(await hooks.checkBeforeGroup())) return true;
    const group = pending.shift();
    if (!group) break;
    const startedAt = Date.now();
    const groupSummary: GroupLoopSummary = { invited: 0, pending: 0, lastStatus: '' };
    const groupCallbacks: GroupInviterRunCallbacks = {
      isCancelled: (pid) => callbacks.isCancelled(pid),
      setProfileStatus: async (pid, status) => {
        groupSummary.lastStatus = status;
        await callbacks.setProfileStatus(pid, status);
      },
      addSessionInvited: async (pid, count) => {
        groupSummary.invited += count;
        await callbacks.addSessionInvited(pid, count);
      },
      reportBatchResult: async (pid, confirmed, pend) => {
        groupSummary.pending += pend;
        await callbacks.reportBatchResult?.(pid, confirmed, pend);
      },
    };
    try {
      await runner.inviteForGroup(profileId, group, invitesPerGroup, groupCallbacks);
      hooks.onGroupDone?.(group, startedAt, groupSummary);
    } catch (err) {
      const skippable = classifySkippableInviterGroupError(err, group.groupName);
      if (skippable) {
        hooks.onGroupSkipped?.(group, skippable, err);
        if (pending.length) await sleepAbortable(1000, signal);
        continue;
      }
      const action = hooks.onGroupError(group, err, startedAt, groupSummary);
      if (action === 'return') return true;
      if (action === 'continue') {
        if (pending.length) await sleepAbortable(1000, signal);
        continue;
      }
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
  _maxConcurrentProfiles: number,
  _pendingLaunchSet: ReadonlySet<string>,
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
    const orderedProfileIds = await sortTargetsOnlineFirst(profileIds, (id) =>
      runner.isProfileReady(id),
    );
    const runWorkerForProfile = (profileId: string, startupDelay: number) =>
      ctx.workboard.runSoldier(
        { carrierId: profileId, carrierKind: 'browser', moduleId: 'group-inviter' },
        async (soldier) => {
          const stopped = () => isProfileCancelled(profileId) || soldier.signal.aborted;
          const onAbort = () => abortedProfiles.add(profileId);
          if (soldier.signal.aborted) abortedProfiles.add(profileId);
          else soldier.signal.addEventListener('abort', onAbort, { once: true });
          let releasePermit: (() => void) | undefined;
          let touchedBrowser = false;
          let riskLimitReason: string | null = null;
          const recordOutcome = (
            group: InviterGroupRow,
            status: InviterGroupOutcome['status'],
            invitedCount: number,
            skippedCount: number,
            reason: string,
          ) =>
            run.groupResults.push({
              profileId,
              profileName: run.profileNames.get(profileId) ?? '',
              groupId: group.groupId,
              groupName: group.groupName,
              status,
              invitedCount,
              skippedCount,
              reason: reason.slice(0, 300),
            });
          const checkLimit = () => checkRiskLimitSafe(ctx.checkDailyRiskLimit, profileId, 'invite');
          try {
            if (stopped()) return void run.profileStatus.set(profileId, '已停止');
            if (await runner.isProfileBusy?.(profileId)) {
              run.profileStatus.set(profileId, '跳过：正在执行其他任务');
              run.failedProfiles.add(profileId);
              return;
            }
            const preCap = await checkLimit();
            if (!preCap.allowed) {
              run.profileStatus.set(
                profileId,
                preCap.reason ?? '今日已达浏览器邀人日限额，自动跳过保护',
              );
              return;
            }
            if (startupDelay > 0 && !stopped()) {
              run.profileStatus.set(profileId, '排队等待并发槽位…');
              await sleepAbortable(startupDelay, soldier.signal);
            }
            if (stopped()) return void run.profileStatus.set(profileId, '已停止');
            const acquired = await acquireCarrierSlotAndLaunch({
              carrierKind: 'browser',
              carrierId: profileId,
              moduleId: 'group-inviter',
              workboard: ctx.workboard,
              signal: soldier.signal,
              featureExecution: ctx.featureExecution,
              checkDailyLimit: async () => {
                if (await runner.isProfileBusy?.(profileId))
                  return { allowed: false, reason: '跳过：正在执行其他任务' };
                return checkLimit();
              },
              isReady: (id) => runner.isProfileReady(id),
              launch: async (id) => {
                touchedBrowser = true;
                const lifecycle = ctx.profileLifecycle;
                if (!lifecycle) return { ok: false, reason: '离线或未就绪' };
                const res = await lifecycle.ensureProfilesOnline([id]).catch((e: unknown) => ({
                  startedIds: [] as string[],
                  failed: [{ profileId: id, reason: errMsg(e, '浏览器自动启动失败') }],
                }));
                if (await runner.isProfileReady(id)) return { ok: true };
                const fail = res.failed.find((f) => f.profileId === id)?.reason;
                return { ok: false, reason: fail ?? '浏览器已启动但插件未连接就绪' };
              },
              onQueued: () => void run.profileStatus.set(profileId, '排队等待并发槽位…'),
              onLaunching: () => void run.profileStatus.set(profileId, '正在启动浏览器…'),
            });
            if (!acquired.ok) {
              if (stopped()) run.profileStatus.set(profileId, '已停止');
              else {
                run.profileStatus.set(profileId, acquired.reason);
                if (!acquired.skipped) run.failedProfiles.add(profileId);
              }
              return;
            }
            releasePermit = acquired.releasePermit;
            touchedBrowser = true;
            if (!stopped()) run.profileStatus.set(profileId, '准备中');
            if (stopped()) return void run.profileStatus.set(profileId, '已停止');
            if (!(await runner.isProfileReady(profileId))) {
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
                  const cap = await checkLimit();
                  if (!cap.allowed) {
                    riskLimitReason = cap.reason ?? '今日已达浏览器邀人日限额，自动跳过保护';
                    run.profileStatus.set(profileId, riskLimitReason);
                    return false;
                  }
                  return true;
                },
                onGroupDone: (group, startAt, summary) => {
                  const hasInvites = summary.invited > 0 || summary.pending > 0;
                  const reason = hasInvites
                    ? formatInviterCompletion(summary.invited, summary.pending, summary.lastStatus)
                    : stopped()
                      ? '已停止'
                      : summary.lastStatus === '无可邀请对象'
                        ? '无可邀请对象'
                        : '已完成（0 人）';
                  recordOutcome(
                    group,
                    hasInvites ? 'invited' : 'skipped',
                    summary.invited,
                    hasInvites ? 0 : 1,
                    reason,
                  );
                  diagInviter('INFO', 'GROUP_INVITER_GROUP_DONE', {
                    profileId,
                    durationMs: Date.now() - startAt,
                    data: {
                      runId: run.id,
                      groupId: group.groupId,
                      status: run.profileStatus.get(profileId) ?? '',
                      sessionInvited: run.sessionCounts.get(profileId) ?? 0,
                    },
                  });
                },
                onGroupSkipped: (group, skip) => {
                  run.profileStatus.set(profileId, skip.message);
                  recordOutcome(
                    group,
                    skip.status,
                    0,
                    skip.status === 'skipped' ? 1 : 0,
                    skip.message,
                  );
                  diagInviter('INFO', 'GROUP_INVITER_GROUP_SKIPPED', {
                    profileId,
                    reason: skip.code,
                    data: { runId: run.id, groupId: group.groupId, outcome: skip.status },
                  });
                },
                onGroupError: (group, err, startAt, summary) => {
                  run.failedProfiles.add(profileId);
                  if (err instanceof Error && err.message === 'GROUP_INVITER_STOP_UNCONFIRMED') {
                    const msg = '停止未确认，请保持浏览器在线后重试停止';
                    run.unconfirmedStops.add(profileId);
                    run.profileStatus.set(profileId, msg);
                    recordOutcome(group, 'failed', summary.invited, 0, msg);
                    return 'return';
                  }
                  const { raw, display } = classifyInviterGroupFailure(err);
                  const statusMsg = display.startsWith('受限') ? display : `执行失败 · ${display}`;
                  run.profileStatus.set(profileId, statusMsg);
                  recordOutcome(group, 'failed', summary.invited, 0, statusMsg);
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
            if (returnedEarly) {
              if (riskLimitReason) run.profileStatus.set(profileId, riskLimitReason);
              return;
            }
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
            releasePermit?.();
            if (!run.unconfirmedStops.has(profileId)) {
              await hooks
                .saveResult(run, profileId)
                .catch(() => void run.profileStatus.set(profileId, '任务已结束，但结果保存失败'));
              run.activeProfiles.delete(profileId);
            }
            const settingsClose = await Promise.resolve(ctx.repo.getSettings())
              .then((s) => Boolean(s.closeBrowserOnFinish))
              .catch(() => false);
            const shouldClose = Boolean(run.closeBrowserOnFinish || settingsClose);
            if (
              shouldClose &&
              touchedBrowser &&
              !run.unconfirmedStops.has(profileId) &&
              ctx.profileLifecycle &&
              !ctx.admittingProfiles.has(profileId) &&
              !ctx.startingProfiles.has(profileId) &&
              !ctx.scheduledRunningProfiles.has(profileId) &&
              !ctx.activeRun?.activeProfiles.has(profileId) &&
              !ctx.workboard.hasCarrierPermit('browser', profileId) &&
              !(await ctx.featureExecution
                ?.isProfileBusy(profileId, 'group-inviter')
                .catch(() => true)) &&
              !(await Promise.resolve(runner.isProfileBusy?.(profileId)).catch(() => true))
            ) {
              await closeIdleProfileAfterFinish(ctx.profileLifecycle, profileId);
            }
          }
        },
      );
    let startupDelay = 0;
    await Promise.all(
      orderedProfileIds.map((pid, index) => {
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
type ScheduledInviterResult = {
  invitedCount: number;
  status: string;
  hardBlocked: boolean;
  softIssue: boolean;
  playSoundOnComplete: boolean;
};
export async function runScheduledInviterProfileStep(
  ctx: InviterRuntimeState,
  input: {
    profileId: string;
    groupIds: string[];
    invitesPerGroup: number;
    playSoundOnComplete?: boolean;
    onProgress: (status: string, sessionInvited: number) => void;
  },
): Promise<ScheduledInviterResult> {
  ctx.assertStartAllowed();
  const { profileId, onProgress } = input;
  const settings = await ctx.repo.getSettings();
  const playSoundOnComplete = input.playSoundOnComplete ?? settings.playSoundOnComplete;
  const skip = (status: string, softIssue = true): ScheduledInviterResult => ({
    invitedCount: 0,
    status,
    hardBlocked: false,
    softIssue,
    playSoundOnComplete,
  });
  if (!ctx.runner || !ctx.runner.isAvailable()) return skip('跳过：浏览器内核桥接未就绪');
  const allGroups = await ctx.repo.listGroups();
  const groupMap = new Map(allGroups.map((g) => [g.groupId, g]));
  const selectedGroups = [...new Set(input.groupIds)]
    .map((id) => groupMap.get(id))
    .filter((g): g is InviterGroupRow => g !== undefined);
  if (!selectedGroups.length) return skip('跳过：未找到有效的目标小组');
  const runner = ctx.runner;
  if (ctx.isProfileRunning(profileId)) return skip('跳过：该浏览器正在执行其他邀请任务');
  const preCap = await checkRiskLimitSafe(ctx.checkDailyRiskLimit, profileId, 'invite');
  if (!preCap.allowed)
    return skip(preCap.reason ?? '今日已达浏览器邀人日限额，自动休眠保护', false);
  const runId = globalThis.crypto.randomUUID();
  const invitesPerGroup = Number.isFinite(input.invitesPerGroup)
    ? Math.max(1, Math.min(200, Math.round(input.invitesPerGroup)))
    : settings.invitesPerGroup;
  ctx.scheduledCancelledProfiles.delete(profileId);
  ctx.scheduledRunningProfiles.add(profileId);
  ctx.scheduledPlaySound = playSoundOnComplete;
  let sessionInvited = 0;
  let pendingSubmitted = 0;
  let statusText = '准备邀请…';
  let hardBlocked = false;
  let softIssue = false;
  let failed = false;
  let sawGroupSkip = false;
  let riskLimitReason = '';
  let earlyResult: ScheduledInviterResult | null = null;
  await runTrackedScheduledWorker(
    ctx.workerPromises,
    profileId,
    ctx.workboard.runSoldier(
      { carrierId: profileId, carrierKind: 'browser', moduleId: 'group-inviter' },
      async (soldier) => {
        let releasePermit: (() => void) | undefined;
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
          const { releasePermit: rel, online } = await acquireOnlineBrowserPermit(
            ctx.workboard,
            profileId,
            soldier.signal,
            () => runner.isProfileReady(profileId),
            ctx.profileLifecycle,
            () => onProgress('正在唤醒浏览器连接…', 0),
          );
          releasePermit = rel;
          if (!online) {
            earlyResult = skip('浏览器未就绪或连接断开');
            return;
          }
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
              checkBeforeGroup: async () => {
                const cap = await checkRiskLimitSafe(ctx.checkDailyRiskLimit, profileId, 'invite');
                if (!cap.allowed) {
                  riskLimitReason = cap.reason ?? '今日已达浏览器邀人日限额，自动休眠保护';
                  statusText = riskLimitReason;
                  onProgress(statusText, sessionInvited);
                  return false;
                }
                return true;
              },
              onGroupSkipped: (_group, skip) => {
                sawGroupSkip = true;
                statusText = skip.message;
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
          else if (riskLimitReason) statusText = riskLimitReason;
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
          releasePermit?.();
          if (!earlyResult) {
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
          }
          ctx.scheduledRunningProfiles.delete(profileId);
          ctx.scheduledCancelledProfiles.delete(profileId);
          if (ctx.scheduledRunningProfiles.size === 0) ctx.scheduledPlaySound = undefined;
        }
      },
    ),
  );
  return (
    earlyResult ?? {
      invitedCount: sessionInvited,
      status: statusText,
      hardBlocked,
      softIssue,
      playSoundOnComplete,
    }
  );
}
