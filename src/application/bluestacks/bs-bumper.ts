import { failError } from '../../domain/workspace.js';
import {
  StartBluestacksBumperInput,
  StartBluestacksPageBumperInput,
  StopBluestacksBumperInput,
  type BluestacksBumperMode,
} from '../../shared/bluestacks.js';
import { BumperSettings, type BumperTarget } from '../../shared/group-bumper.js';
import { devDiag } from '../../shared/dev-diagnostics.js';
import { buildStaggeredBumperQueues } from '../group-bumper-service.js';
import {
  HARD_BLOCK_MSG_RE,
  linkAbortSignal,
  sleepMs,
  sortTargetsOnlineFirst,
} from '../module-worker-pool.js';
import { ensureInstanceOnlineForManualAction } from './bs-instance-ops.js';
import {
  type BluestacksServiceContext,
  type QueuedBluestacksTask,
  bsCarrierId,
  classifyBsWorkerError,
  closeInstanceIfIdleAfterFinish,
  ensurePortraitInstanceOnline,
  getDiscoverySnapshot,
  guardInstanceRiskQuota,
  hasActiveExecution,
  isProfileRunning,
  prepareIdlePortraitInstances,
  recordBsFailure,
  runWithBsSoldier,
  saveLastStatusSafe,
  setBsStat,
  triggerRiskQuotaAbort,
} from './bs-types.js';
const modeLabel = (isPage: boolean) => (isPage ? '蓝蝶专页顶贴' : '蓝蝶小组顶贴');
const statsOf = (ctx: BluestacksServiceContext, isPage: boolean) =>
  isPage ? ctx.pageProfileStats : ctx.profileStats;
const setModeStatus = (ctx: BluestacksServiceContext, isPage: boolean, msg: string) =>
  void (isPage ? (ctx.pageStatusText = msg) : (ctx.statusText = msg));
const clearWorkerSlot = (ctx: BluestacksServiceContext, id: string) => {
  ctx.activeWorkers.delete(id);
  ctx.activeWorkerModes.delete(id);
  ctx.activeWorkerSettings.delete(id);
  ctx.abortControllers.delete(id);
};
function runBumperSoldierWithPermit<T>(
  ctx: BluestacksServiceContext,
  instanceId: string,
  isPage: boolean,
  controller: AbortController,
  work: () => Promise<T>,
  initialDelayMs = 0,
): Promise<T> {
  return runWithBsSoldier(
    ctx,
    instanceId,
    isPage ? 'bluestacks-page-bumper' : 'bluestacks-group-bumper',
    controller,
    async () => {
      let releasePermit: (() => void) | undefined;
      try {
        if (initialDelayMs > 0 && !controller.signal.aborted)
          await sleepMs(initialDelayMs, controller.signal);
        releasePermit = await ctx.workboard.acquireCarrierPermit(
          'bluestacks',
          bsCarrierId(instanceId),
          controller.signal,
        );
        return await work();
      } finally {
        releasePermit?.();
      }
    },
  );
}
export function countModeRunners(
  ctx: BluestacksServiceContext,
  mode: BluestacksBumperMode,
): number {
  let n = 0;
  for (const m of ctx.activeWorkerModes.values()) if (m === mode) n++;
  for (const q of ctx.queuedTasks) if (q.mode === mode) n++;
  return n;
}
export async function startBumperRun(
  ctx: BluestacksServiceContext,
  input: unknown,
  mode: BluestacksBumperMode,
): Promise<void> {
  const isPage = mode === 'page';
  const parsed = isPage
    ? { ...StartBluestacksPageBumperInput.parse(input), groupIds: [] as string[] }
    : StartBluestacksBumperInput.parse(input);
  const [{ instances }, allGroups, allPages, saved, counts] = await Promise.all([
    getDiscoverySnapshot(ctx, true),
    isPage ? Promise.resolve([] as BumperTarget[]) : ctx.repo.targets('groups'),
    ctx.repo.targets('pages'),
    ctx.repo.savedSettings(),
    ctx.repo.todayCounts(undefined, mode),
  ]);
  const selectedGroups = isPage ? [] : allGroups.filter((g) => parsed.groupIds.includes(g.id));
  const selectedPages = allPages.filter((p) => parsed.pageIds.includes(p.id));
  if (!selectedPages.length || (!isPage && !selectedGroups.length))
    failError(
      'BUMPER_TARGETS_EMPTY',
      isPage ? '请至少选择一个有效的目标专页' : '请至少选择一个有效小组和一个目标主页',
      400,
    );
  const statsMap = statsOf(ctx, isPage);
  const onlineReady = await prepareIdlePortraitInstances(
    ctx,
    parsed.profileIds,
    instances,
    'bump',
    statsMap,
    '所选蓝蝶窗口正忙于其他任务，请稍候再试',
  );
  const settings = isPage
    ? (saved.pageBumperSettings ?? saved.bumperSettings)
    : saved.bumperSettings;
  const instById = new Map(instances.map((i) => [i.id, i]));
  const orderedReady = await sortTargetsOnlineFirst(onlineReady, (id) =>
    Boolean(instById.get(id)?.online),
  );
  const staggered = buildStaggeredBumperQueues(
    orderedReady,
    isPage ? selectedPages : selectedGroups,
  );
  for (const id of orderedReady) {
    const controller = new AbortController();
    ctx.abortControllers.set(id, controller);
    ctx.queuedTasks.push({
      instanceId: id,
      mode,
      groups: isPage ? [] : (staggered.get(id) ?? [...selectedGroups]),
      pages: isPage ? (staggered.get(id) ?? [...selectedPages]) : [...selectedPages],
      settings,
      controller,
      ...(parsed.closeWindowOnFinish ? { closeWindowOnFinish: true } : {}),
    });
    statsMap.set(id, {
      running: true,
      status: '排队等待并发槽位…',
      session: 0,
      today: counts[id] ?? 0,
    });
  }
  const maxCap = Math.max(1, ctx.workboard.bluestacksPermits.max);
  devDiag.emit('INFO', 'TASK_RUNNER', 'BLUESTACKS_BUMPER_START', {
    data: {
      mode,
      requestedCount: parsed.profileIds.length,
      readyCount: orderedReady.length,
      groupsCount: selectedGroups.length,
      pagesCount: selectedPages.length,
      searchMode: settings.searchMode,
      maxPostAgeHours: settings.maxPostAgeHours,
    },
  });
  setModeStatus(
    ctx,
    isPage,
    `正在运行 ${countModeRunners(ctx, mode)} 个蓝蝶模拟器（最大并发 ${maxCap}）`,
  );
  pumpWorkerPool(ctx);
}
export function pumpWorkerPool(ctx: BluestacksServiceContext): void {
  if (ctx.pumpingPool) return;
  ctx.pumpingPool = true;
  try {
    const maxCap = Math.max(1, ctx.workboard.bluestacksPermits.max);
    while (ctx.activeWorkers.size < maxCap && ctx.queuedTasks.length) {
      const nextTask = ctx.queuedTasks.shift();
      if (!nextTask) break;
      if (nextTask.controller.signal.aborted) {
        ctx.abortControllers.delete(nextTask.instanceId);
        continue;
      }
      if (ctx.activeWorkers.has(nextTask.instanceId) || ctx.extraWorkers.has(nextTask.instanceId)) {
        ctx.queuedTasks.push(nextTask);
        break;
      }
      const slotIndex = ctx.activeWorkers.size;
      nextTask.settings = { ...nextTask.settings };
      ctx.activeWorkerModes.set(nextTask.instanceId, nextTask.mode);
      ctx.activeWorkerSettings.set(nextTask.instanceId, nextTask.settings);
      const workerPromise = executeInstanceTask(ctx, nextTask, slotIndex * 650).finally(
        async () => {
          clearWorkerSlot(ctx, nextTask.instanceId);
          const isPage = nextTask.mode === 'page';
          setModeStatus(
            ctx,
            isPage,
            hasActiveExecution(ctx, nextTask.mode)
              ? `正在运行 ${countModeRunners(ctx, nextTask.mode)} 个蓝蝶模拟器`
              : `${modeLabel(isPage)}运行结束`,
          );
          if (hasActiveExecution(ctx)) pumpWorkerPool(ctx);
          if (nextTask.closeWindowOnFinish) {
            await closeInstanceIfIdleAfterFinish(ctx, nextTask.instanceId, true, (closeErr) =>
              devDiag.emit('WARN', 'TASK_RUNNER', 'BLUESTACKS_BUMPER_FINISH_CLOSE_FAILED', {
                reason: String(closeErr),
                data: { instanceId: nextTask.instanceId, mode: nextTask.mode },
              }),
            );
          }
        },
      );
      ctx.activeWorkers.set(nextTask.instanceId, workerPromise);
    }
  } finally {
    ctx.pumpingPool = false;
  }
}
async function runBumperCore(
  ctx: BluestacksServiceContext,
  instanceId: string,
  mode: BluestacksBumperMode,
  groups: readonly BumperTarget[],
  pages: readonly BumperTarget[],
  settings: BumperSettings,
  controller: AbortController,
  todayInit: number | undefined,
  prefix: '上次' | '排班',
  onProgress?: (status: string, session: number) => void,
  runnerOpts?: { lockEnableSound?: boolean },
): Promise<{ session: number; status: string; hardBlocked: boolean; softIssue: boolean }> {
  const isPage = mode === 'page',
    lbl = modeLabel(isPage),
    statsMap = statsOf(ctx, isPage);
  let session = 0,
    hardBlocked = false,
    softIssue = false;
  setBsStat(statsMap, instanceId, {
    running: true,
    status: '正在启动顶贴…',
    session: 0,
    ...(todayInit !== undefined ? { today: todayInit } : {}),
  });
  try {
    await ctx.runner.run(
      instanceId,
      groups,
      pages,
      settings,
      controller.signal,
      {
        status: (text, today) => {
          setBsStat(statsMap, instanceId, {
            running: true,
            status: text,
            ...(today !== undefined ? { today } : {}),
          });
          if (onProgress) onProgress(text, session);
          else setModeStatus(ctx, isPage, text);
        },
        added: (today) => {
          session += 1;
          const status = statsMap.get(instanceId)?.status ?? '正在运行…';
          setBsStat(statsMap, instanceId, { running: true, status, session, today });
          onProgress?.(status, session);
          triggerRiskQuotaAbort(ctx, instanceId, 'bump', controller);
        },
      },
      mode,
      runnerOpts,
    );
    const doneStatus = `已完成（本次顶贴 ${session} 条）`;
    devDiag.emit(session > 0 ? 'INFO' : 'WARN', 'TASK_RUNNER', 'BLUESTACKS_BUMPER_INSTANCE_DONE', {
      data: {
        instanceId,
        mode,
        prefix,
        session,
        groupsCount: groups.length,
        pagesCount: pages.length,
      },
    });
    setBsStat(statsMap, instanceId, { running: false, status: doneStatus, session });
    await saveLastStatusSafe(
      ctx,
      instanceId,
      `${prefix}${prefix === '排班' ? '完成' : '成功'} · ${isPage && prefix === '上次' ? '专页顶贴' : lbl.replace('蓝蝶', prefix === '上次' ? '' : '蓝蝶')} ${session} 条`.replace(
        '  ',
        ' ',
      ),
    );
    return { session, status: doneStatus, hardBlocked, softIssue };
  } catch (err) {
    const { riskReason, rawMsg, stopped } = classifyBsWorkerError(controller, err);
    if (riskReason) {
      setBsStat(statsMap, instanceId, { running: false, status: riskReason, session });
      await saveLastStatusSafe(ctx, instanceId, riskReason);
      return { session, status: riskReason, hardBlocked: false, softIssue: false };
    }
    const status = stopped ? '已停止' : rawMsg;
    devDiag.emit(stopped ? 'INFO' : 'WARN', 'TASK_RUNNER', 'BLUESTACKS_BUMPER_INSTANCE_ERROR', {
      reason: rawMsg.slice(0, 160),
      data: { instanceId, mode, prefix, stopped, session },
    });
    setBsStat(statsMap, instanceId, { running: false, status, session });
    if (!stopped) {
      if (HARD_BLOCK_MSG_RE.test(rawMsg)) hardBlocked = true;
      else softIssue = true;
      if (prefix === '排班')
        recordBsFailure(ctx, {
          recordType: isPage ? 'page_bump' : 'group_bump',
          carrier: 'bluestacks',
          status: 'failed',
          profileId: instanceId,
          errorReason: rawMsg.slice(0, 120),
        });
    }
    await saveLastStatusSafe(
      ctx,
      instanceId,
      stopped
        ? `${prefix}${prefix === '排班' ? '停止' : '已停止'} · ${lbl}`
        : `${prefix}异常 · ${rawMsg.slice(0, 80)}`,
    );
    return { session, status, hardBlocked, softIssue };
  }
}
async function executeInstanceTask(
  ctx: BluestacksServiceContext,
  task: QueuedBluestacksTask,
  initialDelayMs: number,
): Promise<void> {
  const { instanceId, mode, groups, pages, settings, controller } = task,
    isPage = mode === 'page',
    lbl = modeLabel(isPage),
    statsMap = statsOf(ctx, isPage);
  try {
    await runBumperSoldierWithPermit(
      ctx,
      instanceId,
      isPage,
      controller,
      async () => {
        while (
          (ctx.inspectingIds.has(instanceId) || ctx.launchingIds.has(instanceId)) &&
          !controller.signal.aborted
        ) {
          setBsStat(statsMap, instanceId, { running: true, status: '等待窗口就绪/账号识别完成…' });
          await sleepMs(300, controller.signal);
        }
        if (!controller.signal.aborted) {
          await ensureInstanceOnlineForManualAction(ctx, instanceId, controller.signal, (msg) => {
            setBsStat(statsMap, instanceId, { running: true, status: msg });
            setModeStatus(ctx, isPage, msg);
          });
        }
        if (controller.signal.aborted) {
          setBsStat(statsMap, instanceId, { running: false, status: '已停止' });
          return void (await saveLastStatusSafe(ctx, instanceId, `上次已停止 · ${lbl}`));
        }
        await runBumperCore(
          ctx,
          instanceId,
          mode,
          groups,
          pages,
          settings,
          controller,
          undefined,
          '上次',
        );
      },
      initialDelayMs,
    );
  } catch (err) {
    const { riskReason, rawMsg, stopped } = classifyBsWorkerError(controller, err);
    setBsStat(statsMap, instanceId, {
      running: false,
      status: riskReason ?? (stopped ? '已停止' : rawMsg),
    });
    await saveLastStatusSafe(
      ctx,
      instanceId,
      riskReason ?? (stopped ? `上次已停止 · ${lbl}` : `上次异常 · ${rawMsg.slice(0, 80)}`),
    );
  }
}
export async function stopBumper(
  ctx: BluestacksServiceContext,
  ids?: readonly string[],
  mode?: BluestacksBumperMode,
): Promise<void> {
  const targetIds = ids?.length ? new Set(ids) : null;
  const matchedIds = targetIds
    ? [...targetIds]
    : [
        ...new Set([
          ...[...ctx.activeWorkers.keys()].filter(
            (id) => !mode || ctx.activeWorkerModes.get(id) === mode,
          ),
          ...ctx.queuedTasks.filter((q) => !mode || q.mode !== mode).map((q) => q.instanceId),
        ]),
      ];
  for (let i = ctx.queuedTasks.length - 1; i >= 0; i--) {
    const q = ctx.queuedTasks[i];
    if (!q || (targetIds && !targetIds.has(q.instanceId)) || (mode && q.mode !== mode)) continue;
    q.controller.abort(new Error('TASK_STOPPED'));
    ctx.workboard.abortCarrier(bsCarrierId(q.instanceId), 'TASK_STOPPED');
    ctx.abortControllers.delete(q.instanceId);
    ctx.queuedTasks.splice(i, 1);
    setBsStat(statsOf(ctx, q.mode === 'page'), q.instanceId, { running: false, status: '已停止' });
    await saveLastStatusSafe(ctx, q.instanceId, `上次已停止 · ${modeLabel(q.mode === 'page')}`);
  }
  const activePromises: Promise<void>[] = [];
  for (const id of matchedIds) {
    const activeMode = ctx.activeWorkerModes.get(id);
    if (mode && activeMode && activeMode !== mode) continue;
    ctx.abortControllers.get(id)?.abort(new Error('TASK_STOPPED'));
    ctx.workboard.abortCarrier(bsCarrierId(id), 'TASK_STOPPED');
    const worker = ctx.activeWorkers.get(id);
    if (worker) {
      setBsStat(statsOf(ctx, activeMode === 'page'), id, { running: true, status: '正在停止…' });
      activePromises.push(worker);
    }
  }
  if (activePromises.length) await Promise.allSettled(activePromises);
  if ((!mode || mode === 'group') && !hasActiveExecution(ctx, 'group'))
    ctx.statusText = '已停止蓝蝶小组顶贴任务';
  if ((!mode || mode === 'page') && !hasActiveExecution(ctx, 'page'))
    ctx.pageStatusText = '已停止蓝蝶专页顶贴任务';
}
export const parseStopInput = (input: unknown): string[] | undefined =>
  !input || (typeof input === 'object' && !Object.keys(input).length)
    ? undefined
    : StopBluestacksBumperInput.parse(input).profileIds;
export const ensureInstanceOnlineForSchedule = (
  ctx: BluestacksServiceContext,
  instanceId: string,
  signal?: AbortSignal,
) =>
  ensurePortraitInstanceOnline(ctx, instanceId, {
    forceDiscover: true,
    launchStatus: '排班自动启动成功',
    signal,
  });
const bumperSkip = (status: string, softIssue = true) => ({
  bumpedCount: 0,
  status,
  hardBlocked: false,
  softIssue,
});
export async function runScheduledInstanceStep(
  ctx: BluestacksServiceContext,
  input: {
    instanceId: string;
    mode: BluestacksBumperMode;
    groupIds: string[];
    pageIds: string[];
    enableSound?: boolean;
    settingsOverride?: Partial<BumperSettings>;
    minConcurrency: number;
    signal?: AbortSignal;
    onProgress: (status: string, sessionBumps: number) => void;
  },
): Promise<{ bumpedCount: number; status: string; hardBlocked: boolean; softIssue: boolean }> {
  const { instanceId, mode, onProgress } = input;
  const isBusy = () =>
    isProfileRunning(ctx, instanceId) ||
    ctx.closingIds.has(instanceId) ||
    ctx.inspectingIds.has(instanceId);
  if (isBusy()) return bumperSkip('跳过：该蓝蝶实例正在执行其他操作');
  const isPage = mode === 'page';
  const [allGroups, allPages, saved, counts] = await Promise.all([
    ctx.repo.targets('groups'),
    ctx.repo.targets('pages'),
    ctx.repo.savedSettings(),
    ctx.repo.todayCounts(undefined, mode),
  ]);
  const selectedPages = allPages.filter((p) => input.pageIds.includes(p.id));
  const selectedGroups = isPage ? [] : allGroups.filter((g) => input.groupIds.includes(g.id));
  if (!selectedPages.length || (!isPage && !selectedGroups.length))
    return bumperSkip('跳过：未找到有效的目标小组或专页');
  const blockedMsg = await guardInstanceRiskQuota(ctx, instanceId, 'bump');
  if (blockedMsg) return bumperSkip(blockedMsg, false);
  const merged = BumperSettings.parse({
    ...(isPage ? (saved.pageBumperSettings ?? saved.bumperSettings) : saved.bumperSettings),
    ...(input.settingsOverride ?? {}),
  });
  const effectiveSound = input.settingsOverride?.enableSound ?? input.enableSound;
  const settings: BumperSettings = {
    ...merged,
    ...(effectiveSound !== undefined ? { enableSound: effectiveSound } : {}),
  };
  const { controller, abortedInitially, detach } = linkAbortSignal(input.signal);
  if (abortedInitially) return bumperSkip('已停止', false);
  if (isBusy()) {
    detach();
    return bumperSkip('跳过：该蓝蝶实例正在执行其他操作');
  }
  ctx.abortControllers.set(instanceId, controller);
  ctx.activeWorkerModes.set(instanceId, mode);
  ctx.activeWorkerSettings.set(instanceId, settings);
  const workerPromise = runBumperSoldierWithPermit(ctx, instanceId, isPage, controller, () =>
    runBumperCore(
      ctx,
      instanceId,
      mode,
      selectedGroups,
      selectedPages,
      settings,
      controller,
      counts[instanceId] ?? 0,
      '排班',
      onProgress,
      input.enableSound !== undefined ? { lockEnableSound: true } : undefined,
    ),
  ).finally(detach);
  ctx.activeWorkers.set(
    instanceId,
    workerPromise.then(() => undefined),
  );
  try {
    const res = await workerPromise;
    return {
      bumpedCount: res.session,
      status: res.status,
      hardBlocked: res.hardBlocked,
      softIssue: res.softIssue,
    };
  } finally {
    clearWorkerSlot(ctx, instanceId);
  }
}
