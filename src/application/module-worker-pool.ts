import type { Awaitable } from '../domain/persistence.js';
import type { BumperRefreshResult, BumperTarget } from '../shared/group-bumper.js';
import type { PostBumpRecordsPort } from '../shared/post-bump-records.js';
import type { ProfileLifecyclePort } from '../shared/profile-lifecycle.js';
import type { ProfileTaskResultValue } from '../shared/task-contracts.js';
import type { FeatureExecutionRegistry } from './feature-execution-registry.js';
import {
  admitProfilesForStart,
  type ProfileStartAdmissionResult,
} from './profile-start-admission.js';
import type { Workboard } from './workboard.js';

export const HARD_BLOCK_MSG_RE =
  /未登录|登录失效|退出登录|账号受限|封号|封禁|停用|账号异常|验证页面|手机验证|身份验证|需验证|安全验证|checkpoint|login/i;

export const randIntInRange = (min: number, max: number) =>
  Math.floor(min + Math.random() * (max - min + 1));

export const errMsg = (err: unknown, fallback?: string): string =>
  err instanceof Error ? err.message : (fallback ?? String(err));

export const ignoreError = (work: Awaitable<unknown>): Promise<void> =>
  Promise.resolve(work).then(
    () => undefined,
    () => undefined,
  );

export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((r) => void setTimeout(r, ms).unref?.());
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function shuffleArray<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = copy[i];
    const b = copy[j];
    if (a !== undefined && b !== undefined) {
      copy[i] = b;
      copy[j] = a;
    }
  }
  return copy;
}

export function buildStaggeredQueues<T>(
  profileIds: readonly string[],
  targets: readonly T[],
): Map<string, T[]> {
  const base = shuffleArray(targets);
  const result = new Map<string, T[]>();
  const m = Math.max(1, profileIds.length);
  const k = base.length;
  profileIds.forEach((profileId, idx) => {
    if (k <= 1) return void result.set(profileId, [...base]);
    const offset = Math.floor((idx * k) / m) % k;
    const rotated = [...base.slice(offset), ...base.slice(0, offset)];
    const first = rotated[0];
    const rest = shuffleArray(rotated.slice(1));
    result.set(profileId, first !== undefined ? [first, ...rest] : rest);
  });
  return result;
}

export function buildProfileCountMap<T extends { today: number }>(
  counts: Record<string, number>,
  runtimeMap: ReadonlyMap<string, T>,
  makeIdle: (today: number) => T,
  mergeToday: (persisted: number | undefined, live: number) => number = (p, l) => p ?? l,
): Record<string, T> {
  const out: Record<string, T> = Object.fromEntries(
    Object.entries(counts).map(([id, today]) => [id, makeIdle(today)]),
  );
  for (const [id, stat] of runtimeMap)
    out[id] = { ...stat, today: mergeToday(counts[id], stat.today) };
  return out;
}

export async function acquireConcurrencySlot(options: {
  isFull: () => boolean;
  isAborted: () => boolean;
  onQueued?: () => void;
  waitStep: () => Promise<void>;
  acquire: () => void;
}): Promise<boolean> {
  let queued = false;
  while (options.isFull()) {
    if (options.isAborted()) return false;
    if (!queued) {
      queued = true;
      options.onQueued?.();
    }
    await options.waitStep();
  }
  if (options.isAborted()) return false;
  options.acquire();
  return true;
}

export async function awaitWorkersSettled(
  promises: ReadonlyArray<Promise<void> | undefined>,
  timeoutMs?: number,
): Promise<void> {
  const pending = promises.filter((p): p is Promise<void> => p !== undefined);
  if (!pending.length) return;
  if (timeoutMs !== undefined && timeoutMs > 0)
    await Promise.race([Promise.allSettled(pending), sleepMs(timeoutMs)]);
  else await Promise.allSettled(pending);
}

export async function persistProfileTaskResult(
  saveFn: ((result: ProfileTaskResultValue) => Awaitable<void>) | undefined,
  result: ProfileTaskResultValue,
): Promise<void> {
  if (!saveFn) return;
  try {
    await saveFn(result);
  } catch {
    /* ignore persistence errors during worker finalization */
  }
}

export function recordPostBumpFailure(
  port: PostBumpRecordsPort | undefined,
  input: Parameters<PostBumpRecordsPort['insert']>[0],
): void {
  if (port) void ignoreError(port.insert(input));
}

export async function launchOfflineProfileInSlot(
  profileId: string,
  profileLifecycle: ProfileLifecyclePort | undefined,
  workboard: Workboard,
  signal: AbortSignal,
  isReady: (id: string) => Awaitable<boolean>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!profileLifecycle) return { ok: true };
  const res = await workboard.launchPermits.run(signal, () =>
    profileLifecycle.ensureProfilesOnline([profileId]),
  );
  const fail = res.failed.find((f) => f.profileId === profileId);
  if (fail || !(await isReady(profileId)))
    return { ok: false, reason: `跳过：${fail?.reason ?? '浏览器启动后未就绪'}` };
  return { ok: true };
}

export async function runTrackedScheduledWorker<T>(
  workers: Map<string, Promise<unknown>>,
  profileId: string,
  work: Promise<T>,
): Promise<T> {
  workers.set(profileId, work);
  try {
    return await work;
  } finally {
    if (workers.get(profileId) === work) workers.delete(profileId);
  }
}

export async function admitAndPlanBrowserLaunch(options: {
  launchCandidates: readonly string[];
  admitIds: () => Awaitable<readonly string[]>;
  moduleId: string;
  profileLifecycle?: ProfileLifecyclePort;
  featureExecution?: FeatureExecutionRegistry;
  isProfileReady: (id: string) => Awaitable<boolean>;
  isAlreadyRunningInCurrentModule: (id: string) => boolean;
  isProfileBusyInRunner: (id: string, pendingLaunchSet: ReadonlySet<string>) => Awaitable<boolean>;
  extraBusyLabels?: (id: string) => Awaitable<string[]>;
  onLaunchingOffline?: (count: number) => Awaitable<void>;
}): Promise<{
  pendingLaunchSet: Set<string>;
  launchFailureReasons: Map<string, string>;
  admission: ProfileStartAdmissionResult;
}> {
  const pendingLaunchSet = new Set<string>();
  const launchFailureReasons = new Map<string, string>();
  if (options.profileLifecycle && options.launchCandidates.length) {
    const offlineCandidates: string[] = [];
    for (const id of options.launchCandidates) {
      if (await options.isProfileReady(id)) continue;
      const busy = options.featureExecution
        ? await options.featureExecution.isProfileBusy(id, options.moduleId)
        : false;
      if (!busy && !(await options.isProfileBusyInRunner(id, new Set())))
        offlineCandidates.push(id);
    }
    if (offlineCandidates.length) {
      await options.onLaunchingOffline?.(offlineCandidates.length);
      const statuses =
        typeof options.profileLifecycle.getStatus === 'function'
          ? await options.profileLifecycle.getStatus(offlineCandidates)
          : [];
      const statusById = new Map(statuses.map((s) => [s.profileId, s]));
      for (const id of offlineCandidates) {
        const st = statusById.get(id);
        if (st && !st.online && !st.launchable)
          launchFailureReasons.set(id, `跳过：${st.reason ?? '未配置浏览器启动绑定'}`);
        else pendingLaunchSet.add(id);
      }
    }
  }
  const requestedProfileIds = await options.admitIds();
  const admission = requestedProfileIds.length
    ? await admitProfilesForStart({
        requestedProfileIds,
        currentModuleId: options.moduleId,
        isAlreadyRunningInCurrentModule: options.isAlreadyRunningInCurrentModule,
        busyModuleLabelsForProfile: async (id) => {
          const labels = options.featureExecution
            ? await options.featureExecution.busyModuleLabels([id], options.moduleId)
            : [];
          if (options.extraBusyLabels)
            for (const lbl of await options.extraBusyLabels(id))
              if (!labels.includes(lbl)) labels.push(lbl);
          return labels;
        },
        isProfileBusyInOtherModule: async (id) =>
          Boolean(
            options.featureExecution &&
            (await options.featureExecution.isProfileBusy(id, options.moduleId)),
          ) || Boolean(await options.isProfileBusyInRunner(id, pendingLaunchSet)),
        isProfileReady: async (id) =>
          Boolean(await options.isProfileReady(id)) || pendingLaunchSet.has(id),
      })
    : { admittedProfileIds: [], alreadyRunningIds: [], skippedBusy: [], skippedOffline: [] };
  return { pendingLaunchSet, launchFailureReasons, admission };
}

export async function ensureBrowserProfileOnline(
  profileId: string,
  isReady: () => Awaitable<boolean>,
  profileLifecycle?: ProfileLifecyclePort,
  onWaking?: () => void,
): Promise<boolean> {
  if (!(await isReady()) && profileLifecycle) {
    onWaking?.();
    await profileLifecycle.ensureProfilesOnline([profileId]);
  }
  return Boolean(await isReady());
}

export function pumpQueuedWorkers<TWork extends { targetId: string }>(options: {
  queue: TWork[];
  getCapacity: () => number;
  getActiveCount: () => number;
  incrementActive: () => void;
  decrementActive: () => void;
  isTargetActive: (targetId: string) => boolean;
  startWork: (work: TWork) => Promise<void>;
  onError: (work: TWork, error: unknown) => Promise<void>;
  onFinally: (work: TWork) => void;
}): void {
  const cap = Math.max(1, options.getCapacity());
  while (options.getActiveCount() < cap && options.queue.length) {
    const nextIdx = options.queue.findIndex((w) => !options.isTargetActive(w.targetId));
    if (nextIdx === -1) break;
    const [work] = options.queue.splice(nextIdx, 1);
    if (!work) break;
    options.incrementActive();
    void options
      .startWork(work)
      .catch((err: unknown) => options.onError(work, err))
      .finally(() => {
        options.decrementActive();
        options.onFinally(work);
      });
  }
}

export async function runConcurrentQueue<T>(
  items: readonly T[],
  concurrency: number,
  onItem: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
  onAbortedItem?: (item: T, index: number) => void,
): Promise<void> {
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
  const worker = async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx];
      if (item === undefined) continue;
      if (signal?.aborted) onAbortedItem?.(item, idx);
      else await onItem(item, idx);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
}

export function linkAbortSignal(external?: AbortSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(new Error('TASK_STOPPED'));
  if (external?.aborted) {
    controller.abort(new Error('TASK_STOPPED'));
    return { controller, abortedInitially: true, detach: () => {} };
  }
  external?.addEventListener('abort', onAbort, { once: true });
  return {
    controller,
    abortedInitially: false,
    detach: () => external?.removeEventListener('abort', onAbort),
  };
}

export function extractRiskAbortReason(signal: AbortSignal, err: unknown): string | null {
  for (const v of [signal.reason, err]) {
    const m = v instanceof Error ? v.message : typeof v === 'string' ? v : '';
    if (m.startsWith('RISK_LIMIT_REACHED:')) return m.slice('RISK_LIMIT_REACHED:'.length);
  }
  return null;
}

export function formatAvatarRefreshSummary(
  res: BumperRefreshResult | void,
  unit = '项',
  fallback = '读取资料完成',
): string {
  if (!res) return fallback;
  return (
    `读取资料：已更新 ${res.updated} ${unit}` +
    (res.needsBrowser
      ? `，${res.needsBrowser} ${unit}需闲置已登录浏览器才能补齐（当前无可用闲置浏览器）`
      : '') +
    (res.failed ? `，${res.failed} ${unit}未能完整读取` : '') +
    (res.error ? `（${res.error}）` : '')
  );
}

export async function runTargetAvatarRefresh(options: {
  targets: BumperTarget[];
  refresh: (signal: AbortSignal) => Promise<BumperRefreshResult | void>;
  getAbort: () => AbortController | null;
  setAbort: (ctrl: AbortController | null) => void;
  setRefreshing: (active: boolean) => void;
  onResult: (res: BumperRefreshResult | void, aborted: boolean) => void;
  onError?: (err: unknown, aborted: boolean) => void;
  onFinally?: () => void;
  waitMs?: number;
  abortPreviousReason?: string;
}): Promise<void> {
  if (options.abortPreviousReason)
    options.getAbort()?.abort(new Error(options.abortPreviousReason));
  const abortController = new AbortController();
  options.setAbort(abortController);
  options.setRefreshing(true);
  const work = options
    .refresh(abortController.signal)
    .then((res) => options.onResult(res, abortController.signal.aborted))
    .catch((err: unknown) => options.onError?.(err, abortController.signal.aborted))
    .finally(() => {
      if (options.getAbort() === abortController) {
        options.setAbort(null);
        options.setRefreshing(false);
      }
      options.onFinally?.();
    });
  if (options.waitMs !== undefined && options.waitMs > 0)
    await Promise.race([work, sleepMs(options.waitMs)]);
}
