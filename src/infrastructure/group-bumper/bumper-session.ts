import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import type { Core, Peer } from '../../bridge/core.js';
import type { CompatibleRepository } from '../../domain/persistence.js';
import type { BumperResolutionValue } from '../../shared/bumper-operation.js';
import { devDiag } from '../../shared/dev-diagnostics.js';
import { isLocalAvatar } from '../../shared/group-bumper.js';
import { kernelOperationPending } from '../../shared/kernel-state.js';
import type { Binding } from '../../shared/task-execution.js';
import {
  assertFacebookPageIdentityReady,
  FacebookGroupSessionHelper,
} from '../facebook-group-session.js';
import { prepareFacebookWorkspace } from '../facebook-workspace-preparation.js';
import { fetchAndLocalizeAvatar } from '../group-bumper-avatar.js';
import {
  bumperSetupKinds,
  bumperSetupLabels,
  recoverBumperOperations,
} from '../group-bumper-recovery.js';
import type { SqliteGroupBumperRepository } from '../group-bumper-store.js';
import type { KernelBridge } from '../kernel-bridge.js';
import {
  type ActionProgressState,
  BUMPER_DEBUGGER_CANCELED_MESSAGE,
  type BumperClosingEntry,
  type BumperConnection,
  BumperFatalError,
  type BumperIdentity,
  type BumperOperationContext,
  type BumperOpFn,
  type BumperRunCallbacks,
  BumperSetupUnconfirmed,
  type BumperTargetMetadataUpdate,
  digest,
  formatBumperDisconnectReason,
  isBumperDebuggerCanceledByUser,
  isBumperFatal,
  isBumperRecoverableDisconnectError,
  isRawDisconnectTechnicalError,
  wait,
} from './bumper-core.js';
import { executeBumperOperation } from './bumper-post-flow.js';
export interface BumperSessionSetupInput {
  profileId: string;
  initialPeer: Peer;
  kernel: KernelBridge;
  core: Core | undefined;
  repo: CompatibleRepository<SqliteGroupBumperRepository>;
  isBusy: (id: string) => Promise<boolean>;
  paceScale: number;
  callbacks: BumperRunCallbacks;
  connections: Map<string, BumperConnection>;
  closing: Map<string, BumperClosingEntry>;
  stopProfile: (id: string) => Promise<void>;
  clock?: { now?: () => number; sleep?: (ms: number) => Promise<void> };
}
export interface BumperSessionRuntime {
  runId: string;
  accountId: string;
  getPeer: () => Peer;
  getEpoch: () => string;
  getConn: () => BumperConnection;
  getPage: () => Page;
  getPageOrUndefined: () => Page | undefined;
  guard: () => void;
  isBackgroundAllowed: () => boolean;
  isCanceledByUserDetach: (err?: unknown) => boolean;
  assertIdentity: (force?: boolean) => Promise<void>;
  recoverBumperSession: (reason: string) => Promise<void>;
  resolveActionProgressOnOpExit: (
    operationId: string,
    dispatched: boolean,
  ) => Promise<ActionProgressState>;
  op: BumperOpFn;
  paceWait: (ms: number) => Promise<void>;
  navigate: (url: string) => Promise<string>;
  searchViaInputOrUrl: (query: string, fallbackSearchUrl: string) => Promise<void>;
  updateAvatar: (kind: 'groups' | 'pages', id: string, rawUrl: string) => Promise<void>;
  updateMetadata: (
    kind: 'groups' | 'pages',
    rawId: string,
    resolved: BumperTargetMetadataUpdate,
  ) => Promise<void>;
  getOperationContext: () => BumperOperationContext;
  setOperationContext: (ctx: BumperOperationContext) => void;
  getIssueCount: () => number;
  reportIssue: (issue: Parameters<NonNullable<BumperRunCallbacks['issue']>>[0]) => void;
  getNavigationChain: () => string[];
  clearNavigationChain: () => void;
  resetNoProgressRecoveries: () => void;
}
export async function createBumperSessionRuntime(
  input: BumperSessionSetupInput,
): Promise<BumperSessionRuntime> {
  const {
    profileId,
    kernel,
    core,
    repo,
    isBusy,
    paceScale,
    callbacks,
    connections,
    closing,
    stopProfile,
    clock,
  } = input;
  let peer: Peer = input.initialPeer;
  let epoch = peer.epoch;
  let initialBrowserSessionEpoch: string | null = null;
  const nowFn = clock?.now ?? Date.now;
  const sleepFn = clock?.sleep ?? wait;
  const cancelGuard = () => {
    if (callbacks.cancelled()) throw new BumperFatalError('已停止');
  };
  const guard = () => {
    cancelGuard();
    if (
      !peer ||
      !peer.online ||
      !peer.synced ||
      peer.epoch !== epoch ||
      core?.peers.get(profileId) !== peer
    )
      throw new BumperFatalError('浏览器连接已变化');
  };
  const inspectIdleForProfile = async () => {
    if (core && typeof core.inspectKernelProfileIdle === 'function')
      return core.inspectKernelProfileIdle(profileId);
    const currentPeer = core?.peers.get(profileId),
      idleRes = <R extends 'PEER_OFFLINE' | 'NOT_SYNCED' | 'PHASE_RUNNING' | 'IDLE'>(
        idle: boolean,
        reason: R,
      ) => ({ idle, reason, unresolvedCount: 0, legacyFixtureCount: 0 });
    if (!currentPeer || !currentPeer.online) return idleRes(false, 'PEER_OFFLINE');
    if (!currentPeer.synced) return idleRes(false, 'NOT_SYNCED');
    if (currentPeer.phase !== undefined && currentPeer.phase !== 'PAUSED')
      return idleRes(false, 'PHASE_RUNNING');
    return idleRes(true, 'IDLE');
  };
  const reconcileRecoveringForProfile = async () =>
    core && typeof core.reconcileRecoveringPeerIfPossible === 'function'
      ? core.reconcileRecoveringPeerIfPossible(profileId)
      : false;
  const waitIdle = (timeoutMs = 12_000, g: () => void = guard) =>
    FacebookGroupSessionHelper.waitKernelProfileIdle({
      inspectIdle: inspectIdleForProfile,
      reconcileRecovering: reconcileRecoveringForProfile,
      guard: g,
      timeoutMs,
      clock: { now: nowFn, sleep: sleepFn },
    });
  const checkSessionEpoch = (nextSessionEpoch: string | undefined) => {
    if (typeof nextSessionEpoch === 'string' && nextSessionEpoch.length > 0) {
      if (initialBrowserSessionEpoch === null) initialBrowserSessionEpoch = nextSessionEpoch;
      else if (nextSessionEpoch !== initialBrowserSessionEpoch)
        throw new BumperFatalError('浏览器已重启，当前任务已停止');
    }
  };
  const requireOnlinePeer = () => {
    const active = core?.peers.get(profileId);
    if (!active || !active.online || !active.synced) throw Error('BROWSER_OFFLINE');
    peer = active;
    epoch = active.epoch;
    return active;
  };
  const prepareAndConnect = async () => {
    requireOnlinePeer();
    await waitIdle(12_000, cancelGuard);
    requireOnlinePeer();
    const prepared = await prepareFacebookWorkspace(
      kernel,
      peer,
      undefined,
      guard,
      undefined,
      true,
    );
    checkSessionEpoch((prepared.inventory as { browserSessionEpoch?: string }).browserSessionEpoch);
    if (prepared.inventory.operations.some(kernelOperationPending))
      await recoverBumperOperations(kernel, peer, repo, guard);
    let identityResult: BumperIdentity | null = await kernel
      .inspectIdleFacebookPage(peer, guard, false, false)
      .catch(() => null);
    for (const homeFallback of [false, true]) {
      if (identityResult) break;
      await waitIdle(12_000, guard);
      if (homeFallback)
        identityResult = await kernel
          .inspectIdleFacebookPage(peer, guard, false, true)
          .catch(() => null);
      if (!identityResult) {
        const p = kernel.inspectFacebookIdentity(
          peer,
          guard,
          true,
          prepared.proof,
          true,
          false,
          homeFallback,
        );
        identityResult = homeFallback ? await p : await p.catch(() => null);
      }
    }
    guard();
    if (!identityResult) throw Error('未能确认 Facebook 登录身份');
    checkSessionEpoch(identityResult.proof?.browserSessionEpoch);
    return identityResult;
  };
  const prepareConnection = async () => {
    const currentPeer = core?.peers.get(profileId);
    if (currentPeer && currentPeer.online && currentPeer.synced) {
      peer = currentPeer;
      epoch = currentPeer.epoch;
    }
    await waitIdle(12_000, cancelGuard);
    requireOnlinePeer();
    await recoverBumperOperations(kernel, peer, repo, guard);
    const resolvedIdentity = await prepareAndConnect();
    await waitIdle(12_000, guard);
    guard();
    return {
      identity: resolvedIdentity,
      connection: await kernel.connectFacebook(
        peer,
        resolvedIdentity.actor.accountId,
        guard,
        resolvedIdentity.proof,
      ),
    };
  };
  const waitPeerOnlineAndReady = async (timeoutMs: number, requireIdle: boolean) => {
    const deadline = nowFn() + timeoutMs;
    while (nowFn() < deadline) {
      cancelGuard();
      const candidate = core?.peers.get(profileId);
      if (candidate?.browserWindowCount === 0)
        throw new BumperFatalError('浏览器窗口已关闭，当前任务已停止');
      if (candidate && candidate.online && candidate.synced) {
        peer = candidate;
        epoch = candidate.epoch;
        if (!requireIdle) return;
        await waitIdle(Math.max(500, deadline - nowFn()), cancelGuard);
        const readyPeer = core?.peers.get(profileId);
        if (readyPeer && readyPeer.online && readyPeer.synced) {
          peer = readyPeer;
          epoch = readyPeer.epoch;
          return;
        }
      }
      await sleepFn(100);
    }
    throw new BumperFatalError('等待浏览器重连超时，已停止顶贴');
  };
  let activeConn: Awaited<ReturnType<typeof kernel.connectFacebook>> | undefined;
  const isCanceledByUserDetach = (err?: unknown): boolean =>
    isBumperDebuggerCanceledByUser(err) ||
    activeConn?.failureReason === 'KERNEL_DEBUGGER_CANCELED_BY_USER' ||
    kernel.lastSessionFailureReason?.(profileId, epoch) === 'KERNEL_DEBUGGER_CANCELED_BY_USER';
  let preparedConnection: Awaited<ReturnType<typeof prepareConnection>> | undefined;
  try {
    let lastStartupErr: unknown;
    for (let startupAttempt = 0; startupAttempt < 3; startupAttempt++) {
      try {
        if (startupAttempt > 0) await waitPeerOnlineAndReady(12_000, true);
        preparedConnection = await prepareConnection();
        break;
      } catch (startupErr) {
        lastStartupErr = startupErr;
        cancelGuard();
        if (isCanceledByUserDetach(startupErr))
          throw new BumperFatalError(BUMPER_DEBUGGER_CANCELED_MESSAGE);
        if (startupErr instanceof BumperFatalError && startupErr.message !== '浏览器连接已变化')
          throw startupErr;
        const isTransient =
          FacebookGroupSessionHelper.isTransientPrepareError(startupErr) ||
          isBumperRecoverableDisconnectError(startupErr);
        if (startupAttempt >= 2 || !isTransient || (await isBusy(profileId))) throw startupErr;
        await kernel.taskWindow?.(profileId).catch(() => {});
        await sleepFn(Math.max(10, Math.round(500 * paceScale)));
      }
    }
    if (!preparedConnection) throw lastStartupErr ?? Error('未能建立顶贴控制连接');
  } catch (error) {
    const finalStartupErr = isCanceledByUserDetach(error)
      ? new BumperFatalError(BUMPER_DEBUGGER_CANCELED_MESSAGE)
      : !(error instanceof BumperFatalError) && isRawDisconnectTechnicalError(error)
        ? new Error(`未能建立顶贴控制连接（${formatBumperDisconnectReason(error)}）`)
        : error;
    devDiag.emit('WARN', 'GROUP_BUMPER', 'BUMPER_PREPARE_FAILED', {
      profileId,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw finalStartupErr;
  }
  let identity = preparedConnection.identity;
  let conn = preparedConnection.connection;
  activeConn = conn;
  const accountId = identity.actor.accountId;
  checkSessionEpoch(identity.proof?.browserSessionEpoch ?? conn.proof?.browserSessionEpoch);
  let page: Page | undefined;
  let identityDocument = '';
  let identityAt = 0;
  const registerActiveConnection = async (
    nextConn: BumperConnection,
    nextIdentity: BumperIdentity,
  ) => {
    const nextLeaseId = (await nextConn.context(accountId).catch(() => null))?.leaseId ?? '';
    const commitClosing = (targetConn: BumperConnection) => {
      connections.set(profileId, targetConn);
      closing.set(profileId, {
        id: targetConn.stopRequestId,
        failed: false,
        accountId,
        peerEpoch: epoch,
        leaseId: nextLeaseId,
        ownershipId: targetConn.proof?.ownershipId,
        connection: targetConn,
      });
    };
    const proofEpoch =
      nextIdentity.proof?.browserSessionEpoch ?? nextConn.proof?.browserSessionEpoch;
    if (
      proofEpoch &&
      initialBrowserSessionEpoch !== null &&
      proofEpoch !== initialBrowserSessionEpoch
    ) {
      commitClosing(nextConn);
      await stopProfile(profileId).catch(() => {});
      throw new BumperFatalError('浏览器已重启，当前任务已停止');
    }
    if (nextIdentity.actor.accountId !== accountId) {
      commitClosing(nextConn);
      await stopProfile(profileId).catch(() => {});
      throw new BumperFatalError('登录账号已变化，已停止顶贴');
    }
    conn = nextConn;
    activeConn = nextConn;
    identity = nextIdentity;
    commitClosing(conn);
    const replacementPage = conn.browser.contexts()[0]?.pages()[0];
    if (!replacementPage) {
      await stopProfile(profileId);
      throw new BumperFatalError('任务页面不存在');
    }
    page = replacementPage;
    identityDocument = '';
    identityAt = 0;
  };
  try {
    await registerActiveConnection(conn, identity);
  } catch (regErr) {
    await stopProfile(profileId).catch(() => {});
    throw regErr;
  }
  const getPage = (): Page => {
    if (!page) throw new BumperFatalError('任务页面不存在');
    return page;
  };
  let avatarObservedOnce = false;
  const isBackgroundAllowed = () =>
    peer.capabilities?.includes('kernel-background-presentation-v1') === true ||
    conn.taskRendering === true;
  const assertIdentity = async (force = false) => {
    guard();
    const activePage = getPage();
    const doc = await activePage.evaluate(() => `${location.href}|${performance.timeOrigin}`);
    if (!force && doc === identityDocument && Date.now() - identityAt < 1000) return;
    await assertFacebookPageIdentityReady({
      page: activePage,
      peer,
      kernel,
      accountId,
      proof: identity.proof,
      backgroundAllowed: isBackgroundAllowed(),
      guard,
      onVerificationRequired: () => new BumperFatalError('受限 · 需要手机验证或操作受限'),
      onAccountChanged: () => new BumperFatalError('登录账号已变化，已停止顶贴'),
      onTimeout: (visible) =>
        Error(visible ? '页面或登录身份未就绪，已停止顶贴' : '页面仍不可见，请让浏览器露出边缘'),
    });
    identityDocument = doc;
    identityAt = Date.now();
    if (!avatarObservedOnce) {
      avatarObservedOnce = true;
      await kernel
        .observeExternalPageAccount?.(profileId, activePage, identity.actor)
        ?.catch(() => {});
    }
  };
  let consecutiveNoProgressRecoveries = 0;
  let recoveryPromise: Promise<void> | null = null;
  const recoverBumperSession = async (reason: string): Promise<void> => {
    if (isCanceledByUserDetach(reason))
      throw new BumperFatalError(BUMPER_DEBUGGER_CANCELED_MESSAGE);
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = (async () => {
      if (isCanceledByUserDetach(reason))
        throw new BumperFatalError(BUMPER_DEBUGGER_CANCELED_MESSAGE);
      const displayReason = formatBumperDisconnectReason(reason);
      if (consecutiveNoProgressRecoveries >= 2)
        throw new BumperFatalError(`连续 2 次中断恢复无实质进展，已停止顶贴（${displayReason}）`);
      consecutiveNoProgressRecoveries++;
      callbacks.status('连接中断，正在恢复 · ' + displayReason);
      await waitPeerOnlineAndReady(15_000, false);
      await stopProfile(profileId);
      await waitPeerOnlineAndReady(12_000, true);
      const reconnected = await prepareConnection();
      await registerActiveConnection(reconnected.connection, reconnected.identity);
    })().finally(() => {
      recoveryPromise = null;
    });
    return recoveryPromise;
  };
  const runId = callbacks.runId ?? randomUUID();
  const localizeIfNeeded = async (rawUrl: string) =>
    isLocalAvatar(rawUrl)
      ? rawUrl
      : ((await fetchAndLocalizeAvatar(rawUrl).catch(() => null)) ?? rawUrl);
  const updateAvatar = async (kind: 'groups' | 'pages', id: string, rawUrl: string) => {
    if (rawUrl) await repo.updateAvatar(kind, id, await localizeIfNeeded(rawUrl));
  };
  const updateMetadata = async (
    kind: 'groups' | 'pages',
    rawId: string,
    resolved: BumperTargetMetadataUpdate,
  ) => {
    await repo.applyResolvedTargetMetadata?.(kind, rawId, {
      canonicalId: resolved.canonicalId ?? null,
      name: resolved.name ?? null,
      avatarUrl: resolved.avatarUrl ? await localizeIfNeeded(resolved.avatarUrl) : null,
    });
  };
  let issueCount = 0;
  let operationContext: BumperOperationContext = { groupId: '', groupName: '' };
  const reportIssue = (issue: Parameters<NonNullable<typeof callbacks.issue>>[0]) => {
    issueCount++;
    const isPageTarget = operationContext.groupId === '-';
    callbacks.issue?.({
      ...issue,
      target: issue.target ?? {
        groupId: isPageTarget ? '' : operationContext.groupId,
        groupName: isPageTarget ? '' : operationContext.groupName,
        pageId: operationContext.pageId ?? '',
        pageName: operationContext.pageName ?? '',
      },
    });
  };
  const jobId = randomUUID();
  const stepId = randomUUID();
  const resolveActionProgressOnOpExit = async (
    operationId: string,
    dispatched: boolean,
  ): Promise<ActionProgressState> => {
    const savedOp = await Promise.resolve(repo.getOperation(operationId)).catch(() => null);
    if (savedOp?.resolution?.outcome === 'VERIFIED') return 'VERIFIED';
    if (savedOp?.resolution?.outcome === 'NOT_APPLIED') return 'NOT_SENT';
    if (
      savedOp?.reason ||
      savedOp?.resolution?.outcome === 'ENDED_UNKNOWN' ||
      savedOp?.resolution?.outcome === 'ABANDONED'
    )
      return 'UNKNOWN';
    return dispatched ? 'UNKNOWN' : 'NOT_SENT';
  };
  const op: BumperOpFn = async <T>(
    label: string,
    work: () => Promise<T>,
    verify: (value: T) => Promise<boolean>,
    persist?: (
      value: T,
      binding: Binding,
      resolution: BumperResolutionValue,
    ) => Promise<BumperResolutionValue | void>,
    onPrepared?: (binding: Binding) => void,
  ) => {
    const submission = label === '点赞' || label === '发送评论' || label === '分享到快拍';
    await assertIdentity(submission);
    const activeConnRef = conn,
      ctx = await activeConnRef.context(accountId);
    if (!ctx) throw new BumperFatalError('账号控制已失效');
    const binding: Binding = {
        ...ctx,
        operationId: randomUUID(),
        jobId,
        stepId,
        actionDigest: digest({ purpose: 'group-bumper', label, accountId }),
      },
      index = bumperSetupLabels.indexOf(label as (typeof bumperSetupLabels)[number]),
      actionKind =
        label === '点赞'
          ? 'submit_like'
          : label === '发送评论'
            ? 'submit_comment'
            : label === '分享到快拍'
              ? 'submit_story_share'
              : index >= 0
                ? (bumperSetupKinds[index] ?? 'setup_navigate')
                : 'setup_navigate';
    await repo.prepareOperation({ binding, runId, actionKind, ...operationContext });
    let reviewed = false;
    onPrepared?.(binding);
    try {
      return await executeBumperOperation({
        connection: activeConnRef,
        binding,
        label,
        work,
        verify,
        persist: persist ? (value, resolution) => persist(value, binding, resolution) : undefined,
        settlement: {
          auxiliary: !submission,
          save: async (resolution) => repo.setOperationResolution(binding.operationId, resolution),
          settled: async () => {
            await repo.markOperationSettled(binding.operationId);
          },
          review: async (reason) => {
            await repo.markOperationReview(binding.operationId, reason);
            reviewed = true;
            reportIssue({ kind: 'pending', reason });
          },
        },
        assertCurrent: assertIdentity,
        stop: () =>
          connections.get(profileId) === activeConnRef ? stopProfile(profileId) : Promise.resolve(),
      });
    } catch (error) {
      if (isCanceledByUserDetach(error))
        throw new BumperFatalError(BUMPER_DEBUGGER_CANCELED_MESSAGE);
      if (submission && !reviewed && !isBumperRecoverableDisconnectError(error))
        reportIssue({
          kind: 'failed',
          reason: isRawDisconnectTechnicalError(error)
            ? formatBumperDisconnectReason(error)
            : error instanceof Error
              ? error.message
              : String(error),
        });
      if (!(error instanceof BumperSetupUnconfirmed)) throw error;
      callbacks.status('恢复准备步骤 · ' + label);
      await recoverBumperSession(label);
      throw Error(error.message);
    }
  };
  let navigationChain: string[] = [];
  const paceWait = async (ms: number) => {
      const total = Math.round(ms * paceScale);
      for (let i = 0; i < total; i += 100) {
        guard();
        await wait(Math.min(100, total - i));
      }
    },
    navigate = async (url: string) =>
      op(
        '打开小组页面',
        async () => {
          const activePage = getPage(),
            response = await activePage.goto(url, {
              waitUntil: 'domcontentloaded',
              timeout: 30000,
            });
          navigationChain = [];
          for (
            let request = response?.request();
            request;
            request = request.redirectedFrom() ?? undefined
          )
            navigationChain.push(request.url());
          return activePage.url();
        },
        async () => {
          const u = new URL(getPage().url()),
            requested = new URL(url);
          if (u.origin !== 'https://www.facebook.com') return false;
          if (requested.pathname.includes('/search'))
            return (
              !!u.searchParams.get('q') &&
              u.searchParams.get('q') === requested.searchParams.get('q') &&
              (/^\/groups\/search\//.test(u.pathname) ||
                /^\/search(?:\/(?:groups|pages|top))?\/?$/.test(u.pathname) ||
                /^\/groups\/[^/]+\/search\//.test(u.pathname))
            );
          if (!requested.pathname.startsWith('/groups/'))
            return !/^\/(?:login|checkpoint)(?:\/|\.php|$)/i.test(u.pathname);
          return (
            /^\/groups\/(?!search(?:\/|$))[^/]+/.test(u.pathname) &&
            (!requested.searchParams.has('sorting_setting') ||
              u.searchParams.get('sorting_setting') === null ||
              u.searchParams.get('sorting_setting') ===
                requested.searchParams.get('sorting_setting'))
          );
        },
      );
  const searchViaInputOrUrl = async (query: string, fallbackSearchUrl: string) => {
    const searchSelector = [
      '[role="banner"] input[type="search"]',
      '[role="banner"] input[role="combobox"]',
      '[role="banner"] input[aria-label*="Search" i]',
      '[role="banner"] input[aria-label*="搜索"]',
      '[role="banner"] input[aria-label*="搜尋"]',
      '[role="banner"] input[aria-label*="ရှာ"]',
      '[role="banner"] input[placeholder*="Search" i]',
      '[role="banner"] input[placeholder*="搜索"]',
      '[role="banner"] input[placeholder*="搜尋"]',
    ].join(', ');
    let typed = false;
    try {
      const hasVisibleInput = await getPage()
        .evaluate((sel) => {
          for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
            const r = el.getBoundingClientRect(),
              s = getComputedStyle(el);
            if (r.width > 20 && r.height > 12 && s.display !== 'none' && s.visibility !== 'hidden')
              return true;
          }
          return false;
        }, searchSelector)
        .catch(() => false);
      if (hasVisibleInput === true) {
        await op(
          '打开搜索结果',
          async () => {
            const activePage = getPage();
            const box = activePage.locator(searchSelector).first();
            await box.click({ timeout: 3000 });
            await box.press('ControlOrMeta+A').catch(() => {});
            await box.press('Backspace').catch(() => {});
            const typeChar =
              typeof activePage.keyboard.type === 'function'
                ? (ch: string) => activePage.keyboard.type(ch)
                : (ch: string) => activePage.keyboard.insertText(ch);
            for (const ch of Array.from(query)) {
              guard();
              await typeChar(ch);
              const delayMs = Math.round((55 + Math.floor(Math.random() * 56)) * paceScale);
              if (delayMs > 0) await wait(delayMs);
            }
            await box.press('Enter', { timeout: 3000 });
            await activePage
              .waitForURL(
                (u) => u.origin === 'https://www.facebook.com' && /search/i.test(u.pathname),
                { timeout: 5000 },
              )
              .catch(() => {});
            return activePage.url();
          },
          async () => true,
        );
        const landed = new URL(getPage().url());
        typed = landed.origin === 'https://www.facebook.com' && /search/i.test(landed.pathname);
      }
    } catch (err) {
      if (isBumperFatal(err)) throw err;
    }
    if (!typed) await navigate(fallbackSearchUrl);
  };
  return {
    runId,
    accountId,
    getPeer: () => peer,
    getEpoch: () => epoch,
    getConn: () => conn,
    getPage,
    getPageOrUndefined: () => page,
    guard,
    isBackgroundAllowed,
    isCanceledByUserDetach,
    assertIdentity,
    recoverBumperSession,
    resolveActionProgressOnOpExit,
    op,
    paceWait,
    navigate,
    searchViaInputOrUrl,
    updateAvatar,
    updateMetadata,
    getOperationContext: () => operationContext,
    setOperationContext: (ctx) => {
      operationContext = ctx;
    },
    getIssueCount: () => issueCount,
    reportIssue,
    getNavigationChain: () => navigationChain,
    clearNavigationChain: () => {
      navigationChain = [];
    },
    resetNoProgressRecoveries: () => {
      consecutiveNoProgressRecoveries = 0;
    },
  };
}
