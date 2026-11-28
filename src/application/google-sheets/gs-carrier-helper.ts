import type { GoogleSheetLink } from '../../shared/google-sheets.js';
import { bsCarrierId } from '../bluestacks/bs-types.js';
import { ignoreError, linkAbortSignal } from '../module-worker-pool.js';
import { Workboard, isWorkAbortError } from '../workboard.js';
import {
  recordLinkPollFailure,
  requireLink,
  safeAppendSheetLog,
  updateActiveProfileStatus,
  wakeBrowserProfile,
  type GoogleSheetsContext,
} from './gs-context-and-library.js';
/** Shared poll-loop guard, runtime status initialization, error recording, and cleanup. */
export async function withSheetLinkPollRun(
  ctx: GoogleSheetsContext,
  runningSet: Set<string>,
  linkId: string,
  busySummary: string,
  scanningJobText: string,
  failureAction: string,
  failurePrefix: string,
  getFallbackNextPollAt: (link: GoogleSheetLink | null) => number,
  run: (activeLink: GoogleSheetLink) => Promise<{ summary: string }>,
): Promise<{ summary: string }> {
  if (runningSet.has(linkId)) return { summary: busySummary };
  runningSet.add(linkId);
  ctx.cancelledLinks.delete(linkId);
  let link: GoogleSheetLink | null = null;
  try {
    link = await requireLink(ctx, linkId);
    await ctx.repo.updateLinkRuntime(link.id, { activeJobText: scanningJobText, lastError: null });
    return await run(link);
  } catch (err) {
    await recordLinkPollFailure(
      ctx,
      link,
      getFallbackNextPollAt(link),
      failureAction,
      failurePrefix,
      err,
    );
    throw err;
  } finally {
    runningSet.delete(linkId);
    ctx.cancelledLinks.delete(linkId);
  }
}
/** Acquires and releases a Workboard carrier permit around a single soldier run. */
export async function runWithCarrierPermit(
  workboard: Workboard,
  options: {
    carrierKind: 'browser' | 'bluestacks';
    executorId: string;
    moduleId: string;
    swallowWorkAbort?: boolean;
  },
  work: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const permitCarrierId =
    options.carrierKind === 'bluestacks' ? bsCarrierId(options.executorId) : options.executorId;
  await workboard.runSoldier(
    {
      carrierId: permitCarrierId,
      carrierKind: options.carrierKind,
      moduleId: options.moduleId,
    },
    async (soldier) => {
      let releasePermit: (() => void) | undefined;
      try {
        releasePermit = await workboard.acquireCarrierPermit(
          options.carrierKind,
          permitCarrierId,
          soldier.signal,
        );
        await work(soldier.signal);
      } catch (err) {
        if (!options.swallowWorkAbort || !isWorkAbortError(err)) throw err;
      } finally {
        releasePermit?.();
      }
    },
  );
}
/** Links a BlueStacks abort controller to a soldier signal and cleans up registration on exit. */
export async function runWithLinkedBluestacksAbort<T>(
  ctx: GoogleSheetsContext,
  instanceId: string,
  signal: AbortSignal,
  work: (bluestacksSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const { controller, detach } = linkAbortSignal(signal);
  ctx.activeBluestacksAborts.set(instanceId, controller);
  try {
    return await work(controller.signal);
  } finally {
    detach();
    ctx.activeBluestacksAborts.delete(instanceId);
  }
}
export const isCarrierExecutionCancelled = (
  ctx: GoogleSheetsContext,
  linkId: string,
  executorId: string,
  signal?: AbortSignal,
): boolean =>
  Boolean(signal?.aborted) ||
  ctx.cancelledLinks.has(linkId) ||
  ctx.cancelledProfiles.has(executorId);
/** Wakes an offline Chrome profile under staggered launch control if needed. */
export async function ensureBrowserProfileOnline(
  ctx: GoogleSheetsContext,
  workboard: Workboard,
  linkId: string,
  profileId: string,
  isOnline: boolean,
  signal: AbortSignal,
): Promise<void> {
  if (isOnline || !ctx.deps.profileLifecycle) return;
  updateActiveProfileStatus(ctx, profileId, linkId, '正在唤醒浏览器…');
  const woke = await workboard.runStaggeredLaunch(signal, () =>
    wakeBrowserProfile(ctx, profileId, () =>
      isCarrierExecutionCancelled(ctx, linkId, profileId, signal),
    ),
  );
  if (!woke) throw new Error('离线浏览器未能按时唤醒上线（请检查启动路径绑定）');
}
export async function closeOfflineBrowserIfNeeded(
  ctx: GoogleSheetsContext,
  profileId: string,
  shouldClose: boolean,
): Promise<void> {
  if (shouldClose && ctx.deps.profileLifecycle)
    await ctx.deps.profileLifecycle.closeProfile(profileId).catch(() => {});
}
export function reportCarrierJobStatus(
  ctx: GoogleSheetsContext,
  linkId: string,
  executorId: string,
  activeJobText: string,
  profileStatusText: string,
): void {
  updateActiveProfileStatus(ctx, executorId, linkId, profileStatusText);
  void ignoreError(ctx.repo.updateLinkRuntime(linkId, { activeJobText }));
}
export const logSheetEvent = (
  ctx: GoogleSheetsContext,
  linkId: string | null,
  level: 'info' | 'warn' | 'error',
  action: string,
  summary: string,
) => safeAppendSheetLog(ctx, linkId, level, action, summary);
