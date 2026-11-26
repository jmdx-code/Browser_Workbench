import type { GlobalAccountAbnormalReporter } from '../application/account-abnormal-reporter.js';
import type { BumperRunner } from '../application/group-bumper-service.js';
import type { Core, Peer } from '../bridge/core.js';
import type { CompatibleRepository } from '../domain/persistence.js';
import { devDiag } from '../shared/dev-diagnostics.js';
import type { BumperScope, BumperSettings, BumperTarget } from '../shared/group-bumper.js';
import {
  FacebookGroupSessionHelper,
  InFlightBumperCoordinator,
  reportGlobalRouteAbnormalIfNeeded,
  stopOwnedConnectionWithReconnect,
  type KernelInventory,
} from './facebook-group-session.js';
import { recoverBumperOperations } from './group-bumper-recovery.js';
import type { SqliteGroupBumperRepository } from './group-bumper-store.js';
import {
  BUMPER_DEBUGGER_CANCELED_MESSAGE,
  type BumperClosingEntry,
  type BumperConnection,
  BumperFatalError,
  type BumperGroupFeedContext,
  BumperGroupSkipped,
  BumperMetadataAccountError,
  BumperPostReadIncomplete,
  type BumperRunStats,
  BumperSetupUnconfirmed,
  type BumperSurface,
  canonicalBumperPageIdFromURL,
  claimBumperComment,
  confirmedBumperGraphQL,
  formatBumperDisconnectReason,
  isBumperDebuggerCanceledByUser,
  isBumperFatal,
  isBumperGraphQLRestricted,
  isBumperRecoverableDisconnectError,
  isRawDisconnectTechnicalError,
  normalizeBumperComment,
  observeBumperGraphql,
  observeBumperStoryShareGraphql,
  readBumperPageRedirect,
  sameBumperFeedbackId,
  verifyBumperPageAlias,
} from './group-bumper/bumper-core.js';
import { runBumperFeedsForGroup } from './group-bumper/bumper-feed-scanner.js';
import {
  createGroupSurfaceHelpers,
  enterBumperGroupSurface,
} from './group-bumper/bumper-group-setup.js';
import {
  centerBumperControl,
  closeBumperPostDialog,
  executeBumperOperation,
  isForeignPagePost,
  prepareBumperPost,
  requireBumperPost,
  revealBumperControlIfNeeded,
  type RequireBumperPostOptions,
  typeBumperComment,
} from './group-bumper/bumper-post-flow.js';
import { createBumperSessionRuntime } from './group-bumper/bumper-session.js';
import {
  refreshBumperTargetBatch,
  refreshBumperTargets,
  type TargetRefresherDeps,
} from './group-bumper/bumper-target-refresher.js';
import type { KernelBridge } from './kernel-bridge.js';
export {
  FacebookGroupSessionHelper,
  InFlightBumperCoordinator,
  BumperPostReadIncomplete,
  type RequireBumperPostOptions,
  requireBumperPost,
  closeBumperPostDialog,
  isBumperGraphQLRestricted,
  normalizeBumperComment,
  claimBumperComment,
  sameBumperFeedbackId,
  confirmedBumperGraphQL,
  observeBumperGraphql,
  observeBumperStoryShareGraphql,
  verifyBumperPageAlias,
  BumperFatalError,
  BumperSetupUnconfirmed,
  BumperMetadataAccountError,
  canonicalBumperPageIdFromURL,
  readBumperPageRedirect,
  BUMPER_DEBUGGER_CANCELED_MESSAGE,
  isBumperDebuggerCanceledByUser,
  formatBumperDisconnectReason,
  isBumperFatal,
  isBumperRecoverableDisconnectError,
  centerBumperControl,
  prepareBumperPost,
  revealBumperControlIfNeeded,
  typeBumperComment,
  executeBumperOperation,
  isForeignPagePost,
};
export class GroupBumperBrowserAdapter implements BumperRunner {
  private metadataPreferred?: { id: string; epoch: string };
  private metadataProfiles = new Set<string>();
  private connections = new Map<string, BumperConnection>();
  private stopWorks = new WeakMap<BumperConnection, Promise<void>>();
  private commentClaims = new Set<string>();
  private readonly inFlightCoordinator = new InFlightBumperCoordinator();
  private closing = new Map<string, BumperClosingEntry>();
  constructor(
    private readonly repo: CompatibleRepository<SqliteGroupBumperRepository>,
    private readonly kernel: () => KernelBridge | undefined,
    private readonly core: () => Core | undefined,
    private readonly isBusy: (id: string) => Promise<boolean>,
    private readonly paceScale = 1,
    private onAccountAbnormal?: GlobalAccountAbnormalReporter,
    private readonly clock?: { now?: () => number; sleep?: (ms: number) => Promise<void> },
  ) {}
  isReadingProfile(id: string) {
    return this.metadataProfiles.has(id);
  }
  hasMetadataReads() {
    return this.metadataProfiles.size > 0;
  }
  ready(id: string) {
    const p = this.core()?.peers.get(id);
    return !!p?.online && p.synced;
  }
  busy(id: string) {
    return this.isBusy(id);
  }
  hasControl(id: string) {
    return this.connections.has(id);
  }
  private refresherDeps(): TargetRefresherDeps {
    return {
      repo: this.repo,
      kernel: this.kernel,
      core: this.core,
      isBusy: this.isBusy,
      metadataProfiles: this.metadataProfiles,
      getMetadataPreferred: () => this.metadataPreferred,
      setMetadataPreferred: (val) => {
        this.metadataPreferred = val;
      },
      getOnAccountAbnormal: () => this.onAccountAbnormal,
    };
  }
  async refreshTargets(
    kind: 'groups' | 'pages',
    items: ReadonlyArray<Pick<BumperTarget, 'id' | 'name' | 'avatarUrl'>>,
    options?: Parameters<typeof refreshBumperTargets>[3],
  ) {
    return refreshBumperTargets(this.refresherDeps(), kind, items, options);
  }
  async refreshTargetBatch(
    kind: 'groups' | 'pages',
    items: BumperTarget[],
    options?: Parameters<typeof refreshBumperTargetBatch>[3],
  ) {
    return refreshBumperTargetBatch(this.refresherDeps(), kind, items, options);
  }
  async stop(id: string) {
    const connection = this.connections.get(id);
    if (!connection) return;
    connection.revokeInput('BUMPER_STOP');
    const previous = this.stopWorks.get(connection);
    if (previous) return previous;
    const work = this.finishStop(id);
    this.stopWorks.set(connection, work);
    try {
      await work;
    } finally {
      if (this.stopWorks.get(connection) === work) this.stopWorks.delete(connection);
    }
  }
  private async finishStop(id: string) {
    const connection = this.connections.get(id),
      stop = this.closing.get(id);
    if (!connection) return;
    if (!stop || stop.connection !== connection) throw Error('BUMPER_STOP_CONTEXT_MISSING');
    connection.revokeInput('BUMPER_STOP');
    const kernel = this.kernel(),
      core = this.core(),
      peer = core?.peers.get(id);
    if (!peer || !peer.online || !peer.synced) {
      await connection.closeLocalAfterDisconnect().catch(() => {});
      stop.failed = true;
      throw Error('BUMPER_STOP_AWAITING_RECONNECT');
    }
    await stopOwnedConnectionWithReconnect({
      profileId: id,
      connection,
      stopId: stop.id,
      failed: stop.failed,
      peerEpoch: stop.peerEpoch,
      kernel,
      core,
      errorPrefix: 'BUMPER',
      setFailed: () => {
        stop.failed = true;
      },
      setStopId: (nextId) => {
        stop.id = nextId;
      },
      onBeforeConfirmStop: kernel
        ? async (activePeer) => {
            await recoverBumperOperations(kernel, activePeer, this.repo, () => {
              if (
                this.core()?.peers.get(id) !== activePeer ||
                !activePeer.online ||
                !activePeer.synced
              )
                throw Error('BUMPER_RECOVERY_CHANGED');
            });
          }
        : undefined,
      verifyInventoryBeforeStop: (state: KernelInventory) => {
        if (
          state.tabs.some(
            (t) => t.ownershipId === stop.ownershipId && ['CREATING', 'UNKNOWN'].includes(t.state),
          ) ||
          state.operations.some(
            (o) => o.binding.leaseId === stop.leaseId && o.state === 'DISPATCHING',
          )
        )
          throw Error('BUMPER_OLD_EXECUTION_UNCONFIRMED');
      },
    });
    if (this.connections.get(id) === connection) this.connections.delete(id);
    if (this.closing.get(id) === stop) this.closing.delete(id);
  }
  async run(
    profileId: string,
    groups: BumperTarget[],
    pages: BumperTarget[],
    settings: BumperSettings,
    callbacks: Parameters<BumperRunner['run']>[4],
  ) {
    const kernel = this.kernel(),
      core = this.core(),
      initialPeer = core?.peers.get(profileId);
    if (!kernel || !initialPeer) throw Error('浏览器未连接');
    if (this.closing.has(profileId)) await this.stop(profileId);
    if (this.connections.has(profileId)) throw Error('BUMPER_PREVIOUS_RUN_ACTIVE');
    const session = await createBumperSessionRuntime({
      profileId,
      initialPeer,
      kernel,
      core,
      repo: this.repo,
      isBusy: this.isBusy,
      paceScale: this.paceScale,
      callbacks,
      connections: this.connections,
      closing: this.closing,
      stopProfile: (id: string) => this.stop(id),
      clock: this.clock,
    });
    const initialConn = session.getConn(),
      stats: BumperRunStats = {
        groupsEntered: 0,
        skippedGroups: 0,
        expectedGroupSkips: 0,
        lastGroupError: '',
        matchedAuthorPosts: 0,
        filteredByAgePosts: 0,
        skippedByQuotaPosts: 0,
        sessionBumped: 0,
        quotaReached: false,
        commentRestrictedInSession: false,
        consecutiveUnconfirmed: 0,
      };
    try {
      pages = pages.map((p) => ({ ...p }));
      for (const target of pages) {
        session.guard();
        const canonicalId = await readBumperPageRedirect(session.getPage(), target.id).catch(
          () => null,
        );
        session.guard();
        if (canonicalId && canonicalId !== target.id) {
          await session.updateMetadata('pages', target.id, { canonicalId });
          target.id = canonicalId;
        }
      }
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const group = groups[groupIndex];
        if (!group) continue;
        session.setOperationContext({ groupId: group.id, groupName: group.name });
        try {
          session.guard();
          const isPageBumperMode = group.id === '-',
            sourceMode: BumperScope = isPageBumperMode ? 'page' : 'group',
            quota = await this.repo.eligibility(
              session.accountId,
              profileId,
              '',
              Date.now(),
              sourceMode,
            );
          callbacks.status(`正在查找 · ${group.name}`, quota.today);
          if (quota.today >= settings.dailyMaxLikesPerAccount) {
            stats.quotaReached = true;
            callbacks.status(
              `今日已达上限 (${quota.today}/${settings.dailyMaxLikesPerAccount})`,
              quota.today,
            );
            break;
          }
          const groupCtx: BumperGroupFeedContext = {
              group,
              effectiveGroupId: group.id,
              effectiveSearchMode: settings.searchMode,
              joinRestrictedFallback: false,
              unjoinableFallbackReason: '',
              isPageBumperMode,
              sourceMode,
              pages,
            },
            groupHelpers = createGroupSurfaceHelpers({
              profileId,
              paceScale: this.paceScale,
              settings,
              callbacks,
              session,
              groupCtx,
            });
          let surface: BumperSurface | undefined, initialFeed: BumperSurface | undefined;
          if (!isPageBumperMode) {
            const entered = await enterBumperGroupSurface({
              paceScale: this.paceScale,
              callbacks,
              session,
              groupCtx,
              helpers: groupHelpers,
              stats,
            });
            surface = entered.surface;
            initialFeed = entered.initialFeed;
          }
          if (
            (await runBumperFeedsForGroup({
              profileId,
              paceScale: this.paceScale,
              repo: this.repo,
              inFlightCoordinator: this.inFlightCoordinator,
              commentClaims: this.commentClaims,
              settings,
              callbacks,
              session,
              groupCtx,
              groupHelpers,
              stats,
              initialFeed,
              initialSurface: surface,
            })) === 'quota_reached'
          )
            return;
        } catch (error) {
          if (session.isCanceledByUserDetach(error))
            throw new BumperFatalError(BUMPER_DEBUGGER_CANCELED_MESSAGE);
          if (!callbacks.cancelled() && isBumperRecoverableDisconnectError(error)) {
            await session.recoverBumperSession(
              error instanceof Error ? error.message : String(error),
            );
            groupIndex--;
            continue;
          }
          session.guard();
          if (isBumperFatal(error)) throw error;
          stats.skippedGroups++;
          if (error instanceof BumperGroupSkipped) stats.expectedGroupSkips++;
          stats.lastGroupError = error instanceof Error ? error.message : String(error);
          callbacks.status('跳过小组 · ' + group.name + ' · ' + stats.lastGroupError);
          devDiag.record({
            level: 'WARN',
            category: 'GROUP_BUMPER',
            event: 'BUMPER_GROUP_SKIPPED',
            profileId,
            reason: stats.lastGroupError,
            data: { groupId: group.id },
          });
        }
        await session.paceWait(4500 + Math.floor(Math.random() * 5001));
      }
      if (
        !stats.quotaReached &&
        stats.groupsEntered === 0 &&
        stats.skippedGroups > stats.expectedGroupSkips
      )
        throw new Error(`全部小组执行异常：${stats.lastGroupError || '页面未就绪'}`);
      if (session.scanOnly) callbacks.status('已完成 · 0 次（只读扫描，无互动）');
      if (!stats.quotaReached && !session.scanOnly && stats.sessionBumped === 0) {
        if (stats.matchedAuthorPosts === 0 && stats.skippedGroups > 0)
          callbacks.status(
            `已完成 · 0 次（未扫到目标帖，${stats.skippedGroups} 个小组跳过：${stats.lastGroupError}）`,
          );
        else if (stats.matchedAuthorPosts === 0)
          callbacks.status('已完成 · 0 次（小组内未扫到目标主页帖子）');
        else if (stats.filteredByAgePosts > 0 && stats.skippedByQuotaPosts === 0)
          callbacks.status(
            `已完成 · 0 次（扫到 ${stats.matchedAuthorPosts} 帖均超出 ${settings.maxPostAgeHours}h 时效）`,
          );
        else if (stats.skippedByQuotaPosts > 0)
          callbacks.status('已完成 · 0 次（目标帖均已顶过或冷却中）');
      }
    } catch (runErr) {
      const effectiveRunErr = session.isCanceledByUserDetach(runErr)
        ? new BumperFatalError(BUMPER_DEBUGGER_CANCELED_MESSAGE)
        : !(runErr instanceof BumperFatalError) && isRawDisconnectTechnicalError(runErr)
          ? new Error(formatBumperDisconnectReason(runErr))
          : runErr;
      const activePage = session.getPageOrUndefined();
      if (activePage) {
        if (effectiveRunErr instanceof BumperFatalError) {
          await reportGlobalRouteAbnormalIfNeeded({
            profileId,
            page: activePage,
            kernel,
            onAccountAbnormal: this.onAccountAbnormal,
            error: effectiveRunErr,
            fallbackScope: effectiveRunErr.scope,
            fallbackState: effectiveRunErr.abnormalState,
          });
        } else {
          await kernel.observeExternalPageAccount?.(profileId, activePage, null)?.catch(() => {});
        }
      }
      throw effectiveRunErr;
    } finally {
      const currentConn = session.getConn();
      if (
        this.connections.get(profileId) === currentConn ||
        this.connections.get(profileId) === initialConn
      )
        await this.stop(profileId).catch(() => {});
      const peer: Peer = session.getPeer();
      if (
        !this.hasControl(profileId) &&
        core?.peers.get(profileId) === peer &&
        peer.online &&
        peer.synced &&
        peer.phase === 'PAUSED'
      )
        await recoverBumperOperations(kernel, peer, this.repo, () => {
          if (core?.peers.get(profileId) !== peer || !peer.online || !peer.synced)
            throw Error('BUMPER_RECOVERY_CHANGED');
        }).catch(() => {});
    }
  }
}
