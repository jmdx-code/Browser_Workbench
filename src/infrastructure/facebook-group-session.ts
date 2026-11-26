import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import {
  inferAbnormalScopeFromUrl,
  inferAbnormalStateFromCodeOrMessage,
  type GlobalAccountAbnormalReporter,
} from '../application/account-abnormal-reporter.js';
import type { Core, KernelProfileIdleInspection, Peer } from '../bridge/core.js';
import type { Awaitable } from '../domain/persistence.js';
import { classifyFacebookAbnormalUrl } from '../shared/facebook-browse-route.js';
import { extractFacebookGroupId } from '../shared/facebook-target-id.js';
import {
  isCompleteNumericId,
  isPlaceholderTargetName,
  type BumperScope,
} from '../shared/group-bumper.js';
import { kernelOperationPending } from '../shared/kernel-state.js';
import { sameNotice } from '../shared/settlement.js';
import { sameBinding, type Binding, type StopReceipt } from '../shared/task-execution.js';
import {
  dismissFeatureInterventionDialogIfPresent,
  readGroupInvitationState,
} from './group-inviter-effects.js';
import type { KernelBridge, KernelSummaryPort } from './kernel-bridge.js';
export type KernelInventory = Awaited<ReturnType<KernelSummaryPort['inventory']>>;
export type KernelOperationResolutionValue = {
  id: string;
  outcome: 'VERIFIED' | 'NOT_APPLIED' | 'ENDED_UNKNOWN';
  evidenceDigest: string;
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export interface GroupRedirectResolution {
  effectiveGroupId: string;
  canonicalGroupId: string | null;
  redirectedToCanonical: boolean;
}
export function parseFacebookJsonChunks(body: string): unknown[] | null {
  const text = body.trim().replace(/^for\s*\(;;\);\s*/, '');
  if (!text) return null;
  try {
    return [JSON.parse(text) as unknown];
  } catch {
    try {
      return text
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line.trim().replace(/^for\s*\(;;\);\s*/, '')) as unknown);
    } catch {
      return null;
    }
  }
}
export async function checkGroupPendingOrQuestions(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const pendingRx =
        /^(?:Cancel request|Requested|Membership pending|Pending|取消请求|取消申請|已请求|已申請|待审核|待審核|等待批准|တောင်းဆိုထားသည်|တောင်းဆိုမှုကို ပယ်ဖျက်ပါ|Đã yêu cầu|Hủy yêu cầu|Chờ phê duyệt)$/i;
      const questionRx =
        /Answer questions|Membership questions|回答问题|回答問題|入组问题|入群问题|社團問題|မေးခွန်းများဖြေဆိုရန်|Trả lời câu hỏi/i;
      const hasPending = Array.from(
        document.querySelectorAll<HTMLElement>('[role="button"], button'),
      ).some((b) => {
        const r = b.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const txt = (b.textContent ?? '').replace(/\s+/g, ' ').trim();
        const aria = (b.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim();
        return (
          (txt.length > 0 && txt.length <= 40 && pendingRx.test(txt)) ||
          (aria.length > 0 && aria.length <= 40 && pendingRx.test(aria))
        );
      });
      const hasQuestions = Array.from(
        document.querySelectorAll<HTMLElement>('[role="dialog"]'),
      ).some((d) => {
        const r = d.getBoundingClientRect();
        return r.width > 120 && r.height > 100 && questionRx.test(d.textContent ?? '');
      });
      return hasPending || hasQuestions;
    })
    .catch(() => false);
}
export async function reportGlobalRouteAbnormalIfNeeded(input: {
  profileId: string;
  page: Page | undefined;
  kernel: KernelBridge | undefined;
  onAccountAbnormal?: GlobalAccountAbnormalReporter;
  error: unknown;
  fallbackScope?: 'global_route' | 'feature_action';
  fallbackState?: 'logged-out' | 'verification' | 'restricted';
}): Promise<void> {
  const { profileId, page, kernel, onAccountAbnormal, error, fallbackScope, fallbackState } = input;
  if (!page) return;
  await kernel?.observeExternalPageAccount?.(profileId, page, null)?.catch(() => {});
  let currentUrl = '';
  try {
    currentUrl = page.url();
  } catch {}
  const scope = inferAbnormalScopeFromUrl(currentUrl) ?? fallbackScope;
  if (scope !== 'global_route') return;
  const reason = error instanceof Error ? error.message : String(error ?? '');
  const state =
    inferAbnormalStateFromCodeOrMessage(classifyFacebookAbnormalUrl(currentUrl) ?? reason) ??
    fallbackState ??
    'restricted';
  await onAccountAbnormal?.({ profileId, scope: 'global_route', state, reason });
}
export interface SharedReconnectingStopTarget {
  stopRequestId?: string;
  close: (id: string) => Promise<unknown>;
  retryClose: (id: string) => Promise<unknown>;
  stopOnCloseFailure?: () => Promise<unknown>;
  closeLocalAfterDisconnect: () => Promise<unknown>;
  confirmReconnectedStop: (
    receipt: Pick<StopReceipt, 'profileId' | 'connectionEpoch' | 'requestId' | 'state'>,
  ) => Promise<unknown>;
}
export async function stopOwnedConnectionWithReconnect(input: {
  profileId: string;
  connection: SharedReconnectingStopTarget;
  stopId: string;
  failed: boolean;
  peerEpoch: string;
  kernel: KernelBridge | undefined;
  core: Core | undefined;
  errorPrefix: string;
  setFailed?: () => void;
  setStopId?: (nextId: string) => void;
  onBeforeConfirmStop?: (peer: Peer) => Promise<void>;
  verifyInventoryBeforeStop?: (inventory: KernelInventory) => void;
  onAfterConfirmStop?: (port: KernelSummaryPort) => Promise<void>;
}): Promise<void> {
  const {
    profileId,
    connection,
    stopId,
    failed,
    peerEpoch,
    kernel,
    core,
    errorPrefix,
    setFailed,
    setStopId,
    onBeforeConfirmStop,
    verifyInventoryBeforeStop,
    onAfterConfirmStop,
  } = input;
  const peer = core?.peers.get(profileId),
    awaitReconnect = async () => {
      await connection.closeLocalAfterDisconnect().catch(() => {});
      setFailed?.();
      throw Error(`${errorPrefix}_STOP_AWAITING_RECONNECT`);
    };
  try {
    if (core && (!peer || !peer.online || !peer.synced)) await awaitReconnect();
    if (kernel && peer && peer.epoch !== peerEpoch) {
      if (peer.phase !== 'PAUSED') {
        await core?.reconcileRecoveringPeerIfPossible?.(profileId).catch(() => false);
      }
      if (peer.phase !== 'PAUSED') await awaitReconnect();
      await connection.closeLocalAfterDisconnect();
      await onBeforeConfirmStop?.(peer);
      await kernel.withSummary(peer, async (port) => {
        if (verifyInventoryBeforeStop) verifyInventoryBeforeStop(await port.inventory());
        const receipt = await port.stopCurrent(stopId);
        if (
          receipt.requestId !== stopId ||
          receipt.connectionEpoch !== peer.epoch ||
          receipt.state !== 'stopped'
        )
          throw Error(`${errorPrefix}_STOP_UNCONFIRMED`);
        await connection.confirmReconnectedStop(receipt);
        await onAfterConfirmStop?.(port);
      });
    } else {
      try {
        await (failed ? connection.retryClose(stopId) : connection.close(stopId));
      } catch (err) {
        if (!failed) setFailed?.();
        if (typeof connection.stopOnCloseFailure !== 'function') throw err;
        await connection.stopOnCloseFailure();
        const retryId = connection.stopRequestId ?? stopId;
        setStopId?.(retryId);
        await connection.retryClose(retryId);
      }
    }
  } catch (err) {
    setFailed?.();
    throw err;
  }
}
export async function assertFacebookPageIdentityReady(input: {
  page: Page;
  peer: Peer;
  kernel: KernelBridge;
  accountId: string;
  proof: Parameters<KernelBridge['revealOwnedFacebookPage']>[1] | undefined;
  backgroundAllowed: boolean;
  guard: () => Awaitable<void>;
  onVerificationRequired: () => Error;
  onAccountChanged: () => Error;
  onTimeout: (visible: boolean) => Error;
}): Promise<void> {
  const {
    page,
    peer,
    kernel,
    accountId,
    proof,
    backgroundAllowed,
    guard,
    onVerificationRequired,
    onAccountChanged,
    onTimeout,
  } = input;
  await guard();
  let state = await readGroupInvitationState(page, guard);
  const deadline = Date.now() + 15000;
  let revealed = false;
  while (
    !state.ready ||
    state.accountId === null ||
    (!state.visible && !(backgroundAllowed && revealed))
  ) {
    if (state.accountId !== null && state.accountId !== accountId) throw onAccountChanged();
    if (state.verificationRequired) {
      await dismissFeatureInterventionDialogIfPresent(page, guard);
      state = await readGroupInvitationState(page, guard);
    }
    if (state.verificationRequired) throw onVerificationRequired();
    if (!state.visible && !revealed && proof) {
      revealed = true;
      await kernel.revealOwnedFacebookPage(peer, proof, false);
    }
    if (Date.now() >= deadline) throw onTimeout(state.visible);
    await guard();
    await sleep(250);
    state = await readGroupInvitationState(page, guard);
  }
  if (state.verificationRequired) {
    await dismissFeatureInterventionDialogIfPresent(page, guard);
    state = await readGroupInvitationState(page, guard);
  }
  if (state.verificationRequired) throw onVerificationRequired();
  if (state.accountId !== accountId) throw onAccountChanged();
  await guard();
}
export async function recoverKernelModuleOperations<
  TRow extends {
    binding: Binding;
    actionKind: string;
    status: string;
    resolution?: KernelOperationResolutionValue | null | undefined;
  },
>(input: {
  kernel: KernelBridge;
  peer: Peer;
  guard: () => Awaitable<void>;
  listOperations: () => Awaitable<TRow[]>;
  matchLegacySetupKind: (binding: Binding) => string | null;
  prepareLegacyRow: (binding: Binding, actionKind: string) => Awaitable<TRow>;
  isSettled: (row: TRow) => boolean;
  markSettled: (operationId: string) => Awaitable<void>;
  setResolution: (
    operationId: string,
    resolution: KernelOperationResolutionValue,
  ) => Awaitable<KernelOperationResolutionValue | null | undefined>;
  digest: (value: unknown) => string;
  shouldCreateResolution: (row: TRow, state: string) => boolean;
  getNotifyBinding?: (row: TRow, opBinding: Binding) => Binding;
  onBeforeSubmitResolution?: (row: TRow, operationId: string) => Awaitable<void>;
  resolutionReason: (row: TRow) => string;
}): Promise<ReadonlySet<string>> {
  const protectedIds = new Set<string>();
  const rows = await input.listOperations();
  const known = new Map(rows.map((row) => [row.binding.operationId, row]));
  const inventory = await input.kernel.withSummary(input.peer, (port) => port.inventory());
  const archived = input.kernel.archivedOperations
    ? await input.kernel.archivedOperations(input.peer.profileId, [...known.keys()])
    : [];
  const nativeIds = new Set(inventory.operations.map((row) => row.binding.operationId));
  for (const op of [
    ...inventory.operations,
    ...archived.filter((row) => !nativeIds.has(row.binding.operationId)),
  ]) {
    await input.guard();
    let row = known.get(op.binding.operationId);
    if (!row && kernelOperationPending(op) && ['ACKNOWLEDGED', 'UNKNOWN'].includes(op.state)) {
      const actionKind =
        op.binding.profileId === input.peer.profileId
          ? input.matchLegacySetupKind(op.binding)
          : null;
      if (!actionKind) continue;
      row = await input.prepareLegacyRow(op.binding, actionKind);
    }
    if (!row || !sameBinding(row.binding, op.binding) || input.isSettled(row)) continue;
    const notifyBinding = input.getNotifyBinding
      ? input.getNotifyBinding(row, op.binding)
      : op.binding;
    if (op.resolution || op.disposition) {
      const savedResolution = row.resolution;
      if (
        savedResolution &&
        [op.resolution, op.disposition].some(
          (res) =>
            res &&
            sameNotice(
              { binding: notifyBinding, resolution: res },
              { binding: row.binding, resolution: savedResolution },
            ),
        )
      )
        await input.markSettled(op.binding.operationId);
      continue;
    }
    if (!kernelOperationPending(op)) continue;
    let resolution: KernelOperationResolutionValue | null | undefined = row.resolution;
    if (input.shouldCreateResolution(row, op.state)) {
      await input.onBeforeSubmitResolution?.(row, op.binding.operationId);
      resolution = await input.setResolution(op.binding.operationId, {
        id: randomUUID(),
        outcome: 'ENDED_UNKNOWN',
        evidenceDigest: input.digest({
          binding: notifyBinding,
          reason: input.resolutionReason(row),
        }),
      });
    }
    if (!resolution) continue;
    const savedResolution = resolution;
    await input.kernel.withSummary(input.peer, async (port) => {
      try {
        await port.notify(notifyBinding, savedResolution);
      } catch (error) {
        if (
          savedResolution.outcome !== 'ENDED_UNKNOWN' ||
          !(error instanceof Error) ||
          error.message !== 'KERNEL_END_NOT_REQUIRED'
        )
          throw error;
        const current = (await port.inventory()).operations.find(
          (item) => item.binding.operationId === op.binding.operationId,
        );
        if (
          !current?.disposition ||
          !sameNotice(
            { binding: notifyBinding, resolution: savedResolution },
            { binding: current.binding, resolution: current.disposition },
          )
        )
          throw error;
      }
    });
    await input.guard();
    await input.markSettled(op.binding.operationId);
  }
  if (input.peer.capabilities?.includes('kernel-journal-collection-v1')) {
    const found = new Set(
      [...inventory.operations, ...archived].map((op) => op.binding.operationId),
    );
    for (const row of known.values()) {
      if (found.has(row.binding.operationId)) continue;
      await input.guard();
      const resolution =
        row.resolution ??
        (await input.setResolution(row.binding.operationId, {
          id: randomUUID(),
          outcome: 'ENDED_UNKNOWN',
          evidenceDigest: input.digest({
            binding: row.binding,
            reason: 'Retired executor native receipt absent',
          }),
        }));
      if (resolution)
        await input.kernel.withSummary(input.peer, (port) => port.notify(row.binding, resolution));
      await input.markSettled(row.binding.operationId);
    }
  }
  return protectedIds;
}
export class FacebookGroupSessionHelper {
  static async waitPeerPaused(
    peer: Partial<Pick<Peer, 'phase' | 'synced'>>,
    guard: () => Awaitable<void>,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (
      let elapsed = 0;
      ((peer.phase !== undefined && peer.phase !== 'PAUSED') || peer.synced === false) &&
      elapsed < timeoutMs &&
      Date.now() < deadline;
      elapsed += 50
    ) {
      await sleep(50);
      await guard();
    }
  }
  static isTransientPrepareError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return /PREPARE_TIMEOUT|FACEBOOK_TASK_DOCUMENT_TIMEOUT|FACEBOOK_TASK_DOCUMENT_ERROR_PAGE|KERNEL_SCOPE_CHANGED|KERNEL_READ_FENCED|KERNEL_INITIAL_DOCUMENT_PENDING|BROWSER_OFFLINE|KERNEL_PROFILE_NOT_IDLE|KERNEL_PEER_NOT_IDLE/i.test(
      msg,
    );
  }
  static async waitKernelProfileIdle(options: {
    inspectIdle: () => Awaitable<KernelProfileIdleInspection>;
    reconcileRecovering?: () => Awaitable<boolean>;
    guard: () => Awaitable<void>;
    timeoutMs?: number;
    clock?: { now?: () => number; sleep?: (ms: number) => Promise<void> };
  }): Promise<KernelProfileIdleInspection> {
    const now = options.clock?.now ?? Date.now;
    const waitFn = options.clock?.sleep ?? sleep;
    const deadline = now() + (options.timeoutMs ?? 12_000);
    let lastReason: KernelProfileIdleInspection['reason'] = 'IDLE';
    let reconcileAttempted = false;
    while (now() < deadline) {
      await options.guard();
      const status = await options.inspectIdle();
      if (status.idle) return status;
      lastReason = status.reason;
      if (status.reason === 'UNRESOLVED_BRIDGE_COMMANDS')
        throw Error('浏览器存在待复核的历史桥接指令（UNRESOLVED_BRIDGE_COMMANDS）');
      if (
        !reconcileAttempted &&
        options.reconcileRecovering &&
        (status.reason === 'UNRESOLVED_LEGACY_FIXTURE' ||
          status.reason === 'RECOVERING_CONTROL_OR_SYNC')
      ) {
        reconcileAttempted = true;
        await options.reconcileRecovering();
      }
      await waitFn(100);
    }
    throw Error(`等待浏览器空闲超时（${lastReason}）`);
  }
  static async syncCanonicalGroupRedirect(input: {
    currentUrl: string;
    rawGroupId: string;
    groupName?: string | null;
    avatarUrl?: string | null;
    surfaceGroupIds?: readonly string[];
    allowAliasRedirect?: boolean;
    applyResolvedMetadata?: (
      rawId: string,
      resolved: { canonicalId?: string | null; name?: string | null; avatarUrl?: string | null },
    ) => Awaitable<unknown>;
  }): Promise<GroupRedirectResolution> {
    const rawId = input.rawGroupId.trim();
    let extracted = '';
    try {
      const parsed = new URL(input.currentUrl);
      if (parsed.origin === 'https://www.facebook.com' && parsed.pathname.startsWith('/groups/'))
        extracted = extractFacebookGroupId(input.currentUrl);
    } catch {}
    const surfaceNumeric = (input.surfaceGroupIds ?? []).find((gid) => isCompleteNumericId(gid));
    const candidateCanonical = isCompleteNumericId(extracted) ? extracted : (surfaceNumeric ?? '');
    const canResolveAlias = input.allowAliasRedirect !== false && !isCompleteNumericId(rawId);
    const redirectedToCanonical = Boolean(
      canResolveAlias &&
      candidateCanonical &&
      candidateCanonical.toLowerCase() !== rawId.toLowerCase() &&
      isCompleteNumericId(candidateCanonical),
    );
    const effectiveGroupId = redirectedToCanonical ? candidateCanonical : rawId;
    const canonicalGroupId = isCompleteNumericId(effectiveGroupId) ? effectiveGroupId : null;
    if (
      input.applyResolvedMetadata &&
      (redirectedToCanonical ||
        Boolean(input.groupName && !isPlaceholderTargetName(input.groupName, effectiveGroupId)) ||
        Boolean(input.avatarUrl))
    ) {
      await input.applyResolvedMetadata(rawId, {
        canonicalId: canonicalGroupId,
        name: input.groupName ?? null,
        avatarUrl: input.avatarUrl ?? null,
      });
    }
    return { effectiveGroupId, canonicalGroupId, redirectedToCanonical };
  }
}
export class InFlightBumperCoordinator {
  private readonly activeAccountPosts = new Set<string>();
  private readonly inFlightQuotaByAccountScope = new Map<string, number>();
  private postKey(actingAccountId: string, postId: string): string {
    return `${actingAccountId.trim()}::${postId.trim()}`;
  }
  private quotaKey(actingAccountId: string, sourceMode: BumperScope = 'group'): string {
    return `${actingAccountId.trim()}::${sourceMode}`;
  }
  tryAcquirePost(actingAccountId: string, postId: string): boolean {
    const key = this.postKey(actingAccountId, postId);
    if (this.activeAccountPosts.has(key)) return false;
    this.activeAccountPosts.add(key);
    return true;
  }
  releasePost(actingAccountId: string, postId: string): void {
    this.activeAccountPosts.delete(this.postKey(actingAccountId, postId));
  }
  tryReserveDailyQuota(
    actingAccountId: string,
    sourceMode: BumperScope,
    dbTodayCount: number,
    dailyMaxLikesPerAccount: number,
  ): boolean {
    const key = this.quotaKey(actingAccountId, sourceMode);
    const currentInFlight = this.inFlightQuotaByAccountScope.get(key) ?? 0;
    if (dbTodayCount + currentInFlight >= dailyMaxLikesPerAccount) return false;
    this.inFlightQuotaByAccountScope.set(key, currentInFlight + 1);
    return true;
  }
  releaseDailyQuota(actingAccountId: string, sourceMode: BumperScope = 'group'): void {
    const key = this.quotaKey(actingAccountId, sourceMode);
    const current = this.inFlightQuotaByAccountScope.get(key) ?? 0;
    if (current <= 1) this.inFlightQuotaByAccountScope.delete(key);
    else this.inFlightQuotaByAccountScope.set(key, current - 1);
  }
}
