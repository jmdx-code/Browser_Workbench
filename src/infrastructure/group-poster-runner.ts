import { randomUUID } from 'node:crypto';
import type { GlobalAccountAbnormalReporter } from '../application/account-abnormal-reporter.js';
import {
  PosterAccountRestrictedError,
  type GroupPosterBrowserCallbacks,
  type GroupPosterBrowserPort,
} from '../application/group-poster-service.js';
import type { Core } from '../bridge/core.js';
import type { CompatibleRepository } from '../domain/persistence.js';
import { devDiag } from '../shared/dev-diagnostics.js';
import { PAGE_TIMELINE_SYNTHETIC_GROUP_ID } from '../shared/google-sheets.js';
import { stripAnsi, type PosterActionKind, type PosterSettings } from '../shared/group-poster.js';
import { kernelOperationPending } from '../shared/kernel-state.js';
import type { Binding } from '../shared/task-execution.js';
import {
  assertFacebookPageIdentityReady,
  FacebookGroupSessionHelper,
  reportGlobalRouteAbnormalIfNeeded,
} from './facebook-group-session.js';
import { prepareFacebookWorkspace } from './facebook-workspace-preparation.js';
import { recoverBumperOperations } from './group-bumper-recovery.js';
import type { SqliteGroupBumperRepository } from './group-bumper-store.js';
import {
  openAndFillPosterComposer,
  preparePosterTargetSurface,
} from './group-poster-runner/poster-flow.js';
import { FilesystemPosterMediaPreparer } from './group-poster-runner/poster-media-preparer.js';
import { waitMediaAndSubmitPost } from './group-poster-runner/poster-publish.js';
import {
  dismissPosterDialogsOnError,
  extractCreatedGroupPostIdFromGraphQL,
  posterDigest,
  posterSetupKinds,
  posterSetupLabels,
  readPosterIdentityMeta,
  recoverPosterOperations,
  resolvePosterPendingApprovalState,
  stopPosterConnection,
  type PosterClosingRecord,
  type PosterConnection,
  type PosterOpContext,
} from './group-poster-runner/poster-support.js';
import type { SqliteGroupPosterRepository } from './group-poster-store.js';
import type { KernelBridge } from './kernel-bridge.js';
export {
  extractCreatedGroupPostIdFromGraphQL,
  FilesystemPosterMediaPreparer,
  PosterAccountRestrictedError,
  posterDigest,
  posterSetupKinds,
  posterSetupLabels,
  recoverPosterOperations,
  resolvePosterPendingApprovalState,
};
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export class GroupPosterBrowserAdapter implements GroupPosterBrowserPort {
  private readonly connections = new Map<string, PosterConnection>();
  private readonly closing = new Map<string, PosterClosingRecord>();
  private readonly stopWorks = new WeakMap<PosterConnection, Promise<void>>();
  constructor(
    private readonly bumperRepo: CompatibleRepository<SqliteGroupBumperRepository>,
    private readonly getKernel: () => KernelBridge | undefined,
    private readonly getCore: () => Core | undefined,
    private readonly isBusy: (profileId: string) => Promise<boolean> = async () => false,
    private readonly paceScale = 1,
    private readonly posterRepo?: CompatibleRepository<SqliteGroupPosterRepository>,
    private onAccountAbnormal?: GlobalAccountAbnormalReporter,
  ) {}
  ready = (profileId: string) => {
    const peer = this.getCore()?.peers.get(profileId);
    return !!this.getKernel() && !!peer?.online && peer.synced && !this.connections.has(profileId);
  };
  hasPendingReconnectStop = (profileId: string) => {
    const staleStop = this.closing.get(profileId);
    const peer = this.getCore()?.peers.get(profileId);
    return Boolean(staleStop?.failed && (!peer || !peer.online || !peer.synced));
  };
  onlineProfileIds(): string[] {
    const core = this.getCore();
    if (!core || !this.getKernel()) return [];
    return Array.from(core.peers.entries())
      .filter(([, p]) => p.online && p.synced)
      .map(([id]) => id);
  }
  async busy(profileId: string): Promise<boolean> {
    const staleStop = this.closing.get(profileId);
    const livePeer = this.getCore()?.peers.get(profileId);
    if (staleStop?.failed && livePeer?.online && livePeer.synced)
      await this.stop(profileId).catch(() => {});
    if (this.connections.has(profileId) || (await this.isBusy(profileId))) return true;
    const kernel = this.getKernel();
    const peer = this.getCore()?.peers.get(profileId);
    if (!kernel || !peer?.online || !peer.synced) return false;
    try {
      await recoverBumperOperations(kernel, peer, this.bumperRepo, () => {});
      if (this.posterRepo) await recoverPosterOperations(kernel, peer, this.posterRepo, () => {});
      return (await kernel.withSummary(peer, (port) => port.inventory())).operations.some(
        kernelOperationPending,
      );
    } catch {
      return false;
    }
  }
  async stop(profileId: string): Promise<void> {
    const conn = this.connections.get(profileId);
    if (!conn) return;
    const existingStop = this.stopWorks.get(conn);
    if (existingStop) return existingStop;
    const stopRec = this.closing.get(profileId);
    const stopId = stopRec?.id ?? conn.stopRequestId ?? randomUUID();
    conn.revokeInput?.('POSTER_STOP');
    const work = stopPosterConnection({
      profileId,
      conn,
      stopRec,
      stopId,
      kernel: this.getKernel(),
      core: this.getCore(),
      posterRepo: this.posterRepo,
      connections: this.connections,
      closing: this.closing,
    }).finally(() => {
      if (this.stopWorks.get(conn) === work) this.stopWorks.delete(conn);
    });
    this.stopWorks.set(conn, work);
    return work;
  }
  async runProfileWorker(
    profileId: string,
    files: readonly string[],
    _settings: PosterSettings,
    callbacks: GroupPosterBrowserCallbacks,
  ): Promise<void> {
    const kernel = this.getKernel();
    const core = this.getCore();
    const peer = core?.peers.get(profileId);
    if (!kernel || !peer || !peer.online || !peer.synced) throw Error('浏览器未连接或未就绪');
    const epoch = peer.epoch;
    const guard = () => {
      if (callbacks.cancelled()) throw Error('已手动停止');
      if (
        core?.peers.get(profileId) !== peer ||
        peer.epoch !== epoch ||
        !peer.online ||
        !peer.synced
      )
        throw Error('浏览器连接已断开');
    };
    const recoverAll = async (g: () => void) => {
      await recoverBumperOperations(kernel, peer, this.bumperRepo, g);
      if (this.posterRepo) await recoverPosterOperations(kernel, peer, this.posterRepo, g);
    };
    callbacks.status('正在整理浏览器工作区…');
    await recoverAll(guard);
    const prepared = await prepareFacebookWorkspace(
      kernel,
      peer,
      undefined,
      guard,
      undefined,
      true,
    ).catch(async (prepErr) => {
      if (!FacebookGroupSessionHelper.isTransientPrepareError(prepErr)) throw prepErr;
      await wait(Math.max(10, Math.round(500 * this.paceScale)));
      guard();
      return prepareFacebookWorkspace(kernel, peer, undefined, guard, undefined, true);
    });
    if (prepared.inventory.operations.some(kernelOperationPending)) await recoverAll(guard);
    callbacks.status('读取当前登录账号/专页身份…');
    await FacebookGroupSessionHelper.waitPeerPaused(peer, guard, 10_000);
    const identity =
      (await kernel.inspectIdleFacebookPage(peer, guard, false, true)) ??
      (await kernel.inspectFacebookIdentity(peer, guard, true, prepared.proof, true, false, false));
    guard();
    const accountId = identity.actor.accountId;
    const accountName = identity.actor.name ?? accountId;
    if (this.connections.has(profileId) || this.closing.has(profileId)) await this.stop(profileId);
    const grantedFiles = new Set<string>(files);
    let currentConn: PosterConnection | undefined;
    const registerConnection = async (nextConn: PosterConnection) => {
      currentConn = nextConn;
      const stopRec: PosterClosingRecord = {
        id: nextConn.stopRequestId ?? randomUUID(),
        failed: false,
        peerEpoch: epoch,
        leaseId: '',
        ownershipId: nextConn.proof?.ownershipId,
        connection: nextConn,
      };
      this.connections.set(profileId, nextConn);
      this.closing.set(profileId, stopRec);
      const leaseId = (await nextConn.context(accountId).catch(() => null))?.leaseId ?? '';
      if (this.closing.get(profileId) === stopRec) stopRec.leaseId = leaseId;
    };
    try {
      let conn = await kernel.connectFacebook(peer, accountId, guard, identity.proof, false, [
        ...grantedFiles,
      ]);
      await registerConnection(conn);
      const initialPage = conn.browser.contexts()[0]?.pages()[0];
      if (!initialPage) throw Error('任务页面不存在');
      let page = initialPage;
      const getPage = () => page;
      const getConn = () => conn;
      const backgroundAllowed =
        peer.capabilities?.includes('kernel-background-presentation-v1') === true ||
        conn.taskRendering === true;
      let avatarObservedOnce = false;
      const assertIdentity = async () => {
        await assertFacebookPageIdentityReady({
          page,
          peer,
          kernel,
          accountId,
          proof: identity.proof,
          backgroundAllowed,
          guard,
          onVerificationRequired: () =>
            new PosterAccountRestrictedError('受限 · 需要手机验证或操作受限'),
          onAccountChanged: () =>
            new PosterAccountRestrictedError('登录身份已变化，已停止该账号发帖'),
          onTimeout: () => Error('页面未就绪或不可见'),
        });
        if (!avatarObservedOnce) {
          avatarObservedOnce = true;
          await kernel
            .observeExternalPageAccount?.(profileId, page, identity.actor)
            ?.catch(() => {});
        }
      };
      const jobId = randomUUID();
      const stepId = randomUUID();
      let currentContext: PosterOpContext = { groupId: '', groupName: '', materialId: '' };
      const reconnectAfterUncertainOp = async () => {
        await this.stop(profileId);
        guard();
        if (this.posterRepo) await recoverPosterOperations(kernel, peer, this.posterRepo, guard);
        const ready = await prepareFacebookWorkspace(
          kernel,
          peer,
          identity.proof,
          guard,
          undefined,
          true,
        );
        conn = await kernel.connectFacebook(peer, accountId, guard, ready.proof, false, [
          ...grantedFiles,
        ]);
        await registerConnection(conn);
        const replacementPage = conn.browser.contexts()[0]?.pages()[0];
        if (!replacementPage) throw Error('任务页面不存在');
        page = replacementPage;
      };
      const execOp = async <T>(
        label: (typeof posterSetupLabels)[number],
        work: () => Promise<T>,
      ): Promise<T> => {
        await assertIdentity();
        const ctx = await conn.context(accountId);
        if (!ctx) throw Error('账号控制上下文已失效');
        const operationId = randomUUID();
        const idx = posterSetupLabels.indexOf(label);
        const actionKind: PosterActionKind =
          idx >= 0 ? (posterSetupKinds[idx] ?? 'setup_open_group') : 'setup_open_group';
        const binding: Binding = {
          ...ctx,
          operationId,
          jobId,
          stepId,
          actionDigest: posterDigest({ purpose: 'group-poster', actionKind, label, accountId }),
        };
        if (this.posterRepo)
          await this.posterRepo.prepareOperation({
            binding,
            runId: callbacks.runId,
            actionKind,
            groupId: currentContext.groupId,
            groupName: currentContext.groupName,
            materialId: currentContext.materialId || undefined,
          });
        const countMutations = () =>
          Object.values(conn.nativeMutationCalls ?? {}).reduce((n, c) => n + c, 0);
        const before = countMutations();
        type Attempt = { ok: true; value: T } | { ok: false; error: unknown };
        let executed: Awaited<ReturnType<typeof conn.execute<Attempt>>> | null = null;
        let execThrown: unknown = null;
        try {
          executed = await conn.execute<Attempt>(
            binding,
            async () => {
              try {
                return { ok: true, value: await work() };
              } catch (error) {
                return { ok: false, error };
              }
            },
            assertIdentity,
            () => this.stop(profileId),
          );
        } catch (err) {
          execThrown = err;
        }
        const settleOp = async (outcome: 'VERIFIED' | 'NOT_APPLIED', reconcile: boolean) => {
          const resolution = {
            id: randomUUID(),
            outcome,
            evidenceDigest: posterDigest({ binding, label, ok: outcome === 'VERIFIED' }),
          };
          await this.posterRepo?.setOperationResolution(operationId, resolution);
          if (!reconcile) return false;
          await conn.reconcile(binding, resolution);
          await this.posterRepo?.markOperationKernelSettled(operationId);
          return true;
        };
        if (executed?.value.ok) {
          await settleOp('VERIFIED', true);
          return executed.value.value;
        }
        const failureError = executed && !executed.value.ok ? executed.value.error : execThrown;
        const sessionAlive =
          this.connections.get(profileId) === conn && Boolean(peer.online && peer.synced);
        if (executed && countMutations() === before && sessionAlive) {
          try {
            await settleOp('NOT_APPLIED', true);
          } catch {
            await reconnectAfterUncertainOp();
          }
        } else {
          await settleOp('NOT_APPLIED', false);
          await reconnectAfterUncertainOp();
        }
        throw failureError ?? Error(`${label}执行失败`);
      };
      const paceWait = async (ms: number) => {
        const scaled = Math.max(10, Math.round(ms * this.paceScale));
        for (let elapsed = 0; elapsed < scaled; elapsed += 100) {
          guard();
          await wait(Math.min(100, scaled - elapsed));
        }
      };
      await assertIdentity();
      const identityMeta = await readPosterIdentityMeta(page, accountId);
      let consecutiveGroupComposerFailures = 0;
      while (!callbacks.cancelled() && (await callbacks.canContinueAccount(profileId))) {
        const task = await callbacks.claimNextTask();
        if (!task) break;
        const { group, material } = task;
        const rawGroupId = group.id;
        const isPageTimeline = rawGroupId === PAGE_TIMELINE_SYNTHETIC_GROUP_ID;
        let effectiveGroupId = isPageTimeline ? accountId : group.id;
        let effectiveGroupName = isPageTimeline ? accountName || '专页时间线' : group.name;
        currentContext = {
          groupId: effectiveGroupId,
          groupName: effectiveGroupName,
          materialId: material.id,
        };
        const markedPendingReviewRef = { value: false };
        try {
          if (material.localFilePath && !grantedFiles.has(material.localFilePath)) {
            grantedFiles.add(material.localFilePath);
            await reconnectAfterUncertainOp();
          }
          const baseArgs = {
            getPage,
            accountId,
            isPageTimeline,
            identityMeta,
            paceScale: this.paceScale,
            callbacks,
            guard,
            execOp,
          };
          const setupResult = await preparePosterTargetSurface({
            ...baseArgs,
            rawGroupId,
            initialEffectiveGroupId: effectiveGroupId,
            initialEffectiveGroupName: effectiveGroupName,
            groupAvatarUrl: group.avatarUrl,
            bumperRepo: this.bumperRepo,
            paceWait,
            updateContext: (patch) => {
              currentContext = { ...currentContext, ...patch };
            },
          });
          if (setupResult.status === 'skipped') continue;
          effectiveGroupId = setupResult.effectiveGroupId;
          effectiveGroupName = setupResult.effectiveGroupName;
          await openAndFillPosterComposer({
            ...baseArgs,
            groupDisplayName: group.name,
            effectiveGroupName,
            material,
          });
          await waitMediaAndSubmitPost({
            ...baseArgs,
            profileId,
            getConn,
            peer,
            kernel,
            core,
            accountName,
            jobId,
            stepId,
            effectiveGroupId,
            effectiveGroupName,
            groupAvatarUrl: group.avatarUrl,
            resolvedGroupAvatar: setupResult.resolvedGroupAvatar,
            surface: setupResult.surface,
            material,
            posterRepo: this.posterRepo,
            markedPendingReviewRef,
            assertIdentity,
            stopProfile: () => this.stop(profileId),
            reconnectAfterUncertainOp,
          });
          if (!isPageTimeline) consecutiveGroupComposerFailures = 0;
          await paceWait(1800 + Math.floor(Math.random() * 1200));
        } catch (err) {
          await dismissPosterDialogsOnError(getPage(), this.paceScale);
          const msg = stripAnsi(err instanceof Error ? err.message : String(err));
          if (
            err instanceof PosterAccountRestrictedError ||
            this.connections.get(profileId) !== conn
          ) {
            if (!markedPendingReviewRef.value) callbacks.returnTaskOnRestriction(task);
            throw err instanceof Error ? err : Error(msg);
          }
          if (
            !isPageTimeline &&
            /发帖弹窗未打开|未开放发帖框|发帖弹窗中未找到文字输入框|发小组受限/i.test(msg) &&
            ++consecutiveGroupComposerFailures >= 2
          ) {
            callbacks.returnTaskOnRestriction(task);
            throw new PosterAccountRestrictedError(
              '发小组受限 · 连续多个小组无法打开发帖框，已自动停止发小组',
              { scope: 'feature_action' },
            );
          }
          callbacks.onTargetError?.(rawGroupId, msg);
          callbacks.status(
            `${isPageTimeline ? '专页时间线发布失败' : `跳过小组 ${effectiveGroupName}`} · ${msg.slice(0, 48)}`,
          );
          await paceWait(1000);
        }
      }
    } catch (outerErr) {
      const currentPage = currentConn?.browser.contexts()[0]?.pages()[0];
      if (currentPage) {
        if (outerErr instanceof PosterAccountRestrictedError)
          await reportGlobalRouteAbnormalIfNeeded({
            profileId,
            page: currentPage,
            kernel,
            onAccountAbnormal: this.onAccountAbnormal,
            error: outerErr,
            fallbackScope: outerErr.scope,
            fallbackState: outerErr.abnormalState,
          });
        else
          await kernel.observeExternalPageAccount?.(profileId, currentPage, null)?.catch(() => {});
      }
      throw outerErr;
    } finally {
      await this.stop(profileId).catch((stopErr) =>
        devDiag.emit('WARN', 'BRIDGE_WS', 'POSTER_STOP_FINALIZE_FAILED', {
          profileId,
          reason: stopErr instanceof Error ? stopErr.message : 'STOP_FAILED',
        }),
      );
      if (
        this.posterRepo &&
        core?.peers.get(profileId) === peer &&
        peer.online &&
        peer.synced &&
        peer.phase === 'PAUSED'
      )
        await recoverPosterOperations(kernel, peer, this.posterRepo, () => {}).catch(() => {});
    }
  }
}
